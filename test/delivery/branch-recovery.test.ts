import assert from "node:assert/strict";
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
