import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  boundDetail,
  type DiagnosticExecution,
  type DiagnosticItem,
} from "./execution-diagnostics.js";
import {
  maxToolPathChars,
  maxToolPaths,
  maxToolTargetChars,
  outsideWorkspace,
} from "../operator/tool-limits.js";
import { isCoordinationTool } from "./tool-activity.js";
import {
  compareTimelineKeys,
  serializeTimelineKey,
  type TimelineKey,
} from "../operator/timeline-key.js";

/** One entry before its common fields are added: where it sorts and what it says. */
export interface TimelineCandidate {
  key: TimelineKey;
  /** The conversation the entry belongs to; null only for a task-scoped comment. */
  assignmentId: string | null;
  precision: "ms" | "s";
  body: { kind: string } & Record<string, unknown>;
}

/**
 * The only diagnostic item types that reach the timeline, and how each is shown.
 * Reasoning, plans, messages and cab's own coordination tool calls are absent on
 * purpose: those are represented by their own records or not shown at all.
 */
const toolKinds = {
  commandExecution: "command",
  fileChange: "file-change",
  mcpToolCall: "other",
  webSearch: "other",
  toolCall: "other",
} as const;

/** The stored row names (`<itemType>/<phase>`) the tool projection reads. */
export const toolRowNames = Object.keys(toolKinds).flatMap((type) => [
  `${type}/started`,
  `${type}/completed`,
]);

const maxCommandChars = 512;
const maxLabelChars = 128;
const maxStatusChars = 64;

/** A stored path is relative; anything absolute or escaping reads as masked. */
function safePath(path: string): string {
  return isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    path.startsWith("..\\")
    ? outsideWorkspace
    : path;
}

const observedPayload = z.object({
  observedAt: z.number().int().nonnegative(),
});

const toolPayload = z
  .object({
    itemType: z.string(),
    status: z.string().optional(),
    tool: z.string().optional(),
    command: z
      .union([z.string(), z.object({ omitted: z.literal("size-limit") })])
      .optional(),
    exitCode: z.number().int().nullable().optional(),
    // Each field falls back alone, so one bad value never gaps the row.
    paths: z.array(z.string()).optional().catch(undefined),
    pathsTruncated: z.boolean().optional().catch(undefined),
    target: z.string().optional().catch(undefined),
  })
  .loose();

export type ToolProjection =
  | {
      kind: "tool";
      tool: "command" | "file-change" | "other";
      label: string | null;
      status: string | null;
      command: string | null;
      truncated: boolean;
      exitCode: number | null;
      /** The completed row whose output can be fetched, for a command. */
      outputSequence: number | null;
      /** When the newest completed row was observed; null while unfinished. */
      endedAt: number | null;
      /** Changed files, repository-relative; empty when none were captured. */
      paths: string[];
      pathsTruncated: boolean;
      /** The allowlisted target (path, pattern, query, `server/tool`, subagent type). */
      target: string | null;
    }
  | { kind: "gap"; reason: "size-limit" | "redaction-unavailable" };

/**
 * One tool item as the curated projection. The newest completed row, else the first,
 * supplies the content; it is sanitised again with the current exclusions, and
 * anything omitted, oversized or unredactable becomes a gap, never text.
 */
export function projectTool(
  first: DiagnosticItem,
  last: DiagnosticItem | undefined,
  excluded: readonly string[] | undefined,
): ToolProjection {
  const row = last ?? first;
  if (row.state === "omitted")
    return {
      kind: "gap",
      reason:
        row.reason === "redaction-unavailable"
          ? "redaction-unavailable"
          : "size-limit",
    };
  // Pick the few fields first so nothing else is processed, let alone returned.
  const raw = toolPayload.safeParse(row.payload);
  const picked = raw.success
    ? {
        itemType: raw.data.itemType,
        status: raw.data.status,
        tool: raw.data.tool,
        command: raw.data.command,
        exitCode: raw.data.exitCode,
        paths: raw.data.paths,
        pathsTruncated: raw.data.pathsTruncated,
        target: raw.data.target,
      }
    : undefined;
  const bounded = boundDetail(picked, excluded);
  const payload = toolPayload.safeParse(bounded);
  if (!payload.success) return { kind: "gap", reason: "redaction-unavailable" };
  const data = payload.data;
  const tool = toolKinds[data.itemType as keyof typeof toolKinds];
  if (tool === undefined)
    return { kind: "gap", reason: "redaction-unavailable" };
  if (typeof data.command === "object")
    return { kind: "gap", reason: "size-limit" };
  // Collapse first, then redact again: collapsing must not assemble an excluded value.
  const collapsed =
    tool === "command" && data.command !== undefined
      ? boundDetail(data.command.replace(/\s+/g, " ").trim(), excluded)
      : null;
  if (collapsed === undefined)
    return { kind: "gap", reason: "redaction-unavailable" };
  const command = typeof collapsed === "string" ? collapsed : null;
  const label = data.tool ?? data.itemType;
  const listed = (data.paths ?? []).slice(0, maxToolPaths);
  const capped = listed
    .filter((path) => path.length <= maxToolPathChars)
    .map(safePath);
  // A file path target is re-checked; a pattern or query may legitimately start with "/".
  const shown =
    tool === "file-change" || label === "Read"
      ? data.target === undefined
        ? undefined
        : safePath(data.target)
      : data.target;
  const target =
    shown !== undefined && !isCoordinationTool(label)
      ? shown.length > maxToolTargetChars
        ? `${shown.slice(0, maxToolTargetChars - 1)}…`
        : shown
      : null;
  const completedAt = observedPayload.safeParse(last?.payload);
  return {
    kind: "tool",
    tool,
    label: tool === "other" && label.length <= maxLabelChars ? label : null,
    status:
      data.status !== undefined && data.status.length <= maxStatusChars
        ? data.status
        : null,
    command: command === null ? null : command.slice(0, maxCommandChars),
    truncated: command !== null && command.length > maxCommandChars,
    exitCode: tool === "command" ? (data.exitCode ?? null) : null,
    outputSequence:
      tool === "command" && last !== undefined && last.state === "available"
        ? last.sequence
        : null,
    endedAt: completedAt.success ? completedAt.data.observedAt : null,
    paths: [...new Set(capped)],
    pathsTruncated:
      data.pathsTruncated === true ||
      listed.length < (data.paths?.length ?? 0) ||
      capped.length < listed.length,
    target,
  };
}

const expiredCodes = new Set(["expired", "evicted"]);
const incompleteCodes = new Set([
  "capture-failed",
  "capture-interrupted",
  "execution-limit",
  "item-limit",
  "early-buffer-limit",
  "late-event",
]);

/** The work-level gaps of one execution, each placed at the execution's start. */
export function toolActivityGaps(
  execution: DiagnosticExecution,
): (
  | "tool-activity-expired"
  | "tool-activity-not-captured"
  | "tool-activity-incomplete"
)[] {
  const codes = execution.gaps.map((gap) => gap.code);
  return [
    ...(codes.some((code) => expiredCodes.has(code))
      ? (["tool-activity-expired"] as const)
      : []),
    ...(execution.mode === "baseline" || execution.eventSource === "unsupported"
      ? (["tool-activity-not-captured"] as const)
      : []),
    ...(codes.some((code) => incompleteCodes.has(code))
      ? (["tool-activity-incomplete"] as const)
      : []),
  ];
}

/** A short stable token for an identifier that must not appear in an entry id. */
export function identityToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The newest `n` candidates strictly below `before`, newest first. */
export function newestBelow(
  candidates: readonly TimelineCandidate[],
  before: TimelineKey | undefined,
  n: number,
): TimelineCandidate[] {
  return candidates
    .filter((c) => !before || compareTimelineKeys(c.key, before) < 0)
    .sort((a, b) => compareTimelineKeys(b.key, a.key))
    .slice(0, n);
}

/**
 * Merges per-source candidate lists, each already the source's newest `limit + 1`
 * below the cursor, into one page in ascending order. Because every source supplies
 * its true newest entries, the page is the newest `limit` of the whole order and
 * concatenating pages reproduces it with no gap or repeat.
 */
export function mergeTimelinePage(
  sources: readonly (readonly TimelineCandidate[])[],
  limit: number,
): { page: TimelineCandidate[]; olderCursor: string | null } {
  const all = sources.flat().sort((a, b) => compareTimelineKeys(b.key, a.key));
  const page = all.slice(0, limit).reverse();
  const oldest = page[0];
  return {
    page,
    olderCursor:
      all.length > limit && oldest ? serializeTimelineKey(oldest.key) : null,
  };
}
