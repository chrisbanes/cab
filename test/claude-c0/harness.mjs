// Shared helpers for the #822 Claude Agent SDK probes. Live steps run only
// through run.mjs; nothing here imports the SDK at module load.
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureProcessIdentity,
  MacProcessTerminationVerifier,
} from "../../dist/src/standalone/termination.js";

export const ROOT_PREFIX = "ensemble-claude-c0-";
export const QUERY_CAP = 60;
export const QUERY_DEADLINE_MS = 120_000;
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STEPS = ["init", "p7", "p8", "p1", "p3", "p4", "p5", "p6", "cleanup"];
const verifier = new MacProcessTerminationVerifier();
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** Parses `--live <step> [--root <dir>]` or `summary --root <dir>`; throws otherwise. */
export function requireLive(args) {
  const [first, second, flag, root, ...rest] = args;
  if (first === "summary" && second === "--root" && flag && root === undefined)
    return { step: "summary", root: flag };
  const ok =
    first === "--live" &&
    STEPS.includes(second) &&
    rest.length === 0 &&
    (second === "init"
      ? flag === undefined
      : flag === "--root" && typeof root === "string" && root.length > 0);
  if (!ok)
    throw new Error(
      "Refusing Claude SDK probes: use --live init, --live <p7|p8|p1|p3|p4|p5|p6|cleanup> --root <dir>, or summary --root <dir>",
    );
  return { step: second, root };
}

export function createRoot() {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  for (const dir of [
    "sdk",
    "config",
    "home",
    "tmp",
    "workspace",
    "outside",
    "traces",
    "results",
  ])
    mkdirSync(join(root, dir));
  return root;
}

function realOrParent(path) {
  // Resolves symlinks in the deepest existing ancestor.
  let current = resolve(path);
  const tail = [];
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...tail);
}

export function assertInside(root, path) {
  const rel = relative(realpathSync(root), realOrParent(path));
  if (rel === "" || rel.startsWith("..") || resolve(rel) === rel)
    throw new Error("Path escapes the disposable root");
  return resolve(path);
}

export function assertCleanupRoot(path) {
  const full = resolve(path);
  const parents = new Set([tmpdir(), realpathSync(tmpdir())]);
  if (
    !parents.has(dirname(full)) ||
    !basename(full).startsWith(ROOT_PREFIX) ||
    !existsSync(full) ||
    realpathSync(full) !== join(realpathSync(tmpdir()), basename(full))
  )
    throw new Error("Refusing to remove a path that is not a probe root");
  return full;
}

/** Reads only CLAUDE_CODE_OAUTH_TOKEN, from the environment then ~/.env. */
export function loadToken(
  env = process.env,
  envFile = join(homedir(), ".env"),
) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN=(.*)$/.exec(line);
    if (match) {
      const value = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Allowlist environment; `env` replaces the CLI's environment entirely. */
export function buildEnv(root, token, source = process.env) {
  return {
    PATH: source.PATH ?? "/usr/bin:/bin",
    TMPDIR: join(root, "tmp"),
    LANG: source.LANG ?? "en_US.UTF-8",
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "config"),
    ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
  };
}

const FIELD_LIMIT = 2048;
export function redact(value, context) {
  if (typeof value === "string") {
    let text = value;
    if (context.token)
      text = text.split(context.token).join("<redacted-token>");
    text = text
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, "<redacted-token>")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted-token>");
    const paths = [
      [context.root, "<disposable-root>"],
      [context.repo, "<repo>"],
      [context.home, "<user-home>"],
    ];
    for (const [path, label] of paths) {
      if (!path) continue;
      // The resolved variant first: /private/var contains /var. Claude Code
      // also names project directories by the path with non-alphanumerics as "-".
      const real = realOrParent(path);
      for (const variant of new Set([
        real,
        path,
        real.replace(/[^A-Za-z0-9]/g, "-"),
        path.replace(/[^A-Za-z0-9]/g, "-"),
      ]))
        text = text.split(variant).join(label);
    }
    return text.length > FIELD_LIMIT
      ? `${text.slice(0, FIELD_LIMIT)}…[truncated ${text.length - FIELD_LIMIT} chars]`
      : text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, context));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, context)]),
    );
  return value;
}

export function redactionContext(root, token) {
  return { root, token, repo: REPO, home: homedir() };
}

/** Appends redacted JSON lines; nothing unredacted is ever written. */
export function createRecorder(root, step, token) {
  const context = redactionContext(root, token);
  const file = join(root, "traces", `${step}.jsonl`);
  return {
    context,
    record(event, data = {}) {
      appendFileSync(
        file,
        `${JSON.stringify(redact({ at: new Date().toISOString(), event, ...data }, context))}\n`,
      );
    },
    redact: (value) => redact(value, context),
  };
}

export function processTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, pgid, command] =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line) ?? [];
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        command,
      };
    });
}

export function descendants(pid, table = processTable()) {
  const found = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of table)
      if (row.ppid === parent) {
        found.push(row);
        queue.push(row.pid);
      }
  }
  return found;
}

const psRow = (pid) =>
  new Promise((done) =>
    execFile(
      "ps",
      ["-o", "pgid=,command=", "-p", String(pid)],
      { encoding: "utf8" },
      (error, out) => {
        const match = /^\s*(\d+)\s(.*)$/.exec(out?.trim() ?? "");
        done(
          error || !match
            ? null
            : { pgid: Number(match[1]), command: match[2] },
        );
      },
    ),
  );

/** Spawns the CLI as the SDK asks, captures its identity and counts both streams. */
export function spawnWrapper(recorder, prefix = []) {
  const procs = [];
  const spawnClaudeCodeProcess = (options) => {
    const [command, ...args] = [...prefix, options.command, ...options.args];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const entry = {
      pid: child.pid,
      command: options.command,
      args: options.args,
      envKeys: Object.keys(options.env ?? {}).sort(),
      optionKeys: Object.keys(options).sort(),
      identity: captureProcessIdentity(child.pid),
      ps: psRow(child.pid),
      stdout: { bytes: 0, lines: 0, largestLine: 0 },
      stderr: { bytes: 0 },
      exit: new Promise((done) =>
        child.once("exit", (code, signal) => done({ code, signal })),
      ),
      child,
    };
    let pending = 0;
    child.stdout.on("data", (chunk) => {
      entry.stdout.bytes += chunk.length;
      let start = 0;
      for (
        let at = chunk.indexOf(10);
        at !== -1;
        at = chunk.indexOf(10, start)
      ) {
        entry.stdout.lines++;
        entry.stdout.largestLine = Math.max(
          entry.stdout.largestLine,
          pending + at - start,
        );
        pending = 0;
        start = at + 1;
      }
      pending += chunk.length - start;
    });
    child.stderr.on("data", (chunk) => {
      entry.stderr.bytes += chunk.length;
    });
    child.on("error", (error) =>
      recorder.record("spawn-error", { message: String(error?.message) }),
    );
    procs.push(entry);
    return child;
  };
  return { procs, spawnClaudeCodeProcess };
}

const sameIdentity = (a, b) =>
  a &&
  b &&
  a.processId === b.processId &&
  a.processStartedAt === b.processStartedAt &&
  a.bootId === b.bootId;

/** Signals only a PID whose birth identity still matches; TERM, wait, then KILL. */
export async function terminateExact(
  identity,
  recorder,
  label,
  { waitMs = 5000, signals = ["SIGTERM", "SIGKILL"] } = {},
) {
  if (!identity) {
    recorder.record("terminate", { label, outcome: "no-identity" });
    return "unknown";
  }
  for (const signal of signals) {
    const before = await verifier.verify(identity);
    if (before.kind === "verified") {
      recorder.record("terminate", { label, signal, outcome: "already-gone" });
      return "verified";
    }
    const current = await captureProcessIdentity(Number(identity.processId));
    if (!sameIdentity(current, identity)) {
      recorder.record("terminate", {
        label,
        signal,
        outcome: "identity-mismatch",
      });
      return "conflict";
    }
    process.kill(Number(identity.processId), signal);
    recorder.record("terminate", { label, signal, pid: identity.processId });
    for (let waited = 0; waited < waitMs; waited += 100) {
      await delay(100);
      if ((await verifier.verify(identity)).kind === "verified") {
        recorder.record("terminate", { label, signal, outcome: "verified" });
        return "verified";
      }
    }
  }
  return (await verifier.verify(identity)).kind;
}

export const verifyExit = (identity) =>
  identity
    ? verifier.verify(identity)
    : Promise.resolve({ kind: "unknown", reason: "no identity" });

/** Persists the model-backed query count against the cap. */
export function consumeQuery(root) {
  const file = join(root, "results", "budget.json");
  const used = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8")).used
    : 0;
  if (used >= QUERY_CAP) return false;
  writeFileSync(
    file,
    `${JSON.stringify({ used: used + 1, cap: QUERY_CAP })}\n`,
  );
  return true;
}

export function queryCount(root) {
  const file = join(root, "results", "budget.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).used : 0;
}

export class BudgetExhausted extends Error {}

/** Summarizes a message as types only, never bodies. */
export function shape(message) {
  const blocks = Array.isArray(message?.message?.content)
    ? message.message.content.map((block) => block.type)
    : undefined;
  return {
    type: message?.type,
    ...(message?.subtype ? { subtype: message.subtype } : {}),
    ...(blocks ? { blocks } : {}),
  };
}

/**
 * Runs one query() under a deadline with abort and exact-PID cleanup.
 * `onMessage(message, context)` may abort or inspect the live query.
 */
export async function runQuery({
  sdk,
  root,
  recorder,
  label,
  prompt,
  options,
  modelBacked,
  onMessage,
  prefix,
  deadlineMs = QUERY_DEADLINE_MS,
}) {
  if (modelBacked && !consumeQuery(root)) throw new BudgetExhausted(label);
  const wrapper = spawnWrapper(recorder, prefix);
  const abortController = options.abortController ?? new AbortController();
  const stderrChunks = { bytes: 0 };
  const run = {
    label,
    messages: [],
    procs: wrapper.procs,
    stderrCallbackBytes: 0,
    error: null,
    timedOut: false,
  };
  abortController.signal.addEventListener("abort", () => {
    run.abortedAt = Date.now();
  });
  const timer = setTimeout(() => {
    run.timedOut = true;
    abortController.abort();
  }, deadlineMs);
  const startedAt = Date.now();
  try {
    const q = sdk.query({
      prompt,
      options: {
        ...options,
        abortController,
        spawnClaudeCodeProcess: wrapper.spawnClaudeCodeProcess,
        stderr: (data) => {
          stderrChunks.bytes += Buffer.byteLength(data);
        },
      },
    });
    run.query = q;
    for await (const message of q) {
      run.messages.push(message);
      if (message.type === "system" && message.subtype === "init")
        run.init = message;
      if (message.type === "result") run.result = message;
      recorder.record("message", { label, ...shape(message) });
      if (onMessage) await onMessage(message, { q, abortController, run });
    }
  } catch (error) {
    run.error = {
      name: error?.name,
      message: String(error?.message ?? error).slice(0, 500),
    };
    recorder.record("query-error", { label, ...run.error });
  } finally {
    clearTimeout(timer);
  }
  run.settledMs = Date.now() - startedAt;
  run.settledAfterAbortMs = run.abortedAt ? Date.now() - run.abortedAt : null;
  run.stderrCallbackBytes = stderrChunks.bytes;
  for (const proc of wrapper.procs) {
    proc.identity = await proc.identity;
    proc.ps = await proc.ps;
    const exit = await Promise.race([
      proc.exit,
      delay(10_000).then(() => null),
    ]);
    proc.exitStatus = exit;
    if (!exit) {
      proc.killedByHarness = true;
      await terminateExact(proc.identity, recorder, `${label}:cli`);
    }
    proc.verification = (await verifyExit(proc.identity)).kind;
  }
  recorder.record("query-settled", {
    label,
    settledMs: run.settledMs,
    timedOut: run.timedOut,
    result: run.result
      ? {
          subtype: run.result.subtype,
          is_error: run.result.is_error,
          terminal_reason: run.result.terminal_reason,
          num_turns: run.result.num_turns,
        }
      : null,
    procs: wrapper.procs.map((proc) => ({
      pid: proc.pid,
      exit: proc.exitStatus,
      verification: proc.verification,
      stdout: proc.stdout,
      stderr: proc.stderr,
    })),
    stderrCallbackBytes: run.stderrCallbackBytes,
  });
  return run;
}

/** Imports the SDK from the disposable install; never called at module load. */
export async function loadSdk(root) {
  const entry = join(root, "sdk", "entry.mjs");
  // Bare specifiers resolve from <root>/sdk/node_modules, never the repository.
  writeFileSync(
    entry,
    [
      'export * as sdk from "@anthropic-ai/claude-agent-sdk";',
      'export { z } from "zod";',
      'export { Client } from "@modelcontextprotocol/sdk/client/index.js";',
      'export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";',
      "",
    ].join("\n"),
  );
  return import(pathToFileURL(entry).href);
}

export function baseOptions(root, token, extra = {}) {
  return {
    cwd: join(root, "workspace"),
    env: buildEnv(root, token),
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    model: "haiku",
    effort: "low",
    tools: [],
    ...extra,
  };
}

/** The session transcript as record and block types with tool pairing, no bodies. */
export function transcript(root, sessionId) {
  const projects = join(root, "config", "projects");
  const dir = existsSync(projects)
    ? readdirSync(projects).find((name) =>
        existsSync(join(projects, name, `${sessionId}.jsonl`)),
      )
    : undefined;
  if (!dir) return null;
  const file = join(projects, dir, `${sessionId}.jsonl`);
  const records = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const results = new Map();
  for (const record of records)
    for (const block of Array.isArray(record.message?.content)
      ? record.message.content
      : [])
      if (block.type === "tool_result")
        results.set(block.tool_use_id, block.is_error === true);
  return {
    file,
    records: records.map((record) => {
      const content = record.message?.content;
      return {
        type: record.type,
        ...(record.subtype ? { subtype: record.subtype } : {}),
        ...(Array.isArray(content)
          ? {
              blocks: content.map((block) =>
                block.type === "tool_use"
                  ? `tool_use:${block.name}:${results.has(block.id) ? (results.get(block.id) ? "error-result" : "result") : "unpaired"}`
                  : block.type === "tool_result"
                    ? `tool_result${block.is_error ? ":error" : ""}`
                    : block.type,
              ),
            }
          : {}),
      };
    }),
  };
}

/** Tool uses from assistant messages and tool results from user messages. */
export function toolCalls(messages) {
  const uses = [];
  const results = new Map();
  for (const message of messages) {
    for (const block of Array.isArray(message.message?.content)
      ? message.message.content
      : []) {
      if (message.type === "assistant" && block.type === "tool_use")
        uses.push({ id: block.id, name: block.name, input: block.input });
      if (message.type === "user" && block.type === "tool_result") {
        const text = Array.isArray(block.content)
          ? block.content.map((part) => part.text ?? `[${part.type}]`).join("")
          : String(block.content ?? "");
        results.set(block.tool_use_id, {
          isError: block.is_error === true,
          chars: text.length,
          text: text.slice(0, 400),
        });
      }
    }
  }
  return uses.map((use) => ({ ...use, result: results.get(use.id) ?? null }));
}

export const resultText = (run) =>
  typeof run.result?.result === "string" ? run.result.result : "";

/** null when the F7.1 subscription gate passed, else the reason live facets are untested. */
export function authGate(root, token) {
  if (!token) return "no subscription token";
  const file = join(root, "results", "p7.json");
  if (!existsSync(file)) return "F7.1 not run";
  const gate = readJson(file).facets.find((item) => item.id === "F7.1");
  return gate?.disposition === "passed"
    ? null
    : `F7.1 ${gate?.disposition ?? "missing"}: ${gate?.reason ?? "authentication failed"}`;
}

/** Runs one facet; cap and harness errors become untested with the reason. */
export async function attempt(id, adr, gate, work) {
  if (gate) return facet(id, adr, "untested", null, gate);
  try {
    return await work();
  } catch (error) {
    return facet(
      id,
      adr,
      "untested",
      null,
      error instanceof BudgetExhausted
        ? "model-backed query cap reached"
        : `harness error: ${String(error?.message ?? error).slice(0, 200)}`,
    );
  }
}

/** Identities, exits and stream counts for a result file. */
export function procSummary(run) {
  return run.procs.map((proc) => ({
    pid: proc.pid,
    identityCaptured: proc.identity !== null,
    exit: proc.exitStatus,
    verification: proc.verification,
    killedByHarness: proc.killedByHarness === true,
    stdout: proc.stdout,
    stderrBytes: proc.stderr.bytes,
  }));
}

export function facet(id, adr, disposition, observation, reason) {
  if (disposition === "untested" && !reason)
    throw new Error(`Facet ${id} is untested without a reason`);
  return {
    id,
    adr,
    disposition,
    ...(reason ? { reason } : {}),
    observation,
  };
}

export function probeDisposition(facets) {
  for (const item of facets)
    if (item.disposition === "untested" && !item.reason)
      throw new Error(`Facet ${item.id} is untested without a reason`);
  if (facets.some((item) => item.adr && item.disposition === "failed"))
    return "failed";
  if (facets.some((item) => item.disposition === "untested")) return "untested";
  return "passed";
}

export function returnedToChris(facets) {
  return facets.filter((item) => item.adr && item.disposition === "failed");
}

/** Checks every declared facet is present and returns per-probe rows. */
export function summarize(results, declared) {
  const rows = [];
  for (const [step, ids] of Object.entries(declared)) {
    const facets = results[step]?.facets;
    if (!facets) throw new Error(`Missing result file for ${step}`);
    for (const id of ids)
      if (!facets.some((item) => item.id === id))
        throw new Error(`Result for ${step} omits facet ${id}`);
    rows.push({ step, disposition: probeDisposition(facets), facets });
  }
  return rows;
}

export function writeResult(root, step, facets, extra = {}) {
  const context = redactionContext(root, null);
  writeFileSync(
    join(root, "results", `${step}.json`),
    `${JSON.stringify(redact({ step, facets, ...extra }, context), null, 2)}\n`,
  );
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function cleanupRoot(root) {
  rmSync(assertCleanupRoot(root), { recursive: true, force: true });
}

/** Exact descendant processes with birth identities, for later survivor checks. */
export async function descendantIdentities(pid) {
  return Promise.all(
    descendants(pid).map(async (row) => ({
      command: row.command.split(" ")[0],
      identity: await captureProcessIdentity(row.pid),
    })),
  );
}

/** Outcome of an abort: how the query ended and whether the CLI exited by itself. */
export function abortOutcome(run) {
  const proc = run.procs[0];
  return {
    abortedAt: run.abortedAt ? "yes" : "no",
    settledAfterAbortMs: run.settledAfterAbortMs,
    thrown: run.error,
    result: run.result
      ? {
          subtype: run.result.subtype,
          is_error: run.result.is_error,
          terminal_reason: run.result.terminal_reason,
          errors: run.result.errors,
        }
      : null,
    cliExit: proc?.exitStatus,
    cliVerification: proc?.verification,
    killedByHarness: proc?.killedByHarness === true,
  };
}

export const abortPassed = (outcome) =>
  outcome.abortedAt === "yes" &&
  outcome.settledAfterAbortMs !== null &&
  outcome.settledAfterAbortMs <= 15_000 &&
  outcome.cliVerification === "verified" &&
  !outcome.killedByHarness &&
  (outcome.thrown !== null ||
    outcome.result?.is_error === true ||
    (outcome.result?.terminal_reason ?? "completed") !== "completed");
export { captureProcessIdentity };
