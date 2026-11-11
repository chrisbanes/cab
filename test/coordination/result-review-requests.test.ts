import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { until } from "../fixtures/until.js";

const request = {
  decision: "Should the new toolbar ship behind the beta flag?",
  recommendation: "Ship behind the flag; the focus regression is fixed.",
  uncertainties: ["Safari was not checked"],
};

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** Reads the store over its own connection, as the fixture seeds it. */
function store<T>(f: Fixture, read: (c: CoordinationStore) => T): T {
  let value: T | undefined;
  f.seedPersistedState((db) => {
    value = read(new CoordinationStore(db));
  });
  return value as T;
}

test("a lead result with operatorReview records one pending review bound to it; a routine result records none", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f);
  const routine = a.result("Routine completion");
  assert.deepEqual(
    store(f, (c) => c.resultReviews(a.taskId)),
    [],
  );
  assert.equal(
    f.service
      .inboxLifecycle()
      .rows(a.taskId)
      .filter((row) => row.kind === "result-review").length,
    0,
  );
  const r = a.result("Toolbar behind a flag", undefined, undefined, request);
  const [review, ...rest] = store(f, (c) => c.resultReviews(a.taskId));
  assert.equal(rest.length, 0);
  assert.ok(review);
  assert.equal(review.resultId, r.resultId);
  assert.equal(review.workId, r.workId);
  assert.equal(review.workRevision, 2);
  assert.equal(review.requestingAssignmentId, a.assignmentId);
  assert.equal(review.status, "pending");
  assert.equal(review.revision, 1);
  assert.equal(review.decision, request.decision);
  assert.equal(review.recommendation, request.recommendation);
  assert.deepEqual(review.uncertainties, request.uncertainties);
  assert.notEqual(review.resultId, routine.resultId);
  const episode = f.service.inboxLifecycle().get(review.reviewId);
  assert.equal(episode?.kind, "result-review");
  assert.equal(episode?.status, "actionable");
  assert.equal(episode?.sourceKey, `result-review:${review.reviewId}`);
  // Omitted uncertainties stay unrecorded, never an empty list.
  a.result("Second ask", undefined, undefined, {
    decision: request.decision,
    recommendation: request.recommendation,
  });
  assert.equal(
    store(f, (c) => c.resultReviews(a.taskId)).at(-1)?.uncertainties,
    null,
  );
});

test("replaying the report call returns the same result without a second review, and survives restarts", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f);
  const r = a.result("Toolbar behind a flag", undefined, undefined, request);
  const call = {
    threadId: r.workId,
    turnId: r.workId,
    callId: r.callId,
    tool: "cab_report_result",
    arguments: { summary: "Toolbar behind a flag", operatorReview: request },
  };
  const replay = store(f, (c) => c.recordResult(call));
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.resultId, r.resultId);
  assert.equal(
    replay.response.text,
    `Result recorded: ${r.resultId}; operator review requested`,
  );
  assert.throws(
    () =>
      store(f, (c) =>
        c.recordResult({
          ...call,
          arguments: {
            ...call.arguments,
            operatorReview: { ...request, decision: "Something else?" },
          },
        }),
      ),
    /different content/,
  );
  await f.reopen();
  await f.reopen();
  const reviews = store(f, (c) => c.resultReviews(a.taskId));
  assert.equal(reviews.length, 1);
  assert.equal(
    f.service
      .inboxLifecycle()
      .rows(a.taskId)
      .filter((row) => row.kind === "result-review").length,
    1,
  );
});

test("a delegate's request and a headline-breaking decision are refused and record no result", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  // A refused seed leaves its work revision behind, so each case gets its own task.
  for (const [ask, refusal] of [
    [
      (a: Awaited<ReturnType<typeof seedReviewTask>>) =>
        a.delegatedResult("Delegate asks", undefined, request),
      /accountable lead/,
    ],
    [
      (a: Awaited<ReturnType<typeof seedReviewTask>>) =>
        a.result("Lead asks", undefined, undefined, {
          ...request,
          decision: "Merge commit 1a2b3c4d5e6f now?",
        }),
      /operatorReview\.decision.*SHA/,
    ],
    [
      (a: Awaited<ReturnType<typeof seedReviewTask>>) =>
        a.result("Lead asks", undefined, undefined, {
          ...request,
          decision: "x".repeat(121),
        }),
      /operatorReview\.decision.*limit is 120/,
    ],
  ] as const) {
    const a = await seedReviewTask(f);
    assert.throws(() => ask(a), refusal);
    assert.deepEqual(
      store(f, (c) => c.results(a.taskId)),
      [],
    );
    assert.deepEqual(
      store(f, (c) => c.resultReviews(a.taskId)),
      [],
    );
  }
});

test("a newer lead result supersedes the pending review; a delegate result leaves it pending", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f);
  const r1 = a.result("First handback", undefined, undefined, request);
  a.delegatedResult("Delegate detail");
  let [review] = store(f, (c) => c.resultReviews(a.taskId));
  assert.equal(review?.status, "pending");
  const r2 = a.result("Revised handback");
  [review] = store(f, (c) => c.resultReviews(a.taskId));
  assert.equal(review?.resultId, r1.resultId);
  assert.equal(review?.status, "superseded");
  assert.equal(review?.supersededByResultId, r2.resultId);
  assert.equal(review?.revision, 2);
  const episode = f.service.inboxLifecycle().get(review!.reviewId);
  assert.equal(episode?.status, "resolved");
  assert.equal(episode?.obsolete, 1);
  assert.equal(episode?.resolution, "Superseded by a newer result");
});

test("only the lead withdraws its pending review request, with a reason", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f);
  const r = a.result("Handback", undefined, undefined, request);
  const delegate = a.delegatedResult("Delegate detail");
  const withdraw = (workId: string, callId = randomUUID()) =>
    store(f, (c) =>
      c.withdrawResultReview({
        threadId: workId,
        turnId: workId,
        callId,
        tool: "cab_withdraw_result_review",
        arguments: { resultId: r.resultId, reason: "Decided it myself" },
      }),
    );
  // Only running work may call; resume both finished works for the tool calls.
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE execution_intents SET state='running' WHERE workId IN (?,?)",
    ).run(r.workId, delegate.workId);
    db.prepare(
      "UPDATE domain_assignments SET state='running' WHERE id IN (?,?)",
    ).run(a.assignmentId, delegate.assignmentId);
  });
  const refused = withdraw(delegate.workId);
  assert.equal(refused.success, false);
  assert.match(refused.text, /accountable lead/);
  assert.equal(
    store(f, (c) => c.resultReviews(a.taskId))[0]?.status,
    "pending",
  );
  const callId = randomUUID();
  const withdrawn = withdraw(r.workId, callId);
  assert.equal(withdrawn.success, true, withdrawn.text);
  assert.deepEqual(withdraw(r.workId, callId), withdrawn);
  const [review] = store(f, (c) => c.resultReviews(a.taskId));
  assert.equal(review?.status, "withdrawn");
  assert.equal(review?.withdrawReason, "Decided it myself");
  assert.equal(
    f.service.inboxLifecycle().get(review!.reviewId)?.resolution,
    "Withdrawn by the lead",
  );
  const again = withdraw(r.workId);
  assert.equal(again.success, false);
  assert.match(again.text, /only a pending request/);
});

test("a pending review closes with its task on reconciliation", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  for (const state of ["done", "cancelled"] as const) {
    const a = await seedReviewTask(f, `Close ${state}`);
    a.result("Handback", undefined, undefined, request);
    f.seedPersistedState((db) =>
      db
        .prepare("UPDATE domain_tasks SET state=? WHERE id=?")
        .run(state, a.taskId),
    );
    f.service.reconcileInbox();
    const [review] = store(f, (c) => c.resultReviews(a.taskId));
    assert.equal(review?.status, "closed");
    const episode = f.service.inboxLifecycle().get(review!.reviewId);
    assert.equal(episode?.status, "resolved");
    assert.equal(episode?.obsolete, 1);
    assert.equal(
      episode?.resolution,
      state === "done" ? "Task is Done" : "Task is Cancelled",
    );
  }
});

test("an open review request neither holds the lead's completion nor authorizes anything", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const a = await seedReviewTask(f, "Review lifetime", "Hand back for review");
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    expectedVersion: 1,
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => f.runtime.hasPending(1));
  const work = f.service.list().find((w) => w.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const reported = await f.runtime.callTool({
    threadId: work.threadId,
    turnId: work.turnId,
    callId: "report-for-review",
    tool: "cab_report_result",
    arguments: { summary: "Toolbar ready.", operatorReview: request },
  });
  assert.equal(reported.success, true, reported.text);
  assert.match(reported.text, /operator review requested$/);
  f.runtime.complete(1);
  await until(() => domain.assignment(a.assignmentId).state === "completed");
  const [review] = store(f, (c) => c.resultReviews(a.taskId));
  assert.equal(review?.status, "pending");
  assert.deepEqual(
    store(f, (c) => c.openInteractionsForCompletion(a.taskId)),
    [],
  );
  assert.deepEqual(
    store(f, (c) => c.interactions(a.taskId)),
    [],
  );
  assert.equal(
    store(f, (c) =>
      c.authorizationFor({
        assignmentId: a.assignmentId,
        interactionId: review!.reviewId,
        expectedRevision: review!.revision,
        action: "pr.merge",
        material: {},
      }),
    ),
    false,
  );
  assert.equal(domain.task(a.taskId).state, "open");
});
