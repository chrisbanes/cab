import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DomainOperationError } from "../../src/core/domain.js";
import {
  commandReceiptSchema,
  operatorCommandSchema,
  type taskTimelineSchema,
} from "../../src/operator/contracts.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { completedLead, configure, until } from "../fixtures/completed-lead.js";
import { seedReviewTask } from "../fixtures/task-review.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** A paused project whose lead is pending and whose delegate has completed a result. */
async function pausedTask(f: Fixture, name: string) {
  const task = await seedReviewTask(f, name);
  configure(f, task.projectId, true);
  const delegate = task.delegatedResult("Delegate finished");
  return { task, delegate, api: new OperatorApi(f.service, []) };
}

const version = (f: Fixture, assignmentId: string) =>
  Number(f.service.domain().assignment(assignmentId).version);

const send = (
  f: Fixture,
  taskId: string,
  body: string,
  ids: string[],
  key = randomUUID(),
) => ({
  type: "task.comment.send" as const,
  key,
  taskId,
  body,
  recipients: ids.map((assignmentId) => ({
    assignmentId,
    expectedAssignmentVersion: version(f, assignmentId),
  })),
});

const operations = (taskId: string, key: string) =>
  new URLSearchParams({
    scope: `task:${taskId}`,
    type: "task.comment.send",
    key,
  });

const status = (error: unknown) =>
  (error as { status?: number; code?: string }).status;

test("the task read previews each recipient's effect and a send returns one typed receipt", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, delegate, api } = await pausedTask(f, "Comment preview");
  const read = await api.readTask(task.taskId);
  const recipients = read.data.commentRecipients ?? [];
  const byId = new Map(recipients.map((r) => [r.assignmentId, r]));
  assert.equal(byId.get(task.assignmentId)?.role, "lead");
  assert.equal(byId.get(task.assignmentId)?.mode, "input");
  assert.equal(byId.get(delegate.assignmentId)?.role, "delegate");
  assert.equal(byId.get(delegate.assignmentId)?.mode, "resume");
  assert.equal(byId.get(delegate.assignmentId)?.name, "Task lead");

  const command = send(f, task.taskId, "Both of you, please sync.", [
    delegate.assignmentId,
    task.assignmentId,
  ]);
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "task-comment");
  if (receipt.kind !== "task-comment") return;
  assert.equal(receipt.key, command.key);
  assert.deepEqual(
    receipt.deliveries.map((d) => [d.assignmentId, d.effect]).sort(),
    [
      [delegate.assignmentId, "resume"],
      [task.assignmentId, "input"],
    ].sort(),
  );
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(
    commandReceiptSchema.safeParse({ ...receipt, actor: "agent" }).success,
    false,
  );

  const after = await api.readTask(task.taskId);
  const shared = after.data.messages.filter((m) => m.sharedCommentId);
  assert.equal(shared.length, 2);
  assert.ok(shared.every((m) => m.sharedCommentId === receipt.commentId));
  assert.equal(
    byId.get(delegate.assignmentId)?.version,
    version(f, delegate.assignmentId) - 1,
  );
});

test("a send's authority comes from selected assignments, not from names in the text", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, api } = await pausedTask(f, "Inert mention");
  const events = () =>
    f.service.coordinationView().readTask(task.taskId).messages.length;
  const before = events();
  const receipt = await api.execute(
    send(f, task.taskId, "@lead @Task lead please act now", []),
  );
  assert.equal(receipt.kind, "task-comment");
  assert.equal(events(), before, "mentions in text wake nobody");
  // The wire contract has no alias, profile or actor field to carry one.
  for (const spoof of [
    { recipients: [{ name: "lead" }] },
    { recipients: [{ assignmentId: task.assignmentId }] },
    { actor: "agent" },
    { recipients: [], effect: "resume" },
  ])
    assert.equal(
      operatorCommandSchema.safeParse({
        ...send(f, task.taskId, "x", []),
        ...spoof,
      }).success,
      false,
    );
});

test("refusals are definitive and record nothing", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, delegate, api } = await pausedTask(f, "Comment refusals");
  const other = await seedReviewTask(f, "Other task");
  const snapshot = async () => {
    const read = await api.readTask(task.taskId);
    const timeline = await api.readTaskTimeline(
      task.taskId,
      new URLSearchParams(),
    );
    return JSON.stringify([
      read.data.messages,
      timeline.data.entries.length,
      read.data.assignments.map((a) => [a.version, a.state]),
    ]);
  };
  const refuse = async (
    name: string,
    command: ReturnType<typeof send>,
    expected: number,
  ) => {
    const before = await snapshot();
    await assert.rejects(
      api.execute(command),
      (error) => status(error) === expected,
      name,
    );
    assert.equal(await snapshot(), before, name);
  };
  await refuse(
    "stale version",
    {
      ...send(f, task.taskId, "x", [task.assignmentId, delegate.assignmentId]),
      recipients: [
        {
          assignmentId: task.assignmentId,
          expectedAssignmentVersion: version(f, task.assignmentId),
        },
        {
          assignmentId: delegate.assignmentId,
          expectedAssignmentVersion: version(f, delegate.assignmentId) + 1,
        },
      ],
    },
    409,
  );
  await refuse(
    "another task's assignment",
    send(f, task.taskId, "x", [task.assignmentId, other.assignmentId]),
    403,
  );
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
      .run(delegate.assignmentId),
  );
  await refuse(
    "held delegate",
    send(f, task.taskId, "x", [task.assignmentId, delegate.assignmentId]),
    409,
  );
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='completed' WHERE id=?")
      .run(delegate.assignmentId),
  );
  await assert.rejects(
    api.execute({
      ...send(f, task.taskId, "x", [task.assignmentId]),
      recipients: [
        { assignmentId: task.assignmentId, expectedAssignmentVersion: 1 },
        { assignmentId: task.assignmentId, expectedAssignmentVersion: 1 },
      ],
    }),
    (error) => error instanceof Error && "issues" in error,
  );
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_tasks SET state='done' WHERE id=?")
      .run(task.taskId),
  );
  await assert.rejects(
    api.execute(send(f, task.taskId, "Too late", [])),
    (error) => status(error) === 409,
  );
});

test("a lost response is recovered from the receipt without a second delivery", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, delegate, api } = await pausedTask(
    f,
    "Comment unknown outcome",
  );
  // The scheduler wake-up after commit is the one step that can fail after the record is durable.
  const service = f.service as unknown as { wakeScheduler: () => unknown };
  const wake = service.wakeScheduler;
  let notifications = 0;
  service.wakeScheduler = async () => {
    notifications++;
    throw new DomainOperationError("lost");
  };
  const command = send(f, task.taskId, "Anyone there?", [
    task.assignmentId,
    delegate.assignmentId,
  ]);
  const key = command.key;
  const query = operations(task.taskId, key);
  // Before the send, the read observes nothing.
  assert.deepEqual((await api.readOperation(query)).data, {
    state: "not-recorded",
  });
  await assert.rejects(
    api.execute(command),
    (error) =>
      status(error) === 503 &&
      (error as { code?: string }).code === "command-outcome-unknown",
  );
  assert.equal(notifications, 1);
  const read = (await api.readOperation(query)).data;
  assert.equal(read.state, "recorded");
  // Replaying the identical command returns that receipt and writes nothing new.
  service.wakeScheduler = wake;
  const replay = await api.execute(command);
  assert.equal(
    JSON.stringify(replay),
    JSON.stringify(read.state === "recorded" ? read.receipt : null),
  );
  const shared = (await api.readTask(task.taskId)).data.messages.filter(
    (m) => m.sharedCommentId,
  );
  assert.equal(shared.length, 2);
  // Other types, tasks, scopes and keys never settle it.
  await assert.rejects(
    api.readOperation(operations(task.taskId, randomUUID())).then((r) => {
      assert.equal(r.data.state, "not-recorded");
      throw new Error("not-recorded");
    }),
    /not-recorded/,
  );
  const other = await seedReviewTask(f, "Other");
  await assert.rejects(
    api.readOperation(operations(other.taskId, key)),
    (error) => status(error) === 409,
  );
  await assert.rejects(
    api.readOperation(
      new URLSearchParams({
        scope: `project:${task.projectId}`,
        type: "task.comment.send",
        key,
      }),
    ),
    (error) => status(error) === 400,
  );
});

test("the timeline shows each comment once, at the task root, across pages and with no lead", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, delegate, api } = await pausedTask(f, "Comment timeline");
  const bodies = ["first", "second", "third"];
  for (const body of bodies)
    await api.execute(
      send(f, task.taskId, `Comment ${body}`, [
        task.assignmentId,
        ...(body === "second" ? [delegate.assignmentId] : []),
      ]),
    );
  // A legacy direct message stays its own entry.
  await api.execute({
    type: "message",
    key: randomUUID(),
    taskId: task.taskId,
    recipientAssignmentId: task.assignmentId,
    expectedAssignmentVersion: version(f, task.assignmentId),
    message: "Direct message",
  });
  const pages: ReturnType<typeof taskTimelineSchema.parse>["data"]["entries"] =
    [];
  let before: string | null = null;
  for (let i = 0; i < 20; i++) {
    const query = new URLSearchParams({ limit: "2" });
    if (before) query.set("before", before);
    const page = await api.readTaskTimeline(task.taskId, query);
    pages.unshift(...page.data.entries);
    before = page.data.olderCursor;
    if (!before) break;
  }
  const comments = pages.filter((e) => e.kind === "task-comment");
  assert.deepEqual(
    comments.map((e) => e.kind === "task-comment" && e.text),
    bodies.map((b) => `Comment ${b}`),
  );
  assert.ok(comments.every((e) => e.assignmentId === null));
  const second = comments[1];
  assert.equal(second?.kind === "task-comment" && second.deliveries.length, 2);
  const messages = pages.filter((e) => e.kind === "message");
  assert.deepEqual(
    messages.map((e) => e.kind === "message" && e.text),
    ["Direct message"],
    "recipient deliveries are not separate posts",
  );
  assert.equal(new Set(pages.map((e) => e.entryId)).size, pages.length);
  // With no lead binding, the comment is still task scoped.
  f.seedPersistedState((db) =>
    db
      .prepare("DELETE FROM task_lead_bindings WHERE taskId=?")
      .run(task.taskId),
  );
  const noLead = await api.readTaskTimeline(
    task.taskId,
    new URLSearchParams({ limit: "100" }),
  );
  assert.equal(
    noLead.data.entries.filter((e) => e.kind === "task-comment").length,
    3,
  );
});

test("comments queued behind a running turn start nothing until it settles, then arrive once together", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, api } = await completedLead(f, "Comment overlap");
  // The first comment resumes the completed lead; its resumed turn then holds.
  const resumed = await api.execute(
    send(f, task.taskId, "Resume with this.", [task.assignmentId]),
  );
  assert.equal(
    resumed.kind === "task-comment" && resumed.deliveries[0]?.effect,
    "resume",
  );
  await until(() => f.runtime.hasPending(2), "resumed turn");
  const turns = f.runtime.turns;
  // While that turn runs, further comments are input for the next one.
  const second = await api.execute(
    send(f, task.taskId, "SECOND_COMMENT", [task.assignmentId]),
  );
  const third = await api.execute(
    send(f, task.taskId, "THIRD_COMMENT", [task.assignmentId]),
  );
  for (const r of [second, third])
    assert.equal(r.kind === "task-comment" && r.deliveries[0]?.effect, "input");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.runtime.turns, turns, "no overlapping turn starts");
  f.runtime.complete(2);
  await until(() => f.runtime.hasPending(3), "next admitted turn");
  const prompt = f.runtime.prompts[2] ?? "";
  assert.equal(prompt.match(/SECOND_COMMENT/g)?.length, 1);
  assert.equal(prompt.match(/THIRD_COMMENT/g)?.length, 1);
  assert.equal(f.runtime.turns, turns + 1);
});

test("pause and Stop hold a queued comment without losing it", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const { task, api } = await completedLead(f, "Comment admission");
  configure(f, task.projectId, true);
  const receipt = await api.execute(
    send(f, task.taskId, "PAUSED_COMMENT", [task.assignmentId]),
  );
  assert.equal(
    receipt.kind === "task-comment" && receipt.deliveries[0]?.effect,
    "resume",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(f.runtime.turns, 1, "a paused project starts no turn");
  const read = await api.readTask(task.taskId);
  assert.equal(
    read.data.messages.filter((m) => m.sharedCommentId)[0]?.text,
    "PAUSED_COMMENT",
  );
  configure(f, task.projectId, false);
  await until(() => f.runtime.hasPending(2), "admitted after unpause");
  assert.match(f.runtime.prompts[1] ?? "", /PAUSED_COMMENT/);
});
