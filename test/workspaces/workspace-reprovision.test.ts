import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import type {
  Runtime,
  RuntimeToolCall,
  RuntimeToolResult,
} from "../../src/standalone/codex.js";
import {
  type RuntimeSpawnContext,
  StandaloneService,
} from "../../src/standalone/service.js";
import { taskScratchPath } from "../../src/standalone/workspaces.js";
import { startedOf } from "../fixtures/service-internals.js";
import { tmpdir } from "../fixtures/temp.js";

/** A Codex-shaped fake that records each thread start, resume and turn with its workspace. */
class ResumeRuntime implements Runtime {
  readonly harness = "codex" as const;
  readonly starts: string[] = [];
  readonly resumes: Array<{
    threadId: string;
    settings: unknown;
    cwd: string;
  }> = [];
  readonly turns: Array<{ threadId: string; cwd: string }> = [];
  safety: RuntimeSpawnContext["safety"] | undefined;
  private tool:
    | ((call: RuntimeToolCall) => Promise<RuntimeToolResult>)
    | undefined;
  onToolCall(listener: (call: RuntimeToolCall) => Promise<RuntimeToolResult>) {
    this.tool = listener;
  }
  currentUserInputGeneration() {
    return "resume-fixture";
  }
  async start() {}
  async stop() {}
  async startThread(workspace: string) {
    this.starts.push(workspace);
    return `thread-${this.starts.length}`;
  }
  async resumeThread(
    threadId: string,
    _tools: unknown,
    settings: unknown,
    cwd: string,
  ) {
    this.resumes.push({ threadId, settings, cwd });
  }
  async startTurn(threadId: string, cwd: string) {
    this.turns.push({ threadId, cwd });
    return `turn-${this.turns.length}`;
  }
  async interruptTurn() {}
  async waitForTurn(threadId: string, turnId: string) {
    const result = await this.tool?.({
      threadId,
      turnId,
      callId: randomUUID(),
      tool: "cab_report_result",
      arguments: { summary: "fixture result" },
    });
    assert.equal(result?.success, true, result?.text ?? "Missing report");
    this.safety?.recordTerminal({
      threadId,
      turnId,
      status: "completed",
      runtimeGeneration: "resume-fixture",
    });
    return "completed" as const;
  }
  onUnexpectedRequest() {}
}

async function waitUntil(predicate: () => boolean, describe: () => unknown) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out: ${JSON.stringify(describe())}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A started service whose Ready task ran one turn and then had its workspace removed. */
async function removedTask(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cab-reprovision-service-"));
  const runtime = new ResumeRuntime();
  const service = new StandaloneService(
    join(root, "data"),
    (context) => {
      runtime.safety = context.safety;
      return runtime;
    },
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  t.after(async () => {
    await service.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const execute = (command: Record<string, unknown>) =>
    service
      .domain()
      .execute({ key: randomUUID(), actor: "operator", ...command } as never);
  await service.start();
  const lead = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  execute({
    type: "profile.create",
    profileId: lead,
    name: "Lead",
    instructions: "lead",
    capabilities: "code",
    runtime: { harness: "codex" },
  });
  execute({
    type: "project.create",
    projectId,
    name: "R",
    leadProfileId: lead,
  });
  execute({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  execute({
    type: "task.create",
    projectId,
    taskId,
    title: "Reprovision",
    outcome: "Resume after removal",
    ready: true,
  });
  const describe = () => [
    service.list().map((i) => [i.workId, i.state, i.reason]),
    startedOf(service)
      .schedulerStore.list()
      .map((r) => [r.workId, r.state, r.reason]),
  ];
  await waitUntil(
    () => service.list().some((i) => i.state === "completed"),
    describe,
  );
  const old = (await service.taskWorkspace(taskId))!;
  assert.equal(runtime.turns[0]?.cwd, old.path);
  const configure = (change: Record<string, unknown>) =>
    execute({
      type: "task.configure",
      projectId,
      taskId,
      expectedVersion: Number(service.domain().task(taskId).version),
      ...change,
    });
  configure({ state: "done" });
  const removed = await service.removeTaskWorkspace(taskId, "manual");
  assert.equal(removed.outcome, "cleaned", JSON.stringify(removed));
  assert.equal(existsSync(old.path), false);
  const assignmentId =
    service.recoveryForTask(taskId)[0]?.binding?.assignmentId;
  assert.ok(assignmentId);
  const message = () =>
    service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId,
      recipientAssignmentId: assignmentId,
      expectedAssignmentVersion: Number(
        service.domain().assignment(assignmentId).version,
      ),
      message: "Continue",
    });
  const lifecycle = new WorkspaceLifecycleStore(
    // biome-ignore lint/complexity/useLiteralKeys: the service's own database
    service["cache"]!,
  );
  const pause = (paused: boolean) =>
    execute({
      type: "project.configure",
      projectId,
      expectedVersion: Number(service.domain().project(projectId).version),
      paused,
    });
  return {
    service,
    runtime,
    taskId,
    pause,
    old,
    describe,
    configure,
    message,
    lifecycle,
  };
}

test("a turn after removal resumes the same conversation in one new workspace", async (t) => {
  const {
    service,
    runtime,
    taskId,
    old,
    describe,
    configure,
    message,
    lifecycle,
  } = await removedTask(t);
  configure({ state: "open" });
  // Two manual provisions race the turn's admission; all three see one new workspace.
  const [first, second] = await Promise.all([
    service.provisionTask(taskId),
    service.provisionTask(taskId),
    message(),
  ]);
  await waitUntil(
    () => service.list().filter((i) => i.state === "completed").length === 2,
    describe,
  );
  const current = (await service.taskWorkspace(taskId))!;
  assert.equal(first.workspaceId, current.workspaceId);
  assert.equal(second.workspaceId, current.workspaceId);
  assert.notEqual(current.workspaceId, old.workspaceId);
  assert.equal(lifecycle.forTask(taskId).length, 2);
  assert.ok(lifecycle.removal(old));

  // The conversation is resumed, not replaced: one thread, moved to the new cwd and scratch.
  assert.equal(runtime.starts.length, 1);
  assert.equal(runtime.resumes.length, 1);
  assert.equal(runtime.resumes[0]?.threadId, "thread-1");
  assert.equal(runtime.resumes[0]?.cwd, current.path);
  assert.equal(
    (runtime.resumes[0]!.settings as { scratchDirectory?: string })
      .scratchDirectory,
    taskScratchPath(current.path),
  );
  assert.deepEqual(runtime.turns[1], {
    threadId: "thread-1",
    cwd: current.path,
  });
  assert.equal(service.taskHold(taskId), undefined);
});

test("a turn admission refuses creates no workspace, and the removed one stays archived", async (t) => {
  const w = await removedTask(t);
  const [initial] = w.service.list();
  w.configure({ state: "open" });
  // Queued while paused, then made stale by a task edit before it is attempted.
  w.pause(true);
  await w.message();
  const scheduler = startedOf(w.service).schedulerStore;
  const pending = () =>
    scheduler.list().find((r) => r.workId !== initial?.workId);
  assert.ok(pending());
  w.configure({ title: "Edited after the turn was queued" });
  w.pause(false);
  await waitUntil(() => !!pending()?.reason, w.describe);
  assert.equal(pending()?.state, "held");
  assert.match(pending()?.reason ?? "", /older task or assignment revisions/);
  const kept = (await w.service.taskWorkspace(w.taskId))!;
  assert.equal(kept.state, "archived");
  assert.equal(kept.workspaceId, w.old.workspaceId);
  assert.equal(w.lifecycle.forTask(w.taskId).length, 1);
  assert.equal(w.runtime.resumes.length, 0);
});

test("a request that recorded the removed workspace runs in its replacement", async (t) => {
  const w = await removedTask(t);
  const [initial] = w.service.list();
  w.configure({ state: "open" });
  w.pause(true);
  await w.message();
  const scheduler = startedOf(w.service).schedulerStore;
  const workId = scheduler
    .list()
    .find((r) => r.workId !== initial?.workId)!.workId;
  // As a request first attempted before the removal would have recorded it.
  // biome-ignore lint/complexity/useLiteralKeys: the service's own database
  w.service["cache"]!.prepare(
    "UPDATE turn_requests SET workspace=? WHERE workId=?",
  ).run(w.old.path, workId);
  w.pause(false);
  await waitUntil(
    () => w.service.list().filter((i) => i.state === "completed").length === 2,
    w.describe,
  );
  const current = (await w.service.taskWorkspace(w.taskId))!;
  assert.notEqual(current.workspaceId, w.old.workspaceId);
  assert.equal(scheduler.byWorkId(workId).workspace, current.path);
  assert.equal(w.runtime.resumes[0]?.cwd, current.path);
  assert.equal(w.runtime.starts.length, 1);
});
