import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const timings = await import(
  pathToFileURL(resolve("scripts/test-timings.mjs")).href
);

test("timing weights are selected independently for each browser profile", () => {
  const document = {
    profiles: {
      all: { milliseconds: { browser: 900, service: 100 } },
      chromium: { milliseconds: { browser: 400, service: 100 } },
      service: { milliseconds: { browser: 10, service: 100 } },
    },
  };
  for (const profile of ["all", "chromium", "service"] as const)
    assert.equal(
      timings.profileTimings(document, profile),
      document.profiles[profile].milliseconds,
    );
  assert.throws(() => timings.profileTimings(document, "missing"));
});

test("file timing receipts ignore individual and nested cases and retain failed files", () => {
  const metadata = {
    profile: "service",
    nodeVersion: "v26.9.0",
    inputDigest: "digest",
  };
  const file = resolve("dist/test/execution/runtime.test.js");
  const data = {
    nesting: 0,
    name: file,
    file,
    details: { duration_ms: 123.1, passed: true },
  };
  assert.deepEqual(
    timings.timingRecord({ type: "test:complete", data }, metadata),
    {
      ...metadata,
      file: "test/execution/runtime.test.ts",
      milliseconds: 124,
      passed: true,
    },
  );
  assert.equal(
    timings.timingRecord(
      {
        type: "test:complete",
        data: { ...data, name: "dist/test/execution/runtime.test.js" },
      },
      metadata,
    ).milliseconds,
    124,
  );
  for (const event of [
    { type: "test:pass", data },
    { type: "test:complete", data: { ...data, nesting: 1 } },
    { type: "test:complete", data: { ...data, entryFile: file } },
    { type: "test:complete", data: { ...data, name: "user case" } },
  ])
    assert.equal(timings.timingRecord(event, metadata), null);
  assert.equal(
    timings.timingRecord(
      {
        type: "test:complete",
        data: { ...data, details: { duration_ms: 1, passed: false } },
      },
      metadata,
    ).passed,
    false,
  );
});

test("refreshing weights requires successful current receipts for the complete inventory", () => {
  const files = ["test/operator/a.test.ts", "test/execution/b.test.ts"];
  const records = files.map((file, index) => ({
    file,
    milliseconds: index + 10,
    passed: true,
    profile: "service",
    nodeVersion: "v26.9.0",
    inputDigest: "current",
  }));
  const measure = (values: unknown[]) =>
    timings.measuredProfile(values, files, "service", 26, "current");
  assert.deepEqual(
    measure([
      ...records,
      { ...records[0], profile: "all" },
      { ...records[0], nodeVersion: "v24.21.0" },
    ]).milliseconds,
    {
      "test/execution/b.test.ts": 11,
      "test/operator/a.test.ts": 10,
    },
  );
  for (const invalid of [
    records.slice(1),
    [...records, records[0]],
    [{ ...records[0], passed: false }, records[1]],
    [{ ...records[0], passed: "true" }, records[1]],
    [{ ...records[0], inputDigest: "stale" }, records[1]],
    [{ ...records[0], milliseconds: -1 }, records[1]],
    [...records, { ...records[0], file: "test/operator/removed.test.ts" }],
  ])
    assert.throws(() => measure(invalid));
});
