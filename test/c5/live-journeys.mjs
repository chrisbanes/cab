// Guarded live Claude journeys for #827. Refuses without exactly
// `--live --facet <name>`; the token, launcher, versions and dist imports are
// checked before the ledger attempt opens or any disposable root exists.
// Prints redacted, leak-scanned evidence JSON only.
import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_MS,
  BudgetExhausted,
  ledgerPath,
  parseArgs,
  physicalTmpdir,
  ROOT_PREFIX,
  readLedger,
  removeRoot,
  scanForLeaks,
  TURN_MS,
  withAttempt,
} from "./harness.mjs";
import {
  SLEEP,
  setupJourney,
  shellOnly,
  startJourneyService,
  TOKEN_VARIABLE,
} from "./service-child.mjs";

const refuse = (message) => {
  process.stderr.write(`Refusing live Claude journeys: ${message}\n`);
  process.exit(2);
};
let facet;
try {
  facet = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
const c0 = await import("../claude-c0/harness.mjs");
const token = c0.loadToken();
if (!token) refuse("token unavailable (CLAUDE_CODE_OAUTH_TOKEN)");
// The service reads the token only through its env: reference.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const launcher =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
if (!existsSync(launcher)) refuse("the approved Codex launcher is absent");

// Everything that can fail before work starts runs before the attempt opens.
const { claudeTemporaryBase, releaseClaudeTemporaryBase } = await import(
  "../../dist/src/standalone/claude.js"
);
const { captureProcessIdentity } = await import(
  "../../dist/src/standalone/termination.js"
);
const sdkPackage = JSON.parse(
  readFileSync(
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    "utf8",
  ),
);
const evidence = {
  facet,
  attempt: null,
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: process.version,
  sdk: sdkPackage.version,
  claudeCode: sdkPackage.claudeCodeVersion ?? null,
  codex: {
    launcherSha256: createHash("sha256")
      .update(readFileSync(launcher))
      .digest("hex"),
    version: execFileSync(launcher, ["--version"], {
      encoding: "utf8",
    }).trim(),
  },
  model: null,
  stage: "fixture",
  outcome: "failed",
  failure: null,
  observations: {},
  startTurn: { turns: 0, refused: [] },
  processes: [],
  trace: [],
  cleanup: { serviceStopped: false, temporaryBases: [], rootRemoved: false },
};
const ledgerFile = ledgerPath();
const { delay } = c0;

class ComplianceError extends Error {}
const stage = (name) => {
  evidence.stage = name;
  process.stderr.write(`[c5-live] ${facet} ${name}\n`);
};
const trace = {
  record: (event, data) => evidence.trace.push({ event, ...data }),
};
let attemptDeadline = Date.now() + ATTEMPT_MS;
let root;
/** Everything cleanup must reach, whichever path ends the attempt. */
const active = {
  current: null,
  watchdog: null,
  codex: [],
  children: [],
  claude: new Map(),
  workspaces: new Set(),
};
const noteClaude = (records) => {
  for (const r of records)
    if (r.processIdentity)
      active.claude.set(
        `${r.processIdentity.processId}:${r.processIdentity.processStartedAt}`,
        r.processIdentity,
      );
};

/** Polls within the attempt's wall time; a missing model action is a compliance failure. */
async function waitUntil(predicate, ms, what, compliance = false) {
  const deadline = Math.min(Date.now() + ms, attemptDeadline);
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline)
      throw new (compliance ? ComplianceError : Error)(`${what} timed out`);
    await delay(500);
  }
}

const settledProcesses = new Map();
/** Waits for an exact process to exit; stops it by verified identity only after the grace period. */
async function settleProcess(label, identity, graceMs = 10_000) {
  if (!identity) return { label, exitedByItself: false, verification: "none" };
  const key = `${identity.processId}:${identity.processStartedAt}`;
  if (settledProcesses.has(key)) return settledProcesses.get(key);
  const entry = { label, exitedByItself: false, verification: "unknown" };
  settledProcesses.set(key, entry);
  evidence.processes.push(entry);
  const until = Date.now() + graceMs;
  do {
    if ((await c0.verifyExit(identity)).kind === "verified") {
      entry.exitedByItself = true;
      entry.verification = "verified";
      return entry;
    }
    await delay(200);
  } while (Date.now() < until);
  entry.verification = await c0.terminateExact(identity, trace, label);
  return entry;
}

function gitFixture() {
  const repository = join(root, "repo");
  mkdirSync(repository, { mode: 0o700 });
  const git = (...args) =>
    execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=C5",
    "-c",
    "user.email=c5@invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  return repository;
}

function findFile(directory, name, depth = 3) {
  if (depth < 0 || !existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory() && entry.name !== ".git") {
      const found = findFile(path, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

const running = (records) =>
  records.find((r) => r.intent.state === "running" && r.processIdentity);
const settled = (state) => !["running", "submitting"].includes(state);

/** In-process service for every facet but crash; each turn gets TURN_MS, then Stop. */
async function inProcess(run) {
  // Before the service exposes the token, so git children never inherit it.
  const repository = gitFixture();
  const current = await startJourneyService({
    dataDir: join(root, "data"),
    launcher,
    ledgerFile,
    token,
  });
  if (active.closing) {
    // Cleanup already ran; this late service must not outlive the attempt.
    await current.service.stop().catch(() => {});
    for (const identity of [
      ...current.priorProcesses,
      current.observed.runtimes.codex?.processIdentity?.(),
    ])
      await settleProcess("codex-app-server (late)", identity);
    throw new Error("attempt closed during service start");
  }
  active.current = current;
  active.codex.push(...current.priorProcesses);
  for (const identity of current.priorProcesses)
    await settleProcess("codex-app-server (before token)", identity);
  active.codex.push(current.observed.runtimes.codex?.processIdentity?.());
  let timedOut = false;
  active.watchdog = setInterval(() => {
    const now = Date.now();
    for (const turn of current.observed.turns)
      if (
        now - turn.at > TURN_MS &&
        current.taskId &&
        current.service
          .list()
          .some((i) => i.turnId === turn.turnId && i.state === "running")
      ) {
        timedOut = true;
        void current.service.stopTask(current.taskId).catch(() => {});
      }
  }, 5000);
  const check = () => {
    if (timedOut)
      throw new Error("a turn exceeded its time cap and was stopped");
  };
  const ids = await setupJourney(current.service, {
    facet,
    model: evidence.model.claude,
    repository,
  });
  current.taskId = ids.taskId;
  await run(current, ids, check);
}

async function coordination(current, ids, check) {
  const calls = current.observed.calls;
  const tool = (name, harness) =>
    waitUntil(
      () => {
        check();
        return calls.find(
          (c) => c.tool === name && c.harness === harness && c.success !== null,
        );
      },
      TURN_MS,
      `${harness} ${name}`,
      true,
    );
  const leadHarness = facet === "mixed" ? "codex" : "claude";
  const delegate = await tool("ensemble_delegate", leadHarness);
  if (!delegate.success)
    throw new ComplianceError("ensemble_delegate was rejected");
  if (facet === "claude-only") {
    const question = await waitUntil(
      () => {
        check();
        return current.service.coordinationView().readTask(ids.taskId)
          .questions[0];
      },
      TURN_MS,
      "worker question",
      true,
    );
    await current.service.coordinationView().answerQuestion({
      key: randomUUID(),
      taskId: ids.taskId,
      interactionId: question.interactionId,
      expectedRevision: question.revision,
      answer: "ready",
    });
  }
  const report = await tool("ensemble_report_result", "claude");
  if (!report.success)
    throw new ComplianceError("ensemble_report_result was rejected");
  await waitUntil(
    () => {
      check();
      return current.service.domain().task(ids.taskId).state === "done";
    },
    2 * TURN_MS,
    "task completion",
    true,
  );
  const view = current.service.coordinationView().readTask(ids.taskId);
  const turns = current.observed.turns;
  evidence.observations = {
    leadHarness,
    questionAnswered: facet === "claude-only",
    resultNonceMatched: view.results.some((r) =>
      String(r.summary ?? "").includes(`C5_RESULT_${ids.nonce}`),
    ),
    completionFinalized: view.completionRequests.some(
      (r) => r.status === "finalized",
    ),
    turnsByHarness: {
      claude: turns.filter((t) => t.harness === "claude").length,
      codex: turns.filter((t) => t.harness === "codex").length,
    },
    tools: calls.map(({ harness, tool, success }) => ({
      harness,
      tool,
      success,
    })),
  };
  if (!evidence.observations.resultNonceMatched)
    throw new ComplianceError("no result carries the nonce");
  if (!evidence.observations.completionFinalized)
    throw new Error("completion was not finalized");
}

const PROBE_FILES = ["env-names.txt", "env-full.txt", "ps-parent.txt"];
async function scrub(current, ids, check) {
  await waitUntil(
    () => {
      check();
      return (
        PROBE_FILES.every((name) => findFile(ids.workspace, name)) &&
        current.service.list().every((i) => settled(i.state))
      );
    },
    TURN_MS,
    "probe files",
    true,
  );
  // Read in memory, keep booleans only, and delete before any evidence is written.
  const [names, full, ps] = PROBE_FILES.map((name) =>
    readFileSync(findFile(ids.workspace, name), "utf8"),
  );
  for (const name of PROBE_FILES) rmSync(findFile(ids.workspace, name));
  const listed = names.split("\n");
  const o = {
    tokenNamePresent: listed.includes("CLAUDE_CODE_OAUTH_TOKEN"),
    referenceNamePresent: listed.includes(TOKEN_VARIABLE),
    tokenValueInEnv: full.includes(token),
    tokenValueInParentPs: ps.includes(token),
    parentPsReadable: !/ps-error|not permitted/i.test(ps),
    controlPresent: listed.includes("ENSEMBLE_C5_CONTROL"),
    hooksAndStdioMcp:
      "not applicable: the hook runs in-process and strict MCP config allows no stdio servers",
  };
  o.disposition = !o.controlPresent
    ? "inconclusive"
    : o.tokenValueInEnv || o.tokenValueInParentPs
      ? "residual-exposure"
      : o.tokenNamePresent || o.referenceNamePresent
        ? "inconclusive"
        : "qualified";
  evidence.observations = o;
}

async function stop(current, ids, check) {
  const records = () => {
    const r = current.service.recoveryForTask(ids.taskId);
    noteClaude(r);
    return r;
  };
  const record = await waitUntil(
    () => {
      check();
      return running(records());
    },
    TURN_MS,
    "running Claude turn with a process identity",
    true,
  );
  await delay(15_000); // Lets the sleep start inside the turn.
  if (!running(records()))
    // Not compliance: the CLI's own refusal ended the first such turn (#827).
    throw new Error("the turn ended before Stop; sleep did not run");
  const starts = () =>
    current.observed.turns.length + current.observed.refused.length;
  const before = starts();
  const observation = await current.service.stopTask(ids.taskId);
  const after = await waitUntil(
    () => {
      const r = records().find((x) => x.workId === record.workId);
      return r && settled(r.intent.state) ? r : null;
    },
    60_000,
    "stopped turn to settle",
  );
  const cli = await settleProcess(
    "claude-cli (stopped turn)",
    record.processIdentity,
    15_000,
  );
  await delay(30_000);
  const outcome = observation.outcomes.find((o) => o.workId === record.workId);
  evidence.observations = {
    interrupt: outcome?.interrupt ?? null,
    terminal: outcome?.terminal ?? null,
    stateAfter: after.intent.state,
    holds: after.holds,
    cliExitedByItself: cli.exitedByItself,
    startTurnAfterStop: starts() - before,
  };
  const observed =
    outcome?.interrupt === "acknowledged" && outcome.terminal === "observed";
  if (!observed && !(after.intent.state === "held" && after.holds.writer))
    throw new Error("Stop was neither observed nor held with the writer hold");
  if (!cli.exitedByItself) throw new Error("the Claude CLI survived Stop");
  if (evidence.observations.startTurnAfterStop !== 0)
    throw new Error("a turn started after Stop");
}

const IPC_MS = 120_000;
/** Forks the journey service; every call times out and fails when the child exits. */
async function spawnChild() {
  if (active.closing) throw new Error("attempt closed; no new service child");
  const child = fork(new URL("./service-child.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const entry = {
    child,
    identity: await captureProcessIdentity(child.pid),
    pending: new Map(),
    refused: [],
  };
  entry.exited = new Promise((done) => child.once("exit", done));
  active.children.push(entry);
  const failAll = (error) => {
    for (const call of entry.pending.values()) call.failed(error);
    entry.pending.clear();
  };
  child.once("exit", () => failAll(new Error("service child exited")));
  child.once("error", failAll);
  await new Promise((ready, failed) => {
    child.once("exit", () => failed(new Error("service child exited")));
    child.once("error", failed);
    child.on("message", (message) => {
      if (message.ready) return ready();
      const call = entry.pending.get(message.id);
      entry.pending.delete(message.id);
      if (message.error) call?.failed(new Error(message.error));
      else call?.done(message.result);
    });
  });
  entry.call = (op, args) =>
    new Promise((done, failed) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        failed(new Error(`service child ${op} timed out`));
      }, IPC_MS);
      entry.pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        failed: (error) => {
          clearTimeout(timer);
          failed(error);
        },
      });
      child.send({ id, op, args });
    });
  const started = await entry.call("start", {
    dataDir: join(root, "data"),
    launcher,
    ledgerFile,
    token,
  });
  for (const identity of started.priorProcesses)
    await settleProcess("codex-app-server (before token)", identity);
  active.codex.push(started.codex);
  if (active.closing) {
    await stopChild(entry);
    await settleProcess("codex-app-server (late)", started.codex);
    throw new Error("attempt closed during service child start");
  }
  return entry;
}

async function stopChild(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  try {
    await entry.call("stop");
    entry.child.disconnect();
  } catch {}
  await Promise.race([entry.exited, delay(15_000)]);
  await settleProcess("service-child", entry.identity, 1000);
}

/** SIGKILLs the exact child service mid-turn, restarts it, then recovers by receipt. */
async function crash() {
  const repository = gitFixture();
  const snapshot = async (entry, taskId) => {
    const s = await entry.call("snapshot", { taskId });
    for (const workspace of s.workspaces) active.workspaces.add(workspace);
    noteClaude(s.recovery);
    entry.refused = s.refused;
    return s;
  };
  const first = await spawnChild();
  const ids = await first.call("setup", {
    facet,
    model: evidence.model.claude,
    repository,
  });
  // Recovery resumes the latest completed turn's session, so one completes first.
  const completed = await waitUntil(
    async () => {
      const s = await snapshot(first, ids.taskId);
      return s.recovery.find((r) => r.intent.state === "completed");
    },
    TURN_MS,
    "first Claude turn to complete",
    true,
  );
  await first.call("message", {
    key: randomUUID(),
    taskId: ids.taskId,
    recipientAssignmentId: completed.binding.assignmentId,
    expectedAssignmentVersion: completed.binding.assignmentVersion,
    message: shellOnly(SLEEP),
  });
  const record = await waitUntil(
    async () => running((await snapshot(first, ids.taskId)).recovery),
    TURN_MS,
    "running follow-up Claude turn with a process identity",
    true,
  );
  await delay(15_000);
  if (!running((await snapshot(first, ids.taskId)).recovery))
    throw new ComplianceError("the turn ended before the crash");
  stage("sigkill");
  const killed = await c0.terminateExact(
    first.identity,
    trace,
    "service-child",
    { signals: ["SIGKILL"] },
  );
  await first.exited;
  const cli = await settleProcess(
    "claude-cli (killed service)",
    record.processIdentity,
    10_000,
  );
  stage("restart");
  const second = await spawnChild();
  const read = async () =>
    (await snapshot(second, ids.taskId)).recovery.find(
      (r) => r.workId === record.workId,
    );
  const held = await read();
  // ponytail: in-process OperatorApi read; the HTTP `execution.read` token scope is not exercised.
  const operator = await second.call("operatorRead", {
    workId: record.workId,
    root,
  });
  await delay(30_000);
  const quiet = await snapshot(second, ids.taskId);
  const retained = await read();
  const allHeld = (h) => Boolean(h?.writer && h.capacity && h.uncertainty);
  evidence.observations = {
    serviceKill: killed,
    cliExitedByItself: cli.exitedByItself,
    heldState: held?.intent.state ?? null,
    observationKinds: held?.observations.map((o) => o.kind) ?? [],
    holds: held?.holds ?? null,
    operatorExecutionState: operator.state,
    operatorReadPath:
      "in-process OperatorApi.readExecution; the HTTP execution.read token scope is not exercised",
    startTurnInQuietWindow: quiet.turns.length + quiet.refused.length,
    holdsAfterQuietWindow: retained?.holds ?? null,
    recoveryRoute:
      "service seam resolveHeldExecution; no operator HTTP or CLI route",
  };
  if (
    held?.intent.state !== "held" ||
    !allHeld(held.holds) ||
    !allHeld(retained?.holds) ||
    operator.state !== "held" ||
    evidence.observations.startTurnInQuietWindow !== 0
  )
    throw new Error(
      "the crash did not leave a visible, retained uncertainty hold",
    );
  stage("recover");
  await second.call("resolve", {
    receipt: {
      workId: held.workId,
      workRevision: held.generation.workRevision,
      requestSequence: held.generation.requestSequence,
      threadId: held.intent.threadId,
      turnId: held.intent.turnId,
      processIdentity: held.processIdentity,
      termination: { kind: "process-exit" },
      effects: "settled",
      workspace: "preserved",
    },
  });
  await second.call("message", {
    key: randomUUID(),
    taskId: ids.taskId,
    recipientAssignmentId: held.binding.assignmentId,
    expectedAssignmentVersion: held.binding.assignmentVersion,
    message:
      "Recovered after a service crash. Run no command. Call ensemble_report_result exactly once with summary C5 recovered, and end the turn.",
  });
  let resumed;
  try {
    resumed = await waitUntil(
      async () => {
        const s = await snapshot(second, ids.taskId);
        const turn = s.turns[0];
        return turn &&
          s.list.some(
            (i) => i.turnId === turn.turnId && i.state === "completed",
          )
          ? turn
          : null;
      },
      TURN_MS,
      "recovered Claude turn",
      true,
    );
  } catch (error) {
    // The recovered turn gets TURN_MS too, then Stop.
    await second.call("stopTask", { taskId: ids.taskId }).catch(() => {});
    throw error;
  }
  await delay(30_000);
  const after = await snapshot(second, ids.taskId);
  const released = after.recovery.find((r) => r.workId === record.workId);
  Object.assign(evidence.observations, {
    recoveredTurns: after.turns.length,
    sameThread:
      resumed.threadId === held.intent.threadId &&
      resumed.threadId === completed.intent.threadId,
    holdsAfterRecovery: released?.holds ?? null,
  });
  evidence.startTurn.turns = 2 + after.turns.length;
  if (after.turns.length !== 1 || after.refused.length !== 0)
    throw new Error("recovery started other than exactly one turn");
  if (!evidence.observations.sameThread)
    throw new Error("the recovered turn did not resume the same session");
  const h = released?.holds;
  if (!h || h.writer || h.capacity || h.uncertainty)
    throw new Error("holds were not released after the recovered turn");
}

let cleaned;
/** Runs once on every exit path: success, failure, attempt timeout or signal. */
function cleanup() {
  active.closing = true;
  cleaned ??= (async () => {
    clearInterval(active.watchdog);
    const current = active.current;
    if (current) {
      try {
        if (current.taskId)
          noteClaude(current.service.recoveryForTask(current.taskId));
      } catch {}
      for (const workspace of current.observed.workspaces)
        active.workspaces.add(workspace);
      evidence.startTurn = {
        turns: current.observed.turns.length,
        refused: current.observed.refused,
      };
      try {
        await current.service.stop();
        evidence.cleanup.serviceStopped = true;
      } catch (error) {
        evidence.cleanup.serviceStopError = String(error?.message ?? error);
      }
    }
    for (const entry of active.children) await stopChild(entry);
    if (active.children.length) {
      evidence.cleanup.serviceStopped = active.children.every(
        (e) => e.child.exitCode !== null || e.child.signalCode !== null,
      );
      evidence.startTurn.refused = active.children.flatMap((e) => e.refused);
    }
    for (const identity of active.claude.values())
      await settleProcess("claude-cli", identity);
    for (const identity of active.codex)
      await settleProcess("codex-app-server", identity);
    delete process.env[TOKEN_VARIABLE];
    for (const workspace of active.workspaces) {
      await releaseClaudeTemporaryBase(workspace).catch(() => {});
      evidence.cleanup.temporaryBases.push(
        existsSync(claudeTemporaryBase(workspace)) ? "remains" : "removed",
      );
    }
    if (root)
      try {
        evidence.cleanup.rootRemoved = removeRoot(root);
      } catch (error) {
        evidence.failure ??= {
          stage: "cleanup",
          kind: "harness",
          message: String(error?.message),
        };
      }
  })();
  return cleaned;
}

async function attemptBody(attempt) {
  evidence.attempt = attempt.number;
  evidence.model = { claude: attempt.model, reasoningEffort: "low" };
  attemptDeadline = Date.now() + ATTEMPT_MS;
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = reject;
  });
  const timer = setTimeout(
    () => abort(new BudgetExhausted("attempt wall-time cap reached")),
    ATTEMPT_MS,
  );
  const onSignal = (signal) => abort(new Error(`received ${signal}`));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let failureKind = null;
  let work;
  try {
    root = mkdtempSync(join(physicalTmpdir(), ROOT_PREFIX));
    chmodSync(root, 0o700);
    // Non-secret positive control: shows the scrub probe reads Bash's environment.
    process.env.ENSEMBLE_C5_CONTROL = "present";
    stage("run");
    work =
      facet === "crash"
        ? crash()
        : inProcess((current, ids, check) =>
            facet === "scrub"
              ? scrub(current, ids, check)
              : facet === "stop"
                ? stop(current, ids, check)
                : coordination(current, ids, check),
          );
    work.catch(() => {});
    await Promise.race([work, aborted]);
    evidence.outcome =
      facet === "scrub" && evidence.observations.disposition === "inconclusive"
        ? "inconclusive"
        : "passed";
  } catch (error) {
    failureKind =
      error instanceof ComplianceError
        ? "model-compliance"
        : error instanceof BudgetExhausted
          ? "budget"
          : "harness";
    evidence.failure = {
      stage: evidence.stage,
      kind: failureKind,
      message: String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
    await cleanup();
    // Let abandoned work reach its closing checks and stop what it started.
    await Promise.race([work?.catch(() => {}), delay(60_000)]);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  // A refused reservation means the facet failed on budget, whatever surfaced first.
  if (evidence.startTurn.refused.length) {
    failureKind = "budget";
    evidence.outcome = "failed";
  }
  if (evidence.failure) evidence.outcome = "failed";
  return { outcome: evidence.outcome, failureKind };
}

try {
  await withAttempt(ledgerFile, facet, attemptBody);
} catch (error) {
  if (error instanceof BudgetExhausted && evidence.attempt === null)
    refuse(`budget: ${error.message}`);
  evidence.failure ??= {
    stage: evidence.stage,
    kind: "harness",
    message: String(error?.message ?? error),
  };
}
const closed = readLedger(ledgerFile);
evidence.budget = {
  attempt: closed.attempts[facet]?.at(-1) ?? null,
  totals: closed.totals,
};
// Redact before anything is written, then refuse to print on any residual leak.
const text = JSON.stringify(
  c0.redact(evidence, c0.redactionContext(root, token)),
  null,
  2,
);
const leaks = scanForLeaks(text, {
  token,
  roots: [join(physicalTmpdir(), ROOT_PREFIX), "/tmp/ens-"],
  home: homedir(),
});
const code =
  leaks.length || evidence.failure || evidence.outcome === "failed" ? 1 : 0;
// Exit after the write drains: orphaned work after a timeout or signal must not
// keep the process alive, and a pipe write on macOS is asynchronous.
process.stdout.write(
  leaks.length
    ? `${JSON.stringify({ facet, leakScan: leaks })}\n`
    : `${text}\n`,
  () => process.exit(code),
);
