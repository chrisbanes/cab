import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { git } from "../fixtures/publication.js";
import { stackedDeliveryFixture } from "../fixtures/stacked-delivery.js";

/**
 * A through-merge GitLab stacking project, over the real GitLab provider and a scripted instance:
 * `tasks` each blocked by the one before. `open` pushes a task's work and opens its merge request.
 */
async function gitLabStack(t: TestContext, tasks = 2) {
  const f = await stackedDeliveryFixture(t, { codeHost: "gitlab", tasks });
  // A merge needs the project's instructions.
  f.run({
    type: "project.configure",
    projectId: f.projectId,
    expectedVersion: Number(f.service.domain().project(f.projectId).version),
    instructions: "Deliver",
  });
  const policy = f.service.delivery().configuration(f.projectId);
  f.run({
    type: "delivery.configure",
    projectId: f.projectId,
    expectedVersion: policy.version,
    mode: "through-merge",
    credentialRef: null,
    grants: [
      ...policy.grants,
      { action: "pr.create", repositoryId: f.repositoryId, mode: "allow" },
      { action: "pr.merge", repositoryId: f.repositoryId, mode: "allow" },
    ],
    requiredChecks: [],
    repositories: [
      {
        repositoryId: f.repositoryId,
        mergeMethod: "merge",
        requiredChecks: [{ name: "pipeline" }],
      },
    ],
  });
  const mrOf = (taskId: string) => {
    const mr = f.gitlab.state.mergeRequests.find(
      (m) => m.source_branch === f.branchOf(taskId)?.branch,
    );
    assert.ok(mr, `merge request of ${taskId}`);
    return mr;
  };
  const act = (taskId: string, action: Record<string, unknown>) =>
    f.call(taskId, "cab_external_action", {
      operationId: randomUUID(),
      action,
    });
  /** The task's latest action of `kind`. */
  const last = (taskId: string, kind: string) =>
    f.service
      .delivery()
      .actions(taskId)
      .filter((a) => a.request.action.kind === kind)
      .at(-1);
  const create = (taskId: string, baseRef: string) => {
    const branch = f.branchOf(taskId);
    assert.ok(branch?.lastPushedSha);
    return act(taskId, {
      kind: "pr.create",
      target: {
        repositoryId: f.repositoryId,
        baseRef,
        headRef: branch.branch,
        expectedHeadSha: branch.lastPushedSha,
      },
      title: `Change ${taskId}`,
      body: "Body",
      draft: false,
    });
  };
  /** Pushes new work on the task and opens its merge request on `baseRef`, then registers it. */
  const open = async (taskId: string, baseRef = "main") => {
    await f.waitTurn(taskId);
    const head = await f.commit(taskId, `work-${taskId}`);
    assert.equal((await f.push(taskId, head)).success, true);
    const created = await create(taskId, baseRef);
    assert.equal(created.success, true, created.text);
    const mr = mrOf(taskId);
    mr.head_pipeline = {
      id: mr.iid,
      sha: head,
      status: "success",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:04:00Z",
    };
    const registered = await f.call(taskId, "cab_register_pr", {
      repositoryId: f.repositoryId,
      prNumber: mr.iid,
      expectedPrNodeId: String(mr.id),
      expectedHeadSha: head,
    });
    assert.equal(registered.success, true, registered.text);
    await f.service.refreshGitHub();
    return { head, mr };
  };
  /** The lead takes its pending delivery events in its next turn. */
  const nextTurn = async (taskId: string) => {
    const count = (await f.turnsOf(taskId)).length;
    await f.complete(taskId);
    await f.waitTurn(taskId, count + 1);
  };
  const merge = (taskId: string, baseRef: string) => {
    const mr = mrOf(taskId);
    return act(taskId, {
      kind: "pr.merge",
      target: {
        repositoryId: f.repositoryId,
        nodeId: String(mr.id),
        number: mr.iid,
        baseRef,
        headRef: mr.source_branch,
        expectedHeadSha: mr.sha,
      },
      method: "merge",
      reviewedResultIds: [],
    });
  };
  /** Requests sent while `run` runs. */
  const requestsDuring = async (run: () => Promise<unknown>) => {
    const before = f.gitlab.requests.length;
    await run();
    return f.gitlab.requests.slice(before);
  };
  return {
    ...f,
    mrOf,
    act,
    last,
    create,
    open,
    nextTurn,
    merge,
    requestsDuring,
  };
}

test("a GitLab dependent's merge request must target its blocker's branch, refused before any request", async (t) => {
  const f = await gitLabStack(t);
  const [a, b] = f.tasks as [string, string];
  await f.open(a);
  await f.waitTurn(b);
  const head = await f.commit(b, "dependent");
  assert.equal((await f.push(b, head)).success, true);
  const sent = await f.requestsDuring(() => f.create(b, "main"));
  assert.deepEqual(sent, []);
  assert.equal(
    f.last(b, "pr.create")?.observation?.reason,
    "stacked-pr-base-must-match-blocker-branch",
  );
  const lower = f.branchOf(a)!.branch;
  const created = await f.create(b, lower);
  assert.equal(created.success, true, created.text);
  assert.equal(f.mrOf(b).target_branch, lower);
  assert.equal(f.last(b, "pr.create")?.stackCreate, undefined);
});

/** A blocked by nothing, B stacked on A: both merge requests open and registered. */
async function twoLayer(t: TestContext) {
  const f = await gitLabStack(t);
  const [a, b] = f.tasks as [string, string];
  await f.open(a);
  const lower = f.branchOf(a)!.branch;
  await f.open(b, lower);
  return { ...f, a, b, lower };
}

test("merging a stacked blocker removes its branch, GitLab retargets the dependent, and merges go bottom-up", async (t) => {
  const f = await twoLayer(t);
  const refused = await f.requestsDuring(() => f.merge(f.b, f.lower));
  assert.deepEqual(refused, []);
  assert.equal(
    f.last(f.b, "pr.merge")?.observation?.reason,
    "stacked-lower-pr-unmerged",
  );
  const lowerMr = f.mrOf(f.a);
  const merged = await f.merge(f.a, "main");
  assert.equal(merged.success, true, merged.text);
  assert.deepEqual(f.gitlab.merges, [
    {
      route: "merge",
      body: {
        sha: lowerMr.sha,
        squash: false,
        auto_merge: false,
        should_remove_source_branch: true,
      },
    },
  ]);
  assert.equal(f.gitlab.state.heads.has(f.lower), false);
  assert.equal(f.mrOf(f.b).target_branch, "main");
  await f.service.refreshGitHub();
  const bound = f.service.delivery().delivery(f.b);
  assert.equal(bound?.acceptedBaseRef, "main");
  assert.equal(bound?.acceptedRetarget?.fromRef, f.lower);
  // GitLab moved nothing on the dependent's branch, so nothing is adopted.
  assert.equal(f.rebaseProofCount(), 0);
  // The dependent's lead takes the retarget before it merges.
  await f.nextTurn(f.b);
  const top = await f.merge(f.b, "main");
  assert.equal(top.success, true, top.text);
  assert.equal(f.last(f.b, "pr.merge")?.state, "confirmed-success");
  assert.deepEqual(f.gitlab.merges[1]?.body, {
    sha: f.mrOf(f.b).sha,
    squash: false,
    auto_merge: false,
  });
});

test("a merge request with no stacked dependent merges with GitLab's plain body", async (t) => {
  const f = await gitLabStack(t, 1);
  const [a] = f.tasks as [string];
  const { mr } = await f.open(a);
  const merged = await f.merge(a, "main");
  assert.equal(merged.success, true, merged.text);
  assert.deepEqual(f.gitlab.merges, [
    {
      route: "merge",
      body: { sha: mr.sha, squash: false, auto_merge: false },
    },
  ]);
});

test("a blocker whose dependent has no merge request on its branch merges without removal", async (t) => {
  const f = await gitLabStack(t);
  const [a, b] = f.tasks as [string, string];
  await f.open(a);
  await f.waitTurn(b);
  assert.equal((await f.push(b, await f.commit(b, "dependent"))).success, true);
  assert.equal((await f.merge(a, "main")).success, true);
  assert.equal(
    "should_remove_source_branch" in f.gitlab.merges[0]!.body,
    false,
  );
});

test("a dependent retargeted elsewhere outside cab gets no removal for its blocker", async (t) => {
  const f = await twoLayer(t);
  f.mrOf(f.b).target_branch = "elsewhere";
  await f.service.refreshGitHub();
  assert.equal((await f.merge(f.a, "main")).success, true);
  assert.equal(
    "should_remove_source_branch" in f.gitlab.merges[0]!.body,
    false,
  );
});

test("a dependent still targeting a merged blocker's branch is held until GitLab retargets it", async (t) => {
  const f = await twoLayer(t);
  f.gitlab.state.ignoreRemoval = true;
  assert.equal((await f.merge(f.a, "main")).success, true);
  await f.service.refreshGitHub();
  assert.equal(f.mrOf(f.b).target_branch, f.lower);
  const sent = await f.requestsDuring(() => f.merge(f.b, f.lower));
  assert.deepEqual(sent, []);
  assert.equal(
    f.last(f.b, "pr.merge")?.observation?.reason,
    "stacked-pr-retarget-pending",
  );
});

test("a dependent that changes during the blocker's merge preflight refuses the merge unsent", async (t) => {
  const f = await twoLayer(t);
  const path = `/api/v4/projects/${f.repositoryId}/merge_requests/${f.mrOf(f.a).iid}`;
  f.gitlab.state.intercept = (method, requested) => {
    if (method === "GET" && requested === path) {
      f.gitlab.state.intercept = undefined;
      f.service.delivery().recordPrReadFailure(f.b);
    }
    return undefined;
  };
  await f.merge(f.a, "main");
  assert.deepEqual(f.gitlab.merges, []);
  assert.equal(
    f.last(f.a, "pr.merge")?.observation?.reason,
    "delivery-authority-stale-or-held",
  );
});

test("a blocker closed unmerged holds its GitLab dependent as failed", async (t) => {
  const f = await twoLayer(t);
  f.mrOf(f.a).state = "closed";
  await f.service.refreshGitHub();
  assert.ok(
    f.service
      .domain()
      .admission(f.b)
      .reasons.includes("stacked-blocker-failed"),
  );
});

/** B stacked on A, ready for the operator's Unstack of B through the operator API's preview. */
async function unstackable(t: TestContext) {
  const f = await twoLayer(t);
  const path = `/api/v4/projects/${f.repositoryId}/merge_requests/${f.mrOf(f.b).iid}`;
  const edits = () =>
    f.gitlab.requests.filter(
      (r) => r.init.method === "PUT" && new URL(r.url).pathname === path,
    );
  const preview = async () => {
    const read = await new OperatorApi(f.service, [f.root]).readUnstack(f.b);
    assert.ok(
      read.data.preview,
      `preview unavailable: ${read.data.unavailable}`,
    );
    return read.data.preview;
  };
  const unstack = async () => {
    const p = await preview();
    const key = randomUUID();
    const record = await f.service.unstackTask({
      key,
      taskId: f.b,
      expectedVersion: p.expectedVersion,
      materialHash: p.materialHash,
    });
    return { key, record };
  };
  const restacks = (key: string) =>
    f.readDb(
      (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_external_delivery_notices WHERE taskId=? AND identity=?",
          )
          .get(f.b, `unstack-restack:${key}`)?.n,
    );
  return { ...f, path, edits, preview, unstack, restacks };
}

for (const failed of [false, true])
  test(`GitLab Unstack of a dependent ${failed ? "held by a failed blocker " : ""}retargets only its merge request and queues one restack`, async (t) => {
    const f = await unstackable(t);
    if (failed) {
      f.mrOf(f.a).state = "closed";
      await f.service.refreshGitHub();
      assert.ok(
        f.service
          .domain()
          .admission(f.b)
          .reasons.includes("stacked-blocker-failed"),
      );
    }
    const preview = await f.preview();
    assert.equal(preview.codeHost, "gitlab");
    assert.equal(preview.stackNumber, null);
    assert.equal(preview.repository, "group/app");
    assert.deepEqual(preview.members, [
      { number: f.mrOf(f.a).iid, state: failed ? "CLOSED" : "OPEN" },
      { number: f.mrOf(f.b).iid, state: "OPEN" },
    ]);
    const { key, record } = await f.unstack();
    assert.equal(record.phase, "confirmed");
    assert.deepEqual(
      f.edits().map((r) => JSON.parse(String(r.init.body))),
      [{ target_branch: "main" }],
    );
    assert.equal(f.service.delivery().delivery(f.b)?.acceptedBaseRef, "main");
    assert.equal(f.service.domain().activeStackedDependency(f.b), null);
    assert.equal(
      f.readDb(
        (db) =>
          db
            .prepare(
              "SELECT parentHead FROM stacked_dependencies WHERE taskId=?",
            )
            .get(f.b)?.parentHead,
      ),
      f.base,
    );
    assert.equal(f.restacks(key), 1);
    if (failed) return;
    // A retired edge has no dependent to retarget, so the blocker merges without removal.
    const merged = await f.merge(f.a, "main");
    assert.equal(merged.success, true, merged.text);
    assert.equal(
      "should_remove_source_branch" in f.gitlab.merges[0]!.body,
      false,
    );
  });

test("a lost GitLab Unstack response settles by read-back without a second edit", async (t) => {
  const f = await unstackable(t);
  // The edit applies but its response is lost, and so is the read that follows it.
  f.gitlab.state.intercept = (method, requested) => {
    if (method !== "PUT" || requested !== f.path) return undefined;
    f.mrOf(f.b).target_branch = "main";
    f.gitlab.state.intercept = (next, read) => {
      if (next !== "GET" || read !== f.path) return undefined;
      f.gitlab.state.intercept = undefined;
      throw new TypeError("fetch failed");
    };
    throw new TypeError("fetch failed");
  };
  const { key, record } = await f.unstack();
  assert.equal(record.phase, "unstack-attempting");
  assert.equal(f.restacks(key), 0);
  assert.equal((await f.service.reconcileTaskUnstack(key)).phase, "confirmed");
  assert.equal(f.edits().length, 1);
  assert.equal(f.restacks(key), 1);
});

test("a GitLab Unstack edit refused with 422 fails with no further writes", async (t) => {
  const f = await unstackable(t);
  f.gitlab.state.intercept = (method, requested) =>
    method === "PUT" && requested === f.path
      ? new Response("{}", { status: 422 })
      : undefined;
  const writes = () =>
    f.gitlab.requests.filter((r) => r.init.method !== "GET").length;
  const before = writes();
  const { record } = await f.unstack();
  assert.equal(record.phase, "failed");
  assert.equal(record.reason, "unstack-refused");
  assert.equal(writes() - before, 1);
  assert.equal(f.mrOf(f.b).target_branch, f.lower);
});

test("a GitLab merge request retargeted outside cab after the preview is not edited", async (t) => {
  const f = await unstackable(t);
  // The preview reads the merge request first; the journal's own read sees it moved.
  let reads = 0;
  f.gitlab.state.intercept = (method, requested) => {
    if (method === "GET" && requested === f.path && ++reads === 3)
      f.mrOf(f.b).target_branch = "elsewhere";
    return undefined;
  };
  const { record } = await f.unstack();
  assert.equal(record.reason, "identity-changed");
  assert.deepEqual(f.edits(), []);
});

/**
 * A merged with removal and B's retarget accepted; `rebase` then replays B outside cab onto the new
 * `main` (A merged with a merge commit), as an outside writer would, and GitLab shows it.
 */
async function retargeted(t: TestContext) {
  const f = await twoLayer(t);
  assert.equal((await f.merge(f.a, "main")).success, true);
  await f.service.refreshGitHub();
  assert.equal(f.service.delivery().delivery(f.b)?.acceptedBaseRef, "main");
  await f.workspaceOf(f.b);
  const lowerHead = f.branchOf(f.a)!.lastPushedSha!,
    oldHead = f.branchOf(f.b)!.lastPushedSha!;
  git(f.source, "checkout", "-q", "--detach", f.base);
  git(f.source, "merge", "-q", "--no-ff", "-m", "Merge lower", lowerHead);
  const newBase = git(f.source, "rev-parse", "HEAD");
  git(f.source, "cherry-pick", oldHead);
  const newHead = git(f.source, "rev-parse", "HEAD");
  const rebase = async (head = newHead) => {
    f.gitlab.state.heads.set("main", newBase);
    f.gitlab.state.heads.set(f.mrOf(f.b).source_branch, head);
    Object.assign(f.mrOf(f.b), { sha: head, diff_refs: { base_sha: newBase } });
    await f.service.refreshGitHub();
  };
  return { ...f, lowerHead, oldHead, newBase, newHead, rebase };
}

test("an unchanged outside rebase after an accepted GitLab retarget is adopted with its proof", async (t) => {
  const f = await retargeted(t);
  await f.rebase();
  const proofs = f.service.delivery().delivery(f.b)?.rebaseProofs ?? [];
  assert.deepEqual(
    proofs.map((p) => [p.oldBase, p.oldHead, p.newBase, p.newHead]),
    [[f.lowerHead, f.oldHead, f.newBase, f.newHead]],
  );
  assert.deepEqual(
    f.readDb((db) => ({
      ...db
        .prepare(
          "SELECT parentHead, settledHead FROM stacked_dependencies WHERE taskId=?",
        )
        .get(f.b),
    })),
    { parentHead: f.newBase, settledHead: f.newBase },
  );
  assert.equal(
    (await f.service.taskWorkspace(f.b))?.repositories[0]?.commit,
    f.newBase,
  );
  assert.equal(f.branchOf(f.b)?.lastPushedSha, f.newHead);
  assert.equal(
    f.readDb(
      (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_external_delivery_notices WHERE taskId=? AND identity=?",
          )
          .get(f.b, `stack-rebase:${f.newHead}`)?.n,
    ),
    1,
  );
  assert.deepEqual(f.service.coordinationView().readTask(f.b).approvals, []);
});

test("a reworded outside rebase after a GitLab retarget keeps the outside-change hold", async (t) => {
  const f = await retargeted(t);
  git(f.source, "commit", "--amend", "-qm", "reworded");
  const changed = git(f.source, "rev-parse", "HEAD");
  await f.rebase(changed);
  assert.equal(f.service.delivery().delivery(f.b)?.rebaseProofs, undefined);
  assert.equal(f.branchOf(f.b)?.lastPushedSha, f.oldHead);
  assert.equal(f.branchOf(f.b)?.outsideHeadSha, changed);
});
