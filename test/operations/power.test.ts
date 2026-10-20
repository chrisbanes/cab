import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { ExecutionState } from "../../src/standalone/state.js";

interface PowerEventCursor {
  version: 1;
  value: string;
}

interface TestPowerEvent {
  cursor: PowerEventCursor;
  previousCursor: PowerEventCursor | null;
  transition: "sleep" | "wake";
}

interface PowerEventSource {
  readSince(cursor: PowerEventCursor | null): Promise<{
    complete: boolean;
    fromCursor: PowerEventCursor | null;
    cursor: PowerEventCursor | null;
    events: TestPowerEvent[];
  }>;
  lastSleepOrWakeAt?(): Promise<number>;
}

interface CaffeinateAssertionPort {
  on(event: string, listener: (reason: unknown) => void): this;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ExecutionPowerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  poll(): Promise<void>;
  executionStarted(workId: string): Promise<void>;
  executionEnded(workId: string): Promise<void>;
  admissionHeld(): boolean;
  observedForAdmission(now?: number): boolean;
  status(): { assertionFailure: string | null };
}

// These runtime imports deliberately fail against the pre-T6 baseline.
const powerModulePath: string = "../../src/standalone/power.js";
const powerModule = await import(powerModulePath);
const CaffeinateAssertion = powerModule.CaffeinateAssertion as unknown as new (
  spawn: (command: string, args: string[]) => FakeChild,
) => CaffeinateAssertionPort;
const ExecutionPower = powerModule.ExecutionPower as unknown as new (
  state: ExecutionState,
  events: PowerEventSource,
  assertion: CaffeinateAssertionPort,
  reconcile: () => Promise<void>,
) => ExecutionPowerPort;
const parsePmsetPowerLog = powerModule.parsePmsetPowerLog as (
  output: string,
  cursor: PowerEventCursor | null,
) => Awaited<ReturnType<PowerEventSource["readSince"]>>;
type PowerLogReader = (
  command: string,
  args: string[],
  options: { timeoutMs: number; idleTimeoutMs: number; maxLineBytes: number },
) => AsyncIterable<string>;
const MacPowerEventSource = powerModule.MacPowerEventSource as unknown as new (
  readLog?: PowerLogReader,
  timeoutMs?: number,
  idleTimeoutMs?: number,
  maxLineBytes?: number,
  now?: () => number,
  readSleepTimes?: () => Promise<string>,
) => PowerEventSource;
const spawnPowerLogReader = powerModule.spawnPowerLogReader as PowerLogReader;
interface PowerSignals {
  transition(kind: "sleep" | "wake"): void;
  failure(reason: string): void;
}
interface SleepWakeListenerPort {
  start(signals: PowerSignals): Promise<void>;
  stop(): Promise<void>;
}
const SleepWakeListener = powerModule.SleepWakeListener as new (
  spawn?: (command: string, args: string[]) => ListenerChild,
  startTimeoutMs?: number,
  stopTimeoutMs?: number,
) => SleepWakeListenerPort;
const MacPowerEventSourceWithListener =
  powerModule.MacPowerEventSource as unknown as new (
    readLog: PowerLogReader | undefined,
    timeoutMs: number,
    idleTimeoutMs: number,
    maxLineBytes: number,
    now: () => number,
    readSleepTimes: (() => Promise<string>) | undefined,
    listener: SleepWakeListenerPort,
  ) => PowerEventSource & {
    start(signals: PowerSignals): Promise<void>;
    stop(): Promise<void>;
  };
const PowerLogReadTimeout = powerModule.PowerLogReadTimeout as new (
  kind: "idle" | "total",
) => Error & { kind: "idle" | "total" };

class FakePowerEvents implements PowerEventSource {
  cursor: PowerEventCursor | null = null;
  complete = true;
  events: TestPowerEvent[] = [];
  stopCalls = 0;
  failStop = false;
  stopFailure: unknown;
  lastSleepOrWakeAt?: () => Promise<number>;

  async readSince(cursor: PowerEventCursor | null) {
    const requested = cursor;
    const first = this.events.findIndex((event) =>
      sameCursor(event.previousCursor, requested),
    );
    return {
      complete: this.complete,
      fromCursor: requested,
      cursor: this.cursor,
      events: first < 0 ? [] : this.events.slice(first),
    };
  }

  async stop() {
    this.stopCalls++;
    if (this.failStop) throw this.stopFailure;
  }
}

function powerCursor(value: string): PowerEventCursor {
  return { version: 1, value };
}

function sameCursor(
  left: PowerEventCursor | null,
  right: PowerEventCursor | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.version === right.version &&
        left.value === right.value;
}

class FakeChild extends EventEmitter {
  killed = 0;

  constructor(private readonly automaticClose = true) {
    super();
  }

  kill() {
    this.killed++;
    if (this.automaticClose)
      queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }
}

/** A listener child whose stdout the test writes; it closes when killed unless told otherwise. */
class ListenerChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly signals: string[] = [];

  constructor(private readonly closeOn: "SIGTERM" | "SIGKILL" | "any" = "any") {
    super();
  }

  write(text: string) {
    this.stdout.write(text);
  }

  kill(signal: string) {
    this.signals.push(signal);
    if (this.closeOn === "any" || this.closeOn === signal)
      queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

/** A spawn that records listener children and makes each one ready. */
function readyListenerSpawn(children: ListenerChild[] = []) {
  return (command: string, args: string[]) => {
    assert.equal(command, "/usr/bin/osascript");
    assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
    const child = new ListenerChild();
    children.push(child);
    setImmediate(() => child.write("ready\n"));
    return child;
  };
}

function signalRecorder() {
  const seen: string[] = [];
  return {
    seen,
    signals: {
      transition: (kind: string) => seen.push(kind),
      failure: (reason: string) => seen.push(`failure: ${reason}`),
    } as PowerSignals,
  };
}

function powerStore(path: string) {
  const db = new DatabaseSync(path);
  new Store(db).ensureHost("standalone-codex");
  new DomainStore(db).migrate();
  return { db, state: new ExecutionState(db) };
}

function begin(state: ExecutionState, workId: string, workspace: string) {
  const intent = state.create(workId, `prompt:${workId}`, workspace);
  assert.equal(state.begin(intent.id), true);
  return intent;
}

function hasWriterOrCapacity(db: DatabaseSync, workId: string) {
  const writer = db
    .prepare("SELECT 1 FROM task_writer_admissions WHERE workId = ?")
    .get(workId);
  const capacity = db
    .prepare("SELECT 1 FROM execution_capacity_reservations WHERE workId = ?")
    .get(workId);
  return writer !== undefined || capacity !== undefined;
}

function waitUntil(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() >= deadline) reject(new Error("condition timed out"));
      else setTimeout(check, 0);
    };
    check();
  });
}

test("caffeinate holds exactly one idle-sleep assertion only while execution is active", async () => {
  const children: FakeChild[] = [];
  const invocations: Array<{ command: string; args: string[] }> = [];
  const assertion = new CaffeinateAssertion(
    (command: string, args: string[]) => {
      invocations.push({ command, args });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  );
  const events = new FakePowerEvents();
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const power = new ExecutionPower(state, events, assertion, async () => {});
  try {
    await power.start();
    assert.equal(
      invocations.length,
      0,
      "idle supervision must not prevent sleep",
    );
    await power.executionStarted("work-a");
    await power.executionStarted("work-b");
    assert.deepEqual(invocations, [
      {
        command: "/usr/bin/caffeinate",
        args: ["-i", "-w", String(process.pid)],
      },
    ]);
    await power.executionEnded("work-a");
    assert.equal(
      children[0]?.killed,
      0,
      "one remaining execution retains the assertion",
    );
    await power.executionEnded("work-b");
    assert.equal(
      children[0]?.killed,
      1,
      "last execution releases the assertion",
    );
    await power.executionStarted("work-c");
    assert.equal(invocations.length, 2);
    await power.stop();
    assert.equal(
      children[1]?.killed,
      1,
      "supervisor shutdown releases its assertion",
    );
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission observation needs a completed poll started after the last execution ended", async () => {
  let clock = 1_000_000;
  const clockMock = mock.method(Date, "now", () => clock);
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-observed-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const events = new FakePowerEvents();
  events.cursor = powerCursor("baseline");
  const assertion: CaffeinateAssertionPort = {
    on() {
      return this;
    },
    async start() {},
    async stop() {},
  };
  const power = new ExecutionPower(state, events, assertion, async () => {});
  try {
    await power.start();
    assert.equal(power.observedForAdmission(), false, "no completed poll");
    await power.poll();
    assert.equal(power.observedForAdmission(), true);

    await power.executionStarted("work-a");
    clock += 1;
    await power.executionEnded("work-a");
    assert.equal(power.observedForAdmission(), false, "stale after end");
    await power.poll();
    assert.equal(
      power.observedForAdmission(),
      false,
      "a poll starting in the same millisecond is not after the end",
    );

    // A poll already in flight when the execution ends does not count.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const readSince = events.readSince.bind(events);
    events.readSince = async (cursor) => {
      await readGate;
      return readSince(cursor);
    };
    clock += 1;
    const inFlight = power.poll();
    clock += 1;
    await power.executionStarted("work-b");
    await power.executionEnded("work-b");
    releaseRead();
    await inFlight;
    assert.equal(power.observedForAdmission(), false, "poll began before end");

    const slowPoll = async (readMs: number) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      events.readSince = async (cursor) => {
        await gate;
        return readSince(cursor);
      };
      clock += 1;
      const slow = power.poll();
      clock += readMs;
      release();
      await slow;
      events.readSince = readSince;
      return clock;
    };
    // Without proof that the Mac did not sleep, age counts from the poll's start.
    await slowPoll(20_000);
    assert.equal(power.observedForAdmission(), false, "unproven slow read");

    // With no sleep or wake since the poll started, age counts from completion.
    let transitionAt = 0;
    events.lastSleepOrWakeAt = async () => transitionAt;
    const completedAt = await slowPoll(20_000);
    assert.equal(power.observedForAdmission(), true, "slow poll is fresh");
    assert.equal(power.observedForAdmission(completedAt + 14_999), true);
    assert.equal(power.observedForAdmission(completedAt + 15_000), false);
    assert.equal(
      power.observedForAdmission(completedAt - 1),
      false,
      "a wall clock that moved backwards is stale",
    );
    await slowPoll(0);
    assert.equal(
      power.observedForAdmission(),
      true,
      "a check in the poll's own millisecond is fresh",
    );

    // A sleep or wake at or after the poll's start, or an unreadable time, is
    // not an observation; one before the start is.
    events.lastSleepOrWakeAt = async () => clock;
    await slowPoll(5_000);
    assert.equal(power.observedForAdmission(), false, "slept during the poll");
    transitionAt = clock;
    events.lastSleepOrWakeAt = async () => transitionAt;
    await slowPoll(5_000);
    assert.equal(power.observedForAdmission(), true, "woke before the poll");
    events.lastSleepOrWakeAt = async () => {
      throw new Error("injected sleep-clock failure");
    };
    await slowPoll(0);
    assert.equal(power.observedForAdmission(), false, "unknown sleep time");
    events.lastSleepOrWakeAt = async () => transitionAt;

    // A poll that throws does not refresh the observation.
    clock += 20_000;
    const admissionState = state.powerAdmissionState.bind(state);
    state.powerAdmissionState = () => {
      throw new Error("injected power-state failure");
    };
    await assert.rejects(power.poll(), /injected power-state failure/);
    state.powerAdmissionState = admissionState;
    assert.equal(power.observedForAdmission(), false, "failed poll is stale");
  } finally {
    clockMock.mock.restore();
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertion child failure is visible without releasing execution state", async () => {
  const children: FakeChild[] = [];
  const assertion = new CaffeinateAssertion(
    (command: string, args: string[]) => {
      assert.equal(command, "/usr/bin/caffeinate");
      assert.deepEqual(args, ["-i", "-w", String(process.pid)]);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  );
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-failure-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const power = new ExecutionPower(
    state,
    new FakePowerEvents(),
    assertion,
    async () => {},
  );
  try {
    const active = begin(
      state,
      "active-before-assertion-failure",
      "/workspace/a",
    );
    assert.equal(state.bindThread(active.id, "thread-a"), true);
    assert.equal(state.bindTurn(active.id, "turn-a"), true);
    await power.start();
    await power.executionStarted(active.workId);
    children[0]?.emit("close", 1, null);
    await waitUntil(() => power.status().assertionFailure !== null);
    assert.match(power.status().assertionFailure ?? "", /caffeinate.*exited/i);
    assert.equal(hasWriterOrCapacity(db, active.workId), true);
    // Work is still active, so the assertion is restarted with a fresh child.
    await waitUntil(() => children.length === 2);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("power stop attempts event-source cleanup after assertion failure and preserves holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-stop-assertion-"));
  const path = join(root, "power.sqlite");
  const { db, state } = powerStore(path);
  const active = begin(state, "active-at-power-stop", "/workspace/a");
  assert.equal(state.bindThread(active.id, "thread-a"), true);
  assert.equal(state.bindTurn(active.id, "turn-a"), true);
  state.holdPowerAdmission("Injected power-admission hold");
  const events = new FakePowerEvents();
  const assertionFailure = new Error("injected assertion stop failure");
  let assertionStops = 0;
  const assertion: CaffeinateAssertionPort = {
    on() {
      return this;
    },
    async start() {},
    async stop() {
      assertionStops++;
      throw assertionFailure;
    },
  };
  const power = new ExecutionPower(state, events, assertion, async () => {});
  try {
    await power.start();
    await power.executionStarted(active.workId);
    const result = await power.stop().then(
      () => ({ rejected: false as const, error: undefined }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    assert.equal(result.rejected, true);
    assert.equal(result.error, assertionFailure);
    assert.equal(assertionStops, 1);
    assert.equal(events.stopCalls, 1);
    assert.equal(state.get(active.id).state, "running");
    assert.equal(state.powerAdmissionState().held, true);

    db.close();
    const reopened = new DatabaseSync(path);
    try {
      const persisted = new ExecutionState(reopened);
      assert.equal(persisted.get(active.id).state, "running");
      assert.equal(persisted.powerAdmissionState().held, true);
    } finally {
      reopened.close();
    }
  } finally {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("power stop reports assertion and event-source failures in shutdown order", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-stop-both-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const queued = state.create("queued-at-power-stop", "prompt", "/workspace/a");
  state.holdPowerAdmission("Injected power-admission hold");
  const events = new FakePowerEvents();
  const assertionFailure = new Error("injected assertion stop failure");
  const eventSourceFailure = new Error("injected event-source stop failure");
  events.failStop = true;
  events.stopFailure = eventSourceFailure;
  const power = new ExecutionPower(
    state,
    events,
    {
      on() {
        return this;
      },
      async start() {},
      async stop() {
        throw assertionFailure;
      },
    },
    async () => {},
  );
  try {
    await power.start();
    const result = await power.stop().then(
      () => ({ rejected: false as const, error: undefined }),
      (error: unknown) => ({ rejected: true as const, error }),
    );
    assert.equal(result.rejected, true);
    assert.ok(result.error instanceof AggregateError);
    assert.deepEqual(result.error.errors, [
      assertionFailure,
      eventSourceFailure,
    ]);
    assert.match(result.error.message, /assertion stop/);
    assert.match(result.error.message, /power event source stop/);
    assert.equal(events.stopCalls, 1);
    assert.equal(state.get(queued.id).state, "ready");
    assert.equal(state.powerAdmissionState().held, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new execution racing final assertion release reacquires before its first turn", async () => {
  const children: FakeChild[] = [];
  const invocations: string[] = [];
  const assertion = new CaffeinateAssertion((command: string) => {
    invocations.push(command);
    const child = new FakeChild(false);
    children.push(child);
    return child;
  });
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-race-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const power = new ExecutionPower(
    state,
    new FakePowerEvents(),
    assertion,
    async () => {},
  );
  try {
    await power.start();
    await power.executionStarted("work-before-idle");
    const ending = power.executionEnded("work-before-idle");
    await waitUntil(() => children[0]?.killed === 1);
    const starting = power.executionStarted("work-after-idle");
    children[0]?.emit("close", 0, "SIGTERM");
    await Promise.all([ending, starting]);
    assert.deepEqual(invocations, [
      "/usr/bin/caffeinate",
      "/usr/bin/caffeinate",
    ]);
    assert.equal(
      children.length,
      2,
      "the newly active turn needs its own live assertion",
    );
  } finally {
    const stopping = power.stop();
    children[1]?.emit("close", 0, "SIGTERM");
    await stopping;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sleep/wake installs the durable admission gate before reconciling active generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-wake-"));
  const path = join(root, "power.sqlite");
  const { db, state } = powerStore(path);
  const active = state.create(
    "active-before-wake",
    "prompt:active-before-wake",
    "/workspace/active",
  );
  assert.equal(
    state.begin(active.id, { projectId: null, requestSequence: 1 }),
    true,
  );
  assert.equal(state.bindThread(active.id, "thread-active"), true);
  assert.equal(state.bindTurn(active.id, "turn-active"), true);
  const queued = state.create(
    "queued-during-wake",
    "queued",
    "/workspace/queued",
  );
  const events = new FakePowerEvents();
  events.cursor = powerCursor("wake-2");
  events.events = [
    {
      cursor: powerCursor("sleep-1"),
      previousCursor: null,
      transition: "sleep",
    },
    {
      cursor: powerCursor("wake-2"),
      previousCursor: powerCursor("sleep-1"),
      transition: "wake",
    },
  ];
  let reconciliations = 0;
  let releaseReconciliation!: () => void;
  const reconciliation = new Promise<void>(
    (resolve) => (releaseReconciliation = resolve),
  );
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      reconciliations++;
      assert.equal(
        power.admissionHeld(),
        true,
        "persist wake gate before T4 reconciliation starts",
      );
      state.recordRecoveryObservation(active.workId, "no-proof");
      await reconciliation;
    },
  );
  try {
    await power.start();
    const polling = power.poll();
    await waitUntil(() => reconciliations > 0);
    assert.equal(
      state.begin(queued.id),
      false,
      "new turn cannot enter admission during wake reconciliation",
    );
    assert.equal(state.get(queued.id).state, "capacity-waiting");
    assert.equal(hasWriterOrCapacity(db, queued.workId), false);
    assert.equal(
      hasWriterOrCapacity(db, active.workId),
      true,
      "wake never releases admitted ownership",
    );
    releaseReconciliation();
    await polling;
    assert.equal(power.admissionHeld(), false);
    assert.equal(
      state.begin(queued.id),
      true,
      "reconciled wake permits current admission checks to resume",
    );
    await power.poll();
    assert.equal(
      reconciliations,
      1,
      "duplicate wake reads do not reconcile or dispatch twice",
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        )
        .get(queued.workId)?.count,
      1,
    );
  } finally {
    releaseReconciliation();
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an incomplete or ambiguous power-event cursor persists a global hold across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-cursor-"));
  const path = join(root, "power.sqlite");
  const opened = powerStore(path);
  const events = new FakePowerEvents();
  events.complete = false;
  const power = new ExecutionPower(
    opened.state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(power.admissionHeld(), true);
    await power.stop();
    opened.db.close();
    const reopened = powerStore(path);
    try {
      const queued = reopened.state.create(
        "after-incomplete-cursor",
        "queued",
        "/workspace/next",
      );
      assert.equal(reopened.state.begin(queued.id), false);
      assert.equal(hasWriterOrCapacity(reopened.db, queued.workId), false);
    } finally {
      reopened.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repeated or out-of-order power cursor holds admission instead of guessing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-ambiguous-"));
  const path = join(root, "power.sqlite");
  const { db, state } = powerStore(path);
  const events = new FakePowerEvents();
  events.cursor = powerCursor("duplicate-2");
  events.events = [
    {
      cursor: powerCursor("duplicate-2"),
      previousCursor: null,
      transition: "sleep",
    },
    {
      cursor: powerCursor("duplicate-2"),
      previousCursor: powerCursor("duplicate-2"),
      transition: "wake",
    },
  ];
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(power.admissionHeld(), true);
    const queued = state.create(
      "after-ambiguous-cursor",
      "queued",
      "/workspace/next",
    );
    assert.equal(state.begin(queued.id), false);
    assert.equal(hasWriterOrCapacity(db, queued.workId), false);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wake cursor survives restart and an already reconciled wake is not replayed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-restart-"));
  const path = join(root, "power.sqlite");
  const opened = powerStore(path);
  const events = new FakePowerEvents();
  events.cursor = powerCursor("wake-2");
  events.events = [
    {
      cursor: powerCursor("sleep-1"),
      previousCursor: null,
      transition: "sleep",
    },
    {
      cursor: powerCursor("wake-2"),
      previousCursor: powerCursor("sleep-1"),
      transition: "wake",
    },
  ];
  let reconciliations = 0;
  const power = new ExecutionPower(
    opened.state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      reconciliations++;
    },
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(reconciliations, 1);
    await power.stop();
    opened.db.close();
    const reopened = powerStore(path);
    const afterRestart = new ExecutionPower(
      reopened.state,
      events,
      new CaffeinateAssertion(() => new FakeChild()),
      async () => {
        reconciliations++;
      },
    );
    try {
      await afterRestart.start();
      await afterRestart.poll();
      assert.equal(
        reconciliations,
        1,
        "durable cursor suppresses duplicate wake reconciliation",
      );
      const queued = reopened.state.create(
        "dispatch-after-restart",
        "queued",
        "/workspace/restarted",
      );
      assert.equal(reopened.state.begin(queued.id), true);
    } finally {
      await afterRestart.stop();
      reopened.db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wake admission stays held until every admitted generation is reconciled", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-power-pending-reconciliation-"),
  );
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const active = state.create(
    "active-needs-reconciliation",
    "prompt:active-needs-reconciliation",
    "/workspace/active",
  );
  assert.equal(
    state.begin(active.id, { projectId: null, requestSequence: 1 }),
    true,
  );
  assert.equal(state.bindThread(active.id, "thread-active"), true);
  assert.equal(state.bindTurn(active.id, "turn-active"), true);
  const events = new FakePowerEvents();
  events.cursor = powerCursor("wake-1");
  events.events = [
    { cursor: powerCursor("wake-1"), previousCursor: null, transition: "wake" },
  ];
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await power.start();
    await power.poll();
    assert.equal(
      power.admissionHeld(),
      true,
      "a callback without T4 observations cannot clear the gate",
    );
    const queued = state.create(
      "queued-behind-unreconciled-wake",
      "queued",
      "/workspace/next",
    );
    assert.equal(state.begin(queued.id), false);
    assert.equal(hasWriterOrCapacity(db, queued.workId), false);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete cursor can establish an idle baseline but not bypass active recovery", async () => {
  const idleRoot = mkdtempSync(join(tmpdir(), "ensemble-power-idle-baseline-"));
  const idle = powerStore(join(idleRoot, "power.sqlite"));
  const idleEvents = new FakePowerEvents();
  idleEvents.cursor = powerCursor("baseline-1");
  const idlePower = new ExecutionPower(
    idle.state,
    idleEvents,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  );
  try {
    await idlePower.start();
    await idlePower.poll();
    assert.equal(idlePower.admissionHeld(), false);
  } finally {
    await idlePower.stop();
    idle.db.close();
    rmSync(idleRoot, { recursive: true, force: true });
  }

  const activeRoot = mkdtempSync(
    join(tmpdir(), "ensemble-power-active-baseline-"),
  );
  const active = powerStore(join(activeRoot, "power.sqlite"));
  const intent = active.state.create(
    "active-without-history",
    "prompt",
    "/workspace/active",
  );
  assert.equal(
    active.state.begin(intent.id, { projectId: null, requestSequence: 1 }),
    true,
  );
  const activeEvents = new FakePowerEvents();
  activeEvents.cursor = powerCursor("baseline-1");
  const activePower = new ExecutionPower(
    active.state,
    activeEvents,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      active.state.recordRecoveryObservation(intent.workId, "no-proof");
    },
  );
  try {
    await activePower.start();
    await activePower.poll();
    assert.equal(
      activePower.admissionHeld(),
      true,
      "unknown pre-cursor history with active work must remain quarantined",
    );
  } finally {
    await activePower.stop();
    active.db.close();
    rmSync(activeRoot, { recursive: true, force: true });
  }
});

test("macOS pmset source accepts ordered sleep/wake rows and rejects gaps or ambiguous rows", async () => {
  const fixture = [
    "PM ASL data store: /var/log/powermanagement",
    "2026-09-29 09:50:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
    "2026-09-29 10:00:00 +0100 Sleep\tEntering Sleep state due to 'Clamshell Sleep'",
    "2026-09-29 10:05:00 +0100 Wake\tWake from Deep Idle due to EC.LidOpen",
    "2026-09-29 10:06:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
    "2026-09-29 10:07:00 +0100 : Showing all currently held IOKit power assertions",
    "Assertion status system-wide:",
    "   PreventSystemSleep             0",
    "Listed by owning process:",
    "Kernel Assertions: 0x0=NONE",
  ].join("\n");
  const readLog: PowerLogReader = async function* (command, args, options) {
    assert.equal(command, "/usr/bin/pmset");
    assert.deepEqual(args, ["-g", "log"]);
    assert.equal(options.timeoutMs, 2500);
    assert.equal(options.maxLineBytes, 4096);
    yield* fixture.split(/\r?\n/);
  };
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  const source = new MacPowerEventSource(
    readLog,
    2500,
    2500,
    4096,
    () => baselineMs,
  );
  const baseline = await source.readSince(null);
  assert.equal(baseline.complete, true);
  assert.deepEqual(baseline.cursor, powerCursor(`pmset-time:${baselineMs}`));
  const batch = await source.readSince(baseline.cursor);
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch.events.map((event) => event.transition),
    ["sleep", "wake"],
  );
  assert.deepEqual(batch.events[0]?.previousCursor, baseline.cursor);
  assert.deepEqual(batch.events[1]?.previousCursor, batch.events[0]?.cursor);
  assert.deepEqual(batch.cursor, batch.events[1]?.cursor);
  assert.equal(
    parsePmsetPowerLog(fixture, powerCursor("pmset-event:1:2:0123456789abcdef"))
      .complete,
    false,
  );

  const ambiguous = fixture.replace(
    "2026-09-29 10:06:00 +0100 Assertions",
    "2026-09-29 10:06:00 +0100 UnknownWakeSummary",
  );
  assert.equal(parsePmsetPowerLog(ambiguous, baseline.cursor).complete, false);
});

const pmsetRows = [
  "PM ASL data store: /var/log/powermanagement",
  "2026-09-29 09:50:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
  "2026-09-29 10:00:00 +0100 Sleep\tEntering Sleep state due to 'Clamshell Sleep'",
  "2026-09-29 10:05:00 +0100 Wake\tWake from Deep Idle due to EC.LidOpen",
  "2026-09-29 10:06:00 +0100 Sleep\tEntering Sleep state due to 'Idle Sleep'",
  "2026-09-29 10:07:00 +0100 Wake\tWake from Normal Sleep",
  "Assertion status system-wide:",
  "   PreventSystemSleep             0",
  "",
];

function printLines(lines: string[], eol: string): string[] {
  return ["-e", `process.stdout.write(${JSON.stringify(lines.join(eol))})`];
}

test("the default pmset reader streams lines so cursors match the whole-output parser, with CRLF or a trailing newline", async () => {
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  for (const eol of ["\n", "\r\n"]) {
    for (const text of [pmsetRows, [...pmsetRows, ""]]) {
      const reader: PowerLogReader = (_c, _a, options) =>
        spawnPowerLogReader(process.execPath, printLines(text, eol), options);
      const source = new MacPowerEventSource(
        reader,
        10_000,
        10_000,
        65_536,
        () => baselineMs,
      );
      const baseline = await source.readSince(null);
      const batch = await source.readSince(baseline.cursor);
      const expected = parsePmsetPowerLog(text.join(eol), baseline.cursor);
      assert.equal(batch.complete, true);
      assert.deepEqual(batch, expected);
      assert.deepEqual(
        batch.events.map((event) => event.cursor.value.split(":")[2]),
        ["2", "3", "4", "5"],
      );
      const resumed = await source.readSince(batch.events[1]?.cursor ?? null);
      assert.deepEqual(
        resumed.events.map((event) => event.transition),
        ["sleep", "wake"],
      );
    }
  }
});

const macos27Header = `Time stamp${" ".repeat(16)}Domain${" ".repeat(14)}\tMessage${" ".repeat(20)}\tDuration  \tDelay     `;
const macos27Separator = `==========${" ".repeat(16)}======${" ".repeat(14)}\t=======${" ".repeat(20)}\t========  \t=====     `;
const macos27Preamble = [
  "PM ASL data store: /var/log/powermanagement",
  "",
  macos27Header,
  macos27Separator,
  "UUID: (null)",
];
const macos27Rows = [
  "2026-09-29 09:50:00 +0100 Assertions\tPID 10(app) Created PreventUserIdleSystemSleep",
  "2026-09-29 10:00:00 +0100 Sleep\tEntering Sleep state due to 'Clamshell Sleep'",
  "2026-09-29 10:05:00 +0100 Wake\tWake from Deep Idle due to EC.LidOpen",
  "Assertion status system-wide:",
  "   PreventSystemSleep             0",
  "",
];
const macos27Log = [...macos27Preamble, ...macos27Rows];
const macos27BaselineMs = Date.parse("2026-09-29T08:59:00Z");

test("a macOS 27 column header gives a complete baseline and follow-up with cursors that count the skipped lines", async () => {
  const readLog: PowerLogReader = async function* () {
    yield* macos27Log;
  };
  const source = new MacPowerEventSource(
    readLog,
    2500,
    2500,
    4096,
    () => macos27BaselineMs,
  );
  const baseline = await source.readSince(null);
  assert.equal(baseline.complete, true);
  assert.deepEqual(
    baseline.cursor,
    powerCursor(`pmset-time:${macos27BaselineMs}`),
  );
  const batch = await source.readSince(baseline.cursor);
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch.events.map((event) => event.transition),
    ["sleep", "wake"],
  );
  assert.deepEqual(batch.events[0]?.previousCursor, baseline.cursor);
  assert.deepEqual(
    batch.events.map((event) => event.cursor.value.split(":")[2]),
    ["6", "7"],
  );
});

test("macOS 27 preamble output streams to the same batch as whole-output parsing, and a cursor that ignores the skipped lines is rejected", async () => {
  for (const eol of ["\n", "\r\n"]) {
    for (const text of [macos27Log, [...macos27Log, ""]]) {
      const reader: PowerLogReader = (_c, _a, options) =>
        spawnPowerLogReader(process.execPath, printLines(text, eol), options);
      const source = new MacPowerEventSource(
        reader,
        10_000,
        10_000,
        65_536,
        () => macos27BaselineMs,
      );
      const baseline = await source.readSince(null);
      const batch = await source.readSince(baseline.cursor);
      assert.equal(batch.complete, true);
      assert.deepEqual(
        batch,
        parsePmsetPowerLog(text.join(eol), baseline.cursor),
      );
      const resumed = await source.readSince(batch.events[0]?.cursor ?? null);
      assert.equal(resumed.complete, true);
      assert.deepEqual(
        resumed.events.map((event) => event.transition),
        ["wake"],
      );
    }
  }
});

test("an event cursor saved from headerless output resolves to the one matching row, and ambiguous or unsupported matches are rejected", () => {
  const baseline = powerCursor(`pmset-time:${macos27BaselineMs}`);
  // A real cursor from the pre-macOS 27 layout, where the first Sleep is line 2.
  const old = parsePmsetPowerLog(pmsetRows.join("\n"), baseline).events[0];
  const [prefix, timestamp, index, hash] = (old?.cursor.value ?? "").split(":");
  assert.equal(index, "2");
  const withIndex = (value: number, rowHash = hash) =>
    powerCursor([prefix, timestamp, value, rowHash].join(":"));
  const text = macos27Log.join("\n");

  const current = parsePmsetPowerLog(text, baseline).events[0]?.cursor;
  assert.ok(current);
  const exact = parsePmsetPowerLog(text, current);
  const legacy = parsePmsetPowerLog(text, withIndex(2));
  assert.equal(legacy.complete, true);
  assert.deepEqual(
    legacy.events.map((event) => event.cursor),
    exact.events.map((event) => event.cursor),
  );
  assert.deepEqual(
    legacy.events.map((event) => event.transition),
    ["wake"],
  );

  const rejects = (output: string[], cursor: PowerEventCursor, label: string) =>
    assert.equal(
      parsePmsetPowerLog(output.join("\n"), cursor).complete,
      false,
      label,
    );
  rejects(macos27Log, withIndex(2, "0123456789abcdef"), "unknown hash");
  rejects(macos27Log, withIndex(7), "cursor past the row");
  rejects(pmsetRows, withIndex(1), "no preamble in the output");
  const [sleepRow] = macos27Rows.slice(1, 2) as [string];
  const duplicated = [
    ...macos27Preamble,
    ...macos27Rows.slice(0, 2),
    sleepRow,
    ...macos27Rows.slice(2),
  ];
  rejects(duplicated, withIndex(2), "two matching rows");
});

test("the macOS 27 preamble is accepted once, in order, and only before the first timestamped row", () => {
  const [asl, blank, header, separator, uuid] = macos27Preamble as [
    string,
    string,
    string,
    string,
    string,
  ];
  const [first, ...rest] = macos27Rows as [string, ...string[]];
  const cases: Record<string, string[]> = {
    "header after a row": [asl, blank, first, header, ...rest],
    "separator after a row": [asl, blank, first, separator, ...rest],
    "UUID after a row": [asl, blank, first, uuid, ...rest],
    "duplicated header": [
      asl,
      blank,
      header,
      header,
      separator,
      uuid,
      ...macos27Rows,
    ],
    "header then a row": [asl, blank, header, ...macos27Rows],
    "header and separator then a row": [
      asl,
      blank,
      header,
      separator,
      ...macos27Rows,
    ],
    "UUID without header and separator": [asl, blank, uuid, ...macos27Rows],
    "separator before header": [
      asl,
      blank,
      separator,
      header,
      uuid,
      ...macos27Rows,
    ],
    "unrecognised UUID": [
      asl,
      blank,
      header,
      separator,
      "UUID: not-a-uuid",
      ...macos27Rows,
    ],
    "unfamiliar preamble line": [
      ...macos27Preamble,
      "Domain: surprise",
      ...macos27Rows,
    ],
    "out-of-order timestamp": [
      ...macos27Preamble,
      first,
      "2026-09-29 09:40:00 +0100 Assertions\tearlier",
      ...rest,
    ],
    "unknown wake summary": [
      ...macos27Preamble,
      "2026-09-29 10:06:00 +0100 UnknownWakeSummary",
      ...rest,
    ],
  };
  for (const [label, lines] of Object.entries(cases)) {
    for (const cursor of [
      null,
      powerCursor(`pmset-time:${macos27BaselineMs}`),
    ]) {
      assert.equal(
        parsePmsetPowerLog(lines.join("\n"), cursor).complete,
        false,
        label,
      );
    }
  }
});

test("a well-formed UUID line is accepted in the macOS 27 preamble", () => {
  const lines = [
    ...macos27Preamble.slice(0, 4),
    "UUID: 123e4567-E89B-12d3-a456-426614174000",
    ...macos27Rows,
  ];
  assert.equal(parsePmsetPowerLog(lines.join("\n"), null).complete, true);
});

test("power supervision establishes its baseline from macOS 27 output but holds when the header is misplaced", async () => {
  const [asl, blank, header, separator, uuid] = macos27Preamble as [
    string,
    string,
    string,
    string,
    string,
  ];
  const [first, ...rest] = macos27Rows as [string, ...string[]];
  const misplaced = [asl, blank, first, header, separator, uuid, ...rest];
  for (const [lines, held] of [
    [macos27Log, false],
    [misplaced, true],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "ensemble-power-macos27-"));
    const store = powerStore(join(root, "power.sqlite"));
    const readLog: PowerLogReader = async function* () {
      yield* lines;
    };
    const power = new ExecutionPower(
      store.state,
      new MacPowerEventSourceWithListener(
        readLog,
        2500,
        2500,
        4096,
        () => macos27BaselineMs,
        undefined,
        new SleepWakeListener(readyListenerSpawn()),
      ),
      new CaffeinateAssertion(() => new FakeChild()),
      async () => {},
    );
    try {
      await power.start();
      await power.poll();
      assert.equal(power.admissionHeld(), held);
    } finally {
      await power.stop();
      store.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a multi-megabyte valid log streams to a complete batch without a total-size cap", async () => {
  const script = `const row="2026-09-29 09:50:00 +0100 Assertions\\tPID 10(app) Created PreventUserIdleSystemSleep";
let out="";for(let i=0;i<60000;i++){out+=row+"\\n";if(out.length>1e5){process.stdout.write(out);out=""}}
process.stdout.write(out+"2026-09-29 10:00:00 +0100 Sleep\\tx\\n");`;
  const reader: PowerLogReader = (_c, _a, options) =>
    spawnPowerLogReader(process.execPath, ["-e", script], options);
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  const source = new MacPowerEventSource(
    reader,
    20_000,
    10_000,
    65_536,
    () => baselineMs,
  );
  const baseline = await source.readSince(null);
  assert.equal(baseline.complete, true);
  const batch = await source.readSince(baseline.cursor);
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch.events.map((event) => event.transition),
    ["sleep"],
  );
});

test("an over-long line, a timeout, a failing exit or a reader error stop the child, and only a timeout is distinguishable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-power-reader-"));
  try {
    const pidFile = join(dir, "pid");
    const hang = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write("2026-09-29 10:00:00 +0100 Sleep\\n");setInterval(()=>{},1000)`;
    const flood = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write("x".repeat(70*1024));setInterval(()=>{},1000)`;
    const cases: Array<[string, string[], number]> = [
      ["timeout", ["-e", hang], 1000],
      ["70 KiB line", ["-e", flood], 10_000],
      ["non-zero exit", ["-e", "process.exit(3)"], 10_000],
    ];
    for (const [label, args, timeoutMs] of cases) {
      const reader: PowerLogReader = (_c, _a, options) =>
        spawnPowerLogReader(process.execPath, args, options);
      const source = new MacPowerEventSource(
        reader,
        timeoutMs,
        timeoutMs,
        64 * 1024,
        () => 0,
      );
      if (label === "timeout")
        await assert.rejects(source.readSince(null), PowerLogReadTimeout);
      else assert.equal((await source.readSince(null)).complete, false, label);
      if (label !== "non-zero exit") await childPidGone(pidFile, label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failing: PowerLogReader = async function* () {
    yield "2026-09-29 10:00:00 +0100 Sleep";
    throw new Error("injected reader failure");
  };
  const batch = await new MacPowerEventSource(failing).readSince(null);
  assert.equal(batch.complete, false);
});

test("the pmset source defaults to a 10 second idle bound, a 60 second total bound and 64 KiB lines", async () => {
  let seen: Parameters<PowerLogReader>[2] | undefined;
  const reader: PowerLogReader = async function* (_c, _a, options) {
    seen = options;
    yield* pmsetRows;
  };
  await new MacPowerEventSource(reader).readSince(null);
  assert.deepEqual(seen, {
    timeoutMs: 60_000,
    idleTimeoutMs: 10_000,
    maxLineBytes: 64 * 1024,
  });
  for (const [timeoutMs, idleTimeoutMs, maxLineBytes] of [
    [0, 1, 1],
    [1, 0, 1],
    [1, 1, 0],
    [1.5, 1, 1],
    [10, 5.5, 1],
    [10, 11, 1],
  ] as const)
    assert.throws(
      () =>
        new MacPowerEventSource(reader, timeoutMs, idleTimeoutMs, maxLineBytes),
      /Power-event (read bounds|idle bound)/,
    );
});

async function childPidGone(pidFile: string, label: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, "utf8"));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `${label}: child stopped`);
}

test("a read slower than the idle bound completes while it keeps producing output, including from a legacy cursor", async () => {
  const baselineMs = Date.parse("2026-09-29T08:59:00Z");
  const slowly = (lines: string[]) =>
    `const lines=${JSON.stringify(lines)};let i=0;const t=setInterval(()=>{process.stdout.write(lines[i++]+"\\n");if(i===lines.length)clearInterval(t)},100)`;
  const slowSource = (lines: string[]) =>
    new MacPowerEventSource(
      (_c, _a, options) =>
        spawnPowerLogReader(process.execPath, ["-e", slowly(lines)], options),
      10_000,
      500,
      65_536,
      () => baselineMs,
    );
  const source = slowSource(pmsetRows);
  const baseline = await source.readSince(null);
  assert.equal(baseline.complete, true);
  const batch = await source.readSince(baseline.cursor);
  assert.equal(batch.complete, true);
  assert.deepEqual(
    batch,
    parsePmsetPowerLog(`${pmsetRows.join("\n")}\n`, baseline.cursor),
  );

  // A pre-macOS 27 cursor resolves through the slow reader like the exact one.
  const old = parsePmsetPowerLog(pmsetRows.join("\n"), baseline.cursor)
    .events[0]?.cursor;
  assert.ok(old);
  const text = `${macos27Log.join("\n")}\n`;
  const exact = parsePmsetPowerLog(text, baseline.cursor).events[0]?.cursor;
  assert.ok(exact);
  const modern = slowSource(macos27Log);
  const legacy = await modern.readSince(old);
  assert.equal(legacy.complete, true);
  assert.deepEqual(
    legacy.events.map((event) => event.cursor),
    parsePmsetPowerLog(text, exact).events.map((event) => event.cursor),
  );
  assert.equal(
    (await modern.readSince(powerCursor("pmset-unknown:1"))).complete,
    false,
    "an unusable cursor still fails closed",
  );
});

test("a stalled read hits the idle bound and an endless read hits the total bound, each as a typed timeout that stops the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-power-bounds-"));
  try {
    const pidFile = join(dir, "pid");
    const record = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`;
    const row = "2026-09-29 09:50:00 +0100 Assertions\\tPID 10(app) x\\n";
    const cases = [
      [
        "idle",
        `${record}process.stdout.write("${row}");setInterval(()=>{},1000)`,
        10_000,
      ],
      [
        "total",
        `${record}setInterval(()=>process.stdout.write("${row}"),50)`,
        1000,
      ],
    ] as const;
    for (const [kind, script, timeoutMs] of cases) {
      const source = new MacPowerEventSource(
        (_c, _a, options) =>
          spawnPowerLogReader(process.execPath, ["-e", script], options),
        timeoutMs,
        500,
        65_536,
        () => 0,
      );
      await assert.rejects(
        source.readSince(null),
        (error: unknown) =>
          error instanceof PowerLogReadTimeout && error.kind === kind,
      );
      await childPidGone(pidFile, kind);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timed-out read holds admission with its own reason, distinct from an unavailable or incomplete history", async () => {
  const outcomes: Array<[string, (() => Promise<never>) | null, string]> = [
    [
      "timeout",
      () => Promise.reject(new PowerLogReadTimeout("idle")),
      "read timed out",
    ],
    [
      "error",
      () => Promise.reject(new Error("injected read failure")),
      "is unavailable",
    ],
    ["incomplete", null, "is incomplete or ambiguous"],
  ];
  for (const [label, fail, suffix] of outcomes) {
    for (const stage of ["history", "advancement"] as const) {
      const root = mkdtempSync(join(tmpdir(), "ensemble-power-reason-"));
      const { db, state } = powerStore(join(root, "power.sqlite"));
      const events = new FakePowerEvents();
      events.cursor = powerCursor("baseline");
      const readSince = events.readSince.bind(events);
      const power = new ExecutionPower(
        state,
        events,
        new CaffeinateAssertion(() => new FakeChild()),
        async () => {},
      );
      try {
        await power.start();
        let reads = 0;
        if (stage === "advancement") {
          await power.poll();
          state.holdPowerAdmission("Injected power-admission hold");
        }
        // The advancement re-read is the second read of a held poll.
        const failAt = stage === "advancement" ? 2 : 1;
        events.readSince = async (cursor) => {
          if (++reads !== failAt) return readSince(cursor);
          if (fail) return fail();
          return { ...(await readSince(cursor)), complete: false };
        };
        await power.poll();
        assert.equal(reads, failAt, `${label} ${stage}: reads`);
        assert.deepEqual(
          state.powerAdmissionState().reason,
          `Power-event ${stage} ${suffix}`,
          `${label} ${stage}`,
        );
        assert.equal(power.admissionHeld(), true, `${label} ${stage}: held`);
      } finally {
        await power.stop();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("the pmset source reports the later of the kernel's sleep and wake times and fails closed on unfamiliar output", async () => {
  const source = (output: string | Error) =>
    new MacPowerEventSource(undefined, 60_000, 10_000, 65_536, Date.now, () =>
      output instanceof Error
        ? Promise.reject(output)
        : Promise.resolve(output),
    ) as PowerEventSource & { lastSleepOrWakeAt(): Promise<number> };
  const timeval = (sec: number, usec: number) =>
    `{ sec = ${sec}, usec = ${usec} } Thu Oct 15 10:00:00 2026`;
  assert.equal(
    await source(
      `${timeval(1_792_000_000, 123_456)}\n${timeval(1_792_000_100, 999_999)}\n`,
    ).lastSleepOrWakeAt(),
    1_792_000_100_999,
  );
  assert.equal(
    await source(`${timeval(0, 0)}\n${timeval(0, 0)}\n`).lastSleepOrWakeAt(),
    0,
    "never slept since boot",
  );
  for (const output of [
    "",
    `${timeval(1, 0)}\n`,
    `${timeval(1, 0)}\nsurprise\n`,
    `${timeval(1, 0)}\n${timeval(1, 0)}\n${timeval(1, 0)}\n`,
    new Error("injected sysctl failure"),
  ])
    await assert.rejects(source(output).lastSleepOrWakeAt());
});

test("the sleep/wake listener reports transitions only after it is ready and stops its child", async () => {
  const children: ListenerChild[] = [];
  const listener = new SleepWakeListener(readyListenerSpawn(children));
  const { seen, signals } = signalRecorder();
  await listener.start(signals);
  await listener.start(signals);
  assert.equal(children.length, 1, "a running listener is not respawned");
  children[0]?.write("sleep\nwa");
  children[0]?.write("ke\n");
  await waitUntil(() => seen.length === 2);
  assert.deepEqual(seen, ["sleep", "wake"]);
  await listener.stop();
  assert.deepEqual(children[0]?.signals, ["SIGTERM"]);
  assert.deepEqual(seen, ["sleep", "wake"], "a requested stop is no failure");
  await listener.start(signals);
  assert.equal(children.length, 2, "a stopped listener can start again");
  await listener.stop();
});

test("sleep/wake listener startup failures reject with distinct reasons and kill the child", async () => {
  const cases: Array<{
    name: string;
    act: (child: ListenerChild) => void;
    reason: RegExp;
  }> = [
    {
      name: "malformed",
      act: (child) => child.write("hello\n"),
      reason: /unexpected output/,
    },
    {
      name: "output before ready",
      act: (child) => child.write("wake\nready\n"),
      reason: /unexpected output/,
    },
    {
      name: "over-long line",
      act: (child) => child.write("x".repeat(65)),
      reason: /unexpected output/,
    },
    {
      name: "exit",
      act: (child) => child.emit("close", 1, null),
      reason: /exited \(1\)/,
    },
    {
      name: "error",
      act: (child) => child.emit("error", new Error("ENOENT")),
      reason: /listener failed$/,
    },
    { name: "start timeout", act: () => {}, reason: /did not become ready/ },
  ];
  for (const { name, act, reason } of cases) {
    const children: ListenerChild[] = [];
    const listener = new SleepWakeListener(() => {
      const child = new ListenerChild();
      children.push(child);
      setImmediate(() => act(child));
      return child;
    }, 50);
    const { seen, signals } = signalRecorder();
    await assert.rejects(listener.start(signals), reason, name);
    if (name !== "exit")
      assert.deepEqual(children[0]?.signals, ["SIGKILL"], name);
    assert.deepEqual(seen, [], `${name}: a start failure is not a signal`);
  }
  const throwing = new SleepWakeListener(() => {
    throw new Error("spawn EACCES");
  });
  await assert.rejects(
    throwing.start(signalRecorder().signals),
    /failed to start/,
  );
});

test("a running sleep/wake listener reports exit and malformed output as failures", async () => {
  for (const [act, reason] of [
    [
      (child: ListenerChild) => child.emit("close", null, "SIGSEGV"),
      /exited \(SIGSEGV\)/,
    ],
    [(child: ListenerChild) => child.write("ready\n"), /unexpected output/],
  ] as const) {
    const children: ListenerChild[] = [];
    const listener = new SleepWakeListener(readyListenerSpawn(children));
    const { seen, signals } = signalRecorder();
    await listener.start(signals);
    act(children[0] as ListenerChild);
    await waitUntil(() => seen.length === 1);
    assert.match(seen[0] ?? "", reason);
    children[0]?.write("wake\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, 1, "a failed child sends no more signals");
    await listener.stop();
  }
});

test("stopping a sleep/wake listener settles a pending start and kills a child that ignores SIGTERM", async () => {
  const child = new ListenerChild("SIGKILL");
  const listener = new SleepWakeListener(() => child, 5000, 20);
  const starting = listener.start(signalRecorder().signals);
  await listener.stop();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(starting, /stopped/);
});

test("the macOS source owns its sleep/wake listener", async () => {
  const children: ListenerChild[] = [];
  const source = new MacPowerEventSourceWithListener(
    undefined,
    60_000,
    10_000,
    65_536,
    Date.now,
    undefined,
    new SleepWakeListener(readyListenerSpawn(children)),
  );
  const { seen, signals } = signalRecorder();
  await source.start(signals);
  children[0]?.write("wake\n");
  await waitUntil(() => seen.length === 1);
  await source.stop();
  assert.deepEqual(children[0]?.signals, ["SIGTERM"]);
});

class SignallingPowerEvents extends FakePowerEvents {
  signals: PowerSignals | undefined;
  starts = 0;
  startFailure: Error | undefined;
  onRead: (() => void) | undefined;

  async start(signals: PowerSignals) {
    this.starts++;
    if (this.startFailure) throw this.startFailure;
    this.signals = signals;
  }

  override async readSince(cursor: PowerEventCursor | null) {
    this.onRead?.();
    return super.readSince(cursor);
  }
}

async function signallingPower(
  label: string,
  run: (context: {
    state: ExecutionState;
    events: SignallingPowerEvents;
    power: ExecutionPowerPort & {
      sleepWakeListenerFailure(): string | null;
    };
    reconciles: { count: number; during?: (() => void) | undefined };
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), `ensemble-power-${label}-`));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const events = new SignallingPowerEvents();
  events.cursor = powerCursor("baseline");
  events.lastSleepOrWakeAt = async () => 0;
  const reconciles: { count: number; during?: (() => void) | undefined } = {
    count: 0,
  };
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {
      reconciles.count++;
      reconciles.during?.();
    },
  ) as ExecutionPowerPort & { sleepWakeListenerFailure(): string | null };
  try {
    await run({ state, events, power, reconciles });
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a sleep/wake notification after the post-poll kernel snapshot stales admission until a later poll reconciles", async () => {
  await signallingPower(
    "notified",
    async ({ state, events, power, reconciles }) => {
      await power.start();
      await power.poll();
      assert.equal(power.observedForAdmission(), true);
      assert.equal(state.powerAdmissionState().held, false);

      events.signals?.transition("sleep");
      events.signals?.transition("wake");
      assert.equal(power.observedForAdmission(), false);
      assert.equal(state.powerAdmissionState().held, true);
      assert.match(state.powerAdmissionState().reason ?? "", /notification/);
      const queued = state.create(
        "queued-after-wake",
        "prompt",
        "/workspace/q",
      );
      assert.equal(state.begin(queued.id), false, "no admission before a poll");
      assert.equal(reconciles.count, 0);

      await power.poll();
      assert.equal(reconciles.count, 1, "the later poll reconciles");
      assert.equal(state.powerAdmissionState().held, false);
      assert.equal(power.observedForAdmission(), true);
      assert.equal(state.begin(queued.id), true);
    },
  );
});

test("a notification during a poll's read, kernel snapshot or reconciliation keeps that poll from clearing it", async () => {
  await signallingPower(
    "during",
    async ({ state, events, power, reconciles }) => {
      await power.start();
      await power.poll();

      events.onRead = () => {
        events.onRead = undefined;
        events.signals?.transition("wake");
      };
      await power.poll();
      assert.equal(power.observedForAdmission(), false, "notified during read");
      assert.equal(state.powerAdmissionState().held, true);

      await power.poll();
      assert.equal(power.observedForAdmission(), true);
      const clock = events.lastSleepOrWakeAt as () => Promise<number>;
      events.lastSleepOrWakeAt = async () => {
        events.signals?.transition("sleep");
        return 0;
      };
      await power.poll();
      events.lastSleepOrWakeAt = clock;
      assert.equal(power.observedForAdmission(), false, "notified at snapshot");
      assert.equal(state.powerAdmissionState().held, true);

      reconciles.during = () => {
        reconciles.during = undefined;
        events.signals?.transition("wake");
      };
      await power.poll();
      assert.equal(
        state.powerAdmissionState().held,
        true,
        "the older reconciliation cannot clear the newer hold",
      );
      assert.equal(power.observedForAdmission(), false);
      await power.poll();
      assert.equal(state.powerAdmissionState().held, false);
      assert.equal(power.observedForAdmission(), true);
    },
  );
});

test("a failed sleep/wake listener holds admission with its reason until it restarts and a later poll reconciles", async () => {
  await signallingPower(
    "listener-failure",
    async ({ state, events, power }) => {
      await power.start();
      await power.poll();
      assert.equal(power.observedForAdmission(), true);

      events.signals?.failure("Sleep/wake listener exited (1)");
      assert.equal(power.observedForAdmission(), false);
      assert.equal(
        power.sleepWakeListenerFailure(),
        "Sleep/wake listener exited (1)",
      );
      assert.deepEqual(
        [state.powerAdmissionState().held, state.powerAdmissionState().reason],
        [true, "Sleep/wake listener exited (1)"],
      );

      events.startFailure = new Error(
        "Sleep/wake listener did not become ready",
      );
      await power.poll();
      assert.equal(events.starts, 2, "the poll retried the listener once");
      assert.equal(
        power.observedForAdmission(),
        false,
        "a poll alone cannot release",
      );
      assert.deepEqual(
        [state.powerAdmissionState().held, state.powerAdmissionState().reason],
        [true, "Sleep/wake listener did not become ready"],
      );

      events.startFailure = undefined;
      await power.poll();
      assert.equal(events.starts, 3);
      assert.equal(power.sleepWakeListenerFailure(), null);
      assert.equal(state.powerAdmissionState().held, false);
      assert.equal(power.observedForAdmission(), true);
    },
  );
});

test("a listener that cannot start holds admission without failing supervision startup, and stop ends signal handling", async () => {
  await signallingPower("listener-start", async ({ state, events, power }) => {
    events.startFailure = new Error("Sleep/wake listener failed to start");
    await power.start();
    assert.equal(
      power.sleepWakeListenerFailure(),
      "Sleep/wake listener failed to start",
    );
    assert.equal(state.powerAdmissionState().held, true);
    await power.poll();
    assert.equal(power.observedForAdmission(), false);

    events.startFailure = undefined;
    await power.poll();
    assert.equal(power.observedForAdmission(), true);
    await power.stop();
    assert.equal(events.stopCalls, 1);
    events.signals?.transition("wake");
    events.signals?.failure("late");
    assert.equal(
      state.powerAdmissionState().held,
      false,
      "no handling after stop",
    );
  });
});

test("a listener failure in the same output chunk as ready keeps admission held until a restart succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-power-ready-then-fail-"));
  const { db, state } = powerStore(join(root, "power.sqlite"));
  const children: ListenerChild[] = [];
  const listener = new SleepWakeListener((() => {
    const child = new ListenerChild();
    children.push(child);
    const first = children.length === 1;
    setImmediate(() => child.write(first ? "ready\nbogus\n" : "ready\n"));
    return child;
  }) as never);
  const source = new MacPowerEventSourceWithListener(
    async function* () {},
    60_000,
    10_000,
    65_536,
    Date.now,
    undefined,
    listener,
  );
  const events = new FakePowerEvents();
  events.cursor = powerCursor("baseline");
  Object.assign(events, {
    start: (signals: PowerSignals) => source.start(signals),
    stop: () => source.stop(),
  });
  const power = new ExecutionPower(
    state,
    events,
    new CaffeinateAssertion(() => new FakeChild()),
    async () => {},
  ) as ExecutionPowerPort & { sleepWakeListenerFailure(): string | null };
  try {
    await power.start();
    assert.deepEqual(children[0]?.signals, ["SIGKILL"]);
    assert.match(power.sleepWakeListenerFailure() ?? "", /unexpected output/);
    assert.equal(state.powerAdmissionState().held, true);
    assert.equal(power.observedForAdmission(), false);

    await power.poll();
    assert.equal(children.length, 2, "the poll restarted the listener");
    assert.equal(power.sleepWakeListenerFailure(), null);
    assert.equal(state.powerAdmissionState().held, false);
    assert.equal(power.observedForAdmission(), true);
  } finally {
    await power.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a listener failure during a poll's history read keeps the durable hold and its reason", async () => {
  await signallingPower(
    "failure-in-read",
    async ({ state, events, power, reconciles }) => {
      await power.start();
      await power.poll();
      events.signals?.transition("wake");
      const reason = "Sleep/wake listener exited (1)";
      // The poll's own hold, installed after this read, has a newer revision.
      events.onRead = () => {
        events.onRead = undefined;
        events.signals?.failure(reason);
      };
      events.startFailure = new Error(reason);
      await power.poll();
      assert.equal(reconciles.count, 1, "the held poll reconciled");
      assert.deepEqual(
        [state.powerAdmissionState().held, state.powerAdmissionState().reason],
        [true, reason],
        "the in-flight poll cannot clear the failure hold",
      );
      assert.equal(power.observedForAdmission(), false);

      events.startFailure = undefined;
      await power.poll();
      assert.equal(state.powerAdmissionState().held, false);
      assert.equal(power.observedForAdmission(), true);
    },
  );
});
