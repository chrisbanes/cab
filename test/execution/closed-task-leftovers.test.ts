import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  nextActor,
  taskColumnOf,
} from "../../src/operator/task-presentation.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { refusedTask } from "../fixtures/refused-task.js";
import { ManualRestartClock } from "../fixtures/restart-clock.js";
import { databaseOf, startedOf } from "../fixtures/service-internals.js";
import { HOST_BOOT_DIFFERS } from "../../src/standalone/termination.js";
import { boundWorld } from "./bound-turn-recovery-fixture.js";

type World = Awaited<ReturnType<typeof boundWorld>>;

/** A held bound turn that held-turn release leaves alone: no event, a manual clock, no exit proof. */
async function closedWorld(t: { after(fn: () => unknown): void }) {
  const clock = new ManualRestartClock();
  const w = await boundWorld(t, "codex", [], false, false, {
    mode: "unknown",
    heldTurnRelease: { clock, wallNow: clock.wallNow },
  });
  const service = w.s.f.service;
  const api = new OperatorApi(service);
  const db = () => databaseOf(service);
  const held = (table: string) =>
    db().prepare(`SELECT 1 FROM ${table} WHERE workId=?`).get(w.g.workId) !==
    undefined;
  const close = (state: "done" | "cancelled") => {
    const d = service.domain();
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.g.projectId,
      taskId: w.g.taskId,
      expectedVersion: Number(d.task(w.g.taskId).version),
      state,
    });
  };
  const read = async () => {
    const { data } = await api.readTask(w.g.taskId);
    const column = taskColumnOf(data);
    return {
      execution: data.execution,
      column,
      next: nextActor(data.attention.codes, column).text,
      codes: data.attention.codes,
    };
  };
  const check = () => service.checkClosedTaskLeftovers(0);
  /** A restart forgets the lost submission, as an upgrade does; startup records the verdict. */
  const restart = async () => {
    await service.stop();
    await service.start();
  };
  const addHolds = () => {
    db()
      .prepare(
        "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Legacy writer hold')",
      )
      .run(w.g.taskId);
    db()
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Legacy work revision order is ambiguous')",
      )
      .run(w.g.taskId);
    db()
      .prepare(
        "INSERT INTO task_archival_holds (taskId, reason) VALUES (?, 'Task archival in progress')",
      )
      .run(w.g.taskId);
  };
  return {
    ...w,
    service,
    api,
    db,
    held,
    close,
    read,
    check,
    restart,
    addHolds,
  };
}

/** The 409's fixed text names the refusal code. */
const refused = (code: string) => (error: unknown) =>
  (error as { publicMessage?: string }).publicMessage?.startsWith(
    `${code}:`,
  ) === true;

const retire = (
  w: Awaited<ReturnType<typeof closedWorld>>,
  digest: string,
  key = randomUUID(),
) =>
  w.api.execute({
    type: "recovery.retire",
    key,
    taskId: w.g.taskId,
    digest,
    reason: "Closed before the hold could settle",
  });

test("a held turn on a closed task settles once its process is proved gone and frees its slot", async (t) => {
  const w = await closedWorld(t);
  w.close("done");
  await w.restart();
  // No exit proof: unsettled, not live.
  let r = await w.read();
  assert.equal(r.column, "Done");
  assert.deepEqual(r.execution.reasonCodes, ["execution-not-settled"]);
  assert.equal(r.next, "Next: you · retire leftover execution");
  assert.ok(!r.codes.includes("execution-uncertain"));

  // The process is still present: the task is Uncertain, naming that work.
  w.setMode("live");
  await w.check();
  r = await w.read();
  assert.equal(r.column, "Uncertain");
  assert.ok(r.codes.includes("execution-uncertain"));
  const live = (await w.api.readLeftoverExecution(w.g.taskId)).data;
  assert.equal(live.refusal, "live-turn");
  assert.deepEqual(
    live.items.map((i) => i.kind === "request" && [i.status, i.reason]),
    [["live", "Execution process is still present"]],
  );
  await assert.rejects(retire(w, live.digest), refused("live-turn"));

  // A conflict that does not show the process ended proves nothing.
  w.setMode("conflict");
  await w.check();
  assert.equal(w.held("execution_capacity_reservations"), true);
  // A different host boot proves it ended: settled, with writer and capacity freed.
  Object.assign(startedOf(w.service).supervisor, {
    terminationVerifier: {
      verify: async () => ({ kind: "conflict", reason: HOST_BOOT_DIFFERS }),
    },
  });
  await w.check();
  assert.equal(w.held("execution_capacity_reservations"), false);
  assert.equal(w.held("task_writer_admissions"), false);
  r = await w.read();
  assert.equal(r.column, "Done");
  assert.deepEqual(r.execution.reasonCodes, []);
  assert.equal(r.next, "Next: none · no decision");
  assert.deepEqual(r.codes, []);
  // Final: a later present verdict never downgrades it.
  w.setMode("live");
  await w.check();
  r = await w.read();
  assert.equal(r.column, "Done");
});

test("the startup check records the verdict before admission, and a slow check never blocks a read", async (t) => {
  const w = await closedWorld(t);
  w.close("cancelled");
  await w.service.stop();
  w.setMode("verified");
  await w.service.start();
  assert.equal(w.held("execution_capacity_reservations"), false);
  assert.equal((await w.read()).column, "Cancelled");

  // A held work on another closed task: its check hangs, and the read still answers.
  const w2 = await closedWorld(t);
  w2.close("done");
  await w2.restart();
  let release!: () => void;
  w2.setGate(new Promise<void>((resolve) => (release = resolve)));
  const pending = w2.check();
  const r = await w2.read();
  assert.equal(r.column, "Done");
  release();
  await pending;
});

test("task holds and an unproved turn leave a closed task not settled until the operator retires them", async (t) => {
  const w = await closedWorld(t);
  w.addHolds();
  // An open task's leftovers cannot be retired.
  const open = (await w.api.readLeftoverExecution(w.g.taskId)).data;
  assert.equal(open.refusal, "task-not-closed");
  assert.deepEqual(open.items, []);
  await assert.rejects(retire(w, open.digest), refused("task-not-closed"));

  w.close("cancelled");
  await w.restart();
  let r = await w.read();
  assert.equal(r.column, "Cancelled");
  assert.deepEqual(r.execution.reasonCodes, ["execution-not-settled"]);
  const shown = (await w.api.readLeftoverExecution(w.g.taskId)).data;
  assert.equal(shown.refusal, undefined);
  assert.deepEqual(
    shown.items.map((i) =>
      i.kind === "request"
        ? [i.kind, i.status, i.workId]
        : [i.kind, i.hold, i.workspaceEffects],
    ),
    [
      ["request", "unsettled", w.g.workId],
      ["hold", "ambiguity", false],
      ["hold", "archival", false],
      ["hold", "writer", false],
    ],
  );

  // A stale digest changes nothing.
  const count = (table: string) =>
    (
      w
        .db()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE taskId=?`)
        .get(w.g.taskId) as { n: number }
    ).n;
  await assert.rejects(retire(w, "0".repeat(64)), refused("digest-changed"));
  assert.equal(count("task_writer_holds"), 1);
  assert.equal(w.held("execution_capacity_reservations"), true);

  const key = randomUUID();
  const receipt = await retire(w, shown.digest, key);
  assert.equal(receipt.kind, "recovery-retire");
  assert.ok(receipt.kind === "recovery-retire");
  assert.deepEqual(
    receipt.requests.map((x) => x.workId),
    [w.g.workId],
  );
  assert.deepEqual(
    receipt.holds.map((h) => h.hold),
    ["ambiguity", "archival", "writer"],
  );
  assert.deepEqual(await retire(w, shown.digest, key), receipt);
  for (const table of [
    "task_writer_holds",
    "task_writer_ambiguity_holds",
    "task_archival_holds",
  ])
    assert.equal(count(table), 0, table);
  assert.equal(w.held("execution_capacity_reservations"), false);
  assert.equal(w.held("task_writer_admissions"), false);
  assert.equal(
    w
      .db()
      .prepare("SELECT state FROM turn_requests WHERE workId=?")
      .get(w.g.workId)?.state,
    "held",
  );
  r = await w.read();
  assert.equal(r.column, "Cancelled");
  assert.deepEqual(r.codes, []);
  assert.equal(r.next, "Next: none · history retained");
  assert.equal(
    (await w.api.readLeftoverExecution(w.g.taskId)).data.refusal,
    "nothing-to-retire",
  );
  const operation = await w.api.readOperation(
    new URLSearchParams({
      key,
      scope: `task:${w.g.taskId}`,
      type: "recovery.retire",
    }),
  );
  assert.equal(operation.data.state, "recorded");

  // Reopened, a retired request stays history: it does not make the task Uncertain again.
  w.close("done");
  const d = w.service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.g.projectId,
    taskId: w.g.taskId,
    expectedVersion: Number(d.task(w.g.taskId).version),
    state: "open",
  });
  assert.notEqual((await w.read()).column, "Uncertain");
});

test("a closed task whose turn was reconciled with no successor is Done with nothing to decide", async (t) => {
  const w: World = await boundWorld(t);
  await w.reconcile();
  const service = w.s.f.service;
  const d = service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.g.projectId,
    taskId: w.g.taskId,
    expectedVersion: Number(d.task(w.g.taskId).version),
    state: "done",
  });
  const { data } = await new OperatorApi(service).readTask(w.g.taskId);
  assert.equal(taskColumnOf(data), "Done");
  assert.deepEqual(data.attention.codes, []);
  assert.deepEqual(service.closedTaskLeftovers(w.g.taskId).items, []);
});

test("a closed task whose only leftover was refused before it ran is Done with nothing to decide", async () => {
  const f = await createOperatorFixture();
  try {
    const task = await refusedTask(f);
    const d = f.service.domain();
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: Number(d.task(task.taskId).version),
      state: "done",
    });
    const { data } = await new OperatorApi(f.service, [f.directory]).readTask(
      task.taskId,
    );
    assert.equal(taskColumnOf(data), "Done");
    assert.deepEqual(data.attention.codes, []);
    assert.deepEqual(f.service.closedTaskLeftovers(task.taskId).items, []);
  } finally {
    await f.close();
  }
});

test("a stale present verdict stops counting once another route frees the work", async (t) => {
  const w = await closedWorld(t);
  w.close("done");
  await w.restart();
  w.setMode("live");
  await w.check();
  assert.equal((await w.read()).column, "Uncertain");
  // Held-turn release (or another route) frees writer and capacity without a new verdict.
  for (const table of [
    "execution_capacity_reservations",
    "task_writer_admissions",
  ])
    w.db().prepare(`DELETE FROM ${table} WHERE workId=?`).run(w.g.workId);
  const r = await w.read();
  assert.notEqual(r.column, "Uncertain");
  const listing = (await w.api.readLeftoverExecution(w.g.taskId)).data;
  assert.ok(
    listing.items.every((i) => i.kind !== "request" || i.status !== "live"),
  );
  assert.notEqual(listing.refusal, "live-turn");
});
