import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  type IssueEditPolicy,
  improveView,
  issueBodyLimit,
  lineDiff,
  readStored,
  reviewBlock,
  staleProviderReason,
  type ViewInput,
  writeStored,
} from "../../web/src/issue-improve-model.js";

const available: IssueEditPolicy = {
  available: true,
  reasonCode: null,
  reason: null,
  latest: null,
};
const base: ViewInput = {
  policy: available,
  ownOperationId: null,
  runId: null,
  run: null,
  hasEdit: false,
  hasReview: false,
  sending: false,
  staleFlag: false,
  sendFailure: false,
};
const run = (state: string, extra = {}) =>
  ({
    runId: randomUUID(),
    state,
    reason: null,
    proposal: null,
    proposalWithheld: false,
    leadName: "Mira",
    createdAt: 1,
    expiresAt: null,
    ...extra,
  }) as never;

test("the diff marks removed and added lines and keeps common ones", () => {
  const { current, proposed } = lineDiff("a\nb\nc", "a\nx\nc\nd");
  assert.deepEqual(current, [
    { kind: "same", text: "a" },
    { kind: "removed", text: "b" },
    { kind: "same", text: "c" },
  ]);
  assert.deepEqual(proposed, [
    { kind: "same", text: "a" },
    { kind: "added", text: "x" },
    { kind: "same", text: "c" },
    { kind: "added", text: "d" },
  ]);
  assert.deepEqual(lineDiff("", "").current, [{ kind: "same", text: "" }]);
});

test("review is blocked for a blank, oversize or unchanged edit", () => {
  const observed = { title: "T", body: "B" };
  assert.match(
    String(reviewBlock({ title: " ", body: "b" }, observed)),
    /title/,
  );
  assert.match(
    String(reviewBlock({ title: "t", body: "  " }, observed)),
    /body/,
  );
  assert.match(
    String(
      reviewBlock({ title: "t", body: "b".repeat(issueBodyLimit + 1) }, null),
    ),
    /over/,
  );
  assert.match(
    String(reviewBlock({ title: "T", body: "B" }, observed)),
    /matches/,
  );
  assert.equal(reviewBlock({ title: "T2", body: "B" }, observed), null);
});

test("an unsettled edit on the service holds the panel whatever else is happening", () => {
  for (const state of ["uncertain", "attempting", "prepared"] as const) {
    const policy = {
      ...available,
      latest: { operationId: randomUUID(), state, reason: null },
    };
    assert.equal(
      improveView({ ...base, policy, hasEdit: true, runId: randomUUID() }),
      "held",
    );
  }
});

test("the panel's own settled edit shows sent, stale or failed; another's does not", () => {
  const operationId = randomUUID();
  const settled = (state: string, reason: string | null) => ({
    ...base,
    ownOperationId: operationId,
    policy: {
      ...available,
      latest: { operationId, state, reason } as never,
    },
  });
  assert.equal(improveView(settled("confirmed-success", null)), "sent");
  assert.equal(
    improveView(settled("confirmed-failure", staleProviderReason)),
    "stale",
  );
  assert.equal(improveView(settled("confirmed-failure", "x")), "send-failed");
  assert.equal(improveView(settled("denied", "x")), "send-failed");
  assert.equal(
    improveView({
      ...settled("confirmed-success", null),
      ownOperationId: randomUUID(),
    }),
    "idle",
  );
});

test("run states map to views and a withheld proposal is never an editor", () => {
  const runId = randomUUID();
  const view = (r: unknown) => improveView({ ...base, runId, run: r as never });
  assert.equal(view(null), "starting");
  assert.equal(view(run("queued")), "queued");
  assert.equal(view(run("running")), "running");
  assert.equal(view(run("stopping")), "stopping");
  assert.equal(view(run("failed")), "failed");
  assert.equal(view(run("interrupted")), "interrupted");
  assert.equal(
    view(run("proposed", { proposal: { title: "t", body: "b" } })),
    "editing",
  );
  assert.equal(view(run("proposed", { proposalWithheld: true })), "withheld");
});

test("an unavailable policy disables the panel unless work is under way", () => {
  const policy = {
    ...available,
    available: false,
    reasonCode: "no-edit-grant" as const,
  };
  assert.equal(improveView({ ...base, policy }), "unavailable");
  assert.equal(improveView({ ...base, policy, hasEdit: true }), "editing");
});

test("stored state survives a reload, tolerates damage and clears when empty", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const taskId = randomUUID();
  const value = { note: "hi", edit: { title: "t", body: "b" } };
  writeStored(storage, taskId, value);
  assert.deepEqual(readStored(storage, taskId), value);
  writeStored(storage, taskId, { note: "" });
  assert.equal(map.size, 0);
  map.set(`ensemble.issue-improve.v1.${taskId}`, "{not json");
  assert.deepEqual(readStored(storage, taskId), { note: "" });
  map.set(`ensemble.issue-improve.v1.${taskId}`, '{"note":1}');
  assert.deepEqual(readStored(storage, taskId), { note: "" });
});
