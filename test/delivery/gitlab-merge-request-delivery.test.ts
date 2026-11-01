import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalMaterial } from "../../src/core/delivery.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  assertNoToken,
  gitlabWorld,
  opened,
  host,
  projectPath,
  repositoryId,
  token,
} from "../fixtures/gitlab-delivery.js";
import { gitLabDiscussion } from "../fixtures/gitlab-remote.js";

type World = Awaited<ReturnType<typeof gitlabWorld>>;

const allow = (...actions: string[]) =>
  actions.map((action) => ({ action, mode: "allow" as const }));

const wakes = (w: World) =>
  w.f.readDb(
    (db) =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_inbox_events WHERE eventType='pr-delivery'",
          )
          .get() as { n: number }
      ).n,
  );
const writes = (w: World) =>
  w.remote.requests.filter((r) => r.init.method !== "GET").length;

test("a draft merge request is created from the task branch only, registered, and read back as the exact merge request", async (t) => {
  const w = await gitlabWorld(t);
  try {
    w.f.grant(...allow("branch.push", "pr.create"));
    const { mr, sha } = await opened(w);
    const requests = w.remote.requests.length;
    const foreign = await w.createPr("someone-elses-branch", sha);
    assert.equal(foreign.success, false);
    assert.equal(w.remote.requests.length, requests);
    assert.equal(mr.draft, true);
    assert.match(mr.title, /^Draft: /);
    const bound = w.f.service.delivery().delivery(w.f.taskId);
    assert.equal(bound?.observation.nodeId, String(mr.id));
    assert.equal(bound?.observation.number, mr.iid);
    assert.equal(bound?.observation.draft, true);
    assert.deepEqual(bound?.observation.mergeBlockers, [
      "pr-draft",
      "merge-status-draft_status",
    ]);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("handback waits for settlement, a head change clears it, and unchanged polls wake the lead once per new fact", async (t) => {
  const w = await gitlabWorld(t);
  try {
    w.f.grant(...allow("branch.push", "pr.create"));
    const { sha, mr } = await opened(w, false);
    await w.f.terminal(1);
    const delivery = () => w.f.service.delivery().delivery(w.f.taskId);
    const refresh = () =>
      w.f.service.coordinationView().refreshDelivery(w.f.taskId);
    await w.f.service.settleHandback({
      ...w.f.settlement(),
      repositoryId,
      prNumber: mr.iid,
      expectedPrNodeId: String(mr.id),
      expectedHeadSha: sha,
    });
    assert.ok(delivery()?.settlement);
    await refresh();
    const baseline = wakes(w);
    await refresh();
    await refresh();
    assert.equal(wakes(w), baseline, "unchanged polls add no wake");
    assert.ok(delivery()?.settlement, "an unchanged head keeps the settlement");

    mr.head_pipeline = {
      id: 55,
      sha,
      status: "failed",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:05:00Z",
    };
    await refresh();
    await refresh();
    assert.equal(wakes(w), baseline + 1, "a failed pipeline wakes once");

    w.remote.state.discussions.push(
      gitLabDiscussion("abc", [{ body: "Please fix" }], {}),
    );
    await refresh();
    await refresh();
    assert.equal(wakes(w), baseline + 2, "a new note wakes once");
    w.remote.state.discussions.push(
      gitLabDiscussion("def", [{ system: true, resolvable: false }]),
    );
    await refresh();
    assert.equal(wakes(w), baseline + 2, "a system note does not wake");

    mr.sha = "3".repeat(40);
    await refresh();
    assert.equal(
      delivery()?.settlement,
      null,
      "a new head clears the settlement",
    );
    assert.equal(wakes(w), baseline + 3);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("edit and ready change the merge request once each, and a thread reply and resolve write once, refusing stale or repeated resolves", async (t) => {
  const w = await gitlabWorld(t);
  try {
    w.f.grant(
      ...allow(
        "branch.push",
        "pr.create",
        "pr.edit",
        "pr.ready",
        "pr.thread.reply",
        "pr.thread.resolve",
      ),
    );
    w.remote.state.discussions.push(gitLabDiscussion("abc", [{}]));
    const { mr, pr, target, act } = await opened(w);
    assert.deepEqual(
      w.f.service
        .delivery()
        .delivery(w.f.taskId)
        ?.observation.reviewThreads?.map((x) => x.nodeId),
      ["abc"],
    );

    // An edit always needs the operator's approval of its exact text.
    const edit = {
      kind: "pr.edit",
      target: pr,
      fields: { title: "Renamed" },
    };
    const approval = await w.approve(edit, 1);
    const edited = await act(edit, { approval });
    assert.equal(edited.success, true, edited.text);
    assert.equal(mr.title, "Draft: Renamed");
    assert.equal(mr.draft, true);
    const ready = await act({ kind: "pr.ready", target: pr });
    assert.equal(ready.success, true, ready.text);
    assert.deepEqual([mr.draft, mr.title], [false, "Renamed"]);

    const thread = { ...target, threadNodeId: "abc" };
    const replied = await act({
      kind: "pr.thread.reply",
      target: thread,
      body: "Fixed",
    });
    assert.equal(replied.success, true, replied.text);
    const discussion = w.remote.state.discussions[0];
    assert.equal(discussion?.notes.length, 2);
    const latest = String(discussion?.notes[1]?.id);
    assert.equal(
      w.f.service.delivery().delivery(w.f.taskId)?.observation
        .reviewThreads?.[0]?.latestCommentNodeId,
      latest,
    );
    const stale = await act({
      kind: "pr.thread.resolve",
      target: thread,
      expectedLatestCommentNodeId: String(discussion?.notes[0]?.id),
    });
    assert.equal(stale.success, false);
    assert.match(stale.text, /provider-preflight-held/);
    const before = writes(w);
    const resolved = await act({
      kind: "pr.thread.resolve",
      target: thread,
      expectedLatestCommentNodeId: latest,
    });
    assert.equal(resolved.success, true, resolved.text);
    assert.equal(writes(w), before + 1);
    const again = await act({
      kind: "pr.thread.resolve",
      target: thread,
      expectedLatestCommentNodeId: latest,
    });
    assert.equal(again.success, false);
    assert.equal(writes(w), before + 1);
    assertNoToken(w);
  } finally {
    await w.f.close();
  }
});

test("thread actions need a grant, and approval mode waits for the operator to approve the exact material", async (t) => {
  const w = await gitlabWorld(t);
  try {
    w.f.grant(...allow("branch.push", "pr.create"), {
      action: "pr.thread.reply",
      mode: "approval",
    });
    w.remote.state.discussions.push(gitLabDiscussion("abc", [{}]));
    const { target, act } = await opened(w);
    const reply = (body = "Fixed") => ({
      kind: "pr.thread.reply",
      target: { ...target, threadNodeId: "abc" },
      body,
    });
    const resolve = {
      kind: "pr.thread.resolve",
      target: { ...target, threadNodeId: "abc" },
      expectedLatestCommentNodeId: "1",
    };
    const denied = await act(resolve);
    assert.equal(denied.success, false);
    assert.match(denied.text, /delivery-authority-denied/);
    const before = writes(w);
    assert.equal((await act(reply())).success, false);
    const approval = await w.approve(reply(), 1);
    assert.equal(
      (await act(reply("Other text"), { approval }, 2)).success,
      false,
    );
    assert.equal(writes(w), before);
    const done = await act(reply(), { approval }, 2);
    assert.equal(done.success, true, done.text);
    assert.equal(writes(w), before + 1);
  } finally {
    await w.f.close();
  }
});

test("the delivery and approval reads name the GitLab merge request, its link and the approval's code host", async (t) => {
  const w = await gitlabWorld(t);
  try {
    w.f.grant(...allow("branch.push", "pr.create"), {
      action: "pr.thread.reply",
      mode: "approval",
    });
    w.remote.state.discussions.push(gitLabDiscussion("abc", [{}]));
    const { mr, target } = await opened(w);
    const reply = {
      kind: "pr.thread.reply",
      target: { ...target, threadNodeId: "abc" },
      body: "Fixed",
    };
    const requested = await w.f.call("cab_request_approval", {
      action: reply.kind,
      target: canonicalMaterial(reply.target),
      material: reply,
    });
    assert.equal(requested.success, true, requested.text);
    const api = new OperatorApi(w.f.service, [w.f.directory]);
    const read = (await api.readTask(w.f.taskId)).data;
    assert.equal(read.delivery?.binding?.codeHost, "gitlab");
    assert.equal(
      read.delivery?.binding?.url,
      `https://${host}/${projectPath}/-/merge_requests/${mr.iid}`,
    );
    assert.equal(read.delivery?.binding?.repositoryName, projectPath);
    assert.equal(read.approvals.at(-1)?.codeHost, "gitlab");
    assert.equal(JSON.stringify(read).includes(token), false);
    // A project path the operator may not see gives no link and no name.
    const withheld = (
      await new OperatorApi(w.f.service, [w.f.directory, projectPath]).readTask(
        w.f.taskId,
      )
    ).data.delivery?.binding;
    assert.equal(withheld?.url, undefined);
    assert.equal(withheld?.repositoryName, repositoryId);
    assert.equal(withheld?.codeHost, "gitlab");
  } finally {
    await w.f.close();
  }
});
