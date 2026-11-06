import type { DatabaseObserver } from "../core/database-cache.js";

/** `read`: refetch the task read (and with it the timeline). `timeline`: refetch the newest timeline page. */
export type TaskChangeKind = "read" | "timeline";
/** `gone`: the task is no longer readable; the watch has ended. */
export type TaskChangeEvent = TaskChangeKind | "gone";

/**
 * Tables written by timeline capture and read only by the timeline read
 * (`readTaskTimeline`), never by the task read. A commit whose attributed
 * writes all fall in this set emits `timeline`; any other table emits `read`,
 * which refetches both. Listing a table the task read uses would lose changes.
 */
export const timelineCaptureTables: ReadonlySet<string> = new Set([
  "conversation_history_items",
  "conversation_history_turn_omissions",
  "diagnostic_items",
  "diagnostic_gaps",
  "diagnostic_executions",
  "diagnostic_usage",
]);

/** The ids a watched task's writes bind. */
export interface TaskChangeIds {
  /** Bound only by this task's records: task, assignment, work and imported-item ids. */
  readonly own: readonly string[];
  /** Also bound by sibling tasks' records; see `TaskChangeFeed`. */
  readonly project: string;
}

interface Watch {
  readonly resolve: () => TaskChangeIds | undefined;
  readonly listener: (event: TaskChangeEvent) => void;
  ids: readonly string[];
  pending: TaskChangeKind | undefined;
  timer: NodeJS.Timeout | undefined;
}

const writeStatement =
  /^\s*(?:INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i;
const cteWrite =
  /^\s*WITH\b[\s\S]*\b(?:INSERT|UPDATE|DELETE|REPLACE\s+INTO)\b/i;
const writtenTablePattern =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)/i;
const fullRollback = /^\s*ROLLBACK(?:\s+TRANSACTION)?\s*;?\s*$/i;

/** The written table; `null` for a write whose table is not recognised; `undefined` for no write. */
function writtenTable(sql: string): string | null | undefined {
  if (!writeStatement.test(sql) && !cteWrite.test(sql)) return undefined;
  return writtenTablePattern.exec(sql)?.[1]?.toLowerCase() ?? null;
}

/**
 * Turns committed writes seen at the database facade into content-free change
 * notices for watched tasks. A write is attributed to a task when a bound
 * string parameter (or, for a parameterless statement, the SQL text) equals
 * one of its ids; a parameterless write matching no id notifies every watched
 * task. A project-id match counts only when the commit wrote no task's or
 * assignment's own record (`isTaskRecordId`), so a sibling task's command does
 * not notify, while a project edit does. Notices are coalesced per task for
 * `coalesceMs`.
 */
export class TaskChangeFeed {
  private readonly watches = new Set<Watch>();
  private readonly byId = new Map<string, Set<Watch>>();
  private readonly byProject = new Map<string, Set<Watch>>();
  /** Since the last commit point: own-id and project-id matches, with the strongest kind. */
  private readonly marks = new Map<Watch, TaskChangeKind>();
  private readonly projectMarks = new Map<Watch, TaskChangeKind>();
  /** Short strings bound by this commit's writes, for `isTaskRecordId`. */
  private readonly bound = new Set<string>();
  private readonly coalesceMs: number;
  private readonly isTaskRecordId: (values: readonly string[]) => boolean;
  private resolving = false;

  constructor(
    options: {
      coalesceMs?: number;
      /** Whether any value is a task or assignment id. */
      isTaskRecordId?: (values: readonly string[]) => boolean;
    } = {},
  ) {
    this.coalesceMs = options.coalesceMs ?? 200;
    this.isTaskRecordId = options.isTaskRecordId ?? (() => false);
  }

  readonly observer: DatabaseObserver = (
    sql,
    parameters,
    inTransaction,
    changes,
  ) => {
    if (this.watches.size === 0 || this.resolving) return;
    try {
      if (!inTransaction && fullRollback.test(sql)) {
        this.clearMarks();
        return;
      }
      const table = changes === 0 ? undefined : writtenTable(sql);
      if (table !== undefined) this.mark(sql, parameters, table);
    } catch {
      // Fail open: an unattributable write notifies every watched task.
      for (const watch of this.watches)
        this.markWatch(this.marks, watch, "read");
    }
    if (!inTransaction) this.commit();
  };

  /**
   * Watches one task: `resolve` returns its current ids, or `undefined` once
   * it is gone. The listener must not use the database. Returns the
   * unsubscribe.
   */
  watch(
    resolve: () => TaskChangeIds | undefined,
    listener: (event: TaskChangeEvent) => void,
  ): () => void {
    const watch: Watch = {
      resolve,
      listener,
      ids: [],
      pending: undefined,
      timer: undefined,
    };
    this.watches.add(watch);
    if (!this.refresh(watch)) return () => undefined;
    return () => this.drop(watch);
  }

  private mark(
    sql: string,
    parameters: readonly unknown[],
    table: string | null,
  ): void {
    const kind =
      table !== null && timelineCaptureTables.has(table) ? "timeline" : "read";
    if (parameters.length > 0) {
      for (const parameter of parameters) {
        if (typeof parameter !== "string") continue;
        if (parameter.length <= 64) this.bound.add(parameter);
        for (const watch of this.byId.get(parameter) ?? [])
          this.markWatch(this.marks, watch, kind);
        for (const watch of this.byProject.get(parameter) ?? [])
          this.markWatch(this.projectMarks, watch, kind);
      }
      return;
    }
    let matched = false;
    for (const [index, marks] of [
      [this.byId, this.marks],
      [this.byProject, this.projectMarks],
    ] as const)
      for (const [id, watches] of index) {
        if (!sql.includes(id)) continue;
        matched = true;
        for (const watch of watches) this.markWatch(marks, watch, kind);
      }
    if (!matched)
      for (const watch of this.watches) this.markWatch(this.marks, watch, kind);
  }

  private markWatch(
    marks: Map<Watch, TaskChangeKind>,
    watch: Watch,
    kind: TaskChangeKind,
  ): void {
    if (marks.get(watch) !== "read") marks.set(watch, kind);
  }

  private commit(): void {
    if (this.projectMarks.size > 0 && !this.wroteTaskRecord())
      for (const [watch, kind] of this.projectMarks)
        this.markWatch(this.marks, watch, kind);
    const marks = [...this.marks];
    this.clearMarks();
    for (const [watch, kind] of marks) {
      // Only a `read` commit can bind a new work id or remove the task, so a
      // capture burst does not re-resolve per write.
      if (!this.watches.has(watch) || (kind === "read" && !this.refresh(watch)))
        continue;
      watch.pending = watch.pending === "read" ? "read" : kind;
      watch.timer ??= setTimeout(() => {
        const pending = watch.pending;
        watch.pending = undefined;
        watch.timer = undefined;
        if (pending) watch.listener(pending);
      }, this.coalesceMs).unref();
    }
  }

  private wroteTaskRecord(): boolean {
    this.resolving = true;
    try {
      return this.isTaskRecordId([...this.bound]);
    } catch {
      return false;
    } finally {
      this.resolving = false;
    }
  }

  private clearMarks(): void {
    this.marks.clear();
    this.projectMarks.clear();
    this.bound.clear();
  }

  /** Re-indexes the watch's ids; drops it and emits `gone` when it no longer resolves. */
  private refresh(watch: Watch): boolean {
    let ids: TaskChangeIds | undefined;
    this.resolving = true;
    try {
      ids = watch.resolve();
    } catch {
      ids = undefined;
    } finally {
      this.resolving = false;
    }
    this.unindex(watch);
    if (ids === undefined) {
      this.drop(watch);
      watch.listener("gone");
      return false;
    }
    watch.ids = [...ids.own, ids.project];
    for (const id of ids.own) add(this.byId, id, watch);
    add(this.byProject, ids.project, watch);
    return true;
  }

  private unindex(watch: Watch): void {
    for (const index of [this.byId, this.byProject])
      for (const id of watch.ids) {
        const watches = index.get(id);
        watches?.delete(watch);
        if (watches?.size === 0) index.delete(id);
      }
    watch.ids = [];
  }

  private drop(watch: Watch): void {
    if (!this.watches.delete(watch)) return;
    this.unindex(watch);
    this.marks.delete(watch);
    this.projectMarks.delete(watch);
    clearTimeout(watch.timer);
    watch.timer = undefined;
  }
}

function add(index: Map<string, Set<Watch>>, id: string, watch: Watch): void {
  const watches = index.get(id);
  if (watches) watches.add(watch);
  else index.set(id, new Set([watch]));
}
