import { materialDigest } from "../core/delivery.js";
import { transaction, type Database } from "../core/store.js";
import { releaseCapturedClaudeTemporaryBase } from "./claude.js";
import type { Runtime } from "./codex.js";
import type { ConversationArchival } from "./conversation-archival.js";
import type { CleanupOutcome } from "./project-cleanup-identities.js";
import { capturedWorkspaceUnclaimed } from "./project-cleanup-reservations.js";
import { ProjectTombstones, type ProjectCleanup } from "./project-deletion.js";
import type { WorkspaceManager } from "./workspaces.js";

type PendingItem = Extract<
  ProjectCleanup["items"][number],
  { state: "pending" }
>;
interface CleanupOptions {
  roots: { task: string; drafting: string };
  workspaces: { task: WorkspaceManager; drafting: WorkspaceManager };
  archival: ConversationArchival;
  runtime: () => Runtime | undefined;
  accepting: () => boolean;
  /** Trusted fixture seams; never operator-supplied values. */
  budgetMs?: number;
  afterEffect?: (item: PendingItem) => Promise<void>;
}

/** Bounded, single-flight postcommit work. Durable discovery never depends on live parent rows. */
export class ProjectDeletionCleanup {
  private readonly store: ProjectTombstones;
  private running: Promise<void> | undefined;
  private afterProject: string | undefined;
  private readonly effects = new Map<string, Promise<CleanupOutcome>>();
  constructor(
    private readonly db: Database,
    private readonly options: CleanupOptions,
  ) {
    this.store = new ProjectTombstones(db, false);
  }
  hasPending(): boolean {
    return (
      !!this.running ||
      this.effects.size > 0 ||
      !!this.db
        .prepare(
          "SELECT 1 FROM project_tombstones WHERE cleanupState='pending' LIMIT 1",
        )
        .get()
    );
  }
  sweep(projectId?: string): Promise<void> {
    if (this.running)
      return projectId
        ? this.running.then(() => this.sweep(projectId))
        : this.running;
    if (!this.options.accepting()) return Promise.resolve();
    const operation = this.pass(projectId).catch(() => {});
    this.running = operation;
    void operation.finally(() => {
      if (this.running === operation) this.running = undefined;
    });
    return operation;
  }
  async settle(): Promise<void> {
    await this.running;
    await Promise.allSettled([...this.effects.values()]);
  }
  private async pass(projectId?: string) {
    const deadline = Date.now() + (this.options.budgetMs ?? 30_000);
    const allowed = () => this.options.accepting() && Date.now() < deadline;
    let rows = projectId
      ? [this.store.pendingCleanupProject(projectId)].filter(
          (row) => row !== undefined,
        )
      : this.store.pendingCleanupPage(this.afterProject);
    if (!projectId && !rows.length && this.afterProject) {
      this.afterProject = undefined;
      rows = this.store.pendingCleanupPage();
    }
    let processed = 0;
    for (const row of rows) {
      const pending = row.cleanup.items.filter(
        (item): item is PendingItem => item.state === "pending",
      );
      const items = pending;
      this.afterProject = row.projectId;
      for (const item of items) {
        if (!allowed() || processed++ >= 16) return;
        const key = `${row.projectId}:${item.id}`;
        // A timed-out RPC or filesystem call retains its lock until actual settlement.
        if (this.effects.has(key)) {
          transaction(this.db, () =>
            this.store.retainCleanupWithinTransaction(
              row.projectId,
              item.id,
              "unknown",
            ),
          );
          continue;
        }
        if (this.effects.size >= 16) return;
        const effect = Promise.resolve()
          .then(() => this.effect(item, allowed))
          .catch(
            (): CleanupOutcome => ({ outcome: "pending", reason: "unknown" }),
          );
        this.effects.set(key, effect);
        void effect.finally(() => {
          if (this.effects.get(key) === effect) this.effects.delete(key);
        });
        const outcome = await this.withDeadline(
          effect,
          Math.max(1, deadline - Date.now()),
        );
        try {
          if (outcome.outcome === "complete")
            await this.options.afterEffect?.(item);
          if (!this.options.accepting()) return;
          transaction(this.db, () => {
            const current = this.store
              .pendingCleanupProject(row.projectId)
              ?.cleanup.items.find((value) => value.id === item.id);
            if (current?.state !== "pending") return;
            if (
              materialDigest(current.captured) !== materialDigest(item.captured)
            )
              return;
            if (outcome.outcome === "complete")
              this.store.completeCleanupWithinTransaction(
                row.projectId,
                item.id,
              );
            else
              this.store.retainCleanupWithinTransaction(
                row.projectId,
                item.id,
                outcome.reason,
              );
          });
        } catch {
          // Commit succeeded earlier. A crash/checkpoint failure keeps the durable pending item.
        }
      }
    }
  }
  private async withDeadline(
    effect: Promise<CleanupOutcome>,
    milliseconds: number,
  ): Promise<CleanupOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CleanupOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ outcome: "pending", reason: "unknown" }),
        milliseconds,
      );
    });
    try {
      return await Promise.race([effect, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private effect(
    item: PendingItem,
    allowed: () => boolean,
  ): Promise<CleanupOutcome> {
    if (!allowed())
      return Promise.resolve({ outcome: "pending", reason: "unavailable" });
    const captured = item.captured;
    switch (captured.kind) {
      case "workspace": {
        const manager =
          captured.managedRoot === this.options.roots.task
            ? this.options.workspaces.task
            : captured.managedRoot === this.options.roots.drafting
              ? this.options.workspaces.drafting
              : undefined;
        if (!manager)
          return Promise.resolve({ outcome: "pending", reason: "unsafe" });
        return manager.discardCaptured(
          captured,
          () =>
            allowed() && capturedWorkspaceUnclaimed(this.db, captured.binding),
        );
      }
      case "claude-temp":
        return releaseCapturedClaudeTemporaryBase(
          captured,
          () =>
            allowed() &&
            !!captured.workspacePath &&
            capturedWorkspaceUnclaimed(this.db, {
              taskId: captured.taskId,
              workspaceId: captured.workspaceId,
              path: captured.workspacePath,
            }),
        );
      case "codex-thread":
        return this.options.archival.archiveCaptured(
          this.options.runtime(),
          captured.threadId,
          allowed,
        );
    }
  }
}
