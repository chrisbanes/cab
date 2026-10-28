import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  type FailureEvidence,
  type Runtime,
  type RuntimeConversationEvent,
  RuntimeNotEnabledError,
  type RuntimeToolCall,
  type RuntimeToolResult,
  type UnexpectedRequest,
} from "../../src/standalone/codex.js";
import type { RuntimeSafetyPort } from "../../src/standalone/runtime-retention.js";
import type { ExecutionHarness } from "../../src/standalone/execution-harness.js";
import type {
  ExactExecutionIdentity,
  ExecutionInspection,
} from "../../src/standalone/recovery-types.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { stopWithoutDrain } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";

/** Records every call so each test can prove which harness ran the work. */
class HarnessRuntime implements Runtime {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  holdTurns = false;
  failNextTurn = false;
  failStart = false;
  /** Start reports the harness cannot run on this host, like Claude without `claude`. */
  notEnabled = false;
  hangIdentity = false;
  /** When set, stop() waits for it, like a child slow to exit. */
  stopGate: Promise<void> | undefined;
  /** Fails while a recovery inspection is pending and never settles it. */
  failDuringInspection = false;
  /** Lets two fakes return the same opaque thread ID. */
  threadName: string | undefined;
  private threads = 0;
  private turns = 0;
  private readonly open = new Map<
    string,
    { release: () => void; lose: (error: Error) => void }
  >();
  private readonly failing = new Set<string>();
  private unexpected: ((request: UnexpectedRequest) => void) | undefined;
  private failure: ((error: Error) => void) | undefined;
  private anomaly:
    | ((anomaly: {
        threadId?: string;
        turnId?: string;
        reason: string;
      }) => void)
    | undefined;
  private tools:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  safety: RuntimeSafetyPort | undefined;
  private conversation: ((event: RuntimeConversationEvent) => void) | undefined;

  constructor(private readonly name: ExecutionHarness) {}

  async start() {
    if (this.notEnabled) throw new RuntimeNotEnabledError("Not on this host");
    if (this.failStart) throw new Error("Runtime failed to start");
  }
  /** Like a lost App Server: pending waits reject without a terminal status. */
  stops = 0;
  async stop() {
    this.stops++;
    await this.stopGate;
    for (const turn of this.open.values())
      turn.lose(new Error("Runtime stopped"));
    this.open.clear();
  }
  async startThread() {
    this.calls.push("startThread");
    return this.threadName ?? `${this.name}-thread-${++this.threads}`;
  }
  async resumeThread(threadId: string) {
    this.calls.push(`resumeThread:${threadId}`);
  }
  async startTurn(threadId: string, _workspace?: string, prompt?: string) {
    const turnId = `${this.name}-turn-${++this.turns}`;
    this.prompts.push(prompt ?? "");
    this.calls.push(`startTurn:${threadId}`);
    if (this.failNextTurn) {
      this.failNextTurn = false;
      this.failing.add(turnId);
    }
    return turnId;
  }
  async interruptTurn(_threadId: string, turnId: string) {
    this.calls.push(`interruptTurn:${turnId}`);
    this.failing.add(turnId);
    this.open.get(turnId)?.release();
  }
  async waitForTurn(_threadId: string, turnId: string) {
    if (this.failing.has(turnId)) return "failed" as const;
    if (this.holdTurns)
      await new Promise<void>((release, lose) =>
        this.open.set(turnId, { release, lose }),
      );
    this.open.delete(turnId);
    return this.failing.has(turnId)
      ? ("failed" as const)
      : ("completed" as const);
  }
  currentUserInputGeneration() {
    return `${this.name}-generation`;
  }
  processIdentity() {
    if (this.hangIdentity)
      return new Promise<never>(() => {
        // Never settles, like a wedged runtime process.
      });
    return {
      processId: `${this.name}-process`,
      processStartedAt: "2026-10-01T00:00:00.000Z",
      bootId: "harness-routing-boot",
    };
  }
  failureEvidence(
    threadId: string,
    turnId: string,
  ): FailureEvidence | undefined {
    return this.failing.has(turnId) &&
      !this.calls.includes(`interruptTurn:${turnId}`)
      ? {
          threadId,
          turnId,
          status: "failed",
          classification: "transient",
          reasonCode: "serverOverloaded",
          source: "harness",
          harnessRetries: 0,
        }
      : undefined;
  }
  async inspectExecution(
    identity: ExactExecutionIdentity,
  ): Promise<ExecutionInspection> {
    this.calls.push(`inspect:${identity.threadId}`);
    if (this.failDuringInspection) {
      setTimeout(() => this.crash(), 10);
      return new Promise<never>(() => {
        // Never settles, like a runtime lost mid-request.
      });
    }
    return { kind: "unknown" } as ExecutionInspection;
  }
  onUnexpectedRequest(listener: (request: UnexpectedRequest) => void) {
    this.unexpected = listener;
  }
  onFailure(listener: (error: Error) => void) {
    this.failure = listener;
  }
  onTerminalAnomaly(
    listener: (anomaly: {
      threadId?: string;
      turnId?: string;
      reason: string;
    }) => void,
  ) {
    this.anomaly = listener;
  }
  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversation = listener;
  }
  answer(threadId: string, turnId: string, text: string) {
    const itemId = `${this.name}-answer`;
    this.conversation?.({ threadId, turnId, itemId, kind: "started" });
    this.conversation?.({ threadId, turnId, itemId, kind: "completed", text });
  }
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tools = listener;
  }
  callTool(threadId: string, turnId: string) {
    if (!this.tools) throw new Error("No tool listener");
    return this.tools({
      threadId,
      turnId,
      callId: randomUUID(),
      tool: "ensemble_ask_question",
      arguments: { question: "Which harness owns this turn?" },
    });
  }
  reportAnomaly(threadId: string, turnId: string) {
    this.anomaly?.({ threadId, turnId, reason: "Terminal report conflicted" });
  }
  denyUnexpectedFor(threadId: string, turnId: string) {
    this.unexpected?.({ method: "item/tool/call", threadId, turnId });
  }
  reportUnidentifiedAnomaly() {
    this.anomaly?.({ reason: "Terminal report without identity" });
  }
  denyUnexpected(method: string) {
    this.unexpected?.({ method });
  }
  crash() {
    this.failure?.(new Error("Runtime lost"));
  }
  releaseAll() {
    for (const turn of this.open.values()) turn.release();
  }
}

type Fakes = Record<ExecutionHarness, HarnessRuntime>;

function fakes(): Fakes {
  return {
    codex: new HarnessRuntime("codex"),
    claude: new HarnessRuntime("claude"),
  };
}

function open(
  dataDir: string,
  runtimes: Fakes,
  harnesses: ExecutionHarness[] = ["codex", "claude"],
  broken?: ExecutionHarness,
) {
  return new StandaloneService(
    dataDir,
    (context, harness) => {
      if (harness === broken) throw new Error("Runtime cannot be constructed");
      runtimes[harness].safety = context.safety;
      return runtimes[harness];
    },
    undefined,
    {
      runtimeHarnesses: harnesses,
      power: { enabled: false },
      routingClient: null,
    },
  );
}

function execute(service: StandaloneService, command: Record<string, unknown>) {
  return service
    .domain()
    .execute({ key: randomUUID(), actor: "operator", ...command } as never);
}

function profile(service: StandaloneService, harness: ExecutionHarness) {
  const profileId = randomUUID();
  execute(service, {
    type: "profile.create",
    profileId,
    name: `${harness} profile`,
    instructions: "build",
    capabilities: "code",
    runtime:
      harness === "claude"
        ? { harness, model: "opus", reasoningEffort: "high" }
        : { harness },
  });
  return profileId;
}

function project(
  service: StandaloneService,
  leadProfileId: string,
  candidateProfileIds: string[] = [],
) {
  const projectId = randomUUID();
  execute(service, {
    type: "project.create",
    projectId,
    name: "Harness routing",
    leadProfileId,
  });
  execute(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds,
  });
  return projectId;
}

/** Creates a task with explicit assignments, then makes it ready. */
async function task(
  service: StandaloneService,
  projectId: string,
  profileIds: string[],
) {
  const taskId = randomUUID();
  execute(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Harness routing",
    outcome: "Route by harness",
    ready: false,
  });
  await service.provisionTask(taskId);
  const assignmentIds = profileIds.map((profileId) => {
    const assignmentId = randomUUID();
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Route",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    return assignmentId;
  });
  execute(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return { taskId, assignmentIds };
}

const initial = (assignmentId: string) => `assignment:${assignmentId}:initial`;

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function count(service: StandaloneService, sql: string, ...args: string[]) {
  const db = (service as unknown as { db: DatabaseSync }).db;
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

function intent(service: StandaloneService, workId: string) {
  return service.list().find((item) => item.workId === workId);
}

function diagnostics(service: StandaloneService, runtimes: Fakes) {
  return () => ({
    codex: runtimes.codex.calls,
    claude: runtimes.claude.calls,
    intents: service
      .list()
      .map((item) => [item.workId, item.state, item.reason]),
    requests: service
      .turnRequests()
      .map((request) => [request.workId, request.state, request.reason]),
  });
}

test("a mixed task routes each assignment, Stop and anomaly to its own harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-mixed-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    const { taskId } = await task(service, projectId, []);
    const leadWork = service
      .turnRequests()
      .find((request) => request.taskId === taskId)?.workId;
    assert.ok(leadWork);
    await waitUntil(
      () => intent(service, leadWork)?.state === "completed",
      describe,
    );

    runtimes.claude.holdTurns = true;
    const workerId = randomUUID();
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId: workerId,
      profileId: worker,
      brief: "Build with Claude",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    await waitUntil(
      () => intent(service, initial(workerId))?.state === "running",
      describe,
    );
    assert.ok(runtimes.codex.calls.every((call) => !call.includes("claude")));
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
    assert.equal(intent(service, leadWork)?.threadId, "codex-thread-1");
    assert.equal(service.bindingHarness(leadWork), "codex");
    assert.equal(service.bindingHarness(initial(workerId)), "claude");

    // A Codex lead on another task stays open while both harnesses run.
    runtimes.codex.holdTurns = true;
    const other = await task(service, projectId, []);
    const otherWork = service
      .turnRequests()
      .find((request) => request.taskId === other.taskId)?.workId;
    assert.ok(otherWork);
    await waitUntil(
      () => intent(service, otherWork)?.state === "running",
      describe,
    );

    // An unidentified Codex anomaly holds only Codex-bound work.
    runtimes.codex.denyUnexpected("item/commandExecution/requestApproval");
    assert.equal(intent(service, otherWork)?.state, "held");
    assert.equal(
      intent(service, otherWork)?.reason,
      "Unexpected runtime request denied: item/commandExecution/requestApproval",
    );
    assert.equal(intent(service, initial(workerId))?.state, "running");

    const stopped = await service.stopTask(taskId);
    assert.deepEqual(
      stopped.outcomes.map((outcome) => [outcome.workId, outcome.interrupt]),
      [[initial(workerId), "acknowledged"]],
    );
    assert.deepEqual(
      runtimes.claude.calls.filter((call) => call.startsWith("interrupt")),
      ["interruptTurn:claude-turn-1"],
    );
    assert.deepEqual(
      runtimes.codex.calls.filter((call) => call.startsWith("interrupt")),
      [],
    );
  } finally {
    runtimes.codex.releaseAll();
    runtimes.claude.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude unexpected request holds only its work with neutral text", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-unexpected-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    runtimes.codex.holdTurns = true;
    runtimes.claude.holdTurns = true;
    const { assignmentIds } = await task(service, projectId, [worker]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, workId)?.state === "running",
      describe,
    );

    runtimes.claude.denyUnexpected("claude/canUseTool:Bash");
    const held = intent(service, workId);
    assert.equal(held?.state, "held");
    assert.equal(
      held?.reason,
      "Unexpected runtime request denied: claude/canUseTool:Bash",
    );
    assert.doesNotMatch(held?.reason ?? "", /Codex|App Server/);
    assert.deepEqual(
      service
        .list()
        .filter((item) => item.state === "held")
        .map((item) => item.workId),
      [workId],
    );
  } finally {
    runtimes.codex.releaseAll();
    runtimes.claude.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude transient failure is held without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-retry-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    runtimes.claude.failNextTurn = true;
    const { assignmentIds } = await task(service, projectId, [worker]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(() => intent(service, workId)?.state === "held", describe);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      count(service, "SELECT COUNT(*) AS n FROM execution_retry_resolutions"),
      0,
    );
    assert.equal(service.turnRequests().length, 1);
    assert.equal(
      runtimes.claude.calls.filter((call) => call.startsWith("startTurn"))
        .length,
      1,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a profile change keeps a live conversation on its harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-profile-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const changing = profile(service, "codex");
    const projectId = project(service, lead, [changing]);
    const first = await task(service, projectId, [changing]);
    const assignmentId = first.assignmentIds[0] ?? "";
    await waitUntil(
      () => intent(service, initial(assignmentId))?.state === "completed",
      describe,
    );

    execute(service, {
      type: "profile.configure",
      profileId: changing,
      expectedVersion: 1,
      runtime: { harness: "claude", model: null, reasoningEffort: null },
    });
    execute(service, {
      type: "assignment.apply",
      projectId,
      assignmentId,
      expectedVersion: Number(
        service.domain().assignment(assignmentId).version,
      ),
    });
    assert.equal(
      Number(service.domain().assignment(assignmentId).profileRevision),
      2,
    );
    const next = `${assignmentId}:next`;
    await service.submitTask(
      next,
      assignmentId,
      "Continue",
      initial(assignmentId),
    );
    await waitUntil(
      () => intent(service, next)?.state === "completed",
      describe,
    );
    assert.equal(intent(service, next)?.threadId, "codex-thread-1");
    assert.ok(runtimes.codex.calls.includes("resumeThread:codex-thread-1"));
    assert.equal(service.bindingHarness(next), "codex");
    // Only the profile revision changed, so only it is re-sent, as a replacement.
    const [firstPrompt, followUp] = runtimes.codex.prompts;
    assert.match(firstPrompt ?? "", /^Project instructions:\n\(none\)$/m);
    assert.match(firstPrompt ?? "", /^Profile instructions:\nbuild$/m);
    assert.match(
      followUp ?? "",
      /^Updated profile instructions\. These replace all profile instructions given earlier in this conversation:\nbuild$/m,
    );
    assert.doesNotMatch(followUp ?? "", /project instructions/i);
    assert.deepEqual(runtimes.claude.calls, []);

    const second = await task(service, projectId, [changing]);
    const newWork = initial(second.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, newWork)?.state === "completed",
      describe,
    );
    assert.equal(service.bindingHarness(newWork), "claude");
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Claude conversation omits unchanged instructions on its follow-up", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-claude-once-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "claude");
    const projectId = project(service, lead);
    const first = await task(service, projectId, [lead]);
    const assignmentId = first.assignmentIds[0] ?? "";
    await waitUntil(
      () => intent(service, initial(assignmentId))?.state === "completed",
      describe,
    );
    // The initial turn reports no result, so its repair turn resumes the same thread.
    await waitUntil(() => runtimes.claude.prompts.length >= 2, describe);
    assert.ok(runtimes.claude.calls.includes("resumeThread:claude-thread-1"));
    const [firstPrompt, followUp] = runtimes.claude.prompts;
    assert.match(firstPrompt ?? "", /^Project instructions:/m);
    assert.match(firstPrompt ?? "", /^Profile instructions:/m);
    assert.doesNotMatch(followUp ?? "", /instructions:/i);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a first turn still waiting for capacity moves to the runtime of a re-captured profile revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-waiting-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const blocker = profile(service, "codex");
    const changing = profile(service, "codex");
    const projectId = project(service, lead, [blocker, changing]);
    execute(service, {
      type: "capacity.configure",
      globalLimit: 4,
      projectOverrides: { [projectId]: 1 },
    });
    runtimes.codex.holdTurns = true;
    const running = await task(service, projectId, [blocker]);
    await waitUntil(
      () =>
        intent(service, initial(running.assignmentIds[0] ?? ""))?.state ===
        "running",
      describe,
    );
    const waiting = await task(service, projectId, [changing]);
    const workId = initial(waiting.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, workId)?.state === "capacity-waiting",
      describe,
    );
    assert.equal(service.bindingHarness(workId), "codex");

    // The waiting turn never started, so it takes the new revision and its runtime.
    execute(service, {
      type: "profile.configure",
      profileId: changing,
      expectedVersion: 1,
      runtime: { harness: "claude", model: "opus", reasoningEffort: "high" },
    });
    runtimes.codex.holdTurns = false;
    runtimes.codex.releaseAll();
    await waitUntil(
      () => intent(service, workId)?.state === "completed",
      describe,
    );
    assert.equal(service.bindingHarness(workId), "claude");
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
  } finally {
    runtimes.codex.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured or failed harness holds its work visibly without fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-unavailable-"));
  const dataDir = join(root, "data");
  let runtimes = fakes();
  let service = open(dataDir, runtimes, ["codex"]);
  let describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker, lead]);
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, claudeWork)?.reason ===
        "Claude runtime is not configured",
      describe,
    );
    assert.equal(intent(service, claudeWork)?.state, "ready");
    assert.equal(
      service.turnRequests().find((request) => request.workId === claudeWork)
        ?.reason,
      "Claude runtime is not configured",
    );
    assert.equal(service.bindingHarness(claudeWork), "claude");
    assert.equal(
      count(
        service,
        "SELECT COUNT(*) AS n FROM execution_capacity_reservations WHERE workId = ?",
        claudeWork,
      ),
      0,
    );
    const codexTask = await task(service, projectId, [lead]);
    const codexWork = initial(codexTask.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, codexWork)?.state === "completed",
      describe,
    );
    assert.deepEqual(runtimes.claude.calls, []);
    assert.equal(intent(service, codexWork)?.threadId, "codex-thread-1");

    await service.stop();
    runtimes = fakes();
    service = open(dataDir, runtimes);
    describe = diagnostics(service, runtimes);
    await service.start();
    await waitUntil(
      () => intent(service, claudeWork)?.state === "completed",
      describe,
    );
    assert.equal(service.bindingHarness(claudeWork), "claude");
    assert.deepEqual(runtimes.claude.calls, [
      "startThread",
      "startTurn:claude-thread-1",
    ]);
    assert.ok(runtimes.codex.calls.every((call) => !call.includes("claude")));

    runtimes.claude.crash();
    const afterCrash = await task(service, projectId, [worker]);
    const blocked = initial(afterCrash.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, blocked)?.reason ===
        "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
      describe,
    );
    assert.deepEqual(service.runtimeStatus(), { state: "available" });
    const stillCodex = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(stillCodex.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
    // Work queued after the failure never reaches the failed runtime. (A
    // follow-up admitted just before the crash may still have started.)
    assert.equal(intent(service, blocked)?.state, "ready");
    assert.equal(intent(service, blocked)?.threadId, null);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runtime that cannot run on this host is not enabled, not failed, and holds its work without fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-not-enabled-"));
  const dataDir = join(root, "data");
  let runtimes = fakes();
  runtimes.claude.notEnabled = true;
  let service = open(dataDir, runtimes);
  let describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    // Not enabled, exactly like a harness outside the configured list: no unavailable state.
    assert.deepEqual(
      service.harnessStatuses().map(({ harness, state }) => [harness, state]),
      [
        ["codex", "available"],
        ["claude", "not-configured"],
      ],
    );
    assert.equal(runtimes.claude.stops, 1, "the failed start is cleaned up");
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, claudeWork)?.reason ===
        "Claude runtime is not configured",
      describe,
    );
    const codexTask = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
    assert.deepEqual(runtimes.claude.calls, []);
    assert.equal(intent(service, claudeWork)?.state, "ready");
    // A restart re-checks the host; the held work then runs on Claude.
    await service.stop();
    runtimes = fakes();
    service = open(dataDir, runtimes);
    describe = diagnostics(service, runtimes);
    await service.start();
    assert.equal(service.harnessStatuses()[1]?.state, "available");
    await waitUntil(
      () => intent(service, claudeWork)?.state === "completed",
      describe,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery inspects admitted work only through its own harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-recovery-"));
  const dataDir = join(root, "data");
  let runtimes = fakes();
  let service = open(dataDir, runtimes);
  let describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    runtimes.claude.holdTurns = true;
    const { assignmentIds } = await task(service, projectId, [worker]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, workId)?.state === "running",
      describe,
    );
    // A crash leaves no planned-shutdown interrupt, so the restart cannot release it.
    await stopWithoutDrain(service);

    runtimes = fakes();
    service = open(dataDir, runtimes, ["codex"]);
    describe = diagnostics(service, runtimes);
    await service.start();
    // The Codex runtime is never asked about Claude-bound work.
    assert.deepEqual(runtimes.codex.calls, [], JSON.stringify(describe()));
    const recovery = service
      .recoveryView()
      .find((record) => record.workId === workId);
    assert.equal(recovery?.intent.state, "held");
    assert.deepEqual(
      recovery?.observations.map((observation) => observation.kind),
      ["unknown"],
    );
    assert.deepEqual(
      [
        recovery?.holds.writer,
        recovery?.holds.capacity,
        recovery?.holds.uncertainty,
      ],
      [true, true, true],
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unidentified anomaly retracts only its own harness's last completed work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-anomaly-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    assert.equal(
      (await service.submit("direct", "Codex", workspace)).state,
      "completed",
    );
    const worker = profile(service, "claude");
    const projectId = project(service, worker, [worker]);
    const { assignmentIds } = await task(service, projectId, [worker]);
    const claudeWork = initial(assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, claudeWork)?.state === "completed",
      describe,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(runtimes.codex.calls.every((call) => !call.includes("claude")));

    runtimes.codex.reportUnidentifiedAnomaly();
    assert.equal(intent(service, "direct")?.state, "held");
    assert.equal(intent(service, claudeWork)?.state, "completed");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["construction", "start"] as const)
  test(`a Claude runtime ${failure} failure leaves Codex running and Claude work waiting`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-harness-startup-"));
    const runtimes = fakes();
    runtimes.claude.failStart = failure === "start";
    const service = open(
      join(root, "data"),
      runtimes,
      ["codex", "claude"],
      failure === "construction" ? "claude" : undefined,
    );
    const describe = diagnostics(service, runtimes);
    try {
      await service.start();
      assert.deepEqual(service.runtimeStatus(), { state: "available" });
      const lead = profile(service, "codex");
      const worker = profile(service, "claude");
      const projectId = project(service, lead, [worker, lead]);
      const claudeTask = await task(service, projectId, [worker]);
      const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
      await waitUntil(
        () =>
          intent(service, claudeWork)?.reason ===
          "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
        describe,
      );
      const codexTask = await task(service, projectId, [lead]);
      await waitUntil(
        () =>
          intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
          "completed",
        describe,
      );
      assert.deepEqual(runtimes.claude.calls, []);
      assert.ok(runtimes.codex.calls.every((call) => !call.includes("claude")));
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("no runtime is required: a Codex start failure leaves the service running (ADR-1012)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-default-"));
  const runtimes = fakes();
  runtimes.codex.failStart = true;
  const service = open(join(root, "data"), runtimes);
  try {
    await service.start();
    assert.deepEqual(
      service.harnessStatuses().map((s) => [s.harness, s.state]),
      [
        ["codex", "unavailable"],
        ["claude", "available"],
      ],
    );
    assert.doesNotThrow(() => open(join(root, "other"), runtimes, ["claude"]));
    assert.throws(
      () => open(join(root, "other"), runtimes, ["codex", "codex"]),
      /listed once each/,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runtime cannot act through another harness's execution or evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-foreign-"));
  const runtimes = fakes();
  runtimes.codex.holdTurns = true;
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const projectId = project(service, lead, [lead]);
    const { taskId, assignmentIds } = await task(service, projectId, [lead]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, workId)?.state === "running",
      describe,
    );
    const pair = ["codex-thread-1", "codex-turn-1"] as const;
    assert.deepEqual(
      [intent(service, workId)?.threadId, intent(service, workId)?.turnId],
      pair,
    );

    // Claude presents Codex's exact pair: no authority, no holds on Codex work.
    assert.deepEqual(await runtimes.claude.callTool(...pair), {
      text: "Coordination call is not bound to current task work",
      success: false,
    });
    runtimes.claude.denyUnexpectedFor(...pair);
    runtimes.claude.reportAnomaly(...pair);
    assert.equal(intent(service, workId)?.state, "running");
    assert.equal(
      service.coordinationView().readTask(taskId).questions.length,
      0,
    );
    // The owning runtime's identical call is accepted.
    assert.equal((await runtimes.codex.callTool(...pair)).success, true);

    // A foreign terminal or thread write is refused before any side effect.
    const db = (service as unknown as { db: DatabaseSync }).db;
    const marks = () =>
      db
        .prepare(
          "SELECT runtimeGeneration, terminalEvidenceObserved FROM execution_recovery_identities WHERE workId = ?",
        )
        .get(workId) as Record<string, unknown>;
    const before = { ...marks() };
    assert.deepEqual(before, {
      runtimeGeneration: "codex-generation",
      terminalEvidenceObserved: 0,
    });
    const foreignTerminal = {
      threadId: pair[0],
      turnId: pair[1],
      status: "completed" as const,
      runtimeGeneration: "codex-generation",
    };
    assert.throws(
      () => runtimes.claude.safety?.recordTerminal(foreignTerminal),
      /another harness/,
    );
    assert.throws(
      () =>
        runtimes.claude.safety?.registerThreadTools(pair[0], "f".repeat(64)),
      /another harness/,
    );
    assert.equal(
      count(
        service,
        "SELECT COUNT(*) AS n FROM runtime_terminal_evidence WHERE threadId = ?",
        pair[0],
      ),
      0,
    );
    assert.equal(
      count(
        service,
        "SELECT COUNT(*) AS n FROM runtime_thread_qualification WHERE threadId = ?",
        pair[0],
      ),
      0,
    );
    assert.deepEqual({ ...marks() }, before);
    // The owner then records its own terminal cleanly.
    assert.equal(
      runtimes.codex.safety?.recordTerminal(foreignTerminal).harness,
      "codex",
    );
    assert.deepEqual(
      { ...marks() },
      { ...before, terminalEvidenceObserved: 1 },
    );

    // Retained evidence is readable only by the harness that recorded it.
    const codex = runtimes.codex.safety;
    const claude = runtimes.claude.safety;
    assert.ok(codex && claude);
    codex.recordTerminal({
      threadId: "shared-thread",
      turnId: "shared-turn",
      status: "completed",
      runtimeGeneration: "codex-generation",
    });
    assert.equal(
      codex.terminal("shared-thread", "shared-turn", "codex-generation")
        ?.harness,
      "codex",
    );
    assert.throws(
      () =>
        claude.terminal("shared-thread", "shared-turn", "claude-generation"),
      /another harness/,
    );
    assert.throws(() =>
      claude.recordTerminal({
        threadId: "shared-thread",
        turnId: "shared-turn",
        status: "completed",
        runtimeGeneration: "claude-generation",
      }),
    );
    codex.registerThreadTools("shared-thread", "e".repeat(64));
    assert.throws(
      () => claude.threadQualification("shared-thread"),
      /another harness/,
    );
    assert.throws(() =>
      claude.registerThreadTools("shared-thread", "e".repeat(64)),
    );
  } finally {
    runtimes.codex.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping turns on the same thread ID keep separate per-harness captures", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-captures-"));
  const runtimes = fakes();
  for (const runtime of Object.values(runtimes)) {
    runtime.holdTurns = true;
    runtime.threadName = "shared-thread";
  }
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    const codexTask = await task(service, projectId, [lead]);
    const codexWork = initial(codexTask.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, codexWork)?.state === "running",
      describe,
    );
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, claudeWork)?.state === "running",
      describe,
    );
    assert.equal(intent(service, codexWork)?.threadId, "shared-thread");
    assert.equal(intent(service, claudeWork)?.threadId, "shared-thread");

    // The later Claude capture must not replace or receive Codex's.
    runtimes.codex.answer("shared-thread", "codex-turn-1", "Codex answer");
    runtimes.claude.answer("shared-thread", "claude-turn-1", "Claude answer");
    const db = (service as unknown as { db: DatabaseSync }).db;
    const items = () =>
      db
        .prepare(
          "SELECT workId, turnId, itemId FROM conversation_history_items ORDER BY workId",
        )
        .all() as Array<{ workId: string; turnId: string; itemId: string }>;
    await waitUntil(
      () => items().length === 2,
      () => items(),
    );
    assert.deepEqual(
      items().map((item) => [item.workId, item.turnId, item.itemId]),
      [
        [codexWork, "codex-turn-1", "codex-answer"],
        [claudeWork, "claude-turn-1", "claude-answer"],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  } finally {
    runtimes.codex.releaseAll();
    runtimes.claude.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed harness with a hung identity blocks neither other work nor shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-hung-"));
  const runtimes = fakes();
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    runtimes.claude.crash();
    runtimes.claude.hangIdentity = true;
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, claudeWork)?.reason ===
        "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
      describe,
    );
    const codexTask = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
    const stopped = await Promise.race([
      service.stop().then(() => "stopped"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    assert.equal(stopped, "stopped");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a harness failing during a pending recovery inspection does not stall start-up", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-inspect-"));
  const dataDir = join(root, "data");
  let runtimes = fakes();
  let service = open(dataDir, runtimes);
  let describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    runtimes.claude.holdTurns = true;
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, claudeWork)?.state === "running",
      describe,
    );
    // A crash leaves no planned-shutdown interrupt, so the restart cannot release it.
    await stopWithoutDrain(service);

    runtimes = fakes();
    runtimes.claude.failDuringInspection = true;
    service = open(dataDir, runtimes);
    describe = diagnostics(service, runtimes);
    const started = await Promise.race([
      service.start().then(() => "started"),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 3000)),
    ]);
    assert.equal(started, "started");
    assert.deepEqual(runtimes.claude.calls, ["inspect:claude-thread-1"]);
    assert.deepEqual(
      service
        .recoveryView()
        .find((record) => record.workId === claudeWork)
        ?.observations.map((observation) => observation.kind),
      ["unknown"],
    );
    const codexTask = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("start-up does not wait for a failed secondary runtime's cleanup, and shutdown does", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-cleanup-"));
  const runtimes = fakes();
  let release!: () => void;
  runtimes.claude.failStart = true;
  runtimes.claude.stopGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  const settled = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  try {
    assert.equal(await settled(service.start()), "settled");
    assert.equal(runtimes.claude.stops, 1);
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    const claudeTask = await task(service, projectId, [worker]);
    await waitUntil(
      () =>
        intent(service, initial(claudeTask.assignmentIds[0] ?? ""))?.reason ===
        "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
      describe,
    );
    const codexTask = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );

    // Shutdown still waits for the tracked cleanup before releasing state.
    const stopping = service.stop();
    assert.equal(await settled(stopping), "pending");
    release();
    await stopping;
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unexpected request naming another harness's turn holds only the emitter's work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-unexpected-"));
  const runtimes = fakes();
  runtimes.codex.holdTurns = true;
  runtimes.claude.holdTurns = true;
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    const codexTask = await task(service, projectId, [lead]);
    const codexWork = initial(codexTask.assignmentIds[0] ?? "");
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, codexWork)?.state === "running" &&
        intent(service, claudeWork)?.state === "running",
      describe,
    );

    runtimes.claude.denyUnexpectedFor("codex-thread-1", "codex-turn-1");
    assert.equal(intent(service, codexWork)?.state, "running");
    assert.equal(intent(service, claudeWork)?.state, "held");
    assert.equal(
      intent(service, claudeWork)?.reason,
      "Runtime reported another harness's execution: item/tool/call",
    );
  } finally {
    runtimes.codex.releaseAll();
    runtimes.claude.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed secondary runtime whose stop throws synchronously is still tracked", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-sync-stop-"));
  const runtimes = fakes();
  runtimes.claude.failStart = true;
  runtimes.claude.stop = () => {
    throw new Error("Claude stop threw synchronously");
  };
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const projectId = project(service, lead, [lead]);
    const codexTask = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
    // Shutdown reports the tracked cleanup failure like any runtime stop.
    await assert.rejects(service.stop(), /Claude stop threw synchronously/);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed secondary runtime cannot start new tool calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-failed-tool-"));
  const runtimes = fakes();
  runtimes.claude.holdTurns = true;
  const service = open(join(root, "data"), runtimes);
  const describe = diagnostics(service, runtimes);
  try {
    await service.start();
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [worker]);
    const { taskId, assignmentIds } = await task(service, projectId, [worker]);
    const workId = initial(assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, workId)?.state === "running",
      describe,
    );

    // Emitted in the same tick as the failure, before its work is held.
    runtimes.claude.crash();
    assert.equal(intent(service, workId)?.state, "running");
    assert.deepEqual(
      await runtimes.claude.callTool("claude-thread-1", "claude-turn-1"),
      {
        text: "Coordination call is not bound to current task work",
        success: false,
      },
    );
    assert.equal(
      service.coordinationView().readTask(taskId).questions.length,
      0,
    );
  } finally {
    runtimes.claude.releaseAll();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["callback", "start"] as const)
  test(`a secondary runtime ${failure} failure cannot retract completed work`, async () => {
    const root = mkdtempSync(
      join(tmpdir(), "ensemble-harness-failed-request-"),
    );
    const runtimes = fakes();
    const service = open(join(root, "data"), runtimes);
    const describe = diagnostics(service, runtimes);
    try {
      await service.start();
      const worker = profile(service, "claude");
      const projectId = project(service, worker, [worker]);
      const { assignmentIds } = await task(service, projectId, [worker]);
      const workId = initial(assignmentIds[0] ?? "");
      await waitUntil(
        () => intent(service, workId)?.state === "completed",
        describe,
      );
      const completed = intent(service, workId);
      assert.ok(completed?.threadId);
      assert.ok(completed.turnId);

      if (failure === "start") {
        await service.stop();
        runtimes.claude.failStart = true;
        await service.start();
      } else runtimes.claude.crash();

      // Queued callbacks must not invalidate retained success, including in
      // the same tick as onFailure and after start() rejects without onFailure.
      runtimes.claude.denyUnexpectedFor(completed.threadId, completed.turnId);
      assert.equal(intent(service, workId)?.state, "completed");
      runtimes.claude.reportAnomaly(completed.threadId, completed.turnId);
      assert.equal(intent(service, workId)?.state, "completed");
      runtimes.claude.reportUnidentifiedAnomaly();
      assert.equal(intent(service, workId)?.state, "completed");
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a secondary runtime with pending startup does not block healthy work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-hung-start-"));
  const runtimes = fakes();
  let release!: () => void;
  let childAlive = false;
  let claudeStartSettled = false;
  runtimes.claude.start = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      claudeStartSettled = true;
      childAlive = true;
    });
  const stop = runtimes.claude.stop.bind(runtimes.claude);
  runtimes.claude.stop = async () => {
    await stop();
    childAlive = false;
  };
  const service = new StandaloneService(
    join(root, "data"),
    (context, harness) => {
      runtimes[harness].safety = context.safety;
      return runtimes[harness];
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      secondaryRuntimeStartTimeoutMs: 50,
      power: { enabled: false },
      routingClient: null,
    },
  );
  const describe = diagnostics(service, runtimes);
  const started = service.start();
  let deadline: NodeJS.Timeout | undefined;
  try {
    // The timer only stops a regression from hanging the suite.
    await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("service.start() hung on Claude's start()")),
          10_000,
        );
      }),
    ]);
    assert.equal(claudeStartSettled, false);
    assert.equal(runtimes.claude.stops, 1);
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    const claudeTask = await task(service, projectId, [worker]);
    const claudeWork = initial(claudeTask.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, claudeWork)?.reason ===
        "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
      describe,
    );
    // A late resolution never returns the detached runtime to admission.
    release();
    await waitUntil(() => runtimes.claude.stops === 2, describe);
    assert.equal(childAlive, false);
    const codexTask = await task(service, projectId, [lead]);
    await waitUntil(
      () =>
        intent(service, initial(codexTask.assignmentIds[0] ?? ""))?.state ===
        "completed",
      describe,
    );
    assert.deepEqual(runtimes.claude.calls, []);
    assert.equal(
      intent(service, claudeWork)?.reason,
      "Claude runtime unavailable; turn it off and on in Settings → Runtime, or restart the service",
    );
  } finally {
    if (deadline) clearTimeout(deadline);
    release();
    await started;
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("secondary runtime startup deadlines reject invalid bounds", () => {
  for (const value of [
    0,
    -1,
    30_001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])
    assert.throws(
      () =>
        new StandaloneService("unused", undefined, undefined, {
          secondaryRuntimeStartTimeoutMs: value,
        }),
      /Secondary runtime startup timeout/,
    );
});

test("shutdown retains pending secondary startup until its late cleanup settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-harness-late-start-"));
  const runtimes = fakes();
  let release!: () => void;
  let childAlive = false;
  runtimes.claude.start = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      childAlive = true;
    });
  const stop = runtimes.claude.stop.bind(runtimes.claude);
  runtimes.claude.stop = async () => {
    await stop();
    childAlive = false;
  };
  const service = new StandaloneService(
    join(root, "data"),
    (_, harness) => runtimes[harness],
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      secondaryRuntimeStartTimeoutMs: 50,
      power: { enabled: false },
      routingClient: null,
    },
  );
  let stopped = false;
  try {
    await service.start();
    const shutdown = service.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped, false);
    assert.equal(runtimes.claude.stops, 1);
    release();
    await shutdown;
    assert.equal(runtimes.claude.stops, 2);
    assert.equal(childAlive, false);
  } finally {
    release();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Each create returns a fresh fake, so a live enable is visible as a new instance. */
function openLive(
  dataDir: string,
  options: {
    resolves?: (harness: ExecutionHarness) => boolean;
    prepare?: (runtime: HarnessRuntime, harness: ExecutionHarness) => void;
  } = {},
) {
  const created: Record<ExecutionHarness, HarnessRuntime[]> = {
    codex: [],
    claude: [],
  };
  const service = new StandaloneService(
    dataDir,
    (context, harness) => {
      const runtime = new HarnessRuntime(harness);
      runtime.safety = context.safety;
      options.prepare?.(runtime, harness);
      created[harness].push(runtime);
      return runtime;
    },
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
      resolveExecutable: async (harness) => options.resolves?.(harness) ?? true,
    },
  );
  const latest = (harness: ExecutionHarness) => {
    const runtime = created[harness].at(-1);
    assert.ok(runtime, `${harness} was created`);
    return runtime;
  };
  return { service, created, latest };
}

const statusOf = (service: StandaloneService, harness: ExecutionHarness) => {
  const status = service.harnessStatuses().find((s) => s.harness === harness);
  return status && [status.state, "reason" in status ? status.reason : null];
};

test("disabling Claude lets its running turn finish, then stops it; new Claude work waits and never runs on Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-toggle-"));
  const live = openLive(join(root, "data"));
  const { service } = live;
  const describe = () => ({
    claude: live.created.claude.map((r) => r.calls),
    codex: live.created.codex.map((r) => r.calls),
    intents: service.list().map((i) => [i.workId, i.state, i.reason]),
  });
  try {
    await service.start();
    await service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    const lead = profile(service, "codex");
    const worker = profile(service, "claude");
    const projectId = project(service, lead, [lead, worker]);
    const first = live.latest("claude");
    first.holdTurns = true;
    const running = await task(service, projectId, [worker]);
    const runningWork = initial(running.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, runningWork)?.state === "running",
      describe,
    );

    // Bound work needs confirmation; nothing is saved without it.
    await assert.rejects(
      service.configureRuntime({
        key: randomUUID(),
        harness: "claude",
        enabled: false,
      }),
      (error: { code?: string; boundTasks?: number }) =>
        error.code === "runtime-confirmation-required" &&
        error.boundTasks === 1,
    );
    assert.equal(service.domain().runtimeEnabled("claude"), true);
    const key = randomUUID();
    const disable = {
      key,
      harness: "claude" as const,
      enabled: false,
      confirmedBoundTasks: 1,
    };
    assert.deepEqual(await service.configureRuntime(disable), {
      harness: "claude",
      enabled: false,
    });
    // A replay converges without re-asking for confirmation.
    assert.deepEqual(
      await service.configureRuntime({
        ...disable,
        confirmedBoundTasks: undefined,
      }),
      { harness: "claude", enabled: false },
    );
    assert.deepEqual(statusOf(service, "claude"), [
      "not-configured",
      "disabled",
    ]);
    assert.equal(first.stops, 0, "a draining runtime keeps running");
    assert.ok(!first.calls.some((c) => c.startsWith("interruptTurn")));

    const waiting = await task(service, projectId, [worker]);
    const waitingWork = initial(waiting.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, waitingWork)?.reason ===
        "Claude runtime is not configured",
      describe,
    );

    first.releaseAll();
    await waitUntil(
      () => intent(service, runningWork)?.state === "completed",
      describe,
    );
    await waitUntil(() => first.stops === 1, describe);
    assert.equal(intent(service, waitingWork)?.state, "ready");
    assert.ok(
      live.created.codex.every((r) =>
        r.calls.every((call) => !call.includes("claude")),
      ),
    );
    assert.equal(
      live.created.codex
        .flatMap((r) => r.calls)
        .filter((c) => c.startsWith("startTurn")).length,
      0,
      "no Codex turn ran for Claude work",
    );

    // Re-enabling starts a new runtime without a restart and admits the waiting work.
    await service.configureRuntime({
      key: randomUUID(),
      harness: "claude",
      enabled: true,
    });
    assert.equal(live.created.claude.length, 2);
    assert.deepEqual(statusOf(service, "claude"), ["available", null]);
    await waitUntil(
      () => intent(service, waitingWork)?.state === "completed",
      describe,
    );
    assert.ok(
      live.latest("claude").calls.some((c) => c.startsWith("startTurn")),
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-enabling a draining runtime keeps it; disabling one with no bound work stops it at once", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-drain-"));
  const live = openLive(join(root, "data"));
  const { service } = live;
  const describe = () => service.list().map((i) => [i.state, i.reason]);
  try {
    await service.start();
    const worker = profile(service, "claude");
    const lead = profile(service, "codex");
    const projectId = project(service, lead, [worker]);
    const claude = live.latest("claude");
    claude.holdTurns = true;
    const running = await task(service, projectId, [worker]);
    const work = initial(running.assignmentIds[0] ?? "");
    await waitUntil(() => intent(service, work)?.state === "running", describe);
    await service.configureRuntime({
      key: randomUUID(),
      harness: "claude",
      enabled: false,
      confirmedBoundTasks: 1,
    });
    // Work that waited while it was disabled is admitted on re-enable, before the
    // running turn ends.
    const waiting = await task(service, projectId, [worker]);
    const waitingWork = initial(waiting.assignmentIds[0] ?? "");
    await waitUntil(
      () =>
        intent(service, waitingWork)?.reason ===
        "Claude runtime is not configured",
      describe,
    );
    await service.configureRuntime({
      key: randomUUID(),
      harness: "claude",
      enabled: true,
    });
    assert.equal(live.created.claude.length, 1, "nothing starts twice");
    await waitUntil(
      () => intent(service, waitingWork)?.state === "running",
      describe,
    );
    claude.releaseAll();
    await waitUntil(
      () => intent(service, work)?.state === "completed",
      describe,
    );
    assert.equal(claude.stops, 0);

    // Codex has no bound work: no confirmation, stopped immediately.
    assert.equal(
      service.runtimeSettings().find((r) => r.harness === "codex")?.boundTasks,
      0,
    );
    await service.configureRuntime({
      key: randomUUID(),
      harness: "codex",
      enabled: false,
    });
    assert.equal(live.latest("codex").stops, 1);
    assert.deepEqual(statusOf(service, "codex"), [
      "not-configured",
      "disabled",
    ]);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabling is refused while the executable is missing; a failed start is unavailable until enabled again", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-refuse-"));
  let claudeOnPath = true;
  let failNext = false;
  const live = openLive(join(root, "data"), {
    resolves: (harness) => harness !== "claude" || claudeOnPath,
    prepare: (runtime, harness) => {
      if (harness === "claude" && failNext) {
        runtime.failStart = true;
        failNext = false;
      }
    },
  });
  const { service } = live;
  try {
    await service.start();
    await service.configureRuntime({
      key: randomUUID(),
      harness: "claude",
      enabled: false,
    });
    claudeOnPath = false;
    await assert.rejects(
      service.configureRuntime({
        key: randomUUID(),
        harness: "claude",
        enabled: true,
      }),
      (error: { code?: string; harness?: string }) =>
        error.code === "runtime-executable-missing" &&
        error.harness === "claude",
    );
    assert.equal(service.domain().runtimeEnabled("claude"), false);
    assert.equal(live.created.claude.length, 1);

    claudeOnPath = true;
    failNext = true;
    assert.deepEqual(
      await service.configureRuntime({
        key: randomUUID(),
        harness: "claude",
        enabled: true,
      }),
      { harness: "claude", enabled: true },
    );
    assert.equal(service.domain().runtimeEnabled("claude"), true);
    assert.equal(statusOf(service, "claude")?.[0], "unavailable");
    assert.equal(
      live.latest("claude").stops,
      1,
      "the failed start is cleaned up",
    );

    // Enabling an enabled, unavailable runtime retries on a fresh instance.
    await service.configureRuntime({
      key: randomUUID(),
      harness: "claude",
      enabled: true,
    });
    assert.equal(live.created.claude.length, 3);
    assert.deepEqual(statusOf(service, "claude"), ["available", null]);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the setting persists across restart; with none enabled the service starts and work waits", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-runtime-none-"));
  const dataDir = join(root, "data");
  let live = openLive(dataDir);
  try {
    await live.service.start();
    for (const harness of ["codex", "claude"] as const)
      await live.service.configureRuntime({
        key: randomUUID(),
        harness,
        enabled: false,
      });
    await live.service.stop();

    live = openLive(dataDir);
    const { service } = live;
    await service.start();
    assert.equal(live.created.codex.length + live.created.claude.length, 0);
    assert.deepEqual(
      ["codex", "claude"].map((h) => statusOf(service, h as ExecutionHarness)),
      [
        ["not-configured", "disabled"],
        ["not-configured", "disabled"],
      ],
    );
    const lead = profile(service, "codex");
    const projectId = project(service, lead, [lead]);
    const waiting = await task(service, projectId, [lead]);
    const work = initial(waiting.assignmentIds[0] ?? "");
    await waitUntil(
      () => intent(service, work)?.reason === "Codex runtime is not configured",
      () => service.list().map((i) => [i.state, i.reason]),
    );
    await service.configureRuntime({
      key: randomUUID(),
      harness: "codex",
      enabled: true,
    });
    await waitUntil(
      () => intent(service, work)?.state === "completed",
      () => service.list().map((i) => [i.state, i.reason]),
    );
  } finally {
    await live.service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
