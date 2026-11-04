import { z } from "zod";
import type { Database } from "../core/store.js";
import { repositoryBindingSchema, taskWorkspaceSchema } from "./workspaces.js";

const id = z.string().uuid();
const identity = z.string().min(1).max(512);
const absolutePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"));
const filesystemIdentity = z
  .object({ device: identity, inode: identity })
  .strict();

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
    })
    .strict(),
  z
    .object({
      kind: z.literal("claude-temp"),
      path: absolutePath,
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
const deletionResult = z
  .object({
    kind: z.literal("project-deleted"),
    projectId: id,
    deletedAt: z.string().datetime(),
  })
  .strict();
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

/** Store preparation only; deletion/cleanup orchestration is integrated after archive freeze. */
export class ProjectTombstones {
  constructor(private readonly db: Database) {
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
        "SELECT payloadHash, resultJson FROM project_tombstones WHERE projectId = ? AND commandKey = ?",
      )
      .get(projectId, commandKey) as
      | { payloadHash: string; resultJson: string }
      | undefined;
    if (!row) return undefined;
    if (row.payloadHash !== payloadHash)
      throw new Error("Project delete command key conflict");
    return deletionResult.parse(JSON.parse(row.resultJson));
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
