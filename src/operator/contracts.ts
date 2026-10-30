import { z } from "zod";
import {
  issueBodyLimit,
  issueCurrentBodyLimit,
  issueTitleLimit,
} from "../core/issue-text-limits.js";
import {
  commentReasonCodes,
  issueEditReasonCodes,
  publicationReasonCodes,
  publicationTargetReasonCodes,
} from "./github-reasons.js";
import { publicationStates } from "../core/task-publication-contracts.js";
import { waitCodes, waitSchema } from "./wait-reasons.js";
import { attentionCodes, attentionCodeSchema } from "./attention.js";
import {
  discoveryCredentialReference,
  envCredentialReference,
  gitLabCredentialReference,
  glabReferenceMatchesHost,
} from "../core/credential-reference.js";
import {
  statusMappingEvents,
  statusMappingSchema,
} from "../core/status-mapping-contracts.js";
import {
  gitLabHostSchema,
  gitLabProjectPathSchema,
  gitLabRepositoryId,
  repositoriesConfigurationCommandSchema,
  setupRepositoriesSchema,
} from "../core/repository-links.js";
import {
  closedIssuesSchema,
  githubConfigurationSchema,
  githubConfigurationCommandSchema,
  jiraConfigurationSchema,
  jiraInstanceSchema,
  readinessConditionSchema,
  readinessSchema,
  setupRepositorySchema,
} from "../core/github-source-contracts.js";
import {
  retainedEvidenceIdentitySchema,
  retainedEvidenceSourceObservationSchema,
  reviewAnchorRecordBaseSchema,
  reviewAnchorSelectionSchema,
} from "../core/review-anchor-contracts.js";
import {
  workspaceComparisonAnchorBase,
  workspaceComparisonContentBase,
  workspaceComparisonEntryBase,
  workspaceComparisonHunkBase,
  workspaceComparisonSnapshotBase,
  workspaceTurnCaptureReasonSchema,
  workspaceTurnComparisonBase,
  workspaceTurnIdentityBase,
} from "../core/workspace-comparison-contracts.js";
import {
  questionAnswersSchema,
  questionFormSchema,
  questionPayloadLimit,
} from "../core/question-forms.js";
import {
  feedbackReferenceSchema,
  taskReviewReadSchema,
} from "../core/task-review-contracts.js";
import {
  historicalNoTurnAdoptionBodySchema,
  historicalPreTurnAdoptionBodySchema,
  noTurnRecoveryBodySchema,
  preTurnRecoveryBodySchema,
  recoveryPaths,
  replaceConversationBodySchema,
} from "../core/recovery-contracts.js";
import {
  executionHarnessSchema,
  executionIntentStateSchema,
  profileRuntimeSchema,
  supportedRuntimeSettingsSchema,
} from "../core/execution-runtime.js";
export {
  executionHarnessLabels,
  type ExecutionHarness,
  type ProfileRuntime,
  runtimeSummary,
  type SupportedRuntimeSettings,
  unsupportedRuntimeField,
} from "../core/execution-runtime.js";
export const uuid = z.string().uuid();
const revision = z.number().int().positive().safe();

/** Why a draft turn cannot start now; pause, Stop and capacity queue it instead. */
export const draftTurnReasonSchema = z.enum([
  "task-not-open",
  "task-ready",
  "lead-unconfigured",
  "lead-revoked",
  "lead-unavailable",
  "draft-turn-active",
]);
export type DraftTurnReason = z.infer<typeof draftTurnReasonSchema>;

/** Why Start again is not offered for a task; each names the recovery that applies instead. */
export const startAgainReasonSchema = z.enum([
  "nothing-refused",
  "task-not-open",
  "source-held",
  "assignment-held",
  "submission-interrupted",
  "execution-unresolved",
]);
export type StartAgainReason = z.infer<typeof startAgainReasonSchema>;

/** Why Reset task is not offered for a task. */
export const resetReasonSchema = z.enum([
  "task-not-open",
  "task-not-ready",
  "lead-unconfigured",
  "nothing-to-reset",
  "execution-unresolved",
  "task-held",
]);
export type ResetReason = z.infer<typeof resetReasonSchema>;
const time = z.number().int().nonnegative().safe();
/** The most Unicode characters (code points, as zod counts them) any operator text field takes. */
export const textMaxLength = 16000;
const text = z.string().max(textMaxLength);
/** Whether `value` fits a text field, by the same check the service applies. */
export const fitsTextField = (value: string) => text.safeParse(value).success;
const safeText = text.nullable();
const draftingStateSchema = z.enum([
  "queued",
  "running",
  "stopping",
  "proposed",
  "interrupted",
  "failed",
  "accepted",
  "discarded",
  "expired",
]);
const attentionCodesSchema = z
  .array(attentionCodeSchema)
  .max(attentionCodes.length);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
const scalar = z.union([z.null(), z.boolean(), z.number().finite(), text]);
let boundedJson: z.ZodType<JsonValue> = scalar;
for (let depth = 0; depth < 12; depth++) {
  const child = boundedJson;
  boundedJson = z.union([
    scalar,
    z.array(child).max(256),
    z
      .record(z.string().max(512), child)
      .refine((value) => Object.keys(value).length <= 256),
  ]);
}
export const materialSchema = boundedJson.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 8192,
);
export const sessionSchema = z
  .object({
    authenticated: z.boolean(),
    csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const projectSummarySchema = z
  .object({
    id: uuid,
    name: safeText,
    version: revision,
    paused: z.boolean(),
    leadProfileId: uuid.nullable(),
  })
  .strict();
export const profileSummarySchema = z
  .object({
    id: uuid,
    name: safeText,
    summary: safeText,
    version: revision,
    revoked: z.boolean(),
  })
  .strict();
const envelope = <T extends z.ZodType>(schema: T) =>
  z.object({ data: schema, observedAt: time }).strict();
/** What a harness enforces and its disclosed limits; null until disclosable. */
const policyDisclosureSchema = z
  .object({
    lines: z.array(z.string().max(300)).max(10),
    limits: z.array(z.string().max(300)).max(12),
  })
  .strict();
const harnessStatusBase = {
  harness: executionHarnessSchema,
  policy: policyDisclosureSchema.nullable(),
  /** Null until the runtime has read them; then the server validates against them. */
  settings: supportedRuntimeSettingsSchema.nullable(),
};
/** A closed set chosen by the service; runtime error text is never carried (it can hold secrets). */
export const runtimeRestartFailureSchema = z.enum([
  "exited",
  "start-failed",
  "start-timed-out",
  "spawn-failed",
]);
export type RuntimeRestartFailure = z.infer<typeof runtimeRestartFailureSchema>;
export const runtimeRestartAttemptSchema = z
  .object({
    attempt: z.number().int().min(1).max(3),
    at: time,
    outcome: z.enum(["started", "failed"]),
    failure: runtimeRestartFailureSchema.nullable(),
  })
  .strict();
export type RuntimeRestartAttempt = z.infer<typeof runtimeRestartAttemptSchema>;
/** In memory only. `attempt` of a pending retry is the next attempt number. */
export const runtimeRestartSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("pending"),
      attempt: z.number().int().min(1).max(3),
      nextAt: time,
      lastFailure: runtimeRestartFailureSchema,
      attempts: z.array(runtimeRestartAttemptSchema).max(3),
    })
    .strict(),
  z
    .object({
      state: z.literal("exhausted"),
      since: time,
      lastFailure: runtimeRestartFailureSchema,
      attempts: z.array(runtimeRestartAttemptSchema).max(3),
    })
    .strict(),
]);
export type RuntimeRestart = z.infer<typeof runtimeRestartSchema>;
/**
 * One per harness; `enabled` is the operator's persisted setting. `not-configured` (shown as
 * "Not enabled") is a disabled runtime, or an enabled one whose executable is not on the service
 * `PATH`; `unavailable` is an enabled runtime that failed to start or failed later.
 */
export const harnessStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...harnessStatusBase,
      enabled: z.boolean(),
      state: z.literal("available"),
    })
    .strict(),
  z
    .object({
      ...harnessStatusBase,
      enabled: z.boolean(),
      state: z.literal("not-configured"),
      reason: z.enum(["disabled", "executable-missing"]),
    })
    .strict(),
  z
    .object({
      ...harnessStatusBase,
      enabled: z.boolean(),
      state: z.literal("unavailable"),
      since: time,
      /** Absent while an attempt runs, or when nothing is scheduled. */
      restart: runtimeRestartSchema.optional(),
    })
    .strict(),
]);
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;
/** Workspace profile rows also carry the current revision's execution runtime. */
const workspaceProfileSchema = profileSummarySchema
  .extend({ runtime: profileRuntimeSchema })
  .strict();
export const workspaceSchema = envelope(
  z
    .object({
      projects: z.array(projectSummarySchema),
      profiles: z.array(workspaceProfileSchema),
      runtime: z.discriminatedUnion("state", [
        z.object({ state: z.literal("available") }).strict(),
        z.object({ state: z.literal("unavailable"), since: time }).strict(),
      ]),
      harnesses: z.array(harnessStatusSchema),
      /** Installation facts for the getting-started checklist. */
      gettingStarted: z
        .object({ turnStarted: z.boolean(), dismissed: z.boolean() })
        .strict(),
    })
    .strict(),
);
const workspaceInspectionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z
    .object({
      kind: z.literal("repository"),
      repositoryId: z.string().min(1).max(512),
    })
    .strict(),
]);
const workspaceInspectionPathSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(255)
      .refine(
        (part) =>
          !/\p{Cc}/u.test(part) && !part.includes("/") && !part.includes("\\"),
      ),
  )
  .max(32)
  .refine((parts) => new TextEncoder().encode(parts.join("/")).length <= 2048);
const workspaceInspectionStateSchema = z.enum([
  "ready",
  "missing",
  "provisioning",
  "held",
  "archiving",
  "archived",
  "excluded",
  "ignored",
  "conflict",
  "unavailable",
]);
const workspaceInspectionEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository"),
      repositoryId: z.string().min(1).max(128),
      size: z.null(),
      modifiedAt: z.null(),
      ignored: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["file", "directory", "symlink", "other"]),
      name: z.string().min(1).max(255),
      size: z.number().int().nonnegative().safe().nullable(),
      modifiedAt: z.number().finite().nullable(),
      ignored: z.boolean().nullable(),
    })
    .strict(),
]);
export const workspaceDirectoryReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      workspaceId: uuid.nullable(),
      scope: workspaceInspectionScopeSchema,
      path: workspaceInspectionPathSchema,
      state: workspaceInspectionStateSchema,
      entries: z.array(workspaceInspectionEntrySchema).max(256),
      truncated: z.boolean(),
      ignoreStatus: z.enum(["known", "not-applicable", "incomplete"]),
    })
    .strict(),
);
const workspacePreviewMetadataSchema = z
  .object({
    kind: z.enum(["file", "directory", "symlink", "other"]),
    size: z.number().int().nonnegative().safe().nullable(),
    modifiedAt: z.number().finite().nullable(),
    ignored: z.boolean().nullable(),
    reason: z
      .enum([
        "unsupported-format",
        "binary-content",
        "invalid-content",
        "too-large",
        "multiple-links",
        "image-dimensions-exceed-limit",
      ])
      .optional(),
  })
  .strict();
const workspacePreviewDataSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      mime: z.string().min(1).max(128),
      text: z.string().max(1024 * 1024),
      sha256: hash,
      size: z
        .number()
        .int()
        .nonnegative()
        .max(1024 * 1024)
        .safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("base64"),
      mime: z.enum([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
      ]),
      data: z.string().max(4 * Math.ceil((8 * 1024 * 1024) / 3)),
      sha256: hash,
      size: z
        .number()
        .int()
        .nonnegative()
        .max(8 * 1024 * 1024)
        .safe(),
      width: z.number().int().positive().safe().optional(),
      height: z.number().int().positive().safe().optional(),
      maxDisplayedPages: z.number().int().positive().max(10).safe().optional(),
      maxCanvasPixels: z
        .number()
        .int()
        .positive()
        .max(16_000_000)
        .safe()
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mime === "application/pdf") {
        if (value.maxDisplayedPages === undefined)
          context.addIssue({
            code: "custom",
            message: "PDF preview requires a displayed-page limit",
          });
        if (value.maxCanvasPixels === undefined)
          context.addIssue({
            code: "custom",
            message: "PDF preview requires a canvas-pixel limit",
          });
      } else if (
        value.maxDisplayedPages !== undefined ||
        value.maxCanvasPixels !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "PDF limits are only valid for PDF previews",
        });
      }
    }),
]);
export const workspacePreviewReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      workspaceId: uuid.nullable(),
      scope: workspaceInspectionScopeSchema,
      path: workspaceInspectionPathSchema,
      state: z.union([
        workspaceInspectionStateSchema,
        z.literal("metadata-only"),
      ]),
      metadata: workspacePreviewMetadataSchema.optional(),
      preview: workspacePreviewDataSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.state === "ready" && (!value.metadata || !value.preview))
        context.addIssue({
          code: "custom",
          message: "ready preview requires metadata and data",
        });
      if (value.state === "metadata-only" && !value.metadata?.reason)
        context.addIssue({
          code: "custom",
          message: "metadata-only preview requires a reason",
        });
      if (value.state !== "ready" && value.preview)
        context.addIssue({
          code: "custom",
          message: "unavailable preview cannot contain file data",
        });
    }),
);
const retainedEvidenceAvailableItemSchema = z
  .object({
    itemId: uuid,
    kind: z.enum(["file", "diff"]),
    state: z.literal("available"),
    source: z.enum(["artifact-file", "change-file", "observed-diff"]),
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    artifactId: uuid.optional(),
    mime: z.string().min(1).max(128),
    sha256: hash,
    size: z.number().int().nonnegative().safe(),
    capturedAt: time,
    observedAt: time.nullable(),
    provenance: z.record(z.string().max(80), scalar),
  })
  .strict();
const retainedEvidenceItemReadSchema = z.discriminatedUnion("state", [
  retainedEvidenceAvailableItemSchema,
  z
    .object({
      itemId: uuid,
      kind: z.enum(["file", "diff"]),
      state: z.literal("gap"),
      reason: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      itemId: uuid,
      kind: z.enum(["file", "diff"]),
      state: z.literal("unavailable"),
      reason: z.enum(["excluded", "unavailable"]),
    })
    .strict(),
]);
export const retainedResultEvidenceReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        state: z.enum(["empty", "available", "partial", "gap"]),
        evidenceId: uuid,
        // The result route supplies the task; the identity does not repeat it.
        identity: retainedEvidenceIdentitySchema.omit({ taskId: true }),
        capturedAt: time,
        sourceObservation: retainedEvidenceSourceObservationSchema,
        items: z.array(retainedEvidenceItemReadSchema).max(320),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        state: z.literal("unavailable"),
        reason: z.enum(["not-retained", "excluded", "unavailable"]),
      })
      .strict(),
  ]),
);
export const retainedEvidenceItemContentReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        itemId: uuid,
        state: z.literal("available"),
        item: retainedEvidenceAvailableItemSchema,
        preview: workspacePreviewDataSchema,
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        itemId: uuid,
        state: z.literal("gap"),
        reason: z.string().min(1).max(80),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        resultId: uuid,
        itemId: uuid,
        state: z.literal("unavailable"),
        reason: z.enum(["excluded", "unavailable"]),
      })
      .strict(),
  ]),
);
// Reads stay open-ended on `reason`; the store records the closed gap-reason enum.
const retainedReviewAnchorRecordSchema = reviewAnchorRecordBaseSchema
  .extend({ reason: z.string().min(1).max(80).optional() })
  .strict();
export const retainedReviewAnchorReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        anchorId: uuid,
        state: z.literal("available"),
        status: z.enum(["current", "outdated", "unknown"]),
        anchor: retainedReviewAnchorRecordSchema.extend({
          state: z.literal("available"),
        }),
        preview: workspacePreviewDataSchema,
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        anchorId: uuid,
        state: z.literal("gap"),
        status: z.literal("unavailable"),
        anchor: retainedReviewAnchorRecordSchema.extend({
          state: z.literal("gap"),
        }),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        anchorId: uuid,
        state: z.literal("unavailable"),
        reason: z.enum(["excluded", "unavailable"]),
      })
      .strict(),
  ]),
);
// Each schema below extends its shared lenient base with this layer's stricter
// rules (UUIDs, bounds, non-negative times). An `.extend` does not reach into
// child schemas, so every tightened child is re-declared one level up.
const workspaceComparisonContentSchema = workspaceComparisonContentBase
  .extend({ modifiedAt: time.nullable().optional() })
  .strict();
const workspaceComparisonAnchorSchema = workspaceComparisonAnchorBase
  .extend({
    taskId: uuid,
    repositoryId: z.string().min(1).max(512).nullable(),
    path: z.string().min(1).max(2048),
    workId: z.string().min(1).max(512).optional(),
    resultId: z.string().min(1).max(512).optional(),
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine((anchor) => anchor.endLine >= anchor.startLine);
const workspaceComparisonHunkSchema = workspaceComparisonHunkBase
  .extend({
    leftAnchor: workspaceComparisonAnchorSchema.optional(),
    rightAnchor: workspaceComparisonAnchorSchema.optional(),
  })
  .strict();
const workspaceComparisonEntrySchema = workspaceComparisonEntryBase
  .extend({
    path: z.string().min(1).max(2048),
    repositoryId: z.string().min(1).max(512).nullable().optional(),
    previousPath: z.string().min(1).max(2048).optional(),
    left: workspaceComparisonContentSchema.optional(),
    right: workspaceComparisonContentSchema.optional(),
    hunks: z.array(workspaceComparisonHunkSchema).max(2048),
  })
  .strict();
const workspaceComparisonEntriesSchema = z
  .array(workspaceComparisonEntrySchema)
  .max(256);
type WorkspaceComparisonAnchorContainer = {
  comparisonId: string;
  taskId: string;
  target: "branch" | "uncommitted" | "turn";
  repositoryId?: string | undefined;
  workId?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  entries: z.infer<typeof workspaceComparisonEntriesSchema>;
};
function validateWorkspaceComparisonAnchors(
  comparison: WorkspaceComparisonAnchorContainer,
  context: z.RefinementCtx,
) {
  for (const [entryIndex, entry] of comparison.entries.entries()) {
    for (const [hunkIndex, hunk] of entry.hunks.entries()) {
      for (const [anchorSide, anchor] of [
        ["left", hunk.leftAnchor],
        ["right", hunk.rightAnchor],
      ] as const) {
        if (!anchor) continue;
        const content = entry[anchorSide];
        const expectedRepositoryId =
          comparison.repositoryId ?? entry.repositoryId ?? null;
        const expectedPath =
          anchorSide === "left"
            ? (entry.previousPath ?? entry.path)
            : entry.path;
        if (
          anchor.taskId !== comparison.taskId ||
          anchor.comparisonId !== comparison.comparisonId ||
          anchor.side !== anchorSide ||
          anchor.path !== expectedPath ||
          anchor.context !== comparison.target ||
          anchor.contentSha256 !== content?.sha256 ||
          content?.lineCount === null ||
          content?.lineCount === undefined ||
          anchor.endLine > content.lineCount ||
          anchor.repositoryId !== expectedRepositoryId ||
          (comparison.workId !== undefined &&
            (anchor.workId !== comparison.workId ||
              anchor.threadId !== comparison.threadId ||
              anchor.turnId !== comparison.turnId))
        )
          context.addIssue({
            code: "custom",
            path: ["entries", entryIndex, "hunks", hunkIndex],
            message: "comparison-anchor-context-mismatch",
          });
      }
    }
  }
}
const workspaceRepositoryComparisonSchema = workspaceComparisonSnapshotBase
  .extend({
    taskId: uuid,
    repositoryId: z.string().min(1).max(512),
    baseline: workspaceComparisonSnapshotBase.shape.baseline
      .unwrap()
      .extend({ branch: z.string().min(1).max(255).optional() })
      .strict()
      .optional(),
    baseBranch: z.string().min(1).max(255).optional(),
    availableBaseBranches: z.array(z.string().min(1).max(255)).max(4096),
    entries: workspaceComparisonEntriesSchema,
  })
  .strict()
  .superRefine(validateWorkspaceComparisonAnchors);
const workspaceTurnComparisonSchema = workspaceTurnComparisonBase
  .extend({
    taskId: uuid,
    workId: z.string().min(1).max(512),
    assignmentId: z.string().min(1).max(512),
    profileId: uuid,
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    entries: workspaceComparisonEntriesSchema,
  })
  .strict()
  .superRefine(validateWorkspaceComparisonAnchors);
const workspaceComparisonSnapshotSchema = z.union([
  workspaceRepositoryComparisonSchema,
  workspaceTurnComparisonSchema,
]);
const workspaceTurnCaptureIdentitySchema = workspaceTurnIdentityBase
  .extend({
    taskId: uuid,
    workId: z.string().min(1).max(512),
    assignmentId: z.string().min(1).max(512),
    profileId: uuid,
  })
  .strict();
const workspacePendingTurnSchema = z
  .object({
    comparisonId: uuid,
    identity: workspaceTurnCaptureIdentitySchema,
    captureState: z.enum(["pending", "unsettled"]),
    outcome: z.enum(["running", "completed", "failed", "unknown"]),
    startedAt: time,
    observedAt: time,
    threadId: z.string().min(1).max(512).optional(),
    turnId: z.string().min(1).max(512).optional(),
    beforeState: z.enum(["available", "gap"]).optional(),
    beforeObservedAt: time.optional(),
    afterState: z.enum(["available", "gap"]).optional(),
    afterObservedAt: time.optional(),
    comparison: workspaceTurnComparisonSchema.optional(),
    reason: workspaceTurnCaptureReasonSchema.optional(),
  })
  .strict();
export const workspaceComparisonReadRequestSchema = z.union([
  z
    .object({
      target: z.enum(["branch", "uncommitted", "last-turn"]),
      comparisonId: uuid,
    })
    .strict(),
  z
    .object({
      target: z.literal("branch"),
      repositoryId: z.string().min(1).max(512),
      baseBranch: z.string().min(1).max(255).optional(),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      target: z.literal("uncommitted"),
      repositoryId: z.string().min(1).max(512),
      changeSet: z.enum(["all", "staged", "unstaged"]).optional(),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z.object({ target: z.literal("last-turn") }).strict(),
]);
export const workspaceComparisonReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        taskId: uuid,
        target: z.enum(["branch", "uncommitted", "last-turn"]),
        state: z.literal("available"),
        comparisonId: uuid,
        comparison: workspaceComparisonSnapshotSchema,
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        target: z.enum(["branch", "uncommitted", "last-turn"]),
        state: z.literal("gap"),
        comparisonId: uuid.optional(),
        comparison: workspaceComparisonSnapshotSchema.optional(),
        reason: z.string().min(1).max(80).optional(),
        availableBaseBranches: z
          .array(z.string().min(1).max(255))
          .max(4096)
          .optional(),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        target: z.enum(["branch", "uncommitted", "last-turn"]),
        state: z.literal("unavailable"),
        comparisonId: uuid.optional(),
        comparison: workspaceComparisonSnapshotSchema.optional(),
        reason: z.string().min(1).max(80),
        availableBaseBranches: z
          .array(z.string().min(1).max(255))
          .max(4096)
          .optional(),
      })
      .strict(),
    z
      .object({
        taskId: uuid,
        target: z.literal("last-turn"),
        state: z.literal("unsettled"),
        pending: workspacePendingTurnSchema,
        latestFinished: workspaceTurnComparisonSchema.optional(),
      })
      .strict(),
  ]),
);
export const executionSchema = z
  .object({
    state: z.enum([
      "idle",
      "selected",
      "queued",
      "starting",
      "running",
      "waiting",
      "paused",
      "stopping",
      "uncertain",
      "not-started",
      "completed",
      "cancelled",
    ]),
    reasonCodes: z.array(
      z.enum([
        "refused-before-start",
        "project-paused",
        "task-held",
        "recovery-held",
        "admission-blocked",
        "runtime-unconfirmed",
      ]),
    ),
    holds: z
      .object({
        stop: z.boolean(),
        writer: z.boolean(),
        capacity: z.boolean(),
        uncertainty: z.boolean(),
        task: z.boolean(),
      })
      .strict(),
  })
  .strict();
const taskState = z.enum(["open", "done", "cancelled"]);
const sourceIdentity = z
  .object({
    /** The issue tracker's instance: `github.com`, or a Jira site host. */
    provider: z.string().min(1).max(253),
    /** Absent for GitHub. */
    tracker: z.literal("jira").optional(),
    nodeId: z.string().min(1),
    repositoryId: z.string().min(1),
  })
  .strict();
const taskSummary = z
  .object({
    id: uuid,
    projectId: uuid,
    title: safeText,
    version: revision,
    state: taskState,
    ready: z.boolean(),
    execution: executionSchema,
    sourceIdentity: sourceIdentity.nullable(),
  })
  .strict();
export const projectSchema = envelope(
  z
    .object({
      project: projectSummarySchema,
      profiles: z.array(profileSummarySchema),
      tasks: z.array(taskSummary),
    })
    .strict(),
);
export const admissionSchema = taskSchemaAdmission();
function taskSchemaAdmission() {
  return z
    .object({
      eligible: z.boolean(),
      reasons: z.array(
        z.enum([
          "project-paused",
          "project-lead-unconfigured",
          "project-lead-revoked",
          "task-unready",
          "task-not-open",
          "local-dependency",
          "imported-blockers-unknown",
          "imported-blockers-blocked",
          "source-held",
          "admission-blocked",
        ]),
      ),
    })
    .strict();
}
// The server only builds https GitHub URLs; reject javascript: and data: links.
const sourceUrl = z.url().startsWith("https://");
/** A GitHub `owner/name`, or a Jira project key. */
const sourceRepositoryName = z
  .string()
  .regex(/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Z][A-Z0-9_]{0,254})$/);
/** What only a Jira task reports: its issue key and its status in Jira. */
const jiraSourceDetail = {
  key: z.string().min(1).max(280).optional(),
  status: z
    .object({
      name: z.string().max(255),
      categoryKey: z.string().max(64),
    })
    .strict()
    .nullable()
    .optional(),
};
/**
 * Provider-closure provenance: closed on GitHub while held, completed by that closure, or
 * held because GitHub's closure could not be attributed to cab's own delivery.
 */
const sourceClosure = z.enum(["held", "completed", "unattributed"]).nullable();
/**
 * The field and option names the last complete read of a Project listed; a read that has
 * not listed them, or no longer lists them, leaves only the node IDs. Never sent back.
 */
const fieldNameShape = {
  fieldName: text.optional(),
  optionName: text.optional(),
};
const [
  labelCondition,
  projectFieldCondition,
  statusCondition,
  selectCondition,
] = readinessConditionSchema.options;
const readinessConditionViewSchema = z.discriminatedUnion("kind", [
  labelCondition,
  // A condition names its options by node ID; the read lists the names it knows.
  projectFieldCondition.extend({
    fieldName: fieldNameShape.fieldName,
    optionNames: z.record(z.string().max(512), text).optional(),
  }),
  // Jira names come from the last complete read of the project's imported issues.
  statusCondition.extend({
    statusNames: z.record(z.string().max(512), text).optional(),
  }),
  selectCondition.extend({
    optionNames: z.record(z.string().max(512), text).optional(),
  }),
]);
/**
 * A project's readiness rule as a read may show it: `none` only for a stored null rule
 * (no filtering); `unavailable` when disclosure is withheld, so no condition text leaves.
 */
export const readinessRuleViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z
    .object({
      kind: z.literal("rule"),
      mode: readinessSchema.shape.mode,
      conditions: z.array(readinessConditionViewSchema).min(1).max(20),
    })
    .strict(),
]);
/** A viewed rule as a command value: without the view's `kind` key and names. */
export function readinessCommandValue(
  rule: z.output<typeof readinessRuleViewSchema>,
) {
  if (rule.kind !== "rule") return null;
  return {
    mode: rule.mode,
    conditions: rule.conditions.map((c) => {
      if (c.kind === "label") return c;
      if (c.kind === "status") {
        const { statusNames: _statuses, ...ids } = c;
        return ids;
      }
      if (c.kind === "select-field") {
        const { optionNames: _options, ...ids } = c;
        return ids;
      }
      const { fieldName: _field, optionNames: _options, ...ids } = c;
      return ids;
    }),
  };
}
/** Why an imported task is Draft under the rule; matching is never Ready or admissible. */
export const taskReadinessSchema = z
  .object({
    rule: readinessRuleViewSchema,
    outcome: z.enum(["matched", "unmet", "not-evaluated"]),
    unmet: z.array(readinessConditionViewSchema).max(20),
  })
  .strict();
const observationCount = z.number().int().nonnegative();
/** Per-selection counts from stored observations; never summed across selections. */
export const selectionCountsSchema = z
  .object({
    observed: observationCount,
    open: observationCount,
    closedSkipped: observationCount,
    matching: observationCount.nullable(),
    complete: z.boolean(),
  })
  .strict();
/**
 * A Project selection's single-select fields, named by its last complete read, with the open
 * items of the selection holding each option; `null` for any other selection kind.
 */
export const selectionProjectFieldsSchema = z
  .object({
    projectNodeId: text,
    fields: z
      .array(
        z
          .object({
            fieldNodeId: text,
            name: text,
            options: z
              .array(
                z
                  .object({
                    optionNodeId: text,
                    name: text,
                    open: observationCount,
                  })
                  .strict(),
              )
              .max(256),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .nullable();
export const taskSourceSummarySchema = z
  .object({
    identity: sourceIdentity,
    repositoryName: sourceRepositoryName.nullable(),
    number: revision.nullable(),
    url: sourceUrl.nullable(),
    ...jiraSourceDetail,
    state: z.enum(["open", "closed"]).nullable(),
    closure: sourceClosure,
    readiness: taskReadinessSchema,
    /** The open GitHub issues blocking it; the cab task and its disclosable title when imported into the same project. */
    openBlockers: z
      .array(
        z
          .object({
            label: safeText,
            task: z.object({ id: uuid, title: text }).strict().nullable(),
            url: sourceUrl.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .nullable();
export const taskListSummarySchema = z
  .object({
    id: uuid,
    projectId: uuid,
    title: safeText,
    version: revision,
    state: taskState,
    ready: z.boolean(),
    project: projectSummarySchema,
    lead: z.object({ profileId: uuid, name: safeText }).strict().nullable(),
    execution: executionSchema,
    admission: admissionSchema,
    capacity: z
      .object({
        globalUsage: time,
        globalLimit: revision,
        projectUsage: time,
        projectLimit: revision,
      })
      .strict(),
    source: taskSourceSummarySchema,
    attention: z
      .object({
        codes: attentionCodesSchema,
        count: time,
      })
      .strict(),
  })
  .strict();
export const taskListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: uuid.optional(),
    projectId: uuid.optional(),
    state: taskState.optional(),
  })
  .strict();
export const taskListPageSchema = envelope(
  z
    .object({
      tasks: z.array(taskListSummarySchema).max(100),
      nextCursor: uuid.nullable(),
      catalogFingerprint: hash,
    })
    .strict(),
);
export const composerOptionsSchema = envelope(
  z
    .object({
      project: projectSummarySchema,
      lead: z.object({ profileId: uuid, name: safeText }).strict().nullable(),
      profiles: z.array(profileSummarySchema),
      dependencies: z
        .array(
          z
            .object({
              id: uuid,
              title: safeText,
              state: taskState,
              source: taskSourceSummarySchema,
              /** Whether it would hold a new dependent, by admission's rule. */
              blocking: z.boolean(),
            })
            .strict(),
        )
        .max(10000),
      capacity: z
        .object({
          globalUsage: time,
          globalLimit: revision,
          projectUsage: time,
          projectLimit: revision,
        })
        .strict(),
      routingEnabled: z.boolean(),
      /** Project-level waits a new task would have; the composer adds selected dependencies. */
      waits: z.array(waitSchema).max(waitCodes.length),
      /** Runtime waits per permitted profile, used in place of the lead's when it is the explicit assignee. */
      assigneeWaits: z.record(uuid, z.array(waitSchema).max(3)),
    })
    .strict(),
);
export type TaskListPage = z.infer<typeof taskListPageSchema>;
export type TaskListSummary = z.infer<typeof taskListSummarySchema>;
export type ComposerOptions = z.infer<typeof composerOptionsSchema>;
/** The title and body of an imported issue, as `issue.edit` limits them. */
export const issueTextSchema = z
  .object({
    title: z.string().max(issueTitleLimit),
    body: z.string().max(issueBodyLimit),
  })
  .strict();
/** The issue text an edit replaces, which may be longer than a replacement can be. */
const currentIssueTextSchema = z
  .object({
    title: z.string().max(issueTitleLimit),
    body: z.string().max(issueCurrentBodyLimit),
  })
  .strict();
export const draftingRunReadSchema = envelope(
  z
    .object({
      runId: uuid,
      projectId: uuid,
      state: draftingStateSchema,
      reason: safeText,
      /** A brief run proposes `proposal`; an issue run proposes `issueProposal`. */
      kind: z.enum(["brief", "issue"]),
      proposal: z
        .object({ title: z.string().max(512), outcome: text })
        .strict()
        .nullable(),
      issueProposal: issueTextSchema.nullable(),
      /** The lead the run captured when it started, not whoever leads the project now. */
      leadName: safeText,
      /** The run has a proposal that cannot be shown: it holds text the service withholds. */
      proposalWithheld: z.boolean(),
      createdAt: time,
      expiresAt: time.nullable(),
    })
    .strict(),
);
export type DraftingRunRead = z.infer<typeof draftingRunReadSchema>;
const generation = z
  .object({
    workId: z.string().min(1),
    assignmentVersion: revision,
    requestSequence: revision,
    instructionsRevision: revision,
    profileRevision: revision,
    harness: executionHarnessSchema.nullable(),
    /** Optional so older services still parse; null until the turn is admitted. */
    commandNetworkAccess: z.boolean().nullable().optional(),
    /** The latest failed turn's bounded classification; null when none failed. */
    failure: z
      .object({
        classification: z.enum(["transient", "permanent", "unknown"]),
        reasonCode: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const assignmentSchema = z
  .object({
    assignmentId: uuid,
    profileId: uuid,
    name: safeText,
    brief: safeText.optional(),
    requesterAssignmentId: uuid.nullable().optional(),
    resultDestination: safeText.optional(),
    resultRecipientAssignmentId: uuid.nullable().optional(),
    resultRecipientDisposition: safeText.optional(),
    waitReason: safeText.optional(),
    version: revision,
    state: z.enum(["pending", "running", "completed", "held", "cancelled"]),
    profileRevision: revision,
    instructionsRevision: revision,
    currentProfileRevision: revision,
    currentInstructionsRevision: revision,
    /** The execution runtime of the captured profile revision. */
    runtime: profileRuntimeSchema,
    executionGeneration: generation.nullable(),
  })
  .strict();
const message = z
  .object({
    eventId: uuid,
    eventType: z.string(),
    recipientAssignmentId: uuid,
    deliveryState: z.enum([
      "pending",
      "queued",
      "delivered",
      "operator-reconciled",
    ]),
    createdAt: time,
    text: safeText.optional(),
    decision: z.enum(["approved", "denied"]).optional(),
    action: safeText.optional(),
    target: safeText.optional(),
    resultId: uuid.optional(),
    routingOperationId: uuid.optional(),
    routingReason: safeText.optional(),
    questionAnswers: questionAnswersSchema.optional(),
    interactionId: uuid.optional(),
    reference: feedbackReferenceSchema.optional(),
    requester: z.enum(["assignment", "operator"]).optional(),
  })
  .strict();
const result = z
  .object({
    resultId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    workId: z.string().min(1),
    workRevision: revision,
    assignmentVersion: revision,
    summary: safeText,
    recipientAssignmentId: uuid.nullable(),
    destinationDisposition: z.enum(["delivered", "unresolved"]),
    createdAt: time,
  })
  .strict();
export const interactionSchema = z
  .object({
    interactionId: uuid,
    taskId: uuid,
    requestingAssignmentId: uuid,
    requestingWorkId: z.string().min(1),
    requestingWorkRevision: revision,
    requestingAssignmentVersion: revision,
    conversationRevision: revision,
    kind: z.enum(["question", "approval"]),
    status: z.enum(["open", "answered", "approved", "denied"]),
    prompt: safeText,
    action: safeText,
    target: safeText,
    materialHash: hash.nullable(),
    material: materialSchema.nullable(),
    approvable: z.boolean(),
    /** For a recovery from an outside change: the code host's view of what the outside writer changed. */
    compareUrl: z.url().startsWith("https://").optional(),
    compareCodeHost: z.enum(["github", "gitlab"]).optional(),
    /** For a pull request, merge request, thread or branch action: the code host of its repository link; absent means GitHub. */
    codeHost: z.enum(["github", "gitlab"]).optional(),
    materialUnavailable: z.boolean(),
    response: safeText,
    revision,
    createdAt: time,
    updatedAt: time,
  })
  .strict()
  // The link and its code host come together, and a GitHub link stays on github.com.
  .refine(
    (i) =>
      (i.compareUrl === undefined) === (i.compareCodeHost === undefined) &&
      (i.compareCodeHost !== "github" ||
        i.compareUrl?.startsWith("https://github.com/")),
  );
const completion = z
  .object({
    requestId: uuid,
    taskId: uuid,
    leadAssignmentId: uuid,
    leadWorkId: z.string().min(1),
    leadWorkRevision: revision,
    taskVersion: revision,
    reviewedResultIds: z.array(uuid),
    status: z.enum(["pending", "rejected", "finalized"]),
    rejectionReasons: z.array(z.literal("completion-rejected")),
    revision,
    createdAt: time,
    finalizedAt: time.nullable(),
  })
  .strict();
export const unresolvedResultSchema = z
  .object({
    resultId: uuid,
    taskId: uuid,
    assignmentId: uuid,
    revision,
    reasonCode: z.literal("unresolved-destination"),
    permittedRecipient: z
      .object({ assignmentId: uuid, name: safeText })
      .strict()
      .nullable(),
    availability: z.enum(["available", "recipient-unavailable"]),
  })
  .strict();
const source = z
  .object({
    identity: sourceIdentity,
    repositoryName: sourceRepositoryName.nullable(),
    number: revision.nullable(),
    url: sourceUrl.nullable(),
    ...jiraSourceDetail,
    title: safeText,
    body: safeText,
    state: z.enum(["open", "closed"]).nullable(),
    closure: sourceClosure,
    readiness: taskReadinessSchema,
    memberships: z.array(
      z
        .object({
          selectionId: z.string().max(512),
          projectFields: z.array(
            z
              .object({
                projectNodeId: z.string().max(512),
                fieldNodeId: z.string().max(512),
                optionNodeId: z.string().max(512),
                ...fieldNameShape,
              })
              .strict(),
          ),
          sync: z
            .object({
              lastAttemptAt: z.string().nullable(),
              lastSuccessfulAt: z.string().nullable(),
              complete: z.boolean().nullable(),
              reasonCode: z
                .enum(["partial-sync", "sync-unavailable"])
                .nullable(),
            })
            .strict(),
        })
        .strict(),
    ),
    nativeBlockers: z.array(
      z
        .object({
          nodeId: z.string().max(512),
          repositoryId: z.string().max(512),
          repositoryName: z.string().max(512),
          number: revision,
          state: z.enum(["open", "closed"]),
          /** The tracker's own name for the blocker, `owner/name#n` or `KEY-n`, and its link. */
          label: text,
          url: sourceUrl.nullable(),
        })
        .strict(),
    ),
    review: z
      .object({
        observedDigest: hash,
        acceptedDigest: hash,
        decision: safeText,
        decidedAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
    hold: z
      .object({
        active: z.boolean(),
        revision,
        reasonCode: z.literal("source-held"),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .nullable();
export const reviewReadSchema = envelope(taskReviewReadSchema);
const publicationStepStateSchema = z.enum([
  "prepared",
  "attempting",
  "uncertain",
  "confirmed-success",
  "confirmed-failure",
  "denied",
]);
const publicationProjectFieldsSchema = z.array(
  z
    .object({
      projectNodeId: text,
      fieldNodeId: text,
      optionNodeId: text,
      ...fieldNameShape,
    })
    .strict(),
);
/** Where a local task can be published, and why a target cannot take it. */
export const publicationPolicySchema = z
  .object({
    available: z.boolean(),
    reasonCode: z.enum(publicationReasonCodes).nullable(),
    reason: safeText,
    targets: z
      .array(
        z
          .object({
            id: text,
            repository: safeText,
            selectionKind: z.enum(["repository", "project", "search"]),
            enabled: z.boolean(),
            reasonCode: z.enum(publicationTargetReasonCodes).nullable(),
            reason: safeText,
            labels: z.array(safeText),
            projectFields: publicationProjectFieldsSchema,
            predictedSelected: z.boolean(),
            predictedReady: z.boolean(),
          })
          .strict(),
      )
      // Every unfiltered Project selection (30) crossed with every linked repository (20).
      .max(600),
    /** The task's newest publication, whatever its state. */
    latest: z
      .object({
        publicationId: uuid,
        state: z.enum(publicationStates),
        revision,
        materialHash: hash,
        repository: safeText,
        issueNumber: revision.nullable(),
        steps: z
          .array(
            z
              .object({
                operationId: uuid,
                kind: z.enum([
                  "issue.create",
                  "project.item.add",
                  "project.field",
                ]),
                state: publicationStepStateSchema,
                /** A failure GitHub allows retrying, with attempts left: the step waits for a retry. */
                retrying: z.boolean(),
                reason: safeText,
              })
              .strict(),
          )
          .max(24),
        createdAt: time,
      })
      .strict()
      .nullable(),
  })
  .strict();
export const deliveryReadSchema = z
  .object({
    mode: z.enum(["reviewable-pr", "through-merge"]),
    policyVersion: revision,
    blockers: z.array(text).max(128),
    omittedBlockerCount: z.number().int().nonnegative(),
    omittedActionCount: z.number().int().nonnegative(),
    /** The task's assigned branches; a name the exclusions withhold reads as null. */
    branches: z
      .array(
        z
          .object({
            repositoryName: text,
            branch: safeText,
            lastPushedSha: text.nullable(),
            outsideHeadSha: text.nullable(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    binding: z
      .object({
        revision,
        number: revision,
        repositoryName: text,
        /** The code host of the repository link; absent means GitHub, as on older servers. */
        codeHost: z.enum(["github", "gitlab"]).optional(),
        /** Built by the server for the PR's own repository only; the web renders no other link. */
        url: z.url().startsWith("https://").optional(),
        draft: z.boolean().optional(),
        headSha: text,
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        /** The operator's handback settlement of a reviewable PR, and the head it covers; absent from older servers. */
        settlement: z
          .object({
            decision: z.enum(["accepted", "closed"]),
            headSha: text,
          })
          .strict()
          .nullable()
          .optional(),
        observedAt: time,
        readError: safeText,
        omittedCheckCount: z.number().int().nonnegative(),
        omittedFeedbackCount: z.number().int().nonnegative(),
        checks: z
          .array(
            z
              .object({
                name: safeText,
                sha: text,
                status: z.enum(["success", "pending", "failure"]),
              })
              .strict(),
          )
          .max(128),
        feedback: z
          .array(
            z
              .object({
                nodeId: text,
                kind: text,
                author: safeText,
                body: safeText,
                commitSha: safeText,
                updatedAt: text,
                state: text,
              })
              .strict(),
          )
          .max(128),
      })
      .strict()
      // A GitHub link stays on github.com; a GitLab instance may be any https host.
      .refine(
        (b) =>
          b.codeHost === "gitlab" ||
          b.url === undefined ||
          b.url.startsWith("https://github.com/"),
      )
      .nullable(),
    actions: z
      .array(
        z
          .object({
            operationId: uuid,
            kind: text,
            /** Who submitted it; a status-mapping write is the service's, not an agent's or the operator's. */
            caller: z.enum(["agent", "operator", "service"]),
            /** The mapped event of a service write. */
            event: z.enum(statusMappingEvents).nullable(),
            state: text,
            reason: safeText,
            createdAt: time,
            updatedAt: time,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export const searchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(256),
    projectId: uuid.optional(),
    type: z.enum(["task", "decision", "result"]).optional(),
    after: z.coerce.number().int().nonnegative().optional(),
    before: z.coerce.number().int().nonnegative().optional(),
    historical: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    cursor: z
      .string()
      .regex(/^[a-f0-9-]{36}(?::decision:[0-9]+)?$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export const searchReadSchema = envelope(
  z
    .object({
      matches: z
        .array(
          z
            .object({
              recordId: text,
              type: z.enum(["task", "decision", "result"]),
              taskId: uuid,
              projectId: uuid,
              projectName: safeText,
              taskTitle: safeText,
              sourceId: uuid.nullable(),
              resultId: uuid.nullable(),
              excerpt: safeText,
              createdAt: time,
              historical: z.boolean(),
              href: text,
            })
            .strict(),
        )
        .max(50),
      nextCursor: text.nullable(),
      coverage: z.literal("retained-records-only"),
      omittedCount: time,
    })
    .strict(),
);
export const taskSchema = envelope(
  z
    .object({
      task: z
        .object({
          id: uuid,
          projectId: uuid,
          title: safeText,
          outcome: safeText,
          version: revision,
          state: taskState,
          ready: z.boolean(),
        })
        .strict(),
      lead: z.object({ profileId: uuid, name: safeText }).strict().nullable(),
      leadAssignmentId: uuid.nullable().optional(),
      leadFeedback: z
        .object({
          mode: z.enum(["receives", "resumes", "unavailable"]),
          awaitingRecoveryMessage: z.boolean(),
        })
        .strict()
        .optional(),
      /** Whether the operator can start a draft turn now, and why not. */
      draftTurn: z
        .object({
          available: z.boolean(),
          reason: draftTurnReasonSchema.optional(),
        })
        .strict()
        .optional(),
      /** Whether Start again is offered for a request refused before it ran, and why not. */
      startAgain: z
        .object({
          available: z.boolean(),
          reason: startAgainReasonSchema.optional(),
          assignmentId: uuid.optional(),
          workId: z.string().min(1).max(512).optional(),
        })
        .strict()
        .optional(),
      /** Whether Reset task is offered, and why not. */
      reset: z
        .object({
          available: z.boolean(),
          reason: resetReasonSchema.optional(),
        })
        .strict()
        .optional(),
      assignments: z.array(assignmentSchema),
      admission: z
        .object({
          eligible: z.boolean(),
          reasons: z.array(
            z.enum([
              "project-paused",
              "project-lead-unconfigured",
              "project-lead-revoked",
              "task-unready",
              "task-not-open",
              "local-dependency",
              "imported-blockers-unknown",
              "imported-blockers-blocked",
              "source-held",
              "admission-blocked",
            ]),
          ),
        })
        .strict(),
      waits: z.array(waitSchema).max(waitCodes.length),
      execution: executionSchema,
      // The recorded reason of a task hold other than Stop; null when there is none.
      taskHold: z.object({ reason: safeText }).strict().nullable(),
      localDependencies: z.array(
        z.object({ id: uuid, title: safeText, state: taskState }).strict(),
      ),
      source,
      messages: z.array(message),
      results: z.array(result),
      unresolvedResults: z.array(unresolvedResultSchema),
      questions: z.array(interactionSchema),
      approvals: z.array(interactionSchema),
      completionRequests: z.array(completion),
      attention: z
        .object({
          interactions: z.array(
            z
              .object({
                attentionId: uuid,
                interactionId: uuid,
                status: z.enum(["open", "resolved"]),
                revision,
                createdAt: time,
                resolvedAt: time.nullable(),
              })
              .strict(),
          ),
          completions: z.array(
            z
              .object({
                requestId: uuid,
                status: z.enum(["pending", "rejected", "finalized"]),
                revision,
              })
              .strict(),
          ),
          routingFallbacks: z.array(
            z
              .object({
                eventId: uuid,
                operationId: uuid,
                reasonCode: z.literal("routing-fallback"),
                createdAt: time,
              })
              .strict(),
          ),
          codes: attentionCodesSchema,
          count: time,
        })
        .strict(),
      review: taskReviewReadSchema.optional(),
      delivery: deliveryReadSchema.optional(),
      commentPolicy: z
        .object({
          available: z.boolean(),
          mode: z.enum(["allow", "approval"]).nullable(),
          reason: safeText,
          /** Why a comment cannot be posted; absent from older servers. `available` and `reason` are unchanged. */
          reasonCode: z.enum(commentReasonCodes).nullable().optional(),
        })
        .strict()
        .optional(),
      /** Whether the operator can improve and edit the source issue, and the newest such edit. */
      issueEdit: z
        .object({
          available: z.boolean(),
          reasonCode: z.enum(issueEditReasonCodes).nullable(),
          reason: safeText,
          latest: z
            .object({
              operationId: uuid,
              state: z.enum([
                "prepared",
                "attempting",
                "uncertain",
                "confirmed-success",
                "confirmed-failure",
                "denied",
              ]),
              reason: safeText,
            })
            .strict()
            .nullable(),
        })
        .strict()
        .optional(),
      /** Whether the operator can publish this local task as a GitHub issue, to where, and its newest publication. */
      publication: publicationPolicySchema.optional(),
      /** True when the task's project links at least one GitHub repository; no names or paths. */
      repositoryLinked: z.boolean().optional(),
      contentUnavailable: z.boolean(),
    })
    .strict(),
);
/** Paged results or messages of one task, projected exactly as in `taskSchema`. */
export const taskRecordQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: uuid.optional(),
    resultId: uuid.optional(),
  })
  .strict()
  .refine((q) => !(q.cursor && q.resultId));
export const taskResultPageSchema = envelope(
  z
    .object({
      results: z.array(result).max(200),
      total: time,
      nextCursor: uuid.nullable(),
    })
    .strict(),
);
export const taskMessagePageSchema = envelope(
  z
    .object({
      messages: z.array(message).max(200),
      total: time,
      nextCursor: uuid.nullable(),
    })
    .strict(),
);
const binding = {
  workId: z.string().min(1),
  taskId: uuid,
  assignmentId: uuid,
  assignmentVersion: revision,
  instructionsRevision: revision,
  profileRevision: revision,
  conversationRevision: revision,
  workRevision: revision,
  threadId: z.string().min(1),
  turnId: z.string().min(1),
};
export const assignmentHistorySchema = envelope(
  z
    .object({
      visibilityRevision: hash.optional(),
      items: z.array(
        z
          .object({
            ...binding,
            sequence: revision,
            itemId: z.string().min(1),
            lifecycle: z.enum(["started", "streaming", "completed", "omitted"]),
            text: z.string().nullable(),
            omissionReason: z
              .enum([
                "size-limit",
                "item-limit",
                "active-turn-limit",
                "turn-ended",
                "missing-text",
                "redaction-unavailable",
              ])
              .nullable(),
            deltaBytes: time,
            createdAt: time,
            updatedAt: time,
          })
          .strict(),
      ),
      turnOmissions: z.array(
        z
          .object({
            ...binding,
            sequence: revision,
            reason: z.literal("early-buffer-limit"),
            createdAt: time,
          })
          .strict(),
      ),
      omittedItemCount: time,
      omittedTurnCount: z.number().int().nonnegative(),
    })
    .strict(),
);
const timelineKey = z
  .string()
  .regex(/^[0-9]{1,16}\.[0-9]{1,2}\.[0-9]{1,16}\.[\w-]{1,96}$/);
const timelineEntryBase = {
  entryId: z.string().regex(/^[\w-]{1,96}$/),
  key: timelineKey,
  assignmentId: uuid,
  /** Milliseconds; `precision: "s"` means the record only has whole-second time. */
  at: time,
  precision: z.enum(["ms", "s"]),
};
/** One page of a task's conversation, oldest first; `olderCursor` is the next `before`. */
export const taskTimelineSchema = envelope(
  z
    .object({
      visibilityRevision: hash,
      olderCursor: timelineKey.nullable(),
      entries: z
        .array(
          z.discriminatedUnion("kind", [
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("assistant"),
                workId: z.string().min(1),
                lifecycle: z.enum(["started", "streaming", "completed"]),
                // Captured text is bounded at 64 KiB, as in the assignment history.
                text: z.string().nullable(),
              })
              .strict(),
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("request"),
                requestKind: z.enum(["question", "approval"]),
                interactionId: uuid,
                status: z.enum(["open", "answered", "approved", "denied"]),
                prompt: safeText,
                action: safeText,
                target: safeText,
              })
              .strict(),
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("result"),
                resultId: uuid,
                summary: safeText,
                recipientAssignmentId: uuid.nullable(),
                destinationDisposition: z.enum(["delivered", "unresolved"]),
              })
              .strict(),
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("message"),
                messageKind: z.enum([
                  "operator-message",
                  "follow-up",
                  "answer",
                  "decision",
                ]),
                requester: z.enum(["assignment", "operator"]).nullable(),
                interactionId: uuid.nullable(),
                decision: z.enum(["approved", "denied"]).nullable(),
                text: safeText,
                questionAnswers: questionAnswersSchema.nullable(),
              })
              .strict(),
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("delegation"),
                requesterAssignmentId: uuid.nullable(),
                profileId: uuid,
                name: safeText,
                runtime: profileRuntimeSchema,
                state: z.enum([
                  "pending",
                  "running",
                  "completed",
                  "held",
                  "cancelled",
                ]),
              })
              .strict(),
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("tool"),
                tool: z.enum(["command", "file-change", "other"]),
                label: z.string().max(128).nullable(),
                status: z.string().max(64).nullable(),
                command: z.string().max(512).nullable(),
                truncated: z.boolean(),
                exitCode: z.number().int().nullable(),
                /** Pass to the output read; null when no output is retained. */
                outputSequence: revision.nullable(),
              })
              .strict(),
            z
              .object({
                ...timelineEntryBase,
                kind: z.literal("gap"),
                reason: z.enum([
                  "size-limit",
                  "item-limit",
                  "active-turn-limit",
                  "turn-ended",
                  "missing-text",
                  "redaction-unavailable",
                  "early-buffer-limit",
                  "tool-activity-expired",
                  "tool-activity-not-captured",
                  "tool-activity-incomplete",
                ]),
                detail: z
                  .object({
                    workId: safeText,
                    turnId: safeText,
                    itemId: safeText,
                  })
                  .strict(),
              })
              .strict(),
          ]),
        )
        .max(100),
    })
    .strict(),
);
/** The bounded, redacted output of one completed command in a task's timeline. */
export const taskToolOutputSchema = envelope(
  z
    .object({
      sequence: revision,
      state: z.enum(["available", "omitted"]),
      reason: z
        .enum(["size-limit", "redaction-unavailable", "not-captured"])
        .nullable(),
      // Bounded by the 48 KiB capture limit rather than the 16,000-character field limit.
      text: z.string().nullable(),
    })
    .strict(),
);
const base = { key: uuid };
const domainBase = { ...base, projectId: uuid };
const localReviewCommentSchema = z
  .object({
    commentId: uuid,
    body: z.string().trim().min(1).max(4000),
    // Reads accept stored drafts from before the anchor rule.
    anchorGroupIds: z.array(uuid).max(32),
  })
  .strict();
const localReviewDraftContentSchema = z
  .object({
    summary: z.string().trim().max(4000),
    comments: z.array(localReviewCommentSchema).max(32),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const ids = draft.comments.flatMap((comment) => comment.anchorGroupIds);
    if (
      new Set(draft.comments.map((comment) => comment.commentId)).size !==
        draft.comments.length ||
      new Set(ids).size !== ids.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate-local-review-reference",
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength;
    if (bytes > 16000)
      ctx.addIssue({ code: "custom", message: "local-review-batch-too-large" });
  });
/** Saved drafts bind every comment to exact anchor context. */
const localReviewDraftWriteSchema = localReviewDraftContentSchema.refine(
  (draft) =>
    draft.comments.every((comment) => comment.anchorGroupIds.length > 0),
  { message: "local-review-comment-anchor-required" },
);
export const localReviewDraftReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      version: z.number().int().nonnegative().safe(),
      state: z.enum(["editable", "sending", "sent"]),
      draft: localReviewDraftContentSchema,
      accessFingerprint: z.string().max(128).nullable(),
      updatedAt: time.nullable(),
      pendingOperation: z
        .object({
          key: uuid,
          recipientAssignmentId: uuid,
          expectedAssignmentVersion: revision,
        })
        .strict()
        .nullable(),
      groups: z
        .array(
          z
            .object({
              groupId: uuid,
              anchorIds: z.array(uuid).max(32),
              state: z.enum(["open", "sealed", "discarded"]),
              submittedContextId: uuid.nullable(),
              createdAt: time,
            })
            .strict(),
        )
        .max(1024),
      unsentDraftLost: z.boolean(),
    })
    .strict(),
);
const localReviewOperationAnchorSchema = z.union([
  z
    .object({
      anchorId: uuid,
      state: z.literal("unavailable"),
      reason: z.enum(["excluded", "unavailable"]),
    })
    .strict(),
  z
    .object({
      anchorId: uuid,
      state: z.enum(["available", "gap"]),
      status: z.enum(["current", "outdated", "unknown"]).optional(),
      path: z.string().min(1).max(2048),
      context: z.enum(["workspace", "branch", "uncommitted", "turn", "result"]),
      startLine: revision,
      endLine: revision,
    })
    .strict(),
]);
/** Recorded reviews for a task, newest first; unsent operations are never listed. */
export const localReviewListReadSchema = envelope(
  z
    .object({
      taskId: uuid,
      reviews: z
        .array(
          z
            .object({
              operationId: uuid,
              reviewId: uuid,
              recipientAssignmentId: uuid,
              eventId: uuid,
              recordedAt: time,
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
);
export const localReviewOperationReadSchema = envelope(
  z
    .object({
      operationId: uuid,
      taskId: uuid,
      reviewId: uuid,
      state: z.enum(["prepared", "recorded", "rejected", "not-recorded"]),
      eventId: uuid.optional(),
      recipientAssignmentId: uuid.optional(),
      reason: z.string().max(128).optional(),
      recordedAt: time.optional(),
      resumedLead: z.literal(true).optional(),
      summary: z.string().max(16000).nullable().optional(),
      comments: z
        .array(
          z
            .object({
              commentId: uuid,
              body: z.string().max(4000).nullable(),
              anchorGroupIds: z.array(uuid).max(32),
            })
            .strict(),
        )
        .max(32)
        .optional(),
      groups: z
        .array(
          z
            .object({
              groupId: uuid,
              anchors: z.array(localReviewOperationAnchorSchema).max(32),
            })
            .strict(),
        )
        .max(32)
        .optional(),
    })
    .strict(),
);
/** A drafted task brief: the same limits as `task.create` title and outcome. */
export const draftProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(512),
    // As the composer requires of a typed outcome; a pattern, so it reaches the tool's JSON schema.
    outcome: text.regex(/\S/, "Enter a desired outcome"),
  })
  .strict();
export type DraftProposal = z.infer<typeof draftProposalSchema>;

export const operatorCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...domainBase,
      type: z.literal("task.create"),
      taskId: uuid,
      title: z.string().trim().min(1).max(512),
      outcome: text,
      ready: z.boolean(),
      blockerTaskIds: z
        .array(uuid)
        .max(128)
        .refine((ids) => new Set(ids).size === ids.length)
        .optional(),
      initialAssignment: z
        .object({ assignmentId: uuid, profileId: uuid })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("task.configure"),
      taskId: uuid,
      expectedVersion: revision,
      title: z.string().trim().min(1).max(512).optional(),
      outcome: text.optional(),
      ready: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("dependency.add"),
      taskId: uuid,
      blockerTaskId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("dependency.remove"),
      taskId: uuid,
      blockerTaskId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("assignment.apply"),
      assignmentId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("message"),
      taskId: uuid,
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
      message: z.string().trim().min(1).max(16000),
      reference: feedbackReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.anchor.stage"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      anchors: z.array(reviewAnchorSelectionSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.draft.save"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      draft: localReviewDraftWriteSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.draft.discard"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.send"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.send.reconcile"),
      taskId: uuid,
      expectedDraftVersion: z.number().int().nonnegative().safe(),
      recipientAssignmentId: uuid,
      expectedAssignmentVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answer: z.string().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.form.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answers: questionAnswersSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("question.native.answer"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      answers: z
        .record(
          z.string().min(1).max(512),
          z
            .object({
              answers: z.array(z.string().min(1).max(16000)).length(1),
            })
            .strict(),
        )
        .superRefine((value, ctx) => {
          if (
            new TextEncoder().encode(JSON.stringify(value)).byteLength >
            questionPayloadLimit
          )
            ctx.addIssue({
              code: "custom",
              message: "Answer payload exceeds limit",
            });
        }),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("approval.decide"),
      taskId: uuid,
      interactionId: uuid,
      expectedRevision: revision,
      decision: z.enum(["approved", "denied"]),
      action: text,
      target: text.optional(),
      material: materialSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("result.recipient"),
      taskId: uuid,
      resultId: uuid,
      expectedRevision: revision,
      recipientAssignmentId: uuid,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("project.create"),
      name: z.string().trim().min(1).max(512),
      leadProfileId: uuid.nullable(),
      instructions: text.optional(),
      repositories: setupRepositoriesSchema.optional(),
      githubProject: z
        .object({ projectNodeId: z.string().trim().min(1).max(512) })
        .strict()
        .optional(),
      sourceCredentialRef: z.literal("gh:github.com").optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("project.configure"),
      expectedVersion: revision,
      name: z.string().trim().min(1).max(512).optional(),
      paused: z.boolean().optional(),
      leadProfileId: uuid.nullable().optional(),
      instructions: text.optional(),
      diagnosticCapture: z.enum(["enhanced", "baseline"]).optional(),
      commandNetworkAccess: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("profile.create"),
      profileId: uuid,
      name: z.string().trim().min(1).max(512),
      summary: z.string().trim().max(120).optional(),
      instructions: text,
      capabilities: text,
      runtime: profileRuntimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("profile.configure"),
      profileId: uuid,
      expectedVersion: revision,
      name: z.string().trim().min(1).max(512).optional(),
      summary: z.string().trim().max(120).optional(),
      instructions: text.optional(),
      capabilities: text.optional(),
      revoked: z.boolean().optional(),
      runtime: profileRuntimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("routing.configure"),
      expectedVersion: revision,
      enabled: z.boolean(),
      guidance: text.optional(),
      credentialRef: z
        .string()
        .regex(/^env:[A-Z][A-Z0-9_]*$/)
        .nullable()
        .optional(),
      candidateProfileIds: z
        .array(uuid)
        .max(128)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("status-mapping.configure"),
      expectedVersion: revision,
      mapping: statusMappingSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("repositories.configure"),
      expectedVersion: revision,
      ...repositoriesConfigurationCommandSchema.shape,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("jira.configure"),
      expectedVersion: revision,
      ...jiraConfigurationSchema.shape,
      /** Omitted keeps the saved rule; `null` removes it. */
      readiness: jiraConfigurationSchema.shape.readiness.optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("github.configure"),
      expectedVersion: revision,
      ...githubConfigurationCommandSchema.shape,
      credentialRef: githubConfigurationSchema.shape.credentialRef.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("capacity.configure"),
      globalLimit: revision,
      projectOverrides: z.record(uuid, revision.nullable()),
      /** Optional compare-and-swap: the limits this change was prepared against. */
      expectedCurrent: z
        .object({
          globalLimit: revision,
          projectOverrides: z.record(uuid, revision.nullable()).default({}),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("discovery.configure"),
      credentialRef: discoveryCredentialReference.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("code-host-credential.configure"),
      codeHost: z.literal("gitlab"),
      host: gitLabHostSchema,
      /** `env:NAME`, or `glab:` and the same host; null removes the host's credential. */
      credentialRef: gitLabCredentialReference.nullable(),
    })
    .strict()
    .refine(glabReferenceMatchesHost, { path: ["credentialRef"] }),
  z
    .object({
      ...base,
      type: z.literal("issue-tracker-credential.configure"),
      issueTracker: z.literal("jira"),
      /** Only to remove a site's credential; saving derives the site from `siteRef`. */
      instance: jiraInstanceSchema.optional(),
      siteRef: envCredentialReference.optional(),
      emailRef: envCredentialReference.optional(),
      tokenRef: envCredentialReference.optional(),
      clear: z.literal(true).optional(),
    })
    .strict()
    .refine((c) =>
      c.clear
        ? c.instance !== undefined && !c.siteRef && !c.emailRef && !c.tokenRef
        : c.instance === undefined &&
          Boolean(c.siteRef && c.emailRef && c.tokenRef) &&
          new Set([c.siteRef, c.emailRef, c.tokenRef]).size === 3,
    ),
  z
    .object({
      ...base,
      type: z.literal("claude-token.configure"),
      /** `env:NAME`, or `file:` and an absolute path with no empty, `.` or `..` segment. */
      credentialRef: z
        .string()
        .max(1024)
        .regex(
          /^(?:env:[A-Z][A-Z0-9_]*|file:(?:\/(?!\.{1,2}(?:\/|$))[^/\0\r\n]+)+)$/,
        )
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("getting-started.configure"),
      dismissed: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("runtime.configure"),
      harness: executionHarnessSchema,
      enabled: z.boolean(),
      /**
       * The bound-task count the operator confirmed. Disabling a runtime that bound tasks
       * use is refused without it, or when the service now counts more.
       */
      confirmedBoundTasks: z.number().int().nonnegative().safe().optional(),
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("github.preview"),
      selectionId: z.string().trim().min(1).max(512),
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...domainBase,
      type: z.literal("github.place"),
      taskId: uuid,
      chosenProjectId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.view"),
      taskId: uuid,
      sourceId: uuid.nullable(),
      resultIds: z.array(uuid).max(128),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("delivery.refresh"), taskId: uuid })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("delivery.settle"),
      taskId: uuid,
      expectedTaskVersion: revision,
      expectedDeliveryRevision: revision,
      expectedPolicyVersion: revision,
      expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
      decision: z.enum(["accepted", "closed"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("comment.review"),
      taskId: uuid,
      operationId: uuid,
      expectedTaskVersion: revision,
      body: z.string().trim().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("comment.confirm"),
      taskId: uuid,
      reviewId: uuid,
      expectedRevision: revision,
      materialHash: hash,
      decision: z.enum(["approved", "denied"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("comment.send"),
      taskId: uuid,
      expectedTaskVersion: revision,
      body: z.string().trim().min(1).max(16000),
      reviewId: uuid.optional(),
    })
    .strict(),
  // Improve with lead: a drafting run that proposes a better title and body for the task's issue.
  z
    .object({
      ...base,
      type: z.literal("issue.draft.start"),
      runId: uuid,
      taskId: uuid,
      expectedTaskVersion: revision,
      note: z.string().max(16000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("issue.edit.review"),
      taskId: uuid,
      /** The drafting run whose recorded text the edit replaces. */
      runId: uuid,
      operationId: uuid,
      expectedTaskVersion: revision,
      title: z.string().trim().min(1).max(issueTitleLimit),
      body: z.string().max(issueBodyLimit).regex(/\S/),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("issue.edit.confirm"),
      taskId: uuid,
      reviewId: uuid,
      expectedRevision: revision,
      materialHash: hash,
      decision: z.enum(["approved", "denied"]),
    })
    .strict(),
  // The key is the review's operation id: a send is one operation.
  z
    .object({
      ...base,
      type: z.literal("issue.edit.send"),
      taskId: uuid,
      reviewId: uuid,
      expectedTaskVersion: revision,
    })
    .strict(),
  // Publish a local task as a GitHub issue. The key of a review is the publication's id and its
  // `issue.create` operation id; confirm is the approval and send is one publication.
  z
    .object({
      ...base,
      type: z.literal("task.publish.review"),
      taskId: uuid,
      targetId: z.string().min(1).max(1100),
      expectedTaskVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.publish.confirm"),
      taskId: uuid,
      reviewId: uuid,
      expectedRevision: revision,
      materialHash: hash,
      decision: z.enum(["approved", "denied"]),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.publish.send"),
      taskId: uuid,
      reviewId: uuid,
      expectedTaskVersion: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.publish.link"),
      taskId: uuid,
      reviewId: uuid,
      issueNumber: revision,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.publish.abandon"),
      taskId: uuid,
      reviewId: uuid,
    })
    .strict(),
  // Queues one read-only turn of the project lead on an open task that is not Ready.
  z
    .object({
      ...base,
      type: z.literal("task.draft-turn"),
      taskId: uuid,
      expectedVersion: revision,
      message: z.string().trim().min(1).max(16000),
    })
    .strict(),
  // Queues a refused-before-start request again at the current revisions.
  z
    .object({
      ...base,
      type: z.literal("task.start-again"),
      taskId: uuid,
      expectedVersion: revision,
      workId: z.string().min(1).max(512),
    })
    .strict(),
  // Replaces every assignment's conversation and queues a fresh first turn for the lead.
  z
    .object({
      ...base,
      type: z.literal("task.reset"),
      taskId: uuid,
      expectedVersion: revision,
    })
    .strict(),
  // Optional fence: Stop and Resume act on a hold, so an unrelated edit must not block them.
  z
    .object({
      ...base,
      type: z.literal("task.stop"),
      taskId: uuid,
      expectedVersion: revision.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("task.resume"),
      taskId: uuid,
      expectedVersion: revision.optional(),
    })
    .strict(),
  // Evidence-bearing recovery: the inner service command plus its assignment scope.
  z
    .object({
      ...base,
      type: z.literal("recovery.pre-turn.adopt"),
      assignmentId: uuid,
      ...historicalPreTurnAdoptionBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.pre-turn.recover"),
      assignmentId: uuid,
      ...preTurnRecoveryBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.no-turn.adopt"),
      assignmentId: uuid,
      ...historicalNoTurnAdoptionBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.no-turn.recover"),
      assignmentId: uuid,
      ...noTurnRecoveryBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("recovery.conversation.replace"),
      ...replaceConversationBodySchema.shape,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("drafting.start"),
      runId: uuid,
      projectId: uuid,
      /** The composer's brief limit. */
      idea: z.string().min(1).max(16000),
    })
    .strict(),
  z.object({ ...base, type: z.literal("drafting.stop"), runId: uuid }).strict(),
  z
    .object({
      ...base,
      type: z.literal("drafting.settle"),
      runId: uuid,
      disposition: z.enum(["accept", "discard"]),
    })
    .strict(),
]);
export const configurationReceiptSchema = z
  .object({
    kind: z.literal("configuration"),
    key: uuid,
    recorded: z.literal(true),
    result: z.discriminatedUnion("commandType", [
      z
        .object({
          commandType: z.enum(["project.create", "project.configure"]),
          resourceId: uuid,
          version: revision,
          paused: z.boolean(),
          leadProfileId: uuid.nullable(),
          instructionsRevision: revision,
        })
        .strict(),
      z
        .object({
          commandType: z.enum(["profile.create", "profile.configure"]),
          resourceId: uuid,
          version: revision,
          revoked: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("routing.configure"),
          resourceId: uuid,
          version: revision,
          enabled: z.boolean(),
          credentialConfigured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("status-mapping.configure"),
          resourceId: uuid,
          version: revision,
          mappedEventCount: z.number().int().min(0).max(4),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("jira.configure"),
          resourceId: uuid,
          version: revision,
          selectionCount: time,
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.configure"),
          resourceId: uuid,
          version: revision,
          credentialConfigured: z.boolean(),
          selectionCount: time,
          /** Only receipts recorded before repository links moved to the project report it. */
          repositoryCount: time.optional(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("repositories.configure"),
          resourceId: uuid,
          version: revision,
          repositoryCount: time,
        })
        .strict(),
      z
        .object({
          commandType: z.literal("capacity.configure"),
          resourceId: z.literal("system:capacity"),
          globalLimit: revision,
          defaultProjectLimit: z.literal(2),
          projectOverrides: z.record(uuid, revision),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("discovery.configure"),
          resourceId: z.literal("system:discovery"),
          configured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("code-host-credential.configure"),
          resourceId: z
            .string()
            .regex(/^system:code-host-credential:gitlab:[a-z0-9.-]{1,253}$/),
          configured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("issue-tracker-credential.configure"),
          resourceId: z
            .string()
            .regex(/^system:issue-tracker-credential:jira:[a-z0-9.-]{1,253}$/),
          configured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("claude-token.configure"),
          resourceId: z.literal("system:claude-token"),
          configured: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("getting-started.configure"),
          resourceId: z.literal("system:getting-started"),
          dismissed: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("runtime.configure"),
          resourceId: z.enum(["system:runtime:codex", "system:runtime:claude"]),
          harness: executionHarnessSchema,
          enabled: z.boolean(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.preview"),
          resourceId: uuid,
          selectionId: z.string().min(1).max(512),
          configVersion: revision,
          active: z.literal(true),
          alreadyActive: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          commandType: z.literal("github.place"),
          resourceId: uuid,
          projectId: uuid,
          version: revision,
        })
        .strict(),
    ]),
  })
  .strict();
export const runtimeSettingsSchema = envelope(
  z
    .object({
      /** Each execution runtime's setting and the tasks a disable would make wait. */
      runtimes: z.array(
        z
          .object({
            harness: executionHarnessSchema,
            enabled: z.boolean(),
            boundTasks: time,
          })
          .strict(),
      ),
      globalLimit: revision,
      defaultProjectLimit: z.literal(2),
      globalUsage: time,
      projects: z.array(
        z
          .object({
            project: projectSummarySchema,
            limit: revision,
            usage: time,
            override: revision.nullable(),
            tasks: z.array(
              z
                .object({
                  taskId: uuid,
                  title: safeText,
                  paused: z.boolean(),
                  held: z.boolean(),
                  assignments: z.array(
                    z.object({ assignmentId: uuid, name: safeText }).strict(),
                  ),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
);
export const recoveryObservationSchema = z.enum([
  "exact-live",
  "exact-terminal-completed",
  "exact-terminal-failed",
  "historical-only",
  "conflicting",
  "no-proof",
  "unknown",
  "termination-verified",
  "termination-conflict",
  "termination-unknown",
  "receipt-accepted",
  "retry-enqueued",
]);
const recoveryHolds = z
  .object({
    stop: z.boolean(),
    writer: z.boolean(),
    capacity: z.boolean(),
    uncertainty: z.boolean(),
    task: z.boolean(),
  })
  .strict();
const assignmentRecoveryRecordSchema = z
  .object({
    workId: safeText,
    generation: z
      .object({
        workRevision: revision.nullable(),
        requestSequence: revision,
      })
      .strict(),
    binding: z
      .object({
        assignmentId: uuid,
        assignmentVersion: revision,
        instructionsRevision: revision,
        profileRevision: revision,
      })
      .strict()
      .nullable(),
    // "unknown" is operator-only: the API reports it for an unrecognised stored state.
    intentState: z.enum([...executionIntentStateSchema.options, "unknown"]),
    requestState: z
      .enum(["queued", "active", "completed", "held", "unknown"])
      .nullable(),
    holds: recoveryHolds,
    observations: z.array(recoveryObservationSchema).max(12),
    pendingEffectCount: time,
    noTurnSubmission: z
      .object({
        id: uuid,
        source: z.literal("operator-adopted"),
        idleThreadMayExist: z.literal(true),
      })
      .strict()
      .optional(),
    preTurnRejection: z
      .object({
        id: uuid,
        source: z.enum(["runtime", "operator-adopted"]),
        predecessorThreadId: safeText,
      })
      .strict()
      .optional(),
    receiptRecorded: z.boolean(),
    workspace: z.enum(["preserved", "reconciled", "unknown"]),
  })
  .strict();
export const assignmentRecoverySchema = envelope(
  z
    .object({
      assignment: assignmentSchema,
      taskId: uuid,
      project: projectSummarySchema,
      held: z.boolean(),
      holds: recoveryHolds,
      evidenceAvailable: z.boolean(),
      omittedCount: time,
      records: z.array(assignmentRecoveryRecordSchema).max(20),
    })
    .strict(),
);
/** Closed reasons a recovery path is not currently eligible; advisory, the service decides. */
export const recoveryBlockerSchema = z.enum([
  "not-held",
  "ownership-released",
  "context-unavailable",
  "witness-missing",
  "witness-present",
  "other-witness",
  "already-reconciled",
  "reason-withheld",
  "identity-withheld",
  "task-held",
  "unresolved-execution",
]);
export const recoveryPathSchema = z.enum(recoveryPaths);
const boundedText = z.string().max(4000);
/** Exact recovery identity of one assignment's generations, with advisory eligibility. */
export const recoveryOptionsSchema = envelope(
  z
    .object({
      assignmentId: uuid,
      taskId: uuid,
      projectId: uuid,
      assignmentVersion: revision,
      conversationRevision: revision,
      held: z.boolean(),
      holds: recoveryHolds,
      evidenceAvailable: z.boolean(),
      omittedCount: time,
      /** Exact strings withheld because redaction changed them or was unavailable. */
      gaps: z.array(z.enum(["content-redacted", "redaction-unavailable"])),
      replacement: z
        .object({
          eligible: z.boolean(),
          blockedBy: z.array(recoveryBlockerSchema),
          expectedAssignmentVersion: revision,
          expectedConversationRevision: revision,
        })
        .strict(),
      records: z
        .array(
          z
            .object({
              workId: z.string().max(512).nullable(),
              generation: z
                .object({
                  workRevision: revision.nullable(),
                  requestSequence: revision,
                })
                .strict(),
              intentState: assignmentRecoveryRecordSchema.shape.intentState,
              requestState: assignmentRecoveryRecordSchema.shape.requestState,
              holds: recoveryHolds,
              observations: z.array(recoveryObservationSchema).max(12),
              process: z
                .object({
                  processId: boundedText,
                  processStartedAt: boundedText,
                  bootId: boundedText,
                })
                .strict()
                .nullable(),
              retainedReason: boundedText.nullable(),
              writerSequence: revision.nullable(),
              conversationRevision: revision.nullable(),
              predecessor: z
                .object({ workId: boundedText, threadId: boundedText })
                .strict()
                .nullable(),
              witnesses: z
                .object({
                  preTurn: z
                    .object({
                      id: uuid,
                      source: z.enum(["runtime", "operator-adopted"]),
                    })
                    .strict()
                    .nullable(),
                  noTurn: z.object({ id: uuid }).strict().nullable(),
                })
                .strict(),
              receiptRecorded: z.boolean(),
              workspace: z.enum(["preserved", "reconciled", "unknown"]),
              paths: z
                .array(
                  z
                    .object({
                      path: recoveryPathSchema,
                      eligible: z.boolean(),
                      blockedBy: z.array(recoveryBlockerSchema),
                    })
                    .strict(),
                )
                .max(4),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
);
/** The GitHub CLI login for github.com, detected on every status read. Never the token. */
export const ghLoginStateSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("signed-in"),
      login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    })
    .strict(),
  z
    .object({
      state: z.enum(["not-installed", "not-signed-in", "unreadable"]),
    })
    .strict(),
]);
export const sourceCredentialReasonSchema = z.enum([
  "missing-credential",
  "invalid-credential-reference",
  "gh-not-installed",
  "gh-not-signed-in",
  "gh-unreadable",
]);
export const sourceCredentialStatusSchema = z
  .object({
    configured: z.boolean(),
    source: z.enum(["env", "gh"]).nullable(),
    usable: z.boolean(),
    reason: sourceCredentialReasonSchema.nullable(),
    gh: ghLoginStateSchema,
  })
  .strict();

export const sourceObservationSchema = envelope(
  z
    .object({
      projects: z.array(
        z
          .object({
            projectId: uuid,
            /** Absent for GitHub. A Jira project reports no GitHub credential. */
            tracker: z.literal("jira").optional(),
            credential: sourceCredentialStatusSchema.optional(),
            readiness: readinessRuleViewSchema,
            selections: z.array(
              z
                .object({
                  selectionId: safeText,
                  state: z.enum([
                    "complete",
                    "partial",
                    "never",
                    "unavailable",
                  ]),
                  credentialReason: sourceCredentialReasonSchema
                    .nullable()
                    .optional(),
                  lastAttemptAt: z.string().nullable(),
                  lastSuccessfulAt: z.string().nullable(),
                  counts: selectionCountsSchema.nullable(),
                  /** Optional so older services still parse; absent means not reported. */
                  projectFields: selectionProjectFieldsSchema.optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
);
export const profileConfigurationSchema = envelope(
  z
    .object({
      profile: profileSummarySchema,
      instructionPresent: z.boolean(),
      instructionRevision: revision,
      capabilities: safeText,
      runtime: profileRuntimeSchema,
    })
    .strict(),
);
/** The status mapping with what its editor needs: the Project selections and the granted options. */
export const statusMappingViewSchema = z
  .object({
    version: revision,
    availability: z.enum(["available", "unavailable"]),
    mapping: statusMappingSchema.nullable(),
    selections: z
      .array(
        z
          .object({ id: text, projectNodeId: text, active: z.boolean() })
          .strict(),
      )
      .max(30),
    /** Options an `allow` project field grant covers, per Project field. */
    granted: z
      .array(
        z
          .object({
            projectNodeId: text,
            fieldNodeId: text,
            optionNodeIds: z.array(text).max(256),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export const projectConfigurationSchema = envelope(
  z
    .object({
      project: projectSummarySchema,
      profiles: z.array(profileSummarySchema),
      instructionsRevision: revision,
      instructionPresent: z.boolean(),
      /** Optional so older services still parse; absent means not reported. */
      diagnosticCapture: z.enum(["enhanced", "baseline"]).optional(),
      commandNetworkAccess: z.boolean().optional(),
      routing: z
        .object({
          version: revision,
          enabled: z.boolean(),
          candidateProfileIds: z.array(uuid),
          credentialConfigured: z.boolean(),
          availability: z.enum([
            "available",
            "disabled",
            "missing-client-credentials",
            "no-eligible-candidates",
          ]),
        })
        .strict(),
      placements: z.array(
        z
          .object({
            taskId: uuid,
            projectId: uuid,
            version: revision,
            title: safeText,
            choices: z.array(projectSummarySchema),
          })
          .strict(),
      ),
      /** Optional so older services still parse; absent means not reported. */
      statusMapping: statusMappingViewSchema.optional(),
      repositories: z
        .object({
          version: revision,
          links: z.array(
            z.discriminatedUnion("codeHost", [
              z
                .object({
                  repositoryId: safeText,
                  codeHost: z.literal("github"),
                  host: z.literal("github.com"),
                  ref: safeText,
                })
                .strict(),
              z
                .object({
                  repositoryId: safeText,
                  codeHost: z.literal("gitlab"),
                  host: z.string().min(1).max(253),
                  ref: safeText,
                })
                .strict(),
            ]),
          ),
        })
        .strict(),
      source: z
        .object({
          version: revision,
          /** Absent for GitHub; for Jira, `instance` names the site. */
          tracker: z.literal("jira").optional(),
          instance: safeText.optional(),
          credentialConfigured: z.boolean(),
          credential: sourceCredentialStatusSchema.optional(),
          selections: z.array(
            z
              .object({
                id: safeText,
                kind: z.enum(["repository", "search", "project", "jql"]),
                descriptor: safeText,
                active: z.boolean(),
              })
              .strict(),
          ),
          readiness: readinessRuleViewSchema,
          closedIssues: closedIssuesSchema,
        })
        .strict(),
    })
    .strict(),
);
/**
 * Exact private text for one project, readable only by a signed-in web session.
 * Never reuse these schemas in a configuration read, list or CLI output.
 */
export const projectPrivateValuesSchema = envelope(
  z
    .object({
      project: z
        .object({
          version: revision,
          instructionsRevision: revision,
          instructions: text,
        })
        .strict(),
      routing: z.object({ version: revision, guidance: text }).strict(),
      source: z
        .object({
          version: revision,
          searches: z.array(z.object({ id: text, query: text }).strict()),
          /** A Jira project's selections; empty for GitHub. */
          jql: z.array(z.object({ id: text, jql: text }).strict()).optional(),
        })
        .strict(),
      repositories: z
        .object({
          version: revision,
          links: z.array(z.object({ repositoryId: text, path: text }).strict()),
        })
        .strict(),
    })
    .strict(),
);
/** Exact private instructions of one profile, readable only by a signed-in web session. */
export const profilePrivateValuesSchema = envelope(
  z
    .object({
      profile: z.object({ version: revision, instructions: text }).strict(),
    })
    .strict(),
);
export const questionReadSchema = z
  .object({
    data: z
      .object({
        taskId: uuid,
        interactionId: uuid,
        requestingAssignmentId: uuid,
        conversationRevision: revision,
        revision,
        source: z.enum(["plain", "cab", "native"]),
        status: z.enum([
          "pending",
          "recorded",
          "stale",
          "cancelled",
          "offline",
          "unsupported",
          "unavailable",
        ]),
        form: questionFormSchema.nullable(),
        answers: questionAnswersSchema.nullable(),
        reason: safeText,
        deliveryState: safeText,
      })
      .strict(),
    observedAt: time,
  })
  .strict();
export type QuestionRead = z.infer<typeof questionReadSchema>;
export const taskInboxItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["question", "approval", "intervention"]),
    urgency: z.number().int().min(0).max(1),
    createdAt: time.nullable(),
    taskId: uuid,
    projectId: uuid,
    projectName: safeText,
    taskTitle: safeText,
    requestingAssignmentId: uuid.nullable(),
    requesterName: safeText,
    interactionId: uuid.nullable(),
    revision: revision.nullable(),
    // The first question's label or the approval's exact action; null when withheld.
    headline: safeText,
    reason: safeText,
    attentionCode: attentionCodeSchema.nullable(),
    destination: z.string().max(512),
    evidence: z.string().max(512),
    conversation: z.string().max(512).nullable(),
  })
  .strict();
/**
 * A runtime whose automatic restarts are exhausted. Derived on every read from in-memory
 * restart state, never stored, and carries no task or project field.
 */
export const runtimeInboxItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.literal("runtime"),
    urgency: z.literal(0),
    /** The wall time of exhaustion, equal to `since`. */
    createdAt: time,
    harness: executionHarnessSchema,
    since: time,
    headline: z.string().max(200),
    reason: z.string().max(200),
    lastFailure: runtimeRestartFailureSchema,
    attempts: z.array(runtimeRestartAttemptSchema).max(3),
    destination: z.string().max(512),
  })
  .strict();
export const inboxItemSchema = z.union([
  taskInboxItemSchema,
  runtimeInboxItemSchema,
]);
export const inboxReadSchema = z
  .object({
    data: z
      .object({
        items: z.array(inboxItemSchema).max(100),
        nextCursor: z.string().max(256).nullable(),
        complete: z.boolean(),
        unavailable: z.boolean(),
      })
      .strict(),
    observedAt: time,
  })
  .strict();
export type TaskInboxItem = z.infer<typeof taskInboxItemSchema>;
export type RuntimeInboxItem = z.infer<typeof runtimeInboxItemSchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
// Fixed strict command envelope maxima; question JSON independently remains <=256 KiB.
export const questionCommandRawLimit =
  questionPayloadLimit +
  new TextEncoder().encode(
    JSON.stringify({
      type: "question.native.answer",
      key: "f".repeat(36),
      taskId: "f".repeat(36),
      interactionId: "f".repeat(36),
      expectedRevision: Number.MAX_SAFE_INTEGER,
      answers: {},
    }),
  ).byteLength -
  2;

export const commandReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("drafting"),
      key: uuid,
      recorded: z.literal(true),
      operation: z.enum(["start", "stop", "accept", "discard"]),
      runId: uuid,
      state: draftingStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("local-review-draft"),
      key: uuid,
      taskId: uuid,
      version: revision,
      state: z.enum(["editable", "discarded"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local-review-anchor"),
      key: uuid,
      taskId: uuid,
      groupId: uuid,
      anchorIds: z.array(uuid).max(32),
      draftVersion: revision,
      state: z.literal("staged"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local-review-operation"),
      key: uuid,
      taskId: uuid,
      reviewId: uuid,
      state: z.enum(["prepared", "recorded", "rejected", "not-recorded"]),
      eventId: uuid.optional(),
      recipientAssignmentId: uuid.optional(),
      resumedLead: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("native-question"),
      key: uuid,
      taskId: uuid,
      interactionId: uuid,
      revision,
      recorded: z.literal(true),
      deliveryState: z.literal("recorded"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      operation: z.enum(["review.view", "delivery.refresh"]),
    })
    .strict(),
  configurationReceiptSchema,
  z
    .object({
      kind: z.literal("domain"),
      key: uuid,
      recorded: z.literal(true),
      result: z.union([
        z
          .object({
            id: uuid,
            projectId: uuid,
            version: revision,
            state: taskState,
            ready: z.boolean(),
          })
          .strict(),
        z
          .object({
            id: uuid,
            taskId: uuid,
            projectId: uuid,
            version: revision,
            profileRevision: revision,
            instructionsRevision: revision,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("coordination"),
      key: uuid,
      recorded: z.literal(true),
      eventId: uuid,
      taskId: uuid,
      recipientAssignmentId: uuid,
      eventType: z.string(),
      createdAt: time,
      resumedLead: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit-review"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      reviewId: uuid,
      operationId: uuid,
      revision,
      materialHash: hash,
      decision: z.enum(["pending", "approved", "denied"]),
      /** What GitHub showed when the draft started, and what the edit would replace it with. */
      current: currentIssueTextSchema,
      proposed: issueTextSchema,
      target: z
        .object({ repositoryId: text, nodeId: text, number: revision })
        .strict(),
      taskVersion: revision,
      sourceId: uuid,
      sourceRevision: revision,
      sourceDigest: hash,
      policyVersion: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("publication-review"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      reviewId: uuid,
      revision,
      materialHash: hash,
      decision: z.enum(["pending", "approved", "denied"]),
      /** The destination, named so the operator confirms where the issue is created. */
      repository: safeText,
      selectionKind: z.enum(["repository", "project", "search"]),
      /** The task text that becomes the issue, exactly as it will be sent. */
      title: z.string().max(issueTitleLimit),
      body: z.string().max(issueBodyLimit),
      labels: z.array(safeText),
      projectFields: publicationProjectFieldsSchema,
      /** Whether the new issue is added to a GitHub Project. */
      addsToProject: z.boolean(),
      predictedSelected: z.boolean(),
      predictedReady: z.boolean(),
      taskVersion: revision,
      policyVersion: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("publication"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      publicationId: uuid,
      state: z.enum(publicationStates),
      issueNumber: revision.nullable(),
      steps: z
        .array(
          z
            .object({
              operationId: uuid,
              kind: z.enum([
                "issue.create",
                "project.item.add",
                "project.field",
              ]),
              state: publicationStepStateSchema,
              /** A failure GitHub allows retrying, with attempts left: the step waits for a retry. */
              retrying: z.boolean(),
              reason: safeText,
            })
            .strict(),
        )
        .max(24),
    })
    .strict(),
  z
    .object({
      kind: z.literal("comment-review"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      reviewId: uuid,
      operationId: uuid,
      revision,
      materialHash: hash,
      decision: z.enum(["pending", "approved", "denied"]),
      body: safeText,
      target: z
        .object({ repositoryId: text, nodeId: text, number: revision })
        .strict(),
      taskVersion: revision,
      sourceId: uuid,
      sourceRevision: revision,
      sourceDigest: hash,
      policyVersion: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delivery-settlement"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      decision: z.enum(["accepted", "closed"]),
      revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("delivery"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      operationId: uuid,
      state: z.enum([
        "prepared",
        "attempting",
        "uncertain",
        "confirmed-success",
        "confirmed-failure",
        "denied",
      ]),
      reason: safeText,
    })
    .strict(),
  z
    .object({
      kind: z.literal("draft-turn"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      leadAssignmentId: uuid,
      workId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-again"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      assignmentId: uuid,
      refusedWorkId: z.string().min(1).max(512),
      workId: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task-reset"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      leadAssignmentId: uuid,
      workId: z.string().min(1).max(512),
      conversations: z.array(
        z.object({ assignmentId: uuid, revision }).strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task-stop"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      /** Active executions asked to stop; cancellation itself is best-effort. */
      cancellationRequested: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task-resume"),
      key: uuid,
      recorded: z.literal(true),
      taskId: uuid,
      /** False when no operator Stop was in effect (a recorded no-op). */
      stopCleared: z.boolean(),
      requeued: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recovery-adoption"),
      key: uuid,
      recorded: z.literal(true),
      path: z.enum(["pre-turn-adopt", "no-turn-adopt"]),
      assignmentId: uuid,
      workId: z.string().min(1).max(512),
      witnessId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recovery-resolution"),
      key: uuid,
      recorded: z.literal(true),
      path: z.enum(["pre-turn-recover", "no-turn-recover"]),
      assignmentId: uuid,
      workId: z.string().min(1).max(512),
      receiptId: uuid,
      state: z.literal("reconciled"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("conversation-replacement"),
      key: uuid,
      recorded: z.literal(true),
      assignmentId: uuid,
      revision,
    })
    .strict(),
]);
export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "unauthenticated",
          "forbidden",
          "not-found",
          "method-not-allowed",
          "invalid-input",
          "unsupported-media",
          "body-too-large",
          "conflict",
          "unavailable",
          "redaction-limit",
          "command-outcome-unknown",
          "local-review-batch-too-large",
          "local-review-recipient-unavailable",
          "local-review-comment-anchor-required",
          "credential-invalid",
          "insufficient-scope",
          "runtime-executable-missing",
          "runtime-confirmation-required",
        ]),
        message: z.string().max(256),
        fieldPaths: z.array(z.string().max(128)).optional(),
        credentialReason: sourceCredentialReasonSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type OperatorCommand = z.infer<typeof operatorCommandSchema>;
/** Exact source passed to `review.anchor.stage`; never a specimen or a later match. */
export type ReviewAnchorCandidate = z.infer<typeof reviewAnchorSelectionSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceComparisonRead = z.infer<
  typeof workspaceComparisonReadSchema
>;
export type TaskRead = z.infer<typeof taskSchema>;
export type Execution = z.infer<typeof executionSchema>;
export type Session = z.infer<typeof sessionSchema>;

const githubSegment = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
/**
 * The Claude subscription token reference: booleans and a closed state only, never the
 * reference name or value. `restart-required`: configured after the service started.
 */
export const claudeTokenStatusSchema = envelope(
  z
    .object({
      configured: z.boolean(),
      available: z.boolean(),
      state: z.enum([
        "not-configured",
        "missing-value",
        "restart-required",
        "available",
      ]),
    })
    .strict(),
);
/**
 * Installation discovery credential: whether a reference is set, its kind and whether it
 * resolves, plus the detected GitHub CLI logins. Never the variable name or a token.
 */
export const discoveryStatusSchema = envelope(
  z
    .object({
      configured: z.boolean(),
      available: z.boolean(),
      source: z.enum(["env", "gh"]).nullable(),
      gh: ghLoginStateSchema,
      /** The login a new project's `gh:github.com` source would use; status only. */
      sourceGh: ghLoginStateSchema,
    })
    .strict(),
);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;
export const discoveryUnavailableReasons = [
  "unconfigured",
  "missing-credential",
  "unauthorized",
  "forbidden",
  "rate-limited",
  "unreadable",
  "gh-not-installed",
  "gh-not-signed-in",
  "gh-unreadable",
] as const;
const discoveryUnavailable = z
  .object({
    state: z.literal("unavailable"),
    reason: z.enum(discoveryUnavailableReasons),
  })
  .strict();
const discoveryRead = <T extends z.ZodRawShape>(shape: T) =>
  envelope(
    z.discriminatedUnion("state", [
      z
        .object({ state: z.literal("ready"), truncated: z.boolean(), ...shape })
        .strict(),
      discoveryUnavailable,
    ]),
  );
/** Why a GitLab credential or discovery read is unavailable; never a message or token. */
export const gitLabCredentialReasons = [
  "missing-credential",
  "glab-not-installed",
  "glab-not-signed-in",
  "glab-unreadable",
  "unauthorized",
  "forbidden",
  "rate-limited",
  "unreadable",
] as const;
const gitLabCredentialBase = {
  codeHost: z.literal("gitlab"),
  host: gitLabHostSchema,
  /** The kind only: an `env:` reference's variable name is never disclosed. */
  kind: z.enum(["glab", "env"]),
  /** A `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` or `OAUTH_TOKEN` shadows a `glab` login. */
  glabOverridden: z.boolean(),
};
/** Installation GitLab credentials: kind, usability and the account, never a name or token. */
export const codeHostCredentialsSchema = envelope(
  z
    .object({
      credentials: z
        .array(
          z.discriminatedUnion("state", [
            z
              .object({
                ...gitLabCredentialBase,
                state: z.literal("usable"),
                account: z.string().min(1).max(255),
              })
              .strict(),
            z
              .object({
                ...gitLabCredentialBase,
                state: z.literal("unavailable"),
                reason: z.enum(gitLabCredentialReasons),
              })
              .strict(),
          ]),
        )
        .max(1000),
    })
    .strict(),
);
/** Why a Jira site's credential is unusable; never a message or secret. */
export const jiraCredentialReasons = [
  "missing-credential",
  "site-invalid",
  "site-mismatch",
  "site-unreachable",
  "not-jira",
  "unauthorized",
] as const;
/** Installation Jira credentials: usability and the account, never a variable name or secret. */
export const issueTrackerCredentialsSchema = envelope(
  z
    .object({
      credentials: z
        .array(
          z
            .object({
              issueTracker: z.literal("jira"),
              instance: jiraInstanceSchema,
              usable: z.boolean(),
              account: z
                .object({
                  accountId: z.string().min(1).max(128),
                  displayName: safeText,
                })
                .strict()
                .nullable(),
              reason: z.enum(jiraCredentialReasons).nullable(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
);
/** Up to 20 issues a JQL query matches, read without saving anything. */
export const jiraPreviewSchema = envelope(
  z
    .object({
      matches: z
        .array(
          z
            .object({
              key: z.string().min(1).max(280),
              title: safeText,
              status: safeText,
            })
            .strict(),
        )
        .max(20),
      more: z.boolean(),
    })
    .strict(),
);
export const gitLabProjectsSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("ready"),
        truncated: z.boolean(),
        projects: z
          .array(
            z
              .object({
                repositoryId: gitLabRepositoryId,
                projectPath: gitLabProjectPathSchema,
                defaultBranch: z.string().min(1).max(255),
              })
              .strict(),
          )
          .max(1000),
      })
      .strict(),
    z
      .object({
        state: z.literal("unavailable"),
        reason: z.enum(["unconfigured", ...gitLabCredentialReasons]),
      })
      .strict(),
  ]),
);
export const discoveredRepositorySchema = z
  .object({
    repositoryId: z.string().min(1).max(512),
    owner: githubSegment,
    name: githubSegment,
    defaultBranch: z.string().min(1).max(255),
  })
  .strict();
export const discoveryRepositoriesSchema = discoveryRead({
  repositories: z.array(discoveredRepositorySchema).max(1000),
});
export const discoveryBranchesSchema = discoveryRead({
  branches: z.array(z.string().min(1).max(255)).max(500),
});
export const discoveryLabelsSchema = discoveryRead({
  labels: z.array(z.string().min(1).max(255)).max(500),
});
const discoveredProjectSchema = z
  .object({
    projectNodeId: z.string().min(1).max(512),
    title: z.string().max(512),
    number: revision,
  })
  .strict();
export const discoveryProjectsSchema = discoveryRead({
  ownerLogin: githubSegment,
  linked: z.array(discoveredProjectSchema).max(100),
  owned: z.array(discoveredProjectSchema).max(100),
});
export const discoveryProjectFieldsSchema = discoveryRead({
  fields: z
    .array(
      z
        .object({
          fieldNodeId: z.string().min(1).max(512),
          name: z.string().max(512),
          options: z
            .array(
              z
                .object({
                  optionNodeId: z.string().min(1).max(512),
                  name: z.string().max(512),
                })
                .strict(),
            )
            .max(500),
        })
        .strict(),
    )
    .max(100),
});
export const folderListRequestSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict();
/**
 * The service's home folder for Add Claude's suggested token path, or null when it is
 * unusable. Session-only: local-path data that no bearer credential may read.
 */
export const setupHomeSchema = envelope(
  z.object({ home: z.string().min(1).max(4096).nullable() }).strict(),
);
export const folderListingSchema = envelope(
  z
    .object({
      /** Home-relative (`~` or `~/…`); never an absolute path. */
      path: z.string().min(1).max(4096),
      parent: z.string().min(1).max(4096).nullable(),
      entries: z
        .array(
          z
            .object({
              name: z.string().min(1).max(255),
              kind: z.enum(["folder", "git"]),
              /** `owner/name` of a `github.com` origin, else null. */
              origin: z.string().max(201).nullable(),
              branch: z.string().max(255).nullable(),
            })
            .strict(),
        )
        .max(200),
      truncated: z.boolean(),
    })
    .strict(),
);
export const repositoryVerificationReasons = [
  "path-invalid",
  "not-checkout",
  "origin-missing",
  "origin-provider",
  "origin-mismatch",
  "ref-unavailable",
  "unreadable",
] as const;
export const checkoutVerifyRequestSchema = z
  .object({
    path: z.string().trim().min(1).max(4096),
    repository: z.discriminatedUnion("codeHost", [
      z
        .object({
          codeHost: z.undefined().optional(),
          owner: githubSegment,
          name: githubSegment,
        })
        .strict(),
      z
        .object({
          codeHost: z.literal("gitlab"),
          host: gitLabHostSchema,
          projectPath: gitLabProjectPathSchema,
        })
        .strict(),
    ]),
    ref: setupRepositorySchema.shape.ref,
  })
  .strict();
export const checkoutVerificationSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("verified"),
        origin: z.string().max(201),
        branch: z.string().max(255).nullable(),
      })
      .strict(),
    z
      .object({
        state: z.literal("rejected"),
        reason: z.enum(repositoryVerificationReasons),
        origin: z.string().max(201).nullable(),
      })
      .strict(),
  ]),
);
export type DiscoveryUnavailableReason =
  (typeof discoveryUnavailableReasons)[number];
export type RepositoryVerificationReason =
  (typeof repositoryVerificationReasons)[number];
export type FolderListing = z.infer<typeof folderListingSchema>;
export type CheckoutVerification = z.infer<typeof checkoutVerificationSchema>;

export const operatorCredentialScopeSchema = z.enum(["read", "read-write"]);
export const operatorCredentialNameSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
export const operatorCredentialSchema = z
  .object({
    id: uuid,
    name: operatorCredentialNameSchema,
    scope: operatorCredentialScopeSchema,
    createdAt: time,
    expiresAt: time,
    lastUsedAt: time.nullable(),
    revokedAt: time.nullable(),
    replacesId: uuid.nullable(),
    state: z.enum(["active", "expired", "revoked"]),
  })
  .strict();
export type OperatorCredential = z.infer<typeof operatorCredentialSchema>;
export const operatorCredentialListSchema = envelope(
  z
    .object({ credentials: z.array(operatorCredentialSchema).max(1000) })
    .strict(),
);
export const operatorCredentialIssueRequestSchema = z
  .object({
    name: operatorCredentialNameSchema,
    scope: operatorCredentialScopeSchema,
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();
/** Capture groups: credential id, secret. */
export const OPERATOR_CREDENTIAL_TOKEN_PATTERN =
  /^ens_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;
export const operatorCredentialTokenSchema = z
  .string()
  .regex(OPERATOR_CREDENTIAL_TOKEN_PATTERN);
export const operatorCredentialIssuedSchema = z
  .object({
    credential: operatorCredentialSchema,
    token: operatorCredentialTokenSchema,
  })
  .strict();
/** Push subscription label: 1 to 64 characters, no control characters. */
export const pushSubscriptionLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\p{Cc}\u2028\u2029]/u.test(value));
/** The browser's PushSubscription JSON. Hosts, key lengths and curve points are checked server-side. */
export const pushSubscribeRequestSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    keys: z
      .object({
        p256dh: z.string().min(1).max(128),
        auth: z.string().min(1).max(64),
      })
      .strict(),
    label: pushSubscriptionLabelSchema,
  })
  .strict();
export const pushRevokedReasonSchema = z.enum([
  "operator",
  "gone",
  "key-changed",
]);
export const pushFailureSchema = z.enum(["rejected", "unavailable", "timeout"]);
/** Metadata only: never the endpoint, p256dh or auth. */
export const pushSubscriptionSchema = z
  .object({
    id: uuid,
    label: pushSubscriptionLabelSchema,
    serviceHost: z.string().min(1).max(253),
    endpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: time,
    lastSuccessAt: time.nullable(),
    lastFailure: pushFailureSchema.nullable(),
    state: z.enum(["active", "revoked"]),
    revokedAt: time.nullable(),
    revokedReason: pushRevokedReasonSchema.nullable(),
  })
  .strict();
export type PushSubscriptionRecord = z.infer<typeof pushSubscriptionSchema>;
export const pushNotificationsReadSchema = envelope(
  z
    .object({
      available: z.boolean(),
      publicKey: z
        .string()
        .regex(/^[A-Za-z0-9_-]{87}$/)
        .nullable(),
      subscriptions: z.array(pushSubscriptionSchema).max(100),
    })
    .strict(),
);
export const pushSubscriptionResultSchema = z
  .object({ subscription: pushSubscriptionSchema })
  .strict();
export const pushTestOutcomeSchema = z.enum([
  "sent",
  "gone",
  "rejected",
  "unavailable",
  "timeout",
]);
export const pushTestResultSchema = z
  .object({ outcome: pushTestOutcomeSchema })
  .strict();
export const cliIdentitySchema = z
  .object({
    apiVersion: z.number().int().positive().safe(),
    capabilities: z.array(z.string().max(64)).max(64),
    service: z
      .object({ installationId: uuid, origin: z.string().max(2048) })
      .strict(),
    credential: z
      .object({
        id: uuid,
        name: operatorCredentialNameSchema,
        scope: operatorCredentialScopeSchema,
        createdAt: time,
        expiresAt: time,
      })
      .strict(),
  })
  .strict();
export type CliIdentity = z.infer<typeof cliIdentitySchema>;
/** Capability families the CLI bearer API serves, in negotiation order. */
export const cliCapabilities = [
  "cli.identity",
  "task.read",
  "workspace.read",
  "task.list",
  "task.search",
  "task.records",
  "assignment.read",
  "instructions.read",
  "result.read",
  "artifact.read",
  "configuration.write",
  "operation.read",
  "capacity.read",
  "configuration.impact",
  "execution.read",
  "diagnostics.read",
  "task.write",
  "attention.read",
  "attention.write",
  "source.write",
  "delivery.write",
  "recovery.read",
  "recovery.write",
] as const;
/** Assignments a profile or project change would affect, observed at read time. */
export const configurationImpactSchema = envelope(
  z
    .object({
      target: z
        .object({ kind: z.enum(["project", "profile"]), id: uuid })
        .strict(),
      assignments: z
        .array(
          z
            .object({
              assignmentId: uuid,
              taskId: uuid,
              projectId: uuid,
              profileId: uuid,
              state: z.enum(["pending", "running", "completed", "held"]),
              lead: z.boolean(),
              bound: z
                .object({
                  profileRevision: revision,
                  instructionsRevision: revision,
                })
                .strict(),
              current: z
                .object({
                  profileRevision: revision,
                  instructionsRevision: revision,
                })
                .strict(),
              stale: z
                .object({ profile: z.boolean(), instructions: z.boolean() })
                .strict(),
            })
            .strict(),
        )
        .max(200),
      total: z.number().int().nonnegative().safe(),
      truncated: z.boolean(),
      limit: z.number().int().min(1).max(200),
    })
    .strict(),
);
/** Commands whose receipts `GET /api/operator/operations` reads back. */
export const operationTypeSchema = z.enum([
  "profile.create",
  "profile.configure",
  "project.create",
  "project.configure",
  "routing.configure",
  "capacity.configure",
  "runtime.configure",
  "assignment.apply",
  "github.configure",
  "jira.configure",
  "repositories.configure",
  "status-mapping.configure",
  "github.preview",
  "recovery.pre-turn.adopt",
  "recovery.pre-turn.recover",
  "recovery.no-turn.adopt",
  "recovery.no-turn.recover",
  "recovery.conversation.replace",
]);
/** `project:<id>`, `profile:<id>`, `assignment:<id>`, `system:capacity` or `system:runtime:<harness>`; nothing else is a readable scope. */
export const operationScopeSchema = z
  .string()
  .regex(
    /^(?:(?:project|profile|assignment):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|system:capacity|system:runtime:(?:codex|claude))$/i,
  );
export const operationReadSchema = envelope(
  z.discriminatedUnion("state", [
    z
      .object({ state: z.literal("recorded"), receipt: commandReceiptSchema })
      .strict(),
    z.object({ state: z.literal("not-recorded") }).strict(),
  ]),
);
/** Instruction views are reconstructed from retained revisions, never a captured prompt. */
const instructionProvenanceSchema = z
  .object({
    source: z.literal("retained-revision-records"),
    reconstructed: z.literal(true),
    submittedPrompt: z.literal("not-captured"),
  })
  .strict();
export const instructionProvenance = {
  source: "retained-revision-records",
  reconstructed: true,
  submittedPrompt: "not-captured",
} as const;
export const instructionBodySchema = z
  .object({
    revision,
    state: z.enum(["available", "omitted"]),
    reason: z.literal("redaction-unavailable").nullable(),
    text: text.nullable(),
    redacted: z.boolean(),
  })
  .strict();
const profileInstructionBodySchema = instructionBodySchema
  .extend({
    name: safeText,
    capabilities: safeText,
    revoked: z.boolean(),
    runtime: profileRuntimeSchema,
  })
  .strict();
const instructionRevisionListSchema = z
  .array(
    z
      .object({ revision, current: z.boolean(), instructionChars: time })
      .strict(),
  )
  .max(128);
export const profileInstructionsSchema = envelope(
  z
    .object({
      summary: profileSummarySchema,
      currentRevision: revision,
      revisions: instructionRevisionListSchema,
      selected: profileInstructionBodySchema,
      provenance: instructionProvenanceSchema,
    })
    .strict(),
);
export const projectInstructionsSchema = envelope(
  z
    .object({
      summary: projectSummarySchema,
      currentRevision: revision,
      revisions: instructionRevisionListSchema,
      selected: instructionBodySchema,
      provenance: instructionProvenanceSchema,
    })
    .strict(),
);
const instructionPairSchema = z
  .object({
    profile: profileInstructionBodySchema,
    project: instructionBodySchema,
  })
  .strict();
const instructionComparisonSchema = z
  .object({ sameRevision: z.boolean(), sameContent: z.boolean().nullable() })
  .strict();
export const assignmentInstructionsSchema = envelope(
  z
    .object({
      assignmentId: uuid,
      taskId: uuid,
      projectId: uuid,
      profileId: uuid,
      bound: instructionPairSchema,
      current: instructionPairSchema,
      comparison: z
        .object({
          profile: instructionComparisonSchema,
          project: instructionComparisonSchema,
          boundIsCurrent: z.boolean(),
        })
        .strict(),
      execution: z
        .object({
          workId: z.string().min(1),
          requestSequence: revision,
          profileRevision: revision,
          instructionsRevision: revision,
          matchesBound: z.boolean(),
        })
        .strict()
        .nullable(),
      provenance: instructionProvenanceSchema,
    })
    .strict(),
);
export const assignmentDetailSchema = envelope(
  assignmentSchema
    .extend({
      taskId: uuid,
      projectId: uuid,
      taskVersion: revision,
      lead: z.boolean(),
      execution: executionSchema,
    })
    .strict(),
);
/** Work ids are opaque service identifiers, never paths. */
export const workIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);
const diagnosticGapCodeSchema = z.enum([
  "capture-baseline",
  "capture-failed",
  "capture-interrupted",
  "input-failed",
  "size-limit",
  "redaction-unavailable",
  "execution-limit",
  "item-limit",
  "expired",
  "evicted",
  "late-event",
  "early-buffer-limit",
  "unsupported-event",
]);
const diagnosticGapSchema = z
  .object({
    code: diagnosticGapCodeSchema,
    count: z.number().int().nonnegative().safe(),
    bytes: z.number().int().nonnegative().safe(),
    firstAt: time,
    lastAt: time,
  })
  .strict();
/** `captured` (enhanced), `baseline`, or `not-captured` (no capture row). */
const captureStateSchema = z.enum(["captured", "baseline", "not-captured"]);
const executionSummarySchema = z
  .object({
    workId: workIdSchema,
    requestSequence: z.number().int().positive().safe(),
    taskId: uuid,
    projectId: uuid,
    assignmentId: uuid,
    state: z.enum(["queued", "active", "completed", "held"]),
    reason: safeText,
    capture: captureStateSchema,
    threadId: safeText,
    turnId: safeText,
    startedAt: time.nullable(),
    finishedAt: time.nullable(),
  })
  .strict();
export const executionListSchema = envelope(
  z
    .object({
      executions: z.array(executionSummarySchema).max(200),
      /** Pass as `before` for the next older page; null on the last page. */
      nextBefore: z.number().int().positive().safe().nullable(),
    })
    .strict(),
);
const settingEntrySchema = z
  .object({
    name: z.string().max(64),
    value: z.union([z.string().max(1024), z.null()]),
    source: z.enum(["service-admitted", "runtime-reported", "unknown"]),
  })
  .strict();
/** Capture coverage facts; observation is never claimed complete. */
const captureHealthSchema = z
  .object({
    mode: z.enum(["enhanced", "baseline"]).nullable(),
    eventSource: z.enum(["supported", "unsupported"]).nullable(),
    toolObservation: z.literal("incomplete"),
    reasoning: z.literal("not-collected"),
    gaps: z.array(diagnosticGapSchema),
    unrecorded: z.number().int().nonnegative().safe(),
  })
  .strict();
export const executionDetailSchema = envelope(
  z
    .object({
      execution: executionSummarySchema,
      identity: z
        .object({
          assignmentVersion: revision,
          instructionsRevision: revision,
          profileRevision: revision,
          conversationRevision: z.number().int().nonnegative().safe(),
          harness: executionHarnessSchema,
        })
        .strict()
        .nullable(),
      settings: z.array(settingEntrySchema).nullable(),
      counts: z
        .object({
          items: z.number().int().nonnegative().safe(),
          payloadBytes: z.number().int().nonnegative().safe(),
        })
        .strict(),
      health: captureHealthSchema,
    })
    .strict(),
);
const inputSegmentSchema = z
  .object({
    name: z.enum([
      "request",
      "role",
      "review-references",
      "project-instructions",
      "profile-instructions",
    ]),
    revision: revision.nullable(),
    /** False: the thread already held this revision, so the turn did not carry it. */
    sent: z.boolean(),
    state: z.enum(["available", "omitted"]),
    reason: diagnosticGapCodeSchema.nullable(),
    /** Up to 64 KiB captured; redaction markers can lengthen it. */
    text: z.string().max(140000).nullable(),
    redacted: z.boolean(),
  })
  .strict();
export const executionInputsSchema = envelope(
  z
    .object({
      workId: workIdSchema,
      capture: captureStateSchema,
      /** cab-supplied inputs as submitted; never the runtime's effective prompt. */
      provenance: z
        .object({
          source: z.enum(["captured-submission", "not-captured"]),
          effectivePrompt: z.literal("not-captured"),
        })
        .strict(),
      segments: z.array(inputSegmentSchema).max(8),
      submitted: z
        .object({ bytes: z.number().int().nonnegative().safe(), sha256: hash })
        .strict()
        .nullable(),
      /** Only when no instruction segment was captured: retained revisions instead. */
      reconstructed: z
        .object({
          provenance: instructionProvenanceSchema,
          profile: instructionBodySchema,
          project: instructionBodySchema,
        })
        .strict()
        .nullable(),
      comparison: z
        .object({
          instructions: z.array(
            z
              .object({
                name: z.enum(["project-instructions", "profile-instructions"]),
                boundRevision: revision,
                currentRevision: revision,
                sameRevision: z.boolean(),
                sameContent: z.boolean().nullable(),
              })
              .strict(),
          ),
          settings: z.array(
            z
              .object({
                name: z.string().max(64),
                captured: z.union([z.string().max(1024), z.null()]),
                current: z.union([z.string().max(1024), z.null()]),
                same: z.boolean().nullable(),
              })
              .strict(),
          ),
        })
        .strict()
        .nullable(),
    })
    .strict(),
);
const diagnosticItemSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    kind: z.enum(["input", "setting", "runtime", "tool", "service"]),
    name: z.string().max(256),
    severity: z.enum(["info", "warn", "error"]),
    itemId: z.string().max(256).nullable(),
    state: z.enum(["available", "omitted"]),
    reason: diagnosticGapCodeSchema.nullable(),
    payload: z.unknown(),
    redacted: z.boolean(),
    createdAt: time,
  })
  .strict();
export const executionEventsSchema = envelope(
  z
    .object({
      workId: workIdSchema,
      capture: captureStateSchema,
      items: z.array(diagnosticItemSchema).max(200),
      /** Expired or evicted ranges after the cursor, plus other capture gaps. */
      gaps: z.array(
        diagnosticGapSchema.extend({
          maxPrunedSequence: z.number().int().nonnegative().safe(),
        }),
      ),
      /** The last returned sequence, or the request cursor when nothing was returned. */
      resumeAfter: z.number().int().nonnegative().safe(),
      more: z.boolean(),
      finished: z.boolean(),
      health: captureHealthSchema,
    })
    .strict(),
);
