import { spawn } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { profileTimings } from "./test-timings.mjs";
import { constants } from "node:os";
import {
  createTestEvidenceDirectory,
  writeTestEvidence,
} from "../dist/test/fixtures/browser-diagnostics.js";

function diagnosticStream() {
  const result = { lines: [], omitted: 0, truncated: 0 };
  let pending = "",
    dropping = false,
    ended = false;
  const line = () => {
    const value = pending.replace(/^# /, "").trim();
    pending = "";
    const allowed =
      /^(ensemble-test-evidence (stdout|stderr) synthetic-ci-probe|AssertionError \[ERR_ASSERTION\]: Injected CI browser assertion remains primary|[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo) \d+)$/.test(
        value,
      );
    if (allowed && result.lines.length < 40) result.lines.push(value);
    else result.omitted++;
  };
  return {
    add(chunk) {
      if (ended) return;
      for (const character of chunk.toString("utf8")) {
        if (character === "\n") {
          if (!dropping) line();
          pending = "";
          dropping = false;
        } else if (!dropping) {
          if (pending.length === 4096) {
            pending = "";
            dropping = true;
            result.truncated++;
          } else pending += character;
        }
      }
    },
    finish() {
      if (!ended && pending && !dropping) line();
      ended = true;
      return result;
    },
  };
}

export async function runTestProcess(args, options = {}) {
  const started = performance.now();
  // The suite includes Chromium and WebKit journeys; keep headroom under the 30-minute CI job.
  const deadlineMs = options.deadlineMs ?? 900000;
  const graceMs = options.graceMs ?? 5000;
  const forceWaitMs = options.forceWaitMs ?? 5000;
  for (const limit of [deadlineMs, graceMs, forceWaitMs])
    if (!Number.isFinite(limit) || limit <= 0)
      throw Error("Runner deadlines must be finite positive milliseconds");
  // Only tests transfer a ready child, together with its exact creation grant.
  const group = options.ownedChild
    ? options.ownedChild.ownsGroup
    : process.platform !== "win32";
  if (typeof group !== "boolean")
    throw Error("Transferred test child requires its group ownership grant");
  const child =
    options.ownedChild?.child ??
    spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
    });
  const pid = child.pid;
  if (
    options.ownedChild &&
    (options.ownedChild.pid !== pid ||
      child.exitCode !== null ||
      child.signalCode !== null)
  )
    throw Error(
      "Transferred test child must retain its live creation identity",
    );
  const stdout = diagnosticStream(),
    stderr = diagnosticStream();
  child.stdout.on("data", (chunk) => {
    stdout.add(chunk);
    if (options.forwardOutput) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.add(chunk);
    if (options.forwardOutput) process.stderr.write(chunk);
  });
  const closed = new Promise((resolve) =>
    child.once("close", () => resolve(true)),
  );
  let observed;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      observed = { code, signal };
      resolve(observed);
    });
    child.once("error", () => {
      observed = { code: null, signal: null, spawnFailed: true };
      resolve(observed);
    });
  });
  const wait = async (milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const terminationSignals = [];
  const signalOwned = (signal) => {
    if (
      observed ||
      !pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    try {
      if (group) process.kill(-pid, signal);
      else child.kill(signal);
      terminationSignals.push(signal);
    } catch {
      /* An unsuccessful signal is not proof of exit. */
    }
  };
  let interrupted;
  let interrupt;
  const interruption = new Promise((resolve) => {
    interrupt = resolve;
  });
  const handlers = new Map();
  if (options.forwardSignals)
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const handler = () => {
        interrupted ??= signal;
        interrupt({ interrupted: true });
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  let deadlineTimer;
  const first = await Promise.race([
    exited,
    interruption,
    new Promise((resolve) => {
      deadlineTimer = setTimeout(
        resolve,
        Math.max(1, deadlineMs - (performance.now() - started)),
      );
    }),
  ]);
  clearTimeout(deadlineTimer);
  const timedOut = first === undefined;
  if (timedOut || interrupted) {
    signalOwned("SIGTERM");
    if (!(await wait(graceMs))) {
      signalOwned("SIGKILL");
      await wait(forceWaitMs);
    }
  }
  let drainTimer;
  const outputComplete = await Promise.race([
    closed,
    new Promise((resolve) => {
      drainTimer = setTimeout(() => resolve(false), 100);
    }),
  ]);
  clearTimeout(drainTimer);
  child.stdout.destroy();
  child.stderr.destroy();
  if (!observed) child.unref();
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return {
    code: observed?.code ?? null,
    signal: observed?.signal ?? null,
    pid: pid ?? null,
    signalTarget: group ? "owned-process-group" : "owned-root-child",
    exitObserved: Boolean(observed && !observed.spawnFailed),
    spawnFailed: Boolean(observed?.spawnFailed),
    timedOut,
    interrupted: interrupted ?? null,
    ownershipHeld: !observed,
    elapsedMs: Math.round(performance.now() - started),
    limits: {
      deadlineMs,
      gracefulFollowupMs: graceMs,
      forcedFollowupMs: forceWaitMs,
    },
    terminationSignals,
    stdout: stdout.finish(),
    stderr: stderr.finish(),
    outputComplete,
    eventualExit: exited,
  };
}

export function runnerStatus(result) {
  if (result.timedOut) return result.exitObserved ? 124 : 125;
  if (result.interrupted)
    return result.exitObserved
      ? result.interrupted === "SIGINT"
        ? 130
        : 143
      : 125;
  return result.exitObserved
    ? (result.code ??
        (result.signal && constants.signals[result.signal]
          ? 128 + constants.signals[result.signal]
          : 1))
    : 125;
}

export async function recordRunnerEvidence(result, name, evidenceRoot) {
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const directory = await createTestEvidenceDirectory(
          "test-runner",
          name,
          evidenceRoot,
        );
        const { eventualExit: _eventualExit, ...manifest } = result;
        await writeTestEvidence(
          directory,
          "manifest.json",
          JSON.stringify(
            {
              ...manifest,
              wrapperStatus: runnerStatus(result),
              nodeVersion: process.version,
              exitProof: "owned root child only",
            },
            null,
            2,
          ),
        );
        for (const stream of ["stdout", "stderr"])
          await writeTestEvidence(
            directory,
            `${stream}.sanitized.log`,
            `${result[stream].lines.join("\n")}\nomitted=${result[stream].omitted} truncated=${result[stream].truncated}\n`,
          );
        return directory;
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Runner evidence wait ended after 5000ms")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function discoverTestFiles(root = ".") {
  const files = globSync("test/**/*.test.ts", { cwd: root })
    .sort()
    .map((source) => `dist/${source.slice(0, -3)}.js`);
  if (!files.length) throw Error("No test source files found");
  for (const file of files)
    if (!logicalSuites.some((suite) => file.startsWith(`dist/test/${suite}/`)))
      throw Error(`Test is outside the logical suites: ${file}`);
    else if (!existsSync(resolve(root, file)))
      throw Error(`Compiled test missing: ${file}; run npm run build first`);
  return files;
}

export const logicalSuites = [
  "coordination",
  "execution",
  "sources",
  "delivery",
  "workspaces",
  "operator",
  "operations",
  "infrastructure",
];

export function parseTestOptions(args) {
  const options = {
    profile: "all",
    suite: "all",
    shard: 1,
    shards: 1,
    preflight: false,
  };
  const seen = new Set();
  for (const arg of args) {
    const key = arg.split("=")[0];
    if (seen.has(key)) throw Error(`Duplicate test option: ${key}`);
    seen.add(key);
    if (arg === "--fixture-preflight") options.preflight = true;
    else if (arg.startsWith("--profile=")) options.profile = arg.slice(10);
    else if (arg.startsWith("--suite=")) options.suite = arg.slice(8);
    else if (arg.startsWith("--shard=")) {
      const match = /^--shard=([12])\/([12])$/.exec(arg);
      if (!match || Number(match[1]) > Number(match[2]))
        throw Error("Shard must be 1/1, 1/2 or 2/2");
      options.shard = Number(match[1]);
      options.shards = Number(match[2]);
    } else throw Error(`Unknown test option: ${arg}`);
  }
  if (!["all", "chromium", "service"].includes(options.profile))
    throw Error("Profile must be all, chromium or service");
  if (options.suite !== "all") {
    const suites = options.suite.split(",");
    if (
      new Set(suites).size !== suites.length ||
      suites.some((suite) => !logicalSuites.includes(suite))
    )
      throw Error(`Unknown or duplicate logical suites: ${options.suite}`);
  }
  if (
    options.preflight &&
    (options.suite !== "all" ||
      options.shards !== 1 ||
      options.profile === "service")
  )
    throw Error(
      "Fixture preflight requires all suites, no sharding and browser coverage",
    );
  return options;
}

export function selectTestFiles(files, options, timings = {}) {
  const selected = files.filter(
    (file) =>
      options.suite === "all" ||
      options.suite
        .split(",")
        .some((suite) => file.startsWith(`dist/test/${suite}/`)),
  );
  if (!selected.length)
    throw Error(`No tests selected for suite ${options.suite}`);
  if (options.shards === 1) return selected;
  const measured = Object.values(timings)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const fallback = measured[Math.floor(measured.length / 2)] ?? 1000;
  const weight = (file) => {
    const value = timings[file.replace(/^dist\//, "").replace(/\.js$/, ".ts")];
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const bins = Array.from({ length: options.shards }, () => ({
    files: [],
    weight: 0,
  }));
  for (const file of selected.toSorted(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const bin = bins.reduce((best, candidate) =>
      candidate.weight < best.weight ? candidate : best,
    );
    bin.files.push(file);
    bin.weight += weight(file);
  }
  const result = bins[options.shard - 1].files.sort();
  if (!result.length) throw Error("Selected shard contains no tests");
  return result;
}

async function main() {
  const options = parseTestOptions(process.argv.slice(2));
  const preflight = options.preflight;
  const files = preflight
    ? [
        "dist/test/infrastructure/operator-fixture-preflight.test.js",
        "dist/test/operator/operator-web-browser.test.js",
      ]
    : selectTestFiles(
        discoverTestFiles(),
        options,
        profileTimings(
          JSON.parse(
            readFileSync(
              new URL("./test-timings.json", import.meta.url),
              "utf8",
            ),
          ),
          options.profile,
        ),
      );
  if (!files.length) throw Error("No compiled test files found");
  process.stdout.write(
    `Test selection: suite=${options.suite} profile=${options.profile} shard=${options.shard}/${options.shards} files=${files.length}\n`,
  );
  const args = [
    "--test",
    ...(preflight
      ? [
          "--test-name-pattern=fixture preflight|failed browser assertion surfaces",
        ]
      : []),
    ...files,
  ];
  if (!preflight) {
    const directory = await createTestEvidenceDirectory(
      "test-runner",
      `${options.suite} ${options.profile} shard ${options.shard} timings`,
    );
    const destination = join(directory, "file-timings.ndjson");
    args.splice(
      1,
      0,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=./scripts/test-timing-reporter.mjs",
      `--test-reporter-destination=${destination}`,
    );
    process.stdout.write(`Test timings: ${destination}\n`);
  }
  const result = await runTestProcess(args, {
    env: {
      ...process.env,
      ENSEMBLE_TEST_PROFILE: options.profile,
      ENSEMBLE_TEST_BROWSER_ENGINE: {
        all: "all",
        chromium: "chromium",
        service: "none",
      }[options.profile],
    },
    forwardOutput: true,
    forwardSignals: true,
  });
  try {
    await recordRunnerEvidence(
      result,
      preflight
        ? "fixture preflight"
        : `${options.suite} ${options.profile} shard ${options.shard}/${options.shards}`,
    );
  } catch {
    process.stderr.write("Runner evidence incomplete\n");
    process.exitCode = runnerStatus(result) || 1;
    return;
  }
  process.exitCode = runnerStatus(result);
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
)
  await main();
