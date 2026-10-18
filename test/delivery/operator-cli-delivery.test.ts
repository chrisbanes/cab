import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { databaseDigest } from "../fixtures/database-digest.js";
import { deliveryWorld } from "../fixtures/operator-cli.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

test("delivery get shows the PR, actions and comment policy without provider access", async (t) => {
  const w = await deliveryWorld(t);
  await w.f.register();
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
