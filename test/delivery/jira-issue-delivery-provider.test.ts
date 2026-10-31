import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  DeliveryActionRecord,
  ExternalAction,
} from "../../src/core/delivery.js";
import { markdownToAdf } from "../../src/core/markdown-adf.js";
import { StatusSkipRefusal } from "../../src/standalone/issue-tracker.js";
import { JiraIssueTrackerWriter } from "../../src/standalone/jira-delivery.js";
import {
  accountId,
  fakeJiraIssue,
  otherAccountId,
  target,
} from "../fixtures/fake-jira-issue.js";

const site = "example.atlassian.net";
const world = () => {
  const jira = fakeJiraIssue();
  const writer = new JiraIssueTrackerWriter(
    () => ({ instance: site, email: "cab@example.test", token: "token" }),
    jira.fetcher,
  );
  return { ...jira, writer };
};
type World = ReturnType<typeof world>;

const recordOf = (
  action: ExternalAction,
  beforeState: DeliveryActionRecord["beforeState"],
  operationId = randomUUID(),
) =>
  ({
    operationId,
    request: { operationId, action },
    state: "attempting",
    attempts: 1,
    beforeState,
    observation: null,
  }) as unknown as DeliveryActionRecord;
/** Preflight, then the write and its readback, as the coordinator runs them. */
async function perform(w: World, action: ExternalAction) {
  const record = recordOf(action, await w.writer.preflight(action));
  return { record, observation: await w.writer.performAction(record) };
}
const comment = (body = "Progress\n\nSecond paragraph"): ExternalAction => ({
  kind: "issue.comment",
  target,
  body,
});
const close: ExternalAction = {
  kind: "issue.close",
  target,
  reviewedResultIds: [],
};

test("Markdown becomes plain ADF paragraphs, hard breaks and code blocks, never an active node", () => {
  assert.deepEqual(markdownToAdf("One\ntwo\n\nThree"), {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "One" },
          { type: "hardBreak" },
          { type: "text", text: "two" },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "Three" }] },
    ],
  });
  assert.deepEqual(
    markdownToAdf("```ts\nlet a = 1;\n\nb\n```\nafter").content,
    [
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "let a = 1;\n\nb" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ],
  );
  // An unclosed fence runs to the end.
  assert.equal(markdownToAdf("```\nopen").content[0]?.type, "codeBlock");
  const hostile =
    "@[Admin](accountid:5b10) [x](https://evil.example) ![i](https://evil.example/p.png) [~accountid:5b10]\n:smile: {code} <b>";
  const text = JSON.stringify(markdownToAdf(hostile));
  for (const node of ["mention", "media", "mediaSingle", "inlineCard", "emoji"])
    assert.equal(text.includes(`"${node}"`), false);
  assert.equal(text.includes('"marks"'), false);
  assert.ok(text.includes("@[Admin](accountid:5b10)"));
  assert.throws(() => markdownToAdf(" \n\n "), /no content/);
});

test("a comment posts ADF with the operation marker and is confirmed only by reading it back", async () => {
  const w = world();
  const { record, observation } = await perform(w, comment());
  assert.equal(observation.state, "confirmed-success");
  assert.equal(observation.receipt?.nodeId, w.state.comments[0]?.id);
  assert.deepEqual(w.writes(), ["POST comment"]);
  const post = w.requests.find((r) => r.method === "POST");
  assert.deepEqual(post?.body, {
    body: markdownToAdf("Progress\n\nSecond paragraph"),
    properties: [
      { key: "cab-operation", value: { operationId: record.operationId } },
    ],
  });
  assert.equal(post?.headers.get("authorization")?.startsWith("Basic "), true);
  assert.equal(post?.redirect, "manual");
});

test("a comment is not confirmed when the readback shows no marker, a copy, another author or another text", async () => {
  const w = world();
  const { record } = await perform(w, comment());
  const [mine] = w.state.comments;
  assert.ok(mine);
  const confirmed = async () => (await w.writer.inspectAction(record)).state;
  assert.equal(await confirmed(), "confirmed-success");

  w.state.comments.push({ ...mine, id: "700" });
  assert.equal(await confirmed(), "uncertain");
  w.state.comments.pop();

  mine.accountId = otherAccountId;
  assert.equal(await confirmed(), "uncertain");
  mine.accountId = accountId;

  const body = mine.body;
  mine.body = markdownToAdf("Edited");
  assert.equal(await confirmed(), "uncertain");
  mine.body = body;

  mine.properties = [];
  assert.equal(await confirmed(), "uncertain");

  // Jira dropping the property on create is an unproved write, never a success.
  const dropped = world();
  dropped.state.dropProperties = true;
  assert.equal(
    (await perform(dropped, comment())).observation.state,
    "uncertain",
  );
});

test("a comment whose request is lost or fails with a server error stays uncertain, and is never resent", async () => {
  for (const failure of [{}, { status: 503 }]) {
    const w = world();
    w.state.fail["POST comment"] = { ...failure, apply: true };
    const { record, observation } = await perform(w, comment());
    assert.equal(observation.state, "uncertain");
    assert.equal(observation.reason, "provider-effect-unproved");
    // A later readback finds the marker comment the lost response hid.
    assert.equal(
      (await w.writer.inspectAction(record)).state,
      "confirmed-success",
    );
    assert.deepEqual(w.writes(), ["POST comment"]);
  }
  const none = world();
  none.state.fail["POST comment"] = {};
  const { record } = await perform(none, comment());
  assert.equal((await none.writer.inspectAction(record)).state, "uncertain");
  assert.equal(none.writes().length, 1);
});

test("a rejected comment request is a confirmed failure, and a rate limit is retryable", async () => {
  for (const status of [400, 401, 403, 404]) {
    const w = world();
    w.state.fail["POST comment"] = { status };
    const { observation } = await perform(w, comment());
    assert.equal(observation.state, "confirmed-failure");
    assert.equal(observation.reason, `provider-http-${status}`);
    assert.equal(observation.retryable, undefined);
  }
  const w = world();
  w.state.fail["POST comment"] = { status: 429 };
  const { observation } = await perform(w, comment());
  assert.equal(observation.state, "confirmed-failure");
  assert.equal(observation.reason, "provider-http-429");
  assert.equal(observation.retryable, true);
  assert.ok((observation.resumeAt ?? 0) > Date.now());
});

test("preflight refuses a target that is not the named issue, and text Jira cannot take", async () => {
  const w = world();
  for (const wrong of [
    { ...target, number: 8 },
    { ...target, repositoryId: "10001" },
  ])
    await assert.rejects(
      w.writer.preflight({ kind: "issue.comment", target: wrong, body: "B" }),
      /provider-target-mismatch/,
    );
  await assert.rejects(w.writer.preflight(comment(" \n ")), /no content/);
  await assert.rejects(
    w.writer.preflight({
      kind: "issue.labels",
      target,
      add: ["has space"],
      remove: [],
    }),
    /provider-label-invalid/,
  );
  assert.deepEqual(w.writes(), []);
});

test("labels change in one request and are confirmed by exact readback", async () => {
  const w = world();
  const action: ExternalAction = {
    kind: "issue.labels",
    target,
    add: ["Urgent", "backend"],
    remove: ["ready"],
  };
  const { record, observation } = await perform(w, action);
  assert.equal(observation.state, "confirmed-success");
  assert.deepEqual(w.state.labels, ["Urgent", "backend"]);
  assert.deepEqual(w.writes(), ["PUT issue"]);
  assert.deepEqual(w.requests.find((r) => r.method === "PUT")?.body, {
    update: {
      labels: [{ add: "Urgent" }, { add: "backend" }, { remove: "ready" }],
    },
  });
  // Jira labels are case-sensitive, so a differently cased label is not the one added.
  w.state.labels = ["urgent", "backend"];
  assert.equal((await w.writer.inspectAction(record)).state, "uncertain");
  w.state.labels = ["Urgent", "backend", "ready"];
  assert.equal((await w.writer.inspectAction(record)).state, "uncertain");
});

test("the writer delivers comments, labels, closure and mapped statuses only", async () => {
  const w = world();
  const supported = (kind: ExternalAction["kind"]) =>
    w.writer.supportsAction(kind);
  assert.deepEqual(
    (
      ["issue.comment", "issue.labels", "issue.close", "issue.status"] as const
    ).map(supported),
    [true, true, true, true],
  );
  for (const kind of [
    "issue.edit",
    "issue.create",
    "project.item.add",
    "project.field",
    "pr.merge",
    "branch.push",
  ] as const)
    assert.equal(supported(kind), false);
  await assert.rejects(
    w.writer.preflight({ kind: "issue.edit", target, fields: { title: "T" } }),
    /unsupported/,
  );
});

test("a credential that no longer resolves sends nothing and fails definitively", async () => {
  const w = world();
  const action = comment();
  const record = recordOf(action, await w.writer.preflight(action));
  const requests = w.requests.length;
  const missing = new JiraIssueTrackerWriter(
    () => ({ reason: "missing-credential" }),
    w.fetcher,
  );
  const observation = await missing.performAction(record);
  assert.equal(observation.state, "confirmed-failure");
  assert.equal(observation.reason, "provider-credential-unavailable");
  assert.equal((await missing.inspectAction(record)).state, "uncertain");
  assert.equal(w.requests.length, requests);
  await assert.rejects(missing.preflight(action));
});

test("closure transitions through the one Done transition and is proven by a changelog entry of the credential user", async () => {
  const w = world();
  const { record, observation } = await perform(w, close);
  assert.equal(observation.state, "confirmed-success");
  assert.deepEqual(observation.receipt, {
    nodeId: "10007",
    number: 7,
    issueClosed: true,
  });
  assert.deepEqual(w.writes(), ["POST transitions"]);
  assert.deepEqual(w.requests.find((r) => r.method === "POST")?.body, {
    transition: { id: "31" },
  });
  assert.equal(record.beforeState?.state, "open");
  assert.equal(record.beforeState?.changelogHighWater, "500");
});

test("closure is refused before any write when the issue is done or Done is not one transition", async () => {
  const done = world();
  done.state.status = { id: "9", name: "Done", category: "done" };
  await assert.rejects(done.writer.preflight(close), /not-open/);

  const none = world();
  none.state.transitions = [];
  await assert.rejects(none.writer.preflight(close), /ambiguous/);

  const two = world();
  two.state.transitions.push({
    id: "41",
    to: { id: "10", name: "Won't do", category: "done" },
  });
  await assert.rejects(two.writer.preflight(close), /ambiguous/);
  for (const w of [done, none, two]) assert.deepEqual(w.writes(), []);
});

test("a closure by another account, a second status move, or a lost response is not proved", async () => {
  const person = world();
  person.state.writer = otherAccountId;
  assert.equal((await perform(person, close)).observation.state, "uncertain");

  const twice = world();
  const first = await perform(twice, close);
  twice.state.history.push({
    id: "900",
    accountId: otherAccountId,
    items: [{ field: "status", to: "1" }],
  });
  assert.equal(
    (await twice.writer.inspectAction(first.record)).state,
    "uncertain",
  );

  // Unrelated edits after preflight do not hide the closure.
  const edited = world();
  const preflight = await edited.writer.preflight(close);
  edited.state.history.push({
    id: "550",
    accountId: otherAccountId,
    items: [{ field: "labels", to: "x" }],
  });
  const record = recordOf(close, preflight);
  assert.equal(
    (await edited.writer.performAction(record)).state,
    "confirmed-success",
  );

  const lost = world();
  lost.state.fail["POST transitions"] = { apply: true };
  const attempt = await perform(lost, close);
  assert.equal(attempt.observation.state, "uncertain");
  assert.equal(
    (await lost.writer.inspectAction(attempt.record)).state,
    "confirmed-success",
  );
  assert.deepEqual(lost.writes(), ["POST transitions"]);

  const missing = world();
  missing.state.fail["POST transitions"] = { status: 503 };
  assert.equal((await perform(missing, close)).observation.state, "uncertain");
});

test("an unpaged or malformed changelog never proves a closure", async () => {
  const w = world();
  const { record } = await perform(w, close);
  const fetcher: typeof fetch = async (input, init) => {
    const response = await w.fetcher(input, init);
    return String(input).includes("/changelog")
      ? Response.json({ values: [], total: 3, startAt: 0 })
      : response;
  };
  const broken = new JiraIssueTrackerWriter(
    () => ({ instance: site, email: "e", token: "t" }),
    fetcher,
  );
  assert.equal((await broken.inspectAction(record)).state, "uncertain");
  await assert.rejects(broken.inspectClosedIssue(target));
});

test("closed-issue inspection names who made the latest move to the current Done status", async () => {
  const w = world();
  assert.deepEqual(await w.writer.inspectClosedIssue(target), {
    state: "open",
  });
  await perform(w, close);
  const own = await w.writer.inspectClosedIssue(target);
  assert.ok(own.state === "closed");
  assert.equal(own.closedEvent?.closerKind, "none");
  assert.equal(own.closedEvent?.closerPrNodeId, null);
  assert.equal(own.snapshot.providerInstance, site);
  assert.deepEqual(own.snapshot.status, {
    id: "9",
    name: "Done",
    categoryKey: "done",
  });

  // A reopen and a later closure by a person is a different, external closure.
  w.state.history.push(
    {
      id: "800",
      accountId: otherAccountId,
      items: [{ field: "status", to: "1" }],
    },
    {
      id: "801",
      accountId: otherAccountId,
      items: [{ field: "status", to: "9" }],
    },
  );
  const external = await w.writer.inspectClosedIssue(target);
  assert.ok(external.state === "closed");
  assert.equal(external.closedEvent?.closerKind, "other");
  assert.equal(external.closedEvent?.id, "801");
  assert.notEqual(external.closedEvent?.id, own.closedEvent?.id);
});

const inProgress = { id: "3", name: "In Progress", category: "indeterminate" };
const toStatus = (
  statusId: string,
  expected: string | null,
): ExternalAction => ({
  kind: "issue.status",
  target,
  statusId,
  expected: { statusId: expected },
});
/** An issue at To Do (1) with one transition to In Progress (3), as a team-managed project offers. */
const statusWorld = () => {
  const w = world();
  w.state.transitions = [{ id: "21", to: inProgress }, ...w.state.transitions];
  return w;
};
const skipped = (w: World, action: ExternalAction, reason: string) =>
  assert.rejects(
    w.writer.preflight(action),
    (e: unknown) => e instanceof StatusSkipRefusal && e.reason === reason,
  );

test("a mapped status takes the one transition to the target and is confirmed by reading the status back", async () => {
  const w = statusWorld();
  const { record, observation } = await perform(w, toStatus("3", "1"));
  assert.equal(observation.state, "confirmed-success");
  assert.deepEqual(observation.receipt, { nodeId: "10007", number: 7 });
  assert.deepEqual(w.writes(), ["POST transitions"]);
  assert.deepEqual(w.requests.find((r) => r.method === "POST")?.body, {
    transition: { id: "21" },
  });
  assert.deepEqual(record.beforeState, {
    issueId: "10007",
    state: "open",
    transitionId: "21",
    targetStatusId: "3",
  });
  // Two reads before the write (the issue, its transitions), then the one POST.
  assert.deepEqual(
    w.requests.slice(0, 3).map((r) => r.method),
    ["GET", "GET", "POST"],
  );
});

test("a mapped status is skipped, with nothing written, when no or several transitions reach it", async () => {
  const none = statusWorld();
  await skipped(none, toStatus("10", "1"), "provider-transition-unavailable");
  const two = statusWorld();
  two.state.transitions.push({ id: "22", to: inProgress });
  await skipped(two, toStatus("3", "1"), "provider-transition-ambiguous");
  for (const w of [none, two]) assert.deepEqual(w.writes(), []);
});

test("a mapped status is skipped without reading transitions when the issue moved, and when it is already there", async () => {
  const moved = statusWorld();
  await skipped(moved, toStatus("3", "10"), "provider-issue-status-changed");
  await skipped(moved, toStatus("3", null), "provider-issue-status-changed");
  assert.equal(
    moved.requests.some((r) => r.url.pathname.endsWith("/transitions")),
    false,
  );
  const there = statusWorld();
  there.state.status = {
    id: "3",
    name: "In Progress",
    category: "indeterminate",
  };
  // Already there reads as current even though cab last saw another status.
  await skipped(there, toStatus("3", "1"), "provider-issue-status-current");
  await skipped(there, toStatus("3", "3"), "provider-issue-status-current");
  for (const w of [moved, there]) assert.deepEqual(w.writes(), []);
});

test("a mapped status whose request is lost or fails with a server error stays uncertain, and a rejection is definitive", async () => {
  for (const failure of [{}, { status: 503 }]) {
    const w = statusWorld();
    w.state.fail["POST transitions"] = { ...failure, apply: true };
    const { record, observation } = await perform(w, toStatus("3", "1"));
    assert.equal(observation.state, "uncertain");
    // A later readback finds the move the lost response hid.
    assert.equal(
      (await w.writer.inspectAction(record)).state,
      "confirmed-success",
    );
    assert.deepEqual(w.writes(), ["POST transitions"]);
  }
  for (const status of [400, 403, 404]) {
    const w = statusWorld();
    w.state.fail["POST transitions"] = { status };
    const { observation } = await perform(w, toStatus("3", "1"));
    assert.equal(observation.state, "confirmed-failure");
    assert.equal(observation.reason, `provider-http-${status}`);
  }
  const limited = statusWorld();
  limited.state.fail["POST transitions"] = { status: 429 };
  const { observation } = await perform(limited, toStatus("3", "1"));
  assert.equal(observation.reason, "provider-http-429");
  assert.equal(observation.retryable, true);
  assert.ok((observation.resumeAt ?? 0) > Date.now());
});

test("a mapped status is not confirmed when the readback shows another status", async () => {
  const w = statusWorld();
  w.state.fail["POST transitions"] = { status: 503 };
  const { record, observation } = await perform(w, toStatus("3", "1"));
  assert.equal(observation.state, "uncertain");
  assert.equal((await w.writer.inspectAction(record)).state, "uncertain");
  w.state.status = { id: "9", name: "Done", category: "done" };
  assert.equal((await w.writer.inspectAction(record)).state, "uncertain");
});

test("closure takes the transition to the mapped done status among several Done transitions, else stays ambiguous", async () => {
  const two = () => {
    const w = world();
    w.state.transitions.push({
      id: "41",
      to: { id: "10", name: "Won't do", category: "done" },
    });
    return w;
  };
  const w = two();
  const writer = new JiraIssueTrackerWriter(
    () => ({ instance: site, email: "cab@example.test", token: "token" }),
    w.fetcher,
    "9",
  );
  const record = recordOf(close, await writer.preflight(close));
  assert.equal(record.beforeState?.transitionId, "31");
  assert.equal((await writer.performAction(record)).state, "confirmed-success");
  // A mapped status no Done transition reaches leaves the single-Done-transition rule.
  const other = two();
  await assert.rejects(
    new JiraIssueTrackerWriter(
      () => ({ instance: site, email: "cab@example.test", token: "token" }),
      other.fetcher,
      "5",
    ).preflight(close),
    /ambiguous/,
  );
  await assert.rejects(two().writer.preflight(close), /ambiguous/);
});
