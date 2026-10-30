import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { configure, until } from "../fixtures/completed-lead.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const previousHome = "Started under the previous Codex home; restart the task";

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
