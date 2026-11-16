import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type Database, transaction } from "./store.js";
import { assertOwnedTaskWritable } from "./project-lifecycle.js";
import { DomainConflictError } from "./domain-errors.js";

export const inboxLifecycleSchema = z
  .object({
    status: z.enum(["actionable", "resolved", "dismissed"]),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    resolvedAt: z.number().int().nonnegative().nullable(),
    resolution: z.string().max(4096).nullable(),
    dismissedAt: z.number().int().nonnegative().nullable(),
    note: z.string().max(4096).nullable(),
  })
  .strict();
const rowSchema = inboxLifecycleSchema.extend({
  id: z.string().min(1).max(128),
  taskId: z.uuid().nullable(),
  kind: z.enum([
    "question",
    "approval",
    "intervention",
    "runtime",
    "result-review",
    "workspace-maintenance",
  ]),
  sourceKey: z.string(),
  dataJson: z.string(),
  obsolete: z.union([z.literal(0), z.literal(1)]),
});
export type InboxEpisode = z.infer<typeof rowSchema>;

/** The installation's one workspace maintenance episode: a fixed id and source key. */
export const workspaceMaintenanceInboxId = "workspace-maintenance";

/** Why a workspace blocks maintenance: cab's own fixed codes, never paths or Git output. */
export const workspaceMaintenanceReasons = [
  "task-open",
  "unsettled",
  "uncommitted",
  "pending-result",
  "push-refused",
  "history",
  "delivery-unsettled",
  "maintenance-held",
  "project-read-only",
  "clock-unknown",
  "unmeasured",
  "removal-off",
  "refused",
] as const;
export type WorkspaceMaintenanceReason =
  (typeof workspaceMaintenanceReasons)[number];
/** Stored blockers are bounded; the pass keeps the oldest-idle first. */
export const workspaceMaintenanceBlockerLimit = 50;
export const workspaceMaintenanceAttentionSchema = z.strictObject({
  /** Set while measured usage stays over the disk cap after a pass. */
  usage: z
    .strictObject({
      measuredBytes: z.number().int().nonnegative().safe(),
      capBytes: z.number().int().positive().safe(),
    })
    .nullable(),
  blockers: z
    .array(
      z.strictObject({
        taskId: z.uuid(),
        workspaceId: z.uuid(),
        condition: z.enum(["disk-cap", "retention"]),
        reason: z.enum(workspaceMaintenanceReasons),
      }),
    )
    .max(workspaceMaintenanceBlockerLimit),
});
export type WorkspaceMaintenanceAttention = z.infer<
  typeof workspaceMaintenanceAttentionSchema
>;

/** Visibility is independent of answers, scheduling and execution ownership. */
export class InboxLifecycle {
  constructor(private readonly db: Database) {}

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox_lifecycle (
      id TEXT PRIMARY KEY, taskId TEXT REFERENCES domain_tasks(id),
      kind TEXT NOT NULL, sourceKey TEXT NOT NULL UNIQUE, dataJson TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('actionable','resolved','dismissed')),
      revision INTEGER NOT NULL, createdAt INTEGER NOT NULL,
      resolvedAt INTEGER, resolution TEXT, dismissedAt INTEGER, note TEXT,
      obsolete INTEGER NOT NULL DEFAULT 0 CHECK(obsolete IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS inbox_lifecycle_receipts (
      key TEXT PRIMARY KEY, taskId TEXT REFERENCES domain_tasks(id), itemId TEXT NOT NULL,
      payloadHash TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_lifecycle_task ON inbox_lifecycle(taskId);`);
  }

  rows(taskId?: string): InboxEpisode[] {
    return this.db
      .prepare(
        `SELECT * FROM inbox_lifecycle${taskId ? " WHERE taskId=?" : ""}`,
      )
      .all(...(taskId ? [taskId] : []))
      .map((row) => rowSchema.parse(row));
  }

  get(id: string): InboxEpisode | undefined {
    const row = this.db
      .prepare("SELECT * FROM inbox_lifecycle WHERE id=?")
      .get(id);
    return row ? rowSchema.parse(row) : undefined;
  }

  observe(input: {
    id?: string;
    taskId: string | null;
    kind: InboxEpisode["kind"];
    sourceKey: string;
    data?: unknown;
    createdAt?: number;
  }): InboxEpisode {
    this.db
      .prepare(`INSERT OR IGNORE INTO inbox_lifecycle
      (id,taskId,kind,sourceKey,dataJson,status,revision,createdAt)
      VALUES (?,?,?,?,?,'actionable',1,?)`)
      .run(
        input.id ?? randomUUID(),
        input.taskId,
        input.kind,
        input.sourceKey,
        JSON.stringify(input.data ?? {}),
        input.createdAt ?? Date.now(),
      );
    return rowSchema.parse(
      this.db
        .prepare("SELECT * FROM inbox_lifecycle WHERE sourceKey=?")
        .get(input.sourceKey),
    );
  }

  /**
   * Refreshes the installation's maintenance episode in place: inserts it, updates its blockers,
   * or reactivates the same item after it resolved. Question and approval rows never come here.
   */
  refreshWorkspaceMaintenance(
    attention: WorkspaceMaintenanceAttention,
    at = Date.now(),
  ): InboxEpisode {
    const data = JSON.stringify(
      workspaceMaintenanceAttentionSchema.parse(attention),
    );
    return transaction(this.db, () => {
      const row = this.get(workspaceMaintenanceInboxId);
      if (!row)
        this.db
          .prepare(`INSERT INTO inbox_lifecycle
          (id,taskId,kind,sourceKey,dataJson,status,revision,createdAt)
          VALUES (?,NULL,'workspace-maintenance',?,?,'actionable',1,?)`)
          .run(
            workspaceMaintenanceInboxId,
            workspaceMaintenanceInboxId,
            data,
            at,
          );
      else if (row.kind !== "workspace-maintenance" || row.taskId !== null)
        throw new DomainConflictError("Maintenance Inbox identity is taken");
      else if (row.status !== "actionable")
        // A recurrence is a new active episode of the same item: its createdAt starts it.
        this.db
          .prepare(`UPDATE inbox_lifecycle SET status='actionable',dataJson=?,createdAt=?,
          revision=revision+1,resolvedAt=NULL,resolution=NULL,dismissedAt=NULL,note=NULL,obsolete=0
          WHERE id=?`)
          .run(data, at, row.id);
      else if (row.dataJson !== data)
        this.db
          .prepare(
            "UPDATE inbox_lifecycle SET dataJson=?,revision=revision+1 WHERE id=?",
          )
          .run(data, row.id);
      return this.get(workspaceMaintenanceInboxId)!;
    });
  }

  /** The maintenance episode's validated data, or undefined while it was never raised. */
  workspaceMaintenance():
    | { row: InboxEpisode; attention: WorkspaceMaintenanceAttention }
    | undefined {
    const row = this.get(workspaceMaintenanceInboxId);
    if (row?.kind !== "workspace-maintenance") return undefined;
    return {
      row,
      attention: workspaceMaintenanceAttentionSchema.parse(
        JSON.parse(row.dataJson),
      ),
    };
  }

  /** Inside project deletion's transaction: drops the deleted tasks' blocker references only. */
  pruneWorkspaceMaintenance(taskIds: readonly string[]): void {
    const current = this.workspaceMaintenance();
    if (!current) return;
    const deleted = new Set(taskIds);
    const blockers = current.attention.blockers.filter(
      (b) => !deleted.has(b.taskId),
    );
    if (blockers.length === current.attention.blockers.length) return;
    this.db
      .prepare(
        "UPDATE inbox_lifecycle SET dataJson=?,revision=revision+1 WHERE id=?",
      )
      .run(JSON.stringify({ ...current.attention, blockers }), current.row.id);
  }

  resolve(id: string, reason: string, obsolete = false) {
    this.db
      .prepare(`UPDATE inbox_lifecycle SET status='resolved',resolution=?,resolvedAt=?,obsolete=?,revision=revision+1
      WHERE id=? AND status<>'resolved'`)
      .run(reason, Date.now(), obsolete ? 1 : 0, id);
  }

  change(
    id: string,
    revision: number,
    action: "dismiss" | "restore",
    note?: string,
  ) {
    const row = this.get(id);
    if (
      !row ||
      row.revision !== revision ||
      row.status !== (action === "dismiss" ? "actionable" : "dismissed")
    )
      throw new DomainConflictError(
        "Inbox item changed; refresh before trying again",
      );
    // Dismissal must not hide an unresolved disk or retention warning; it clears when resolved.
    if (row.kind === "workspace-maintenance")
      throw new DomainConflictError(
        "Workspace maintenance attention clears once resolved and cannot be dismissed",
      );
    this.db
      .prepare(
        `UPDATE inbox_lifecycle SET status=?,revision=revision+1,dismissedAt=?,note=? WHERE id=?`,
      )
      .run(
        action === "dismiss" ? "dismissed" : "actionable",
        action === "dismiss" ? Date.now() : row.dismissedAt,
        action === "dismiss" ? (note ?? null) : row.note,
        id,
      );
    return this.get(id)!;
  }

  receipt(key: string, input?: unknown) {
    const row = this.db
      .prepare(
        "SELECT payloadHash,result FROM inbox_lifecycle_receipts WHERE key=?",
      )
      .get(key) as { payloadHash: string; result: string } | undefined;
    if (!row) return undefined;
    if (
      input !== undefined &&
      row.payloadHash !==
        createHash("sha256").update(JSON.stringify(input)).digest("hex")
    )
      throw new DomainConflictError(
        "Inbox command key reused with different content",
      );
    return JSON.parse(row.result) as unknown;
  }

  command(
    input: {
      type: "inbox.dismiss" | "inbox.restore";
      key: string;
      itemId: string;
      expectedRevision: number;
      note?: string | undefined;
    },
    eligible: () => void,
  ) {
    return transaction(this.db, () => {
      const prior = this.receipt(input.key, input);
      if (prior) return prior;
      const current = this.get(input.itemId);
      if (current?.taskId) assertOwnedTaskWritable(this.db, current.taskId);
      eligible();
      const row = this.change(
        input.itemId,
        input.expectedRevision,
        input.type === "inbox.dismiss" ? "dismiss" : "restore",
        input.note,
      );
      const result = {
        kind: "inbox",
        key: input.key,
        recorded: true,
        itemId: row.id,
        revision: row.revision,
        status: row.status,
      };
      this.db
        .prepare(
          "INSERT INTO inbox_lifecycle_receipts (key,taskId,itemId,payloadHash,result) VALUES (?,?,?,?,?)",
        )
        .run(
          input.key,
          row.taskId,
          row.id,
          createHash("sha256").update(JSON.stringify(input)).digest("hex"),
          JSON.stringify(result),
        );
      return result;
    });
  }

  required(interactionId: string): boolean {
    const row = this.get(interactionId);
    return row?.status !== "dismissed" && row?.obsolete !== 1;
  }

  obsolete(interactionId: string): boolean {
    return this.get(interactionId)?.obsolete === 1;
  }
}
