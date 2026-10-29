import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";

/**
 * The GitHub-named task-source tables as `b77c4dc8` created them, before storage was keyed by
 * provider and instance. Columns later added by `ALTER TABLE` sit at the end of their table, as
 * they do in a database that was upgraded in place.
 */
export const previousSourceTables = [
  "project_github_sources",
  "project_github_active",
  "github_sync_state",
  "github_external_issues",
  "github_memberships",
  "github_placement_decisions",
  "github_native_blockers",
  "github_dependency_observations",
  "github_source_reviews",
  "github_source_holds",
  "github_imported_tasks",
  "github_issue_status",
  "github_delivery_closures",
  "github_delivery_closure_supersessions",
  "github_provider_completions",
  "github_project_fields",
] as const;

const previousSourceSchema = `
  CREATE TABLE project_github_sources (
    projectId TEXT PRIMARY KEY REFERENCES domain_projects(id), version INTEGER NOT NULL,
    credentialRef TEXT, selections TEXT NOT NULL, readiness TEXT NOT NULL,
    closedIssues TEXT NOT NULL DEFAULT 'skip' CHECK(closedIssues IN ('skip','done'))
  );
  CREATE TABLE project_github_active (
    projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
    configVersion INTEGER NOT NULL, PRIMARY KEY(projectId, selectionId)
  );
  CREATE TABLE github_imported_tasks (
    taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
    providerInstance TEXT NOT NULL CHECK(providerInstance = 'github.com'),
    nodeId TEXT NOT NULL, repositoryId TEXT NOT NULL,
    UNIQUE(providerInstance, nodeId)
  );
  CREATE TABLE github_issue_status (
    nodeId TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('open','closed','unknown')),
    reason TEXT, refreshedAt TEXT NOT NULL
  );
  CREATE TABLE github_external_issues (
    providerInstance TEXT NOT NULL CHECK(providerInstance = 'github.com'), nodeId TEXT NOT NULL,
    taskId TEXT NOT NULL UNIQUE REFERENCES domain_tasks(id), repositoryId TEXT NOT NULL,
    repositoryName TEXT NOT NULL, issueNumber INTEGER NOT NULL,
    observedTitle TEXT NOT NULL, observedBody TEXT NOT NULL, observedState TEXT NOT NULL,
    labels TEXT NOT NULL, PRIMARY KEY(providerInstance, nodeId), UNIQUE(nodeId)
  );
  CREATE TABLE github_memberships (
    projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
    nodeId TEXT NOT NULL, projectFields TEXT NOT NULL,
    itemNodeId TEXT, readAt INTEGER, missedReads INTEGER,
    PRIMARY KEY(projectId, selectionId, nodeId),
    FOREIGN KEY(nodeId) REFERENCES github_external_issues(nodeId)
  );
  CREATE TABLE github_sync_state (
    projectId TEXT NOT NULL REFERENCES domain_projects(id), selectionId TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT,
    refreshedAt TEXT NOT NULL, skippedClosedNodeIds TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY(projectId, selectionId)
  );
  CREATE TABLE github_placement_decisions (
    nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
    projectId TEXT NOT NULL REFERENCES domain_projects(id)
  );
  CREATE TABLE github_native_blockers (
    nodeId TEXT NOT NULL REFERENCES github_external_issues(nodeId), blockerNodeId TEXT NOT NULL,
    repositoryId TEXT NOT NULL, repositoryName TEXT NOT NULL, issueNumber INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','closed')),
    PRIMARY KEY(nodeId, blockerNodeId)
  );
  CREATE TABLE github_dependency_observations (
    nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
    complete INTEGER NOT NULL CHECK(complete IN (0,1)), reason TEXT, refreshedAt TEXT NOT NULL
  );
  CREATE TABLE github_source_reviews (
    nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
    observedDigest TEXT NOT NULL, acceptedDigest TEXT NOT NULL,
    decision TEXT, decidedAt TEXT
  );
  CREATE TABLE github_delivery_closures (nodeId TEXT PRIMARY KEY, operationId TEXT NOT NULL, closerPrNodeId TEXT, snapshotJson TEXT NOT NULL, closedEventId TEXT);
  CREATE TABLE github_delivery_closure_supersessions (
    nodeId TEXT NOT NULL, operationId TEXT NOT NULL, supersededAt TEXT NOT NULL,
    PRIMARY KEY(nodeId, operationId)
  );
  CREATE TABLE github_source_holds (
    nodeId TEXT PRIMARY KEY REFERENCES github_external_issues(nodeId),
    active INTEGER NOT NULL CHECK(active IN (0,1)), reason TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0)
  );
  CREATE TABLE github_project_fields (
    projectNodeId TEXT NOT NULL, fieldNodeId TEXT NOT NULL, name TEXT NOT NULL,
    options TEXT NOT NULL, PRIMARY KEY(projectNodeId, fieldNodeId)
  );
  CREATE TABLE github_provider_completions (
    taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
    nodeId TEXT NOT NULL, completedAt TEXT NOT NULL
  );`;

/** The provider-neutral tables, children before the parents they reference. */
const neutralSourceTables = [
  "source_field_names",
  "source_completions",
  "source_closure_supersessions",
  "source_closures",
  "external_item_status",
  "imported_tasks",
  "source_holds",
  "source_reviews",
  "source_dependency_observations",
  "source_native_blockers",
  "source_placement_decisions",
  "source_memberships",
  "external_items",
  "source_sync_state",
  "project_active_selections",
  "project_task_sources",
];

/**
 * Turns a migrated database into one from the previous schema: the neutral tables
 * (and any rows they hold) give way to the GitHub-named ones.
 */
export function restorePreviousSourceSchema(db: DatabaseSync): void {
  for (const table of neutralSourceTables) db.exec(`DROP TABLE ${table}`);
  db.exec(previousSourceSchema);
}

/** An in-memory database with its projects, in the previous source schema and holding no source rows. */
export function previousSchemaDatabase(projectCount = 1) {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectIds = Array.from({ length: projectCount }, (_, index) => {
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: `Previous ${index + 1}`,
      leadProfileId: null,
    });
    return projectId;
  });
  restorePreviousSourceSchema(db);
  return { db, domain, projectId: projectIds[0] as string, projectIds };
}

/** Imports one issue as a task into a previous-schema database. */
export function seedPreviousIssue(
  db: DatabaseSync,
  projectId: string,
  nodeId: string,
  state: "open" | "closed" = "open",
): string {
  const taskId = randomUUID();
  db.prepare("INSERT INTO tasks (id, projectId, title) VALUES (?, ?, ?)").run(
    taskId,
    projectId,
    "Imported",
  );
  db.prepare(
    "INSERT INTO domain_tasks (id, projectId, version, outcome, ready, state, importedBlockers) VALUES (?, ?, 1, 'Body', 0, ?, 'unknown')",
  ).run(taskId, projectId, state === "open" ? "open" : "done");
  db.prepare(
    "INSERT INTO github_external_issues VALUES ('github.com', ?, ?, 'R1', 'owner/repo', 1, 'Imported', 'Body', ?, '[]')",
  ).run(nodeId, taskId, state);
  return taskId;
}
