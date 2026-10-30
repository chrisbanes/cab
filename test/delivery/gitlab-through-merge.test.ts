import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  assertNoToken,
  branchOf,
  gitlabWorld,
  opened,
} from "../fixtures/gitlab-delivery.js";

type World = Awaited<ReturnType<typeof gitlabWorld>>;

const pipeline = (sha: string, status: string) => ({
  id: 54,
  sha,
  status,
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:04:00Z",
});

/** A through-merge project where the lead may push, open and merge. */
async function throughMerge(w: World, mergeTrains = false) {
  w.f.grant(
    { action: "branch.push", mode: "allow" },
    { action: "pr.create", mode: "allow" },
    { action: "pr.merge", mode: "allow" },
  );
  const delivery = w.f.service.delivery();
  w.f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: w.f.projectId,
    expectedVersion: delivery.configuration(w.f.projectId).version,
    mode: "through-merge",
    credentialRef: null,
    grants: delivery.configuration(w.f.projectId).grants,
    requiredChecks: [{ name: "pipeline" }],
  });
  w.remote.state.project = {
    id: 42,
    path_with_namespace: "group/sub/app",
    merge_trains_enabled: mergeTrains,
  };
  const pr = await opened(w, false);
  const refresh = () =>
    w.f.service.coordinationView().refreshDelivery(w.f.taskId);
  const observation = () =>
    w.f.service.delivery().delivery(w.f.taskId)?.observation;
  const blockers = () =>
    w.f.service.delivery().completionBlockers(w.f.taskId, 1);
  const merge = (expectedHeadSha = pr.sha, turn?: number) =>
    pr.act(
      {
        kind: "pr.merge",
        target: { ...pr.pr, expectedHeadSha },
        method: "squash",
        reviewedResultIds: [],
      },
      {},
      turn,
    );
  const mergeWrites = () => w.remote.merges.length;
  /** The lead's merge action and what the last read of it showed. */
  const action = () => {
    const a = w.f.service
      .delivery()
      .actions(w.f.taskId)
      .find((x) => x.request.action.kind === "pr.merge");
    return { state: a?.state, reason: a?.observation?.reason };
  };
  return { ...pr, refresh, observation, blockers, merge, mergeWrites, action };
}

test("a merge is refused with GitLab's reason until the merge request is mergeable and cab's check passes", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const m = await throughMerge(w);
    // The request stopped being mergeable after the last poll: the merge reads it again and refuses.
    Object.assign(m.mr, {
      head_pipeline: pipeline(m.sha, "running"),
      detailed_merge_status: "ci_still_running",
    });
    const requests = w.remote.requests.length;
    const refused = await m.merge();
    assert.equal(refused.success, false);
    assert.match(refused.text, /provider-preflight-held/);
    assert.equal(m.mergeWrites(), 0);
    assert.equal(
      w.remote.requests.slice(requests).filter((r) => r.init.method !== "GET")
        .length,
      0,
    );
    await m.refresh();
    assert.deepEqual(m.observation()?.mergeBlockers, [
      "check-pipeline-unproved",
      "merge-status-ci_still_running",
    ]);

    Object.assign(m.mr, {
      head_pipeline: pipeline(m.sha, "success"),
      detailed_merge_status: "mergeable",
    });
    await m.refresh();
    assert.deepEqual(m.observation()?.mergeBlockers, []);
    assert.deepEqual(m.observation()?.allowedMethods, ["merge", "squash"]);
    assert.ok(m.blockers().includes("pr-not-confirmed-merged"));
    // The lead takes the polls' wake-ups in its next turn before it may merge.
    await w.f.terminal(1);
    await w.f.waitTurn(2);
    const merged = await m.merge(m.sha, 2);
    assert.equal(merged.success, true, merged.text);
    assert.deepEqual(w.remote.merges, [
      {
        route: "merge",
        body: { sha: m.sha, squash: true, auto_merge: false },
      },
    ]);
    await m.refresh();
    assert.equal(m.observation()?.merged, true);
    assert.deepEqual(m.blockers(), []);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("a merge is leased to cab's last push and to through-merge mode", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const m = await throughMerge(w);
    const requests = w.remote.requests.length;
    const stale = await m.merge("9".repeat(40));
    assert.equal(stale.success, false);
    assert.match(stale.text, /delivery-authority-denied/);
    assert.equal(w.remote.requests.length, requests);

    const delivery = w.f.service.delivery();
    w.f.service.domain().execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: w.f.projectId,
      expectedVersion: delivery.configuration(w.f.projectId).version,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: delivery.configuration(w.f.projectId).grants,
      requiredChecks: [{ name: "pipeline" }],
    });
    const forbidden = await m.merge();
    assert.equal(forbidden.success, false);
    assert.match(forbidden.text, /delivery-authority-denied/);
    assert.equal(w.remote.requests.length, requests);
    assert.equal(m.mergeWrites(), 0);
  } finally {
    await w.f.close();
  }
});

test("a merged merge request is acceptance even at a head cab did not push", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const m = await throughMerge(w);
    const outside = "5".repeat(40);
    w.remote.state.head = outside;
    await w.push(w.commit("two.txt"));
    assert.equal(branchOf(w)?.outsideHeadSha, outside);
    assert.ok(m.blockers().includes("task-branch-outside-change"));
    Object.assign(m.mr, { state: "merged", sha: outside });
    await m.refresh();
    assert.equal(m.observation()?.merged, true);
    assert.deepEqual(m.blockers(), []);
  } finally {
    await w.f.close();
  }
});

test("a merge train merge stays pending across passes, then settles as merged", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const m = await throughMerge(w, true);
    const added = await m.merge();
    assert.equal(added.success, false, "an unproved merge is not a success");
    assert.deepEqual(w.remote.merges, [
      {
        route: "train",
        body: { sha: m.sha, squash: true, auto_merge: false },
      },
    ]);
    assert.deepEqual(
      [m.action().state, m.action().reason],
      ["uncertain", "provider-merge-train-pending"],
    );
    for (const car of ["fresh", "merging"]) {
      w.remote.state.cars.set(m.mr.iid, car);
      await m.refresh();
      await m.refresh();
      assert.equal(m.action().state, "uncertain", car);
    }
    assert.equal(m.mergeWrites(), 1, "pending is re-read, never re-sent");
    assert.ok(m.blockers().includes("pr-not-confirmed-merged"));
    assert.ok(m.blockers().includes("external-action-uncertain"));

    w.remote.state.cars.set(m.mr.iid, "merged");
    m.mr.state = "merged";
    await m.refresh();
    assert.equal(m.action().state, "confirmed-success");
    assert.deepEqual(m.blockers(), []);
    assert.equal(m.mergeWrites(), 1);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("a merge train merge that leaves the train unmerged is dropped, with no further write", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const m = await throughMerge(w, true);
    await m.merge();
    assert.equal(m.action().reason, "provider-merge-train-pending");
    w.remote.state.cars.delete(m.mr.iid);
    await m.refresh();
    assert.deepEqual(
      [m.action().state, m.action().reason],
      ["confirmed-failure", "provider-merge-train-dropped"],
    );
    assert.equal(m.observation()?.merged, false);
    assert.equal(m.mr.state, "opened");
    await m.refresh();
    assert.equal(m.mergeWrites(), 1);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("a train that never showed the merge cannot be called dropped", async (t) => {
  const w = await gitlabWorld(t);
  try {
    const m = await throughMerge(w, true);
    // The write took effect but its response was lost, and the car is gone when it is first read.
    w.remote.state.loseMergeResponse = true;
    await m.merge();
    w.remote.state.cars.delete(m.mr.iid);
    await m.refresh();
    const action = m.action();
    assert.equal(action?.state, "uncertain");
    assert.equal(action?.reason, "provider-effect-unproved");
    assert.equal(m.mergeWrites(), 1);
  } finally {
    await w.f.close();
  }
});
