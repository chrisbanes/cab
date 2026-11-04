import {
  capturedRepositoryIdentitySchema,
  projectCleanupId,
} from "./project-cleanup-identities.js";
import { repositoryLinkListSchema } from "../core/repository-links.js";
import { RedactionLimitError } from "../core/redaction-limits.js";
import { z } from "zod";
import { transaction, type Database } from "../core/store.js";
import { materialDigest, prBindingSchema } from "../core/delivery.js";
import { projectDeletionCommandResultSchema } from "../core/command-results.js";
import {
  DomainConflictError,
  DomainNotFoundError,
} from "../core/domain-errors.js";
import { DeletedProjectRedactionStore } from "../core/deleted-project-redaction.js";
import {
  ProjectArchiveBlockedError,
  projectDeleteCommandSchema,
  type ArchiveBlocker,
  type ProjectDeleteCommand,
} from "../core/project-lifecycle.js";
import {
  captureDeletionOwnership,
  assertProjectRowsRemoved,
  deletionQuery,
  type ProjectOwnership,
} from "./project-deletion-ownership.js";
import { projectDeletionStatements } from "./project-deletion-sql.js";
import {
  captureDeletionCleanup,
  deletionWorktreeStatusSchema,
} from "./project-deletion-capture.js";
import type { DeletionPrivateInputs } from "./project-deletion-private.js";
import { repositoryBindingSchema, taskWorkspaceSchema } from "./workspaces.js";

const id = z.string().uuid();
const identity = z.string().min(1).max(512);
const absolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"));
const filesystemIdentity = z.union([
  z
    .object({
      device: identity,
      inode: identity,
      ownerUid: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ unavailable: z.literal(true) }).strict(),
]);

/** Private captured identities, never executable commands or a public read projection. */
export const capturedProjectCleanupSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace"),
      binding: taskWorkspaceSchema
        .extend({ repositories: z.array(repositoryBindingSchema.strict()) })
        .strict(),
      managedRoot: absolutePath,
      filesystem: filesystemIdentity,
      gitIdentities: z.array(capturedRepositoryIdentitySchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("claude-temp"),
      path: absolutePath,
      workspacePath: absolutePath.optional(),
      canonicalPath: absolutePath.optional(),
      taskId: identity,
      workspaceId: id,
      filesystem: filesystemIdentity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex-thread"),
      threadId: identity,
      harness: z.literal("codex"),
      codexHome: z.literal("cab"),
    })
    .strict(),
]);
export type CapturedProjectCleanup = z.output<
  typeof capturedProjectCleanupSchema
>;
const cleanupItemSchema = z.discriminatedUnion("state", [
  z
    .object({
      id,
      kind: z.enum(["workspace", "claude-temp", "codex-thread"]),
      state: z.literal("pending"),
      captured: capturedProjectCleanupSchema,
      gitRemoval: z
        .object({
          repositoryId: z.string().min(1).max(512),
          capturedDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .optional(),
      reason: z.enum([
        "not-attempted",
        "unavailable",
        "unsafe",
        "failed",
        "unknown",
      ]),
    })
    .strict(),
  // Completion deliberately drops every captured path and binding.
  z
    .object({
      id,
      kind: z.enum(["workspace", "claude-temp", "codex-thread"]),
      state: z.literal("complete"),
    })
    .strict(),
]);
export const projectCleanupSchema = z
  .object({ version: z.literal(1), items: z.array(cleanupItemSchema) })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.items.map((item) => item.id)).size !== value.items.length)
      context.addIssue({
        code: "custom",
        message: "Duplicate project cleanup identity",
      });
    for (const item of value.items) {
      if (
        item.state === "pending" &&
        item.gitRemoval &&
        (item.captured.kind !== "workspace" ||
          item.gitRemoval.capturedDigest !== materialDigest(item.captured) ||
          !item.captured.binding.repositories.some(
            (repo) => repo.repositoryId === item.gitRemoval!.repositoryId,
          ))
      )
        context.addIssue({
          code: "custom",
          message: "Invalid captured Git removal reservation",
        });
    }
    for (const item of value.items) {
      if (
        item.state === "pending" &&
        item.captured.kind === "codex-thread" &&
        item.id !== projectCleanupId("codex-thread", item.captured.threadId)
      )
        context.addIssue({
          code: "custom",
          message: "Invalid captured thread cleanup identity",
        });
    }
    for (const item of value.items)
      if (item.state === "pending" && item.kind !== item.captured.kind)
        context.addIssue({
          code: "custom",
          message: "Project cleanup kind mismatch",
        });
  });
export type ProjectCleanup = z.output<typeof projectCleanupSchema>;

const counts = z
  .object({
    tasks: z.number().int().nonnegative(),
    assignments: z.number().int().nonnegative(),
    worktrees: z.number().int().nonnegative(),
  })
  .strict();
const externalRemnant = z
  .object({
    codeHost: z.enum(["github", "gitlab"]),
    host: identity,
    repositoryId: identity,
    branch: identity.nullable(),
    changeRequestId: identity.nullable(),
  })
  .strict();
const deletionResult = projectDeletionCommandResultSchema;
const tombstone = z
  .object({
    projectId: id,
    name: z.string().min(1).max(512),
    deletedAt: z.string().datetime(),
    actor: z.literal("operator"),
    counts,
    externalRemnants: z.array(externalRemnant),
    commandKey: id,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    result: deletionResult,
    cleanup: projectCleanupSchema,
  })
  .strict();
export type ProjectTombstone = z.output<typeof tombstone>;

/** Durable deletion receipt and captured cleanup; no physical effect occurs in this store. */
export class ProjectTombstones {
  constructor(
    private readonly db: Database,
    initialize = true,
  ) {
    if (initialize)
      db.exec(`CREATE TABLE IF NOT EXISTS project_tombstones (
      projectId TEXT PRIMARY KEY, name TEXT NOT NULL, deletedAt TEXT NOT NULL, actor TEXT NOT NULL,
      countsJson TEXT NOT NULL, externalRemnantsJson TEXT NOT NULL, commandKey TEXT NOT NULL,
      payloadHash TEXT NOT NULL, resultJson TEXT NOT NULL, cleanupJson TEXT NOT NULL,
      cleanupState TEXT NOT NULL CHECK(cleanupState IN ('pending','complete'))
    )`);
  }

  recordWithinTransaction(input: ProjectTombstone): void {
    if (!this.db.isTransaction)
      throw new Error("Project deletion requires a transaction");
    const value = tombstone.parse(input);
    if (
      value.result.projectId !== value.projectId ||
      value.result.deletedAt !== value.deletedAt
    )
      throw new Error("Project delete receipt identity mismatch");
    this.db
      .prepare(`INSERT INTO project_tombstones
      (projectId,name,deletedAt,actor,countsJson,externalRemnantsJson,commandKey,payloadHash,resultJson,cleanupJson,cleanupState)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        value.projectId,
        value.name,
        value.deletedAt,
        value.actor,
        JSON.stringify(value.counts),
        JSON.stringify(value.externalRemnants),
        value.commandKey,
        value.payloadHash,
        JSON.stringify(value.result),
        JSON.stringify(value.cleanup),
        value.cleanup.items.every((item) => item.state === "complete")
          ? "complete"
          : "pending",
      );
  }

  /** Replays only the minimal immutable receipt, before any live-project lookup. */
  replay(
    projectId: string,
    commandKey: string,
    payloadHash: string,
  ): z.output<typeof deletionResult> | undefined {
    const row = this.db
      .prepare(
        "SELECT commandKey, payloadHash, resultJson FROM project_tombstones WHERE projectId = ?",
      )
      .get(projectId) as
      | { commandKey: string; payloadHash: string; resultJson: string }
      | undefined;
    if (!row) return undefined;
    if (row.commandKey !== commandKey || row.payloadHash !== payloadHash)
      throw new DomainConflictError("Project delete command key conflict");
    return deletionResult.parse(JSON.parse(row.resultJson));
  }

  recordedResult(projectId: string, key: string) {
    const row = this.db
      .prepare(
        "SELECT resultJson FROM project_tombstones WHERE projectId=? AND commandKey=?",
      )
      .get(id.parse(projectId), id.parse(key)) as
      | { resultJson: string }
      | undefined;
    return row ? deletionResult.parse(JSON.parse(row.resultJson)) : undefined;
  }

  status(projectId: string) {
    id.parse(projectId);
    const row = this.db
      .prepare(
        "SELECT projectId,name,deletedAt,countsJson,externalRemnantsJson,resultJson,cleanupJson FROM project_tombstones WHERE projectId=?",
      )
      .get(projectId) as
      | {
          projectId: string;
          name: string;
          deletedAt: string;
          countsJson: string;
          externalRemnantsJson: string;
          resultJson: string;
          cleanupJson: string;
        }
      | undefined;
    if (!row) return undefined;
    const cleanup = projectCleanupSchema.parse(JSON.parse(row.cleanupJson));
    return {
      projectId: row.projectId,
      name: row.name,
      deletedAt: row.deletedAt,
      counts: counts.parse(JSON.parse(row.countsJson)),
      externalRemnants: z
        .array(externalRemnant)
        .parse(JSON.parse(row.externalRemnantsJson)),
      result: deletionResult.parse(JSON.parse(row.resultJson)),
      cleanup: cleanup.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        state: item.state,
        ...(item.state === "pending" ? { reason: item.reason } : {}),
      })),
    };
  }

  /** Only the cleanup runner reads this payload; never expose it through operator get. */
  pendingCleanup(): { projectId: string; cleanup: ProjectCleanup }[] {
    return this.db
      .prepare(
        "SELECT projectId, cleanupJson FROM project_tombstones WHERE cleanupState = 'pending' ORDER BY deletedAt, projectId LIMIT 16",
      )
      .all()
      .map((input) => {
        const row = z
          .object({ projectId: id, cleanupJson: z.string() })
          .strict()
          .parse(input);
        return {
          projectId: row.projectId,
          cleanup: projectCleanupSchema.parse(JSON.parse(row.cleanupJson)),
        };
      });
  }

  pendingCleanupProject(
    projectId: string,
  ): { projectId: string; cleanup: ProjectCleanup } | undefined {
    const row = this.db
      .prepare(
        "SELECT cleanupJson FROM project_tombstones WHERE projectId=? AND cleanupState='pending'",
      )
      .get(projectId) as { cleanupJson: string } | undefined;
    return row
      ? {
          projectId: id.parse(projectId),
          cleanup: projectCleanupSchema.parse(JSON.parse(row.cleanupJson)),
        }
      : undefined;
  }

  pendingCleanupPage(
    afterProjectId?: string,
  ): { projectId: string; cleanup: ProjectCleanup }[] {
    return (
      this.db
        .prepare(
          "SELECT projectId,cleanupJson FROM project_tombstones WHERE cleanupState='pending' AND projectId>? ORDER BY projectId LIMIT 16",
        )
        .all(afterProjectId ?? "") as {
        projectId: string;
        cleanupJson: string;
      }[]
    ).map((row) => ({
      projectId: id.parse(row.projectId),
      cleanup: projectCleanupSchema.parse(JSON.parse(row.cleanupJson)),
    }));
  }

  retainCleanupWithinTransaction(
    projectId: string,
    itemId: string,
    reason?: "unsafe" | "unavailable" | "failed" | "unknown",
  ): void {
    if (!this.db.isTransaction)
      throw new Error("Project cleanup checkpoint requires a transaction");
    const row = this.db
      .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId=?")
      .get(projectId) as { cleanupJson: string } | undefined;
    if (!row) throw new Error("Unknown project tombstone");
    const cleanup = projectCleanupSchema.parse(JSON.parse(row.cleanupJson));
    const item = cleanup.items.find((value) => value.id === itemId);
    if (item?.state !== "pending") return;
    // Rotate blocked work durably, including across restart. With no new outcome,
    // preserve the current reservation and reason rather than applying a stale snapshot.
    cleanup.items = [
      ...cleanup.items.filter((value) => value.id !== itemId),
      reason === undefined ? item : { ...item, reason },
    ];
    this.db
      .prepare("UPDATE project_tombstones SET cleanupJson=? WHERE projectId=?")
      .run(JSON.stringify(cleanup), projectId);
  }

  /** A private, captured-identity-bound write-ahead reservation; no parent rows are needed. */
  checkpointWorkspaceRemovalWithinTransaction(
    projectId: string,
    itemId: string,
    capturedDigest: string,
    repositoryId: string,
    phase: "begin" | "settled",
  ): boolean {
    if (!this.db.isTransaction)
      throw new Error("Project cleanup checkpoint requires a transaction");
    const row = this.pendingCleanupProject(projectId);
    if (!row) return false;
    const item = row.cleanup.items.find((value) => value.id === itemId);
    if (
      item?.state !== "pending" ||
      item.captured.kind !== "workspace" ||
      materialDigest(item.captured) !== capturedDigest ||
      !item.captured.binding.repositories.some(
        (repo) => repo.repositoryId === repositoryId,
      )
    )
      return false;
    if (phase === "begin") {
      if (item.gitRemoval || item.reason === "unknown") return false;
      item.gitRemoval = { repositoryId, capturedDigest };
      item.reason = "unknown";
    } else {
      if (
        item.gitRemoval?.repositoryId !== repositoryId ||
        item.gitRemoval.capturedDigest !== capturedDigest
      )
        return false;
      delete item.gitRemoval;
      item.reason = "failed";
    }
    this.db
      .prepare("UPDATE project_tombstones SET cleanupJson=? WHERE projectId=?")
      .run(JSON.stringify(projectCleanupSchema.parse(row.cleanup)), projectId);
    return true;
  }

  completeCleanupWithinTransaction(projectId: string, itemId: string): void {
    if (!this.db.isTransaction)
      throw new Error("Project cleanup checkpoint requires a transaction");
    const row = this.db
      .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId = ?")
      .get(projectId) as { cleanupJson: string } | undefined;
    if (!row) throw new Error("Unknown project tombstone");
    const cleanup = projectCleanupSchema.parse(JSON.parse(row.cleanupJson));
    const item = cleanup.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error("Unknown project cleanup identity");
    if (
      item.state === "pending" &&
      item.captured.kind === "workspace" &&
      (item.gitRemoval || item.reason === "unknown")
    )
      throw new Error("Captured Git removal has no settlement checkpoint");
    cleanup.items = cleanup.items.map((entry) =>
      entry.id === itemId
        ? { id: entry.id, kind: entry.kind, state: "complete" as const }
        : entry,
    );
    this.db
      .prepare(
        "UPDATE project_tombstones SET cleanupJson = ?, cleanupState = ? WHERE projectId = ?",
      )
      .run(
        JSON.stringify(cleanup),
        cleanup.items.every((entry) => entry.state === "complete")
          ? "complete"
          : "pending",
        projectId,
      );
  }
}

/** Explicit ownership joins, captured before any parent rows are removed. No deletion effects. */
const ownership = `WITH owner AS (SELECT ? AS projectId),
  owned_tasks AS (SELECT id FROM domain_tasks WHERE projectId = (SELECT projectId FROM owner)
    UNION SELECT id FROM tasks WHERE projectId = (SELECT projectId FROM owner)),
  owned_assignments AS (SELECT id FROM domain_assignments WHERE projectId = (SELECT projectId FROM owner) OR taskId IN (SELECT id FROM owned_tasks)),
  owned_drafts AS (SELECT runId AS id FROM drafting_runs WHERE projectId = (SELECT projectId FROM owner) OR taskId IN (SELECT id FROM owned_tasks)),
  owned_work AS (SELECT workId AS id FROM turn_requests WHERE projectId = (SELECT projectId FROM owner) OR taskId IN (SELECT id FROM owned_tasks) OR taskId IN (SELECT id FROM owned_drafts) OR assignmentId IN (SELECT id FROM owned_assignments)
    UNION SELECT workId FROM task_execution_bindings WHERE taskId IN (SELECT id FROM owned_tasks) OR assignmentId IN (SELECT id FROM owned_assignments)
    UNION SELECT workId FROM diagnostic_executions WHERE projectId = (SELECT projectId FROM owner) OR taskId IN (SELECT id FROM owned_tasks) OR assignmentId IN (SELECT id FROM owned_assignments))`;

export function captureProjectOwnership(db: Database, projectId: string) {
  id.parse(projectId);
  if (!db.isTransaction)
    throw new Error("Project ownership capture requires a transaction");
  const read = (
    table: "owned_tasks" | "owned_assignments" | "owned_drafts" | "owned_work",
  ) =>
    db
      .prepare(`${ownership} SELECT id FROM ${table} ORDER BY id`)
      .all(projectId)
      .map((row) => z.object({ id: identity }).strict().parse(row).id);
  const tasks = read("owned_tasks"),
    assignments = read("owned_assignments"),
    drafts = read("owned_drafts"),
    work = read("owned_work");
  const intents = db
    .prepare(
      `${ownership} SELECT id FROM execution_intents WHERE workId IN (SELECT id FROM owned_work) ORDER BY id`,
    )
    .all(projectId)
    .map((row) => z.object({ id: identity }).strict().parse(row).id);
  const external = db
    .prepare(
      `${ownership} SELECT provider, instance, externalId FROM external_items WHERE taskId IN (SELECT id FROM owned_tasks) ORDER BY provider, instance, externalId`,
    )
    .all(projectId)
    .map((row) =>
      z
        .object({
          provider: identity,
          instance: identity,
          externalId: identity,
        })
        .strict()
        .parse(row),
    );
  return { projectId, tasks, assignments, drafts, work, intents, external };
}

const previewSchema = z
  .object({
    projectId: id,
    version: z.number().int().positive(),
    name: z.string().min(1).max(512),
    archived: z.literal(true),
    counts,
    worktrees: z.array(deletionWorktreeStatusSchema),
    affectedProjects: z.array(
      z.object({ projectId: id, name: z.string() }).strict(),
    ),
    externalRemnants: z.array(externalRemnant),
    previewDigest: z.string().length(64),
    forceDiscard: z.literal(true),
    outsideDiscovery: z.literal("recorded-identities-only"),
  })
  .strict();
export type ProjectDeletionPreview = z.output<typeof previewSchema>;
export const projectDeletionFaultPhases = [
  "ledger",
  "tombstone",
  "diagnostic-accounting",
  ...projectDeletionStatements.map((s) => `delete:${s.table}`),
  "postcondition",
] as const;
interface DeletionOptions {
  roots: { task: string; drafting: string };
  drain: (projectId: string) => readonly ArchiveBlocker[];
  privateInputs: (
    owner: ProjectOwnership,
    paths: readonly string[],
  ) => Promise<DeletionPrivateInputs>;
  gitExecutable?: string | undefined;
  signal?: AbortSignal | undefined;
  now?: () => Date;
  /** Trusted fault/race fixtures only; never accepted from an operator request. */
  phase?: (phase: string) => void;
  beforeCommit?: () => Promise<void>;
}
function foreignKeys(db: Database) {
  if (
    (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys !== 1
  )
    throw new Error("Project deletion requires foreign keys enabled");
}
function projectRecord(db: Database, projectId: string) {
  const row = db
    .prepare(
      "SELECT id,name,version,paused,archived FROM domain_projects WHERE id=?",
    )
    .get(projectId);
  if (!row) throw new DomainNotFoundError();
  const value = z
    .object({
      id,
      name: z.string().min(1).max(512),
      version: z.number().int().positive(),
      paused: z.union([z.literal(0), z.literal(1)]),
      archived: z.union([z.literal(0), z.literal(1)]),
    })
    .strict()
    .parse(row);
  if (!value.archived || !value.paused)
    throw new DomainConflictError(
      "Archive and drain the project before deleting it",
    );
  return value;
}
function consequences(owner: ProjectOwnership) {
  const projectId = String(owner.parameters.projectId);
  const links = (owner.rows.project_repository_links ?? []).flatMap((row) =>
    repositoryLinkListSchema.parse(JSON.parse(String(row.links))),
  );
  const host = (repositoryId: string) => {
    const link = links.find((entry) => entry.repositoryId === repositoryId);
    if (!link)
      throw new Error("Retained branch repository identity is unavailable");
    return { codeHost: link.codeHost, host: link.host, repositoryId };
  };
  const branches = (owner.rows.delivery_task_branches ?? []).map((row) => ({
    taskId: String(row.taskId),
    ...host(String(row.repositoryId)),
    branch: String(row.branch),
  }));
  const prs = (owner.rows.delivery_pr_bindings ?? []).map((row) =>
    prBindingSchema.parse(JSON.parse(String(row.recordJson))),
  );
  const externalRemnants = [
    ...branches.map((row) => ({
      ...host(row.repositoryId),
      branch: row.branch,
      changeRequestId:
        prs.find(
          (pr) =>
            pr.taskId === row.taskId &&
            pr.observation.repositoryId === row.repositoryId,
        )?.observation.nodeId ?? null,
    })),
    ...prs
      .filter(
        (pr) =>
          !branches.some(
            (b) =>
              b.taskId === pr.taskId &&
              b.repositoryId === pr.observation.repositoryId,
          ),
      )
      .map((pr) => ({
        ...host(pr.observation.repositoryId),
        branch: pr.observation.headRef,
        changeRequestId: pr.observation.nodeId,
      })),
  ].map((row) => externalRemnant.parse(row));
  const affectedProjectIds = [
    ...new Set(
      (owner.rows.source_memberships ?? [])
        .map((row) => String(row.projectId))
        .filter((id) => id !== projectId),
    ),
  ].sort();
  return { externalRemnants, affectedProjectIds };
}

/** Explicit SQL traversal shared with the exhaustive ownership/rollback fixture. */
export function deleteCapturedProjectRowsWithinTransaction(
  db: Database,
  owner: ProjectOwnership,
  phase?: (phase: string) => void,
) {
  if (!db.isTransaction)
    throw new Error("Project deletion requires a transaction");
  foreignKeys(db);
  const byteValues = (owner.rows.diagnostic_items ?? []).map((row) =>
    z.number().int().nonnegative().safe().parse(row.payloadBytes),
  );
  const bytes = byteValues.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(bytes))
    throw new Error("Diagnostic accounting is unavailable");
  const usage = db
    .prepare("SELECT totalBytes FROM diagnostic_usage WHERE id=1")
    .get() as { totalBytes: number } | undefined;
  const actual = db
    .prepare(
      "SELECT COALESCE(SUM(payloadBytes),0) AS totalBytes FROM diagnostic_items",
    )
    .get() as { totalBytes: number };
  if (
    !usage ||
    usage.totalBytes !== actual.totalBytes ||
    !Number.isSafeInteger(usage.totalBytes) ||
    usage.totalBytes < bytes
  )
    throw new Error("Diagnostic accounting is unavailable");
  db.prepare(
    "UPDATE diagnostic_usage SET totalBytes=totalBytes-? WHERE id=1",
  ).run(bytes);
  phase?.("diagnostic-accounting");
  for (const statement of projectDeletionStatements) {
    const query = deletionQuery(statement.sql, owner.parameters);
    db.prepare(query.sql).run(...query.parameters);
    phase?.(`delete:${statement.table}`);
  }
  assertProjectRowsRemoved(db, owner);
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Project deletion left invalid references");
  phase?.("postcondition");
}

/** No cleanup/provider effect: prepares observations, then commits one synchronous transaction. */
export class ProjectDeletionUnavailableError extends Error {
  readonly code = "unavailable";
  constructor() {
    super("Project deletion preparation is unavailable");
  }
}
export class ProjectDeletion {
  private readonly tombstones: ProjectTombstones;
  private readonly ledger: DeletedProjectRedactionStore;
  constructor(
    private readonly db: Database,
    private readonly options: DeletionOptions,
  ) {
    this.tombstones = new ProjectTombstones(db, false);
    this.ledger = new DeletedProjectRedactionStore(db, false);
  }
  private capture(projectId: string) {
    foreignKeys(this.db);
    return transaction(this.db, () => ({
      project: projectRecord(this.db, projectId),
      owner: captureDeletionOwnership(this.db, projectId),
    }));
  }
  private envelope(
    capture: ReturnType<ProjectDeletion["capture"]>,
    physical: Awaited<ReturnType<typeof captureDeletionCleanup>>,
  ) {
    const { project, owner } = capture,
      remnants = consequences(owner);
    const affectedProjects = remnants.affectedProjectIds.map((projectId) => {
      const row = this.db
        .prepare("SELECT name FROM domain_projects WHERE id=?")
        .get(projectId) as { name: string } | undefined;
      if (!row) throw new Error("Selecting project identity is unavailable");
      return { projectId, name: row.name };
    });
    const countsValue = {
      tasks: (owner.parameters.tasks as string[]).length,
      assignments: (owner.parameters.assignments as string[]).length,
      worktrees: physical.worktrees.length,
    };
    const digest = materialDigest({
      project,
      ownership: owner.digest,
      cleanup: physical.cleanup,
      counts: countsValue,
      externalRemnants: remnants.externalRemnants,
      affectedProjects,
    });
    return previewSchema.parse({
      projectId: project.id,
      version: project.version,
      name: project.name,
      archived: true,
      counts: countsValue,
      worktrees: physical.worktrees,
      affectedProjects,
      externalRemnants: remnants.externalRemnants,
      previewDigest: digest,
      forceDiscard: true,
      outsideDiscovery: "recorded-identities-only",
    });
  }
  async preview(projectId: string): Promise<ProjectDeletionPreview> {
    try {
      return await this.previewPrepared(projectId);
    } catch (error) {
      if (
        error instanceof DomainConflictError ||
        error instanceof DomainNotFoundError ||
        error instanceof RedactionLimitError ||
        this.options.phase
      )
        throw error;
      throw new ProjectDeletionUnavailableError();
    }
  }
  private async previewPrepared(
    projectId: string,
  ): Promise<ProjectDeletionPreview> {
    id.parse(projectId);
    const capture = this.capture(projectId);
    const physical = await captureDeletionCleanup(
      this.db,
      capture.owner,
      this.options.roots,
      this.options.gitExecutable,
      this.options.signal,
    );
    // Recheck database identity after local inspection, without refreshing any live binding.
    const current = this.capture(projectId);
    if (
      capture.owner.digest !== current.owner.digest ||
      materialDigest(capture.project) !== materialDigest(current.project)
    )
      throw new DomainConflictError(
        "Project deletion preview changed; inspect it again",
      );
    return this.envelope(current, physical);
  }
  async delete(input: ProjectDeleteCommand) {
    try {
      return await this.deletePrepared(input);
    } catch (error) {
      if (
        error instanceof DomainConflictError ||
        error instanceof DomainNotFoundError ||
        error instanceof RedactionLimitError ||
        this.options.phase
      )
        throw error;
      throw new ProjectDeletionUnavailableError();
    }
  }
  private async deletePrepared(input: ProjectDeleteCommand) {
    const command = projectDeleteCommandSchema.parse(input),
      payloadHash = materialDigest(command);
    const replay = this.tombstones.replay(
      command.projectId,
      command.key,
      payloadHash,
    );
    if (replay) return replay;
    const capture = this.capture(command.projectId);
    if (
      capture.project.version !== command.expectedVersion ||
      capture.project.name !== command.confirmationName
    )
      throw new DomainConflictError("Project deletion confirmation is stale");
    const physical = await captureDeletionCleanup(
      this.db,
      capture.owner,
      this.options.roots,
      this.options.gitExecutable,
      this.options.signal,
    );
    const preview = this.envelope(capture, physical);
    if (preview.previewDigest !== command.previewDigest)
      throw new DomainConflictError(
        "Project deletion preview changed; inspect it again",
      );
    const privateInputs = await this.options.privateInputs(
      capture.owner,
      physical.retiring,
    );
    const ledgerFingerprint = this.ledger.fingerprint([
      ...privateInputs.live,
      ...privateInputs.retiring,
    ]);
    await this.options.beforeCommit?.();
    this.options.signal?.throwIfAborted();
    return transaction(this.db, () => {
      this.options.signal?.throwIfAborted();
      foreignKeys(this.db);
      const replay = this.tombstones.replay(
        command.projectId,
        command.key,
        payloadHash,
      );
      if (replay) return replay;
      const currentProject = projectRecord(this.db, command.projectId),
        currentOwner = captureDeletionOwnership(this.db, command.projectId);
      if (
        currentProject.version !== command.expectedVersion ||
        currentProject.name !== command.confirmationName ||
        currentOwner.digest !== capture.owner.digest ||
        materialDigest(currentProject) !== materialDigest(capture.project)
      )
        throw new DomainConflictError("Project deletion confirmation is stale");
      const currentPreview = this.envelope(
        { project: currentProject, owner: currentOwner },
        physical,
      );
      if (currentPreview.previewDigest !== command.previewDigest)
        throw new DomainConflictError(
          "Project deletion preview changed; inspect it again",
        );
      const blockers = this.options.drain(command.projectId);
      if (blockers.length) throw new ProjectArchiveBlockedError(blockers);
      if (
        privateInputs.fence() !== privateInputs.fingerprint ||
        this.ledger.fingerprint([
          ...privateInputs.live,
          ...privateInputs.retiring,
        ]) !== ledgerFingerprint
      )
        throw new DomainConflictError(
          "Project deletion private inputs changed; inspect it again",
        );
      const deletedAt = (this.options.now?.() ?? new Date()).toISOString();
      const result = deletionResult.parse({
        kind: "project-deleted",
        projectId: command.projectId,
        deletedAt,
      });
      // Lifetime credential caches are global exclusions without an owner tag. Retain the
      // validated union so an old resolved value cannot disappear on process restart.
      this.ledger.captureProject(command.projectId, privateInputs.live, [
        ...privateInputs.live,
        ...privateInputs.retiring,
      ]);
      this.options.phase?.("ledger");
      this.tombstones.recordWithinTransaction({
        projectId: command.projectId,
        name: currentProject.name,
        deletedAt,
        actor: "operator",
        counts: preview.counts,
        externalRemnants: preview.externalRemnants,
        commandKey: command.key,
        payloadHash,
        result,
        cleanup: physical.cleanup,
      });
      this.options.phase?.("tombstone");
      deleteCapturedProjectRowsWithinTransaction(
        this.db,
        currentOwner,
        this.options.phase,
      );
      return result;
    });
  }
  deleted(projectId: string) {
    return this.tombstones.status(projectId);
  }
}
