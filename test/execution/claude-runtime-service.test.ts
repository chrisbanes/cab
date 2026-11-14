import { seedLegacyCommand } from "../fixtures/legacy-harness-configuration.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ClaudeRuntime,
  claudeTemporaryBase,
} from "../../src/standalone/claude.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { gitEnvironment } from "../../src/standalone/git-process.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import {
  fakeSdk,
  init,
  result,
  type Script,
  sessionOf,
} from "../fixtures/claude-sdk.js";
import { stopWithoutDrain } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { failureNotice } from "../../web/src/execution-runtime.js";
import { slashTmpDenied } from "../fixtures/host-access.js";

/** Captures the spawn context; never starts a turn. */
class ContextRuntime implements Runtime {
  async start() {}
  async stop() {}
  async startThread(): Promise<string> {
    throw new Error("unused");
  }
  async resumeThread() {}
  async startTurn(): Promise<string> {
    throw new Error("unused");
  }
  async interruptTurn() {}
  async waitForTurn(): Promise<"completed"> {
    throw new Error("unused");
  }
  onUnexpectedRequest() {}
}

const TOKEN = "claude-token-canary-4471";
const NAME = "FIXTURE_CLAUDE_SUBSCRIPTION";
const ALIAS = "FIXTURE_CLAUDE_ALIAS";
const DELIVERY = "FIXTURE_CLAUDE_DELIVERY_CREDENTIAL";
const DELIVERY_VALUE = "delivery-canary-9910";

function withEnvironment(
  t: { after: (fn: () => void) => void },
  values: Record<string, string | undefined>,
) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function harnessFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dataDir = join(
    mkdtempSync(join(tmpdir(), "cab-claude-service-")),
    "data",
  );
  const contexts = new Map<ExecutionHarness, RuntimeSpawnContext>();
  const service = new StandaloneService(
    dataDir,
    (context, harness) => {
      contexts.set(harness, context);
      return new ContextRuntime();
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });
  const configure = (credentialRef: string | null) =>
    seedLegacyCommand(service.domain(), {
      type: "claude-token.configure",
      actor: "operator",
      key: randomUUID(),
      credentialRef,
    });
  const claude = () => {
    const context = contexts.get("claude")?.claude;
    assert.ok(context);
    return context;
  };
  return { service, dataDir, contexts, configure, claude };
}

test("historical token references still scrub cab credentials while native startup preserves homes", async (t) => {
  withEnvironment(t, {
    [NAME]: TOKEN,
    [ALIAS]: TOKEN,
    [DELIVERY]: DELIVERY_VALUE,
  });
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`env:${NAME}`);
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Delivery",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: `env:${DELIVERY}`,
    grants: [],
    requiredChecks: [],
  });
  await f.service.stop();
  await f.service.start();
  const codex = f.contexts.get("codex")?.spawnEnvironment();
  assert.ok(codex);
  const serialized = JSON.stringify(codex);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(codex[NAME], undefined);
  assert.equal(codex[ALIAS], undefined);
  assert.equal(serialized.includes(DELIVERY_VALUE), false);
  // Helper children such as git never inherit the token or an alias of it.
  const git = gitEnvironment();
  assert.equal(JSON.stringify(git).includes(TOKEN), false);
  assert.equal(git[NAME], undefined);
  assert.equal(git[ALIAS], undefined);
  const turn = f.claude().turnEnvironment();
  assert.ok("env" in turn);
  assert.equal("token" in turn, false);
  assert.equal(JSON.stringify(turn.env).includes(TOKEN), false);
  assert.equal(JSON.stringify(turn.env).includes(DELIVERY_VALUE), false);
  assert.equal(turn.env.CAB_MANAGED_ASSIGNMENT, "1");
  assert.ok(!("configDirectory" in f.claude()));
});

const FILE_TOKEN = "claude-file-token-canary-3381";

/** An owner-only token file in a private real directory; returns its path. */
function tokenFile(t: { after: (fn: () => void) => void }, value = FILE_TOKEN) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cab-claude-token-")));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "claude-token");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

test("historical file-token values remain excluded from every runtime and helper environment", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: FILE_TOKEN });
  const path = tokenFile(t);
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`file:${path}`);
  await f.service.stop();
  await f.service.start();
  const codex = f.contexts.get("codex")?.spawnEnvironment();
  assert.ok(codex);
  assert.equal(JSON.stringify(codex).includes(FILE_TOKEN), false);
  assert.equal(codex[ALIAS], undefined);
  const git = gitEnvironment();
  assert.equal(JSON.stringify(git).includes(FILE_TOKEN), false);
  assert.equal(git[ALIAS], undefined);
  const turn = f.claude().turnEnvironment();
  assert.ok("env" in turn);
  assert.equal("token" in turn, false);
  assert.equal(JSON.stringify(turn.env).includes(FILE_TOKEN), false);
  assert.equal(turn.env.CAB_MANAGED_ASSIGNMENT, "1");
});

test("a rotated token file keeps the previous value in the failure exclusions", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const path = tokenFile(t);
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`file:${path}`);
  await f.service.stop();
  await f.service.start();
  const turn = f.claude().turnEnvironment();
  assert.ok("env" in turn);
  writeFileSync(path, "rotated-claude-token-1185\n", { mode: 0o600 });
  const exclusions = f.service.failureExclusions();
  assert.ok(exclusions?.includes("rotated-claude-token-1185"));
  assert.ok(exclusions?.includes(FILE_TOKEN));
});

const processIdentity = {
  processId: "4242",
  processStartedAt: "Sat Oct 11 10:00:00 2026",
  bootId: "claude-seam-boot",
};

/** A harness fake exercising only the optional Claude seams. */
class SeamRuntime implements Runtime {
  readonly startTurnArgs: unknown[][] = [];
  readonly preflights: unknown[] = [];
  readonly recorded: boolean[] = [];
  preflightReason: string | undefined;
  safety: RuntimeSpawnContext["safety"] | undefined;
  private turns = 0;
  constructor(
    private readonly name: ExecutionHarness,
    withPreflight: boolean,
  ) {
    if (withPreflight)
      this.preflightTurn = async (input) => {
        this.preflights.push(input);
        return this.preflightReason;
      };
  }
  declare preflightTurn?: NonNullable<Runtime["preflightTurn"]>;
  async start() {}
  async stop() {}
  async startThread() {
    return `${this.name}-thread-${randomUUID()}`;
  }
  async resumeThread() {}
  async startTurn(...args: unknown[]) {
    this.startTurnArgs.push(args);
    const threadId = String(args[0]);
    if (this.preflightTurn) {
      const record = this.safety?.recordTurnProcess;
      assert.ok(record);
      this.recorded.push(record({ threadId, processIdentity }));
      this.recorded.push(record({ threadId, processIdentity }));
    }
    return `${this.name}-turn-${++this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn() {
    return "completed" as const;
  }
  processIdentity() {
    return null;
  }
  onUnexpectedRequest() {}
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a Claude preflight reason keeps work queued without admission, then the next wake starts it with the profile settings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-claude-seams-"));
  const runtimes = {
    codex: new SeamRuntime("codex", false),
    claude: new SeamRuntime("claude", true),
  };
  const service = new StandaloneService(
    join(root, "data"),
    (context, harness) => {
      runtimes[harness].safety = context.safety;
      return runtimes[harness];
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const execute = (command: Record<string, unknown>) =>
    seedLegacyCommand(service.domain(), {
      key: randomUUID(),
      actor: "operator",
      ...command,
    } as never);
  const db = () =>
    (service as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  await service.start();
  const lead = randomUUID();
  const worker = randomUUID();
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Codex lead",
    instructions: "lead",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "profile.create",
    profileId: worker,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: "opus", reasoningEffort: "high" },
  });
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Seams",
    leadProfileId: lead,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [worker],
  });
  const taskId = randomUUID();
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Seams",
    outcome: "Claude seams",
    ready: false,
  });
  await service.provisionTask(taskId);
  const assignmentId = randomUUID();
  execute({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId: worker,
    brief: "Build",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const reason = "Claude runtime unavailable: sandbox self-test failed";
  runtimes.claude.preflightReason = reason;
  execute({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const workId = `assignment:${assignmentId}:initial`;
  const describe = () => ({
    intents: service.list().map((i) => [i.workId, i.state, i.reason]),
    requests: service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
  });
  const request = () => service.turnRequests().find((r) => r.workId === workId);
  await waitUntil(() => request()?.reason === reason, describe);
  const waiting = service.list().find((i) => i.workId === workId);
  assert.equal(waiting?.state, "ready");
  assert.equal(waiting?.reason, reason);
  assert.equal(request()?.state, "queued");
  const rows = (sql: string) =>
    db().prepare(sql).all(workId) as Record<string, unknown>[];
  assert.deepEqual(
    rows("SELECT workId FROM execution_recovery_identities WHERE workId = ?"),
    [],
  );
  assert.equal(runtimes.claude.startTurnArgs.length, 0);
  assert.deepEqual(runtimes.claude.preflights.at(-1), {
    workspace: waiting?.workspace,
    settings: { model: "opus", reasoningEffort: "high" },
  });

  runtimes.claude.preflightReason = undefined;
  await (
    service as unknown as { wakeScheduler(): Promise<void> }
  ).wakeScheduler();
  await waitUntil(
    () =>
      service.list().find((i) => i.workId === workId)?.state === "completed",
    describe,
  );
  assert.deepEqual(runtimes.claude.startTurnArgs[0]?.[3], {
    model: "opus",
    reasoningEffort: "high",
  });
  assert.deepEqual(runtimes.claude.recorded, [true, false]);
  assert.deepEqual(
    rows(
      "SELECT processId, processStartedAt, bootId FROM execution_recovery_identities WHERE workId = ?",
    ).map((row) => ({ ...row })),
    [processIdentity],
  );
  const threadId = service.list().find((i) => i.workId === workId)?.threadId;
  assert.ok(threadId);
  assert.equal(
    runtimes.claude.safety?.recordTurnProcess?.({ threadId, processIdentity }),
    false,
  );
  // Codex lead work never sees the Claude seams.
  const codexTask = randomUUID();
  execute({
    type: "task.create",
    projectId,
    taskId: codexTask,
    title: "Codex",
    outcome: "Codex lead",
    ready: true,
  });
  await service.provisionTask(codexTask);
  await waitUntil(() => runtimes.codex.startTurnArgs.length > 0, describe);
  assert.ok(runtimes.codex.startTurnArgs.every((args) => args.length === 3));
});

const T6_NAME = "FIXTURE_CLAUDE_T6_TOKEN_REF";
const T6_TOKEN = "claude-t6-token-canary-7731";

interface ClaudeHarnessControls {
  selfTest: boolean;
  verified: boolean;
  hangModels?: boolean;
  hangIdentity?: boolean;
  /** The `claude` the runtime finds; `null` is none on the PATH. Defaults to a fixture path. */
  executable?: string | null;
  sandboxEscalationExpiryMs?: number;
  exclusions?: () => readonly string[];
}

/** The service with the real ClaudeRuntime over a scripted SDK and a fake Codex. */
function claudeHarness(
  dataDir: string,
  scripts: Script[],
  controls: ClaudeHarnessControls,
) {
  const codex = new SeamRuntime("codex", false);
  const codexContexts: RuntimeSpawnContext[] = [];
  const { sdk, sessions, queries } = fakeSdk(scripts, [], {
    hangModels: controls.hangModels ?? false,
  });
  const verifier = {
    verify: async (identity: {
      processId: string;
      processStartedAt: string;
      bootId: string;
    }) =>
      controls.verified
        ? {
            kind: "verified" as const,
            processIdentity: identity,
            verifiedAt: new Date().toISOString(),
            method: "mac-pid-absent-same-boot" as const,
          }
        : { kind: "unknown" as const, reason: "unverifiable" },
  };
  const service = new StandaloneService(
    dataDir,
    (context, harness) => {
      if (harness === "codex") {
        codexContexts.push(context);
        return codex;
      }
      assert.ok(context.claude);
      return new ClaudeRuntime({
        safety: context.safety,
        claude: context.claude,
        sdk,
        resolveExecutable: async () =>
          controls.executable === undefined
            ? "/fixture/bin/claude"
            : controls.executable,
        captureProcessIdentity: async (pid) =>
          controls.hangIdentity
            ? new Promise<never>(() => {})
            : pid
              ? {
                  processId: String(pid),
                  processStartedAt: "Sat Oct 11 10:00:00 2026",
                  bootId: "claude-t6-boot",
                }
              : null,
        terminationVerifier: verifier,
        sandboxSelfTest: async () => controls.selfTest,
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
      ...(controls.exclusions
        ? { conversationHistoryExclusions: controls.exclusions }
        : {}),
      supervisor: { observationMs: 3000 },
      ...(controls.sandboxEscalationExpiryMs === undefined
        ? {}
        : { sandboxEscalationExpiryMs: controls.sandboxEscalationExpiryMs }),
    },
  );
  const execute = (command: Record<string, unknown>) =>
    seedLegacyCommand(service.domain(), {
      key: randomUUID(),
      actor: "operator",
      ...command,
    } as never);
  const describe = () => ({
    intents: service.list().map((i) => [i.workId, i.state, i.reason]),
    requests: service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
    queries,
  });
  const intent = (workId: string) =>
    service.list().find((item) => item.workId === workId);
  const recovery = (workId: string) =>
    service.recoveryView().find((record) => record.workId === workId);
  const db = () =>
    (service as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const wake = () =>
    (service as unknown as { wakeScheduler(): Promise<void> }).wakeScheduler();
  /** A Codex lead project with one Claude worker profile. */
  const setup = () => {
    const lead = randomUUID();
    const worker = randomUUID();
    execute({
      type: "profile.create",
      profileId: lead,
      name: "Codex lead",
      instructions: "lead",
      capabilities: "code",
      runtime: { harness: "codex" },
    });
    execute({
      type: "profile.create",
      profileId: worker,
      name: "Claude worker",
      instructions: "build",
      capabilities: "code",
      runtime: { harness: "claude", model: "haiku", reasoningEffort: "low" },
    });
    const projectId = randomUUID();
    execute({
      type: "project.create",
      projectId,
      name: "T6",
      leadProfileId: lead,
    });
    execute({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "",
      candidateProfileIds: [worker],
    });
    return { projectId, worker };
  };
  /** A ready task with one Claude assignment; returns its work ID. */
  const claudeTask = async (projectId: string, worker: string) => {
    const taskId = randomUUID();
    execute({
      type: "task.create",
      projectId,
      taskId,
      title: "Claude",
      outcome: "Claude work",
      ready: false,
    });
    await service.provisionTask(taskId);
    const assignmentId = randomUUID();
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId: worker,
      brief: "Build",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    execute({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    return { taskId, workId: `assignment:${assignmentId}:initial` };
  };
  return {
    service,
    codex,
    codexContexts,
    sessions,
    queries,
    execute,
    describe,
    intent,
    recovery,
    db,
    wake,
    setup,
    claudeTask,
  };
}

async function claudeServiceRun(
  t: { after: (fn: () => Promise<void> | void) => void },
  scripts: Script[],
  controls: ClaudeHarnessControls = { selfTest: true, verified: true },
  token: string | undefined = T6_TOKEN,
  credentialRef = `env:${T6_NAME}`,
) {
  withEnvironment(t, { [T6_NAME]: token });
  const root = mkdtempSync(join(tmpdir(), "cab-claude-t6-"));
  const h = claudeHarness(join(root, "data"), scripts, controls);
  t.after(async () => {
    await h.service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await h.service.start();
  h.execute({ type: "claude-token.configure", credentialRef });
  // Configured before this start, so the running runtimes never inherited it.
  await h.service.stop();
  await h.service.start();
  return { ...h, root };
}

const releaseTemporaryBase = (workspace: string | undefined) => {
  if (workspace)
    rmSync(claudeTemporaryBase(workspace), { recursive: true, force: true });
};

test("a native Claude assignment completes with its bound coordination callback", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      const args = { summary: "Claude finished" };
      await session.hook("mcp__cab__cab_report_result", args, "toolu_t6a");
      const outcome = (await session.callTool("cab_report_result", args)) as {
        isError: boolean;
      };
      assert.equal(outcome.isError, false);
      yield result(sessionOf(session));
    },
  ]);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(
    () => run.intent(workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  const receipts = run
    .db()
    .prepare("SELECT callId FROM coordination_receipts WHERE callId = ?")
    .all("toolu_t6a");
  assert.equal(receipts.length, 1);
  const env = run.sessions[0]?.options.env;
  assert.equal(env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const codexEnvironment = run.codexContexts.at(-1)?.spawnEnvironment();
  assert.ok(codexEnvironment);
  assert.equal(JSON.stringify(codexEnvironment).includes(T6_TOKEN), false);
});

test("native execution ignores unavailable historical plugin selections and records no new selected-plugin evidence", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      yield result(sessionOf(session));
    },
  ]);
  const { projectId, worker } = run.setup();
  run.execute({
    type: "profile.configure",
    profileId: worker,
    expectedVersion: 1,
    skills: { plugins: [{ path: "/missing/legacy-plugin", skills: ["old"] }] },
  });
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(
    () => run.intent(workId)?.state === "completed",
    run.describe,
  );
  assert.equal(run.sessions[0]?.options.plugins, undefined);
  assert.equal(run.sessions[0]?.options.skills, undefined);
  assert.deepEqual(run.service.turnSkillPlugins(workId), []);
  assert.deepEqual(run.service.domain().profileSkills(worker), {
    plugins: [{ path: "/missing/legacy-plugin", skills: ["old"] }],
  });
});

test("a Claude turn records its commands as runtime items with exit status and redacted output", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      const ok = { command: "echo hi" };
      await session.hook("Bash", ok, "toolu_ok");
      await session.postHook("Bash", ok, "toolu_ok", {
        response: { stdout: `hi ${T6_TOKEN}`, stderr: "", interrupted: false },
      });
      const bad = { command: "false" };
      await session.hook("Bash", bad, "toolu_bad");
      await session.postHook("Bash", bad, "toolu_bad", {
        error: "Exit code 3\nnope",
      });
      const args = { summary: "Claude finished" };
      await session.hook("mcp__cab__cab_report_result", args, "toolu_cab");
      await session.callTool("cab_report_result", args);
      await session.postHook("mcp__cab__cab_report_result", args, "toolu_cab", {
        response: {},
      });
      yield result(sessionOf(session));
    },
  ]);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(
    () => run.intent(workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  const execution = run
    .db()
    .prepare("SELECT eventSource FROM diagnostic_executions WHERE workId = ?")
    .get(workId) as { eventSource: string };
  assert.equal(execution.eventSource, "supported");
  const items = run
    .db()
    .prepare(
      "SELECT name, itemId, payload FROM diagnostic_items WHERE workId = ? AND kind = 'runtime' ORDER BY sequence",
    )
    .all(workId) as Array<{ name: string; itemId: string; payload: string }>;
  assert.deepEqual(
    items.map((item) => [item.name, item.itemId]),
    [
      ["commandExecution/started", "toolu_ok"],
      ["commandExecution/completed", "toolu_ok"],
      ["commandExecution/started", "toolu_bad"],
      ["commandExecution/completed", "toolu_bad"],
    ],
  );
  const [, okDone, , badDone] = items.map(
    (item) => JSON.parse(item.payload) as Record<string, unknown>,
  );
  assert.equal(okDone?.exitCode, 0);
  assert.equal(okDone?.command, "echo hi");
  assert.match(String(okDone?.aggregatedOutput), /\[redacted\]/);
  assert.equal(badDone?.exitCode, 3);
  assert.equal(badDone?.aggregatedOutput, "nope");
  assert.equal(JSON.stringify(items).includes(T6_TOKEN), false);
});

test("native authentication ignores a retained historical token file", {
  skip: slashTmpDenied(),
}, async (t) => {
  const path = tokenFile(t);
  const run = await claudeServiceRun(
    t,
    [
      async function* (session) {
        yield init(sessionOf(session));
        yield result(sessionOf(session));
      },
    ],
    undefined,
    undefined,
    `file:${path}`,
  );
  assert.equal(Object.values(process.env).includes(FILE_TOKEN), false);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(
    () => run.intent(workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  const env = run.sessions[0]?.options.env;
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(
    Object.entries(env ?? {}).some(
      ([key, value]) =>
        key !== "CLAUDE_CODE_OAUTH_TOKEN" && value === FILE_TOKEN,
    ),
    false,
  );
  const codexEnvironment = run.codexContexts.at(-1)?.spawnEnvironment();
  assert.ok(codexEnvironment);
  assert.equal(JSON.stringify(codexEnvironment).includes(FILE_TOKEN), false);
});

test("a failed sandbox self-test keeps Claude work waiting without holds while Codex proceeds", {
  skip: slashTmpDenied(),
}, async (t) => {
  const controls = { selfTest: false, verified: true };
  const run = await claudeServiceRun(
    t,
    [
      async function* (session) {
        yield init(sessionOf(session));
        yield result(sessionOf(session));
      },
    ],
    controls,
    "",
  );
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  const request = () =>
    run.service.turnRequests().find((r) => r.workId === workId);
  const assertWaiting = (reason: string) => {
    assert.equal(request()?.reason, reason);
    assert.equal(request()?.state, "queued");
    assert.equal(run.intent(workId)?.state, "ready");
    assert.equal(run.intent(workId)?.reason, reason);
    assert.equal(run.recovery(workId)?.holds.writer ?? false, false);
    assert.deepEqual(
      run
        .db()
        .prepare(
          "SELECT workId FROM execution_recovery_identities WHERE workId = ?",
        )
        .all(workId),
      [],
    );
  };
  const sandbox = "Claude runtime unavailable: sandbox self-test failed";
  await waitUntil(() => request()?.reason === sandbox, run.describe);
  assertWaiting(sandbox);
  // Codex work in the same service is not blocked.
  const codexTask = randomUUID();
  run.execute({
    type: "task.create",
    projectId,
    taskId: codexTask,
    title: "Codex",
    outcome: "Codex lead",
    ready: true,
  });
  await run.service.provisionTask(codexTask);
  await waitUntil(() => run.codex.startTurnArgs.length > 0, run.describe);

  assert.deepEqual(run.queries, []);

  controls.selfTest = true;
  await run.wake();
  await waitUntil(
    () => run.intent(workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
});

test("an invalid Claude token fails the turn visibly as unauthorized and is not retried", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      yield result(sessionOf(session), {
        is_error: true,
        terminal_reason: "api_error",
        result: "Not logged in · Please run /login",
      });
      throw new Error("Claude Code returned an error result: Not logged in");
    },
  ]);
  const { projectId, worker } = run.setup();
  const { taskId, workId } = await run.claudeTask(projectId, worker);
  // The runtime reported the failed turn, so cab releases it; it is never retried.
  await waitUntil(
    () => run.intent(workId)?.state === "resolved-failed",
    run.describe,
  );
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  assert.equal(
    run.intent(workId)?.reason,
    "Held turn released: the runtime reported the turn ended",
  );
  const evidence = run
    .db()
    .prepare(
      "SELECT failureEvidence FROM runtime_terminal_evidence WHERE turnId = ?",
    )
    .get(run.intent(workId)?.turnId ?? "") as { failureEvidence: string };
  assert.equal(JSON.parse(evidence.failureEvidence).reasonCode, "unauthorized");
  // Task rows, history and recovery share this read and presenter.
  const api = new OperatorApi(run.service, [run.root]);
  const assignmentId = workId.split(":")[1] ?? "";
  const fromTask = (await api.readTask(taskId)).data.assignments.find(
    (a) => a.assignmentId === assignmentId,
  );
  const fromRecovery = (await api.readAssignmentRecovery(assignmentId)).data
    .assignment;
  for (const a of [fromTask, fromRecovery]) {
    assert.ok(a);
    assert.deepEqual(a.executionGeneration?.failure, {
      classification: "permanent",
      reasonCode: "unauthorized",
    });
    const notice = failureNotice(a);
    assert.match(notice?.message ?? "", /Claude rejected its native login/);
    assert.deepEqual(
      notice?.routes.map((r) => r.href),
      ["/settings#runtime", `/assignments/${assignmentId}/recovery`],
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    run.queries.filter((query) => query === "turn"),
    ["turn"],
  );
});

test("losing the Claude process mid-tool holds the work with its writer and capacity", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      yield {
        type: "assistant",
        uuid: "t6-tool",
        message: {
          content: [{ type: "tool_use", id: "toolu_lost", name: "Bash" }],
        },
      };
      session.child.kill("SIGKILL");
      await session.waitForExit();
      throw new Error("Claude Code process terminated by signal SIGKILL");
    },
  ]);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(() => run.intent(workId)?.state === "held", run.describe);
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  const holds = run.recovery(workId)?.holds;
  assert.deepEqual([holds?.writer, holds?.capacity], [true, true]);
});

for (const verified of [true, false])
  test(`Stop of a running Claude turn ${verified ? "observes its terminal" : "keeps the hold when exit is unverified"}`, {
    skip: slashTmpDenied(),
  }, async (t) => {
    const controls = { selfTest: true, verified };
    let streaming!: () => void;
    const reached = new Promise<void>((resolve) => {
      streaming = resolve;
    });
    const run = await claudeServiceRun(
      t,
      [
        async function* (session) {
          yield init(sessionOf(session));
          streaming();
          await new Promise(() => {});
        },
      ],
      controls,
    );
    const { projectId, worker } = run.setup();
    const { taskId, workId } = await run.claudeTask(projectId, worker);
    await reached;
    await waitUntil(
      () => run.intent(workId)?.state === "running",
      run.describe,
    );
    {
      const base = run.intent(workId)?.workspace;
      t.after(() => releaseTemporaryBase(base));
    }
    const stopped = await run.service.stopTask(taskId);
    const outcome = stopped.outcomes.find((item) => item.workId === workId);
    assert.equal(outcome?.interrupt, "acknowledged");
    if (verified) assert.equal(outcome?.terminal, "observed");
    else {
      await waitUntil(() => run.intent(workId)?.state === "held", run.describe);
      assert.equal(run.recovery(workId)?.holds.writer, true);
    }
  });

test("a restart after a crash releases a Claude turn whose per-turn process exited", {
  skip: slashTmpDenied(),
}, async (t) => {
  const scripts: Script[] = [
    async function* (session) {
      yield init(sessionOf(session));
      await new Promise(() => {});
    },
  ];
  const run = await claudeServiceRun(t, scripts);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(() => run.intent(workId)?.state === "running", run.describe);
  const workspace = run.intent(workId)?.workspace;
  t.after(() => releaseTemporaryBase(workspace));
  const identity = run.recovery(workId)?.processIdentity;
  assert.ok(identity);
  // A crash leaves no planned-shutdown interrupt; the verified exit of the turn's own
  // Claude process releases it.
  await stopWithoutDrain(run.service);
  const restarted = claudeHarness(join(run.root, "data"), [], {
    selfTest: true,
    verified: true,
  });
  t.after(() => restarted.service.stop().catch(() => {}));
  await restarted.service.start();
  const record = restarted.recovery(workId);
  assert.equal(record?.intent.state, "resolved-failed");
  assert.deepEqual(
    record?.observations.map((observation) => observation.kind),
    ["unknown", "termination-verified", "held-turn-released"],
  );
  assert.deepEqual(
    [record?.holds.writer, record?.holds.capacity, record?.holds.uncertainty],
    [false, false, false],
  );
});

test("a planned restart with a running Claude execution interrupts and releases it", {
  skip: slashTmpDenied(),
}, async (t) => {
  const scripts: Script[] = [
    async function* (session) {
      yield init(sessionOf(session));
      await new Promise(() => {});
    },
  ];
  const run = await claudeServiceRun(t, scripts);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(() => run.intent(workId)?.state === "running", run.describe);
  const workspace = run.intent(workId)?.workspace;
  t.after(() => releaseTemporaryBase(workspace));
  await run.service.stop();
  const restarted = claudeHarness(join(run.root, "data"), [], {
    selfTest: true,
    verified: true,
  });
  t.after(() => restarted.service.stop().catch(() => {}));
  await restarted.service.start();
  assert.equal(restarted.intent(workId)?.state, "resolved-failed");
  assert.equal(restarted.recovery(workId)?.holds.writer, false);
  assert.equal(
    restarted
      .db()
      .prepare(
        "SELECT COUNT(*) AS n FROM execution_shutdown_resolutions WHERE interruptedWorkId = ?",
      )
      .get(workId)?.n,
    1,
  );
});

test("a hanging Claude settings read never delays queued Codex work", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [], {
    selfTest: true,
    verified: true,
    hangModels: true,
  });
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  const reading = "Claude runtime unavailable: reading supported models";
  await waitUntil(() => run.intent(workId)?.reason === reading, run.describe);
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  const started = Date.now();
  const codexTask = randomUUID();
  run.execute({
    type: "task.create",
    projectId,
    taskId: codexTask,
    title: "Codex",
    outcome: "Codex lead",
    ready: true,
  });
  await run.service.provisionTask(codexTask);
  await waitUntil(() => run.codex.startTurnArgs.length > 0, run.describe);
  assert.ok(Date.now() - started < 2000);
  assert.equal(run.intent(workId)?.reason, reading);
  assert.equal(run.intent(workId)?.state, "ready");
});

test("a restart before the Claude process identity was recorded reports no proof and keeps the hold", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(
    t,
    [
      async function* (session) {
        yield init(sessionOf(session));
      },
    ],
    { selfTest: true, verified: true, hangIdentity: true },
  );
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(
    () => run.intent(workId)?.state === "submitting",
    run.describe,
  );
  const workspace = run.intent(workId)?.workspace;
  t.after(() => releaseTemporaryBase(workspace));
  assert.equal(run.recovery(workId)?.processIdentity, null);
  await run.service.stop();
  const restarted = claudeHarness(join(run.root, "data"), [], {
    selfTest: true,
    verified: true,
  });
  t.after(() => restarted.service.stop().catch(() => {}));
  await restarted.service.start();
  const record = restarted.recovery(workId);
  assert.equal(record?.intent.state, "held");
  assert.deepEqual(
    record?.observations.map((observation) => observation.kind),
    ["no-proof"],
  );
  assert.deepEqual(
    [record?.holds.writer, record?.holds.capacity],
    [true, true],
  );
});

test("a service whose host has no claude starts with Claude not enabled, and its work waits without a query", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-claude-missing-"));
  const missing = claudeHarness(join(root, "missing"), [], {
    selfTest: true,
    verified: true,
    executable: null,
  });
  const present = claudeHarness(join(root, "present"), [], {
    selfTest: true,
    verified: true,
  });
  t.after(async () => {
    await missing.service.stop().catch(() => {});
    await present.service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await missing.service.start();
  await present.service.start();
  const states = (service: StandaloneService) =>
    Object.fromEntries(
      service.harnessStatuses().map(({ harness, state }) => [harness, state]),
    );
  assert.deepEqual(states(missing.service), {
    codex: "available",
    claude: "not-configured",
  });
  assert.deepEqual(states(present.service), {
    codex: "available",
    claude: "available",
  });
  // Claude work holds with the not-enabled reason; no query could reach a bundled binary.
  const { projectId, worker } = missing.setup();
  const { workId } = await missing.claudeTask(projectId, worker);
  await waitUntil(
    () => missing.intent(workId)?.reason === "Claude runtime is not configured",
    missing.describe,
  );
  assert.deepEqual(missing.queries, []);
});

test("a started Claude runtime's supported settings and effective policy parse into the harness status", {
  skip: slashTmpDenied(),
}, async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      yield result(sessionOf(session));
    },
  ]);
  const before = run.service.harnessStatuses()[1];
  assert.equal(before?.harness, "claude");
  assert.match(before?.policy?.lines.join(" ") ?? "", /cab's hook/);
  assert.ok((before?.policy?.limits.length ?? 0) > 0);
  assert.equal(JSON.stringify(before?.policy).includes("/tmp/ens-"), false);
  const { projectId, worker } = run.setup();
  const { workId } = await run.claudeTask(projectId, worker);
  await waitUntil(
    () => run.intent(workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  const settings = run.service.harnessSettings("claude");
  assert.ok(settings && settings.models.length > 0);
  assert.deepEqual(run.service.harnessStatuses()[1]?.settings, settings);
});

type EscalationApproval = {
  interactionId: string;
  revision: number;
  action: string | null;
  material: { command?: string; reason?: string | null };
};
const flaggedBash = (command: string) => ({
  command,
  dangerouslyDisableSandbox: true,
  description: "needs host Chromium",
});
const permission = (value: unknown) =>
  (value as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput?.permissionDecision;

/** A Claude task in a project at an escalate level, and the operator's Inbox controls. */
async function claudeEscalation(
  t: { after: (fn: () => Promise<void> | void) => void },
  scripts: Script[],
  expiryMs?: number,
  level: "escalate-approval" | "escalate-auto-review" = "escalate-approval",
) {
  const run = await claudeServiceRun(t, scripts, {
    selfTest: true,
    verified: true,
    ...(expiryMs === undefined ? {} : { sandboxEscalationExpiryMs: expiryMs }),
  });
  const { projectId, worker } = run.setup();
  run.execute({
    type: "project.configure",
    projectId,
    expectedVersion: Number(run.service.domain().project(projectId).version),
    sandbox: level,
  });
  const { taskId, workId } = await run.claudeTask(projectId, worker);
  const api = new OperatorApi(run.service, [run.root]);
  const approvals = async () =>
    (await api.readTask(taskId)).data.approvals as EscalationApproval[];
  const decide = async (decision: "approved" | "denied") => {
    let pending: EscalationApproval | undefined;
    await waitUntil(() => {
      pending = run.service
        .coordinationView()
        .readTask(taskId)
        .approvals.find(
          (a) => a.action === "sandbox.escalate" && a.status === "open",
        ) as EscalationApproval | undefined;
      return pending !== undefined;
    }, run.describe);
    const approval = (await approvals()).find(
      (a) => a.interactionId === pending!.interactionId,
    )!;
    await api.execute({
      type: "approval.decide",
      key: randomUUID(),
      taskId,
      interactionId: approval.interactionId,
      expectedRevision: approval.revision,
      decision,
      action: approval.action!,
      material: approval.material,
    } as never);
    return approval;
  };
  const escalations = async () =>
    (await api.readTask(taskId)).data.sandboxEscalations ?? [];
  const reviews = async () =>
    (await api.readTask(taskId)).data.sandboxReviews ?? [];
  return { ...run, taskId, workId, decide, escalations, reviews, approvals };
}

test("a Claude escalate-approval turn holds a flagged Bash call for the Inbox: approve allows it once with its exit code, decline refuses it", {
  skip: slashTmpDenied(),
}, async (t) => {
  const decisions: unknown[] = [];
  let decided: Promise<unknown> = Promise.resolve();
  let run!: Awaited<ReturnType<typeof claudeEscalation>>;
  run = await claudeEscalation(t, [
    async function* (session) {
      yield init(sessionOf(session), "auto");
      const approved = session.hook(
        "Bash",
        flaggedBash("node chromium.mjs"),
        "toolu_esc_approve",
      );
      decided = run.decide("approved");
      decisions.push(await approved);
      await session.postHook(
        "Bash",
        flaggedBash("node chromium.mjs"),
        "toolu_esc_approve",
        { response: { stdout: "", stderr: "", interrupted: false } },
      );
      const declined = session.hook(
        "Bash",
        flaggedBash("echo declined"),
        "toolu_esc_decline",
      );
      await decided;
      decided = run.decide("denied");
      decisions.push(await declined);
      yield result(sessionOf(session));
    },
  ]);
  await waitUntil(
    () => run.intent(run.workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(run.workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  await decided;
  assert.deepEqual(decisions.map(permission), ["allow", "deny"]);
  assert.equal(run.sessions[0]?.options.permissionMode, "auto");
  const read = await run.escalations();
  assert.deepEqual(
    read.map((e) => ({
      command: e.command,
      decider: e.decider,
      decision: e.decision,
      exitCode: e.exitCode,
      durationSource: e.durationSource,
    })),
    [
      {
        command: "node chromium.mjs",
        decider: "operator",
        decision: "accept",
        exitCode: 0,
        // Claude reports no duration, so the service measures it.
        durationSource: "service",
      },
      {
        command: "echo declined",
        decider: "operator",
        decision: "decline",
        exitCode: null,
        durationSource: null,
      },
    ],
  );
  assert.equal(typeof read[0]?.durationMs, "number");
  const [approval] = await run.approvals();
  assert.equal(approval?.material.reason, "needs host Chromium");
});

test("a Claude escalation is declined at expiry, and one whose turn process does not match the admitted one is refused", {
  skip: slashTmpDenied(),
}, async (t) => {
  const decisions: unknown[] = [];
  let run!: Awaited<ReturnType<typeof claudeEscalation>>;
  run = await claudeEscalation(
    t,
    [
      async function* (session) {
        yield init(sessionOf(session), "auto");
        const runtime = (
          run.service as unknown as { runtimes: Map<string, ClaudeRuntime> }
        ).runtimes.get("claude")!;
        const own = runtime.turnProcessIdentity.bind(runtime);
        runtime.turnProcessIdentity = (threadId, turnId) => {
          const identity = own(threadId, turnId);
          return identity && { ...identity, processId: "999999" };
        };
        decisions.push(
          await session.hook(
            "Bash",
            flaggedBash("echo foreign"),
            "toolu_foreign",
          ),
        );
        runtime.turnProcessIdentity = own;
        decisions.push(
          await session.hook(
            "Bash",
            flaggedBash("echo expired"),
            "toolu_expired",
          ),
        );
        yield result(sessionOf(session));
      },
    ],
    100,
  );
  await waitUntil(
    () => run.intent(run.workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(run.workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  assert.deepEqual(decisions.map(permission), ["deny", "deny"]);
  const read = await run.escalations();
  // The mismatched call reached no Inbox; the other expired unanswered.
  assert.deepEqual(
    read.map((e) => [e.command, e.decider, e.decision]),
    [["echo expired", "expiry", "decline"]],
  );
});

test("at escalate-auto-review a Claude classifier approval is recorded with its exit code and no Inbox item, and a denial with no overrule", {
  skip: slashTmpDenied(),
}, async (t) => {
  const passed: unknown[] = [];
  const run = await claudeEscalation(
    t,
    [
      async function* (session) {
        yield init(sessionOf(session), "auto");
        passed.push(
          await session.hook(
            "Bash",
            flaggedBash("node chromium.mjs"),
            "toolu_ok",
          ),
        );
        await session.postHook(
          "Bash",
          flaggedBash("node chromium.mjs"),
          "toolu_ok",
          { response: { stdout: "", stderr: "", interrupted: false } },
        );
        passed.push(
          await session.hook("Bash", flaggedBash("curl x"), "toolu_no"),
        );
        yield {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Bash",
          tool_use_id: "toolu_no",
          decision_reason_type: "classifier",
          decision_reason: "Not needed for the task",
          message: "denied",
        };
        yield result(sessionOf(session));
      },
    ],
    undefined,
    "escalate-auto-review",
  );
  await waitUntil(
    () => run.intent(run.workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(run.workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  // Both calls pass the hook to the classifier.
  assert.deepEqual(passed.map(permission), [undefined, undefined]);
  assert.equal(run.service.sandboxLevelFor(run.workId), "escalate-auto-review");
  // Reviewer events apply one at a time; wait for the queue before reading.
  await (run.service as unknown as { sandboxReviewQueue: Promise<void> })
    .sandboxReviewQueue;
  const read = await run.reviews();
  assert.deepEqual(
    read.map((r) => ({
      command: r.command,
      decider: r.decider,
      outcome: r.outcome,
      riskLevel: r.riskLevel,
      rationale: r.rationale,
      overrule: r.overrule,
      exitCode: r.exitCode,
      durationSource: r.durationSource,
    })),
    [
      {
        command: "node chromium.mjs",
        decider: "reviewer",
        outcome: "approved",
        riskLevel: null,
        rationale: null,
        overrule: null,
        exitCode: 0,
        // Timed by the runtime from the hook: the approval is known only after the command ran.
        durationSource: "runtime",
      },
      {
        command: "curl x",
        decider: "reviewer",
        outcome: "denied",
        riskLevel: null,
        rationale: "Not needed for the task",
        overrule: null,
        exitCode: null,
        durationSource: null,
      },
    ],
  );
  assert.deepEqual(await run.approvals(), []);
  assert.deepEqual(await run.escalations(), []);
});

test("at escalate-auto-review a Claude call the classifier leaves undecided follows the escalate-approval path, including expiry", {
  skip: slashTmpDenied(),
}, async (t) => {
  const asked: unknown[] = [];
  const run = await claudeEscalation(
    t,
    [
      async function* (session) {
        yield init(sessionOf(session), "auto");
        await session.hook(
          "Bash",
          flaggedBash("node chromium.mjs"),
          "toolu_ask",
        );
        asked.push(
          await session.canUseTool(
            "Bash",
            flaggedBash("node chromium.mjs"),
            "toolu_ask",
          ),
        );
        yield result(sessionOf(session));
      },
    ],
    100,
    "escalate-auto-review",
  );
  await waitUntil(
    () => run.intent(run.workId)?.state === "completed",
    run.describe,
  );
  {
    const base = run.intent(run.workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  assert.equal((asked[0] as { behavior: string }).behavior, "deny");
  const read = await run.escalations();
  assert.deepEqual(
    read.map((e) => [e.command, e.decider, e.decision]),
    [["node chromium.mjs", "expiry", "decline"]],
  );
  // An operator escalation is not a classifier decision.
  assert.deepEqual(await run.reviews(), []);
});

test("admitted Claude summaries keep their snapshot and privacy across erasure, failures and later turns", {
  skip: slashTmpDenied(),
}, async (t) => {
  const gates = Array.from({ length: 8 }, () => {
    let release!: () => void;
    return {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
  });
  let exclusionsAvailable = true;
  const scripts: Script[] = gates.map(
    (gate, index) =>
      async function* (session) {
        yield init(sessionOf(session));
        const frame = {
          type: "assistant",
          uuid: `summary-${index}`,
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "thinking",
                thinking: "a".repeat(15_990) + "PRIVATE_SPL",
                signature: "SIGNATURE_CANARY",
              },
            ],
          },
        };
        yield frame;
        yield frame;
        yield {
          type: "assistant",
          uuid: `summary-tail-${index}`,
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "thinking",
                thinking: "IT_CANARY token=TOKEN_CANARY tail",
              },
              { type: "text", text: "Ordinary public answer" },
            ],
          },
        };
        await gate.promise;
        const args = { summary: "Summary fixture finished" };
        await session.hook(
          "mcp__cab__cab_report_result",
          args,
          `toolu_reasoning_${index}`,
        );
        await session.callTool("cab_report_result", args);
        yield result(sessionOf(session));
      },
  );
  const run = await claudeServiceRun(t, scripts, {
    selfTest: true,
    verified: true,
    exclusions: () => {
      if (!exclusionsAvailable)
        throw new Error("private exclusion unavailable");
      return [];
    },
  });
  t.after(() => {
    for (const gate of gates) gate.release();
  });
  const { projectId, worker } = run.setup();
  const configure = (fields: object) =>
    run.execute({
      type: "project.configure",
      projectId,
      expectedVersion: Number(run.service.domain().project(projectId).version),
      ...fields,
    });
  configure({ reasoningSummaries: true, instructions: "PRIVATE_SPLIT_CANARY" });
  const turn = async (index: number, during?: (workId: string) => void) => {
    const task = await run.claudeTask(projectId, worker);
    await waitUntil(
      () =>
        run.sessions.length > index &&
        run.intent(task.workId)?.state === "running",
      run.describe,
    );
    const workspace = run.intent(task.workId)?.workspace;
    t.after(() => releaseTemporaryBase(workspace));
    during?.(task.workId);
    gates[index]!.release();
    await waitUntil(
      () => run.intent(task.workId)?.state === "completed",
      run.describe,
    );
    return {
      task,
      row: run
        .db()
        .prepare(
          "SELECT * FROM conversation_reasoning_summaries WHERE workId=?",
        )
        .get(task.workId),
    };
  };
  const first = await turn(0, () => configure({ reasoningSummaries: false }));
  assert.deepEqual(run.sessions[0]?.options.thinking, {
    type: "adaptive",
    display: "summarized",
  });
  assert.equal(first.row?.enabled, 1);
  assert.equal(first.row?.captureMode, "enhanced");
  assert.equal(first.row?.stored, 1);
  assert.equal(first.row?.truncated, 1);
  assert.equal(first.row?.text, "a".repeat(15_990) + "[redacted]");
  const off = await turn(1);
  assert.equal(run.sessions[1]?.options.thinking, undefined);
  assert.equal(off.row?.enabled, 0);
  assert.equal(off.row?.text, null);
  configure({ diagnosticCapture: "baseline" });
  const baseline = await turn(2);
  assert.equal(run.sessions[2]?.options.thinking, undefined);
  assert.equal(baseline.row?.captureMode, "baseline");
  assert.equal(baseline.row?.text, null);
  configure({ diagnosticCapture: "enhanced", reasoningSummaries: true });
  const erased = await turn(3, () =>
    run.execute({
      type: "project.reasoning.delete",
      projectId,
      expectedVersion: Number(run.service.domain().project(projectId).version),
      confirmed: true,
    }),
  );
  assert.equal(erased.row?.text, null);
  assert.equal(erased.row?.stored, 0);
  assert.equal(run.service.domain().reasoningSummaries(projectId), true);
  const later = await turn(4);
  assert.equal(later.row?.generation, 1);
  assert.equal(later.row?.stored, 1);
  const failed = await turn(5, () =>
    run
      .db()
      .exec(`CREATE TRIGGER fail_summary BEFORE INSERT ON conversation_reasoning_summaries
    BEGIN SELECT RAISE(ABORT,'PRIVATE_FAILURE_CANARY'); END`),
  );
  assert.equal(failed.row, undefined);
  run.db().exec("DROP TRIGGER fail_summary");
  assert.equal(
    run
      .db()
      .prepare(
        "SELECT text FROM conversation_history_items WHERE workId=? AND lifecycle='completed'",
      )
      .get(failed.task.workId)?.text,
    "Ordinary public answer",
  );
  exclusionsAvailable = false;
  const unavailable = await turn(6);
  assert.equal(unavailable.row?.text, null);
  exclusionsAvailable = true;
  const last = await turn(7);
  assert.equal(last.row?.stored, 1);
  for (const table of ["conversation_history_items", "diagnostic_items"]) {
    const text = JSON.stringify(
      run.db().prepare(`SELECT * FROM ${table}`).all(),
    );
    assert.equal(
      /TOKEN_CANARY|SIGNATURE_CANARY|PRIVATE_FAILURE_CANARY|a{20}/.test(text),
      false,
      `${table} excludes summary content`,
    );
    if (table === "conversation_history_items")
      assert.equal(text.includes("PRIVATE_SPLIT_CANARY"), false);
  }
  assert.doesNotMatch(
    JSON.stringify(
      run.db().prepare("SELECT * FROM conversation_reasoning_summaries").all(),
    ),
    /PRIVATE_SPLIT_CANARY|TOKEN_CANARY|SIGNATURE_CANARY/,
  );
  const rows = run
    .db()
    .prepare(
      "SELECT workId,threadId,turnId FROM conversation_reasoning_summaries WHERE assignmentId IN (SELECT id FROM domain_assignments WHERE profileId=?)",
    )
    .all(worker);
  assert.equal(new Set(rows.map((row) => row.workId)).size, 7);
});
