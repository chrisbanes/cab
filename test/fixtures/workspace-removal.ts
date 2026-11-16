import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { StandaloneService } from "../../src/standalone/service.js";
import type { TaskWorkspaceBinding } from "../../src/standalone/workspaces.js";

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

/** Links the project to exactly `binding`'s repositories, as they were provisioned. */
export function linkBindingRepositories(
  f: { seedPersistedState(seed: (db: DatabaseSync) => void): void },
  projectId: string,
  binding: Pick<TaskWorkspaceBinding, "repositories">,
): void {
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE project_repository_links SET version=version+1, links=? WHERE projectId=?",
      )
      .run(
        JSON.stringify(
          binding.repositories.map((r) => ({
            codeHost: "github",
            host: "github.com",
            repositoryId: r.repositoryId,
            path: r.sourcePath,
            ref: r.ref,
            gitCommonDirectory: r.sourceGitCommonDir ?? r.gitCommonDir,
          })),
        ),
        projectId,
      ),
  );
}
