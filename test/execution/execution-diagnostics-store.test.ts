import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { test } from "node:test";
import type { Database } from "../../src/core/store.js";
import {
  boundDetail,
  DiagnosticCursorError,
  ExecutionDiagnosticsStore,
  diagnosticLimitsFromEnv,
  type DiagnosticLimits,
} from "../../src/standalone/execution-diagnostics.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { tmpdir } from "../fixtures/temp.js";

const day = 24 * 60 * 60 * 1000;
const identity = (workId: string) => ({
  workId,
  taskId: "t1",
  projectId: "p1",
  assignmentId: "a1",
  assignmentVersion: 1,
  instructionsRevision: 1,
  profileRevision: 1,
  conversationRevision: 1,
  harness: "codex",
  mode: "enhanced" as const,
  eventSource: "supported" as const,
});

function fixture(limits: Partial<DiagnosticLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "diag-"));
  const file = join(dir, "db.sqlite");
  let db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const clock = { t: 1_000_000 };
  // The store sees a swappable target so tests can close or demote the connection.
  const target = { db: db as Database };
  const proxy: Database = {
    exec: (sql) => target.db.exec(sql),
    prepare: (sql) => target.db.prepare(sql),
  };
  const store = new ExecutionDiagnosticsStore(proxy, {
    limits,
    now: () => clock.t,
  });
  store.begin(identity("w1"));
  return {
    dir,
    file,
    clock,
    target,
    store,
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      target.db = db;
      return new ExecutionDiagnosticsStore(db, {
        limits,
        now: () => clock.t,
      });
    },
    cleanup() {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const rec = (
  f: ReturnType<typeof fixture>,
  payload: unknown,
  kind: "input" | "tool" | "runtime" = "tool",
  exclusions: readonly string[] | undefined = [],
) => f.store.record("w1", kind, "n", "info", undefined, payload, exclusions);
const rows = (f: ReturnType<typeof fixture>) =>
  f.db.prepare("SELECT * FROM diagnostic_items ORDER BY sequence").all() as {
    sequence: number;
    state: string;
    reason: string | null;
    payload: string | null;
    payloadBytes: number;
    originalBytes: number;
  }[];
const gap = (f: ReturnType<typeof fixture>, code: string) =>
  f.db
    .prepare("SELECT * FROM diagnostic_gaps WHERE workId='w1' AND code=?")
    .get(code) as
    | { count: number; bytes: number; maxPrunedSequence: number }
    | undefined;
const counters = (f: ReturnType<typeof fixture>) => {
  const sum = (
    f.db
      .prepare("SELECT COALESCE(SUM(payloadBytes),0) s FROM diagnostic_items")
      .get() as { s: number }
  ).s;
  assert.equal(f.store.health().totalBytes, sum);
  assert.equal(
    (
      f.db
        .prepare(
          "SELECT payloadBytes p FROM diagnostic_executions WHERE workId='w1'",
        )
        .get() as { p: number }
    ).p,
    sum,
  );
};

test("item, command and leaf bounds", () => {
  const f = fixture();
  try {
    // JSON overhead of a two-string array is 7 bytes.
    rec(f, ["a".repeat(32765), "b".repeat(32764)]);
    rec(f, ["a".repeat(32765), "b".repeat(32765)]);
    const [exact, over] = rows(f);
    assert.equal(exact?.state, "available");
    assert.equal(exact?.payloadBytes, 65536);
    assert.equal(over?.state, "omitted");
    assert.equal(over?.reason, "size-limit");
    assert.equal(over?.originalBytes, 65537);
    assert.equal(over?.payload, null);

    rec(f, { command: "x".repeat(4096), other: "y".repeat(49152) });
    rec(f, { command: "x".repeat(4097), other: "y".repeat(49153) });
    const [, , ok, marked] = rows(f);
    assert.match(ok!.payload!, /"x{4096}"/);
    assert.deepEqual(JSON.parse(marked!.payload!), {
      command: { omitted: "size-limit", bytes: 4097 },
      other: { omitted: "size-limit", bytes: 49153 },
    });
    counters(f);
  } finally {
    f.cleanup();
  }
});

test("execution byte and row limits coalesce into one gap row", () => {
  const bytes = fixture({ executionBytes: 4096 });
  try {
    for (let i = 0; i < 5; i += 1) rec(bytes, "z".repeat(1500));
    assert.equal(rows(bytes).length, 2);
    assert.equal(gap(bytes, "execution-limit")?.count, 3);
    counters(bytes);
  } finally {
    bytes.cleanup();
  }
  const items = fixture({ executionItems: 3 });
  try {
    for (let i = 0; i < 5; i += 1) rec(items, "z");
    assert.equal(rows(items).length, 3);
    assert.equal(gap(items, "item-limit")?.count, 2);
  } finally {
    items.cleanup();
  }
});

test("redacts string leaves before persistence", () => {
  const f = fixture();
  const secrets = ["sk-secret-value", "/ctl/path", "line one\nline two"];
  try {
    rec(
      f,
      {
        a: "has sk-secret-value",
        nested: [{ b: "at /ctl/path" }, ["prefix line one\nline two suffix"]],
        c: "token=abc123",
        d: "Authorization: Bearer abc.def",
      },
      "runtime",
      secrets,
    );
    f.store.record(
      "w1",
      "runtime",
      "n",
      "info",
      undefined,
      { a: "anything" },
      undefined,
    );
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const [first, second] = rows(f);
    assert.equal(first?.state, "available");
    assert.match(first!.payload!, /\[redacted\]/);
    assert.equal(second?.state, "omitted");
    assert.equal(second?.reason, "redaction-unavailable");
    assert.equal(second?.payload, null);
    for (const file of [f.file, `${f.file}-wal`]) {
      let bytes = "";
      try {
        bytes = readFileSync(file, "latin1");
      } catch {
        continue;
      }
      for (const s of [...secrets, "token=abc123", "abc.def"])
        assert.equal(bytes.includes(s), false, `${file} contains ${s}`);
    }
  } finally {
    f.cleanup();
  }
});

test("age and quota retention keep metadata and leave other tables alone", async () => {
  const f = fixture({ ageMs: 30 * day });
  try {
    f.db.exec(
      "CREATE TABLE domain_things(id INTEGER, v TEXT); INSERT INTO domain_things VALUES (1,'x')",
    );
    const digest = () =>
      databaseDigest({ seedPersistedState: (seed) => seed(f.db) }, (name) =>
        name.startsWith("diagnostic_"),
      );
    const before = digest();
    const now = 40 * day;
    for (const age of [30.01, 29.99, 0]) {
      f.clock.t = now - age * day;
      rec(f, "p");
    }
    f.clock.t = now;
    await f.store.prune();
    assert.deepEqual(
      rows(f).map((r) => r.sequence),
      [2, 3],
    );
    assert.equal(f.store.execution("w1")?.workId, "w1");
    const expired = gap(f, "expired");
    assert.equal(expired?.count, 1);
    assert.equal(expired?.bytes, 3);
    assert.equal(expired?.maxPrunedSequence, 1);
    await f.store.prune();
    assert.equal(gap(f, "expired")?.count, 1);
    counters(f);
    assert.equal(digest(), before);
  } finally {
    f.cleanup();
  }

  const q = fixture({ installationBytes: 10 * 1024 });
  try {
    for (let i = 0; i < 4; i += 1) rec(q, "q".repeat(3070)); // 3072 bytes each
    assert.deepEqual(
      rows(q).map((r) => r.sequence),
      [2, 3, 4],
    );
    assert.equal(gap(q, "evicted")?.count, 1);
    counters(q);
    // Below a pruned sequence the gap is reported; above it, not.
    assert.equal(q.store.events("w1", { after: 0 }).gaps.length, 1);
    assert.equal(q.store.events("w1", { after: 1 }).gaps.length, 0);
    await q.store.prune();
    assert.equal(rows(q).length, 3);
  } finally {
    q.cleanup();
  }
});

test("expiry selects through the createdAt index", async (t) => {
  const f = fixture({ ageMs: 30 * day });
  try {
    const now = 40 * day;
    for (const age of [31, 29]) {
      f.clock.t = now - age * day;
      rec(f, "p");
    }
    f.clock.t = now;
    const captured: Array<{ sql: string; args: unknown[] }> = [];
    const all = StatementSync.prototype.all;
    t.mock.method(
      StatementSync.prototype,
      "all",
      function (
        this: StatementSync,
        ...args: Parameters<StatementSync["all"]>
      ) {
        if (/FROM diagnostic_items WHERE createdAt < \?/.test(this.sourceSQL))
          captured.push({ sql: this.sourceSQL, args: args as unknown[] });
        return all.apply(this, args);
      },
    );
    await f.store.prune();
    t.mock.restoreAll();
    assert.ok(captured[0]);
    const plan = f.db
      .prepare(`EXPLAIN QUERY PLAN ${captured[0].sql}`)
      .all(...(captured[0].args as never[]))
      .map((row) => String((row as { detail: string }).detail))
      .join("\n");
    assert.match(plan, /INDEX diagnostic_items_created/);
    assert.doesNotMatch(plan, /SCAN diagnostic_items|TEMP B-TREE/);
  } finally {
    f.cleanup();
  }
});

test("failures never throw, count once and recover", async () => {
  const f = fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON diagnostic_items BEGIN SELECT RAISE(ABORT,'boom'); END",
    );
    rec(f, "p");
    assert.equal(f.store.health().unrecorded, 1);
    assert.equal(gap(f, "capture-failed")?.count, 1);
    f.db.exec("DROP TRIGGER boom");
    rec(f, "p");
    assert.equal(rows(f).length, 1);

    const ro = new DatabaseSync(f.file, { readOnly: true });
    f.target.db = ro;
    rec(f, "p");
    f.store.gap("w1", "late-event");
    await f.store.prune();
    assert.equal(f.store.health().unrecorded, 4);
    ro.close();
    f.target.db = f.db;
    rec(f, "p");
    assert.equal(rows(f).length, 2);

    f.db.close();
    const unrecorded = f.store.health().unrecorded;
    f.store.begin(identity("w2"));
    f.store.bindThread("w1", "th");
    f.store.bindTurn("w1", "tu");
    rec(f, "p");
    f.store.finish("w1");
    f.store.closeOpen();
    f.store.reconcile();
    await f.store.prune();
    assert.equal(f.store.health().unrecorded, unrecorded + 8);
    assert.equal(f.store.health().totalBytes, undefined);
  } finally {
    f.cleanup();
  }
});

test("event pages, cursors, restart and interruption", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 205; i += 1) rec(f, i, i % 2 ? "tool" : "runtime");
    const first = f.store.events("w1");
    assert.equal(first.items.length, 200);
    assert.equal(first.more, true);
    const rest = f.store.events("w1", { after: first.nextAfter ?? 0 });
    assert.equal(rest.items.length, 5);
    assert.equal(rest.more, false);
    assert.equal(f.store.events("w1", { kind: "tool" }).items.length, 102);
    assert.throws(
      () => f.store.events("w1", { after: 206 }),
      DiagnosticCursorError,
    );
    assert.equal(f.store.events("w1", { after: 205 }).items.length, 0);

    const big = fixture();
    try {
      for (let i = 0; i < 20; i += 1)
        rec(big, ["a".repeat(30000), "b".repeat(30000)]);
      const page = big.store.events("w1");
      assert.ok(page.items.length >= 1 && page.items.length <= 17);
      assert.equal(page.more, true);
    } finally {
      big.cleanup();
    }

    f.store.bindThread("w1", "th");
    f.store.bindTurn("w1", "tu");
    f.store.record("w1", "input", "prompt", "info", "i1", "hello", []);
    const reopened = f.reopen();
    assert.equal(reopened.execution("w1")?.threadId, "th");
    assert.equal(reopened.execution("w1")?.turnId, "tu");
    assert.equal(reopened.inputs("w1").length, 1);
    assert.equal(reopened.events("w1").items.length, 200);
    counters(f);
    reopened.closeOpen();
    const ex = reopened.execution("w1");
    assert.ok(ex?.finishedAt);
    assert.equal(
      ex?.gaps.find((g) => g.code === "capture-interrupted")?.count,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test("limits from the environment", () => {
  const d = diagnosticLimitsFromEnv({});
  assert.equal(d.ageMs, 30 * day);
  assert.equal(d.installationBytes, 1024 ** 3);
  const o = diagnosticLimitsFromEnv({
    CAB_DIAGNOSTIC_RETENTION_DAYS: "7",
    CAB_DIAGNOSTIC_STORAGE_MIB: "16",
  });
  assert.equal(o.ageMs, 7 * day);
  assert.equal(o.installationBytes, 16 * 1024 * 1024);
  for (const env of [
    { CAB_DIAGNOSTIC_RETENTION_DAYS: "0" },
    { CAB_DIAGNOSTIC_RETENTION_DAYS: "NaN" },
    { CAB_DIAGNOSTIC_RETENTION_DAYS: "366" },
    { CAB_DIAGNOSTIC_STORAGE_MIB: "15" },
    { CAB_DIAGNOSTIC_STORAGE_MIB: "1048577" },
  ])
    assert.throws(() => diagnosticLimitsFromEnv(env));
});

test("an excluded value holding a pattern or another excluded value is still redacted whole", () => {
  const instruction =
    "Internal plan X. Staging token: lives-in-vault SECRET_VALUE end";
  assert.deepEqual(
    boundDetail({ echo: `before ${instruction} after` }, [
      instruction,
      "SECRET_VALUE",
    ]),
    JSON.parse(JSON.stringify({ echo: "before [redacted] after" })),
  );
});

test("large excluded texts with patterns do not exhaust the redaction limits", () => {
  const large = (n: number) =>
    `${"Instruction body. ".repeat(3300)}token=abc /data/dir ${n}`;
  const exclusions = [large(1), large(2), "/data/dir"];
  assert.equal(boundDetail("hello", exclusions), "hello");
  assert.equal(
    boundDetail(`x ${large(1)} y`, exclusions, 64 * 1024),
    "x [redacted] y",
  );
});
