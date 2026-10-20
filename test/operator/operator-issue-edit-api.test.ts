import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DomainConflictError } from "../../src/core/domain-errors.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { deliveryFixture } from "../fixtures/delivery-fixture.js";
import { startedOf } from "../fixtures/service-internals.js";

type Fixture = Awaited<ReturnType<typeof deliveryFixture>>;
/** A definite refusal of changed state: the service's conflict, or its 409. */
const conflict = (error: unknown) =>
  error instanceof DomainConflictError ||
  (error instanceof OperatorApiError && error.status === 409);
const credentialName = "FIXTURE_ISSUE_EDIT_CREDENTIAL";
const edit = { title: "Better title", body: "A body an implementer can use" };

/** An imported task with an issue.edit grant and a delivery credential. */
async function world(
  t: { after: (fn: () => unknown) => void },
  options: { grant?: boolean; credential?: boolean } = {},
) {
  const f = await deliveryFixture("reviewable-pr", true);
  t.after(() => f.close());
  process.env[credentialName] = `fixture-${randomUUID()}`;
  t.after(() => {
    delete process.env[credentialName];
  });
  const configure = (grant: boolean, credential: boolean) =>
    f.service.domain().execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: f.service.delivery().configuration(f.projectId).version,
      mode: "reviewable-pr",
      credentialRef: credential ? `env:${credentialName}` : null,
      grants: grant
        ? [{ action: "issue.edit", repositoryId: "R1", mode: "allow" }]
        : [],
      requiredChecks: [],
    });
  configure(options.grant ?? true, options.credential ?? true);
  const api = new OperatorApi(f.service, [f.root]);
  return { f, api, configure };
}

const version = (f: Fixture) =>
  Number(f.service.domain().task(f.taskId).version);

/** A used draft of the task, as the store would hold it after the operator loaded it. */
function usedRun(
  f: Fixture,
  over: { taskId?: string; kind?: "issue" | "brief" } = {},
) {
  const drafting = startedOf(f.service).drafting;
  const runId = randomUUID();
  drafting.create({
    runId,
    projectId: f.projectId,
    idea: over.kind === "brief" ? "an idea" : "",
    harness: "codex",
    profileId: f.profileId,
    profileRevision: 1,
    instructionsRevision: 1,
    ...(over.kind === "brief"
      ? {}
      : {
          issue: {
            taskId: over.taskId ?? f.taskId,
            sourceNodeId: "I1",
            observedTitle: "T",
            observedBody: "O",
          },
        }),
  });
  drafting.transition(runId, "running");
  drafting.recordProposal(
    runId,
    over.kind === "brief"
      ? { title: "t", outcome: "o" }
      : { title: edit.title, body: edit.body },
  );
  drafting.transition(runId, "proposed");
  drafting.transition(runId, "accepted");
  return runId;
}

const reviewCommand = (f: Fixture, runId: string) => ({
  type: "issue.edit.review" as const,
  key: randomUUID(),
  taskId: f.taskId,
  runId,
  operationId: randomUUID(),
  expectedTaskVersion: version(f),
  ...edit,
});

test("review, confirm and send an issue edit; every command replays by key and other content under a key conflicts", async (t) => {
  const { f, api } = await world(t);
  f.applyIssueEdits(true);
  const review = reviewCommand(f, usedRun(f));
  const reviewed = await api.execute(review);
  assert.equal(reviewed.kind, "edit-review");
  if (reviewed.kind !== "edit-review") return assert.fail("not a review");
  assert.deepEqual(reviewed.current, { title: "T", body: "O" });
  assert.deepEqual(reviewed.proposed, edit);
  assert.equal(reviewed.decision, "pending");
  assert.deepEqual(await api.execute(review), reviewed);
  await assert.rejects(api.execute({ ...review, title: "Other" }), conflict);

  const confirm = {
    type: "issue.edit.confirm" as const,
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: reviewed.reviewId,
    expectedRevision: reviewed.revision,
    materialHash: reviewed.materialHash,
    decision: "approved" as const,
  };
  const approved = await api.execute(confirm);
  assert.equal(
    approved.kind === "edit-review" && approved.decision,
    "approved",
  );
  assert.deepEqual(await api.execute(confirm), approved);

  const send = {
    type: "issue.edit.send" as const,
    key: reviewed.operationId,
    taskId: f.taskId,
    reviewId: reviewed.reviewId,
    expectedTaskVersion: version(f),
  };
  const sent = await api.execute(send);
  assert.equal(sent.kind === "delivery" && sent.state, "confirmed-success");
  assert.deepEqual(await api.execute(send), sent);
  assert.equal(f.effects.length, 1);
  // The key of a send is its review's operation id and no other.
  await assert.rejects(api.execute({ ...send, key: randomUUID() }), conflict);
  assert.equal(f.effects.length, 1);
});

test("a runtime actor, a spoofed target and a draft that is not this task's are refused", async (t) => {
  const { f, api } = await world(t);
  const review = reviewCommand(f, usedRun(f));
  await assert.rejects(api.execute({ ...review, actor: "runtime" }));
  await assert.rejects(api.execute({ ...review, target: { nodeId: "I2" } }));
  await assert.rejects(
    api.execute({ ...review, runId: randomUUID() }),
    conflict,
  );
  await assert.rejects(
    api.execute({ ...review, runId: usedRun(f, { kind: "brief" }) }),
    conflict,
  );
  await assert.rejects(
    api.execute({ ...review, runId: usedRun(f, { taskId: randomUUID() }) }),
    conflict,
  );
  assert.equal(f.effects.length, 0);
});

test("a stale synced copy is a definite conflict and a hidden current text is refused", async (t) => {
  const { f, api } = await world(t);
  const runId = usedRun(f);
  f.setSourceBody("Changed on GitHub");
  await f.service.refreshGitHub();
  await assert.rejects(api.execute(reviewCommand(f, runId)), conflict);
  assert.equal(f.effects.length, 0);
});

test("text the exclusions would change cannot be reviewed", async (t) => {
  const { f, api } = await world(t);
  const runId = usedRun(f);
  // The data directory is a private path.
  const leaky = { ...reviewCommand(f, runId), body: `See ${f.root}/data` };
  await assert.rejects(api.execute(leaky), /forbidden/);
  assert.equal(f.effects.length, 0);
});

test("the task read reports whether an edit is possible, the first reason in order, and the newest edit", async (t) => {
  const { f, api, configure } = await world(t, {
    grant: false,
    credential: false,
  });
  const policy = async () => (await api.readTask(f.taskId)).data.issueEdit;
  // No grant outranks no credential.
  assert.equal((await policy())?.reasonCode, "no-edit-grant");
  assert.equal((await policy())?.available, false);
  configure(true, false);
  assert.equal((await policy())?.reasonCode, "no-delivery-credential");
  configure(true, true);
  assert.deepEqual(await policy(), {
    available: true,
    reasonCode: null,
    reason: null,
    latest: null,
  });
  // An unknown outcome is shown as the latest edit and blocks another.
  f.setActionOutcome({ state: "uncertain", reason: "lost", receipt: null });
  const reviewed = await api.execute(reviewCommand(f, usedRun(f)));
  assert.equal(reviewed.kind, "edit-review");
  if (reviewed.kind !== "edit-review") return;
  await api.execute({
    type: "issue.edit.confirm",
    key: randomUUID(),
    taskId: f.taskId,
    reviewId: reviewed.reviewId,
    expectedRevision: reviewed.revision,
    materialHash: reviewed.materialHash,
    decision: "approved",
  });
  await api.execute({
    type: "issue.edit.send",
    key: reviewed.operationId,
    taskId: f.taskId,
    reviewId: reviewed.reviewId,
    expectedTaskVersion: version(f),
  });
  const after = await policy();
  assert.equal(after?.available, false);
  assert.equal(after?.reasonCode, "action-unresolved");
  assert.equal(after?.latest?.operationId, reviewed.operationId);
  assert.equal(after?.latest?.state, "uncertain");
});

test("starting a draft needs an available edit, replays by key and is fenced to the task version", async (t) => {
  const { f, api, configure } = await world(t);
  // A paused project holds the run in the queue, so no runtime turn is involved.
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    paused: true,
  });
  const start = {
    type: "issue.draft.start" as const,
    key: randomUUID(),
    runId: randomUUID(),
    taskId: f.taskId,
    expectedTaskVersion: version(f),
    note: "mention the toolbar",
  };
  const receipt = await api.execute(start);
  assert.equal(receipt.kind === "drafting" && receipt.state, "queued");
  assert.deepEqual(await api.execute(start), receipt);
  await assert.rejects(api.execute({ ...start, note: "other" }), conflict);
  const stopped = await api.execute({
    type: "drafting.stop",
    key: randomUUID(),
    runId: start.runId,
  });
  assert.equal(stopped.kind, "drafting");
  // Another start is refused when the version moved or no grant allows an edit.
  await assert.rejects(
    api.execute({
      ...start,
      key: randomUUID(),
      runId: randomUUID(),
      expectedTaskVersion: version(f) + 1,
    }),
    conflict,
  );
  configure(false, true);
  await assert.rejects(
    api.execute({
      ...start,
      key: randomUUID(),
      runId: randomUUID(),
      expectedTaskVersion: version(f),
    }),
    conflict,
  );
});

test("a start whose run already exists converges even after the task or the grant moved on", async (t) => {
  const { f, api, configure } = await world(t);
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    paused: true,
  });
  const runId = randomUUID();
  const expectedTaskVersion = version(f);
  // The run exists, as after a stop between creating it and recording its receipt.
  await f.service.startIssueDrafting({ runId, taskId: f.taskId, note: "n" });
  configure(false, true);
  const receipt = await api.execute({
    type: "issue.draft.start",
    key: randomUUID(),
    runId,
    taskId: f.taskId,
    expectedTaskVersion,
    note: "n",
  });
  assert.equal(receipt.kind === "drafting" && receipt.runId, runId);
});

test("a drafting run read says its kind and carries an issue proposal apart from a brief", async (t) => {
  const { f, api } = await world(t);
  const runId = usedRun(f);
  const read = await api.readDraftingRun(runId);
  assert.equal(read.data.kind, "issue");
  assert.equal(read.data.proposal, null);
  const brief = await api.readDraftingRun(usedRun(f, { kind: "brief" }));
  assert.equal(brief.data.kind, "brief");
  assert.equal(brief.data.issueProposal, null);
});

test("text being replaced that would have to be hidden refuses the review before it is recorded", async (t) => {
  const { f, api } = await world(t);
  f.setSourceBody(`See ${f.root}/data`);
  await f.service.refreshGitHub();
  const drafting = startedOf(f.service).drafting;
  const runId = randomUUID();
  drafting.create({
    runId,
    projectId: f.projectId,
    idea: "",
    harness: "codex",
    profileId: f.profileId,
    profileRevision: 1,
    instructionsRevision: 1,
    issue: {
      taskId: f.taskId,
      sourceNodeId: "I1",
      observedTitle: "T",
      observedBody: `See ${f.root}/data`,
    },
  });
  drafting.transition(runId, "running");
  drafting.recordProposal(runId, edit);
  drafting.transition(runId, "proposed");
  const review = reviewCommand(f, runId);
  await assert.rejects(api.execute(review), /forbidden/);
  assert.equal(f.service.delivery().operatorReview(review.key), undefined);
});
