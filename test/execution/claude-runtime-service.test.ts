import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
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
import { tmpdir } from "../fixtures/temp.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { failureNotice } from "../../web/src/execution-runtime.js";

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
    mkdtempSync(join(tmpdir(), "ensemble-claude-service-")),
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
    service.domain().execute({
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

test("the Claude token reaches only the Claude turn environment, never Codex or alias spawn environments", async (t) => {
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
  assert.equal(turn.token, TOKEN);
  assert.equal(JSON.stringify(turn.env).includes(TOKEN), false);
  assert.equal(JSON.stringify(turn.env).includes(DELIVERY_VALUE), false);
  assert.equal(turn.env.ENSEMBLE_MANAGED_ASSIGNMENT, "1");
  assert.equal(f.claude().configDirectory, join(f.dataDir, "claude", "config"));
});

test("a Claude token reference inherited by the running runtime waits until restart", async (t) => {
  withEnvironment(t, { [NAME]: TOKEN, [ALIAS]: undefined });
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`env:${NAME}`);
  const held = f.claude().turnEnvironment();
  assert.ok("unavailable" in held);
  assert.match(
    held.unavailable,
    /^Claude runtime unavailable: .*restart the service/,
  );
  assert.equal(held.unavailable.includes(TOKEN), false);
  await f.service.stop();
  await f.service.start();
  const turn = f.claude().turnEnvironment();
  assert.ok("token" in turn);
  assert.equal(turn.token, TOKEN);
});

test("a missing or empty Claude token makes the turn environment unavailable without revealing it", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const f = harnessFixture(t);
  await f.service.start();
  const missing = f.claude().turnEnvironment();
  assert.deepEqual(missing, {
    unavailable:
      "Claude runtime unavailable: subscription token is not configured",
    code: "not-configured",
  });
  f.configure(`env:${NAME}`);
  await f.service.stop();
  await f.service.start();
  const empty = f.claude().turnEnvironment();
  assert.deepEqual(empty, {
    unavailable:
      "Claude runtime unavailable: subscription token is unavailable",
    code: "empty",
  });
  assert.equal(JSON.stringify(empty).includes(NAME), false);
});

const FILE_TOKEN = "claude-file-token-canary-3381";

/** An owner-only token file in a private real directory; returns its path. */
function tokenFile(t: { after: (fn: () => void) => void }, value = FILE_TOKEN) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-claude-token-")),
  );
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "claude-token");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

test("a file-sourced Claude token reaches only the Claude turn, never Codex, helper or alias environments", async (t) => {
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
  assert.equal(turn.token, FILE_TOKEN);
  assert.equal(JSON.stringify(turn.env).includes(FILE_TOKEN), false);
  assert.equal(turn.env.ENSEMBLE_MANAGED_ASSIGNMENT, "1");
});

test("a file token also inherited by the running runtimes waits until restart", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: FILE_TOKEN });
  const path = tokenFile(t);
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`file:${path}`);
  const held = f.claude().turnEnvironment();
  assert.ok("unavailable" in held);
  assert.equal(held.code, "restart-required");
  assert.match(held.unavailable, /restart the service$/);
  assert.equal(held.unavailable.includes(FILE_TOKEN), false);
  await f.service.stop();
  await f.service.start();
  const turn = f.claude().turnEnvironment();
  assert.ok("token" in turn);
  assert.equal(turn.token, FILE_TOKEN);
});

test("an unsafe token file fails closed with a reason naming neither path nor value", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const path = tokenFile(t);
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`file:${path}`);
  chmodSync(path, 0o644);
  const unsafe = f.claude().turnEnvironment();
  assert.deepEqual(unsafe, {
    unavailable:
      "Claude runtime unavailable: subscription token file permits group or other access",
    code: "empty",
  });
  assert.equal(f.service.claudeTokenStatus().state, "missing-value");
  rmSync(path);
  const missing = f.claude().turnEnvironment();
  assert.ok("unavailable" in missing);
  assert.equal(
    missing.unavailable,
    "Claude runtime unavailable: subscription token file is missing",
  );
});

test("a replaced token file applies to the next turn without a restart", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const path = tokenFile(t);
  const f = harnessFixture(t);
  await f.service.start();
  f.configure(`file:${path}`);
  const first = f.claude().turnEnvironment();
  assert.ok("token" in first);
  assert.equal(first.token, FILE_TOKEN);
  const next = `${path}.next`;
  writeFileSync(next, "claude-file-token-rotated-5120\n", { mode: 0o600 });
  renameSync(next, path);
  const rotated = f.claude().turnEnvironment();
  assert.ok("token" in rotated);
  assert.equal(rotated.token, "claude-file-token-rotated-5120");
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
  const root = mkdtempSync(join(tmpdir(), "ensemble-claude-seams-"));
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
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
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
      supervisor: { observationMs: 3000 },
    },
  );
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
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
  const root = mkdtempSync(join(tmpdir(), "ensemble-claude-t6-"));
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

test("a Claude assignment turn completes, its coordination call carries the hook ID, and only Claude sees the token", async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      const args = { summary: "Claude finished" };
      await session.hook(
        "mcp__ensemble__ensemble_report_result",
        args,
        "toolu_t6a",
      );
      const outcome = (await session.callTool(
        "ensemble_report_result",
        args,
      )) as {
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
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, T6_TOKEN);
  const codexEnvironment = run.codexContexts.at(-1)?.spawnEnvironment();
  assert.ok(codexEnvironment);
  assert.equal(JSON.stringify(codexEnvironment).includes(T6_TOKEN), false);
});

test("an installed service runs a Claude turn from a token file with no token in its environment", async (t) => {
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
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, FILE_TOKEN);
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

test("a missing token or failed sandbox self-test keeps Claude work waiting without holds while Codex proceeds", async (t) => {
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
  const missing =
    "Claude runtime unavailable: subscription token is unavailable";
  await waitUntil(() => request()?.reason === missing, run.describe);
  assertWaiting(missing);
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

  process.env[T6_NAME] = T6_TOKEN;
  await run.wake();
  const sandbox = "Claude runtime unavailable: sandbox self-test failed";
  await waitUntil(() => request()?.reason === sandbox, run.describe);
  assertWaiting(sandbox);
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

test("an invalid Claude token fails the turn visibly as unauthorized and is not retried", async (t) => {
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
  await waitUntil(() => run.intent(workId)?.state === "held", run.describe);
  {
    const base = run.intent(workId)?.workspace;
    t.after(() => releaseTemporaryBase(base));
  }
  assert.equal(
    run.intent(workId)?.reason,
    "Bound turn failed or was interrupted",
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
    assert.match(notice?.message ?? "", /Claude rejected the configured token/);
    assert.deepEqual(
      notice?.routes.map((r) => r.href),
      ["/app/settings", `/app/assignments/${assignmentId}/recovery`],
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    run.queries.filter((query) => query === "turn"),
    ["turn"],
  );
});

test("losing the Claude process mid-tool holds the work with its writer and capacity", async (t) => {
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
  test(`Stop of a running Claude turn ${verified ? "observes its terminal" : "keeps the hold when exit is unverified"}`, async (t) => {
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

test("a restart with a running Claude execution holds it as unknown", async (t) => {
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
    ["unknown"],
  );
  assert.deepEqual(
    [record?.holds.writer, record?.holds.capacity, record?.holds.uncertainty],
    [true, true, true],
  );
});

test("a hanging Claude settings read never delays queued Codex work", async (t) => {
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

test("a restart before the Claude process identity was recorded reports no proof and keeps the hold", async (t) => {
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

test("operator token status reports each state without the reference name or value", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const f = harnessFixture(t);
  await f.service.start();
  let api = new OperatorApi(f.service, [f.dataDir]);
  const state = async () => {
    const read = api.readClaudeTokenStatus();
    const text =
      JSON.stringify(read) + JSON.stringify(await api.readWorkspace());
    assert.equal(text.includes(NAME), false);
    assert.equal(text.includes(TOKEN), false);
    return read.data;
  };
  assert.deepEqual(await state(), {
    configured: false,
    available: false,
    state: "not-configured",
  });
  const receipt = await api.execute({
    type: "claude-token.configure",
    key: randomUUID(),
    credentialRef: `env:${NAME}`,
  });
  assert.equal(JSON.stringify(receipt).includes(NAME), false);
  assert.deepEqual(await state(), {
    configured: true,
    available: false,
    state: "missing-value",
  });
  // A value set after start is read live; it was never in the inherited snapshot.
  process.env[NAME] = TOKEN;
  assert.deepEqual(await state(), {
    configured: true,
    available: true,
    state: "available",
  });
  const clear = () =>
    api.execute({
      type: "claude-token.configure",
      key: randomUUID(),
      credentialRef: null,
    });
  await clear();
  assert.equal((await state()).state, "not-configured");
  // Inherited by the running runtimes at start, then configured: restart first.
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.dataDir]);
  await api.execute({
    type: "claude-token.configure",
    key: randomUUID(),
    credentialRef: `env:${NAME}`,
  });
  assert.deepEqual(await state(), {
    configured: true,
    available: false,
    state: "restart-required",
  });
  await f.service.stop();
  await f.service.start();
  api = new OperatorApi(f.service, [f.dataDir]);
  assert.equal((await state()).state, "available");
  await clear();
  assert.equal((await state()).state, "not-configured");
});

test("operator token status for a file reference names neither its path nor its value", async (t) => {
  withEnvironment(t, { [NAME]: undefined, [ALIAS]: undefined });
  const path = tokenFile(t);
  const f = harnessFixture(t);
  await f.service.start();
  const api = new OperatorApi(f.service, [f.dataDir]);
  const state = async () => {
    const read = api.readClaudeTokenStatus();
    const text =
      JSON.stringify(read) + JSON.stringify(await api.readWorkspace());
    assert.equal(text.includes(path), false);
    assert.equal(text.includes(FILE_TOKEN), false);
    return read.data.state;
  };
  await api.execute({
    type: "claude-token.configure",
    key: randomUUID(),
    credentialRef: `file:${path}`,
  });
  assert.equal(await state(), "available");
  chmodSync(path, 0o640);
  assert.equal(await state(), "missing-value");
});

test("a started Claude runtime's supported settings and effective policy parse into the harness status", async (t) => {
  const run = await claudeServiceRun(t, [
    async function* (session) {
      yield init(sessionOf(session));
      yield result(sessionOf(session));
    },
  ]);
  const before = run.service.harnessStatuses()[1];
  assert.equal(before?.harness, "claude");
  assert.match(before?.policy?.lines.join(" ") ?? "", /Ensemble's hook/);
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
