import { DomainConflictError } from "../core/domain.js";
import { createHash, randomUUID } from "node:crypto";
import { relative } from "node:path";
import { materialDigest } from "../core/delivery.js";
import type { RetainedReviewAnchorCandidate } from "../core/retained-evidence.js";
import { reviewAnchorSelectionSchema } from "../core/review-anchor-contracts.js";
import { isDisclosable } from "./conversation-history.js";
import type {
  WorkspaceComparisonEntry,
  WorkspaceComparisonExport,
  WorkspaceComparisonSideContent,
} from "./workspace-comparison.js";
import {
  previewWorkspaceFile,
  workspaceInspectionPathExcluded,
  type WorkspaceInspectionCurrent,
  type WorkspaceInspectionScope,
} from "./workspace-inspection.js";
import type { TaskWorkspaceBinding } from "./workspaces.js";
import { z } from "zod";

export const retainedReviewAnchorStageRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    operationId: z.string().uuid(),
    anchors: z.array(reviewAnchorSelectionSchema).max(32),
  })
  .strict()
  .superRefine((request, ctx) => {
    for (const [index, anchor] of request.anchors.entries())
      if (anchor.taskId !== request.taskId)
        ctx.addIssue({
          code: "custom",
          path: ["anchors", index, "taskId"],
          message: "anchor-task-mismatch",
        });
  });
export type RetainedReviewAnchorSelection = z.infer<
  typeof reviewAnchorSelectionSchema
>;
export type RetainedReviewAnchorStageRequest = z.infer<
  typeof retainedReviewAnchorStageRequestSchema
>;

export interface CaptureRetainedReviewAnchorInput {
  selection: RetainedReviewAnchorSelection;
  identity: { taskId: string; captureTaskVersion: number };
  currentWorkspace: () => Promise<WorkspaceInspectionCurrent>;
  currentPolicy: () => Promise<RetainedEvidenceCapturePolicy | undefined>;
  exportComparison: (
    comparisonId: string,
  ) => WorkspaceComparisonExport | undefined;
  comparisonOwner: (comparisonId: string) => string | undefined;
  /** The work that recorded a result of this task, or undefined when the task has no such result. */
  resultWorkId: (resultId: string) => string | undefined;
}

export interface RetainedEvidenceCapturePolicy {
  taskVersion: number;
  fingerprint: string;
  excluded: readonly string[];
  authorizedRepositoryIds: readonly string[];
}

const validRelativePath = (path: string): string[] | undefined => {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\\")
  )
    return undefined;
  const segments = path.split("/");
  if (
    segments.length > 32 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /\p{Cc}/u.test(segment) ||
        Buffer.from(segment, "utf8").toString("utf8") !== segment,
    ) ||
    Buffer.byteLength(path, "utf8") > 2048
  )
    return undefined;
  return segments;
};

const lineCount = (text: string) => {
  if (!text) return 0;
  let lines = 0;
  for (const character of text) if (character === "\n") lines++;
  return text.endsWith("\n") ? lines : lines + 1;
};

export function retainedReviewAnchorMaterialHash(
  request: RetainedReviewAnchorStageRequest,
): string {
  return materialDigest(request);
}

function anchorLineRange(
  bytes: Buffer,
  startLine: number,
  endLine: number,
): { bytes: Buffer; byteStart: number; byteEnd: number } | undefined {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return undefined;
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a) {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < bytes.length) ranges.push({ start, end: bytes.length });
  if (endLine > ranges.length) return undefined;
  const byteStart = ranges[startLine - 1]?.start;
  const byteEnd = ranges[endLine - 1]?.end;
  if (byteStart === undefined || byteEnd === undefined) return undefined;
  return {
    bytes: Buffer.from(bytes.subarray(byteStart, byteEnd)),
    byteStart,
    byteEnd,
  };
}

const anchorReasonForPreview = (state: string): "missing" | "unavailable" =>
  state === "missing" ? "missing" : "unavailable";

const anchorBase = (selection: RetainedReviewAnchorSelection) => ({
  anchorId: randomUUID(),
  taskId: selection.taskId,
  repositoryId: selection.repositoryId,
  path: selection.path,
  sourceKind: selection.sourceKind,
  context: selection.context,
  ...(selection.comparisonId ? { comparisonId: selection.comparisonId } : {}),
  ...(selection.resultId ? { resultId: selection.resultId } : {}),
  ...(selection.workId ? { workId: selection.workId } : {}),
  ...(selection.threadId ? { threadId: selection.threadId } : {}),
  ...(selection.turnId ? { turnId: selection.turnId } : {}),
  side: selection.side,
  startLine: selection.startLine,
  endLine: selection.endLine,
});

function gapReviewAnchorCandidate(
  selection: RetainedReviewAnchorSelection,
  reason: NonNullable<RetainedReviewAnchorCandidate["reason"]>,
  observedAt: number | null,
  capturedAt = Date.now(),
): RetainedReviewAnchorCandidate {
  return {
    ...anchorBase(selection),
    claimedSha256: selection.contentSha256,
    state: "gap",
    reason,
    size: 0,
    capturedAt,
    observedAt,
  };
}

function availableReviewAnchorCandidate(
  selection: RetainedReviewAnchorSelection,
  sourceBytes: Buffer,
  mime: string,
  observedAt: number,
  originRoot: string,
): RetainedReviewAnchorCandidate {
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceSha256 !== selection.contentSha256)
    throw new DomainConflictError("Review anchor content changed");
  const selected = anchorLineRange(
    sourceBytes,
    selection.startLine,
    selection.endLine,
  );
  if (!selected)
    throw new DomainConflictError("Review anchor range is invalid");
  const excerptSha256 = createHash("sha256")
    .update(selected.bytes)
    .digest("hex");
  return {
    ...anchorBase(selection),
    originRoot,
    sourceSha256,
    excerptSha256,
    byteStart: selected.byteStart,
    byteEnd: selected.byteEnd,
    mime,
    state: "available",
    size: selected.bytes.byteLength,
    capturedAt: Date.now(),
    observedAt,
    bytes: new Uint8Array(selected.bytes),
  };
}

function anchorOriginRoot(
  binding: TaskWorkspaceBinding,
  repositoryId: string | null,
): string {
  if (!repositoryId) return binding.path;
  const root = binding.repositories.find(
    (repository) => repository.repositoryId === repositoryId,
  )?.workspacePath;
  if (!root)
    throw new DomainConflictError("Review anchor repository binding mismatch");
  return root;
}

function validateOptionalResultBinding(
  selection: RetainedReviewAnchorSelection,
  resultWorkId: CaptureRetainedReviewAnchorInput["resultWorkId"],
) {
  if (!selection.resultId) return;
  const workId = resultWorkId(selection.resultId);
  if (workId === undefined || workId !== selection.workId)
    throw new DomainConflictError("Review anchor result binding mismatch");
}

export async function captureRetainedReviewAnchor(
  input: CaptureRetainedReviewAnchorInput,
): Promise<RetainedReviewAnchorCandidate> {
  const selection = reviewAnchorSelectionSchema.parse(input.selection);
  if (selection.taskId !== input.identity.taskId)
    throw new DomainConflictError("Review anchor task binding mismatch");
  const capturedAt = Date.now();
  const policy = await input.currentPolicy();
  if (!policy)
    throw new DomainConflictError("Review anchor policy is unavailable");
  if (policy.taskVersion !== input.identity.captureTaskVersion)
    throw new DomainConflictError("Review anchor task version changed");
  if (
    (selection.repositoryId &&
      !policy.authorizedRepositoryIds.includes(selection.repositoryId)) ||
    !isDisclosable(selection.path, policy.excluded)
  )
    throw new DomainConflictError("Review anchor path is excluded");

  if (selection.sourceKind === "workspace-file") {
    const workspace = await input.currentWorkspace();
    if (
      workspace.taskVersion !== input.identity.captureTaskVersion ||
      policy.taskVersion !== input.identity.captureTaskVersion ||
      workspace.binding?.state !== "ready"
    )
      return gapReviewAnchorCandidate(
        selection,
        "unavailable",
        null,
        capturedAt,
      );
    const segments = validRelativePath(selection.path);
    if (!segments) throw new Error("Unsafe review anchor path");
    let scope: WorkspaceInspectionScope;
    const previewPath = segments;
    if (selection.repositoryId) {
      scope = { kind: "repository", repositoryId: selection.repositoryId };
    } else {
      scope = { kind: "workspace" };
      const repository = workspace.binding.repositories.find((item) => {
        const mount = relative(
          workspace.binding?.path ?? "",
          item.workspacePath,
        );
        return (
          mount &&
          !mount.startsWith("../") &&
          mount !== ".." &&
          !mount.includes("/") &&
          segments[0] === mount
        );
      });
      if (repository)
        throw new Error("Workspace anchor path must use repository identity");
    }
    if (
      await workspaceInspectionPathExcluded(
        selection.taskId,
        scope,
        previewPath,
        input.currentWorkspace,
      )
    )
      throw new DomainConflictError("Review anchor path is excluded");
    const preview = await previewWorkspaceFile(
      { taskId: selection.taskId, scope, path: previewPath, showIgnored: true },
      input.currentWorkspace,
    );
    if (preview.state !== "ready" || preview.preview?.kind !== "text")
      return gapReviewAnchorCandidate(
        selection,
        anchorReasonForPreview(preview.state),
        preview.observedAt,
        capturedAt,
      );
    const sourceBytes = Buffer.from(preview.preview.text, "utf8");
    if (
      preview.preview.size !== sourceBytes.byteLength ||
      createHash("sha256").update(sourceBytes).digest("hex") !==
        preview.preview.sha256
    )
      throw new DomainConflictError(
        "Review anchor file observation is inconsistent",
      );
    validateOptionalResultBinding(selection, input.resultWorkId);
    const latestPolicy = await input.currentPolicy();
    const latestWorkspace = await input.currentWorkspace();
    if (
      !latestPolicy ||
      latestPolicy.taskVersion !== input.identity.captureTaskVersion ||
      latestPolicy.fingerprint !== policy.fingerprint ||
      latestWorkspace.taskVersion !== workspace.taskVersion ||
      latestWorkspace.visibility !== workspace.visibility
    )
      throw new DomainConflictError(
        "Review anchor binding changed during capture",
      );
    return availableReviewAnchorCandidate(
      selection,
      sourceBytes,
      preview.preview.mime,
      preview.observedAt,
      anchorOriginRoot(workspace.binding, selection.repositoryId),
    );
  }

  const exported = input.exportComparison(selection.comparisonId as string);
  if (!exported) {
    const owner = input.comparisonOwner(selection.comparisonId as string);
    if (owner && owner !== selection.taskId)
      throw new DomainConflictError(
        "Review anchor comparison identity mismatch",
      );
    return gapReviewAnchorCandidate(
      selection,
      "comparison-unavailable",
      null,
      capturedAt,
    );
  }
  const comparison = exported.comparison;
  if (
    comparison.taskId !== selection.taskId ||
    comparison.comparisonId !== selection.comparisonId
  )
    throw new DomainConflictError("Review anchor comparison identity mismatch");
  if (comparison.target !== selection.context)
    throw new DomainConflictError("Review anchor comparison context mismatch");
  if (
    (selection.context === "turn" &&
      (exported.captureState !== "finished" ||
        comparison.target !== "turn" ||
        comparison.state !== "available" ||
        comparison.outcome !== "completed")) ||
    (selection.context !== "turn" && comparison.state !== "available")
  )
    return gapReviewAnchorCandidate(
      selection,
      exported.captureState === "pending" ||
        exported.captureState === "unsettled"
        ? "comparison-unsettled"
        : "comparison-unavailable",
      comparison.observedAt,
      capturedAt,
    );
  if (selection.context === "turn") {
    if (
      comparison.target !== "turn" ||
      comparison.workId !== selection.workId ||
      comparison.threadId !== selection.threadId ||
      comparison.turnId !== selection.turnId
    )
      throw new DomainConflictError("Review anchor turn identity mismatch");
  }

  const entryMatches = comparison.entries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => {
      const expectedPath =
        selection.side === "left"
          ? (entry.previousPath ?? entry.path)
          : entry.path;
      const expectedRepository =
        comparison.target === "turn"
          ? (entry.repositoryId ?? null)
          : comparison.repositoryId;
      return (
        expectedPath === selection.path &&
        expectedRepository === selection.repositoryId
      );
    });
  if (entryMatches.length !== 1)
    throw new DomainConflictError("Review anchor comparison source mismatch");
  const { entry, entryIndex } = entryMatches[0] as {
    entry: WorkspaceComparisonEntry;
    entryIndex: number;
  };
  const currentWorkspace = await input.currentWorkspace();
  if (
    currentWorkspace.taskVersion !== input.identity.captureTaskVersion ||
    policy.taskVersion !== input.identity.captureTaskVersion ||
    currentWorkspace.binding?.state !== "ready"
  )
    return gapReviewAnchorCandidate(
      selection,
      "unavailable",
      comparison.observedAt,
      capturedAt,
    );
  const entryPaths = [
    entry.path,
    ...(entry.previousPath ? [entry.previousPath] : []),
  ];
  for (const path of entryPaths) {
    const segments = validRelativePath(path);
    if (!segments) throw new Error("Unsafe review comparison path");
    if (
      await workspaceInspectionPathExcluded(
        selection.taskId,
        selection.repositoryId
          ? { kind: "repository", repositoryId: selection.repositoryId }
          : { kind: "workspace" },
        segments,
        input.currentWorkspace,
      )
    )
      throw new Error("Review comparison path is excluded");
  }
  const side = sideMap(exported.sides).get(entryIndex);
  const sideText = exactSideText(
    entry,
    selection.side as "left" | "right",
    side,
  );
  const metadata = entry[selection.side as "left" | "right"];
  if (
    entry.state !== "text" ||
    !sideText ||
    !metadata ||
    metadata.sha256 !== selection.contentSha256 ||
    metadata.lineCount !== lineCount(sideText)
  )
    throw new DomainConflictError("Review anchor side or range is invalid");
  validateOptionalResultBinding(selection, input.resultWorkId);
  const latestPolicy = await input.currentPolicy();
  const latestWorkspace = await input.currentWorkspace();
  if (
    !latestPolicy ||
    latestPolicy.taskVersion !== input.identity.captureTaskVersion ||
    latestPolicy.fingerprint !== policy.fingerprint ||
    latestWorkspace.taskVersion !== currentWorkspace.taskVersion ||
    latestWorkspace.visibility !== currentWorkspace.visibility
  )
    throw new DomainConflictError(
      "Review anchor binding changed during capture",
    );
  const bytes = Buffer.from(sideText, "utf8");
  return availableReviewAnchorCandidate(
    selection,
    bytes,
    "text/plain; charset=utf-8",
    comparison.observedAt,
    anchorOriginRoot(currentWorkspace.binding, selection.repositoryId),
  );
}

const sideMap = (sides: readonly WorkspaceComparisonSideContent[]) =>
  new Map(sides.map((side) => [side.entryIndex, side]));

function exactSideText(
  entry: WorkspaceComparisonEntry,
  side: "left" | "right",
  content: WorkspaceComparisonSideContent | undefined,
): string | undefined {
  const metadata = entry[side];
  if (!metadata) return undefined;
  const text = side === "left" ? content?.leftText : content?.rightText;
  if (
    text === undefined ||
    !metadata.sha256 ||
    metadata.size !== Buffer.byteLength(text, "utf8") ||
    createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex") !==
      metadata.sha256 ||
    metadata.lineCount !== lineCount(text)
  )
    return undefined;
  return text;
}
