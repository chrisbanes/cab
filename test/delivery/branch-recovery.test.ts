import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { publicationWorld, repositoryId } from "../fixtures/publication.js";
import { absentBranchHead } from "../../src/core/delivery.js";

type World = ReturnType<typeof publicationWorld>;
const branchOf = (w: World) => w.store.taskBranch(w.taskId, repositoryId);
const outside = "5".repeat(40);
/** A pushed first commit, then an outside writer moves the branch and a plain push records it. */
async function withOutsideHead(w: World, head: string | null = outside) {
  const first = w.commit();
  await w.submit("branch.push", first);
  w.remote.head = head;
  const refused = await w.submit("branch.push", w.commit());
  assert.equal(refused.observation?.reason, "branch-outside-change");
  w.wakes.length = 0;
  return first;
}
const holds = (w: World) =>
  w.store
    .completionBlockers(w.taskId, 1)
    .includes("task-branch-outside-change");

test("an approved overwrite replaces the outside head under a lease on it and resumes publishing", async (t) => {
  const w = publicationWorld(t, { approved: true });
  const first = await withOutsideHead(w);
  assert.ok(holds(w));
  const replacement = w.amend();
  const record = await w.overwrite(replacement);
  assert.equal(record.state, "confirmed-success");
  assert.equal(w.pushes.at(-1)?.lease, outside);
  assert.equal(w.remote.head, replacement);
  assert.equal(branchOf(w)?.lastPushedSha, replacement);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.ok(!holds(w));
  assert.notEqual(first, replacement);
  const next = await w.submit("branch.push", w.commit());
  assert.equal(next.state, "confirmed-success");
});

test("overwriting a deleted branch recreates it with a lease that expects it absent", async (t) => {
  const w = publicationWorld(t, { approved: true });
  await withOutsideHead(w, null);
  assert.equal(branchOf(w)?.outsideHeadSha, absentBranchHead);
  const replacement = w.commit();
  const record = await w.overwrite(replacement);
  assert.equal(record.state, "confirmed-success");
  assert.equal(w.pushes.at(-1)?.lease, null);
  assert.equal(w.remote.head, replacement);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.ok(!holds(w));
});

test("an overwrite without a current operator approval is denied even under an allow grant", async (t) => {
  const w = publicationWorld(t, { approved: false });
  await withOutsideHead(w);
  const pushes = w.pushes.length;
  const record = await w.overwrite(w.commit());
  assert.equal(record.state, "denied");
  assert.equal(record.observation?.reason, "delivery-authority-denied");
  assert.equal(w.pushes.length, pushes);
  assert.equal(branchOf(w)?.outsideHeadSha, outside);
});

test("an overwrite whose material is not the recorded outside change is denied", async (t) => {
  const w = publicationWorld(t, { approved: true });
  await withOutsideHead(w);
  const material = w.outsideMaterial();
  const commit = w.commit();
  for (const wrong of [
    { ...material, outsideHeadSha: "6".repeat(40) },
    { ...material, lastPushedSha: "7".repeat(40) },
    { ...material, lastPushedSha: null },
    { ...material, branch: "ensemble/other" },
  ])
    assert.equal((await w.overwrite(commit, wrong)).state, "denied");
  // Partial material is not an overwrite request at all.
  for (const partial of [
    { branch: material.branch },
    { outsideHeadSha: outside },
    { branch: material.branch, outsideHeadSha: outside },
  ])
    assert.throws(() => w.overwrite(commit, partial), /together/);
  assert.equal(branchOf(w)?.outsideHeadSha, outside);
});

test("a remote that moved after approval fails the overwrite, records the new head and spends the approval", async (t) => {
  const w = publicationWorld(t, { approved: true });
  await withOutsideHead(w);
  const material = w.outsideMaterial();
  const moved = "8".repeat(40);
  w.remote.head = moved;
  const pushes = w.pushes.length;
  const record = await w.overwrite(w.commit(), material);
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(w.pushes.length, pushes);
  assert.equal(branchOf(w)?.outsideHeadSha, moved);
  assert.deepEqual(
    w.wakes.map((x) => x.identity),
    [`outside-push:${repositoryId}:${moved}`],
  );
  // The same approved material no longer matches the record.
  assert.equal((await w.overwrite(w.commit(), material)).state, "denied");
});

test("a remote that moves between preflight and push is recorded, not overwritten", async (t) => {
  const w = publicationWorld(t, { approved: true });
  await withOutsideHead(w);
  const moved = "8".repeat(40);
  w.raceBeforeNextPush(moved);
  const record = await w.overwrite(w.commit());
  assert.notEqual(record.state, "confirmed-success");
  assert.equal(w.remote.head, moved);
  assert.equal(w.pushes.at(-1)?.lease, outside);
});

test("a remote back at Ensemble's last push clears the record without pushing", async (t) => {
  const w = publicationWorld(t, { approved: true });
  const first = await withOutsideHead(w);
  const material = w.outsideMaterial();
  w.remote.head = first;
  const pushes = w.pushes.length;
  const record = await w.overwrite(w.commit(), material);
  assert.equal(record.observation?.reason, "branch-outside-cleared");
  assert.equal(w.pushes.length, pushes);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.equal(branchOf(w)?.lastPushedSha, first);
  assert.ok(!holds(w));
});

test("an overwrite whose push outcome is unknown settles from the read after a restart, without a replay", async (t) => {
  const w = publicationWorld(t, { approved: true });
  await withOutsideHead(w);
  const replacement = w.amend();
  w.setPush("uncertain-applied");
  const record = await w.overwrite(replacement);
  assert.equal(record.state, "uncertain");
  assert.ok(holds(w));
  const pushes = w.pushes.length;
  await w.coordinatorFor().reconcile();
  assert.equal(w.store.action(record.operationId).state, "confirmed-success");
  assert.equal(w.pushes.length, pushes);
  assert.equal(branchOf(w)?.lastPushedSha, replacement);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.ok(!holds(w));
});

/** A real outside commit on the remote, which the lead's next commit builds on. */
async function withRealOutsideHead(w: World) {
  const first = w.commit();
  await w.submit("branch.push", first);
  const head = w.commit();
  w.remote.head = head;
  const next = w.commit();
  const refused = await w.submit("branch.push", next);
  assert.equal(refused.observation?.reason, "branch-outside-change");
  w.wakes.length = 0;
  return { first, outside: head, next };
}
const adoptWorld = (t: Parameters<typeof publicationWorld>[0]) =>
  publicationWorld(t, {
    approved: true,
    grants: ["branch.push", "branch.force-push", "branch.adopt"],
  });

test("an approved adoption records the outside head as the branch's own, settles with the PR and lets the lead push on top", async (t) => {
  const w = adoptWorld(t);
  const { outside, next } = await withRealOutsideHead(w);
  const branch = branchOf(w)?.branch ?? "";
  w.showPr(outside, branch);
  const record = await w.adoptOutside();
  assert.equal(record.state, "confirmed-success");
  assert.equal(record.observation?.receipt?.headSha, outside);
  assert.equal(branchOf(w)?.lastPushedSha, outside);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.ok(!holds(w));
  // The request carried the provisioned base and the verified branch, never a credential in the record.
  assert.equal(w.adopts.length, 1);
  assert.equal(w.adopts[0]?.baseCommit, w.base);
  assert.equal(w.adopts[0]?.commitSha, outside);
  assert.equal(w.adopts[0]?.branch, branch);
  assert.equal(JSON.stringify(record).includes("token"), false);
  // Handback settlement is evaluated against the adopted head.
  w.store.transaction(() =>
    w.store.registerPrWithinTransaction(
      w.caller,
      w.showPr(outside, branch),
      w.caller.assignmentId,
    ),
  );
  assert.ok(!holds(w));
  const delivery = w.store.delivery(w.taskId);
  assert.ok(delivery);
  const settled = await w.coordinator.settleHandback({
    actor: "operator",
    key: randomUUID(),
    taskId: w.taskId,
    expectedTaskVersion: 1,
    expectedDeliveryRevision: delivery.revision,
    expectedPolicyVersion: w.store.configuration(w.projectId).version,
    decision: "accepted",
    repositoryId,
    prNumber: 7,
    expectedPrNodeId: "P7",
    expectedHeadSha: outside,
  });
  assert.equal(settled.settlement?.headSha, outside);
  const pushed = await w.submit("branch.push", next);
  assert.equal(pushed.state, "confirmed-success");
  assert.equal(w.pushes.at(-1)?.lease, outside);
});

test("an adoption the fetch cannot place on the base is refused, keeps the hold and leaves overwrite available", async (t) => {
  const w = adoptWorld(t);
  await withOutsideHead(w);
  w.setAdopt(async () => "not-on-base");
  const record = await w.adoptOutside();
  assert.equal(record.state, "confirmed-failure");
  assert.equal(record.observation?.reason, "branch-adopt-not-on-base");
  assert.equal(branchOf(w)?.outsideHeadSha, outside);
  assert.ok(holds(w));
  const overwritten = await w.overwrite(w.amend());
  assert.equal(overwritten.state, "confirmed-success");
  assert.ok(!holds(w));
});

test("a remote that moved before or during the adoption is another outside change and spends the approval", async (t) => {
  const w = adoptWorld(t);
  await withOutsideHead(w);
  const material = w.outsideMaterial();
  const moved = "8".repeat(40);
  w.remote.head = moved;
  const before = await w.adoptOutside(material);
  assert.equal(before.observation?.reason, "branch-outside-change");
  assert.equal(w.adopts.length, 0);
  assert.equal(branchOf(w)?.outsideHeadSha, moved);
  assert.deepEqual(
    w.wakes.map((x) => x.identity),
    [`outside-push:${repositoryId}:${moved}`],
  );
  assert.equal((await w.adoptOutside(material)).state, "denied");

  const racing = adoptWorld(t);
  await withOutsideHead(racing);
  const racingMaterial = racing.outsideMaterial();
  racing.setAdopt(async () => {
    racing.remote.head = null;
    return "adopted";
  });
  const during = await racing.adoptOutside(racingMaterial);
  assert.equal(during.observation?.reason, "branch-outside-change");
  assert.equal(branchOf(racing)?.outsideHeadSha, absentBranchHead);
  assert.equal(branchOf(racing)?.lastPushedSha !== outside, true);
});

test("an adoption left unsettled by a restart runs again from its recorded context and records once", async (t) => {
  const w = adoptWorld(t);
  await withOutsideHead(w);
  w.setAdopt(() => new Promise(() => {}));
  void w.adoptOutside();
  const deadline = Date.now() + 5000;
  while (
    !w.store.actions(w.taskId).some((a) => a.state === "attempting") &&
    Date.now() < deadline
  )
    await new Promise<void>((r) => setTimeout(r, 10));
  const stuck = w.store.actions(w.taskId).find((a) => a.state === "attempting");
  assert.ok(stuck);
  assert.equal(stuck.beforeState?.baseCommit, w.base);
  w.setAdopt(async () => "adopted");
  await w.coordinatorFor().reconcile();
  assert.equal(w.store.action(stuck.operationId).state, "confirmed-success");
  assert.equal(branchOf(w)?.lastPushedSha, outside);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.equal(w.adopts.length, 2);
});

test("a failed adoption leaves the hold without blocking the task, and the lead can request it again", async (t) => {
  const w = adoptWorld(t);
  await withOutsideHead(w);
  for (const [outcome, reason] of [
    ["fetch-failed", "branch-adopt-fetch-failed"],
    ["unproved", "branch-adopt-unproved"],
    ["not-attempted", "branch-adopt-workspace-unavailable"],
  ] as const) {
    w.setAdopt(async () => outcome);
    const failed = await w.adoptOutside();
    assert.equal(failed.state, "confirmed-failure");
    assert.equal(failed.observation?.reason, reason);
    assert.equal(failed.observation?.retryable, undefined);
    assert.deepEqual(w.store.actionBlockers(w.taskId), []);
    assert.equal(branchOf(w)?.outsideHeadSha, outside);
  }
  w.setAdopt(async () => "adopted");
  assert.equal((await w.adoptOutside()).state, "confirmed-success");
  assert.ok(!holds(w));
});

test("adoption is never grantable as allow, always needs approval, and is not offered for a deleted branch", async (t) => {
  const w = adoptWorld(t);
  assert.throws(() =>
    w.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.projectId,
      expectedVersion: w.store.configuration(w.projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "branch.adopt", repositoryId, mode: "allow" }],
      requiredChecks: [],
    }),
  );
  await withOutsideHead(w);
  const unapproved = w.coordinatorFor(true, false);
  assert.equal((await w.adoptOutside(undefined, unapproved)).state, "denied");
  assert.equal(w.adopts.length, 0);
  // A service caller can never take a branch action.
  assert.throws(
    () =>
      w.store.authorize(
        w.request({
          kind: "branch.adopt",
          target: { repositoryId },
          ...w.outsideMaterial(),
        }),
        {
          actor: "service",
          purpose: "status-mapping",
          projectId: w.projectId,
          taskId: w.taskId,
          mappingVersion: 1,
          event: "done",
        } as never,
        true,
      ),
    /Status mapping caller/,
  );

  const deleted = adoptWorld(t);
  await withOutsideHead(deleted, null);
  assert.equal(
    (await deleted.adoptOutside()).state,
    "denied",
    "a deleted branch has nothing to adopt",
  );
  assert.equal(branchOf(deleted)?.outsideHeadSha, absentBranchHead);
});

test("an adoption whose remote returned to Ensemble's push clears the stale record without fetching", async (t) => {
  const w = adoptWorld(t);
  const first = await withOutsideHead(w);
  const material = w.outsideMaterial();
  w.remote.head = first;
  const record = await w.adoptOutside(material);
  assert.equal(record.observation?.reason, "branch-outside-cleared");
  assert.equal(w.adopts.length, 0);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
});
