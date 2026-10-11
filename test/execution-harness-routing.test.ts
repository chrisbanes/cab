import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type {
  FailureEvidence,
  Runtime,
  UnexpectedRequest,
} from "../src/standalone/codex.js";
import type { ExecutionHarness } from "../src/standalone/execution-harness.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
} from "../src/standalone/recovery-types.js";
import { StandaloneService } from "../src/standalone/service.js";
import { tmpdir } from "./temp.js";

/** Records every call so each test can prove which harness ran the work. */
class HarnessRuntime implements Runtime {
  readonly calls: string[] = [];
  holdTurns = false;
  failNextTurn = false;
  private threads = 0;
  private turns = 0;
  private readonly open = new Map<
    string,
    { release: () => void; lose: (error: Error) => void }
  >();
  private readonly failing = new Set<string>();
  private unexpected: ((request: UnexpectedRequest) => void) | undefined;
  private failure: ((error: Error) => void) | undefined;

  constructor(private readonly name: ExecutionHarness) {}

  async start() {}
  /** Like a lost App Server: pending waits reject without a terminal status. */
  async stop() {
    for (const turn of this.open.values())
      turn.lose(new Error("Runtime stopped"));
    this.open.clear();
  }
  async startThread() {
    this.calls.push("startThread");
    return `${this.name}-thread-${++this.threads}`;
  }
  async resumeThread(threadId: string) {
    this.calls.push(`resumeThread:${threadId}`);
  }
  async startTurn(threadId: string) {
    const turnId = `${this.name}-turn-${++this.turns}`;
    this.calls.push(`startTurn:${threadId}`);
    if (this.failNextTurn) {
      this.failNextTurn = false;
      this.failing.add(turnId);
    }
    return turnId;
  }
  async interruptTurn(_threadId: string, turnId: string) {
    this.calls.push(`interruptTurn:${turnId}`);
    this.failing.add(turnId);
    this.open.get(turnId)?.release();
  }
  async waitForTurn(_threadId: string, turnId: string) {
    if (this.failing.has(turnId)) return "failed" as const;
    if (this.holdTurns)
      await new Promise<void>((release, lose) =>
        this.open.set(turnId, { release, lose }),
      );
    this.open.delete(turnId);
    return this.failing.has(turnId)
      ? ("failed" as const)
      : ("completed" as const);
  }
  processIdentity() {
    return {
      processId: `${this.name}-process`,
      processStartedAt: "2026-10-01T00:00:00.000Z",
      bootId: "harness-routing-boot",
    };
  }
  failureEvidence(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined {
    return this.failing.has(turnId) &&
      !this.calls.includes(`interruptTurn:${turnId}`)
      ? {
          threadId,
          turnId,
          status: "failed",
          classification: "transient",
          reasonCode: "serverOverloaded",
          source: "harness",
          harnessRetries: 0,
        }
      : undefined;
  }
  async inspectExecution(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    this.calls.push(`inspect:${identity.threadId}`);
    return { kind: "unknown" } as ExecutionInspection;
  }
  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void) {
    this.unexpected = listener;
  }
  onFailure(listener: (error: Error) => void) {
    this.failure = listener;
  }
  denyUnexpected(method: string) {
    this.unexpected?.({ method });
  }
  crash() {
    this.failure?.(new Error("Runtime lost"));
  }
  releaseAll() {
    for (const turn of this.open.values()) turn.release();
  }
}

type Fakes = Record<ExecutionHarness, HarnessRuntime>;

function fakes(): Fakes {
  return {
    codex: new HarnessRuntime("codex"),
    claude: new HarnessRuntime("claude"),
  };
}

function open(
  dataDir: string,
  runtimes: Fakes,
  harnesses: ExecutionHarness[] = ["codex", "claude"],
) {
  return new StandaloneService(
    dataDir,
    (_context, harness) => runtimes[harness],
    undefined,
    {
      runtimeHarnesses: harnesses,
      power: { enabled: false },
      routingClient: null,
    },
  );
}

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

function project(
  service: StandaloneService,
  leadProfileId: string,
  candidateProfileIds: string[] = [],
) {
  const projectId = randomUUID();
  execute(service, {
    type: "project.create",
    projectId,
    name: "Harness routing",
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
    candidateProfileIds,
  });
  return projectId;
}

/** Creates a task with explicit assignments, then makes it ready. */
async function task(
  service: StandaloneService,
  projectId: string,
  profileIds: string[],
) {
  const taskId = randomUUID();
  execute(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Harness routing",
    outcome: "Route by harness",
    ready: false,
  });
  await service.provisionTask(taskId);
  const assignmentIds = profileIds.map((profileId) => {
    const assignmentId = randomUUID();
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Route",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    return assignmentId;
  });
  execute(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return { taskId, assignmentIds };
}

const initial = (assignmentId: string) => `assignment:${assignmentId}:initial`;

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function count(service: StandaloneService, sql: string, ...args: string[]) {
  const db = (service as unknown as { db: DatabaseSync }).db;
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

function intent(service: StandaloneService, workId: string) {
  return service.list().find((item) => item.workId === workId);
}

function diagnostics(service: StandaloneService, runtimes: Fakes) {
  return () => ({
    codex: runtimes.codex.calls,
    claude: runtimes.claude.calls,
    intents: service
      .list()
      .map((item) => [item.workId, item.state, item.reason]),
    requests: service
      .turnRequests()
      .map((request) => [request.workId, request.state, request.reason]),
  });
}

test("a mixed task routes each assignment, Stop and anomaly to its own harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-mixed-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    const { taskId } = await task(service, projectId, []);
    const leadWork = service
      .turnRequests()
      .find((request) => request.taskId === taskId)?.workId;
    assert.ok(leadWork);
    await waitUntil(
      () => intent(service, leadWork)?.state === "completed",
      describe,
    );

    runtimes.claude.holdTurns = true;
    const workerId = randomUUID();
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId: workerId,
      profileId: worker,
      brief: "Build with Claude",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    await waitUntil(
      () => intent(service, initial(workerId))?.state === "running",
      describe,
    );
    assert.ok(runtimes.codex.calls.every((call) => !call.includes("claude")));
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
    assert.equal(intent(service, leadWork)?.threadId, "codex-thread-1");
    assert.equal(service.bindingHarness(leadWork), "codex");
    assert.equal(service.bindingHarness(initial(workerId)), "claude");

    // A Codex lead on another task stays open while both harnesses run.
    runtimes.codex.holdTurns = true;
    const other = await task(service, projectId, []);
    const otherWork = service
      .turnRequests()
      .find((request) => request.taskId === other.taskId)?.workId;
    assert.ok(otherWork);
    await waitUntil(
      () => intent(service, otherWork)?.state === "running",
      describe,
    );

    // An unidentified Codex anomaly holds only Codex-bound work.
    runtimes.codex.denyUnexpected("item/commandExecution/requestApproval");
    assert.equal(intent(service, otherWork)?.state, "held");
    assert.equal(intent(service, initial(workerId))?.state, "running");

    const stopped = await service.stopTask(taskId);
    assert.deepEqual(
      stopped.outcomes.map((outcome) => [outcome.workId, outcome.interrupt]),
      [[initial(workerId), "acknowledged"]],
    );
    assert.deepEqual(
      runtimes.claude.calls.filter((call) => call.startsWith("interrupt")),
      ["interruptTurn:claude-turn-1"],
    );
    assert.deepEqual(
      runtimes.codex.calls.filter((call) => call.startsWith("interrupt")),
      [],
    );
  } finally {
    runtimes.codex.releaseAll();
    runtimes.claude.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude transient failure is held without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-retry-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    runtimes.claude.failNextTurn = true;
    const { assignmentIds } = await task(service, projectId, [worker]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(() => intent(service, workId)?.state === "held", describe);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      count(service, "SELECT COUNT(*) AS n FROM execution_retry_resolutions"),
      0,
    );
    assert.equal(service.turnRequests().length, 1);
    assert.equal(
      runtimes.claude.calls.filter((call) => call.startsWith("startTurn"))
        .length,
      1,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a profile change keeps a live conversation on its harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-profile-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const changing = profile(service, "codex");
    const projectId = project(service, lead, [changing]);
    const first = await task(service, projectId, [changing]);
    const assignmentId = first.assignmentIds[0] ?? "";
    await waitUntil(
      () => intent(service, initial(assignmentId))?.state === "completed",
      describe,
    );

    execute(service, {
      type: "profile.configure",
      profileId: changing,
      expectedVersion: 1,
      runtime: { harness: "claude", model: null, reasoningEffort: null },
    });
    execute(service, {
      type: "assignment.apply",
      projectId,
      assignmentId,
      expectedVersion: Number(
        service.domain().assignment(assignmentId).version,
      ),
    });
    assert.equal(
      Number(service.domain().assignment(assignmentId).profileRevision),
      2,
    );
    const next = `${assignmentId}:next`;
    await service.submitTask(
      next,
      assignmentId,
      "Continue",
      initial(assignmentId),
    );
    await waitUntil(
      () => intent(service, next)?.state === "completed",
      describe,
    );
    assert.equal(intent(service, next)?.threadId, "codex-thread-1");
    assert.ok(runtimes.codex.calls.includes("resumeThread:codex-thread-1"));
    assert.equal(service.bindingHarness(next), "codex");
    assert.deepEqual(runtimes.claude.calls, []);

    const second = await task(service, projectId, [changing]);
    const newWork = initial(second.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, newWork)?.state === "completed",
      describe,
    );
    assert.equal(service.bindingHarness(newWork), "claude");
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured or failed harness holds its work visibly without fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-unavailable-"));
  const dataDir = join(root, "data");
  let runtimes = fakes();
  let service = open(dataDir, runtimes, ["codex"]);
  let describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker, lead]);
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, claudeWork)?.reason ===
        "Claude runtime is not configured",
      describe,
    );
    assert.equal(intent(service, claudeWork)?.state, "ready");
    assert.equal(
      service.turnRequests().find((request) => request.workId === claudeWork)
        ?.reason,
      "Claude runtime is not configured",
    );
    assert.equal(service.bindingHarness(claudeWork), "claude");
    assert.equal(
      count(
        service,
        "SELECT COUNT(*) AS n FROM execution_capacity_reservations WHERE workId = ?",
        claudeWork,
      ),
      0,
    );
    const codexTask = await task(service, projectId, [lead]);
    const codexWork = initial(codexTask.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, codexWork)?.state === "completed",
      describe,
    );
    assert.deepEqual(runtimes.claude.calls, []);
    assert.equal(intent(service, codexWork)?.threadId, "codex-thread-1");

    await service.stop();
    runtimes = fakes();
    service = open(dataDir, runtimes);
    describe = diagnostics(service, runtimes);
    await service.start();
    await waitUntil(
      () => intent(service, claudeWork)?.state === "completed",
      describe,
    );
    assert.equal(service.bindingHarness(claudeWork), "claude");
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
    assert.ok(runtimes.codex.calls.every((call) => !call.includes("claude")));

    runtimes.claude.crash();
    const afterCrash = await task(service, projectId, [worker]);
    const blocked = initial(afterCrash.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, blocked)?.reason ===
        "Claude runtime unavailable; restart the service",
      describe,
    );
    assert.deepEqual(service.runtimeStatus(), { state: "available" });
    const stillCodex = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(stillCodex.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
    assert.equal(
      runtimes.claude.calls.filter((call) => call.startsWith("startTurn"))
        .length,
      1,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery inspects admitted work only through its own harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-recovery-"));
  const dataDir = join(root, "data");
  let runtimes = fakes();
  let service = open(dataDir, runtimes);
  let describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    runtimes.claude.holdTurns = true;
    const { assignmentIds } = await task(service, projectId, [worker]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, workId)?.state === "running",
      describe,
    );
    await service.stop();

    runtimes = fakes();
    service = open(dataDir, runtimes, ["codex"]);
    describe = diagnostics(service, runtimes);
    await service.start();
    // The Codex runtime is never asked about Claude-bound work.
    assert.deepEqual(runtimes.codex.calls, [], JSON.stringify(describe()));
    const recovery = service
      .recoveryView()
      .find((record) => record.workId === workId);
    assert.equal(recovery?.intent.state, "held");
    assert.deepEqual(
      recovery?.observations.map((observation) => observation.kind),
      ["unknown"],
    );
    assert.deepEqual(
      [
        recovery?.holds.writer,
        recovery?.holds.capacity,
        recovery?.holds.uncertainty,
      ],
      [true, true, true],
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
