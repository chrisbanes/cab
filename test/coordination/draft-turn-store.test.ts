import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { coordinationFixture } from "../fixtures/coordination.js";

const task = "20000000-0000-4000-8000-000000000001";
const ask = (threadId: string, turnId: string) => ({
  threadId,
  turnId,
  callId: `ask-${turnId}`,
  tool: "ensemble_ask_question",
  arguments: { question: "Which repository?" },
});

/** The lead's bound work with its request; the lead assignment stays pending. */
function leadTurn(
  f: ReturnType<typeof coordinationFixture>,
  scheduler: SchedulerStore,
  name: string,
  draftTurn: boolean,
) {
  const lead = String(f.leadAssignment(task)?.id);
  f.addWork(lead, `work-${name}`, `thread-${name}`, `turn-${name}`);
  f.db
    .prepare("UPDATE domain_assignments SET state = 'pending' WHERE id = ?")
    .run(lead);
  const assignment = f.domain.assignment(lead);
  scheduler.ensure({
    requestKey: `work-${name}`,
    workId: `work-${name}`,
    kind: "assignment",
    taskId: task,
    projectId: String(assignment.projectId),
    assignmentId: lead,
    taskVersion: 1,
    assignmentVersion: Number(assignment.version),
    instructionsRevision: Number(assignment.instructionsRevision),
    profileRevision: Number(assignment.profileRevision),
    prompt: "prompt",
    workspace: null,
    previousWorkId: null,
    draftTurn,
  });
  return lead;
}

test("a draft turn keeps the lead pending and still binds its callbacks", () => {
  const f = coordinationFixture();
  try {
    const scheduler = new SchedulerStore(f.db);
    const lead = leadTurn(f, scheduler, "draft", true);
    assert.equal(scheduler.hasOrdinaryAssignmentWork(lead), false);
    assert.equal(scheduler.activeDraftTurn(task)?.workId, "work-draft");
    f.coordination.requestQuestion(ask("thread-draft", "turn-draft"));
    assert.equal(f.coordination.interactions(task).length, 1);
    assert.equal(
      f.db
        .prepare("SELECT state FROM domain_assignments WHERE id = ?")
        .get(lead)?.state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("an ordinary turn of a pending lead is not bound and counts as ordinary work", () => {
  const f = coordinationFixture();
  try {
    const scheduler = new SchedulerStore(f.db);
    const lead = leadTurn(f, scheduler, "ordinary", false);
    assert.equal(scheduler.hasOrdinaryAssignmentWork(lead), true);
    assert.equal(scheduler.activeDraftTurn(task), undefined);
    assert.throws(() =>
      f.coordination.requestQuestion(ask("thread-ordinary", "turn-ordinary")),
    );
  } finally {
    f.close();
  }
});

test("a request identity cannot change its draft turn marker", () => {
  const f = coordinationFixture();
  try {
    const scheduler = new SchedulerStore(f.db);
    leadTurn(f, scheduler, "draft", true);
    const request = scheduler.byWorkId("work-draft");
    assert.equal(request.draftTurn, true);
    assert.throws(
      () => scheduler.ensure({ ...request, draftTurn: false }),
      /different content/,
    );
  } finally {
    f.close();
  }
});

test("turn requests created before draft turns gain a non-draft marker", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE turn_requests (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, requestKey TEXT NOT NULL UNIQUE,
    workId TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('direct','assignment')),
    taskId TEXT, projectId TEXT, assignmentId TEXT, taskVersion INTEGER,
    assignmentVersion INTEGER, instructionsRevision INTEGER, profileRevision INTEGER,
    prompt TEXT NOT NULL, workspace TEXT, previousWorkId TEXT,
    state TEXT NOT NULL CHECK(state IN ('queued','active','completed','held')),
    reason TEXT, nextEligibleAt INTEGER)`);
  db.exec(`INSERT INTO turn_requests (requestKey, workId, kind, prompt, state)
    VALUES ('k', 'w', 'direct', 'p', 'queued')`);
  const scheduler = new SchedulerStore(db);
  assert.equal(scheduler.byWorkId("w").draftTurn, false);
  db.close();
});
