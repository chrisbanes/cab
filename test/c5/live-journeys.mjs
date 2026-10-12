// Guarded live Claude journeys for #827. Refuses without exactly
// `--live --facet <name>`; the token, launcher and ledger are checked before
// any disposable root exists. Prints redacted evidence JSON only.
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
  beginAttempt,
  finishAttempt,
  ledgerPath,
  parseArgs,
  physicalTmpdir,
  ROOT_PREFIX,
  readLedger,
  removeRoot,
  scanForLeaks,
  TURN_MS,
  writeLedger,
} from "./harness.mjs";
import {
  setupJourney,
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
const ledgerFile = ledgerPath();
const opened = readLedger(ledgerFile);
if (opened.current)
  refuse(
    `ledger attempt ${opened.current.facet}#${opened.current.number} is still open; close it only after verifying no driver runs`,
  );
try {
  writeLedger(beginAttempt(opened, facet), ledgerFile);
} catch (error) {
  if (error instanceof BudgetExhausted) refuse(`budget: ${error.message}`);
  throw error;
}
const attempt = readLedger(ledgerFile).attempts[facet].at(-1);

const { claudeTemporaryBase, releaseClaudeTemporaryBase } = await import(
  "../../dist/src/standalone/claude.js"
);
const { captureProcessIdentity } = await import(
  "../../dist/src/standalone/termination.js"
);

class ComplianceError extends Error {}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const attemptDeadline = Date.now() + ATTEMPT_MS;
const sdkPackage = JSON.parse(
  readFileSync(
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    "utf8",
  ),
);
const evidence = {
  facet,
  attempt: attempt.number,
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
  model: { claude: attempt.model, reasoningEffort: "low" },
  stage: "fixture",
  outcome: "failed",
  failure: null,
  observations: {},
  startTurn: { turns: 0, refused: [] },
  processes: [],
  trace: [],
  cleanup: { serviceStopped: false, temporaryBases: [], rootRemoved: false },
};
const stage = (name) => {
  evidence.stage = name;
  process.stderr.write(`[c5-live] ${facet} ${name}\n`);
};
const trace = {
  record: (event, data) => evidence.trace.push({ event, ...data }),
};
const workspaces = new Set();

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

/** Waits for an exact process to exit; stops it by verified identity only after the grace period. */
async function settleProcess(label, identity, graceMs = 10_000) {
  const entry = { label, exitedByItself: false, verification: "unknown" };
  evidence.processes.push(entry);
  if (!identity) return entry;
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

async function releaseBases() {
  for (const workspace of workspaces) {
    await releaseClaudeTemporaryBase(workspace);
    evidence.cleanup.temporaryBases.push(
      existsSync(claudeTemporaryBase(workspace)) ? "remains" : "removed",
    );
  }
  workspaces.clear();
}

function gitFixture(root) {
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
async function inProcess(root, run) {
  const current = await startJourneyService({
    dataDir: join(root, "data"),
    launcher,
    ledgerFile,
  });
  const codexIdentity = current.observed.runtimes.codex?.processIdentity?.();
  let timedOut = false;
  const watchdog = setInterval(() => {
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
  try {
    const repository = gitFixture(root);
    const ids = await setupJourney(current.service, {
      facet,
      model: attempt.model,
      repository,
    });
    current.taskId = ids.taskId;
    await run(current, ids, check);
  } finally {
    clearInterval(watchdog);
    const identities = current.taskId
      ? current.service
          .recoveryForTask(current.taskId)
          .map((r) => r.processIdentity)
          .filter(Boolean)
      : [];
    for (const workspace of current.observed.workspaces)
      workspaces.add(workspace);
    evidence.startTurn = {
      turns: current.observed.turns.length,
      refused: current.observed.refused,
    };
    await current.service.stop();
    evidence.cleanup.serviceStopped = true;
    for (const identity of identities)
      await settleProcess("claude-cli", identity);
    await settleProcess("codex-app-server", codexIdentity);
  }
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
  const record = await waitUntil(
    () => {
      check();
      return running(current.service.recoveryForTask(ids.taskId));
    },
    TURN_MS,
    "running Claude turn with a process identity",
  );
  await delay(15_000); // Lets the sleep start inside the turn.
  const starts = () =>
    current.observed.turns.length + current.observed.refused.length;
  const before = starts();
  const observation = await current.service.stopTask(ids.taskId);
  const after = await waitUntil(
    () => {
      const r = current.service
        .recoveryForTask(ids.taskId)
        .find((x) => x.workId === record.workId);
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

/** SIGKILLs the exact child service mid-turn, restarts it, then recovers by receipt. */
async function crash(root) {
  const dataDir = join(root, "data");
  const repository = gitFixture(root);
  const children = [];
  const spawnChild = async () => {
    const child = fork(new URL("./service-child.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const entry = {
      child,
      identity: await captureProcessIdentity(child.pid),
      exited: new Promise((done) => child.once("exit", done)),
      pending: new Map(),
    };
    children.push(entry);
    await new Promise((ready, failed) => {
      child.once("error", failed);
      child.once("exit", () => failed(new Error("service child exited")));
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
        entry.pending.set(id, { done, failed });
        child.send({ id, op, args });
      });
    await entry.call("start", { dataDir, launcher, ledgerFile });
    return entry;
  };
  const snapshot = async (entry, taskId) => {
    const s = await entry.call("snapshot", { taskId });
    for (const workspace of s.workspaces) workspaces.add(workspace);
    entry.refused = s.refused;
    return s;
  };
  const stopChild = async (entry) => {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null)
      return;
    try {
      await Promise.race([entry.call("stop"), delay(30_000)]);
      entry.child.disconnect();
    } catch {}
    await Promise.race([entry.exited, delay(15_000)]);
    await settleProcess("service-child", entry.identity, 1000);
  };
  try {
    const first = await spawnChild();
    const ids = await first.call("setup", {
      facet,
      model: attempt.model,
      repository,
    });
    const record = await waitUntil(
      async () => running((await snapshot(first, ids.taskId)).recovery),
      TURN_MS,
      "running Claude turn with a process identity",
    );
    await delay(15_000);
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
    const operator = await second.call("operatorRead", {
      workId: record.workId,
      root,
    });
    await delay(30_000);
    const quiet = await snapshot(second, ids.taskId);
    const retained = await read();
    evidence.observations = {
      serviceKill: killed,
      cliExitedByItself: cli.exitedByItself,
      heldState: held?.intent.state ?? null,
      observationKinds: held?.observations.map((o) => o.kind) ?? [],
      holds: held?.holds ?? null,
      operatorExecutionState: operator.state,
      startTurnInQuietWindow: quiet.turns.length + quiet.refused.length,
      holdsAfterQuietWindow: retained?.holds ?? null,
      recoveryRoute:
        "service seam resolveHeldExecution; no operator HTTP or CLI route",
    };
    const holds = held?.holds;
    if (
      held?.intent.state !== "held" ||
      !holds.writer ||
      !holds.capacity ||
      !holds.uncertainty ||
      !retained?.holds.writer ||
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
        "Recovered after a service crash. Do not run any command. Reply with one short sentence and end the turn.",
    });
    const resumed = await waitUntil(
      async () => {
        const s = await snapshot(second, ids.taskId);
        const turn = s.turns[0];
        return turn &&
          s.list.some(
            (i) => i.turnId === turn.turnId && i.state === "completed",
          )
          ? { turn, s }
          : null;
      },
      TURN_MS,
      "recovered Claude turn",
      true,
    );
    const released = await read();
    Object.assign(evidence.observations, {
      recoveredTurns: resumed.s.turns.length,
      sameThread: resumed.turn.threadId === held.intent.threadId,
      holdsAfterRecovery: released?.holds ?? null,
    });
    evidence.startTurn.turns = 1 + resumed.s.turns.length;
    if (resumed.s.turns.length !== 1 || !evidence.observations.sameThread)
      throw new Error(
        "recovery did not resume exactly one turn on the same session",
      );
    const recovered = resumed.s.recovery.find(
      (r) => r.intent.turnId === resumed.turn.turnId,
    )?.processIdentity;
    await stopChild(second);
    await settleProcess("claude-cli (recovered turn)", recovered);
  } finally {
    for (const entry of children) await stopChild(entry);
    evidence.startTurn.refused = children.flatMap((e) => e.refused ?? []);
    evidence.cleanup.serviceStopped = children.every(
      (e) => e.child.exitCode !== null || e.child.signalCode !== null,
    );
  }
}

let root;
let failureKind = null;
try {
  root = mkdtempSync(join(physicalTmpdir(), ROOT_PREFIX));
  chmodSync(root, 0o700);
  process.env[TOKEN_VARIABLE] = token;
  // Non-secret positive control: shows the scrub probe reads Bash's environment.
  process.env.ENSEMBLE_C5_CONTROL = "present";
  stage("run");
  if (facet === "crash") await crash(root);
  else
    await inProcess(root, (current, ids, check) =>
      facet === "scrub"
        ? scrub(current, ids, check)
        : facet === "stop"
          ? stop(current, ids, check)
          : coordination(current, ids, check),
    );
  evidence.outcome =
    facet === "scrub" && evidence.observations.disposition === "inconclusive"
      ? "inconclusive"
      : "passed";
} catch (error) {
  failureKind =
    error instanceof ComplianceError ? "model-compliance" : "harness";
  evidence.failure = {
    stage: evidence.stage,
    kind: failureKind,
    message: String(error?.message ?? error),
  };
} finally {
  delete process.env[TOKEN_VARIABLE];
  await releaseBases().catch(() => {});
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
  // A refused reservation means the facet failed on budget, whatever surfaced first.
  if (evidence.startTurn.refused.length) {
    failureKind = "budget";
    evidence.outcome = "failed";
  }
  writeLedger(
    finishAttempt(readLedger(ledgerFile), evidence.outcome, failureKind),
    ledgerFile,
  );
  const closed = readLedger(ledgerFile);
  evidence.budget = {
    attempt: closed.attempts[facet].at(-1),
    totals: closed.totals,
  };
}
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
if (leaks.length) {
  process.stdout.write(`${JSON.stringify({ facet, leakScan: leaks })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${text}\n`);
  process.exitCode = evidence.failure || evidence.outcome === "failed" ? 1 : 0;
}
