import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../src/core/coordination.js";
import { DomainStore } from "../src/core/domain.js";
import {
  SchedulerStore,
  type TurnRequest,
} from "../src/standalone/scheduler.js";
import { ExecutionState } from "../src/standalone/state.js";
import {
  createOperatorFixture,
  seedOperatorRecovery,
} from "./fixtures/operator-web.js";
import { seedCatalog } from "./fixtures/operator-work.js";
import { seedOrphanHistory } from "./fixtures/read-guards.js";

test("targeted history reads return the full-history rows in the same order", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seedCatalog(f);
  const d = f.service.domain();
  const lead = (taskId: string) => {
    const a = d.assignments(taskId)[0];
    assert.ok(a);
    return String(a.id);
  };
  const recoveryTask = ids.running.id,
    recoveryAssignment = lead(recoveryTask);
  seedOrphanHistory(f, 30);
  seedOperatorRecovery(
    f,
    {
      taskId: recoveryTask,
      assignmentId: recoveryAssignment,
      projectId: ids.projectId,
    },
    5,
  );
  // An unbound identity between bound ones, a version-2 binding, and a completed
  // version-2 request sequenced after the assignment's active request.
  const unbound = `unbound-${randomUUID()}`,
    versionTwo = `version-two-${randomUUID()}`,
    question = ids.question.request;
  f.seedPersistedState((db) => {
    for (const workId of [unbound, versionTwo]) {
      db.prepare(
        "INSERT INTO execution_intents (id,workId,prompt,workspace,state,accountType,sandbox,approval) VALUES (?,?,'P','/w','held','chatgpt','workspaceWrite','never')",
      ).run(randomUUID(), workId);
      db.prepare(
        "INSERT INTO execution_recovery_identities (workId,workRevision,requestSequence) VALUES (?,1,7)",
      ).run(workId);
    }
    db.prepare(
      "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,2,1,1,1)",
    ).run(versionTwo, question.taskId, question.assignmentId);
    db.prepare(
      "INSERT INTO turn_requests (requestKey,workId,kind,taskId,projectId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,prompt,state) VALUES (?,?,'assignment',?,?,?,2,1,1,'P','completed')",
    ).run(
      randomUUID(),
      versionTwo,
      question.taskId,
      ids.projectId,
      question.assignmentId,
    );
    const batch = db.prepare(
      "INSERT INTO coordination_delivery_batches (batchId,deliveryWorkId,taskId,recipientAssignmentId,assignmentVersion,highWaterSequence,state,createdAt) VALUES (?,?,?,?,1,1,'queued',100)",
    );
    for (const [batchId, taskId] of [
      ["batch-c", ids.running.id],
      ["batch-a", ids.running.id],
      ["batch-b", ids.normal.id],
    ] as const)
      batch.run(batchId, `delivery-${batchId}`, taskId, randomUUID());
  });
  seedOrphanHistory(f, 30);

  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const state = new ExecutionState(db),
    scheduler = new SchedulerStore(db),
    coordination = new CoordinationStore(db, new DomainStore(db));
  const view = state.recoveryView(),
    requests = scheduler.list(),
    intents = state.list();
  assert.ok(view.some((r) => r.workId === unbound && !r.binding));
  assert.ok(
    view.findIndex((r) => r.workId === unbound) > 0 &&
      view.findIndex((r) => r.workId === unbound) < view.length - 1,
  );
  const tasks = [
    ...new Set([...d.taskCatalog().map((x) => x.id), randomUUID()]),
  ];
  const assignments = tasks.flatMap((taskId) =>
    d
      .assignments(taskId)
      .map((a) => ({ id: String(a.id), version: Number(a.version) })),
  );
  assert.ok(assignments.length > 5);

  for (const a of assignments)
    for (const v of [1, 2, 99, Number.NaN, a.version]) {
      const expected = view.filter(
        (r) =>
          r.binding?.assignmentId === a.id && r.binding.assignmentVersion === v,
      );
      assert.deepEqual(state.recoveryFor(a.id, v), expected);
      for (const r of expected)
        assert.deepEqual(state.recoveryFor(a.id, v, r.workId), [r]);
      assert.deepEqual(state.recoveryFor(a.id, v, unbound), []);
    }
  assert.deepEqual(
    state.recoveryFor(question.assignmentId as string, 2).map((r) => r.workId),
    [versionTwo],
  );

  for (const taskId of tasks) {
    assert.deepEqual(
      state.recoveryForTask(taskId),
      view.filter((r) => r.binding?.taskId === taskId),
    );
    assert.deepEqual(
      state.recoveryForTask(taskId, unbound),
      view.filter((r) => r.binding?.taskId === taskId || r.workId === unbound),
    );
    assert.deepEqual(
      scheduler.forTask(taskId),
      requests.filter((r) => r.taskId === taskId),
    );
    assert.deepEqual(
      coordination.queuedDeliveriesForTask(taskId),
      coordination.queuedDeliveries().filter((x) => x.taskId === taskId),
    );
    const legacy = intents.flatMap((intent) => {
      const binding = state.taskBinding(intent.workId);
      return binding?.taskId === taskId ? [{ intent, binding }] : [];
    });
    const byWork = (
      x: { intent: { workId: string } },
      y: { intent: { workId: string } },
    ) => x.intent.workId.localeCompare(y.intent.workId);
    assert.deepEqual(
      state.taskExecutions(taskId).sort(byWork),
      legacy.sort(byWork),
    );
  }
  assert.deepEqual(
    coordination.queuedDeliveriesForTask(ids.running.id).map((x) => x.batchId),
    ["batch-a", "batch-c"],
  );
  assert.equal(state.recoveryForTask(recoveryTask).length >= 5, true);

  const newest = (candidates: TurnRequest[]) =>
    candidates.reduce<TurnRequest | undefined>(
      (latest, c) => (!latest || c.sequence > latest.sequence ? c : latest),
      undefined,
    );
  for (const a of assignments)
    for (const v of [a.version, 1, 2, Number.NaN]) {
      const own = requests.filter((r) => r.assignmentId === a.id);
      assert.deepEqual(
        scheduler.current(a.id, v),
        newest(own.filter((r) => r.state === "active")) ??
          newest(own.filter((r) => r.assignmentVersion === v)),
      );
    }
  // The active request wins over the later completed version-2 request.
  assert.equal(
    scheduler.current(question.assignmentId as string, 2)?.workId,
    question.workId,
  );
  for (const intent of intents)
    assert.deepEqual(state.byWorkId(intent.workId), intent);
  assert.equal(state.byWorkId(randomUUID()), undefined);

  for (const n of [1, 5, view.length, view.length + 1])
    assert.equal(state.recoveryCountUpTo(n), Math.min(n, view.length));
  for (const n of [1, 5, requests.length, requests.length + 1])
    assert.equal(scheduler.countUpTo(n), Math.min(n, requests.length));
  // The service wrappers route to the same reads.
  assert.deepEqual(
    f.service.recoveryForTask(recoveryTask),
    state.recoveryForTask(recoveryTask),
  );
  assert.deepEqual(
    f.service.turnRequestsForTask(recoveryTask),
    scheduler.forTask(recoveryTask),
  );
  assert.deepEqual(
    f.service.executionForWork(question.workId),
    state.byWorkId(question.workId),
  );
  assert.deepEqual(
    f.service.currentTurnRequest(question.assignmentId as string, 1),
    scheduler.current(question.assignmentId as string, 1),
  );
  assert.deepEqual(
    f.service.recoveryFor(recoveryAssignment, 1),
    state.recoveryFor(recoveryAssignment, 1),
  );
});

test("retainedRowsExceed is the global 128-row bound of either history kind", async (t) => {
  for (const kinds of [
    { requests: true, recovery: false },
    { requests: false, recovery: true },
  ]) {
    const f = await createOperatorFixture();
    t.after(() => f.close());
    seedOrphanHistory(f, 128, kinds);
    assert.equal(
      Math.max(
        f.service.turnRequests().length,
        f.service.recoveryView().length,
      ),
      128,
    );
    assert.equal(f.service.retainedRowsExceed(128), false);
    seedOrphanHistory(f, 1, kinds);
    assert.equal(f.service.retainedRowsExceed(128), true);
  }
});

test("targeted-read indexes exist on new and reopened databases", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const names = [
    "task_execution_bindings_task",
    "task_execution_bindings_assignment",
    "turn_requests_taskId_sequence",
    "turn_requests_assignmentId_sequence",
  ];
  const present = () => {
    const found: string[] = [];
    f.seedPersistedState((db) => {
      for (const table of ["task_execution_bindings", "turn_requests"])
        for (const row of db.prepare(`PRAGMA index_list(${table})`).all())
          found.push(String((row as { name: string }).name));
    });
    return names.filter((n) => found.includes(n));
  };
  assert.deepEqual(present(), names);
  f.seedPersistedState((db) => {
    for (const name of names) db.exec(`DROP INDEX ${name}`);
  });
  assert.deepEqual(present(), []);
  await f.reopen();
  assert.deepEqual(present(), names);
});
