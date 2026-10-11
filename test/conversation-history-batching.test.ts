import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { Database } from "../src/core/store.js";
import type { RuntimeConversationEvent } from "../src/standalone/codex.js";
import {
  ConversationHistoryCapture,
  ConversationHistoryStore,
} from "../src/standalone/conversation-history.js";

const binding = {
  workId: "work-1",
  taskId: "task-1",
  assignmentId: "assignment-1",
  assignmentVersion: 1,
  instructionsRevision: 1,
  profileRevision: 1,
  conversationRevision: 1,
  workRevision: 1,
  threadId: "thread-1",
  turnId: "turn-1",
};

const turn = { threadId: "thread-1", turnId: "turn-1" };

/** Counts durable commits: explicit transactions and autocommit writes. */
function setup(t: TestContext, fakeTimers = true) {
  if (fakeTimers) t.mock.timers.enable({ apis: ["setTimeout"] });
  const raw = new DatabaseSync(":memory:");
  let commits = 0;
  let open = false;
  const db: Database = {
    get isTransaction() {
      return raw.isTransaction;
    },
    exec(sql) {
      if (sql.startsWith("BEGIN")) open = true;
      else if (sql === "COMMIT") {
        open = false;
        commits += 1;
      } else if (sql === "ROLLBACK") open = false;
      return raw.exec(sql);
    },
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        run: (...parameters) => {
          if (!open && /^\s*(INSERT|UPDATE)/.test(sql)) commits += 1;
          return statement.run(...parameters);
        },
        get: (...parameters) => statement.get(...parameters),
        all: (...parameters) => statement.all(...parameters),
      };
    },
  };
  const store = new ConversationHistoryStore(db);
  commits = 0;
  const capture = new ConversationHistoryCapture({
    store,
    workId: binding.workId,
    threadId: binding.threadId,
    captureStartExclusions: [],
    currentExclusions: () => [],
  });
  const rows = () =>
    raw
      .prepare(
        "SELECT itemId, lifecycle, text, omissionReason, deltaBytes FROM conversation_history_items ORDER BY sequence",
      )
      .all()
      .map((row) => ({ ...row }));
  const row = (itemId: string) => rows().find((r) => r.itemId === itemId);
  const send = (event: Partial<RuntimeConversationEvent> & { kind: string }) =>
    capture.receive({ ...turn, ...event } as RuntimeConversationEvent);
  const delta = (itemId: string, bytes: number) =>
    send({ itemId, kind: "delta", bytes });
  return {
    raw,
    store,
    capture,
    rows,
    row,
    send,
    delta,
    commits: () => commits,
    isTransaction: () => db.isTransaction,
    started: (itemId: string) => send({ itemId, kind: "started" }),
  };
}

test("deltas cost one commit per item event or flush interval, never one per delta", (t) => {
  const s = setup(t);
  try {
    s.capture.bind(binding);
    s.started("a");
    assert.equal(s.commits(), 1);
    for (let i = 0; i < 500; i += 1) s.delta("a", 3);
    assert.equal(s.commits(), 1);
    assert.equal(s.row("a")?.lifecycle, "started");
    assert.equal(s.row("a")?.deltaBytes, 0);
    t.mock.timers.tick(999);
    assert.equal(s.commits(), 1);
    t.mock.timers.tick(1);
    assert.equal(s.commits(), 2);
    assert.equal(s.row("a")?.lifecycle, "streaming");
    assert.equal(s.row("a")?.deltaBytes, 1500);
    for (let i = 0; i < 300; i += 1) s.delta("a", 3);
    t.mock.timers.tick(1000);
    assert.equal(s.commits(), 3);
    assert.equal(s.row("a")?.deltaBytes, 2400);
    t.mock.timers.tick(10000);
    assert.equal(s.commits(), 3);
    s.send({ itemId: "a", kind: "completed", text: "done" });
    assert.equal(s.commits(), 4);
    assert.deepEqual(s.row("a"), {
      itemId: "a",
      lifecycle: "completed",
      text: "done",
      omissionReason: null,
      deltaBytes: 2400,
    });
  } finally {
    s.raw.close();
  }
});

test("pending counts are written before completion, omission and turn end", (t) => {
  const s = setup(t);
  try {
    s.capture.bind(binding);
    for (const id of ["done", "dropped", "open"]) {
      s.started(id);
      s.delta(id, 4);
    }
    s.send({ itemId: "done", kind: "completed", text: "x" });
    assert.equal(s.row("done")?.deltaBytes, 4);
    assert.equal(s.row("dropped")?.deltaBytes, 4);
    s.delta("dropped", 1);
    s.send({ itemId: "dropped", kind: "omitted", reason: "size-limit" });
    assert.equal(s.row("dropped")?.lifecycle, "omitted");
    assert.equal(s.row("dropped")?.deltaBytes, 5);
    s.delta("open", 2);
    s.capture.finish();
    assert.equal(s.row("open")?.lifecycle, "omitted");
    assert.equal(s.row("open")?.omissionReason, "turn-ended");
    assert.equal(s.row("open")?.deltaBytes, 6);
    const commits = s.commits();
    t.mock.timers.runAll();
    t.mock.timers.tick(5000);
    s.delta("open", 9);
    assert.equal(s.commits(), commits);
    assert.equal(s.row("open")?.deltaBytes, 6);
  } finally {
    s.raw.close();
  }
});

test("late, foreign and post-completion deltas never reopen or move a settled item", (t) => {
  const s = setup(t);
  try {
    s.capture.bind(binding);
    s.started("a");
    s.send({ itemId: "a", kind: "completed", text: "done" });
    const commits = s.commits();
    s.delta("a", 7);
    s.send({ itemId: "a", kind: "delta", bytes: 7, turnId: "other" });
    s.send({ itemId: "a", kind: "delta", bytes: 7, threadId: "other" });
    t.mock.timers.tick(1000);
    assert.equal(s.commits(), commits + 1);
    assert.equal(s.rows().length, 1);
    assert.equal(s.row("a")?.lifecycle, "completed");
    assert.equal(s.row("a")?.text, "done");
    assert.equal(s.row("a")?.deltaBytes, 0);
  } finally {
    s.raw.close();
  }
});

test("deltas buffered before the turn binds are written as one aggregate", (t) => {
  const s = setup(t);
  try {
    s.started("a");
    for (let i = 0; i < 100; i += 1) s.delta("a", 2);
    s.send({ itemId: "a", kind: "delta", bytes: 2, turnId: "other" });
    assert.deepEqual(s.rows(), []);
    s.capture.bind(binding);
    assert.equal(s.commits(), 1);
    t.mock.timers.tick(1000);
    assert.equal(s.commits(), 2);
    assert.deepEqual(
      s.rows().map((r) => [r.itemId, r.lifecycle, r.deltaBytes]),
      [["a", "streaming", 200]],
    );
  } finally {
    s.raw.close();
  }
});

test("discard writes bound counts once and an unbound discard writes nothing", (t) => {
  const unbound = setup(t);
  try {
    unbound.delta("a", 2);
    unbound.capture.discard();
    t.mock.timers.runAll();
    assert.deepEqual(unbound.rows(), []);
  } finally {
    unbound.raw.close();
  }

  const s = setup(t, false);
  try {
    s.capture.bind(binding);
    s.delta("a", 2);
    s.capture.discard();
    assert.equal(s.commits(), 1);
    assert.equal(s.row("a")?.deltaBytes, 2);
    t.mock.timers.runAll();
    s.delta("a", 2);
    assert.equal(s.commits(), 1);
  } finally {
    s.raw.close();
  }
});

test("pending items are bounded by flushing before the cap is exceeded", (t) => {
  const s = setup(t);
  try {
    s.capture.bind(binding);
    for (let i = 0; i < 64; i += 1) s.delta(`item-${i}`, 1);
    assert.equal(s.commits(), 0);
    s.delta("item-64", 1);
    assert.equal(s.commits(), 1);
    assert.equal(s.rows().length, 64);
    t.mock.timers.tick(1000);
    assert.equal(s.rows().length, 65);
    assert.equal(s.commits(), 2);
  } finally {
    s.raw.close();
  }
});

test("invalid delta sizes are ignored and counts saturate at the safe-integer bound", (t) => {
  const s = setup(t);
  try {
    s.capture.bind(binding);
    for (const bytes of [0, -1, 1.5, Number.NaN, 65537]) s.delta("a", bytes);
    t.mock.timers.runAll();
    assert.deepEqual(s.rows(), []);
    s.store.recordDeltaBytes(
      binding,
      new Map([["a", Number.MAX_SAFE_INTEGER]]),
    );
    s.store.recordDeltaBytes(binding, new Map([["a", 5]]));
    assert.equal(s.row("a")?.deltaBytes, Number.MAX_SAFE_INTEGER);
  } finally {
    s.raw.close();
  }
});

test("a failing flush never throws, leaves no open transaction and loses only that batch", (t) => {
  const s = setup(t);
  const fail = `CREATE TRIGGER fail_insert BEFORE INSERT ON conversation_history_items
    BEGIN SELECT RAISE(ABORT, 'diagnostic write failed'); END`;
  try {
    s.capture.bind(binding);
    s.raw.exec(fail);
    s.delta("a", 1);
    s.delta("b", 1);
    assert.doesNotThrow(() => t.mock.timers.tick(1000));
    assert.equal(s.isTransaction(), false);
    assert.deepEqual(s.rows(), []);
    s.raw.exec("DROP TRIGGER fail_insert");
    s.delta("a", 2);
    t.mock.timers.tick(1000);
    assert.deepEqual(
      s.rows().map((r) => [r.itemId, r.deltaBytes]),
      [["a", 2]],
    );
    s.raw.exec(fail);
    s.delta("c", 1);
    assert.doesNotThrow(() => s.capture.finish());
    assert.doesNotThrow(() => s.capture.discard());
  } finally {
    s.raw.close();
  }
});
