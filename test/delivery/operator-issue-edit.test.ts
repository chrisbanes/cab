import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainConflictError } from "../../src/core/domain-errors.js";
import { issueChangedReason } from "../../src/operator/github-reasons.js";
import { IssueChangedRefusal } from "../../src/standalone/github-delivery.js";
import { deliveryFixture } from "../fixtures/delivery-fixture.js";
import { startedOf } from "../fixtures/service-internals.js";

type Fixture = Awaited<ReturnType<typeof deliveryFixture>>;
const edit = { title: "Better title", body: "A body an implementer can use" };
const observed = { title: "T", body: "O" };

const grants = (f: Fixture, edits: "allow" | null) =>
  f.domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.service.delivery().configuration(f.projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: edits
      ? [{ action: "issue.edit", repositoryId: "R1", mode: edits }]
      : [],
    requiredChecks: [],
  });

const review = (f: Fixture, text = edit, expected = observed) => {
  const key = randomUUID();
  return f.service.reviewOperatorEdit({
    key,
    taskId: f.taskId,
    operationId: randomUUID(),
    expectedTaskVersion: Number(f.service.domain().task(f.taskId).version),
    ...text,
    expected,
  });
};
const approve = (f: Fixture, r: ReturnType<typeof review>) =>
  f.service.confirmOperatorComment({
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: r.reviewId,
    expectedRevision: r.revision,
    materialHash: r.materialHash,
    decision: "approved",
  });
const post = (f: Fixture, r: ReturnType<typeof review>) =>
  f.service.postOperatorEdit({
    key: r.operationId,
    taskId: f.taskId,
    reviewId: r.reviewId,
    expectedTaskVersion: Number(f.service.domain().task(f.taskId).version),
  });

test("a reviewed, approved operator edit is one issue.edit that the next sync observes", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  f.applyIssueEdits(true);
  const r = review(f);
  assert.equal(r.decision, "pending");
  approve(f, r);
  const saved = await post(f, r);
  assert.equal(saved.state, "confirmed-success");
  assert.equal(f.effects.length, 1);
  const effect = f.effects[0];
  assert.equal(effect?.kind, "issue.edit");
  if (effect?.kind === "issue.edit") {
    assert.equal(effect.target.nodeId, "I1");
    assert.deepEqual(effect.fields, edit);
    assert.deepEqual(effect.expected, observed);
  }
  // A replay returns the same record and sends nothing more.
  assert.equal((await post(f, r)).operationId, saved.operationId);
  assert.equal(f.effects.length, 1);
  await f.service.refreshGitHub();
  // Ensemble keeps no copy of its own: the synced issue shows the edit like a hand edit.
  const synced = f.service.githubSources().issue("I1");
  assert.equal(synced?.observedTitle, edit.title);
  assert.equal(synced?.observedBody, edit.body);
});

test("without an edit grant nothing is approved or sent", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  grants(f, null);
  const r = review(f);
  assert.throws(() => approve(f, r), /denied by project policy/);
  assert.equal((await post(f, r)).state, "denied");
  assert.equal(f.effects.length, 0);
});

test("an unapproved, altered or misdirected edit is refused before any effect", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const r = review(f);
  // The review is still pending, so its approval is not current.
  assert.equal((await post(f, r)).state, "denied");
  approve(f, r);
  const coordinator = startedOf(f.service).deliveryCoordinator;
  const caller = f.service.operatorCommentCaller(f.taskId);
  const submit = (action: object) =>
    Promise.resolve()
      .then(() =>
        coordinator.submit(
          { operationId: r.operationId, action, operatorReviewId: r.reviewId },
          caller,
        ),
      )
      .then(
        (record) => record.state,
        () => "refused",
      );
  const base = {
    kind: "issue.edit",
    target: { nodeId: "I1", repositoryId: "R1", number: 1 },
    fields: edit,
    expected: observed,
  };
  const other = await submit({ ...base, fields: { ...edit, body: "other" } });
  assert.ok(["denied", "refused"].includes(other), other);
  const wrongTarget = await submit({
    ...base,
    target: { ...base.target, nodeId: "I2" },
  });
  assert.ok(["denied", "refused"].includes(wrongTarget), wrongTarget);
  // An edit that names nothing it replaces is not an operator action.
  const unguarded = await submit({ ...base, expected: undefined });
  assert.ok(["denied", "refused"].includes(unguarded), unguarded);
  assert.equal(f.effects.length, 0);
});

test("a runtime caller cannot use an operator review, and its own issue.edit keeps needing approval", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const r = review(f);
  approve(f, r);
  const action = {
    kind: "issue.edit",
    target: { nodeId: "I1", repositoryId: "R1", number: 1 },
    fields: edit,
    expected: observed,
  };
  const withReview = await f.call("ensemble_external_action", {
    operationId: r.operationId,
    action,
    operatorReviewId: r.reviewId,
  });
  assert.equal(withReview.success, false);
  const plain = await f.call("ensemble_external_action", {
    operationId: randomUUID(),
    action: { ...action, expected: undefined },
  });
  assert.equal(plain.success, false);
  assert.equal(f.effects.length, 0);
});

test("a send refused because GitHub changed writes nothing and is not retried", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const r = review(f);
  approve(f, r);
  // GitHub moved on after the draft started; the synced copy has not caught up yet.
  f.setSourceBody("Changed on GitHub");
  f.onPreflight(() => {
    throw new IssueChangedRefusal();
  });
  const saved = await post(f, r);
  // The refusal reads the source again, so a Redraft starts from what GitHub shows.
  assert.equal(
    f.service.githubSources().issue("I1")?.observedBody,
    "Changed on GitHub",
  );
  assert.equal(saved.state, "confirmed-failure");
  assert.equal(saved.observation?.reason, issueChangedReason);
  // A replay of that refusal reads the source again, in case the first read failed.
  f.setSourceBody("Changed again on GitHub");
  assert.equal(
    (
      await f.service.postOperatorEdit({
        key: r.operationId,
        taskId: f.taskId,
        reviewId: r.reviewId,
        expectedTaskVersion: saved.binding.taskVersion,
      })
    ).operationId,
    saved.operationId,
  );
  assert.equal(
    f.service.githubSources().issue("I1")?.observedBody,
    "Changed again on GitHub",
  );
  assert.notEqual(saved.observation?.retryable, true);
  assert.equal(f.effects.length, 0);
});

test("a review of text the synced copy no longer shows is refused as changed", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  f.setSourceBody("Changed on GitHub");
  await f.service.refreshGitHub();
  assert.throws(() => review(f), DomainConflictError);
  assert.equal(f.effects.length, 0);
});

test("an unknown outcome stays uncertain through a restart and is never sent again", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const r = review(f);
  approve(f, r);
  f.setActionOutcome({
    state: "uncertain",
    reason: "Lost provider response",
    receipt: null,
  });
  assert.equal((await post(f, r)).state, "uncertain");
  assert.equal(f.effects.length, 1);
  await f.service.stop();
  await f.service.start();
  await f.service.refreshGitHub();
  const record = f.service.delivery().action(r.operationId);
  assert.equal(record.state, "uncertain");
  assert.equal(f.effects.length, 1);
  assert.ok(
    f.service
      .delivery()
      .actionBlockers(f.taskId)
      .includes("external-action-uncertain"),
  );
  // Another edit waits for this one to be known.
  const next = f.service.reviewOperatorEdit({
    key: randomUUID(),
    taskId: f.taskId,
    operationId: randomUUID(),
    expectedTaskVersion: Number(f.service.domain().task(f.taskId).version),
    ...edit,
    expected: observed,
  });
  assert.throws(
    () =>
      f.service.confirmOperatorComment({
        key: randomUUID(),
        taskId: f.taskId,
        reviewId: next.reviewId,
        expectedRevision: next.revision,
        materialHash: next.materialHash,
        decision: "approved",
      }),
    DomainConflictError,
  );
});

test("an edit can be sent while work is running or the task is not Ready, and not once it is closed", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  // The fixture's lead is running: admission would hold a comment, an edit goes.
  const running = review(f);
  approve(f, running);
  assert.equal((await post(f, running)).state, "confirmed-success");
  // No longer Ready on GitHub: still an open task.
  f.setSourceLabels([]);
  await f.service.refreshGitHub();
  const unready = review(f, { title: "Second", body: "Second body" }, observed);
  approve(f, unready);
  assert.equal((await post(f, unready)).state, "confirmed-success");
  assert.equal(f.effects.length, 2);
  await f.service.stop();
  const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
  db.prepare(
    "UPDATE domain_tasks SET state='cancelled', version=version+1 WHERE id=?",
  ).run(f.taskId);
  db.close();
  await f.service.start();
  assert.equal(f.service.domain().task(f.taskId).state, "cancelled");
  const closed = review(f, { title: "Third", body: "Third body" }, observed);
  assert.throws(() => approve(f, closed));
  assert.equal((await post(f, closed)).state, "denied");
  assert.equal(f.effects.length, 2);
});
