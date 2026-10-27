import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainStore } from "../../src/core/domain.js";
import {
  SchedulerStore,
  type TurnRequest,
} from "../../src/standalone/scheduler.js";
import { ExecutionState } from "../../src/standalone/state.js";
import {
  createOperatorFixture,
  seedOperatorRecovery,
} from "../fixtures/operator-web.js";
import { seedCatalog } from "../fixtures/operator-work.js";
import { seedOrphanHistory } from "../fixtures/read-guards.js";

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

  for (const taskId of tasks) {
    const ownRecovery = view.filter((r) => r.binding?.taskId === taskId).length,
      ownRequests = requests.filter((r) => r.taskId === taskId).length;
    for (const n of [1, 5, ownRecovery, ownRecovery + 1])
      assert.equal(
        state.recoveryCountForTaskUpTo(taskId, n),
        Math.min(n, ownRecovery),
      );
    for (const n of [1, 5, ownRequests, ownRequests + 1])
      assert.equal(
        scheduler.countForTaskUpTo(taskId, n),
        Math.min(n, ownRequests),
      );
  }
  assert.ok(
    tasks.some(
      (taskId) =>
        view.some((r) => r.binding?.taskId === taskId) &&
        requests.some((r) => r.taskId === taskId),
    ),
  );
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

test("taskRetainedRowsExceed is the task's own 128-row bound, per kind", async (t) => {
  for (const kinds of [
    { requests: true, recovery: false },
    { requests: false, recovery: true },
  ]) {
    const f = await createOperatorFixture();
    t.after(() => f.close());
    const ids = await seedCatalog(f);
    const taskId = ids.normal.id,
      assignment = f.service.domain().assignments(taskId)[0];
    assert.ok(assignment);
    const owner = {
      taskId,
      projectId: ids.projectId,
      assignmentId: String(assignment.id),
    };
    const own = () =>
      kinds.requests
        ? f.service.turnRequestsForTask(taskId).length
        : f.service.recoveryForTask(taskId).length;
    // Rows of other tasks never count, however many.
    seedOrphanHistory(f, 129, kinds);
    assert.equal(f.service.taskRetainedRowsExceed(taskId, 128), false);
    seedOrphanHistory(f, 128 - own(), kinds, owner);
    assert.equal(own(), 128);
    assert.equal(f.service.taskRetainedRowsExceed(taskId, 128), false);
    seedOrphanHistory(f, 1, kinds, owner);
    assert.equal(own(), 129);
    assert.equal(f.service.taskRetainedRowsExceed(taskId, 128), true);
    // The other task is unaffected by this one's excess.
    assert.equal(f.service.taskRetainedRowsExceed(ids.running.id, 128), false);
  }
});

test("per-task retained-row counts are indexed and capped", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const sql = new Map<string, unknown[]>();
  const get = StatementSync.prototype.get;
  t.mock.method(
    StatementSync.prototype,
    "get",
    function (this: StatementSync, ...args: Parameters<StatementSync["get"]>) {
      if (/COUNT\(\*\)/.test(this.sourceSQL))
        sql.set(this.sourceSQL, args as unknown[]);
      return get.apply(this, args);
    },
  );
  const taskId = randomUUID();
  f.service.taskRetainedRowsExceed(taskId, 128);
  const plans = new Map<string, string>();
  f.seedPersistedState((db) => {
    for (const [statement, args] of sql)
      plans.set(
        statement,
        db
          .prepare(`EXPLAIN QUERY PLAN ${statement}`)
          .all(...(args as never[]))
          .map((row) => String((row as { detail: string }).detail))
          .join("\n"),
      );
  });
  const text = [...plans.values()].join("\n");
  assert.match(text, /INDEX turn_requests_taskId_sequence/);
  assert.match(text, /INDEX task_execution_bindings_task/);
  assert.doesNotMatch(text, /SCAN turn_requests|SCAN task_execution_bindings/);
});

test("coordination reads by task and recipient use indexes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const ids = await seedCatalog(f);
  const taskId = ids.normal.id,
    assignment = f.service.domain().assignments(taskId)[0];
  assert.ok(assignment);
  const assignmentId = String(assignment.id);
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const coordination = new CoordinationStore(db, new DomainStore(db));
  const captured: Array<{ sql: string; args: unknown[] }> = [];
  const all = StatementSync.prototype.all;
  t.mock.method(
    StatementSync.prototype,
    "all",
    function (this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
      if (/domain_assignments|coordination_inbox_events/.test(this.sourceSQL))
        captured.push({ sql: this.sourceSQL, args: args as unknown[] });
      return all.apply(this, args);
    },
  );
  new DomainStore(db).assignments(taskId);
  coordination.inboxEvents(assignmentId);
  coordination.pendingEvents(assignmentId);
  t.mock.restoreAll();
  assert.equal(captured.length, 3);
  // The completion-blocker pending-inbox-event check in CoordinationStore.completionBlockers
  // is private, so its statement is copied from there.
  captured.push({
    sql: `SELECT 1 AS pending FROM coordination_inbox_events event
      LEFT JOIN coordination_delivery_events delivery ON delivery.eventId = event.eventId
      WHERE event.taskId = ? AND delivery.eventId IS NULL LIMIT 1`,
    args: [taskId],
  });
  const plan = (c: { sql: string; args: unknown[] }) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${c.sql}`)
      .all(...(c.args as never[]))
      .map((row) => String((row as { detail: string }).detail))
      .join("\n");
  const plans = captured.map(plan);
  assert.match(plans[0] as string, /INDEX domain_assignments_taskId/);
  for (const recipient of [plans[1], plans[2]])
    assert.match(
      recipient as string,
      /INDEX coordination_inbox_events_recipient_sequence/,
    );
  assert.match(plans[3] as string, /INDEX coordination_inbox_events_taskId/);
  const text = plans.join("\n");
  assert.doesNotMatch(
    text,
    /SCAN domain_assignments|SCAN (coordination_inbox_events|event)\b/,
  );
  assert.doesNotMatch(
    `${plans[1]}\n${plans[2]}`,
    /USE TEMP B-TREE FOR ORDER BY/,
  );
});

test("targeted-read indexes exist on new and reopened databases", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const names = [
    "task_execution_bindings_task",
    "task_execution_bindings_assignment",
    "turn_requests_taskId_sequence",
    "turn_requests_assignmentId_sequence",
    "domain_assignments_taskId",
    "coordination_inbox_events_recipient_sequence",
    "coordination_inbox_events_taskId",
  ];
  const present = () => {
    const found: string[] = [];
    f.seedPersistedState((db) => {
      for (const table of [
        "task_execution_bindings",
        "turn_requests",
        "domain_assignments",
        "coordination_inbox_events",
      ])
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
