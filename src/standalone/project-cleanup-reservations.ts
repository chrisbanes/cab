import { isAbsolute, resolve, sep } from "node:path";
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
const within = (path: string, root: string) => {
  const normalized = resolve(path),
    parent = resolve(root);
  return normalized === parent || normalized.startsWith(parent + sep);
};
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
    if (
      typeof row.path !== "string" ||
      !isAbsolute(row.path) ||
      typeof row.taskId !== "string"
    )
      throw new Error("Workspace cleanup ownership unavailable");
    const root = row.path;
    if (
      row.taskId === binding.taskId ||
      within(binding.path, root) ||
      binding.repositories.some(
        (repo) =>
          within(repo.sourcePath, root) ||
          within(repo.workspacePath, root) ||
          (repo.gitCommonDir !== null && within(repo.gitCommonDir, root)),
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
  // The final rm removes the entire captured root, including repository subdirectories.
  // Source checkouts may legitimately be registered at a subdirectory of a Git tree.
  // Compare normalized paths with a separator boundary, never SQL LIKE or substring matching.
  const unclaimed = (rows: { path: unknown }[]) =>
    rows.length <= 10000 &&
    rows.every(
      ({ path }) =>
        typeof path === "string" &&
        isAbsolute(path) &&
        !within(path, binding.path),
    );
  for (const table of [
    "task_workspace_bindings",
    "drafting_workspace_bindings",
  ]) {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE taskId=? OR workspaceId=? LIMIT 1`,
        )
        .get(binding.taskId, binding.workspaceId)
    )
      return false;
    if (
      !unclaimed(
        db.prepare(`SELECT path FROM ${table} LIMIT 10001`).all() as {
          path: unknown;
        }[],
      )
    )
      return false;
    for (const field of ["sourcePath", "workspacePath", "gitCommonDir"]) {
      const rows = db
        .prepare(`SELECT json_extract(r.value,'$.${field}') AS path
        FROM ${table} b,json_each(b.repositories) r
        ${field === "gitCommonDir" ? "WHERE json_extract(r.value,'$.gitCommonDir') IS NOT NULL" : ""}
        LIMIT 10001`)
        .all() as { path: unknown }[];
      if (!unclaimed(rows)) return false;
    }
  }
  for (const table of [
    "execution_intents",
    "turn_requests",
    "task_writer_admissions",
  ]) {
    if (
      !unclaimed(
        db
          .prepare(`SELECT workspace AS path FROM ${table}
            WHERE workspace IS NOT NULL LIMIT 10001`)
          .all() as { path: unknown }[],
      )
    )
      return false;
  }
  return unclaimed(
    db
      .prepare(`SELECT json_extract(r.value,'$.path') AS path
        FROM project_repository_links p,json_each(p.links) r LIMIT 10001`)
      .all() as { path: unknown }[],
  );
}
