import type { Database } from "./store.js";

/** Why a dependent does not, or does not yet, start on its blocker's head (ADR-1023). */
export const stackReasons = [
  "stacking-off",
  "multiple-blockers",
  "sibling-stacked",
  "cross-repository",
  "outside-project",
  "dependent-started",
  "blocker-unpublished",
  "blocker-unknown",
] as const;
export type StackReason = (typeof stackReasons)[number];

export interface StackFacts {
  state: "stacked" | "waiting";
  reason: StackReason | null;
  blockerTaskId: string | null;
  repositoryId: string | null;
  /** The blocker head the dependent's workspace starts from; null until recorded. */
  parentHead: string | null;
  restack: "current" | "pending" | null;
}

export const stackingTables = `
  CREATE TABLE IF NOT EXISTS project_stacking (
    projectId TEXT PRIMARY KEY REFERENCES domain_projects(id),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS stacked_dependencies (
    taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
    blockerTaskId TEXT NOT NULL UNIQUE REFERENCES domain_tasks(id),
    repositoryId TEXT NOT NULL, parentHead TEXT NOT NULL, settledHead TEXT,
    restack TEXT NOT NULL CHECK(restack IN ('current','pending')),
    restackFromSha TEXT, restackSeq INTEGER NOT NULL DEFAULT 0,
    recordedAt INTEGER NOT NULL
  );`;

/** The durable order of task dependency edges: the lowest `seq` is the first recorded edge. */
export const dependencyRecordsTable = `CREATE TABLE IF NOT EXISTS task_dependency_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId TEXT NOT NULL REFERENCES domain_tasks(id),
    blockerTaskId TEXT NOT NULL REFERENCES domain_tasks(id),
    UNIQUE(taskId, blockerTaskId)
  )`;

const localEdges =
  "SELECT blockerTaskId FROM local_dependencies WHERE taskId = ?";
/** Native edges of an imported task whose blocker was imported as a task. */
const nativeEdges = `SELECT bi.taskId AS blockerTaskId FROM imported_tasks d
  JOIN source_native_blockers n ON n.provider = d.provider AND n.instance = d.instance
    AND n.externalId = d.externalId
  JOIN imported_tasks bi ON bi.provider = n.provider AND bi.instance = n.instance
    AND bi.externalId = n.blockerExternalId
  WHERE d.taskId = ?`;

/**
 * Brings a dependent's edge records in line with its local and native edges, in their
 * order, keeping the sequence of edges that remain. A stacked dependency whose edge is
 * gone is no longer recorded. Run inside the caller's transaction.
 */
export function syncDependencyRecords(db: Database, taskId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_dependency_records (taskId, blockerTaskId)
      SELECT ?, blockerTaskId FROM (${localEdges} ORDER BY rowid)`,
  ).run(taskId, taskId);
  db.prepare(
    `INSERT OR IGNORE INTO task_dependency_records (taskId, blockerTaskId)
      SELECT ?, blockerTaskId FROM (${nativeEdges} ORDER BY n.blockerExternalId)`,
  ).run(taskId, taskId);
  for (const table of ["task_dependency_records", "stacked_dependencies"])
    db.prepare(
      `DELETE FROM ${table} WHERE taskId = ? AND blockerTaskId NOT IN (${localEdges} UNION ${nativeEdges})`,
    ).run(taskId, taskId, taskId);
}

/**
 * Records the edges of dependents whose native blockers name `blockerTaskId`, once it has been
 * imported: their refresh may have run before it was a task. Run inside the caller's transaction.
 */
export function syncDependentsOf(db: Database, blockerTaskId: string): void {
  const dependents = db
    .prepare(
      `SELECT DISTINCT d.taskId FROM imported_tasks b
      JOIN source_native_blockers n ON n.provider = b.provider AND n.instance = b.instance
        AND n.blockerExternalId = b.externalId
      JOIN imported_tasks d ON d.provider = n.provider AND d.instance = n.instance
        AND d.externalId = n.externalId
      WHERE b.taskId = ? ORDER BY n.rowid`,
    )
    .all(blockerTaskId) as Array<{ taskId: string }>;
  for (const { taskId } of dependents) syncDependencyRecords(db, taskId);
}

/** Seeds edge records for every dependent once, local edges first in insertion order. */
export function seedDependencyRecords(db: Database): void {
  db.exec(`INSERT OR IGNORE INTO task_dependency_records (taskId, blockerTaskId)
    SELECT taskId, blockerTaskId FROM local_dependencies ORDER BY rowid`);
  db.exec(`INSERT OR IGNORE INTO task_dependency_records (taskId, blockerTaskId)
    SELECT d.taskId, bi.taskId FROM imported_tasks d
    JOIN source_native_blockers n ON n.provider = d.provider AND n.instance = d.instance
      AND n.externalId = d.externalId
    JOIN imported_tasks bi ON bi.provider = n.provider AND bi.instance = n.instance
      AND bi.externalId = n.blockerExternalId
    ORDER BY n.externalId, n.blockerExternalId`);
}
