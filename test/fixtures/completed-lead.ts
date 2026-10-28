import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import type { createOperatorFixture } from "./operator-web.js";
import { seedReviewTask } from "./task-review.js";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

export async function until(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

export function configure(f: Fixture, projectId: string, paused: boolean) {
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    paused,
  });
}

/** Runs the lead's first turn through the real scheduler until it reports a result. */
export async function completedLead(f: Fixture, name: string) {
  const task = await seedReviewTask(f, name);
  const domain = f.service.domain();
  configure(f, task.projectId, false);
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(domain.task(task.taskId).version),
    ready: true,
  });
  await until(() => f.runtime.hasPending(1), "turn 1");
  const first = f.service.list().find((work) => work.state === "running");
  assert.ok(first?.threadId && first.turnId);
  const workspace = await f.service.taskWorkspace(task.taskId);
  assert.ok(workspace?.state === "ready");
  await writeFile(join(workspace.path, "lead.txt"), "lead output\n");
  const reported = await f.runtime.callTool({
    threadId: first.threadId,
    turnId: first.turnId,
    callId: randomUUID(),
    tool: "cab_report_result",
    arguments: { summary: "Lead finished the first pass" },
  });
  assert.equal(reported.success, true, reported.text);
  f.runtime.complete(1);
  await until(
    () =>
      domain.assignment(task.assignmentId).state === "completed" &&
      !f.service.list().some((work) => work.state === "running"),
    "lead completion",
  );
  return { task, first, api: new OperatorApi(f.service, []) };
}
