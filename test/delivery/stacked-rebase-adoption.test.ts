import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { git } from "../fixtures/publication.js";
import {
  stackedDeliveryFixture,
  repositoryId,
} from "../fixtures/stacked-delivery.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";

async function prepared(t: TestContext) {
  const f = await stackedDeliveryFixture(t);
  const [lower, dependent] = f.tasks as [string, string];
  await f.waitTurn(lower);
  const lowerHead = await f.commit(lower, "lower");
  assert.equal((await f.push(lower, lowerHead)).success, true);
  await f.showPr(lower);
  await f.service.refreshGitHub();
  await f.waitTurn(dependent);
  const oldHead = await f.commit(dependent, "dependent");
  assert.equal((await f.push(dependent, oldHead)).success, true);
  const lowerBranch = f.branchOf(lower)!.branch;
  await f.showPr(dependent, { baseRef: lowerBranch, baseSha: lowerHead });
  const oldPr = f.prs.get(`PR-${dependent}`)!;
  const lowerPr = f.prs.get(`PR-${lower}`)!;
  // The outside writer shares objects with the fixture worktrees, never modifies the dependent checkout.
  git(f.source, "checkout", "-q", "--detach", f.base);
  git(f.source, "merge", "--squash", lowerHead);
  git(f.source, "commit", "-qm", "squashed lower");
  const newBase = git(f.source, "rev-parse", "HEAD");
  git(f.source, "cherry-pick", oldHead);
  const newHead = git(f.source, "rev-parse", "HEAD");
  const publish = () => {
    f.prs.set(lowerPr.nodeId, { ...lowerPr, state: "MERGED", merged: true });
    f.prs.set(oldPr.nodeId, {
      ...oldPr,
      baseRef: "main",
      baseSha: newBase,
      headSha: newHead,
      retarget: { fromRef: lowerBranch, priorMerged: true },
    });
    f.remote[oldPr.headRef] = newHead;
  };
  const workspace = (await f.workspaceOf(dependent)).path;
  const image = () => ({
    head: git(workspace, "rev-parse", "HEAD"),
    status: git(workspace, "status", "--porcelain"),
    index: readFileSync(
      git(
        workspace,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ),
    ),
    contents: readFileSync(`${workspace}/dependent.txt`),
  });
  return {
    ...f,
    lower,
    dependent,
    lowerHead,
    oldHead,
    newBase,
    newHead,
    oldPr,
    lowerPr,
    publish,
    image,
    currentService: () => f.service,
  };
}

test("bound lower merge and accepted retarget adopt exactly proved commits and preserve workspace across restart", async (t) => {
  const f = await prepared(t),
    before = f.image();
  f.publish();
  await f.currentService().refreshGitHub();
  const binding = f.currentService().delivery().delivery(f.dependent)!;
  const proof = binding.rebaseProofs?.[0];
  assert.deepEqual(
    [proof?.oldBase, proof?.oldHead, proof?.newBase, proof?.newHead],
    [f.lowerHead, f.oldHead, f.newBase, f.newHead],
  );
  assert.equal(proof?.pairs.length, 1);
  assert.equal(proof?.pairs[0]?.oldCommit, f.oldHead);
  assert.equal(proof?.pairs[0]?.newCommit, f.newHead);
  assert.match(proof!.pairs[0]!.messageSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    f.currentService().delivery().taskBranch(f.dependent, repositoryId)
      ?.lastPushedSha,
    f.newHead,
  );
  assert.equal(
    f.currentService().delivery().taskBranch(f.dependent, repositoryId)
      ?.outsideHeadSha,
    null,
  );
  assert.equal(
    f.currentService().domain().stackedDependency(f.dependent)?.parentHead,
    f.newBase,
  );
  assert.equal(
    (await f.currentService().taskWorkspace(f.dependent))?.repositories[0]
      ?.commit,
    f.newBase,
  );
  assert.deepEqual(f.image(), before);
  const api = new OperatorApi(f.currentService(), [f.root]);
  assert.deepEqual(
    (await api.readTask(f.dependent)).data.stackDelivery?.rebaseProofs,
    [proof],
  );
  const count = f.rebaseProofCount();
  await f.currentService().refreshGitHub();
  assert.equal(f.rebaseProofCount(), count);
  await f.restart();
  assert.deepEqual(
    f.currentService().delivery().delivery(f.dependent)?.rebaseProofs,
    [proof],
  );
  assert.deepEqual(f.image(), before);
});

for (const change of [
  "ref",
  "base",
  "head",
  "task",
  "edge",
  "workspace",
  "pause",
  "branch",
  "policy",
] as const)
  test(`a ${change} change across the proof await retains outside-head recovery authority`, async (t) => {
    const f = await prepared(t);
    f.publish();
    f.onRebaseProof(() => {
      if (change === "ref") f.remote[f.oldPr.headRef] = "f".repeat(40);
      else if (change === "base" || change === "head")
        f.prs.set(f.oldPr.nodeId, {
          ...f.prs.get(f.oldPr.nodeId)!,
          [change === "base" ? "baseSha" : "headSha"]: "f".repeat(40),
        });
      else if (change === "pause")
        f.run({
          type: "project.configure",
          projectId: f.projectId,
          expectedVersion: Number(
            f.currentService().domain().project(f.projectId).version,
          ),
          paused: true,
        });
      else
        f.readDb((db) => {
          if (change === "task")
            db.prepare(
              "UPDATE domain_tasks SET version=version+1 WHERE id=?",
            ).run(f.dependent);
          if (change === "edge")
            db.prepare(
              "UPDATE stacked_dependencies SET restackSeq=restackSeq+1 WHERE taskId=?",
            ).run(f.dependent);
          if (change === "branch")
            db.prepare(
              "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
            ).run(f.lowerHead, f.dependent);
          if (change === "workspace")
            db.prepare(
              "UPDATE task_workspace_bindings SET updatedAt='2099-01-01T00:00:00.000Z' WHERE taskId=?",
            ).run(f.dependent);
          // Policy changes invalidate the captured automatic-adoption authority.
          if (change === "policy")
            db.prepare(
              "UPDATE delivery_policies SET version=version+1 WHERE projectId=?",
            ).run(f.projectId);
        });
    });
    await f.currentService().refreshGitHub();
    assert.equal(
      f.currentService().delivery().delivery(f.dependent)?.rebaseProofs,
      undefined,
    );
    assert.notEqual(
      f.currentService().delivery().taskBranch(f.dependent, repositoryId)
        ?.outsideHeadSha,
      null,
    );
  });

for (const state of ["OPEN", "CLOSED", "unknown"] as const)
  test(`a ${state} lower PR cannot authorize automatic adoption`, async (t) => {
    const f = await prepared(t);
    f.publish();
    if (state === "unknown") f.prs.delete(f.lowerPr.nodeId);
    else f.prs.set(f.lowerPr.nodeId, { ...f.lowerPr, state, merged: false });
    await f.currentService().refreshGitHub();
    assert.equal(f.rebaseProofCount(), 0);
    assert.equal(
      f.currentService().delivery().delivery(f.dependent)?.rebaseProofs,
      undefined,
    );
  });

test("a reworded outside head keeps approval-only adoption and no automatic receipt", async (t) => {
  const f = await prepared(t);
  git(f.source, "commit", "--amend", "-qm", "reworded");
  const changed = git(f.source, "rev-parse", "HEAD");
  f.publish();
  f.remote[f.oldPr.headRef] = changed;
  f.prs.set(f.oldPr.nodeId, {
    ...f.prs.get(f.oldPr.nodeId)!,
    headSha: changed,
  });
  await f.currentService().refreshGitHub();
  assert.equal(
    f.currentService().delivery().delivery(f.dependent)?.rebaseProofs,
    undefined,
  );
  assert.equal(
    f.currentService().delivery().taskBranch(f.dependent, repositoryId)
      ?.lastPushedSha,
    f.oldHead,
  );
  assert.equal(
    f.currentService().delivery().taskBranch(f.dependent, repositoryId)
      ?.outsideHeadSha,
    changed,
  );
});

for (const cause of ["closed", "cancelled"] as const)
  test(`${cause} lower holds the dependent and a separate Cancel is terminal and replayable`, async (t) => {
    const f = await prepared(t);
    if (cause === "closed")
      f.prs.set(f.lowerPr.nodeId, {
        ...f.lowerPr,
        state: "CLOSED",
        merged: false,
      });
    else
      f.run({
        type: "task.configure",
        projectId: f.projectId,
        taskId: f.lower,
        expectedVersion: Number(
          f.currentService().domain().task(f.lower).version,
        ),
        state: "cancelled",
      });
    await f.currentService().refreshGitHub();
    const d = f.currentService().domain();
    assert.equal(d.stackFacts(f.dependent)?.reason, "blocker-failed");
    assert.ok(
      d.admission(f.dependent).reasons.includes("stacked-blocker-failed"),
    );
    assert.equal((await f.push(f.dependent, f.oldHead)).success, false);
    const api = new OperatorApi(f.currentService(), [f.root]);
    assert.equal(
      (await api.readTask(f.dependent)).data.stackDelivery?.failedBlocker,
      true,
    );
    const command = {
      type: "task.cancel",
      key: randomUUID(),
      taskId: f.dependent,
      expectedVersion: Number(d.task(f.dependent).version),
    };
    const receipt = await api.execute(command);
    assert.equal(receipt.kind, "task-cancel");
    assert.equal(d.task(f.dependent).state, "cancelled");
    assert.equal(
      f.readDb(
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM task_writer_holds WHERE taskId=? AND holdKind='operator-stop'",
            )
            .get(f.dependent)!.n,
      ),
      0,
    );
    assert.deepEqual(await api.execute(command), receipt);
    await assert.rejects(
      api.execute({ ...command, expectedVersion: command.expectedVersion + 1 }),
    );
    assert.equal(f.prs.get(f.oldPr.nodeId)?.state, "OPEN");
    assert.ok(await f.currentService().taskWorkspace(f.dependent));
    await f.restart();
    assert.equal(
      f.currentService().domain().task(f.dependent).state,
      "cancelled",
    );
    assert.deepEqual(
      await new OperatorApi(f.currentService(), [f.root]).execute(command),
      receipt,
    );
  });

test("an approval opened during proof prevents automatic adoption", async (t) => {
  const f = await prepared(t);
  f.publish();
  f.onRebaseProof(async () => {
    const action = {
      kind: "branch.adopt",
      target: { repositoryId },
      outsideHeadSha: f.newHead,
      lastPushedSha: f.oldHead,
    };
    const response = await f.call(f.dependent, "cab_request_approval", {
      action: action.kind,
      target: JSON.stringify(action.target),
      material: action,
    });
    assert.equal(response.success, true, response.text);
  });
  await f.currentService().refreshGitHub();
  assert.equal(
    f.currentService().delivery().delivery(f.dependent)?.rebaseProofs,
    undefined,
  );
  assert.equal(
    f.currentService().delivery().taskBranch(f.dependent, repositoryId)
      ?.outsideHeadSha,
    f.newHead,
  );
});

test("excluded proof material is withheld through the existing operator read fence", async (t) => {
  const f = await prepared(t);
  f.publish();
  await f.currentService().refreshGitHub();
  const proof = f.currentService().delivery().delivery(f.dependent)!
    .rebaseProofs![0]!;
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(
      f.currentService().domain().project(f.projectId).version,
    ),
    instructions: proof.pairs[0]!.messageSha256,
  });
  const api = new OperatorApi(f.currentService(), [f.root]);
  const read = await api.readTask(f.dependent);
  assert.equal(read.data.stackDelivery?.rebaseProofs, null);
  assert.ok(!JSON.stringify(read).includes(proof.pairs[0]!.messageSha256));
});

test("an unknown lower read holds as unknown; a merged lower never becomes failed", async (t) => {
  const f = await prepared(t);
  f.prs.delete(f.lowerPr.nodeId);
  await f.currentService().refreshGitHub();
  assert.equal(
    f.currentService().domain().stackFacts(f.dependent)?.reason,
    "blocker-unknown",
  );
  const command = {
    type: "task.cancel",
    key: randomUUID(),
    taskId: f.dependent,
    expectedVersion: Number(
      f.currentService().domain().task(f.dependent).version,
    ),
  };
  await assert.rejects(
    new OperatorApi(f.currentService(), [f.root]).execute(command),
  );
  f.prs.set(f.lowerPr.nodeId, { ...f.lowerPr, state: "MERGED", merged: true });
  await f.currentService().refreshGitHub();
  assert.notEqual(
    f.currentService().domain().stackFacts(f.dependent)?.reason,
    "blocker-failed",
  );
});

test("the service registry prevents archive while proof is in flight", async (t) => {
  const f = await prepared(t);
  f.publish();
  f.onRebaseProof(() => {
    assert.throws(
      () =>
        f.run({
          type: "project.archive",
          projectId: f.projectId,
          expectedVersion: Number(
            f.currentService().domain().project(f.projectId).version,
          ),
        }),
      (error: unknown) => {
        const blockers = (error as { blockers?: { kind: string }[] }).blockers;
        assert.ok(blockers?.some((b) => b.kind === "provider-write"));
        return true;
      },
    );
  });
  await f.currentService().refreshGitHub();
  assert.equal(
    f.currentService().delivery().delivery(f.dependent)?.rebaseProofs?.length,
    1,
  );
});

test("Cancel retains unresolved execution ownership, independent holds and no-repeat targets", async (t) => {
  const f = await prepared(t);
  f.prs.set(f.lowerPr.nodeId, { ...f.lowerPr, state: "CLOSED", merged: false });
  await f.currentService().refreshGitHub();
  const before = f.readDb((db) =>
    db
      .prepare(
        `SELECT e.workId FROM execution_intents e JOIN task_execution_bindings b ON b.workId=e.workId WHERE b.taskId=? AND e.state='running'`,
      )
      .all(f.dependent),
  );
  assert.ok(before.length);
  f.readDb((db) => {
    db.prepare(
      "INSERT OR IGNORE INTO task_writer_ambiguity_holds(taskId,reason) VALUES (?,?)",
    ).run(f.dependent, "Keep unresolved owner");
    db.prepare(
      "UPDATE execution_intents SET state='held', reason='Known unfinished execution' WHERE workId=?",
    ).run(String(before[0]!.workId));
  });
  const command = {
    key: randomUUID(),
    taskId: f.dependent,
    expectedVersion: Number(
      f.currentService().domain().task(f.dependent).version,
    ),
  };
  const receipt = await f.currentService().cancelStackedTask(command);
  assert.equal(receipt.kind, "task-cancel");
  const holds = f.readDb((db) =>
    db
      .prepare("SELECT * FROM task_writer_ambiguity_holds WHERE taskId=?")
      .all(f.dependent),
  );
  assert.equal(holds.length, 1);
  assert.equal(holds[0]!.reason, "Keep unresolved owner");
  assert.equal(
    f.currentService().domain().task(f.dependent).state,
    "cancelled",
  );
  const state = f.readDb((db) =>
    db
      .prepare(
        "SELECT receiptJson FROM task_control_receipts WHERE taskId=? AND key=?",
      )
      .get(f.dependent, command.key),
  );
  assert.ok(state);
  assert.deepEqual(
    await f.currentService().cancelStackedTask(command),
    receipt,
  );
  assert.ok(f.currentService().domain().admission(f.dependent).reasons.length);
});

test("a delivery originally registered on trunk cannot claim accepted stack retarget provenance", async (t) => {
  const f = await prepared(t);
  f.publish();
  f.readDb((db) => {
    const row = db
      .prepare("SELECT recordJson FROM delivery_pr_bindings WHERE taskId=?")
      .get(f.dependent)!;
    const record = JSON.parse(String(row.recordJson));
    record.acceptedBaseRef = "main";
    delete record.acceptedRetarget;
    db.prepare(
      "UPDATE delivery_pr_bindings SET recordJson=? WHERE taskId=?",
    ).run(JSON.stringify(record), f.dependent);
  });
  await f.currentService().refreshGitHub();
  assert.equal(f.rebaseProofCount(), 0);
  assert.equal(
    f.currentService().delivery().delivery(f.dependent)?.rebaseProofs,
    undefined,
  );
});

test("independent Ready and pause holds remain after failed-edge Cancel", async (t) => {
  const f = await prepared(t);
  f.prs.set(f.lowerPr.nodeId, { ...f.lowerPr, state: "CLOSED", merged: false });
  await f.currentService().refreshGitHub();
  // Ready and project pause remain independent of the selected failed edge.
  f.run({
    type: "task.configure",
    projectId: f.projectId,
    taskId: f.dependent,
    expectedVersion: Number(
      f.currentService().domain().task(f.dependent).version,
    ),
    ready: false,
  });
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(
      f.currentService().domain().project(f.projectId).version,
    ),
    paused: true,
  });
  const d = f.currentService().domain();
  assert.equal(d.failedStackedBlocker(f.dependent), true);
  const reasons = d.admission(f.dependent).reasons;
  assert.ok(reasons.includes("stacked-blocker-failed"));
  assert.ok(reasons.includes("task-unready"));
  assert.ok(reasons.includes("project-paused"));
  await f.currentService().cancelStackedTask({
    key: randomUUID(),
    taskId: f.dependent,
    expectedVersion: Number(d.task(f.dependent).version),
  });
  assert.equal(d.project(f.projectId).paused, 1);
  assert.equal(d.task(f.dependent).ready, 0);
  assert.ok(d.stackedDependency(f.dependent));
});

test("a malformed retained Cancel receipt refuses replay without repeating cancellation", async (t) => {
  const f = await prepared(t);
  f.prs.set(f.lowerPr.nodeId, { ...f.lowerPr, state: "CLOSED", merged: false });
  await f.currentService().refreshGitHub();
  const command = {
    key: randomUUID(),
    taskId: f.dependent,
    expectedVersion: Number(
      f.currentService().domain().task(f.dependent).version,
    ),
  };
  await f.currentService().cancelStackedTask(command);
  f.readDb((db) =>
    db
      .prepare(
        "UPDATE task_control_receipts SET receiptJson=? WHERE taskId=? AND key=?",
      )
      .run(
        JSON.stringify({
          kind: "task-cancel",
          recorded: true,
          taskId: f.lower,
          key: command.key,
          cancellationRequested: 0,
        }),
        f.dependent,
        command.key,
      ),
  );
  await assert.rejects(
    f.currentService().cancelStackedTask(command),
    /identity/,
  );
  assert.equal(
    f.currentService().domain().task(f.dependent).state,
    "cancelled",
  );
});

test("a stale closed-unmerged observation followed by a read failure is unknown rather than failed", async (t) => {
  const f = await prepared(t);
  f.prs.set(f.lowerPr.nodeId, { ...f.lowerPr, state: "CLOSED", merged: false });
  await f.currentService().refreshGitHub();
  assert.equal(
    f.currentService().domain().failedStackedBlocker(f.dependent),
    true,
  );
  f.prs.delete(f.lowerPr.nodeId);
  await f.currentService().refreshGitHub();
  assert.equal(
    f.currentService().domain().failedStackedBlocker(f.dependent),
    false,
  );
  assert.equal(
    f.currentService().domain().stackFacts(f.dependent)?.reason,
    "blocker-unknown",
  );
});
