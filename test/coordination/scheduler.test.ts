import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "../fixtures/temp.js";
import { waitForProcessGone } from "../fixtures/process-gone.js";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { controlledGit } from "../fixtures/controlled-git.js";
import { StandaloneService } from "../../src/standalone/service.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
  UnexpectedRequest,
} from "../../src/standalone/codex.js";
import type { TaskWorkspaceRepositoryInput } from "../../src/standalone/workspaces.js";
import { QUIET_WINDOW_MS } from "../fixtures/until.js";

class GatedRuntime implements Runtime {
  starts = 0;
  turns = 0;
  prompts: string[] = [];
  entered: (() => void) | undefined;
  release: Promise<void> | undefined;
  private toolCall:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  async start() {}
  async stop() {}
  async startThread() {
    this.starts++;
    return `thread-${this.starts}`;
  }
  async resumeThread() {}
  async startTurn(_threadId: string, _workspace: string, prompt: string) {
    this.turns++;
    this.prompts.push(prompt);
    return `turn-${this.turns}`;
  }
  async interruptTurn() {}
  async waitForTurn(threadId: string, turnId: string) {
    await this.toolCall?.({
      threadId,
      turnId,
      callId: `fixture-question-${threadId}-${turnId}`,
      tool: "cab_ask_question",
      arguments: { question: "Scheduler fixture is waiting for the next step" },
    });
    this.entered?.();
    await this.release;
    return "completed" as const;
  }
  onUnexpectedRequest(_listener: (request: UnexpectedRequest) => void) {}
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.toolCall = listener;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs?: number,
): Promise<boolean> {
  if (timeoutMs !== undefined) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    return predicate();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

function execute(service: StandaloneService, command: Record<string, unknown>) {
  return service.domain().execute({ key: randomUUID(), ...command } as never);
}

async function addProject(service: StandaloneService, profileId: string) {
  const projectId = randomUUID();
  execute(service, {
    type: "project.create",
    actor: "operator",
    projectId,
    name: `Project ${projectId.slice(0, 8)}`,
    leadProfileId: profileId,
  });
  execute(service, {
    type: "project.configure",
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  return projectId;
}

async function addReadyAssignment(
  service: StandaloneService,
  projectId: string,
  profileId: string,
  brief: string,
  repositories: TaskWorkspaceRepositoryInput[] = [],
) {
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  execute(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title: brief,
    outcome: brief,
    ready: false,
  });
  await service.provisionTask(taskId, repositories);
  execute(service, {
    type: "assignment.create",
    actor: "agent",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief,
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  execute(service, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return { assignmentId, taskId, workId: `assignment:${assignmentId}:initial` };
}

function repository(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path]);
  execFileSync("git", ["-C", path, "config", "user.name", "Scheduler Test"]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "scheduler-test@example.invalid",
  ]);
  writeFileSync(join(path, "README.md"), `${name}\n`);
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "initial"]);
  return path;
}

async function waitForControlledGitReady(
  controlled: ReturnType<typeof controlledGit>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      controlled
        .events()
        .some(
          ({ event, operation }) =>
            event === "ready" && operation === "repository-identity",
        )
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Scheduler test Git child did not reach its stall");
}

async function addProfile(service: StandaloneService) {
  const profileId = randomUUID();
  execute(service, {
    type: "profile.create",
    actor: "operator",
    profileId,
    name: "Builder",
    instructions: "build",
    capabilities: "code",
  });
  return profileId;
}

async function configureCapacity(
  service: StandaloneService,
  globalLimit: number,
  projectOverrides: Record<string, number | null> = {},
  minimumLeadSlots = 0,
  agentOverrides: Record<string, number | null> = {},
) {
  return service.configureCapacity({
    key: randomUUID(),
    globalLimit,
    minimumLeadSlots,
    projectOverrides,
    agentOverrides,
  });
}

function capacityLimits(service: StandaloneService) {
  return service.capacityLimits();
}

/** A Ready task with no explicit assignment, so its lead takes the first turn. */
async function addReadyLeadTask(
  service: StandaloneService,
  projectId: string,
  title: string,
) {
  const taskId = randomUUID();
  execute(service, {
    type: "task.create",
    actor: "operator",
    projectId,
    taskId,
    title,
    outcome: title,
    ready: false,
  });
  await service.provisionTask(taskId);
  execute(service, {
    type: "task.configure",
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  return taskId;
}

function leadWork(service: StandaloneService, taskId: string) {
  return service.turnRequests().find((request) => request.taskId === taskId)
    ?.workId;
}

function stateOf(service: StandaloneService, workId: string | undefined) {
  const intent = service.list().find((item) => item.workId === workId);
  return { state: intent?.state, reason: intent?.reason };
}

function countRows(
  service: StandaloneService,
  sql: string,
  ...args: unknown[]
): number {
  const db = (
    service as unknown as {
      db: {
        prepare(query: string): {
          get(...params: unknown[]): { count: number } | undefined;
        };
      };
    }
  ).db;
  return db.prepare(sql).get(...args)?.count ?? 0;
}

test("eligible pending assignments dispatch once and retain request identity after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-scheduler-"));
  const dataDir = join(root, "data");
  const runtime = new GatedRuntime();
  let service = new StandaloneService(dataDir, () => runtime);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "use deterministic assignments",
      candidateProfileIds: [profileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Task",
      outcome: "Deliver",
      ready: false,
    });
    await service.provisionTask(taskId);
    const entered = deferred();
    const release = deferred();
    runtime.entered = entered.resolve;
    runtime.release = release.promise;
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Implement the task",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    execute({
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    assert.equal(
      await waitUntil(() => runtime.turns === 1),
      true,
      `eligible assignment was not dispatched: ${JSON.stringify({ requests: service.turnRequests(), intents: service.list(), admission: service.domain().assignmentAdmission(assignmentId) })}`,
    );
    await entered.promise;
    assert.equal(runtime.turns, 1);
    const first = service.list().find((item) => item.state === "running");
    assert.ok(first);
    const admittedAssignmentState = service
      .domain()
      .assignment(assignmentId).state;
    release.resolve();
    assert.equal(admittedAssignmentState, "running");

    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 2,
      paused: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(runtime.turns, 1);

    release.resolve();
    await waitUntil(
      () =>
        service.list().find((item) => item.id === first.id)?.state ===
        "completed",
      15_000,
    );
    assert.equal(
      service.list().find((item) => item.id === first.id)?.state,
      "completed",
      JSON.stringify({
        intent: service.list().find((item) => item.id === first.id),
        request: service.turnRequests(),
      }),
    );
    await service.stop();

    const restartedRuntime = new GatedRuntime();
    service = new StandaloneService(dataDir, () => restartedRuntime);
    await service.start();
    const restored = service.list().find((item) => item.id === first.id);
    assert.equal(restored?.workId, first.workId);
    assert.equal(restored?.state, "completed");
    await service.stop();
    assert.equal(restartedRuntime.turns, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("service stop cancels ready-workspace Git before scheduler settlement and preserves uncertainty", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-scheduler-git-drain-"));
  const controlled = controlledGit();
  const source = repository(root, "source");
  const failures: Array<{
    operation: string;
    kind: string;
    childExitObserved: boolean;
    childExitSignal: NodeJS.Signals | null;
  }> = [];
  const failureObservedAt: number[] = [];
  const runtime = new GatedRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      // The stalled Git call, not a running turn, is what this stop measures.
      supervisor: { shutdownWaitMs: 1 },
      workspaceManager: {
        gitExecutable: controlled.executable,
        gitTimeoutMs: { "repository-identity": 30_000 },
        gitTerminationGraceMs: 20,
        gitTerminationObservationMs: 40,
        gitFailureObserver: (failure) => {
          failures.push(failure);
          failureObservedAt.push(Date.now());
        },
      },
    },
  );
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    const assignment = await addReadyAssignment(
      service,
      projectId,
      profileId,
      "Bounded Git stop",
      [{ repositoryId: "repo", path: source }],
    );
    const binding = await service.taskWorkspace(assignment.taskId);
    const repositoryBinding = binding?.repositories[0];
    assert.ok(repositoryBinding);

    controlled.setRule({
      commandPrefix: "rev-parse --show-toplevel",
      behavior: "stall",
      holdPipe: true,
    });
    const pendingSubmission = service
      .submitTask(
        "stalled-workspace-validation",
        assignment.assignmentId,
        "Run only after workspace validation",
      )
      .then(
        (value) => ({ outcome: "resolved" as const, value }),
        (error: unknown) => ({ outcome: "rejected" as const, error }),
      );
    await waitForControlledGitReady(controlled);
    const readyEvent = controlled
      .events()
      .find(
        ({ event, operation }) =>
          event === "ready" && operation === "repository-identity",
      );
    assert.ok(readyEvent?.atMs !== undefined);

    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const stopStartedAt = Date.now();
    await service.stop();
    const stopSettledAt = Date.now();
    loopDelay.disable();
    const readyAt = readyEvent.atMs ?? stopStartedAt;
    const stopElapsedMs = stopSettledAt - readyAt;
    const cancelled = failures.filter(
      ({ operation, kind }) =>
        operation === "repository-identity" && kind === "cancelled",
    );
    const termEvent = controlled
      .events()
      .find(({ event, pid }) => event === "term" && pid === readyEvent.pid);
    // Emitted before any assertion, so a failing run still prints its timing.
    t.diagnostic(
      `bounded-git-stop-evidence ${JSON.stringify({
        readyToStopSettledMs: stopElapsedMs,
        readyToStopStartMs: stopStartedAt - readyAt,
        stopDurationMs: stopSettledAt - stopStartedAt,
        readyToTermMs:
          termEvent?.atMs === undefined ? null : termEvent.atMs - readyAt,
        maxLoopDelayMs: Math.round(loopDelay.max / 1e6),
        failureCount: failures.length,
        termGraceMs: 20,
        observationMs: 40,
        childExitObserved: cancelled[0]?.childExitObserved,
        childExitSignal: cancelled[0]?.childExitSignal,
      })}`,
    );
    // The strict bound protects the cancellation; the rest of the stop (store close,
    // loop teardown) varies with load, so it only has to finish well before a hang.
    const observedAt = failureObservedAt.at(-1);
    assert.ok(
      observedAt !== undefined && observedAt - readyAt < 20 + 40 + 700,
      `Git cancellation observed ${observedAt === undefined ? "never" : observedAt - readyAt}ms after ready`,
    );
    assert.ok(stopElapsedMs < 5_000, `stop settled in ${stopElapsedMs}ms`);
    const submission = await pendingSubmission;
    assert.equal(submission.outcome, "rejected");
    if (submission.outcome === "rejected")
      assert.match(
        String(submission.error),
        /Turn request is queued until its task workspace is ready/,
      );
    // The child's exit is reported only when the OS delivers it inside the 40 ms window,
    // which a loaded machine can miss. The escalation itself is asserted on the child: it
    // dies, whatever the window saw (the controlled Git ignores SIGTERM, so only SIGKILL
    // can end it).
    assert.deepEqual(
      cancelled.map(({ operation, kind }) => ({ operation, kind })),
      [{ operation: "repository-identity", kind: "cancelled" }],
    );
    assert.equal(
      cancelled[0]?.childExitSignal,
      cancelled[0]?.childExitObserved ? "SIGKILL" : null,
    );
    await waitForProcessGone(readyEvent.pid);

    const database = new DatabaseSync(join(root, "data", "standalone.sqlite"));
    const stored = database
      .prepare(
        "SELECT workspaceId, path, state, gitUncertain FROM task_workspace_bindings WHERE taskId = ?",
      )
      .get(assignment.taskId) as
      | {
          workspaceId: string;
          path: string;
          state: string;
          gitUncertain: number;
        }
      | undefined;
    database.close();
    assert.equal(stored?.workspaceId, binding?.workspaceId);
    assert.equal(stored?.path, binding?.path);
    assert.equal(stored?.state, "held");
    assert.equal(stored?.gitUncertain, 1);
    assert.equal(existsSync(repositoryBinding.workspacePath), true);
  } finally {
    try {
      await service.stop();
    } finally {
      try {
        await controlled.cleanup();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("lead bindings are task-scoped and enabled routing waits for an assignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-lead-binding-"));
  const dataDir = join(root, "data");
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const routedProjectId = randomUUID();
  const leadProjectId = randomUUID();
  const routedTaskId = randomUUID();
  const leadTaskIds: string[] = [randomUUID(), randomUUID()];
  const leadProfileId = randomUUID();
  const workerProfileId = randomUUID();
  const gate = deferred();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId: leadProfileId,
      name: "Lead",
      instructions: "coordinate",
      capabilities: "code",
    });
    execute({
      type: "profile.create",
      actor: "operator",
      profileId: workerProfileId,
      name: "Worker",
      instructions: "implement",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId: routedProjectId,
      name: "Routed project",
      leadProfileId,
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId: leadProjectId,
      name: "Lead project",
      leadProfileId,
    });
    for (const projectId of [routedProjectId, leadProjectId])
      execute({
        type: "project.configure",
        actor: "operator",
        projectId,
        expectedVersion: 1,
        paused: false,
      });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId: routedProjectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "route work",
      candidateProfileIds: [workerProfileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId: routedProjectId,
      taskId: routedTaskId,
      title: "Routed task",
      outcome: "Use deterministic routing",
      ready: false,
    });
    for (const taskId of leadTaskIds)
      execute({
        type: "task.create",
        actor: "operator",
        projectId: leadProjectId,
        taskId,
        title: "Lead task",
        outcome: "Ask the lead",
        ready: false,
      });
    await service.provisionTask(routedTaskId);
    for (const taskId of leadTaskIds) await service.provisionTask(taskId);
    let entered = 0;
    runtime.entered = () => entered++;
    runtime.release = gate.promise;
    const assignmentId = randomUUID();
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId: routedProjectId,
      taskId: routedTaskId,
      assignmentId,
      profileId: workerProfileId,
      brief: "Implement the routed task",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    for (const taskId of [routedTaskId, ...leadTaskIds])
      execute({
        type: "task.configure",
        actor: "operator",
        projectId: taskId === routedTaskId ? routedProjectId : leadProjectId,
        taskId,
        expectedVersion: 1,
        ready: true,
      });

    assert.equal(await waitUntil(() => entered === 3), true);
    const bindings = service.domain().leadBindings();
    assert.equal(bindings.length, 3);
    assert.equal(new Set(bindings.map((binding) => binding.taskId)).size, 3);
    const leadBindings = bindings.filter((binding) =>
      leadTaskIds.includes(String(binding.taskId)),
    );
    assert.equal(
      new Set(leadBindings.map((binding) => binding.assignmentId)).size,
      2,
    );
    assert.equal(service.domain().assignments(routedTaskId).length, 1);
    assert.notEqual(
      service.domain().assignment(assignmentId).id,
      bindings.find((binding) => binding.taskId === routedTaskId)?.assignmentId,
      "routed assignment and task-scoped lead binding must remain distinct",
    );
    const leadRequests = service
      .turnRequests()
      .filter((request) => leadTaskIds.includes(String(request.taskId)));
    assert.equal(leadRequests.length, 2);
    assert.deepEqual(
      new Set(leadRequests.map((request) => request.assignmentId)),
      new Set(leadBindings.map((binding) => binding.assignmentId)),
    );
    gate.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          3,
      ),
      true,
    );
    assert.equal(runtime.turns, 3);
  } finally {
    gate.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct and managed turns share one atomic provisional reservation ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-admission-ledger-"));
  const dataDir = join(root, "data");
  const firstDirect = join(root, "direct-one");
  const secondDirect = join(root, "direct-two");
  mkdirSync(firstDirect);
  mkdirSync(secondDirect);
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "use the pending assignment",
      candidateProfileIds: [profileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Managed task",
      outcome: "Run the assignment",
      ready: false,
    });
    await service.provisionTask(taskId);
    const release = deferred();
    let entered = 0;
    runtime.entered = () => entered++;
    runtime.release = release.promise;
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Managed work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    execute({
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    const directOne = service.submit("direct-one", "Direct one", firstDirect);
    const directTwo = service.submit("direct-two", "Direct two", secondDirect);
    assert.equal(await waitUntil(() => entered === 3), true);
    const db = (
      service as unknown as {
        db: { prepare(sql: string): { all(): unknown[] } };
      }
    ).db;
    const reservations = db
      .prepare(
        "SELECT workId, projectId FROM execution_capacity_reservations ORDER BY workId",
      )
      .all() as { workId: string; projectId: string | null }[];
    assert.equal(reservations.length, 3);
    assert.equal(new Set(reservations.map((row) => row.workId)).size, 3);
    assert.equal(
      reservations.find(
        (row) => row.workId === `assignment:${assignmentId}:initial`,
      )?.projectId,
      projectId,
    );
    assert.equal(
      reservations.filter((row) => row.projectId === null).length,
      2,
    );
    release.resolve();
    await Promise.all([directOne, directTwo]);
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          3,
      ),
      true,
    );
    assert.equal(runtime.turns, 3);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed writer admission rolls back the entire reservation transition", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-admission-rollback-"));
  const service = new StandaloneService(
    join(root, "data"),
    () => new GatedRuntime(),
  );
  const projectId = randomUUID();
  const taskId = randomUUID();
  const profileId = randomUUID();
  const assignmentId = randomUUID();
  const execute = (command: Record<string, unknown>) =>
    service.domain().execute({ key: randomUUID(), ...command } as never);
  try {
    await service.start();
    execute({
      type: "profile.create",
      actor: "operator",
      profileId,
      name: "Builder",
      instructions: "build",
      capabilities: "code",
    });
    execute({
      type: "project.create",
      actor: "operator",
      projectId,
      name: "Project",
      leadProfileId: profileId,
    });
    execute({
      type: "project.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
    execute({
      type: "routing.configure",
      actor: "operator",
      projectId,
      expectedVersion: 1,
      enabled: true,
      guidance: "route",
      candidateProfileIds: [profileId],
      credentialRef: "env:ROUTER",
    });
    execute({
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Task",
      outcome: "Deliver",
      ready: false,
    });
    await service.provisionTask(taskId);
    const db = (
      service as unknown as {
        db: {
          exec(sql: string): void;
          prepare(sql: string): { get(...args: unknown[]): { count: number } };
        };
      }
    ).db;
    db.exec(`CREATE TRIGGER fail_writer_admission BEFORE INSERT ON task_writer_admissions
      BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END`);
    execute({
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Work",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    execute({
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    assert.equal(
      await waitUntil(() =>
        service
          .turnRequests()
          .some(
            (request) =>
              request.workId === `assignment:${assignmentId}:initial` &&
              request.state === "held",
          ),
      ),
      true,
    );
    assert.equal(
      service
        .list()
        .find((item) => item.workId === `assignment:${assignmentId}:initial`)
        ?.state,
      "held",
    );
    assert.equal(service.domain().assignment(assignmentId).state, "pending");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM task_writer_admissions").get()
        ?.count,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM execution_capacity_reservations",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      service
        .turnRequests()
        .find(
          (request) => request.workId === `assignment:${assignmentId}:initial`,
        )?.state,
      "held",
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("default capacity counts direct and managed turns, holds one of six slots for leads and has no project default", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-capacity-defaults-"));
  const dataDir = join(root, "data");
  const directOne = join(root, "direct-one");
  const directTwo = join(root, "direct-two");
  mkdirSync(directOne);
  mkdirSync(directTwo);
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const active = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = active.promise;
  let direct: Promise<unknown>[] = [];
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectA = await addProject(service, profileId);
    const projectB = await addProject(service, profileId);
    direct = [
      service.submit("direct-one", "Direct one", directOne),
      service.submit("direct-two", "Direct two", directTwo),
    ];
    assert.equal(await waitUntil(() => entered === 2), true);

    const managedA = await Promise.all(
      ["A one", "A two", "A three"].map((brief) =>
        addReadyAssignment(service, projectA, profileId, brief),
      ),
    );
    const managedB = await addReadyAssignment(
      service,
      projectB,
      profileId,
      "B one",
    );
    assert.equal(
      await waitUntil(() => entered >= 5),
      true,
      JSON.stringify({
        entered,
        turns: runtime.turns,
        requests: service.turnRequests(),
        intents: service.list(),
      }),
    );
    assert.equal(
      await waitUntil(
        () => stateOf(service, managedB.workId).state === "capacity-waiting",
      ),
      true,
      JSON.stringify(service.list()),
    );
    assert.equal(runtime.turns, 5);
    // No implicit project limit: all three of project A's turns run.
    for (const assignment of managedA)
      assert.equal(stateOf(service, assignment.workId).state, "running");
    assert.deepEqual(stateOf(service, managedB.workId), {
      state: "capacity-waiting",
      reason: "Capacity waiting: held for lead turns (1)",
    });
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
        managedB.workId,
      ),
      0,
    );
    const usage = capacityLimits(service).currentUsage;
    assert.equal(usage.global, 5);
    assert.equal(usage.lead, 0);
    assert.equal(usage.projects[projectA], 3);

    // The held slot admits a lead turn while every general slot is in use.
    const leadTask = await addReadyLeadTask(service, projectB, "Lead turn");
    assert.equal(await waitUntil(() => entered >= 6), true);
    assert.equal(
      stateOf(service, leadWork(service, leadTask)).state,
      "running",
    );
    assert.equal(capacityLimits(service).currentUsage.lead, 1);
    assert.equal(stateOf(service, managedB.workId).state, "capacity-waiting");
  } finally {
    active.resolve();
    await Promise.all(direct);
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lowered capacity preserves active turns and waits for both limits to fit", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-capacity-lowering-"));
  const dataDir = join(root, "data");
  const runtime = new GatedRuntime();
  let service = new StandaloneService(dataDir, () => runtime);
  const active = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = active.promise;
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    await configureCapacity(service, 4, { [projectId]: 3 });
    const existing = await Promise.all(
      ["Existing one", "Existing two", "Existing three"].map((brief) =>
        addReadyAssignment(service, projectId, profileId, brief),
      ),
    );
    assert.equal(await waitUntil(() => entered === 3, 30000), true);

    await configureCapacity(service, 2, { [projectId]: 1 }, 1, {
      [profileId]: 1,
    });
    assert.equal(runtime.turns, 3);
    for (const item of existing)
      assert.equal(
        service.list().find((intent) => intent.workId === item.workId)?.state,
        "running",
      );
    const atLowering = capacityLimits(service);
    assert.equal(atLowering.globalLimit, 2);
    assert.equal(atLowering.projectOverrides[projectId], 1);
    assert.equal(atLowering.currentUsage.global, 3);
    assert.equal(atLowering.currentUsage.projects[projectId], 3);
    const waiting = await addReadyAssignment(
      service,
      projectId,
      profileId,
      "After lowering",
    );
    assert.equal(
      await waitUntil(
        () =>
          service.list().find((item) => item.workId === waiting.workId)
            ?.state === "capacity-waiting",
        30000,
      ),
      true,
      JSON.stringify({
        requests: service.turnRequests(),
        intents: service.list(),
      }),
    );
    assert.equal(runtime.turns, 3);
    assert.equal(
      capacityLimits(service).currentUsage.global,
      3,
      "lowering must not release reservations for admitted work",
    );

    active.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          4,
        30000,
      ),
      true,
    );
    assert.equal(runtime.turns, 4);
    await service.stop();

    const restartedRuntime = new GatedRuntime();
    service = new StandaloneService(dataDir, () => restartedRuntime);
    await service.start();
    const restored = capacityLimits(service);
    assert.equal(restored.globalLimit, 2);
    assert.equal(restored.minimumLeadSlots, 1);
    assert.deepEqual(restored.agentOverrides, { [profileId]: 1 });
    assert.equal(restored.projectOverrides[projectId], 1);
    assert.equal(restored.currentUsage.global, 0);
    assert.equal(restartedRuntime.turns, 0);
  } finally {
    active.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A started service whose turns all block until `release` resolves. */
async function capacityWorld(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const runtime = new GatedRuntime();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  const active = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = active.promise;
  await service.start();
  return {
    root,
    runtime,
    service,
    entered: () => entered,
    async close() {
      active.resolve();
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    },
    release: () => active.resolve(),
  };
}

async function waitForState(
  service: StandaloneService,
  workId: string | undefined,
  state: string,
  reason?: string,
) {
  assert.equal(
    await waitUntil(() => {
      const current = stateOf(service, workId);
      return (
        current.state === state &&
        (reason === undefined || current.reason === reason)
      );
    }, 30000),
    true,
    JSON.stringify({ workId, intents: service.list() }),
  );
}

test("held lead slots admit leads, are never lent to workers, and lead turns also use free general slots", async () => {
  const w = await capacityWorld("cab-capacity-lead-slots-");
  try {
    const profileId = await addProfile(w.service);
    const projectId = await addProject(w.service, profileId);
    await configureCapacity(w.service, 3, {}, 1);
    const workers = [];
    for (const brief of ["Worker one", "Worker two", "Worker three"])
      workers.push(
        await addReadyAssignment(w.service, projectId, profileId, brief),
      );
    await waitForState(
      w.service,
      workers[2]?.workId,
      "capacity-waiting",
      "Capacity waiting: held for lead turns (1)",
    );
    assert.equal(await waitUntil(() => w.runtime.turns === 2), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(w.runtime.turns, 2, "the free held slot is not lent");

    const first = await addReadyLeadTask(w.service, projectId, "Lead one");
    await waitForState(w.service, leadWork(w.service, first), "running");
    assert.equal(await waitUntil(() => w.runtime.turns === 3), true);
    assert.equal(
      stateOf(w.service, workers[2]?.workId).state,
      "capacity-waiting",
    );
    const second = await addReadyLeadTask(w.service, projectId, "Lead two");
    await waitForState(
      w.service,
      leadWork(w.service, second),
      "capacity-waiting",
      "Capacity waiting: global active-turn limit (3)",
    );
  } finally {
    await w.close();
  }
});

test("a lead turn takes a free general slot once the held slots are used", async () => {
  const w = await capacityWorld("cab-capacity-lead-general-");
  try {
    const profileId = await addProfile(w.service);
    const projectId = await addProject(w.service, profileId);
    await configureCapacity(w.service, 3, {}, 1);
    const leads = [];
    for (const title of ["Lead one", "Lead two"])
      leads.push(await addReadyLeadTask(w.service, projectId, title));
    for (const task of leads)
      await waitForState(w.service, leadWork(w.service, task), "running");
    const worker = await addReadyAssignment(
      w.service,
      projectId,
      profileId,
      "Worker",
    );
    await waitForState(w.service, worker.workId, "running");
    assert.equal(w.service.capacityLimits().currentUsage.lead, 2);
    assert.equal(w.service.capacityLimits().currentUsage.global, 3);
  } finally {
    await w.close();
  }
});

test("zero minimum lead slots is a single shared pool", async () => {
  const w = await capacityWorld("cab-capacity-shared-pool-");
  try {
    const profileId = await addProfile(w.service);
    const projectId = await addProject(w.service, profileId);
    await configureCapacity(w.service, 3, {}, 0);
    const workers = [];
    for (const brief of ["One", "Two", "Three", "Four"])
      workers.push(
        await addReadyAssignment(w.service, projectId, profileId, brief),
      );
    for (const worker of workers.slice(0, 3))
      await waitForState(w.service, worker.workId, "running");
    await waitForState(
      w.service,
      workers[3]?.workId,
      "capacity-waiting",
      "Capacity waiting: global active-turn limit (3)",
    );
  } finally {
    await w.close();
  }
});

test("an agent cap holds only that agent's turns, across projects, without blocking later work", async () => {
  const w = await capacityWorld("cab-capacity-agent-cap-");
  try {
    const capped = await addProfile(w.service);
    const other = await addProfile(w.service);
    const projectA = await addProject(w.service, capped);
    const projectB = await addProject(w.service, capped);
    const projectC = await addProject(w.service, other);
    await configureCapacity(w.service, 6, {}, 0, { [capped]: 1 });
    const first = await addReadyAssignment(w.service, projectA, capped, "A");
    await waitForState(w.service, first.workId, "running");
    const held = await addReadyAssignment(w.service, projectB, capped, "B");
    const later = await addReadyAssignment(w.service, projectC, other, "C");
    await waitForState(w.service, later.workId, "running");
    await waitForState(
      w.service,
      held.workId,
      "capacity-waiting",
      "Capacity waiting: agent active-turn limit (1)",
    );
    // The capped agent's lead turns count too.
    const lead = await addReadyLeadTask(w.service, projectA, "Lead");
    await waitForState(
      w.service,
      leadWork(w.service, lead),
      "capacity-waiting",
      "Capacity waiting: agent active-turn limit (1)",
    );
    assert.equal(w.service.capacityLimits().currentUsage.agents[capped], 1);
  } finally {
    await w.close();
  }
});

test("a project cap counts only non-lead turns, so workers never block the project's lead", async () => {
  const w = await capacityWorld("cab-capacity-project-cap-");
  try {
    const profileId = await addProfile(w.service);
    const projectId = await addProject(w.service, profileId);
    await configureCapacity(w.service, 6, { [projectId]: 1 }, 0);
    const first = await addReadyAssignment(
      w.service,
      projectId,
      profileId,
      "One",
    );
    await waitForState(w.service, first.workId, "running");
    const second = await addReadyAssignment(
      w.service,
      projectId,
      profileId,
      "Two",
    );
    await waitForState(
      w.service,
      second.workId,
      "capacity-waiting",
      "Capacity waiting: project active-turn limit (1)",
    );
    const lead = await addReadyLeadTask(w.service, projectId, "Lead");
    await waitForState(w.service, leadWork(w.service, lead), "running");
    const usage = w.service.capacityLimits().currentUsage;
    assert.equal(usage.projects[projectId], 1);
    assert.equal(usage.lead, 1);
  } finally {
    await w.close();
  }
});

test("an upgraded store keeps its global cap and overrides, classifies held reservations and drops the project default", async () => {
  const w = await capacityWorld("cab-capacity-upgrade-");
  const dataDir = join(w.root, "data");
  let service = w.service;
  try {
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    const other = await addProject(service, profileId);
    await configureCapacity(service, 4, { [projectId]: 3 }, 0);
    const lead = await addReadyLeadTask(service, projectId, "Lead");
    const leadWorkId = leadWork(service, lead);
    await waitForState(service, leadWorkId, "running");
    w.release();
    await waitForState(service, leadWorkId, "completed");
    await service.stop();
    // Rebuild the capacity tables as they were before lead slots and agent caps.
    const db = new DatabaseSync(join(dataDir, "standalone.sqlite"));
    db.exec(`
      CREATE TABLE legacy_limits (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        globalLimit INTEGER NOT NULL CHECK(globalLimit > 0));
      INSERT INTO legacy_limits SELECT singleton, globalLimit FROM scheduler_capacity_limits;
      DROP TABLE scheduler_capacity_limits;
      ALTER TABLE legacy_limits RENAME TO scheduler_capacity_limits;
      CREATE TABLE legacy_reservations (workId TEXT PRIMARY KEY REFERENCES execution_intents(workId),
        projectId TEXT, admittedAt INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO legacy_reservations SELECT workId, projectId, admittedAt FROM execution_capacity_reservations;
      -- A lead turn still holding capacity when the store was upgraded.
      INSERT INTO legacy_reservations (workId, projectId) VALUES ('${leadWorkId}', '${projectId}');
      DROP TABLE execution_capacity_reservations;
      ALTER TABLE legacy_reservations RENAME TO execution_capacity_reservations;
      DROP TABLE scheduler_agent_capacity_limits;`);
    db.close();
    const runtime = new GatedRuntime();
    service = new StandaloneService(dataDir, () => runtime);
    await service.start();
    const upgraded = service.capacityLimits();
    assert.equal(upgraded.globalLimit, 4);
    assert.equal(upgraded.minimumLeadSlots, 1);
    assert.deepEqual(upgraded.projectOverrides, { [projectId]: 3 });
    assert.deepEqual(upgraded.agentOverrides, {});
    assert.equal(
      upgraded.currentUsage.lead,
      1,
      "the held lead turn stays a lead turn",
    );
    assert.equal(upgraded.currentUsage.agents[profileId], 1);
    assert.equal(upgraded.currentUsage.projects[projectId] ?? 0, 0);
    assert.equal(other in upgraded.projectOverrides, false);
  } finally {
    await service.stop();
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("resumed work is admitted before unstarted work, oldest first within each group", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-admission-order-"));
  const runtime = new GatedRuntime();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  const gates: Array<() => void> = [];
  // Each turn blocks on its own gate, so turns finish one at a time.
  runtime.entered = () => {
    const gate = deferred();
    gates.push(gate.resolve);
    runtime.release = gate.promise;
  };
  const workspaces = ["earlier", "blocker", "new-one", "new-two"].map(
    (name) => {
      const path = join(root, name);
      mkdirSync(path);
      return path;
    },
  );
  const [earlierSpace, blockerSpace, newOne, newTwo] = workspaces as [
    string,
    string,
    string,
    string,
  ];
  const finishLatest = async (count: number) => {
    assert.equal(await waitUntil(() => gates.length === count, 30000), true);
    gates[count - 1]?.();
  };
  const pending: Promise<unknown>[] = [];
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    await configureCapacity(service, 1, {}, 0);
    const started = await addReadyAssignment(
      service,
      projectId,
      profileId,
      "Started assignment",
    );
    await finishLatest(1);
    await waitForState(service, started.workId, "completed");
    pending.push(service.submit("earlier", "Earlier direct", earlierSpace));
    await finishLatest(2);
    await waitForState(service, "earlier", "completed");

    pending.push(service.submit("blocker", "Blocker direct", blockerSpace));
    assert.equal(await waitUntil(() => gates.length === 3, 30000), true);
    const unstarted = await addReadyAssignment(
      service,
      projectId,
      profileId,
      "Unstarted assignment",
    );
    pending.push(service.submit("new-one", "New direct one", newOne));
    pending.push(service.submit("new-two", "New direct two", newTwo));
    await waitForState(service, unstarted.workId, "capacity-waiting");
    await service.submitTask(
      "assignment-resume",
      started.assignmentId,
      "Resumed assignment",
      started.workId,
    );
    // A worker newly delegated on a task underway is resumed work too.
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId: started.taskId,
      assignmentId: randomUUID(),
      profileId,
      brief: "Delegated assignment",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    pending.push(
      service.submit(
        "direct-resume",
        "Resumed direct",
        earlierSpace,
        "earlier",
      ),
    );
    await waitForState(service, "direct-resume", "capacity-waiting");

    for (let turn = 3; turn <= 8; turn++) await finishLatest(turn);
    await finishLatest(9);
    const order = [
      "Resumed assignment",
      "Delegated assignment",
      "Resumed direct",
      "Unstarted assignment",
      "New direct one",
      "New direct two",
    ].map((marker) =>
      runtime.prompts.findIndex((prompt) => prompt.startsWith(marker)),
    );
    assert.deepEqual(
      order,
      [3, 4, 5, 6, 7, 8],
      JSON.stringify(runtime.prompts),
    );
  } finally {
    for (const release of gates) release();
    await Promise.allSettled(pending);
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity-waiting direct work owns neither ledger and wakes once on the same workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-capacity-waiting-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const runtime = new GatedRuntime();
  const service = new StandaloneService(dataDir, () => runtime);
  const firstGate = deferred();
  const secondGate = deferred();
  const thirdGate = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = firstGate.promise;
  let first: Promise<unknown> | undefined;
  try {
    await service.start();
    await configureCapacity(service, 1);
    first = service.submit("first", "First", workspace);
    assert.equal(await waitUntil(() => entered === 1), true);

    runtime.release = secondGate.promise;
    const second = await service.submit("second", "Second", workspace);
    const third = await service.submit("third", "Third", workspace);
    assert.equal(second.state, "capacity-waiting");
    assert.match(
      second.reason ?? "",
      /Capacity waiting: global active-turn limit/,
    );
    assert.equal(third.state, "capacity-waiting");
    assert.equal(runtime.turns, 1);
    for (const workId of ["second", "third"]) {
      assert.equal(
        countRows(
          service,
          "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
          workId,
        ),
        0,
      );
      assert.equal(
        countRows(
          service,
          "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
          workId,
        ),
        0,
      );
    }

    runtime.release = secondGate.promise;
    firstGate.resolve();
    await first;
    assert.equal(await waitUntil(() => entered === 2), true);
    assert.equal(runtime.prompts[1], "Second");
    runtime.release = thirdGate.promise;
    secondGate.resolve();
    assert.equal(await waitUntil(() => entered === 3), true);
    assert.equal(runtime.prompts[2], "Third");
    thirdGate.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().filter((item) => item.state === "completed").length ===
          3,
      ),
      true,
    );
    assert.deepEqual(runtime.prompts, ["First", "Second", "Third"]);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    thirdGate.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity one yields a completed requester to its child and resumes it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-capacity-yielding-"));
  const runtime = new GatedRuntime();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  const parentGate = deferred();
  const childGate = deferred();
  const continuationGate = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = parentGate.promise;
  try {
    await service.start();
    const profileId = await addProfile(service);
    const projectId = await addProject(service, profileId);
    await configureCapacity(service, 1, { [projectId]: 1 });
    const taskId = randomUUID();
    const parentAssignmentId = randomUUID();
    execute(service, {
      type: "task.create",
      actor: "operator",
      projectId,
      taskId,
      title: "Parent task",
      outcome: "Coordinate the child",
      ready: false,
    });
    await service.provisionTask(taskId);
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId: parentAssignmentId,
      profileId,
      brief: "Parent turn",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    execute(service, {
      type: "task.configure",
      actor: "operator",
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
    const parentWorkId = `assignment:${parentAssignmentId}:initial`;
    assert.equal(await waitUntil(() => entered === 1), true);

    const childAssignmentId = randomUUID();
    execute(service, {
      type: "assignment.create",
      actor: "agent",
      projectId,
      taskId,
      assignmentId: childAssignmentId,
      profileId,
      brief: "Child turn",
      resultDestination: `requester:${parentAssignmentId}`,
      requesterAssignmentId: parentAssignmentId,
    });
    const childWorkId = `assignment:${childAssignmentId}:initial`;
    assert.equal(
      await waitUntil(() =>
        service
          .turnRequests()
          .some((request) => request.workId === childWorkId),
      ),
      true,
    );
    assert.equal(runtime.turns, 1);
    assert.equal(
      service.domain().assignment(childAssignmentId).state,
      "pending",
    );
    assert.equal(
      service.recordTaskResult(parentWorkId, "early child result"),
      false,
    );
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        childWorkId,
      ),
      0,
    );

    runtime.release = childGate.promise;
    parentGate.resolve();
    assert.equal(await waitUntil(() => entered === 2), true);
    assert.equal(
      runtime.prompts[0]?.split("\n\nAssignment role:")[0],
      "Parent turn",
    );
    assert.equal(
      runtime.prompts[1]?.split("\n\nAssignment role:")[0],
      "Child turn",
    );
    assert.match(runtime.prompts[0] ?? "", /Assignment role: project assignee/);
    assert.match(runtime.prompts[1] ?? "", /Assignment role: project assignee/);
    assert.equal(
      service.list().find((intent) => intent.workId === parentWorkId)?.state,
      "completed",
    );

    const followUpWorkId = "parent-continuation";
    const waitingParent = await service.submitTask(
      followUpWorkId,
      parentAssignmentId,
      "Parent continuation",
      parentWorkId,
    );
    assert.equal(waitingParent.state, "capacity-waiting");
    assert.equal(service.recordTaskResult(followUpWorkId, "early"), false);
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM task_writer_admissions WHERE workId = ?",
        followUpWorkId,
      ),
      0,
    );
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        followUpWorkId,
      ),
      0,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
    assert.equal(runtime.turns, 2);

    runtime.release = continuationGate.promise;
    childGate.resolve();
    assert.equal(await waitUntil(() => entered === 3), true);
    assert.deepEqual(
      runtime.prompts.map((prompt) => prompt.split("\n\nAssignment role:")[0]),
      ["Parent turn", "Child turn", "Parent continuation"],
    );
    const wake = (
      service as unknown as { wakeScheduler(): Promise<void> }
    ).wakeScheduler.bind(service);
    await wake();
    await wake();
    assert.equal(runtime.turns, 3);
    continuationGate.resolve();
    assert.equal(
      await waitUntil(
        () =>
          service.list().find((intent) => intent.workId === followUpWorkId)
            ?.state === "completed",
      ),
      true,
    );
    assert.equal(runtime.turns, 3);
    assert.equal(
      service
        .turnRequests()
        .filter((request) => request.workId === followUpWorkId).length,
      1,
    );
  } finally {
    parentGate.resolve();
    childGate.resolve();
    continuationGate.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

class CrashableRuntime extends GatedRuntime {
  private failureListener: ((error: Error) => void) | undefined;
  private lost: ((error: Error) => void) | undefined;
  onFailure(listener: (error: Error) => void) {
    this.failureListener = listener;
  }
  override async waitForTurn(threadId: string, turnId: string) {
    const lost = new Promise<never>((_, reject) => {
      this.lost = reject;
    });
    return await Promise.race([super.waitForTurn(threadId, turnId), lost]);
  }
  /** Mirrors CodexRuntime.fail: failure listeners first, then pending waits reject. */
  crash() {
    const error = new Error("Runtime lost");
    this.failureListener?.(error);
    this.lost?.(error);
  }
}

test("runtime failure holds the running turn, blocks admission and keeps queued work queued", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-runtime-failure-"));
  const runningWorkspace = join(root, "running");
  const queuedWorkspace = join(root, "queued");
  mkdirSync(runningWorkspace);
  mkdirSync(queuedWorkspace);
  const runtime = new CrashableRuntime();
  const service = new StandaloneService(join(root, "data"), () => runtime);
  const gate = deferred();
  let entered = 0;
  runtime.entered = () => entered++;
  runtime.release = gate.promise;
  try {
    await service.start();
    assert.deepEqual(service.runtimeStatus(), { state: "available" });
    const first = service.submit("running", "Running", runningWorkspace);
    assert.equal(await waitUntil(() => entered === 1), true);

    const before = Date.now();
    runtime.crash();
    // A wrongly admitted turn would now complete instead of hanging the test.
    gate.resolve();
    assert.equal((await first).state, "held");
    const status = service.runtimeStatus();
    assert.equal(status.state, "unavailable");
    assert.ok(status.state === "unavailable" && status.since >= before);

    const queued = await service.submit("queued", "Queued", queuedWorkspace);
    assert.equal(queued.state, "ready");
    assert.match(queued.reason ?? "", /Codex runtime unavailable/);
    const request = service
      .turnRequests()
      .find((item) => item.workId === "queued");
    assert.equal(request?.state, "queued");
    assert.match(request?.reason ?? "", /Codex runtime unavailable/);
    assert.equal(runtime.turns, 1);
    assert.equal(
      service.list().filter((intent) => intent.state === "held").length,
      1,
    );
    assert.equal(
      countRows(
        service,
        "SELECT COUNT(*) AS count FROM execution_capacity_reservations WHERE workId = ?",
        "queued",
      ),
      0,
    );
    await service.stop();
    await service.start();
    assert.deepEqual(service.runtimeStatus(), { state: "available" });
  } finally {
    gate.resolve();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
