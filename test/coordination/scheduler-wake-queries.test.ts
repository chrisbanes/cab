import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinationStore } from "../../src/core/coordination.js";
import { DomainStore } from "../../src/core/domain.js";
import { type Database, Store } from "../../src/core/store.js";
import { RoutingAttemptStore } from "../../src/standalone/routing.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { SchedulerWakeQueries } from "../../src/standalone/scheduler-wake-queries.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { tmpdir } from "../fixtures/temp.js";

const uuid = (kind: number, n: number) =>
  `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assignmentA = uuid(1, 1);
const assignmentB = uuid(1, 2);
const project = uuid(2, 1);
const task = uuid(3, 1);

type Sql = string | number | null;

/** Real SQLite database with every owning schema migrated, as at service start. */
function open(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  new DomainStore(db).migrate();
  new SchedulerStore(db);
  new ExecutionState(db);
  new CoordinationStore(db).migrate();
  new RoutingAttemptStore(db).migrate();
  // The queries read persisted rows only; seeding raw rows needs no parents.
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function insert(db: DatabaseSync, table: string, row: Record<string, Sql>) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

const request = (
  workId: string,
  assignmentId: string | null,
  state: string,
  prompt = "prompt",
) =>
  insert(db(), "turn_requests", {
    requestKey: workId,
    workId,
    kind: "assignment",
    assignmentId,
    prompt,
    state,
  });

const completion = (
  requestId: string,
  status: string,
  createdAt: number,
  reviewedResultIds = "[]",
) =>
  insert(db(), "coordination_completion_requests", {
    requestId,
    taskId: task,
    leadAssignmentId: assignmentA,
    leadWorkId: `lead-${requestId}`,
    leadWorkRevision: 1,
    taskVersion: 1,
    reviewedResultIds,
    status,
    revision: 1,
    createdAt,
  });

const operation = (id: string, disposition: string, judgment = "{}") =>
  insert(db(), "routing_operations", {
    id,
    projectId: project,
    taskId: task,
    taskVersion: Number(id.slice(-6)),
    candidateRevisions: "{}",
    guidanceRevision: 1,
    model: "m",
    question: "q",
    judgment,
    disposition,
    resultDestination: "lead:task",
    brief: "brief",
    payloadHash: id,
  });

const fallbackEvent = (routingOperationId: string, n: number) =>
  insert(db(), "coordination_inbox_events", {
    eventId: uuid(4, n),
    taskId: task,
    recipientAssignmentId: assignmentA,
    eventType: "routing-fallback",
    routingOperationId,
    payload: "{}",
  });

const attempt = (
  operationId: string,
  status: string,
  createdAt: number,
  taskVersion = 1,
  snapshotJson = "{}",
) =>
  insert(db(), "routing_attempt_operations", {
    operationId,
    projectId: project,
    taskId: task,
    taskVersion,
    snapshotHash: operationId,
    snapshotJson,
    status,
    createdAt,
    updatedAt: createdAt,
  });

// Each test installs its own database; helpers above address the current one.
let current: DatabaseSync | undefined;
function db(): DatabaseSync {
  assert.ok(current);
  return current;
}

function withDatabase(
  name: string,
  body: (filename: string, queries: SchedulerWakeQueries) => void,
) {
  test(name, () => {
    const directory = mkdtempSync(join(tmpdir(), "cab-wake-queries-"));
    const filename = join(directory, "wake.sqlite");
    current = open(filename);
    try {
      const queries = new SchedulerWakeQueries(current);
      queries.ensureIndexes();
      body(filename, queries);
    } finally {
      current?.close();
      current = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

const op = (n: number) => uuid(5, n);

withDatabase(
  "work identity and unsettled requests read current rows",
  (_filename, queries) => {
    assert.equal(queries.hasWork("w1"), false);
    assert.equal(queries.oldestAssignmentWorkId(assignmentA), undefined);
    assert.deepEqual(queries.unsettledAssignmentWorkIds(assignmentA), []);

    request("w1", assignmentA, "completed");
    request("other", assignmentB, "queued");
    request("w2", assignmentA, "held");
    request("w3", assignmentA, "queued");
    request("w4", assignmentA, "active");
    request("w5", assignmentA, "completed");
    request("direct", null, "queued");

    assert.equal(queries.hasWork("w3"), true);
    assert.equal(queries.hasWork("w3 "), false);
    // Oldest is by sequence and includes work that has since completed.
    assert.equal(queries.oldestAssignmentWorkId(assignmentA), "w1");
    assert.equal(queries.oldestAssignmentWorkId(assignmentB), "other");
    assert.deepEqual(queries.unsettledAssignmentWorkIds(assignmentA), [
      "w2",
      "w3",
      "w4",
    ]);

    // Freshness: every read observes changes made since the previous read.
    db()
      .prepare("UPDATE turn_requests SET state = 'completed' WHERE workId = ?")
      .run("w2");
    request("w6", assignmentA, "queued");
    db().prepare("DELETE FROM turn_requests WHERE workId = ?").run("w1");
    assert.deepEqual(queries.unsettledAssignmentWorkIds(assignmentA), [
      "w3",
      "w4",
      "w6",
    ]);
    assert.equal(queries.oldestAssignmentWorkId(assignmentA), "w2");
    assert.equal(queries.hasWork("w1"), false);
    assert.equal(queries.hasWork("w6"), true);
  },
);

withDatabase(
  "pending completions keep status filter and existing order",
  (_filename, queries) => {
    assert.deepEqual(queries.pendingCompletionIdentities(), []);
    completion("c-late", "pending", 30);
    completion("c-done", "finalized", 5, "not json");
    completion("c-b", "pending", 20);
    completion("c-reject", "rejected", 1);
    // Malformed excluded-column JSON on a qualifying row is never read.
    completion("c-a", "pending", 20, "{broken");

    assert.deepEqual(
      queries.pendingCompletionIdentities().map((item) => item.requestId),
      ["c-a", "c-b", "c-late"],
    );
    assert.deepEqual(queries.pendingCompletionIdentities()[0], {
      requestId: "c-a",
      taskId: task,
      leadAssignmentId: assignmentA,
      leadWorkId: "lead-c-a",
    });

    db()
      .prepare(
        "UPDATE coordination_completion_requests SET status = 'finalized' WHERE requestId = ?",
      )
      .run("c-b");
    completion("c-new", "pending", 1);
    assert.deepEqual(
      queries.pendingCompletionIdentities().map((item) => item.requestId),
      ["c-new", "c-a", "c-late"],
    );
  },
);

withDatabase(
  "missing fallbacks use exact identity and case-sensitive prefix",
  (_filename, queries) => {
    assert.deepEqual(queries.missingRoutingFallbackOperationIds(), []);
    operation(op(1), "assigned");
    operation(op(2), "lead-review:no-candidates", "{broken");
    operation(op(3), "Lead-Review:no-candidates");
    operation(op(4), "lead-review:missing-context");
    operation(op(5), "xlead-review:no-candidates");
    operation(op(6), "lead-review:missing-credentials");
    fallbackEvent(op(4), 1);
    // An event for a similar but different identity does not count.
    fallbackEvent(`${op(6)}x`, 2);
    insert(db(), "coordination_inbox_events", {
      eventId: uuid(4, 3),
      taskId: task,
      recipientAssignmentId: assignmentA,
      eventType: "assignment-result",
      payload: "{}",
    });

    // Rowid order, regardless of identity order.
    assert.deepEqual(queries.missingRoutingFallbackOperationIds(), [
      op(2),
      op(6),
    ]);

    fallbackEvent(op(2), 4);
    operation(op(7), "lead-review:no-candidates");
    assert.deepEqual(queries.missingRoutingFallbackOperationIds(), [
      op(6),
      op(7),
    ]);
    db()
      .prepare("DELETE FROM coordination_inbox_events WHERE eventId = ?")
      .run(uuid(4, 4));
    assert.deepEqual(queries.missingRoutingFallbackOperationIds(), [
      op(2),
      op(6),
      op(7),
    ]);
  },
);

withDatabase(
  "uncommitted attempts exclude stale and committed operations",
  (_filename, queries) => {
    assert.deepEqual(queries.uncommittedRoutingAttemptIdentities(), []);
    attempt(op(1), "stale", 1, 1);
    attempt(op(2), "pending", 5, 2, "{broken");
    attempt(op(3), "routing", 5, 3);
    attempt(op(4), "assigned", 2, 4);
    attempt(op(5), "lead-review", 3, 5);
    attempt(op(6), "assigned", 4, 6);
    operation(op(6), "assigned");
    attempt(op(7), "lead-review", 4, 7);
    operation(op(7), "lead-review:no-candidates");

    assert.deepEqual(queries.uncommittedRoutingAttemptIdentities(), [
      { operationId: op(4), projectId: project, taskId: task, taskVersion: 4 },
      { operationId: op(5), projectId: project, taskId: task, taskVersion: 5 },
      { operationId: op(2), projectId: project, taskId: task, taskVersion: 2 },
      { operationId: op(3), projectId: project, taskId: task, taskVersion: 3 },
    ]);

    operation(op(4), "assigned");
    db()
      .prepare(
        "UPDATE routing_attempt_operations SET status = 'stale' WHERE operationId = ?",
      )
      .run(op(2));
    assert.deepEqual(
      queries
        .uncommittedRoutingAttemptIdentities()
        .map((item) => item.operationId),
      [op(5), op(3)],
    );
  },
);

function snapshot(db: DatabaseSync) {
  const rows = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return [
    rows("SELECT * FROM turn_requests ORDER BY sequence"),
    rows("SELECT * FROM coordination_completion_requests ORDER BY requestId"),
    rows("SELECT * FROM routing_operations ORDER BY rowid"),
    rows("SELECT * FROM coordination_inbox_events ORDER BY sequence"),
    rows("SELECT * FROM routing_attempt_operations ORDER BY operationId"),
  ];
}

withDatabase(
  "index initialization is additive, idempotent and survives reopen",
  (filename, queries) => {
    request("w1", assignmentA, "queued");
    completion("c1", "pending", 1);
    operation(op(1), "lead-review:no-candidates");
    attempt(op(2), "pending", 1);
    const rows = snapshot(db());
    const schema = () =>
      JSON.stringify(
        db()
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name",
          )
          .all(),
      );
    const before = schema();
    const userVersion = db().prepare("PRAGMA user_version").get();

    queries.ensureIndexes();
    queries.ensureIndexes();
    assert.equal(schema(), before);
    assert.deepEqual(snapshot(db()), rows);
    assert.deepEqual(db().prepare("PRAGMA user_version").get(), userVersion);

    // A database that holds history before the indexes exist gains only indexes.
    db().exec(`
    DROP INDEX scheduler_wake_pending_completions;
    DROP INDEX scheduler_wake_routing_fallbacks;
    DROP INDEX scheduler_wake_open_routing_attempts;`);
    db().close();
    current = open(filename);
    const reopened = new SchedulerWakeQueries(current);
    reopened.ensureIndexes();
    reopened.ensureIndexes();
    assert.equal(schema(), before);
    assert.deepEqual(snapshot(db()), rows);
    assert.deepEqual(reopened.unsettledAssignmentWorkIds(assignmentA), ["w1"]);
    assert.deepEqual(
      reopened.pendingCompletionIdentities().map((item) => item.requestId),
      ["c1"],
    );
    assert.deepEqual(reopened.missingRoutingFallbackOperationIds(), [op(1)]);
    assert.deepEqual(
      reopened
        .uncommittedRoutingAttemptIdentities()
        .map((item) => item.operationId),
      [op(2)],
    );
  },
);

test("index initialization requires the owning tables", () => {
  const empty = new DatabaseSync(":memory:");
  try {
    assert.throws(() => new SchedulerWakeQueries(empty).ensureIndexes());
  } finally {
    empty.close();
  }
});

/** Database wrapper that records each statement and what it returned. */
function recording(inner: DatabaseSync) {
  const calls: Array<{
    sql: string;
    parameters: unknown[];
    rows: number;
    bytes: number;
  }> = [];
  const database: Database = {
    exec: (sql) => inner.exec(sql),
    prepare: (sql) => {
      const statement = inner.prepare(sql);
      const record = (parameters: unknown[], result: unknown[]) =>
        calls.push({
          sql,
          parameters,
          rows: result.length,
          bytes: JSON.stringify(result).length,
        });
      return {
        run: (...parameters) => statement.run(...parameters),
        get: (...parameters) => {
          const row = statement.get(...parameters);
          record(parameters, row === undefined ? [] : [row]);
          return row;
        },
        all: (...parameters) => {
          const rows = statement.all(...parameters);
          record(parameters, rows);
          return rows;
        },
      };
    },
  };
  return { database, calls };
}

function exerciseAll(queries: SchedulerWakeQueries) {
  return {
    has: queries.hasWork("live-1"),
    oldest: queries.oldestAssignmentWorkId(assignmentA),
    unsettled: queries.unsettledAssignmentWorkIds(assignmentA),
    completions: queries.pendingCompletionIdentities(),
    fallbacks: queries.missingRoutingFallbackOperationIds(),
    attempts: queries.uncommittedRoutingAttemptIdentities(),
  };
}

function seedLive() {
  request("live-0", assignmentA, "completed");
  request("live-1", assignmentA, "queued");
  completion("live-c", "pending", 500_000);
  operation(op(900_001), "lead-review:no-candidates");
  attempt(op(900_002), "pending", 500_000, 900_002);
}

const forbidden = [
  "*",
  "prompt",
  "reviewedResultIds",
  "rejectionReasons",
  "judgment",
  "snapshotJson",
  "outcomeJson",
  "payload",
];

withDatabase(
  "large unrelated history is neither materialized nor parsed",
  (_filename, queries) => {
    seedLive();
    const small = recording(db());
    const expected = exerciseAll(new SchedulerWakeQueries(small.database));
    assert.equal(expected.fallbacks.length, 1);
    assert.equal(expected.attempts.length, 1);

    const bulk = "x".repeat(2048);
    db().exec("BEGIN");
    const requests = db().prepare(
      "INSERT INTO turn_requests (requestKey, workId, kind, assignmentId, prompt, state) VALUES (?, ?, 'assignment', ?, ?, ?)",
    );
    const completions = db().prepare(
      "INSERT INTO coordination_completion_requests (requestId, taskId, leadAssignmentId, leadWorkId, leadWorkRevision, taskVersion, reviewedResultIds, status, revision, createdAt) VALUES (?, ?, ?, ?, 1, 1, ?, ?, 1, ?)",
    );
    const operations = db().prepare(
      "INSERT INTO routing_operations (id, projectId, taskId, taskVersion, candidateRevisions, guidanceRevision, model, question, judgment, disposition, resultDestination, brief, payloadHash) VALUES (?, ?, ?, ?, '{}', 1, 'm', 'q', ?, ?, 'lead:task', 'b', ?)",
    );
    const events = db().prepare(
      "INSERT INTO coordination_inbox_events (eventId, taskId, recipientAssignmentId, eventType, routingOperationId, payload) VALUES (?, ?, ?, 'routing-fallback', ?, '{}')",
    );
    const attempts = db().prepare(
      "INSERT INTO routing_attempt_operations (operationId, projectId, taskId, taskVersion, snapshotHash, snapshotJson, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)",
    );
    for (let n = 1; n <= 10_000; n++) {
      requests.run(`old-${n}`, `old-${n}`, assignmentA, bulk, "completed");
      requests.run(`oth-${n}`, `oth-${n}`, assignmentB, bulk, "queued");
      completions.run(
        `old-c-${n}`,
        task,
        assignmentA,
        `old-lead-${n}`,
        `not json ${bulk}`,
        n % 2 ? "finalized" : "rejected",
        n,
      );
      const committed = op(n);
      operations.run(
        committed,
        project,
        task,
        n,
        `{broken ${bulk}`,
        n % 2 ? "assigned" : "lead-review:no-candidates",
        committed,
      );
      if (n % 2 === 0) events.run(uuid(6, n), task, assignmentA, committed);
      attempts.run(
        committed,
        project,
        task,
        n,
        committed,
        `{broken ${bulk}`,
        n % 3 ? "assigned" : "stale",
      );
    }
    db().exec("COMMIT");

    const large = recording(db());
    const actual = exerciseAll(new SchedulerWakeQueries(large.database));
    // Historical sequences differ, so compare against what the small database
    // would answer for the live rows plus the bulk rows that legitimately qualify.
    assert.equal(actual.has, true);
    assert.equal(actual.oldest, "live-0");
    assert.deepEqual(actual.unsettled, ["live-1"]);
    assert.deepEqual(actual.completions, expected.completions);
    assert.deepEqual(actual.fallbacks, expected.fallbacks);
    assert.deepEqual(actual.attempts, expected.attempts);
    assert.deepEqual(actual, { ...expected, unsettled: ["live-1"] });

    for (const [index, call] of large.calls.entries()) {
      const sql = call.sql.replace(/'[^']*'/g, "''");
      for (const column of forbidden)
        assert.ok(!sql.includes(column), `${column} selected by ${call.sql}`);
      assert.deepEqual(
        call.rows,
        small.calls[index]?.rows,
        `materialized row count changed for ${call.sql}`,
      );
      assert.ok(call.bytes < 1024, `projection too large for ${call.sql}`);
    }
    assert.equal(large.calls.length, small.calls.length);
    // Nothing was rewritten by reads alone.
    queries.ensureIndexes();
  },
);

withDatabase(
  "hot queries use identity and status indexes, not history scans",
  () => {
    seedLive();
    const { database, calls } = recording(db());
    exerciseAll(new SchedulerWakeQueries(database));
    assert.equal(calls.length, 6);
    const plans = calls.map((call) => ({
      sql: call.sql,
      details: (
        db()
          .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
          .all(...(call.parameters as Sql[])) as Array<{ detail: string }>
      ).map((row) => row.detail),
    }));
    for (const plan of plans)
      for (const detail of plan.details)
        assert.ok(
          !/^SCAN \w+$/.test(detail) && !/^SCAN \w+ AS \w+$/.test(detail),
          `unindexed scan in ${plan.sql}: ${detail}`,
        );
    const text = (n: number) => (plans[n]?.details ?? []).join("\n");
    assert.match(text(0), /SEARCH turn_requests USING .*\(workId=\?\)/);
    assert.match(
      text(1),
      /SEARCH turn_requests USING .*INDEX turn_requests_assignmentId_sequence/,
    );
    assert.match(
      text(2),
      /SEARCH turn_requests USING INDEX turn_requests_assignmentId_sequence/,
    );
    assert.match(text(3), /INDEX scheduler_wake_pending_completions/);
    assert.match(text(4), /INDEX scheduler_wake_routing_fallbacks/);
    assert.match(text(4), /coordination_one_routing_fallback/);
    assert.match(text(5), /INDEX scheduler_wake_open_routing_attempts/);
    assert.match(text(5), /SEARCH routing_operations USING .*\(id=\?\)/);
  },
);
