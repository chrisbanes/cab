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
  changedFileCount,
  changesLabel,
  commandsDuration,
  commandsLabel,
  durationLabel,
  entryDuration,
  conversationTree,
  gapCopy,
  hasDelegation,
  mergeTimeline,
  pendingBelow,
  prependTimeline,
  type ConversationItem,
  type ToolEntry,
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
    assignmentId?: string | null;
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
    assignmentId: o.assignmentId === undefined ? lead : o.assignmentId,
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

test("an unfinished entry behind the newest page is found, and an older page completes it in place", () => {
  const streaming = entry(
    { kind: "assistant", workId: "w", lifecycle: "streaming", text: null },
    { rank: timelineRank.history },
  );
  const done = {
    ...streaming,
    lifecycle: "completed",
    text: "finished",
  } as TimelineEntry;
  const newest = text("newest");
  const held = window([streaming, newest]);
  const active = new Set([lead]);
  assert.equal(pendingBelow(held, newest, active), true);
  assert.equal(pendingBelow(window([done, newest]), newest, active), false);
  // An entry of an assignment that is not running will not finish, so nothing waits for it.
  assert.equal(pendingBelow(held, newest, new Set()), false);
  const joined = prependTimeline(held, page([done]));
  assert.ok(joined && joined !== held);
  assert.equal(joined.entries[0], done);
  assert.equal(joined.entries.length, 2);
  // The same page again changes nothing.
  assert.equal(prependTimeline(joined, page([done])), joined);
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

const timed = (at: number, endedAt: number | null, tool = "command") =>
  entry({
    kind: "tool",
    tool,
    label: null,
    status: "completed",
    command: tool === "command" ? "npm test" : null,
    truncated: false,
    exitCode: null,
    outputSequence: null,
    at,
    endedAt,
  }) as ToolEntry;

test("durations format as seconds, minutes and hours", () => {
  assert.deepEqual(
    [0, 999, 1000, 12_500, 125_000, 3_720_000].map(durationLabel),
    ["<1s", "<1s", "1s", "12s", "2m 5s", "1h 2m"],
  );
});

test("a duration is known only for a finished tool with a non-negative span", () => {
  assert.equal(entryDuration(timed(1000, null)), null);
  assert.equal(entryDuration(timed(1000, 500)), null);
  assert.equal(entryDuration(timed(1000, 3500)), 2500);
  assert.equal(entryDuration(command(0) as ToolEntry), null);
  const known = [timed(0, 1000), timed(0, null), timed(0, 2000)];
  assert.equal(commandsDuration(known), 3000);
  assert.equal(commandsDuration([timed(0, null)]), null);
  assert.equal(commandsLabel(3, 1, 3000), "Ran 3 commands · 1 failed · 3s");
});

test("changed files count distinct paths and entries without paths", () => {
  const paths = (...p: string[]) =>
    entry({
      kind: "tool",
      tool: "file-change",
      label: null,
      status: null,
      command: null,
      truncated: false,
      exitCode: null,
      outputSequence: null,
      paths: p,
    }) as ToolEntry;
  assert.equal(
    changedFileCount([paths("a", "b"), paths("a"), fileChange() as ToolEntry]),
    3,
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

const taskComment = (id: string) =>
  entry(
    {
      kind: "task-comment",
      commentId: randomUUID(),
      author: "operator",
      text: id,
      deliveries: [{ assignmentId: worker, effect: "input" }],
    },
    { assignmentId: null, rank: timelineRank.taskComment, id },
  );

test("a task comment sits once in the root stream, with or without a lead, never under a delegate", () => {
  const entries = [
    text("lead plan"),
    delegation(worker, lead),
    text("worker output", worker),
    taskComment("shared-1"),
  ];
  const tree = conversationTree(entries, assignments, lead);
  const rootIds = tree.flatMap((i) => (i.type === "entry" ? [i.id] : []));
  assert.ok(rootIds.includes("shared-1"));
  const [child] = delegations(tree);
  const inner = child?.type === "delegation" ? child.items : [];
  assert.equal(
    inner.some((i) => i.type === "entry" && i.id === "shared-1"),
    false,
  );
  // With no lead binding the comment is still at the root, and the delegate keeps its own stream.
  const noLead = conversationTree(entries, assignments, null);
  assert.ok(noLead.some((i) => i.type === "entry" && i.id === "shared-1"));
  const everywhere = JSON.stringify(noLead).split('"shared-1"').length - 1;
  assert.ok(
    everywhere >= 1 &&
      everywhere === JSON.stringify(tree).split('"shared-1"').length - 1,
  );
  // A task comment never counts as unfinished work of a running assignment.
  assert.equal(
    pendingBelow(
      window(entries),
      entries[0] as TimelineEntry,
      new Set([worker]),
    ),
    false,
  );
});

test("task comments merge, page and reset like any other entry", () => {
  const a = taskComment("c-1"),
    b = taskComment("c-2");
  const merged = mergeTimeline(null, page([a, b]));
  assert.deepEqual(ids(merged.window.entries), ["c-1", "c-2"]);
  const older = prependTimeline(window([b]), page([a]));
  assert.deepEqual(ids(older?.entries ?? []), ["c-1", "c-2"]);
  assert.equal(
    prependTimeline(window([b]), page([a], { visibilityRevision: v2 })),
    null,
  );
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
  // A finished assignment with nothing loaded at all is not invented.
  assert.equal(conversationTree([text("lead")], assignments, lead).length, 1);
});

test("a pending or running assignment with nothing loaded still has its place, last", () => {
  const withState = (state: string) => [
    assignment(lead, null),
    { ...assignment(worker, lead), state } as Assignment,
  ];
  for (const state of ["pending", "running"]) {
    const tree = conversationTree([text("lead")], withState(state), lead);
    assert.deepEqual(
      tree.map((i) => i.type),
      ["entry", "delegation"],
      state,
    );
    assert.equal(hasDelegation(tree, worker), true);
    // The placeholder is not something loaded: a link still reads earlier pages for it.
    assert.equal(hasDelegation(tree, worker, true), false);
  }
  assert.equal(
    conversationTree([text("lead")], withState("completed"), lead).length,
    1,
  );
});

test("hasDelegation finds an assignment's place at any depth, and none when nothing of it is loaded", () => {
  const tree = conversationTree(
    [delegation(worker, lead), delegation(grandchild, worker)],
    assignments,
    lead,
  );
  for (const id of [worker, grandchild])
    assert.equal(hasDelegation(tree, id), true);
  assert.equal(hasDelegation(tree, lead), false);
  assert.equal(
    hasDelegation(conversationTree([text("lead")], assignments, lead), worker),
    false,
  );
});

test("every gap reason has copy", () => {
  for (const reason of timelineGapReasons)
    assert.ok(gapCopy(reason).length > 10, reason);
});
