import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "../fixtures/temp.js";
import {
  fixture as runtimeFixture,
  receiveTerminal,
  until,
} from "../fixtures/runtime-retention.js";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import { ConversationArchival } from "../../src/standalone/conversation-archival.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { coordinationFixture } from "../fixtures/coordination.js";

function fixture() {
  const f = coordinationFixture();
  new SchedulerStore(f.db);
  const state = new ExecutionState(f.db);
  f.db.exec(`UPDATE execution_intents SET state = 'completed';
    UPDATE execution_pending_effects SET state = 'settled';
    UPDATE domain_assignments SET state = 'completed'`);
  state.registerRuntimeThreadTools("thread-child-a", "a".repeat(64));
  const calls: [string, boolean][] = [];
  const runtime = {
    setThreadArchived: async (id: string, archived: boolean) => {
      calls.push([id, archived]);
    },
  } as Runtime;
  const busy = new Set<string>();
  const archival = () =>
    new ConversationArchival(
      f.db,
      state,
      (id) => busy.has(id),
      () => true,
    );
  return { ...f, state, calls, runtime, busy, archival };
}

test("archives finished Cab conversations once, restores only Cab archives, and persists receipts", async () => {
  const f = fixture();
  try {
    await f.archival().sweep(f.runtime);
    assert.deepEqual(f.calls, [["thread-child-a", true]]);
    const restarted = f.archival();
    await restarted.sweep(f.runtime);
    await restarted.restore(f.runtime, "operator-archived");
    assert.equal(f.calls.length, 1);
    await restarted.restore(f.runtime, "thread-child-a");
    assert.deepEqual(f.calls.at(-1), ["thread-child-a", false]);
    assert.equal(
      f.db.prepare("SELECT 1 FROM conversation_archives").get(),
      undefined,
    );
  } finally {
    f.close();
  }
});

const protectedCases: [string, string][] = [
  [
    "running turn",
    "UPDATE execution_intents SET state = 'running' WHERE workId = 'work-child-a'",
  ],
  [
    "held recovery",
    "UPDATE execution_intents SET state = 'held' WHERE workId = 'work-child-a'",
  ],
  ["active assignment", "UPDATE domain_assignments SET state = 'running'"],
  [
    "pending effects",
    "UPDATE execution_pending_effects SET state = 'pending' WHERE workId = 'work-child-a'",
  ],
  [
    "other task generation",
    "UPDATE execution_intents SET state = 'held' WHERE workId = 'work-nested-a'",
  ],
  [
    "other task effects",
    "UPDATE execution_pending_effects SET state = 'pending' WHERE workId = 'work-nested-a'",
  ],
  [
    "operator stop",
    "INSERT INTO task_writer_holds SELECT taskId, 'stopped', 'operator-stop' FROM task_execution_bindings WHERE workId = 'work-child-a'",
  ],
  [
    "ambiguity hold",
    "INSERT INTO task_writer_ambiguity_holds SELECT taskId, 'uncertain' FROM task_execution_bindings WHERE workId = 'work-child-a'",
  ],
  [
    "archival hold",
    "INSERT INTO task_archival_holds SELECT taskId, 'cleanup' FROM task_execution_bindings WHERE workId = 'work-child-a'",
  ],
  [
    "capacity ownership",
    "INSERT INTO execution_capacity_reservations (workId, projectId) SELECT 'work-child-a', projectId FROM domain_assignments WHERE id = (SELECT assignmentId FROM task_execution_bindings WHERE workId = 'work-child-a')",
  ],
  [
    "unknown stop outcome",
    "INSERT INTO execution_stop_targets (taskId,workId,threadId,turnId,interruptState,terminalState,reason,requestedAt) SELECT taskId,workId,'thread-child-a','turn-child-a','uncertain','unknown','stopped',0 FROM task_execution_bindings WHERE workId = 'work-child-a'",
  ],
  [
    "foreign harness",
    "UPDATE runtime_thread_qualification SET harness = 'claude'",
  ],
  [
    "previous Codex home",
    "UPDATE runtime_thread_qualification SET codexHome = NULL",
  ],
];
for (const [name, sql] of protectedCases)
  test(`preserves ${name}`, async () => {
    const f = fixture();
    try {
      f.db.exec(sql);
      assert.equal(
        f.archival().sweep(f.runtime),
        undefined,
        "ineligible cleanup must not retain background work",
      );
      assert.deepEqual(f.calls, []);
    } finally {
      f.close();
    }
  });

test("preserves callbacks still settling after terminal and resumes queued against the thread", async () => {
  const f = fixture();
  try {
    const archival = f.archival();
    f.busy.add("work-child-a");
    await archival.sweep(f.runtime);
    assert.deepEqual(f.calls, []);
    f.busy.clear();
    f.db
      .prepare(`INSERT INTO turn_requests
      (requestKey,workId,kind,prompt,previousWorkId,state)
      VALUES ('continuation','continuation','direct','continue','work-child-a','queued')`)
      .run();
    await archival.sweep(f.runtime);
    assert.deepEqual(f.calls, []);
    f.db.exec("UPDATE turn_requests SET state = 'completed'");
    await archival.sweep(f.runtime);
    assert.deepEqual(f.calls, [["thread-child-a", true]]);
  } finally {
    f.close();
  }
});

test("archives replaced conversations while preserving their open current replacement", async () => {
  const f = fixture();
  try {
    f.db.exec(`UPDATE domain_assignments SET state = 'running';
      UPDATE assignment_conversations SET revision = revision + 1`);
    await f.archival().sweep(f.runtime);
    assert.deepEqual(f.calls, [["thread-child-a", true]]);
  } finally {
    f.close();
  }
});

test("archive failure is retried, and lost acknowledgements are restored after restart", async () => {
  const f = fixture();
  try {
    const archival = f.archival();
    await archival.sweep({
      setThreadArchived: async () => {
        throw new Error("lost reply");
      },
    } as unknown as Runtime);
    assert.equal(
      (
        f.db.prepare("SELECT state FROM conversation_archives").get() as {
          state: string;
        }
      ).state,
      "requested",
    );
    await f.archival().restore(f.runtime, "thread-child-a");
    assert.deepEqual(f.calls, [["thread-child-a", false]]);
    await archival.sweep(f.runtime);
    assert.deepEqual(f.calls.at(-1), ["thread-child-a", true]);
  } finally {
    f.close();
  }
});

test("restoration waits for an in-flight archive and retains its receipt on restore failure", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const archived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      setThreadArchived: async (id: string, archive: boolean) => {
        f.calls.push([id, archive]);
        if (archive) await archived;
        else throw new Error("restore unavailable");
      },
    } as Runtime;
    const archival = f.archival();
    const sweep = archival.sweep(runtime);
    const restore = archival.restore(runtime, "thread-child-a");
    assert.deepEqual(f.calls, [["thread-child-a", true]]);
    release();
    await sweep;
    await assert.rejects(restore, /restore unavailable/);
    assert.deepEqual(f.calls, [
      ["thread-child-a", true],
      ["thread-child-a", false],
    ]);
    assert.ok(f.db.prepare("SELECT 1 FROM conversation_archives").get());
  } finally {
    f.close();
  }
});

test("finished direct and drafting requests archive, unfinished drafts and unknown bindings do not", async () => {
  const f = fixture();
  try {
    for (const [kind, draftState] of [
      ["direct", null],
      ["drafting", "proposed"],
      ["drafting", "running"],
      ["unknown", null],
    ] as const) {
      const runId = randomUUID();
      const workId = kind === "drafting" ? `drafting:${runId}` : runId;
      const threadId = `${kind}-${draftState}`;
      const intent = f.state.create(workId, "test", "/tmp/work");
      f.db
        .prepare(
          "UPDATE execution_intents SET state = 'completed', threadId = ? WHERE id = ?",
        )
        .run(threadId, intent.id);
      f.state.registerRuntimeThreadTools(threadId, "a".repeat(64));
      if (kind !== "unknown")
        f.db
          .prepare(`INSERT INTO turn_requests
        (requestKey,workId,kind,prompt,state) VALUES (?, ?, ?, 'test', 'completed')`)
          .run(workId, workId, kind);
      if (kind === "drafting")
        f.db
          .prepare(`INSERT INTO drafting_runs
        (runId,projectId,idea,harness,profileId,profileRevision,instructionsRevision,state,createdAt)
        VALUES (?, 'project', 'idea', 'codex', 'profile', 1, 1, ?, 0)`)
          .run(runId, draftState);
    }
    await f.archival().sweep(f.runtime);
    assert.deepEqual(
      f.calls.map(([id]) => id).sort(),
      ["thread-child-a", "direct-null", "drafting-proposed"].sort(),
    );
  } finally {
    f.close();
  }
});

test("service automatically archives terminal direct work and restores before a continuation", {
  timeout: 15_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-conversation-archival-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const f = runtimeFixture(root);
  const calls: [string, boolean][] = [];
  try {
    await f.service.start();
    f.runtime().setThreadArchived = async (id, archived) => {
      calls.push([id, archived]);
    };
    const firstResult = f.service.submit("first", "first", workspace);
    await until(
      () => f.internals().state.byWorkId("first")?.state === "running",
      "first turn binding",
    );
    const first = f.internals().state.byWorkId("first")!;
    assert.equal(first.state, "running");
    assert.deepEqual(calls, []);
    receiveTerminal(
      f.runtime(),
      f.child,
      first.turnId!,
      "completed",
      first.threadId!,
    );
    await firstResult;
    await until(() => calls.length === 1, "automatic archival");
    assert.deepEqual(calls, [[first.threadId!, true]]);
    const nextResult = f.service.submit("next", "continue", workspace, "first");
    await until(
      () => f.internals().state.byWorkId("next")?.state === "running",
      "continuation turn binding",
    );
    const next = f.internals().state.byWorkId("next")!;
    assert.equal(next.state, "running");
    assert.equal(next.threadId, first.threadId);
    assert.deepEqual(calls, [
      [first.threadId!, true],
      [first.threadId!, false],
    ]);
    receiveTerminal(
      f.runtime(),
      f.child,
      next.turnId!,
      "completed",
      next.threadId!,
    );
    await nextResult;
    await until(() => calls.length === 3, "continuation archival");
    assert.deepEqual(calls.at(-1), [first.threadId!, true]);
  } finally {
    await f.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
