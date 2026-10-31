import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { deliveryFixture } from "../fixtures/delivery-fixture.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { DomainPolicyError } from "../../src/core/domain.js";
import { runtimeDeliveryCallerSchema } from "../../src/core/delivery.js";
import { wrapTaskExclusions } from "../fixtures/exclusions-hook.js";
import { startedOf } from "../fixtures/service-internals.js";
const policy = (
  f: Awaited<ReturnType<typeof deliveryFixture>>,
  mode: "allow" | "approval" | null,
) =>
  f.domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.service.delivery().configuration(f.projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: mode ? [{ action: "issue.comment", repositoryId: "R1", mode }] : [],
    requiredChecks: [],
  });
const send = (
  f: Awaited<ReturnType<typeof deliveryFixture>>,
  body = "Exact operator comment",
  key: string = randomUUID(),
) => ({
  type: "comment.send" as const,
  key,
  taskId: f.taskId,
  expectedTaskVersion: Number(f.domain.task(f.taskId).version),
  body,
});
test("operator issue.comment uses server-owned imported identity, rejects spoofing/non-comment/wrong target and preserves runtime actor material", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f),
    saved = await api.execute(command);
  assert.equal(saved.kind, "delivery");
  if (saved.kind === "delivery") assert.equal(saved.state, "confirmed-success");
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0]?.kind, "issue.comment");
  if (f.effects[0]?.kind === "issue.comment")
    assert.equal(f.effects[0].target.nodeId, "I1");
  assert.deepEqual(await api.execute(command), saved);
  await assert.rejects(api.execute({ ...send(f), actor: "runtime" }));
  await assert.rejects(api.execute({ ...send(f), target: { nodeId: "I2" } }));
  const caller = f.service.operatorCommentCaller(f.taskId);
  const coordinator = startedOf(f.service).deliveryCoordinator;
  assert.throws(
    () =>
      coordinator.submit(
        {
          operationId: randomUUID(),
          action: {
            kind: "issue.labels",
            target: { nodeId: "I1", repositoryId: "R1", number: 1 },
            add: ["other"],
            remove: [],
          },
        },
        caller,
      ),
    (error) =>
      error instanceof DomainPolicyError &&
      error.code === "forbidden" &&
      error.message === "Operator delivery only permits issue.comment",
  );
  assert.equal(
    f.service.delivery().prepareAction(
      {
        operationId: randomUUID(),
        action: {
          kind: "issue.labels",
          target: { nodeId: "I1", repositoryId: "R1", number: 1 },
          add: ["other"],
          remove: [],
        },
      },
      caller,
      true,
    ).state,
    "denied",
  );
  assert.equal(
    f.service.delivery().prepareAction(
      {
        operationId: randomUUID(),
        action: {
          kind: "issue.comment",
          target: { nodeId: "I1", repositoryId: "R1", number: 99 },
          body: "wrong number",
        },
      },
      caller,
      true,
    ).state,
    "denied",
  );
  const runtime = await f.call("cab_external_action", {
    operationId: randomUUID(),
    action: {
      kind: "issue.comment",
      target: { nodeId: "I1", repositoryId: "R1", number: 1 },
      body: "Runtime original authority",
    },
  });
  assert.equal(runtime.success, true, runtime.text);
  const runtimeRecord = f.service
    .delivery()
    .actions(f.taskId)
    .find(
      (a) =>
        a.request.action.kind === "issue.comment" &&
        a.request.action.body === "Runtime original authority",
    );
  assert.ok(runtimeRecord);
  assert.deepEqual(
    runtimeDeliveryCallerSchema.parse(runtimeRecord.binding),
    runtimeRecord.binding,
  );
  await assert.rejects(
    f.service.postOperatorComment({
      ...send(f),
      key: runtimeRecord.operationId,
    }),
  );
  assert.equal(f.effects.length, 2);
});
test("approval-mode operator comment requires distinct exact durable review and confirmation; login/generic boolean/unrelated runtime approval cannot authorize", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  policy(f, "approval");
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f),
    review = await api.execute({
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: command.key,
      expectedTaskVersion: command.expectedTaskVersion,
      body: command.body,
    });
  assert.equal(review.kind, "comment-review");
  if (review.kind !== "comment-review") assert.fail("review receipt absent");
  assert.equal(review.decision, "pending");
  const caller = f.service.operatorCommentCaller(f.taskId),
    action = {
      kind: "issue.comment" as const,
      target: { nodeId: "I1", repositoryId: "R1", number: 1 },
      body: command.body,
    };
  assert.throws(
    () =>
      f.service.delivery().authorize(
        {
          operationId: command.key,
          action,
          operatorReviewId: review.reviewId,
        },
        caller,
        true,
      ),
    /approval/,
  );
  await assert.rejects(
    api.execute({
      type: "comment.confirm",
      key: randomUUID(),
      taskId: f.taskId,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      materialHash: "0".repeat(64),
      decision: "approved",
    }),
  );
  // A send through the API before confirmation is denied and leaves the review pending.
  const reviewState = (id: string) =>
    f.service.delivery().operatorReview(id)?.decision;
  const early = await api.execute({ ...send(f), reviewId: review.reviewId });
  assert.equal(early.kind === "delivery" && early.state, "denied");
  assert.equal(reviewState(review.reviewId), "pending");
  // On the review's own operation the denial is that operation's alone; the review stays usable.
  const other = send(f, "Another reviewed comment"),
    otherReview = await api.execute({
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: other.key,
      expectedTaskVersion: other.expectedTaskVersion,
      body: other.body,
    });
  if (otherReview.kind !== "comment-review") assert.fail("review absent");
  const burnt = await api.execute({ ...other, reviewId: otherReview.reviewId });
  assert.equal(burnt.kind === "delivery" && burnt.state, "denied");
  assert.equal(reviewState(otherReview.reviewId), "pending");
  assert.equal(f.effects.length, 0);
  assert.equal(
    (
      await api.execute({
        type: "comment.confirm",
        key: randomUUID(),
        taskId: f.taskId,
        reviewId: otherReview.reviewId,
        expectedRevision: otherReview.revision,
        materialHash: otherReview.materialHash,
        decision: "denied",
      })
    ).kind,
    "comment-review",
  );
  const confirm = {
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  };
  const approved = await api.execute(confirm);
  assert.deepEqual(await api.execute(confirm), approved);
  // A decided review cannot be re-decided the other way.
  await assert.rejects(
    api.execute({ ...confirm, key: randomUUID(), decision: "denied" }),
    { status: 409 },
  );
  assert.equal(reviewState(review.reviewId), "approved");
  const result = await api.execute({ ...command, reviewId: review.reviewId });
  assert.equal(result.kind, "delivery");
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-success");
  assert.equal(f.effects.length, 1);
  assert.equal(
    f.service.delivery().operatorReview(review.reviewId)?.decision,
    "approved",
  );
  assert.equal(f.domain.task(f.taskId).state, "open");
});
test("a comment send rechecks the approved body against the exclusions as they are now", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true),
    credentialName = "FIXTURE_COMMENT_SEND_CREDENTIAL",
    marker = "ZQXcomment123";
  t.after(() => f.close());
  process.env[credentialName] = `fixture-${randomUUID()}`;
  t.after(() => {
    delete process.env[credentialName];
  });
  f.domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: f.service.delivery().configuration(f.projectId).version,
    mode: "reviewable-pr",
    credentialRef: `env:${credentialName}`,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "approval" }],
    requiredChecks: [],
  });
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f, `A comment naming ${marker}`),
    review = await api.execute({
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: command.key,
      expectedTaskVersion: command.expectedTaskVersion,
      body: command.body,
    });
  if (review.kind !== "comment-review") assert.fail("review receipt absent");
  await api.execute({
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  });
  // The delivery credential's value now equals text in the approved body.
  process.env[credentialName] = marker;
  const sendApproved = { ...command, reviewId: review.reviewId };
  await assert.rejects(api.execute(sendApproved), /forbidden/);
  assert.equal(f.effects.length, 0);
  assert.equal(
    f.service
      .delivery()
      .actions()
      .some((a) => a.operationId === command.key),
    false,
  );
  assert.equal(
    f.service.delivery().operatorReview(review.reviewId)?.decision,
    "approved",
  );
  // The stored approval survives the refusal: once the text is no longer private, the send posts.
  process.env[credentialName] = `fixture-${randomUUID()}`;
  const result = await api.execute(sendApproved);
  assert.equal(result.kind, "delivery");
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-success");
  assert.equal(f.effects.length, 1);
});
test("operator no-grant, task/Stop holds and changed policy during delayed preflight prevent provider effect", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]);
  policy(f, null);
  let result = await api.execute(send(f));
  assert.equal(result.kind, "delivery");
  if (result.kind === "delivery") assert.equal(result.state, "denied");
  assert.equal(f.effects.length, 0);
  policy(f, "allow");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.holdPreflight(gate);
  let entered!: () => void;
  const entry = new Promise<void>((r) => (entered = r));
  f.onPreflight(entered);
  const pending = api.execute(send(f));
  await entry;
  policy(f, null);
  release();
  result = await pending;
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-failure");
  assert.equal(f.effects.length, 0);
  policy(f, "allow");
  await f.service.stopTask(f.taskId);
  result = await api.execute(send(f));
  if (result.kind === "delivery") assert.equal(result.state, "denied");
  assert.equal(f.effects.length, 0);
});
test("unknown provider outcome retains original operator intent across restart and read reconciliation never duplicates a comment", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f);
  f.setActionOutcome({
    state: "uncertain",
    reason: "Lost provider response",
    receipt: null,
  });
  const result = await api.execute(command);
  if (result.kind === "delivery") assert.equal(result.state, "uncertain");
  assert.equal(f.effects.length, 1);
  assert.deepEqual(await api.execute(command), result);
  await f.service.stop();
  await f.service.start();
  assert.equal(
    f.service
      .delivery()
      .actions(f.taskId)
      .find((a) => a.operationId === command.key)?.state,
    "uncertain",
  );
  assert.equal((await api.execute(command)).kind, "delivery");
  f.setInspectOutcome({
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: "C1" },
  });
  await api.execute({
    type: "delivery.refresh",
    key: randomUUID(),
    taskId: f.taskId,
  });
  assert.equal(
    f.service
      .delivery()
      .actions(f.taskId)
      .find((a) => a.operationId === command.key)?.state,
    "confirmed-success",
  );
  assert.equal(f.effects.length, 1);
});
test("approved operator material cannot authorize changed body/source or another operation; denial counterpart is durable", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  policy(f, "approval");
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f),
    review = await api.execute({
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: command.key,
      expectedTaskVersion: command.expectedTaskVersion,
      body: command.body,
    });
  if (review.kind !== "comment-review") assert.fail("Review absent");
  await api.execute({
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  });
  const unrelated = await api.execute({
    ...send(f),
    reviewId: review.reviewId,
  });
  if (unrelated.kind === "delivery") assert.equal(unrelated.state, "denied");
  const changed = await api.execute({
    ...command,
    body: "Changed body",
    reviewId: review.reviewId,
  });
  if (changed.kind === "delivery") assert.equal(changed.state, "denied");
  assert.equal(f.effects.length, 0);
  const pending = await api.execute({
    type: "comment.review",
    key: randomUUID(),
    taskId: f.taskId,
    operationId: randomUUID(),
    expectedTaskVersion: command.expectedTaskVersion,
    body: "Separate review",
  });
  if (pending.kind !== "comment-review") assert.fail("Review absent");
  const deny = {
    type: "comment.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: pending.reviewId,
    expectedRevision: pending.revision,
    materialHash: pending.materialHash,
    decision: "denied",
  };
  assert.deepEqual(await api.execute(deny), await api.execute(deny));
  assert.equal(
    f.service.delivery().operatorReview(pending.reviewId)?.decision,
    "denied",
  );
});
test("actual source snapshot change during delayed preflight retains its hold and rejects the prior source material before effect", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]),
    command = send(f);
  let release!: () => void, entered!: () => void;
  f.holdPreflight(new Promise<void>((r) => (release = r)));
  const entry = new Promise<void>((r) => (entered = r));
  f.onPreflight(entered);
  const pending = api.execute(command);
  await entry;
  f.setSourceBody("Changed source requirements");
  f.service.githubSources().reconcileSelection(f.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "org/repo",
        number: 1,
        title: "T",
        body: "Changed source requirements",
        state: "open",
        labels: ["ready"],
        projectFields: [],
      },
    ],
  });
  release();
  const result = await pending;
  if (result.kind === "delivery")
    assert.equal(result.state, "confirmed-failure");
  assert.equal(f.effects.length, 0);
  assert.ok(f.service.githubSources().hold("I1")?.active);
  assert.equal(f.service.taskReview().sources(f.taskId).length, 2);
});

test("comment send receipt fences visibility, task and workspace changes during awaited exclusions", async (t) => {
  for (const race of [
    "reference",
    "value",
    "instructions",
    "task",
    "workspace",
  ] as const) {
    await t.test(race, async (t) => {
      const f = await deliveryFixture("reviewable-pr", true);
      t.after(() => f.close());
      const envKey = "FIXTURE_COMMENT_ACCESS",
        previous = process.env[envKey];
      t.after(() => {
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
      });
      process.env[envKey] = "OriginalCommentAccessValue";
      if (race === "value")
        f.domain.execute({
          type: "discovery.configure",
          actor: "operator",
          key: randomUUID(),
          credentialRef: `env:${envKey}`,
        });
      const api = new OperatorApi(f.service, [f.root]),
        fingerprint = f.service.taskWorkspaceVisibility.bind(f.service);
      let posted = false,
        changed = false;
      const post = f.service.postOperatorComment.bind(f.service);
      f.service.postOperatorComment = async (...args) => {
        const saved = await post(...args);
        posted = true;
        return {
          ...saved,
          observation: {
            ...saved.observation!,
            reason: "NewCommentAccessValue",
          },
        };
      };
      wrapTaskExclusions(api, async (_id, run) => {
        const excluded = await run();
        if (posted && !changed) {
          changed = true;
          if (race === "reference") {
            process.env[envKey] = "NewCommentAccessValue";
            f.domain.execute({
              type: "discovery.configure",
              actor: "operator",
              key: randomUUID(),
              credentialRef: `env:${envKey}`,
            });
          } else if (race === "value")
            process.env[envKey] = "NewCommentAccessValue";
          else if (race === "instructions")
            f.domain.execute({
              type: "project.configure",
              actor: "operator",
              key: randomUUID(),
              projectId: f.projectId,
              expectedVersion: Number(f.domain.project(f.projectId).version),
              instructions: "NewCommentAccessValue",
            });
          else if (race === "task")
            f.domain.execute({
              type: "task.configure",
              projectId: f.projectId,
              actor: "operator",
              key: randomUUID(),
              taskId: f.taskId,
              expectedVersion: Number(f.domain.task(f.taskId).version),
              state: "cancelled",
            });
          else
            f.service.taskWorkspaceVisibility = (id) =>
              `${fingerprint(id)}-changed`;
        }
        return excluded;
      });
      await assert.rejects(api.execute(send(f)), { status: 409 });
      assert.equal(changed, true);
      assert.equal(
        f.effects.length,
        1,
        "receipt rejection must not resend the provider effect",
      );
    });
  }
});

test("definite operator comment rejections are typed 409/403, never an unknown outcome", async (t) => {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]);
  const review = async (body = "Reviewed comment") => {
    const key = randomUUID();
    const r = await api.execute({
      type: "comment.review",
      key,
      taskId: f.taskId,
      operationId: key,
      expectedTaskVersion: Number(f.domain.task(f.taskId).version),
      body,
    });
    if (r.kind !== "comment-review") assert.fail("review receipt absent");
    return r;
  };
  const confirm = (
    r: { reviewId: string; revision: number; materialHash: string },
    decision: "approved" | "denied" = "approved",
  ) => ({
    type: "comment.confirm" as const,
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: r.reviewId,
    expectedRevision: r.revision,
    materialHash: r.materialHash,
    decision,
  });
  const rejects = async (
    name: string,
    command: unknown,
    status: number,
    reviewId?: string,
  ) => {
    const effects = f.effects.length,
      before = reviewId && f.service.delivery().operatorReview(reviewId);
    await assert.rejects(
      api.execute(command),
      (error: { status?: number; code?: string }) => {
        assert.equal(error.status, status, name);
        assert.equal(
          error.code,
          status === 409 ? "conflict" : "forbidden",
          name,
        );
        return true;
      },
    );
    assert.equal(f.effects.length, effects, name);
    if (reviewId)
      assert.deepEqual(
        f.service.delivery().operatorReview(reviewId),
        before,
        name,
      );
  };
  policy(f, "approval");
  const r = await review();
  await rejects(
    "wrong hash",
    { ...confirm(r), materialHash: "0".repeat(64) },
    409,
    r.reviewId,
  );
  await rejects(
    "wrong revision",
    { ...confirm(r), expectedRevision: r.revision + 1 },
    409,
    r.reviewId,
  );
  const first = confirm(r);
  const approved = await api.execute(first);
  await rejects("second confirm", confirm(r), 409, r.reviewId);
  const version = Number(f.domain.task(f.taskId).version);
  await rejects(
    "stale review",
    {
      type: "comment.review",
      key: randomUUID(),
      taskId: f.taskId,
      operationId: randomUUID(),
      expectedTaskVersion: version + 5,
      body: "x",
    },
    409,
  );
  await rejects(
    "stale send",
    { ...send(f), expectedTaskVersion: version + 5 },
    409,
  );
  await rejects(
    "review key reuse",
    {
      type: "comment.review",
      key: r.reviewId,
      taskId: f.taskId,
      operationId: r.reviewId,
      expectedTaskVersion: version,
      body: "Another body",
    },
    409,
    r.reviewId,
  );
  const sent = await api.execute({
    ...send(f, "Reviewed comment", r.reviewId),
    reviewId: r.reviewId,
  });
  assert.equal(sent.kind === "delivery" && sent.state, "confirmed-success");
  await rejects(
    "send key reuse",
    { ...send(f, "Another body", r.reviewId), reviewId: r.reviewId },
    409,
  );
  // Unchanged: exact replays return their original receipts.
  assert.deepEqual(await api.execute(first), approved);
  assert.deepEqual(
    await api.execute({
      ...send(f, "Reviewed comment", r.reviewId),
      reviewId: r.reviewId,
    }),
    sent,
  );
  // No grant when reviewed: an approval is forbidden, a denial still records.
  policy(f, null);
  const ungranted = await review("No grant");
  await rejects("no grant", confirm(ungranted), 403, ungranted.reviewId);
  assert.equal(
    (await api.execute(confirm(ungranted, "denied"))).kind,
    "comment-review",
  );
  policy(f, "approval");
  const changed = await review("Policy changes");
  policy(f, "approval");
  await rejects("policy changed", confirm(changed), 409, changed.reviewId);
  const held = await review("Held");
  await f.service.stopTask(f.taskId);
  await rejects("task stopped", confirm(held), 409, held.reviewId);
  assert.equal(f.effects.length, 1);
});

test("operator comments on a local task are a definite conflict", async (t) => {
  const f = await deliveryFixture("reviewable-pr", false);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]);
  const key = randomUUID();
  for (const command of [
    {
      type: "comment.review",
      key,
      taskId: f.taskId,
      operationId: key,
      expectedTaskVersion: Number(f.domain.task(f.taskId).version),
      body: "Local",
    },
    send(f, "Local"),
  ])
    await assert.rejects(api.execute(command), {
      status: 409,
      code: "conflict",
    });
  assert.equal(f.effects.length, 0);
  // A delivery refresh without a running coordinator stays an unknown outcome.
  await f.service.stop();
  await assert.rejects(
    api.execute({
      type: "delivery.refresh",
      key: randomUUID(),
      taskId: f.taskId,
    }),
    { status: 503, code: "command-outcome-unknown" },
  );
});
