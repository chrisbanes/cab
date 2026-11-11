import assert from "node:assert/strict";
import { test } from "node:test";
import { startCliOperator } from "../fixtures/operator-cli.js";
import { startedOf } from "../fixtures/service-internals.js";

type Operator = Awaited<ReturnType<typeof startCliOperator>>;

/** A repository-free workspace held as `holdReleasable`, which a recheck can lift. */
async function held(o: Operator, holdReleasable: 0 | 1) {
  await startedOf(o.s.f.service).workspaces.provision(o.s.taskId);
  o.s.f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE task_workspace_bindings SET state = 'held', reason = 'Task workspace unavailable: test hold', holdReleasable = ? WHERE taskId = ?",
      )
      .run(holdReleasable, o.s.taskId),
  );
}

test("task workspace-recheck validates its task argument", async (t) => {
  const o = await startCliOperator(t);
  for (const args of [[], ["not-a-uuid"]]) {
    const r = await o.cli("rw", ["task", "workspace-recheck", ...args]);
    assert.equal(r.code, 2, r.err + r.out);
  }
});

test("task workspace-recheck releases a releasable hold and reports it", async (t) => {
  const o = await startCliOperator(t);
  await held(o, 1);
  let r = await o.cli("rw", ["task", "workspace-recheck", o.s.taskId]);
  assert.equal(r.code, 0, r.err + r.out);
  const data = r.json().data;
  assert.equal(data.effect, "saved");
  assert.equal(data.receipt.kind, "workspace-recheck");
  assert.equal(data.receipt.released, true);
  assert.equal(
    startedOf(o.s.f.service).workspaceBindings.get(o.s.taskId)?.state,
    "ready",
  );
  r = await o.h.run([
    "task",
    "workspace-recheck",
    o.s.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /Rechecked the workspace of task/);
  assert.match(r.out, /Released:\s+no/);
  assert.match(r.out, /The workspace was not held; nothing changed\./);
});

test("task workspace-recheck refuses a hold that needs a person, and a read-only credential", async (t) => {
  const o = await startCliOperator(t);
  await held(o, 0);
  let r = await o.cli("ro", ["task", "workspace-recheck", o.s.taskId]);
  assert.equal(r.code, 3, r.err + r.out);
  r = await o.h.run([
    "task",
    "workspace-recheck",
    o.s.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 4, r.err + r.out);
  assert.match(
    r.err + r.out,
    /This workspace hold needs a person's judgement and cannot be rechecked: test hold \(conflict/,
  );
  assert.equal(
    startedOf(o.s.f.service).workspaceBindings.get(o.s.taskId)?.state,
    "held",
  );
});
