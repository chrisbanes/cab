import { type Database, transaction } from "../core/store.js";
import type { RuntimeDiagnosticEvent } from "./codex.js";
import { sanitizeConversationText } from "./conversation-history.js";

export type DiagnosticKind =
  | "input"
  | "setting"
  | "runtime"
  | "tool"
  | "service";
export type DiagnosticMode = "enhanced" | "baseline";
export type DiagnosticGapCode =
  | "capture-baseline"
  | "capture-failed"
  | "capture-interrupted"
  | "input-failed"
  | "size-limit"
  | "redaction-unavailable"
  | "execution-limit"
  | "item-limit"
  | "expired"
  | "evicted"
  | "late-event"
  | "early-buffer-limit"
  | "unsupported-event";

export interface DiagnosticLimits {
  /** Items with `createdAt` strictly older than this many ms are expired. */
  ageMs: number;
  installationBytes: number;
  executionBytes: number;
  executionItems: number;
  itemBytes: number;
}

export interface DiagnosticExecutionIdentity {
  workId: string;
  taskId: string;
  projectId: string;
  assignmentId: string;
  assignmentVersion: number;
  instructionsRevision: number;
  profileRevision: number;
  conversationRevision: number;
  harness: string;
  mode: DiagnosticMode;
  eventSource: "supported" | "unsupported";
}

export interface DiagnosticExecution extends DiagnosticExecutionIdentity {
  threadId: string | null;
  turnId: string | null;
  startedAt: number;
  finishedAt: number | null;
  payloadBytes: number;
  gaps: DiagnosticGap[];
}

export interface DiagnosticGap {
  workId: string;
  code: DiagnosticGapCode;
  count: number;
  bytes: number;
  firstAt: number;
  lastAt: number;
  maxPrunedSequence: number;
}

export interface DiagnosticItem {
  sequence: number;
  workId: string;
  kind: DiagnosticKind;
  name: string;
  severity: string;
  itemId: string | null;
  state: "available" | "omitted";
  reason: DiagnosticGapCode | null;
  payload: unknown;
  payloadBytes: number;
  originalBytes: number;
  createdAt: number;
}

export interface DiagnosticEventFilter {
  /** Global item sequence; items with a greater sequence are returned. */
  after?: number;
  kind?: DiagnosticKind;
  severity?: string;
  since?: number;
  until?: number;
}

export interface DiagnosticEventPage {
  items: DiagnosticItem[];
  gaps: DiagnosticGap[];
  more: boolean;
  /** Sequence to pass as `after` to continue; undefined when nothing was returned. */
  nextAfter: number | undefined;
}

export interface DiagnosticStoreOptions {
  limits?: Partial<DiagnosticLimits>;
  now?: () => number;
}

const day = 24 * 60 * 60 * 1000;
const mib = 1024 * 1024;
export const defaultDiagnosticLimits: DiagnosticLimits = {
  ageMs: 30 * day,
  installationBytes: 1024 * mib,
  executionBytes: 16 * mib,
  executionItems: 8192,
  itemBytes: 64 * 1024,
};
const commandLeafBytes = 4 * 1024;
const stringLeafBytes = 48 * 1024;
const inputLeafBytes = 64 * 1024;
const maxDepth = 16;
const batchRows = 256;
export const eventPageItems = 200;
export const eventPageBytes = mib;

/** Thrown by `events` when `after` is beyond any sequence ever issued. */
export class DiagnosticCursorError extends Error {
  constructor(
    readonly after: number,
    readonly highWater: number,
  ) {
    super(
      `diagnostic cursor ${after} is above the high-water mark ${highWater}`,
    );
    this.name = "DiagnosticCursorError";
  }
}

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max))
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** Throws on an invalid value so startup fails rather than silently using defaults. */
export function diagnosticLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticLimits {
  return {
    ...defaultDiagnosticLimits,
    ageMs:
      integerFromEnv(env, "ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS", 1, 365, 30) *
      day,
    installationBytes:
      integerFromEnv(
        env,
        "ENSEMBLE_DIAGNOSTIC_STORAGE_MIB",
        16,
        1048576,
        1024,
      ) * mib,
  };
}

const unavailable = Symbol("redaction-unavailable");

function boundLeaf(
  value: unknown,
  exclusions: readonly string[],
  cap: number,
  key: string | undefined,
  depth: number,
): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > (key === "command" ? Math.min(cap, commandLeafBytes) : cap))
      return { omitted: "size-limit", bytes };
    const text = sanitizeConversationText(value, exclusions);
    if (text === undefined) throw unavailable;
    return text;
  }
  if (value === null || typeof value !== "object")
    return typeof value === "bigint" ? String(value) : value;
  if (depth >= maxDepth) return { omitted: "size-limit", bytes: 0 };
  if (Array.isArray(value))
    return value.map((v) =>
      boundLeaf(v, exclusions, cap, undefined, depth + 1),
    );
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      boundLeaf(v, exclusions, cap, k, depth + 1),
    ]),
  );
}

/**
 * Sanitises every string leaf (never the serialised JSON, whose escaping defeats
 * exact-value matching) and replaces oversized leaves whole. Returns undefined when
 * redaction is unavailable.
 */
export function boundDetail(
  value: unknown,
  exclusions: readonly string[] | undefined,
  leafBytes: number = stringLeafBytes,
): unknown {
  if (exclusions === undefined) return undefined;
  try {
    return boundLeaf(value, exclusions, leafBytes, undefined, 0) ?? null;
  } catch (error) {
    if (error === unavailable) return undefined;
    throw error;
  }
}

interface ItemRow {
  sequence: number;
  workId: string;
  kind: DiagnosticKind;
  name: string;
  severity: string;
  itemId: string | null;
  state: "available" | "omitted";
  reason: DiagnosticGapCode | null;
  payload: string | null;
  payloadBytes: number;
  originalBytes: number;
  createdAt: number;
}

/** Additive, bounded, best-effort diagnostic storage; it never affects execution. */
export class ExecutionDiagnosticsStore {
  private readonly limits: DiagnosticLimits;
  private readonly now: () => number;
  private unrecorded = 0;

  constructor(
    private readonly db: Database,
    options: DiagnosticStoreOptions = {},
  ) {
    this.limits = { ...defaultDiagnosticLimits, ...options.limits };
    this.now = options.now ?? Date.now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_executions (
      workId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      assignmentId TEXT NOT NULL,
      assignmentVersion INTEGER NOT NULL,
      instructionsRevision INTEGER NOT NULL,
      profileRevision INTEGER NOT NULL,
      conversationRevision INTEGER NOT NULL,
      harness TEXT NOT NULL,
      threadId TEXT,
      turnId TEXT,
      mode TEXT NOT NULL CHECK(mode IN ('enhanced','baseline')),
      eventSource TEXT NOT NULL CHECK(eventSource IN ('supported','unsupported')),
      startedAt INTEGER NOT NULL,
      finishedAt INTEGER,
      payloadBytes INTEGER NOT NULL DEFAULT 0 CHECK(payloadBytes >= 0)
    );
    CREATE TABLE IF NOT EXISTS diagnostic_items (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('input','setting','runtime','tool','service')),
      name TEXT NOT NULL,
      severity TEXT NOT NULL,
      itemId TEXT,
      state TEXT NOT NULL CHECK(state IN ('available','omitted')),
      reason TEXT,
      payload TEXT,
      payloadBytes INTEGER NOT NULL CHECK(payloadBytes >= 0),
      originalBytes INTEGER NOT NULL CHECK(originalBytes >= 0),
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS diagnostic_items_work_sequence
      ON diagnostic_items(workId, sequence);
    CREATE INDEX IF NOT EXISTS diagnostic_items_created ON diagnostic_items(createdAt);
    CREATE TABLE IF NOT EXISTS diagnostic_gaps (
      workId TEXT NOT NULL,
      code TEXT NOT NULL,
      count INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      firstAt INTEGER NOT NULL,
      lastAt INTEGER NOT NULL,
      maxPrunedSequence INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workId, code)
    );
    CREATE TABLE IF NOT EXISTS diagnostic_usage (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      totalBytes INTEGER NOT NULL CHECK(totalBytes >= 0)
    );
    INSERT OR IGNORE INTO diagnostic_usage(id, totalBytes) VALUES (1, 0)`);
  }

  begin(identity: DiagnosticExecutionIdentity): void {
    this.guard(() =>
      this.db
        .prepare(`INSERT OR IGNORE INTO diagnostic_executions
          (workId, taskId, projectId, assignmentId, assignmentVersion,
            instructionsRevision, profileRevision, conversationRevision, harness,
            mode, eventSource, startedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          identity.workId,
          identity.taskId,
          identity.projectId,
          identity.assignmentId,
          identity.assignmentVersion,
          identity.instructionsRevision,
          identity.profileRevision,
          identity.conversationRevision,
          identity.harness,
          identity.mode,
          identity.eventSource,
          this.now(),
        ),
    );
  }

  bindThread(workId: string, threadId: string): void {
    this.guard(() =>
      this.db
        .prepare(
          "UPDATE diagnostic_executions SET threadId = ? WHERE workId = ?",
        )
        .run(threadId, workId),
    );
  }

  bindTurn(workId: string, turnId: string): void {
    this.guard(() =>
      this.db
        .prepare("UPDATE diagnostic_executions SET turnId = ? WHERE workId = ?")
        .run(turnId, workId),
    );
  }

  /**
   * Stores one sanitised, bounded item. `exclusions` undefined stores an
   * `omitted/redaction-unavailable` marker instead of the payload.
   */
  record(
    workId: string,
    kind: DiagnosticKind,
    name: string,
    severity: string,
    itemId: string | undefined,
    payload: unknown,
    exclusions: readonly string[] | undefined,
  ): void {
    this.guard(() => {
      let state: "available" | "omitted" = "available";
      let reason: DiagnosticGapCode | null = null;
      let text: string | null = null;
      let bytes = 0;
      let originalBytes = 0;
      const bounded = boundDetail(
        payload,
        exclusions,
        kind === "input" ? inputLeafBytes : stringLeafBytes,
      );
      if (bounded === undefined) {
        state = "omitted";
        reason = "redaction-unavailable";
      } else {
        text = JSON.stringify(bounded);
        bytes = originalBytes = Buffer.byteLength(text, "utf8");
        if (bytes > this.limits.itemBytes) {
          state = "omitted";
          reason = "size-limit";
          text = null;
          bytes = 0;
        }
      }

      const limited = transaction(this.db, () => {
        const execution = this.db
          .prepare(
            "SELECT payloadBytes FROM diagnostic_executions WHERE workId = ?",
          )
          .get(workId) as { payloadBytes: number } | undefined;
        if (!execution) throw new Error("diagnostic execution not begun");
        const rows = (
          this.db
            .prepare(
              "SELECT COUNT(*) AS c FROM diagnostic_items WHERE workId = ?",
            )
            .get(workId) as { c: number }
        ).c;
        const limit: DiagnosticGapCode | undefined =
          rows >= this.limits.executionItems
            ? "item-limit"
            : execution.payloadBytes + bytes > this.limits.executionBytes
              ? "execution-limit"
              : undefined;
        if (limit) {
          this.upsertGap(workId, limit, 1, bytes, 0);
          return true;
        }
        this.db
          .prepare(`INSERT INTO diagnostic_items
              (workId, kind, name, severity, itemId, state, reason, payload,
                payloadBytes, originalBytes, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            workId,
            kind,
            name,
            severity,
            itemId ?? null,
            state,
            reason,
            text,
            bytes,
            originalBytes,
            this.now(),
          );
        this.db
          .prepare(
            "UPDATE diagnostic_executions SET payloadBytes = payloadBytes + ? WHERE workId = ?",
          )
          .run(bytes, workId);
        this.db
          .prepare(
            "UPDATE diagnostic_usage SET totalBytes = totalBytes + ? WHERE id = 1",
          )
          .run(bytes);
        return false;
      });
      if (!limited && this.totalBytes() > this.limits.installationBytes)
        this.evictBatch();
    }, workId);
  }

  /** Adds `count` to a coalesced gap; never throws. */
  gap(workId: string, code: DiagnosticGapCode, bytes = 0, count = 1): void {
    this.guard(() => this.upsertGap(workId, code, count, bytes, 0));
  }

  finish(workId: string): void {
    this.guard(() =>
      this.db
        .prepare(
          "UPDATE diagnostic_executions SET finishedAt = ? WHERE workId = ? AND finishedAt IS NULL",
        )
        .run(this.now(), workId),
    );
  }

  /** At service start: marks executions that never finished as interrupted. */
  closeOpen(): void {
    this.guard(() =>
      transaction(this.db, () => {
        const open = this.db
          .prepare(
            "SELECT workId FROM diagnostic_executions WHERE finishedAt IS NULL",
          )
          .all() as { workId: string }[];
        for (const { workId } of open) {
          this.upsertGap(workId, "capture-interrupted", 1, 0, 0);
          this.db
            .prepare(
              "UPDATE diagnostic_executions SET finishedAt = ? WHERE workId = ?",
            )
            .run(this.now(), workId);
        }
      }),
    );
  }

  /** Deletes expired items, then evicts oldest items until under the installation cap. */
  async prune(): Promise<void> {
    try {
      const cutoff = this.now() - this.limits.ageMs;
      while (this.removeBatch("expired", cutoff) > 0) await yieldToLoop();
      while (this.totalBytes() > this.limits.installationBytes) {
        if (this.evictBatch() === 0) break;
        await yieldToLoop();
      }
    } catch {
      this.unrecorded += 1;
    }
  }

  /** Recomputes the byte counters from stored items; call once at start. */
  reconcile(): void {
    this.guard(() =>
      transaction(this.db, () => {
        this.db.exec(`UPDATE diagnostic_executions SET payloadBytes = COALESCE(
            (SELECT SUM(payloadBytes) FROM diagnostic_items i
              WHERE i.workId = diagnostic_executions.workId), 0);
          UPDATE diagnostic_usage SET totalBytes = COALESCE(
            (SELECT SUM(payloadBytes) FROM diagnostic_items), 0) WHERE id = 1`);
      }),
    );
  }

  execution(workId: string): DiagnosticExecution | undefined {
    const row = this.db
      .prepare("SELECT * FROM diagnostic_executions WHERE workId = ?")
      .get(workId) as Omit<DiagnosticExecution, "gaps"> | undefined;
    return row && { ...row, gaps: this.gaps(workId, 0) };
  }

  /** Ascending page by global sequence, at most 200 items or 1 MiB (at least one). */
  events(
    workId: string,
    filter: DiagnosticEventFilter = {},
  ): DiagnosticEventPage {
    const after = filter.after ?? 0;
    const highWater = this.highWater();
    if (after > highWater) throw new DiagnosticCursorError(after, highWater);
    const rows = this.db
      .prepare(`SELECT * FROM diagnostic_items
        WHERE workId = ? AND sequence > ?
          AND (? IS NULL OR kind = ?) AND (? IS NULL OR severity = ?)
          AND (? IS NULL OR createdAt >= ?) AND (? IS NULL OR createdAt <= ?)
        ORDER BY sequence LIMIT ?`)
      .all(
        workId,
        after,
        filter.kind ?? null,
        filter.kind ?? null,
        filter.severity ?? null,
        filter.severity ?? null,
        filter.since ?? null,
        filter.since ?? null,
        filter.until ?? null,
        filter.until ?? null,
        eventPageItems + 1,
      ) as unknown as ItemRow[];
    let used = 0;
    let taken = 0;
    for (const row of rows.slice(0, eventPageItems)) {
      if (taken > 0 && used + row.payloadBytes > eventPageBytes) break;
      used += row.payloadBytes;
      taken += 1;
    }
    const page = rows.slice(0, taken);
    return {
      items: page.map(toItem),
      gaps: this.gaps(workId, after),
      more: rows.length > taken,
      nextAfter: page.at(-1)?.sequence,
    };
  }

  itemCount(workId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM diagnostic_items WHERE workId = ?")
        .get(workId) as { c: number }
    ).c;
  }

  /** The captured input segments in order. */
  inputs(workId: string): DiagnosticItem[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM diagnostic_items WHERE workId = ? AND kind = 'input' ORDER BY sequence",
        )
        .all(workId) as unknown as ItemRow[]
    ).map(toItem);
  }

  /** Never throws; `totalBytes` is undefined when the store cannot be read. */
  health(): { unrecorded: number; totalBytes: number | undefined } {
    try {
      return { unrecorded: this.unrecorded, totalBytes: this.totalBytes() };
    } catch {
      return { unrecorded: this.unrecorded, totalBytes: undefined };
    }
  }

  private gaps(workId: string, after: number): DiagnosticGap[] {
    return this.db
      .prepare(
        `SELECT * FROM diagnostic_gaps WHERE workId = ?
          AND (code NOT IN ('expired','evicted') OR maxPrunedSequence > ?) ORDER BY code`,
      )
      .all(workId, after) as unknown as DiagnosticGap[];
  }

  private highWater(): number {
    const row = this.db
      .prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'diagnostic_items'",
      )
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private totalBytes(): number {
    return (
      this.db
        .prepare("SELECT totalBytes FROM diagnostic_usage WHERE id = 1")
        .get() as { totalBytes: number }
    ).totalBytes;
  }

  private upsertGap(
    workId: string,
    code: DiagnosticGapCode,
    count: number,
    bytes: number,
    maxPrunedSequence: number,
  ): void {
    const now = this.now();
    this.db
      .prepare(`INSERT INTO diagnostic_gaps
        (workId, code, count, bytes, firstAt, lastAt, maxPrunedSequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workId, code) DO UPDATE SET
          count = count + excluded.count, bytes = bytes + excluded.bytes,
          lastAt = excluded.lastAt,
          maxPrunedSequence = MAX(maxPrunedSequence, excluded.maxPrunedSequence)`)
      .run(workId, code, count, bytes, now, now, maxPrunedSequence);
  }

  /** Deletes up to one batch of items older than `cutoff`; returns rows removed. */
  private removeBatch(code: "expired", cutoff: number): number {
    return transaction(this.db, () =>
      this.deleteRows(
        this.db
          .prepare(
            "SELECT sequence, workId, payloadBytes FROM diagnostic_items WHERE createdAt < ? ORDER BY sequence LIMIT ?",
          )
          .all(cutoff, batchRows) as unknown as DeleteRow[],
        code,
      ),
    );
  }

  /** Evicts the lowest sequences, in one batch, until under the cap. */
  private evictBatch(): number {
    return transaction(this.db, () => {
      let excess = this.totalBytes() - this.limits.installationBytes;
      const rows: DeleteRow[] = [];
      for (const row of this.db
        .prepare(
          "SELECT sequence, workId, payloadBytes FROM diagnostic_items ORDER BY sequence LIMIT ?",
        )
        .all(batchRows) as unknown as DeleteRow[]) {
        if (excess <= 0 && rows.length > 0) break;
        rows.push(row);
        excess -= row.payloadBytes;
      }
      return this.deleteRows(rows, "evicted");
    });
  }

  private deleteRows(rows: DeleteRow[], code: "expired" | "evicted"): number {
    const perWork = new Map<string, DeleteRow & { count: number }>();
    for (const row of rows) {
      this.db
        .prepare("DELETE FROM diagnostic_items WHERE sequence = ?")
        .run(row.sequence);
      const entry = perWork.get(row.workId);
      if (entry) {
        entry.count += 1;
        entry.payloadBytes += row.payloadBytes;
        entry.sequence = Math.max(entry.sequence, row.sequence);
      } else perWork.set(row.workId, { ...row, count: 1 });
    }
    let total = 0;
    for (const [workId, e] of perWork) {
      total += e.payloadBytes;
      this.upsertGap(workId, code, e.count, e.payloadBytes, e.sequence);
      this.db
        .prepare(
          "UPDATE diagnostic_executions SET payloadBytes = MAX(0, payloadBytes - ?) WHERE workId = ?",
        )
        .run(e.payloadBytes, workId);
    }
    this.db
      .prepare(
        "UPDATE diagnostic_usage SET totalBytes = MAX(0, totalBytes - ?) WHERE id = 1",
      )
      .run(total);
    return rows.length;
  }

  /** Runs a mutation; a failure is counted and coalesced as a `capture-failed` gap. */
  private guard(action: () => unknown, workId?: string): void {
    try {
      action();
    } catch {
      this.unrecorded += 1;
      if (workId === undefined) return;
      try {
        this.upsertGap(workId, "capture-failed", 1, 0, 0);
      } catch {
        // The store itself is unavailable; the counter above is the only signal.
      }
    }
  }
}

type Exclusions = () => readonly string[] | undefined;

interface PendingItem {
  turnId: string | undefined;
  kind: DiagnosticKind;
  name: string;
  severity: string;
  itemId: string | undefined;
  payload: unknown;
}

const maxBufferedItems = 256;
const maxBufferedBytes = mib;

/** Severity of a runtime event: failures and non-zero exits warn. */
function runtimeSeverity(event: RuntimeDiagnosticEvent): string {
  if (event.kind === "turn")
    return event.status === "completed" ? "info" : "warn";
  if (typeof event.exitCode === "number" && event.exitCode !== 0) return "warn";
  return event.status === "failed" || event.status === "declined"
    ? "warn"
    : "info";
}

/**
 * Per-thread capture for one execution, like `ConversationHistoryCapture`: turn-bound
 * events buffer until the turn binds, wrong-turn events are dropped and events
 * after `finish` add a coalesced `late-event` gap. Never throws.
 */
export class ExecutionDiagnosticsCapture {
  private turnId: string | undefined;
  private closed = false;
  private buffered: PendingItem[] = [];
  private bufferedBytes = 0;
  private overflowed = false;

  constructor(
    private readonly options: {
      store: ExecutionDiagnosticsStore;
      workId: string;
      threadId: string;
      /** The general set: every instruction text stays redacted. */
      exclusions: Exclusions;
    },
  ) {}

  get workId() {
    return this.options.workId;
  }

  receive(event: RuntimeDiagnosticEvent): void {
    if (event.threadId !== this.options.threadId) return;
    const { kind: _kind, threadId: _thread, turnId, ...detail } = event;
    this.add({
      turnId,
      kind: "runtime",
      name:
        event.kind === "turn"
          ? "turn/completed"
          : `${event.itemType}/${event.phase}`,
      severity: runtimeSeverity(event),
      itemId: event.kind === "item" ? event.itemId : undefined,
      payload: detail,
    });
  }

  /** A coordination tool call or service event; `turnId` binds it to the turn. */
  add(item: PendingItem): void {
    try {
      if (this.closed) {
        this.options.store.gap(this.options.workId, "late-event");
        return;
      }
      if (item.turnId !== undefined && this.turnId === undefined) {
        if (this.overflowed) return;
        const bytes = Buffer.byteLength(JSON.stringify(item.payload) ?? "");
        if (
          this.buffered.length >= maxBufferedItems ||
          this.bufferedBytes + bytes > maxBufferedBytes
        ) {
          this.buffered = [];
          this.bufferedBytes = 0;
          this.overflowed = true;
          this.options.store.gap(this.options.workId, "early-buffer-limit");
          return;
        }
        this.buffered.push(item);
        this.bufferedBytes += bytes;
        return;
      }
      if (item.turnId !== undefined && item.turnId !== this.turnId) return;
      this.persist(item);
    } catch {
      // Diagnostics never change execution control.
    }
  }

  /** Records immediately with explicit exclusions; used for input segments. */
  recordNow(
    kind: DiagnosticKind,
    name: string,
    payload: unknown,
    exclusions: readonly string[] | undefined,
  ): void {
    if (this.closed) return;
    this.options.store.record(
      this.options.workId,
      kind,
      name,
      "info",
      undefined,
      payload,
      exclusions,
    );
  }

  gap(code: DiagnosticGapCode): void {
    this.options.store.gap(this.options.workId, code);
  }

  bind(turnId: string): void {
    if (this.closed || this.turnId !== undefined) return;
    this.turnId = turnId;
    this.options.store.bindTurn(this.options.workId, turnId);
    const buffered = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    for (const item of buffered) if (item.turnId === turnId) this.persist(item);
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffered = [];
    this.options.store.finish(this.options.workId);
  }

  private persist(item: PendingItem) {
    let exclusions: readonly string[] | undefined;
    try {
      exclusions = this.options.exclusions();
    } catch {
      exclusions = undefined;
    }
    this.options.store.record(
      this.options.workId,
      item.kind,
      item.name,
      item.severity,
      item.itemId,
      item.payload,
      exclusions,
    );
  }
}

interface DeleteRow {
  sequence: number;
  workId: string;
  payloadBytes: number;
}

function toItem(row: ItemRow): DiagnosticItem {
  let payload: unknown = null;
  try {
    if (row.payload !== null) payload = JSON.parse(row.payload);
  } catch {
    // A corrupt payload reads as absent.
  }
  return { ...row, payload };
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
