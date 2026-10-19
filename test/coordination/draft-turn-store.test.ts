import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { ExecutionState } from "../../src/standalone/state.js";
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
    draftTaskDigest: draftTurn ? "digest-1" : null,
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

const refusal =
  "Request refused: captured revisions no longer match (task-revision-changed)";

/** Turns a bound draft request into one refused before it ran, with no admission evidence. */
function refuse(f: ReturnType<typeof coordinationFixture>, workId: string) {
  f.db
    .prepare(
      "UPDATE execution_intents SET state='held', reason=?, threadId=NULL, turnId=NULL WHERE workId=?",
    )
    .run(refusal, workId);
  f.db
    .prepare("UPDATE turn_requests SET state='held', reason=? WHERE workId=?")
    .run(refusal, workId);
  f.db
    .prepare("DELETE FROM execution_pending_effects WHERE workId=?")
    .run(workId);
  f.db
    .prepare(
      "INSERT INTO execution_request_refusals (workId, reason) VALUES (?, ?)",
    )
    .run(workId, refusal);
}

test("a draft request stores its task digest and a refusal before it ran finishes it", () => {
  const f = coordinationFixture();
  try {
    const scheduler = new SchedulerStore(f.db);
    leadTurn(f, scheduler, "draft", true);
    assert.equal(scheduler.byWorkId("work-draft").draftTaskDigest, "digest-1");
    assert.throws(
      () =>
        scheduler.ensure({
          ...scheduler.byWorkId("work-draft"),
          draftTaskDigest: "digest-2",
        }),
      /different content/,
    );
    // Held by Stop (no refusal row): still the task's draft turn.
    f.db
      .prepare(
        "UPDATE turn_requests SET state='held' WHERE workId='work-draft'",
      )
      .run();
    assert.equal(scheduler.activeDraftTurn(task)?.workId, "work-draft");
    f.db
      .prepare(
        "UPDATE turn_requests SET state='active' WHERE workId='work-draft'",
      )
      .run();
    refuse(f, "work-draft");
    // Built after the request table exists, as the service builds it.
    const state = new ExecutionState(f.db);
    assert.equal(
      state.isNeverAdmittedRefusedAssignmentWork("work-draft"),
      true,
    );
    assert.equal(scheduler.activeDraftTurn(task), undefined);
    // Evidence of a stop target means it is not never-admitted history.
    f.db
      .prepare(
        "INSERT INTO execution_stop_targets (taskId, workId, threadId, turnId, interruptState, terminalState, reason, requestedAt) VALUES (?, 'work-draft', NULL, NULL, 'unbound', 'unknown', NULL, 1)",
      )
      .run(task);
    assert.equal(
      state.isNeverAdmittedRefusedAssignmentWork("work-draft"),
      false,
    );
  } finally {
    f.close();
  }
});

test("only a draft turn refused before it ran releases its batch, and events are never deleted", () => {
  const f = coordinationFixture();
  try {
    const scheduler = new SchedulerStore(f.db);
    const lead = leadTurn(f, scheduler, "draft", true);
    const ordinary = leadTurn(f, scheduler, "ordinary", false);
    assert.equal(ordinary, lead);
    const version = Number(f.domain.assignment(lead).version);
    for (const name of ["draft", "ordinary"]) {
      f.coordination.deliverOperatorFeedback(task, lead, `message ${name}`);
      // One queued batch per recipient: complete the earlier one first.
      f.coordination.bindDeliveryBatch(lead, `work-${name}`, version);
      refuse(f, `work-${name}`);
      const state = new ExecutionState(f.db);
      assert.equal(
        state.isNeverAdmittedRefusedAssignmentWork(`work-${name}`),
        name === "draft",
      );
      const coordination = new CoordinationStore(f.db, f.domain, (workId) =>
        state.isNeverAdmittedRefusedAssignmentWork(workId),
      );
      const released = coordination.releaseRefusedDraftTurnDelivery(
        `work-${name}`,
      );
      assert.equal(released, name === "draft", name);
      const events = Number(
        (
          f.db
            .prepare("SELECT COUNT(*) AS n FROM coordination_inbox_events")
            .get() as { n: number }
        ).n,
      );
      assert.equal(
        events,
        name === "draft" ? 1 : 2,
        "events are never deleted",
      );
      if (name === "draft")
        assert.equal(coordination.pendingEvents(lead).length, 1);
      // Finish the earlier batch so the next one can bind.
      f.db.prepare("DELETE FROM coordination_delivery_events").run();
      f.db.prepare("DELETE FROM coordination_delivery_batches").run();
    }
  } finally {
    f.close();
  }
});
