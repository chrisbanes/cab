import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DomainConflictError } from "../src/core/domain.js";
import {
  commandReceiptSchema,
  operatorCommandSchema,
} from "../src/operator/contracts.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../src/standalone/operator-api.js";
import { ExecutionState } from "../src/standalone/state.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { startOwnWork } from "./fixtures/questions.js";
import { seedReviewTask } from "./fixtures/task-review.js";

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
      "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,accountType,sandbox,approval) VALUES (?,?,'p','/w','capacity-waiting','Task stopped','chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId);
    db.prepare(
      "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES (?,?,?,1,1,1,1)",
    ).run(workId, b.taskId, b.assignmentId);
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Task stopped')",
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
