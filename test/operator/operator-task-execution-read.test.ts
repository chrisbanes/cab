import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  createOperatorFixture,
  seedOperatorRecovery,
} from "../fixtures/operator-web.js";
import { seedImportedCommentTask } from "../fixtures/task-review.js";

async function seed() {
  const f = await createOperatorFixture();
  const api = new OperatorApi(f.service, [f.directory]),
    d = f.service.domain(),
    projectId = randomUUID(),
    otherProjectId = randomUUID(),
    leadId = randomUUID(),
    workerId = randomUUID(),
    taskId = randomUUID(),
    blockerId = randomUUID(),
    candidateId = randomUUID(),
    foreignTaskId = randomUUID(),
    leadAssignment = randomUUID(),
    workerAssignment = randomUUID();
  const run = (command: Record<string, unknown>) =>
    d.execute({ actor: "operator", key: randomUUID(), ...command } as never);
  for (const [profileId, name] of [
    [leadId, "Lead"],
    [workerId, "Worker"],
  ])
    run({
      type: "profile.create",
      profileId,
      name,
      instructions: "private",
      capabilities: "coordinate",
    });
  for (const [id, name] of [
    [projectId, "Execution"],
    [otherProjectId, "Other"],
  ])
    run({
      type: "project.create",
      projectId: id,
      name,
      leadProfileId: leadId,
    });
  run({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "None.",
    credentialRef: null,
    candidateProfileIds: [workerId],
  });
  for (const [id, project, title] of [
    [taskId, projectId, "Execution task"],
    [blockerId, projectId, "Current blocker"],
    [candidateId, projectId, "Candidate blocker"],
    [foreignTaskId, otherProjectId, "Other project task"],
  ] as const)
    run({
      type: "task.create",
      projectId: project,
      taskId: id,
      title,
      outcome: "Done",
      ready: false,
    });
  run({
    type: "dependency.add",
    projectId,
    taskId,
    blockerTaskId: blockerId,
    expectedVersion: 1,
  });
  for (const [assignmentId, profileId] of [
    [leadAssignment, leadId],
    [workerAssignment, workerId],
  ])
    run({
      type: "assignment.create",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Work",
      resultDestination: "operator",
      requesterAssignmentId: null,
    });
  // 21 lead records (the oldest holds writer and capacity) plus the task's operator Stop.
  seedOperatorRecovery(f, { projectId, taskId, assignmentId: leadAssignment });
  f.seedPersistedState((db) => {
    const intent = db.prepare(
        "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'PRIVATE','/PRIVATE','completed',NULL,NULL,NULL,'chatgpt','workspaceWrite','never')",
      ),
      identity = db.prepare(
        "INSERT INTO execution_recovery_identities(workId,workRevision,requestSequence) VALUES (?,1,?)",
      ),
      binding = db.prepare(
        "INSERT INTO task_execution_bindings(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
      );
    // Three newer worker records, a record bound to another task and an unbound one.
    for (let i = 0; i < 3; i++) {
      const workId = `worker-record-${i + 1}`;
      intent.run(randomUUID(), workId);
      identity.run(workId, 100 + i);
      binding.run(workId, taskId, workerAssignment);
    }
    for (const workId of ["foreign-record", "unbound-record"]) {
      intent.run(randomUUID(), workId);
      identity.run(workId, 999);
    }
    binding.run("foreign-record", foreignTaskId, leadAssignment);
  });
  return { f, api, taskId, blockerId, candidateId, projectId };
}

test("the task read carries task-wide recovery evidence, newest 20 after scoping, with every recorded hold", async (t) => {
  const { f, api, taskId } = await seed();
  t.after(() => f.close());
  const stopped = (await api.readTask(taskId)).data;
  assert.equal(stopped.execution.state, "stopping");
  assert.equal(stopped.execution.holds.stop, true);
  const recovery = stopped.executionRecovery;
  assert.ok(recovery);
  // 24 task records: the newest 20 across both assignments, oldest first.
  assert.equal(recovery.evidenceAvailable, true);
  assert.equal(recovery.omittedCount, 4);
  assert.equal(recovery.records.length, 20);
  assert.equal(recovery.records[0]?.workId, "recovery-generation-5");
  assert.deepEqual(
    recovery.records.slice(-3).map((r) => r.workId),
    ["worker-record-1", "worker-record-2", "worker-record-3"],
  );
  assert.ok(
    recovery.records.every(
      (r) => r.workId !== "foreign-record" && r.workId !== "unbound-record",
    ),
  );
  assert.equal(JSON.stringify(recovery).includes("PRIVATE"), false);
  // The omitted oldest (held) record still holds writer, capacity and uncertainty.
  assert.deepEqual(recovery.holds, {
    stop: true,
    writer: true,
    capacity: true,
    uncertainty: true,
    task: true,
  });

  // Resume clears only the Stop: the recorded writer and capacity holds remain.
  await f.service.resumeTask(taskId);
  const resumed = (await api.readTask(taskId)).data;
  assert.equal(resumed.execution.holds.stop, false);
  assert.notEqual(resumed.execution.state, "stopping");
  assert.deepEqual(resumed.executionRecovery?.holds, {
    stop: false,
    writer: true,
    capacity: true,
    uncertainty: true,
    task: false,
  });
});

test("a task without recovery records reports no evidence rather than a release", async (t) => {
  const { f, api, candidateId } = await seed();
  t.after(() => f.close());
  const recovery = (await api.readTask(candidateId)).data.executionRecovery;
  assert.deepEqual(recovery, {
    evidenceAvailable: false,
    omittedCount: 0,
    holds: {
      stop: false,
      writer: false,
      capacity: false,
      uncertainty: false,
      task: false,
    },
    records: [],
  });
});

test("dependency candidates are the project's other tasks that are not already blockers", async (t) => {
  const { f, api, taskId, blockerId, candidateId } = await seed();
  t.after(() => f.close());
  const read = (await api.readTask(taskId)).data;
  assert.deepEqual(
    read.localDependencies.map((b) => b.id),
    [blockerId],
  );
  assert.deepEqual(read.dependencyCandidates, [
    { id: candidateId, title: "Candidate blocker", state: "open" },
  ]);
  // The blocker can take the task as its own blocker only if that makes no cycle: the
  // domain decides, so the candidate list still names it.
  assert.deepEqual(
    new Set(
      (await api.readTask(blockerId)).data.dependencyCandidates?.map(
        (c) => c.id,
      ),
    ),
    new Set([taskId, candidateId]),
  );
});

test("an imported task gets no local dependency candidates, and unstarted assignments say so", async (t) => {
  const { f, api, taskId, candidateId } = await seed();
  t.after(() => f.close());
  // Bound execution records mean started; a fresh lead assignment has never run.
  assert.ok(
    (await api.readTask(taskId)).data.assignments.every((a) => a.started),
  );
  assert.ok(f.service.domain().ensureLeadAssignment(candidateId));
  assert.deepEqual(
    (await api.readTask(candidateId)).data.assignments.map((a) => a.started),
    [false],
  );
  const imported = await seedImportedCommentTask(f, null);
  const read = (await api.readTask(imported.taskId)).data;
  assert.ok(read.source);
  assert.deepEqual(read.dependencyCandidates, []);
});
