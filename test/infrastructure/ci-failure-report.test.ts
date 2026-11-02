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

test("workflow pagination does not mistake ten short pages for the result ceiling", async () => {
  let page = 0;
  const endpoint =
    "https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs";
  const result = await api.paginateActions(
    endpoint,
    async () => {
      page++;
      return {
        ok: true,
        status: 200,
        headers: new Map([
          [
            "link",
            page < 11 ? `<${endpoint}?page=${page + 1}>; rel="next"` : "",
          ],
        ]),
        body: JSON.stringify({ workflow_runs: [{ id: page }] }),
      };
    },
    { queryKind: "workflow-runs" },
  );
  assert.equal(page, 11);
  assert.equal(result.capped, false);
});

test("pagination refuses endpoint changes, added filters and repeated pages", async () => {
  const endpoint =
    "https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs";
  for (const next of [
    endpoint.replace("ci.yml", "release.yml"),
    `${endpoint}?branch=topic&page=2`,
    endpoint,
  ]) {
    await assert.rejects(
      api.paginateActions(
        endpoint,
        async () => ({
          ok: true,
          status: 200,
          headers: new Map([["link", `<${next}>; rel="next"`]]),
          body: JSON.stringify({ workflow_runs: [] }),
        }),
        { queryKind: "workflow-runs" },
      ),
      /pagination link/,
    );
  }
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

function apiResponse(payload: unknown, headers = new Map()) {
  return {
    ok: true,
    status: 200,
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}
function runRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    head_branch: "main",
    event: "push",
    head_sha: "abc",
    created_at: "2026-11-01T23:59:59.999999Z",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
    html_url: "https://github.com/chrisbanes/cab/actions/runs/10",
    ...overrides,
  };
}

test("collection retains failed attempt before latest success and captures attempt timing and links", async () => {
  const calls: Array<{ url: string; options?: { rawLogs?: boolean } }> = [];
  const transport = async (url: string, options?: { rawLogs?: boolean }) => {
    calls.push({ url, options });
    if (url.includes("/workflows/ci.yml/runs"))
      return apiResponse({ workflow_runs: [runRecord(), runRecord()] });
    if (url.includes("attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 101,
            name: "service shard 1",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-11-01T10:00:00Z",
            completed_at: "2026-11-01T10:01:00Z",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/10/job/101",
          },
        ],
      });
    if (url.includes("attempts/2/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 102,
            name: "service shard 1",
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-01T10:02:00Z",
            completed_at: "2026-11-01T10:03:00Z",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/10/job/102",
          },
        ],
      });
    if (url.endsWith("/jobs/101/logs"))
      return apiResponse(
        "\u001b[31m2026-11-01T10:00:10Z ✖ spec failed (10ms)\u001b[0m",
      );
    throw Error(`unexpected endpoint ${url}`);
  };
  const report = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport,
  });
  assert.equal(report.denominator, 1);
  assert.equal(report.observedFailures, 1);
  assert.equal(report.runs[0].attempts.length, 2);
  assert.equal(
    report.runs[0].attempts[0].failures[0].failure.name,
    "spec failed",
  );
  assert.equal(report.runs[0].attempts[1].startedAt, "2026-11-01T10:02:00Z");
  assert.match(report.runs[0].attempts[0].url, /attempts\/1$/);
  assert.equal(
    calls.filter((c) => c.url.includes("/workflows/ci.yml/runs")).length,
    1,
  );
  assert.ok(
    calls.find((c) => c.url.endsWith("/jobs/101/logs"))?.options?.rawLogs,
  );
  assert.ok(calls.every((c) => !/POST|PATCH|DELETE/.test(c.url)));
});

test("failed jobs with unavailable or markerless logs remain known failures and incomplete", async () => {
  const transport = async (url: string) => {
    if (url.includes("/workflows/ci.yml/runs"))
      return apiResponse({
        workflow_runs: [runRecord({ run_attempt: 1, conclusion: "failure" })],
      });
    if (url.includes("/attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 201,
            name: "expired log",
            status: "completed",
            conclusion: "failure",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/10/job/201",
          },
          {
            id: 202,
            name: "no marker",
            status: "completed",
            conclusion: "failure",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/10/job/202",
          },
        ],
      });
    if (url.endsWith("/jobs/201/logs"))
      return { ok: false, status: 410, headers: new Map(), body: "" };
    if (url.endsWith("/jobs/202/logs"))
      return apiResponse("Build failed; no test marker");
    throw Error("unexpected request");
  };
  const report = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport,
  });
  const run = report.runs[0];
  assert.equal(report.observedFailures, 1);
  assert.equal(run.hasFailedJob, true);
  assert.equal(run.incomplete, true);
  assert.deepEqual(
    run.coverage.map((x: { reason: string }) => x.reason).sort(),
    ["failed-job-log-unavailable", "failed-job-log-without-test-marker"],
  );
});

test("cancelled, in-progress and unknown conclusions retain explicit linked coverage", async () => {
  const records = [
    runRecord({ id: 11, run_attempt: 1, conclusion: "cancelled" }),
    runRecord({
      id: 12,
      run_attempt: 1,
      status: "in_progress",
      conclusion: null,
    }),
    runRecord({
      id: 13,
      head_branch: null,
      run_attempt: 1,
      conclusion: "neutral",
    }),
  ];
  const transport = async (url: string) =>
    url.includes("/workflows/ci.yml/runs")
      ? apiResponse({ workflow_runs: records })
      : apiResponse({ jobs: [] });
  const report = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport,
  });
  assert.equal(report.denominator, 0);
  assert.equal(report.runs.length, 0);
  assert.deepEqual(
    report.otherBranchFailures.map((r: { id: number }) => r.id),
    [],
  );
  assert.equal(report.incomplete, 2);
  assert.equal(report.coverageRuns.length, 3);
  assert.ok(
    report.coverageRuns.every(
      (r: { coverage: unknown[] }) => r.coverage.length > 0,
    ),
  );
});

test("report options reject impossible dates, invalid ranges and unsafe top limits", () => {
  for (const options of [
    { since: "2026-02-30", until: "2026-03-01" },
    { since: "2026-11-01", until: "2026-10-31" },
    { since: "2026-09-01", until: "2026-10-10" },
    { since: "2026-10-19", until: "2026-11-01", top: 0 },
    { since: "2026-10-19", until: "2026-11-01", top: 1.5 },
    { since: "2026-10-19", until: "2026-11-01", top: "1.0" },
    { since: "2026-10-19", until: "2026-11-01", top: 101 },
  ])
    assert.throws(() => api.validateReportOptions(options));
  assert.doesNotThrow(() =>
    api.validateReportOptions({
      since: "2026-10-19",
      until: "2026-11-01",
      top: 20,
    }),
  );
});

test("malformed run records fail closed and workflow API failures are visible", async () => {
  await assert.rejects(
    api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: async () => apiResponse({ workflow_runs: [{ id: "bad" }] }),
    }),
    /Malformed workflow run/,
  );
  await assert.rejects(
    api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: async () => ({
        ok: false,
        status: 503,
        headers: new Map(),
        body: "",
      }),
    }),
    /503/,
  );
});
