import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import { coordinationFixture } from "../fixtures/coordination.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskA = "20000000-0000-4000-8000-000000000001";
const taskB = "20000000-0000-4000-8000-000000000002";
const workerProfile = "30000000-0000-4000-8000-000000000002";

function admissionFixture() {
  const f = coordinationFixture();
  f.db
    .prepare(
      "INSERT INTO scheduler_project_capacity_limits (projectId, projectLimit) VALUES (?, 20)",
    )
    .run(projectId);
  const setNetwork = (enabled: boolean) => {
    f.domain.execute({
      type: "project.configure",
      actor: "operator",
      key: crypto.randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.project(projectId).version),
      commandNetworkAccess: enabled,
    });
  };
  let sequence = 0;
  /** A ready intent bound to a fresh assignment on a harness. */
  const ready = (taskId: string, harness: ExecutionHarness = "codex") => {
    sequence += 1;
    const workId = `net-work-${sequence}`;
    const assignmentId = crypto.randomUUID();
    f.domain.execute({
      type: "assignment.create",
      actor: "agent",
      key: crypto.randomUUID(),
      projectId,
      taskId,
      assignmentId,
      profileId: workerProfile,
      brief: "Network test",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    const assignment = f.domain.assignment(assignmentId);
    const intent = f.state.create(workId, "work", `/tmp/net-${sequence}`);
    f.state.bindTask(
      workId,
      {
        taskId: String(assignment.taskId),
        assignmentId,
        assignmentVersion: Number(assignment.version),
        instructionsRevision: Number(assignment.instructionsRevision),
        profileRevision: Number(assignment.profileRevision),
      },
      harness,
    );
    return intent;
  };
  const admit = (intent: { id: string }) =>
    f.state.begin(intent.id, { projectId });
  return { f, setNetwork, ready, admit };
}

test("a turn records the project's command network setting at its own admission", () => {
  const { f, setNetwork, ready, admit } = admissionFixture();
  try {
    const before = ready(taskA);
    const earlier = ready(taskB);
    assert.equal(f.state.commandNetworkAccess(before.id), false);

    // Enabled after `before` was created but before it is admitted: the
    // setting at admission wins, and an already admitted turn keeps its value.
    assert.equal(admit(earlier), true);
    setNetwork(true);
    assert.equal(admit(before), true);
    assert.equal(f.state.commandNetworkAccess(earlier.id), false);
    assert.equal(f.state.commandNetworkAccess(before.id), true);

    // Disabling leaves the admitted turn on and the next one off.
    setNetwork(false);
    const after = ready(taskA);
    assert.equal(admit(after), true);
    assert.equal(f.state.commandNetworkAccess(after.id), false);
    assert.equal(f.state.commandNetworkAccess(before.id), true);
  } finally {
    f.close();
  }
});

test("only Codex task turns can be admitted with command network access", () => {
  const { f, setNetwork, ready, admit } = admissionFixture();
  try {
    setNetwork(true);
    const claude = ready(taskA, "claude");
    assert.equal(admit(claude), true);
    assert.equal(f.state.commandNetworkAccess(claude.id), false);

    // A request without a task binding, such as a drafting run, stays off.
    const drafting = f.state.create(
      "drafting:run-1",
      "draft",
      "/tmp/net-draft",
    );
    assert.equal(f.state.begin(drafting.id, { projectId }), true);
    assert.equal(f.state.commandNetworkAccess(drafting.id), false);

    // A turn that was never admitted has no record, which means off.
    assert.equal(f.state.commandNetworkAccess(ready(taskB).id), false);
  } finally {
    f.close();
  }
});
