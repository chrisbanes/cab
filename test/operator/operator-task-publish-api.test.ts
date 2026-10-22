import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DomainConflictError } from "../../src/core/domain-errors.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { publicationFixture } from "../fixtures/task-publication.js";

/** A definite refusal of changed state: the service's conflict, or its 409. */
const conflict = (error: unknown) =>
  error instanceof DomainConflictError ||
  (error instanceof OperatorApiError && error.status === 409);

async function world(
  t: { after: (fn: () => unknown) => void },
  options: Parameters<typeof publicationFixture>[0] = {},
) {
  const f = await publicationFixture(options);
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.root]);
  const reviewCommand = (taskId: string, selectionId = "repo") => ({
    type: "task.publish.review" as const,
    key: randomUUID(),
    taskId,
    targetId: f.target(taskId, selectionId).id,
    expectedTaskVersion: f.version(taskId),
  });
  const confirmCommand = (
    review: {
      taskId: string;
      reviewId: string;
      revision: number;
      materialHash: string;
    },
    decision: "approved" | "denied" = "approved",
  ) => ({
    type: "task.publish.confirm" as const,
    key: randomUUID(),
    taskId: review.taskId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision,
  });
  return { f, api, reviewCommand, confirmCommand };
}

test("review, confirm and send a publication; every command replays by key and other content under a key conflicts", async (t) => {
  const { f, api, reviewCommand, confirmCommand } = await world(t);
  const taskId = f.task(true, "Ship it", "Do the work");
  const review = reviewCommand(taskId);
  const reviewed = await api.execute(review);
  assert.equal(reviewed.kind, "publication-review");
  if (reviewed.kind !== "publication-review")
    return assert.fail("not a review");
  // The confirm step names the repository, the text that becomes the issue and what it writes.
  assert.equal(reviewed.repository, "org/repo");
  assert.equal(reviewed.title, "Ship it");
  assert.equal(reviewed.body, "Do the work");
  assert.deepEqual(reviewed.labels, ["ready"]);
  assert.equal(reviewed.addsToProject, false);
  assert.equal(reviewed.predictedSelected, true);
  assert.equal(reviewed.predictedReady, true);
  assert.equal(reviewed.decision, "pending");
  assert.deepEqual(await api.execute(review), reviewed);
  await assert.rejects(
    api.execute({ ...review, targetId: f.target(taskId, "project").id }),
    conflict,
  );

  const confirm = confirmCommand(reviewed);
  const approved = await api.execute(confirm);
  assert.equal(
    approved.kind === "publication-review" && approved.decision,
    "approved",
  );
  assert.deepEqual(await api.execute(confirm), approved);
  await assert.rejects(
    api.execute({ ...confirm, decision: "denied" }),
    conflict,
  );

  const send = {
    type: "task.publish.send" as const,
    key: randomUUID(),
    taskId,
    reviewId: reviewed.reviewId,
    expectedTaskVersion: f.version(taskId),
  };
  const sent = await api.execute(send);
  assert.equal(sent.kind, "publication");
  if (sent.kind !== "publication") return assert.fail("not a publication");
  assert.equal(sent.state, "converted");
  assert.equal(sent.issueNumber, 1);
  assert.deepEqual(
    sent.steps.map((s) => [s.kind, s.state]),
    [["issue.create", "confirmed-success"]],
  );
  // A replay answers where it ended and sends nothing more.
  assert.equal((await api.execute(send)).kind, "publication");
  assert.equal(f.gh.posts, 1);
});

test("a denied review sends nothing, and Link and Abandon act on an unknown create", async (t) => {
  const { f, api, reviewCommand, confirmCommand } = await world(t);
  const taskId = f.task(false);
  const reviewed = await api.execute(reviewCommand(taskId));
  assert.equal(reviewed.kind, "publication-review");
  if (reviewed.kind !== "publication-review") return;
  const denied = await api.execute(confirmCommand(reviewed, "denied"));
  assert.equal(
    denied.kind === "publication-review" && denied.decision,
    "denied",
  );
  await assert.rejects(
    api.execute({
      type: "task.publish.send",
      key: randomUUID(),
      taskId,
      reviewId: reviewed.reviewId,
      expectedTaskVersion: f.version(taskId),
    }),
    conflict,
  );
  assert.equal(f.gh.posts, 0);

  f.gh.createMode = "lost-unseen";
  const second = await api.execute(reviewCommand(taskId));
  if (second.kind !== "publication-review") return assert.fail("not a review");
  await api.execute(confirmCommand(second));
  const sent = await api.execute({
    type: "task.publish.send",
    key: randomUUID(),
    taskId,
    reviewId: second.reviewId,
    expectedTaskVersion: f.version(taskId),
  });
  assert.equal(sent.kind === "publication" && sent.state, "sending");
  assert.equal(
    sent.kind === "publication" && sent.steps[0]?.state,
    "uncertain",
  );
  // The task read shows the pending publication with its uncertain create.
  const read = (await api.readTask(taskId)).data.publication;
  assert.equal(read?.available, false);
  assert.equal(read?.reasonCode, "publication-unresolved");
  assert.equal(read?.latest?.state, "sending");
  assert.equal(read?.latest?.steps[0]?.state, "uncertain");
  // A named issue without the marker is refused and nothing changes.
  const stranger = f.gh.add("x", "no marker");
  await assert.rejects(
    api.execute({
      type: "task.publish.link",
      key: randomUUID(),
      taskId,
      reviewId: second.reviewId,
      issueNumber: stranger.number,
    }),
    conflict,
  );
  const abandon = {
    type: "task.publish.abandon" as const,
    key: randomUUID(),
    taskId,
    reviewId: second.reviewId,
  };
  const abandoned = await api.execute(abandon);
  // A retry of the same command after a lost answer is answered, not refused.
  assert.deepEqual(await api.execute(abandon), abandoned);
  assert.equal(
    abandoned.kind === "publication" && abandoned.state,
    "abandoned",
  );
  assert.equal((await api.readTask(taskId)).data.publication?.available, true);
});

test("the task read reports where a task can be published, the first reason in order, and disabled targets", async (t) => {
  const { f, api } = await world(t, {
    selections: ["repo", "project", "search", "filtered"],
    grants: ["create"],
  });
  const taskId = f.task(true);
  const policy = async () => (await api.readTask(taskId)).data.publication;
  const read = await policy();
  assert.equal(read?.available, true);
  assert.equal(read?.reasonCode, null);
  const by = (id: string) => read?.targets.find((x) => x.id.startsWith(id));
  assert.equal(by("repo~")?.enabled, true);
  assert.deepEqual(by("repo~")?.labels, ["ready"]);
  assert.equal(by("project~")?.reasonCode, "no-item-grant");
  assert.match(String(by("project~")?.reason), /GitHub Project/);
  assert.equal(by("search~")?.reasonCode, "selection-unpredictable");
  assert.equal(by("filtered~")?.reasonCode, "selection-unpredictable");
  assert.equal(by("repo~")?.predictedSelected, true);
  assert.equal(by("repo~")?.predictedReady, true);
  // Once published, the task is an imported one and says so.
  f.configureGrants(["create"]);
  await f.publish(taskId);
  const after = await policy();
  assert.equal(after?.reasonCode, "task-imported");
  assert.deepEqual(after?.targets, []);
  assert.equal(after?.latest?.state, "converted");
});

test("text the exclusions would change cannot be published", async (t) => {
  const { f, api, reviewCommand } = await world(t);
  // The data directory is a private path.
  const taskId = f.task(false, "Leak", `See ${f.root}/data`);
  await assert.rejects(api.execute(reviewCommand(taskId)), /forbidden/);
  assert.equal(f.gh.posts, 0);
  // Nothing was recorded, so the task is still publishable once its text is clean.
  assert.equal(f.service.latestPublication(taskId), null);
});

test("a runtime actor and a stale task version are refused", async (t) => {
  const { f, api, reviewCommand } = await world(t);
  const taskId = f.task(false);
  const review = reviewCommand(taskId);
  await assert.rejects(api.execute({ ...review, actor: "runtime" }));
  await assert.rejects(
    api.execute({
      ...review,
      expectedTaskVersion: review.expectedTaskVersion + 1,
    }),
    conflict,
  );
  assert.equal(f.gh.posts, 0);
});
