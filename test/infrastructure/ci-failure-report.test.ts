import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const api = await import(
  pathToFileURL(resolve("scripts/report-ci-failures.mjs")).href
);

test("real report CLI supports old and new gh log options without retrying other errors", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "cab-report-gh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = resolve(directory, "gh");
  await writeFile(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CAB_FAKE_GH_JOURNAL, JSON.stringify(args) + "\n");
if (args[0] !== "api" || args[args.indexOf("--method") + 1] !== "GET") process.exit(90);
const endpoint = args.at(-1);
const raw = /\/jobs\/\d+\/logs$/.test(endpoint);
const flag = args.includes("--allow-escape-sequences");
const mode = process.env.CAB_FAKE_GH_MODE;
if (raw && mode === "old" && flag) { process.stderr.write("unknown flag: --allow-escape-sequences\n\nUsage: gh api <endpoint> [flags]\n"); process.exit(1); }
if (raw && mode === "new" && !flag) { process.stderr.write("required escape safety flag missing\n"); process.exit(1); }
if (raw && mode === "auth") { process.stderr.write("authentication required: do-not-print\n"); process.exit(1); }
if (raw && mode === "network") { process.stderr.write("error connecting to api.github.com: do-not-print\n"); process.exit(1); }
if (raw && mode === "http") { process.stdout.write("HTTP/2.0 403 Forbidden\r\n\r\n{}"); process.stderr.write("gh: forbidden: do-not-print\n"); process.exit(1); }
let body;
if (endpoint.includes("head_sha=")) body = { workflow_runs: [] };
else if (endpoint.includes("/workflows/ci.yml/runs")) body = { workflow_runs: [{ id: 1, head_branch: "main", event: "push", head_sha: "abc", created_at: "2026-10-20T10:00:00Z", status: "completed", conclusion: "failure", run_attempt: 1, html_url: "https://github.com/chrisbanes/cab/actions/runs/1" }] };
else if (endpoint.includes("/attempts/1/jobs")) body = { jobs: [11,12].map(id => ({ id, name: "shard-" + id, status: "completed", conclusion: "failure", html_url: "https://github.com/chrisbanes/cab/actions/runs/1/job/" + id })) };
else if (raw) body = "\x1b[31m✖ failure " + endpoint.match(/jobs\/(\d+)/)[1] + " (1ms)\x1b[0m\n";
else process.exit(91);
process.stdout.write("HTTP/2.0 200 OK\r\nContent-Type: " + (raw ? "text/plain" : "application/json") + "\r\n\r\n" + (raw ? body : JSON.stringify(body)));
`}`,
    { mode: 0o755 },
  );
  for (const mode of ["old", "new", "auth", "network", "http"]) {
    const journal = resolve(directory, `${mode}.jsonl`);
    const result = await promisify(execFile)(
      process.execPath,
      [
        resolve("scripts/report-ci-failures.mjs"),
        "--since",
        "2026-10-19",
        "--until",
        "2026-11-01",
        "--top",
        "5",
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          CAB_FAKE_GH_MODE: mode,
          CAB_FAKE_GH_JOURNAL: journal,
        },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const report = JSON.parse(result.stdout);
    const calls = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const logs = calls.filter((args) =>
      /\/jobs\/\d+\/logs$/.test(args.at(-1) ?? ""),
    );
    assert.equal(
      report.top.length,
      mode === "old" || mode === "new" ? 2 : 0,
      mode,
    );
    assert.equal(logs.length, mode === "old" ? 3 : 2, mode);
    assert.equal(
      logs.filter((args) => args.includes("--allow-escape-sequences")).length,
      mode === "old" ? 1 : 2,
      mode,
    );
    assert.ok(
      calls.every((args) => args[args.indexOf("--method") + 1] === "GET"),
    );
    assert.ok(
      !result.stdout.includes("do-not-print") &&
        !result.stderr.includes("do-not-print"),
    );
    if (mode === "old" || mode === "new")
      assert.deepEqual(
        report.top.map((entry: { test: string }) => entry.test).sort(),
        ["failure 11", "failure 12"],
      );
    else
      assert.equal(
        report.coverageRuns[0].coverage.filter(
          (entry: { reason: string }) =>
            entry.reason === "failed-job-log-unavailable",
        ).length,
        2,
      );
  }
});

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

test("a current or future UTC window cannot establish the fourteen-day target", () => {
  for (const until of ["2026-11-02", "2026-11-14"]) {
    const since = until === "2026-11-02" ? "2026-10-20" : "2026-11-01";
    const report = api.aggregateFailureReport({
      since,
      until,
      asOf: "2026-11-02T12:00:00Z",
      runs: [
        {
          id: 1,
          branch: "main",
          event: "push",
          createdAt: `${since}T12:00:00Z`,
          conclusion: "success",
        },
      ],
    });
    assert.equal(report.windowElapsed, false);
    assert.equal(report.windowCoverage.reason, "window-not-ended");
    assert.equal(report.verdict, "insufficient-evidence");
    assert.equal(report.incomplete, 1);
    assert.equal(report.upperBound, 1);
  }
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
  const firstUrl = urls[0];
  assert.ok(firstUrl);
  assert.equal(new URL(firstUrl).searchParams.get("per_page"), "100");
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

test("pagination accepts GitHub's repository-ID next links for the queried repository only", async () => {
  const endpoint =
    "https://api.github.com/repos/chrisbanes/cab/actions/workflows/ci.yml/runs";
  const transportFor = (id: number, nextPath: string) => {
    const urls: string[] = [];
    const transport = async (url: string) => {
      urls.push(url);
      if (url === "https://api.github.com/repos/chrisbanes/cab")
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          body: `{"id":${id}}`,
        };
      return {
        ok: true,
        status: 200,
        headers: new Map([
          [
            "link",
            urls.length === 1
              ? `<https://api.github.com${nextPath}?created=a..b&page=2>; rel="next"`
              : "",
          ],
        ]),
        body: JSON.stringify({ workflow_runs: [{ id: urls.length }] }),
      };
    };
    return transport;
  };
  const ok = await api.paginateActions(
    `${endpoint}?created=a..b`,
    transportFor(
      1194815584,
      "/repositories/1194815584/actions/workflows/ci.yml/runs",
    ),
    { queryKind: "workflow-runs" },
  );
  assert.equal(ok.items.length, 2);
  for (const nextPath of [
    "/repositories/999/actions/workflows/ci.yml/runs",
    "/repositories/1194815584/actions/workflows/release.yml/runs",
  ])
    await assert.rejects(
      api.paginateActions(
        `${endpoint}?created=a..b`,
        transportFor(1194815584, nextPath),
        { queryKind: "workflow-runs" },
      ),
      /escaped repository API/,
    );
});

test("Renovate exclusion requires exact guard evidence", () => {
  const line = { name: "the pinned SDK is the qualified version" };
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
    calls.push({ url, ...(options === undefined ? {} : { options }) });
    if (url.includes("/workflows/ci.yml/runs"))
      return apiResponse({ workflow_runs: [runRecord(), runRecord()] });
    if (url.includes("head_sha=")) return apiResponse({ workflow_runs: [] });
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
  assert.equal(calls.filter((c) => c.url.includes("?created=")).length, 1);
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

test("only an exact guard with positively verified Renovate SDK upgrade is excluded", async () => {
  const guardRun = runRecord({
    id: 30,
    head_sha: "guard-sha",
    run_attempt: 1,
    conclusion: "failure",
  });
  const validPr = {
    number: 77,
    html_url: "https://github.com/chrisbanes/cab/pull/77",
    user: { login: "renovate[bot]", type: "Bot" },
    head: { sha: "guard-sha" },
    merged_at: null,
    merge_commit_sha: null,
  };
  const patchText =
    '-    "@anthropic-ai/claude-agent-sdk": "0.3.300",\n+    "@anthropic-ai/claude-agent-sdk": "0.3.301",';
  const makeTransport = (variant: string) => async (url: string) => {
    if (url.includes("?created="))
      return apiResponse({ workflow_runs: [guardRun] });
    if (url.includes("attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 301,
            name: "shard",
            status: "completed",
            conclusion: "failure",
            steps: [
              {
                name: "Run logical suite",
                status: "completed",
                conclusion: "failure",
              },
              {
                name: "Upload synthetic test evidence",
                status: "completed",
                conclusion: "success",
              },
            ],
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/30/job/301",
          },
        ],
      });
    if (url.endsWith("/jobs/301/logs"))
      return apiResponse(
        `✖ the pinned SDK is the qualified version (10ms)${variant === "mixed" ? "\n✖ another failing assertion (8ms)" : ""}`,
      );
    if (url.includes("/commits/guard-sha/pulls")) {
      if (variant === "missing-pr") return apiResponse([]);
      const pr = {
        ...validPr,
        user:
          variant === "ordinary"
            ? { login: "someone", type: "User" }
            : validPr.user,
        head: {
          sha: [
            "changed-head",
            "merged-main",
            "unmerged-main",
            "bad-merge-time",
          ].includes(variant)
            ? "other"
            : "guard-sha",
        },
        merged_at:
          variant === "merged-main"
            ? "2026-10-19T00:00:00Z"
            : variant === "bad-merge-time"
              ? "invalid"
              : null,
        merge_commit_sha: [
          "merged-main",
          "unmerged-main",
          "bad-merge-time",
        ].includes(variant)
          ? "guard-sha"
          : null,
      };
      return apiResponse([pr]);
    }
    if (url.endsWith("/pulls/77/files?per_page=100")) {
      if (variant === "files-unavailable") throw Error("fixture API failure");
      const patch =
        variant === "wrong-sdk"
          ? '- "other": "0.3.300"\n+ "other": "0.3.301"'
          : variant === "downgrade"
            ? '- "@anthropic-ai/claude-agent-sdk": "0.3.301"\n+ "@anthropic-ai/claude-agent-sdk": "0.3.300"'
            : patchText;
      return apiResponse([{ filename: "package.json", patch }]);
    }
    if (url.includes("head_sha=")) return apiResponse({ workflow_runs: [] });
    throw Error(`unexpected ${url}`);
  };
  for (const variant of [
    "ordinary",
    "wrong-sdk",
    "downgrade",
    "missing-pr",
    "changed-head",
    "files-unavailable",
    "unmerged-main",
    "bad-merge-time",
    "mixed",
  ]) {
    const report = await api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: makeTransport(variant),
    });
    assert.equal(
      report.excludedEvidence.length,
      variant === "mixed" ? 1 : 0,
      variant,
    );
    assert.equal(report.observedFailures, 1, variant);
    assert.equal(report.confirmedUnrelated, 0, variant);
    if (variant === "files-unavailable")
      assert.ok(
        report.coverageRuns[0].coverage.some(
          (entry: { reason: string }) =>
            entry.reason === "renovate-metadata-unavailable",
        ),
      );
    if (variant === "mixed") assert.equal(report.unclassified, 1);
  }
  const verified = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport: makeTransport("verified"),
  });
  assert.equal(verified.excludedEvidence.length, 1);
  assert.equal(verified.observedFailures, 0);
  assert.equal(verified.confirmedUnrelated, 0);
  const merged = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport: makeTransport("merged-main"),
  });
  assert.equal(merged.excludedEvidence.length, 1);
  assert.equal(merged.observedFailures, 0);
});

test("same-SHA report separates later runs and later attempts within the inclusive horizon", async () => {
  const sourceRun = runRecord({
    id: 40,
    head_sha: "same-head",
    run_attempt: 2,
    conclusion: "success",
    created_at: "2026-11-01T09:00:00Z",
  });
  const laterRun = runRecord({
    id: 41,
    head_branch: "renovate/topic",
    event: "pull_request",
    head_sha: "same-head",
    run_attempt: 1,
    conclusion: "success",
    created_at: "2026-11-01T11:00:00Z",
    html_url: "https://github.com/chrisbanes/cab/actions/runs/41",
  });
  const beyond = {
    ...laterRun,
    id: 42,
    created_at: "2026-11-02T00:00:00Z",
    html_url: "https://github.com/chrisbanes/cab/actions/runs/42",
  };
  const transport = async (url: string) => {
    if (url.includes("?created="))
      return apiResponse({ workflow_runs: [sourceRun] });
    if (url.includes("head_sha="))
      return apiResponse({ workflow_runs: [sourceRun, laterRun, beyond] });
    if (url.includes("/runs/41/attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 410,
            name: "check",
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-01T12:00:00Z",
            completed_at: "2026-11-01T23:59:59.999999Z",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/41/job/410",
          },
        ],
      });
    if (url.includes("attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 401,
            name: "shard",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-11-01T10:00:00Z",
            completed_at: "2026-11-01T10:01:00Z",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/40/job/401",
          },
        ],
      });
    if (url.endsWith("/jobs/401/logs"))
      return apiResponse("✖ a test failed (5ms)");
    if (url.includes("attempts/2/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 402,
            name: "check",
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-01T10:02:00Z",
            completed_at: "2026-11-01T10:03:00Z",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/40/job/402",
          },
        ],
      });
    throw Error(`unexpected ${url}`);
  };
  const report = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport,
  });
  const corroboration = report.sameShaCorroboration[0];
  assert.equal(
    corroboration.laterPasses.some(
      (pass: { kind: string }) => pass.kind === "later-attempt",
    ),
    true,
  );
  assert.equal(
    corroboration.laterPasses.some(
      (pass: { passingRunId: number }) => pass.passingRunId === 41,
    ),
    true,
  );
  assert.equal(
    corroboration.laterPasses.some(
      (pass: { passingRunId: number }) => pass.passingRunId === 42,
    ),
    false,
  );
  assert.equal(report.denominator, 1);
  assert.equal(report.observedFailures, 1);
});

test("later-pass chronology excludes future attempts and equal timestamps with different precision", async () => {
  for (const startedAt of ["2026-11-02T00:01:00Z", "2026-11-01T22:02:00Z"]) {
    const source = runRecord({
      id: 42,
      run_attempt: 2,
      conclusion: "success",
      created_at: "2026-11-01T22:00:00.000Z",
    });
    const report = await api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: async (url: string) => {
        if (url.includes("created="))
          return apiResponse({ workflow_runs: [source] });
        if (url.includes("head_sha="))
          return apiResponse({
            workflow_runs: [
              {
                ...source,
                id: 43,
                created_at: "2026-11-01T22:00:00Z",
                html_url: "https://github.com/chrisbanes/cab/actions/runs/43",
              },
            ],
          });
        if (url.includes("attempts/")) {
          const passing = url.includes("attempts/2");
          return apiResponse({
            jobs: [
              {
                id: passing ? 2 : 1,
                name: passing ? "check" : "operator-2",
                status: "completed",
                conclusion: passing ? "success" : "failure",
                started_at: passing ? startedAt : "2026-11-01T22:01:00Z",
                completed_at: passing
                  ? startedAt.replace(":01:", ":03:").replace(":02:", ":03:")
                  : "2026-11-01T22:02:00.000Z",
                html_url: `https://github.com/chrisbanes/cab/actions/runs/42/job/${passing ? 2 : 1}`,
              },
            ],
          });
        }
        return apiResponse("✖ example failure (5ms)");
      },
    });
    assert.deepEqual(report.sameShaCorroboration[0].laterPasses, []);
  }
});

test("earlier cancelled or unsupported job outcomes remain incomplete after a successful rerun", async () => {
  for (const conclusion of [
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "unknown-result",
  ]) {
    const report = await api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: async (url: string) => {
        if (url.includes("created="))
          return apiResponse({
            workflow_runs: [
              runRecord({ run_attempt: 2, conclusion: "success" }),
            ],
          });
        if (url.includes("head_sha="))
          return apiResponse({ workflow_runs: [] });
        const later = url.includes("attempts/2");
        return apiResponse({
          jobs: [
            {
              id: later ? 2 : 1,
              name: "check",
              status: "completed",
              conclusion: later ? "success" : conclusion,
              html_url: `https://github.com/chrisbanes/cab/actions/runs/10/job/${later ? 2 : 1}`,
            },
          ],
        });
      },
    });
    assert.equal(report.verdict, "insufficient-evidence", conclusion);
    assert.equal(report.incomplete, 1, conclusion);
    assert.equal(
      report.coverageRuns[0].coverage[0].reason,
      "job-conclusion-unresolved",
    );
    assert.equal(report.coverageRuns[0].coverage[0].conclusion, conclusion);
    assert.ok(report.coverageRuns[0].coverage[0].jobUrl);
  }
});

test("attempt chronology uses numeric extrema across multiple job timestamps", async () => {
  const report = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport: async (url: string) => {
      if (url.includes("created="))
        return apiResponse({
          workflow_runs: [runRecord({ run_attempt: 2, conclusion: "success" })],
        });
      if (url.includes("head_sha=")) return apiResponse({ workflow_runs: [] });
      if (url.endsWith("/logs")) return apiResponse("✖ failure (1ms)");
      if (url.includes("attempts/1"))
        return apiResponse({
          jobs: [
            {
              id: 1,
              name: "operator-2",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-11-01T09:59:00Z",
              completed_at: "2026-11-01T10:00:00.200Z",
              html_url:
                "https://github.com/chrisbanes/cab/actions/runs/10/job/1",
            },
          ],
        });
      return apiResponse({
        jobs: [
          {
            id: 2,
            name: "check",
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-01T10:00:00.500Z",
            completed_at: "2026-11-01T10:01:00Z",
            html_url: "https://github.com/chrisbanes/cab/actions/runs/10/job/2",
          },
          {
            id: 3,
            name: "operator-2",
            status: "completed",
            conclusion: "success",
            started_at: "2026-11-01T10:00:00Z",
            completed_at: "2026-11-01T10:01:00.500Z",
            html_url: "https://github.com/chrisbanes/cab/actions/runs/10/job/3",
          },
        ],
      });
    },
  });
  const attempts = report.runs[0].attempts;
  assert.equal(attempts[1].startedAt, "2026-11-01T10:00:00Z");
  assert.equal(attempts[1].completedAt, "2026-11-01T10:01:00.500Z");
  assert.deepEqual(report.sameShaCorroboration[0].laterPasses, []);
});

test("same-run success with missing chronology is not reported as a later pass", async () => {
  const sourceRun = runRecord({
    id: 50,
    head_sha: "missing-time",
    run_attempt: 2,
    conclusion: "success",
  });
  const transport = async (url: string) => {
    if (url.includes("?created="))
      return apiResponse({ workflow_runs: [sourceRun] });
    if (url.includes("head_sha=")) return apiResponse({ workflow_runs: [] });
    if (url.includes("attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 501,
            name: "shard",
            status: "completed",
            conclusion: "failure",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/50/job/501",
          },
        ],
      });
    if (url.endsWith("/jobs/501/logs"))
      return apiResponse("✖ test fails (2ms)");
    if (url.includes("attempts/2/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 502,
            name: "check",
            status: "completed",
            conclusion: "success",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/50/job/502",
          },
        ],
      });
    throw Error("unexpected endpoint");
  };
  const report = await api.renderReport({
    since: "2026-10-19",
    until: "2026-11-01",
    transport,
  });
  assert.deepEqual(report.sameShaCorroboration[0].laterPasses, []);
});

test("same-SHA lookup failures and 1000-result caps remain explicit coverage", async () => {
  const sourceRun = runRecord({
    id: 60,
    head_sha: "capped-sha",
    run_attempt: 1,
    conclusion: "failure",
  });
  const makeTransport = (mode: string) => async (url: string) => {
    if (url.includes("?created="))
      return apiResponse({ workflow_runs: [sourceRun] });
    if (url.includes("attempts/1/jobs"))
      return apiResponse({
        jobs: [
          {
            id: 601,
            name: "shard",
            status: "completed",
            conclusion: "failure",
            html_url:
              "https://github.com/chrisbanes/cab/actions/runs/60/job/601",
          },
        ],
      });
    if (url.endsWith("/jobs/601/logs"))
      return apiResponse("✖ failed spec (2ms)");
    if (url.includes("head_sha=")) {
      if (mode === "unavailable") throw Error("lookup failed");
      return apiResponse({ workflow_runs: Array(1000).fill({ id: 99 }) });
    }
    throw Error("unexpected endpoint");
  };
  for (const mode of ["unavailable", "capped"]) {
    const report = await api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: makeTransport(mode),
    });
    assert.equal(
      report.sameShaCorroboration[0].status,
      mode === "capped" ? "lookup-capped" : "lookup-unavailable",
    );
    assert.equal(report.runs[0].incomplete, true);
    assert.equal(report.verdict, "insufficient-evidence");
  }
});

function completeAggregateJobs() {
  const names = [
    "changes",
    "quality",
    "workspaces-1",
    "execution-2",
    "operator-2",
    "service-2",
    "integrations-1",
    "service-1",
    "operator-1",
    "execution-1",
    "check",
  ];
  return names.map((name, index) => ({
    id: 700 + index,
    name,
    status: "completed",
    conclusion:
      name === "execution-2" || name === "check" ? "failure" : "success",
    started_at: "2026-11-01T10:00:00Z",
    completed_at: "2026-11-01T10:01:00Z",
    html_url: `https://github.com/chrisbanes/cab/actions/runs/70/job/${700 + index}`,
    steps:
      name === "check"
        ? [
            {
              name: "Run actions/checkout@v7",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "Require every applicable job to succeed",
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "Complete job",
              status: "completed",
              conclusion: "success",
            },
          ]
        : name === "execution-2"
          ? [
              {
                name: "Run logical suite",
                status: "completed",
                conclusion: "failure",
              },
              {
                name: "Upload synthetic test evidence",
                status: "completed",
                conclusion: "success",
              },
            ]
          : [],
  }));
}

const aggregateLog =
  "2026-11-01T10:00:00Z ##[group]Run node scripts/check-ci-results.mjs\n2026-11-01T10:00:00Z RUN_CHECKS: true\n2026-11-01T10:00:00Z ##[endgroup]\n2026-11-01T10:00:01Z suites: expected success, observed failure\n2026-11-01T10:00:01Z ##[error]Process completed with exit code 1.";

test("aggregate failure accounting follows complete dependencies and retains owning failures", async () => {
  for (const variant of [
    "guard",
    "split-topology",
    "ordinary",
    "mixed",
    "checkout",
    "syntax",
    "unavailable",
    "missing-dependency",
    "extra-job",
    "unfinished",
    "unexpected-diagnostic",
    "unexpected-step",
    "malformed-step",
    "guard-upload-failure",
    "guard-steps-missing",
    "guard-step-unresolved",
  ]) {
    const jobs = completeAggregateJobs();
    const check = jobs.find((job) => job.name === "check");
    assert.ok(check);
    const owning = jobs.find((job) => job.name === "execution-2");
    assert.ok(owning);
    if (variant === "guard-upload-failure")
      owning.steps[1]!.conclusion = "failure";
    if (variant === "guard-steps-missing") owning.steps = [];
    if (variant === "guard-step-unresolved")
      owning.steps[1]!.conclusion = "unknown-result";
    if (variant === "checkout") {
      check.steps[0]!.conclusion = "failure";
      check.steps[1]!.conclusion = "success";
    }
    if (variant === "unexpected-step")
      check.steps[1]!.name = "Different command";
    if (variant === "missing-dependency")
      jobs.splice(
        jobs.findIndex((job) => job.name === "service-1"),
        1,
      );
    if (variant === "extra-job")
      jobs.push({ ...jobs[0]!, id: 999, name: "historical-extra-job" });
    if (variant === "split-topology") {
      // Browser-only lanes: execution and workspaces fold into integrations.
      for (const name of ["execution-1", "workspaces-1"])
        jobs.splice(
          jobs.findIndex((job) => job.name === name),
          1,
        );
      owning.name = "operator-3";
      const passing = jobs.find((job) => job.name === "operator-1")!;
      for (const [index, name] of [
        "operator-4",
        "service-3",
        "service-4",
      ].entries())
        jobs.push({ ...passing, id: 711 + index, name });
    }
    if (variant === "unfinished") jobs[0]!.status = "in_progress";
    const ordinary = variant === "ordinary" || variant === "mixed";
    const report = await api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: async (url: string) => {
        if (url.includes("created="))
          return apiResponse({
            workflow_runs: [
              runRecord({
                id: 70,
                head_sha: "aggregate-head",
                run_attempt: 1,
                conclusion: "failure",
              }),
            ],
          });
        if (url.includes("head_sha="))
          return apiResponse({ workflow_runs: [] });
        if (url.includes("/attempts/1/jobs"))
          return apiResponse({
            jobs: jobs.map((job) =>
              variant === "malformed-step" && job.name === "check"
                ? { ...job, steps: [null] }
                : job,
            ),
          });
        if (url.endsWith(`/jobs/${check.id}/logs`)) {
          if (variant === "unavailable")
            return { ok: false, status: 410, headers: new Map(), body: "" };
          return apiResponse(
            variant === "syntax"
              ? "SyntaxError: Unexpected token"
              : variant === "unexpected-diagnostic"
                ? aggregateLog.replace("observed failure", "observed mystery")
                : aggregateLog,
          );
        }
        if (url.endsWith("/jobs/703/logs"))
          return apiResponse(
            `${ordinary ? "✖ independent test fails (5ms)" : "✖ the pinned SDK is the qualified version (5ms)"}${variant === "mixed" ? "\n✖ the pinned SDK is the qualified version (5ms)" : ""}`,
          );
        if (url.includes("/commits/aggregate-head/pulls"))
          return apiResponse([
            {
              number: 77,
              user: { login: "renovate[bot]", type: "Bot" },
              head: { sha: "aggregate-head" },
              html_url: "https://github.com/chrisbanes/cab/pull/77",
            },
          ]);
        if (url.includes("/pulls/77/files"))
          return apiResponse([
            {
              filename: "package.json",
              patch:
                '- "@anthropic-ai/claude-agent-sdk": "0.3.300",\n+ "@anthropic-ai/claude-agent-sdk": "0.3.301",',
            },
          ]);
        throw Error(`Unexpected fixture endpoint ${url}`);
      },
    });
    const positive = ["guard", "split-topology", "ordinary", "mixed"].includes(
      variant,
    );
    const aggregateAccounted = positive || variant.startsWith("guard-");
    const aggregate = report.runs[0].attempts[0].jobs.find(
      (job: { name: string }) => job.name === "check",
    );
    assert.equal(Boolean(aggregate.accountedFor), aggregateAccounted, variant);
    const guarded = variant === "guard" || variant === "split-topology";
    assert.equal(report.observedFailures, guarded ? 0 : 1, variant);
    assert.equal(report.incomplete, positive ? 0 : 1, variant);
    assert.equal(report.confirmedUnrelated, 0, variant);
    if (variant.startsWith("guard-") && variant !== "guard") {
      assert.equal(report.excludedEvidence.length, 1, variant);
      assert.notEqual(
        report.runs[0].classification,
        "excluded-evidence",
        variant,
      );
      assert.ok(
        report.coverageRuns[0].coverage.some(
          (entry: { reason: string; jobId?: number; jobUrl?: string }) =>
            entry.reason.startsWith("guard-job-") &&
            entry.jobId === owning.id &&
            entry.jobUrl === owning.html_url,
        ),
      );
    }
    if (aggregateAccounted) {
      assert.deepEqual(aggregate.accountedFor.diagnostics, [
        "suites: expected success, observed failure",
      ]);
      assert.equal(
        aggregate.accountedFor.dependencies.length,
        variant === "split-topology" ? 11 : 10,
      );
      assert.ok(aggregate.url);
    }
    if (ordinary) assert.equal(report.top[0].test, "independent test fails");
  }
});

test("cross-run passes use verified attempt completion and preserve an earlier eligible pass", async () => {
  for (const variant of [
    "future",
    "eligible",
    "missing",
    "invalid",
    "earlier-pass",
    "newer-lookup",
    "newer-unavailable",
    "equal-precision",
  ]) {
    const source = runRecord({
      id: 80,
      head_sha: "timed-head",
      run_attempt: 1,
      conclusion: "failure",
      created_at: "2026-11-01T09:00:00Z",
      html_url: "https://github.com/chrisbanes/cab/actions/runs/80",
    });
    const candidate = runRecord({
      id: 81,
      head_sha: "timed-head",
      head_branch: "topic",
      event: "pull_request",
      run_attempt: variant === "earlier-pass" ? 2 : 1,
      created_at: "2026-11-01T09:30:00Z",
      html_url: "https://github.com/chrisbanes/cab/actions/runs/81",
    });
    const calls: string[] = [];
    const report = await api.renderReport({
      since: "2026-10-19",
      until: "2026-11-01",
      transport: async (url: string) => {
        calls.push(url);
        if (url.includes("created="))
          return apiResponse({ workflow_runs: [source, candidate] });
        if (url.includes("head_sha="))
          return apiResponse({
            workflow_runs: [
              {
                ...candidate,
                run_attempt: variant.startsWith("newer-")
                  ? 2
                  : candidate.run_attempt,
              },
            ],
          });
        if (url.includes("/runs/80/attempts/1/jobs"))
          return apiResponse({
            jobs: [
              {
                id: 801,
                name: "execution-2",
                status: "completed",
                conclusion: "failure",
                started_at: "2026-11-01T09:59:00Z",
                completed_at: "2026-11-01T10:00:00.500Z",
                html_url:
                  "https://github.com/chrisbanes/cab/actions/runs/80/job/801",
              },
            ],
          });
        if (url.endsWith("/jobs/801/logs"))
          return apiResponse("✖ test fails (1ms)");
        if (url.includes("/runs/81/attempts/")) {
          if (variant === "newer-unavailable" && url.includes("attempts/2"))
            throw Error("New attempt unavailable");
          const future = variant === "future" || url.includes("attempts/2");
          const completedAt =
            variant === "missing"
              ? null
              : variant === "invalid"
                ? "2026-11-01T09:00:00Z"
                : variant === "equal-precision"
                  ? "2026-11-01T10:00:00.5000Z"
                  : future
                    ? "2026-11-02T00:02:00Z"
                    : "2026-11-01T12:01:00.200Z";
          return apiResponse({
            jobs: [
              {
                id: url.includes("attempts/2") ? 812 : 811,
                name: "check",
                status: "completed",
                conclusion: "success",
                started_at:
                  variant === "equal-precision"
                    ? "2026-11-01T10:00:00.400Z"
                    : future
                      ? "2026-11-01T23:59:00Z"
                      : "2026-11-01T12:00:00Z",
                completed_at: completedAt,
                html_url:
                  "https://github.com/chrisbanes/cab/actions/runs/81/job/811",
              },
            ],
          });
        }
        throw Error(`Unexpected endpoint ${url}`);
      },
    });
    const evidence = report.sameShaCorroboration.find(
      (item: { failureRunId: number }) => item.failureRunId === 80,
    );
    assert.ok(evidence, variant);
    const eligible = [
      "eligible",
      "earlier-pass",
      "newer-lookup",
      "newer-unavailable",
    ].includes(variant);
    assert.equal(evidence.laterPasses.length, eligible ? 1 : 0, variant);
    if (eligible) {
      assert.equal(
        evidence.laterPasses[0].passedAt,
        "2026-11-01T12:01:00.200Z",
      );
      assert.equal(
        evidence.laterPasses[0].failedAt,
        "2026-11-01T10:00:00.500Z",
      );
      assert.equal(evidence.laterPasses[0].passingAttempt, 1);
      assert.match(evidence.laterPasses[0].passingAttemptUrl, /attempts\/1$/);
    } else
      assert.ok(
        evidence.timingGaps.some(
          (item: { passingAttemptUrl?: string }) => item.passingAttemptUrl,
        ),
        variant,
      );
    const expectedReads =
      variant === "earlier-pass" || variant.startsWith("newer-") ? 2 : 1;
    assert.equal(
      calls.filter((url) => url.includes("/runs/81/attempts/")).length,
      expectedReads,
      variant,
    );
  }
});
