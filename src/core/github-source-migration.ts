import type { Database } from "./store.js";

/**
 * Task-source tables from before storage was keyed by provider and instance (ADR-1020).
 * Every row was GitHub on github.com. Parents come before the children that reference them.
 */
const github = "'github', 'github.com'";
const legacyTables: {
  from: string;
  to: string;
  columns: string;
  select: string;
}[] = [
  {
    from: "project_github_sources",
    to: "project_task_sources",
    columns:
      "projectId, provider, instance, version, credentialRef, selections, readiness, closedIssues",
    select: `projectId, ${github}, version, credentialRef, selections, readiness, closedIssues`,
  },
  {
    from: "project_github_active",
    to: "project_active_selections",
    columns: "projectId, selectionId, configVersion",
    select: "projectId, selectionId, configVersion",
  },
  {
    from: "github_sync_state",
    to: "source_sync_state",
    columns:
      "projectId, selectionId, complete, reason, refreshedAt, skippedClosedIds",
    select:
      "projectId, selectionId, complete, reason, refreshedAt, skippedClosedNodeIds",
  },
  {
    from: "github_external_issues",
    to: "external_items",
    columns:
      "provider, instance, externalId, taskId, containerId, containerName, number, observedTitle, observedBody, observedState, labels",
    select: `${github}, nodeId, taskId, repositoryId, repositoryName, issueNumber, observedTitle, observedBody, observedState, labels`,
  },
  {
    from: "github_memberships",
    to: "source_memberships",
    columns:
      "projectId, selectionId, provider, instance, externalId, fields, itemId, readAt, missedReads",
    select: `projectId, selectionId, ${github}, nodeId, projectFields, itemNodeId, readAt, missedReads`,
  },
  {
    from: "github_placement_decisions",
    to: "source_placement_decisions",
    columns: "provider, instance, externalId, projectId",
    select: `${github}, nodeId, projectId`,
  },
  {
    from: "github_native_blockers",
    to: "source_native_blockers",
    columns:
      "provider, instance, externalId, blockerExternalId, containerId, containerName, number, status",
    select: `${github}, nodeId, blockerNodeId, repositoryId, repositoryName, issueNumber, status`,
  },
  {
    from: "github_dependency_observations",
    to: "source_dependency_observations",
    columns: "provider, instance, externalId, complete, reason, refreshedAt",
    select: `${github}, nodeId, complete, reason, refreshedAt`,
  },
  {
    from: "github_source_reviews",
    to: "source_reviews",
    columns:
      "provider, instance, externalId, observedDigest, acceptedDigest, decision, decidedAt",
    select: `${github}, nodeId, observedDigest, acceptedDigest, decision, decidedAt`,
  },
  {
    from: "github_source_holds",
    to: "source_holds",
    columns: "provider, instance, externalId, active, reason, generation",
    select: `${github}, nodeId, active, reason, generation`,
  },
  {
    from: "github_imported_tasks",
    to: "imported_tasks",
    columns: "taskId, provider, instance, externalId, containerId",
    select: `taskId, ${github}, nodeId, repositoryId`,
  },
  {
    from: "github_issue_status",
    to: "external_item_status",
    columns: "provider, instance, externalId, status, reason, refreshedAt",
    select: `${github}, nodeId, status, reason, refreshedAt`,
  },
  {
    from: "github_delivery_closures",
    to: "source_closures",
    columns:
      "provider, instance, externalId, operationId, closerChangeRequestId, snapshotJson, closedEventId",
    select: `${github}, nodeId, operationId, closerPrNodeId, snapshotJson, closedEventId`,
  },
  {
    from: "github_delivery_closure_supersessions",
    to: "source_closure_supersessions",
    columns: "provider, instance, externalId, operationId, supersededAt",
    select: `${github}, nodeId, operationId, supersededAt`,
  },
  {
    from: "github_provider_completions",
    to: "source_completions",
    columns: "taskId, provider, instance, externalId, completedAt",
    select: `taskId, ${github}, nodeId, completedAt`,
  },
  {
    from: "github_project_fields",
    to: "source_field_names",
    columns: "provider, instance, scopeId, fieldId, name, options",
    select: `${github}, projectNodeId, fieldNodeId, name, options`,
  },
];

/** Columns added to the legacy tables over time; a database from any earlier schema gains them before it is copied. */
const legacyColumns: [table: string, column: string, definition: string][] = [
  [
    "project_github_sources",
    "closedIssues",
    "TEXT NOT NULL DEFAULT 'skip' CHECK(closedIssues IN ('skip','done'))",
  ],
  ["github_sync_state", "skippedClosedNodeIds", "TEXT NOT NULL DEFAULT '[]'"],
  ["github_memberships", "itemNodeId", "TEXT"],
  ["github_memberships", "readAt", "INTEGER"],
  ["github_memberships", "missedReads", "INTEGER"],
  ["github_delivery_closures", "closedEventId", "TEXT"],
];

const columnsOf = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );

/**
 * Repository links moved from the GitHub source to the project: copy any still on the legacy
 * source table, then drop that column. One-way: an older build cannot read it.
 */
export function extractLegacyRepositoryLinks(
  db: Database,
  toLinks: (repositories: unknown) => unknown[],
): void {
  if (!columnsOf(db, "project_github_sources").includes("repositories")) return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO project_repository_links (projectId, version, links) VALUES (?, 1, ?)",
  );
  for (const row of db
    .prepare("SELECT projectId, repositories FROM project_github_sources")
    .all() as { projectId: string; repositories: string }[])
    insert.run(
      row.projectId,
      JSON.stringify(toLinks(JSON.parse(row.repositories))),
    );
  db.exec("ALTER TABLE project_github_sources DROP COLUMN repositories");
}

/**
 * Moves every row of the GitHub-named task-source tables into the neutral tables and drops
 * them. Forward-only and idempotent: nothing happens once no legacy table remains. Runs in
 * the caller's transaction, so a conflict or failed copy rolls everything back. Plain
 * `INSERT` never ignores or replaces a row.
 */
export function moveLegacyGitHubSourceStorage(db: Database): void {
  const present = legacyTables.filter(
    ({ from }) => columnsOf(db, from).length > 0,
  );
  if (present.length === 0) return;
  // The copy below would silently drop them.
  if (columnsOf(db, "project_github_sources").includes("repositories"))
    throw new Error("Repository links must be extracted before the move");
  for (const [table, column, definition] of legacyColumns)
    if (
      columnsOf(db, table).length > 0 &&
      !columnsOf(db, table).includes(column)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  for (const { from, to, columns, select } of present)
    db.exec(
      `INSERT INTO ${to} (${columns}) SELECT ${select} FROM ${from} ORDER BY rowid`,
    );
  // Children before the parent they reference.
  for (const { from } of [...present].reverse()) db.exec(`DROP TABLE ${from}`);
}
