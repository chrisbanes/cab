import { isDeletedProjectThread } from "./project-cleanup-reservations.js";
import type { CleanupOutcome } from "./project-cleanup-identities.js";
import {
  workAcceptsWrites,
  ProjectArchivedError,
} from "../core/project-lifecycle.js";
import type { Database } from "../core/store.js";
import type { Runtime } from "./codex.js";
import type { ExecutionState } from "./state.js";

/** Archives only finished threads owned by cab's Codex home, retaining restore receipts. */
export class ConversationArchival {
  private readonly pending = new Map<string, Promise<void>>();
  private sweeping = false;

  constructor(
    private readonly db: Database,
    private readonly state: ExecutionState,
    private readonly busy: (workId: string) => boolean,
    private readonly accepting: () => boolean,
    private readonly projectWrite?: <T>(
      threadId: string,
      run: () => Promise<T>,
    ) => Promise<T>,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_archives (
      threadId TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('requested','archived'))
    )`);
  }

  private eligible(threadId: string): boolean {
    const intents = (
      this.db
        .prepare("SELECT workId FROM execution_intents WHERE threadId = ?")
        .all(threadId) as { workId: string }[]
    ).map(({ workId }) => this.state.byWorkId(workId)!);
    // Candidates are already limited to threads in cab's Codex home.
    if (intents.length === 0) return false;
    for (const intent of intents) {
      if (
        !workAcceptsWrites(this.db, intent.workId) ||
        this.busy(intent.workId) ||
        !["completed", "reconciled", "resolved-failed"].includes(
          intent.state,
        ) ||
        this.db
          .prepare(`SELECT 1 FROM execution_pending_effects
          WHERE workId = ? AND state = 'pending'`)
          .get(intent.workId) ||
        this.db
          .prepare(`SELECT 1 FROM execution_capacity_reservations
          WHERE workId = ?`)
          .get(intent.workId) ||
        this.db
          .prepare(`SELECT 1 FROM execution_stop_targets
          WHERE workId = ? AND terminalState = 'unknown'`)
          .get(intent.workId) ||
        this.db
          .prepare(`SELECT 1 FROM turn_requests
          WHERE (workId = ? OR previousWorkId = ?)
          AND state IN ('queued','active','held')`)
          .get(intent.workId, intent.workId)
      )
        return false;
      const binding = this.state.taskBinding(intent.workId);
      if (binding) {
        if (
          this.state.taskHold(binding.taskId) ||
          this.state.unsettledTaskWorkIds(binding.taskId).length > 0 ||
          this.db
            .prepare(`SELECT 1 FROM task_execution_bindings b
            JOIN execution_pending_effects e ON e.workId = b.workId
            WHERE b.taskId = ? AND e.state = 'pending'`)
            .get(binding.taskId)
        )
          return false;
        // A completed turn on an open assignment can still need continuation.
        if (
          !this.db
            .prepare(`SELECT 1 FROM domain_assignments a
          JOIN domain_tasks t ON t.id = a.taskId
          JOIN assignment_conversations c ON c.assignmentId = a.id
          WHERE a.id = ? AND (a.state = 'completed' OR t.state IN ('done','cancelled')
            OR c.revision > ?)`)
            .get(binding.assignmentId, binding.conversationRevision)
        )
          return false;
      } else {
        // Require an owned request, rather than treating missing bindings as completion.
        const request = this.db
          .prepare(`SELECT kind FROM turn_requests
          WHERE workId = ? AND state = 'completed'`)
          .get(intent.workId) as { kind: string } | undefined;
        if (request?.kind === "drafting") {
          if (
            !this.db
              .prepare(`SELECT 1 FROM drafting_runs
            WHERE runId = ? AND state IN
            ('proposed','interrupted','failed','accepted','discarded','expired')`)
              .get(intent.workId.slice("drafting:".length))
          )
            return false;
        } else if (request?.kind !== "direct") return false;
      }
    }
    return true;
  }

  sweep(runtime: Runtime | undefined): Promise<void> | undefined {
    if (!runtime?.setThreadArchived || this.sweeping) return;
    try {
      const threads = this.db
        .prepare(`SELECT q.threadId FROM runtime_thread_qualification q
        LEFT JOIN conversation_archives a ON a.threadId = q.threadId
        WHERE q.harness = 'codex' AND q.codexHome = 'cab'
        AND (a.state IS NULL OR a.state = 'requested')
        AND EXISTS (SELECT 1 FROM execution_intents e WHERE e.threadId = q.threadId)`)
        .all() as { threadId: string }[];
      const eligible = threads.filter(({ threadId }) =>
        this.eligible(threadId),
      );
      if (eligible.length === 0) return;
      return this.archiveCandidates(
        runtime.setThreadArchived.bind(runtime),
        eligible,
      );
    } catch {
      // A failed eligibility read must leave the conversations alone.
      return;
    }
  }

  private async archiveCandidates(
    setArchived: (threadId: string, archived: boolean) => Promise<void>,
    threads: { threadId: string }[],
  ): Promise<void> {
    this.sweeping = true;
    try {
      for (const { threadId } of threads) {
        if (!this.accepting()) return;
        // Earlier archives await, so eligibility may have changed since the scan.
        if (this.pending.has(threadId) || !this.eligible(threadId)) continue;
        const operation = this.withThreadLock(threadId, async () => {
          if (
            !this.accepting() ||
            isDeletedProjectThread(this.db, threadId) ||
            !this.eligible(threadId)
          )
            return;
          // Persist before RPC: a lost acknowledgement remains recoverable.
          this.db
            .prepare(
              "INSERT OR IGNORE INTO conversation_archives VALUES (?, 'requested')",
            )
            .run(threadId);
          const archive = async () => {
            await setArchived(threadId, true);
            this.db
              .prepare(
                "UPDATE conversation_archives SET state='archived' WHERE threadId=?",
              )
              .run(threadId);
          };
          if (this.projectWrite) await this.projectWrite(threadId, archive);
          else await archive();
        });
        try {
          await operation;
        } catch {
          // Cleanup is best effort; retain the request and retry on the next sweep.
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private withThreadLock(
    threadId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const previous = this.pending.get(threadId);
    let operation: Promise<void>;
    if (previous) {
      operation = previous.catch(() => {}).then(run);
      this.pending.set(threadId, operation);
    } else {
      // Reserve before invoking user/runtime code, but preserve synchronous lease/RPC admission.
      let resolve!: () => void, reject!: (error: unknown) => void;
      operation = new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      this.pending.set(threadId, operation);
      try {
        void run().then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    }
    return operation.finally(() => {
      if (this.pending.get(threadId) === operation)
        this.pending.delete(threadId);
    });
  }

  /** Uses captured qualified identity, never a discovery query requiring deleted intents. */
  async archiveCaptured(
    runtime: Runtime | undefined,
    threadId: string,
    allowed: () => boolean = () => true,
  ): Promise<CleanupOutcome> {
    let outcome: CleanupOutcome = { outcome: "pending", reason: "unavailable" };
    if (this.pending.has(threadId))
      return { outcome: "pending", reason: "unknown" };
    try {
      await this.withThreadLock(threadId, async () => {
        if (!runtime?.setThreadArchived || !this.accepting() || !allowed())
          return;
        if (
          !isDeletedProjectThread(this.db, threadId) ||
          this.db
            .prepare("SELECT 1 FROM execution_intents WHERE threadId=? LIMIT 1")
            .get(threadId) ||
          this.db
            .prepare(
              "SELECT 1 FROM execution_recovery_identities WHERE threadId=? LIMIT 1",
            )
            .get(threadId) ||
          this.db
            .prepare(
              "SELECT 1 FROM coordination_runtime_questions WHERE threadId=? OR json_extract(identityJson,'$.threadId')=? LIMIT 1",
            )
            .get(threadId, threadId)
        ) {
          outcome = { outcome: "pending", reason: "unsafe" };
          return;
        }
        // CodexRuntime first reads archive state and otherwise requires the RPC acknowledgement.
        // Repeating after a lost acknowledgement is idempotent and never unarchives the thread.
        await runtime.setThreadArchived(threadId, true);
        outcome = { outcome: "complete" };
      });
    } catch {
      outcome = { outcome: "pending", reason: "unknown" };
    }
    return outcome;
  }

  restore(runtime: Runtime, threadId: string): Promise<void> {
    return this.withThreadLock(threadId, async () => {
      const check = () => {
        if (isDeletedProjectThread(this.db, threadId))
          throw new ProjectArchivedError();
        const owners = this.db
          .prepare("SELECT workId FROM execution_intents WHERE threadId=?")
          .all(threadId) as { workId: string }[];
        if (owners.some((owner) => !workAcceptsWrites(this.db, owner.workId)))
          throw new ProjectArchivedError();
      };
      check();
      if (
        !this.db
          .prepare("SELECT 1 FROM conversation_archives WHERE threadId=?")
          .get(threadId)
      )
        return;
      if (!runtime.setThreadArchived)
        throw new Error("Conversation restoration unavailable");
      const restore = async () => {
        check();
        await runtime.setThreadArchived!(threadId, false);
        this.db
          .prepare("DELETE FROM conversation_archives WHERE threadId=?")
          .run(threadId);
      };
      if (this.projectWrite) await this.projectWrite(threadId, restore);
      else await restore();
    });
  }
}
