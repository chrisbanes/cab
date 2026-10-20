import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forgeCommitGraphParent } from "../fixtures/forged-commit-graph.js";
import {
  git,
  publicationWorld,
  repositoryId,
} from "../fixtures/publication.js";
import { verifyTaskPush } from "../../src/standalone/push-verification.js";

type World = ReturnType<typeof publicationWorld>;
const branchOf = (w: World) => w.store.taskBranch(w.taskId, repositoryId);
const settle = (w: World, headSha: string) => {
  const binding = w.store.delivery(w.taskId);
  assert.ok(binding);
  return w.coordinator.settleHandback({
    actor: "operator",
    key: randomUUID(),
    taskId: w.taskId,
    expectedTaskVersion: 1,
    expectedDeliveryRevision: binding.revision,
    expectedPolicyVersion: w.store.configuration(w.projectId).version,
    decision: "accepted",
    repositoryId,
    prNumber: 7,
    expectedPrNodeId: "P7",
    expectedHeadSha: headSha,
  });
};
/** A pushed first commit with the task's PR registered on its branch. */
async function withPr(w: World) {
  const first = w.commit();
  await w.submit("branch.push", first);
  const branch = branchOf(w)?.branch ?? "";
  w.store.transaction(() =>
    w.store.registerPrWithinTransaction(
      w.caller,
      w.showPr(first, branch),
      w.caller.assignmentId,
    ),
  );
  return { first, branch };
}

test("an equal head after a rejected fresh push is an outside change, not Ensemble's push", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  w.setPush("remote-rejected");
  w.raceBeforeNextPush(sha);
  const record = await w.submit("branch.push", sha);
  assert.equal(record.state, "confirmed-failure");
  assert.equal(record.observation?.reason, "branch-outside-change");
  await w.coordinatorFor().reconcile();
  assert.equal(w.store.action(record.operationId).state, "confirmed-failure");
  assert.equal(branchOf(w)?.lastPushedSha, null);
  assert.equal(branchOf(w)?.outsideHeadSha, sha);
  assert.equal(w.wakes.length, 1);
});

test("a push that never started does not own its commit on the PR, and the branch holds settlement", async (t) => {
  const w = publicationWorld(t);
  const { first, branch } = await withPr(w);
  await settle(w, first);
  assert.ok(w.store.delivery(w.taskId)?.settlement);
  const second = w.commit();
  w.setPush("not-attempted");
  const record = await w.submit("branch.push", second);
  assert.equal(record.observation?.reason, "push-not-attempted");
  w.wakes.length = 0;
  w.showPr(second, branch);
  await w.coordinator.refresh();
  assert.equal(branchOf(w)?.outsideHeadSha, second);
  assert.deepEqual(
    w.wakes.map((x) => x.identity),
    [`outside-push:${repositoryId}:${second}`],
  );
  assert.equal(w.store.delivery(w.taskId)?.settlement, null);
  assert.ok(
    w.store
      .completionBlockers(w.taskId, 1)
      .includes("task-branch-outside-change"),
  );
  await assert.rejects(settle(w, second), /outside Ensemble/);
});

test("PR actions on the task branch need the commit Ensemble last pushed", async (t) => {
  const w = publicationWorld(t, { grants: ["branch.push", "pr.create"] });
  const outside = w.commit();
  w.remote.head = outside;
  const refused = await w.submit("branch.push", w.commit());
  assert.equal(refused.observation?.reason, "branch-outside-change");
  const branch = branchOf(w)?.branch ?? "";
  const create = (expectedHeadSha: string) => ({
    operationId: randomUUID(),
    action: {
      kind: "pr.create" as const,
      target: {
        repositoryId,
        baseRef: "main",
        headRef: branch,
        expectedHeadSha,
      },
      title: "t",
      body: "b",
      draft: true,
    },
  });
  // The branch exists but Ensemble never published it: no PR may be opened from that head.
  assert.throws(
    () => w.store.authorize(create(outside), w.caller, false),
    /last Ensemble push/,
  );

  const own = publicationWorld(t, {
    grants: ["branch.push", "pr.create", "pr.merge", "pr.ready", "pr.edit"],
    deliveryMode: "through-merge",
  });
  const sha = own.commit();
  await own.submit("branch.push", sha);
  const ownBranch = branchOf(own)?.branch ?? "";
  const ownCreate = (expectedHeadSha: string) => ({
    operationId: randomUUID(),
    action: {
      kind: "pr.create" as const,
      target: {
        repositoryId,
        baseRef: "main",
        headRef: ownBranch,
        expectedHeadSha,
      },
      title: "t",
      body: "b",
      draft: true,
    },
  });
  own.store.authorize(ownCreate(sha), own.caller, false);
  assert.throws(() =>
    own.store.authorize(ownCreate("1".repeat(40)), own.caller, false),
  );
  // An outside advance blocks the same PR actions until the branch is back where Ensemble left it.
  own.db
    .prepare(
      "UPDATE delivery_task_branches SET outsideHeadSha=? WHERE taskId=?",
    )
    .run("2".repeat(40), own.taskId);
  assert.throws(
    () => own.store.authorize(ownCreate(sha), own.caller, false),
    /last Ensemble push/,
  );
  const prAction = (kind: "pr.merge" | "pr.ready" | "pr.edit") => ({
    operationId: randomUUID(),
    action: {
      kind,
      target: {
        repositoryId,
        nodeId: "P7",
        number: 7,
        baseRef: "main",
        headRef: ownBranch,
        expectedHeadSha: sha,
      },
      ...(kind === "pr.merge"
        ? { method: "squash", reviewedResultIds: [] }
        : {}),
      ...(kind === "pr.edit" ? { fields: { title: "x" } } : {}),
    },
  });
  for (const kind of ["pr.merge", "pr.ready", "pr.edit"] as const)
    assert.throws(
      () => own.store.authorize(prAction(kind) as never, own.caller, true),
      /last Ensemble push/,
      kind,
    );
});

test("a late landing is still recognised after a retry that never started", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const w = publicationWorld(t);
  const sha = w.commit();
  w.setPush("uncertain-lost");
  const record = await w.submit("branch.push", sha);
  const coordinator = w.coordinatorFor();
  await coordinator.reconcile();
  assert.equal(
    w.store.action(record.operationId).observation?.reason,
    "branch-push-not-applied",
  );
  w.setPush("not-attempted");
  t.mock.timers.tick(61_000);
  await coordinator.reconcile();
  assert.equal(
    w.store.action(record.operationId).observation?.reason,
    "push-not-attempted",
  );
  w.remote.head = sha; // the first attempt lands late
  t.mock.timers.tick(61_000);
  w.setPush("apply");
  await coordinator.reconcile();
  assert.equal(w.store.action(record.operationId).state, "confirmed-success");
  assert.equal(branchOf(w)?.lastPushedSha, sha);
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.deepEqual(w.wakes, []);
});

test("a push Git reported done stays unproved while the read lags, and settles when it shows", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  w.setPush("applied-but-unread");
  const record = await w.submit("branch.push", sha);
  assert.equal(record.state, "uncertain");
  assert.equal(record.observation?.pushed, true);
  const coordinator = w.coordinatorFor();
  await coordinator.reconcile();
  const lagging = w.store.action(record.operationId);
  assert.equal(lagging.state, "uncertain", "never concluded not applied");
  assert.equal(lagging.observation?.pushed, true);
  // Not even a failing readback forgets that Git reported the push done.
  w.failRefReads(true);
  await coordinator.reconcile();
  assert.equal(w.store.action(record.operationId).observation?.pushed, true);
  w.failRefReads(false);
  w.remote.head = sha;
  await coordinator.reconcile();
  assert.equal(w.store.action(record.operationId).state, "confirmed-success");
  assert.equal(w.pushes.length, 1);
});

test("a push Git reported done followed by a third head is Ensemble's push and an outside move", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  const third = "3".repeat(40);
  w.setPush("applied-then-moved");
  w.movedHeadAfterPush(third);
  const record = await w.submit("branch.push", sha);
  assert.equal(record.state, "confirmed-success");
  assert.equal(branchOf(w)?.lastPushedSha, sha);
  assert.equal(branchOf(w)?.outsideHeadSha, third);
  assert.equal(w.wakes.length, 1);
  // The next preflight sees the third head and refuses.
  w.setPush("apply");
  const next = await w.submit("branch.push", w.commit());
  assert.equal(next.observation?.reason, "branch-outside-change");
});

test("an outside change recorded by a push clears handback settlement in the same step", async (t) => {
  const w = publicationWorld(t);
  const { first } = await withPr(w);
  await settle(w, first);
  assert.ok(w.store.delivery(w.taskId)?.settlement);
  w.raceBeforeNextPush("4".repeat(40));
  const record = await w.submit("branch.push", w.commit());
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(w.store.delivery(w.taskId)?.settlement, null);
});

test("a retry of a superseded push never rewinds a newer push", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const w = publicationWorld(t);
  await w.submit("branch.push", w.commit());
  const older = w.amend();
  w.setPush("not-attempted");
  const first = await w.submit("branch.force-push", older);
  assert.equal(first.observation?.reason, "push-not-attempted");
  w.setPush("apply");
  const newer = w.commit();
  const second = await w.submit("branch.force-push", newer);
  assert.equal(second.state, "confirmed-success");
  t.mock.timers.tick(61_000);
  await w.coordinatorFor().reconcile();
  const retried = w.store.action(first.operationId);
  assert.equal(retried.observation?.reason, "push-superseded");
  assert.equal(retried.observation?.retryable, undefined);
  assert.equal(w.remote.head, newer);
  assert.equal(branchOf(w)?.lastPushedSha, newer);
});

test("a recorded outside head clears once the branch is back at Ensemble's push or Ensemble pushes again", async (t) => {
  const w = publicationWorld(t);
  const { first, branch } = await withPr(w);
  w.showPr("5".repeat(40), branch);
  await w.coordinator.refresh();
  assert.equal(branchOf(w)?.outsideHeadSha, "5".repeat(40));
  w.showPr(first, branch);
  await w.coordinator.refresh();
  assert.equal(branchOf(w)?.outsideHeadSha, null, "head back at the last push");

  w.db
    .prepare(
      "UPDATE delivery_task_branches SET outsideHeadSha=? WHERE taskId=?",
    )
    .run("6".repeat(40), w.taskId);
  const second = w.commit();
  assert.equal(
    (await w.submit("branch.push", second)).state,
    "confirmed-success",
  );
  assert.equal(branchOf(w)?.outsideHeadSha, null, "an owned push clears it");
});

test("a PR registered on a branch that already holds an outside head wakes the lead", async (t) => {
  const w = publicationWorld(t);
  const first = w.commit();
  await w.submit("branch.push", first);
  const branch = branchOf(w)?.branch ?? "";
  const outside = "7".repeat(40);
  await w.coordinator
    .registerPr(
      {
        repositoryId,
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: outside,
      },
      w.caller,
    )
    .catch(() => undefined);
  w.showPr(outside, branch);
  await w.coordinator.registerPr(
    {
      repositoryId,
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: outside,
    },
    w.caller,
  );
  assert.equal(branchOf(w)?.outsideHeadSha, outside);
  assert.deepEqual(
    w.wakes.map((x) => x.identity),
    [`outside-push:${repositoryId}:${outside}`],
  );
});

test("a stale lease is not labelled outside when the readback fails or shows the head Ensemble saw", async (t) => {
  const unchanged = publicationWorld(t);
  const first = unchanged.commit();
  await unchanged.submit("branch.push", first);
  unchanged.setPush("stale-unchanged");
  const a = await unchanged.submit("branch.push", unchanged.commit());
  assert.equal(a.state, "uncertain");
  assert.equal(branchOf(unchanged)?.outsideHeadSha, null);
  assert.deepEqual(unchanged.wakes, []);

  const failing = publicationWorld(t);
  failing.setPush("stale-readback-fails");
  const b = await failing.submit("branch.push", failing.commit());
  assert.equal(b.state, "uncertain");
  assert.equal(branchOf(failing)?.outsideHeadSha, null);
  assert.deepEqual(failing.wakes, []);
});

test("ancestry is proved from hash-verified commits, not from a forged commit-graph", async (t) => {
  const w = publicationWorld(t);
  const first = w.commit();
  await w.submit("branch.push", first);
  // A commit that does not descend from `first`, made reachable from HEAD.
  git(w.workspace, "checkout", "-q", "--detach", w.base);
  git(w.workspace, "commit", "-q", "--allow-empty", "-m", "Y");
  git(w.workspace, "commit", "-q", "--allow-empty", "-m", "X");
  const x = git(w.workspace, "rev-parse", "HEAD");
  git(w.source, "branch", "keep-first", first);
  git(w.source, "branch", "keep-x", x);
  git(w.source, "commit-graph", "write", "--reachable");
  const graph = join(
    git(w.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "objects/info/commit-graph",
  );
  forgeCommitGraphParent(graph, x, first);
  // Plain Git trusts the graph on most versions: it then believes `first` is an ancestor of X.
  // A Git that rejects this forgery is already safe; the verifier is asserted either way.
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", first, x], {
      cwd: w.workspace,
      stdio: "ignore",
    });
  } catch {
    t.diagnostic(
      `Git ${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()} does not trust the forged commit-graph; asserting only the verifier`,
    );
  }
  const verification = await verifyTaskPush(
    { workspacePath: w.workspace, baseCommit: w.base },
    x,
    first,
  );
  assert.equal(verification?.descendsFromLastPushed, false);
  const refused = await w.submit("branch.push", x);
  assert.equal(refused.observation?.reason, "branch-not-fast-forward");
  assert.equal(w.pushes.length, 1);
});

test("ancestry fails closed on a loose object that lies about its content", async (t) => {
  const w = publicationWorld(t);
  const real = w.commit();
  // An unrelated root commit whose loose object is replaced by content naming the base as parent.
  git(w.workspace, "checkout", "-q", "--orphan", "alien");
  git(w.workspace, "commit", "-q", "--allow-empty", "-m", "alien");
  const alien = git(w.workspace, "rev-parse", "HEAD");
  const tree = git(w.workspace, "rev-parse", `${alien}^{tree}`);
  const lie = Buffer.from(
    `tree ${tree}\nparent ${w.base}\nauthor A <a@e.com> 1 +0000\ncommitter A <a@e.com> 1 +0000\n\nalien\n`,
  );
  const { deflateSync } = await import("node:zlib");
  const object = join(
    git(w.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    "objects",
    alien.slice(0, 2),
    alien.slice(2),
  );
  const { chmodSync } = await import("node:fs");
  chmodSync(object, 0o644);
  writeFileSync(
    object,
    deflateSync(Buffer.concat([Buffer.from(`commit ${lie.length}\0`), lie])),
  );
  const refused = await w.submit("branch.push", alien);
  assert.equal(refused.observation?.reason, "push-commit-not-verified");
  assert.deepEqual(w.requests, []);
  void real;
});

test("status in the verifier never runs a configured clean filter", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  const marker = join(mkdtempSync(join(tmpdir(), "ensemble-filter-")), "ran");
  t.after(() => rmSync(join(marker, ".."), { recursive: true, force: true }));
  git(w.workspace, "config", "filter.evil.clean", `touch ${marker}; cat`);
  mkdirSync(w.workspace, { recursive: true });
  writeFileSync(join(w.workspace, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(w.workspace, "a.txt"), "changed so status rehashes it\n");
  const verification = await verifyTaskPush(
    { workspacePath: w.workspace, baseCommit: w.base },
    sha,
    null,
  );
  assert.ok(verification && verification.uncommittedEntries > 0);
  assert.equal(existsSync(marker), false, "the clean filter did not run");
});

test("an update Git rejected never owns an equal head, even when its readback failed", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  w.setPush("stale-readback-fails");
  const record = await w.submit("branch.push", sha);
  assert.equal(record.state, "uncertain");
  assert.equal(record.observation?.rejected, true);
  assert.equal(w.store.mayHaveLanded(record.operationId), false);
  // Another writer pushes exactly the requested commit before the read recovers.
  w.failRefReads(false);
  w.remote.head = sha;
  await w.coordinatorFor().reconcile();
  const settled = w.store.action(record.operationId);
  assert.equal(settled.observation?.reason, "branch-outside-change");
  assert.equal(branchOf(w)?.lastPushedSha, null);
  assert.equal(branchOf(w)?.outsideHeadSha, sha);
  assert.equal(w.wakes.length, 1);

  const unchanged = publicationWorld(t);
  unchanged.setPush("stale-readback-fails");
  const again = await unchanged.submit("branch.push", unchanged.commit());
  unchanged.failRefReads(false);
  await unchanged.coordinatorFor().reconcile();
  assert.equal(
    unchanged.store.action(again.operationId).observation?.reason,
    "branch-push-rejected",
  );
  assert.deepEqual(unchanged.wakes, []);
});

test("a branch deleted after Ensemble's push is an outside change, not a clean success", async (t) => {
  const w = publicationWorld(t);
  const { first } = await withPr(w);
  await settle(w, first);
  w.wakes.length = 0;
  const second = w.commit();
  w.setPush("applied-then-deleted");
  const record = await w.submit("branch.push", second);
  assert.equal(record.state, "confirmed-success");
  assert.equal(branchOf(w)?.lastPushedSha, second);
  assert.equal(w.store.delivery(w.taskId)?.settlement, null);
  assert.deepEqual(
    w.wakes.map((x) => x.identity),
    [`outside-push:${repositoryId}:absent`],
  );
  // The absent branch is not where Ensemble left it, so the next push is refused.
  w.setPush("apply");
  const next = await w.submit("branch.push", w.commit());
  assert.equal(next.observation?.reason, "branch-outside-change");
});

test("a Git-rejected update does not own its commit on the PR while its readback is unproved", async (t) => {
  const w = publicationWorld(t);
  const { branch } = await withPr(w);
  const second = w.commit();
  w.setPush("stale-readback-fails");
  const record = await w.submit("branch.push", second);
  assert.equal(record.observation?.rejected, true);
  w.failRefReads(false);
  // Another writer puts the commit on the branch; the PR is inspected before the reconcile runs.
  const recorded = w.store.transaction(() =>
    w.store.outsideHeadWithinTransaction(w.taskId, w.showPr(second, branch)),
  );
  assert.equal(recorded, true);
  assert.equal(branchOf(w)?.outsideHeadSha, second);
});

test("a remote already at the commit makes Git send nothing, and that is not Ensemble's push", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  w.raceBeforeNextPush(sha);
  const record = await w.submit("branch.push", sha);
  assert.equal(record.state, "confirmed-failure");
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(branchOf(w)?.lastPushedSha, null);
  assert.equal(branchOf(w)?.outsideHeadSha, sha);
  assert.equal(w.wakes.length, 1);
});

test("a retry whose earlier attempt landed finds Git sending nothing and is settled by the read", async (t) => {
  const w = publicationWorld(t);
  const sha = w.commit();
  w.setPush("uncertain-lost");
  const record = await w.submit("branch.push", sha);
  const coordinator = w.coordinatorFor();
  await coordinator.reconcile();
  assert.equal(
    w.store.action(record.operationId).observation?.reason,
    "branch-push-not-applied",
  );
  // The first attempt lands late, between the retry's preflight and its push.
  w.setPush("apply");
  w.raceBeforeNextPush(sha);
  await coordinator.reconcile();
  await coordinator.reconcile();
  assert.equal(w.store.action(record.operationId).state, "confirmed-success");
  assert.equal(branchOf(w)?.lastPushedSha, sha);
  assert.deepEqual(w.wakes, []);
});

test("an ambiguous push keeps its possible ownership when a later read shows a third head", async (t) => {
  const w = publicationWorld(t);
  const { branch } = await withPr(w);
  const second = w.commit();
  w.setPush("uncertain-lost");
  const record = await w.submit("branch.push", second);
  assert.equal(record.state, "uncertain");
  const third = "8".repeat(40);
  w.remote.head = third;
  await w.coordinatorFor().reconcile();
  assert.equal(
    w.store.action(record.operationId).observation?.reason,
    "branch-outside-change",
  );
  assert.equal(branchOf(w)?.outsideHeadSha, third);
  assert.equal(w.store.mayHaveLanded(record.operationId), true);
  // The attempt's own commit later shows up on the PR: it is not reported as an outside push.
  w.wakes.length = 0;
  w.showPr(second, branch);
  await w.coordinator.refresh();
  assert.deepEqual(
    w.wakes.filter((x) => x.identity.startsWith("outside-push")),
    [],
  );
  assert.equal(branchOf(w)?.outsideHeadSha, third);
});

test("a deleted branch keeps holding completion until a ref read proves it is back", async (t) => {
  const w = publicationWorld(t);
  const { branch } = await withPr(w);
  const second = w.commit();
  w.setPush("applied-then-deleted");
  const record = await w.submit("branch.push", second);
  assert.equal(record.state, "confirmed-success");
  assert.equal(branchOf(w)?.outsideHeadSha, "0".repeat(40));
  // The PR keeps its head commit after the branch is deleted: inspecting it proves nothing.
  w.showPr(second, branch);
  await w.coordinator.refresh();
  assert.equal(branchOf(w)?.outsideHeadSha, "0".repeat(40));
  assert.ok(
    w.store
      .completionBlockers(w.taskId, 1)
      .includes("task-branch-outside-change"),
  );
  await assert.rejects(settle(w, second), /outside Ensemble/);
  // The branch comes back where Ensemble left it; the next push reads that and clears the hold.
  w.remote.head = second;
  w.setPush("apply");
  const third = w.commit();
  assert.equal(
    (await w.submit("branch.push", third)).state,
    "confirmed-success",
  );
  assert.equal(branchOf(w)?.outsideHeadSha, null);
  assert.equal(branchOf(w)?.lastPushedSha, third);
});

test("a branch deleted before a push is refused and recorded as held", async (t) => {
  const w = publicationWorld(t);
  const first = w.commit();
  await w.submit("branch.push", first);
  w.remote.head = null;
  const refused = await w.submit("branch.push", w.commit());
  assert.equal(refused.observation?.reason, "branch-outside-change");
  assert.equal(branchOf(w)?.outsideHeadSha, "0".repeat(40));
  // Back at the last push: the next preflight reads it and clears the record before pushing.
  w.remote.head = first;
  const again = await w.submit("branch.push", w.commit());
  assert.equal(again.state, "confirmed-success");
  assert.equal(branchOf(w)?.outsideHeadSha, null);
});

test("closing the outcome stays possible on a closed PR whose branch was deleted", async (t) => {
  const w = publicationWorld(t);
  const { first, branch } = await withPr(w);
  w.remote.head = null;
  const refused = await w.submit("branch.push", w.commit());
  assert.equal(refused.observation?.reason, "branch-outside-change");
  assert.equal(branchOf(w)?.outsideHeadSha, "0".repeat(40));
  w.showPr(first, branch).state = "CLOSED";
  await w.coordinator.refresh();
  assert.ok(
    !w.store
      .completionBlockers(w.taskId, 1)
      .includes("task-branch-outside-change"),
  );
  const binding = w.store.delivery(w.taskId);
  assert.ok(binding);
  await w.coordinator.settleHandback({
    actor: "operator",
    key: randomUUID(),
    taskId: w.taskId,
    expectedTaskVersion: 1,
    expectedDeliveryRevision: binding.revision,
    expectedPolicyVersion: w.store.configuration(w.projectId).version,
    decision: "closed",
    repositoryId,
    prNumber: 7,
    expectedPrNodeId: "P7",
    expectedHeadSha: first,
  });
  assert.ok(w.store.delivery(w.taskId)?.settlement);
});
