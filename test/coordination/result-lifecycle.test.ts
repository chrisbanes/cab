import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { until } from "../fixtures/until.js";

test("a recorded result does not end the assignment's still-running turn or invalidate its next question", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedReviewTask(
      f,
      "Result lifetime",
      "Continue after reporting",
    );
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
    const identity = { threadId: work.threadId, turnId: work.turnId };
    const result = await f.runtime.callTool({
      ...identity,
      callId: "report-before-end",
      tool: "cab_report_result",
      arguments: { summary: "Inspection completed; one decision remains." },
    });
    assert.equal(result.success, true, result.text);
    assert.equal(domain.assignment(a.assignmentId).state, "running");
    const question = await f.runtime.callTool({
      ...identity,
      callId: "question-after-report",
      tool: "cab_ask_question",
      arguments: {
        question: "Which of the evidenced approaches should I use?",
      },
    });
    assert.equal(question.success, true, question.text);
    assert.equal(
      f.service.coordinationView().readTask(a.taskId).questions.length,
      1,
    );
    f.runtime.complete(1);
    await until(
      () => f.service.executionForWork(work.workId)?.state === "completed",
    );
    assert.equal(domain.assignment(a.assignmentId).state, "running");
    const interaction = f.service.coordinationView().readTask(a.taskId)
      .questions[0]!;
    await f.service.coordinationView().answerQuestion({
      taskId: a.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: interaction.revision,
      answer: "Use the verified approach.",
    });
    await until(() => f.runtime.hasPending(2));
    const next = f.service.list().find((w) => w.state === "running")!;
    const final = await f.runtime.callTool({
      threadId: next.threadId!,
      turnId: next.turnId!,
      callId: "report-after-answer",
      tool: "cab_report_result",
      arguments: { summary: "Finished after the decision." },
    });
    assert.equal(final.success, true, final.text);
    f.runtime.complete(2);
    await until(() => domain.assignment(a.assignmentId).state === "completed");
  } finally {
    await f.close();
  }
});

for (const ending of [
  "completed",
  "failed",
  "completion",
  "rejected-completion",
  "completion-before-result",
] as const)
  test(`reported result waits for ${ending} terminal disposition`, async () => {
    const f = await createOperatorFixture();
    try {
      const a = await seedReviewTask(
        f,
        `Result ${ending}`,
        "Retain the active assignment",
      );
      const d = f.service.domain();
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        expectedVersion: 1,
        paused: false,
      });
      d.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        taskId: a.taskId,
        expectedVersion: 1,
        ready: true,
      });
      await until(() => f.runtime.hasPending(1));
      const work = f.service.list().find((w) => w.state === "running")!;
      const identity = { threadId: work.threadId!, turnId: work.turnId! };
      if (ending === "completion-before-result") {
        const requested = await f.runtime.callTool({
          ...identity,
          callId: "complete-before-result",
          tool: "cab_request_completion",
          arguments: {
            reviewedResultIds: f.service
              .coordinationView()
              .readTask(a.taskId)
              .results.map((r) => r.resultId),
          },
        });
        assert.equal(requested.success, true, requested.text);
      }
      const report = await f.runtime.callTool({
        ...identity,
        callId: "result",
        tool: "cab_report_result",
        arguments: { summary: "The scoped result." },
      });
      assert.equal(report.success, true, report.text);
      assert.equal(d.assignment(a.assignmentId).state, "running");
      const view = f.service.coordinationView().readTask(a.taskId);
      assert.equal(
        view.messages.filter((m) => m.eventType === "assignment-result").length,
        0,
      );
      if (ending === "completion" || ending === "rejected-completion") {
        const requested = await f.runtime.callTool({
          ...identity,
          callId: "complete",
          tool: "cab_request_completion",
          arguments: { reviewedResultIds: view.results.map((r) => r.resultId) },
        });
        assert.equal(requested.success, true, requested.text);
        if (ending === "rejected-completion") {
          const question = await f.runtime.callTool({
            ...identity,
            callId: "late-question",
            tool: "cab_ask_question",
            arguments: { question: "A decision remains." },
          });
          assert.equal(question.success, true, question.text);
        }
      }
      assert.equal(d.task(a.taskId).state, "open");
      if (ending === "failed") f.runtime.fail(1);
      else f.runtime.complete(1);
      if (ending === "completion") {
        await until(() => d.task(a.taskId).state === "done");
        assert.equal(d.assignment(a.assignmentId).state, "completed");
      } else if (
        ending === "rejected-completion" ||
        ending === "completion-before-result"
      ) {
        await until(
          () =>
            f.service.coordinationView().readTask(a.taskId)
              .completionRequests[0]?.status === "rejected",
        );
        assert.equal(d.assignment(a.assignmentId).state, "running");
        assert.equal(d.task(a.taskId).state, "open");
      } else if (ending === "failed") {
        await until(
          () => f.service.executionForWork(work.workId)?.state === "held",
        );
        assert.equal(d.assignment(a.assignmentId).state, "running");
        const record = f.service.recoveryFor(
          a.assignmentId,
          1,
          work.workId,
        )[0]!;
        assert.equal(record.holds.writer, true);
        assert.equal(record.holds.capacity, true);
      } else {
        await until(() => d.assignment(a.assignmentId).state === "completed");
        const late = await f.runtime.callTool({
          ...identity,
          callId: "after-terminal",
          tool: "cab_ask_question",
          arguments: { question: "This ended turn must not act." },
        });
        assert.equal(late.success, false);
        assert.match(late.text, /not bound/);
      }
    } finally {
      await f.close();
    }
  });
