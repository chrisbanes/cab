import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CachedDatabase } from "../../src/core/database-cache.js";
import { transaction } from "../../src/core/store.js";
import {
  TaskChangeFeed,
  type TaskChangeEvent,
} from "../../src/standalone/task-change-feed.js";

const coalesceMs = 5;

function setup() {
  const raw = new DatabaseSync(":memory:");
  const feed = new TaskChangeFeed({
    coalesceMs,
    isTaskRecordId: (values) =>
      db
        .prepare(
          "SELECT 1 FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
        )
        .get(JSON.stringify(values)) !== undefined,
  });
  const db = new CachedDatabase(raw, { observer: feed.observer });
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE receipts (scope TEXT, key TEXT);
    CREATE TABLE bindings (workId TEXT PRIMARY KEY, taskId TEXT);
    CREATE TABLE conversation_history_items (taskId TEXT, text TEXT);
    CREATE TABLE diagnostic_items (workId TEXT, payload TEXT);
    CREATE TABLE counters (id INTEGER PRIMARY KEY, total INTEGER);
    INSERT INTO counters VALUES (1, 0);
    INSERT INTO tasks VALUES ('task-b', 'Seeded');`);
  const events = new Map<string, TaskChangeEvent[]>();
  let resolves = 0;
  const watch = (
    taskId: string,
    ids = () => [taskId] as string[] | undefined,
  ) => {
    const seen: TaskChangeEvent[] = [];
    events.set(taskId, seen);
    return feed.watch(
      () => {
        resolves += 1;
        const current = ids();
        return (
          current && {
            own: [
              ...current,
              ...db
                .prepare("SELECT workId FROM bindings WHERE taskId = ?")
                .all(taskId)
                .map((row) => String((row as { workId: unknown }).workId)),
            ],
            project: "project-1",
          }
        );
      },
      (event) => seen.push(event),
    );
  };
  return {
    db,
    feed,
    watch,
    events: (taskId: string) => events.get(taskId) ?? [],
    resolves: () => resolves,
    settle: () => delay(coalesceMs * 4),
  };
}

test("an autocommit write binding a watched id emits one read", async () => {
  const f = setup();
  f.watch("task-a");
  f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
  f.db
    .prepare("UPDATE tasks SET title = ? WHERE id = ?")
    .run("Again", "task-a");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read"]);
});

test("a rolled-back transaction emits nothing and a committed one emits once", async () => {
  const f = setup();
  f.watch("task-a");
  assert.throws(() =>
    transaction(f.db, () => {
      f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
      throw new Error("abort");
    }),
  );
  await f.settle();
  assert.deepEqual(f.events("task-a"), []);
  transaction(f.db, () => {
    f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
    f.db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("x", "task-a");
  });
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read"]);
});

test("capture-table writes emit timeline and a mixed transaction emits read", async () => {
  const f = setup();
  f.watch("task-a");
  f.db
    .prepare("INSERT INTO conversation_history_items VALUES (?, ?)")
    .run("task-a", "secret text");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["timeline"]);
  transaction(f.db, () => {
    f.db
      .prepare("INSERT INTO conversation_history_items VALUES (?, ?)")
      .run("task-a", "more");
    f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
  });
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["timeline", "read"]);
});

test("unattributed and unchanged writes emit nothing, and a parameterless write notifies every watcher", async () => {
  const f = setup();
  f.watch("task-a");
  f.watch("task-b");
  f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-c", "Other");
  f.db.prepare("UPDATE counters SET total = total + ? WHERE id = 1").run(5);
  f.db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("x", "task-a");
  f.db.exec("UPDATE counters SET total = 0 WHERE id = 2");
  await f.settle();
  assert.deepEqual(f.events("task-a"), []);
  f.db.exec("UPDATE counters SET total = 0");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read"]);
  assert.deepEqual(f.events("task-b"), ["read"]);
  f.db.exec("DELETE FROM tasks WHERE id = 'task-b'");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read"]);
  assert.deepEqual(f.events("task-b"), ["read", "read"]);
});

test("a work id bound in a commit attributes later capture writes", async () => {
  const f = setup();
  f.watch("task-a");
  transaction(f.db, () =>
    f.db.prepare("INSERT INTO bindings VALUES (?, ?)").run("work-1", "task-a"),
  );
  await f.settle();
  f.db
    .prepare("INSERT INTO diagnostic_items VALUES (?, ?)")
    .run("work-1", "payload");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read", "timeline"]);
});

test("a task that stops resolving emits gone once and stops listening", async () => {
  const f = setup();
  let present = true;
  f.watch("task-a", () => (present ? ["task-a"] : undefined));
  present = false;
  f.db.prepare("DELETE FROM tasks WHERE id = ?").run("task-a");
  f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Again");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["gone"]);
});

test("without watchers nothing resolves, and unsubscribing stops events", async () => {
  const f = setup();
  f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
  assert.equal(f.resolves(), 0);
  const stop = f.watch("task-a");
  stop();
  const resolves = f.resolves();
  f.db.prepare("UPDATE tasks SET title = ? WHERE id = ?").run("x", "task-a");
  await f.settle();
  assert.equal(f.resolves(), resolves);
  assert.deepEqual(f.events("task-a"), []);
});

test("notices within the coalescing window collapse into one", async () => {
  const f = setup();
  f.watch("task-a");
  for (let i = 0; i < 5; i += 1)
    f.db
      .prepare("INSERT INTO conversation_history_items VALUES (?, ?)")
      .run("task-a", String(i));
  f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read"]);
});

test("a project write notifies the project's tasks unless the commit wrote a task's own record", async () => {
  const f = setup();
  f.watch("task-a");
  f.watch("task-b");
  f.db
    .prepare("INSERT INTO projects VALUES (?, ?)")
    .run("project-1", "Renamed");
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read"]);
  assert.deepEqual(f.events("task-b"), ["read"]);
  transaction(f.db, () => {
    f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-c", "Sibling");
    f.db.prepare("INSERT INTO receipts VALUES (?, ?)").run("project-1", "key");
  });
  transaction(f.db, () => {
    f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Own");
    f.db.prepare("INSERT INTO receipts VALUES (?, ?)").run("project-1", "key");
  });
  await f.settle();
  assert.deepEqual(f.events("task-a"), ["read", "read"]);
  assert.deepEqual(f.events("task-b"), ["read"]);
});

test("a failing listener never fails the committed write", () => {
  const f = setup();
  let present = true;
  f.feed.watch(
    () => (present ? { own: ["task-a"], project: "project-1" } : undefined),
    () => {
      throw new Error("listener failed");
    },
  );
  present = false;
  f.db.prepare("INSERT INTO tasks VALUES (?, ?)").run("task-a", "Title");
  assert.equal(
    (
      f.db.prepare("SELECT title FROM tasks WHERE id = ?").get("task-a") as {
        title: string;
      }
    ).title,
    "Title",
  );
});
