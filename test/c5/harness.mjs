// Pure helpers for the #827 Claude live journeys: grammar, budget ledger,
// evidence leak scan and exact-path cleanup. Nothing runs on import.
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const ROOT_PREFIX = "ensemble-c5-";
/** Per-attempt startTurn caps (#827 plan Guardrails). */
export const FACETS = {
  scrub: { claude: 1, codex: 0 },
  "claude-only": { claude: 8, codex: 0 },
  mixed: { claude: 3, codex: 4 },
  stop: { claude: 1, codex: 0 },
  // A completed turn, the killed follow-up and the recovered turn: only a
  // completed turn gives recovery a session to resume.
  crash: { claude: 3, codex: 0 },
};
export const GLOBAL_CAPS = { claude: 30, codex: 10 };
export const MAX_ATTEMPTS = 2;
export const TURN_MS = 4 * 60_000;
export const ATTEMPT_MS = 20 * 60_000;
export const SESSION_MS = 2 * 60 * 60_000;

export class BudgetExhausted extends Error {}

/** Accepts exactly `--live --facet <name>`; throws a refusal otherwise. */
export function parseArgs(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--live" ||
    args[1] !== "--facet" ||
    !Object.hasOwn(FACETS, args[2])
  )
    throw new Error(
      `Refusing live Claude journeys: use exactly --live --facet <${Object.keys(FACETS).join("|")}>`,
    );
  return args[2];
}

export const physicalTmpdir = () => realpathSync(tmpdir());
/** Outside any disposable root, so caps survive per-facet invocations. */
export const ledgerPath = () =>
  join(physicalTmpdir(), "ensemble-c5.ledger.json");

export const emptyLedger = (now = Date.now()) => ({
  sessionStartedAt: now,
  totals: { claude: 0, codex: 0 },
  attempts: {},
  current: null,
});

export function readLedger(file = ledgerPath()) {
  return existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : emptyLedger();
}

export function writeLedger(state, file = ledgerPath()) {
  // Write-then-rename, so a reader never sees a partial ledger.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

const LOCK_WAIT_MS = 10_000;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Runs `transition` on the ledger under an exclusive lock file holding the
 * owner's PID, so concurrent drivers cannot lose attempts or turn counts. A lock
 * whose owner has gone fails closed, like an open attempt: removing it
 * automatically could race another waiter and admit two owners.
 */
export function updateLedger(file, transition) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      writeFileSync(lock, String(process.pid));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let text;
      try {
        text = readFileSync(lock, "utf8");
      } catch (missing) {
        if (missing.code === "ENOENT") continue; // Released meanwhile: retry.
        throw missing;
      }
      // Empty only between its owner's create and PID write.
      const owner = Number(text || Number.NaN);
      if (Number.isInteger(owner) && owner > 0 && !alive(owner))
        throw new BudgetExhausted(
          "ledger lock is stale; remove it only after verifying no driver runs",
        );
      if (Date.now() > deadline)
        throw new BudgetExhausted(
          "ledger lock is still held or unreadable; verify no driver runs",
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const next = transition(readLedger(file));
    writeLedger(next, file);
    return next;
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Opens the next attempt of a facet; the model escalates only after a recorded compliance failure. */
export function beginAttempt(state, facet, now = Date.now()) {
  if (now - state.sessionStartedAt > SESSION_MS)
    throw new BudgetExhausted("session wall-time cap reached");
  const previous = state.attempts[facet] ?? [];
  if (previous.length >= MAX_ATTEMPTS)
    throw new BudgetExhausted(`${facet}: attempt cap reached`);
  const model =
    previous.at(-1)?.failureKind === "model-compliance" &&
    !previous.some((attempt) => attempt.model === "sonnet")
      ? "sonnet"
      : "haiku";
  const attempt = {
    number: previous.length + 1,
    model,
    startedAt: now,
    turns: { claude: 0, codex: 0 },
    outcome: "running",
    failureKind: null,
  };
  return {
    ...state,
    attempts: { ...state.attempts, [facet]: [...previous, attempt] },
    current: { facet, number: attempt.number },
  };
}

/** Reserves one startTurn against the per-attempt and global caps before it is made. */
export function reserveTurn(state, harness, now = Date.now()) {
  const current = state.current;
  if (!current) throw new BudgetExhausted("no open attempt");
  const attempts = state.attempts[current.facet];
  const attempt = attempts[current.number - 1];
  if (now - attempt.startedAt > ATTEMPT_MS)
    throw new BudgetExhausted("attempt wall-time cap reached");
  if (attempt.turns[harness] + 1 > FACETS[current.facet][harness])
    throw new BudgetExhausted(`${current.facet}: ${harness} turn cap reached`);
  if (state.totals[harness] + 1 > GLOBAL_CAPS[harness])
    throw new BudgetExhausted(`global ${harness} turn cap reached`);
  const updated = {
    ...attempt,
    turns: { ...attempt.turns, [harness]: attempt.turns[harness] + 1 },
  };
  return {
    ...state,
    totals: { ...state.totals, [harness]: state.totals[harness] + 1 },
    attempts: {
      ...state.attempts,
      [current.facet]: attempts.map((item, index) =>
        index === current.number - 1 ? updated : item,
      ),
    },
  };
}

export function finishAttempt(state, outcome, failureKind = null) {
  const { facet, number } = state.current;
  return {
    ...state,
    attempts: {
      ...state.attempts,
      [facet]: state.attempts[facet].map((item, index) =>
        index === number - 1 ? { ...item, outcome, failureKind } : item,
      ),
    },
    current: null,
  };
}

/**
 * Opens one attempt in the ledger file, runs `body`, and always closes the
 * attempt, as failed when `body` throws. A still-open attempt (a driver that was
 * killed) refuses new attempts until it is closed by hand.
 */
export async function withAttempt(file, facet, body) {
  const next = updateLedger(file, (state) => {
    if (state.current)
      throw new BudgetExhausted(
        `attempt ${state.current.facet}#${state.current.number} is still open; close it only after verifying no driver runs`,
      );
    return beginAttempt(state, facet);
  });
  let result = { outcome: "failed", failureKind: "harness" };
  try {
    result = await body(next.attempts[facet].at(-1));
    return result;
  } finally {
    updateLedger(file, (state) =>
      finishAttempt(state, result.outcome, result.failureKind),
    );
  }
}

/** File-backed reservation shared by the driver and its child service. */
export function reserveTurnInFile(harness, file = ledgerPath()) {
  return updateLedger(file, (state) => reserveTurn(state, harness));
}

/** Exit 0 only for a passed attempt with a clean leak scan; inconclusive fails. */
export const exitCode = ({ leaks, failure, outcome }) =>
  leaks.length || failure || outcome !== "passed" ? 1 : 0;

/** Labels of secret or local-path material found in evidence text; empty when clean. */
export function scanForLeaks(text, { token, roots = [], home } = {}) {
  const findings = [];
  if (token && text.includes(token)) findings.push("token-value");
  if (text.includes("sk-ant-")) findings.push("sk-ant-prefix");
  if (/Bearer\s+(?!<redacted-token>)\S/.test(text)) findings.push("bearer");
  if (/CLAUDE_CODE_OAUTH_TOKEN=(?!<redacted-token>)\S/.test(text))
    findings.push("token-assignment");
  for (const root of roots)
    if (root && text.includes(root)) findings.push("disposable-root");
  if (home && text.includes(home)) findings.push("home-path");
  return findings;
}

/** Removes only a real, non-symlinked `ensemble-c5-*` directory directly under the temp root. */
export function removeRoot(path) {
  const full = resolve(path);
  const parent = physicalTmpdir();
  if (
    dirname(full) !== parent ||
    !basename(full).startsWith(ROOT_PREFIX) ||
    !lstatSync(full).isDirectory() ||
    realpathSync(full) !== full
  )
    throw new Error("Refusing to remove a path that is not a C5 root");
  rmSync(full, { recursive: true, force: true });
  return !existsSync(full);
}
