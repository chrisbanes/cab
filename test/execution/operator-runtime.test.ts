import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clockLabel } from "../../src/operator/clock-label.js";
import { ManualRestartClock, settle } from "../fixtures/restart-clock.js";
import { tmpdir } from "../fixtures/temp.js";
import type { DomainCommand } from "../../src/core/domain.js";
import type { Runtime } from "../../src/standalone/codex.js";
import { runtimeOperatorRoutes } from "../../src/standalone/operator-runtime.js";
import type { RuntimeProcessIdentity } from "../../src/standalone/recovery-types.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { boundWorld } from "./bound-turn-recovery-fixture.js";
import { until } from "../fixtures/until.js";

const runtime: Runtime = {
  async start() {},
  async stop() {},
  async startThread() {
    return "thread";
  },
  async resumeThread() {},
  async startTurn() {
    return "turn";
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
  onUnexpectedRequest() {},
  onToolCall() {},
};

class HeldRuntime implements Runtime {
  turns = 0;
  private resolveTurn!: (status: "completed" | "failed") => void;
  readonly turn: Promise<"completed" | "failed">;

  constructor() {
    this.turn = new Promise((resolve) => {
      this.resolveTurn = resolve;
    });
  }

  async start() {}
  async stop() {
    this.resolveTurn("failed");
  }
  async startThread() {
    return "held-thread";
  }
  async resumeThread() {}
  async startTurn() {
    this.turns += 1;
    return "held-turn";
  }
  async interruptTurn() {}
  async waitForTurn() {
    return this.turn;
  }
  onUnexpectedRequest() {}
  onToolCall() {}
}

function deferredOutcome() {
  let resolve!: (status: "completed" | "failed") => void;
  const promise = new Promise<"completed" | "failed">((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RecoveryEvidenceRuntime implements Runtime {
  readonly process: RuntimeProcessIdentity = {
    processId: "fixture-process-<script>",
    processStartedAt: "fixture-started-&-bounded",
    bootId: "fixture-boot-identity",
  };
  threads = 0;
  turns = 0;
  private readonly outcomes = new Map<
    string,
    ReturnType<typeof deferredOutcome>
  >();

  async start() {}

  async stop() {
    for (const outcome of this.outcomes.values()) outcome.resolve("failed");
  }

  processIdentity() {
    return this.process;
  }

  async startThread() {
    return `fixture-thread-${++this.threads}-<img src=x onerror=alert(1)>`;
  }

  async resumeThread() {}

  async startTurn() {
    const turnId = `fixture-turn-${++this.turns}-&-recorded`;
    this.outcomes.set(turnId, deferredOutcome());
    return turnId;
  }

  async interruptTurn() {}

  async waitForTurn(_threadId: string, turnId: string) {
    return this.outcomes.get(turnId)?.promise ?? "failed";
  }

  onUnexpectedRequest() {}
  onToolCall() {}

  finish(turnId: string, status: "completed" | "failed") {
    this.outcomes.get(turnId)?.resolve(status);
  }
}

function command(service: StandaloneService, value: object): unknown {
  return service.domain().execute({
    key: randomUUID(),
    actor: "operator",
    ...value,
  } as DomainCommand);
}

test("runtime overview reports effective access limits without exposing configuration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-operator-"));
  const service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Private profile",
    instructions: "PRIVATE_PROFILE_SENTINEL",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Private project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Private task",
    outcome: "PRIVATE_OUTCOME_SENTINEL",
    ready: false,
  });

  const route = runtimeOperatorRoutes(service).find(
    (candidate) => candidate.method === "GET" && candidate.path === "/runtime",
  );
  assert.ok(route, "runtime overview route exists");
  const page = await route.handler({
    params: {},
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(page.kind, "html");
  if (page.kind !== "html") return;

  assert.match(page.body, /Runtime/);
  assert.match(page.body, /Global active turns: 4/);
  assert.match(page.body, /Default project active turns: 2/);
  assert.match(page.body, /workspace writes with broad host-permitted reads/i);
  assert.match(page.body, /Command network access is disabled/i);
  assert.match(page.body, /Approval policy is never/i);
  assert.match(page.body, /Stricter isolation.*not proved/i);
  assert.doesNotMatch(page.body, /PRIVATE_(?:PROFILE|OUTCOME)_SENTINEL/);
  assert.ok(
    page.body.includes(`/app/tasks/${taskId}?section=execution`),
    "runtime overview links to task-specific history",
  );
});

test("runtime overview shows the restart notice only after a runtime failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-failure-"));
  let fail!: (error: Error) => void;
  const clock = new ManualRestartClock();
  const service = new StandaloneService(
    join(directory, "data"),
    () => ({
      ...runtime,
      onFailure(listener: (error: Error) => void) {
        fail = listener;
      },
    }),
    undefined,
    { runtimeRestart: { clock, wallNow: clock.wallNow } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();
  const route = runtimeOperatorRoutes(service).find(
    (candidate) => candidate.method === "GET" && candidate.path === "/runtime",
  );
  assert.ok(route);
  const read = async () => {
    const page = await route.handler({
      params: {},
      fields: {},
      csrfToken: "test-token",
    });
    assert.equal(page.kind, "html");
    return page.kind === "html" ? page.body : "";
  };
  assert.doesNotMatch(await read(), /Codex runtime unavailable/);
  fail(new Error("Runtime lost <script>"));
  const body = await read();
  assert.ok(
    body.includes(
      `<p role="alert">Codex runtime unavailable — Restarting · attempt 1 of 3 · next at ${clockLabel(clock.wall + 30_000)}</p>`,
    ),
  );
  assert.doesNotMatch(body, /Runtime lost|<script>/);
});

test("runtime overview says retries are exhausted once the third restart fails", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-exhausted-"));
  let fail!: (error: Error) => void;
  let starts = 0;
  const clock = new ManualRestartClock();
  const service = new StandaloneService(
    join(directory, "data"),
    () => ({
      ...runtime,
      async start() {
        if (++starts > 1) throw new Error("App Server will not start");
      },
      onFailure(listener: (error: Error) => void) {
        fail = listener;
      },
    }),
    undefined,
    { runtimeRestart: { clock, wallNow: clock.wallNow } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();
  const route = runtimeOperatorRoutes(service).find(
    (candidate) => candidate.method === "GET" && candidate.path === "/runtime",
  );
  assert.ok(route);
  fail(new Error("Runtime lost"));
  for (const [index, delay] of [30_000, 120_000, 600_000].entries()) {
    clock.advance(delay);
    await settle(() => starts === index + 2);
  }
  await settle(() => {
    const status = service.harnessStatuses()[0];
    return (
      status?.state === "unavailable" && status.restart?.state === "exhausted"
    );
  });

  const page = await route.handler({
    params: {},
    fields: {},
    csrfToken: "test-token",
  });
  assert.ok(page.kind === "html");
  assert.ok(
    page.body.includes(
      '<p role="alert">Codex runtime unavailable — Retries exhausted; turn it off and on in Settings → Runtime, or restart the service</p>',
    ),
  );
  assert.doesNotMatch(page.body, /will not start/);
});

test("runtime overview alerts once per unavailable harness and never for a disabled one", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-harnesses-"));
  const clock = new ManualRestartClock();
  const options = (harnesses: ("codex" | "claude")[]) =>
    new StandaloneService(
      join(directory, harnesses.join("-")),
      (_context, harness) => {
        if (harness === "claude") throw new Error("Claude unavailable");
        return { ...runtime };
      },
      undefined,
      {
        runtimeHarnesses: harnesses,
        runtimeRestart: { clock, wallNow: clock.wallNow },
      },
    );
  const disabled = options(["codex"]),
    failed = options(["codex", "claude"]);
  t.after(async () => {
    await disabled.stop();
    await failed.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await disabled.start();
  await failed.start();
  const read = async (service: StandaloneService) => {
    const route = runtimeOperatorRoutes(service).find(
      (candidate) =>
        candidate.method === "GET" && candidate.path === "/runtime",
    );
    const page = await route?.handler({
      params: {},
      fields: {},
      csrfToken: "test-token",
    });
    return page?.kind === "html" ? page.body : "";
  };
  assert.doesNotMatch(await read(disabled), /runtime unavailable/);
  const body = await read(failed);
  assert.ok(
    body.includes(
      `<p role="alert">Claude runtime unavailable — Restarting · attempt 1 of 3 · next at ${clockLabel(clock.wall + 30_000)}</p>`,
    ),
  );
  assert.equal(body.match(/runtime unavailable/g)?.length, 1);
  assert.doesNotMatch(body, /Codex runtime unavailable/);
});

test("runtime details distinguish selected, queued, and running assignments across projects", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-status-matrix-"));
  const heldRuntime = new HeldRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => heldRuntime,
    undefined,
    { power: { enabled: false } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const leadA = randomUUID();
  const leadB = randomUUID();
  const worker = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  const runningTask = randomUUID();
  const queuedTask = randomUUID();
  const selectedTask = randomUUID();
  const selectedWorker = randomUUID();
  const profiles: Array<[string, string]> = [
    [leadA, "Lead A"],
    [leadB, "Lead B"],
    [worker, "Worker"],
  ];
  for (const [profileId, name] of profiles)
    command(service, {
      type: "profile.create",
      profileId,
      name,
      instructions: `PRIVATE_${name.replaceAll(" ", "_")}_INSTRUCTIONS`,
      capabilities: name.startsWith("Lead") ? "coordinate" : "review",
    });
  command(service, {
    type: "project.create",
    projectId: projectA,
    name: "Project A",
    leadProfileId: leadA,
  });
  command(service, {
    type: "project.create",
    projectId: projectB,
    name: "Project B",
    leadProfileId: leadB,
  });
  for (const projectId of [projectA, projectB]) {
    command(service, {
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    command(service, {
      type: "routing.configure",
      projectId,
      expectedVersion: 1,
      enabled: false,
      guidance: "No external routing is enabled.",
      credentialRef: null,
      candidateProfileIds: [worker],
    });
  }
  for (const [projectId, taskId, title] of [
    [projectA, runningTask, "Running task"],
    [projectA, queuedTask, "Queued task"],
    [projectB, selectedTask, "Selected task"],
  ])
    command(service, {
      type: "task.create",
      projectId,
      taskId,
      title,
      outcome: "PRIVATE_TASK_OUTCOME",
      ready: false,
    });
  command(service, {
    type: "assignment.create",
    projectId: projectB,
    taskId: selectedTask,
    assignmentId: selectedWorker,
    profileId: worker,
    brief: "PRIVATE_ASSIGNMENT_BRIEF",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const selectedLead = service.domain().ensureLeadAssignment(selectedTask);
  assert.ok(selectedLead);
  await service.configureCapacity({
    key: randomUUID(),
    globalLimit: 1,
    projectOverrides: { [projectA]: 1 },
  });
  await service.provisionTask(runningTask);
  await service.provisionTask(queuedTask);
  command(service, {
    type: "task.configure",
    projectId: projectA,
    taskId: runningTask,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => heldRuntime.turns === 1);
  command(service, {
    type: "task.configure",
    projectId: projectA,
    taskId: queuedTask,
    expectedVersion: 1,
    ready: true,
  });
  await until(() =>
    service
      .turnRequests()
      .some(
        (request) =>
          request.taskId === queuedTask && request.state === "queued",
      ),
  );

  const routes = runtimeOperatorRoutes(service);
  const get = (path: string) => {
    const route = routes.find(
      (candidate) => candidate.method === "GET" && candidate.path === path,
    );
    assert.ok(route, `GET ${path} exists`);
    return route;
  };
  // Task status is the task read's execution, not a page derivation.
  const api = new OperatorApi(service, [directory]);
  const state = async (taskId: string) =>
    (await api.readTask(taskId)).data.execution.state;
  assert.equal(await state(runningTask), "running");
  assert.equal(await state(queuedTask), "queued");
  assert.equal(await state(selectedTask), "waiting");
  const overview = await get("/runtime").handler({
    params: {},
    fields: {},
    csrfToken: "test-token",
  });
  assert.equal(overview.kind, "html");
  if (overview.kind === "html") {
    for (const taskId of [runningTask, queuedTask, selectedTask])
      assert.ok(
        overview.body.includes(`/app/tasks/${taskId}?section=execution`),
      );
    assert.match(overview.body, /Project A/);
    assert.match(overview.body, /Project B/);
    assert.doesNotMatch(overview.body, /PRIVATE_/);
  }
});

test("capacity control replays the same keyed change", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-capacity-"));
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Capacity lead",
    instructions: "coordinate",
    capabilities: "coordination",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Capacity project",
    leadProfileId: profileId,
  });
  const route = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/capacity",
  );
  assert.ok(route, "capacity control route exists");
  const fields = {
    key: randomUUID(),
    globalLimit: "1",
    projectId,
    projectLimit: "1",
  };
  const context = { params: {}, fields, csrfToken: "test-token" };

  assert.deepEqual(await route.handler(context), {
    kind: "redirect",
    location: "/runtime",
  });
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  const restartedRoute = runtimeOperatorRoutes(service).find(
    (candidate) =>
      candidate.method === "POST" &&
      candidate.path === "/runtime/control/capacity",
  );
  assert.ok(restartedRoute, "capacity control route exists after restart");
  assert.deepEqual(await restartedRoute.handler(context), {
    kind: "redirect",
    location: "/runtime",
  });
  assert.equal(service.capacityLimits([projectId]).globalLimit, 1);
  assert.equal(
    service.capacityLimits([projectId]).projectOverrides[projectId],
    1,
  );
});

test("task execution keeps the writer hold visible after Resume", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-task-"));
  const heldRuntime = new HeldRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => heldRuntime,
    undefined,
    { power: { enabled: false }, supervisor: { observationMs: 5 } },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Task lead",
    instructions: "PRIVATE_PROFILE_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Hold project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Held <script>window.privateValue=1</script>",
    outcome: "PRIVATE_OUTCOME_SENTINEL",
    ready: true,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  await until(() => heldRuntime.turns > 0);

  const api = new OperatorApi(service, [directory]);
  const read = async () => (await api.readTask(taskId)).data;
  assert.equal((await read()).execution.state, "running");

  await service.stopTask(taskId);
  assert.equal((await read()).execution.state, "stopping");

  // Resume clears only the Stop: the writer hold stays recorded.
  await service.resumeTask(taskId);
  const resumed = await read();
  assert.equal(resumed.execution.holds.stop, false);
  assert.equal(resumed.executionRecovery?.holds.writer, true);

});

test("the assignment recovery read retains scoped records and holds", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-recovery-view-"));
  const runtime = new RecoveryEvidenceRuntime();
  const service = new StandaloneService(
    join(directory, "data"),
    () => runtime,
    undefined,
    {
      power: { enabled: false },
      supervisor: { observationMs: 5 },
      terminationVerifier: {
        async verify(processIdentity) {
          return {
            kind: "verified",
            processIdentity,
            verifiedAt: "2026-09-30T12:00:00.000Z",
            method: "mac-pid-absent-same-boot",
          };
        },
      },
    },
  );
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const workerAssignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId: leadProfileId,
    name: "Recovery lead",
    instructions: "PRIVATE_RECOVERY_INSTRUCTIONS_SENTINEL",
    capabilities: "coordinate",
  });
  command(service, {
    type: "profile.create",
    profileId: workerProfileId,
    name: "Recovery worker",
    instructions: "PRIVATE_RECOVERY_WORKER_INSTRUCTIONS_SENTINEL",
    capabilities: "review",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Recovery evidence project",
    leadProfileId,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  command(service, {
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "No routing calls are made by this view fixture.",
    credentialRef: "env:PRIVATE_RECOVERY_CREDENTIAL_SENTINEL",
    candidateProfileIds: [workerProfileId],
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Task-scoped recovery evidence",
    outcome: "PRIVATE_RECOVERY_OUTCOME_SENTINEL",
    ready: false,
  });
  const leadAssignment = service.domain().ensureLeadAssignment(taskId);
  assert.ok(leadAssignment);
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId: workerAssignmentId,
    profileId: workerProfileId,
    brief: "PRIVATE_RECOVERY_BRIEF_SENTINEL",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  await service.provisionTask(taskId);
  command(service, {
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  await until(() => runtime.turns === 1);

  await service.stopTask(taskId);
  const firstRecord = service
    .recoveryView()
    .find((record) => record.binding?.taskId === taskId);
  assert.ok(firstRecord?.binding);
  assert.ok(firstRecord.intent.threadId);
  assert.ok(firstRecord.intent.turnId);
  assert.ok(firstRecord.processIdentity);
  const firstTurnId = firstRecord.intent.turnId;
  await service.resolveHeldExecution({
    workId: firstRecord.workId,
    workRevision: firstRecord.generation.workRevision,
    requestSequence: firstRecord.generation.requestSequence,
    threadId: firstRecord.intent.threadId,
    turnId: firstTurnId,
    processIdentity: firstRecord.processIdentity,
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "reconciled",
  });
  runtime.finish(firstTurnId, "failed");
  await service.resumeTask(taskId);
  await until(() => runtime.turns === 2);
  await service.stopTask(taskId);

  const records = service
    .recoveryView()
    .filter((record) => record.binding?.taskId === taskId);
  assert.equal(
    records.length,
    2,
    "both SQLite-backed generations are retained",
  );
  const receiptRecord = records.find((record) => record.receipt !== null);
  const pendingRecord = records.find(
    (record) => record.receipt === null && record.pendingEffects.length > 0,
  );
  assert.ok(receiptRecord?.receipt);
  assert.ok(receiptRecord?.binding);
  assert.ok(pendingRecord?.binding);
  assert.notEqual(receiptRecord.workId, pendingRecord.workId);

  const recovery = (await new OperatorApi(service, [directory]).readAssignmentRecovery(
    pendingRecord.binding.assignmentId,
  )).data;
  assert.ok(recovery.records.some((r) => r.workId === receiptRecord.workId));
  assert.ok(recovery.records.some((r) => r.workId === pendingRecord.workId));
  assert.equal(recovery.holds.writer, true);
  assert.doesNotMatch(JSON.stringify(recovery), /PRIVATE_RECOVERY_/);
});

test("instruction apply refreshes the selected assignment revision once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cab-runtime-instructions-"));
  let service = new StandaloneService(join(directory, "data"), () => runtime);
  t.after(async () => {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.start();

  const profileId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Instruction lead",
    instructions: "original profile instructions",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "Instruction project",
    leadProfileId: profileId,
  });
  command(service, {
    type: "task.create",
    projectId,
    taskId,
    title: "Instruction task",
    outcome: "Deliver work",
    ready: false,
  });
  command(service, {
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "PRIVATE_ASSIGNMENT_PROMPT",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command(service, {
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "updated project instructions",
  });

  const input = {
    type: "assignment.apply" as const,
    key: randomUUID(),
    projectId,
    assignmentId,
    expectedVersion: 1,
  };
  const receipt = await new OperatorApi(service, [directory]).execute(input);
  await service.stop();
  service = new StandaloneService(join(directory, "data"), () => runtime);
  await service.start();
  assert.deepEqual(await new OperatorApi(service, [directory]).execute(input), receipt);
  const assignment = service.domain().assignment(assignmentId);
  assert.equal(Number(assignment.version), 2);
  assert.equal(Number(assignment.instructionsRevision), 2);
});

test("retained bound-turn controls review without writes, retain refusal and read original receipt before exact retry", async (t) => {
  const w = await boundWorld(t),
    service = w.s.f.service;
  const api = new OperatorApi(service, [w.s.f.directory]);
  const routes = runtimeOperatorRoutes(service, api);
  const call = async (
    path: string,
    fields: Record<string, string> = {},
    params: Record<string, string> = {},
  ) => {
    const result = await routes
      .find((r) => r.path === path)!
      .handler({ fields, params, csrfToken: "fixture-csrf" });
    assert.equal(result.kind, "html");
    return result.kind === "html" ? result.body : "";
  };
  const options = await api.readRecoveryOptions(w.g.assignmentId);
  assert.ok(options.data.records.some((r) => r.paths.some((p) => p.path === "bound-turn-recover" && p.eligible)));
  const recoveryHref = `/app/assignments/${encodeURIComponent(w.g.assignmentId)}/recovery`;
  const original = w.recovery();
  const payload = JSON.stringify(original);
  const fields = {
    payload,
    termination: "confirmed",
    effects: "settled",
    workspace: "preserved",
  };
  const review = await call("/runtime/control/bound-turn/review", fields);
  assert.match(review, /cannot be undone/);
  assert.match(review, /Cancel and return to evidence/);
  assert.ok(review.includes(recoveryHref));
  assert.equal(service.recoveryForTask(w.g.taskId)[0]?.receipt, null);
  const stale = structuredClone(original);
  stale.receipt.turnId = "another-turn";
  const staleReview = await call("/runtime/control/bound-turn/review", {
    ...fields,
    payload: JSON.stringify(stale),
  });
  assert.match(staleReview, /identity changed/);
  assert.ok(staleReview.includes(recoveryHref));
  assert.match(staleReview, /another-turn/);
  assert.match(staleReview, new RegExp(original.key));
  assert.doesNotMatch(staleReview, /<button>Confirm reconciliation|<form/);
  w.setMode("live");
  const blockedReview = await call("/runtime/control/bound-turn/review", {
    ...fields,
    workspace: "reconciled",
  });
  assert.match(blockedReview, /Independent assertions retained/);
  assert.ok(blockedReview.includes(recoveryHref));
  assert.match(blockedReview, /workspace reconciled/);
  assert.match(blockedReview, /&quot;workspace&quot;:&quot;reconciled&quot;/);
  assert.match(blockedReview, new RegExp(original.key));
  assert.doesNotMatch(blockedReview, /<button>Confirm reconciliation|<form/);
  const unavailable = runtimeOperatorRoutes(service, {
    readRecoveryOptions: async () => {
      throw new Error("lookup unavailable");
    },
    readOperation: api.readOperation.bind(api),
  }).find((route) => route.path === "/runtime/control/bound-turn/review");
  assert.ok(unavailable);
  const unavailableReview = await unavailable.handler({
    fields: { ...fields, workspace: "reconciled" },
    params: {},
    csrfToken: "fixture-csrf",
  });
  assert.equal(unavailableReview.kind, "html");
  if (unavailableReview.kind === "html") {
    assert.match(unavailableReview.body, /lookup failed/);
    assert.match(unavailableReview.body, /workspace reconciled/);
    assert.match(unavailableReview.body, new RegExp(original.key));
    assert.doesNotMatch(
      unavailableReview.body,
      /<button>Confirm reconciliation|<form/,
    );
  }
  assert.equal(service.recoveryForTask(w.g.taskId)[0]?.receipt, null);
  assert.equal(service.recoveryForTask(w.g.taskId)[0]?.holds.writer, true);
  const refused = await call("/runtime/control/bound-turn/recover", {
    payload,
    confirmed: "yes",
  });
  assert.match(refused, /Check original receipt/);
  assert.ok(refused.includes(recoveryHref));
  assert.doesNotMatch(refused, /<button>Confirm reconciliation/);
  assert.match(refused, new RegExp(original.key));
  assert.equal(service.recoveryForTask(w.g.taskId)[0]?.holds.writer, true);
  const absent = await call("/runtime/control/bound-turn/check", { payload });
  assert.match(absent, /No receipt is recorded/);
  assert.ok(absent.includes(recoveryHref));
  assert.match(absent, /Confirm reconciliation/);
  w.setMode("verified");
  const accepted = await call("/runtime/control/bound-turn/recover", {
    payload,
    confirmed: "yes",
  });
  assert.match(accepted, /Execution reconciled/);
  assert.ok(accepted.includes(recoveryHref));
  const checks = w.checks();
  const readback = await call("/runtime/control/bound-turn/check", { payload });
  assert.match(readback, /Execution reconciled/);
  assert.ok(readback.includes(recoveryHref));
  assert.doesNotMatch(readback, /<button>Confirm reconciliation/);
  assert.equal(w.checks(), checks);
  assert.equal(w.runtime.turnInvocations.length, 1);
});
