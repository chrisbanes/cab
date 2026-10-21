import { z } from "zod";
import { DomainConflictError, DomainPolicyError } from "./domain-errors.js";
import { readinessSchema, selectionSchema } from "./github-source-contracts.js";
import {
  isInFlightEvent,
  readinessAccepts,
  type StatusMapping,
  type StatusMappingEvent,
  statusMappingEvents,
  statusMappingSchema,
} from "./status-mapping-contracts.js";
import type { Database } from "./store.js";
import type { DeliveryPolicy } from "./delivery.js";

/** Why a mapped option cannot be saved. */
export type StatusMappingRefusalReason =
  | "no-selection"
  | "ungranted"
  | "approval-only"
  | "readiness";
export class StatusMappingRefusal extends DomainPolicyError {
  constructor(
    readonly reason: StatusMappingRefusalReason,
    readonly event: StatusMappingEvent | null,
    readonly optionNodeId: string | null,
  ) {
    super("invalid-input", `Status mapping refused: ${reason}`, [
      event ? `mapping.events.${event}` : "mapping.selectionId",
    ]);
    this.name = "StatusMappingRefusal";
  }
}

export interface StatusMappingTaskState {
  lastEvent: StatusMappingEvent | "none";
  operationId: string | null;
  /** The Status option Ensemble last wrote and read back, with when. */
  observedOptionNodeId: string | null;
  observedAt: number | null;
  /** The mapping has seen the task before it was done (a task first seen done was not worked on under it). */
  watched: boolean;
  /** Turns started when a sent-back handback was first seen; the next turn after it moves the card back. */
  sentBackTurns: number | null;
}

/** Per-project status mapping and, per task, the transition last written. */
export class StatusMappingStore {
  constructor(private readonly db: Database) {}
  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS status_mappings (
      projectId TEXT PRIMARY KEY REFERENCES domain_projects(id), version INTEGER NOT NULL,
      mappingJson TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS status_mapping_task_state (
      taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id), lastEvent TEXT NOT NULL,
      operationId TEXT,
      observedOptionNodeId TEXT, observedAt INTEGER, watched INTEGER NOT NULL DEFAULT 0, sentBackTurns INTEGER);`);
  }
  /** Version 1 with no mapping until the first save, like the delivery policy. */
  current(projectId: string): {
    version: number;
    mapping: StatusMapping | null;
  } {
    const row = this.db
      .prepare(
        "SELECT version, mappingJson FROM status_mappings WHERE projectId = ?",
      )
      .get(projectId) as { version: number; mappingJson: string } | undefined;
    if (!row) return { version: 1, mapping: null };
    return {
      version: z.number().int().positive().parse(row.version),
      mapping: statusMappingSchema
        .nullable()
        .parse(JSON.parse(row.mappingJson)),
    };
  }
  /** The project's `project` selections: what a mapping can bind to. */
  projectSelections(projectId: string) {
    const row = this.db
      .prepare(
        "SELECT selections FROM project_github_sources WHERE projectId=?",
      )
      .get(projectId) as { selections: string } | undefined;
    return z
      .array(selectionSchema)
      .parse(row ? JSON.parse(row.selections) : [])
      .flatMap((s) => (s.kind === "project" ? [s] : []));
  }
  /** `unavailable` while the mapping's Project is no longer a `project` selection of the source. */
  availability(projectId: string): "available" | "unavailable" {
    const { mapping } = this.current(projectId);
    const selections = this.projectSelections(projectId);
    return mapping
      ? selections.some(
          (s) =>
            s.id === mapping.selectionId &&
            s.projectNodeId === mapping.projectNodeId,
        )
        ? "available"
        : "unavailable"
      : selections.length
        ? "available"
        : "unavailable";
  }
  /** Saves (or clears) the mapping after checking its selection, grants and in-flight readiness. */
  configureWithinTransaction(
    projectId: string,
    expectedVersion: number,
    input: unknown,
    policy: DeliveryPolicy,
  ) {
    const current = this.current(projectId);
    if (current.version !== expectedVersion)
      throw new DomainConflictError("Version conflict");
    const mapping = statusMappingSchema.nullable().parse(input);
    if (mapping) this.validate(projectId, mapping, policy);
    // A task seen under one mapping was not worked on under another: clearing or rebinding starts afresh.
    const before = current.mapping;
    if (
      before &&
      (!mapping ||
        before.selectionId !== mapping.selectionId ||
        before.projectNodeId !== mapping.projectNodeId ||
        before.fieldNodeId !== mapping.fieldNodeId)
    )
      this.forget(projectId);
    this.db
      .prepare(
        "INSERT INTO status_mappings VALUES (?, ?, ?) ON CONFLICT(projectId) DO UPDATE SET version=excluded.version, mappingJson=excluded.mappingJson",
      )
      .run(projectId, current.version + 1, JSON.stringify(mapping));
    return this.current(projectId);
  }
  private validate(
    projectId: string,
    mapping: StatusMapping,
    policy: DeliveryPolicy,
  ): void {
    if (
      !this.projectSelections(projectId).some(
        (s) =>
          s.id === mapping.selectionId &&
          s.projectNodeId === mapping.projectNodeId,
      )
    )
      throw new StatusMappingRefusal("no-selection", null, null);
    const row = this.db
      .prepare("SELECT readiness FROM project_github_sources WHERE projectId=?")
      .get(projectId) as { readiness: string };
    const rule = readinessSchema.nullable().parse(JSON.parse(row.readiness));
    for (const event of statusMappingEvents) {
      const option = mapping.events[event];
      if (option === null) continue;
      const covering = policy.grants.filter(
        (g) =>
          g.action === "project.field" &&
          g.projectNodeId === mapping.projectNodeId &&
          g.fieldNodeId === mapping.fieldNodeId &&
          g.optionNodeIds?.includes(option),
      );
      if (!covering.length)
        throw new StatusMappingRefusal("ungranted", event, option);
      // The service cannot obtain an approval.
      if (!covering.some((g) => g.mode === "allow"))
        throw new StatusMappingRefusal("approval-only", event, option);
      if (
        isInFlightEvent(event) &&
        !readinessAccepts(
          rule,
          mapping.projectNodeId,
          mapping.fieldNodeId,
          option,
        )
      )
        throw new StatusMappingRefusal("readiness", event, option);
    }
  }

  /** Drops what the mapping knows about the project's tasks: what it watched, wrote and observed. */
  forget(projectId: string): void {
    this.db
      .prepare(
        "DELETE FROM status_mapping_task_state WHERE taskId IN (SELECT id FROM domain_tasks WHERE projectId = ?)",
      )
      .run(projectId);
  }

  taskState(taskId: string): StatusMappingTaskState {
    const row = this.db
      .prepare(
        "SELECT lastEvent, operationId, observedOptionNodeId, observedAt, watched, sentBackTurns FROM status_mapping_task_state WHERE taskId = ?",
      )
      .get(taskId) as
      | (Omit<StatusMappingTaskState, "watched"> & { watched: number })
      | undefined;
    return row
      ? { ...row, watched: row.watched === 1 }
      : {
          lastEvent: "none",
          operationId: null,
          observedOptionNodeId: null,
          observedAt: null,
          watched: false,
          sentBackTurns: null,
        };
  }
  /** Records, or with `null` clears, the turns started when a handback was sent back. */
  setSentBack(taskId: string, turns: number | null): void {
    this.db
      .prepare(
        `INSERT INTO status_mapping_task_state (taskId, lastEvent, sentBackTurns) VALUES (?, 'none', ?)
        ON CONFLICT(taskId) DO UPDATE SET sentBackTurns = excluded.sentBackTurns`,
      )
      .run(taskId, turns);
  }
  /** Marks a task the mapping has seen before it was done. */
  watch(taskId: string): void {
    this.db
      .prepare(
        `INSERT INTO status_mapping_task_state (taskId, lastEvent, watched) VALUES (?, 'none', 1)
        ON CONFLICT(taskId) DO UPDATE SET watched = 1`,
      )
      .run(taskId);
  }
  /** Records the event a task is now in, and the operation minted for entering it. */
  enter(
    taskId: string,
    lastEvent: StatusMappingEvent | "none",
    operationId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO status_mapping_task_state (taskId, lastEvent, operationId)
        VALUES (?, ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET lastEvent = excluded.lastEvent,
          operationId = excluded.operationId`,
      )
      .run(taskId, lastEvent, operationId);
  }
  /** The newest observation of the item's Status (`null` is no value): a confirmed write, or a read of the item while the task was Ready. */
  observed(taskId: string, optionNodeId: string | null, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO status_mapping_task_state (taskId, lastEvent, observedOptionNodeId, observedAt)
        VALUES (?, 'none', ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET observedOptionNodeId = excluded.observedOptionNodeId,
          observedAt = excluded.observedAt`,
      )
      .run(taskId, optionNodeId, at);
  }
}
