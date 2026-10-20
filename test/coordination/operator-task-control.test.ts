import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import {
  DomainConflictError,
  TaskNotOpenError,
} from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import {
  commandReceiptSchema,
  operatorCommandSchema,
} from "../../src/operator/contracts.js";
import {
  OperatorApi,
  type OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { ExecutionState } from "../../src/standalone/state.js";
import { SchedulerStore } from "../../src/standalone/scheduler.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { startOwnWork } from "../fixtures/questions.js";
import { seedReviewTask } from "../fixtures/task-review.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

const fixture = async (t: { after(fn: () => unknown): void }) => {
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    { supervisor: { observationMs: 50 } },
  );
  t.after(() => f.close());
  return f;
};
const rows = (f: Fixture, sql: string, ...args: string[]) => {
  let result: unknown[] = [];
  f.seedPersistedState((db) => {
    result = db
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  });
  return result;
};
const control = (
  f: Fixture,
  type: "task.stop" | "task.resume",
  taskId: string,
  key = randomUUID(),
  expectedVersion?: number,
) =>
  f.service.controlTask({
    type,
    key,
    taskId,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });

test("a receipted Stop is atomic with its hold and replays without effect", async (t) => {
  const f = await fixture(t);
  const { a, work } = await startOwnWork(f, "Stop me", "Stop project");
  const key = randomUUID();
  const stop = await control(f, "task.stop", a.taskId, key);
  assert.deepEqual(stop, {
    kind: "task-stop",
    key,
    recorded: true,
    taskId: a.taskId,
    cancellationRequested: 1,
  });
  assert.equal(f.service.taskHold(a.taskId), "Task stopped");
  const targets = () =>
    rows(
      f,
      "SELECT workId FROM execution_stop_targets WHERE taskId = ?",
      a.taskId,
    );
  assert.deepEqual(targets(), [{ workId: work.workId }]);
  assert.equal(
    f.service.list().find((w) => w.workId === work.workId)?.state,
    "held",
  );

  // The same key and content replays the stored receipt with no new effect.
  assert.deepEqual(await control(f, "task.stop", a.taskId, key), stop);
  assert.equal(targets().length, 1);
  const resumed = await control(f, "task.resume", a.taskId);
  assert.equal(resumed.kind === "task-resume" && resumed.stopCleared, true);
  assert.deepEqual(await control(f, "task.stop", a.taskId, key), stop);
  assert.equal(
    f.service.taskHold(a.taskId),
    undefined,
    "replay is not a new Stop",
  );

  // Other content under the key conflicts; the key is scoped to its task.
  await assert.rejects(
    control(f, "task.stop", a.taskId, key, 1),
    DomainConflictError,
  );
  await assert.rejects(
    control(f, "task.resume", a.taskId, key),
    DomainConflictError,
  );
  const other = await seedReviewTask(f, "Other project", "Other task");
  const independent = await control(f, "task.stop", other.taskId, key);
  assert.equal(independent.taskId, other.taskId);
  assert.equal(
    independent.kind === "task-stop" && independent.cancellationRequested,
    0,
  );
  assert.equal(f.service.taskHold(other.taskId), "Task stopped");
});

test("an expected version fences Stop and Resume only when supplied", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  const version = Number(f.service.domain().task(a.taskId).version);
  const key = randomUUID();
  await assert.rejects(
    control(f, "task.stop", a.taskId, key, version + 1),
    DomainConflictError,
  );
  assert.equal(f.service.taskHold(a.taskId), undefined);
  assert.deepEqual(
    rows(f, "SELECT key FROM task_control_receipts WHERE taskId = ?", a.taskId),
    [],
  );
  await control(f, "task.stop", a.taskId, randomUUID(), version);
  assert.equal(f.service.taskHold(a.taskId), "Task stopped");
  // An unrelated edit does not block an unfenced Resume or Stop.
  f.service.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: version,
    title: "Edited meanwhile",
  });
  await control(f, "task.resume", a.taskId);
  await control(f, "task.stop", a.taskId);
  assert.equal(f.service.taskHold(a.taskId), "Task stopped");
});

test("Resume clears only the operator Stop and counts requeued work", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  const noop = await control(f, "task.resume", a.taskId);
  assert.deepEqual(
    { ...noop, key: "" },
    {
      kind: "task-resume",
      key: "",
      recorded: true,
      taskId: a.taskId,
      stopCleared: false,
      requeued: 0,
    },
  );

  await control(f, "task.stop", a.taskId);
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Fixture ambiguity')",
      )
      .run(a.taskId),
  );
  const resumed = await control(f, "task.resume", a.taskId);
  assert.equal(resumed.kind === "task-resume" && resumed.stopCleared, true);
  assert.equal(f.service.taskHold(a.taskId), "Fixture ambiguity");
  assert.equal(f.service.isTaskStopped(a.taskId), false);

  // Held queued intents are made ready and counted (state only; no scheduler here).
  const b = await seedReviewTask(f, "Queue project", "Queued task");
  let receipt: unknown;
  f.seedPersistedState((db) => {
    // Opening the state first keeps its startup migration away from the seeded row.
    const state = new ExecutionState(db);
    const workId = `queued-${randomUUID()}`;
    db.prepare(
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,holdKind,accountType,sandbox,approval) VALUES (?,?,'p','/w','capacity-waiting','Task stopped','operator-stop','chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId);
    db.prepare(
      "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
    ).run(workId, b.taskId, b.assignmentId);
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
    ).run(b.taskId);
    receipt = state.controlTask({
      type: "task.resume",
      key: randomUUID(),
      taskId: b.taskId,
    }).receipt;
    // Settle the seeded work so the running service never schedules it.
    db.prepare(
      "UPDATE execution_intents SET state = 'completed' WHERE workId = ?",
    ).run(workId);
  });
  assert.equal(
    (receipt as { requeued: number; stopCleared: boolean }).requeued,
    1,
  );
});

test("reopen preserves a typed Stop whose edited reason matches the legacy ambiguity marker", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  await control(f, "task.stop", a.taskId);
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE task_writer_holds SET reason = 'Legacy work revision order is ambiguous' WHERE taskId = ?",
    ).run(a.taskId);
    db.prepare(
      "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Independent ownership ambiguity')",
    ).run(a.taskId);
  });

  await f.reopen();
  assert.equal(f.service.isTaskStopped(a.taskId), true);
  assert.equal(f.service.hasNonStopTaskHold(a.taskId), true);
  assert.equal(f.service.taskHold(a.taskId), "Independent ownership ambiguity");
  assert.deepEqual(
    rows(
      f,
      "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ?",
      a.taskId,
    ),
    [
      {
        reason: "Legacy work revision order is ambiguous",
        holdKind: "operator-stop",
      },
    ],
  );
  assert.deepEqual(
    rows(
      f,
      "SELECT reason FROM task_writer_ambiguity_holds WHERE taskId = ?",
      a.taskId,
    ),
    [{ reason: "Independent ownership ambiguity" }],
  );

  await control(f, "task.resume", a.taskId);
  assert.equal(f.service.isTaskStopped(a.taskId), false);
  assert.equal(f.service.hasNonStopTaskHold(a.taskId), true);
  assert.equal(f.service.taskHold(a.taskId), "Independent ownership ambiguity");
  assert.deepEqual(
    rows(
      f,
      "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ?",
      a.taskId,
    ),
    [],
  );
  assert.deepEqual(
    rows(
      f,
      "SELECT reason FROM task_writer_ambiguity_holds WHERE taskId = ?",
      a.taskId,
    ),
    [{ reason: "Independent ownership ambiguity" }],
  );
});

test("a failed receipt write rolls back the hold and a retry applies once", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  const api = new OperatorApi(f.service, []);
  f.seedPersistedState((db) =>
    db.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON task_control_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    ),
  );
  const command = { type: "task.stop", key: randomUUID(), taskId: a.taskId };
  await assert.rejects(api.execute(command), (error: OperatorApiError) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "command-outcome-unknown");
    return true;
  });
  assert.equal(f.service.taskHold(a.taskId), undefined, "no partial Stop");
  f.seedPersistedState((db) => db.exec("DROP TRIGGER fail_receipt"));
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "task-stop");
  assert.deepEqual(await api.execute(command), receipt);
  assert.equal(
    rows(f, "SELECT key FROM task_control_receipts WHERE taskId = ?", a.taskId)
      .length,
    1,
  );
  // An unknown task is not found before any change.
  await assert.rejects(
    api.execute({ ...command, key: randomUUID(), taskId: randomUUID() }),
    (error: OperatorApiError) => error.status === 404,
  );
});

test("keyless and receipted Stop and Resume share one hold", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  await f.service.stopTask(a.taskId);
  assert.equal(f.service.isTaskStopped(a.taskId), true);
  await control(f, "task.resume", a.taskId);
  assert.equal(f.service.isTaskStopped(a.taskId), false);
  await control(f, "task.stop", a.taskId);
  assert.equal(f.service.isTaskStopped(a.taskId), true);
  await f.service.resumeTask(a.taskId);
  assert.equal(f.service.isTaskStopped(a.taskId), false);
});

const finish = (f: Fixture, taskId: string, state: "done" | "cancelled") =>
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_tasks SET state = ?, version = version + 1 WHERE id = ?",
    ).run(state, taskId);
  });
const seedStop = (f: Fixture, taskId: string) =>
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
    ).run(taskId);
  });

test("Stop applies only to an open task", async (t) => {
  const f = await fixture(t);
  const open = await seedReviewTask(f, "Open project", "Open task");
  assert.equal((await control(f, "task.stop", open.taskId)).kind, "task-stop");
  for (const state of ["done", "cancelled"] as const) {
    const a = await seedReviewTask(f, `${state} project`, `${state} task`);
    finish(f, a.taskId, state);
    const before = databaseDigest(f);
    for (const stop of [
      () => control(f, "task.stop", a.taskId),
      async () => f.service.stopTask(a.taskId),
    ])
      await assert.rejects(
        stop(),
        (error) =>
          error instanceof TaskNotOpenError &&
          error instanceof DomainConflictError &&
          error.taskState === state,
      );
    assert.equal(databaseDigest(f), before);
    assert.equal(f.service.isTaskStopped(a.taskId), false);
  }
});

test("a stored Stop receipt replays after the task finishes", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  const key = randomUUID();
  const first = await control(f, "task.stop", a.taskId, key);
  finish(f, a.taskId, "done");
  assert.deepEqual(await control(f, "task.stop", a.taskId, key), first);
});

test("Resume clears an existing Stop on a finished task", async (t) => {
  const f = await fixture(t);
  for (const state of ["done", "cancelled"] as const) {
    const a = await seedReviewTask(f, `${state} project`, `${state} task`);
    finish(f, a.taskId, state);
    seedStop(f, a.taskId);
    assert.equal(f.service.isTaskStopped(a.taskId), true);
    const resume = await control(f, "task.resume", a.taskId);
    assert.equal(resume.kind === "task-resume" && resume.stopCleared, true);
    assert.equal(f.service.isTaskStopped(a.taskId), false);
  }
});

test("operator Stop coexists with an independent writer hold across restart and Resume", async (t) => {
  const f = await fixture(t);
  const receipted = await seedReviewTask(f, "Writer hold project", "Receipted");
  const keyless = await seedReviewTask(
    f,
    "Keyless writer hold project",
    "Keyless",
  );
  const heldTasks = [receipted, keyless];
  f.seedPersistedState((db) => {
    for (const task of heldTasks)
      db.prepare(
        "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)",
      ).run(task.taskId, `Independent hold for ${task.taskId}`);
  });

  const stopKey = randomUUID();
  const receipt = await control(f, "task.stop", receipted.taskId, stopKey);
  assert.equal(
    receipt.kind === "task-stop" && receipt.cancellationRequested,
    0,
  );
  await f.service.stopTask(keyless.taskId);
  for (const task of heldTasks) {
    assert.equal(f.service.isTaskStopped(task.taskId), true);
    assert.equal(f.service.hasNonStopTaskHold(task.taskId), true);
    assert.equal(
      f.service.taskHold(task.taskId),
      `Independent hold for ${task.taskId}`,
    );
  }

  await f.reopen();
  for (const task of heldTasks) {
    assert.equal(f.service.isTaskStopped(task.taskId), true);
    assert.equal(f.service.hasNonStopTaskHold(task.taskId), true);
    assert.equal(
      f.service.taskHold(task.taskId),
      `Independent hold for ${task.taskId}`,
    );
    const recovery = f.service
      .recoveryForTask(task.taskId)
      .find((record) => record.binding?.taskId === task.taskId);
    if (recovery) {
      assert.equal(recovery.holds.stop, true);
      assert.equal(
        recovery.holds.task,
        "Execution state requires operator attention",
      );
    }
  }

  await control(f, "task.resume", receipted.taskId);
  await f.service.resumeTask(keyless.taskId);
  assert.deepEqual(
    await control(f, "task.stop", receipted.taskId, stopKey),
    receipt,
  );
  for (const task of heldTasks) {
    assert.equal(f.service.isTaskStopped(task.taskId), false);
    assert.equal(f.service.hasNonStopTaskHold(task.taskId), true);
    assert.equal(
      f.service.taskHold(task.taskId),
      `Independent hold for ${task.taskId}`,
    );
    f.seedPersistedState((db) => {
      assert.deepEqual(
        db
          .prepare(
            "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ?",
          )
          .all(task.taskId)
          .map((row) => ({ ...row })),
        [{ reason: `Independent hold for ${task.taskId}`, holdKind: null }],
      );
    });
  }
});

test("typed hold-table migration rolls back instead of collapsing duplicate legacy rows", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  f.seedPersistedState((db) => {
    db.exec(`CREATE TABLE task_writer_holds_fixture (
      taskId TEXT, reason TEXT NOT NULL,
      holdKind TEXT CHECK(holdKind IS NULL OR holdKind = 'operator-stop')
    );
    INSERT INTO task_writer_holds_fixture VALUES
      ('${a.taskId}', 'Unknown row one', NULL),
      ('${a.taskId}', 'Unknown row two', NULL);
    DROP TABLE task_writer_holds;
    ALTER TABLE task_writer_holds_fixture RENAME TO task_writer_holds`);
  });

  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  try {
    assert.throws(() => new ExecutionState(db), /UNIQUE constraint failed/);
    assert.deepEqual(
      db
        .prepare(
          "SELECT taskId, reason, holdKind FROM task_writer_holds ORDER BY reason",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { taskId: a.taskId, reason: "Unknown row one", holdKind: null },
        { taskId: a.taskId, reason: "Unknown row two", holdKind: null },
      ],
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='task_writer_holds_task_kind'",
        )
        .get(),
      undefined,
    );
  } finally {
    db.close();
  }
});

test("already-typed task writer schema is rebuilt to permit one independent hold beside Stop", async (t) => {
  const f = await fixture(t);
  const a = await seedReviewTask(f);
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)",
    ).run(a.taskId, "Task stopped");
    db.exec(`CREATE TABLE task_writer_holds_typed_legacy (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL,
      holdKind TEXT CHECK(holdKind IS NULL OR holdKind = 'operator-stop')
    );
    INSERT INTO task_writer_holds_typed_legacy (taskId, reason, holdKind)
      SELECT taskId, reason, holdKind FROM task_writer_holds;
    DROP TABLE task_writer_holds;
    ALTER TABLE task_writer_holds_typed_legacy RENAME TO task_writer_holds`);
  });

  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  try {
    let failRename = true;
    const failingDb = {
      exec(sql: string) {
        if (
          failRename &&
          sql ===
            "ALTER TABLE task_writer_holds_rebuild RENAME TO task_writer_holds"
        ) {
          failRename = false;
          throw new Error("Injected migration rename failure");
        }
        db.exec(sql);
      },
      prepare: db.prepare.bind(db),
    };
    assert.throws(
      () => new ExecutionState(failingDb as unknown as DatabaseSync),
      /Injected migration rename failure/,
    );
    assert.equal(failRename, false);
    assert.equal(
      (
        db.prepare("PRAGMA table_info(task_writer_holds)").all() as Array<{
          name: string;
          pk: number;
        }>
      ).find(({ name }) => name === "taskId")?.pk,
      1,
      "transaction rollback restores the old taskId primary key",
    );
    assert.deepEqual(
      db
        .prepare("SELECT taskId, reason, holdKind FROM task_writer_holds")
        .all()
        .map((row) => ({ ...row })),
      [{ taskId: a.taskId, reason: "Task stopped", holdKind: null }],
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_writer_holds_rebuild'",
        )
        .get(),
      undefined,
    );

    const state = new ExecutionState(db);
    assert.equal(state.isTaskStopped(a.taskId), false);
    assert.equal(state.taskHold(a.taskId), "Task stopped");
    assert.equal(
      (
        db.prepare("PRAGMA table_info(task_writer_holds)").all() as Array<{
          name: string;
          pk: number;
        }>
      ).some(({ name, pk }) => name === "taskId" && pk > 0),
      false,
    );
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, ?, 'operator-stop')",
    ).run(a.taskId, "Edited Stop reason");
    assert.deepEqual(
      db
        .prepare(
          "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ? ORDER BY holdKind",
        )
        .all(a.taskId)
        .map((row) => ({ ...row })),
      [
        { reason: "Task stopped", holdKind: null },
        { reason: "Edited Stop reason", holdKind: "operator-stop" },
      ],
    );
    assert.equal(state.isTaskStopped(a.taskId), true);
    state.resumeTask(a.taskId);
    assert.equal(state.isTaskStopped(a.taskId), false);
    assert.equal(state.hasNonStopTaskHold(a.taskId), true);
    assert.deepEqual(
      db
        .prepare(
          "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ?",
        )
        .all(a.taskId)
        .map((row) => ({ ...row })),
      [{ reason: "Task stopped", holdKind: null }],
    );
    new ExecutionState(db);
    assert.equal(state.taskHold(a.taskId), "Task stopped");
  } finally {
    db.close();
  }
});

test("legacy Stop provenance migrates once and remains typed when display text changes", async (t) => {
  const f = await fixture(t);
  const { a, work } = await startOwnWork(f, "Legacy Stop", "Migration project");
  const { a: unknown, work: unknownWork } = await startOwnWork(
    f,
    "Unknown hold",
    "Unknown hold project",
  );
  await control(f, "task.stop", a.taskId);
  await f.service.stop();

  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  try {
    // Recreate the prior schema and its reason-only Stop rows before startup.
    db.exec(`CREATE TABLE task_writer_holds_legacy (
      taskId TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    INSERT INTO task_writer_holds_legacy (taskId, reason)
      SELECT taskId, reason FROM task_writer_holds;
    DROP TABLE task_writer_holds;
    ALTER TABLE task_writer_holds_legacy RENAME TO task_writer_holds`);
    for (const table of ["execution_intents", "turn_requests"])
      db.exec(`ALTER TABLE ${table} DROP COLUMN holdKind`);
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)",
    ).run(unknown.taskId, "Unrecognized legacy hold");
    db.prepare(
      "UPDATE execution_intents SET state = 'capacity-waiting', reason = 'Task stopped' WHERE workId = ?",
    ).run(unknownWork.workId);
    db.prepare(
      "UPDATE turn_requests SET state = 'queued', reason = 'Task stopped' WHERE workId = ?",
    ).run(unknownWork.workId);

    let state = new ExecutionState(db);
    assert.equal(state.isTaskStopped(a.taskId), true);
    assert.equal(state.isTaskStopped(unknown.taskId), false);
    const migrated = rows(
      f,
      `SELECT holdKind, reason FROM task_writer_holds WHERE taskId = ?
     UNION ALL SELECT holdKind, reason FROM execution_intents WHERE workId = ?
     UNION ALL SELECT holdKind, reason FROM turn_requests WHERE workId = ?`,
      a.taskId,
      work.workId,
      work.workId,
    );
    assert.deepEqual(migrated, [
      { holdKind: "operator-stop", reason: "Task stopped" },
      { holdKind: "operator-stop", reason: "Task stopped" },
      { holdKind: "operator-stop", reason: "Task stopped" },
    ]);
    assert.deepEqual(
      {
        ...db
          .prepare(`SELECT intent.holdKind AS intentKind, request.holdKind AS requestKind
      FROM execution_intents intent JOIN turn_requests request ON request.workId = intent.workId
      WHERE intent.workId = ?`)
          .get(unknownWork.workId),
      },
      { intentKind: null, requestKind: null },
    );
    const firstMigration = rows(
      f,
      `SELECT 'task' AS tableName, taskId AS id, holdKind, reason FROM task_writer_holds
     UNION ALL SELECT 'intent', workId, holdKind, reason FROM execution_intents
     UNION ALL SELECT 'request', workId, holdKind, reason FROM turn_requests
     ORDER BY tableName, id`,
    );
    state = new ExecutionState(db);
    assert.deepEqual(
      rows(
        f,
        `SELECT 'task' AS tableName, taskId AS id, holdKind, reason FROM task_writer_holds
       UNION ALL SELECT 'intent', workId, holdKind, reason FROM execution_intents
       UNION ALL SELECT 'request', workId, holdKind, reason FROM turn_requests
       ORDER BY tableName, id`,
      ),
      firstMigration,
    );

    db.prepare(
      "UPDATE task_writer_holds SET reason = 'Stop label edited' WHERE taskId = ?",
    ).run(a.taskId);
    db.prepare(
      "UPDATE execution_intents SET reason = 'Intent label edited' WHERE workId = ?",
    ).run(work.workId);
    db.prepare(
      "UPDATE turn_requests SET reason = 'Request label edited' WHERE workId = ?",
    ).run(work.workId);
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent writer hold')",
    ).run(a.taskId);
    db.prepare(
      "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Fixture ambiguity')",
    ).run(a.taskId);
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason) VALUES (?, 'Fixture archive')",
    ).run(a.taskId);
    state = new ExecutionState(db);
    assert.equal(state.taskHold(a.taskId), "Fixture ambiguity");
    assert.equal(state.isTaskStopped(a.taskId), true);
    assert.equal(state.hasNonStopTaskHold(a.taskId), true);
    db.prepare(
      "UPDATE task_writer_ambiguity_holds SET reason = 'Ambiguity label edited' WHERE taskId = ?",
    ).run(a.taskId);
    assert.equal(state.hasNonStopTaskHold(a.taskId), true);
    db.prepare(
      "UPDATE task_archival_holds SET reason = 'Archive label edited' WHERE taskId = ?",
    ).run(a.taskId);
    assert.equal(state.hasNonStopTaskHold(a.taskId), true);
    assert.equal(state.taskHold(a.taskId), "Ambiguity label edited");
    const recovery = state
      .recoveryForTask(a.taskId)
      .find((item) => item.workId === work.workId);
    assert.equal(recovery?.holds.stop, true);
    assert.equal(
      recovery?.holds.task,
      "Execution state requires operator attention",
      "recovery chooses the independent writer hold before Stop",
    );
    assert.deepEqual(
      rows(
        f,
        "SELECT reason FROM task_writer_holds WHERE taskId = ? ORDER BY reason",
        a.taskId,
      ),
      [{ reason: "Independent writer hold" }, { reason: "Stop label edited" }],
    );

    state.resumeTask(a.taskId);
    assert.equal(state.isTaskStopped(a.taskId), false);
    assert.equal(state.taskHold(a.taskId), "Ambiguity label edited");
    assert.equal(state.hasNonStopTaskHold(a.taskId), true);
    assert.deepEqual(
      rows(
        f,
        "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ?",
        a.taskId,
      ),
      [{ reason: "Independent writer hold", holdKind: null }],
    );
    assert.deepEqual(
      {
        ...db
          .prepare(`SELECT intent.holdKind AS intentKind, request.holdKind AS requestKind
      FROM execution_intents intent JOIN turn_requests request ON request.workId = intent.workId
      WHERE intent.workId = ?`)
          .get(work.workId),
      },
      { intentKind: "operator-stop", requestKind: "operator-stop" },
    );
    state = new ExecutionState(db);
    assert.deepEqual(
      rows(
        f,
        "SELECT reason FROM task_writer_holds WHERE taskId = ?",
        unknown.taskId,
      ),
      [{ reason: "Unrecognized legacy hold" }],
    );
    state.resumeTask(unknown.taskId);
    assert.deepEqual(
      {
        ...db
          .prepare(`SELECT intent.state AS intentState, intent.reason AS intentReason,
      request.state AS requestState, request.reason AS requestReason
      FROM execution_intents intent JOIN turn_requests request ON request.workId = intent.workId
      WHERE intent.workId = ?`)
          .get(unknownWork.workId),
      },
      {
        intentState: "capacity-waiting",
        intentReason: "Task stopped",
        requestState: "queued",
        requestReason: "Task stopped",
      },
    );
  } finally {
    db.close();
  }
});

test("Stop migration adds a later scheduler table without reclassifying existing rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("codex");
    new DomainStore(db).migrate();
    new ExecutionState(db);

    const stoppedTask = randomUUID();
    const unknownTask = randomUUID();
    const stoppedWork = `stopped-${randomUUID()}`;
    const unknownWork = `unknown-${randomUUID()}`;
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, ?, 'operator-stop')",
    ).run(stoppedTask, "Edited Stop display");
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Task stopped')",
    ).run(unknownTask);
    const intent = db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, reason, accountType, sandbox, approval) VALUES (?, ?, 'prompt', '/w', 'held', 'Task stopped', 'chatgpt', 'workspaceWrite', 'never')",
    );
    const binding = db.prepare(
      "INSERT INTO task_execution_bindings (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision) VALUES (?, ?, ?, 1, 1, 1, 1)",
    );
    const workTaskPairs: Array<[string, string]> = [
      [stoppedWork, stoppedTask],
      [unknownWork, unknownTask],
    ];
    for (const [workId, taskId] of workTaskPairs) {
      intent.run(randomUUID(), workId);
      binding.run(workId, taskId, randomUUID());
    }

    new SchedulerStore(db);
    const request = db.prepare(
      "INSERT INTO turn_requests (requestKey, workId, kind, taskId, prompt, state, reason) VALUES (?, ?, 'assignment', ?, 'prompt', 'held', 'Task stopped')",
    );
    request.run(randomUUID(), stoppedWork, stoppedTask);
    request.run(randomUUID(), unknownWork, unknownTask);

    let state = new ExecutionState(db);
    const requestKinds = () =>
      db
        .prepare(
          "SELECT workId, holdKind, reason FROM turn_requests ORDER BY workId",
        )
        .all();
    assert.deepEqual(
      requestKinds().map((row) => ({ ...row })),
      [
        {
          workId: stoppedWork,
          holdKind: "operator-stop",
          reason: "Task stopped",
        },
        { workId: unknownWork, holdKind: null, reason: "Task stopped" },
      ].sort((left, right) => left.workId.localeCompare(right.workId)),
    );
    assert.equal(state.isTaskStopped(stoppedTask), true);
    assert.equal(state.isTaskStopped(unknownTask), false);
    assert.equal(state.hasNonStopTaskHold(unknownTask), true);

    state = new ExecutionState(db);
    assert.deepEqual(
      requestKinds().map((row) => ({ ...row })),
      [
        {
          workId: stoppedWork,
          holdKind: "operator-stop",
          reason: "Task stopped",
        },
        { workId: unknownWork, holdKind: null, reason: "Task stopped" },
      ].sort((left, right) => left.workId.localeCompare(right.workId)),
    );
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT reason, holdKind FROM task_writer_holds WHERE taskId = ?",
          )
          .get(stoppedTask),
      },
      { reason: "Edited Stop display", holdKind: "operator-stop" },
    );
  } finally {
    db.close();
  }
});

test("Stop and Resume commands and receipts parse strictly and append to their unions", () => {
  const taskId = randomUUID(),
    key = randomUUID();
  assert.equal(
    operatorCommandSchema.options[0].shape.type.value,
    "task.create",
  );
  for (const type of ["task.stop", "task.resume"]) {
    assert.ok(operatorCommandSchema.safeParse({ type, key, taskId }).success);
    assert.ok(
      operatorCommandSchema.safeParse({ type, key, taskId, expectedVersion: 2 })
        .success,
    );
    for (const extra of [
      { expectedVersion: 0 },
      { reason: "x" },
      { projectId: taskId },
    ])
      assert.equal(
        operatorCommandSchema.safeParse({ type, key, taskId, ...extra })
          .success,
        false,
      );
  }
  const stop = {
    kind: "task-stop",
    key,
    recorded: true,
    taskId,
    cancellationRequested: 0,
  };
  const resume = {
    kind: "task-resume",
    key,
    recorded: true,
    taskId,
    stopCleared: false,
    requeued: 0,
  };
  assert.deepEqual(commandReceiptSchema.parse(stop), stop);
  assert.deepEqual(commandReceiptSchema.parse(resume), resume);
  assert.equal(
    commandReceiptSchema.safeParse({ ...stop, extra: 1 }).success,
    false,
  );
  assert.equal(
    commandReceiptSchema.safeParse({ ...resume, requeued: -1 }).success,
    false,
  );
});
