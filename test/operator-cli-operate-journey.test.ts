import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { completedLead } from "./fixtures/completed-lead.js";
import { databaseDigest } from "./fixtures/database-digest.js";
import { startCliOperator } from "./fixtures/operator-cli.js";
import { mixedAnswers } from "./fixtures/question-data.js";
import { seedOwnApproval, seedOwnQuestion } from "./fixtures/questions.js";

// biome-ignore lint/suspicious/noExplicitAny: session projections are asserted structurally
type Json = Record<string, any>;

test("an operator journey through the CLI reads back through the UI projections", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, d, file } = o;
  const session = async (path: string) =>
    ((await (await s.sessionGet(path)).json()) as Json).data;
  const outcome = file("outcome.md", "Journey outcome");

  // Create a blocked task, then add and remove a dependency and make it ready.
  let r = await cli("rw", [
    "task",
    "create",
    "--project",
    s.projectId,
    "--title",
    "Journey",
    "--outcome-file",
    outcome,
    "--ready",
    "false",
    "--blocker",
    s.taskId,
  ]);
  assert.equal(r.code, 0, r.out);
  const taskId = r.json().data.taskId;
  let task = await session(`/api/operator/tasks/${taskId}`);
  assert.deepEqual(
    task.localDependencies.map((x: Json) => x.id),
    [s.taskId],
  );
  r = await cli("rw", [
    "task",
    "remove-dependency",
    taskId,
    "--blocker",
    s.taskId,
    "--expected-version",
    String(task.task.version),
  ]);
  assert.equal(r.code, 0, r.out);
  task = await session(`/api/operator/tasks/${taskId}`);
  assert.deepEqual(task.localDependencies, []);
  r = await cli("rw", [
    "task",
    "add-dependency",
    taskId,
    "--blocker",
    s.taskId,
    "--expected-version",
    String(task.task.version),
  ]);
  assert.equal(r.code, 0, r.out);
  task = await session(`/api/operator/tasks/${taskId}`);
  r = await cli("rw", [
    "task",
    "configure",
    taskId,
    "--expected-version",
    String(task.task.version),
    "--ready",
    "true",
  ]);
  assert.equal(r.code, 0, r.out);
  const list = await session(
    `/api/operator/task-list?projectId=${s.projectId}`,
  );
  assert.equal(list.tasks.find((x: Json) => x.id === taskId)?.ready, true);

  // Follow up a completed lead, then message the resumed lead.
  const { task: led } = await completedLead(s.f, "Journey lead");
  const msg = file("m.md", "Also cover the edge case.");
  r = await cli("rw", [
    "task",
    "follow-up",
    led.taskId,
    "--expected-version",
    String(Number(d.assignment(led.assignmentId).version)),
    "--message-file",
    msg,
  ]);
  assert.equal(r.code, 0, r.out);
  task = await session(`/api/operator/tasks/${led.taskId}`);
  assert.ok(
    task.messages.some(
      (m: Json) =>
        m.eventId === r.json().data.receipt.eventId &&
        m.recipientAssignmentId === led.assignmentId,
    ),
  );
  await s.f.service.stopTask(led.taskId);

  // Answer a form question; approve one request and deny another.
  const q = await seedOwnQuestion(s.f);
  r = await cli("rw", [
    "question",
    "answer",
    q.taskId,
    q.interactionId,
    "--expected-revision",
    "1",
    "--answers-file",
    file("a.json", JSON.stringify(mixedAnswers)),
  ]);
  assert.equal(r.code, 0, r.out);
  const inbox = await session("/api/operator/inbox");
  assert.ok(
    !inbox.items.some((i: Json) => i.interactionId === q.interactionId),
  );
  for (const decision of ["approved", "denied"]) {
    const ap = await seedOwnApproval(
      s.f,
      `Approve ${decision}`,
      `${decision} project`,
    );
    const read = (
      await cli("ro", ["approval", "get", ap.taskId, ap.interactionId])
    ).json().data.approval;
    r = await cli("rw", [
      "approval",
      "decide",
      ap.taskId,
      ap.interactionId,
      "--decision",
      decision,
      "--expected-revision",
      String(read.revision),
      "--material-hash",
      read.materialHash,
    ]);
    assert.equal(r.code, 0, r.out);
    task = await session(`/api/operator/tasks/${ap.taskId}`);
    assert.equal(
      task.approvals.find((a: Json) => a.interactionId === ap.interactionId)
        ?.status,
      decision,
    );
  }

  // Stop and Resume.
  r = await cli("rw", ["task", "stop", taskId]);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    (await session(`/api/operator/tasks/${taskId}`)).execution.holds.stop,
    true,
  );
  r = await cli("rw", ["task", "resume", taskId]);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    (await session(`/api/operator/tasks/${taskId}`)).execution.holds.stop,
    false,
  );
});

test("read-only bearer tokens are refused for every CLI5 and CLI6 command type with no change", async (t) => {
  const o = await startCliOperator(t);
  const { s } = o;
  const read = await s.issue("read", "journey-ro");
  const id = randomUUID();
  const before = databaseDigest(s.f);
  for (const body of [
    {
      type: "task.create",
      projectId: s.projectId,
      taskId: id,
      title: "x",
      outcome: "y",
      ready: false,
    },
    {
      type: "task.configure",
      projectId: s.projectId,
      taskId: s.taskId,
      expectedVersion: 1,
      ready: true,
    },
    {
      type: "dependency.add",
      projectId: s.projectId,
      taskId: s.taskId,
      blockerTaskId: id,
      expectedVersion: 1,
    },
    {
      type: "dependency.remove",
      projectId: s.projectId,
      taskId: s.taskId,
      blockerTaskId: id,
      expectedVersion: 1,
    },
    {
      type: "message",
      taskId: s.taskId,
      recipientAssignmentId: id,
      expectedAssignmentVersion: 1,
      message: "m",
    },
    {
      type: "question.answer",
      taskId: s.taskId,
      interactionId: id,
      expectedRevision: 1,
      answer: "a",
    },
    {
      type: "question.form.answer",
      taskId: s.taskId,
      interactionId: id,
      expectedRevision: 1,
      answers: {},
    },
    {
      type: "question.native.answer",
      taskId: s.taskId,
      interactionId: id,
      expectedRevision: 1,
      answers: {},
    },
    {
      type: "approval.decide",
      taskId: s.taskId,
      interactionId: id,
      expectedRevision: 1,
      decision: "denied",
      action: "a",
    },
    { type: "task.stop", taskId: s.taskId },
    { type: "task.resume", taskId: s.taskId },
    // CLI6 recovery types are refused by scope before any validation.
    { type: "recovery.pre-turn.adopt", assignmentId: id },
    { type: "recovery.pre-turn.recover", assignmentId: id },
    { type: "recovery.no-turn.adopt", assignmentId: id },
    { type: "recovery.no-turn.recover", assignmentId: id },
    {
      type: "recovery.conversation.replace",
      assignmentId: id,
      expectedAssignmentVersion: 1,
      expectedConversationRevision: 1,
    },
  ]) {
    const r = await s.bearer(read.token, "/api/operator/commands", {
      method: "POST",
      body: { ...body, key: randomUUID() },
    });
    assert.equal(r.status, 403, body.type);
    assert.equal(((await r.json()) as Json).error.code, "insufficient-scope");
  }
  assert.equal(databaseDigest(s.f), before);
});

test("replays survive a restart, keys stay scoped and the CLI and session API agree", async (t) => {
  const o = await startCliOperator(t);
  const { cli, s, file, lostReply } = o;
  // The service is reopened below, so always read through the current domain.
  const d = () => s.f.service.domain();
  const outcome = file("o.md", "Replay");
  const create = [
    "task",
    "create",
    "--project",
    s.projectId,
    "--title",
    "Replayed",
    "--outcome-file",
    outcome,
    "--ready",
    "false",
  ];
  const count = () => d().tasks(s.projectId).length;
  const before = count();
  let r = await cli("rw", create, { fetch: lostReply });
  assert.equal(r.code, 6);
  r = await cli("rw", ["task", "stop", s.taskId], { fetch: lostReply });
  assert.equal(r.code, 6);
  await s.restart();
  r = await cli("rw", create);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(count(), before + 1);
  r = await cli("rw", ["task", "stop", s.taskId]);
  assert.equal(r.json().data.reusedRequest, true);
  assert.equal(r.json().data.stopInEffect, true);
  let receipts = 0;
  s.f.seedPersistedState((db) => {
    receipts = Number(
      (
        db.prepare("SELECT count(*) AS n FROM task_control_receipts").get() as {
          n: number;
        }
      ).n,
    );
  });
  assert.equal(receipts, 1, "the replayed Stop recorded once");

  // The same key with other content conflicts; the same UUID for another task is independent.
  const key = randomUUID();
  r = await cli("rw", ["task", "resume", s.taskId, "--request-id", key]);
  assert.equal(r.code, 0, r.out);
  r = await cli("rw", [
    "task",
    "resume",
    s.taskId,
    "--request-id",
    key,
    "--expected-version",
    "1",
  ]);
  assert.equal(r.code, 4, r.out);
  assert.equal(r.json().error.code, "conflict");
  r = await cli("rw", create.concat(["--request-id", key]));
  assert.equal(r.code, 0, "the UUID is scoped to its project and command");
  r = await cli("rw", [
    "task",
    "stop",
    r.json().data.taskId,
    "--request-id",
    key,
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json().data.receipt.kind, "task-stop");

  // Stale version and already-answered: same status class through the CLI and session.
  const version = Number(d().task(s.taskId).version);
  r = await cli("rw", [
    "task",
    "configure",
    s.taskId,
    "--expected-version",
    String(version + 1),
    "--ready",
    "true",
  ]);
  assert.equal(r.code, 4);
  const staleSession = await s.sessionPost("/api/operator/commands", {
    type: "task.configure",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: s.taskId,
    expectedVersion: version + 1,
    ready: true,
  });
  assert.equal(staleSession.status, 409);
  const q = await seedOwnQuestion(s.f);
  const answers = file("a.json", JSON.stringify(mixedAnswers));
  const answer = () =>
    cli("rw", [
      "question",
      "answer",
      q.taskId,
      q.interactionId,
      "--expected-revision",
      "1",
      "--answers-file",
      answers,
    ]);
  assert.equal((await answer()).code, 0);
  assert.equal((await answer()).code, 4);
  const answered = await s.sessionPost("/api/operator/commands", {
    type: "question.form.answer",
    key: randomUUID(),
    taskId: q.taskId,
    interactionId: q.interactionId,
    expectedRevision: 1,
    answers: mixedAnswers,
  });
  assert.equal(answered.status, 409);
});
