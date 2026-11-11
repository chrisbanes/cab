import { seedOwnQuestion, startOwnWork } from "../fixtures/questions.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { mixedForm, mixedAnswers } from "../fixtures/question-data.js";
import { QUIET_WINDOW_MS, until } from "../fixtures/until.js";

for (const hold of ["none", "pause", "stop"] as const)
  test(`full own-tool question after successful terminal records exact >16k group behind ${hold} hold`, async () => {
    const f = await createOperatorFixture();
    try {
      const a = await seedReviewTask(f, "Full questions", "Full form task");
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
      await until(() => f.runtime.turns === 1);
      const work = f.service.list().find((w) => w.state === "running")!;
      assert.ok(work.threadId && work.turnId);
      const form = structuredClone(mixedForm);
      form.questions.push({
        id: "extra",
        kind: "free-text",
        label: "Additional notes",
        required: true,
      });
      const answers = {
        ...mixedAnswers,
        notes: { optionIds: [], text: "a".repeat(12000) },
        extra: { optionIds: [], text: "b".repeat(12000) },
      };
      const response = await f.runtime.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        callId: "full-service-question",
        tool: "cab_ask_question",
        arguments: { form },
      });
      assert.equal(response.success, true, response.text);
      const q = f.service.coordinationView().readTask(a.taskId).questions[0]!;
      f.runtime.complete(1);
      await until(() =>
        f.service
          .list()
          .some((w) => w.workId === work.workId && w.state === "completed"),
      );
      if (hold === "pause")
        d.execute({
          type: "project.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: a.projectId,
          expectedVersion: 2,
          paused: true,
        });
      if (hold === "stop") await f.service.stopTask(a.taskId);
      const command = {
        taskId: a.taskId,
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: 1,
        answers,
      };
      const receipt = await f.service
        .coordinationView()
        .answerQuestionForm(command);
      assert.equal(receipt.recipientAssignmentId, a.assignmentId);
      assert.equal(
        (await f.service.coordinationView().answerQuestionForm(command))
          .eventId,
        receipt.eventId,
      );
      const message = f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.find((m) => m.eventId === receipt.eventId)!;
      assert.deepEqual(message.questionAnswers, answers);
      if (hold === "none") {
        await until(() => f.runtime.turns === 2);
        const prompt = f.runtime.prompts[1]!;
        assert.ok(prompt.includes(JSON.stringify(answers)));
        assert.ok(prompt.includes(work.workId));
        assert.equal(f.runtime.turns, 2);
      } else {
        await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
        assert.equal(f.runtime.turns, 1);
      }
    } finally {
      await f.close();
    }
  });

test("ordinary same-assignment continuation delivers before answer to original request; restart never duplicates answer admission", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f);
    await f.service.stop();
    await f.service.start();
    await f.service.coordinationView().postOperatorMessage({
      taskId: a.taskId,
      key: randomUUID(),
      recipientAssignmentId: a.assignmentId,
      expectedAssignmentVersion: Number(
        f.service.domain().assignment(a.assignmentId).version,
      ),
      message: "Ordinary unrelated follow-up",
    });
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 3,
      paused: false,
    });
    await until(() => f.runtime.turns === 2, "second turn", 15_000);
    assert.ok(f.runtime.prompts[1]?.includes("Ordinary unrelated follow-up"));
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 4,
      paused: true,
    });
    const continuation = f.service.list().find((w) => w.state === "running");
    assert.ok(continuation?.threadId && continuation.turnId);
    const waiting = await f.runtime.callTool({
      threadId: continuation.threadId,
      turnId: continuation.turnId,
      callId: "ordinary-next-action",
      tool: "cab_request_approval",
      arguments: { action: "review", material: { revision: 1 } },
    });
    assert.equal(waiting.success, true, waiting.text);
    f.runtime.complete(2);
    await until(
      () =>
        f.service.list().filter((w) => w.state === "completed").length === 2,
    );
    const command = {
        taskId: a.taskId,
        key: randomUUID(),
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers: mixedAnswers,
      },
      receipt = await f.service.coordinationView().answerQuestionForm(command);
    await f.service.stop();
    await f.service.start();
    assert.equal(
      (await f.service.coordinationView().answerQuestionForm(command)).eventId,
      receipt.eventId,
    );
    assert.equal(f.runtime.turns, 2);
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 5,
      paused: false,
    });
    await until(() => f.runtime.turns === 3, "third turn", 15_000);
    assert.ok(
      f.runtime.prompts[2]?.includes(JSON.stringify(mixedAnswers)),
      JSON.stringify({
        prompts: f.runtime.prompts,
        requests: f.service.turnRequests(),
        events: f.service.coordinationView().readTask(a.taskId).messages,
      }),
    );
    assert.ok(f.runtime.prompts[2]?.includes(a.workId));
    f.service.domain().execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      expectedVersion: 6,
      paused: true,
    });
    f.runtime.complete(3);
    await until(
      () =>
        f.service.list().filter((w) => w.state === "completed").length === 3,
    );
    await f.service.stop();
    await f.service.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.runtime.turns, 3);
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("cab question and approval tools refuse unreadable headlines without writing and accept readable ones", async () => {
  const f = await createOperatorFixture();
  try {
    const { a, work } = await startOwnWork(f, "Readable asks", "Readable");
    const call = (tool: string, args: unknown, callId: string = randomUUID()) =>
      f.runtime.callTool({
        threadId: work.threadId!,
        turnId: work.turnId!,
        callId,
        tool,
        arguments: args as Record<string, unknown>,
      });
    const counts = () => {
      const view = f.service.coordinationView().readTask(a.taskId);
      return view.questions.length + view.approvals.length;
    };
    const choice = (label: string, description?: string) => ({
      form: {
        version: 1,
        questions: [
          {
            id: "q",
            kind: "single-choice",
            label: "Which channel should the release use?",
            required: true,
            customAllowed: false,
            options: [
              {
                id: "o",
                label,
                ...(description === undefined ? {} : { description }),
              },
            ],
          },
        ],
      },
    });
    const labelled = (label: string) => ({
      form: {
        version: 1,
        questions: [{ id: "q", kind: "free-text", label, required: true }],
      },
    });
    const refused: Array<[string, string, unknown, RegExp]> = [
      [
        "cab_ask_question",
        "long plain",
        { question: "a".repeat(121) },
        /`question` is 121 characters; the limit is 120/,
      ],
      [
        "cab_ask_question",
        "multi-line plain",
        { question: "Ship it?\nBackground" },
        /`question` contains a line break/,
      ],
      [
        "cab_ask_question",
        "carriage-return plain",
        { question: "Ship it?\rBackground" },
        /`question` contains a line break/,
      ],
      [
        "cab_ask_question",
        "line-separator plain",
        { question: "Ship it?\u2028Background" },
        /`question` contains a line break/,
      ],
      [
        "cab_ask_question",
        "paragraph-separator plain",
        { question: "Ship it?\u2029Background" },
        /`question` contains a line break/,
      ],
      [
        "cab_ask_question",
        "long label",
        labelled("b".repeat(121)),
        /`form\.questions\[0\]\.label` is 121 characters; the limit is 120/,
      ],
      [
        "cab_ask_question",
        "long option",
        choice("c".repeat(81), "Causes it"),
        /`form\.questions\[0\]\.options\[0\]\.label` is 81 characters; the limit is 80/,
      ],
      [
        "cab_ask_question",
        "multi-line option",
        choice("Yes\nreally", "Causes it"),
        /`form\.questions\[0\]\.options\[0\]\.label` contains a line break/,
      ],
      [
        "cab_ask_question",
        "UUID",
        labelled("Retry operation 3ac791e2-d016-41c1-a71a-1e9414bc0831?"),
        /`form\.questions\[0\]\.label` contains a UUID/,
      ],
      [
        "cab_ask_question",
        "SHA",
        labelled("Push head 6d1dc6c2 again?"),
        /contains a SHA \(a hex run of 7–40 characters with a digit\)/,
      ],
      [
        "cab_ask_question",
        "provider code",
        labelled("Retry after provider-http-422?"),
        /contains a provider failure code/,
      ],
      [
        "cab_ask_question",
        "node ID",
        labelled("Use repository R_kgDORzdwYA?"),
        /contains a GitHub node ID/,
      ],
      [
        "cab_ask_question",
        "missing description",
        choice("Stable"),
        /`form\.questions\[0\]\.options\[0\]\.description` is missing/,
      ],
      [
        "cab_ask_question",
        "blank description",
        choice("Stable", "  "),
        /`form\.questions\[0\]\.options\[0\]\.description` is missing/,
      ],
      [
        "cab_request_approval",
        "long action",
        { action: "d".repeat(121), material: {} },
        /`action` is 121 characters; the limit is 120/,
      ],
      [
        "cab_request_approval",
        "SHA action",
        { action: "Force-push 6d1dc6c2e", material: {} },
        /`action` contains a SHA/,
      ],
    ];
    for (const [tool, name, args, message] of refused) {
      const response = await call(tool, args, `refused-${name}`);
      assert.equal(response.success, false, name);
      assert.match(response.text, message, name);
      assert.ok(response.text.length <= 1000, name);
      assert.equal(counts(), 0, name);
    }
    const inbox = (await new OperatorApi(f.service, []).readInbox()).data.items;
    assert.equal(
      inbox.filter((i) => "taskId" in i && i.taskId === a.taskId).length,
      0,
    );
    // A refusal caches no receipt, so the corrected retry under the same callId runs.
    assert.equal(
      (
        await call(
          "cab_ask_question",
          { question: "Ship it?" },
          "refused-long plain",
        )
      ).success,
      true,
    );
    const accepted: Array<[string, unknown]> = [
      ["120-character question", { question: "e".repeat(120) }],
      ["80-character option", choice("f".repeat(80), "Causes it")],
      [
        "dotted action and hex word",
        labelled("Should pr.create run after the facade change?"),
      ],
      [
        "descriptions without recommended",
        {
          form: {
            version: 1,
            questions: [
              {
                id: "q",
                kind: "multiple-choice",
                label: "Which checks should block the merge?",
                required: true,
                customAllowed: false,
                options: [
                  {
                    id: "lint",
                    label: "Lint",
                    description: "Lint failures block merging",
                  },
                  {
                    id: "test",
                    label: "Tests",
                    description: "Test failures block merging",
                  },
                ],
              },
            ],
          },
        },
      ],
    ];
    for (const [name, args] of accepted)
      assert.equal((await call("cab_ask_question", args)).success, true, name);
    const replayed = await call(
      "cab_ask_question",
      {
        question: "Which release channel should we use?",
        context: "Background: beta is behind.",
      },
      "readable-context",
    );
    assert.equal(replayed.success, true, replayed.text);
    assert.deepEqual(
      await call(
        "cab_ask_question",
        {
          question: "Which release channel should we use?",
          context: "Background: beta is behind.",
        },
        "readable-context",
      ),
      replayed,
    );
    const view = f.service.coordinationView().readTask(a.taskId);
    assert.equal(view.questions.length, accepted.length + 2);
    const forms = view.questions.map(
      (q) => f.service.coordinationView().questionForm(q.interactionId)?.form,
    );
    assert.deepEqual(
      forms.find(
        (form) =>
          form?.questions[0]?.description === "Background: beta is behind.",
      ),
      {
        version: 1,
        questions: [
          {
            id: "answer",
            kind: "free-text",
            label: "Which release channel should we use?",
            description: "Background: beta is behind.",
            required: true,
            minLength: 1,
          },
        ],
      },
    );
    assert.equal(
      (
        await call("cab_request_approval", {
          action: "Publish the release notes",
          material: {},
        })
      ).success,
      true,
    );
  } finally {
    await f.close();
  }
});
