import assert from "node:assert/strict";
import { test } from "node:test";
import { git } from "../fixtures/publication.js";
import {
  repositoryId,
  stackedDeliveryFixture,
} from "../fixtures/stacked-delivery.js";
import { until } from "../fixtures/until.js";

type Fixture = Awaited<ReturnType<typeof stackedDeliveryFixture>>;

const succeeded = (r: { text: string }) =>
  /: confirmed-success/.test(r.text) || assert.fail(r.text);

/** `blocker` pushes a first head and shows its PR, so `dependent` starts stacked on it. */
async function start(f: Fixture, blocker: string, dependent: string) {
  const head = await f.commit(blocker);
  succeeded(await f.push(blocker, head));
  await f.showPr(blocker);
  await f.service.refreshGitHub();
  await f.waitTurn(dependent);
  return head;
}

/** Rebases the task's work onto `onto` (from `from`) and returns the new head. */
async function rebase(f: Fixture, taskId: string, from: string, onto: string) {
  const { path } = await f.workspaceOf(taskId);
  git(path, "rebase", "-q", "--onto", onto, from);
  return git(path, "rev-parse", "HEAD");
}

const bindingCommit = async (f: Fixture, taskId: string) =>
  (await f.service.taskWorkspace(taskId))?.repositories[0]?.commit;

test("a blocker's new head queues one restack for its dependent, which publishes under the force-push policy", async (t) => {
  const f = await stackedDeliveryFixture(t, { forcePush: "approval" });
  const [B, D] = f.tasks as [string, string];
  await f.waitTurn(B);
  const first = await start(f, B, D);
  succeeded(await f.push(D, await f.commit(D, "work")));
  await f.complete(D);
  assert.deepEqual(f.restackNotices(), []);

  const moved = await f.commit(B, "moved");
  succeeded(await f.push(B, moved));
  await until(() => f.restackNotices().length === 1, "the restack notice");
  await f.service.refreshGitHub();
  await f.showPr(B);
  assert.deepEqual(f.restackNotices(), [
    `${D} restack:${repositoryId}:1:${moved}`,
  ]);
  const stack = f.service.domain().stackFacts(D);
  assert.equal(stack?.restack, "pending");
  assert.equal(stack?.parentHead, moved);
  assert.equal(await bindingCommit(f, D), first, "not yet advanced");

  // The restack turn names the new parent head and the force-push it needs.
  // D's reporting-repair turn ends first; the restack arrives in the next one.
  await f.waitTurn(D, 2);
  await f.complete(D);
  const turn = await f.turnWith(D, /branch moved to/);
  assert.match(turn.prompt, new RegExp(`branch moved to ${moved}`));
  assert.match(turn.prompt, /branch\.force-push/);

  const rebased = await rebase(f, D, first, moved);
  const force = {
    kind: "branch.force-push",
    target: { repositoryId },
    commitSha: rebased,
  };
  assert.match(
    (await f.push(D, rebased, "branch.force-push")).text,
    /denied/,
    "an approval grant waits for approval",
  );
  const approval = await f.approve(D, force);
  succeeded(await f.push(D, rebased, "branch.force-push", approval));
  await until(
    () => f.service.domain().stackFacts(D)?.restack === "current",
    "the restack settles",
  );
  assert.equal(await bindingCommit(f, D), moved, "the starting point moves");
  assert.equal(f.restackNotices().length, 1, "no further notice");
});

test("restacks run bottom-up through a chain", async (t) => {
  const f = await stackedDeliveryFixture(t, { tasks: 3 });
  const [A, B, C] = f.tasks as [string, string, string];
  await f.waitTurn(A);
  const a1 = await start(f, A, B);
  const b1 = await start(f, B, C);
  succeeded(await f.push(C, await f.commit(C, "c")));

  const a2 = await f.commit(A, "a2");
  succeeded(await f.push(A, a2));
  await until(() => f.restackNotices().length === 1, "B's restack");
  assert.deepEqual(f.restackNotices(), [
    `${B} restack:${repositoryId}:1:${a2}`,
  ]);
  await f.showPr(A);

  const b2 = await rebase(f, B, a1, a2);
  succeeded(await f.push(B, b2, "branch.force-push"));
  await until(() => f.restackNotices().length === 2, "C's restack");
  assert.deepEqual(f.restackNotices(), [
    `${B} restack:${repositoryId}:1:${a2}`,
    `${C} restack:${repositoryId}:1:${b2}`,
  ]);
  assert.equal(f.service.domain().stackFacts(B)?.restack, "current");
  assert.equal(f.service.domain().stackFacts(C)?.parentHead, b2);
  void b1;
});

test("a restack missed before a restart is queued once after it; a Done blocker queues none", async (t) => {
  const f = await stackedDeliveryFixture(t);
  const [B, D] = f.tasks as [string, string];
  await f.waitTurn(B);
  await start(f, B, D);
  const missed = "e".repeat(40);
  await f.restart((db) =>
    db
      .prepare(
        "UPDATE delivery_task_branches SET lastPushedSha = ? WHERE taskId = ?",
      )
      .run(missed, B),
  );
  await until(() => f.restackNotices().length === 1, "the missed restack");
  await f.restart();
  await f.service.refreshGitHub();
  assert.deepEqual(f.restackNotices(), [
    `${D} restack:${repositoryId}:1:${missed}`,
  ]);

  await f.restart((db) => {
    db.prepare("UPDATE domain_tasks SET state = 'done' WHERE id = ?").run(B);
    db.prepare(
      "UPDATE delivery_task_branches SET lastPushedSha = ? WHERE taskId = ?",
    ).run("f".repeat(40), B);
  });
  await f.service.refreshGitHub();
  assert.equal(f.restackNotices().length, 1);
});
