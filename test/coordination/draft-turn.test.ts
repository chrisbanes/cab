import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import type { RoutingChoiceClient } from "../../src/standalone/routing.js";
import { configure, until } from "../fixtures/completed-lead.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** An open Draft task with a configured lead, in an unpaused project. */
async function draftTask(f: Fixture, name: string) {
  const task = await seedReviewTask(f, name);
  configure(f, task.projectId, false);
  return { ...task, api: new OperatorApi(f.service, []) };
}

const version = (f: Fixture, taskId: string) =>
  Number(f.service.domain().task(taskId).version);

const startCommand = (
  f: Fixture,
  taskId: string,
  message = "Look into the flaky deploy check.",
) => ({
  type: "task.draft-turn" as const,
  key: randomUUID(),
  taskId,
  expectedVersion: version(f, taskId),
  message,
});

function count(f: Fixture, sql: string, ...args: string[]) {
  let value = 0;
  f.seedPersistedState((db) => {
    value = Number((db.prepare(sql).get(...args) as { n: number }).n);
  });
  return value;
}

const rows = (f: Fixture, taskId: string) => ({
  events: count(
    f,
    "SELECT COUNT(*) AS n FROM coordination_inbox_events WHERE taskId=?",
    taskId,
  ),
  draftRequests: count(
    f,
    "SELECT COUNT(*) AS n FROM turn_requests WHERE taskId=? AND draftTurn=1",
    taskId,
  ),
});

const conflict = (message?: RegExp) => (error: unknown) =>
  error instanceof OperatorApiError &&
  error.status === 409 &&
  (message === undefined || message.test(error.publicMessage ?? ""));

async function runDraftTurn(
  f: Fixture,
  task: Awaited<ReturnType<typeof draftTask>>,
) {
  const next = f.runtime.turns + 1;
  const receipt = await task.api.execute(startCommand(f, task.taskId));
  assert.equal(receipt.kind, "draft-turn");
  await until(() => f.runtime.hasPending(next), "draft turn");
  const running = f.service.list().find((work) => work.state === "running");
  assert.ok(running?.threadId && running.turnId);
  return { receipt, running };
}

const call = (
  running: { threadId: string | null; turnId: string | null },
  tool: string,
  args: Record<string, unknown>,
) => ({
  threadId: String(running.threadId),
  turnId: String(running.turnId),
  callId: randomUUID(),
  tool,
  arguments: args,
});

test("a draft turn runs read-only with network off and leaves the lead pending", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn basics");
  const domain = f.service.domain();
  // The project setting must not reach a draft turn.
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.project(task.projectId).version),
    commandNetworkAccess: true,
  });
  const before = await task.api.readTask(task.taskId);
  assert.deepEqual(before.data.draftTurn, { available: true });

  const command = startCommand(f, task.taskId);
  const receipt = await task.api.execute(command);
  assert.equal(receipt.kind, "draft-turn");
  assert.equal(
    (receipt as { leadAssignmentId: string }).leadAssignmentId,
    task.assignmentId,
  );
  await until(() => f.runtime.hasPending(1), "draft turn");
  assert.match(
    f.runtime.prompts[0] ?? "",
    /Look into the flaky deploy check\./,
  );
  assert.match(f.runtime.prompts[0] ?? "", /This is a draft turn/);
  assert.deepEqual(f.runtime.policies[0], {
    networkAccess: false,
    access: "read-only",
  });
  const running = f.service.list().find((work) => work.state === "running");
  assert.ok(running);
  assert.equal(f.service.commandNetworkAccessFor(running.workId), false);
  // Never activated: the lead stays pending and has no ordinary work.
  assert.equal(domain.assignment(task.assignmentId).state, "pending");
  assert.equal(
    count(
      f,
      "SELECT COUNT(*) AS n FROM turn_requests WHERE assignmentId=? AND draftTurn=0",
      task.assignmentId,
    ),
    0,
  );
  const active = await task.api.readTask(task.taskId);
  assert.deepEqual(active.data.draftTurn, {
    available: false,
    reason: "draft-turn-active",
  });
  assert.equal(
    active.data.messages.find(
      (message) => message.eventType === "operator-message",
    )?.text,
    command.message,
  );
  // Replay returns the receipt and runs nothing new; other content under the key conflicts.
  assert.deepEqual(await task.api.execute(command), receipt);
  await assert.rejects(
    task.api.execute({ ...command, message: "Something else" }),
    conflict(),
  );
  assert.equal(f.runtime.turns, 1);

  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  assert.equal(domain.assignment(task.assignmentId).state, "pending");
  assert.equal(
    count(
      f,
      "SELECT COUNT(*) AS n FROM execution_pending_effects WHERE workId=? AND state='pending'",
      running.workId,
    ),
    0,
  );
  assert.deepEqual((await task.api.readTask(task.taskId)).data.draftTurn, {
    available: true,
  });
  // No result is expected, so no reporting repair is queued.
  assert.equal(
    count(f, "SELECT COUNT(*) AS n FROM coordination_reporting_repairs"),
    0,
  );
  assert.equal(f.runtime.turns, 1);
});

test("a draft turn is refused with its reason and records nothing", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const domain = f.service.domain();
  const refuse = async (
    task: Awaited<ReturnType<typeof draftTask>>,
    reason: string,
    message: RegExp | undefined,
    command = startCommand(f, task.taskId),
  ) => {
    const before = rows(f, task.taskId);
    await assert.rejects(task.api.execute(command), conflict(message));
    assert.deepEqual(rows(f, task.taskId), before, reason);
    const read = await task.api.readTask(task.taskId);
    if (reason !== "stale") assert.equal(read.data.draftTurn?.reason, reason);
  };

  const done = await draftTask(f, "Done draft");
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: done.projectId,
    taskId: done.taskId,
    expectedVersion: version(f, done.taskId),
    state: "done",
  });
  await refuse(
    done,
    "task-not-open",
    /Draft turn unavailable: task is Done or Cancelled/,
  );

  const cancelled = await draftTask(f, "Cancelled draft");
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: cancelled.projectId,
    taskId: cancelled.taskId,
    expectedVersion: version(f, cancelled.taskId),
    state: "cancelled",
  });
  await refuse(cancelled, "task-not-open", /Done or Cancelled/);

  const stale = await draftTask(f, "Stale draft");
  await refuse(stale, "stale", undefined, {
    ...startCommand(f, stale.taskId),
    expectedVersion: version(f, stale.taskId) + 5,
  });

  const revoked = await draftTask(f, "Revoked draft");
  const profileId = String(domain.project(revoked.projectId).leadProfileId);
  domain.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId,
    expectedVersion: Number(domain.profile(profileId).version),
    revoked: true,
  });
  await refuse(revoked, "lead-revoked", /profile is revoked/);

  const held = await draftTask(f, "Held draft");
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
      .run(held.assignmentId),
  );
  await refuse(
    held,
    "lead-unavailable",
    /has started, is held or has completed/,
  );

  const noLead = await draftTask(f, "No lead draft");
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_projects SET leadProfileId=NULL WHERE id=?")
      .run(noLead.projectId),
  );
  await refuse(noLead, "lead-unconfigured", /no project lead/);

  // Ready tasks use the ordinary reply, and a queued draft turn blocks a second.
  const ready = await draftTask(f, "Ready draft");
  configure(f, ready.projectId, true);
  const readyVersion = version(f, ready.taskId);
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ready.projectId,
    taskId: ready.taskId,
    expectedVersion: readyVersion,
    ready: true,
  });
  await refuse(ready, "task-ready", /task is Ready/);

  const queued = await draftTask(f, "Queued draft");
  configure(f, queued.projectId, true);
  await queued.api.execute(startCommand(f, queued.taskId));
  assert.equal(rows(f, queued.taskId).draftRequests, 1);
  await refuse(queued, "draft-turn-active", /already queued, held or running/);
});

test("a stopped draft turn stays the task's draft turn, so a second one is refused rather than lost", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Held draft turn");
  await runDraftTurn(f, task);
  await task.api.execute({
    type: "task.stop",
    key: randomUUID(),
    taskId: task.taskId,
  });
  await until(
    () =>
      count(
        f,
        "SELECT COUNT(*) AS n FROM turn_requests WHERE taskId=? AND state='held'",
        task.taskId,
      ) === 1,
    "held draft turn",
  );
  const before = rows(f, task.taskId);
  assert.deepEqual((await task.api.readTask(task.taskId)).data.draftTurn, {
    available: false,
    reason: "draft-turn-active",
  });
  await assert.rejects(
    task.api.execute(startCommand(f, task.taskId, "second")),
    conflict(/already queued, held or running/),
  );
  assert.deepEqual(rows(f, task.taskId), before);
});

/** A draft turn queued behind a project pause, then the task edited, then the project resumed. */
async function refusedStaleDraft(
  f: Fixture,
  task: Awaited<ReturnType<typeof draftTask>>,
  edit: { title?: string; outcome?: string },
) {
  const domain = f.service.domain();
  configure(f, task.projectId, true);
  await task.api.execute(startCommand(f, task.taskId, "First question."));
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ...edit,
  });
  configure(f, task.projectId, false);
  await until(
    () =>
      count(
        f,
        "SELECT COUNT(*) AS n FROM turn_requests WHERE taskId=? AND draftTurn=1 AND state='held'",
        task.taskId,
      ) === 1,
    "refused draft turn",
  );
}

const pendingEventCount = (f: Fixture, assignmentId: string) =>
  count(
    f,
    `SELECT COUNT(*) AS n FROM coordination_inbox_events e
     WHERE e.recipientAssignmentId=? AND NOT EXISTS
       (SELECT 1 FROM coordination_delivery_events d WHERE d.eventId=e.eventId)`,
    assignmentId,
  );

for (const edit of [
  { title: "A different title" },
  { outcome: "A different outcome" },
] as const)
  test(`a queued draft turn is refused once the task ${Object.keys(edit)[0]} is edited and its message is released`, async (t) => {
    const f = await createOperatorFixture();
    t.after(() => f.close());
    const task = await draftTask(f, "Stale draft turn");
    await refusedStaleDraft(f, task, edit);
    assert.equal(f.runtime.turns, 0);
    assert.equal(
      count(
        f,
        "SELECT COUNT(*) AS n FROM turn_requests WHERE taskId=? AND draftTurn=1 AND reason LIKE 'Request refused: captured revisions no longer match (%task-revision-changed%'",
        task.taskId,
      ),
      1,
    );
    assert.equal(pendingEventCount(f, task.assignmentId), 1);
    assert.deepEqual((await task.api.readTask(task.taskId)).data.draftTurn, {
      available: true,
    });
    // The released message reaches the next draft turn.
    await task.api.execute(startCommand(f, task.taskId, "Second question."));
    await until(() => f.runtime.hasPending(1), "second draft turn");
    assert.match(f.runtime.prompts[0] ?? "", /First question\./);
    assert.match(f.runtime.prompts[0] ?? "", /Second question\./);
    assert.equal(f.runtime.policies[0]?.access, "read-only");
  });

test("a refused draft turn does not strand the lead when the task becomes Ready", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Refused draft then ready");
  await refusedStaleDraft(f, task, { outcome: "Edited outcome" });
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await until(() => f.runtime.hasPending(1), "initial turn");
  assert.equal(f.runtime.policies[0], undefined);
  assert.match(f.runtime.prompts[0] ?? "", /First question\./);
  assert.equal(
    f.service.domain().assignment(task.assignmentId).state,
    "running",
  );
});

test("draft turns and the first ordinary turn after them carry the current task", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Current task context");
  const domain = f.service.domain();
  await runDraftTurn(f, task);
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    title: "A reworked title",
    outcome: "A reworked outcome",
  });
  const current =
    /Current task \(revision \d+\): A reworked title\nCurrent outcome: A reworked outcome/;
  await task.api.execute(startCommand(f, task.taskId, "Continue."));
  await until(() => f.runtime.hasPending(2), "second draft turn");
  assert.match(f.runtime.prompts[1] ?? "", current);
  assert.match(
    f.runtime.prompts[0] ?? "",
    /^Profile instructions:\nPRIVATE REVIEW INSTRUCTIONS$/m,
  );
  assert.match(f.runtime.prompts[0] ?? "", /^Project instructions:/m);
  assert.doesNotMatch(f.runtime.prompts[1] ?? "", /instructions:/);
  f.runtime.complete(2);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await until(() => f.runtime.hasPending(3), "initial turn");
  assert.match(f.runtime.prompts[2] ?? "", current);
  assert.doesNotMatch(f.runtime.prompts[2] ?? "", /instructions:/);
});

test("the first ordinary turn after a draft turn carries instructions changed in between once", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Changed after the draft turn");
  const domain = f.service.domain();
  await runDraftTurn(f, task);
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.project(task.projectId).version),
    instructions: "PROJECT_INSTRUCTIONS_AFTER_DRAFT",
  });
  domain.execute({
    type: "assignment.apply",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    assignmentId: task.assignmentId,
    expectedVersion: Number(domain.assignment(task.assignmentId).version),
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await until(() => f.runtime.hasPending(2), "initial turn");
  const initial = f.runtime.prompts[1] ?? "";
  assert.match(
    initial,
    /Updated project instructions\. These replace all project instructions given earlier in this conversation:\nPROJECT_INSTRUCTIONS_AFTER_DRAFT/,
  );
  assert.doesNotMatch(initial, /profile instructions|PRIVATE REVIEW/i);
});

test("a task that never had a draft turn keeps exactly its brief", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "No draft turns");
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await until(() => f.runtime.hasPending(1), "initial turn");
  assert.doesNotMatch(f.runtime.prompts[0] ?? "", /Current task \(revision/);
});

test("a lead with queued ordinary work refuses a draft turn and leaves that work alone", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Queued ordinary work");
  const domain = f.service.domain();
  const setReady = (ready: boolean) =>
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: version(f, task.taskId),
      ready,
    });
  // The initial lead request is queued while the project is paused, then the task is Draft again.
  configure(f, task.projectId, true);
  setReady(true);
  await until(
    () =>
      count(
        f,
        "SELECT COUNT(*) AS n FROM turn_requests WHERE assignmentId=? AND draftTurn=0",
        task.assignmentId,
      ) === 1,
    "queued initial request",
  );
  setReady(false);
  const before = rows(f, task.taskId);
  await assert.rejects(
    task.api.execute(startCommand(f, task.taskId)),
    conflict(/has started, is held or has completed/),
  );
  assert.deepEqual(rows(f, task.taskId), before);
  assert.deepEqual((await task.api.readTask(task.taskId)).data.draftTurn, {
    available: false,
    reason: "lead-unavailable",
  });
  // The queued ordinary request is untouched: no draft turn touched it.
  assert.equal(
    count(
      f,
      "SELECT COUNT(*) AS n FROM turn_requests WHERE assignmentId=? AND draftTurn=0 AND state='queued'",
      task.assignmentId,
    ),
    1,
  );
});

test("a draft turn allows questions and refuses every other tool without recording anything", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn tools");
  const { running } = await runDraftTurn(f, task);
  const tables = [
    "domain_assignments",
    "coordination_results",
    "coordination_completion_requests",
    "delivery_actions",
  ];
  const snapshot = () =>
    tables.map((table) => count(f, `SELECT COUNT(*) AS n FROM ${table}`));
  const before = snapshot();
  const action = (kind: string) => ({
    operationId: randomUUID(),
    action: { kind },
  });
  const refused: Array<[string, Record<string, unknown>]> = [
    ["ensemble_delegate", { profileId: randomUUID(), brief: "Do it" }],
    [
      "ensemble_register_pr",
      {
        repositoryId: "R",
        prNumber: 1,
        expectedPrNodeId: "PR",
        expectedHeadSha: "1".repeat(40),
      },
    ],
    ["ensemble_external_action", action("pr.create")],
    ["ensemble_external_action", action("pr.merge")],
    ["ensemble_external_action", action("issue.close")],
    ["ensemble_request_completion", { reviewedResultIds: [] }],
    ["ensemble_report_result", { summary: "Done" }],
    ["ensemble_request_follow_up", { brief: "More" }],
  ];
  for (const [tool, args] of refused) {
    const result = await f.runtime.callTool(call(running, tool, args));
    assert.equal(result.success, false, tool);
    assert.match(result.text, /^Draft turn: /, tool);
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(
    f.service.domain().assignment(task.assignmentId).state,
    "pending",
  );
  // Granted GitHub kinds pass the draft-turn filter; any refusal is the action's own.
  for (const kind of ["issue.comment", "issue.labels"]) {
    const result = await f.runtime.callTool(
      call(running, "ensemble_external_action", action(kind)),
    );
    assert.doesNotMatch(result.text, /^Draft turn: /, kind);
  }
});

test("a question asked in a draft turn is answered later and the answer reaches the next draft turn only", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn questions");
  const { running } = await runDraftTurn(f, task);
  const asked = await f.runtime.callTool(
    call(running, "ensemble_ask_question", { question: "Which repository?" }),
  );
  assert.equal(asked.success, true, asked.text);
  const question = (await task.api.readTask(task.taskId)).data.questions[0];
  assert.ok(question);
  await task.api.execute({
    type: "question.answer",
    key: randomUUID(),
    taskId: task.taskId,
    interactionId: question.interactionId,
    expectedRevision: question.revision,
    answer: "The api repository.",
  });
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  // An answer starts nothing: the task is still Draft.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(f.runtime.turns, 1);
  assert.equal(rows(f, task.taskId).draftRequests, 1);

  await task.api.execute(startCommand(f, task.taskId, "Continue."));
  await until(() => f.runtime.hasPending(2), "second draft turn");
  assert.match(f.runtime.prompts[1] ?? "", /The api repository\./);
  assert.match(f.runtime.prompts[1] ?? "", /Continue\./);
  assert.equal(f.runtime.policies[1]?.access, "read-only");
});

test("pause, Stop and capacity hold a queued draft turn like any other turn", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn holds");

  configure(f, task.projectId, true);
  await task.api.execute(startCommand(f, task.taskId));
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(f.runtime.turns, 0);
  configure(f, task.projectId, false);
  await until(() => f.runtime.hasPending(1), "turn after resume");
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );

  await task.api.execute({
    type: "task.stop",
    key: randomUUID(),
    taskId: task.taskId,
  });
  await task.api.execute(startCommand(f, task.taskId, "While stopped."));
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(f.runtime.turns, 1);
  await task.api.execute({
    type: "task.resume",
    key: randomUUID(),
    taskId: task.taskId,
  });
  await until(() => f.runtime.hasPending(2), "turn after resume");
  f.runtime.complete(2);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );

  // Capacity: another task's running turn occupies the only slot.
  await f.service.configureCapacity({ key: randomUUID(), globalLimit: 1 });
  const other = await draftTask(f, "Other task");
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: other.projectId,
    taskId: other.taskId,
    expectedVersion: version(f, other.taskId),
    ready: true,
  });
  await until(() => f.runtime.hasPending(3), "other turn");
  await task.api.execute(startCommand(f, task.taskId, "Waiting for capacity."));
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.equal(f.runtime.turns, 3);
  f.runtime.complete(3);
  await until(() => f.runtime.hasPending(4), "draft turn after capacity");
  assert.equal(f.runtime.policies[3]?.access, "read-only");
});

test("making the task Ready runs the lead's initial turn in the draft conversation", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn then ready");
  const { running: draft } = await runDraftTurn(f, task);
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );

  const domain = f.service.domain();
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await until(() => f.runtime.hasPending(2), "initial turn");
  const initial = f.service
    .list()
    .find((work) => work.workId === `assignment:${task.assignmentId}:initial`);
  assert.ok(initial);
  assert.equal(initial.threadId, draft.threadId);
  assert.equal(f.runtime.policies[1], undefined);
  assert.doesNotMatch(f.runtime.prompts[1] ?? "", /This is a draft turn/);
  assert.equal(domain.assignment(task.assignmentId).state, "running");
  // Ordinary tools are available again: the refusal is no longer the draft-turn one.
  const delegated = await f.runtime.callTool(
    call(initial, "ensemble_delegate", {
      profileId: randomUUID(),
      brief: "Do it",
    }),
  );
  assert.doesNotMatch(delegated.text, /^Draft turn: /);
});

for (const phase of ["queued", "running"] as const)
  test(`making the task Ready while a draft turn is ${phase} lets it finish read-only before the initial turn`, async (t) => {
    const f = await createOperatorFixture();
    t.after(() => f.close());
    const task = await draftTask(f, `Ready while ${phase}`);
    const domain = f.service.domain();
    if (phase === "queued") configure(f, task.projectId, true);
    const started = await task.api.execute(startCommand(f, task.taskId));
    assert.equal(started.kind, "draft-turn");
    const draftWorkId = (started as { workId: string }).workId;
    if (phase === "running")
      await until(() => f.runtime.hasPending(1), "draft");
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: version(f, task.taskId),
      ready: true,
    });
    if (phase === "queued") configure(f, task.projectId, false);
    await until(() => f.runtime.hasPending(1), "draft turn");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(
      count(f, "SELECT COUNT(*) AS n FROM turn_requests WHERE state='held'"),
      0,
    );
    assert.equal(f.runtime.turns, 1);
    assert.equal(f.runtime.policies[0]?.access, "read-only");
    f.runtime.complete(1);
    await until(() => f.runtime.hasPending(2), "initial turn");
    assert.equal(f.runtime.policies[1], undefined);
    const initial = f.service
      .list()
      .find(
        (work) => work.workId === `assignment:${task.assignmentId}:initial`,
      );
    assert.equal(initial?.state, "running");
    assert.equal(domain.assignment(task.assignmentId).state, "running");
    // The initial turn is chained to the draft turn and resumes its conversation.
    assert.equal(
      f.service
        .turnRequests()
        .find((request) => request.workId === initial?.workId)?.previousWorkId,
      draftWorkId,
    );
    assert.equal(
      initial?.threadId,
      f.service.executionForWork(draftWorkId)?.threadId,
    );
    assert.ok(initial?.threadId);
  });

test("making the task Ready with routing enabled routes it without a preliminary lead turn", async (t) => {
  const previous = process.env.TEST_TYPESAFE_KEY;
  process.env.TEST_TYPESAFE_KEY = "fixture-key";
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_TYPESAFE_KEY;
    else process.env.TEST_TYPESAFE_KEY = previous;
  });
  let workerId = "";
  let routed = 0;
  const client: RoutingChoiceClient = {
    choose: async (request) => {
      routed++;
      return {
        choice: workerId,
        model: request.requestedModel,
        confidence: 0.9,
        probabilities: { [workerId]: 0.9, lead_review: 0.1 },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const f = await createOperatorFixture(client);
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn then route");
  const domain = f.service.domain();
  workerId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: workerId,
    name: "Worker",
    instructions: "Build",
    capabilities: "code",
  });
  domain.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.routing(task.projectId).version),
    enabled: true,
    guidance: "Route everything to the worker.",
    credentialRef: "env:TEST_TYPESAFE_KEY",
    candidateProfileIds: [workerId],
  });
  await runDraftTurn(f, task);
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );

  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await until(
    () =>
      domain
        .assignments(task.taskId)
        .some((assignment) => assignment.profileId === workerId),
    "routed assignment",
  );
  await until(() => f.runtime.hasPending(2), "routed turn");
  assert.equal(routed, 1);
  // The routed worker runs; the lead has had no ordinary turn.
  assert.equal(domain.assignment(task.assignmentId).state, "pending");
  assert.equal(
    count(
      f,
      "SELECT COUNT(*) AS n FROM turn_requests WHERE assignmentId=? AND draftTurn=0",
      task.assignmentId,
    ),
    0,
  );
});

/** A routing project with one worker candidate, whose routing answer waits for `release`. */
async function routedDraftTask(
  t: { after(fn: () => unknown): void },
  choose: "worker" | "lead_review" = "worker",
) {
  const previous = process.env.TEST_TYPESAFE_KEY;
  process.env.TEST_TYPESAFE_KEY = "fixture-key";
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_TYPESAFE_KEY;
    else process.env.TEST_TYPESAFE_KEY = previous;
  });
  let workerId = "";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = { routed: 0 };
  const client: RoutingChoiceClient = {
    choose: async (request) => {
      calls.routed++;
      await gate;
      return {
        choice: choose === "worker" ? workerId : "lead_review",
        model: request.requestedModel,
        confidence: 0.9,
        probabilities:
          choose === "worker"
            ? { [workerId]: 0.9, lead_review: 0.1 }
            : { [workerId]: 0.1, lead_review: 0.9 },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const f = await createOperatorFixture(client);
  t.after(() => f.close());
  const task = await draftTask(f, "Routed draft turn");
  const domain = f.service.domain();
  workerId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: workerId,
    name: "Worker",
    instructions: "Build",
    capabilities: "code",
  });
  domain.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.routing(task.projectId).version),
    enabled: true,
    guidance: "Route everything to the worker.",
    credentialRef: "env:TEST_TYPESAFE_KEY",
    candidateProfileIds: [workerId],
  });
  return { f, task, domain, calls, release, workerId };
}

test("with routing on, a draft-only lead with a pending answer waits for the routing record", async (t) => {
  const { f, task, domain, calls, release, workerId } =
    await routedDraftTask(t);
  const { running } = await runDraftTurn(f, task);
  const asked = await f.runtime.callTool(
    call(running, "ensemble_ask_question", { question: "Which repository?" }),
  );
  assert.equal(asked.success, true, asked.text);
  const question = (await task.api.readTask(task.taskId)).data.questions[0];
  assert.ok(question);
  await task.api.execute({
    type: "question.answer",
    key: randomUUID(),
    taskId: task.taskId,
    interactionId: question.interactionId,
    expectedRevision: question.revision,
    answer: "The api repository.",
  });
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  assert.equal(pendingEventCount(f, task.assignmentId), 1);

  // Paused at Ready: routing and the lead both wait.
  configure(f, task.projectId, true);
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(f.runtime.turns, 1);
  assert.equal(calls.routed, 0);

  // Resumed: routing is asked, and the lead still has no turn while it is undecided.
  configure(f, task.projectId, false);
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.equal(f.runtime.turns, 1, "no preliminary lead turn");
  await until(() => calls.routed === 1, "routing asked");
  release();
  await until(
    () =>
      domain
        .assignments(task.taskId)
        .some((assignment) => assignment.profileId === workerId),
    "routed assignment",
  );
  // The routed worker runs first; the lead has no turn until the result arrives.
  await until(() => f.runtime.hasPending(2), "worker turn");
  assert.doesNotMatch(f.runtime.prompts[1] ?? "", /The api repository\./);
  const worker = f.service.list().find((work) => work.state === "running");
  assert.ok(worker?.threadId && worker.turnId);
  const reported = await f.runtime.callTool(
    call(worker, "ensemble_report_result", {
      summary: "Worker found the cause",
    }),
  );
  assert.equal(reported.success, true, reported.text);
  f.runtime.complete(2);
  await until(() => f.runtime.hasPending(3), "lead turn");
  assert.match(f.runtime.prompts[2] ?? "", /The api repository\./);
  assert.match(f.runtime.prompts[2] ?? "", /Worker found the cause/);
});

test("with routing on and a fallback, the draft-only lead runs with its pending answer", async (t) => {
  const { f, task, domain, release } = await routedDraftTask(t, "lead_review");
  const { running } = await runDraftTurn(f, task);
  const asked = await f.runtime.callTool(
    call(running, "ensemble_ask_question", { question: "Which repository?" }),
  );
  assert.equal(asked.success, true, asked.text);
  const question = (await task.api.readTask(task.taskId)).data.questions[0];
  assert.ok(question);
  await task.api.execute({
    type: "question.answer",
    key: randomUUID(),
    taskId: task.taskId,
    interactionId: question.interactionId,
    expectedRevision: question.revision,
    answer: "The api repository.",
  });
  f.runtime.complete(1);
  await until(
    () => !f.service.list().some((work) => work.state === "running"),
    "turn end",
  );
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version(f, task.taskId),
    ready: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  assert.equal(f.runtime.turns, 1, "no preliminary lead turn");
  release();
  await until(() => f.runtime.hasPending(2), "lead turn");
  assert.match(f.runtime.prompts[1] ?? "", /The api repository\./);
  assert.match(f.runtime.prompts[1] ?? "", /routing-fallback/);
  assert.equal(f.runtime.policies[1], undefined);
});

test("a queued draft turn survives a restart and still runs read-only", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await draftTask(f, "Draft turn restart");
  configure(f, task.projectId, true);
  await task.api.execute(startCommand(f, task.taskId));
  await f.reopen();
  assert.equal(rows(f, task.taskId).draftRequests, 1);
  assert.equal(f.runtime.turns, 0);
  configure(f, task.projectId, false);
  await until(() => f.runtime.hasPending(1), "turn after restart");
  assert.deepEqual(f.runtime.policies[0], {
    networkAccess: false,
    access: "read-only",
  });
  const running = f.service.list().find((work) => work.state === "running");
  assert.ok(running);
  const refused = await f.runtime.callTool(
    call(running, "ensemble_delegate", {
      profileId: randomUUID(),
      brief: "Do it",
    }),
  );
  assert.match(refused.text, /^Draft turn: /);
});
