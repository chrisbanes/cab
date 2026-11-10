import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PrDeliveryObservation } from "../../src/core/delivery.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/until.js";

async function world() {
  let readsFail = false,
    writes = 0;
  let pr: PrDeliveryObservation = {
    repositoryId: "R1",
    number: 7,
    nodeId: "P7",
    baseRef: "main",
    headRef: "unset",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    state: "OPEN",
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash"],
  };
  const priorPrs = new Map<number, PrDeliveryObservation>();
  const provider: CodeHostDeliveryProvider = {
    async preflight() {
      return {};
    },
    async performAction() {
      writes++;
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: pr.nodeId, number: pr.number, headSha: pr.headSha },
      };
    },
    async inspectAction() {
      throw Error("No uncertain outcome expected");
    },
    async inspectPr(identity) {
      if (readsFail) throw Error("provider unavailable");
      const observed =
        identity.prNumber === pr.number ? pr : priorPrs.get(identity.prNumber);
      assert.ok(observed);
      return observed;
    },
  };
  const f = await createOperatorFixture(null, undefined, {
    providerFactories: { github: () => provider },
  });
  const domain = f.service.domain(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const leadProfile = randomUUID(),
    creatorProfile = randomUUID(),
    otherProfile = randomUUID();
  for (const [profileId, name] of [
    [leadProfile, "Lead"],
    [creatorProfile, "Creator"],
    [otherProfile, "Other"],
  ] as const) {
    domain.execute({
      type: "profile.create",
      key: randomUUID(),
      actor: "operator",
      profileId,
      name,
      instructions: "Test the scoped tool",
      capabilities: "work",
    });
  }
  domain.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "PR tool test",
    leadProfileId: leadProfile,
  });
  domain.execute({
    type: "routing.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [creatorProfile, otherProfile],
  });
  domain.execute({
    type: "delivery.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "pr.create", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  domain.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "Create PR",
    outcome: "Bind the PR",
    ready: false,
  });
  await f.service.provisionTask(taskId);
  await f.service.configureCapacity({
    key: randomUUID(),
    globalLimit: 4,
    minimumLeadSlots: 0,
  });
  domain.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const assignments = () => domain.assignments(taskId);
  await until(
    () => assignments().some((a) => a.profileId === leadProfile),
    "lead assignment",
  );
  const leadId = String(
    assignments().find((a) => a.profileId === leadProfile)!.id,
  );
  const call = async (
    assignmentId: string,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    const workId = `assignment:${assignmentId}:initial`;
    await until(() => {
      const running = f.service.list().find((w) => w.state === "running");
      if (running?.workId === workId) return true;
      // A task runs one assignment at a time; finish the preceding fake turn.
      if (running?.turnId)
        f.runtime.complete(Number(running.turnId.split("-").at(-1)));
      return false;
    }, "bound assignment turn");
    const work = f.service
      .list()
      .find((w) => w.workId === workId && w.state === "running")!;
    assert.ok(work.threadId && work.turnId);
    return f.runtime.callTool({
      threadId: work.threadId,
      turnId: work.turnId,
      callId: randomUUID(),
      tool,
      arguments: args,
    });
  };
  for (const profileId of [creatorProfile, otherProfile]) {
    const delegated = await call(leadId, "cab_delegate", {
      profileId,
      brief: "Exercise PR tools in this task",
    });
    assert.equal(delegated.success, true, delegated.text);
  }
  const creatorId = String(
    assignments().find((a) => a.profileId === creatorProfile)!.id,
  );
  const otherId = String(
    assignments().find((a) => a.profileId === otherProfile)!.id,
  );
  const branch = f.service
    .delivery()
    .assignTaskBranchWithinTransaction(taskId, "R1");
  pr.headRef = branch.branch;
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
      )
      .run(pr.headSha, taskId),
  );
  const identity = () => ({
    repositoryId: pr.repositoryId,
    prNumber: pr.number,
    expectedPrNodeId: pr.nodeId,
    expectedHeadSha: pr.headSha,
  });
  const create = (assignmentId: string) =>
    call(assignmentId, "cab_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.create",
        target: {
          repositoryId: "R1",
          baseRef: "main",
          headRef: branch.branch,
          expectedHeadSha: "a".repeat(40),
        },
        title: "Created through the service",
        body: "",
        draft: false,
      },
    });
  return {
    ...f,
    taskId,
    leadId,
    creatorId,
    otherId,
    call,
    create,
    identity,
    branch: branch.branch,
    failReads: (fail: boolean) => {
      readsFail = fail;
    },
    setPr: (patch: Partial<PrDeliveryObservation>) => {
      priorPrs.set(pr.number, pr);
      pr = { ...pr, ...patch };
    },
    writes: () => writes,
  };
}

test("service tools preserve confirmed fallback and enforce lead, creating delegate and nonowner eligibility", async () => {
  const f = await world();
  try {
    f.failReads(true);
    const created = await f.create(f.creatorId);
    assert.equal(created.success, true, created.text);
    assert.match(created.text, /Created PR #7.*node P7.*register PR #7/);
    f.failReads(false);
    const registered = await f.call(
      f.creatorId,
      "cab_register_pr",
      f.identity(),
    );
    assert.equal(registered.success, true, registered.text);
    assert.equal(
      f.service.delivery().delivery(f.taskId)?.leadAssignmentId,
      f.leadId,
    );
    const reused = await f.create(f.creatorId);
    assert.equal(reused.success, true, reused.text);
    assert.match(reused.text, /"nodeId":"P7".*"number":7/);
    assert.equal(f.writes(), 1);
    const refused = await f.call(f.otherId, "cab_register_pr", f.identity());
    assert.equal(refused.success, false);
    assert.match(
      refused.text,
      /Only the task lead or the same-task assignment/,
    );
  } finally {
    await f.close();
  }
});

test("service tools automatically bind a delegate's confirmed create to the lead and reuse an unbound create", async () => {
  for (const readFailure of [false, true]) {
    const f = await world();
    try {
      f.failReads(readFailure);
      const first = await f.create(f.creatorId);
      assert.equal(first.success, true, first.text);
      if (readFailure)
        assert.equal(f.service.delivery().delivery(f.taskId), null);
      f.failReads(false);
      assert.equal((await f.create(f.creatorId)).success, true);
      assert.equal(f.writes(), 1);
      assert.equal(
        f.service.delivery().delivery(f.taskId)?.leadAssignmentId,
        f.leadId,
      );
      assert.equal(
        f.service.coordinationView().readTask(f.taskId).delivery
          ?.unregisteredPr,
        null,
      );
    } finally {
      await f.close();
    }
  }
});

test("service keeps the exact confirmed created PR visible when another PR is already bound", async () => {
  const f = await world();
  try {
    f.setPr({ nodeId: "P9", number: 9, headRef: "other-head" });
    const bound = await f.call(f.leadId, "cab_register_pr", f.identity());
    assert.equal(bound.success, true, bound.text);
    f.setPr({
      nodeId: "P7",
      number: 7,
      headRef: f.branch,
      headSha: "c".repeat(40),
    });
    const created = await f.create(f.creatorId);
    assert.equal(created.success, true, created.text);
    assert.match(
      created.text,
      /Created PR #7.*node P7, head c{40}.*register PR #7/,
    );
    const delivery = f.service.coordinationView().readTask(f.taskId).delivery;
    assert.equal(delivery?.binding?.observation.number, 9);
    assert.match(
      delivery?.unregisteredPr ?? "",
      /Created PR #7.*node P7, head c{40}.*register PR #7/,
    );
  } finally {
    await f.close();
  }
});
