import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DomainConflictError } from "../../src/core/domain-errors.js";
import {
  ClaudeRuntime,
  claudeTemporaryBase,
} from "../../src/standalone/claude.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import {
  draftProposalToolName,
  draftingInstruction,
} from "../../src/standalone/drafting.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import { fakeSdk, init, result, sessionOf } from "../fixtures/claude-sdk.js";
import { tmpdir } from "../fixtures/temp.js";
import {
  acquiredOf,
  startedOf,
  unpublish,
} from "../fixtures/service-internals.js";

const processIdentity = {
  processId: "4242",
  processStartedAt: "Sat Oct 11 10:00:00 2026",
  bootId: "drafting-boot",
};

/** What a scripted drafting turn can do, whichever harness runs it. */
interface TurnApi {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; text: string }>;
  interrupted(): Promise<void>;
}
type Behavior = (api: TurnApi) => Promise<void>;

/** A runtime whose turns run a test-supplied behavior and end when it does. */
class DraftRuntime implements Runtime {
  readonly threads: Array<{
    id: string;
    workspace: string;
    tools: readonly RuntimeToolDefinition[];
  }> = [];
  readonly prompts: string[] = [];
  readonly interrupts: string[] = [];
  /** Interrupts are acknowledged but the turn keeps running until `release`. */
  holdOnInterrupt = false;
  private readonly behaviors: Behavior[] = [];
  private tool:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  private readonly turns = new Map<
    string,
    {
      settle: (status: "completed" | "failed") => void;
      promise: Promise<"completed" | "failed">;
      interrupted: Promise<void>;
      interrupt: () => void;
    }
  >();
  private count = 0;

  script(behavior: Behavior): void {
    this.behaviors.push(behavior);
  }
  async start() {}
  async stop() {
    for (const turn of this.turns.values()) turn.settle("failed");
  }
  async startThread(
    workspace: string,
    tools: readonly RuntimeToolDefinition[] = [],
  ) {
    const id = `draft-thread-${++this.count}`;
    this.threads.push({ id, workspace, tools });
    return id;
  }
  async resumeThread() {}
  async startTurn(threadId: string, _workspace: string, prompt: string) {
    this.prompts.push(prompt);
    const turnId = `draft-turn-${++this.count}`;
    let settle!: (status: "completed" | "failed") => void;
    const promise = new Promise<"completed" | "failed">((resolve) => {
      settle = resolve;
    });
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    this.turns.set(turnId, { settle, promise, interrupted, interrupt });
    const behavior = this.behaviors.shift();
    if (behavior)
      setTimeout(() => {
        void behavior({
          callTool: async (name, args) => {
            assert.ok(this.tool, "the service registered no tool handler");
            const outcome = await this.tool({
              threadId,
              turnId,
              callId: randomUUID(),
              tool: name,
              arguments: args,
            });
            return { success: outcome.success, text: outcome.text };
          },
          interrupted: () => interrupted,
        }).then(
          () => settle("completed"),
          () => settle("failed"),
        );
      }, 20);
    return turnId;
  }
  async interruptTurn(_threadId: string, turnId: string) {
    this.interrupts.push(turnId);
    const turn = this.turns.get(turnId);
    turn?.interrupt();
    if (!this.holdOnInterrupt) turn?.settle("failed");
  }
  /** Ends every held turn as the runtime seeing its process exit. */
  release() {
    for (const turn of this.turns.values()) turn.settle("failed");
  }
  async waitForTurn(_threadId: string, turnId: string) {
    const turn = this.turns.get(turnId);
    assert.ok(turn);
    return turn.promise;
  }
  processIdentity() {
    return processIdentity;
  }
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tool = listener;
  }
  onUnexpectedRequest() {}
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CLAUDE_TOKEN_NAME = "FIXTURE_DRAFTING_CLAUDE_TOKEN";

interface Options {
  /** Verification of a restarted run's process: ended, or unknown. */
  verified?: boolean;
  draftingTimeLimitMs?: number;
}

function sourceRepository(root: string): { path: string; commit: string } {
  const path = join(root, "source");
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", "-b", "main", path]);
  git("config", "user.name", "Drafting Test");
  git("config", "user.email", "drafting-test@example.invalid");
  writeFileSync(join(path, "README.md"), "# Atlas\nA keyboard-driven tool.\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "initial");
  return { path, commit: git("rev-parse", "HEAD") };
}

/** One data directory that outlives service restarts inside a test. */
function world(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-drafting-service-"));
  const previous = process.env[CLAUDE_TOKEN_NAME];
  process.env[CLAUDE_TOKEN_NAME] = "drafting-claude-token-canary";
  const services: StandaloneService[] = [];
  t.after(async () => {
    for (const service of services) await service.stop().catch(() => {});
    if (previous === undefined) delete process.env[CLAUDE_TOKEN_NAME];
    else process.env[CLAUDE_TOKEN_NAME] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const source = sourceRepository(root);
  const dataDir = join(root, "data");
  const claudeScripts: Array<Behavior> = [];

  /** A service whose Codex slot is a DraftRuntime and whose Claude slot is the real runtime. */
  const open = (options: Options = {}) => {
    const codex = new DraftRuntime();
    const verifier = {
      verify: async (identity: typeof processIdentity) =>
        options.verified
          ? {
              kind: "verified" as const,
              processIdentity: identity,
              verifiedAt: new Date().toISOString(),
              method: "mac-pid-absent-same-boot" as const,
            }
          : { kind: "unknown" as const, reason: "unverifiable" },
    };
    const sdkState = fakeSdk(
      // Each scripted query consumes one behavior, in order.
      new Proxy([], {
        get: (_target, key) =>
          key === "shift"
            ? () => {
                const behavior = claudeScripts.shift();
                assert.ok(behavior, "unexpected Claude query");
                return async function* (
                  session: Parameters<Parameters<typeof fakeSdk>[0][number]>[0],
                ) {
                  yield init(sessionOf(session));
                  const aborted = new Promise<void>((resolve) => {
                    const signal = session.options.abortController?.signal;
                    if (signal?.aborted) resolve();
                    else signal?.addEventListener("abort", () => resolve());
                  });
                  await behavior({
                    callTool: async (name, args) => {
                      try {
                        // Like the CLI, a tool call is announced to the hook first.
                        await session.hook(
                          `mcp__ensemble__${name}`,
                          args,
                          `toolu_${randomUUID()}`,
                        );
                        const outcome = (await session.callTool(
                          name,
                          args,
                        )) as {
                          isError?: boolean;
                          content?: Array<{ text?: string }>;
                        };
                        return {
                          success: !outcome.isError,
                          text: outcome.content?.[0]?.text ?? "",
                        };
                      } catch (error) {
                        // The MCP layer reports a malformed call as a tool error.
                        return { success: false, text: String(error) };
                      }
                    },
                    interrupted: () => aborted,
                  });
                  yield result(sessionOf(session));
                };
              }
            : undefined,
      }) as never,
      [],
    );
    const service = new StandaloneService(
      dataDir,
      (context: RuntimeSpawnContext, harness: ExecutionHarness) => {
        if (harness === "codex") return codex;
        assert.ok(context.claude);
        return new ClaudeRuntime({
          safety: context.safety,
          claude: context.claude,
          sdk: sdkState.sdk,
          resolveExecutable: async () => "/fixture/bin/claude",
          captureProcessIdentity: async (pid) =>
            pid
              ? {
                  processId: String(pid),
                  processStartedAt: "Sat Oct 11 10:00:00 2026",
                  bootId: "drafting-claude-boot",
                }
              : null,
          // The runtime's own exit check; the service-level verifier is what a restart tests.
          terminationVerifier: {
            verify: async (identity: typeof processIdentity) => ({
              kind: "verified" as const,
              processIdentity: identity,
              verifiedAt: new Date().toISOString(),
              method: "mac-pid-absent-same-boot" as const,
            }),
          },
          sandboxSelfTest: async () => true,
          probeRetryMs: 50,
          exitTimeoutMs: 2000,
        });
      },
      undefined,
      {
        runtimeHarnesses: ["codex", "claude"],
        power: { enabled: false },
        routingClient: null,
        terminationVerifier: verifier,
        ...(options.draftingTimeLimitMs
          ? { draftingTimeLimitMs: options.draftingTimeLimitMs }
          : {}),
      },
    );
    services.push(service);
    return { service, codex, sdk: sdkState };
  };
  const execute = (
    service: StandaloneService,
    command: Record<string, unknown>,
  ) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);

  /** A project whose lead runs on `harness`, linked to the one source repository. */
  const project = async (
    service: StandaloneService,
    harness: ExecutionHarness,
    leadInstructions = "Lead instructions: prefer small, reviewable tasks.",
    withLead = true,
  ) => {
    const lead = randomUUID();
    execute(service, {
      type: "profile.create",
      profileId: lead,
      name: `${harness} lead`,
      instructions: leadInstructions,
      capabilities: "code",
      runtime:
        harness === "claude"
          ? { harness, model: "haiku", reasoningEffort: "low" }
          : { harness },
    });
    const projectId = randomUUID();
    execute(service, {
      type: "project.create",
      projectId,
      name: `Atlas ${randomUUID().slice(0, 8)}`,
      leadProfileId: withLead ? lead : null,
    });
    execute(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    const domain = service.domain();
    await domain.configureGitHub({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(domain.githubConfiguration(projectId).version),
      credentialRef: null,
      selections: [
        {
          id: "repo",
          kind: "repository",
          repositoryId: "R_1",
          owner: "acme",
          name: "atlas",
        },
      ],
      repositories: [
        { repositoryId: "repo-alpha", path: source.path, ref: "main" },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
    });
    return { projectId, lead };
  };

  /** Starts the service; a Claude run needs its token configured before the runtime starts. */
  const start = async (
    service: StandaloneService,
    harness: ExecutionHarness,
  ) => {
    await service.start();
    if (harness === "claude") {
      execute(service, {
        type: "claude-token.configure",
        credentialRef: `env:${CLAUDE_TOKEN_NAME}`,
      });
      await service.stop();
      await service.start();
    }
  };
  const tracked = (service: StandaloneService) => ({
    runs: () =>
      (service as unknown as { db: import("node:sqlite").DatabaseSync }).db
        .prepare("SELECT runId, state, reason FROM drafting_runs")
        .all(),
    usage: (projectId: string) =>
      service.capacityLimits([projectId]).currentUsage,
    counts: () => {
      const db = (
        service as unknown as { db: import("node:sqlite").DatabaseSync }
      ).db;
      const count = (table: string) =>
        Number(
          (
            db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
              n: number;
            }
          ).n,
        );
      return {
        tasks: count("domain_tasks"),
        assignments: count("domain_assignments"),
        deliveries: count("coordination_results"),
        taskWorkspaces: count("task_workspace_bindings"),
      };
    },
  });
  return {
    root,
    dataDir,
    source,
    open,
    execute,
    project,
    start,
    tracked,
    claudeScripts,
  };
}

const harnesses: ExecutionHarness[] = ["codex", "claude"];
const proposal = {
  title: "Publish a keyboard guide",
  outcome: "Publish the guide.\nDone: reviewed and checked examples.",
};
const idea = "Document the keyboard shortcuts";

/** The behavior that proposes each of `calls` in order, then finishes. */
const proposing =
  (...calls: Array<Record<string, unknown>>): Behavior =>
  async (api) => {
    for (const args of calls) await api.callTool(draftProposalToolName, args);
  };

type Opened = ReturnType<ReturnType<typeof world>["open"]>;

const script = (
  w: ReturnType<typeof world>,
  harness: ExecutionHarness,
  opened: Opened,
  behavior: Behavior,
) =>
  harness === "codex"
    ? opened.codex.script(behavior)
    : w.claudeScripts.push(behavior);

/** What the runtime was handed for its first drafting turn. */
function firstTurn(harness: ExecutionHarness, opened: Opened) {
  if (harness === "codex") {
    const [thread] = opened.codex.threads;
    return thread
      ? {
          workspace: thread.workspace,
          tools: thread.tools.map((tool) => tool.name),
          prompt: opened.codex.prompts[0] ?? "",
        }
      : undefined;
  }
  const session = opened.sdk.sessions[0];
  if (!session) return undefined;
  const tools =
    (
      session.options.mcpServers?.ensemble as unknown as
        | { instance: { tools: Array<{ name: string }> } }
        | undefined
    )?.instance.tools ?? [];
  return {
    workspace: String(session.options.cwd),
    tools: tools.map((tool) => tool.name),
    prompt: String(session.prompt?.message.content ?? ""),
  };
}

for (const harness of harnesses) {
  test(`${harness}: a drafting run proposes from a disposable copy at the configured commit and creates no task`, async (t) => {
    const w = world(t);
    const opened = w.open();
    const { service } = opened;
    await w.start(service, harness);
    const { projectId } = await w.project(service, harness);
    const watch = w.tracked(service);
    const before = watch.counts();
    let inside:
      | {
          readme: string;
          head: string;
          usage: number | undefined;
          owner: string[];
        }
      | undefined;
    script(w, harness, opened, async (api) => {
      const turn = firstTurn(harness, opened);
      assert.ok(turn);
      const copy = join(turn.workspace, "repo-1");
      inside = {
        readme: readFileSync(join(copy, "README.md"), "utf8"),
        head: execFileSync("git", ["-C", copy, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        usage: watch.usage(projectId).global,
        owner: (["codex", "claude"] as const).filter((name) =>
          startedOf(service).state.hasRuntimeOwnedExecution(name),
        ),
      };
      const outcome = await api.callTool(draftProposalToolName, proposal);
      assert.equal(outcome.success, true);
    });
    const runId = randomUUID();
    await service.startDrafting({ runId, projectId, idea });
    await waitUntil(
      () => service.readDrafting(runId)?.state === "proposed",
      () => ({ runs: watch.runs(), requests: service.turnRequests() }),
    );
    assert.deepEqual(service.readDrafting(runId)?.proposal, proposal);
    assert.equal(inside?.readme, "# Atlas\nA keyboard-driven tool.\n");
    assert.equal(inside?.head, w.source.commit);
    assert.equal(inside?.usage, 1, "the run held capacity while it ran");
    assert.deepEqual(inside?.owner, [harness], "its own runtime owns it");
    assert.equal(watch.usage(projectId).global, 0);
    assert.deepEqual(watch.counts(), before);
    const turn = firstTurn(harness, opened);
    assert.ok(turn);
    assert.deepEqual(turn.tools, [draftProposalToolName]);
    assert.ok(
      turn.workspace.startsWith(join(w.dataDir, "drafting-workspaces")),
    );
    assert.ok(
      turn.prompt.includes(
        "Lead instructions: prefer small, reviewable tasks.",
      ),
    );
    assert.ok(turn.prompt.includes(draftingInstruction));
    assert.ok(turn.prompt.includes(idea));
    // The copy and the Claude sandbox base are gone.
    assert.equal(existsSync(turn.workspace), false);
    assert.equal(existsSync(claudeTemporaryBase(turn.workspace)), false);
    assert.deepEqual(readdirSync(join(w.dataDir, "drafting-workspaces")), []);
  });

  test(`${harness}: an invalid proposal is refused so the lead can retry, and a turn with no proposal fails`, async (t) => {
    const w = world(t);
    const opened = w.open();
    const { service } = opened;
    await w.start(service, harness);
    const { projectId } = await w.project(service, harness);
    const outcomes: boolean[] = [];
    script(w, harness, opened, async (api) => {
      outcomes.push(
        (await api.callTool(draftProposalToolName, { title: "", outcome: "x" }))
          .success,
        (
          await api.callTool(draftProposalToolName, {
            title: "Only",
            outcome: "First",
          })
        ).success,
        (await api.callTool(draftProposalToolName, proposal)).success,
      );
    });
    const first = randomUUID();
    await service.startDrafting({ runId: first, projectId, idea });
    await waitUntil(
      () => service.readDrafting(first)?.state === "proposed",
      () => w.tracked(service).runs(),
    );
    // The malformed call never reaches the tool for Claude, whose shape check refuses it.
    assert.equal(outcomes.at(-1), true);
    assert.equal(outcomes[0], false);
    assert.deepEqual(service.readDrafting(first)?.proposal, proposal);

    script(w, harness, opened, async () => {});
    const second = randomUUID();
    await service.startDrafting({ runId: second, projectId, idea });
    await waitUntil(
      () => service.readDrafting(second)?.state === "failed",
      () => w.tracked(service).runs(),
    );
    assert.equal(
      service.readDrafting(second)?.reason,
      "The lead returned no draft",
    );
    assert.equal(w.tracked(service).usage(projectId).global, 0);
  });

  test(`${harness}: Stop interrupts a running draft, which settles as interrupted with capacity freed and the copy deleted`, async (t) => {
    const w = world(t);
    const opened = w.open();
    const { service } = opened;
    await w.start(service, harness);
    const { projectId } = await w.project(service, harness);
    script(w, harness, opened, async (api) => {
      await api.interrupted();
      throw new Error("interrupted");
    });
    const runId = randomUUID();
    await service.startDrafting({ runId, projectId, idea });
    await waitUntil(
      () =>
        service.readDrafting(runId)?.state === "running" &&
        firstTurn(harness, opened) !== undefined,
      () => w.tracked(service).runs(),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = await service.stopDrafting(runId);
    assert.equal(stopped.state, "stopping");
    await waitUntil(
      () => service.readDrafting(runId)?.state === "interrupted",
      () => w.tracked(service).runs(),
    );
    assert.equal(service.readDrafting(runId)?.reason, "You stopped the draft");
    assert.equal(w.tracked(service).usage(projectId).global, 0);
    const turn = firstTurn(harness, opened);
    assert.ok(turn);
    assert.equal(existsSync(turn.workspace), false);
    assert.equal(service.readDrafting(runId)?.proposal, null);
  });

  test(`${harness}: the time limit stops a draft the same way`, async (t) => {
    const w = world(t);
    const opened = w.open({ draftingTimeLimitMs: 300 });
    const { service } = opened;
    await w.start(service, harness);
    const { projectId } = await w.project(service, harness);
    script(w, harness, opened, async (api) => {
      await api.interrupted();
      throw new Error("interrupted");
    });
    const runId = randomUUID();
    await service.startDrafting({ runId, projectId, idea });
    await waitUntil(
      () => service.readDrafting(runId)?.state === "interrupted",
      () => w.tracked(service).runs(),
    );
    assert.equal(
      service.readDrafting(runId)?.reason,
      "The 10 minute time limit was reached",
    );
    assert.equal(w.tracked(service).usage(projectId).global, 0);
    const turn = firstTurn(harness, opened);
    assert.ok(turn);
    assert.equal(existsSync(turn.workspace), false);
  });
}

test("Stop keeps capacity reserved and the copy in place until the runtime is seen to end", async (t) => {
  const w = world(t);
  const opened = w.open();
  const { service, codex } = opened;
  codex.holdOnInterrupt = true;
  await w.start(service, "codex");
  const { projectId } = await w.project(service, "codex");
  script(w, "codex", opened, async (api) => {
    await api.interrupted();
    await new Promise(() => {});
  });
  const runId = randomUUID();
  await service.startDrafting({ runId, projectId, idea });
  await waitUntil(
    () =>
      service.readDrafting(runId)?.state === "running" &&
      codex.threads.length > 0,
    () => w.tracked(service).runs(),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await service.stopDrafting(runId);
  await waitUntil(
    () => codex.interrupts.length > 0,
    () => w.tracked(service).runs(),
  );
  // Acknowledged, but the process is not seen to end.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(service.readDrafting(runId)?.state, "stopping");
  assert.equal(w.tracked(service).usage(projectId).global, 1);
  const workspace = codex.threads[0]?.workspace;
  assert.ok(workspace && existsSync(workspace));
  codex.release();
  await waitUntil(
    () => service.readDrafting(runId)?.state === "interrupted",
    () => w.tracked(service).runs(),
  );
  assert.equal(w.tracked(service).usage(projectId).global, 0);
  assert.equal(existsSync(workspace), false);
});

test("capacity: a drafting run waits on the global and project limits and runs after the blocker ends", async (t) => {
  const w = world(t);
  const opened = w.open();
  const { service, codex } = opened;
  await w.start(service, "codex");
  const { projectId } = await w.project(service, "codex");
  w.execute(service, {
    type: "capacity.configure",
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  });
  const blocked: Array<() => void> = [];
  const hold = async () => {
    await new Promise<void>((resolve) => blocked.push(resolve));
  };
  codex.script(hold);
  codex.script(proposing(proposal));
  const first = randomUUID();
  const second = randomUUID();
  await service.startDrafting({ runId: first, projectId, idea });
  await waitUntil(
    () => service.readDrafting(first)?.state === "running",
    () => w.tracked(service).runs(),
  );
  await service.startDrafting({ runId: second, projectId, idea });
  const request = () =>
    service.turnRequests().find((item) => item.workId === `drafting:${second}`);
  assert.equal(service.readDrafting(second)?.state, "queued");
  assert.match(
    request()?.reason ?? "",
    /Capacity waiting: global active-turn limit \(1\)/,
  );
  blocked[0]?.();
  await waitUntil(
    () => service.readDrafting(second)?.state === "proposed",
    () => ({
      runs: w.tracked(service).runs(),
      requests: service.turnRequests(),
    }),
  );
  assert.equal(service.readDrafting(first)?.state, "failed");

  // With the global limit raised, the project limit still holds a second run back.
  w.execute(service, {
    type: "capacity.configure",
    globalLimit: 4,
    projectOverrides: { [projectId]: 1 },
  });
  codex.script(hold);
  codex.script(proposing(proposal));
  const third = randomUUID();
  const fourth = randomUUID();
  await service.startDrafting({ runId: third, projectId, idea });
  await waitUntil(
    () => service.readDrafting(third)?.state === "running",
    () => w.tracked(service).runs(),
  );
  await service.startDrafting({ runId: fourth, projectId, idea });
  assert.match(
    service.turnRequests().find((item) => item.workId === `drafting:${fourth}`)
      ?.reason ?? "",
    /Capacity waiting: project active-turn limit \(1\)/,
  );
  blocked[1]?.();
  await waitUntil(
    () => service.readDrafting(fourth)?.state === "proposed",
    () => w.tracked(service).runs(),
  );
});

test("Stop on a queued run settles it at once with no reservation", async (t) => {
  const w = world(t);
  const opened = w.open();
  const { service, codex } = opened;
  await w.start(service, "codex");
  const { projectId } = await w.project(service, "codex");
  w.execute(service, {
    type: "capacity.configure",
    globalLimit: 1,
    projectOverrides: {},
  });
  codex.script(() => new Promise<void>(() => {}));
  const running = randomUUID();
  await service.startDrafting({ runId: running, projectId, idea });
  await waitUntil(
    () => service.readDrafting(running)?.state === "running",
    () => w.tracked(service).runs(),
  );
  const queued = randomUUID();
  await service.startDrafting({ runId: queued, projectId, idea });
  assert.equal(service.readDrafting(queued)?.state, "queued");
  const stopped = await service.stopDrafting(queued);
  assert.equal(stopped.state, "interrupted");
  assert.equal(
    w.tracked(service).usage(projectId).global,
    1,
    "only the running draft holds capacity",
  );
  await service.stopDrafting(running);
  await waitUntil(
    () => service.readDrafting(running)?.state === "interrupted",
    () => w.tracked(service).runs(),
  );
  assert.equal(w.tracked(service).usage(projectId).global, 0);
  // The stopped run is never admitted afterwards.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(service.readDrafting(queued)?.state, "interrupted");
  const copies = join(w.dataDir, "drafting-workspaces");
  assert.deepEqual(existsSync(copies) ? readdirSync(copies) : [], []);
});

test("a project without an active lead refuses to draft, and a paused project holds the request", async (t) => {
  const w = world(t);
  const opened = w.open();
  const { service, codex } = opened;
  await w.start(service, "codex");
  const lone = await w.project(service, "codex", "x", false);
  await assert.rejects(
    service.startDrafting({
      runId: randomUUID(),
      projectId: lone.projectId,
      idea,
    }),
    (error) =>
      error instanceof DomainConflictError &&
      error.message === "Drafting needs a project lead",
  );
  const { projectId } = await w.project(service, "codex");
  const current = service.domain().project(projectId);
  w.execute(service, {
    type: "project.configure",
    projectId,
    expectedVersion: Number(current.version),
    paused: true,
  });
  codex.script(proposing(proposal));
  const runId = randomUUID();
  await service.startDrafting({ runId, projectId, idea });
  const request = service
    .turnRequests()
    .find((item) => item.workId === `drafting:${runId}`);
  assert.equal(request?.state, "queued");
  assert.match(request?.reason ?? "", /project-paused/);
  assert.equal(service.readDrafting(runId)?.state, "queued");
  assert.equal(codex.threads.length, 0);
  // Stop is available while it waits.
  assert.equal((await service.stopDrafting(runId)).state, "interrupted");
});

test("an accepted proposal is handed over once and a discarded or expired draft cannot be used", async (t) => {
  const w = world(t);
  const opened = w.open();
  const { service, codex } = opened;
  await w.start(service, "codex");
  const { projectId } = await w.project(service, "codex");
  codex.script(proposing(proposal));
  const runId = randomUUID();
  await service.startDrafting({ runId, projectId, idea });
  await waitUntil(
    () => service.readDrafting(runId)?.state === "proposed",
    () => w.tracked(service).runs(),
  );
  const accepted = service.settleDrafting(runId, "accept");
  assert.deepEqual(accepted.proposal, proposal);
  assert.equal(accepted.run.state, "accepted");
  assert.throws(
    () => service.settleDrafting(runId, "accept"),
    DomainConflictError,
  );

  codex.script(proposing(proposal));
  const other = randomUUID();
  await service.startDrafting({ runId: other, projectId, idea });
  await waitUntil(
    () => service.readDrafting(other)?.state === "proposed",
    () => w.tracked(service).runs(),
  );
  assert.equal(service.settleDrafting(other, "discard").run.state, "discarded");
  assert.throws(
    () => service.settleDrafting(other, "accept"),
    DomainConflictError,
  );
});

test("an assignment thread is never offered the proposal tool, and the tool refuses a call outside a running draft", async (t) => {
  const w = world(t);
  const opened = w.open();
  const { service, codex } = opened;
  await w.start(service, "codex");
  const { projectId } = await w.project(service, "codex");
  // A finished draft: its turn no longer exists, so a late call is refused.
  codex.script(async (api) => {
    await api.callTool(draftProposalToolName, proposal);
  });
  const runId = randomUUID();
  await service.startDrafting({ runId, projectId, idea });
  await waitUntil(
    () => service.readDrafting(runId)?.state === "proposed",
    () => w.tracked(service).runs(),
  );
  const handler = (
    codex as unknown as {
      tool: (call: RuntimeToolCall) => Promise<RuntimeToolResult>;
    }
  ).tool;
  const late = await handler({
    threadId: "draft-thread-1",
    turnId: "draft-turn-2",
    callId: randomUUID(),
    tool: draftProposalToolName,
    arguments: proposal,
  });
  assert.equal(late.success, false);
  // Coordination tools are not offered or honoured for drafting work.
  const coordination = await handler({
    threadId: "draft-thread-1",
    turnId: "draft-turn-2",
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: { summary: "x" },
  });
  assert.equal(coordination.success, false);
});

/** Loses the service without a shutdown, as a crash would. */
function crash(service: StandaloneService): void {
  const internals = service as unknown as {
    db: { close(): void } | undefined;
    owner: { close(): void } | undefined;
  };
  startedOf(service).scheduler.stop();
  unpublish(service);
  const acquired = acquiredOf(service);
  if (acquired) delete acquired.scheduler;
  internals.db?.close();
  internals.db = undefined;
  internals.owner?.close();
  internals.owner = undefined;
}

for (const how of ["graceful stop", "crash"] as const) {
  for (const verified of [true, false]) {
    if (how === "graceful stop" && !verified) continue;
    test(`restart after a ${how}${how === "crash" ? (verified ? " with the process verified ended" : " with termination unverifiable") : ""}: capacity is released only once the end is known`, async (t) => {
      const w = world(t);
      const first = w.open({ verified });
      await w.start(first.service, "codex");
      const { projectId } = await w.project(first.service, "codex");
      first.codex.script(() => new Promise<void>(() => {}));
      const runId = randomUUID();
      await first.service.startDrafting({ runId, projectId, idea });
      await waitUntil(
        () =>
          first.service.readDrafting(runId)?.state === "running" &&
          first.codex.threads.length > 0,
        () => w.tracked(first.service).runs(),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      const workspace = first.codex.threads[0]?.workspace;
      assert.ok(workspace && existsSync(workspace));
      if (how === "crash") crash(first.service);
      else await first.service.stop();

      const second = w.open({ verified });
      await second.service.start();
      const watch = w.tracked(second.service);
      if (verified) {
        assert.equal(second.service.readDrafting(runId)?.state, "interrupted");
        assert.equal(watch.usage(projectId).global, 0);
        assert.equal(existsSync(workspace), false);
      } else {
        assert.equal(second.service.readDrafting(runId)?.state, "stopping");
        assert.equal(watch.usage(projectId).global, 1);
        assert.equal(
          existsSync(workspace),
          true,
          "the copy stays until the end is known",
        );
      }
      // No recovery item lists a drafting run.
      assert.deepEqual(
        second.service
          .recoveryView()
          .filter((record) => record.workId === `drafting:${runId}`),
        [],
      );
      await second.service.stop();
    });
  }
}
