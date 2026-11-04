import { z } from "zod";
import { DomainConflictError, DomainNotFoundError } from "./domain-errors.js";
import type { Database } from "./store.js";

const flag = z.union([z.literal(0), z.literal(1)]);
const lifecycleSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    paused: flag,
    archived: flag,
  })
  .strict();
export type ProjectLifecycleSnapshot = z.output<typeof lifecycleSchema>;

export const projectDeleteCommandSchema = z
  .object({
    type: z.literal("project.delete"),
    actor: z.literal("operator"),
    key: z.string().uuid(),
    projectId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    confirmationName: z.string().min(1).max(512),
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProjectDeleteCommand = z.output<typeof projectDeleteCommandSchema>;

export class ProjectArchivedError extends DomainConflictError {
  constructor() {
    super("Archived projects are read-only");
    this.name = "ProjectArchivedError";
  }
}

export function projectLifecycle(
  db: Database,
  projectId: string,
): ProjectLifecycleSnapshot {
  const row = db
    .prepare(
      "SELECT id, version, paused, archived FROM domain_projects WHERE id = ?",
    )
    .get(projectId);
  if (!row) throw new DomainNotFoundError();
  return lifecycleSchema.parse(row);
}

export function projectAcceptsWrites(db: Database, projectId: string): boolean {
  const row = db
    .prepare(
      "SELECT id, version, paused, archived FROM domain_projects WHERE id = ?",
    )
    .get(projectId);
  return row !== undefined && lifecycleSchema.parse(row).archived === 0;
}

/** Internal enumeration remains exhaustive; write admission uses this predicate. */
export function assertProjectWritable(
  db: Database,
  projectId: string,
): ProjectLifecycleSnapshot {
  const snapshot = projectLifecycle(db, projectId);
  if (snapshot.archived) throw new ProjectArchivedError();
  return snapshot;
}

export function assertTaskProjectWritable(
  db: Database,
  taskId: string,
): ProjectLifecycleSnapshot {
  const row = db
    .prepare("SELECT projectId FROM domain_tasks WHERE id = ?")
    .get(taskId) as { projectId: string } | undefined;
  if (!row) throw new DomainNotFoundError();
  return assertProjectWritable(db, row.projectId);
}

/** Direct, unscoped executions have no project; known task/draft work always retains its owner. */
export function taskProjectId(
  db: Database,
  taskId: string,
): string | undefined {
  for (const [table, column] of [
    ["domain_tasks", "id"],
    ["drafting_runs", "runId"],
  ] as const) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
        )
        .get(table)
    )
      continue;
    const row = db
      .prepare(`SELECT projectId FROM ${table} WHERE ${column} = ?`)
      .get(taskId) as { projectId: string } | undefined;
    if (row) return row.projectId;
  }
  return undefined;
}

export function workProjectId(
  db: Database,
  workId: string,
): string | undefined {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'turn_requests'",
      )
      .get()
  ) {
    const request = db
      .prepare(
        "SELECT projectId, taskId, assignmentId FROM turn_requests WHERE workId = ?",
      )
      .get(workId) as
      | {
          projectId: string | null;
          taskId: string | null;
          assignmentId: string | null;
        }
      | undefined;
    if (request?.projectId) return request.projectId;
    if (request?.taskId) return taskProjectId(db, request.taskId);
    if (
      request?.assignmentId &&
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='domain_assignments'",
        )
        .get()
    ) {
      const assignment = db
        .prepare("SELECT projectId FROM domain_assignments WHERE id=?")
        .get(request.assignmentId) as { projectId: string } | undefined;
      if (assignment) return assignment.projectId;
    }
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_execution_bindings'",
      )
      .get()
  ) {
    const binding = db
      .prepare("SELECT taskId FROM task_execution_bindings WHERE workId = ?")
      .get(workId) as { taskId: string } | undefined;
    if (binding) return taskProjectId(db, binding.taskId);
  }
  return undefined;
}

export function taskAcceptsWrites(db: Database, taskId: string): boolean {
  const projectId = taskProjectId(db, taskId);
  return projectId === undefined || projectAcceptsWrites(db, projectId);
}

export function workAcceptsWrites(db: Database, workId: string): boolean {
  const projectId = workProjectId(db, workId);
  return projectId === undefined || projectAcceptsWrites(db, projectId);
}

export function assertOwnedTaskWritable(db: Database, taskId: string): void {
  const projectId = taskProjectId(db, taskId);
  if (projectId !== undefined) assertProjectWritable(db, projectId);
}

export function assertOwnedWorkWritable(db: Database, workId: string): void {
  const projectId = workProjectId(db, workId);
  if (projectId !== undefined) assertProjectWritable(db, projectId);
}

/** A source read can finish after archive, but cannot commit under its old lifecycle. */
export function projectLifecycleMatches(
  db: Database,
  snapshot: ProjectLifecycleSnapshot,
): boolean {
  const row = db
    .prepare(
      "SELECT id, version, paused, archived FROM domain_projects WHERE id = ?",
    )
    .get(snapshot.id);
  if (!row) return false;
  const current = lifecycleSchema.parse(row);
  return !current.archived && current.version === snapshot.version;
}

export const archiveBlockerSchema = z
  .object({
    kind: z.enum([
      "not-paused",
      "assignment",
      "execution",
      "writer-hold",
      "archival-hold",
      "recovery-hold",
      "pending-effect",
      "capacity",
      "drafting",
      "routing",
      "delivery-action",
      "change-request",
      "interaction",
      "result-destination",
      "callback",
      "provider-write",
      "publication",
      "workspace",
      "completion",
      "unavailable",
    ]),
    taskId: z.string().uuid().optional(),
    workId: z.string().min(1).max(256).optional(),
    operationId: z.string().min(1).max(256).optional(),
    reason: z.string().min(1).max(240),
  })
  .strict();
export type ArchiveBlocker = z.output<typeof archiveBlockerSchema>;
export type ProjectLifecycleFacts = (
  projectId: string,
) => readonly ArchiveBlocker[];

export class ProjectArchiveBlockedError extends DomainConflictError {
  constructor(readonly blockers: readonly ArchiveBlocker[]) {
    super("Project is not drained for archive");
    this.name = "ProjectArchiveBlockedError";
  }
}

const owned = `WITH owner AS (SELECT ? AS id),
  owned_tasks AS (SELECT id FROM domain_tasks WHERE projectId = (SELECT id FROM owner)
    UNION SELECT id FROM tasks WHERE projectId = (SELECT id FROM owner)),
  owned_assignments AS (SELECT id FROM domain_assignments WHERE projectId = (SELECT id FROM owner) OR taskId IN (SELECT id FROM owned_tasks)),
  owned_drafts AS (SELECT runId AS id FROM drafting_runs WHERE projectId = (SELECT id FROM owner) OR taskId IN (SELECT id FROM owned_tasks)),
  owned_work AS (SELECT workId FROM turn_requests WHERE projectId = (SELECT id FROM owner)
    OR taskId IN (SELECT id FROM owned_tasks) OR taskId IN (SELECT id FROM owned_drafts)
    OR assignmentId IN (SELECT id FROM owned_assignments)
    UNION SELECT workId FROM task_execution_bindings WHERE taskId IN (SELECT id FROM owned_tasks) OR assignmentId IN (SELECT id FROM owned_assignments))`;
const drainQueries: readonly [ArchiveBlocker["kind"], string, string][] = [
  [
    "assignment",
    "SELECT id AS operationId, taskId FROM domain_assignments WHERE id IN (SELECT id FROM owned_assignments) AND state != 'completed'",
    "An assignment still owns work",
  ],
  [
    "execution",
    "SELECT workId, CASE WHEN taskId IN (SELECT id FROM owned_tasks) THEN taskId ELSE NULL END AS taskId FROM turn_requests r WHERE workId IN (SELECT workId FROM owned_work) AND (state IN ('queued','active') OR (state = 'held' AND NOT EXISTS (SELECT 1 FROM execution_intents i WHERE i.workId = r.workId AND i.state IN ('completed','reconciled','resolved-failed'))))",
    "A turn request remains unfinished",
  ],
  [
    "execution",
    "SELECT workId FROM execution_intents WHERE workId IN (SELECT workId FROM owned_work) AND state NOT IN ('completed','reconciled','resolved-failed')",
    "An execution remains unfinished or uncertain",
  ],
  [
    "writer-hold",
    "SELECT taskId FROM task_writer_holds WHERE taskId IS NULL OR taskId IN (SELECT id FROM owned_tasks)",
    "Writer ownership has not been released",
  ],
  [
    "recovery-hold",
    "SELECT taskId FROM task_writer_ambiguity_holds WHERE taskId IN (SELECT id FROM owned_tasks)",
    "Writer identity is ambiguous",
  ],
  [
    "archival-hold",
    "SELECT taskId FROM task_archival_holds WHERE taskId IN (SELECT id FROM owned_tasks)",
    "Task archival has an unresolved hold",
  ],
  [
    "pending-effect",
    "SELECT workId FROM execution_pending_effects WHERE workId IN (SELECT workId FROM owned_work) AND state = 'pending'",
    "An execution effect remains pending",
  ],
  [
    "capacity",
    "SELECT workId FROM execution_capacity_reservations WHERE projectId = (SELECT id FROM owner)",
    "Execution capacity remains reserved",
  ],
  [
    "drafting",
    "SELECT runId AS operationId, taskId FROM drafting_runs WHERE projectId = (SELECT id FROM owner) AND state IN ('queued','running','stopping')",
    "A drafting run remains active",
  ],
  [
    "routing",
    "SELECT operationId, taskId FROM routing_attempt_operations WHERE projectId = (SELECT id FROM owner) AND status IN ('pending','routing')",
    "Assignment routing remains active",
  ],
  [
    "delivery-action",
    "SELECT operationId, taskId FROM delivery_actions WHERE taskId IN (SELECT id FROM owned_tasks) AND COALESCE(json_extract(recordJson,'$.state'),'UNKNOWN') NOT IN ('confirmed-success','confirmed-failure','denied')",
    "An external action remains pending or uncertain",
  ],
  [
    "change-request",
    "SELECT taskId FROM delivery_pr_bindings WHERE taskId IN (SELECT id FROM owned_tasks) AND COALESCE(json_extract(recordJson,'$.observation.state'),'UNKNOWN') NOT IN ('CLOSED','MERGED')",
    "A change request is open or its state is unknown",
  ],
  [
    "interaction",
    "SELECT interactionId AS operationId, taskId FROM coordination_interactions WHERE taskId IN (SELECT id FROM owned_tasks) AND status = 'open'",
    "An agent request remains unresolved",
  ],
  [
    "interaction",
    "SELECT b.interactionId AS operationId, b.taskId FROM delivery_approval_bindings b JOIN coordination_interactions i ON i.interactionId = b.interactionId WHERE b.taskId IN (SELECT id FROM owned_tasks) AND b.operationId IS NULL AND i.status = 'approved'",
    "An approved external action has not been resolved",
  ],
  [
    "provider-write",
    "SELECT a.threadId AS operationId FROM conversation_archives a WHERE a.state='requested' AND a.threadId IN (SELECT e.threadId FROM execution_intents e WHERE e.workId IN (SELECT workId FROM owned_work))",
    "A conversation archive has no confirmed outcome",
  ],
  [
    "publication",
    "SELECT publicationId AS operationId, taskId FROM task_publications WHERE taskId IN (SELECT id FROM owned_tasks) AND state='sending'",
    "An issue publication remains unfinished",
  ],
  [
    "callback",
    "SELECT operationId, taskId FROM coordination_local_review_operations WHERE taskId IN (SELECT id FROM owned_tasks) AND state='prepared'",
    "A local review send remains unfinished",
  ],
  [
    "callback",
    "SELECT batchId AS operationId, taskId FROM coordination_delivery_batches WHERE taskId IN (SELECT id FROM owned_tasks) AND state='queued'",
    "An inbox delivery remains queued",
  ],
  [
    "completion",
    "SELECT requestId AS operationId, taskId FROM coordination_completion_requests WHERE taskId IN (SELECT id FROM owned_tasks) AND status='pending'",
    "A completion request awaits disposition",
  ],
  [
    "recovery-hold",
    "SELECT workId, taskId FROM execution_stop_targets WHERE workId IN (SELECT workId FROM owned_work) AND terminalState='unknown'",
    "A stop target has not reached a proved terminal",
  ],
  [
    "recovery-hold",
    "SELECT workId FROM task_work_revision_ambiguities WHERE workId IN (SELECT workId FROM owned_work)",
    "A work revision remains ambiguous",
  ],
  [
    "pending-effect",
    "SELECT workId FROM task_work_revision_pending WHERE workId IN (SELECT workId FROM owned_work)",
    "A work revision awaits a durable binding",
  ],
  [
    "workspace",
    "SELECT taskId FROM task_workspace_bindings WHERE taskId IN (SELECT id FROM owned_tasks) AND (state IN ('provisioning','archiving') OR gitUncertain=1)",
    "A managed workspace operation remains unfinished or uncertain",
  ],
  [
    "workspace",
    "SELECT taskId AS operationId FROM drafting_workspace_bindings WHERE taskId IN (SELECT id FROM owned_drafts) AND (state IN ('provisioning','archiving') OR gitUncertain=1)",
    "A drafting workspace operation remains unfinished or uncertain",
  ],
  [
    "recovery-hold",
    "SELECT workId FROM execution_power_reconciliation_pending WHERE workId IN (SELECT workId FROM owned_work)",
    "Execution reconciliation remains pending after a power event",
  ],
  [
    "interaction",
    "SELECT q.interactionId AS operationId, i.taskId FROM coordination_runtime_questions q JOIN coordination_interactions i ON i.interactionId=q.interactionId WHERE i.taskId IN (SELECT id FROM owned_tasks) AND q.answerJson IS NOT NULL AND q.deliveryState IN ('sending','uncertain','held')",
    "A native answer has not reached a proved outcome",
  ],
  [
    "result-destination",
    "SELECT resultId AS operationId, taskId FROM coordination_unresolved_result_destinations WHERE taskId IN (SELECT id FROM owned_tasks) AND status = 'unresolved'",
    "A result destination remains unresolved",
  ],
];

/** Synchronous DB facts and service facts are rechecked in the archive transaction. */
export function archiveBlockers(
  db: Database,
  projectId: string,
  facts?: ProjectLifecycleFacts,
): ArchiveBlocker[] {
  if (!db.isTransaction)
    throw new Error("Archive drain requires a transaction");
  const project = projectLifecycle(db, projectId);
  const blockers: ArchiveBlocker[] = [];
  if (!project.paused)
    blockers.push({
      kind: "not-paused",
      reason: "Pause the project before archiving",
    });
  if (!facts)
    return [
      ...blockers,
      { kind: "unavailable", reason: "Project write authority is unavailable" },
    ];
  try {
    blockers.push(
      ...z.array(archiveBlockerSchema).max(256).parse(facts(projectId)),
    );
    for (const [kind, sql, reason] of drainQueries) {
      const rows = db.prepare(`${owned} ${sql} LIMIT 129`).all(projectId);
      if (rows.length > 128) {
        blockers.push({
          kind: "unavailable",
          reason: "Project drain exceeds its inspection bound",
        });
        continue;
      }
      for (const row of rows) {
        const identity = row as {
          taskId?: string | null;
          workId?: string | null;
          operationId?: string | null;
        };
        blockers.push(
          archiveBlockerSchema.parse({
            kind,
            reason,
            ...(identity.taskId ? { taskId: identity.taskId } : {}),
            ...(identity.workId ? { workId: identity.workId } : {}),
            ...(identity.operationId
              ? { operationId: identity.operationId }
              : {}),
          }),
        );
      }
    }
  } catch {
    blockers.push({
      kind: "unavailable",
      reason: "Project drain could not be established",
    });
  }
  return blockers;
}
