import { z } from "zod";

/**
 * Workspace-comparison shapes shared by the comparison store, the in-memory
 * comparison types and the operator contract. Zod only: `web/` loads this
 * through `src/operator/contracts.ts`, so never import `node:*` or store
 * modules here.
 *
 * These bases carry the lenient persistence rules, so stored rows keep
 * parsing. Each layer derives its own schema with `.extend` and re-declares
 * every nested child it tightens or refines, because an `.extend` does not
 * reach into a child schema. Refinements go on the derived schema, never on a
 * base, and every derived object stays `.strict()`.
 *
 * Intentional layer differences:
 * - store: ids are `min(1)` strings, strings are unbounded (bar the 1 MiB
 *   text fields), `modifiedAt` may be negative, `baseline.branch` may be
 *   empty, and the turn capture carries cross-field checks;
 * - operator contract: ids are UUIDs where they are UUIDs in the domain,
 *   strings are length-bounded, times are non-negative integers, and the
 *   comparison also verifies each hunk's anchors against its entry.
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const id = z.string().min(1);
const uuid = z.string().uuid();
const count = z.number().int().nonnegative();
const position = z.number().int().positive();
const text = z.string().max(1024 * 1024);

const workspaceComparisonEntryReasonSchema = z.enum([
  "too-large",
  "invalid-text",
  "unsupported-format",
  "changing",
  "unavailable",
  "output-limit",
  "time-limit",
]);
const workspaceComparisonReasonSchema = z.enum([
  "workspace-unavailable",
  "repository-unavailable",
  "base-branch-required",
  "base-branch-unavailable",
  "no-merge-base",
  "head-unavailable",
  "git-failed",
  "time-limit",
  "output-limit",
  "unsafe-path",
  "workspace-changed",
]);
const workspaceTurnReasonSchema = z.enum([
  ...workspaceComparisonReasonSchema.options,
  "unsupported-content",
]);
export const workspaceTurnCaptureReasonSchema = z.enum([
  ...workspaceTurnReasonSchema.options,
  "runtime-uncertain",
  "turn-unbound",
  "callback-unfinished",
  "capture-store-failed",
]);

export const workspaceComparisonContentBase = z
  .object({
    sha256: sha256.optional(),
    objectId: objectId.optional(),
    size: count.nullable(),
    lineCount: count.nullable(),
    modifiedAt: z.number().int().nullable().optional(),
  })
  .strict();

export const workspaceComparisonAnchorBase = z
  .object({
    taskId: id,
    repositoryId: id.nullable(),
    path: id,
    comparisonId: uuid,
    context: z.enum(["branch", "uncommitted", "turn", "result"]),
    workId: id.optional(),
    resultId: id.optional(),
    threadId: id.optional(),
    turnId: id.optional(),
    side: z.enum(["left", "right"]),
    startLine: position,
    endLine: position,
    contentSha256: sha256,
  })
  .strict();

export const workspaceComparisonHunkBase = z
  .object({
    oldStart: count,
    oldLines: count,
    newStart: count,
    newLines: count,
    patch: text,
    leftAnchor: workspaceComparisonAnchorBase.optional(),
    rightAnchor: workspaceComparisonAnchorBase.optional(),
  })
  .strict();

export const workspaceComparisonEntryBase = z
  .object({
    path: id,
    repositoryId: id.nullable().optional(),
    previousPath: id.optional(),
    change: z.enum(["added", "modified", "deleted", "renamed", "type-changed"]),
    changeSet: z.enum(["branch", "staged", "unstaged"]).optional(),
    state: z.enum(["text", "binary", "unsupported", "gap"]),
    diff: text.optional(),
    left: workspaceComparisonContentBase.optional(),
    right: workspaceComparisonContentBase.optional(),
    hunks: z.array(workspaceComparisonHunkBase).max(2048),
    reason: workspaceComparisonEntryReasonSchema.optional(),
  })
  .strict();

export const workspaceComparisonSnapshotBase = z
  .object({
    comparisonId: uuid,
    taskId: id,
    repositoryId: id,
    target: z.enum(["branch", "uncommitted"]),
    changeSet: z.enum(["all", "staged", "unstaged"]).optional(),
    state: z.enum(["available", "unavailable", "gap"]),
    observedAt: count,
    baseline: z
      .object({
        kind: z.enum(["merge-base", "head"]),
        branch: z.string().optional(),
        commit: objectId,
      })
      .strict()
      .optional(),
    availableBaseBranches: z.array(z.string()).max(4096),
    entries: z.array(workspaceComparisonEntryBase).max(256),
    truncated: z.boolean(),
    reason: workspaceComparisonReasonSchema.optional(),
  })
  .strict();

export const workspaceTurnComparisonBase = z
  .object({
    comparisonId: uuid,
    taskId: id,
    target: z.literal("turn"),
    state: z.enum(["available", "gap", "unavailable"]),
    outcome: z.enum(["completed", "failed", "unknown"]),
    startedAt: count,
    beforeObservedAt: count.optional(),
    observedAt: count,
    // Rows recorded before the task revision was captured have none.
    taskVersion: position.optional(),
    workId: id,
    workRevision: position,
    requestSequence: position,
    assignmentId: id,
    assignmentVersion: position,
    instructionsRevision: position,
    profileRevision: position,
    profileId: id,
    threadId: id.optional(),
    turnId: id.optional(),
    entries: z.array(workspaceComparisonEntryBase).max(256),
    truncated: z.boolean(),
    reason: workspaceTurnReasonSchema.optional(),
  })
  .strict();

export const workspaceTurnIdentityBase = z
  .object({
    taskId: id,
    taskVersion: position.optional(),
    workId: id,
    workRevision: position,
    requestSequence: position,
    assignmentId: id,
    assignmentVersion: position,
    instructionsRevision: position,
    profileRevision: position,
    profileId: id,
  })
  .strict();

export const workspaceTurnFileBase = z
  .object({
    repositoryId: id.nullable(),
    path: id,
    state: z.enum(["text", "binary", "unsupported", "gap"]),
    content: workspaceComparisonContentBase,
    text: text.optional(),
    reason: workspaceComparisonEntryReasonSchema.optional(),
    kind: z.enum(["file", "symlink", "other"]),
  })
  .strict();

export const workspaceTurnObservationBase = z
  .object({
    observedAt: count,
    state: z.enum(["available", "gap"]),
    reason: workspaceTurnReasonSchema.optional(),
    files: z.array(workspaceTurnFileBase).max(256),
    truncated: z.boolean(),
  })
  .strict();

export const workspaceComparisonSideContentBase = z
  .object({
    entryIndex: count,
    leftText: text.optional(),
    rightText: text.optional(),
  })
  .strict();

export const workspaceComparisonSidesBase = z
  .array(workspaceComparisonSideContentBase)
  .max(256);

export const workspaceTurnCaptureBase = z
  .object({
    comparisonId: uuid,
    identity: workspaceTurnIdentityBase,
    captureState: z.enum(["pending", "unsettled", "finished"]),
    outcome: z.enum(["running", "completed", "failed", "unknown"]),
    startedAt: count,
    observedAt: count,
    threadId: id.optional(),
    turnId: id.optional(),
    before: workspaceTurnObservationBase.optional(),
    after: workspaceTurnObservationBase.optional(),
    comparison: workspaceTurnComparisonBase.optional(),
    sides: workspaceComparisonSidesBase.optional(),
    reason: workspaceTurnCaptureReasonSchema.optional(),
  })
  .strict();
