import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { releasedPreTurnRefusalReason } from "../../src/standalone/pre-turn-failure.js";
import {
  type GenerationMode,
  type PreTurnRuntime,
  servedGeneration,
} from "../fixtures/recovery-generations.js";
import { until } from "../fixtures/until.js";

type World = Awaited<ReturnType<typeof servedGeneration>>;

/** The rows a release changes, so an untouched generation compares equal. */
function holdRows(w: World) {
  let rows: unknown;
  w.s.f.seedPersistedState((db) => {
    const one = (sql: string) => {
      const row = db.prepare(sql).get(w.g.workId);
      return row ? { ...row } : null;
    };
    rows = {
      intent: one(
        "SELECT state, reason, threadId, turnId FROM execution_intents WHERE workId=?",
      ),
      request: one("SELECT state, reason FROM turn_requests WHERE workId=?"),
      capacity: one(
        "SELECT 1 AS held FROM execution_capacity_reservations WHERE workId=?",
      ),
      writer: one("SELECT sequence FROM task_writer_admissions WHERE workId=?"),
      refusal: one(
        "SELECT reason FROM execution_request_refusals WHERE workId=?",
      ),
      preTurnRefusal: one(
        "SELECT origin, stage, failureClass, threadId FROM execution_pre_turn_refusals WHERE workId=?",
      ),
    };
  });
  return rows as {
    intent: { state: string; reason: string };
    request: { state: string; reason: string };
    capacity: unknown;
    writer: unknown;
    refusal: { reason: string } | null;
    preTurnRefusal: unknown;
  };
}

/** Restarts the service, optionally changing its stored state while it is stopped. */
async function restart(w: World, seed?: (db: DatabaseSync) => void) {
  await w.s.f.service.stop();
  if (seed) w.s.f.seedPersistedState(seed);
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    if (String(chunk).includes("held-generation-released"))
      lines.push(String(chunk));
    return write(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    await w.s.f.service.start();
  } finally {
    process.stderr.write = write;
  }
  return lines;
}

for (const [mode, reason] of [
  ["pre-turn-defect", /invalid_value/],
  ["pre-turn-historical", /-32600/],
  ["no-turn", /Runtime stopped/],
] as [GenerationMode, RegExp][])
  test(`startup releases a ${mode} hold with no saved thread or turn`, async (t) => {
    const w = await servedGeneration(t, mode);
    const before = holdRows(w);
    assert.equal(before.intent.state, "held");
    assert.match(before.intent.reason, reason);
    assert.ok(before.capacity && before.writer);
    assert.equal(
      w.s.f.service.startAgainAvailability(w.g.taskId).available,
      false,
    );

    const lines = await restart(w);

    const after = holdRows(w);
    assert.deepEqual(after.intent, {
      ...before.intent,
      reason: releasedPreTurnRefusalReason,
    });
    assert.deepEqual(after.request, {
      state: "held",
      reason: releasedPreTurnRefusalReason,
    });
    assert.equal(after.capacity, null);
    assert.equal(after.writer, null);
    assert.equal(after.refusal?.reason, releasedPreTurnRefusalReason);
    assert.deepEqual(after.preTurnRefusal, {
      origin: "operator-adopted",
      stage: null,
      failureClass: null,
      threadId: null,
    });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0] ?? "").workId, w.g.workId);
    assert.deepEqual(w.s.f.service.startAgainAvailability(w.g.taskId), {
      available: true,
      assignmentId: w.g.assignmentId,
      workId: w.g.workId,
    });
    // A second start finds nothing more to release.
    assert.deepEqual(await restart(w), []);
    assert.deepEqual(holdRows(w), after);

    if (mode !== "pre-turn-defect") return;
    (w.runtime as PreTurnRuntime).resumeError = undefined;
    const receipt = await w.s.f.service.startAgain({
      key: randomUUID(),
      taskId: w.g.taskId,
      expectedVersion: Number(w.s.f.service.domain().task(w.g.taskId).version),
      workId: w.g.workId,
    });
    await until(
      () =>
        w.s.f.service.list().find((i) => i.workId === receipt.workId)?.state ===
        "completed",
      "started again",
    );
  });

const keepers: [string, (db: DatabaseSync, workId: string) => void][] = [
  [
    "a saved thread",
    (db, workId) => {
      db.prepare(
        "UPDATE execution_intents SET threadId='thread-x' WHERE workId=?",
      ).run(workId);
    },
  ],
  [
    "a saved turn",
    (db, workId) => {
      db.prepare(
        "UPDATE execution_recovery_identities SET turnId='turn-x' WHERE workId=?",
      ).run(workId);
    },
  ],
  [
    "a pending effect",
    (db, workId) => {
      db.prepare(
        "INSERT INTO execution_pending_effects (workId, effectKey, state) VALUES (?, 'stop-interrupt', 'pending')",
      ).run(workId);
    },
  ],
  [
    "a known survivor",
    (db, workId) => {
      db.prepare(
        "INSERT INTO execution_pending_effects (workId, effectKey, state) VALUES (?, 'known-survivor', 'pending')",
      ).run(workId);
    },
  ],
  [
    "a task hold",
    (db, workId) => {
      db.prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) SELECT taskId, 'ambiguous' FROM task_execution_bindings WHERE workId=?",
      ).run(workId);
    },
  ],
];
for (const [name, seed] of keepers)
  test(`startup leaves a hold with ${name} unchanged`, async (t) => {
    const w = await servedGeneration(t, "pre-turn-defect");
    await w.s.f.service.stop();
    w.s.f.seedPersistedState((db) => seed(db, w.g.workId));
    await w.s.f.service.start();
    const before = holdRows(w);
    assert.equal(before.intent.state, "held");
    assert.deepEqual(await restart(w), []);
    assert.deepEqual(holdRows(w), before);
    assert.equal(before.refusal, null);
    assert.ok(before.capacity);
  });

test("startup leaves a hold with a runtime witness or an operator Stop unchanged", async (t) => {
  const witnessed = await servedGeneration(t, "pre-turn-runtime");
  let before = holdRows(witnessed);
  assert.deepEqual(await restart(witnessed), []);
  assert.deepEqual(holdRows(witnessed), before);

  const stopped = await servedGeneration(t, "pre-turn-defect");
  const token = (await stopped.s.issue("read-write", "stop")).token;
  const r = await stopped.s.bearer(token, "/api/operator/commands", {
    method: "POST",
    body: { type: "task.stop", key: randomUUID(), taskId: stopped.g.taskId },
  });
  assert.equal(r.status, 200, await r.text());
  before = holdRows(stopped);
  assert.deepEqual(await restart(stopped), []);
  assert.deepEqual(holdRows(stopped), before);
});
