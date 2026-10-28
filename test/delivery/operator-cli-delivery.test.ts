import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import { deliveryWorld, publicationWorld } from "../fixtures/operator-cli.js";
import { labelAndFieldReady } from "../fixtures/task-publication.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

test("delivery get shows the PR, actions and comment policy without provider access", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  w.f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO delivery_task_branches VALUES (?,?,?,?,?,1)")
      .run(
        w.f.taskId,
        "R1",
        "ensemble/12345678-fix-it",
        "a".repeat(40),
        "b".repeat(40),
      ),
  );
  const requests = w.scripted.requests.length;
  const before = databaseDigest(w.s.f);
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  const read = await w.task();
  assert.deepEqual(json.data.delivery, read.delivery);
  assert.deepEqual(json.data.commentPolicy, {
    available: true,
    mode: "allow",
    reason: null,
  });
  assert.equal(json.data.issue.number, 1);
  assert.equal(json.data.delivery.binding.number, 7);
  assert.deepEqual(json.coverage.gaps, []);
  const human = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /Pull request: +org\/repo#7 OPEN/);
  assert.match(human.out, /Comments: +available \(allow\)/);
  assert.match(
    human.out,
    /Branch: +org\/repo ensemble\/12345678-fix-it pushed a{12}, outside push b{12}/,
  );
  assert.equal(json.data.delivery.branches.length, 1);
  assert.match(human.out, /build +success/);
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.scripted.requests.length, requests);
});

test("delivery get reports a local task without a bound issue", async (t) => {
  const w = await deliveryWorld(t, "allow", true);
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  assert.equal(json.data.issue, null);
  assert.equal(json.data.commentPolicy.available, false);
  assert.equal(
    json.data.commentPolicy.reason,
    "Task has no bound GitHub issue",
  );
});

test("delivery refresh is a receipted write that reports partial outcomes", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const before = databaseDigest(w.s.f);
  const requests = w.scripted.requests.length;
  const denied = await w.cli("ro", ["delivery", "refresh", w.f.taskId]);
  assert.equal(denied.code, 3, denied.out);
  assert.equal(databaseDigest(w.s.f), before);
  assert.equal(w.scripted.requests.length, requests);

  const observed = (await w.task()).delivery.binding.observedAt;
  await new Promise((r) => setTimeout(r, 5));
  const refreshed = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  assert.deepEqual(refreshed.data.receipt, {
    kind: "review",
    key: refreshed.request.key,
    recorded: true,
    taskId: w.f.taskId,
    operation: "delivery.refresh",
  });
  assert.equal(refreshed.data.outcome, "complete");
  assert.ok(refreshed.data.observedAt.after > observed);
  assert.equal(refreshed.coverage.complete, true);

  // A provider read failure is partial, keeps the old observation and is not "refreshed".
  w.scripted.outage = true;
  const partial = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  assert.equal(partial.data.outcome, "partial");
  assert.equal(partial.data.readError, "provider-read-unavailable");
  assert.equal(partial.data.observedAt.after, refreshed.data.observedAt.after);
  assert.ok(partial.coverage.gaps.includes("evidence-gap"));
  const text = await w.h.run([
    "delivery",
    "refresh",
    w.f.taskId,
    "--connection",
    "rw",
  ]);
  assert.equal(text.code, 0);
  assert.match(text.out, /PARTIAL/);
  assert.match(text.out, /installation-wide/);
  w.scripted.outage = false;

  // An uncertain comment is read back once, without a second comment.
  w.scripted.lostComment = true;
  const sent = await w.cli("rw", [
    "delivery",
    "send-comment",
    w.f.taskId,
    "--body-file",
    w.file("lost.txt", "Lost reply comment"),
    "--expected-task-version",
    String((await w.task()).task.version),
  ]);
  assert.equal(sent.code, 6, sent.out);
  assert.match(
    sent.json().error.message,
    /Do not resend with a new --request-id/,
  );
  w.scripted.lostComment = false;
  const reconciled = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  const action = reconciled.data.changed.find(
    (a: Json) => a.operationId === sent.json().error.request.key,
  );
  assert.equal(action?.state, "confirmed-success");
  assert.equal(w.scripted.commentWrites, 1);

  // A lost reply is unknown; the identical rerun refreshes again.
  const lost = await w.cli("rw", ["delivery", "refresh", w.f.taskId], {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  assert.doesNotMatch(lost.json().error.message, /operation get/);
  const rerun = await w.ok("rw", ["delivery", "refresh", w.f.taskId]);
  assert.equal(rerun.request.key, lost.json().error.request.key);
  // The session UI path records the same receipt kind.
  const session = await w.s.sessionPost("/api/operator/commands", {
    type: "delivery.refresh",
    key: randomUUID(),
    taskId: w.f.taskId,
  });
  assert.equal(((await session.json()) as Json).operation, "delivery.refresh");
});

test("delivery get lists thread reply and resolve actions with their outcomes", async (t) => {
  const w = await deliveryWorld(t);
  w.scripted.thread = {
    resolved: false,
    resolvedBy: null,
    comments: [
      { id: "C1", body: "Please fix", state: "SUBMITTED", author: "U_REV" },
    ],
  };
  w.f.grant(
    { action: "pr.thread.reply", mode: "allow" },
    { action: "pr.thread.resolve", mode: "allow" },
  );
  await w.f.register();
  assert.equal(
    (await w.f.threadAction({ kind: "pr.thread.reply", body: "Fixed" }))
      .success,
    true,
  );
  assert.equal(
    (
      await w.f.threadAction({
        kind: "pr.thread.resolve",
        expectedLatestCommentNodeId: "C1",
      })
    ).success,
    false,
  );
  const json = await w.ok("ro", ["delivery", "get", w.f.taskId]);
  assert.deepEqual(
    json.data.delivery.actions.map((a: Json) => [a.kind, a.state, a.reason]),
    [
      ["pr.thread.reply", "confirmed-success", null],
      ["pr.thread.resolve", "confirmed-failure", "provider-preflight-held"],
    ],
  );
  const human = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(human.out, /pr\.thread\.reply +confirmed-success/);
  assert.match(
    human.out,
    /pr\.thread\.resolve +confirmed-failure +provider-preflight-held/,
  );
});

test("delivery publish reviews, confirms and sends a local task as an issue, and a replay creates nothing more", async (t) => {
  const w = await publicationWorld(t);
  const taskId = w.f.task(true, "Ship it", "Do the work");
  const target = w.f.target(taskId, "repo").id;
  const version = w.f.version(taskId);
  const denied = await w.cli("ro", [
    "delivery",
    "publish-review",
    taskId,
    "--target",
    target,
    "--expected-task-version",
    String(version),
  ]);
  assert.notEqual(denied.code, 0);
  assert.equal(w.f.gh.posts, 0);

  const review = await w.ok("rw", [
    "delivery",
    "publish-review",
    taskId,
    "--target",
    target,
    "--expected-task-version",
    String(version),
  ]);
  const r = review.data.receipt as Json;
  assert.equal(r.kind, "publication-review");
  assert.equal(r.repository, "org/repo");
  assert.equal(r.decision, "pending");
  assert.equal(w.f.gh.posts, 0);
  const human = await w.h.run([
    "delivery",
    "publish-review",
    taskId,
    "--target",
    target,
    "--expected-task-version",
    String(version),
    "--connection",
    "rw",
  ]);
  assert.match(human.out, /Nothing was created on GitHub/);
  assert.match(human.out, /cannot delete or take back/);
  assert.match(human.out, /delivery publish-confirm/);

  const confirmArgs = [
    "delivery",
    "publish-confirm",
    taskId,
    "--review-id",
    r.reviewId,
    "--expected-revision",
    String(r.revision),
    "--material-hash",
    r.materialHash,
    "--decision",
    "approved",
  ];
  const confirmed = await w.ok("rw", confirmArgs);
  assert.equal(confirmed.data.receipt.decision, "approved");

  const sendArgs = [
    "delivery",
    "publish-send",
    taskId,
    "--review-id",
    r.reviewId,
    "--expected-task-version",
    String(version),
    "--request-id",
    "11111111-1111-4111-8111-111111111111",
  ];
  const sent = await w.ok("rw", sendArgs);
  assert.equal(sent.data.receipt.kind, "publication");
  assert.equal(sent.data.state, "converted");
  assert.equal(sent.data.issueNumber, 1);
  assert.equal(w.f.gh.posts, 1);
  // The same request replays the recorded outcome and posts nothing.
  const replay = await w.ok("rw", sendArgs);
  assert.equal(replay.data.state, "converted");
  assert.equal(w.f.gh.posts, 1);
  const read = await w.h.run(["task", "get", taskId, "--connection", "ro"]);
  assert.equal(read.code, 0, read.err);
});

test("delivery publish names the reason a task or target is unavailable and sends nothing", async (t) => {
  const w = await publicationWorld(t, {
    selections: ["repo", "search"],
    grants: ["create"],
  });
  const taskId = w.f.task(false);
  const search = w.f.target(taskId, "search").id;
  const base = [
    "delivery",
    "publish-review",
    taskId,
    "--expected-task-version",
  ];
  const version = String(w.f.version(taskId));
  const disabled = await w.h.run([
    ...base,
    version,
    "--target",
    search,
    "--connection",
    "rw",
  ]);
  assert.notEqual(disabled.code, 0);
  assert.match(disabled.err, /can't tell whether a new issue would match/);
  const missing = await w.h.run([...base, version, "--connection", "rw"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /Name the target with --target ID/);
  assert.equal(w.f.gh.posts, 0);
});

test("delivery publish-link refuses an issue without the marker, and publish-abandon warns about a duplicate", async (t) => {
  const w = await publicationWorld(t);
  w.f.gh.createMode = "lost-unseen";
  const taskId = w.f.task(false);
  const { review } = await w.f.publish(taskId);
  const stranger = w.f.gh.add("x", "no marker");
  const link = await w.h.run([
    "delivery",
    "publish-link",
    taskId,
    "--publication-id",
    review.publicationId,
    "--issue",
    String(stranger.number),
    "--connection",
    "rw",
  ]);
  assert.notEqual(link.code, 0);
  assert.match(link.err, /does not carry this publication's marker/);
  const abandoned = await w.h.run([
    "delivery",
    "publish-abandon",
    taskId,
    "--publication-id",
    review.publicationId,
    "--connection",
    "rw",
  ]);
  assert.equal(abandoned.code, 0, abandoned.err);
  assert.match(abandoned.out, /may still have created the issue/);
  assert.match(abandoned.out, /State: +abandoned|abandoned/);
  assert.equal(w.f.gh.posts, 1);
});

test("delivery publish-send says a later step is waiting, not that the create is unknown, when only an item add waits for a retry", async (t) => {
  const w = await publicationWorld(t, {
    selections: ["project"],
    readiness: labelAndFieldReady,
  });
  w.f.gh.itemMode = "retry";
  const taskId = w.f.task(true);
  const review = w.f.service.reviewTaskPublication({
    key: randomUUID(),
    taskId,
    targetId: w.f.target(taskId, "project").id,
    expectedTaskVersion: w.f.version(taskId),
  });
  w.f.service.confirmTaskPublication({
    key: randomUUID(),
    taskId,
    reviewId: review.publicationId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  });
  const sent = await w.h.run([
    "delivery",
    "publish-send",
    taskId,
    "--review-id",
    review.publicationId,
    "--expected-task-version",
    String(w.f.version(taskId)),
    "--connection",
    "rw",
  ]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /Issue #1 was created/);
  assert.match(sent.out, /Link and Abandon do not apply/);
  assert.doesNotMatch(sent.out, /outcome is not known/);
  assert.doesNotMatch(sent.out, /publish-link|publish-abandon/);
  assert.equal(w.f.gh.posts, 1);
});

type World = Awaited<ReturnType<typeof deliveryWorld>>;
type Pins = { v: number; r: number; p: number; h: string };

/** The four values `delivery settle` checks, as the task read shows them. */
async function pinsOf(w: World): Promise<Pins> {
  const read = await w.task();
  return {
    v: read.task.version,
    r: read.delivery.binding.revision,
    p: read.delivery.policyVersion,
    h: read.delivery.binding.headSha,
  };
}
const pinFlags = (p: Pins) => [
  "--expected-task-version",
  String(p.v),
  "--expected-delivery-revision",
  String(p.r),
  "--expected-policy-version",
  String(p.p),
  "--expected-head-sha",
  p.h,
];
const settleArgs = (w: World, ...rest: string[]) => [
  "delivery",
  "settle",
  w.f.taskId,
  ...rest,
];
const settlementRows = (w: World) => {
  let n = -1;
  w.f.seedPersistedState((db) => {
    n = (
      db
        .prepare("SELECT count(*) AS n FROM delivery_settlement_receipts")
        .get() as { n: number }
    ).n;
  });
  return n;
};
/** A fetch that counts command POSTs, and runs `beforePost` ahead of each. */
function countingFetch(beforePost: () => void = () => {}) {
  const counter = {
    posts: 0,
    fetch: (async (input, init) => {
      if (String(input).endsWith("/api/operator/commands")) {
        counter.posts++;
        beforePost();
      }
      return fetch(input, init);
    }) as typeof fetch,
  };
  return counter;
}

test("delivery settle records the decision once, replays it after the revision moves and refuses a changed request", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const before = await pinsOf(w);
  const awaiting = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(
    awaiting.out,
    new RegExp(
      `Handback: +awaiting settlement for head ${before.h.slice(0, 12)} \\(binding revision ${before.r}\\)`,
    ),
  );

  const first = await w.ok(
    "rw",
    settleArgs(w, "--decision", "accepted", "--request-id", randomUUID()),
  );
  const key = first.request.key as string;
  assert.deepEqual(first.data.receipt, {
    kind: "delivery-settlement",
    key,
    recorded: true,
    taskId: w.f.taskId,
    decision: "accepted",
    revision: before.r + 1,
  });
  assert.deepEqual(first.data.pins, {
    taskVersion: before.v,
    deliveryRevision: before.r,
    policyVersion: before.p,
    headSha: before.h,
  });
  const after = await w.task();
  assert.deepEqual(after.delivery.binding.settlement, {
    decision: "accepted",
    headSha: before.h,
  });
  const human = await w.h.run([
    ...settleArgs(w, "--decision", "accepted", ...pinFlags(before)),
    "--request-id",
    key,
    "--connection",
    "rw",
  ]);
  assert.equal(human.code, 0, human.err);
  assert.match(human.out, /does not merge, close or comment/);
  assert.match(human.out, /does not complete the task/);
  assert.match(human.out, /cannot be undone/);
  const accepted = await w.h.run([
    "delivery",
    "get",
    w.f.taskId,
    "--connection",
    "ro",
  ]);
  assert.match(
    accepted.out,
    new RegExp(
      `Handback: +accepted for head ${before.h.slice(0, 12)} \\(binding revision ${before.r + 1}\\)`,
    ),
  );

  // The binding revision has moved; the same request and pins replay the receipt.
  const digest = databaseDigest(w.s.f);
  const replay = await w.ok(
    "rw",
    settleArgs(
      w,
      "--decision",
      "accepted",
      ...pinFlags(before),
      "--request-id",
      key,
    ),
  );
  assert.deepEqual(replay.data.receipt, first.data.receipt);
  assert.equal(replay.data.reusedRequest, true);
  assert.equal(databaseDigest(w.s.f), digest);
  assert.equal(settlementRows(w), 1);
  // The journal also finds the key without --request-id when the pins are the same.
  const journaled = await w.ok(
    "rw",
    settleArgs(w, "--decision", "accepted", ...pinFlags(before)),
  );
  assert.equal(journaled.request.key, key);
  // The session path replays the same body to the same receipt.
  const session = await w.s.sessionPost("/api/operator/commands", {
    type: "delivery.settle",
    key,
    taskId: w.f.taskId,
    expectedTaskVersion: before.v,
    expectedDeliveryRevision: before.r,
    expectedPolicyVersion: before.p,
    expectedHeadSha: before.h,
    decision: "accepted",
  });
  assert.deepEqual(await session.json(), first.data.receipt);

  // A reused key with other material conflicts and records nothing.
  for (const other of [
    ["--decision", "closed", ...pinFlags(before)],
    ["--decision", "accepted", ...pinFlags({ ...before, v: before.v + 1 })],
  ]) {
    const conflict = await w.cli(
      "rw",
      settleArgs(w, ...other, "--request-id", key),
    );
    assert.equal(conflict.code, 4, conflict.out);
    assert.equal(conflict.json().error.code, "conflict");
  }
  assert.equal(settlementRows(w), 1);
  assert.deepEqual((await w.task()).delivery.binding.settlement, {
    decision: "accepted",
    headSha: before.h,
  });

  // A pin-less rerun reads the new revision, so it is a new request: refused, nothing sent.
  const wire = countingFetch();
  const again = await w.cli("rw", settleArgs(w, "--decision", "accepted"), {
    fetch: wire.fetch,
  });
  assert.equal(again.code, 4, again.out);
  assert.match(again.json().error.message, /already settled as accepted/);
  assert.equal(wire.posts, 0);
  assert.equal(settlementRows(w), 1);
});

test("delivery settle names the current values for a stale pin or a race and records nothing", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const now = await pinsOf(w);
  const stale: [string, string][] = [
    ["--expected-task-version", String(now.v + 1)],
    ["--expected-delivery-revision", String(now.r + 1)],
    ["--expected-policy-version", String(now.p + 1)],
    ["--expected-head-sha", "9".repeat(40)],
  ];
  for (const [flag, value] of stale) {
    const refused = await w.cli(
      "rw",
      settleArgs(w, "--decision", "accepted", flag, value),
    );
    assert.equal(refused.code, 4, `${flag}: ${refused.out}`);
    const { error } = refused.json();
    assert.equal(error.code, "conflict");
    assert.ok(
      error.message.includes(
        `task version ${now.v}, binding revision ${now.r}, policy version ${now.p}, head ${now.h.slice(0, 12)}`,
      ),
      error.message,
    );
    const human = await w.h.run([
      ...settleArgs(w, "--decision", "accepted", flag, value),
      "--connection",
      "rw",
    ]);
    assert.equal(human.code, 4);
    assert.equal(human.err.match(/^Fix:/gm)?.length, 1, human.err);
  }
  assert.equal((await w.task()).delivery.binding.settlement ?? null, null);
  assert.equal(settlementRows(w), 0);

  // The head moves after the CLI read and before its POST.
  const racing = countingFetch(() => {
    w.scripted.head = "3".repeat(40);
  });
  const raced = await w.cli("rw", settleArgs(w, "--decision", "accepted"), {
    fetch: racing.fetch,
  });
  assert.equal(raced.code, 4, raced.out);
  assert.equal(raced.json().error.code, "conflict");
  assert.equal(racing.posts, 1);
  assert.equal(settlementRows(w), 0);
});

test("delivery settle refuses accepting a draft, closed or outside-changed PR, and settling as closed stays possible", async (t) => {
  const draft = await deliveryWorld(t);
  await draft.f.register();
  draft.scripted.draft = true;
  await draft.ok("rw", ["delivery", "refresh", draft.f.taskId]);
  const wire = countingFetch();
  const refusedDraft = await draft.cli(
    "rw",
    settleArgs(draft, "--decision", "accepted"),
    { fetch: wire.fetch },
  );
  assert.equal(refusedDraft.code, 4, refusedDraft.out);
  assert.match(refusedDraft.json().error.message, /draft/);
  assert.equal(wire.posts, 0);
  assert.equal(settlementRows(draft), 0);
  const closedDraft = await draft.ok(
    "rw",
    settleArgs(draft, "--decision", "closed"),
  );
  assert.equal(closedDraft.data.receipt.decision, "closed");
  assert.match(
    (
      await draft.h.run([
        "delivery",
        "get",
        draft.f.taskId,
        "--connection",
        "ro",
      ])
    ).out,
    /Handback: +settled as closed/,
  );

  const closed = await deliveryWorld(t);
  await closed.f.register();
  closed.scripted.closed = true;
  await closed.ok("rw", ["delivery", "refresh", closed.f.taskId]);
  const refusedClosed = await closed.cli(
    "rw",
    settleArgs(closed, "--decision", "accepted"),
  );
  assert.equal(refusedClosed.code, 4, refusedClosed.out);
  assert.match(refusedClosed.json().error.message, /closed/);
  assert.equal(
    (await closed.ok("rw", settleArgs(closed, "--decision", "closed"))).data
      .receipt.decision,
    "closed",
  );

  const outside = await deliveryWorld(t);
  await outside.f.register();
  outside.f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO delivery_task_branches VALUES (?,?,?,?,?,1)")
      .run(
        outside.f.taskId,
        "R1",
        "ensemble/12345678-fix-it",
        "a".repeat(40),
        "b".repeat(40),
      ),
  );
  await outside.ok("rw", ["delivery", "refresh", outside.f.taskId]);
  const refusedOutside = await outside.cli(
    "rw",
    settleArgs(outside, "--decision", "accepted"),
  );
  assert.equal(refusedOutside.code, 4, refusedOutside.out);
  assert.match(refusedOutside.json().error.message, /outside Ensemble/);
  assert.equal(settlementRows(outside), 0);

  // An unreadable provider asks for a refresh first.
  const outage = await deliveryWorld(t);
  await outage.f.register();
  outage.scripted.outage = true;
  await outage.ok("rw", ["delivery", "refresh", outage.f.taskId]);
  const refusedRead = await outage.cli(
    "rw",
    settleArgs(outage, "--decision", "closed"),
  );
  assert.equal(refusedRead.code, 4, refusedRead.out);
  assert.match(refusedRead.json().error.message, /last GitHub read failed/);
  const readHuman = await outage.h.run([
    ...settleArgs(outage, "--decision", "closed"),
    "--connection",
    "rw",
  ]);
  assert.match(readHuman.err, /Fix: .*delivery refresh/);
  assert.equal(settlementRows(outage), 0);
});

test("delivery settle keeps the request identity and pins when the reply is lost, and rejects a wrong receipt", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const now = await pinsOf(w);
  const lost = await w.cli("rw", settleArgs(w, "--decision", "accepted"), {
    fetch: w.lostReply,
  });
  assert.equal(lost.code, 6, lost.out);
  const message = lost.json().error.message as string;
  const key = lost.json().error.request.key as string;
  assert.ok(message.includes(`--request-id ${key} `), message);
  for (const flag of pinFlags(now)) assert.ok(message.includes(flag), flag);
  assert.doesNotMatch(message, /operation get/);
  // The applied send moved the revision; the printed identity and pins replay it.
  assert.equal(settlementRows(w), 1);
  const rerun = await w.ok(
    "rw",
    settleArgs(
      w,
      "--decision",
      "accepted",
      "--request-id",
      key,
      ...pinFlags(now),
    ),
  );
  assert.equal(rerun.request.key, key);
  assert.equal(rerun.data.receipt.kind, "delivery-settlement");
  assert.equal(settlementRows(w), 1);

  const other = await deliveryWorld(t);
  await other.f.register();
  const wrong: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!String(input).endsWith("/api/operator/commands")) return response;
    const body = JSON.parse(String(init?.body));
    return Response.json({
      kind: "review",
      key: body.key,
      recorded: true,
      taskId: other.f.taskId,
      operation: "delivery.refresh",
    });
  };
  const mismatched = await other.cli(
    "rw",
    settleArgs(other, "--decision", "accepted"),
    { fetch: wrong },
  );
  assert.equal(mismatched.code, 6, mismatched.out);
  assert.match(mismatched.json().error.message, /not the expected receipt/);
});

test("delivery settle sends nothing for a read-only credential, bad flags or a task without a reviewable PR", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
  const wire = countingFetch();
  const run = (connection: "ro" | "rw", ...args: string[]) =>
    w.cli(connection, settleArgs(w, ...args), { fetch: wire.fetch });
  assert.equal((await run("ro", "--decision", "accepted")).code, 3);
  assert.equal((await run("rw")).code, 2);
  assert.notEqual((await run("rw", "--decision", "maybe")).code, 0);
  assert.notEqual(
    (await run("rw", "--decision", "closed", "--expected-head-sha", "abc"))
      .code,
    0,
  );
  const local = await deliveryWorld(t, "allow", true);
  const refused = await local.cli(
    "rw",
    settleArgs(local, "--decision", "closed"),
    { fetch: wire.fetch },
  );
  assert.equal(refused.code, 4, refused.out);
  assert.match(refused.json().error.message, /no reviewable pull request/);
  assert.equal(wire.posts, 0);
  assert.equal(settlementRows(w), 0);
});
