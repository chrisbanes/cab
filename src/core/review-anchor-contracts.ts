import { z } from "zod";

/**
 * Review-anchor shapes shared by the core store
 * and the operator contract. Zod only: `web/` loads this through
 * `src/operator/contracts.ts`, so never import `node:*` or store modules here.
 *
 * Both layers start from these bases. Refinements go on the derived schema,
 * never on a base, because Zod `.omit`/`.pick` throws on a refined object.
 * The only intentional layer differences:
 * - an operator-read anchor `reason` is a bounded string, the store keeps the
 *   closed gap-reason enum;
 * - the store alone carries `originRoot` and the excerpt `bytes`.
 */
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();

/** Unrefined base of a retained anchor record; derive and then refine. */
export const reviewAnchorRecordBaseSchema = z
  .object({
    anchorId: uuid,
    taskId: uuid,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    sourceKind: z.enum(["workspace-file", "comparison-side"]),
    context: z.enum(["workspace", "branch", "uncommitted", "turn"]),
    comparisonId: uuid.optional(),
    resultId: uuid.optional(),
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
          selection.comparisonId !== undefined)) ||
      (selection.sourceKind === "comparison-side" &&
        (!(["branch", "uncommitted", "turn"] as const).includes(
          selection.context as "branch" | "uncommitted" | "turn",
        ) ||
          selection.side === "file" ||
          selection.comparisonId === undefined))
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
    if (selection.resultId !== undefined && !selection.workId)
      ctx.addIssue({
        code: "custom",
        message: "result-anchor-work-identity-required",
      });
  });
