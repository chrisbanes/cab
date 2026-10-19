import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("the live drafting run refuses to start without --live", () => {
  const run = spawnSync(
    process.execPath,
    ["test/execution/drafting-qualification/live-drafting.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /explicit --live flag/);
  assert.equal(run.stdout, "");
});
