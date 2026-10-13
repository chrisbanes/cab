import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "../fixtures/temp.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { StandaloneService } from "../../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import { startedOf } from "../fixtures/service-internals.js";

interface StopOutcome {
  workId: string;
  threadId: string | null;
  turnId: string | null;
  interrupt: "acknowledged" | "failed" | "unbound";
  terminal: "observed" | "unknown";
  reason?: string;
}

interface StopObservation {
  taskId: string;
  observationMs: number;
  outcomes: StopOutcome[];
}

interface SupervisorClock {
  monotonicNow(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

interface ServiceOptions {
  supervisor?: { clock: SupervisorClock; observationMs: number };
}

class ManualClock implements SupervisorClock {
  private now = 0;
  private sleeper:
    | { deadline: number; resolve(): void; reject(error: Error): void }
    | undefined;

  monotonicNow() {
    return this.now;
  }

  get sleeping() {
    return this.sleeper !== undefined;
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const sleeper = { deadline: this.now + milliseconds, resolve, reject };
      this.sleeper = sleeper;
      signal.addEventListener(
        "abort",
        () => {
          if (this.sleeper === sleeper) this.sleeper = undefined;
          reject(new Error("Observation cancelled"));
        },
        { once: true },
      );
    });
  }

  advance(milliseconds: number) {
    this.now += milliseconds;
    const sleeper = this.sleeper;
    if (sleeper && this.now >= sleeper.deadline) {
      this.sleeper = undefined;
      sleeper.resolve();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

class SupervisorRuntime implements Runtime {
  threads = 0;
  turns = 0;
  prompts: string[] = [];
  interrupts: Array<{ threadId: string; turnId: string }> = [];
  interruptError: Error | undefined;
  interruptGate: Promise<void> | undefined;
  startThreadGate: Promise<string> | undefined;
  startTurnGate: Promise<string> | undefined;
  turnGate: Promise<void> | undefined;
  turnEntered: (() => void) | undefined;
  threadStartEntered: (() => void) | undefined;
  turnStartEntered: (() => void) | undefined;
  beforeInterrupt: (() => void) | undefined;
  terminal: "completed" | "failed" = "completed";
  private anomaly?: (event: {
    threadId?: string;
    turnId?: string;
    reason: string;
  }) => void;
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;

  async start() {}
  async stop() {}

  async startThread() {
    this.threadStartEntered?.();
    return this.startThreadGate ?? `thread-${++this.threads}`;
  }

  async resumeThread() {}

  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    this.turnStartEntered?.();
    this.prompts.push(prompt);
    return this.startTurnGate ?? `turn-${++this.turns}`;
  }

  async waitForTurn(threadId: string, turnId: string) {
    await this.toolCall?.({
      threadId,
      turnId,
      callId: `fixture-question-${threadId}-${turnId}`,
      tool: "ensemble_ask_question",
      arguments: {
        question: "Supervisor fixture is waiting for the next step",
      },
    });
    this.turnEntered?.();
    await this.turnGate;
    return this.terminal;
  }

  async interruptTurn(threadId: string, turnId: string) {
    this.beforeInterrupt?.();
    await this.interruptGate;
    if (this.interruptError) throw this.interruptError;
    this.interrupts.push({ threadId, turnId });
  }

  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}

  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }

  onTerminalAnomaly(
    listener: (event: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ) {
    this.anomaly = listener;
  }

  reportAnomaly(event: { threadId?: string; turnId?: string; reason: string }) {
    this.anomaly?.(event);
  }
}

function createService(
  dataDir: string,
  runtime: SupervisorRuntime,
  options?: ServiceOptions,
) {
  const ServiceWithOptions = StandaloneService as unknown as new (
    dataDir: string,
    runtimeFactory: () => Runtime,
    markerWriter?: (path: string, flag: "wx" | "w") => void,
    options?: ServiceOptions,
  ) => StandaloneService;
  return new ServiceWithOptions(dataDir, () => runtime, undefined, options);
}

async function fixture(options?: ServiceOptions) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-supervisor-"));
  const runtime = new SupervisorRuntime();
  const service = createService(join(root, "data"), runtime, options);
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  await service.start();
  execute({
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Builder",
    instructions: "build",
    capabilities: "code",
  });
  execute({
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  execute({
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Task",
    outcome: "Deliver",
    ready: false,
  });
  await service.provisionTask(taskId);
  execute({
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Initial work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute({
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  assert.equal(
    await waitUntil(
      () =>
        service
          .list()
          .find((item) => item.workId === `assignment:${assignmentId}:initial`)
          ?.state === "completed",
    ),
    true,
  );
  runtime.prompts = [];
  return {
    root,
    dataDir: join(root, "data"),
    service,
    runtime,
    projectId,
    taskId,
    profileId,
    assignmentId,
    execute,
    async close() {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Stop during delayed turn/start records the late identity, interrupts once, and observes for three seconds", async () => {
  const clock = new ManualClock();
  const f = await fixture({
    supervisor: { clock, observationMs: 3000 },
  });
  const turnStart = deferred<string>();
  const turnStartEntered = deferred<void>();
  f.runtime.startTurnGate = turnStart.promise;
  f.runtime.turnStartEntered = turnStartEntered.resolve;
  try {
    const run = f.service.submitTask(
      "stopped-during-turn-start",
      f.assignmentId,
      "Write safely",
    );
    await turnStartEntered.promise;
    const stopping = f.service.stopTask(
      f.taskId,
    ) as unknown as Promise<StopObservation>;
    assert.equal(f.service.taskHold(f.taskId), "Task stopped");
    assert.equal(
      f.service
        .list()
        .find((item) => item.workId === "stopped-during-turn-start")?.state,
      "held",
    );
    assert.equal(await waitUntil(() => clock.sleeping), true);
    assert.deepEqual(f.runtime.interrupts, []);

    turnStart.resolve("turn-late");
    assert.equal(
      await waitUntil(() => f.runtime.interrupts.length === 1),
      true,
    );
    assert.deepEqual(f.runtime.interrupts, [
      { threadId: "thread-2", turnId: "turn-late" },
    ]);
    clock.advance(3000);
    const observation = await stopping;
    assert.deepEqual(observation, {
      taskId: f.taskId,
      observationMs: 3000,
      outcomes: [
        {
          workId: "stopped-during-turn-start",
          threadId: "thread-2",
          turnId: "turn-late",
          interrupt: "acknowledged",
          terminal: "unknown",
          reason: "No terminal status observed during the bounded window",
        },
      ],
    });
    assert.equal((await run).state, "held");
    assert.equal(
      f.service.capacityLimits([f.projectId]).currentUsage.global,
      1,
    );
  } finally {
    turnStart.resolve("turn-late");
    await f.close();
  }
});

test("Stop before capacity admission keeps queued work stopped until explicit resume", async () => {
  const f = await fixture();
  const activeGate = deferred<void>();
  const entered = deferred<void>();
  try {
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
    f.runtime.turnGate = activeGate.promise;
    f.runtime.turnEntered = entered.resolve;
    const active = f.service.submitTask(
      "active-parent",
      f.assignmentId,
      "Parent",
    );
    await entered.promise;

    const stoppedTaskId = randomUUID();
    const stoppedAssignmentId = randomUUID();
    f.execute({
      type: "task.create",
      actor: "operator",
      projectId: f.projectId,
      taskId: stoppedTaskId,
      title: "Stopped before admission",
      outcome: "Wait",
      ready: false,
    });
    await f.service.provisionTask(stoppedTaskId);
    f.execute({
      type: "assignment.create",
      actor: "agent",
      projectId: f.projectId,
      taskId: stoppedTaskId,
      assignmentId: stoppedAssignmentId,
      profileId: f.profileId,
      brief: "Queued worker",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    f.execute({
      type: "task.configure",
      actor: "operator",
      projectId: f.projectId,
      taskId: stoppedTaskId,
      expectedVersion: 1,
      ready: true,
    });
    const queuedWorkId = `assignment:${stoppedAssignmentId}:initial`;
    assert.equal(
      await waitUntil(
        () =>
          f.service.list().find((item) => item.workId === queuedWorkId)
            ?.state === "capacity-waiting",
      ),
      true,
    );
    const stopping = f.service.stopTask(
      stoppedTaskId,
    ) as unknown as Promise<StopObservation>;
    const observation = await stopping;
    assert.deepEqual(observation.outcomes, []);
    assert.equal(f.service.taskHold(stoppedTaskId), "Task stopped");

    activeGate.resolve();
    assert.equal((await active).state, "completed");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(
      f.runtime.prompts.some((prompt) => prompt.startsWith("Queued worker")),
      false,
    );
    assert.notEqual(
      f.service.list().find((item) => item.workId === queuedWorkId)?.state,
      "running",
    );

    await f.service.resumeTask(stoppedTaskId);
    assert.equal(
      await waitUntil(() =>
        f.runtime.prompts.some((prompt) => prompt.startsWith("Queued worker")),
      ),
      true,
    );
    assert.equal(
      f.runtime.prompts.filter((prompt) => prompt.startsWith("Queued worker"))
        .length,
      1,
    );
  } finally {
    activeGate.resolve();
    await f.close();
  }
});

function internals(service: StandaloneService) {
  return {
    db: (service as unknown as { db: DatabaseSync }).db,
    ...startedOf(service),
  };
}

function stopRow(service: StandaloneService, workId: string) {
  return internals(service)
    .db.prepare(
      "SELECT interruptState, reason FROM execution_stop_targets WHERE workId = ?",
    )
    .get(workId) as { interruptState: string; reason: string | null };
}

/** Stops a bound running turn whose interrupt request waits on a gate. */
async function stopBoundTurn(options: { interruptError?: Error } = {}) {
  const clock = new ManualClock();
  const f = await fixture({ supervisor: { clock, observationMs: 3000 } });
  const turn = deferred<void>();
  const entered = deferred<void>();
  const interrupt = deferred<void>();
  f.runtime.turnGate = turn.promise;
  f.runtime.turnEntered = entered.resolve;
  f.runtime.interruptGate = interrupt.promise;
  f.runtime.interruptError = options.interruptError;
  const run = f.service.submitTask("stoppable", f.assignmentId, "Write");
  await entered.promise;
  const stopping = f.service.stopTask(f.taskId);
  assert.equal(await waitUntil(() => clock.sleeping), true);
  return {
    ...f,
    clock,
    stopping,
    interrupt,
    row: () => stopRow(f.service, "stoppable"),
    async observe() {
      clock.advance(3000);
      return (await stopping).outcomes.find(
        (outcome) => outcome.workId === "stoppable",
      );
    },
    async close() {
      interrupt.resolve();
      turn.resolve();
      await run.catch(() => {});
      await f.close();
    },
  };
}

test("an uncertain Stop interrupt is typed state and settles from a late acknowledgement", async () => {
  const f = await stopBoundTurn();
  try {
    assert.deepEqual(
      { ...f.row() },
      {
        interruptState: "uncertain",
        reason: null,
      },
    );
    const outcome = await f.observe();
    assert.equal(outcome?.interrupt, "failed");
    assert.equal(outcome?.reason, "Interrupt request outcome is uncertain");

    f.interrupt.resolve();
    assert.equal(
      await waitUntil(() => f.row().interruptState === "acknowledged"),
      true,
    );
    assert.equal(f.row().reason, null);
    const again = f.service.stopTask(f.taskId);
    assert.equal(await waitUntil(() => f.clock.sleeping), true);
    f.clock.advance(3000);
    assert.equal(
      (await again).outcomes.find((item) => item.workId === "stoppable")
        ?.interrupt,
      "acknowledged",
    );
  } finally {
    await f.close();
  }
});

test("a failed Stop interrupt request is typed failed with neutral text", async () => {
  const f = await stopBoundTurn({ interruptError: new Error("refused") });
  try {
    f.interrupt.resolve();
    assert.equal(
      await waitUntil(() => f.row().interruptState === "failed"),
      true,
    );
    assert.equal(f.row().reason, null);
    const outcome = await f.observe();
    assert.equal(outcome?.interrupt, "failed");
    assert.equal(outcome?.reason, "Interrupt request failed");
  } finally {
    await f.close();
  }
});

test("an anomaly blocks a late Stop acknowledgement", async () => {
  const f = await stopBoundTurn();
  const reason =
    "A runtime terminal report conflicted with the bound execution";
  try {
    internals(f.service).state.recordStopAnomaly("stoppable", reason);
    assert.deepEqual({ ...f.row() }, { interruptState: "failed", reason });
    f.interrupt.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual({ ...f.row() }, { interruptState: "failed", reason });
    assert.equal((await f.observe())?.reason, reason);
  } finally {
    await f.close();
  }
});

test("Stop target reason text is display-only", async () => {
  const f = await stopBoundTurn();
  try {
    const { db, state } = internals(f.service);
    db.prepare(
      "UPDATE execution_stop_targets SET reason = 'Arbitrary text' WHERE workId = 'stoppable'",
    ).run();
    state.recordStopInterrupt("stoppable", "acknowledged");
    assert.deepEqual(
      { ...f.row() },
      {
        interruptState: "acknowledged",
        reason: null,
      },
    );
  } finally {
    await f.close();
  }
});

test("legacy reason-text Stop targets migrate to typed interrupt state", async () => {
  const f = await fixture({
    supervisor: { clock: new ManualClock(), observationMs: 3000 },
  });
  const legacyUncertain = "Codex interrupt request outcome is uncertain";
  const legacyFailed = "Codex interrupt request failed";
  const rows: Array<
    [string, string, string | null, string, string | null, string]
  > = [
    // workId, interruptState, reason, terminalState, threadId, expected
    ["crash", "failed", legacyUncertain, "unknown", "t-crash", "uncertain"],
    ["legacy-failed", "failed", legacyFailed, "unknown", "t-f", "failed"],
    [
      "conflict",
      "failed",
      "Conflicting late execution identity",
      "unknown",
      "t-c",
      "failed",
    ],
    [
      "anomaly",
      "failed",
      "Known unfinished execution remains after terminal status",
      "unknown",
      "t-a",
      "failed",
    ],
    ["pending", "pending", null, "unknown", null, "pending"],
    ["acked", "acknowledged", null, "completed", "t-ack", "acknowledged"],
    ["unbound", "unbound", null, "unknown", null, "unbound"],
  ];
  const dbPath = join(f.dataDir, "standalone.sqlite");
  const select = (db: DatabaseSync) =>
    db
      .prepare(
        "SELECT workId, interruptState, reason FROM execution_stop_targets ORDER BY workId",
      )
      .all()
      .map((row) => ({ ...row }));
  const storedSql = (db: DatabaseSync) =>
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='execution_stop_targets'",
        )
        .get() as { sql: string }
    ).sql;
  const columns = (db: DatabaseSync) =>
    JSON.stringify(
      db.prepare("PRAGMA table_info(execution_stop_targets)").all(),
    );
  let service = f.service;
  try {
    await service.stopTask(f.taskId);
    await service.stop();

    const legacy = new DatabaseSync(dbPath);
    const sql = storedSql(legacy);
    const before = columns(legacy);
    legacy.exec("BEGIN IMMEDIATE");
    legacy.exec(
      sql
        .replace("execution_stop_targets", "legacy_stop_targets")
        .replace("'pending','uncertain',", "'pending',"),
    );
    legacy.exec(`INSERT INTO legacy_stop_targets SELECT * FROM execution_stop_targets;
      DROP TABLE execution_stop_targets;
      ALTER TABLE legacy_stop_targets RENAME TO execution_stop_targets;`);
    for (const [workId, interruptState, reason, terminal, threadId] of rows) {
      legacy
        .prepare(
          "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, threadId, turnId, accountType, sandbox, approval) VALUES (?, ?, 'Fixture', '/tmp', 'held', 'Fixture hold', ?, ?, 'chatgpt', 'workspaceWrite', 'never')",
        )
        .run(randomUUID(), workId, threadId, threadId && `${threadId}-turn`);
      legacy
        .prepare(
          "INSERT INTO execution_stop_targets (taskId, workId, threadId, turnId, interruptState, terminalState, reason, requestedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .run(
          f.taskId,
          workId,
          threadId,
          threadId && `${threadId}-turn`,
          interruptState,
          terminal,
          reason,
        );
    }
    legacy.exec("COMMIT");
    assert.doesNotMatch(storedSql(legacy), /'uncertain'/);
    assert.deepEqual(
      select(legacy).find((row) => row.workId === "crash")?.reason,
      legacyUncertain,
    );
    legacy.close();

    const reopen = async () => {
      const runtime = new SupervisorRuntime();
      const next = createService(f.dataDir, runtime, {
        supervisor: { clock: new ManualClock(), observationMs: 3000 },
      });
      await next.start();
      return { next, runtime };
    };
    let opened = await reopen();
    service = opened.next;
    const { db } = internals(service);
    assert.match(storedSql(db), /'uncertain'/);
    assert.equal(columns(db), before);
    const migrated = select(db);
    assert.deepEqual(
      migrated,
      rows
        .map(([workId, , reason, , , expected]) => ({
          workId,
          interruptState: expected,
          reason:
            reason === legacyUncertain || reason === legacyFailed
              ? null
              : reason,
        }))
        .sort((a, b) => a.workId.localeCompare(b.workId)),
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    await service.stop();
    opened = await reopen();
    service = opened.next;
    assert.deepEqual(select(internals(service).db), migrated);
    assert.match(storedSql(internals(service).db), /'uncertain'/);

    const observation = await service.stopTask(f.taskId);
    const reasonOf = (workId: string) =>
      observation.outcomes.find((outcome) => outcome.workId === workId)?.reason;
    assert.equal(reasonOf("crash"), "Interrupt request outcome is uncertain");
    assert.equal(reasonOf("legacy-failed"), "Interrupt request failed");
    assert.doesNotMatch(JSON.stringify(observation), /Codex/);

    await service.resumeTask(f.taskId);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(service.isTaskStopped(f.taskId), false);
    assert.equal(stopRow(service, "crash").interruptState, "uncertain");
    assert.equal(
      service.list().find((item) => item.workId === "crash")?.state,
      "held",
    );
    assert.equal(opened.runtime.turns, 0);

    const after = internals(service);
    for (const [workId] of rows)
      after.state.recordStopInterrupt(workId, "acknowledged");
    assert.deepEqual(
      select(after.db),
      migrated.map((row) =>
        row.workId === "crash"
          ? { ...row, interruptState: "acknowledged" }
          : row,
      ),
    );
  } finally {
    await service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
