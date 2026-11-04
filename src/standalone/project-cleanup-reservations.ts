import { sep } from "node:path";
import type { Database } from "../core/store.js";
import { projectCleanupId } from "./project-cleanup-identities.js";
import type { TaskWorkspaceBinding } from "./workspaces.js";

function tombstones(db: Database) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_tombstones'",
    )
    .get();
}
export function isDeletedProjectThread(
  db: Database,
  threadId: string,
): boolean {
  if (!tombstones(db)) return false;
  return !!db
    .prepare(`SELECT 1 FROM project_tombstones t,json_each(t.cleanupJson,'$.items') i
    WHERE json_extract(i.value,'$.kind')='codex-thread' AND (json_extract(i.value,'$.id')=? OR json_extract(i.value,'$.captured.threadId')=?) LIMIT 1`)
    .get(projectCleanupId("codex-thread", threadId), threadId);
}
const within = (path: string, root: string) =>
  path === root || path.startsWith(root + sep);
/** Cooperating binding creation cannot claim an identity while captured cleanup is pending. */
export function assertCapturedWorkspaceAvailable(
  db: Database,
  binding: Pick<
    TaskWorkspaceBinding,
    "taskId" | "workspaceId" | "path" | "repositories"
  >,
): void {
  if (!tombstones(db)) return;
  if (
    db
      .prepare(`SELECT 1 FROM project_tombstones t,json_each(t.cleanupJson,'$.items') i
    WHERE json_extract(i.value,'$.kind')='workspace' AND json_extract(i.value,'$.id')=? LIMIT 1`)
      .get(projectCleanupId("workspace", binding.workspaceId))
  )
    throw new Error("Workspace identity belongs to a deleted project");
  const pending = db
    .prepare(`SELECT json_extract(i.value,'$.captured.binding.path') AS path,
    json_extract(i.value,'$.captured.binding.taskId') AS taskId FROM project_tombstones t,json_each(t.cleanupJson,'$.items') i
    WHERE json_extract(i.value,'$.kind')='workspace' AND json_extract(i.value,'$.state')='pending' LIMIT 10001`)
    .all() as { path: unknown; taskId: unknown }[];
  if (pending.length > 10000)
    throw new Error("Workspace cleanup ownership unavailable");
  for (const row of pending) {
    if (typeof row.path !== "string" || typeof row.taskId !== "string")
      throw new Error("Workspace cleanup ownership unavailable");
    const root = row.path;
    if (
      row.taskId === binding.taskId ||
      within(binding.path, root) ||
      binding.repositories.some(
        (repo) =>
          within(repo.sourcePath, root) || within(repo.workspacePath, root),
      )
    )
      throw new Error(
        "Workspace identity is reserved by deleted-project cleanup",
      );
  }
}
/** Checked again by the locked physical operation after each asynchronous identity read. */
export function capturedWorkspaceUnclaimed(
  db: Database,
  binding: Pick<TaskWorkspaceBinding, "taskId" | "workspaceId" | "path"> & {
    repositories?: readonly { workspacePath: string }[];
  },
): boolean {
  const paths = JSON.stringify([
    binding.path,
    ...(binding.repositories ?? []).map(
      (repository) => repository.workspacePath,
    ),
  ]);
  for (const table of [
    "task_workspace_bindings",
    "drafting_workspace_bindings",
  ]) {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE taskId=? OR workspaceId=? OR path IN (SELECT value FROM json_each(?)) LIMIT 1`,
        )
        .get(binding.taskId, binding.workspaceId, paths)
    )
      return false;
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} b,json_each(b.repositories) r WHERE json_extract(r.value,'$.sourcePath') IN (SELECT value FROM json_each(?)) OR json_extract(r.value,'$.workspacePath') IN (SELECT value FROM json_each(?)) LIMIT 1`,
        )
        .get(paths, paths)
    )
      return false;
  }
  for (const table of [
    "execution_intents",
    "turn_requests",
    "task_writer_admissions",
  ])
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE workspace IN (SELECT value FROM json_each(?)) LIMIT 1`,
        )
        .get(paths)
    )
      return false;
  if (
    db
      .prepare(
        `SELECT 1 FROM project_repository_links p,json_each(p.links) r WHERE json_extract(r.value,'$.path') IN (SELECT value FROM json_each(?)) LIMIT 1`,
      )
      .get(paths)
  )
    return false;
  return true;
}
