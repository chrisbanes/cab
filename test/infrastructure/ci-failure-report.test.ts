import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const api = await import(
  pathToFileURL(resolve("scripts/report-ci-failures.mjs")).href
);

test("log parsing strips terminal controls and collapses repeated test summary lines", () => {
  const line = "✖ 1 test failed (test/foo.test.ts:4:9)";
  assert.deepEqual(api.parseFailureLog(`\x1b[31m${line}\x1b[0m`), [
    { name: "test failed", file: "test/foo.test.ts", line: 4, column: 9 },
  ]);
});

test("parses timestamped Node test failures without requiring source locations", () => {
  const line =
    "2026-11-01T23:37:03.5741954Z ✖ New profile starts on the first enabled runtime: Claude when Codex is disabled (2115.760498ms)";
  assert.deepEqual(api.parseFailureLog(`✖ failing tests:\n${line}\n${line}`), [
    {
      name: "New profile starts on the first enabled runtime: Claude when Codex is disabled",
      duration: "2115.760498ms",
    },
  ]);
});

test("keeps sanitized unparsed failure evidence but ignores section headers", () => {
  assert.deepEqual(
    api.parseFailureLog("✖ failing tests:\n✖ build failed <token-secret>"),
    [{ name: "build failed [redacted]", unknown: true }],
  );
});

test("attempt identity preserves jobs and attempts while removing duplicate progress output", () => {
  const failure = { name: "bad", file: "x.test.ts", line: 1 };
  const entries = [1, 1, 2].map((attempt) => ({
    runId: 1,
    attempt,
    jobId: 4,
    failure,
  }));
  assert.equal(api.dedupeAttemptFailures(entries).length, 2);
});

test("denominator counts distinct main push runs and incomplete coverage cannot meet target", () => {
  const runs = [
    {
      id: 1,
      branch: "main",
      event: "push",
      createdAt: "2026-10-19T12:00:00Z",
      conclusion: "success",
      attempts: [],
    },
    {
      id: 1,
      branch: "main",
      event: "push",
      createdAt: "2026-10-19T12:00:00Z",
      conclusion: "success",
      attempts: [],
    },
    {
      id: 2,
      branch: "renovate",
      event: "pull_request",
      createdAt: "2026-10-19T12:00:00Z",
      conclusion: "failure",
      attempts: [],
    },
  ];
  const report = api.aggregateFailureReport({
    since: "2026-10-19",
    until: "2026-11-01",
    runs,
    complete: false,
  });
  assert.equal(report.denominator, 1);
  assert.equal(report.verdict, "insufficient-evidence");
  assert.equal(report.upperBound, 1);
});

test("failed attempts count once even without parsed test names, and incomplete IDs are unioned", () => {
  const runs = [
    {
      id: 1,
      branch: "main",
      event: "push",
      createdAt: "2026-10-19T12:00:00Z",
      conclusion: "failure",
      attempts: [],
    },
    {
      id: 2,
      branch: "main",
      event: "push",
      createdAt: "2026-10-20T12:00:00Z",
      conclusion: "success",
      attempts: [{ number: 1, failures: [{ jobId: 4, unknown: true }] }],
      incomplete: true,
    },
    {
      id: 3,
      branch: "topic",
      event: "push",
      createdAt: "2026-10-21T12:00:00Z",
      conclusion: "failure",
      attempts: [{ failures: [{ jobId: 5, name: "topic test" }] }],
    },
    {
      id: 4,
      branch: "main",
      event: "push",
      createdAt: "2026-10-22T12:00:00Z",
      conclusion: "cancelled",
      attempts: [],
    },
  ];
  const report = api.aggregateFailureReport({
    since: "2026-10-19",
    until: "2026-11-01",
    runs,
  });
  assert.equal(report.denominator, 2);
  assert.equal(report.observedFailures, 2);
  assert.equal(report.unclassified, 2);
  assert.equal(report.incomplete, 2);
  assert.equal(report.upperBound, 1);
  assert.equal(report.verdict, "insufficient-evidence");
  assert.equal(report.otherBranchFailures.length, 1);
});

test("a clean complete fourteen-day denominator can meet, but excluded evidence is not unrelated", () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    branch: "main",
    event: "push",
    createdAt: `2026-10-${String(19 + Math.floor(i / 2)).padStart(2, "0")}T12:00:00Z`,
    conclusion: "success",
    attempts: [],
  }));
  assert.equal(
    api.aggregateFailureReport({
      since: "2026-10-19",
      until: "2026-11-01",
      runs,
    }).verdict,
    "met",
  );
  const excluded = [
    {
      id: 21,
      branch: "main",
      event: "push",
      createdAt: "2026-10-20T12:00:00Z",
      conclusion: "failure",
      attempts: [{ failures: [] }],
      classification: "excluded-evidence",
    },
  ];
  const report = api.aggregateFailureReport({
    since: "2026-10-19",
    until: "2026-11-01",
    runs: [...runs, ...excluded],
  });
  assert.equal(report.confirmedUnrelated, 0);
});

test("pagination follows pages and reports the 1000 result ceiling", async () => {
  let calls = 0;
  const result = await api.paginateActions(
    "https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs?created=2026-10-19..2026-11-01",
    async (_url: string) => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: new Map([
          [
            "link",
            calls === 1
              ? '<https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs?created=2026-10-19..2026-11-01&page=2>; rel="next"'
              : "",
          ],
        ]),
        body: JSON.stringify({
          workflow_runs:
            calls === 1 ? Array.from({ length: 100 }, (_, i) => i) : [100],
        }),
      };
    },
    { queryKind: "workflow-runs" },
  );
  assert.equal(calls, 2);
  assert.equal(result.capped, false);
  assert.equal(result.items.length, 101);
});

test("follows Link next despite a short page and exact URLs use the injected read transport", async () => {
  const urls: string[] = [];
  const result = await api.paginateActions(
    "https://api.github.com/repos/chrisbanes/cab/actions/runs/4/attempts/1/jobs?per_page=100",
    async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        headers: new Map([
          [
            "link",
            urls.length === 1
              ? '<https://api.github.com/repos/chrisbanes/cab/actions/runs/4/attempts/1/jobs?per_page=100&page=2>; rel="next"'
              : "",
          ],
        ]),
        body: JSON.stringify({
          jobs: urls.length === 1 ? [{ id: 1 }] : [{ id: 2 }],
        }),
      };
    },
  );
  assert.equal(result.items.length, 2);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.get("per_page"), "100");
});

test("full jobs pages have no workflow-query ceiling, malformed payloads and API errors fail", async () => {
  let page = 0;
  const result = await api.paginateActions(
    "https://api.github.com/repos/chrisbanes/cab/actions/runs/4/attempts/1/jobs",
    async () => {
      page++;
      const next =
        page < 11
          ? `<https://api.github.com/repos/chrisbanes/cab/actions/runs/4/attempts/1/jobs?page=${page + 1}>; rel="next"`
          : "";
      return {
        ok: true,
        status: 200,
        headers: new Map([["link", next]]),
        body: JSON.stringify({ jobs: Array(100).fill({ id: page }) }),
      };
    },
  );
  assert.equal(result.items.length, 1100);
  assert.equal(result.capped, false);
  await assert.rejects(
    api.paginateActions(
      "https://api.github.com/repos/chrisbanes/cab/actions/runs/1/attempts/1/jobs",
      async () => ({ ok: true, status: 200, headers: new Map(), body: "{}" }),
    ),
    /Malformed Actions/,
  );
  await assert.rejects(
    api.paginateActions(
      "https://api.github.com/repos/chrisbanes/cab/actions/runs/1/attempts/1/jobs",
      async () => ({ ok: false, status: 403, headers: new Map(), body: "" }),
    ),
    /403/,
  );
});

test("workflow run pagination marks the API 1000-result ceiling, but not other queries", async () => {
  let page = 0;
  const result = await api.paginateActions(
    "https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs",
    async () => {
      page++;
      const link =
        page < 10
          ? `<https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs?page=${page + 1}>; rel="next"`
          : "";
      return {
        ok: true,
        status: 200,
        headers: new Map([["link", link]]),
        body: JSON.stringify({ workflow_runs: Array(100).fill({ id: page }) }),
      };
    },
    { queryKind: "workflow-runs" },
  );
  assert.equal(page, 10);
  assert.equal(result.capped, true);
});

test("Renovate exclusion requires exact guard evidence", () => {
  const line = { raw: "the pinned SDK is the qualified version" };
  assert.equal(
    api.classifyRunEvidence({}, [line], false).classification,
    "unclassified",
  );
  assert.equal(
    api.classifyRunEvidence({}, [line], true).classification,
    "excluded-evidence",
  );
});

test("a confirmed failure with incomplete coverage counts once in the upper bound", () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    branch: "main",
    event: "push",
    createdAt: "2026-10-20T12:00:00Z",
    conclusion: i ? "success" : "failure",
    classification: i ? "clean" : "confirmed-unrelated",
    incomplete: !i,
    attempts: [],
  }));
  const report = api.aggregateFailureReport({
    since: "2026-10-19",
    until: "2026-11-01",
    runs,
  });
  assert.equal(report.confirmedUnrelated, 1);
  assert.equal(report.incomplete, 1);
  assert.equal(report.lowerBound, 1 / 20);
  assert.equal(report.upperBound, 1 / 20);
  assert.equal(report.verdict, "insufficient-evidence");
});
