import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { forgeCommitGraphParent } from "../fixtures/forged-commit-graph.js";
import { git } from "../fixtures/publication.js";
import { stackedDeliveryFixture } from "../fixtures/stacked-delivery.js";
import { until } from "../fixtures/until.js";

const outcome = (r: { text: string }) =>
  /External action [^:]+: ([a-z-]+)(?: \(([^)]+)\))?/.exec(r.text)?.slice(1, 3);

/** B pushes and opens its PR; D then starts. */
async function stackedPair(t: Parameters<typeof stackedDeliveryFixture>[0]) {
  const f = await stackedDeliveryFixture(t);
  const [B, D] = f.tasks as [string, string];
  await f.waitTurn(B);
  const parent = await f.commit(B, "parent");
  assert.deepEqual(outcome(await f.push(B, parent)), [
    "confirmed-success",
    undefined,
  ]);
  assert.deepEqual(await f.turnsOf(D), [], "D waits for B's PR");
  assert.deepEqual(f.service.domain().admission(D).reasons, [
    "stacked-blocker-unpublished",
  ]);
  await f.showPr(B);
  // B's turn keeps running, so its lead can push again.
  await f.service.refreshGitHub();
  await f.waitTurn(D);
  return { f, B, D, parent };
}

test("a stacked dependent's workspace starts at its blocker's last push and proves pushes against it", async (t) => {
  const { f, B, D, parent } = await stackedPair(t);
  const { path } = await f.workspaceOf(D);
  assert.equal(git(path, "rev-parse", "HEAD"), parent);
  assert.deepEqual(f.service.domain().stackedDependency(D), {
    blockerTaskId: B,
    repositoryId: "R1",
    parentHead: parent,
    restack: "current",
  });
  assert.equal(f.service.domain().stackFacts(D)?.state, "stacked");

  // A head built from the link base, not from B's head, never reaches the provider.
  git(path, "checkout", "-q", "--detach", f.base);
  const offBase = await f.commit(D, "off-base");
  const pushes = Object.keys(f.remote).length;
  assert.deepEqual(outcome(await f.push(D, offBase)), [
    "confirmed-failure",
    "push-commit-not-verified",
  ]);
  // Nor does one whose commit-graph claims B's head as its parent.
  execFileSync("git", ["commit-graph", "write", "--stdin-commits"], {
    cwd: f.source,
    input: `${offBase}\n${parent}\n`,
  });
  forgeCommitGraphParent(
    join(f.source, ".git", "objects", "info", "commit-graph"),
    offBase,
    parent,
  );
  assert.deepEqual(outcome(await f.push(D, offBase)), [
    "confirmed-failure",
    "push-commit-not-verified",
  ]);
  assert.equal(Object.keys(f.remote).length, pushes, "no network push");

  git(path, "checkout", "-q", "--detach", parent);
  const own = await f.commit(D, "own");
  assert.deepEqual(outcome(await f.push(D, own)), [
    "confirmed-success",
    undefined,
  ]);
});

test("after the parent head moves, pushes are proved against the new head", async (t) => {
  const { f, B, D, parent } = await stackedPair(t);
  const old = await f.commit(D, "on-old");
  assert.equal(outcome(await f.push(D, old))?.[0], "confirmed-success");

  const moved = await f.commit(B, "moved");
  assert.equal(outcome(await f.push(B, moved))?.[0], "confirmed-success");
  await until(
    () => f.service.domain().stackedDependency(D)?.parentHead === moved,
    "the parent head moves",
  );
  // Until B's PR shows its new head, D's actions wait for the stacked blocker gate.
  assert.deepEqual(f.service.domain().admission(D).reasons, [
    "stacked-blocker-unpublished",
  ]);
  await f.showPr(B);
  // Work that descends only from the old head is not proved.
  const stale = await f.commit(D, "still-old");
  assert.deepEqual(outcome(await f.push(D, stale)), [
    "confirmed-failure",
    "push-commit-not-verified",
  ]);
  // Rebased onto the new head (reachable without a fetch), it is.
  const { path } = await f.workspaceOf(D);
  git(path, "rebase", "-q", "--onto", moved, parent);
  const rebased = git(path, "rev-parse", "HEAD");
  assert.equal(git(path, "merge-base", "--is-ancestor", moved, rebased), "");
  assert.equal(
    outcome(await f.push(D, rebased, "branch.force-push"))?.[0],
    "confirmed-success",
  );
});

test("a dependent that already has a workspace is not stacked", async (t) => {
  const f = await stackedDeliveryFixture(t, { stacking: false });
  const [B, D] = f.tasks as [string, string];
  await f.waitTurn(B);
  // Without stacking, D's first workspace is provisioned from the link base as today.
  await until(
    async () => (await f.service.taskWorkspace(D)) !== undefined,
    "D's workspace",
  );
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    stacking: true,
  });
  await f.push(B, await f.commit(B, "parent"));
  await f.showPr(B);
  assert.equal(f.service.domain().stackFacts(D)?.reason, "dependent-started");
  assert.deepEqual(f.service.domain().admission(D).reasons, [
    "local-dependency",
  ]);
  assert.equal(f.service.domain().stackedDependency(D), null);
  const { path } = await f.workspaceOf(D);
  assert.equal(git(path, "rev-parse", "HEAD"), f.base);
});
