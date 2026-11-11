import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";

const request = {
  decision: "Should the new toolbar ship behind the beta flag?",
  recommendation: "Ship behind the flag; the focus regression is fixed.",
};

async function reviewed() {
  const f = await createOperatorFixture();
  const task = await seedReviewTask(f);
  const result = task.result(
    "Toolbar behind a flag",
    undefined,
    undefined,
    request,
  );
  const api = new OperatorApi(f.service, [f.directory]);
  const review = (await api.readTask(task.taskId)).data.resultReviews![0]!;
  const respond = (
    fields: Partial<{
      key: string;
      response: "reviewed" | "feedback";
      message: string;
      expectedRevision: number;
      reviewId: string;
    }> = {},
  ) => ({
    type: "result-review.respond" as const,
    key: randomUUID(),
    taskId: task.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    response: "feedback" as const,
    message: "Keep the old toolbar for keyboard users",
    ...fields,
  });
  /** What a response must never change. */
  const state = async () => {
    const read = (await api.readTask(task.taskId)).data;
    return {
      task: read.task.state,
      assignments: f.service
        .domain()
        .assignments(task.taskId)
        .map((a) => [a.id, a.state]),
      approvals: read.approvals.length,
      questions: read.questions.length,
      completions: read.completionRequests.length,
      delivery: read.delivery?.actions.length,
    };
  };
  return { f, task, result, api, review, respond, state };
}

test("feedback resolves the review with a receipt and resumes the completed lead once, anchored to the result", async (t) => {
  const { f, task, result, api, review, respond } = await reviewed();
  t.after(() => f.close());
  assert.equal(
    f.service.domain().assignment(task.assignmentId).state,
    "completed",
  );
  const command = respond();
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "result-review");
  assert.ok(receipt.kind === "result-review");
  assert.equal(receipt.reviewId, review.reviewId);
  assert.equal(receipt.response, "feedback");
  assert.equal(receipt.revision, review.revision + 1);
  assert.equal(receipt.resumedLead, true);
  assert.equal(receipt.recipientAssignmentId, task.assignmentId);
  assert.ok(receipt.eventId);
  // The same key replays the receipt without a second delivery.
  assert.deepEqual(await api.execute(command), receipt);
  await assert.rejects(
    api.execute({ ...command, message: "Something else" }),
    /conflict/,
  );
  const read = (await api.readTask(task.taskId)).data;
  const followUps = read.messages.filter(
    (m) => m.eventType === "assignment-follow-up",
  );
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0]?.eventId, receipt.eventId);
  assert.equal(followUps[0]?.text, command.message);
  assert.deepEqual(followUps[0]?.reference, { resultId: result.resultId });
  const [after] = read.resultReviews!;
  assert.equal(after?.status, "responded");
  assert.equal(after?.response?.response, "feedback");
  assert.equal(after?.response?.message, command.message);
  assert.equal(after?.response?.eventId, receipt.eventId);
  assert.equal(after?.lifecycle?.status, "resolved");
  assert.equal(after?.lifecycle?.resolution, "Feedback sent to the lead");
  assert.equal(f.runtime.turns, 0);
});

test("reviewed without a note resolves with a receipt and delivers nothing", async (t) => {
  const { f, task, api, respond, state } = await reviewed();
  t.after(() => f.close());
  const before = await state();
  const messages = (await api.readTask(task.taskId)).data.messages.length;
  const { message: _message, ...command } = respond({ response: "reviewed" });
  const receipt = await api.execute(command);
  assert.ok(receipt.kind === "result-review");
  assert.equal(receipt.response, "reviewed");
  assert.equal(receipt.eventId, null);
  assert.equal(receipt.recipientAssignmentId, null);
  assert.equal(receipt.resumedLead, undefined);
  assert.deepEqual(await api.execute(command), receipt);
  const read = (await api.readTask(task.taskId)).data;
  assert.equal(read.messages.length, messages);
  assert.equal(read.resultReviews![0]?.status, "responded");
  assert.equal(
    read.resultReviews![0]?.lifecycle?.resolution,
    "Marked reviewed",
  );
  assert.deepEqual(await state(), before);
  // Feedback without its text is refused before anything is stored.
  await assert.rejects(
    api.execute({ ...command, key: randomUUID(), response: "feedback" }),
  );
});

test("neither response changes task, assignment, approval, completion or delivery state", async (t) => {
  for (const response of ["reviewed", "feedback"] as const) {
    const { f, task, api, respond, state } = await reviewed();
    t.after(() => f.close());
    // A pending lead receives feedback as input; only a completed lead resumes.
    f.seedPersistedState((db) =>
      db
        .prepare("UPDATE domain_assignments SET state='pending' WHERE id=?")
        .run(task.assignmentId),
    );
    const before = await state();
    const receipt = await api.execute(respond({ response }));
    assert.ok(receipt.kind === "result-review");
    assert.equal(receipt.resumedLead, undefined);
    assert.deepEqual(await state(), before);
  }
});

test("a superseded, withdrawn or stale review refuses a response with a conflict and changes nothing", async (t) => {
  {
    const { f, task, api, review, respond } = await reviewed();
    t.after(() => f.close());
    await assert.rejects(
      api.execute(respond({ expectedRevision: review.revision + 1 })),
      /conflict/,
    );
    task.result("Revised handback");
    await assert.rejects(api.execute(respond()), /conflict/);
    const read = (await api.readTask(task.taskId)).data;
    assert.equal(read.resultReviews![0]?.status, "superseded");
    assert.equal(read.resultReviews![0]?.response, null);
    assert.equal(read.messages.filter((m) => m.reference?.resultId).length, 0);
  }
  {
    const { f, task, result, api, respond } = await reviewed();
    t.after(() => f.close());
    f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE execution_intents SET state='running' WHERE workId=?",
      ).run(result.workId);
      db.prepare(
        "UPDATE domain_assignments SET state='running' WHERE id=?",
      ).run(task.assignmentId);
    });
    f.seedPersistedState((db) => {
      const withdrawn = new CoordinationStore(db).withdrawResultReview({
        threadId: result.workId,
        turnId: result.workId,
        callId: randomUUID(),
        tool: "cab_withdraw_result_review",
        arguments: { resultId: result.resultId, reason: "No longer needed" },
      });
      assert.equal(withdrawn.success, true, withdrawn.text);
    });
    await assert.rejects(api.execute(respond()), /conflict/);
    assert.equal(
      (await api.readTask(task.taskId)).data.resultReviews![0]?.status,
      "withdrawn",
    );
  }
});

test("a plain result-anchored message and viewing the review leave it pending", async (t) => {
  const { f, task, result, api, review } = await reviewed();
  t.after(() => f.close());
  await api.execute({
    type: "message",
    key: randomUUID(),
    taskId: task.taskId,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: Number(
      f.service.domain().assignment(task.assignmentId).version,
    ),
    message: "A thought on this result",
    reference: { resultId: result.resultId },
  });
  await api.execute({
    type: "review.view",
    key: randomUUID(),
    taskId: task.taskId,
    sourceId: null,
    resultIds: [result.resultId],
  });
  const [after] = (await api.readTask(task.taskId)).data.resultReviews!;
  assert.equal(after?.status, "pending");
  assert.equal(after?.revision, review.revision);
  assert.equal(after?.lifecycle?.status, "actionable");
});

test("reviewed with a note delivers it to the lead as result-anchored feedback", async (t) => {
  const { f, task, result, api, respond } = await reviewed();
  t.after(() => f.close());
  const receipt = await api.execute(
    respond({ response: "reviewed", message: "Looks right; ship it" }),
  );
  assert.ok(receipt.kind === "result-review");
  assert.equal(receipt.response, "reviewed");
  assert.ok(receipt.eventId);
  const read = (await api.readTask(task.taskId)).data;
  const delivered = read.messages.find((m) => m.eventId === receipt.eventId);
  assert.equal(delivered?.text, "Looks right; ship it");
  assert.deepEqual(delivered?.reference, { resultId: result.resultId });
  assert.equal(read.resultReviews![0]?.response?.response, "reviewed");
});

test("a review whose task closed refuses a response even before reconciliation", async (t) => {
  const { f, task, api, respond } = await reviewed();
  t.after(() => f.close());
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_tasks SET state='done' WHERE id=?")
      .run(task.taskId),
  );
  await assert.rejects(api.execute(respond()), /conflict/);
});
