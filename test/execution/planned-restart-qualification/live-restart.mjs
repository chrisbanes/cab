import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexRuntime } from "../../../dist/src/standalone/codex.js";
import { StandaloneService } from "../../../dist/src/standalone/service.js";

// Bounded to two real Codex turns: the interrupted one and its requeued successor.
const result = {
  source: {},
  runtime: {},
  interrupted: null,
  afterStop: null,
  requeued: null,
  cleanup: {
    fixtureCreated: false,
    fixtureRemoved: false,
    scope: "temporary cab data and workspace directories only",
  },
  failure: null,
};
let service;
let root;
let stage = "identity";
const failureKind = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? out|timeout/i.test(message)) return "timeout";
  if (/login|auth|account/i.test(message))
    return "authentication-or-account-check";
  return "runtime-or-service-error";
};

if (!process.argv.slice(2).includes("--live")) {
  process.stderr.write(
    "Refusing live Codex execution without the explicit --live flag.\n",
  );
  process.exit(2);
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${description} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const command = (domain, body) =>
  domain.execute({ key: randomUUID(), ...body });

/** Reads the stopped service's database exactly as the next start finds it. */
function readStopped(dataDir, sql, ...params) {
  const db = new DatabaseSync(join(dataDir, "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function run() {
  result.source = {
    gitRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
    workingTreeClean:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim().length === 0,
    node: process.version,
  };
  result.runtime.codexVersion = execFileSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();

  root = realpathSync(mkdtempSync(join(tmpdir(), "cab-planned-restart-")));
  result.cleanup.fixtureCreated = true;
  const dataDir = join(root, "data");
  mkdirSync(root, { recursive: true });
  service = new StandaloneService(
    dataDir,
    (context) => new CodexRuntime("codex", context),
  );
  stage = "authenticated-runtime-start";
  await service.start();

  stage = "task-setup";
  const domain = service.domain();
  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(domain, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Live restart probe",
    instructions: "Complete only the supplied task.",
    capabilities: "code",
  });
  command(domain, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: "Disposable restart probe",
    leadProfileId: profileId,
  });
  command(domain, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(domain, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: "Planned restart probe",
    outcome: "Produce a short poem for restart qualification",
    ready: false,
  });
  await service.provisionTask(taskId);
  command(domain, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief:
      "Write 300 words about an imaginary garden, without tools. It is acceptable to be interrupted before finishing.",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command(domain, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const workId = `assignment:${assignmentId}:initial`;
  const intentOf = (svc, id) => svc.list().find((item) => item.workId === id);

  stage = "bound-running-turn";
  await waitUntil(
    () => {
      const intent = intentOf(service, workId);
      return (
        intent?.state === "running" && Boolean(intent.threadId && intent.turnId)
      );
    },
    60_000,
    "bound live task turn",
  );
  const bound = intentOf(service, workId);
  result.interrupted = {
    workId,
    threadId: bound.threadId,
    turnId: bound.turnId,
  };

  // App Server refuses an interrupt in the first moments after turn/start
  // ("no active turn to interrupt"); a restart then keeps today's hold. Qualify
  // the restart of a turn that is demonstrably running.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  stage = "planned-stop";
  const startedStopping = Date.now();
  await service.stop();
  service = undefined;
  const stopMs = Date.now() - startedStopping;
  const queryCount = (table, id) =>
    readStopped(
      dataDir,
      `SELECT COUNT(*) AS n FROM ${table}${id ? " WHERE workId = ?" : ""}`,
      ...(id ? [id] : []),
    )[0].n;
  const old = readStopped(
    dataDir,
    "SELECT state, reason FROM execution_intents WHERE workId = ?",
    workId,
  )[0];
  const resolution = readStopped(
    dataDir,
    "SELECT requeueWorkId, threadId, turnId FROM execution_shutdown_resolutions WHERE interruptedWorkId = ?",
    workId,
  )[0];
  result.afterStop = {
    stopMs,
    oldState: old?.state,
    oldReason: old?.reason,
    writerRows: queryCount("task_writer_admissions", workId),
    capacityRows: queryCount("execution_capacity_reservations"),
    heldExecutions: readStopped(
      dataDir,
      "SELECT COUNT(*) AS n FROM execution_intents WHERE state = 'held'",
    )[0].n,
    resolutionRecorded: resolution !== undefined,
    // An unresolved shutdown target shows how far the interrupt got.
    shutdownTarget:
      readStopped(
        dataDir,
        "SELECT origin, interruptState, terminalState FROM execution_stop_targets WHERE workId = ?",
        workId,
      )[0] ?? null,
  };
  assert.equal(old?.state, "resolved-failed", "interrupted turn is released");
  assert.ok(resolution, "a shutdown resolution is recorded");
  assert.equal(result.afterStop.writerRows, 0);
  assert.equal(result.afterStop.capacityRows, 0);
  assert.equal(result.afterStop.heldExecutions, 0, "no held execution");

  stage = "restart";
  service = new StandaloneService(
    dataDir,
    (context) => new CodexRuntime("codex", context),
  );
  await service.start();
  const requeueId = resolution.requeueWorkId;
  await waitUntil(
    () => {
      const intent = intentOf(service, requeueId);
      return intent?.state === "running" && Boolean(intent.turnId);
    },
    60_000,
    "requeued live turn",
  );
  const requeued = intentOf(service, requeueId);
  result.requeued = {
    workId: requeueId,
    threadId: requeued.threadId,
    sameThread: requeued.threadId === bound.threadId,
    newTurn: requeued.turnId !== bound.turnId,
    heldExecutions: service.list().filter((item) => item.state === "held")
      .length,
  };
  assert.equal(requeued.threadId, bound.threadId, "resumes the same thread");
  assert.notEqual(requeued.turnId, bound.turnId);
  assert.equal(result.requeued.heldExecutions, 0);

  stage = "requeued-cleanup";
  await service.stopTask(taskId);
}

try {
  await run();
} catch (error) {
  result.failure = { stage, kind: failureKind(error) };
  process.exitCode = 1;
} finally {
  try {
    await service?.stop();
  } catch {
    result.failure ??= { stage: "service-shutdown", kind: "cleanup-error" };
    process.exitCode = 1;
  }
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
      result.cleanup.fixtureRemoved = true;
    } catch {
      result.cleanup.fixtureRemoved = false;
      result.failure ??= { stage: "fixture-cleanup", kind: "cleanup-error" };
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
