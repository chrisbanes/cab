import assert from "node:assert/strict";
import { test } from "node:test";
import { CommitGate } from "../../web/src/commit-gate.js";

test("a callback after render waits for the commit that shows the latest change and is dropped on discard", () => {
  const gate = new CommitGate();
  const runs: string[] = [];
  gate.afterRender(() => runs.push("fresh"));
  assert.deepEqual(runs, ["fresh"]);

  const before = gate.revision;
  gate.changed();
  gate.changed();
  gate.afterRender(() => runs.push("changed"));
  // A commit that predates the later change does not show it.
  gate.committed(before + 1);
  assert.deepEqual(runs, ["fresh"]);
  gate.committed(gate.revision);
  assert.deepEqual(runs, ["fresh", "changed"]);
  // Each callback runs once.
  gate.committed(gate.revision);
  assert.deepEqual(runs, ["fresh", "changed"]);

  gate.changed();
  gate.afterRender(() => runs.push("abandoned"));
  gate.discard();
  gate.committed(gate.revision);
  assert.deepEqual(runs, ["fresh", "changed"]);
});
