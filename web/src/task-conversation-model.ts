import type {
  TaskRead,
  taskTimelineSchema,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import {
  compareTimelineKeys,
  parseTimelineCursor,
} from "../../src/operator/timeline-key.js";

type Page = z.infer<typeof taskTimelineSchema>["data"];
export type TimelineEntry = Page["entries"][number];
type Kind<K extends TimelineEntry["kind"]> = Extract<
  TimelineEntry,
  { kind: K }
>;
export type ToolEntry = Kind<"tool">;
export type DelegationEntry = Kind<"delegation">;
type Assignment = TaskRead["data"]["assignments"][number];

export interface TimelineWindow {
  visibilityRevision: string;
  entries: TimelineEntry[];
}

/** The conversation's retained window and the cursor beneath it; a remount keeps both. */
export interface ConversationCache {
  window: TimelineWindow;
  cursor: string | null;
}

const keyOf = (entry: TimelineEntry) => {
  const key = parseTimelineCursor(entry.key);
  if (!key) throw new Error("invalid-timeline-key");
  return key;
};
const byKey = (a: TimelineEntry, b: TimelineEntry) =>
  compareTimelineKeys(keyOf(a), keyOf(b));

/**
 * Folds a newly read page into the retained window, ordered by the service's own key. An entry
 * already held is replaced in place. The window starts over (`reset`) when the visibility
 * revision changed, or when the page leaves a hole above the window's newest entry (more new
 * entries than a page holds), so a gap is never presented as continuous.
 */
export function mergeTimeline(
  window: TimelineWindow | null,
  page: Pick<Page, "visibilityRevision" | "entries" | "olderCursor">,
): { window: TimelineWindow; reset: boolean; changed: boolean } {
  const fresh = (reset: boolean) => ({
    window: {
      visibilityRevision: page.visibilityRevision,
      entries: [...page.entries].sort(byKey),
    },
    reset,
    changed: true,
  });
  if (!window || window.visibilityRevision !== page.visibilityRevision)
    return fresh(window !== null);
  const newest = window.entries.at(-1),
    oldest = page.entries[0];
  if (
    newest &&
    oldest &&
    page.olderCursor !== null &&
    compareTimelineKeys(keyOf(oldest), keyOf(newest)) > 0
  )
    return fresh(true);
  const held = new Map(window.entries.map((e) => [e.entryId, e]));
  let changed = false;
  // An entry the page's range covers but the service no longer returns (pruned by retention)
  // is gone; the window does not keep showing it.
  if (oldest) {
    const floor = keyOf(oldest),
      returned = new Set(page.entries.map((e) => e.entryId));
    for (const [id, entry] of held)
      if (!returned.has(id) && compareTimelineKeys(keyOf(entry), floor) >= 0) {
        held.delete(id);
        changed = true;
      }
  }
  for (const entry of page.entries) {
    const before = held.get(entry.entryId);
    if (!before || JSON.stringify(before) !== JSON.stringify(entry))
      changed = true;
    held.set(entry.entryId, entry);
  }
  return {
    window: changed
      ? {
          visibilityRevision: window.visibilityRevision,
          entries: [...held.values()].sort(byKey),
        }
      : window,
    reset: false,
    changed,
  };
}

/**
 * Older entries joined above the window, from a page read with `before`. An entry already held
 * takes the page's content, and the window keeps its identity when nothing differs.
 */
export function prependTimeline(
  window: TimelineWindow,
  page: Pick<Page, "visibilityRevision" | "entries">,
): TimelineWindow | null {
  if (page.visibilityRevision !== window.visibilityRevision) return null;
  const held = new Map(window.entries.map((e) => [e.entryId, e]));
  let changed = false;
  for (const entry of page.entries) {
    const before = held.get(entry.entryId);
    if (!before || JSON.stringify(before) !== JSON.stringify(entry)) {
      changed = true;
      held.set(entry.entryId, entry);
    }
  }
  return changed
    ? {
        visibilityRevision: window.visibilityRevision,
        entries: [...held.values()].sort(byKey),
      }
    : window;
}

/** Content that can still change: streaming text, or a tool the harness has not finished. */
const isPending = (entry: TimelineEntry) =>
  entry.kind === "assistant"
    ? entry.lifecycle !== "completed"
    : entry.kind === "tool" &&
      /progress|running|started/i.test(entry.status ?? "");

/**
 * Whether an unfinished entry of a running assignment sits older than `floor`, beyond what a
 * newest-page read returns, so its completion would never reach the window. An entry whose
 * assignment is not running will not finish, so it is not waited for.
 */
export function pendingBelow(
  window: TimelineWindow,
  floor: TimelineEntry,
  running: ReadonlySet<string>,
): boolean {
  const limit = keyOf(floor);
  return window.entries.some(
    (e) =>
      running.has(e.assignmentId) &&
      isPending(e) &&
      compareTimelineKeys(keyOf(e), limit) < 0,
  );
}

export type ConversationItem =
  | {
      type: "entry";
      id: string;
      entry: Exclude<TimelineEntry, ToolEntry | DelegationEntry>;
    }
  | { type: "commands"; id: string; entries: ToolEntry[]; failed: number }
  | { type: "changes"; id: string; entries: ToolEntry[] }
  | { type: "tool"; id: string; entry: ToolEntry }
  | {
      type: "delegation";
      id: string;
      assignment: Assignment | undefined;
      /** Null when the delegation entry is on an older page that is not loaded. */
      entry: DelegationEntry | null;
      items: ConversationItem[];
    };

/**
 * Places the window's entries by stream: an assignment's entries sit in its own stream, and a
 * delegation sits in its requester's stream (the lead's when none is recorded or known), with
 * the delegated stream nested under it. Consecutive commands, and consecutive file changes,
 * of one stream read as one row. A delegated assignment whose delegation entry is not loaded
 * is placed at its first loaded entry and takes its header from the task read; one that is
 * pending or running with nothing loaded is placed last.
 */
export function conversationTree(
  entries: readonly TimelineEntry[],
  assignments: readonly Assignment[],
  leadId: string | null,
): ConversationItem[] {
  const known = new Map(assignments.map((a) => [a.assignmentId, a]));
  const root = leadId ?? "";
  const parentOf = (id: string) => {
    if (id === root) return null;
    const requester = known.get(id)?.requesterAssignmentId;
    return requester && requester !== id && known.has(requester)
      ? requester
      : root;
  };
  const delegations = new Map<string, DelegationEntry>();
  const own = new Map<string, Exclude<TimelineEntry, DelegationEntry>[]>();
  for (const entry of entries) {
    if (entry.kind === "delegation") {
      delegations.set(entry.assignmentId, entry);
      continue;
    }
    const stream = known.has(entry.assignmentId) ? entry.assignmentId : root;
    const mine = own.get(stream) ?? [];
    mine.push(entry);
    own.set(stream, mine);
  }
  const children = new Map<string, string[]>();
  for (const a of assignments) {
    const parent = parentOf(a.assignmentId);
    if (parent !== null)
      children.set(parent, [...(children.get(parent) ?? []), a.assignmentId]);
  }
  const rank = new Map(entries.map((e, i) => [e.entryId, i] as const));
  // `entries` is key ordered, so an entry's index is its place in the order.
  const place = (entry: TimelineEntry) => rank.get(entry.entryId) ?? 0;

  const build = (stream: string, seen: Set<string>): ConversationItem[] => {
    const placed: { at: number; item: ConversationItem }[] = [];
    for (const entry of own.get(stream) ?? [])
      placed.push({
        at: place(entry),
        item:
          entry.kind === "tool"
            ? { type: "tool", id: entry.entryId, entry }
            : { type: "entry", id: entry.entryId, entry },
      });
    for (const child of children.get(stream) ?? []) {
      if (seen.has(child)) continue;
      const entry = delegations.get(child) ?? null;
      const nested = build(child, new Set([...seen, child]));
      const first = nested.length ? firstPlace(nested[0], place) : undefined;
      // A pending or running assignment can still be messaged, so it has its place even when
      // nothing of it is loaded (no captured text yet, or its delegation is on an older page).
      const open = ["pending", "running"].includes(
        known.get(child)?.state ?? "",
      );
      const at = entry
        ? place(entry)
        : (first ?? (open ? Number.MAX_SAFE_INTEGER : undefined));
      if (at === undefined) continue;
      placed.push({
        at,
        item: {
          type: "delegation",
          id: child,
          assignment: known.get(child),
          entry,
          items: nested,
        },
      });
    }
    return groupTools(placed.sort((a, b) => a.at - b.at).map((p) => p.item));
  };
  return build(root, new Set([root]));
}

/**
 * Whether the tree places a delegation sub-conversation for the assignment, at any depth.
 * With `loaded`, an empty placeholder for an open assignment does not count: something of it
 * (its delegation or an entry) is on a loaded page.
 */
export const hasDelegation = (
  items: readonly ConversationItem[],
  assignmentId: string,
  loaded = false,
): boolean =>
  items.some(
    (item) =>
      item.type === "delegation" &&
      ((item.id === assignmentId &&
        (!loaded || item.entry !== null || item.items.length > 0)) ||
        hasDelegation(item.items, assignmentId, loaded)),
  );

function firstPlace(
  item: ConversationItem | undefined,
  place: (entry: TimelineEntry) => number,
): number | undefined {
  if (!item) return undefined;
  switch (item.type) {
    case "entry":
    case "tool":
      return place(item.entry);
    case "commands":
    case "changes":
      return item.entries[0] && place(item.entries[0]);
    case "delegation":
      return item.entry ? place(item.entry) : firstPlace(item.items[0], place);
  }
}

/** Runs of `command` tools and runs of `file-change` tools collapse; other tools stay single. */
function groupTools(items: ConversationItem[]): ConversationItem[] {
  const out: ConversationItem[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.type !== "tool" || item.entry.tool === "other") {
      out.push(item);
      continue;
    }
    const { entry } = item;
    if (entry.tool === "command") {
      const failed = entry.exitCode !== null && entry.exitCode !== 0 ? 1 : 0;
      if (last?.type === "commands") {
        last.entries.push(entry);
        last.failed += failed;
      } else
        out.push({
          type: "commands",
          id: entry.entryId,
          entries: [entry],
          failed,
        });
    } else if (last?.type === "changes") last.entries.push(entry);
    else out.push({ type: "changes", id: entry.entryId, entries: [entry] });
  }
  return out;
}

export const commandsLabel = (count: number, failed: number) =>
  `Ran ${count} ${count === 1 ? "command" : "commands"}${failed ? ` · ${failed} failed` : ""}`;

export const changesLabel = (count: number) =>
  `Changed ${count} ${count === 1 ? "file" : "files"}`;

type GapReason = Kind<"gap">["reason"];
const gapText: Record<GapReason, string> = {
  "size-limit": "An item was too large to keep, so its text is not shown.",
  "item-limit":
    "Older items passed the retention limit, so their text is not shown.",
  "active-turn-limit":
    "Too many turns were active to capture, so some text is not shown.",
  "turn-ended":
    "The turn ended before this item finished, so its text is incomplete.",
  "missing-text": "The runtime recorded this item without any text.",
  "redaction-unavailable":
    "Redaction was unavailable, so this item's text is withheld.",
  "early-buffer-limit":
    "The turn's earliest content passed the capture buffer, so it is not shown.",
  "tool-activity-expired":
    "Tool activity for this turn passed its retention period. Tools may have run that are not listed.",
  "tool-activity-not-captured":
    "This harness does not capture tool activity. Tools may have run that are not listed.",
  "tool-activity-incomplete":
    "Tool capture was incomplete. Tools may have run that are not listed.",
};
export const gapCopy = (reason: GapReason): string => gapText[reason];
