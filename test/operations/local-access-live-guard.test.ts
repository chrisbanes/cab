import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const HARNESS = resolve(
  "test/operations/service-lifecycle-qualification/live-service-lifecycle.mjs",
);

/** The harness, with a PATH that has no launchctl, so a guard bypass could not reach launchd. */
const harness = (...args: string[]) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    encoding: "utf8",
    env: { PATH: "/nonexistent", HOME: "/nonexistent" },
    timeout: 30_000,
  });

test("the local-access live smoke refuses without --live, outside its disposable label and on port 8787", () => {
  const refused = harness("--local-access");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /without --live/);

  const plan = harness("--local-access", "--dry-run");
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout), {
    mode: "local-access",
    dryRun: true,
    label: "local.cab.validation-1414-00000000",
    port: 18787,
    home: "disposable",
    cliConfig: "disposable",
    savedConnections: "none",
    tokens: "never read",
  });

  for (const [args, pattern] of [
    [["--label", "local.cab.service"], /refusing label local\.cab\.service/],
    [["--label", "local.cab.validation-1414-xyz"], /refusing label/],
    [["--label", "local.cab.validation-9999-00000000"], /refusing label/],
    [["--port", "8787"], /refusing port 8787/],
    [["--port", "80"], /refusing port 80/],
  ] as const) {
    const r = harness("--local-access", "--dry-run", ...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, pattern);
    assert.equal(r.stdout, "");
  }

  // A live run never takes a caller's label or port.
  const chosen = harness(
    "--local-access",
    "--live",
    "--label",
    "local.cab.validation-1414-00000000",
  );
  assert.equal(chosen.status, 2);
  assert.match(chosen.stderr, /chooses its own disposable label/);
});
