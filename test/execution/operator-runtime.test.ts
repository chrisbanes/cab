import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import type { DomainCommand } from "../../src/core/domain.js";
import type { Runtime } from "../../src/standalone/codex.js";
import type { RuntimeProcessIdentity } from "../../src/standalone/recovery-types.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { until } from "../fixtures/until.js";

const runtime: Runtime = {
  async start() {},
  async stop() {},
  async startThread() {
    return "thread";
  },
  async resumeThread() {},
  async startTurn() {
    return "turn";
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
  onUnexpectedRequest() {},
  onToolCall() {},
};

class HeldRuntime implements Runtime {
  turns = 0;
  private resolveTurn!: (status: "completed" | "failed") => void;
  readonly turn: Promise<"completed" | "failed">;

  constructor() {
    this.turn = new Promise((resolve) => {
      this.resolveTurn = resolve;
    });
  }

  async start() {}
  async stop() {
    this.resolveTurn("failed");
  }
  async startThread() {
    return "held-thread";
  }
  async resumeThread() {}
  async startTurn() {
    this.turns += 1;
    return "held-turn";
  }
  async interruptTurn() {}
  async waitForTurn() {
    return this.turn;
  }
  onUnexpectedRequest() {}
  onToolCall() {}
}

function deferredOutcome() {
  let resolve!: (status: "completed" | "failed") => void;
  const promise = new Promise<"completed" | "failed">((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RecoveryEvidenceRuntime implements Runtime {
  readonly process: RuntimeProcessIdentity = {
    processId: "fixture-process-<script>",
    processStartedAt: "fixture-started-&-bounded",
    bootId: "fixture-boot-identity",
  };
  threads = 0;
  turns = 0;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferredOutcome>
  >();

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("failed");
  }

  processIdentity() {
    return this.process;
  }

  async startThread() {
    return `fixture-thread-${++this.threads}-<img src=x onerror=alert(1)>`;
  }

  async resumeThread() {}

  async startTurn() {
    const turnId = `fixture-turn-${++this.turns}-&-recorded`;
    this.outcomes.set(turnId, deferredOutcome());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest() {}
  onToolCall() {}

  finish(turnId: string, status: "completed" | "failed") {
    this.outcomes.get(turnId)?.resolve(status);
  }
}

function command(service: StandaloneService, value: object): unknown {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...value,
  } as DomainCommand);
}

test("capacity control replays the same keyed change", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-capacity-"));
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Capacity lead",
    instructions: "coordinate",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Capacity project",
    leadProfileId: profileId,
  });
  const input = {
    type: "capacity.configure" as const,
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectId]: 1 },
  };
  const receipt = await new OperatorApi(service).execute(input);
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  assert.deepEqual(await new OperatorApi(service).execute(input), receipt);
  assert.equal(service.capacityLimits([projectId]).globalLimit, 1);
  assert.equal(
    service.capacityLimits([projectId]).projectOverrides[projectId],
    1,
  );
});

test("task execution keeps the writer hold visible after Resume", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-task-"));
  const heldRuntime = new HeldRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => heldRuntime,
    undefined,
    { power: { enabled: false }, supervisor: { observationMs: 5 } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Task lead",
    instructions: "PRIVATE_PROFILE_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Hold project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Held <script>window.privateValue=1</script>",
    outcome: "PRIVATE_OUTCOME_SENTINEL",
    ready: true,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await until(() => heldRuntime.turns > 0);

  const api = new OperatorApi(service, [directory]);
  const read = async () => (await api.readTask(taskId)).data;
  assert.equal((await read()).execution.state, "running");

  await service.stopTask(taskId);
  assert.equal((await read()).execution.state, "stopping");

  // Resume clears only the Stop: the writer hold stays recorded.
  await service.resumeTask(taskId);
  const resumed = await read();
  assert.equal(resumed.execution.holds.stop, false);
  assert.equal(resumed.executionRecovery?.holds.writer, true);
});

test("the assignment recovery read retains scoped records and holds", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-recovery-view-"));
  const runtime = new RecoveryEvidenceRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      supervisor: { observationMs: 5 },
      terminationVerifier: {
        async verify(processIdentity) {
          return {
            kind: "verified",
            processIdentity,
            verifiedAt: "2026-09-30T12:00:00.000Z",
            method: "mac-pid-absent-same-boot",
          };
        },
      },
    },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const workerAssignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Recovery lead",
    instructions: "PRIVATE_RECOVERY_INSTRUCTIONS_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "profile.create",
    profileId: workerProfileId,
    name: "Recovery worker",
    instructions: "PRIVATE_RECOVERY_WORKER_INSTRUCTIONS_SENTINEL",
    capabilities: "review",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Recovery evidence project",
    leadProfileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "No routing calls are made by this view fixture.",
    credentialRef: "env:PRIVATE_RECOVERY_CREDENTIAL_SENTINEL",
    candidateProfileIds: [workerProfileId],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Task-scoped recovery evidence",
    outcome: "PRIVATE_RECOVERY_OUTCOME_SENTINEL",
    ready: false,
  });
  const leadAssignment = service.domain().ensureLeadAssignment(taskId);
  assert.ok(leadAssignment);
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId: workerAssignmentId,
    profileId: workerProfileId,
    brief: "PRIVATE_RECOVERY_BRIEF_SENTINEL",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => runtime.turns === 1);

  await service.stopTask(taskId);
  const firstRecord = service
    .recoveryView()
    .find((record) => record.binding?.taskId === taskId);
  assert.ok(firstRecord?.binding);
  assert.ok(firstRecord.intent.threadId);
  assert.ok(firstRecord.intent.turnId);
  assert.ok(firstRecord.processIdentity);
  const firstTurnId = firstRecord.intent.turnId;
  await service.resolveHeldExecution({
    workId: firstRecord.workId,
    workRevision: firstRecord.generation.workRevision,
    requestSequence: firstRecord.generation.requestSequence,
    threadId: firstRecord.intent.threadId,
    turnId: firstTurnId,
    processIdentity: firstRecord.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "reconciled",
  });
  runtime.finish(firstTurnId, "failed");
  await service.resumeTask(taskId);
  await until(() => runtime.turns === 2);
  await service.stopTask(taskId);

  const records = service
    .recoveryView()
    .filter((record) => record.binding?.taskId === taskId);
  assert.equal(
    records.length,
    2,
    "both SQLite-backed generations are retained",
  );
  const receiptRecord = records.find((record) => record.receipt !== null);
  const pendingRecord = records.find(
    (record) => record.receipt === null && record.pendingEffects.length > 0,
  );
  assert.ok(receiptRecord?.receipt);
  assert.ok(receiptRecord?.binding);
  assert.ok(pendingRecord?.binding);
  assert.notEqual(receiptRecord.workId, pendingRecord.workId);

  const api = new OperatorApi(service, [directory]);
  const receiptRecovery = (
    await api.readAssignmentRecovery(receiptRecord.binding.assignmentId)
  ).data;
  const pendingRecovery = (
    await api.readAssignmentRecovery(pendingRecord.binding.assignmentId)
  ).data;
  assert.ok(
    receiptRecovery.records.some((r) => r.workId === receiptRecord.workId),
  );
  assert.ok(
    pendingRecovery.records.some((r) => r.workId === pendingRecord.workId),
  );
  assert.equal(pendingRecovery.holds.writer, true);
  assert.doesNotMatch(
    JSON.stringify([receiptRecovery, pendingRecovery]),
    /PRIVATE_RECOVERY_(?:INSTRUCTIONS|WORKER_INSTRUCTIONS|CREDENTIAL)_SENTINEL/,
  );
});

test("instruction apply refreshes the selected assignment revision once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-instructions-"));
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Instruction lead",
    instructions: "original profile instructions",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Instruction project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Instruction task",
    outcome: "Deliver work",
    ready: false,
  });
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "PRIVATE_ASSIGNMENT_PROMPT",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "updated project instructions",
  });

  const input = {
    type: "assignment.apply" as const,
    key: randomUUID(),
    projectId,
    assignmentId,
    expectedVersion: 1,
  };
  const receipt = await new OperatorApi(service, [directory]).execute(input);
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  assert.deepEqual(
    await new OperatorApi(service, [directory]).execute(input),
    receipt,
  );
  const assignment = service.domain().assignment(assignmentId);
  assert.equal(Number(assignment.version), 2);
  assert.equal(Number(assignment.instructionsRevision), 2);
});
