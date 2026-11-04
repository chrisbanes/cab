import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ProjectArchivedError,
  ProjectArchiveBlockedError,
} from "../../src/core/project-lifecycle.js";
import { archivedProjectFixture } from "../fixtures/archived-project.js";

test("the live service archive authority sees an unfinished callback after its execution settled", async (t) => {
  const f = await archivedProjectFixture(t, false);
  let release!: () => void;
  const callback = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.db
    .prepare("UPDATE execution_intents SET state='ready' WHERE workId=?")
    .run(f.workId);
  f.service.registerExecutionCallback(f.workId, callback);
  f.db
    .prepare("UPDATE execution_intents SET state='completed' WHERE workId=?")
    .run(f.workId);
  assert.throws(
    f.freeze,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some(
        (blocker) => blocker.kind === "callback" && blocker.workId === f.workId,
      ),
  );
  release();
  await callback;
  await Promise.resolve();
  f.freeze();
  const before = f.snapshot();
  assert.throws(
    () => f.service.registerExecutionCallback(f.workId, Promise.resolve()),
    ProjectArchivedError,
  );
  assert.equal(f.snapshot(), before);
});

test("archived execution control and direct state calls cannot queue, bind, change results or release ownership", async (t) => {
  const f = await archivedProjectFixture(t),
    before = f.snapshot();
  const refuse = [
    () => f.components.schedulerStore.hold(f.workId, "Changed"),
    () => f.components.schedulerStore.wait(f.workId, "Changed"),
    () => f.components.schedulerStore.setWorkspace(f.workId, "/changed"),
    () => f.components.state.stopTask(f.taskId),
    () => f.components.state.resumeTask(f.taskId),
    () => f.components.state.recordResult(f.workId, "New result"),
    () => f.components.state.bindThread(f.intent.id, "new-thread"),
    () => f.components.state.bindTurn(f.intent.id, "new-turn"),
    () => f.components.state.setWorkspaceKey(f.intent.id, "/changed"),
    () => f.components.state.hold(f.intent.id, "new hold"),
    () => f.components.state.wait(f.intent.id, "wait"),
    () => f.components.state.replaceConversation(f.assignmentId),
    () => f.components.state.beginArchive(f.taskId),
    () => f.components.state.endArchive(f.taskId),
    () => f.components.state.claimStopInterrupt(f.workId),
    () => f.components.state.recordStopInterrupt(f.workId, "failed"),
  ];
  for (const write of refuse) assert.throws(write, ProjectArchivedError);
  await assert.rejects(f.service.resumeTask(f.taskId), ProjectArchivedError);
  await assert.rejects(
    f.service.startDrafting({
      runId: randomUUID(),
      projectId: f.projectId,
      idea: "New work",
    }),
    ProjectArchivedError,
  );
  assert.equal(f.snapshot(), before);
  assert.equal(f.fixture.runtime.turns, 0);
});

test("scheduler, recovery and source sweeps leave an archived project's history unchanged", async (t) => {
  const f = await archivedProjectFixture(t),
    before = f.snapshot();
  await f.service.refreshGitHub();
  await f.service.runStatusMapping();
  await f.components.supervisor.reconcileOnStart();
  f.components.state.settleDraftTurnEffects();
  f.components.drafting.sweepExpired();
  f.service.localReviews().purgeEditableDrafts();
  await f.components.workspaces.recover();
  await f.components.diagnostics?.prune();
  assert.equal(f.snapshot(), before);
  assert.equal(f.fixture.runtime.turns, 0);
  f.restore();
  assert.equal(f.domain.project(f.projectId).paused, 1);
});

test("workspace provisioning holds archive through its awaited operation and frozen reads leave the binding intact", async (t) => {
  const f = await archivedProjectFixture(t, false);
  const pending = f.service.provisionTask(f.taskId);
  assert.throws(
    f.freeze,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some((blocker) => blocker.kind === "callback"),
  );
  await pending;
  f.freeze();
  const before = f.components.workspaceBindings.get(f.taskId);
  assert.ok(before);
  assert.deepEqual(await f.service.taskWorkspace(f.taskId), before);
  await assert.rejects(
    f.components.workspaces.forExecution(f.taskId),
    ProjectArchivedError,
  );
  await f.components.workspaces.recover();
  assert.deepEqual(f.components.workspaceBindings.get(f.taskId), before);
});

for (const kind of [
  "interaction",
  "completion",
  "workspace",
  "recovery-hold",
  "result-destination",
] as const)
  test(`the service archive authority refuses an unresolved ${kind} independently`, async (t) => {
    const f = await archivedProjectFixture(t, false),
      id = randomUUID();
    if (kind === "interaction")
      f.db
        .prepare(
          "INSERT INTO coordination_interactions (interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,revision) VALUES (?,?,?,?,1,1,1,'question','open','Question',1)",
        )
        .run(id, f.taskId, f.assignmentId, f.workId);
    if (kind === "completion")
      f.db
        .prepare(
          "INSERT INTO coordination_completion_requests (requestId,taskId,leadAssignmentId,leadWorkId,leadWorkRevision,taskVersion,reviewedResultIds,status,revision) VALUES (?,?,?,?,1,1,'[]','pending',1)",
        )
        .run(id, f.taskId, f.assignmentId, f.workId);
    if (kind === "workspace")
      f.components.workspaceBindings.createOrGet(
        f.taskId,
        id,
        `/disposable/${id}`,
        [],
      );
    if (kind === "recovery-hold")
      f.db
        .prepare(
          "INSERT INTO execution_stop_targets (taskId,workId,interruptState,terminalState,requestedAt) VALUES (?,?,'unbound','unknown',1)",
        )
        .run(f.taskId, f.workId);
    if (kind === "result-destination") {
      f.db
        .prepare(
          "INSERT INTO coordination_results (resultId,taskId,assignmentId,workId,workRevision,assignmentVersion,summary,payloadHash,destinationDisposition) VALUES (?,?,?,?,1,1,'Result','fixture','unresolved')",
        )
        .run(id, f.taskId, f.assignmentId, f.workId);
      f.db
        .prepare(
          "INSERT INTO coordination_unresolved_result_destinations (resultId,taskId,assignmentId,reason,revision,status) VALUES (?,?,?,'Missing destination',1,'unresolved')",
        )
        .run(id, f.taskId, f.assignmentId);
    }
    const before = f.snapshot();
    assert.throws(
      f.freeze,
      (error) =>
        error instanceof ProjectArchiveBlockedError &&
        error.blockers.some((blocker) => blocker.kind === kind),
    );
    assert.equal(f.snapshot(), before);
  });
