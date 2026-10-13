import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CachedDatabase } from "../src/core/database-cache.js";
import type { Database } from "../src/core/store.js";

function counted(database: Database) {
  const prepares = new Map<string, number>();
  const adapter: Database = {
    get isTransaction() {
      return database.isTransaction ?? false;
    },
    exec(sql) {
      return database.exec(sql);
    },
    prepare(sql) {
      prepares.set(sql, (prepares.get(sql) ?? 0) + 1);
      return database.prepare(sql);
    },
  };
  return { database: adapter, prepares };
}

function field(row: unknown, key: string): unknown {
  return (row as Record<string, unknown> | undefined)?.[key];
}

function retainedCount(database: CachedDatabase): number {
  return (database as unknown as { statements: Map<string, unknown> })
    .statements.size;
}

test("reuses exact parameterized SQL while returning current database rows", () => {
  const raw = new DatabaseSync(":memory:");
  const counts = counted(raw);
  const database = new CachedDatabase(counts.database);
  const select = "SELECT value FROM entries WHERE id = ?";
  try {
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
    database
      .prepare("INSERT INTO entries (id, value) VALUES (?, ?)")
      .run(1, "one");
    database
      .prepare("INSERT INTO entries (id, value) VALUES (?, ?)")
      .run(2, "two");

    const statement = database.prepare(select);
    assert.equal(field(statement.get(1), "value"), "one");
    assert.equal(field(database.prepare(select).get(2), "value"), "two");
    assert.equal(counts.prepares.get(select), 1);

    database
      .prepare("UPDATE entries SET value = ? WHERE id = ?")
      .run("updated", 1);
    assert.equal(field(database.prepare(select).get(1), "value"), "updated");
    assert.equal(counts.prepares.get(select), 1);
  } finally {
    database.close();
    raw.close();
  }
});

test("rollback invalidates statements and reads the restored committed value", () => {
  const raw = new DatabaseSync(":memory:");
  const counts = counted(raw);
  const database = new CachedDatabase(counts.database);
  const select = "SELECT value FROM entries WHERE id = ?";
  try {
    database.exec(
      "CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO entries VALUES (1, 'committed')",
    );
    assert.equal(field(database.prepare(select).get(1), "value"), "committed");
    assert.equal(counts.prepares.get(select), 1);

    database.exec("BEGIN IMMEDIATE");
    assert.equal(database.isTransaction, true);
    database
      .prepare("UPDATE entries SET value = ? WHERE id = ?")
      .run("temporary", 1);
    assert.equal(field(database.prepare(select).get(1), "value"), "temporary");
    assert.equal(counts.prepares.get(select), 1);
    database.exec("SELECT 1; ROLLBACK");
    assert.equal(database.isTransaction, false);
    assert.equal(field(database.prepare(select).get(1), "value"), "committed");
    assert.equal(counts.prepares.get(select), 2);

    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("UPDATE entries SET value = ? WHERE id = ?")
      .run("committed-again", 1);
    assert.equal(
      field(database.prepare(select).get(1), "value"),
      "committed-again",
    );
    database.exec("COMMIT");
    assert.equal(
      field(database.prepare(select).get(1), "value"),
      "committed-again",
    );
    assert.equal(counts.prepares.get(select), 2);
  } finally {
    database.close();
    raw.close();
  }
});

test("exec and prepared DDL invalidate retained statements", () => {
  const raw = new DatabaseSync(":memory:");
  const counts = counted(raw);
  const database = new CachedDatabase(counts.database);
  const select = "SELECT * FROM entries";
  try {
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)");
    database
      .prepare("INSERT INTO entries (id, value) VALUES (?, ?)")
      .run(1, "v");
    assert.equal(field(database.prepare(select).get(), "value"), "v");
    assert.equal(counts.prepares.get(select), 1);

    database.exec("ALTER TABLE entries ADD COLUMN note TEXT DEFAULT 'new'");
    assert.equal(field(database.prepare(select).get(), "note"), "new");
    assert.equal(counts.prepares.get(select), 2);

    database.prepare("CREATE TABLE extra (value TEXT)").run();
    assert.equal(field(database.prepare(select).get(), "note"), "new");
    assert.equal(counts.prepares.get(select), 3);

    database.exec("PRAGMA user_version");
    assert.equal(field(database.prepare(select).get(), "note"), "new");
    assert.equal(counts.prepares.get(select), 3);
    database.exec("PRAGMA user_version = 42");
    assert.equal(field(database.prepare(select).get(), "note"), "new");
    assert.equal(counts.prepares.get(select), 4);
  } finally {
    database.close();
    raw.close();
  }
});

test("capacity two follows LRU recency and recompiles an evicted statement", () => {
  const raw = new DatabaseSync(":memory:");
  const counts = counted(raw);
  const database = new CachedDatabase(counts.database, { capacity: 2 });
  const a = "SELECT 1 AS value";
  const b = "SELECT 2 AS value";
  const c = "SELECT 3 AS value";
  try {
    database.prepare(a).get();
    database.prepare(b).get();
    database.prepare(a).get();
    assert.equal(retainedCount(database), 2);
    database.prepare(c).get();
    assert.equal(retainedCount(database), 2);
    database.prepare(b).get();
    assert.equal(retainedCount(database), 2);
    assert.equal(counts.prepares.get(a), 1);
    assert.equal(counts.prepares.get(b), 2);
    assert.equal(counts.prepares.get(c), 1);
  } finally {
    database.close();
    raw.close();
  }
});

test("identical SQL in separate databases has independent statements and data", () => {
  const firstRaw = new DatabaseSync(":memory:");
  const secondRaw = new DatabaseSync(":memory:");
  const firstCount = counted(firstRaw);
  const secondCount = counted(secondRaw);
  const first = new CachedDatabase(firstCount.database);
  const second = new CachedDatabase(secondCount.database);
  const select = "SELECT value FROM marker";
  try {
    first.exec(
      "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('first')",
    );
    second.exec(
      "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('second')",
    );
    assert.equal(field(first.prepare(select).get(), "value"), "first");
    assert.equal(field(second.prepare(select).get(), "value"), "second");
    assert.equal(field(first.prepare(select).get(), "value"), "first");
    assert.equal(firstCount.prepares.get(select), 1);
    assert.equal(secondCount.prepares.get(select), 1);
  } finally {
    first.close();
    second.close();
    firstRaw.close();
    secondRaw.close();
  }
});

test("failed close invalidates wrappers and a later close retries the same handle", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-database-cache-"));
  const filename = join(directory, "cache.db");
  const raw = new DatabaseSync(filename);
  const counts = counted(raw);
  const events: string[] = [];
  let attempts = 0;
  let retained: ReturnType<Database["prepare"]> | undefined;
  const database = new CachedDatabase(counts.database, {
    close: () => {
      attempts += 1;
      assert.equal(retainedCount(database), 0);
      events.push(`invalidated-${attempts}`);
      if (retained !== undefined)
        assert.throws(() => retained!.get(), /closed/i);
      assert.throws(() => database.prepare("SELECT 1"), /closed/i);
      events.push(`raw-close-${attempts}`);
      if (attempts === 1) throw new Error("injected close failure");
      raw.close();
    },
  });

  try {
    database.exec("CREATE TABLE marker (value TEXT)");
    database.prepare("INSERT INTO marker VALUES (?)").run("persisted");
    retained = database.prepare("SELECT value FROM marker");
    assert.equal(field(retained.get(), "value"), "persisted");

    assert.throws(() => database.close(), /injected close failure/);
    assert.throws(() => retained!.get(), /closed/i);
    assert.throws(() => database.prepare("SELECT 1"), /closed/i);
    database.close();
    assert.deepEqual(events, [
      "invalidated-1",
      "raw-close-1",
      "invalidated-2",
      "raw-close-2",
    ]);
    assert.equal(attempts, 2);

    const reopenedRaw = new DatabaseSync(filename);
    const reopened = new CachedDatabase(reopenedRaw);
    try {
      assert.equal(
        field(reopened.prepare("SELECT value FROM marker").get(), "value"),
        "persisted",
      );
      assert.equal(
        field(
          reopened.prepare("PRAGMA integrity_check").get(),
          "integrity_check",
        ),
        "ok",
      );
    } finally {
      reopened.close();
      reopenedRaw.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the existing minimal Database contract and bind values remain supported", () => {
  const seen: unknown[][] = [];
  const fake: Database = {
    exec() {
      return "exec-result";
    },
    prepare() {
      return {
        run(...parameters) {
          seen.push(parameters);
          return "run-result";
        },
        get(...parameters) {
          seen.push(parameters);
          return { value: parameters[0] };
        },
        all(...parameters) {
          seen.push(parameters);
          return [{ value: parameters[0] }];
        },
      };
    },
  };
  const database = new CachedDatabase(fake);
  try {
    assert.equal("isTransaction" in database, false);
    const statement = database.prepare("SELECT ?, ?, ?, ?");
    const bytes = new Uint8Array([1, 2]);
    assert.equal(statement.run("text", 7, bytes, null), "run-result");
    assert.deepEqual(statement.get("get"), { value: "get" });
    assert.deepEqual(statement.all("all"), [{ value: "all" }]);
    assert.equal(database.exec("SELECT 1"), "exec-result");
    assert.deepEqual(seen, [["text", 7, bytes, null], ["get"], ["all"]]);
  } finally {
    database.close();
  }
});
