import { z } from "zod";

/**
 * Retained-evidence identity and review-anchor shapes shared by the core store
 * and the operator contract. Zod only: `web/` loads this through
 * `src/operator/contracts.ts`, so never import `node:*` or store modules here.
 *
 * Both layers start from these bases. Refinements go on the derived schema,
 * never on a base, because Zod `.omit`/`.pick` throws on a refined object.
 * The only intentional layer differences:
 * - the operator identity omits `taskId` (the route supplies it);
 * - an operator-read anchor `reason` is a bounded string, the store keeps the
 *   closed gap-reason enum;
 * - the store alone carries `originRoot` and the excerpt `bytes`.
 */
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();

export const retainedEvidenceIdentitySchema = z
  .object({
    taskId: uuid,
    // taskVersion is the request's admitted revision. Capture safety uses the
    // separately revalidated revision observed while reading workspace bytes.
    taskVersion: revision,
    captureTaskVersion: revision,
    assignmentId: uuid,
    assignmentVersion: revision,
    workId: z.string().min(1).max(512),
    workRevision: revision,
    requestSequence: revision,
    conversationRevision: revision,
    instructionsRevision: revision,
    profileRevision: revision,
    profileId: uuid,
    threadId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512),
  })
  .strict();

export const retainedEvidenceSourceObservationSchema = z
  .object({
    comparisonId: uuid.nullable(),
    captureState: z.enum(["missing", "pending", "unsettled", "finished"]),
    outcome: z.enum(["running", "completed", "failed", "unknown"]).nullable(),
    observedAt: count.nullable(),
  })
  .strict();

/** Unrefined base of a retained anchor record; derive and then refine. */
export const reviewAnchorRecordBaseSchema = z
  .object({
    anchorId: uuid,
    taskId: uuid,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    sourceKind: z.enum([
      "workspace-file",
      "comparison-side",
      "result-evidence",
    ]),
    context: z.enum(["workspace", "branch", "uncommitted", "turn", "result"]),
    comparisonId: uuid.optional(),
    resultId: uuid.optional(),
    resultItemId: uuid.optional(),
    workId: z.string().min(1).max(512).optional(),
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    side: z.enum(["file", "left", "right"]),
    startLine: revision,
    endLine: revision,
    sourceSha256: hash.optional(),
    claimedSha256: hash.optional(),
    excerptSha256: hash.optional(),
    byteStart: count.optional(),
    byteEnd: count.optional(),
    mime: z.string().min(1).max(128).optional(),
    state: z.enum(["available", "gap"]),
    reason: z
      .enum([
        "missing",
        "unavailable",
        "comparison-unavailable",
        "comparison-unsettled",
        "quota",
      ])
      .optional(),
    size: count,
    capturedAt: count,
    observedAt: count.nullable(),
  })
  .strict();

/** The source an operator submits for staging: a record's identity fields plus the displayed content hash. */
export const reviewAnchorSelectionSchema = reviewAnchorRecordBaseSchema
  .pick({
    taskId: true,
    repositoryId: true,
    path: true,
    sourceKind: true,
    context: true,
    comparisonId: true,
    resultId: true,
    resultItemId: true,
    workId: true,
    threadId: true,
    turnId: true,
    side: true,
    startLine: true,
    endLine: true,
  })
  .extend({ contentSha256: hash })
  .strict()
  .superRefine((selection, ctx) => {
    if (selection.endLine < selection.startLine)
      ctx.addIssue({ code: "custom", message: "invalid-anchor-range" });
    if (
      (selection.sourceKind === "workspace-file" &&
        (selection.context !== "workspace" ||
          selection.side !== "file" ||
          selection.comparisonId !== undefined ||
          selection.resultItemId !== undefined)) ||
      (selection.sourceKind === "comparison-side" &&
        (!(["branch", "uncommitted", "turn"] as const).includes(
          selection.context as "branch" | "uncommitted" | "turn",
        ) ||
          selection.side === "file" ||
          selection.comparisonId === undefined ||
          selection.resultItemId !== undefined)) ||
      (selection.sourceKind === "result-evidence" &&
        (selection.context !== "result" ||
          selection.side !== "file" ||
          selection.resultId === undefined ||
          selection.resultItemId === undefined ||
          selection.comparisonId !== undefined ||
          selection.workId === undefined))
    )
      ctx.addIssue({
        code: "custom",
        message: "anchor-source-context-mismatch",
      });
    if (
      selection.context === "turn" &&
      (!selection.workId || !selection.threadId || !selection.turnId)
    )
      ctx.addIssue({
        code: "custom",
        message: "turn-anchor-identity-required",
      });
    if (
      selection.resultId !== undefined &&
      selection.sourceKind !== "result-evidence" &&
      !selection.workId
    )
      ctx.addIssue({
        code: "custom",
        message: "result-anchor-work-identity-required",
      });
  });
