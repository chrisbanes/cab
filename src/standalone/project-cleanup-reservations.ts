import { repositoryLinkListSchema } from "../core/repository-links.js";
import { isAbsolute } from "node:path";
import {
  assertCleanupOwnershipAvailableWithinTransaction,
  hasProjectTombstones as tombstones,
  withinCapturedRemoval as within,
} from "../core/project-cleanup-reservations.js";
import type { Database } from "../core/store.js";
import { projectCleanupId } from "./project-cleanup-identities.js";
import {
  repositoryBindingPaths,
  type TaskWorkspaceBinding,
} from "./workspaces.js";

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
  assertCleanupOwnershipAvailableWithinTransaction(
    db,
    [binding.path, ...binding.repositories.flatMap(repositoryBindingPaths)],
    binding.taskId,
  );
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
    for (const field of [
      "sourcePath",
      "workspacePath",
      "gitCommonDir",
      "sourceGitCommonDir",
      "gitDirectory",
    ]) {
      const rows = db
        .prepare(`SELECT json_extract(r.value,'$.${field}') AS path
        FROM ${table} b,json_each(b.repositories) r
        ${field === "sourcePath" || field === "workspacePath" ? "" : `WHERE json_extract(r.value,'$.${field}') IS NOT NULL`}
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
  const savedLinks = db
    .prepare("SELECT links FROM project_repository_links LIMIT 10001")
    .all() as { links: unknown }[];
  if (savedLinks.length > 10000) return false;
  for (const row of savedLinks) {
    try {
      if (
        typeof row.links !== "string" ||
        !repositoryLinkListSchema.safeParse(JSON.parse(row.links)).success
      )
        return false;
    } catch {
      return false;
    }
  }
  for (const field of ["path", "gitCommonDirectory"]) {
    const rows = db
      .prepare(`SELECT json_extract(r.value,'$.${field}') AS path
        FROM project_repository_links p,json_each(p.links) r
        ${field === "gitCommonDirectory" ? "WHERE json_extract(r.value,'$.gitCommonDirectory') IS NOT NULL" : ""}
        LIMIT 10001`)
      .all() as { path: unknown }[];
    if (!unclaimed(rows)) return false;
  }
  return true;
}
