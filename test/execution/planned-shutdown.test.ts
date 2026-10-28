import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import {
  CaffeinateAssertion,
  type PowerEventBatch,
  type PowerEventSource,
} from "../../src/standalone/power.js";
import { StandaloneService } from "../../src/standalone/service.js";
import type { ExecutionState } from "../../src/standalone/state.js";
import { ExecutionSupervisor } from "../../src/standalone/supervisor.js";
import { databaseOf, startedOf } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  describe: () => unknown = () => undefined,
) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A runtime whose pending requests reject when it stops, as the real runtimes'
 * do. `interrupt` scripts how the harness answers an interrupt request.
 */
class ShutdownRuntime implements Runtime {
  interrupt: "clean" | "late-ack" | "complete" | "silent" | "hang" = "clean";
  autoComplete = false;
  startTurnGate: Promise<void> | undefined;
  startTurnFailure: Error | undefined;
  readonly startTurnEntered = deferred();
  readonly resumed: string[] = [];
  readonly prompts: string[] = [];
  readonly startedTurns: string[] = [];
  readonly interrupted: string[] = [];
  stopped = false;
  private threads = 0;
  private turns = 0;
  private readonly waits = new Map<
    string,
    ReturnType<typeof deferred<"completed" | "failed">>
  >();
  private readonly rejecters = new Set<(error: Error) => void>();

  constructor(
    readonly name: string,
    private readonly log: string[],
  ) {}

  private until<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.rejecters.add(reject);
      work.then(resolve, reject);
    });
  }

  private wait(turnId: string) {
    let entry = this.waits.get(turnId);
    if (!entry) {
      entry = deferred<"completed" | "failed">();
      this.waits.set(turnId, entry);
    }
    return entry;
  }

  async start() {}

  async stop() {
    this.stopped = true;
    this.log.push(`${this.name}:stop`);
    for (const reject of this.rejecters) reject(new Error("runtime stopped"));
    this.rejecters.clear();
  }

  async startThread() {
    return `${this.name}-thread-${++this.threads}`;
  }

  async resumeThread(threadId: string) {
    this.resumed.push(threadId);
  }

  async startTurn(_threadId?: string, _workspace?: string, prompt?: string) {
    this.log.push(`${this.name}:startTurn`);
    this.startTurnEntered.resolve();
    if (this.startTurnGate) await this.until(this.startTurnGate);
    if (this.startTurnFailure) {
      this.log.push(`${this.name}:startTurn-failed`);
      throw this.startTurnFailure;
    }
    const turnId = `${this.name}-turn-${++this.turns}`;
    this.prompts.push(prompt ?? "");
    this.startedTurns.push(turnId);
    if (this.autoComplete) this.wait(turnId).resolve("completed");
    return turnId;
  }

  async interruptTurn(_threadId: string, turnId: string) {
    this.log.push(`${this.name}:interrupt:${turnId}`);
    this.interrupted.push(turnId);
    if (this.interrupt === "clean") this.wait(turnId).resolve("failed");
    if (this.interrupt === "late-ack") {
      // The terminal status precedes the interrupt response.
      this.wait(turnId).resolve("failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.interrupt === "complete") this.wait(turnId).resolve("completed");
    if (this.interrupt === "hang")
      await this.until(new Promise<void>(() => {}));
  }

  waitForTurn(_threadId: string, turnId: string) {
    return this.until(this.wait(turnId).promise);
  }

  onUnexpectedRequest() {}
}

class PowerEvents implements PowerEventSource {
  async start() {}
  async readSince(requested: { version: 1; value: string } | null) {
    const cursor = requested ?? { version: 1 as const, value: "baseline" };
    return {
      complete: true,
      fromCursor: requested,
      cursor,
      events: [],
    } satisfies PowerEventBatch;
  }
}

/** An assertion whose start is gated, which holds admitted work before submission. */
class GatedAssertion extends CaffeinateAssertion {
  readonly gate = deferred();
  override async start() {
    await this.gate.promise;
  }
  override async stop() {}
}

interface Harnesses {
  codex: ShutdownRuntime;
  claude: ShutdownRuntime;
}

function newRuntimes(log: string[]): Harnesses {
  return {
    codex: new ShutdownRuntime("codex", log),
    claude: new ShutdownRuntime("claude", log),
  };
}

function serviceFor(
  root: string,
  runtimes: Harnesses,
  options: Partial<ConstructorParameters<typeof StandaloneService>[3]> = {},
) {
  return new StandaloneService(
    join(root, "data"),
    (_context, harness) => runtimes[harness as ExecutionHarness],
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
      supervisor: { shutdownWaitMs: 2000 },
      ...options,
    },
  );
}

/** One project with a task per requested harness, each with one running assignment. */
async function seed(service: StandaloneService, harnesses: ExecutionHarness[]) {
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
  const lead = randomUUID();
  const workers = {
    codex: randomUUID(),
    claude: randomUUID(),
  };
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Lead",
    instructions: "lead",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "profile.create",
    profileId: workers.codex,
    name: "Codex worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "profile.create",
    profileId: workers.claude,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: "opus", reasoningEffort: "high" },
  });
  const projectId = randomUUID();
  execute({
    type: "project.create",
    projectId,
    name: "Shutdown",
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
    candidateProfileIds: [workers.codex, workers.claude],
  });
  const tasks: { taskId: string; workId: string; harness: ExecutionHarness }[] =
    [];
  for (const harness of harnesses) {
    const taskId = randomUUID();
    const assignmentId = randomUUID();
    execute({
      type: "task.create",
      projectId,
      taskId,
      title: `${harness} task`,
      outcome: "Restart safely",
      ready: false,
    });
    await service.provisionTask(taskId);
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId: workers[harness],
      brief: "build",
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
    tasks.push({
      taskId,
      workId: `assignment:${assignmentId}:initial`,
      harness,
    });
  }
  return tasks;
}

const stateOf = (service: StandaloneService, workId: string) =>
  service.list().find((item) => item.workId === workId)?.state;

const describe = (service: StandaloneService) => () => ({
  intents: service.list().map((i) => [i.workId, i.state, i.reason]),
  requests: service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
});

async function untilRunning(
  service: StandaloneService,
  runtimes: ShutdownRuntime[],
  workIds: string[],
) {
  await waitUntil(
    () =>
      workIds.every((workId) => stateOf(service, workId) === "running") &&
      runtimes.every((runtime) => runtime.startedTurns.length > 0),
    describe(service),
  );
}

/** Reads the closed service's database, as the next start would find it. */
function readClosed<T>(root: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(join(root, "data", "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row })) as T[];
  } finally {
    db.close();
  }
}

const sandbox = (t: { after(fn: () => unknown): void }) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-planned-shutdown-"));
  const services: StandaloneService[] = [];
  t.after(async () => {
    for (const service of services) await service.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    track(service: StandaloneService) {
      services.push(service);
      return service;
    },
  };
};

interface IntentRow {
  workId: string;
  state: string;
  reason: string | null;
  threadId: string | null;
}

const intents = (root: string) =>
  readClosed<IntentRow>(
    root,
    "SELECT workId, state, reason, threadId FROM execution_intents ORDER BY rowid",
  );

const count = (root: string, table: string, workId?: string) =>
  readClosed<{ n: number }>(
    root,
    `SELECT COUNT(*) AS n FROM ${table}${workId ? " WHERE workId = ?" : ""}`,
    ...(workId ? [workId] : []),
  )[0]?.n;

/** What a restart after a requeue must show: the new work resumes the same thread. */
async function restartAndComplete(
  box: ReturnType<typeof sandbox>,
  oldWorkId: string,
  harness: ExecutionHarness,
  oldThread: string,
) {
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  runtimes.codex.autoComplete = true;
  runtimes.claude.autoComplete = true;
  const service = box.track(serviceFor(box.root, runtimes));
  await service.start();
  const requeue = readClosedOrLive(service, oldWorkId);
  await waitUntil(
    () => stateOf(service, requeue) === "completed",
    describe(service),
  );
  assert.deepEqual(runtimes[harness].resumed, [oldThread]);
  // The interrupted turn may not have delivered its prompt, so both instructions go again.
  for (const kind of ["project", "profile"])
    assert.match(
      runtimes[harness].prompts[0] ?? "",
      new RegExp(
        `^Updated ${kind} instructions\\. These replace all ${kind} instructions`,
        "m",
      ),
    );
  for (const workId of [oldWorkId, requeue]) {
    assert.notEqual(stateOf(service, workId), "held", workId);
    assert.equal(
      databaseOf(service)
        .prepare(
          "SELECT COUNT(*) AS n FROM execution_capacity_reservations WHERE workId = ?",
        )
        .get(workId)?.n,
      0,
      workId,
    );
  }
  assert.equal(
    databaseOf(service)
      .prepare("SELECT COUNT(*) AS n FROM execution_stop_targets")
      .get()?.n,
    0,
    "no shutdown target survives the restart",
  );
  return service;
}

function readClosedOrLive(service: StandaloneService, oldWorkId: string) {
  const row = databaseOf(service)
    .prepare(
      "SELECT requeueWorkId FROM execution_shutdown_resolutions WHERE interruptedWorkId = ?",
    )
    .get(oldWorkId) as { requeueWorkId: string } | undefined;
  assert.ok(row, "a shutdown resolution names the requeued work");
  return row.requeueWorkId;
}

// -- State API -------------------------------------------------------------

interface Running {
  service: StandaloneService;
  workId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  intentId: string;
  evidence(): Parameters<
    ReturnType<typeof startedOf>["state"]["resolveShutdownInterrupted"]
  >[0];
  /** What the supervisor and run loop record for a cleanly interrupted turn. */
  interruptCleanly(): void;
}

async function runningTask(
  t: { after(fn: () => unknown): void },
  harness: ExecutionHarness = "codex",
): Promise<Running & { box: ReturnType<typeof sandbox> }> {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  runtimes[harness].interrupt = "silent";
  const service = box.track(serviceFor(box.root, runtimes));
  await service.start();
  const [task] = await seed(service, [harness]);
  assert.ok(task);
  await untilRunning(service, [runtimes[harness]], [task.workId]);
  const { state } = startedOf(service);
  const intent = state.byWorkId(task.workId);
  assert.ok(intent?.threadId && intent.turnId);
  const { threadId, turnId } = intent;
  const identity = state.recoveryIdentity(task.workId);
  assert.ok(identity);
  return {
    box,
    service,
    workId: task.workId,
    taskId: task.taskId,
    threadId,
    turnId,
    intentId: intent.id,
    evidence: () => ({
      workId: task.workId,
      workRevision: identity.workRevision,
      requestSequence: identity.requestSequence,
      threadId,
      turnId,
      harness,
      callbacksEnded: true,
      noSurvivor: true,
    }),
    interruptCleanly() {
      state.claimStopInterrupt(task.workId);
      state.recordStopInterrupt(task.workId, "acknowledged");
      state.recordStopTerminal(task.workId, threadId, turnId, "failed");
      state.hold(intent.id, "Bound turn failed or was interrupted");
    },
  };
}

const one = <T>(service: StandaloneService, sql: string, ...params: string[]) =>
  databaseOf(service)
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row })) as T[];

test("a shutdown-interrupted turn is released and requeued in one transaction without using retries", async (t) => {
  const f = await runningTask(t);
  const { state } = startedOf(f.service);
  const [target] = state.beginShutdownInterrupts();
  assert.equal(target?.workId, f.workId);
  assert.equal(target?.origin, "shutdown");
  assert.equal(target?.interruptState, "pending");
  assert.deepEqual(
    state.beginShutdownInterrupts(),
    [],
    "only rows it inserted are returned",
  );
  f.interruptCleanly();
  const chainBefore = one(
    f.service,
    "SELECT * FROM execution_retry_chains ORDER BY chainId",
  );
  const generation = one<{ chainId: string; retryIndex: number }>(
    f.service,
    "SELECT chainId, retryIndex FROM execution_retry_generations WHERE workId = ?",
    f.workId,
  )[0];
  // A queued delivery batch bound to the old work follows the requeue.
  databaseOf(f.service)
    .prepare(
      `INSERT INTO coordination_delivery_batches
        (batchId, deliveryWorkId, taskId, recipientAssignmentId, assignmentVersion, highWaterSequence, state)
      VALUES ('batch', ?, ?, 'recipient', 1, 1, 'queued')`,
    )
    .run(f.workId, f.taskId);

  const result = state.resolveShutdownInterrupted(f.evidence());
  assert.ok(result);
  assert.equal(result.interruptedWorkId, f.workId);
  assert.match(result.requeueWorkId, /^shutdown:/);

  assert.equal(state.byWorkId(f.workId)?.state, "resolved-failed");
  assert.deepEqual(
    one(
      f.service,
      "SELECT state, reason FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
      f.workId,
    ),
    [{ state: "settled", reason: "Superseded by shutdown requeue" }],
  );
  for (const table of [
    "task_writer_admissions",
    "execution_capacity_reservations",
    "execution_stop_targets",
  ])
    assert.deepEqual(
      one(f.service, `SELECT 1 FROM ${table} WHERE workId = ?`, f.workId),
      [],
      table,
    );
  assert.equal(state.byWorkId(result.requeueWorkId)?.state, "ready");
  assert.deepEqual(
    one(
      f.service,
      "SELECT state, previousWorkId, nextEligibleAt FROM turn_requests WHERE workId = ?",
      result.requeueWorkId,
    ),
    [{ state: "queued", previousWorkId: f.workId, nextEligibleAt: null }],
  );
  assert.deepEqual(
    one(
      f.service,
      "SELECT previousWorkId, predecessorKnown FROM execution_request_predecessors WHERE workId = ?",
      result.requeueWorkId,
    ),
    [{ previousWorkId: f.workId, predecessorKnown: 1 }],
  );
  assert.deepEqual(
    one(
      f.service,
      "SELECT chainId, retryIndex FROM execution_retry_generations WHERE workId = ?",
      result.requeueWorkId,
    ),
    [generation],
  );
  assert.deepEqual(
    one(f.service, "SELECT * FROM execution_retry_chains ORDER BY chainId"),
    chainBefore,
  );
  assert.deepEqual(
    one(f.service, "SELECT deliveryWorkId FROM coordination_delivery_batches"),
    [{ deliveryWorkId: result.requeueWorkId }],
  );
  assert.equal(
    startedOf(f.service).coordination.isHistoricalWorkResolved(f.workId),
    true,
  );
  assert.deepEqual(state.shutdownRequeue(result.requeueWorkId), {
    interruptedWorkId: f.workId,
    requeueWorkId: result.requeueWorkId,
  });
});

test("replaying the same shutdown proof returns the same result and a mismatched proof throws", async (t) => {
  const f = await runningTask(t);
  const { state } = startedOf(f.service);
  state.beginShutdownInterrupts();
  f.interruptCleanly();
  const first = state.resolveShutdownInterrupted(f.evidence());
  assert.ok(first);
  const rowCount = () =>
    one<{ n: number }>(
      f.service,
      "SELECT COUNT(*) AS n FROM execution_intents",
    )[0]?.n;
  const before = rowCount();
  assert.deepEqual(state.resolveShutdownInterrupted(f.evidence()), first);
  assert.equal(rowCount(), before);
  assert.throws(
    () =>
      state.resolveShutdownInterrupted({ ...f.evidence(), turnId: "another" }),
    /does not match the committed generation/,
  );
});

test("any other hold keeps the interrupted generation held with its writer and capacity", async (t) => {
  const cases: Array<{ name: string; arrange(f: Running): void }> = [
    {
      name: "another pending effect",
      arrange: (f) => {
        startedOf(f.service).state.beginShutdownInterrupts();
        f.interruptCleanly();
        databaseOf(f.service)
          .prepare(
            "INSERT INTO execution_pending_effects (workId, effectKey, state, reason) VALUES (?, 'other-effect', 'pending', 'pending')",
          )
          .run(f.workId);
      },
    },
    {
      name: "an operator Stop before shutdown targets are recorded",
      arrange: (f) => {
        const { state } = startedOf(f.service);
        state.stopTask(f.taskId);
        state.beginShutdownInterrupts();
        f.interruptCleanly();
      },
    },
    {
      name: "an interrupt left uncertain",
      arrange: (f) => {
        const { state } = startedOf(f.service);
        state.beginShutdownInterrupts();
        state.claimStopInterrupt(f.workId);
        state.recordStopTerminal(f.workId, f.threadId, f.turnId, "failed");
        state.hold(f.intentId, "Bound turn failed or was interrupted");
      },
    },
    {
      name: "a queued successor naming the work",
      arrange: (f) => {
        startedOf(f.service).state.beginShutdownInterrupts();
        f.interruptCleanly();
        databaseOf(f.service)
          .prepare(
            "INSERT INTO turn_requests (requestKey, workId, kind, prompt, previousWorkId, state) VALUES ('succ', 'succ', 'direct', 'p', ?, 'queued')",
          )
          .run(f.workId);
      },
    },
  ];
  for (const { name, arrange } of cases) {
    await t.test(name, async (sub) => {
      const f = await runningTask(sub);
      const { state } = startedOf(f.service);
      arrange(f);
      assert.equal(state.resolveShutdownInterrupted(f.evidence()), undefined);
      for (const table of [
        "task_writer_admissions",
        "execution_capacity_reservations",
      ])
        assert.equal(
          one(f.service, `SELECT 1 FROM ${table} WHERE workId = ?`, f.workId)
            .length,
          1,
          table,
        );
      assert.equal(state.byWorkId(f.workId)?.state, "held");
      assert.equal(
        one<{ state: string }>(
          f.service,
          "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
          f.workId,
        )[0]?.state,
        "pending",
      );
      assert.deepEqual(
        one(
          f.service,
          "SELECT interruptedWorkId FROM execution_shutdown_resolutions",
        ),
        [],
      );
    });
  }
});

test("an operator Stop after shutdown targets exist converts the target and wins", async (t) => {
  const f = await runningTask(t);
  const { state } = startedOf(f.service);
  state.beginShutdownInterrupts();
  state.stopTask(f.taskId);
  assert.equal(state.stopTarget(f.workId)?.origin, "operator");
  state.claimStopInterrupt(f.workId);
  state.recordStopInterrupt(f.workId, "acknowledged");
  state.recordStopTerminal(f.workId, f.threadId, f.turnId, "failed");
  assert.equal(state.resolveShutdownInterrupted(f.evidence()), undefined);
  assert.equal(state.stopTarget(f.workId)?.origin, "operator");
  assert.equal(state.taskHold(f.taskId), "Task stopped");
  assert.equal(state.beginShutdownInterrupts().length, 0);
});

test("completion removes a shutdown target and reopening leaves exactly the restart hold", async (t) => {
  const completed = await runningTask(t);
  const done = startedOf(completed.service).state;
  done.beginShutdownInterrupts();
  assert.ok(done.stopTarget(completed.workId));
  done.complete(completed.intentId, completed.threadId, completed.turnId);
  assert.equal(done.stopTarget(completed.workId), undefined);

  const crashed = await runningTask(t);
  const { state } = startedOf(crashed.service);
  state.beginShutdownInterrupts();
  assert.ok(state.stopTarget(crashed.workId));
  state.holdUnfinishedOnOpen();
  assert.equal(state.stopTarget(crashed.workId), undefined);
  assert.deepEqual(
    {
      state: state.byWorkId(crashed.workId)?.state,
      reason: state.byWorkId(crashed.workId)?.reason,
    },
    { state: "held", reason: "service restarted with unresolved execution" },
  );
});

// -- Graceful shutdown -----------------------------------------------------

test("a running turn that interrupts cleanly is released, requeued and resumed on its thread after restart", async (t) => {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  const service = box.track(serviceFor(box.root, runtimes));
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await untilRunning(service, [runtimes.codex], [task.workId]);
  const oldThread = service
    .list()
    .find((i) => i.workId === task.workId)?.threadId;
  assert.ok(oldThread);

  await service.stop();

  assert.deepEqual(
    log.filter((entry) => entry.startsWith("codex:")),
    ["codex:startTurn", "codex:interrupt:codex-turn-1", "codex:stop"],
  );
  assert.equal(runtimes.codex.startedTurns.length, 1, "no successor admitted");
  const rows = intents(box.root);
  const old = rows.find((row) => row.workId === task.workId);
  assert.equal(old?.state, "resolved-failed");
  const requeue = rows.find((row) => row.workId.startsWith("shutdown:"));
  assert.equal(requeue?.state, "ready");
  assert.equal(count(box.root, "execution_capacity_reservations"), 0);
  assert.equal(count(box.root, "task_writer_admissions", task.workId), 0);
  assert.equal(count(box.root, "execution_stop_targets"), 0);

  await restartAndComplete(box, task.workId, "codex", oldThread);
});

test("a turn that never reports keeps today's hold and shutdown stays bounded", async (t) => {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  runtimes.codex.interrupt = "silent";
  const service = box.track(
    serviceFor(box.root, runtimes, {
      supervisor: { shutdownWaitMs: 200 },
    }),
  );
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await untilRunning(service, [runtimes.codex], [task.workId]);

  const started = Date.now();
  await service.stop();
  assert.ok(Date.now() - started < 200 + 2000, "stop is bounded");

  const old = intents(box.root).find((row) => row.workId === task.workId);
  assert.equal(old?.state, "held");
  assert.equal(count(box.root, "task_writer_admissions", task.workId), 1);
  assert.equal(count(box.root, "execution_capacity_reservations"), 1);
  assert.equal(
    readClosed<{ state: string }>(
      box.root,
      "SELECT state FROM execution_pending_effects WHERE workId = ? AND effectKey = 'assignment-result'",
      task.workId,
    )[0]?.state,
    "pending",
  );
  assert.equal(count(box.root, "execution_shutdown_resolutions"), 0);
  assert.equal(
    intents(box.root).filter((row) => row.workId.startsWith("shutdown:"))
      .length,
    0,
  );

  // The next start drops the transient target and keeps exactly today's hold.
  const restarted = box.track(serviceFor(box.root, newRuntimes([])));
  await restarted.start();
  assert.equal(stateOf(restarted, task.workId), "held");
  assert.equal(
    databaseOf(restarted)
      .prepare("SELECT COUNT(*) AS n FROM execution_stop_targets")
      .get()?.n,
    0,
  );
});

test("a turn that completes during the wait takes the normal completion path", async (t) => {
  const box = sandbox(t);
  const runtimes = newRuntimes([]);
  runtimes.codex.interrupt = "complete";
  const service = box.track(serviceFor(box.root, runtimes));
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await untilRunning(service, [runtimes.codex], [task.workId]);

  await service.stop();

  assert.equal(
    intents(box.root).find((row) => row.workId === task.workId)?.state,
    "completed",
  );
  assert.equal(count(box.root, "execution_shutdown_resolutions"), 0);
  assert.equal(count(box.root, "execution_stop_targets"), 0);
});

test("a submission in flight binds and is interrupted before the runtime stops", async (t) => {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  const gate = deferred();
  runtimes.codex.startTurnGate = gate.promise;
  const service = box.track(
    serviceFor(box.root, runtimes, { supervisor: { shutdownWaitMs: 3000 } }),
  );
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await runtimes.codex.startTurnEntered.promise;

  const stopping = service.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtimes.codex.stopped, false, "waiting for the submission");
  gate.resolve();
  await stopping;

  assert.deepEqual(runtimes.codex.interrupted, ["codex-turn-1"]);
  assert.deepEqual(
    log.filter((entry) => entry.startsWith("codex:")),
    ["codex:startTurn", "codex:interrupt:codex-turn-1", "codex:stop"],
  );
  const rows = intents(box.root);
  assert.equal(
    rows.find((row) => row.workId === task.workId)?.state,
    "resolved-failed",
  );
  assert.equal(
    rows.filter((row) => row.workId.startsWith("shutdown:")).length,
    1,
  );
});

test("a submission that fails ends held with its recorded reason before the runtime stops", async (t) => {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  const gate = deferred();
  runtimes.codex.startTurnGate = gate.promise;
  runtimes.codex.startTurnFailure = new Error("submission rejected");
  const service = box.track(
    serviceFor(box.root, runtimes, { supervisor: { shutdownWaitMs: 3000 } }),
  );
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await runtimes.codex.startTurnEntered.promise;

  const stopping = service.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtimes.codex.stopped, false);
  gate.resolve();
  await stopping;

  const entries = log.filter((entry) => entry.startsWith("codex:"));
  assert.deepEqual(entries, [
    "codex:startTurn",
    "codex:startTurn-failed",
    "codex:stop",
  ]);
  const old = intents(box.root).find((row) => row.workId === task.workId);
  assert.equal(old?.state, "held");
  assert.match(
    old?.reason ?? "",
    /Runtime submission or observation uncertain/,
  );
  assert.equal(count(box.root, "execution_shutdown_resolutions"), 0);
});

test("admitted work not yet submitted still binds and is requeued during shutdown", async (t) => {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  const assertion = new GatedAssertion();
  const service = box.track(
    serviceFor(box.root, runtimes, {
      power: {
        eventSource: new PowerEvents(),
        pollIntervalMs: 10,
        assertion,
      },
      supervisor: { shutdownWaitMs: 3000 },
    }),
  );
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await waitUntil(
    () => stateOf(service, task.workId) === "submitting",
    describe(service),
  );
  assert.equal(runtimes.codex.startedTurns.length, 0);

  const stopping = service.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertion.gate.resolve();
  await stopping;

  const rows = intents(box.root);
  const old = rows.find((row) => row.workId === task.workId);
  assert.equal(old?.state, "resolved-failed", String(old?.reason));
  assert.equal(
    rows.filter((row) => row.workId.startsWith("shutdown:")).length,
    1,
  );
});

test("a hung runtime of one harness does not stop another from being interrupted or the service from exiting", async (t) => {
  const box = sandbox(t);
  const log: string[] = [];
  const runtimes = newRuntimes(log);
  runtimes.claude.interrupt = "hang";
  const service = box.track(
    serviceFor(box.root, runtimes, {
      supervisor: { shutdownWaitMs: 200 },
    }),
  );
  await service.start();
  const tasks = await seed(service, ["codex", "claude"]);
  const codex = tasks.find((task) => task.harness === "codex");
  const claude = tasks.find((task) => task.harness === "claude");
  assert.ok(codex && claude);
  await untilRunning(
    service,
    [runtimes.codex, runtimes.claude],
    [codex.workId, claude.workId],
  );
  const codexThread = service
    .list()
    .find((i) => i.workId === codex.workId)?.threadId;
  assert.ok(codexThread);

  const started = Date.now();
  await service.stop();
  assert.ok(Date.now() - started < 200 + 2000, "stop is bounded");

  const firstStop = log.findIndex((entry) => entry.endsWith(":stop"));
  for (const prefix of ["codex:interrupt:", "claude:interrupt:"]) {
    const issued = log.findIndex((entry) => entry.startsWith(prefix));
    assert.ok(
      issued >= 0 && issued < firstStop,
      `${prefix} was issued before any runtime stopped`,
    );
  }
  const rows = intents(box.root);
  assert.equal(
    rows.find((row) => row.workId === codex.workId)?.state,
    "resolved-failed",
  );
  assert.equal(rows.find((row) => row.workId === claude.workId)?.state, "held");
  assert.equal(count(box.root, "task_writer_admissions", claude.workId), 1);

  const restarted = await restartAndComplete(
    box,
    codex.workId,
    "codex",
    codexThread,
  );
  assert.equal(stateOf(restarted, claude.workId), "held");
});

test("a Claude turn that interrupts cleanly is requeued on its thread", async (t) => {
  const box = sandbox(t);
  const runtimes = newRuntimes([]);
  const service = box.track(serviceFor(box.root, runtimes));
  await service.start();
  const [task] = await seed(service, ["claude"]);
  assert.ok(task);
  await untilRunning(service, [runtimes.claude], [task.workId]);
  const oldThread = service
    .list()
    .find((i) => i.workId === task.workId)?.threadId;
  assert.ok(oldThread);

  await service.stop();

  assert.equal(
    intents(box.root).find((row) => row.workId === task.workId)?.state,
    "resolved-failed",
  );
  await restartAndComplete(box, task.workId, "claude", oldThread);
});

test("an operator Stop before shutdown is not requeued and survives restart", async (t) => {
  const box = sandbox(t);
  const runtimes = newRuntimes([]);
  const service = box.track(
    serviceFor(box.root, runtimes, {
      supervisor: { observationMs: 50, shutdownWaitMs: 200 },
    }),
  );
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await untilRunning(service, [runtimes.codex], [task.workId]);
  await service.stopTask(task.taskId);

  await service.stop();

  assert.equal(
    intents(box.root).filter((row) => row.workId.startsWith("shutdown:"))
      .length,
    0,
  );
  assert.equal(count(box.root, "execution_shutdown_resolutions"), 0);
  assert.equal(
    readClosed(
      box.root,
      "SELECT 1 FROM task_writer_holds WHERE taskId = ?",
      task.taskId,
    ).length,
    1,
  );
  assert.equal(
    intents(box.root).find((row) => row.workId === task.workId)?.state,
    "held",
  );
});

test("the shutdown wait must be a positive integer", () => {
  for (const shutdownWaitMs of [0, -1, 1.5, Number.NaN])
    assert.throws(
      () =>
        new ExecutionSupervisor({} as ExecutionState, () => undefined, {
          shutdownWaitMs,
        }),
      /Shutdown wait must be a positive integer/,
    );
});

test("an interrupt response that arrives after the terminal status still releases the turn", async (t) => {
  const box = sandbox(t);
  const runtimes = newRuntimes([]);
  runtimes.codex.interrupt = "late-ack";
  const service = box.track(serviceFor(box.root, runtimes));
  await service.start();
  const [task] = await seed(service, ["codex"]);
  assert.ok(task);
  await untilRunning(service, [runtimes.codex], [task.workId]);

  await service.stop();

  assert.equal(
    intents(box.root).find((row) => row.workId === task.workId)?.state,
    "resolved-failed",
  );
  assert.equal(count(box.root, "execution_shutdown_resolutions"), 1);
});
