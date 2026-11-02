import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { ciFailures } from "./check-ci-results.mjs";

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
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
      "",
    )
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
    (failure) =>
      !(renovateSdkBump && failure.name === guard && !failure.unknown),
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
  asOf = new Date().toISOString(),
}) {
  if (!validTimestamp(asOf)) throw Error("Invalid report snapshot time");
  const windowElapsed = until < asOf.slice(0, 10);
  const completeWindow = complete && windowElapsed;
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
      r.conclusion === "failure" ||
      r.hasFailedJob ||
      r.attempts?.some(
        (a) =>
          a.jobs?.some((j) => j.conclusion === "failure") || a.failures?.length,
      ),
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
    completeWindow &&
    denominator > 0 &&
    dateDays(since, until) === 14 &&
    incomplete === 0;
  const otherBranchFailures = all.filter(
    (r) => !(r.branch === "main" && r.event === "push") && failed.includes(r),
  );
  return {
    since,
    until,
    windowDays: dateDays(since, until),
    comparisonHorizonUntil: until,
    asOf,
    windowElapsed,
    windowCoverage: windowElapsed
      ? null
      : { reason: "window-not-ended", until, asOf },
    targetRate: 1 / 20,
    denominator,
    observedFailures: failedEligible.length,
    confirmedUnrelated: unrelated,
    unclassified,
    incomplete: incomplete + (completeWindow ? 0 : 1),
    lowerBound: lower,
    upperBound: Math.max(upper, completeWindow ? 0 : 1),
    verdict:
      fullWindow && upper <= 1 / 20
        ? "met"
        : fullWindow && lower > 1 / 20
          ? "not-met"
          : "insufficient-evidence",
    runs: failed,
    otherBranchFailures,
    coverageRuns: all.filter((r) => r.incomplete || r.coverage?.length),
  };
}

function dateDays(a, b) {
  return (
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000 + 1
  );
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === s;
}

export function validateReportOptions({ since, until, top = 20 }) {
  if (
    !validDate(since) ||
    !validDate(until) ||
    since >= until ||
    dateDays(since, until) > 31
  )
    throw Error("Use increasing real UTC dates spanning at most 31 days");
  if (
    !(typeof top === "number"
      ? Number.isSafeInteger(top)
      : /^\d+$/.test(top)) ||
    Number(top) < 1 ||
    Number(top) > 100
  )
    throw Error("--top must be a positive integer no greater than 100");
}

function safeGithubUrl(value, owner, repo) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(`/${owner}/${repo}/`)
    );
  } catch {
    return false;
  }
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function attemptChronology(attempt) {
  const jobs = attempt.jobs;
  return (
    attempt.metadataComplete !== false &&
    jobs.length > 0 &&
    jobs.every(
      (job) =>
        job.status === "completed" &&
        ["success", "failure", "skipped", "cancelled"].includes(
          job.conclusion,
        ) &&
        validTimestamp(job.startedAt) &&
        validTimestamp(job.completedAt) &&
        Date.parse(job.startedAt) <= Date.parse(job.completedAt),
    )
  );
}

async function candidateAttempts(
  candidate,
  collected,
  base,
  transport,
  cache,
  owner,
  repo,
) {
  if (cache.has(candidate.id)) return cache.get(candidate.id);
  const loading = (async () => {
    if (
      !Number.isSafeInteger(candidate.run_attempt) ||
      candidate.run_attempt < 1
    )
      throw Error("Missing candidate attempt identity");
    const existing = collected.find(
      (run) => run.id === candidate.id && run.sha === candidate.head_sha,
    );
    const attempts = [];
    for (
      let number = 1;
      number <= Math.max(candidate.run_attempt, existing?.attempts.length ?? 0);
      number++
    ) {
      const retained = existing?.attempts.find(
        (attempt) => attempt.number === number,
      );
      if (
        retained &&
        !(
          number === candidate.run_attempt &&
          candidate.status === "completed" &&
          candidate.conclusion === "success" &&
          retained.conclusion !== "success"
        )
      ) {
        attempts.push(retained);
        continue;
      }
      try {
        const response = await paginateActions(
          `${base}/actions/runs/${candidate.id}/attempts/${number}/jobs?per_page=100`,
          transport,
        );
        const jobs = response.items.map((job) => {
          if (
            !Number.isSafeInteger(job.id) ||
            typeof job.name !== "string" ||
            typeof job.status !== "string" ||
            !safeGithubUrl(job.html_url, owner, repo)
          )
            throw Error("Malformed candidate job");
          return {
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            url: job.html_url,
            startedAt: job.started_at,
            completedAt: job.completed_at,
          };
        });
        const attempt = {
          number,
          url: `${candidate.html_url}/attempts/${number}`,
          jobs,
          metadataComplete: true,
        };
        if (attemptChronology(attempt)) {
          attempt.startedAt = jobs.reduce(
            (a, job) =>
              Date.parse(job.startedAt) < Date.parse(a) ? job.startedAt : a,
            jobs[0].startedAt,
          );
          attempt.completedAt = jobs.reduce(
            (a, job) =>
              Date.parse(job.completedAt) > Date.parse(a) ? job.completedAt : a,
            jobs[0].completedAt,
          );
        }
        if (
          jobs.some(
            (job) =>
              job.name.toLowerCase() === "check" &&
              job.conclusion === "success",
          ) &&
          jobs.every(
            (job) =>
              job.status === "completed" &&
              ["success", "skipped"].includes(job.conclusion),
          )
        )
          attempt.conclusion = "success";
        attempts.push(attempt);
      } catch {
        attempts.push({
          number,
          url: `${candidate.html_url}/attempts/${number}`,
          jobs: [],
          metadataComplete: false,
          collectionError: true,
        });
      }
    }
    return attempts;
  })();
  cache.set(candidate.id, loading);
  return loading;
}

function accountAggregateFailure(attempt, logs) {
  // Only this retrieved topology is qualified; historical or extra jobs remain unknown.
  const lanes = [
    "integrations-1",
    "execution-1",
    "execution-2",
    "workspaces-1",
    "operator-1",
    "operator-2",
    "service-1",
    "service-2",
  ];
  const names = ["changes", "quality", ...lanes, "check"];
  const jobs = attempt.jobs;
  if (
    jobs.length !== names.length ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    names.some(
      (name) => jobs.filter((job) => job.name === name).length !== 1,
    ) ||
    jobs.some(
      (job) =>
        job.status !== "completed" ||
        !["success", "failure"].includes(job.conclusion),
    )
  )
    return;
  const check = jobs.find((job) => job.name === "check");
  if (
    jobs.find((job) => job.name === "changes").conclusion !== "success" ||
    jobs.find((job) => job.name === "quality").conclusion !== "success"
  )
    return;
  if (
    check.conclusion !== "failure" ||
    check.failures.length ||
    !Array.isArray(check.steps) ||
    !check.steps.length ||
    !check.steps.every(
      (step) =>
        step &&
        typeof step === "object" &&
        typeof step.name === "string" &&
        typeof step.status === "string" &&
        typeof step.conclusion === "string",
    ) ||
    check.steps.some((step) => step.status !== "completed") ||
    check.steps.filter((step) => step.conclusion === "failure").length !== 1 ||
    check.steps.some(
      (step) => !["success", "failure"].includes(step.conclusion),
    ) ||
    !check.steps.some(
      (step) =>
        step.name === "Require every applicable job to succeed" &&
        step.conclusion === "failure",
    )
  )
    return;
  if (
    check.steps.filter(
      (step) => step.name === "Require every applicable job to succeed",
    ).length !== 1 ||
    !check.steps.some(
      (step) =>
        step.name === "Run actions/checkout@v7" &&
        step.conclusion === "success",
    ) ||
    !check.steps.some(
      (step) => step.name === "Complete job" && step.conclusion === "success",
    )
  )
    return;
  const log = logs.get(check.id);
  if (!log) return;
  const lines = sanitizeLog(log)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+Z\s*/, "").trim())
    .filter(Boolean);
  const command = lines.indexOf(
    "##[group]Run node scripts/check-ci-results.mjs",
  );
  const groupEnd = lines.indexOf("##[endgroup]", command + 1);
  const exit = lines.indexOf(
    "##[error]Process completed with exit code 1.",
    groupEnd + 1,
  );
  if (
    command < 0 ||
    groupEnd < 0 ||
    exit < 0 ||
    lines.filter((line) => line.startsWith("##[error]")).length !== 1 ||
    !lines.slice(command, groupEnd).includes("RUN_CHECKS: true")
  )
    return;
  const needs = {
    changes: { result: jobs.find((job) => job.name === "changes").conclusion },
    quality: { result: jobs.find((job) => job.name === "quality").conclusion },
    suites: {
      result: jobs.some(
        (job) => lanes.includes(job.name) && job.conclusion === "failure",
      )
        ? "failure"
        : "success",
    },
  };
  const diagnostics = ciFailures(needs);
  if (
    !diagnostics.length ||
    JSON.stringify(lines.slice(groupEnd + 1, exit)) !==
      JSON.stringify(diagnostics)
  )
    return;
  check.accountedFor = {
    reason: "verified-aggregate-dependency-failure",
    diagnostics,
    dependencies: jobs
      .filter((job) => job.id !== check.id)
      .map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        url: job.url,
      })),
  };
  check.coverage = check.coverage.filter(
    (entry) => entry.reason !== "failed-job-log-without-test-marker",
  );
}

function versionTuple(value) {
  const match =
    typeof value === "string" && value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function isSdkVersionIncrease(patch) {
  if (typeof patch !== "string" || patch.length === 0) return false;
  const removed = [
    ...patch.matchAll(
      /^[-]\s*"@anthropic-ai\/claude-agent-sdk"\s*:\s*"([^"]+)"/gm,
    ),
  ]
    .map((m) => versionTuple(m[1]))
    .filter(Boolean);
  const added = [
    ...patch.matchAll(
      /^[+]\s*"@anthropic-ai\/claude-agent-sdk"\s*:\s*"([^"]+)"/gm,
    ),
  ]
    .map((m) => versionTuple(m[1]))
    .filter(Boolean);
  return (
    removed.length === 1 &&
    added.length === 1 &&
    added[0].some(
      (part, i) =>
        part !== removed[0][i] &&
        added[0].slice(0, i).every((x, j) => x === removed[0][j]) &&
        part > removed[0][i],
    )
  );
}

async function collectSameShaCorroboration({
  runs,
  base,
  transport,
  until,
  owner,
  repo,
}) {
  const failures = runs.filter(
    (run) =>
      run.classification !== "excluded-evidence" &&
      (run.hasFailedJob || run.conclusion === "failure"),
  );
  const bySha = new Map();
  for (const failure of failures) {
    if (!bySha.has(failure.sha)) bySha.set(failure.sha, []);
    bySha.get(failure.sha).push(failure);
  }
  const results = [];
  const attemptCache = new Map();
  for (const [sha, failedRuns] of bySha) {
    try {
      const lookup = await paginateActions(
        `${base}/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
        transport,
        { queryKind: "head-runs" },
      );
      const lookupRuns = new Map(lookup.items.map((r) => [r.id, r]));
      for (const failedRun of failedRuns) {
        const laterPasses = [];
        const timingGaps = [];
        const failedAttempts = failedRun.attempts.filter(
          (attempt) =>
            attempt.conclusion === "failure" && attemptChronology(attempt),
        );
        if (!failedAttempts.length)
          timingGaps.push({
            reason: "failure-attempt-timing-unavailable",
            failureRunUrl: failedRun.url,
          });
        for (const attempt of failedRun.attempts) {
          if (attempt.conclusion !== "failure" || !attemptChronology(attempt))
            continue;
          for (const laterAttempt of failedRun.attempts) {
            if (
              laterAttempt.number > attempt.number &&
              laterAttempt.conclusion === "success" &&
              attemptChronology(laterAttempt) &&
              laterAttempt.startedAt &&
              laterAttempt.completedAt &&
              laterAttempt.completedAt.slice(0, 10) <= until &&
              Date.parse(laterAttempt.startedAt) >
                Date.parse(attempt.completedAt)
            )
              laterPasses.push({
                kind: "later-attempt",
                runId: failedRun.id,
                failedAttempt: attempt.number,
                passingAttempt: laterAttempt.number,
                failureRunUrl: failedRun.url,
                failureAttemptUrl: attempt.url,
                passingAttemptUrl: laterAttempt.url,
                failedAt: attempt.completedAt,
                passedAt: laterAttempt.completedAt,
              });
          }
        }
        for (const candidate of lookupRuns.values()) {
          if (
            candidate.id === failedRun.id ||
            !Number.isSafeInteger(candidate.id) ||
            candidate.head_sha !== sha ||
            !validTimestamp(candidate.created_at) ||
            candidate.created_at.slice(0, 10) > until ||
            !(
              Date.parse(candidate.created_at) > Date.parse(failedRun.createdAt)
            ) ||
            !safeGithubUrl(candidate.html_url, owner, repo)
          )
            continue;
          try {
            const attempts = await candidateAttempts(
              candidate,
              runs,
              base,
              transport,
              attemptCache,
              owner,
              repo,
            );
            let verifiedPass = false;
            for (const passingAttempt of attempts) {
              if (passingAttempt.collectionError)
                timingGaps.push({
                  reason: "candidate-attempt-jobs-unavailable",
                  passingRunUrl: candidate.html_url,
                  passingAttemptUrl: passingAttempt.url,
                });
              if (passingAttempt.conclusion !== "success") continue;
              if (!attemptChronology(passingAttempt)) {
                timingGaps.push({
                  reason: "passing-attempt-timing-unavailable",
                  passingRunUrl: candidate.html_url,
                  passingAttemptUrl: passingAttempt.url,
                });
                continue;
              }
              if (
                Date.parse(passingAttempt.startedAt) <
                Date.parse(candidate.created_at)
              ) {
                timingGaps.push({
                  reason: "passing-attempt-precedes-run-creation",
                  passingRunUrl: candidate.html_url,
                  passingAttemptUrl: passingAttempt.url,
                });
                continue;
              }
              if (passingAttempt.completedAt.slice(0, 10) > until) {
                timingGaps.push({
                  reason: "passing-attempt-after-horizon",
                  passingRunUrl: candidate.html_url,
                  passingAttemptUrl: passingAttempt.url,
                  completedAt: passingAttempt.completedAt,
                });
                continue;
              }
              for (const failedAttempt of failedAttempts) {
                if (
                  Date.parse(passingAttempt.completedAt) <=
                  Date.parse(failedAttempt.completedAt)
                ) {
                  timingGaps.push({
                    reason: "passing-completion-not-after-failure",
                    failureAttemptUrl: failedAttempt.url,
                    passingAttemptUrl: passingAttempt.url,
                  });
                  continue;
                }
                verifiedPass = true;
                laterPasses.push({
                  kind: "later-run",
                  runId: failedRun.id,
                  passingRunId: candidate.id,
                  failedAttempt: failedAttempt.number,
                  passingAttempt: passingAttempt.number,
                  failureRunUrl: failedRun.url,
                  failureAttemptUrl: failedAttempt.url,
                  passingRunUrl: candidate.html_url,
                  passingAttemptUrl: passingAttempt.url,
                  failedAt: failedAttempt.completedAt,
                  passedAt: passingAttempt.completedAt,
                  interpretation:
                    "same-head corroboration; not a cause classification",
                });
              }
            }
            if (
              !verifiedPass &&
              !attempts.some((attempt) => attempt.conclusion === "success")
            )
              timingGaps.push({
                reason: "candidate-has-no-verified-passing-attempt",
                passingRunUrl: candidate.html_url,
              });
          } catch {
            timingGaps.push({
              reason: "candidate-attempt-jobs-unavailable",
              passingRunUrl: candidate.html_url,
            });
          }
        }
        results.push({
          sha,
          failureRunId: failedRun.id,
          status: lookup.capped ? "lookup-capped" : "complete-through-until",
          horizonUntil: until,
          laterPasses,
          timingGaps,
        });
      }
      if (lookup.capped)
        for (const run of failedRuns) {
          run.coverage.push({ reason: "same-sha-run-lookup-capped", sha });
          run.incomplete = true;
        }
    } catch {
      for (const run of failedRuns) {
        run.coverage.push({ reason: "same-sha-run-lookup-unavailable", sha });
        run.incomplete = true;
        results.push({
          sha,
          failureRunId: run.id,
          status: "lookup-unavailable",
          horizonUntil: until,
          laterPasses: [],
        });
      }
    }
  }
  return results;
}

async function verifiedRenovateSdkBump({
  sha,
  base,
  transport,
  cache,
  owner,
  repo,
}) {
  if (cache.has(sha)) return cache.get(sha);
  const result = (async () => {
    try {
      const pulls = await paginateActions(
        `${base}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`,
        transport,
      );
      if (pulls.capped)
        return { verified: false, reason: "pull-request-list-capped" };
      for (const pr of pulls.items) {
        if (pr.user?.login !== "renovate[bot]" || pr.user?.type !== "Bot")
          continue;
        const matchesHead = pr.head?.sha === sha;
        const matchesMerge = pr.merged === true && pr.merge_commit_sha === sha;
        if (!matchesHead && !matchesMerge) continue;
        if (
          !Number.isSafeInteger(pr.number) ||
          !safeGithubUrl(pr.html_url, owner, repo)
        )
          continue;
        const files = await paginateActions(
          `${base}/pulls/${pr.number}/files?per_page=100`,
          transport,
          { queryKind: "pull-files" },
        );
        if (files.capped)
          return {
            verified: false,
            reason: "pull-files-capped",
            url: pr.html_url,
          };
        if (
          files.items.some(
            (file) =>
              file.filename === "package.json" &&
              isSdkVersionIncrease(file.patch),
          )
        )
          return { verified: true, url: pr.html_url, number: pr.number };
      }
      return { verified: false, reason: "no-verified-renovate-sdk-bump" };
    } catch {
      return { verified: false, reason: "renovate-metadata-unavailable" };
    }
  })();
  cache.set(sha, result);
  return result;
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
  const visited = new Set();
  const original = new URL(url);
  const repoMatch = original.pathname.match(/^(\/repos\/[^/]+\/[^/]+)\//);
  if (original.origin !== API || !repoMatch)
    throw Error("Refusing Actions query outside repository API");
  while (true) {
    const parsed = new URL(next);
    if (parsed.origin !== API || parsed.pathname !== original.pathname)
      throw Error("GitHub pagination link escaped repository API");
    if (visited.has(parsed.href))
      throw Error("GitHub pagination link repeated a page");
    visited.add(parsed.href);
    for (const [key, value] of original.searchParams)
      if (key !== "page" && parsed.searchParams.get(key) !== value)
        throw Error("GitHub pagination link changed query scope");
    for (const [key, value] of parsed.searchParams)
      if (key !== "page" && original.searchParams.get(key) !== value)
        throw Error("GitHub pagination link changed query scope");
    const response = await transport(next);
    if (!response.ok) throw Error(`GitHub API returned ${response.status}`);
    const body = responseJson(response);
    if (
      !Array.isArray(body) &&
      !Array.isArray(body.workflow_runs) &&
      !Array.isArray(body.jobs) &&
      !Array.isArray(body.files)
    )
      throw Error("Malformed Actions response");
    const batch = Array.isArray(body)
      ? body
      : (body.workflow_runs ?? body.jobs ?? body.files);
    items.push(...batch);
    const link = nextLink(
      response.headers?.get?.("link") ??
        response.headers?.get?.("Link") ??
        response.headers?.get?.("LINK") ??
        response.headers?.link,
    );
    const limit =
      queryKind === "workflow-runs" || queryKind === "head-runs"
        ? 1000
        : queryKind === "pull-files"
          ? 3000
          : Infinity;
    if (!link) return { items, capped: items.length >= limit };
    next = new URL(link, next).href;
    if (items.length >= limit) return { items, capped: true };
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
  const asOf = new Date().toISOString();
  validateReportOptions({ since, until, top });
  top = Number(top);
  const base = `${API}/repos/${owner}/${repo}`;
  const query = await paginateActions(
    `${base}/actions/workflows/ci.yml/runs?created=${since}..${until}&per_page=100`,
    transport,
    { queryKind: "workflow-runs" },
  );
  const rawRuns = [
    ...new Map(query.items.map((run) => [run.id, run])).values(),
  ];
  const runs = [];
  const renovateCache = new Map();
  for (const raw of rawRuns) {
    if (
      !Number.isSafeInteger(raw.id) ||
      (raw.head_branch !== null && typeof raw.head_branch !== "string") ||
      typeof raw.event !== "string" ||
      typeof raw.head_sha !== "string" ||
      !validTimestamp(raw.created_at) ||
      typeof raw.status !== "string" ||
      !Number.isSafeInteger(raw.run_attempt) ||
      raw.run_attempt < 1 ||
      !safeGithubUrl(raw.html_url, owner, repo) ||
      (raw.conclusion !== null && typeof raw.conclusion !== "string")
    )
      throw Error("Malformed workflow run record");
    const createdDay = raw.created_at.slice(0, 10);
    if (createdDay < since || createdDay > until) continue;
    const run = {
      id: raw.id,
      branch: raw.head_branch ?? "unknown",
      event: raw.event,
      sha: raw.head_sha,
      createdAt: raw.created_at,
      conclusion: raw.conclusion,
      url: raw.html_url,
      attempts: [],
      incomplete: false,
      coverage: [],
    };
    for (let attempt = 1; attempt <= raw.run_attempt; attempt++) {
      const attemptInfo = {
        number: attempt,
        url: `${raw.html_url}/attempts/${attempt}`,
        jobs: [],
        failures: [],
        status: "unknown",
        startedAt: null,
        completedAt: null,
      };
      run.attempts.push(attemptInfo);
      const failedJobLogs = new Map();
      try {
        const jobsResult = await paginateActions(
          `${base}/actions/runs/${raw.id}/attempts/${attempt}/jobs?per_page=100`,
          transport,
        );
        if (jobsResult.items.length === 0)
          run.coverage.push({
            reason: "attempt-has-no-jobs",
            attempt,
            attemptUrl: attemptInfo.url,
          });
        for (const job of jobsResult.items) {
          if (
            !Number.isSafeInteger(job.id) ||
            typeof job.name !== "string" ||
            (job.conclusion !== null && typeof job.conclusion !== "string") ||
            typeof job.status !== "string" ||
            !safeGithubUrl(job.html_url, owner, repo)
          ) {
            run.coverage.push({
              reason: "malformed-job",
              attempt,
              jobId: Number.isSafeInteger(job.id) ? job.id : null,
            });
            continue;
          }
          const jobRecord = {
            id: job.id,
            name: job.name,
            url: job.html_url,
            attempt,
            status: job.status,
            conclusion: job.conclusion,
            steps: job.steps,
            startedAt:
              job.started_at == null
                ? null
                : validTimestamp(job.started_at)
                  ? job.started_at
                  : null,
            completedAt:
              job.completed_at == null
                ? null
                : validTimestamp(job.completed_at)
                  ? job.completed_at
                  : null,
            failures: [],
            coverage: [],
          };
          if (
            (job.started_at != null && !validTimestamp(job.started_at)) ||
            (job.completed_at != null && !validTimestamp(job.completed_at))
          )
            run.coverage.push({
              reason: "malformed-job-timestamp",
              attempt,
              jobId: job.id,
              jobUrl: job.html_url,
            });
          if (
            job.status !== "completed" ||
            !["success", "failure", "skipped"].includes(job.conclusion)
          )
            run.coverage.push({
              reason:
                job.status !== "completed" || job.conclusion == null
                  ? "job-incomplete"
                  : "job-conclusion-unresolved",
              attempt,
              jobId: job.id,
              jobUrl: job.html_url,
              status: job.status,
              conclusion: job.conclusion,
            });
          attemptInfo.jobs.push(jobRecord);
          if (
            validTimestamp(job.started_at) &&
            (!attemptInfo.startedAt ||
              Date.parse(job.started_at) < Date.parse(attemptInfo.startedAt))
          )
            attemptInfo.startedAt = job.started_at;
          if (
            validTimestamp(job.completed_at) &&
            (!attemptInfo.completedAt ||
              Date.parse(job.completed_at) >
                Date.parse(attemptInfo.completedAt))
          )
            attemptInfo.completedAt = job.completed_at;
          if (job.status !== "completed" || job.conclusion === null)
            attemptInfo.status = job.status;
          else if (attemptInfo.status === "unknown")
            attemptInfo.status = "completed";
          if (job.conclusion !== "failure") continue;
          try {
            const response = await transport(
              `${base}/actions/jobs/${job.id}/logs`,
              { rawLogs: true },
            );
            if (!response.ok) throw Error(`log ${response.status}`);
            if (typeof response.body !== "string")
              throw Error("Malformed log response");
            failedJobLogs.set(job.id, response.body);
            const parsedFailures = parseFailureLog(response.body);
            jobRecord.failures = parsedFailures;
            if (parsedFailures.length === 0) {
              jobRecord.coverage.push({
                reason: "failed-job-log-without-test-marker",
              });
              run.coverage.push({
                reason: "failed-job-log-without-test-marker",
                attempt,
                jobId: job.id,
                jobUrl: job.html_url,
              });
            }
            for (const failure of parsedFailures)
              attemptInfo.failures.push({
                runId: raw.id,
                attempt,
                jobId: job.id,
                jobName: job.name,
                url: job.html_url,
                attemptUrl: attemptInfo.url,
                failure,
              });
          } catch {
            jobRecord.coverage.push({ reason: "failed-job-log-unavailable" });
            run.coverage.push({
              reason: "failed-job-log-unavailable",
              attempt,
              jobId: job.id,
              jobUrl: job.html_url,
            });
          }
        }
      } catch {
        run.coverage.push({
          reason: "attempt-jobs-unavailable",
          attempt,
          attemptUrl: attemptInfo.url,
        });
      }
      accountAggregateFailure(attemptInfo, failedJobLogs);
      run.coverage = run.coverage.filter(
        (entry) =>
          !(
            entry.reason === "failed-job-log-without-test-marker" &&
            attemptInfo.jobs.some(
              (job) => job.id === entry.jobId && job.accountedFor,
            )
          ),
      );
      attemptInfo.metadataComplete = !run.coverage.some(
        (entry) =>
          entry.attempt === attempt &&
          [
            "malformed-job",
            "attempt-jobs-unavailable",
            "attempt-has-no-jobs",
            "malformed-job-timestamp",
          ].includes(entry.reason),
      );
      const jobs = attemptInfo.jobs;
      const check = jobs.find((job) => job.name.toLowerCase() === "check");
      if (
        jobs.length &&
        jobs.every(
          (job) =>
            job.status === "completed" &&
            ["success", "failure", "cancelled", "skipped"].includes(
              job.conclusion,
            ),
        ) &&
        check?.conclusion === "success" &&
        jobs.every((job) => !["failure", "cancelled"].includes(job.conclusion))
      )
        attemptInfo.conclusion = "success";
      else if (jobs.some((job) => job.conclusion === "failure"))
        attemptInfo.conclusion = "failure";
    }
    if (!["success", "failure"].includes(raw.conclusion))
      run.coverage.push({
        reason:
          raw.status === "in_progress"
            ? "run-in-progress"
            : raw.conclusion === "cancelled"
              ? "run-cancelled"
              : "run-conclusion-unknown",
        status: raw.status,
        conclusion: raw.conclusion,
        runUrl: raw.html_url,
      });
    run.hasFailedJob = run.attempts.some((attempt) =>
      attempt.jobs.some((job) => job.conclusion === "failure"),
    );
    run.excludedEvidence = [];
    const guardEntries = run.attempts.flatMap((attempt) =>
      attempt.failures.filter(
        (item) => item.failure.name === guard && !item.failure.unknown,
      ),
    );
    if (guardEntries.length) {
      const metadata = await verifiedRenovateSdkBump({
        sha: run.sha,
        base,
        transport,
        cache: renovateCache,
        owner,
        repo,
      });
      if (metadata.verified) {
        for (const attempt of run.attempts) {
          attempt.failures = attempt.failures.filter((item) => {
            if (item.failure.name !== guard || item.failure.unknown)
              return true;
            run.excludedEvidence.push({
              runId: run.id,
              attempt: attempt.number,
              jobId: item.jobId,
              jobUrl: item.url,
              pullRequestUrl: metadata.url,
              reason: "verified-renovate-sdk-qualification-guard",
            });
            return false;
          });
          for (const job of attempt.jobs)
            job.failures = classifyRunEvidence({}, job.failures, true).failures;
        }
      } else {
        run.coverage.push({
          reason: metadata.reason,
          subject: "renovate-sdk-guard",
          sha: run.sha,
          pullRequestUrl: metadata.url ?? null,
        });
      }
    }
    run.hasFailedJob = run.attempts.some((attempt) =>
      attempt.jobs.some(
        (job) =>
          job.conclusion === "failure" &&
          !job.accountedFor &&
          (job.failures.length > 0 || job.coverage.length > 0),
      ),
    );
    run.incomplete = run.coverage.length > 0;
    run.attempts = run.attempts.map((a) => ({
      ...a,
      failures: dedupeAttemptFailures(a.failures),
    }));
    run.classification = run.hasFailedJob
      ? "unclassified"
      : run.excludedEvidence.length && !run.incomplete
        ? "excluded-evidence"
        : run.incomplete
          ? "incomplete"
          : "clean";
    runs.push(run);
  }
  const sameShaCorroboration = await collectSameShaCorroboration({
    runs,
    base,
    transport,
    until,
    owner,
    repo,
  });
  if (query.capped)
    for (const run of runs.filter(
      (item) => item.branch === "main" && item.event === "push",
    )) {
      run.incomplete = true;
      run.coverage.push({ reason: "workflow-run-query-capped" });
    }
  const report = aggregateFailureReport({
    since,
    until,
    runs,
    complete: !query.capped,
    asOf,
  });
  report.capped = query.capped;
  report.excludedEvidence = runs.flatMap((run) => run.excludedEvidence);
  report.sameShaCorroboration = sameShaCorroboration;
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
          attemptUrl: item.attemptUrl,
          attempt: attempt.number,
        });
        counts.set(key, current);
      }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function sanitizeOutput(value) {
  if (typeof value === "string") return sanitizeLog(value);
  if (Array.isArray(value)) return value.map(sanitizeOutput);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeOutput(item)]),
    );
  return value;
}

export function formatReport(report) {
  return JSON.stringify(sanitizeOutput(report), null, 2);
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
