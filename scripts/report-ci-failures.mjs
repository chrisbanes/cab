import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const API = "https://api.github.com";
const guard = "the pinned SDK is the qualified version";

export function parseFailureLog(log) {
  if (typeof log !== "string") throw Error("Malformed job log");
  const clean = sanitizeLog(
    log.replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
      "",
    ),
  );
  const failures = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.replace(/^\d{4}-\d\d-\d\dT\S+Z\s*/, "").trim();
    if (!line.startsWith("✖") || /^✖\s*failing tests\s*:?$/i.test(line))
      continue;
    const spec = line.match(/^✖\s+(.+?)\s+\((\d+(?:\.\d+)?\s*ms)\)$/);
    if (spec) {
      failures.push({ name: spec[1], duration: spec[2] });
      continue;
    }
    const old = line.match(
      /^✖\s+\d+\s+(.+?)\s*\(([^()]+\.test\.[cm]?[jt]sx?):(\d+):(\d+)\)$/,
    );
    if (old)
      failures.push({
        name: old[1],
        file: old[2],
        line: Number(old[3]),
        column: Number(old[4]),
      });
    else {
      const name = line
        .replace(/^✖\s*/, "")
        .replace(/\s*\([^()]*\)\s*$/, "")
        .trim();
      if (name) failures.push({ name, unknown: true });
    }
  }
  const seen = new Set();
  return failures.filter((failure) => {
    const identity = `${failure.name}|${failure.file ?? ""}|${failure.line ?? ""}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function sanitizeLog(value) {
  return value
    .replace(/[\s\S]/g, (character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        code === 127
        ? ""
        : character;
    })
    .replace(
      /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+|<[^>]*(?:token|secret|credential)[^>]*>)/gi,
      "[redacted]",
    );
}

export function dedupeAttemptFailures(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.runId}/${entry.attempt}/${entry.jobId}/${entry.failure.file}:${entry.failure.line}:${entry.failure.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function classifyRunEvidence(run, failures, renovateSdkBump = false) {
  const retained = failures.filter(
    (failure) => !(renovateSdkBump && failure.raw?.trim() === guard),
  );
  return {
    ...run,
    failures: retained,
    classification: retained.length
      ? "unclassified"
      : failures.length
        ? "excluded-evidence"
        : "clean",
  };
}

export function aggregateFailureReport({
  since,
  until,
  runs,
  complete = true,
}) {
  const inWindow = (r) =>
    typeof r.createdAt === "string" &&
    r.createdAt.slice(0, 10) >= since &&
    r.createdAt.slice(0, 10) <= until;
  const all = [
    ...new Map(runs.filter(inWindow).map((r) => [r.id, r])).values(),
  ];
  const eligible = all.filter((r) => r.branch === "main" && r.event === "push");
  const denominatorRuns = eligible.filter(
    (r) => r.conclusion === "success" || r.conclusion === "failure",
  );
  const denominator = denominatorRuns.length;
  const failed = all.filter(
    (r) =>
      r.conclusion === "failure" || r.attempts?.some((a) => a.failures?.length),
  );
  const failedEligible = eligible.filter(
    (r) =>
      failed.some((f) => f.id === r.id) &&
      r.classification !== "excluded-evidence",
  );
  const unrelated = failedEligible.filter(
    (r) => r.classification === "confirmed-unrelated",
  ).length;
  const unclassifiedRuns = failedEligible.filter(
    (r) => r.classification !== "confirmed-unrelated",
  );
  const unclassified = unclassifiedRuns.length;
  const unresolvedRuns = eligible.filter(
    (r) =>
      !["success", "failure"].includes(r.conclusion) ||
      r.incomplete ||
      r.coverageIncomplete,
  );
  const incomplete = unresolvedRuns.length;
  const potentialIds = new Set(
    [...failedEligible, ...unresolvedRuns].map((r) => r.id),
  );
  const upper = denominator ? Math.min(1, potentialIds.size / denominator) : 1;
  const lower = denominator ? unrelated / denominator : 0;
  const fullWindow =
    complete &&
    denominator > 0 &&
    dateDays(since, until) === 14 &&
    incomplete === 0;
  const otherBranchFailures = all.filter(
    (r) => !(r.branch === "main" && r.event === "push") && failed.includes(r),
  );
  return {
    since,
    until,
    denominator,
    observedFailures: failedEligible.length,
    confirmedUnrelated: unrelated,
    unclassified,
    incomplete: incomplete + (complete ? 0 : 1),
    lowerBound: lower,
    upperBound: Math.max(upper, complete ? 0 : 1),
    verdict:
      fullWindow && upper <= 1 / 20
        ? "met"
        : fullWindow && lower > 1 / 20
          ? "not-met"
          : "insufficient-evidence",
    runs: failed,
    otherBranchFailures,
  };
}

function dateDays(a, b) {
  return (
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000 + 1
  );
}
function validDate(s) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  );
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function ghTransport(
  url,
  {
    rawLogs = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
  } = {},
) {
  const parsed = new URL(url);
  if (parsed.origin !== API || !parsed.pathname.startsWith("/repos/"))
    throw Error("Refusing GitHub API URL outside repository API");
  return new Promise((resolve, reject) => {
    const args = ["api", "--include", "--method", "GET"];
    if (rawLogs) args.push("--allow-escape-sequences");
    args.push(`${parsed.pathname}${parsed.search}`);
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(Error("GitHub API request timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGTERM");
        finish(Error("GitHub API response exceeded the byte limit"));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(Error("Unable to start gh api")));
    child.on("close", (code) => {
      if (code !== 0)
        return finish(Error(`gh api failed (${code ?? "signal"})`));
      const output = Buffer.concat(stdout).toString("utf8");
      const split = output.search(/\r?\n\r?\n/);
      if (split < 0)
        return finish(Error("gh api response is missing HTTP headers"));
      const boundary = output.slice(split).match(/^\r?\n\r?\n/)[0];
      const headerText = output.slice(0, split);
      const body = output.slice(split + boundary.length);
      const status = Number(headerText.match(/^HTTP\/\S+\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(status))
        return finish(Error("gh api response has malformed HTTP status"));
      const headers = new Map(
        [...headerText.matchAll(/^([^:\r\n]+):\s*(.*)$/gm)].map((m) => [
          m[1].toLowerCase(),
          m[2],
        ]),
      );
      finish(null, {
        status,
        ok: status >= 200 && status < 300,
        headers,
        body,
      });
    });
  });
}

function responseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw Error("Malformed GitHub API JSON response");
  }
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (match?.[2].split(/\s+/).includes("next")) return match[1];
  }
  return null;
}

export async function paginateActions(
  url,
  transport = ghTransport,
  { queryKind = "jobs" } = {},
) {
  const items = [];
  let next = url;
  let pages = 0;
  const original = new URL(url);
  const repoMatch = original.pathname.match(/^(\/repos\/[^/]+\/[^/]+)\//);
  if (original.origin !== API || !repoMatch)
    throw Error("Refusing Actions query outside repository API");
  const repoPath = repoMatch[1];
  while (true) {
    const parsed = new URL(next);
    if (parsed.origin !== API || !parsed.pathname.startsWith(`${repoPath}/`))
      throw Error("GitHub pagination link escaped repository API");
    for (const [key, value] of original.searchParams)
      if (key !== "page" && parsed.searchParams.get(key) !== value)
        throw Error("GitHub pagination link changed query scope");
    const response = await transport(next);
    if (!response.ok) throw Error(`GitHub API returned ${response.status}`);
    const body = responseJson(response);
    if (!Array.isArray(body.workflow_runs) && !Array.isArray(body.jobs))
      throw Error("Malformed Actions response");
    const batch = body.workflow_runs ?? body.jobs;
    items.push(...batch);
    pages++;
    const link = nextLink(
      response.headers?.get?.("link") ??
        response.headers?.get?.("Link") ??
        response.headers?.get?.("LINK") ??
        response.headers?.link,
    );
    if (!link)
      return {
        items,
        capped: queryKind === "workflow-runs" && items.length >= 1000,
      };
    next = new URL(link, next).href;
    if (queryKind === "workflow-runs" && pages >= 10)
      return { items, capped: true };
  }
}

export async function renderReport({
  since,
  until,
  top = 20,
  transport = ghTransport,
  owner = "chrisbanes",
  repo = "cab",
}) {
  if (
    !validDate(since) ||
    !validDate(until) ||
    since >= until ||
    dateDays(since, until) > 31
  )
    throw Error(
      "Use --since and --until as an increasing UTC date range of at most 31 days",
    );
  const base = `${API}/repos/${owner}/${repo}`;
  const query = await paginateActions(
    `${base}/actions/workflows/ci.yml/runs?created=${since}..${until}`,
    transport,
    { queryKind: "workflow-runs" },
  );
  const rawRuns = query.items;
  const runs = [];
  for (const raw of rawRuns) {
    if (
      !Number.isSafeInteger(raw.id) ||
      typeof raw.head_branch !== "string" ||
      typeof raw.event !== "string" ||
      typeof raw.head_sha !== "string" ||
      typeof raw.created_at !== "string" ||
      typeof raw.status !== "string" ||
      !Number.isSafeInteger(raw.run_attempt) ||
      raw.run_attempt < 1 ||
      typeof raw.html_url !== "string"
    )
      throw Error("Malformed workflow run record");
    if (
      raw.created_at < `${since}T00:00:00Z` ||
      raw.created_at >= `${until}T23:59:59.999Z`
    )
      continue;
    const run = {
      id: raw.id,
      branch: raw.head_branch,
      event: raw.event,
      sha: raw.head_sha,
      createdAt: raw.created_at,
      conclusion: raw.conclusion,
      url: raw.html_url,
      attempts: [],
      incomplete: false,
    };
    if (raw.conclusion === "failure" || raw.run_attempt > 1) {
      for (let attempt = 1; attempt <= raw.run_attempt; attempt++) {
        const jobsResult = await paginateActions(
          `${base}/actions/runs/${raw.id}/attempts/${attempt}/jobs`,
          transport,
        );
        const attemptInfo = { number: attempt, failures: [] };
        run.attempts.push(attemptInfo);
        for (const job of jobsResult.items.filter(
          (j) => j.conclusion === "failure",
        )) {
          try {
            if (
              !Number.isSafeInteger(job.id) ||
              typeof job.name !== "string" ||
              typeof job.html_url !== "string"
            )
              throw Error("Malformed failed job record");
            const response = await transport(
              `${base}/actions/jobs/${job.id}/logs`,
              { rawLogs: true },
            );
            if (!response.ok) throw Error(`log ${response.status}`);
            const text = response.body;
            for (const failure of parseFailureLog(text))
              attemptInfo.failures.push({
                runId: raw.id,
                attempt,
                jobId: job.id,
                jobName: job.name,
                url: job.html_url,
                failure,
              });
          } catch {
            run.incomplete = true;
          }
        }
      }
    }
    run.attempts = run.attempts.map((a) => ({
      ...a,
      failures: dedupeAttemptFailures(a.failures),
    }));
    run.classification = run.incomplete
      ? "incomplete"
      : run.attempts.some((a) => a.failures.length)
        ? "unclassified"
        : "clean";
    runs.push(run);
  }
  const report = aggregateFailureReport({
    since,
    until,
    runs,
    complete: !query.capped,
  });
  report.capped = query.capped;
  report.top = topFailing(report.runs, top);
  return report;
}

function topFailing(runs, limit) {
  const counts = new Map();
  for (const run of runs)
    for (const attempt of run.attempts ?? [])
      for (const item of attempt.failures ?? []) {
        const key = `${item.failure.name} (${item.jobName})`;
        const current = counts.get(key) ?? {
          test: item.failure.name,
          shard: item.jobName,
          count: 0,
          links: [],
        };
        current.count++;
        current.links.push({
          url: item.url,
          run: run.url,
          attempt: attempt.number,
        });
        counts.set(key, current);
      }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

export function formatReport(report) {
  return JSON.stringify(report, null, 2).replace(/[\s\S]/g, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? "" : character;
  });
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help") return { help: true };
    if (["--since", "--until", "--top"].includes(argv[i]))
      out[argv[i].slice(2)] = argv[++i];
    else throw Error(`Unknown argument ${argv[i]}`);
  }
  return out;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = args(process.argv.slice(2));
    if (options.help)
      console.log(
        "Usage: node scripts/report-ci-failures.mjs --since YYYY-MM-DD --until YYYY-MM-DD [--top N]",
      );
    else console.log(formatReport(await renderReport(options)));
  } catch (error) {
    console.error(
      String(error.message).replace(/[\s\S]/g, (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
      }),
    );
    process.exitCode = 1;
  }
}
