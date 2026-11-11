import { assertOwnedTaskWritable } from "./project-lifecycle.js";
import { DomainConflictError } from "./domain.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { reviewAnchorRecordBaseSchema } from "./review-anchor-contracts.js";
import { transaction, type Database } from "./store.js";

export const retainedEvidenceLimits = Object.freeze({
  maxInstallationBytes: 512 * 1024 * 1024,
  maxReviewAnchorBytes: 256 * 1024,
  maxReviewAnchorsPerTask: 128,
  maxTaskReviewBytes: 16 * 1024 * 1024,
});

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** The stored record plus store-only fields: the origin root and the excerpt bytes. */
const reviewAnchorCandidateSchema = reviewAnchorRecordBaseSchema
  .extend({
    originRoot: z.string().min(1).max(4096).optional(),
    bytes: z.instanceof(Uint8Array).optional(),
  })
  .strict()
  .superRefine((anchor, ctx) => {
    if (anchor.endLine < anchor.startLine)
      ctx.addIssue({ code: "custom", message: "invalid-anchor-range" });
    if (
      (anchor.sourceKind === "workspace-file" &&
        anchor.context !== "workspace") ||
      (anchor.sourceKind === "comparison-side" &&
        !["branch", "uncommitted", "turn"].includes(anchor.context))
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-source-context-mismatch",
      });
    if (
      (anchor.sourceKind === "comparison-side") !==
      (anchor.comparisonId !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-comparison-identity-mismatch",
      });
    if (anchor.state === "available") {
      if (
        !anchor.bytes ||
        !anchor.sourceSha256 ||
        !anchor.excerptSha256 ||
        anchor.byteStart === undefined ||
        anchor.byteEnd === undefined ||
        !anchor.originRoot ||
        !anchor.mime ||
        anchor.reason !== undefined
      )
        ctx.addIssue({
          code: "custom",
          message: "available-anchor-is-incomplete",
        });
      else {
        if (anchor.size !== anchor.bytes.byteLength)
          ctx.addIssue({ code: "custom", message: "anchor-size-mismatch" });
        if (
          createHash("sha256").update(anchor.bytes).digest("hex") !==
          anchor.excerptSha256
        )
          ctx.addIssue({ code: "custom", message: "anchor-hash-mismatch" });
      }
    } else if (
      anchor.bytes ||
      anchor.sourceSha256 !== undefined ||
      anchor.excerptSha256 !== undefined ||
      anchor.byteStart !== undefined ||
      anchor.byteEnd !== undefined ||
      anchor.originRoot !== undefined ||
      anchor.mime !== undefined ||
      anchor.size !== 0 ||
      anchor.reason === undefined
    )
      ctx.addIssue({ code: "custom", message: "gap-anchor-is-invalid" });
  });

const retainedReviewAnchorResponseSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    draftId: uuid,
    state: z.literal("staged"),
    anchorIds: z.array(uuid).max(32),
    anchorStates: z
      .array(
        z
          .object({
            anchorId: uuid,
            state: z.enum(["available", "gap"]),
            reason: z.string().max(80).optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
const retainedReviewAnchorSealResponseSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    draftId: uuid,
    submittedContextId: uuid,
    state: z.literal("sealed"),
    linkState: z.literal("durable"),
    deliveryState: z.literal("not-attempted"),
    receiptState: z.literal("none"),
    anchorIds: z.array(uuid).max(32),
  })
  .strict();
const retainedReviewAnchorDiscardResponseSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    draftId: uuid,
    state: z.literal("discarded"),
    submittedContextPreserved: z.boolean(),
  })
  .strict();
const reviewAnchorOperationSchema = z
  .object({
    operationId: uuid,
    taskId: uuid,
    kind: z.enum(["stage", "seal", "discard"]),
    materialHash: hash,
    responseJson: z.string().max(64 * 1024),
  })
  .strict();

export type RetainedReviewAnchorCandidate = z.input<
  typeof reviewAnchorCandidateSchema
>;
export type RetainedReviewAnchorStageResponse = z.infer<
  typeof retainedReviewAnchorResponseSchema
>;
export type RetainedReviewAnchorSealResponse = z.infer<
  typeof retainedReviewAnchorSealResponseSchema
>;
export type RetainedReviewAnchorDiscardResponse = z.infer<
  typeof retainedReviewAnchorDiscardResponseSchema
>;
export type RetainedReviewAnchorRecord = z.infer<
  typeof reviewAnchorRecordBaseSchema
>;
export interface RetainedReviewAnchorContent {
  anchor: RetainedReviewAnchorRecord;
  bytes?: Buffer;
  /** Internal only: used to reapply current path policy after workspace cleanup. */
  originRoot?: string;
}

export interface RetainedReviewAnchorDraft {
  draftId: string;
  taskId: string;
  state: "open" | "sealed" | "discarded";
  submittedContextId: string | null;
  createdAt: number;
  updatedAt: number;
  anchorIds: string[];
}

export interface RetainedReviewAnchorSubmittedContext {
  submittedContextId: string;
  taskId: string;
  createdAt: number;
  anchorIds: string[];
}

type Row = Record<string, string | number | Uint8Array | null>;

function gapReviewAnchor(
  candidate: z.infer<typeof reviewAnchorCandidateSchema>,
  reason: NonNullable<z.infer<typeof reviewAnchorCandidateSchema>["reason"]>,
) {
  const {
    bytes: _bytes,
    sourceSha256,
    excerptSha256: _excerptSha256,
    byteStart: _byteStart,
    byteEnd: _byteEnd,
    mime: _mime,
    originRoot: _originRoot,
    ...rest
  } = candidate;
  return reviewAnchorCandidateSchema.parse({
    ...rest,
    ...(sourceSha256 ? { claimedSha256: sourceSha256 } : {}),
    state: "gap",
    reason,
    size: 0,
  });
}

/** Durable bounded review anchors. Write methods ending in WithinTransaction require the caller's transaction. */
export class RetainedEvidenceStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    // The retired 'result-evidence' kind and 'result' context stay in the CHECK so fresh and migrated
    // schemas match (SQLite cannot alter a CHECK); the record schema refuses both.
    this.db.exec(`CREATE TABLE IF NOT EXISTS retained_review_anchor_contexts (
      anchorId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      repositoryId TEXT,
      path TEXT NOT NULL,
      originRoot TEXT,
      sourceKind TEXT NOT NULL CHECK(sourceKind IN ('workspace-file','comparison-side','result-evidence')),
      context TEXT NOT NULL CHECK(context IN ('workspace','branch','uncommitted','turn','result')),
      comparisonId TEXT,
      resultId TEXT,
      resultItemId TEXT,
      workId TEXT,
      threadId TEXT,
      turnId TEXT,
      side TEXT NOT NULL CHECK(side IN ('file','left','right')),
      startLine INTEGER NOT NULL CHECK(startLine > 0),
      endLine INTEGER NOT NULL CHECK(endLine >= startLine),
      sourceSha256 TEXT,
      claimedSha256 TEXT,
      excerptSha256 TEXT,
      byteStart INTEGER,
      byteEnd INTEGER,
      mime TEXT,
      state TEXT NOT NULL CHECK(state IN ('available','gap')),
      reason TEXT CHECK(reason IS NULL OR reason IN ('missing','unavailable','comparison-unavailable','comparison-unsettled','quota')),
      size INTEGER NOT NULL CHECK(size >= 0),
      capturedAt INTEGER NOT NULL CHECK(capturedAt >= 0),
      observedAt INTEGER,
      recordJson TEXT NOT NULL,
      content BLOB,
      CHECK((state='available' AND content IS NOT NULL AND sourceSha256 IS NOT NULL AND excerptSha256 IS NOT NULL AND byteStart IS NOT NULL AND byteEnd IS NOT NULL AND mime IS NOT NULL AND reason IS NULL) OR
            (state='gap' AND content IS NULL AND sourceSha256 IS NULL AND excerptSha256 IS NULL AND byteStart IS NULL AND byteEnd IS NULL AND mime IS NULL AND reason IS NOT NULL AND size=0))
    );
    CREATE INDEX IF NOT EXISTS retained_review_anchor_context_task
      ON retained_review_anchor_contexts(taskId,anchorId);
    CREATE TABLE IF NOT EXISTS retained_review_anchor_submitted_contexts (
      submittedContextId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      createdAt INTEGER NOT NULL CHECK(createdAt >= 0)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_drafts (
      draftId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      state TEXT NOT NULL CHECK(state IN ('open','sealed','discarded')),
      submittedContextId TEXT REFERENCES retained_review_anchor_submitted_contexts(submittedContextId),
      createdAt INTEGER NOT NULL CHECK(createdAt >= 0),
      updatedAt INTEGER NOT NULL CHECK(updatedAt >= createdAt),
      CHECK((state='sealed' AND submittedContextId IS NOT NULL) OR
            (state<>'sealed'))
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_draft_refs (
      draftId TEXT NOT NULL REFERENCES retained_review_anchor_drafts(draftId) ON DELETE CASCADE,
      anchorId TEXT NOT NULL REFERENCES retained_review_anchor_contexts(anchorId) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY(draftId,anchorId),
      UNIQUE(draftId,position)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_submitted_refs (
      submittedContextId TEXT NOT NULL REFERENCES retained_review_anchor_submitted_contexts(submittedContextId) ON DELETE CASCADE,
      anchorId TEXT NOT NULL REFERENCES retained_review_anchor_contexts(anchorId) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0),
      PRIMARY KEY(submittedContextId,anchorId),
      UNIQUE(submittedContextId,position)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_draft_submissions (
      draftId TEXT PRIMARY KEY REFERENCES retained_review_anchor_drafts(draftId) ON DELETE CASCADE,
      submittedContextId TEXT NOT NULL UNIQUE REFERENCES retained_review_anchor_submitted_contexts(submittedContextId)
    );
    CREATE TABLE IF NOT EXISTS retained_review_anchor_operations (
      operationId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL REFERENCES domain_tasks(id),
      kind TEXT NOT NULL CHECK(kind IN ('stage','seal','discard')),
      materialHash TEXT NOT NULL,
      responseJson TEXT NOT NULL
    );`);
  }

  /**
   * Retained result evidence (ADR-1033) is gone: drop its tables and the anchors that pointed into
   * them. Idempotent; runs inside CoordinationStore.migrate's transaction.
   */
  dropResultEvidence(): void {
    if (this.tableExists("retained_review_anchor_contexts")) {
      // Explicit ref deletes: the core Store toggles foreign_keys, so ON DELETE CASCADE may not run.
      const anchors =
        "SELECT anchorId FROM retained_review_anchor_contexts WHERE sourceKind='result-evidence'";
      this.db.exec(`DELETE FROM retained_review_anchor_draft_refs WHERE anchorId IN (${anchors});
        DELETE FROM retained_review_anchor_submitted_refs WHERE anchorId IN (${anchors});
        DELETE FROM retained_review_anchor_contexts WHERE sourceKind='result-evidence';`);
    }
    this.db.exec(`DROP TABLE IF EXISTS retained_result_evidence_items;
      DROP TABLE IF EXISTS retained_result_evidence;`);
  }

  reviewAnchorOperation(
    taskId: string,
    operationId: string,
    kind: "stage" | "seal" | "discard",
    materialHash: string,
  ):
    | RetainedReviewAnchorStageResponse
    | RetainedReviewAnchorSealResponse
    | RetainedReviewAnchorDiscardResponse
    | undefined {
    const row = this.db
      .prepare(
        `SELECT operationId,taskId,kind,materialHash,responseJson
        FROM retained_review_anchor_operations WHERE operationId=?`,
      )
      .get(operationId) as Row | undefined;
    if (!row) return undefined;
    const operation = reviewAnchorOperationSchema.parse({
      operationId: String(row.operationId),
      taskId: String(row.taskId),
      kind: String(row.kind),
      materialHash: String(row.materialHash),
      responseJson: String(row.responseJson),
    });
    if (
      operation.taskId !== taskId ||
      operation.kind !== kind ||
      operation.materialHash !== materialHash
    )
      throw new DomainConflictError(
        "Review anchor operation ID reused with different material",
      );
    const response = JSON.parse(operation.responseJson) as unknown;
    if (kind === "stage")
      return retainedReviewAnchorResponseSchema.parse(response);
    if (kind === "seal")
      return retainedReviewAnchorSealResponseSchema.parse(response);
    return retainedReviewAnchorDiscardResponseSchema.parse(response);
  }

  stageReviewAnchorDraft(
    taskId: string,
    operationId: string,
    materialHash: string,
    candidates: readonly RetainedReviewAnchorCandidate[],
  ): RetainedReviewAnchorStageResponse {
    uuid.parse(taskId);
    uuid.parse(operationId);
    hash.parse(materialHash);
    if (candidates.length > 32)
      throw new DomainConflictError(
        "Review anchor operation exceeds its selection limit",
      );
    const checked = candidates.map((candidate) =>
      reviewAnchorCandidateSchema.parse(candidate),
    );
    if (
      checked.some((candidate) => candidate.taskId !== taskId) ||
      new Set(checked.map((candidate) => candidate.anchorId)).size !==
        checked.length
    )
      throw new DomainConflictError("Review anchor task or identity mismatch");
    const stage = () => {
      const prior = this.reviewAnchorOperation(
        taskId,
        operationId,
        "stage",
        materialHash,
      );
      if (prior) return retainedReviewAnchorResponseSchema.parse(prior);
      const countRow = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM retained_review_anchor_contexts WHERE taskId=?",
        )
        .get(taskId) as Row;
      if (
        Number(countRow.count) + checked.length >
        retainedEvidenceLimits.maxReviewAnchorsPerTask
      )
        throw new DomainConflictError("Review anchor count quota exceeded");

      assertOwnedTaskWritable(this.db, taskId);
      const draftId = randomUUID();
      const now = Date.now();
      this.db
        .prepare(`INSERT INTO retained_review_anchor_drafts
        (draftId,taskId,state,submittedContextId,createdAt,updatedAt)
        VALUES (?,?,'open',NULL,?,?)`)
        .run(draftId, taskId, now, now);

      let taskBytes = this.storedBytes(
        "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_review_anchor_contexts WHERE taskId=? AND state='available'",
        taskId,
      );
      let installationBytes = this.storedBytes(
        "SELECT COALESCE(SUM(size),0) AS bytes FROM retained_review_anchor_contexts WHERE state='available'",
      );
      const anchorIds: string[] = [];
      const anchorStates: RetainedReviewAnchorStageResponse["anchorStates"] =
        [];
      const insertRef =
        this.db.prepare(`INSERT INTO retained_review_anchor_draft_refs
        (draftId,anchorId,position) VALUES (?,?,?)`);
      for (const [position, candidate] of checked.entries()) {
        let stored = candidate;
        const amount = candidate.state === "available" ? candidate.size : 0;
        if (
          candidate.state === "available" &&
          (amount > retainedEvidenceLimits.maxReviewAnchorBytes ||
            taskBytes + amount > retainedEvidenceLimits.maxTaskReviewBytes ||
            installationBytes + amount >
              retainedEvidenceLimits.maxInstallationBytes)
        ) {
          stored = gapReviewAnchor(candidate, "quota");
        } else if (candidate.state === "available") {
          taskBytes += amount;
          installationBytes += amount;
        }
        this.insertReviewAnchor(stored);
        insertRef.run(draftId, stored.anchorId, position);
        anchorIds.push(stored.anchorId);
        anchorStates.push({
          anchorId: stored.anchorId,
          state: stored.state,
          ...(stored.reason ? { reason: stored.reason } : {}),
        });
      }
      const response = retainedReviewAnchorResponseSchema.parse({
        operationId,
        taskId,
        draftId,
        state: "staged",
        anchorIds,
        anchorStates,
      });
      this.recordReviewAnchorOperation(
        operationId,
        taskId,
        "stage",
        materialHash,
        response,
      );
      return response;
    };
    return this.db.isTransaction === true
      ? stage()
      : transaction(this.db, stage);
  }

  /** Called inside a coordination transaction; keeps the #781 stage contract intact. */
  stageReviewAnchorDraftWithinTransaction(
    taskId: string,
    operationId: string,
    materialHash: string,
    candidates: readonly RetainedReviewAnchorCandidate[],
  ): RetainedReviewAnchorStageResponse {
    if (this.db.isTransaction === false)
      throw new DomainConflictError(
        "Review anchor staging requires the coordination transaction",
      );
    return this.stageReviewAnchorDraft(
      taskId,
      operationId,
      materialHash,
      candidates,
    );
  }

  sealReviewAnchorDraft(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
    anchorIds: readonly string[],
  ): RetainedReviewAnchorSealResponse {
    uuid.parse(taskId);
    uuid.parse(draftId);
    uuid.parse(operationId);
    hash.parse(materialHash);
    const checkedIds = anchorIds.map((id) => uuid.parse(id));
    if (
      checkedIds.length > 32 ||
      new Set(checkedIds).size !== checkedIds.length
    )
      throw new Error("Invalid review anchor references");
    const seal = () => {
      const prior = this.reviewAnchorOperation(
        taskId,
        operationId,
        "seal",
        materialHash,
      );
      if (prior) return retainedReviewAnchorSealResponseSchema.parse(prior);
      assertOwnedTaskWritable(this.db, taskId);
      const draft = this.db
        .prepare(`SELECT draftId,taskId,state,submittedContextId,createdAt,updatedAt
        FROM retained_review_anchor_drafts WHERE draftId=?`)
        .get(draftId) as Row | undefined;
      if (!draft || draft.taskId !== taskId)
        throw new DomainConflictError("Review anchor draft is unavailable");
      const refs = this.db
        .prepare(
          "SELECT anchorId FROM retained_review_anchor_draft_refs WHERE draftId=? ORDER BY position",
        )
        .all(draftId)
        .map((row) => String((row as Row).anchorId));
      if (
        refs.length !== checkedIds.length ||
        refs.some((anchorId, index) => anchorId !== checkedIds[index])
      )
        throw new DomainConflictError("Review anchor draft references changed");
      if (draft.state === "discarded" && draft.submittedContextId === null)
        throw new Error("Discarded review anchor draft cannot be sealed");

      let submittedContextId =
        draft.submittedContextId === null
          ? undefined
          : String(draft.submittedContextId);
      if (!submittedContextId) {
        submittedContextId = randomUUID();
        const createdAt = Date.now();
        this.db
          .prepare(`INSERT INTO retained_review_anchor_submitted_contexts
          (submittedContextId,taskId,createdAt) VALUES (?,?,?)`)
          .run(submittedContextId, taskId, createdAt);
        const insert =
          this.db.prepare(`INSERT INTO retained_review_anchor_submitted_refs
          (submittedContextId,anchorId,position) VALUES (?,?,?)`);
        for (const [position, anchorId] of checkedIds.entries())
          insert.run(submittedContextId, anchorId, position);
        this.db
          .prepare(`INSERT INTO retained_review_anchor_draft_submissions
          (draftId,submittedContextId) VALUES (?,?)`)
          .run(draftId, submittedContextId);
        this.db
          .prepare(`UPDATE retained_review_anchor_drafts
          SET state='sealed',submittedContextId=?,updatedAt=? WHERE draftId=? AND state='open'`)
          .run(submittedContextId, createdAt, draftId);
      } else {
        const submittedIds = this.db
          .prepare(
            "SELECT anchorId FROM retained_review_anchor_submitted_refs WHERE submittedContextId=? ORDER BY position",
          )
          .all(submittedContextId)
          .map((row) => String((row as Row).anchorId));
        if (
          submittedIds.length !== checkedIds.length ||
          submittedIds.some((anchorId, index) => anchorId !== checkedIds[index])
        )
          throw new Error("Submitted review anchor references changed");
      }
      const response = retainedReviewAnchorSealResponseSchema.parse({
        operationId,
        taskId,
        draftId,
        submittedContextId,
        state: "sealed",
        linkState: "durable",
        deliveryState: "not-attempted",
        receiptState: "none",
        anchorIds: checkedIds,
      });
      this.recordReviewAnchorOperation(
        operationId,
        taskId,
        "seal",
        materialHash,
        response,
      );
      return response;
    };
    return this.db.isTransaction === true ? seal() : transaction(this.db, seal);
  }

  /** Called inside SendLocalReview's one outer transaction. */
  sealReviewAnchorDraftWithinTransaction(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
    anchorIds: readonly string[],
  ): RetainedReviewAnchorSealResponse {
    if (this.db.isTransaction === false)
      throw new DomainConflictError(
        "Review anchor sealing requires the coordination transaction",
      );
    return this.sealReviewAnchorDraft(
      taskId,
      draftId,
      operationId,
      materialHash,
      anchorIds,
    );
  }

  discardReviewAnchorDraft(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
  ): RetainedReviewAnchorDiscardResponse {
    uuid.parse(taskId);
    uuid.parse(draftId);
    uuid.parse(operationId);
    hash.parse(materialHash);
    const discard = () => {
      const prior = this.reviewAnchorOperation(
        taskId,
        operationId,
        "discard",
        materialHash,
      );
      if (prior) return retainedReviewAnchorDiscardResponseSchema.parse(prior);
      assertOwnedTaskWritable(this.db, taskId);
      const draft = this.db
        .prepare(`SELECT draftId,taskId,state,submittedContextId
        FROM retained_review_anchor_drafts WHERE draftId=?`)
        .get(draftId) as Row | undefined;
      if (!draft || draft.taskId !== taskId)
        throw new DomainConflictError("Review anchor draft is unavailable");
      const preserved = draft.submittedContextId !== null;
      const orphanIds = this.db
        .prepare(
          `SELECT anchorId FROM retained_review_anchor_draft_refs
          WHERE draftId=? AND anchorId NOT IN (
            SELECT anchorId FROM retained_review_anchor_submitted_refs
          )`,
        )
        .all(draftId)
        .map((row) => String((row as Row).anchorId));
      this.db
        .prepare(
          "DELETE FROM retained_review_anchor_draft_refs WHERE draftId=?",
        )
        .run(draftId);
      this.db
        .prepare(`UPDATE retained_review_anchor_drafts
        SET state='discarded',updatedAt=? WHERE draftId=?`)
        .run(Date.now(), draftId);
      if (orphanIds.length) {
        const remove = this.db.prepare(
          "DELETE FROM retained_review_anchor_contexts WHERE anchorId=? AND NOT EXISTS (SELECT 1 FROM retained_review_anchor_draft_refs WHERE anchorId=?) AND NOT EXISTS (SELECT 1 FROM retained_review_anchor_submitted_refs WHERE anchorId=?)",
        );
        for (const anchorId of orphanIds)
          remove.run(anchorId, anchorId, anchorId);
      }
      const response = retainedReviewAnchorDiscardResponseSchema.parse({
        operationId,
        taskId,
        draftId,
        state: "discarded",
        submittedContextPreserved: preserved,
      });
      this.recordReviewAnchorOperation(
        operationId,
        taskId,
        "discard",
        materialHash,
        response,
      );
      return response;
    };
    return this.db.isTransaction === true
      ? discard()
      : transaction(this.db, discard);
  }

  /** Called inside a coordination transaction when reclaiming an unreferenced draft group. */
  discardReviewAnchorDraftWithinTransaction(
    taskId: string,
    draftId: string,
    operationId: string,
    materialHash: string,
  ): RetainedReviewAnchorDiscardResponse {
    if (this.db.isTransaction === false)
      throw new DomainConflictError(
        "Review anchor discard requires the coordination transaction",
      );
    return this.discardReviewAnchorDraft(
      taskId,
      draftId,
      operationId,
      materialHash,
    );
  }

  reviewAnchorDraft(
    taskId: string,
    draftId: string,
  ): RetainedReviewAnchorDraft | undefined {
    const row = this.db
      .prepare(`SELECT draftId,taskId,state,submittedContextId,createdAt,updatedAt
      FROM retained_review_anchor_drafts WHERE taskId=? AND draftId=?`)
      .get(taskId, draftId) as Row | undefined;
    if (!row) return undefined;
    const refs = this.db
      .prepare(
        "SELECT anchorId FROM retained_review_anchor_draft_refs WHERE draftId=? ORDER BY position",
      )
      .all(draftId)
      .map((item) => String((item as Row).anchorId));
    return {
      draftId: String(row.draftId),
      taskId: String(row.taskId),
      state: String(row.state) as RetainedReviewAnchorDraft["state"],
      submittedContextId:
        row.submittedContextId === null ? null : String(row.submittedContextId),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      anchorIds: refs,
    };
  }

  reviewAnchorSubmittedContext(
    taskId: string,
    submittedContextId: string,
  ): RetainedReviewAnchorSubmittedContext | undefined {
    const row = this.db
      .prepare(`SELECT submittedContextId,taskId,createdAt
      FROM retained_review_anchor_submitted_contexts
      WHERE taskId=? AND submittedContextId=?`)
      .get(taskId, submittedContextId) as Row | undefined;
    if (!row) return undefined;
    const refs = this.db
      .prepare(
        "SELECT anchorId FROM retained_review_anchor_submitted_refs WHERE submittedContextId=? ORDER BY position",
      )
      .all(submittedContextId)
      .map((item) => String((item as Row).anchorId));
    return {
      submittedContextId: String(row.submittedContextId),
      taskId: String(row.taskId),
      createdAt: Number(row.createdAt),
      anchorIds: refs,
    };
  }

  reviewAnchor(
    taskId: string,
    anchorId: string,
  ): RetainedReviewAnchorContent | undefined {
    const row = this.db
      .prepare(`SELECT * FROM retained_review_anchor_contexts
      WHERE taskId=? AND anchorId=?`)
      .get(taskId, anchorId) as Row | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(String(row.recordJson)) as Record<
      string,
      unknown
    >;
    const bytes =
      row.content instanceof Uint8Array ? Buffer.from(row.content) : undefined;
    const anchor = reviewAnchorCandidateSchema.parse({
      ...stored,
      ...(bytes ? { bytes } : {}),
    });
    if (
      anchor.taskId !== taskId ||
      anchor.anchorId !== anchorId ||
      anchor.state !== row.state ||
      anchor.size !== Number(row.size) ||
      anchor.repositoryId !== row.repositoryId ||
      anchor.path !== row.path ||
      (anchor.originRoot ?? null) !== row.originRoot ||
      anchor.context !== row.context ||
      anchor.sourceKind !== row.sourceKind ||
      anchor.startLine !== Number(row.startLine) ||
      anchor.endLine !== Number(row.endLine)
    )
      throw new Error("Retained review anchor identity mismatch");
    if (anchor.state === "available") {
      if (!bytes || bytes.byteLength !== anchor.size)
        throw new Error("Retained review anchor payload is missing");
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        anchor.excerptSha256
      )
        throw new Error("Retained review anchor payload integrity mismatch");
    }
    const record: RetainedReviewAnchorRecord = {
      anchorId: anchor.anchorId,
      taskId: anchor.taskId,
      repositoryId: anchor.repositoryId,
      path: anchor.path,
      sourceKind: anchor.sourceKind,
      context: anchor.context,
      ...(anchor.comparisonId ? { comparisonId: anchor.comparisonId } : {}),
      ...(anchor.resultId ? { resultId: anchor.resultId } : {}),
      ...(anchor.workId ? { workId: anchor.workId } : {}),
      ...(anchor.threadId ? { threadId: anchor.threadId } : {}),
      ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
      side: anchor.side,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      ...(anchor.sourceSha256 ? { sourceSha256: anchor.sourceSha256 } : {}),
      ...(anchor.claimedSha256 ? { claimedSha256: anchor.claimedSha256 } : {}),
      ...(anchor.excerptSha256 ? { excerptSha256: anchor.excerptSha256 } : {}),
      ...(anchor.byteStart === undefined
        ? {}
        : { byteStart: anchor.byteStart }),
      ...(anchor.byteEnd === undefined ? {} : { byteEnd: anchor.byteEnd }),
      ...(anchor.mime ? { mime: anchor.mime } : {}),
      state: anchor.state,
      ...(anchor.reason ? { reason: anchor.reason } : {}),
      size: anchor.size,
      capturedAt: anchor.capturedAt,
      observedAt: anchor.observedAt,
    };
    return {
      anchor: record,
      ...(bytes ? { bytes } : {}),
      ...(anchor.originRoot ? { originRoot: anchor.originRoot } : {}),
    };
  }

  reviewAnchorHasReference(taskId: string, anchorId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 AS found FROM retained_review_anchor_contexts anchor
        WHERE anchor.taskId=? AND anchor.anchorId=? AND (
          EXISTS (SELECT 1 FROM retained_review_anchor_draft_refs draft WHERE draft.anchorId=anchor.anchorId) OR
          EXISTS (SELECT 1 FROM retained_review_anchor_submitted_refs submitted WHERE submitted.anchorId=anchor.anchorId)
        )`)
        .get(taskId, anchorId),
    );
  }

  private insertReviewAnchor(
    candidate: z.infer<typeof reviewAnchorCandidateSchema>,
  ): void {
    assertOwnedTaskWritable(this.db, candidate.taskId);
    const { bytes: _bytes, ...record } = candidate;
    this.db
      .prepare(`INSERT INTO retained_review_anchor_contexts
      (anchorId,taskId,repositoryId,path,originRoot,sourceKind,context,comparisonId,resultId,resultItemId,
       workId,threadId,turnId,side,startLine,endLine,sourceSha256,claimedSha256,excerptSha256,
       byteStart,byteEnd,mime,state,reason,size,capturedAt,observedAt,recordJson,content)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        candidate.anchorId,
        candidate.taskId,
        candidate.repositoryId,
        candidate.path,
        candidate.originRoot ?? null,
        candidate.sourceKind,
        candidate.context,
        candidate.comparisonId ?? null,
        candidate.resultId ?? null,
        null,
        candidate.workId ?? null,
        candidate.threadId ?? null,
        candidate.turnId ?? null,
        candidate.side,
        candidate.startLine,
        candidate.endLine,
        candidate.sourceSha256 ?? null,
        candidate.claimedSha256 ?? null,
        candidate.excerptSha256 ?? null,
        candidate.byteStart ?? null,
        candidate.byteEnd ?? null,
        candidate.mime ?? null,
        candidate.state,
        candidate.reason ?? null,
        candidate.size,
        candidate.capturedAt,
        candidate.observedAt,
        JSON.stringify(record),
        candidate.state === "available"
          ? Buffer.from(candidate.bytes as Uint8Array)
          : null,
      );
  }

  private recordReviewAnchorOperation(
    operationId: string,
    taskId: string,
    kind: "stage" | "seal" | "discard",
    materialHash: string,
    response: unknown,
  ): void {
    assertOwnedTaskWritable(this.db, taskId);
    this.db
      .prepare(`INSERT INTO retained_review_anchor_operations
      (operationId,taskId,kind,materialHash,responseJson) VALUES (?,?,?,?,?)`)
      .run(operationId, taskId, kind, materialHash, JSON.stringify(response));
  }

  private tableExists(name: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name),
    );
  }

  private storedBytes(sql: string, ...args: (string | number)[]): number {
    const row = this.db.prepare(sql).get(...args) as Row;
    const bytes = Number(row.bytes ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error("Retained evidence quota count is invalid");
    return bytes;
  }
}
