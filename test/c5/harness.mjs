// Pure helpers for the #827 Claude live journeys: grammar, budget ledger,
// evidence leak scan and exact-path cleanup. Nothing runs on import.
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
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
  crash: { claude: 2, codex: 0 },
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
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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

/** File-backed reservation shared by the driver and its child service. */
export function reserveTurnInFile(harness, file = ledgerPath()) {
  const next = reserveTurn(readLedger(file), harness);
  writeLedger(next, file);
  return next;
}

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
