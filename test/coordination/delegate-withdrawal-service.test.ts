import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { startedOf } from "../fixtures/service-internals.js";
import { command, db, refusedInitial } from "../fixtures/refused-turn.js";

type Fixture = Awaited<ReturnType<typeof refusedInitial>>;

/** A delegate of the task's lead, created as `cab_delegate` creates one. */
function delegate(f: Fixture) {
  const assignmentId = randomUUID();
  command(f.service, {
    type: "assignment.create",
    actor: "agent",
    projectId: f.projectId,
    taskId: f.taskId,
    assignmentId,
    profileId: f.profileId,
    brief: "Delegated work",
    resultDestination: "requester",
    requesterAssignmentId: f.assignmentId,
  });
  return assignmentId;
}

const withdraw = (
  f: Fixture,
  assignmentId: string,
  expectedVersion = Number(f.service.domain().assignment(assignmentId).version),
  key = randomUUID(),
) => ({
  type: "assignment.withdraw" as const,
  key,
  taskId: f.taskId,
  assignmentId,
  expectedVersion,
  reason: "Superseded by a replacement delegate",
});

const conflict = (message?: RegExp) => (error: unknown) =>
  error instanceof OperatorApiError &&
  error.status === 409 &&
  (message === undefined || message.test(error.publicMessage ?? ""));

/** The task changed under the delegate's queued request, which is refused before it starts. */
function refuseQueuedTurn(f: Fixture, assignmentId: string) {
  command(f.service, {
    type: "task.configure",
    projectId: f.projectId,
    taskId: f.taskId,
    expectedVersion: Number(f.service.domain().task(f.taskId).version),
    title: `CHANGED_${assignmentId}`,
  });
  assert.equal(
    startedOf(f.service).state.refuseUncapturedRevision(
      `assignment:${assignmentId}:initial`,
    ),
    true,
    "the stale request is refused before it starts",
  );
}

test("the operator withdraws an idle delegate; the lead is told and reads show the record", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    const delegateId = delegate(f);
    refuseQueuedTurn(f, delegateId);
    const before = await api.readAssignment(delegateId);
    assert.deepEqual(before.data.withdrawal, {
      record: null,
      available: true,
    });
    const lead = (await api.readAssignment(f.assignmentId)).data.withdrawal;
    assert.equal(lead?.available, false);
    assert.equal(lead?.refusal?.code, "lead-assignment");

    await assert.rejects(
      api.execute(withdraw(f, delegateId, before.data.version + 1)),
      conflict(/changed since it was read/),
    );
    const command = withdraw(f, delegateId);
    const receipt = await api.execute(command);
    assert.ok(receipt.kind === "assignment-withdraw");
    assert.equal(receipt.assignmentId, delegateId);
    assert.equal(receipt.leadAssignmentId, f.assignmentId);
    assert.deepEqual(await api.execute(command), receipt);

    const after = await api.readAssignment(delegateId);
    assert.equal(after.data.state, "withdrawn");
    assert.equal(after.data.version, before.data.version + 1);
    assert.deepEqual(after.data.withdrawal?.record, {
      actor: "operator",
      leadAssignmentId: f.assignmentId,
      priorState: "pending",
      reason: "Superseded by a replacement delegate",
      withdrawnAt: receipt.withdrawnAt,
    });
    assert.equal(after.data.withdrawal?.available, false);
    const task = (await api.readTask(f.taskId)).data;
    assert.equal(
      task.assignments.find((a) => a.assignmentId === delegateId)?.state,
      "withdrawn",
    );
    assert.deepEqual(
      (await api.readAssignmentHistory(delegateId)).data.withdrawal,
      after.data.withdrawal?.record,
    );
    const events = db(f.service)
      .prepare(
        "SELECT eventType, payload FROM coordination_inbox_events WHERE recipientAssignmentId = ? AND eventType = 'delegate-withdrawn'",
      )
      .all(f.assignmentId) as Array<{ payload: string }>;
    assert.equal(events.length, 1);
    assert.equal(
      JSON.parse(String(events[0]?.payload)).assignmentId,
      delegateId,
    );

    // Nothing restores it, and messages to it are refused.
    await assert.rejects(
      api.execute(withdraw(f, delegateId)),
      conflict(/already completed or was withdrawn/),
    );
    await assert.rejects(
      api.execute({
        type: "message",
        key: randomUUID(),
        taskId: f.taskId,
        recipientAssignmentId: delegateId,
        expectedAssignmentVersion: after.data.version,
        message: "Still there?",
      }),
      (error: unknown) => error instanceof OperatorApiError,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a delegate whose request was refused before it started can be withdrawn; a live one cannot", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    const live = delegate(f);
    const refused = await api.readAssignment(live);
    assert.equal(refused.data.withdrawal?.available, false);
    assert.equal(refused.data.withdrawal?.refusal?.code, "live-execution");
    await assert.rejects(
      api.execute(withdraw(f, live)),
      conflict(/still running/),
    );
    assert.equal(f.service.domain().assignment(live).state, "pending");

    refuseQueuedTurn(f, live);
    const available = await api.readAssignment(live);
    assert.equal(available.data.withdrawal?.available, true);
    // Delegated with cab_delegate, so the conversation timeline shows it.
    db(f.service)
      .prepare(
        "INSERT INTO coordination_delegations (assignmentId, delegatedAt) VALUES (?, ?)",
      )
      .run(live, Date.now());
    const receipt = await api.execute(withdraw(f, live));
    assert.equal(receipt.kind, "assignment-withdraw");
    // Its refused request is history: Start again never targets it.
    const after = (await api.readTask(f.taskId)).data;
    assert.notEqual(
      after.startAgain && "assignmentId" in after.startAgain
        ? after.startAgain.assignmentId
        : undefined,
      live,
    );
    const timeline = await api.readTaskTimeline(
      f.taskId,
      new URLSearchParams(),
    );
    assert.ok(
      JSON.stringify(timeline.data).includes('"withdrawn"'),
      "the timeline shows the withdrawn delegation",
    );
    assert.throws(
      () =>
        command(f.service, {
          type: "assignment.apply",
          projectId: f.projectId,
          assignmentId: live,
          expectedVersion: Number(f.service.domain().assignment(live).version),
        }),
      /withdrawn assignment takes no further turns/,
    );
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
