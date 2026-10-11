import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Runtime } from "../src/standalone/codex.js";
import type { ExecutionHarness } from "../src/standalone/execution-harness.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

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
  });
  f.configure(`env:${NAME}`);
  await f.service.stop();
  await f.service.start();
  const empty = f.claude().turnEnvironment();
  assert.deepEqual(empty, {
    unavailable:
      "Claude runtime unavailable: subscription token is unavailable",
  });
  assert.equal(JSON.stringify(empty).includes(NAME), false);
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
