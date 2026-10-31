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

const receipt = (file: string, milliseconds: number, extra = {}) => ({
  file,
  milliseconds,
  passed: true,
  profile: "service",
  nodeVersion: "v26.9.0",
  ...extra,
});
const existing = {
  milliseconds: {
    "test/execution/b.test.ts": 500,
    "test/operator/a.test.ts": 400,
    "test/operator/gone.test.ts": 300,
  },
};
const files = [
  "test/operator/a.test.ts",
  "test/execution/b.test.ts",
  "test/sources/c.test.ts",
];
const measure = (records: unknown[]) =>
  timings.measuredProfile(records, files, existing, "service", 26);

test("a partial receipt set updates only the measured files and keeps the others", () => {
  const profile = measure([
    receipt("test/operator/a.test.ts", 10),
    receipt("test/operator/a.test.ts", 99, { profile: "all" }),
    receipt("test/operator/a.test.ts", 98, { nodeVersion: "v24.21.0" }),
  ]);
  assert.deepEqual(profile.milliseconds, {
    "test/execution/b.test.ts": 500,
    "test/operator/a.test.ts": 10,
  });
  assert.equal(profile.nodeMajor, 26);
  assert.deepEqual(Object.keys(profile.milliseconds), [
    "test/execution/b.test.ts",
    "test/operator/a.test.ts",
  ]);
});

test("refreshing weights prunes files that are no longer in the current list", () => {
  const profile = measure([
    receipt("test/sources/c.test.ts", 7),
    receipt("test/operator/removed.test.ts", 8),
  ]);
  assert.deepEqual(profile.milliseconds, {
    "test/execution/b.test.ts": 500,
    "test/operator/a.test.ts": 400,
    "test/sources/c.test.ts": 7,
  });
});

test("refreshing weights skips unsuccessful or invalid receipts and keeps the old weight", () => {
  for (const invalid of [
    receipt("test/operator/a.test.ts", 10, { passed: false }),
    receipt("test/operator/a.test.ts", 10, { passed: "true" }),
    receipt("test/operator/a.test.ts", -1),
    receipt("test/operator/a.test.ts", Number.NaN),
  ])
    assert.equal(
      measure([invalid]).milliseconds["test/operator/a.test.ts"],
      400,
    );
});

test("refreshing weights rejects a duplicate receipt for one file", () => {
  assert.throws(
    () =>
      measure([
        receipt("test/operator/a.test.ts", 10),
        receipt("test/operator/a.test.ts", 11),
      ]),
    /Duplicate timing receipt/,
  );
});
