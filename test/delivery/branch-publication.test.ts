import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deliverySection } from "../../src/standalone/operator-coordination.js";
import { test } from "node:test";
import {
  git,
  publicationWorld,
  repositoryId,
} from "../fixtures/publication.js";

const prCreate = (headRef: string, expectedHeadSha: string) => ({
  kind: "pr.create" as const,
  target: { repositoryId, baseRef: "main", headRef, expectedHeadSha },
  title: "T",
  body: "B",
  draft: true,
});

test("publication is denied without a grant and waits for exact approval under an approval grant", (t) => {
  const none = publicationWorld(t, { grants: [] });
  for (const kind of ["branch.push", "branch.force-push"] as const) {
    const record = none.store.prepareAction(
      none.request({
        kind,
        target: { repositoryId },
        commitSha: none.base,
      }),
      none.caller,
      true,
    );
    assert.equal(record.state, "denied");
    assert.equal(record.observation?.reason, "delivery-authority-denied");
  }
  assert.deepEqual(none.store.taskBranches(none.taskId), []);

  const gated = publicationWorld(t, { mode: "approval" });
  const action = {
    kind: "branch.push" as const,
    target: { repositoryId },
    commitSha: gated.base,
  };
  assert.equal(
    gated.store.prepareAction(gated.request(action), gated.caller, false).state,
    "denied",
  );
  assert.equal(
    gated.store.prepareAction(gated.request(action), gated.caller, true).state,
    "prepared",
  );
});

test("a task gets one durable branch per repository with the operator's prefix", (t) => {
  const world = publicationWorld(t, { grants: ["branch.push"] });
  const action = {
    kind: "branch.push" as const,
    target: { repositoryId },
    commitSha: world.base,
  };
  world.store.prepareAction(world.request(action), world.caller, false);
  const first = world.store.taskBranch(world.taskId, repositoryId);
  assert.equal(
    first?.branch,
    `ensemble/${world.taskId.replaceAll("-", "").slice(0, 8)}-fix-the-login-bug`,
  );

  // Later title and prefix changes never rename it, and a second push reuses it.
  world.db
    .prepare("UPDATE tasks SET title='Something else' WHERE id=?")
    .run(world.taskId);
  world.configure(["branch.push"]);
  world.store.prepareAction(world.request(action), world.caller, false);
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.branch,
    first?.branch,
  );
  assert.equal(world.store.taskBranches(world.taskId).length, 1);

  const prefixed = publicationWorld(t, {
    grants: ["branch.push"],
    branchPrefix: "team/",
  });
  prefixed.store.prepareAction(
    prefixed.request({ ...action, commitSha: prefixed.base }),
    prefixed.caller,
    false,
  );
  assert.match(
    prefixed.store.taskBranch(prefixed.taskId, repositoryId)?.branch ?? "",
    /^team\/[0-9a-f]{8}-fix-the-login-bug$/,
  );
});

test("a colliding branch name lengthens the task id part", (t) => {
  const world = publicationWorld(t, { grants: ["branch.push"] });
  const other = randomUUID();
  world.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: world.projectId,
    taskId: other,
    title: "Fix the login bug!",
    outcome: "O",
  });
  const hex = world.taskId.replaceAll("-", "");
  world.db
    .prepare("INSERT INTO delivery_task_branches VALUES (?,?,?,NULL,NULL,1)")
    .run(other, repositoryId, `ensemble/${hex.slice(0, 8)}-fix-the-login-bug`);
  world.store.prepareAction(
    world.request({
      kind: "branch.push",
      target: { repositoryId },
      commitSha: world.base,
    }),
    world.caller,
    false,
  );
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.branch,
    `ensemble/${hex.slice(0, 12)}-fix-the-login-bug`,
  );
});

test("unsafe branch prefixes are rejected and an older policy still parses", (t) => {
  const world = publicationWorld(t);
  for (const bad of [
    "-x/",
    "a..b/",
    "a.lock/",
    ".hidden/",
    "a//b/",
    "a".repeat(65),
  ])
    assert.throws(() => publicationWorld(t, { branchPrefix: bad }), /./, bad);
  // A policy persisted before branchPrefix existed has none and uses the default.
  assert.equal(
    world.store.configuration(world.projectId).branchPrefix,
    undefined,
  );
  const row = world.db
    .prepare("SELECT policyJson FROM delivery_policies WHERE projectId=?")
    .get(world.projectId) as { policyJson: string };
  assert.doesNotMatch(row.policyJson, /branchPrefix/);
});

test("pr.create is accepted only for the task's assigned branch", async (t) => {
  const world = publicationWorld(t, {
    grants: ["branch.push", "pr.create"],
  });
  const sha = world.commit();
  const create = (headRef: string) =>
    world.store.prepareAction(
      world.request(prCreate(headRef, sha)),
      world.caller,
      false,
    ).state;
  assert.equal(create("cb/anything"), "denied", "before any assignment");
  assert.equal(
    (await world.submit("branch.push", sha)).state,
    "confirmed-success",
  );
  const branch = world.store.taskBranch(world.taskId, repositoryId)?.branch;
  assert.ok(branch);
  assert.equal(create("cb/anything"), "denied");
  assert.equal(create(branch), "prepared");
});

test("a verified commit creates then advances the branch, confirmed by readback", async (t) => {
  const world = publicationWorld(t);
  const first = world.commit();
  const created = await world.submit("branch.push", first);
  assert.equal(created.state, "confirmed-success");
  const branch = world.store.taskBranch(world.taskId, repositoryId);
  assert.equal(world.remote.head, first);
  assert.deepEqual(created.observation?.receipt, {
    nodeId: repositoryId,
    ref: branch?.branch,
    headSha: first,
    uncommittedEntries: 0,
  });
  assert.equal(branch?.lastPushedSha, first);
  assert.equal(world.pushes[0]?.lease, null, "creation expects absence");
  assert.equal(world.pushes[0]?.token, "token");

  const second = world.commit();
  assert.equal(
    (await world.submit("branch.push", second)).state,
    "confirmed-success",
  );
  assert.equal(world.remote.head, second);
  assert.equal(
    world.pushes[1]?.lease,
    first,
    "an advance expects the observed head",
  );
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.lastPushedSha,
    second,
  );

  // A rewritten history needs the force action, and the lease is the last push.
  const rewritten = world.amend();
  const refused = await world.submit("branch.push", rewritten);
  assert.equal(refused.observation?.reason, "branch-not-fast-forward");
  assert.equal(world.pushes.length, 2, "refused before the push");
  const forced = await world.submit("branch.force-push", rewritten);
  assert.equal(forced.state, "confirmed-success");
  assert.equal(world.pushes[2]?.lease, second);
  assert.equal(world.remote.head, rewritten);
  assert.deepEqual(world.wakes, []);
});

test("a force-push before any push has no lease and is refused", async (t) => {
  const world = publicationWorld(t);
  const record = await world.submit("branch.force-push", world.commit());
  assert.equal(record.observation?.reason, "branch-force-push-needs-lease");
  assert.equal(world.pushes.length, 0);
});

test("a branch moved outside Ensemble refuses the push as an outside change and wakes the lead", async (t) => {
  const world = publicationWorld(t);
  assert.equal(
    (await world.submit("branch.push", world.commit())).state,
    "confirmed-success",
  );
  const outside = "e".repeat(40);
  world.remote.head = outside;
  for (const kind of ["branch.push", "branch.force-push"] as const) {
    const record = await world.submit(kind, world.commit());
    assert.equal(record.state, "confirmed-failure");
    assert.equal(record.observation?.reason, "branch-outside-change");
    assert.equal(record.observation?.receipt?.headSha, outside);
  }
  assert.equal(world.pushes.length, 1, "no push after the outside change");
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.outsideHeadSha,
    outside,
  );
  assert.ok(
    world.wakes.every(
      (w) => w.identity === `outside-push:${repositoryId}:${outside}`,
    ),
  );
  assert.equal(world.wakes.length, 2);
});

test("a lease lost between preflight and push is an outside change and nothing is overwritten", async (t) => {
  const world = publicationWorld(t);
  await world.submit("branch.push", world.commit());
  const rewritten = world.amend();
  world.setPush("outside-during-push");
  const record = await world.submit("branch.force-push", rewritten);
  assert.equal(record.state, "confirmed-failure");
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(record.observation?.receipt?.headSha, "d".repeat(40));
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.outsideHeadSha,
    "d".repeat(40),
  );
  assert.equal(world.wakes.length, 1);
});

test("a commit that is not the task's own work is refused before any network call", async (t) => {
  const world = publicationWorld(t);
  // Reachable in the shared object store but not from the worktree's HEAD.
  git(world.source, "checkout", "-q", "-b", "other", world.base);
  git(world.source, "commit", "-q", "--allow-empty", "-m", "foreign");
  const foreign = git(world.source, "rev-parse", "HEAD");
  for (const sha of [foreign, world.beforeBase, "f".repeat(40)]) {
    const record = await world.submit("branch.push", sha);
    assert.equal(record.state, "confirmed-failure");
    assert.equal(record.observation?.reason, "push-commit-not-verified", sha);
  }
  assert.deepEqual(world.requests, []);
  assert.equal(world.pushes.length, 0);
});

test("uncommitted changes are reported and never pushed", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  writeFileSync(`${world.workspace}/dirty.txt`, "dirty\n");
  const record = await world.submit("branch.push", sha);
  assert.equal(record.state, "confirmed-success");
  assert.equal(record.observation?.receipt?.uncommittedEntries, 1);
  assert.equal(world.pushes[0]?.commitSha, sha);
});

test("an ambiguous push is uncertain, holds the task and is reconciled by reading the ref, never replayed", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  world.setPush("uncertain-applied");
  const record = await world.submit("branch.push", sha);
  assert.equal(record.state, "uncertain");
  assert.deepEqual(world.store.actionBlockers(world.taskId), [
    "external-action-uncertain",
  ]);
  assert.equal(world.pushes.length, 1);

  // A restart reconciles from the remote ref alone.
  const restarted = world.coordinatorFor();
  await restarted.reconcile();
  const settled = world.store.action(record.operationId);
  assert.equal(settled.state, "confirmed-success");
  assert.equal(settled.observation?.receipt?.headSha, sha);
  assert.equal(world.pushes.length, 1, "no replay");
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.lastPushedSha,
    sha,
  );
  assert.deepEqual(world.store.actionBlockers(world.taskId), []);
});

test("an ambiguous push that did not land is a no-effect failure that only the retry path re-attempts", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  world.setPush("uncertain-lost");
  const record = await world.submit("branch.push", sha);
  assert.equal(record.state, "uncertain");
  const restarted = world.coordinatorFor();
  await restarted.reconcile();
  const failed = world.store.action(record.operationId);
  assert.equal(failed.state, "confirmed-failure");
  assert.equal(failed.observation?.reason, "branch-push-not-applied");
  assert.equal(failed.observation?.retryable, true);
  assert.equal(world.pushes.length, 1);
  world.setPush("apply");
  await restarted.reconcile();
  assert.equal(
    world.store.action(record.operationId).state,
    "confirmed-success",
  );
  assert.equal(world.pushes.length, 2);
  assert.equal(world.remote.head, sha);
});

test("a PR head Ensemble did not push wakes the lead once and clears handback settlement", async (t) => {
  const world = publicationWorld(t);
  const first = world.commit();
  await world.submit("branch.push", first);
  const branch =
    world.store.taskBranch(world.taskId, repositoryId)?.branch ?? "";
  world.store.transaction(() =>
    world.store.registerPrWithinTransaction(
      world.caller,
      world.showPr(first, branch),
      world.caller.assignmentId,
    ),
  );
  const binding = world.store.delivery(world.taskId);
  assert.ok(binding);
  await world.coordinator.settleHandback({
    actor: "operator",
    key: randomUUID(),
    taskId: world.taskId,
    expectedTaskVersion: 1,
    expectedDeliveryRevision: binding.revision,
    expectedPolicyVersion: world.store.configuration(world.projectId).version,
    decision: "accepted",
    repositoryId,
    prNumber: 7,
    expectedPrNodeId: "P7",
    expectedHeadSha: first,
  });
  assert.ok(world.store.delivery(world.taskId)?.settlement);
  world.wakes.length = 0;

  // Ensemble's own push advances the PR head without being flagged, even while the PR lags.
  const second = world.commit();
  await world.submit("branch.push", second);
  world.showPr(first, branch);
  await world.coordinator.refresh();
  world.showPr(second, branch);
  await world.coordinator.refresh();
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.outsideHeadSha,
    null,
  );
  assert.ok(world.wakes.every((w) => !w.identity.startsWith("outside-push")));

  const wakesBefore = world.wakes.length;
  const outside = "c".repeat(40);
  world.showPr(outside, branch);
  await world.coordinator.refresh();
  await world.coordinator.refresh();
  assert.equal(world.store.delivery(world.taskId)?.settlement, null);
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.outsideHeadSha,
    outside,
  );
  const outsideWakes = world.wakes.filter((w) =>
    w.identity.startsWith("outside-push"),
  );
  assert.deepEqual(
    outsideWakes.map((w) => w.identity),
    [`outside-push:${repositoryId}:${outside}`],
  );
  assert.equal(world.wakes.length - wakesBefore, 1, "one event, once");
});

test("the task's delivery view and retained page show the branch, its last push and an outside push", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  await world.submit("branch.push", sha);
  const branch = world.store.taskBranch(world.taskId, repositoryId)?.branch;
  assert.ok(branch);
  const outside = "b".repeat(40);
  world.db
    .prepare(
      "UPDATE delivery_task_branches SET outsideHeadSha=? WHERE taskId=?",
    )
    .run(outside, world.taskId);
  const delivery = world.store.publicTask(world.taskId);
  assert.deepEqual(
    delivery.branches.map((b) => [b.branch, b.lastPushedSha, b.outsideHeadSha]),
    [[branch, sha, outside]],
  );
  const html = deliverySection(
    { delivery, task: { state: "open" } } as never,
    "csrf",
  );
  assert.ok(
    html.includes(
      `${branch} (${repositoryId}) pushed ${sha}; outside push ${outside}`,
    ),
  );
  // The projection carries refs and commits only, never the delivery credential.
  assert.equal(JSON.stringify(delivery).includes("token"), false);
});

test("a replace ref cannot fake a commit's ancestry", async (t) => {
  const world = publicationWorld(t);
  // The worktree's HEAD is an unrelated root commit that a replace ref makes look like a child of the base.
  git(world.workspace, "checkout", "-q", "--orphan", "alien");
  git(world.workspace, "commit", "-q", "--allow-empty", "-m", "alien");
  const alien = git(world.workspace, "rev-parse", "HEAD");
  const fake = git(
    world.workspace,
    "commit-tree",
    "-p",
    world.base,
    "-m",
    "fake",
    `${alien}^{tree}`,
  );
  git(world.workspace, "replace", alien, fake);
  // Plain Git is fooled: this exits 0.
  git(world.workspace, "merge-base", "--is-ancestor", world.base, alien);
  const record = await world.submit("branch.push", alien);
  assert.equal(record.observation?.reason, "push-commit-not-verified");
  assert.deepEqual(world.requests, []);
});

test("a push whose readback lags is unproved and reconciled, not recorded as not applied", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  world.setPush("applied-but-unread");
  const record = await world.submit("branch.push", sha);
  assert.equal(record.state, "uncertain");
  assert.equal(world.pushes.length, 1);
  world.remote.head = sha;
  await world.coordinatorFor().reconcile();
  assert.equal(
    world.store.action(record.operationId).state,
    "confirmed-success",
  );
  assert.equal(world.pushes.length, 1);
});

test("a graft cannot fake a commit's ancestry", async (t) => {
  const world = publicationWorld(t);
  git(world.workspace, "checkout", "-q", "--orphan", "alien");
  git(world.workspace, "commit", "-q", "--allow-empty", "-m", "alien");
  const alien = git(world.workspace, "rev-parse", "HEAD");
  const grafts = git(world.workspace, "rev-parse", "--git-path", "info/grafts");
  mkdirSync(dirname(resolve(world.workspace, grafts)), { recursive: true });
  writeFileSync(resolve(world.workspace, grafts), `${alien} ${world.base}\n`);
  // Plain Git is fooled: this exits 0.
  git(world.workspace, "merge-base", "--is-ancestor", world.base, alien);
  const record = await world.submit("branch.push", alien);
  assert.equal(record.observation?.reason, "push-commit-not-verified");
  assert.deepEqual(world.requests, []);
});

test("a branch another writer creates after preflight is not recorded as Ensemble's push", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  // The outsider's commit is an ancestor of the one being pushed: a plain fast-forward would succeed.
  world.raceBeforeNextPush(world.base);
  const record = await world.submit("branch.push", sha);
  assert.equal(record.state, "confirmed-failure");
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(world.pushes[0]?.lease, null);
  assert.equal(
    world.remote.head,
    world.base,
    "the outsider's branch is untouched",
  );
  const branch = world.store.taskBranch(world.taskId, repositoryId);
  assert.equal(branch?.lastPushedSha, null);
  assert.equal(branch?.outsideHeadSha, world.base);
  assert.equal(world.wakes.length, 1);
});

test("a branch another writer advances after preflight is not recorded as Ensemble's push", async (t) => {
  const world = publicationWorld(t);
  const first = world.commit();
  await world.submit("branch.push", first);
  const second = world.commit();
  world.raceBeforeNextPush(world.base);
  const record = await world.submit("branch.push", second);
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(world.pushes[1]?.lease, first);
  assert.equal(world.remote.head, world.base);
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.lastPushedSha,
    first,
  );
  assert.equal(world.wakes.length, 1);
});

test("a remote that already equals the commit but was not pushed by Ensemble is an outside change", async (t) => {
  for (const pushedBefore of [false, true]) {
    const world = publicationWorld(t);
    const first = world.commit();
    if (pushedBefore) await world.submit("branch.push", first);
    const target = world.commit();
    world.remote.head = target;
    const pushes = world.pushes.length;
    const record = await world.submit("branch.push", target);
    assert.equal(record.state, "confirmed-failure", String(pushedBefore));
    assert.equal(record.observation?.reason, "branch-outside-change");
    assert.equal(world.pushes.length, pushes, "no push, no laundering");
    assert.equal(
      world.store.taskBranch(world.taskId, repositoryId)?.lastPushedSha,
      pushedBefore ? first : null,
    );
    assert.equal(world.wakes.length, 1);
  }
});

test("a retry may find its own earlier push, which landed late, without a push or a wake", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  world.setPush("uncertain-lost");
  const record = await world.submit("branch.push", sha);
  const restarted = world.coordinatorFor();
  await restarted.reconcile();
  assert.equal(
    world.store.action(record.operationId).observation?.retryable,
    true,
  );
  world.remote.head = sha;
  await restarted.reconcile();
  assert.equal(
    world.store.action(record.operationId).state,
    "confirmed-success",
  );
  assert.equal(world.pushes.length, 1);
  assert.deepEqual(world.wakes, []);
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.lastPushedSha,
    sha,
  );
});

test("a force-push is leased against the observed head and loses to a writer that moved it", async (t) => {
  const world = publicationWorld(t);
  const first = world.commit();
  await world.submit("branch.push", first);
  const rewritten = world.amend();
  world.raceBeforeNextPush("c".repeat(40));
  const record = await world.submit("branch.force-push", rewritten);
  assert.equal(record.observation?.reason, "branch-outside-change");
  assert.equal(world.pushes[1]?.lease, first);
  assert.equal(world.remote.head, "c".repeat(40));
});

test("a server-side rejection after the ref moved is an outside change, not a plain refusal", async (t) => {
  const world = publicationWorld(t);
  const sha = world.commit();
  world.setPush("remote-rejected");
  world.raceBeforeNextPush("e".repeat(40));
  const moved = await world.submit("branch.push", sha);
  assert.equal(moved.observation?.reason, "branch-outside-change");
  assert.equal(world.wakes.length, 1);

  const plain = publicationWorld(t);
  plain.setPush("remote-rejected");
  const refused = await plain.submit("branch.push", plain.commit());
  assert.equal(refused.observation?.reason, "branch-push-rejected");
  assert.deepEqual(plain.wakes, []);
});

test("a retry after a push that never started does not accept an equal remote as its own", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const world = publicationWorld(t);
  const sha = world.commit();
  world.setPush("not-attempted");
  const record = await world.submit("branch.push", sha);
  assert.equal(record.observation?.reason, "push-not-attempted");
  // Someone else creates exactly the requested commit before the retry.
  world.remote.head = sha;
  t.mock.timers.tick(61_000);
  world.setPush("apply");
  await world.coordinatorFor().reconcile();
  const after = world.store.action(record.operationId);
  assert.equal(after.observation?.reason, "branch-outside-change");
  assert.equal(world.wakes.length, 1);
  assert.equal(
    world.store.taskBranch(world.taskId, repositoryId)?.lastPushedSha,
    null,
  );
});

test("a complete branch name longer than the prefix cap is valid", async (t) => {
  const prefix = `${"p".repeat(62)}/`;
  const w = publicationWorld(t, {
    grants: ["branch.push"],
    branchPrefix: prefix,
    title:
      "A very long title that keeps going well past the slug cap for a task",
  });
  const record = await w.submit("branch.push", w.commit());
  assert.equal(
    record.state,
    "confirmed-success",
    record.observation?.reason ?? "",
  );
  const branch = w.store.taskBranch(w.taskId, repositoryId)?.branch ?? "";
  assert.ok(branch.length > 64 && branch.length <= 160, String(branch.length));
  assert.ok(branch.startsWith(prefix));
});
