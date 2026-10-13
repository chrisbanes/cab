import { z } from "zod";
import type { Database } from "../core/store.js";

const workId = z.object({ workId: z.string().min(1) });
const operationId = z.object({ id: z.string().min(1) });
const pendingCompletion = z.object({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  leadAssignmentId: z.string().min(1),
  leadWorkId: z.string().min(1),
});
const uncommittedAttempt = z.object({
  operationId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  taskVersion: z.number().int().positive(),
});

export type PendingCompletionIdentity = z.infer<typeof pendingCompletion>;
export type UncommittedRoutingAttemptIdentity = z.infer<
  typeof uncommittedAttempt
>;

/**
 * Narrow, read-only current-state queries for scheduler wakes. Each call reads
 * the database afresh and projects identities only, so a wake never loads
 * unrelated request, completion or routing history and never works from a
 * snapshot taken before an earlier iteration mutated state.
 */
export class SchedulerWakeQueries {
  constructor(private readonly db: Database) {}

  /** Additive and idempotent; call after every owning table has migrated. */
  ensureIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS scheduler_wake_pending_completions
        ON coordination_completion_requests(createdAt, requestId)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS scheduler_wake_routing_fallbacks
        ON routing_operations(id)
        WHERE disposition GLOB 'lead-review:*';
      CREATE INDEX IF NOT EXISTS scheduler_wake_open_routing_attempts
        ON routing_attempt_operations(createdAt, operationId)
        WHERE status <> 'stale';
    `);
  }

  hasWork(id: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS present FROM turn_requests WHERE workId = ?")
        .get(id) !== undefined
    );
  }

  /** The first request ever created for the assignment, whatever its state. */
  oldestAssignmentWorkId(assignmentId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT workId FROM turn_requests WHERE assignmentId = ? ORDER BY sequence LIMIT 1",
      )
      .get(assignmentId);
    return row === undefined ? undefined : workId.parse(row).workId;
  }

  unsettledAssignmentWorkIds(assignmentId: string): string[] {
    return this.db
      .prepare(
        "SELECT workId FROM turn_requests WHERE assignmentId = ? AND state IN ('queued','active','held') ORDER BY sequence",
      )
      .all(assignmentId)
      .map((row) => workId.parse(row).workId);
  }

  pendingCompletionIdentities(): PendingCompletionIdentity[] {
    return this.db
      .prepare(
        "SELECT requestId, taskId, leadAssignmentId, leadWorkId FROM coordination_completion_requests WHERE status = 'pending' ORDER BY createdAt, requestId",
      )
      .all()
      .map((row) => pendingCompletion.parse(row));
  }

  /**
   * Lead-review routing operations with no fallback inbox event yet, in rowid
   * order. `+rowid` stops the planner scanning the whole table in rowid order
   * instead of using the partial index and sorting the few matches.
   */
  missingRoutingFallbackOperationIds(): string[] {
    return this.db
      .prepare(
        `SELECT id FROM routing_operations
        WHERE disposition GLOB 'lead-review:*'
          AND NOT EXISTS (
            SELECT 1 FROM coordination_inbox_events
            WHERE coordination_inbox_events.routingOperationId = routing_operations.id)
        ORDER BY +rowid`,
      )
      .all()
      .map((row) => operationId.parse(row).id);
  }

  /** Non-stale routing attempts with no committed routing operation. */
  uncommittedRoutingAttemptIdentities(): UncommittedRoutingAttemptIdentity[] {
    return this.db
      .prepare(
        `SELECT operationId, projectId, taskId, taskVersion FROM routing_attempt_operations
        WHERE status <> 'stale'
          AND NOT EXISTS (
            SELECT 1 FROM routing_operations
            WHERE routing_operations.id = routing_attempt_operations.operationId)
        ORDER BY createdAt, operationId`,
      )
      .all()
      .map((row) => uncommittedAttempt.parse(row));
  }
}
