import { githubIssueTracker } from "./github-source-contracts.js";
import { moveLegacyGitHubSourceStorage } from "./github-source-migration.js";
import type { Database } from "./store.js";

/** An issue tracker's identity: the `provider` and `instance` columns of its items. */
export type SourceTracker = {
  readonly provider: string;
  readonly instance: string;
};

/** Binds an item key to its three columns (`provider`, `instance`, `externalId`); GitHub unless a tracker is given. */
export const itemKey = (
  externalId: string,
  tracker: SourceTracker = githubIssueTracker,
) =>
  [tracker.provider, tracker.instance, externalId] as [string, string, string];

/** SQL selecting one item by `itemKey`; `alias` qualifies the columns. */
export const itemIs = (alias = "") => {
  const p = alias ? `${alias}.` : "";
  return `${p}provider = ? AND ${p}instance = ? AND ${p}externalId = ?`;
};

/** The SQL expressions of an item key bound by `itemKey`'s parameters. */
export const itemParams = ["?", "?", "?"] as const;

/** The SQL expressions of the item key columns of a table alias. */
export const itemColumns = (alias: string) =>
  [`${alias}.provider`, `${alias}.instance`, `${alias}.externalId`] as const;

/** SQL equating the item keys of two table aliases. */
export const sameItem = (a: string, b: string) =>
  `${a}.provider = ${b}.provider AND ${a}.instance = ${b}.instance AND ${a}.externalId = ${b}.externalId`;

/**
 * Task-source storage keyed by provider and instance (ADR-1020). Item tables share the key
 * `(provider, instance, externalId)`. Rows of the previous GitHub-named tables move once,
 * inside the caller's transaction.
 */
export function migrateSourceStorage(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_task_sources (
      projectId TEXT PRIMARY KEY REFERENCES domain_projects(id),
      provider TEXT NOT NULL, instance TEXT NOT NULL, version INTEGER NOT NULL,
      credentialRef TEXT, selections TEXT NOT NULL, readiness TEXT NOT NULL,
      closedIssues TEXT NOT NULL DEFAULT 'skip' CHECK(closedIssues IN ('skip','done'))
    );
    CREATE TABLE IF NOT EXISTS project_active_selections (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      configVersion INTEGER NOT NULL, PRIMARY KEY(projectId, selectionId)
    );
    CREATE TABLE IF NOT EXISTS source_sync_state (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT,
      refreshedAt TEXT NOT NULL, skippedClosedIds TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(projectId, selectionId)
    );
    CREATE TABLE IF NOT EXISTS external_items (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      taskId TEXT NOT NULL UNIQUE REFERENCES domain_tasks(id), containerId TEXT NOT NULL,
      containerName TEXT NOT NULL, number INTEGER NOT NULL,
      observedTitle TEXT NOT NULL, observedBody TEXT NOT NULL, observedState TEXT NOT NULL,
      labels TEXT NOT NULL, observedStatus TEXT, observedFields TEXT, PRIMARY KEY(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_memberships (
      projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      fields TEXT NOT NULL, itemId TEXT, readAt INTEGER, missedReads INTEGER,
      PRIMARY KEY(projectId, selectionId, provider, instance, externalId),
      FOREIGN KEY(provider, instance, externalId) REFERENCES external_items(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_placement_decisions (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      projectId TEXT NOT NULL REFERENCES domain_projects(id),
      PRIMARY KEY(provider, instance, externalId),
      FOREIGN KEY(provider, instance, externalId) REFERENCES external_items(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_native_blockers (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      blockerExternalId TEXT NOT NULL, containerId TEXT NOT NULL, containerName TEXT NOT NULL,
      number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')),
      PRIMARY KEY(provider, instance, externalId, blockerExternalId),
      FOREIGN KEY(provider, instance, externalId) REFERENCES external_items(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_dependency_observations (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT, refreshedAt TEXT NOT NULL,
      PRIMARY KEY(provider, instance, externalId),
      FOREIGN KEY(provider, instance, externalId) REFERENCES external_items(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_reviews (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      observedDigest TEXT NOT NULL, acceptedDigest TEXT NOT NULL, decision TEXT, decidedAt TEXT,
      PRIMARY KEY(provider, instance, externalId),
      FOREIGN KEY(provider, instance, externalId) REFERENCES external_items(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_holds (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)), reason TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      PRIMARY KEY(provider, instance, externalId),
      FOREIGN KEY(provider, instance, externalId) REFERENCES external_items(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS imported_tasks (
      taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      containerId TEXT NOT NULL, UNIQUE(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS external_item_status (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','closed','unknown')),
      reason TEXT, refreshedAt TEXT NOT NULL, PRIMARY KEY(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_closures (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      operationId TEXT NOT NULL, closerChangeRequestId TEXT, snapshotJson TEXT NOT NULL,
      closedEventId TEXT, PRIMARY KEY(provider, instance, externalId)
    );
    CREATE TABLE IF NOT EXISTS source_closure_supersessions (
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      operationId TEXT NOT NULL, supersededAt TEXT NOT NULL,
      PRIMARY KEY(provider, instance, externalId, operationId)
    );
    CREATE TABLE IF NOT EXISTS source_completions (
      taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
      provider TEXT NOT NULL, instance TEXT NOT NULL, externalId TEXT NOT NULL,
      completedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_field_names (
      provider TEXT NOT NULL, instance TEXT NOT NULL, scopeId TEXT NOT NULL,
      fieldId TEXT NOT NULL, name TEXT NOT NULL, options TEXT NOT NULL,
      PRIMARY KEY(provider, instance, scopeId, fieldId)
    );`);
  // The tracker's own status as JSON `{id,name,categoryKey}`, and its single-select values as
  // JSON `[{fieldId,optionId,name}]`; NULL for GitHub.
  const columns = (
    db.prepare("PRAGMA table_info(external_items)").all() as { name: string }[]
  ).map((column) => column.name);
  for (const column of ["observedStatus", "observedFields"])
    if (!columns.includes(column))
      db.exec(`ALTER TABLE external_items ADD COLUMN ${column} TEXT`);
  moveLegacyGitHubSourceStorage(db);
}

/** The issue tracker a project's task source names, or null when the project has none. */
export function projectIssueTracker(
  db: Database,
  projectId: string,
): { provider: string; instance: string } | null {
  return (
    (db
      .prepare(
        "SELECT provider, instance FROM project_task_sources WHERE projectId = ?",
      )
      .get(projectId) as { provider: string; instance: string } | undefined) ??
    null
  );
}
