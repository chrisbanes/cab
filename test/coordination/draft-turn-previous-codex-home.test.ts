import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { configure, until } from "../fixtures/completed-lead.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const previousHome = "Started under the previous harness setup; reset the task";

test("a draft turn from the previous Codex home gives its message back, and Reset task replaces the conversation once Ready", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Previous home draft");
  configure(f, task.projectId, false);
  const api = new OperatorApi(f.service, []);
  const domain = f.service.domain();
  const version = () => Number(domain.task(task.taskId).version);
  const draft = (message: string) =>
    api.execute({
      type: "task.draft-turn" as const,
      key: randomUUID(),
      taskId: task.taskId,
      expectedVersion: version(),
      message,
    });

  await draft("First question.");
  await until(() => f.runtime.hasPending(1), "first draft turn");
  const oldThread = f.service
    .list()
    .find((work) => work.state === "running")?.threadId;
  assert.ok(oldThread);
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "first draft turn ends",
  );

  // The conversation now counts as started under the previous Codex home.
  Object.assign(f.runtime, {
    startedUnderPreviousHome: (threadId: string) => threadId === oldThread,
  });
  await draft("Second question.");
  await until(
    () =>
      f.service
        .turnRequests()
        .some((r) => r.state === "held" && r.reason?.includes(previousHome)),
    "second draft turn refused",
  );
  // Its message is given back, so a later draft turn is not blocked behind it.
  assert.deepEqual((await api.readTask(task.taskId)).data.draftTurn, {
    available: true,
  });

  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(),
    ready: true,
  });
  await until(
    () =>
      f.service
        .turnRequests()
        .some((r) => !r.draftTurn && r.reason?.includes(previousHome)),
    "initial turn refused",
  );
  assert.deepEqual((await api.readTask(task.taskId)).data.reset, {
    available: true,
  });
  const turns = f.runtime.turns;
  const receipt = await api.execute({
    type: "task.reset" as const,
    key: randomUUID(),
    taskId: task.taskId,
    expectedVersion: version(),
  });
  assert.ok(receipt.kind === "task-reset");
  await until(
    () => f.runtime.turns === turns + 1,
    "fresh turn on a new thread",
  );
  assert.notEqual(
    f.service.list().find((work) => work.workId === receipt.workId)?.threadId,
    oldThread,
  );
});

test("a draft turn refused before any turn was sent gives its message back to the next draft turn", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Pre-turn draft");
  configure(f, task.projectId, false);
  const api = new OperatorApi(f.service, []);
  const version = () => Number(f.service.domain().task(task.taskId).version);
  const draft = (message: string) =>
    api.execute({
      type: "task.draft-turn" as const,
      key: randomUUID(),
      taskId: task.taskId,
      expectedVersion: version(),
      message,
    });

  await draft("First question.");
  await until(() => f.runtime.hasPending(1), "first draft turn");
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "first draft turn ends",
  );

  // cab's own schema rejects the resumed thread, as with the skip-sandbox defect.
  const resumeThread = f.runtime.resumeThread.bind(f.runtime);
  const parsed = z
    .object({ type: z.literal("workspaceWrite") })
    .safeParse({ type: "dangerFullAccess" });
  assert.equal(parsed.success, false);
  Object.assign(f.runtime, {
    resumeThread: async () => {
      throw parsed.error;
    },
  });
  const turns = f.runtime.turns;
  await draft("SECOND_QUESTION");
  await until(
    () =>
      f.service
        .turnRequests()
        .some(
          (r) =>
            r.draftTurn &&
            r.state === "held" &&
            r.reason?.startsWith("Request refused before any turn was sent"),
        ),
    "second draft turn refused",
  );
  assert.equal(f.runtime.turns, turns, "no turn was sent");
  await until(
    async () => (await api.readTask(task.taskId)).data.draftTurn?.available,
    "draft turn available again",
  );

  Object.assign(f.runtime, { resumeThread });
  await draft("Third question.");
  await until(() => f.runtime.turns === turns + 1, "third draft turn");
  assert.match(f.runtime.prompts.at(-1) ?? "", /SECOND_QUESTION/);
});
