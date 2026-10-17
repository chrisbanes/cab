import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harnessStatusSchema } from "../../src/operator/contracts.js";
import {
  type Runtime,
  RuntimeNotEnabledError,
  type UnexpectedRequest,
} from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
} from "../../src/standalone/recovery-types.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  flush,
  ManualRestartClock,
  settle,
} from "../fixtures/restart-clock.js";
import { tmpdir } from "../fixtures/temp.js";

/** What the next runtime of a harness does; read live, so a test changes it between attempts. */
interface Behaviour {
  failStart: boolean;
  /** Message of the Error a failing start throws; lets a test prove it never surfaces. */
  startError: string;
  spawnThrows: boolean;
  notEnabled: boolean;
  holdTurns: boolean;
  /** start() waits for it. */
  startGate: Promise<void> | undefined;
  /** start() never settles until stop(), like a wedged App Server. */
  hangStart: boolean;
  /** start() reports the runtime lost, then fails: two reports for one episode. */
  crashThenFail: boolean;
  /** Called at the top of every start(), with how many sleeps the clock holds. */
  onStart: (() => void) | undefined;
}

class FakeRuntime implements Runtime {
  readonly calls: string[] = [];
  stops = 0;
  private failure: ((error: Error) => void) | undefined;
  private readonly open = new Map<
    string,
    { release: () => void; lose: (error: Error) => void }
  >();
  private releaseStart: (() => void) | undefined;

  constructor(
    private readonly name: ExecutionHarness,
    private readonly behaviour: Behaviour,
    private readonly ids: { thread: number; turn: number },
  ) {}

  async start() {
    this.behaviour.onStart?.();
    if (this.behaviour.notEnabled)
      throw new RuntimeNotEnabledError("Not on this host");
    await this.behaviour.startGate;
    if (this.behaviour.hangStart)
      await new Promise<void>((resolve) => {
        this.releaseStart = resolve;
      });
    if (this.behaviour.crashThenFail) {
      this.crash();
      throw new Error("Runtime lost while starting");
    }
    if (this.behaviour.failStart) throw new Error(this.behaviour.startError);
  }
  async stop() {
    this.stops++;
    this.releaseStart?.();
    for (const turn of this.open.values())
      turn.lose(new Error("Runtime stopped"));
    this.open.clear();
  }
  async startThread() {
    this.calls.push("startThread");
    return `${this.name}-thread-${++this.ids.thread}`;
  }
  async resumeThread(threadId: string) {
    this.calls.push(`resumeThread:${threadId}`);
  }
  async startTurn(threadId: string) {
    this.calls.push(`startTurn:${threadId}`);
    return `${this.name}-turn-${++this.ids.turn}`;
  }
  async interruptTurn(_threadId: string, turnId: string) {
    this.calls.push(`interruptTurn:${turnId}`);
    this.open.get(turnId)?.release();
  }
  async waitForTurn(_threadId: string, turnId: string) {
    if (this.behaviour.holdTurns)
      await new Promise<void>((release, lose) =>
        this.open.set(turnId, { release, lose }),
      );
    this.open.delete(turnId);
    return "completed" as const;
  }
  currentUserInputGeneration() {
    return `${this.name}-generation`;
  }
  processIdentity() {
    return {
      processId: `${this.name}-process`,
      processStartedAt: "2026-10-01T00:00:00.000Z",
      bootId: "runtime-restart-boot",
    };
  }
  async inspectExecution(
    _identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    return { kind: "unknown" } as ExecutionInspection;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onFailure(listener: (error: Error) => void) {
    this.failure = listener;
  }
  /** Like a lost App Server: the process is gone and its waits reject. */
  crash() {
    this.failure?.(new Error("Runtime lost"));
    for (const turn of this.open.values()) turn.lose(new Error("Runtime lost"));
    this.open.clear();
  }
}

function behaviour(overrides: Partial<Behaviour> = {}): Behaviour {
  return {
    failStart: false,
    startError: "Runtime failed to start",
    spawnThrows: false,
    notEnabled: false,
    holdTurns: false,
    startGate: undefined,
    hangStart: false,
    crashThenFail: false,
    onStart: undefined,
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Each spawn is a fresh fake, so a restart is visible as a new instance. */
function openService(
  dataDir: string,
  clock: ManualRestartClock,
  options: {
    behaviours?: Partial<Record<ExecutionHarness, Behaviour>>;
    resolve?: (harness: ExecutionHarness) => boolean | Promise<boolean>;
    startTimeoutMs?: number;
  } = {},
) {
  const behaviours: Record<ExecutionHarness, Behaviour> = {
    codex: options.behaviours?.codex ?? behaviour(),
    claude: options.behaviours?.claude ?? behaviour(),
  };
  const created: Record<ExecutionHarness, FakeRuntime[]> = {
    codex: [],
    claude: [],
  };
  const ids = {
    codex: { thread: 0, turn: 0 },
    claude: { thread: 0, turn: 0 },
  };
  const service = new StandaloneService(
    dataDir,
    (_context, harness) => {
      if (behaviours[harness].spawnThrows)
        throw new Error("sk-ant-oat01-SPAWN /Users/x/.claude/token");
      const runtime = new FakeRuntime(
        harness,
        behaviours[harness],
        ids[harness],
      );
      created[harness].push(runtime);
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
      resolveExecutable: async (harness) => options.resolve?.(harness) ?? true,
      runtimeRestart: { clock, wallNow: clock.wallNow },
      ...(options.startTimeoutMs
        ? { secondaryRuntimeStartTimeoutMs: options.startTimeoutMs }
        : {}),
    },
  );
  const latest = (harness: ExecutionHarness) => {
    const runtime = created[harness].at(-1);
    assert.ok(runtime, `${harness} was created`);
    return runtime;
  };
  return { service, behaviours, created, latest };
}

/** The status as the operator contract would carry it. */
function statusOf(service: StandaloneService, harness: ExecutionHarness) {
  const status = service.harnessStatuses().find((s) => s.harness === harness);
  assert.ok(status);
  return harnessStatusSchema.parse(status);
}

function restartOf(service: StandaloneService, harness: ExecutionHarness) {
  const status = statusOf(service, harness);
  return status.state === "unavailable" ? status.restart : undefined;
}

async function withService<T>(
  options: Parameters<typeof openService>[2],
  run: (
    context: ReturnType<typeof openService> & {
      clock: ManualRestartClock;
      dataDir: string;
    },
  ) => Promise<T>,
  clock = new ManualRestartClock(),
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-restart-"));
  const dataDir = join(root, "data");
  const context = openService(dataDir, clock, options);
  try {
    return await run({ ...context, clock, dataDir });
  } finally {
    await context.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

const day = 24 * 60 * 60 * 1000;

function execute(service: StandaloneService, command: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...command } as never);
}

function profile(service: StandaloneService, harness: ExecutionHarness) {
  const profileId = randomUUID();
  execute(service, {
    type: "profile.create",
    profileId,
    name: `${harness} profile`,
    instructions: "build",
    capabilities: "code",
    runtime:
      harness === "claude"
        ? { harness, model: "opus", reasoningEffort: "high" }
        : { harness },
  });
  return profileId;
}

function project(service: StandaloneService, leadProfileId: string) {
  const projectId = randomUUID();
  execute(service, {
    type: "project.create",
    projectId,
    name: "Runtime restart",
    leadProfileId,
  });
  execute(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [leadProfileId],
  });
  return projectId;
}

/** A ready task with one assignment; returns the work id of its initial turn. */
async function task(
  service: StandaloneService,
  projectId: string,
  profileId: string,
) {
  const taskId = randomUUID();
  execute(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Runtime restart",
    outcome: "Survive a runtime restart",
    ready: false,
  });
  await service.provisionTask(taskId);
  const assignmentId = randomUUID();
  execute(service, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return `assignment:${assignmentId}:initial`;
}

const intent = (service: StandaloneService, workId: string) =>
  service.list().find((item) => item.workId === workId);

const waitReason =
  "Codex runtime unavailable; turn it off and on in Settings → Runtime, or restart the service";

const turnStarts = (runtimes: FakeRuntime[]) =>
  runtimes.flatMap((runtime) =>
    runtime.calls.filter((call) => call.startsWith("startTurn")),
  );

test("a crashed runtime restarts after 30 s; queued work is admitted once and running work stays held", async () => {
  await withService(
    { behaviours: { codex: behaviour({ holdTurns: true }) } },
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
      const lead = profile(service, "codex");
      const projectId = project(service, lead);
      const running = await task(service, projectId, lead);
      const describe = () => ({
        calls: created.codex.map((runtime) => runtime.calls),
        intents: service.list().map((i) => [i.workId, i.state, i.reason]),
      });
      await settle(
        () => intent(service, running)?.state === "running",
        describe,
      );

      latest("codex").crash();
      behaviours.codex.holdTurns = false;
      const queued = await task(service, projectId, lead);
      await settle(
        () => intent(service, queued)?.reason === waitReason,
        describe,
      );
      await settle(() => intent(service, running)?.state === "held", describe);
      assert.deepEqual(restartOf(service, "codex"), {
        state: "pending",
        attempt: 1,
        nextAt: clock.wall + 30_000,
        lastFailure: "exited",
        attempts: [],
      });
      assert.equal(intent(service, queued)?.state, "ready");

      clock.advance(29_999);
      await flush();
      assert.equal(created.codex.length, 1, "no spawn before 30 s");

      clock.advance(1);
      await settle(
        () => intent(service, queued)?.state === "completed",
        describe,
      );
      assert.equal(created.codex.length, 2, "exactly one new runtime");
      const status = statusOf(service, "codex");
      assert.equal(status.state, "available");
      // One turn on the old runtime (the held one) and exactly one on the new (the queued one).
      assert.equal(turnStarts([created.codex[0] as FakeRuntime]).length, 1);
      assert.equal(turnStarts([latest("codex")]).length, 1);
      assert.equal(
        created.codex[0]?.stops,
        1,
        "the lost runtime is stopped once",
      );
      assert.deepEqual(
        latest("codex").calls.filter((call) => call.startsWith("resumeThread")),
        [],
        "held work is never resumed on the new runtime",
      );
      assert.equal(intent(service, running)?.state, "held");
      assert.equal(clock.pending(), 0);
    },
  );
});

test("a start that fails during an attempt schedules the next at 2 min, then 10 min, then stops with retries exhausted", async () => {
  await withService(
    { behaviours: { codex: behaviour({ failStart: false }) } },
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      behaviours.codex.failStart = true;
      latest("codex").crash();
      for (const [index, delay] of [30_000, 120_000, 600_000].entries()) {
        assert.equal(created.codex.length, index + 1);
        assert.equal(clock.requested.at(-1), delay);
        assert.equal(clock.pending(), 1);
        clock.advance(delay - 1);
        await flush();
        assert.equal(created.codex.length, index + 1, "not before the delay");
        clock.advance(1);
        await settle(() => created.codex.length === index + 2);
        await flush();
      }
      assert.equal(created.codex.length, 4);
      const restart = restartOf(service, "codex");
      assert.equal(restart?.state, "exhausted");
      assert.equal(restart?.attempts.length, 3);
      assert.deepEqual(
        restart?.attempts.map((a) => [a.attempt, a.outcome, a.failure]),
        [
          [1, "failed", "start-failed"],
          [2, "failed", "start-failed"],
          [3, "failed", "start-failed"],
        ],
      );
      assert.equal(clock.pending(), 0);
      clock.advance(day);
      await flush();
      assert.equal(created.codex.length, 4, "exhausted spawns nothing more");
      assert.equal(clock.pending(), 0);
      assert.deepEqual(clock.requested, [30_000, 120_000, 600_000]);
    },
  );
});

test("a runtime that crashes again before 10 minutes keeps its attempt count", async () => {
  await withService({}, async ({ service, clock, created, latest }) => {
    await service.start();
    latest("codex").crash();
    clock.advance(30_000);
    await settle(() => created.codex.length === 2);
    await flush();
    assert.equal(statusOf(service, "codex").state, "available");
    clock.advance(599_999);
    latest("codex").crash();
    const restart = restartOf(service, "codex");
    assert.equal(restart?.state, "pending");
    assert.equal(restart?.state === "pending" ? restart.attempt : 0, 2);
    assert.equal(clock.requested.at(-1), 120_000);
    assert.deepEqual(
      restart?.attempts.map((a) => [a.attempt, a.outcome]),
      [[1, "started"]],
    );
  });
});

test("a runtime available for 10 minutes starts a fresh schedule", async () => {
  await withService({}, async ({ service, clock, created, latest }) => {
    await service.start();
    latest("codex").crash();
    clock.advance(30_000);
    await settle(() => created.codex.length === 2);
    await flush();
    clock.advance(600_000);
    latest("codex").crash();
    const restart = restartOf(service, "codex");
    assert.equal(restart?.state, "pending");
    assert.equal(restart?.state === "pending" ? restart.attempt : 0, 1);
    assert.equal(clock.requested.at(-1), 30_000);
    assert.deepEqual(restart?.attempts, []);
  });
});

test("turning a runtime off during backoff cancels the retry and nothing restarts it", async () => {
  await withService(
    {},
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      latest("codex").crash();
      assert.equal(clock.pending(), 1);
      await service.configureRuntime({
        key: randomUUID(),
        harness: "codex",
        enabled: false,
      });
      assert.equal(clock.pending(), 0);
      assert.equal(clock.aborted(), 1);
      clock.advance(day);
      await flush();
      assert.equal(created.codex.length, 1);
      const status = statusOf(service, "codex");
      assert.equal(status.state, "not-configured");

      // Re-enabling is one spawn from the toggle; its failure starts a fresh schedule.
      behaviours.codex.failStart = true;
      await service.configureRuntime({
        key: randomUUID(),
        harness: "codex",
        enabled: true,
      });
      assert.equal(created.codex.length, 2);
      const restart = restartOf(service, "codex");
      assert.equal(restart?.state === "pending" ? restart.attempt : 0, 1);
      assert.equal(clock.requested.at(-1), 30_000);
    },
  );
});

test("a toggle while an attempt is queued wins and the stale attempt does nothing", async () => {
  const gate = deferred();
  let gated = false;
  await withService(
    {
      // The operator's enable is mid-flight (checking the executable) when the sleep fires.
      resolve: () => (gated ? gate.promise.then(() => true) : true),
    },
    async ({ service, clock, created, latest }) => {
      await service.start();
      latest("codex").crash();
      gated = true;
      const toggle = service.configureRuntime({
        key: randomUUID(),
        harness: "codex",
        enabled: true,
      });
      await flush();
      clock.advance(30_000);
      await flush();
      assert.equal(
        created.codex.length,
        1,
        "the attempt waits behind the toggle",
      );
      gate.resolve();
      await toggle;
      await flush();
      assert.equal(created.codex.length, 2, "one spawn, from the toggle");
      assert.equal(statusOf(service, "codex").state, "available");
      assert.equal(clock.pending(), 0);
      assert.equal(latest("codex").stops, 0);
      assert.equal(created.codex[0]?.stops, 1);
    },
  );
});

test("concurrent failure reports arm one attempt", async () => {
  await withService(
    {},
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      const first = latest("codex");
      first.crash();
      first.crash();
      assert.equal(clock.pending(), 1);
      assert.equal(clock.requested.length, 1);

      // An operator enable whose runtime is lost while starting reports twice in one episode.
      behaviours.codex.crashThenFail = true;
      await service.configureRuntime({
        key: randomUUID(),
        harness: "codex",
        enabled: true,
      });
      assert.equal(created.codex.length, 2);
      assert.equal(
        clock.pending(),
        1,
        "a second report does not arm a second sleep",
      );
      behaviours.codex.crashThenFail = false;
      clock.advance(30_000);
      await settle(() => created.codex.length === 3);
      await flush();
      assert.equal(created.codex.length, 3, "one spawn after 30 s");
      assert.equal(statusOf(service, "codex").state, "available");
      assert.equal(clock.pending(), 0);
    },
  );
});

test("a runtime lost during an attempt is counted once and retried after the attempt ends", async () => {
  const gate = deferred();
  await withService(
    {},
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      latest("codex").crash();
      behaviours.codex.startGate = gate.promise;
      clock.advance(30_000);
      await settle(() => created.codex.length === 2);
      // The attempt is mid-start: the report is recorded but no retry is armed beside it.
      latest("codex").crash();
      await flush();
      assert.equal(clock.pending(), 0);
      assert.equal(
        restartOf(service, "codex"),
        undefined,
        "omitted while in flight",
      );
      gate.resolve();
      await settle(() => clock.pending() === 1);
      const restart = restartOf(service, "codex");
      assert.equal(restart?.state === "pending" ? restart.attempt : 0, 2);
      assert.equal(clock.requested.at(-1), 120_000);
      assert.deepEqual(
        restart?.attempts.map((a) => [a.attempt, a.outcome, a.failure]),
        [[1, "failed", "exited"]],
      );
      assert.equal(created.codex.length, 2);
    },
  );
});

test("stopping the service during backoff leaves no retry and stops promptly", async () => {
  await withService({}, async ({ service, clock, created, latest }) => {
    await service.start();
    latest("codex").crash();
    assert.equal(clock.pending(), 1);
    await service.stop();
    assert.equal(clock.pending(), 0);
    assert.equal(clock.aborted(), 1);
    clock.advance(day);
    await flush();
    assert.equal(created.codex.length, 1);
  });
});

test("stopping the service during an attempt stops the new runtime and arms nothing", async () => {
  const gate = deferred();
  await withService(
    {},
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      latest("codex").crash();
      behaviours.codex.startGate = gate.promise;
      clock.advance(30_000);
      await settle(() => created.codex.length === 2);
      const stopping = service.stop();
      let stopped = false;
      void stopping.then(() => {
        stopped = true;
      });
      await flush();
      assert.equal(stopped, false, "shutdown waits for the attempt to land");
      gate.resolve();
      await stopping;
      assert.ok(latest("codex").stops >= 1, "the new runtime is stopped");
      assert.equal(clock.pending(), 0);
      clock.advance(day);
      await flush();
      assert.equal(created.codex.length, 2);
    },
  );
});

test("a boot-time start failure uses the same schedule and a service restart starts it fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-restart-boot-"));
  const dataDir = join(root, "data");
  const clock = new ManualRestartClock();
  const slept: number[] = [];
  const failing = openService(dataDir, clock, {
    behaviours: {
      codex: behaviour({ failStart: true }),
      claude: behaviour({ onStart: () => slept.push(clock.requested.length) }),
    },
  });
  try {
    await failing.service.start();
    assert.deepEqual(slept, [0], "nothing is armed while start() still runs");
    assert.equal(clock.pending(), 1);
    const restart = restartOf(failing.service, "codex");
    assert.equal(restart?.state === "pending" ? restart.attempt : 0, 1);
    assert.equal(restart?.lastFailure, "start-failed");
    assert.equal(clock.requested.at(-1), 30_000);
    for (const delay of [30_000, 120_000, 600_000]) {
      clock.advance(delay);
      await flush();
    }
    assert.equal(restartOf(failing.service, "codex")?.state, "exhausted");
    await failing.service.stop();
    assert.equal(clock.pending(), 0);

    const healthy = openService(dataDir, clock);
    try {
      await healthy.service.start();
      const status = statusOf(healthy.service, "codex");
      assert.equal(status.state, "available");
      assert.equal("restart" in status, false);
    } finally {
      await healthy.service.stop();
    }

    const broken = openService(dataDir, clock, {
      behaviours: { codex: behaviour({ failStart: true }) },
    });
    try {
      await broken.service.start();
      const restart = restartOf(broken.service, "codex");
      assert.equal(restart?.state === "pending" ? restart.attempt : 0, 1);
      assert.deepEqual(restart?.attempts, []);
    } finally {
      await broken.service.stop();
    }
  } finally {
    await failing.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a start that fails while the service starts leaves no sleeping retry", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "ensemble-runtime-restart-teardown-"),
  );
  const clock = new ManualRestartClock();
  const { service } = openService(join(root, "data"), clock, {
    behaviours: { codex: behaviour({ failStart: true }) },
  });
  // Fails after the boot loop recorded the failure and the service was published.
  const internals = service as unknown as {
    wakeScheduler: () => Promise<void>;
  };
  internals.wakeScheduler = async () => {
    throw new Error("scheduler failed to wake");
  };
  try {
    await assert.rejects(service.start(), /scheduler failed to wake/);
    assert.equal(clock.pending(), 0, "teardown aborted the boot-time sleep");
    assert.ok(clock.aborted() >= 1);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex and Claude restart independently", async () => {
  await withService(
    { behaviours: { claude: behaviour({ failStart: false }) } },
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      behaviours.claude.failStart = true;
      latest("claude").crash();
      for (const delay of [30_000, 120_000, 600_000]) {
        clock.advance(delay);
        await flush();
      }
      assert.equal(restartOf(service, "claude")?.state, "exhausted");
      assert.equal(created.claude.length, 4);

      latest("codex").crash();
      const restart = restartOf(service, "codex");
      assert.equal(restart?.state === "pending" ? restart.attempt : 0, 1);
      assert.equal(restartOf(service, "claude")?.state, "exhausted");
      clock.advance(30_000);
      await settle(() => created.codex.length === 2);
      await flush();
      assert.equal(statusOf(service, "codex").state, "available");
      assert.equal(
        created.claude.length,
        4,
        "Claude spawned nothing for Codex's restart",
      );
      assert.equal(created.codex.length, 2);
    },
  );
});

test("a disabled, draining or not-enabled runtime is never restarted", async () => {
  // A host without the executable, and a runtime that says it cannot run here.
  await withService(
    {
      resolve: (harness) => harness !== "claude",
      behaviours: { codex: behaviour({ notEnabled: false }) },
    },
    async ({ service, clock }) => {
      await service.start();
      assert.equal(statusOf(service, "claude").state, "not-configured");
      assert.equal(clock.pending(), 0);
    },
  );
  await withService(
    { behaviours: { claude: behaviour({ notEnabled: true }) } },
    async ({ service, clock }) => {
      await service.start();
      assert.equal(statusOf(service, "claude").state, "not-configured");
      assert.equal(clock.pending(), 0);
    },
  );
  // Disabled while a turn still runs: the runtime drains, and its loss arms nothing.
  await withService(
    { behaviours: { claude: behaviour({ holdTurns: true }) } },
    async ({ service, clock, latest }) => {
      await service.start();
      await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
      const lead = profile(service, "claude");
      const projectId = project(service, lead);
      const work = await task(service, projectId, lead);
      await settle(() => intent(service, work)?.state === "running");
      await service.configureRuntime({
        key: randomUUID(),
        harness: "claude",
        enabled: false,
        confirmedBoundTasks: 1,
      });
      latest("claude").crash();
      await flush();
      assert.equal(clock.pending(), 0);
      assert.equal(statusOf(service, "claude").state, "not-configured");
    },
  );
});

test("failure reasons are closed codes and never carry runtime error text", async () => {
  const secret = "sk-ant-oat01-SECRET /Users/x/.claude/token";
  await withService(
    {
      startTimeoutMs: 1,
      behaviours: { codex: behaviour({ startError: secret }) },
    },
    async ({ service, clock, created, behaviours, latest }) => {
      await service.start();
      const reasons: unknown[] = [];
      const observe = async () => {
        const restart = restartOf(service, "codex");
        reasons.push(restart?.lastFailure);
        assert.equal(
          JSON.stringify(service.harnessStatuses()).includes("SECRET"),
          false,
        );
        assert.equal(
          JSON.stringify(service.harnessStatuses()).includes("/Users/x"),
          false,
        );
      };
      // exited: the onFailure listener.
      latest("codex").crash();
      await observe();
      // start-failed: the start throws the secret text.
      behaviours.codex.failStart = true;
      clock.advance(30_000);
      await settle(() => created.codex.length === 2);
      await flush();
      await observe();
      // spawn-failed: the factory throws.
      behaviours.codex.failStart = false;
      behaviours.codex.spawnThrows = true;
      clock.advance(120_000);
      await settle(() => clock.pending() === 1 && clock.requested.length === 3);
      await observe();
      // start-timed-out: a start that never settles within the timeout.
      behaviours.codex.spawnThrows = false;
      behaviours.codex.hangStart = true;
      clock.advance(600_000);
      await settle(() => restartOf(service, "codex")?.state === "exhausted");
      await observe();
      assert.deepEqual(reasons, [
        "exited",
        "start-failed",
        "spawn-failed",
        "start-timed-out",
      ]);
      const restart = restartOf(service, "codex");
      assert.deepEqual(
        restart?.attempts.map((a) => a.failure),
        ["start-failed", "spawn-failed", "start-timed-out"],
      );
    },
  );
});

test("backoff follows the monotonic clock while shown times follow the wall clock", async () => {
  await withService({}, async ({ service, clock, created, latest }) => {
    await service.start();
    const armedWall = clock.wall;
    latest("codex").crash();
    const status = statusOf(service, "codex");
    assert.equal(status.state === "unavailable" ? status.since : 0, armedWall);
    const restart = restartOf(service, "codex");
    assert.equal(
      restart?.state === "pending" ? restart.nextAt : 0,
      armedWall + 30_000,
    );

    // The wall clock steps back an hour; the attempt still fires 30 s on the monotonic clock.
    clock.wall -= 3_600_000;
    const firedWall = clock.wall + 30_000;
    clock.advance(30_000);
    await settle(() => created.codex.length === 2);
    await flush();
    assert.equal(created.codex.length, 2);
    latest("codex").crash();
    const next = restartOf(service, "codex");
    assert.deepEqual(next?.attempts, [
      { attempt: 1, at: firedWall, outcome: "started", failure: null },
    ]);
    assert.equal(
      next?.state === "pending" ? next.nextAt : 0,
      firedWall + 120_000,
    );
  });
});
