import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import {
  preTurnFailureClass,
  preTurnRefusalReason,
  RuntimeRequestRejectedError,
} from "../../src/standalone/pre-turn-failure.js";
import {
  ArchivedResumeRejectedError,
  archivedResumeMessage,
} from "../../src/standalone/pre-turn-recovery.js";
import { PreviousHarnessHomeError } from "../../src/standalone/runtime-retention.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { tmpdir } from "../fixtures/temp.js";

/** The schema failure #1620 fixed: cab's own response check rejected a valid thread. */
function schemaFailure(): Error {
  const result = z
    .object({ sandbox: z.object({ type: z.literal("workspaceWrite") }) })
    .safeParse({ sandbox: { type: "dangerFullAccess" } });
  assert.equal(result.success, false);
  return result.error;
}

type ErrorFactory = (() => Error) | undefined;

/** A runtime whose thread start, resume and turn start each fail on request. */
class PreTurnFake implements Runtime {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  startThreadError: ErrorFactory;
  resumeError: ErrorFactory;
  turnError: ErrorFactory;
  /** Fails once while the next started thread's turn is prepared, before `startTurn`. */
  failPreparation = false;
  private preparing = false;
  /** Holds thread start and resume until released, so a Stop can land first. */
  threadGate: Promise<void> | undefined;
  private threads = 0;
  private turns = 0;

  constructor(private readonly name: ExecutionHarness) {}
  async start() {}
  async stop() {}
  async startThread() {
    this.calls.push("startThread");
    await this.threadGate;
    if (this.startThreadError) throw this.startThreadError();
    this.preparing = this.failPreparation;
    return `${this.name}-thread-${++this.threads}`;
  }
  async resumeThread(threadId: string) {
    this.calls.push(`resumeThread:${threadId}`);
    await this.threadGate;
    if (this.resumeError) throw this.resumeError();
  }
  async startTurn(threadId: string, _workspace: string, prompt: string) {
    this.calls.push(`startTurn:${threadId}`);
    this.prompts.push(prompt);
    if (this.turnError) throw this.turnError();
    return `${this.name}-turn-${++this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn() {
    return "completed" as const;
  }
  currentUserInputGeneration() {
    if (this.preparing) {
      this.preparing = false;
      throw new Error("Turn preparation failed");
    }
    return `${this.name}-generation`;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(
    _listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>,
  ) {}
}

function execute(service: StandaloneService, command: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...command } as never);
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** One paused project whose lead runs on `harness`, and one ready task. */
async function fixture(
  t: { after: (fn: () => Promise<void> | void) => void },
  harness: ExecutionHarness = "codex",
) {
  const root = mkdtempSync(join(tmpdir(), "cab-pre-turn-refusal-"));
  const runtimes = {
    codex: new PreTurnFake("codex"),
    claude: new PreTurnFake("claude"),
  };
  const service = new StandaloneService(
    join(root, "data"),
    (_context, name) => runtimes[name],
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
      supervisor: { observationMs: 5 },
    },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  execute(service, {
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "build",
    capabilities: "coordination",
    runtime:
      harness === "claude"
        ? { harness, model: "opus", reasoningEffort: "high" }
        : { harness },
  });
  execute(service, {
    type: "project.create",
    projectId,
    name: "Pre-turn",
    leadProfileId: profileId,
  });
  execute(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: true,
  });
  execute(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [],
  });
  execute(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Pre-turn",
    outcome: "Run once",
    ready: true,
  });
  await service.provisionTask(taskId);
  const assignment = service.domain().assignments(taskId)[0];
  assert.ok(assignment);
  const assignmentId = String(assignment.id);
  const runtime = runtimes[harness];
  const db = (service as unknown as { db: DatabaseSync }).db;
  const count = (sql: string, workId: string) =>
    Number((db.prepare(sql).get(workId) as { n: number }).n);
  const describe = () => ({
    calls: runtime.calls,
    requests: service.turnRequests().map((r) => [r.workId, r.state, r.reason]),
    intents: service.list().map((i) => [i.workId, i.state, i.reason]),
  });
  return {
    service,
    runtime,
    taskId,
    projectId,
    assignmentId,
    initial: `assignment:${assignmentId}:initial`,
    db,
    describe,
    intent: (workId: string) =>
      service.list().find((item) => item.workId === workId),
    request: (workId: string) =>
      service.turnRequests().find((item) => item.workId === workId),
    /** Unpauses the project so the lead's first turn runs. */
    ready() {
      execute(service, {
        type: "project.configure",
        projectId,
        expectedVersion: Number(service.domain().project(projectId).version),
        paused: false,
      });
    },
    owns(workId: string) {
      return {
        writer: count(
          "SELECT COUNT(*) AS n FROM task_writer_admissions WHERE workId = ?",
          workId,
        ),
        capacity: count(
          "SELECT COUNT(*) AS n FROM execution_capacity_reservations WHERE workId = ?",
          workId,
        ),
      };
    },
    refusal(workId: string) {
      const row = db
        .prepare(
          "SELECT origin, stage, failureClass, threadId FROM execution_pre_turn_refusals WHERE workId = ?",
        )
        .get(workId) as
        | {
            origin: string;
            stage: string | null;
            failureClass: string | null;
            threadId: string | null;
          }
        | undefined;
      return row && { ...row };
    },
    witnesses(workId: string) {
      return count(
        "SELECT COUNT(*) AS n FROM execution_pre_turn_rejections WHERE workId = ?",
        workId,
      );
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Waits for `workId` to settle held and returns its reason. */
async function heldReason(f: Fixture, workId: string): Promise<string> {
  await waitUntil(
    () =>
      f.request(workId)?.state === "held" && f.intent(workId)?.state === "held",
    f.describe,
  );
  return f.request(workId)?.reason ?? "";
}

/** The refused request was released and Start again queues and completes it. */
async function startAgainCompletes(f: Fixture, workId: string) {
  assert.deepEqual(f.owns(workId), { writer: 0, capacity: 0 });
  const availability = f.service.startAgainAvailability(f.taskId);
  assert.deepEqual(availability, {
    available: true,
    assignmentId: f.assignmentId,
    workId,
  });
  const before = f.request(workId);
  const receipt = await f.service.startAgain({
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: Number(f.service.domain().task(f.taskId).version),
    workId,
  });
  await waitUntil(
    () => f.intent(receipt.workId)?.state === "completed",
    f.describe,
  );
  assert.deepEqual(f.request(workId), before, "the refusal stays as history");
  return receipt;
}

/** A first turn that completes, then a follow-up that resumes its thread. */
async function resumeAfterInitial(f: Fixture) {
  f.ready();
  await waitUntil(() => f.intent(f.initial)?.state === "completed", f.describe);
  const next = `${f.assignmentId}:follow-up`;
  await f.service.submitTask(next, f.assignmentId, "Continue", f.initial);
  return next;
}

test("a resume whose response fails cab's schema is refused, and Start again succeeds once fixed", async (t) => {
  const f = await fixture(t);
  f.runtime.resumeError = schemaFailure;
  const next = await resumeAfterInitial(f);
  const reason = await heldReason(f, next);
  assert.match(
    reason,
    /^Request refused before any turn was sent \(resume\): cab rejected the runtime's response\. A cab build with the fix is expected to help; then use Start again: /,
  );
  assert.deepEqual(f.refusal(next), {
    origin: "runtime",
    stage: "resume",
    failureClass: "response-rejected",
    threadId: null,
  });
  assert.equal(
    f.runtime.calls.filter((call) => call.startsWith("startTurn")).length,
    1,
    "only the first turn was sent",
  );
  f.runtime.resumeError = undefined;
  await startAgainCompletes(f, next);
  assert.equal(f.runtime.calls.at(-2), "resumeThread:codex-thread-1");
});

test("a thread start whose response fails cab's schema is refused, and Start again succeeds once fixed", async (t) => {
  const f = await fixture(t);
  f.runtime.startThreadError = schemaFailure;
  f.ready();
  const reason = await heldReason(f, f.initial);
  assert.match(reason, /\(thread\): cab rejected the runtime's response/);
  assert.equal(f.refusal(f.initial)?.failureClass, "response-rejected");
  assert.equal(f.runtime.prompts.length, 0);
  f.runtime.startThreadError = undefined;
  await startAgainCompletes(f, f.initial);
});

test("each runtime failure before startTurn is refused with its failure class", async (t) => {
  const cases: Array<[string, () => Error, string, RegExp]> = [
    [
      "rpc error",
      () =>
        new RuntimeRequestRejectedError(
          JSON.stringify({ code: -32602, message: "bad params" }),
        ),
      "request-rejected",
      /: the runtime rejected the request: /,
    ],
    [
      "timeout",
      () => new Error("thread/start timed out"),
      "outcome-unknown",
      /: the request's outcome is unknown: Error: thread\/start timed out$/,
    ],
    [
      "app server failure",
      () => new Error("Runtime stopped"),
      "outcome-unknown",
      /: the request's outcome is unknown: Error: Runtime stopped$/,
    ],
  ];
  for (const [name, error, failureClass, pattern] of cases)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.runtime.startThreadError = error;
      f.ready();
      const reason = await heldReason(f, f.initial);
      assert.match(reason, pattern);
      assert.doesNotMatch(reason, /fix is expected to help/);
      assert.equal(f.refusal(f.initial)?.failureClass, failureClass);
      assert.deepEqual(f.owns(f.initial), { writer: 0, capacity: 0 });
      assert.equal(f.service.startAgainAvailability(f.taskId).available, true);
    });
});

test("a resumed thread identity mismatch and a previous-home thread are refused without build advice", async (t) => {
  for (const [name, error] of [
    ["mismatch", () => new Error("Resumed thread identity mismatch")],
    ["previous home", () => new PreviousHarnessHomeError()],
  ] as const)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.runtime.resumeError = error;
      const next = await resumeAfterInitial(f);
      const reason = await heldReason(f, next);
      assert.match(reason, /\(resume\): the request's outcome is unknown: /);
      assert.doesNotMatch(reason, /fix is expected to help/);
      assert.equal(f.refusal(next)?.failureClass, "outcome-unknown");
    });
});

test("an archived resume rejection is refused and records no pre-turn witness", async (t) => {
  const f = await fixture(t);
  f.runtime.resumeError = () =>
    new ArchivedResumeRejectedError({
      method: "thread/resume",
      requestId: 4,
      threadId: "codex-thread-1",
      processIdentity: {
        processId: "1",
        processStartedAt: "start",
        bootId: "boot",
      },
      error: {
        code: -32600,
        message: archivedResumeMessage("codex-thread-1"),
      },
    });
  const next = await resumeAfterInitial(f);
  await heldReason(f, next);
  assert.equal(f.refusal(next)?.failureClass, "request-rejected");
  assert.equal(f.witnesses(next), 0);
  f.runtime.resumeError = undefined;
  await startAgainCompletes(f, next);
});

test("a failure preparing the turn after the thread is bound is refused with that thread", async (t) => {
  const f = await fixture(t);
  f.runtime.failPreparation = true;
  f.ready();
  const reason = await heldReason(f, f.initial);
  assert.match(reason, /\(bound\): the request's outcome is unknown: /);
  assert.deepEqual(f.refusal(f.initial), {
    origin: "runtime",
    stage: "bound",
    failureClass: "outcome-unknown",
    threadId: "codex-thread-1",
  });
  assert.equal(f.intent(f.initial)?.threadId, "codex-thread-1");
  assert.equal(f.runtime.prompts.length, 0, "no turn was started");
  f.runtime.failPreparation = false;
  await startAgainCompletes(f, f.initial);
});

test("a failure once startTurn was called keeps the uncertain hold and its ownership", async (t) => {
  for (const [name, error] of [
    ["rejected", () => new Error("turn/start timed out")],
    ["malformed response", schemaFailure],
  ] as const)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      f.runtime.turnError = error;
      f.ready();
      const reason = await heldReason(f, f.initial);
      assert.match(reason, /^Runtime submission or observation uncertain: /);
      assert.equal(f.refusal(f.initial), undefined);
      assert.deepEqual(f.owns(f.initial), { writer: 1, capacity: 1 });
      assert.equal(f.service.startAgainAvailability(f.taskId).available, false);
    });
});

test("a Stop or task hold in place when the thread start fails keeps that hold", async (t) => {
  for (const name of ["stop", "task hold"] as const)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      let release!: () => void;
      f.runtime.threadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.runtime.startThreadError = () => new Error("Runtime stopped");
      f.ready();
      await waitUntil(
        () => f.intent(f.initial)?.state === "submitting",
        f.describe,
      );
      if (name === "stop") void f.service.stopTask(f.taskId);
      else
        f.db
          .prepare(
            "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Synthetic hold')",
          )
          .run(f.taskId);
      await waitUntil(
        () =>
          name !== "stop" ||
          f.db
            .prepare("SELECT 1 FROM execution_stop_targets WHERE workId = ?")
            .get(f.initial) !== undefined,
        f.describe,
      );
      release();
      await waitUntil(() => f.intent(f.initial)?.state === "held", f.describe);
      assert.equal(f.refusal(f.initial), undefined);
      assert.equal(f.service.startAgainAvailability(f.taskId).available, false);
      assert.doesNotMatch(
        f.intent(f.initial)?.reason ?? "",
        /^Request refused before any turn was sent/,
      );
    });
});

test("Claude thread start and resume failures before startTurn are refused the same way", async (t) => {
  await t.test("start", async (t) => {
    const f = await fixture(t, "claude");
    f.runtime.startThreadError = () => new Error("Runtime stopped");
    f.ready();
    await heldReason(f, f.initial);
    assert.equal(f.refusal(f.initial)?.stage, "thread");
    f.runtime.startThreadError = undefined;
    await startAgainCompletes(f, f.initial);
  });
  await t.test("resume", async (t) => {
    const f = await fixture(t, "claude");
    f.runtime.resumeError = () => new PreviousHarnessHomeError();
    const next = await resumeAfterInitial(f);
    await heldReason(f, next);
    assert.equal(f.refusal(next)?.stage, "resume");
  });
});

test("failure classes and refusal reasons", () => {
  const zod = schemaFailure();
  assert.equal(preTurnFailureClass(zod), "response-rejected");
  assert.equal(
    preTurnFailureClass(new Error("wrapped", { cause: zod })),
    "response-rejected",
  );
  assert.equal(
    preTurnFailureClass(new RuntimeRequestRejectedError("{}")),
    "request-rejected",
  );
  assert.equal(preTurnFailureClass(new Error("x")), "outcome-unknown");
  assert.equal(preTurnFailureClass("not an error"), "outcome-unknown");
  const long = preTurnRefusalReason(
    "thread",
    "outcome-unknown",
    new Error("x".repeat(10_000)),
  );
  assert.ok(long.length < 4000);
  assert.ok(long.endsWith("…"));
});
