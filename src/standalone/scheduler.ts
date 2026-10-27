import { z } from "zod";
import { type Database, transaction } from "../core/store.js";

const requestSchema = z.object({
  requestKey: z.string().min(1),
  workId: z.string().min(1),
  kind: z.enum(["direct", "assignment", "drafting"]),
  taskId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  assignmentId: z.string().uuid().nullable(),
  taskVersion: z.number().int().positive().nullable(),
  assignmentVersion: z.number().int().positive().nullable(),
  instructionsRevision: z.number().int().positive().nullable(),
  profileRevision: z.number().int().positive().nullable(),
  prompt: z.string().min(1),
  workspace: z.string().min(1).nullable(),
  previousWorkId: z.string().min(1).nullable(),
  /** A read-only turn of the lead assignment on a task that is not Ready yet. */
  draftTurn: z.boolean().default(false),
  /** Digest of the task's title and outcome when a draft turn was queued; see `draftTaskDigest`. */
  draftTaskDigest: z.string().min(1).nullable().default(null),
});

export type TurnRequestInput = z.input<typeof requestSchema>;
export type TurnRequest = z.infer<typeof requestSchema> & {
  sequence: number;
  state: "queued" | "active" | "completed" | "held";
  reason: string | null;
  nextEligibleAt: number | null;
};

/** Durable request identity and fair FIFO order, separate from execution ownership. */
export class SchedulerStore {
  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      requestKey TEXT NOT NULL UNIQUE,
      workId TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('direct','assignment','drafting')),
      taskId TEXT,
      projectId TEXT,
      assignmentId TEXT,
      taskVersion INTEGER,
      assignmentVersion INTEGER,
      instructionsRevision INTEGER,
      profileRevision INTEGER,
      prompt TEXT NOT NULL,
      workspace TEXT,
      previousWorkId TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','active','completed','held')),
      reason TEXT,
      nextEligibleAt INTEGER,
      draftTurn INTEGER NOT NULL DEFAULT 0 CHECK(draftTurn IN (0,1)),
      draftTaskDigest TEXT
    )`);
    this.allowDraftingKind();
    // Execution list reads page by scope without scanning history.
    for (const column of ["taskId", "assignmentId", "projectId"])
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS turn_requests_${column}_sequence ON turn_requests(${column}, sequence)`,
      );
    const columns = this.db
      .prepare("PRAGMA table_info(turn_requests)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "nextEligibleAt"))
      this.db.exec(
        "ALTER TABLE turn_requests ADD COLUMN nextEligibleAt INTEGER",
      );
    if (!columns.some((column) => column.name === "draftTurn"))
      this.db.exec(
        "ALTER TABLE turn_requests ADD COLUMN draftTurn INTEGER NOT NULL DEFAULT 0 CHECK(draftTurn IN (0,1))",
      );
    if (!columns.some((column) => column.name === "draftTaskDigest"))
      this.db.exec("ALTER TABLE turn_requests ADD COLUMN draftTaskDigest TEXT");
  }

  /**
   * Databases created before drafting runs carry a CHECK that rejects the
   * `drafting` kind. SQLite cannot alter a CHECK, so rebuild the table in place,
   * keeping every row, its sequence and the AUTOINCREMENT high-water mark.
   */
  private allowDraftingKind(): void {
    const stored = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='turn_requests'",
      )
      .get() as { sql: string };
    if (stored.sql.includes("'drafting'")) return;
    const legacyCheck = "CHECK(kind IN ('direct','assignment'))";
    if (!stored.sql.includes(legacyCheck))
      throw new Error("Unrecognized turn request schema; migration refused");
    const rebuilt = stored.sql
      .replace(legacyCheck, "CHECK(kind IN ('direct','assignment','drafting'))")
      .replace(
        /CREATE TABLE\s+"?turn_requests"?/,
        "CREATE TABLE turn_requests_rebuild",
      );
    const foreignKeys = (
      this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
    ).foreign_keys;
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      transaction(this.db, () => {
        const highWater = this.db
          .prepare(
            "SELECT seq FROM sqlite_sequence WHERE name = 'turn_requests'",
          )
          .get() as { seq: number } | undefined;
        this.db.exec(`${rebuilt};
          INSERT INTO turn_requests_rebuild SELECT * FROM turn_requests;
          DROP TABLE turn_requests;
          ALTER TABLE turn_requests_rebuild RENAME TO turn_requests;`);
        if (highWater)
          this.db
            .prepare(
              "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'turn_requests'",
            )
            .run(highWater.seq);
        // Only what the rebuild could break: the table and the tables that reference it.
        const references = (
          this.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        )
          .map(({ name }) => name)
          .filter(
            (name) =>
              name === "turn_requests" ||
              (
                this.db
                  .prepare(`PRAGMA foreign_key_list("${name}")`)
                  .all() as Array<{ table: string }>
              ).some(({ table }) => table === "turn_requests"),
          );
        for (const name of references)
          if (
            this.db.prepare(`PRAGMA foreign_key_check("${name}")`).all().length
          )
            throw new Error("Turn request migration broke a foreign key");
      });
    } finally {
      this.db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
    }
  }

  ensure(input: TurnRequestInput): TurnRequest {
    const value = requestSchema.parse(input);
    const existing = this.db
      .prepare("SELECT * FROM turn_requests WHERE requestKey = ? OR workId = ?")
      .get(value.requestKey, value.workId) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      const current = this.parse(existing);
      if (current.previousWorkId !== value.previousWorkId)
        throw new Error(
          "Turn request identity already used with different predecessor",
        );
      if (current.prompt !== value.prompt)
        throw new Error(
          "Turn request identity already used with different prompt",
        );
      if (
        current.taskVersion !== value.taskVersion ||
        current.assignmentVersion !== value.assignmentVersion ||
        current.instructionsRevision !== value.instructionsRevision ||
        current.profileRevision !== value.profileRevision
      )
        throw new Error(
          "Turn request identity already used with different captured revisions",
        );
      if (value.workspace !== null && current.workspace !== value.workspace)
        throw new Error(
          "Turn request identity already used with different workspace",
        );
      if (
        current.requestKey !== value.requestKey ||
        current.workId !== value.workId ||
        current.kind !== value.kind ||
        current.taskId !== value.taskId ||
        current.projectId !== value.projectId ||
        current.assignmentId !== value.assignmentId ||
        current.draftTurn !== value.draftTurn ||
        current.draftTaskDigest !== value.draftTaskDigest
      )
        throw new Error(
          "Turn request identity already used with different content",
        );
      return current;
    }
    this.db
      .prepare(`INSERT INTO turn_requests
        (requestKey, workId, kind, taskId, projectId, assignmentId, taskVersion,
          assignmentVersion, instructionsRevision, profileRevision, prompt,
          workspace, previousWorkId, state, reason, draftTurn, draftTaskDigest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)`)
      .run(
        value.requestKey,
        value.workId,
        value.kind,
        value.taskId,
        value.projectId,
        value.assignmentId,
        value.taskVersion,
        value.assignmentVersion,
        value.instructionsRevision,
        value.profileRevision,
        value.prompt,
        value.workspace,
        value.previousWorkId,
        value.draftTurn ? 1 : 0,
        value.draftTaskDigest,
      );
    return this.byWorkId(value.workId);
  }

  createAssignment(
    input: Omit<
      TurnRequestInput,
      "requestKey" | "workId" | "kind" | "workspace"
    >,
    generation?: { requestKey: string; workId: string },
  ): TurnRequest {
    if (!input.assignmentId)
      throw new Error("Assignment request needs an assignment ID");
    return this.ensure({
      ...input,
      requestKey:
        generation?.requestKey ?? `assignment:${input.assignmentId}:initial`,
      workId: generation?.workId ?? `assignment:${input.assignmentId}:initial`,
      kind: "assignment",
      workspace: null,
    });
  }

  queued(now = Date.now()): TurnRequest[] {
    return this.db
      .prepare(`SELECT * FROM turn_requests WHERE state = 'queued'
        AND (nextEligibleAt IS NULL OR nextEligibleAt <= ?) ORDER BY sequence`)
      .all(now)
      .map((row) => this.parse(row as Record<string, unknown>));
  }

  nextEligibility(now = Date.now()): number | undefined {
    const row = this.db
      .prepare(`SELECT MIN(nextEligibleAt) AS nextEligibleAt
      FROM turn_requests WHERE state = 'queued' AND nextEligibleAt > ?`)
      .get(now) as { nextEligibleAt: number | null };
    return row.nextEligibleAt === null ? undefined : row.nextEligibleAt;
  }

  byWorkId(workId: string): TurnRequest {
    const row = this.db
      .prepare("SELECT * FROM turn_requests WHERE workId = ?")
      .get(workId);
    if (!row) throw new Error("Turn request disappeared");
    return this.parse(row as Record<string, unknown>);
  }

  sequence(workId: string): number {
    const row = this.db
      .prepare("SELECT sequence FROM turn_requests WHERE workId = ?")
      .get(workId) as { sequence: number } | undefined;
    if (!row) throw new Error("Turn request sequence is unavailable");
    return z.number().int().positive().parse(row.sequence);
  }

  list(): TurnRequest[] {
    return this.db
      .prepare("SELECT * FROM turn_requests ORDER BY sequence")
      .all()
      .map((row) => this.parse(row as Record<string, unknown>));
  }

  /** Newest-first keyset page of assignment work for one task, assignment or project. */
  assignmentPage(
    scope: "taskId" | "assignmentId" | "projectId",
    id: string,
    before: number | undefined,
    limit: number,
  ): TurnRequest[] {
    const column = {
      taskId: "taskId",
      assignmentId: "assignmentId",
      projectId: "projectId",
    }[scope];
    return this.db
      .prepare(`SELECT * FROM turn_requests WHERE kind = 'assignment'
        AND ${column} = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`)
      .all(id, before ?? Number.MAX_SAFE_INTEGER, limit)
      .map((row) => this.parse(row as Record<string, unknown>));
  }

  /** One request by work id, or undefined; never throws for an unknown id. */
  find(workId: string): TurnRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM turn_requests WHERE workId = ?")
      .get(workId);
    return row ? this.parse(row as Record<string, unknown>) : undefined;
  }

  /** The assignment's newest active request, else its newest request of `version`. */
  current(assignmentId: string, version: number): TurnRequest | undefined {
    const row =
      this.db
        .prepare(`SELECT * FROM turn_requests WHERE assignmentId = ?
          AND state = 'active' ORDER BY sequence DESC LIMIT 1`)
        .get(assignmentId) ??
      (Number.isSafeInteger(version)
        ? this.db
            .prepare(`SELECT * FROM turn_requests WHERE assignmentId = ?
              AND assignmentVersion = ? ORDER BY sequence DESC LIMIT 1`)
            .get(assignmentId, version)
        : undefined);
    return row ? this.parse(row as Record<string, unknown>) : undefined;
  }

  /** Whether the assignment has any turn that is not a draft turn. */
  hasOrdinaryAssignmentWork(assignmentId: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM turn_requests WHERE assignmentId = ?
          AND kind = 'assignment' AND draftTurn = 0 LIMIT 1`)
        .get(assignmentId) !== undefined
    );
  }

  /** Whether the assignment has only had draft turns: some, and nothing else. */
  hasOnlyDraftTurns(assignmentId: string): boolean {
    return (
      !this.hasOrdinaryAssignmentWork(assignmentId) &&
      this.db
        .prepare(`SELECT 1 FROM turn_requests WHERE assignmentId = ?
          AND kind = 'assignment' AND draftTurn = 1 LIMIT 1`)
        .get(assignmentId) !== undefined
    );
  }

  /**
   * The task's draft turn that is still queued, held or running, if any. A request refused
   * before it ever ran (it has a refusal row; Stop writes none) is finished, not active.
   */
  activeDraftTurn(taskId: string): TurnRequest | undefined {
    const refusals = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_request_refusals'",
      )
      .get();
    const row = this.db
      .prepare(`SELECT * FROM turn_requests WHERE taskId = ? AND draftTurn = 1
        AND state IN ('queued','active','held')
        ${
          refusals
            ? `AND NOT (state = 'held' AND EXISTS (SELECT 1 FROM execution_request_refusals
          refusal WHERE refusal.workId = turn_requests.workId))`
            : ""
        }
        ORDER BY sequence DESC LIMIT 1`)
      .get(taskId);
    return row ? this.parse(row as Record<string, unknown>) : undefined;
  }

  forTask(taskId: string): TurnRequest[] {
    return this.db
      .prepare("SELECT * FROM turn_requests WHERE taskId = ? ORDER BY sequence")
      .all(taskId)
      .map((row) => this.parse(row as Record<string, unknown>));
  }

  /** One task's requests counted up to `limit`, reading at most `limit` index entries. */
  countForTaskUpTo(taskId: string, limit: number): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM (SELECT 1 FROM turn_requests WHERE taskId = ? LIMIT ?)",
          )
          .get(taskId, limit) as { count: number }
      ).count,
    );
  }

  setWorkspace(workId: string, workspace: string): void {
    const current = this.byWorkId(workId);
    if (current.workspace !== null && current.workspace !== workspace)
      throw new Error("Turn request workspace identity changed");
    this.db
      .prepare("UPDATE turn_requests SET workspace = ? WHERE workId = ?")
      .run(workspace, workId);
  }

  /** Re-captures a queued request; callers ensure it never reached an execution. */
  recapture(
    workId: string,
    input: Pick<
      TurnRequestInput,
      | "taskVersion"
      | "assignmentVersion"
      | "instructionsRevision"
      | "profileRevision"
      | "prompt"
    >,
  ): void {
    this.db
      .prepare(`UPDATE turn_requests SET taskVersion = ?, assignmentVersion = ?,
        instructionsRevision = ?, profileRevision = ?, prompt = ?, reason = NULL
        WHERE workId = ? AND state = 'queued'`)
      .run(
        input.taskVersion ?? null,
        input.assignmentVersion ?? null,
        input.instructionsRevision ?? null,
        input.profileRevision ?? null,
        input.prompt,
        workId,
      );
  }

  wait(workId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE turn_requests SET reason = ? WHERE workId = ? AND state = 'queued'",
      )
      .run(reason, workId);
  }

  hold(workId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE turn_requests SET state = 'held', reason = ? WHERE workId = ?",
      )
      .run(reason, workId);
  }

  private parse(row: Record<string, unknown>): TurnRequest {
    const value = requestSchema.parse({
      requestKey: row.requestKey,
      workId: row.workId,
      kind: row.kind,
      taskId: row.taskId,
      projectId: row.projectId,
      assignmentId: row.assignmentId,
      taskVersion: row.taskVersion,
      assignmentVersion: row.assignmentVersion,
      instructionsRevision: row.instructionsRevision,
      profileRevision: row.profileRevision,
      prompt: row.prompt,
      workspace: row.workspace,
      previousWorkId: row.previousWorkId,
      draftTurn: row.draftTurn === 1,
      draftTaskDigest:
        typeof row.draftTaskDigest === "string" ? row.draftTaskDigest : null,
    });
    const state = z
      .enum(["queued", "active", "completed", "held"])
      .parse(row.state);
    return {
      ...value,
      sequence: z.number().int().positive().parse(row.sequence),
      state,
      reason: z.string().nullable().parse(row.reason),
      nextEligibleAt:
        row.nextEligibleAt === null || row.nextEligibleAt === undefined
          ? null
          : z.number().int().nonnegative().safe().parse(row.nextEligibleAt),
    };
  }
}

/** Serializes scheduler wakeups while execution itself continues independently. */
export class TurnScheduler {
  private stopped = true;
  private draining: Promise<void> | undefined;
  private wakeAgain = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: SchedulerStore,
    private readonly attempt: (request: TurnRequest) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly onBackgroundFailure: (
      error: unknown,
    ) => void | Promise<void> = () => {
      process.stderr.write("Turn scheduler background drain failed\n");
    },
  ) {}

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async settle(): Promise<void> {
    await this.draining;
  }

  async wake(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeAgain = true;
    while (!this.stopped) {
      const draining = this.draining ?? this.startDrain();
      await draining;
      if (!this.draining && !this.wakeAgain) return;
    }
  }

  private startDrain(): Promise<void> {
    const draining = this.drain().finally(() => {
      if (this.draining !== draining) return;
      this.draining = undefined;
      if (this.wakeAgain && !this.stopped) {
        const replacement = this.startDrain();
        void replacement.catch((error: unknown) =>
          this.reportBackgroundFailure(error),
        );
      } else this.scheduleNextWake();
    });
    this.draining = draining;
    return draining;
  }

  private scheduleNextWake(): void {
    if (this.stopped) return;
    const next = this.store.nextEligibility(this.now());
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(next - this.now(), 2_147_483_647));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.wake().catch((error: unknown) =>
        this.reportBackgroundFailure(error),
      );
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    while (this.wakeAgain && !this.stopped) {
      this.wakeAgain = false;
      for (const request of this.store.queued(this.now())) {
        if (this.stopped) return;
        await this.attempt(request);
      }
    }
  }

  private reportBackgroundFailure(error: unknown): void {
    try {
      void Promise.resolve(this.onBackgroundFailure(error)).catch(() => {});
    } catch {
      // A diagnostic observer must never own or alter scheduler failures.
    }
  }
}
