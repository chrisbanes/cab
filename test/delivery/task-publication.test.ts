import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DomainConflictError } from "../../src/core/domain-errors.js";
import {
  fieldReady,
  labelAndFieldReady,
  marker,
  publicationFixture,
  publicationProject,
} from "../fixtures/task-publication.js";
import { startedOf } from "../fixtures/service-internals.js";

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
const imported = (f: Fixture, taskId: string) =>
  f.domain().importedTask(taskId);
const issueOf = (f: Fixture, taskId: string) => {
  const row = imported(f, taskId);
  return row ? f.service.githubSources().issue(String(row.nodeId)) : undefined;
};
const holds = (f: Fixture, taskId: string) =>
  f.service
    .githubSources()
    .activeHolds()
    .filter((h) => h.taskId === taskId)
    .map((h) => h.reason);

test("a Draft task published to a repository becomes the issue's imported task and the sync imports no second one", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const taskId = f.task(false);
  const before = f.taskCount();
  const { review, sent } = await f.publish(taskId);
  assert.equal(sent.state, "converted");
  // One create, with no readiness label: a Draft task is not made Ready.
  assert.equal(f.gh.posts, 1);
  const created = f.gh.byMarker(review.publicationId);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]?.labels, []);
  assert.equal(created[0]?.body, `Do it\n\n${marker(review.publicationId)}`);
  // The same task gains the issue's identity and stays a Draft.
  assert.equal(String(imported(f, taskId)?.nodeId), created[0]?.nodeId);
  assert.equal(Boolean(f.domain().task(taskId).ready), false);
  assert.equal(issueOf(f, taskId)?.issueNumber, created[0]?.number);
  await f.service.refreshGitHub();
  assert.equal(f.taskCount(), before);
  assert.equal(f.gh.posts, 1);
  const review2 = f.service.githubSources().review(String(created[0]?.nodeId));
  assert.equal(review2?.observedDigest, review2?.acceptedDigest);
  assert.ok(
    !f.service
      .domain()
      .admission(taskId)
      .reasons.includes("source-review-required"),
  );
});

test("a Ready task published to a repository carries the readiness label and stays Ready after the sync", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const taskId = f.task(true);
  const { review, sent } = await f.publish(taskId);
  assert.equal(sent.state, "converted");
  assert.deepEqual(f.gh.byMarker(review.publicationId)[0]?.labels, ["ready"]);
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
  const before = f.taskCount();
  await f.service.refreshGitHub();
  assert.equal(f.taskCount(), before);
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
  assert.deepEqual(holds(f, taskId), []);
});

test("a Ready task published to a Project records the create, the item and the field in order, then converts", async (t) => {
  const f = await publicationFixture({
    selections: ["project"],
    readiness: labelAndFieldReady,
  });
  t.after(() => f.close());
  const taskId = f.task(true);
  const { review, sent } = await f.publish(taskId, "project");
  assert.equal(sent.state, "converted");
  assert.deepEqual(f.gh.order, [
    "issue.create",
    "project.item.add",
    "project.field",
  ]);
  const issue = f.gh.byMarker(review.publicationId)[0];
  assert.equal(
    issue?.fields.get(
      `${publicationProject.projectNodeId}/${publicationProject.fieldNodeId}`,
    ),
    publicationProject.ready,
  );
  const stored = f.service
    .githubSources()
    .membershipItem(f.projectId, "project", String(issue?.nodeId));
  assert.deepEqual(stored?.projectFields, [
    {
      projectNodeId: publicationProject.projectNodeId,
      fieldNodeId: publicationProject.fieldNodeId,
      optionNodeId: publicationProject.ready,
    },
  ]);
  await f.service.refreshGitHub();
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
  assert.deepEqual(holds(f, taskId), []);
  assert.equal(f.taskCount(), 1);
});

for (const mode of ["rejected", "uncertain"] as const)
  test(`with the Project item add ${mode}, the task converts and the second consecutive complete sync holds it as withdrawn`, async (t) => {
    const f = await publicationFixture({
      selections: ["project"],
      readiness: labelAndFieldReady,
    });
    t.after(() => f.close());
    f.gh.itemMode = mode;
    const taskId = f.task(true);
    const { sent } = await f.publish(taskId, "project");
    assert.equal(sent.state, "converted");
    // No field is written to an item that is not known to exist.
    assert.deepEqual(f.gh.order, ["issue.create", "project.item.add"]);
    assert.ok(imported(f, taskId));
    // One complete read that omits it is forgiven, as GitHub's lists trail a create.
    await f.service.refreshGitHub();
    assert.deepEqual(holds(f, taskId), []);
    assert.equal(Boolean(f.domain().task(taskId).ready), true);
    await f.service.refreshGitHub();
    assert.deepEqual(holds(f, taskId), ["withdrawn"]);
    assert.equal(f.taskCount(), 1);
  });

test("a started task, a missing grant, local edges as a dependent and unpredictable selections are refused with their codes", async (t) => {
  const f = await publicationFixture({
    selections: ["repo", "project", "search", "filtered"],
  });
  t.after(() => f.close());
  const taskId = f.task(true);
  const blocker = f.task(true, "Blocker");
  const dependent = f.task(true, "Dependent");
  const codes = () => {
    const a = f.service.publicationAvailability(taskId);
    return {
      task: a.reasonCode,
      targets: Object.fromEntries(
        a.targets.map((x) => [
          `${x.selectionId}:${x.repositoryId}`,
          x.reasonCode,
        ]),
      ),
    };
  };
  assert.deepEqual(codes().targets, {
    "repo:R1": null,
    "project:R1": null,
    "search:null": "selection-unpredictable",
    "filtered:null": "selection-unpredictable",
  });
  // A task that blocks others may still be published.
  f.domain().execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    taskId: dependent,
    blockerTaskId: taskId,
    expectedVersion: f.version(dependent),
  });
  assert.equal(codes().task, null);
  f.domain().execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    taskId,
    blockerTaskId: blocker,
    expectedVersion: f.version(taskId),
  });
  assert.equal(codes().task, "local-dependencies");
  f.domain().execute({
    type: "dependency.remove",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    taskId,
    blockerTaskId: blocker,
    expectedVersion: f.version(taskId),
  });
  assert.equal(codes().task, null);
  startedOf(f.service).workspaceBindings.createOrGet(
    taskId,
    randomUUID(),
    "/tmp/ws",
    [],
  );
  assert.equal(codes().task, "task-started");
  assert.throws(
    () =>
      f.service.reviewTaskPublication({
        key: randomUUID(),
        taskId,
        targetId: f.target(blocker, "repo").id,
        expectedTaskVersion: f.version(taskId),
      }),
    DomainConflictError,
  );
  // Without the grants, each target says which one is missing.
  const bare = f.task(true, "Bare");
  f.configureGrants(["field"]);
  assert.equal(f.target(bare, "repo").reasonCode, "no-create-grant");
  f.configureGrants(["create"]);
  assert.equal(f.target(bare, "repo").reasonCode, null);
  assert.equal(f.target(bare, "project").reasonCode, "no-item-grant");
  assert.throws(
    () =>
      f.service.reviewTaskPublication({
        key: randomUUID(),
        taskId: bare,
        targetId: f.target(bare, "project").id,
        expectedTaskVersion: f.version(bare),
      }),
    /cannot take the publication/,
  );
});

test("a Draft task is refused where the project has no readiness rule, and a field-only rule cannot be met from a repository", async (t) => {
  const none = await publicationFixture({ readiness: null });
  t.after(() => none.close());
  const draft = none.task(false);
  assert.equal(none.target(draft, "repo").reasonCode, "would-become-ready");
  assert.equal(none.target(none.task(true), "repo").reasonCode, null);
  const fieldOnly = await publicationFixture({ readiness: fieldReady });
  t.after(() => fieldOnly.close());
  assert.equal(
    fieldOnly.target(fieldOnly.task(true), "repo").reasonCode,
    "readiness-unsatisfiable",
  );
  const ready = fieldOnly.task(true);
  assert.equal(fieldOnly.target(ready, "project").reasonCode, null);
  assert.equal(
    fieldOnly.target(fieldOnly.task(false), "repo").reasonCode,
    null,
  );
});

test("an unknown create outcome holds the task, never resends, and a racing sync imports no duplicate", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost";
  f.gh.readbackVisible = false;
  const taskId = f.task(false);
  const before = f.taskCount();
  const { review, sent } = await f.publish(taskId);
  assert.equal(sent.state, "sending");
  assert.equal(f.gh.posts, 1);
  const reasons = () => f.domain().admission(taskId).reasons;
  assert.ok(reasons().includes("external-action-uncertain"));
  assert.ok(reasons().includes("task-publication-pending"));
  // GitHub lists the issue, but it belongs to the unresolved publication.
  await f.service.refreshGitHub();
  assert.equal(f.taskCount(), before);
  assert.equal(imported(f, taskId), undefined);
  // A restart reads back and resumes; it posts nothing.
  await f.restart();
  await f.service.refreshGitHub();
  assert.equal(f.gh.posts, 1);
  assert.equal(f.taskCount(), before);
  assert.equal(
    f.service.latestPublication(taskId)?.publication.state,
    "sending",
  );
  assert.equal(f.gh.byMarker(review.publicationId).length, 1);
});

test("a create the read-back later proves converts the task without being sent again", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost";
  const taskId = f.task(true);
  const { review } = await f.publish(taskId);
  assert.equal(
    f.service.latestPublication(taskId)?.publication.state,
    "sending",
  );
  // The index catches up.
  f.gh.byMarker(review.publicationId)[0]!.hidden = false;
  await f.service.refreshGitHub();
  assert.equal(
    f.service.latestPublication(taskId)?.publication.state,
    "converted",
  );
  assert.equal(f.gh.posts, 1);
  assert.equal(f.taskCount(), 1);
});

test("Link accepts only an issue that carries the create's marker, then converts the task", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost-unseen";
  const taskId = f.task(false);
  const { review } = await f.publish(taskId);
  assert.equal(
    f.service.latestPublication(taskId)?.publication.state,
    "sending",
  );
  const stranger = f.gh.add("Publish me", "Do it");

  await assert.rejects(
    f.service.linkTaskPublication({
      taskId,
      publicationId: review.publicationId,
      issueNumber: stranger.number,
    }),
    /marker/,
  );
  assert.equal(
    f.service.latestPublication(taskId)?.publication.state,
    "sending",
  );
  assert.ok(
    f.domain().admission(taskId).reasons.includes("external-action-uncertain"),
  );
  const real = f.gh.add(
    "Publish me",
    `Do it\n\n${marker(review.publicationId)}`,
  );
  const linked = await f.service.linkTaskPublication({
    taskId,
    publicationId: review.publicationId,
    issueNumber: real.number,
  });
  assert.equal(linked.state, "converted");
  assert.equal(String(imported(f, taskId)?.nodeId), real.nodeId);
  assert.equal(f.gh.posts, 1);
  await f.service.refreshGitHub();
  // Only the human's own issue is imported as a new task.
  assert.equal(f.taskCount(), 2);
});

test("Abandon returns the task to local and a new publish mints a new operation", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost-unseen";
  const taskId = f.task(false);
  const { review } = await f.publish(taskId);
  assert.equal(
    f.service.publicationAvailability(taskId).reasonCode,
    "publication-unresolved",
  );
  const abandoned = await f.service.abandonTaskPublication({
    taskId,
    publicationId: review.publicationId,
  });
  assert.equal(abandoned.state, "abandoned");
  assert.equal(f.service.publicationAvailability(taskId).reasonCode, null);
  assert.ok(
    !f
      .domain()
      .admission(taskId)
      .reasons.some(
        (r) =>
          r.startsWith("external-action") || r === "task-publication-pending",
      ),
  );
  // The abandoned create is neither retried nor read again.
  await f.service.refreshGitHub();
  assert.equal(f.gh.posts, 1);
  f.gh.createMode = "ok";
  const again = await f.publish(taskId);
  assert.notEqual(again.review.publicationId, review.publicationId);
  assert.equal(again.sent.state, "converted");
  assert.equal(f.gh.posts, 2);
});

test("title, outcome, Ready and local dependencies are frozen while a publication is unresolved", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost-unseen";
  const taskId = f.task(false);
  const other = f.task(false, "Other");
  await f.publish(taskId);
  for (const change of [{ title: "New" }, { outcome: "New" }, { ready: true }])
    assert.throws(
      () =>
        f.domain().execute({
          type: "task.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: f.projectId,
          taskId,
          expectedVersion: f.version(taskId),
          ...change,
        }),
      /being published/,
    );
  assert.throws(
    () =>
      f.domain().execute({
        type: "dependency.add",
        actor: "operator",
        key: randomUUID(),
        projectId: f.projectId,
        taskId,
        blockerTaskId: other,
        expectedVersion: f.version(taskId),
      }),
    /being published/,
  );
});

test("a confirmed failure of the create leaves the task local and publishable", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "rejected";
  const taskId = f.task(false);
  const { sent } = await f.publish(taskId);
  assert.equal(sent.state, "failed");
  assert.equal(imported(f, taskId), undefined);
  assert.equal(f.service.publicationAvailability(taskId).reasonCode, null);
});

test("a changed review, an approval-less send and an agent confirm nothing", async (t) => {
  const f = await publicationFixture({ mode: "approval" });
  t.after(() => f.close());
  const taskId = f.task(false);
  const review = f.service.reviewTaskPublication({
    key: randomUUID(),
    taskId,
    targetId: f.target(taskId, "repo").id,
    expectedTaskVersion: f.version(taskId),
  });
  // A replay of the review answers from the stored one; the same key with other material conflicts.
  assert.equal(
    f.service.reviewTaskPublication({
      key: review.publicationId,
      taskId,
      targetId: f.target(taskId, "repo").id,
      expectedTaskVersion: f.version(taskId),
    }).materialHash,
    review.materialHash,
  );
  assert.throws(
    () =>
      f.service.reviewTaskPublication({
        key: review.publicationId,
        taskId,
        targetId: f.target(taskId, "project").id,
        expectedTaskVersion: f.version(taskId),
      }),
    /different material/,
  );
  await assert.rejects(
    f.service.sendTaskPublication({
      taskId,
      publicationId: review.publicationId,
      expectedTaskVersion: f.version(taskId),
    }),
    /not approved/,
  );
  assert.throws(
    () =>
      f.service.confirmTaskPublication({
        key: randomUUID(),
        taskId,
        reviewId: review.publicationId,
        expectedRevision: review.revision,
        materialHash: "0".repeat(64),
        decision: "approved",
      }),
    /mismatch/,
  );
  // The confirmed review is the approval, though the grant itself needs one.
  f.service.confirmTaskPublication({
    key: randomUUID(),
    taskId,
    reviewId: review.publicationId,
    expectedRevision: review.revision,
    materialHash: review.materialHash,
    decision: "approved",
  });
  const sent = await f.service.sendTaskPublication({
    taskId,
    publicationId: review.publicationId,
    expectedTaskVersion: f.version(taskId),
  });
  assert.equal(sent.state, "converted");
  assert.equal(f.gh.posts, 1);
  // A replay of the send returns where it ended and posts nothing.
  assert.equal(
    (
      await f.service.sendTaskPublication({
        taskId,
        publicationId: review.publicationId,
        expectedTaskVersion: f.version(taskId),
      })
    ).state,
    "converted",
  );
  assert.equal(f.gh.posts, 1);
});

test("a review moved by an edit or by changed grants is refused at confirm, and a denial sends nothing", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const taskId = f.task(false);
  const review = () =>
    f.service.reviewTaskPublication({
      key: randomUUID(),
      taskId,
      targetId: f.target(taskId, "repo").id,
      expectedTaskVersion: f.version(taskId),
    });
  const confirm = (
    r: ReturnType<typeof review>,
    decision: "approved" | "denied",
  ) =>
    f.service.confirmTaskPublication({
      key: randomUUID(),
      taskId,
      reviewId: r.publicationId,
      expectedRevision: r.revision,
      materialHash: r.materialHash,
      decision,
    });
  const edited = review();
  f.domain().execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    taskId,
    expectedVersion: f.version(taskId),
    title: "Edited",
  });
  assert.throws(() => confirm(edited, "approved"), /material changed/);
  const regranted = review();
  f.configureGrants(["create", "item", "field"]);
  assert.throws(() => confirm(regranted, "approved"), /material changed/);
  const denied = review();
  assert.equal(confirm(denied, "denied").decision, "denied");
  await assert.rejects(
    f.service.sendTaskPublication({
      taskId,
      publicationId: denied.publicationId,
      expectedTaskVersion: f.version(taskId),
    }),
    /not approved/,
  );
  assert.equal(f.gh.posts, 0);
});

test("Abandon waits for a read-back already in flight and the abandoned create stays resolved", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost-unseen";
  const taskId = f.task(false);
  const { review } = await f.publish(taskId);
  let release = () => {};
  f.gh.inspectGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // A refresh reads the unproved create back; Abandon arrives while that read is open.
  const refreshing = f.service.refreshGitHub();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const abandoning = f.service.abandonTaskPublication({
    taskId,
    publicationId: review.publicationId,
  });
  release();
  await refreshing;
  assert.equal((await abandoning).state, "abandoned");
  const create = f.service
    .delivery()
    .actions(taskId)
    .find((a) => a.operationId === review.publicationId);
  assert.equal(create?.state, "confirmed-failure");
  assert.equal(f.service.publicationAvailability(taskId).reasonCode, null);
  assert.ok(
    !f
      .domain()
      .admission(taskId)
      .reasons.some((r) => r.startsWith("external-action")),
  );
  // A replay of Abandon answers where it is.
  assert.equal(
    (
      await f.service.abandonTaskPublication({
        taskId,
        publicationId: review.publicationId,
      })
    ).state,
    "abandoned",
  );
});

test("an issue edited on GitHub between the create and the conversion is still the publication's, not a new task", async (t) => {
  const f = await publicationFixture({
    selections: ["repo", "project"],
    readiness: labelAndFieldReady,
  });
  t.after(() => f.close());
  const taskId = f.task(true);
  f.gh.beforeItemAdd = async () => {
    // The marker is edited away, and a sync runs before the item add and the conversion.
    const issue = [...f.gh.issues.values()][0];
    if (issue) issue.body = "Edited by a human";
    await startedOf(f.service).githubSynchronizer.refresh();
  };
  const { sent } = await f.publish(taskId, "project");
  assert.equal(sent.state, "converted");
  assert.equal(f.taskCount(), 1);
});

test("a publication key that already names a delivery operation is refused before anything is recorded", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const first = f.task(true);
  const { review } = await f.publish(first, "project");
  const second = f.task(false, "Second");
  assert.throws(
    () =>
      f.service.reviewTaskPublication({
        key: review.item?.operationId ?? "",
        taskId: second,
        targetId: f.target(second, "repo").id,
        expectedTaskVersion: f.version(second),
      }),
    /already in use/,
  );
  assert.equal(f.service.latestPublication(second), null);
});

test("Link asks for the readiness label and the credential user's authorship, as the read-back does", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  f.gh.createMode = "lost-unseen";
  const taskId = f.task(true);
  const { review } = await f.publish(taskId);
  const unlabelled = f.gh.add(
    "Publish me",
    `Do it\n\n${marker(review.publicationId)}`,
  );
  await assert.rejects(
    f.service.linkTaskPublication({
      taskId,
      publicationId: review.publicationId,
      issueNumber: unlabelled.number,
    }),
    /marker/,
  );
  unlabelled.labels.push("ready");
  const linked = await f.service.linkTaskPublication({
    taskId,
    publicationId: review.publicationId,
    issueNumber: unlabelled.number,
  });
  assert.equal(linked.state, "converted");
  // A replay of the link answers where it is.
  assert.equal(
    (
      await f.service.linkTaskPublication({
        taskId,
        publicationId: review.publicationId,
        issueNumber: unlabelled.number,
      })
    ).state,
    "converted",
  );
});

test("a list that trails the create keeps the task Ready, and a later read clears nothing it should keep", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const taskId = f.task(true);
  await f.publish(taskId);
  const shown = f.gh.snapshots.bind(f.gh);
  // The first complete read after the conversion does not list the new issue yet.
  f.gh.snapshots = () => [];
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), []);
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
  f.gh.snapshots = shown;
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), []);
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
  assert.equal(f.taskCount(), 1);
  // Having been listed, it is an ordinary member: one omission now withdraws it, and a listing
  // afterwards leaves that hold for the operator, as on any imported task.
  f.gh.snapshots = () => [];
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
  f.gh.snapshots = shown;
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
});

test("two consecutive omissions withdraw a just-published task, and a later listing releases only that hold", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const taskId = f.task(true);
  await f.publish(taskId);
  const shown = f.gh.snapshots.bind(f.gh);
  f.gh.snapshots = () => [];
  await f.service.refreshGitHub();
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
  assert.equal(Boolean(f.domain().task(taskId).ready), false);
  f.gh.snapshots = shown;
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), []);
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
});

test("an imported issue that is not just published is withdrawn by the first omission and keeps its hold", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const human = f.gh.add("Human", "Made by hand", ["ready"]);
  await f.service.refreshGitHub();
  const imported = f.service.githubSources().issue(human.nodeId);
  assert.ok(imported);
  const taskId = String(imported?.taskId);
  const shown = f.gh.snapshots.bind(f.gh);
  f.gh.snapshots = () => [];
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
  f.gh.snapshots = shown;
  await f.service.refreshGitHub();
  // Today's behaviour on any imported task: the operator resolves the hold.
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
});

test("a flag left by two lagging reads cannot release a later ordinary withdrawal", async (t) => {
  const f = await publicationFixture();
  t.after(() => f.close());
  const taskId = f.task(true);
  const { review } = await f.publish(taskId);
  const issue = f.gh.byMarker(review.publicationId)[0];
  assert.ok(issue);
  const shown = f.gh.snapshots.bind(f.gh);
  // Two omissions withdraw it.
  f.gh.snapshots = () => [];
  await f.service.refreshGitHub();
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
  // It is listed again without its readiness label, so the task is not Ready and nothing is released.
  f.gh.snapshots = shown;
  issue.labels = [];
  await f.service.refreshGitHub();
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
  // An ordinary omission, then a Ready listing: the hold stays for the operator.
  f.gh.snapshots = () => [];
  await f.service.refreshGitHub();
  f.gh.snapshots = shown;
  issue.labels = ["ready"];
  await f.service.refreshGitHub();
  assert.equal(Boolean(f.domain().task(taskId).ready), true);
  assert.deepEqual(holds(f, taskId), ["withdrawn"]);
});
