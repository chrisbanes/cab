import { createHash } from "node:crypto";
import { z } from "zod";
import { type Database, transaction } from "../core/store.js";
import {
  workspaceComparisonAnchorBase,
  workspaceComparisonEntryBase,
  workspaceComparisonHunkBase,
  workspaceComparisonSidesBase,
  workspaceComparisonSnapshotBase,
  workspaceTurnCaptureBase,
  workspaceTurnComparisonBase,
} from "../core/workspace-comparison-contracts.js";
import type {
  WorkspaceComparisonExport,
  WorkspaceComparisonSideContent,
  WorkspaceComparisonSnapshot,
  WorkspaceTurnCaptureRecord,
  WorkspaceTurnComparisonSnapshot,
} from "./workspace-comparison.js";

const maxComparisonRecordBytes = 20 * 1024 * 1024;

const anchorSchema = workspaceComparisonAnchorBase.refine(
  (anchor) => anchor.endLine >= anchor.startLine,
  {
    message: "invalid-anchor-range",
  },
);

const hunkSchema = workspaceComparisonHunkBase
  .extend({
    leftAnchor: anchorSchema.optional(),
    rightAnchor: anchorSchema.optional(),
  })
  .strict();

const entrySchema = workspaceComparisonEntryBase
  .extend({ hunks: z.array(hunkSchema).max(2048) })
  .strict();

const comparisonSnapshotSchema = workspaceComparisonSnapshotBase
  .extend({ entries: z.array(entrySchema).max(256) })
  .strict();

const turnComparisonSchema = workspaceTurnComparisonBase
  .extend({ entries: z.array(entrySchema).max(256) })
  .strict();

const turnCaptureSchema = workspaceTurnCaptureBase
  .extend({ comparison: turnComparisonSchema.optional() })
  .strict()
  .superRefine((capture, context) => {
    if (
      capture.captureState === "finished" &&
      (capture.outcome !== "completed" ||
        capture.before ||
        capture.after ||
        !capture.comparison)
    )
      context.addIssue({
        code: "custom",
        message: "invalid-finished-capture-payload",
      });
    if (
      capture.comparison &&
      (capture.comparison.comparisonId !== capture.comparisonId ||
        capture.comparison.taskId !== capture.identity.taskId ||
        capture.comparison.workId !== capture.identity.workId ||
        capture.comparison.workRevision !== capture.identity.workRevision ||
        capture.comparison.requestSequence !==
          capture.identity.requestSequence ||
        capture.comparison.assignmentId !== capture.identity.assignmentId ||
        capture.comparison.assignmentVersion !==
          capture.identity.assignmentVersion ||
        capture.comparison.instructionsRevision !==
          capture.identity.instructionsRevision ||
        capture.comparison.profileRevision !==
          capture.identity.profileRevision ||
        capture.comparison.profileId !== capture.identity.profileId ||
        capture.comparison.threadId !== capture.threadId ||
        capture.comparison.turnId !== capture.turnId)
    )
      context.addIssue({
        code: "custom",
        message: "turn-comparison-identity-mismatch",
      });
  });

function serialize<T>(value: T): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > maxComparisonRecordBytes)
    throw new Error("comparison-record-limit");
  return text;
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("comparison-store-corrupt");
  }
  return schema.parse(value);
}

const parseComparison = (text: string) =>
  parseJson(text, comparisonSnapshotSchema);
const parseSides = (text: string) =>
  parseJson(text, workspaceComparisonSidesBase);
// Rows recorded before the task revision was captured lack `taskVersion`; the
// in-memory record requires it, so every turn-capture parse casts back to it.
const parseTurnCapture = (text: string) =>
  parseJson(text, turnCaptureSchema) as WorkspaceTurnCaptureRecord;

const identityFields = [
  "taskId",
  "taskVersion",
  "workId",
  "workRevision",
  "requestSequence",
  "assignmentId",
  "assignmentVersion",
  "instructionsRevision",
  "profileRevision",
  "profileId",
] as const;

function textLineCount(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (const character of text) if (character === "\n") lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

function sameIdentity(
  left: WorkspaceTurnCaptureRecord["identity"],
  right: WorkspaceTurnCaptureRecord["identity"],
): boolean {
  return identityFields.every((field) => left[field] === right[field]);
}

function validateComparisonExport(
  comparison: WorkspaceComparisonSnapshot | WorkspaceTurnComparisonSnapshot,
  sides: readonly WorkspaceComparisonSideContent[],
): void {
  const sideByIndex = new Map<number, WorkspaceComparisonSideContent>();
  for (const side of sides) {
    if (
      sideByIndex.has(side.entryIndex) ||
      side.entryIndex >= comparison.entries.length
    )
      throw new Error("comparison-side-index-invalid");
    sideByIndex.set(side.entryIndex, side);
    const entry = comparison.entries[side.entryIndex];
    if (!entry) throw new Error("comparison-side-entry-missing");
    for (const name of ["left", "right"] as const) {
      const text = name === "left" ? side.leftText : side.rightText;
      if (text === undefined) continue;
      const expected = entry[name]?.sha256;
      const content = entry[name];
      const bytes = Buffer.from(text, "utf8");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (
        !expected ||
        expected !== actual ||
        content?.size !== bytes.length ||
        content.lineCount !== textLineCount(text)
      )
        throw new Error("comparison-side-content-mismatch");
    }
  }

  const expectedContext = comparison.target;
  for (const [entryIndex, entry] of comparison.entries.entries()) {
    const expectedRepositoryId =
      comparison.target === "turn"
        ? (entry.repositoryId ?? null)
        : comparison.repositoryId;
    if (
      comparison.target !== "turn" &&
      entry.repositoryId !== undefined &&
      entry.repositoryId !== expectedRepositoryId
    )
      throw new Error("comparison-entry-repository-mismatch");
    const side = sideByIndex.get(entryIndex);
    for (const hunk of entry.hunks) {
      for (const [anchorSide, anchor] of [
        ["left", hunk.leftAnchor],
        ["right", hunk.rightAnchor],
      ] as const) {
        if (!anchor) continue;
        const content = entry[anchorSide];
        const text = anchorSide === "left" ? side?.leftText : side?.rightText;
        const expectedPath =
          anchorSide === "left"
            ? (entry.previousPath ?? entry.path)
            : entry.path;
        if (
          anchor.taskId !== comparison.taskId ||
          anchor.repositoryId !== expectedRepositoryId ||
          anchor.side !== anchorSide ||
          anchor.path !== expectedPath ||
          anchor.comparisonId !== comparison.comparisonId ||
          anchor.context !== expectedContext ||
          anchor.contentSha256 !== content?.sha256 ||
          content?.lineCount === null ||
          content?.lineCount === undefined ||
          anchor.endLine > content.lineCount ||
          text === undefined
        )
          throw new Error("comparison-anchor-content-mismatch");
        if (
          comparison.target === "turn" &&
          (anchor.workId !== comparison.workId ||
            anchor.threadId !== comparison.threadId ||
            anchor.turnId !== comparison.turnId)
        )
          throw new Error("comparison-turn-anchor-identity-mismatch");
      }
    }
  }
}

export interface WorkspaceTurnCaptureSlots {
  latestFinished?: WorkspaceTurnCaptureRecord;
  pending?: WorkspaceTurnCaptureRecord;
}

/** Durable current-comparison and latest/pending turn-capture slots. */
export class SqliteWorkspaceComparisonStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_comparison_current (
        taskId TEXT NOT NULL,
        repositoryId TEXT NOT NULL,
        target TEXT NOT NULL CHECK(target IN ('branch','uncommitted')),
        comparisonId TEXT NOT NULL UNIQUE,
        snapshotJson TEXT NOT NULL,
        sidesJson TEXT NOT NULL,
        PRIMARY KEY(taskId, repositoryId, target)
      );
      CREATE TABLE IF NOT EXISTS workspace_turn_capture_slots (
        taskId TEXT PRIMARY KEY,
        latestFinishedId TEXT,
        pendingId TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace_turn_captures (
        comparisonId TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        captureState TEXT NOT NULL CHECK(captureState IN ('pending','unsettled','finished')),
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_turn_captures_task_idx
        ON workspace_turn_captures(taskId, captureState);
    `);
  }

  replaceCurrentComparison(
    comparison: WorkspaceComparisonSnapshot,
    sides: readonly WorkspaceComparisonSideContent[] = [],
  ): void {
    const parsed = comparisonSnapshotSchema.parse(comparison);
    const parsedSides = workspaceComparisonSidesBase.parse(sides);
    validateComparisonExport(parsed, parsedSides);
    if (
      parsed.entries.some((entry) =>
        entry.hunks.some((hunk) =>
          [hunk.leftAnchor, hunk.rightAnchor].some(
            (anchor) =>
              anchor !== undefined &&
              (anchor.taskId !== parsed.taskId ||
                anchor.repositoryId !== parsed.repositoryId ||
                anchor.comparisonId !== parsed.comparisonId),
          ),
        ),
      )
    )
      throw new Error("comparison-anchor-identity-mismatch");
    const snapshotJson = serialize(parsed);
    const sidesJson = serialize(parsedSides);
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO workspace_comparison_current
        (taskId, repositoryId, target, comparisonId, snapshotJson, sidesJson)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(taskId, repositoryId, target) DO UPDATE SET
          comparisonId = excluded.comparisonId,
          snapshotJson = excluded.snapshotJson,
          sidesJson = excluded.sidesJson`)
        .run(
          parsed.taskId,
          parsed.repositoryId,
          parsed.target,
          parsed.comparisonId,
          snapshotJson,
          sidesJson,
        );
    });
  }

  currentComparison(
    taskId: string,
    repositoryId: string,
    target: WorkspaceComparisonSnapshot["target"],
  ): WorkspaceComparisonExport | undefined {
    const row = this.db
      .prepare(`SELECT snapshotJson, sidesJson
      FROM workspace_comparison_current
      WHERE taskId = ? AND repositoryId = ? AND target = ?`)
      .get(taskId, repositoryId, target) as
      | { snapshotJson: string; sidesJson: string }
      | undefined;
    if (!row) return undefined;
    const comparison = parseComparison(row.snapshotJson);
    const sides = parseSides(row.sidesJson);
    if (
      comparison.taskId !== taskId ||
      comparison.repositoryId !== repositoryId ||
      comparison.target !== target
    )
      throw new Error("comparison-store-identity-mismatch");
    return { comparison, sides };
  }

  comparisonById(
    taskId: string,
    comparisonId: string,
  ): WorkspaceComparisonExport | undefined {
    const row = this.db
      .prepare(`SELECT snapshotJson, sidesJson
      FROM workspace_comparison_current
      WHERE taskId = ? AND comparisonId = ?`)
      .get(taskId, comparisonId) as
      | { snapshotJson: string; sidesJson: string }
      | undefined;
    if (!row) return undefined;
    const comparison = parseComparison(row.snapshotJson);
    const sides = parseSides(row.sidesJson);
    if (
      comparison.taskId !== taskId ||
      comparison.comparisonId !== comparisonId
    )
      throw new Error("comparison-store-identity-mismatch");
    validateComparisonExport(comparison, sides);
    return { comparison, sides };
  }

  exportComparison(
    taskId: string,
    comparisonId: string,
  ): WorkspaceComparisonExport | undefined {
    const current = this.comparisonById(taskId, comparisonId);
    if (current) return current;
    const capture = this.turnCapture(taskId, comparisonId);
    if (
      !capture?.comparison ||
      capture.identity.taskId !== taskId ||
      capture.comparison.comparisonId !== comparisonId
    )
      return undefined;
    const sides = capture.sides ?? [];
    validateComparisonExport(capture.comparison, sides);
    return {
      comparison: capture.comparison,
      sides,
      captureState: capture.captureState,
    };
  }

  comparisonOwner(comparisonId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT taskId FROM workspace_comparison_current WHERE comparisonId = ?
      UNION ALL
      SELECT taskId FROM workspace_turn_captures WHERE comparisonId = ?
      LIMIT 1`)
      .get(comparisonId, comparisonId) as { taskId: string } | undefined;
    return row?.taskId;
  }

  beginTurnCapture(capture: WorkspaceTurnCaptureRecord): void {
    const parsed = turnCaptureSchema.parse(
      capture,
    ) as WorkspaceTurnCaptureRecord;
    if (
      parsed.captureState !== "pending" ||
      parsed.outcome !== "running" ||
      !parsed.before
    )
      throw new Error("invalid-pending-turn-capture");
    const payloadJson = serialize(parsed);
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT OR IGNORE INTO workspace_turn_capture_slots
        (taskId, latestFinishedId, pendingId) VALUES (?, NULL, NULL)`)
        .run(parsed.identity.taskId);
      const slot = this.slot(parsed.identity.taskId);
      if (slot?.pendingId)
        this.db
          .prepare("DELETE FROM workspace_turn_captures WHERE comparisonId = ?")
          .run(slot.pendingId);
      this.db
        .prepare(`INSERT INTO workspace_turn_captures
        (comparisonId, taskId, captureState, payloadJson) VALUES (?, ?, 'pending', ?)`)
        .run(parsed.comparisonId, parsed.identity.taskId, payloadJson);
      this.db
        .prepare(
          "UPDATE workspace_turn_capture_slots SET pendingId = ? WHERE taskId = ?",
        )
        .run(parsed.comparisonId, parsed.identity.taskId);
    });
  }

  bindTurnCapture(
    comparisonId: string,
    threadId: string,
    turnId: string,
  ): boolean {
    const exactThreadId = z.string().min(1).parse(threadId);
    const exactTurnId = z.string().min(1).parse(turnId);
    const current = this.pendingTurnCapture(comparisonId);
    if (!current || current.threadId || current.turnId) return false;
    const next = turnCaptureSchema.parse({
      ...current,
      threadId: exactThreadId,
      turnId: exactTurnId,
    }) as WorkspaceTurnCaptureRecord;
    return this.updatePendingTurnCapture(next);
  }

  updatePendingTurnCapture(capture: WorkspaceTurnCaptureRecord): boolean {
    const parsed = turnCaptureSchema.parse(
      capture,
    ) as WorkspaceTurnCaptureRecord;
    if (parsed.captureState === "finished")
      throw new Error("finished-capture-cannot-update-pending");
    const payloadJson = serialize(parsed);
    return transaction(this.db, () => {
      const slot = this.slot(parsed.identity.taskId);
      if (slot?.pendingId !== parsed.comparisonId) return false;
      const existing = this.pendingTurnCapture(parsed.comparisonId);
      if (
        !existing ||
        !sameIdentity(existing.identity, parsed.identity) ||
        (existing.threadId !== undefined &&
          existing.threadId !== parsed.threadId) ||
        (existing.turnId !== undefined && existing.turnId !== parsed.turnId)
      )
        return false;
      const result = this.db
        .prepare(`UPDATE workspace_turn_captures
        SET captureState = ?, payloadJson = ?
        WHERE comparisonId = ? AND taskId = ? AND captureState IN ('pending','unsettled')`)
        .run(
          parsed.captureState,
          payloadJson,
          parsed.comparisonId,
          parsed.identity.taskId,
        ) as { changes?: number };
      return (result.changes ?? 0) === 1;
    });
  }

  finishTurnCapture(capture: WorkspaceTurnCaptureRecord): boolean {
    const parsed = turnCaptureSchema.parse(
      capture,
    ) as WorkspaceTurnCaptureRecord;
    if (
      parsed.captureState !== "finished" ||
      parsed.outcome !== "completed" ||
      !parsed.threadId ||
      !parsed.turnId ||
      !parsed.comparison ||
      parsed.comparison.comparisonId !== parsed.comparisonId
    )
      throw new Error("invalid-finished-turn-capture");
    const comparison = parsed.comparison;
    if (!comparison) throw new Error("invalid-finished-turn-capture");
    if (
      comparison.target !== "turn" ||
      comparison.taskId !== parsed.identity.taskId ||
      comparison.taskVersion !== parsed.identity.taskVersion ||
      comparison.workId !== parsed.identity.workId ||
      comparison.workRevision !== parsed.identity.workRevision ||
      comparison.requestSequence !== parsed.identity.requestSequence ||
      comparison.assignmentId !== parsed.identity.assignmentId ||
      comparison.assignmentVersion !== parsed.identity.assignmentVersion ||
      comparison.instructionsRevision !==
        parsed.identity.instructionsRevision ||
      comparison.profileRevision !== parsed.identity.profileRevision ||
      comparison.profileId !== parsed.identity.profileId ||
      comparison.threadId !== parsed.threadId ||
      comparison.turnId !== parsed.turnId
    )
      throw new Error("finished-turn-comparison-binding-mismatch");
    validateComparisonExport(comparison, parsed.sides ?? []);
    const payloadJson = serialize(parsed);
    return transaction(this.db, () => {
      const slot = this.slot(parsed.identity.taskId);
      if (slot?.pendingId !== parsed.comparisonId) return false;
      const existing = this.pendingTurnCapture(parsed.comparisonId);
      if (
        !existing ||
        !sameIdentity(existing.identity, parsed.identity) ||
        existing.threadId !== parsed.threadId ||
        existing.turnId !== parsed.turnId ||
        existing.comparison?.comparisonId !== comparison.comparisonId
      )
        return false;
      const updated = this.db
        .prepare(`UPDATE workspace_turn_captures
        SET captureState = 'finished', payloadJson = ?
        WHERE comparisonId = ? AND taskId = ? AND captureState IN ('pending','unsettled')`)
        .run(payloadJson, parsed.comparisonId, parsed.identity.taskId) as {
        changes?: number;
      };
      if ((updated.changes ?? 0) !== 1) return false;
      if (
        slot.latestFinishedId &&
        slot.latestFinishedId !== parsed.comparisonId
      )
        this.db
          .prepare("DELETE FROM workspace_turn_captures WHERE comparisonId = ?")
          .run(slot.latestFinishedId);
      this.db
        .prepare(`UPDATE workspace_turn_capture_slots
        SET latestFinishedId = ?, pendingId = NULL WHERE taskId = ?`)
        .run(parsed.comparisonId, parsed.identity.taskId);
      return true;
    });
  }

  latestTurnCaptures(taskId: string): WorkspaceTurnCaptureSlots {
    const slot = this.slot(taskId);
    if (!slot) return {};
    const latestFinished = slot.latestFinishedId
      ? this.turnCapture(taskId, slot.latestFinishedId)
      : undefined;
    const pending = slot.pendingId
      ? this.turnCapture(taskId, slot.pendingId)
      : undefined;
    return {
      ...(latestFinished ? { latestFinished } : {}),
      ...(pending ? { pending } : {}),
    };
  }

  private pendingTurnCapture(
    comparisonId: string,
  ): WorkspaceTurnCaptureRecord | undefined {
    const row = this.db
      .prepare(`SELECT payloadJson FROM workspace_turn_captures
      WHERE comparisonId = ? AND captureState IN ('pending','unsettled')`)
      .get(comparisonId) as { payloadJson: string } | undefined;
    if (!row) return undefined;
    const capture = parseTurnCapture(row.payloadJson);
    if (capture.comparisonId !== comparisonId)
      throw new Error("turn-capture-store-identity-mismatch");
    if (capture.comparison)
      validateComparisonExport(capture.comparison, capture.sides ?? []);
    return capture;
  }

  private turnCapture(
    taskId: string,
    comparisonId: string,
  ): WorkspaceTurnCaptureRecord | undefined {
    const row = this.db
      .prepare(`SELECT payloadJson FROM workspace_turn_captures
      WHERE taskId = ? AND comparisonId = ?`)
      .get(taskId, comparisonId) as { payloadJson: string } | undefined;
    if (!row) return undefined;
    const capture = parseTurnCapture(row.payloadJson);
    if (
      capture.identity.taskId !== taskId ||
      capture.comparisonId !== comparisonId ||
      (capture.captureState === "finished" &&
        capture.comparison?.comparisonId !== comparisonId)
    )
      throw new Error("turn-capture-store-identity-mismatch");
    if (capture.comparison)
      validateComparisonExport(capture.comparison, capture.sides ?? []);
    return capture;
  }

  private slot(
    taskId: string,
  ): { latestFinishedId: string | null; pendingId: string | null } | undefined {
    return this.db
      .prepare(`SELECT latestFinishedId, pendingId
      FROM workspace_turn_capture_slots WHERE taskId = ?`)
      .get(taskId) as
      | { latestFinishedId: string | null; pendingId: string | null }
      | undefined;
  }
}
