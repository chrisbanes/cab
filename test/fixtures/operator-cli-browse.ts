import { randomUUID } from "node:crypto";
import type { startCliService } from "./operator-cli.js";
import { seedReviewTask } from "./task-review.js";

type Service = Awaited<ReturnType<typeof startCliService>>;

/**
 * Two projects with distinct leads and a shared profile, 120 open tasks in Alpha,
 * a "Shared title" task in each project, one done and one cancelled task, and
 * five messages on Beta's task. `startCliService` already holds one open task.
 */
export async function seedBrowseWorkspace(s: Service) {
  const d = s.f.service.domain();
  const profile = (name: string, runtime?: Record<string, unknown>) => {
    const profileId = randomUUID();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name,
      instructions: `${name} instructions`,
      capabilities: "general",
      ...(runtime ? { runtime } : {}),
    } as Parameters<typeof d.execute>[0]);
    return profileId;
  };
  const alphaLeadId = profile("Alpha lead", {
    harness: "claude",
    model: "opus",
    reasoningEffort: "high",
  });
  const sharedProfileId = profile("Shared reviewer");
  const alphaId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: alphaId,
    name: "Alpha",
    leadProfileId: alphaLeadId,
  });
  const create = (projectId: string, title: string) => {
    const taskId = randomUUID();
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title,
      outcome: `Outcome of ${title}`,
      ready: false,
    });
    return taskId;
  };
  const settle = (
    projectId: string,
    taskId: string,
    state: "done" | "cancelled",
  ) =>
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(d.task(taskId).version),
      state,
    });
  const alphaTaskIds = Array.from({ length: 119 }, (_, i) =>
    create(alphaId, `Alpha work ${String(i).padStart(3, "0")}`),
  );
  const alphaShared = create(alphaId, "Shared title");
  // Beta comes from the review seed: its own lead profile, a lead assignment and results.
  const beta = await seedReviewTask(s.f, "Beta", "Shared title");
  const result = beta.result("Searchable needle result").resultId;
  const done = create(alphaId, "Finished work");
  settle(alphaId, done, "done");
  const cancelled = create(beta.projectId, "Abandoned work");
  settle(beta.projectId, cancelled, "cancelled");
  for (let i = 0; i < 5; i++) {
    const response = await s.sessionPost("/api/operator/commands", {
      type: "message",
      key: randomUUID(),
      taskId: beta.taskId,
      recipientAssignmentId: beta.assignmentId,
      expectedAssignmentVersion: Number(
        d.assignment(beta.assignmentId).version,
      ),
      message: `Operator message ${i}`,
    });
    if (response.status !== 200) throw Error(`message ${response.status}`);
  }
  return {
    alphaId,
    betaId: beta.projectId,
    alphaLeadId,
    sharedProfileId,
    alphaSharedTaskId: alphaShared,
    betaSharedTaskId: beta.taskId,
    alphaTaskIds,
    doneTaskId: done,
    cancelledTaskId: cancelled,
    resultId: result,
  };
}
