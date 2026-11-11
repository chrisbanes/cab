import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { db } from "../fixtures/refused-turn.js";
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

/** A delegate of the lead whose interrupted turn was recovered with no successor. */
async function recoveredDelegate(w: Awaited<ReturnType<typeof boundWorld>>) {
  const service = w.s.f.service;
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
  await recoverHeldTurn(w, delegateId);
  return delegateId;
}

test("an operator Stop alone does not keep a recovered delegate from being withdrawn", async (t) => {
  const w = await boundWorld(t);
  const service = w.s.f.service;
  const delegateId = await recoveredDelegate(w);
  await service.stopTask(w.g.taskId);
  assert.ok(
    db(service)
      .prepare(
        "SELECT 1 FROM task_writer_holds WHERE taskId = ? AND holdKind = 'operator-stop'",
      )
      .get(w.g.taskId),
    "the task is stopped",
  );
  const api = new OperatorApi(service);
  const read = await api.readAssignment(delegateId);
  assert.equal(
    read.data.withdrawal?.available,
    true,
    JSON.stringify(read.data.withdrawal),
  );
  await api.execute({
    type: "assignment.withdraw",
    key: randomUUID(),
    taskId: w.g.taskId,
    assignmentId: delegateId,
    expectedVersion: read.data.version,
    reason: "Recovered while the task was stopped",
  });
  assert.equal(service.domain().assignment(delegateId).state, "withdrawn");
});

test("a writer ambiguity hold still keeps a recovered delegate from being withdrawn", async (t) => {
  const w = await boundWorld(t);
  const service = w.s.f.service;
  const delegateId = await recoveredDelegate(w);
  w.s.f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Writer identity is ambiguous')",
      )
      .run(w.g.taskId),
  );
  const read = await new OperatorApi(service).readAssignment(delegateId);
  assert.equal(read.data.withdrawal?.available, false);
  assert.ok(
    startedOf(service)
      .coordination.delegateStatus(delegateId)
      .blockers.includes("ownership-hold"),
  );
});

test("another turn a Stop interrupted only holds a recovered delegate's withdrawal while its outcome is unknown", async (t) => {
  const w = await boundWorld(t);
  const service = w.s.f.service;
  const delegateId = await recoveredDelegate(w);
  await service.stopTask(w.g.taskId);
  // The Stop interrupted the lead's turn: its target records how that turn ended.
  const target = (terminalState: "failed" | "unknown") =>
    w.s.f.seedPersistedState((db) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO execution_stop_targets
          (taskId, workId, interruptState, terminalState, requestedAt, origin)
          VALUES (?, ?, 'acknowledged', ?, 1, 'operator')`,
        )
        .run(w.g.taskId, w.g.workId, terminalState),
    );
  const blockers = () =>
    startedOf(service).coordination.delegateStatus(delegateId).blockers;
  const strict = () =>
    startedOf(service).state.reconciledAssignmentProof(
      String(
        service
          .turnRequests()
          .find((r) => r.assignmentId === delegateId && r.state === "held")
          ?.workId,
      ),
    );
  target("unknown");
  assert.ok(blockers().includes("held-execution"), String(blockers()));
  target("failed");
  assert.deepEqual(blockers(), []);
  // Recovery callers keep the strict proof while the task is stopped.
  assert.equal(strict(), undefined);
});
