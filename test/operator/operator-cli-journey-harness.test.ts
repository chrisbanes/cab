import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = join(import.meta.dirname, "../../..");
const harness = join(
  root,
  "test/operator/cli-journey-qualification/live-journey.mjs",
);

test("the harness refuses live or remote execution without explicit flags", async () => {
  for (const args of [
    [],
    ["--live"],
    ["--live", "--max-turns", "3"],
    ["--phase", "remote"],
    [
      "--phase",
      "remote",
      "--data",
      root,
      "--origin",
      "http://x",
      "--port",
      "1",
    ],
    ["--fixture", "--live"],
  ]) {
    const exit = await run(process.execPath, [harness, ...args], {
      cwd: root,
    }).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    assert.equal(exit, 2, args.join(" "));
  }
});
