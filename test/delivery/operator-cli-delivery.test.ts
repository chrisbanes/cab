import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import { deliveryWorld, publicationWorld } from "../fixtures/operator-cli.js";

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
