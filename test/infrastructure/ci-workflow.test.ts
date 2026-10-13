import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { ciFailures } = (await import(
  pathToFileURL(resolve("scripts/check-ci-results.mjs")).href
)) as {
  ciFailures(jobs: unknown, full: boolean): string[];
};
function successful(full: boolean) {
  return {
    quality: { result: "success" },
    suites: { result: "success" },
    "service-node26": { result: full ? "skipped" : "success" },
    "compatibility-node26": { result: full ? "success" : "skipped" },
  };
}
test("aggregate check accepts complete PR and compatibility runs", () => {
  assert.deepEqual(ciFailures(successful(false), false), []);
  assert.deepEqual(ciFailures(successful(true), true), []);
});
test("failed, cancelled, missing and unexpectedly skipped applicable jobs cannot pass check", () => {
  for (const full of [false, true]) {
    const expected = successful(full);
    for (const [name, entry] of Object.entries(expected)) {
      if (entry.result !== "success") continue;
      for (const result of ["failure", "cancelled", "skipped", "pending"])
        assert.ok(
          ciFailures({ ...expected, [name]: { result } }, full).length,
          `${name} ${result}`,
        );
      const missing: Record<string, { result: string }> = { ...expected };
      delete missing[name];
      assert.ok(ciFailures(missing, full).length);
    }
    assert.ok(
      ciFailures({ ...expected, extra: { result: "success" } }, full).length,
    );
  }
  assert.ok(ciFailures(null, false).length);
  assert.ok(ciFailures([], false).length);
});
