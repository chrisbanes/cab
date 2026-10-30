import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  type TaskRead,
  taskTimelineSchema,
  timelineGapReasons,
} from "../../src/operator/contracts.js";
import {
  serializeTimelineKey,
  timelineRank,
} from "../../src/operator/timeline-key.js";
import {
  changesLabel,
  commandsLabel,
  conversationTree,
  gapCopy,
  mergeTimeline,
  type ConversationItem,
  type TimelineEntry,
} from "../../web/src/task-conversation-model.js";

type Assignment = TaskRead["data"]["assignments"][number];

const v1 = "a".repeat(64),
  v2 = "b".repeat(64);
const lead = randomUUID(),
  worker = randomUUID(),
  grandchild = randomUUID();
const assignment = (
  assignmentId: string,
  requesterAssignmentId: string | null,
): Assignment => ({ assignmentId, requesterAssignmentId }) as Assignment;
const assignments = [
  assignment(lead, null),
  assignment(worker, lead),
  assignment(grandchild, worker),
];

let ordinal = 0;
/** One entry that passes the real schema; later calls sort after earlier ones. */
function entry(
  body: Record<string, unknown> & { kind: string },
  o: {
    assignmentId?: string;
    timeMs?: number;
    id?: string;
    rank?: number;
  } = {},
): TimelineEntry {
  const id = o.id ?? `e${++ordinal}`;
  const raw = {
    entryId: id,
    key: serializeTimelineKey({
      timeMs: o.timeMs ?? 1_000_000 + ordinal,
      rank: o.rank ?? timelineRank.tool,
      ordinal,
      id,
    }),
    assignmentId: o.assignmentId ?? lead,
    at: 1_000_000 + ordinal,
    precision: "ms",
    ...body,
  };
  const page = taskTimelineSchema.parse({
    data: { visibilityRevision: v1, olderCursor: null, entries: [raw] },
    observedAt: 1,
  });
  return page.data.entries[0] as TimelineEntry;
}
const command = (exitCode: number, assignmentId?: string) =>
  entry(
    {
      kind: "tool",
      tool: "command",
      label: null,
      status: "completed",
      command: "npm test",
      truncated: false,
      exitCode,
      outputSequence: null,
    },
    assignmentId ? { assignmentId } : {},
  );
const fileChange = () =>
  entry({
    kind: "tool",
    tool: "file-change",
    label: null,
    status: null,
    command: null,
    truncated: false,
    exitCode: null,
    outputSequence: null,
  });
const text = (value: string, assignmentId?: string) =>
  entry(
    { kind: "assistant", workId: "w", lifecycle: "completed", text: value },
    { rank: timelineRank.history, ...(assignmentId ? { assignmentId } : {}) },
  );
const delegation = (assignmentId: string, requesterAssignmentId: string) =>
  entry(
    {
      kind: "delegation",
      requesterAssignmentId,
      profileId: randomUUID(),
      name: "Worker",
      runtime: { harness: "codex" },
      state: "running",
    },
    { assignmentId, rank: timelineRank.delegation, id: `d-${assignmentId}` },
  );
const window = (entries: TimelineEntry[], visibilityRevision = v1) => ({
  visibilityRevision,
  entries,
});
const page = (
  entries: TimelineEntry[],
  o: { visibilityRevision?: string; olderCursor?: string | null } = {},
) => ({
  visibilityRevision: o.visibilityRevision ?? v1,
  olderCursor: o.olderCursor ?? null,
  entries,
});
const ids = (entries: readonly TimelineEntry[]) =>
  entries.map((e) => e.entryId);

test("merging a newest page dedupes by entry, applies changed content in place and keeps key order", () => {
  const a = text("one"),
    b = text("two"),
    c = text("three");
  const held = window([a, b]);
  const changedB = {
    ...b,
    kind: "assistant",
    text: "two, finished",
  } as TimelineEntry;
  const merged = mergeTimeline(held, page([changedB, c]));
  assert.deepEqual(ids(merged.window.entries), ids([a, b, c]));
  assert.equal(merged.window.entries[1], changedB);
  assert.equal(merged.changed, true);
  assert.equal(merged.reset, false);
  // The same page again changes nothing and keeps the window object.
  const again = mergeTimeline(merged.window, page([changedB, c]));
  assert.equal(again.changed, false);
  assert.equal(again.window, merged.window);
});

test("an entry the newest page covers but no longer returns is dropped, older ones stay", () => {
  const below = text("below"),
    first = text("first"),
    pruned = text("pruned"),
    kept = text("kept");
  const merged = mergeTimeline(
    window([below, first, pruned, kept]),
    page([first, kept], { olderCursor: "more" }),
  );
  // `pruned` sits inside the page's range but is gone; `below` lies under the page.
  assert.deepEqual(ids(merged.window.entries), ids([below, first, kept]));
  assert.equal(merged.changed, true);
});

test("entries with equal whole-second time keep the service's tie order", () => {
  const sameSecond = { timeMs: 5_000 };
  const first = entry(
    { kind: "assistant", workId: "w", lifecycle: "completed", text: "a" },
    { ...sameSecond, rank: timelineRank.history, id: "z-history" },
  );
  const second = entry(
    {
      kind: "message",
      messageKind: "operator-message",
      requester: "operator",
      interactionId: null,
      decision: null,
      text: "b",
      questionAnswers: null,
    },
    { ...sameSecond, rank: timelineRank.message, id: "a-message" },
  );
  const merged = mergeTimeline(window([second]), page([first, second]));
  assert.deepEqual(ids(merged.window.entries), ["z-history", "a-message"]);
});

test("a visibility revision change or a hole above the window resets it", () => {
  const a = text("one"),
    b = text("two");
  const revised = mergeTimeline(
    window([a]),
    page([b], { visibilityRevision: v2 }),
  );
  assert.equal(revised.reset, true);
  assert.deepEqual(ids(revised.window.entries), ids([b]));
  // The page's oldest entry is newer than everything held and more lies beneath it.
  const hole = mergeTimeline(window([a]), page([b], { olderCursor: a.key }));
  assert.equal(hole.reset, true);
  assert.deepEqual(ids(hole.window.entries), ids([b]));
  // Without an older page the two simply join.
  assert.equal(mergeTimeline(window([a]), page([b])).reset, false);
});

test("consecutive commands group with a failure count and an intervening entry splits them", () => {
  const entries = [
    command(0),
    command(1),
    command(0),
    text("between"),
    command(0),
  ];
  const [group, between, after] = conversationTree(entries, assignments, lead);
  assert.equal(group?.type, "commands");
  assert.equal(
    group?.type === "commands" &&
      commandsLabel(group.entries.length, group.failed),
    "Ran 3 commands · 1 failed",
  );
  assert.equal(between?.type, "entry");
  assert.equal(after?.type, "commands");
  // Another stream's command does not join the lead's run, and the delegation splits it.
  const split = conversationTree(
    [command(0), command(0, worker), command(0)],
    assignments,
    lead,
  );
  assert.deepEqual(
    split.map((i) => i.type),
    ["commands", "delegation", "commands"],
  );
});

test("consecutive file changes become one row", () => {
  const [row] = conversationTree(
    [fileChange(), fileChange()],
    assignments,
    lead,
  );
  assert.equal(row?.type, "changes");
  assert.equal(
    row?.type === "changes" && changesLabel(row.entries.length),
    "Changed 2 files",
  );
});

const delegations = (items: ConversationItem[]) =>
  items.filter((i) => i.type === "delegation");

test("a delegated assignment nests under its delegation and a grandchild under the child", () => {
  const entries = [
    text("lead plan"),
    delegation(worker, lead),
    text("worker output", worker),
    delegation(grandchild, worker),
    text("grandchild output", grandchild),
    text("lead again"),
  ];
  const tree = conversationTree(entries, assignments, lead);
  assert.deepEqual(
    tree.map((i) => i.type),
    ["entry", "delegation", "entry"],
  );
  const [child] = delegations(tree);
  assert.equal(child?.type === "delegation" && child.id, worker);
  const inner = child?.type === "delegation" ? child.items : [];
  assert.deepEqual(
    inner.map((i) => i.type),
    ["entry", "delegation"],
  );
  const [nested] = delegations(inner);
  assert.equal(nested?.type === "delegation" && nested.items.length, 1);
});

test("a delegation whose entry is not loaded takes its header from the assignment record", () => {
  const entries = [text("worker output", worker), text("lead", lead)];
  const tree = conversationTree(entries, assignments, lead);
  const [child] = delegations(tree);
  assert.ok(child?.type === "delegation");
  assert.equal(child.entry, null);
  assert.equal(child.assignment?.assignmentId, worker);
  // It sits at its first loaded entry, so it comes before the lead entry that follows.
  assert.equal(tree[0]?.type, "delegation");
  // An assignment with nothing loaded at all is not invented.
  assert.equal(conversationTree([text("lead")], assignments, lead).length, 1);
});

test("every gap reason has copy", () => {
  for (const reason of timelineGapReasons)
    assert.ok(gapCopy(reason).length > 10, reason);
});
