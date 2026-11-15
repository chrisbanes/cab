import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { StandaloneService } from "../../src/standalone/service.js";

/** Ends (or reopens) the task as the operator would, so its workspace may be removed. */
export function finishTask(
  service: StandaloneService,
  taskId: string,
  state: "done" | "cancelled" | "open" = "done",
): void {
  const domain = service.domain();
  const task = domain.task(taskId);
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: String(task.projectId),
    taskId,
    expectedVersion: Number(task.version),
    state,
  });
}

/**
 * Records each repository's current HEAD as its task branch's last push: the delivery fact a
 * confirmed push leaves, for tests whose subject is not the push itself.
 */
export async function recordDeliveredHeads(
  f: {
    service: StandaloneService;
    seedPersistedState(seed: (db: DatabaseSync) => void): void;
  },
  taskId: string,
): Promise<void> {
  const binding = await f.service.taskWorkspace(taskId);
  for (const repository of binding?.repositories ?? []) {
    const head = execFileSync(
      "git",
      ["-C", repository.workspacePath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    f.seedPersistedState((db) =>
      db
        .prepare(
          `INSERT INTO delivery_task_branches (taskId,repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt)
          VALUES (?,?,?,?,NULL,1) ON CONFLICT(taskId,repositoryId) DO UPDATE SET lastPushedSha=excluded.lastPushedSha`,
        )
        .run(taskId, repository.repositoryId, `cab/${taskId}`, head),
    );
  }
}
