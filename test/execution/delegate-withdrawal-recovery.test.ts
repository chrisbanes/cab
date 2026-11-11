import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { startedOf } from "../fixtures/service-internals.js";
import { until } from "../fixtures/until.js";
import { boundWorld } from "./bound-turn-recovery-fixture.js";

/** Recovers the held bound turn of `assignmentId` through the operator's real recovery path. */
async function recoverHeldTurn(
  w: Awaited<ReturnType<typeof boundWorld>>,
  assignmentId: string,
) {
  const service = w.s.f.service;
  await until(
    () =>
      service
        .recoveryForTask(w.g.taskId)
        .some(
          (r) =>
            r.request?.assignmentId === assignmentId &&
            r.intent.state === "held" &&
            r.intent.turnId !== null,
        ),
    "bound held turn",
  );
  const record = service
    .recoveryForTask(w.g.taskId)
    .find(
      (r) =>
        r.request?.assignmentId === assignmentId &&
        r.intent.state === "held" &&
        r.intent.turnId,
    );
  assert.ok(
    record?.intent.threadId &&
      record.intent.turnId &&
      record.processIdentity &&
      record.generation.workRevision,
  );
  await service.recoverBoundTurnExecution({
    key: randomUUID(),
    assignmentId,
    receipt: {
      kind: "bound-turn",
      workId: record.workId,
      workRevision: record.generation.workRevision,
      requestSequence: record.generation.requestSequence,
      threadId: record.intent.threadId,
      turnId: record.intent.turnId,
      processIdentity: record.processIdentity,
      termination: { kind: "process-exit" },
      effects: "settled",
      workspace: "preserved",
    },
  });
  return record.workId;
}

test("a delegate whose interrupted turn was recovered with no successor, and its conversation replaced, can be withdrawn", async (t) => {
  const w = await boundWorld(t);
  const service = w.s.f.service;
  // The lead's own interrupted turn is recovered first, so no task hold remains.
  await recoverHeldTurn(w, w.g.assignmentId);
  const delegateId = randomUUID();
  w.command({
    type: "assignment.create",
    actor: "agent",
    projectId: w.g.projectId,
    taskId: w.g.taskId,
    assignmentId: delegateId,
    profileId: String(service.domain().assignment(w.g.assignmentId).profileId),
    brief: "Delegated work",
    resultDestination: "requester",
    requesterAssignmentId: w.g.assignmentId,
  });
  const workId = await recoverHeldTurn(w, delegateId);
  assert.equal(service.turnRequest(workId)?.state, "held");
  assert.equal(
    service.turnRequest(workId)?.reason,
    "Execution reconciled; no automatic successor",
  );
  service.replaceConversationCommand({
    key: randomUUID(),
    assignmentId: delegateId,
    expectedAssignmentVersion: Number(
      service.domain().assignment(delegateId).version,
    ),
    expectedConversationRevision: 1,
  });

  const api = new OperatorApi(service);
  const read = await api.readAssignment(delegateId);
  assert.deepEqual(
    read.data.withdrawal,
    { record: null, available: true },
    JSON.stringify(read.data.withdrawal),
  );
  const receipt = await api.execute({
    type: "assignment.withdraw",
    key: randomUUID(),
    taskId: w.g.taskId,
    assignmentId: delegateId,
    expectedVersion: read.data.version,
    reason: "Recovered with no successor; replaced",
  });
  assert.equal(receipt.kind, "assignment-withdraw");
  assert.equal(service.domain().assignment(delegateId).state, "withdrawn");
  // Its recovered request stays held with no continuation, yet no longer counts as
  // unfinished work for the lead's completion or Reset.
  const { state, coordination } = startedOf(service);
  assert.ok(state.unsettledTaskWorkIds(w.g.taskId).includes(workId));
  assert.equal(coordination.isHistoricalWorkResolved(workId), false);
  assert.equal(coordination.isWithdrawnWork(workId), true);
  assert.equal(coordination.isWithdrawnWork(w.g.workId), false);
});
