import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { DomainConflictError } from "./domain-errors.js";
import type { Database } from "./store.js";

export function hasProjectTombstones(db: Database): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_tombstones'",
    )
    .get();
}

/** Canonical ownership paths use normalized separator boundaries, including descendants. */
export function withinCapturedRemoval(path: string, root: string): boolean {
  const normalized = resolve(path),
    parent = resolve(root);
  return (
    normalized === parent ||
    normalized.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

const workspaceId = z.string().uuid();
const unavailable = () =>
  new DomainConflictError("Workspace cleanup ownership unavailable");

/**
 * Acquisition must share the ownership write's transaction: a post-effect readback
 * cannot rescue a new owner from a destructive child that was already dispatched.
 * Only the ownership projection is read here; the cleanup store validates the full
 * private filesystem descriptor before any effect. Pending captures reserve roots
 * even before a child starts and after an unobserved outcome or process restart.
 */
export function assertCleanupOwnershipAvailableWithinTransaction(
  db: Database,
  paths: readonly string[],
  taskId?: string,
): void {
  if (!db.isTransaction)
    throw new Error("Cleanup ownership admission requires a transaction");
  if (paths.length === 0 && taskId === undefined) return;
  if (
    paths.length > 10000 ||
    paths.some((path) => typeof path !== "string" || !isAbsolute(path))
  )
    throw unavailable();
  if (!hasProjectTombstones(db)) return;
  // Never let a malformed envelope turn an unknown reservation into an empty array.
  if (
    db
      .prepare(`SELECT 1 FROM project_tombstones WHERE
    CASE WHEN json_valid(cleanupJson) THEN
      json_type(cleanupJson) IS NOT 'object' OR
      json_extract(cleanupJson,'$.version') IS NOT 1 OR
      json_type(cleanupJson,'$.items') IS NOT 'array'
    ELSE 1 END
    OR (cleanupState IS NOT 'pending' AND cleanupState IS NOT 'complete') LIMIT 1`)
      .get()
  )
    throw unavailable();
  const rows = db
    .prepare(`SELECT t.cleanupState AS aggregateState, i.type AS itemType,
    json_extract(i.value,'$.id') AS id,
    json_extract(i.value,'$.state') AS state,
    json_extract(i.value,'$.reason') AS reason,
    json_extract(i.value,'$.kind') AS kind,
    json_extract(i.value,'$.captured.kind') AS capturedKind,
    json_extract(i.value,'$.captured.managedRoot') AS managedRoot,
    json_extract(i.value,'$.captured.binding.path') AS path,
    json_extract(i.value,'$.captured.binding.taskId') AS taskId,
    json_extract(i.value,'$.captured.binding.workspaceId') AS workspaceId
    FROM project_tombstones t,json_each(t.cleanupJson,'$.items') i
    WHERE json_extract(i.value,'$.state') IS NOT 'complete'
      OR json_type(i.value,'$.captured') IS NOT NULL
      OR json_type(i.value,'$.gitRemoval') IS NOT NULL
      OR json_extract(i.value,'$.kind') IS NULL
      OR json_extract(i.value,'$.kind') NOT IN ('workspace','claude-temp','codex-thread')
      OR json_type(i.value,'$.id') IS NOT 'text'
    LIMIT 10001`)
    .all() as Record<string, unknown>[];
  if (rows.length > 10000) throw unavailable();
  for (const row of rows) {
    if (
      row.itemType !== "object" ||
      typeof row.id !== "string" ||
      !row.id ||
      row.state !== "pending" ||
      row.aggregateState !== "pending" ||
      !["not-attempted", "unavailable", "unsafe", "failed", "unknown"].includes(
        String(row.reason),
      ) ||
      !["workspace", "claude-temp", "codex-thread"].includes(
        String(row.kind),
      ) ||
      row.capturedKind !== row.kind
    )
      throw unavailable();
    if (row.kind !== "workspace") continue;
    if (
      typeof row.path !== "string" ||
      !isAbsolute(row.path) ||
      resolve(row.path) !== row.path ||
      typeof row.taskId !== "string" ||
      !row.taskId ||
      typeof row.workspaceId !== "string" ||
      !workspaceId.safeParse(row.workspaceId).success ||
      typeof row.managedRoot !== "string" ||
      !isAbsolute(row.managedRoot) ||
      resolve(row.managedRoot) !== row.managedRoot ||
      row.path !== join(row.managedRoot, row.workspaceId)
    )
      throw unavailable();
    if (
      row.taskId === taskId ||
      paths.some((path) => withinCapturedRemoval(path, row.path as string))
    )
      throw new DomainConflictError(
        "Workspace identity is reserved by deleted-project cleanup",
      );
  }
}
