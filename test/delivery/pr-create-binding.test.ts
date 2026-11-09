import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  type PrDeliveryObservation,
  type ProviderActionObservation,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";

function fixture(host: "github" | "gitlab" = "github") {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    taskId = randomUUID(),
    lead = randomUUID();
  domain.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "P",
    leadProfileId: null,
  });
  domain.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "T",
    outcome: "O",
  });
  const store = new DeliveryStore(db);
  store.migrate();
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
  const branch = store.assignTaskBranchWithinTransaction(taskId, "R1");
  const caller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "creator-work",
    workRevision: 1,
    conversationRevision: 1,
  };
  let pr: PrDeliveryObservation = {
    repositoryId: "R1",
    nodeId: "P7",
    number: 7,
    baseRef: "main",
    headRef: branch.branch,
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
  db.prepare(
    "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
  ).run(pr.headSha, taskId);
  let writes = 0,
    failRead = false,
    valid = true,
    uncertain = false;
  let readHook = () => {};
  const success = (): ProviderActionObservation => ({
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: pr.nodeId, number: pr.number, headSha: pr.headSha },
  });
  const provider: CodeHostDeliveryProvider = {
    async preflight() {
      return {};
    },
    async performAction() {
      writes++;
      return uncertain
        ? { state: "uncertain", reason: "lost-response", receipt: null }
        : success();
    },
    async inspectAction() {
      return success();
    },
    async inspectPr() {
      if (failRead) throw Error("read unavailable");
      readHook();
      return pr;
    },
  };
  const coordinator = new DeliveryCoordinator(store, {
    providerFactories: { [host]: () => provider },
    codeHostOf: () => ({
      codeHost: host,
      host: host === "github" ? "github.com" : "gitlab.com",
      ref: "main",
    }),
    authorize: () => {
      if (!valid) throw Error("caller revoked");
    },
    approved: () => false,
    leadAssignmentId: () => lead,
  });
  const request = () => ({
    operationId: randomUUID(),
    action: {
      kind: "pr.create" as const,
      target: {
        repositoryId: "R1",
        headRef: branch.branch,
        baseRef: "main",
        expectedHeadSha: pr.headSha,
      },
      title: "T",
      body: "",
      draft: false,
    },
  });
  const identity = () => ({
    repositoryId: pr.repositoryId,
    prNumber: pr.number,
    expectedPrNodeId: pr.nodeId,
    expectedHeadSha: pr.headSha,
  });
  return {
    db,
    store,
    coordinator,
    caller,
    lead,
    taskId,
    request,
    identity,
    writes: () => writes,
    setReadFailure: (v: boolean) => {
      failRead = v;
    },
    revoke: () => {
      valid = false;
    },
    setUncertain: () => {
      uncertain = true;
    },
    setPr: (patch: Partial<PrDeliveryObservation>) => {
      pr = { ...pr, ...patch };
    },
    onRead: (hook: () => void) => {
      readHook = hook;
    },
    close: async () => {
      await coordinator.stop();
      db.close();
    },
  };
}

for (const host of ["github", "gitlab"] as const) {
  test(`${host}: confirmed delegate create binds to the lead and repeated creates reuse an open PR`, async () => {
    const f = fixture(host);
    try {
      const first = await f.coordinator.submit(f.request(), f.caller);
      assert.equal(first.state, "confirmed-success");
      assert.equal(f.store.delivery(f.taskId)?.leadAssignmentId, f.lead);
      assert.equal(f.store.unregisteredPr(f.taskId), null);
      const second = await f.coordinator.submit(f.request(), f.caller);
      assert.equal(second.state, "confirmed-success");
      assert.equal(
        second.attempts,
        0,
        "reuse confirms atomically without a provider send boundary",
      );
      assert.deepEqual(second.observation?.receipt, first.observation?.receipt);
      assert.equal(f.writes(), 1);
      f.revoke();
      assert.equal(
        (await f.coordinator.submit(f.request(), f.caller)).state,
        "denied",
      );
      assert.equal(f.writes(), 1);
    } finally {
      await f.close();
    }
  });
}

test("failed auto-binding preserves confirmed creation, exact recovery summary and creator/lead registration", async () => {
  const f = fixture();
  try {
    f.setReadFailure(true);
    assert.equal(
      (await f.coordinator.submit(f.request(), f.caller)).state,
      "confirmed-success",
    );
    assert.equal(f.store.delivery(f.taskId), null);
    const summary = f.store.publicTask(f.taskId).unregisteredPr;
    assert.match(
      summary!,
      /Created PR #7 in repository R1 \(node P7, head a{40}\); register PR #7/,
    );
    f.setReadFailure(false);
    const outsider = {
      ...f.caller,
      assignmentId: randomUUID(),
      workId: "other-work",
    };
    await assert.rejects(
      f.coordinator.registerPr(f.identity(), outsider),
      /Only the task lead or the same-task assignment/,
    );
    for (const patch of [
      { repositoryId: "R2" },
      { nodeId: "P8" },
      { number: 8 },
    ]) {
      f.setPr(patch);
      await assert.rejects(
        f.coordinator.registerPr(f.identity(), f.caller),
        /Only the task lead or the same-task assignment/,
      );
      f.setPr({ repositoryId: "R1", nodeId: "P7", number: 7 });
    }
    await f.coordinator.registerPr(f.identity(), f.caller);
    assert.equal(f.store.delivery(f.taskId)?.leadAssignmentId, f.lead);
    await f.coordinator.registerPr(f.identity(), {
      ...f.caller,
      assignmentId: f.lead,
      workId: "lead-work",
    });
    assert.equal(f.store.delivery(f.taskId)?.leadAssignmentId, f.lead);
  } finally {
    await f.close();
  }
});

test("an earlier task-created unbound PR is reused without a second write", async () => {
  const f = fixture();
  try {
    f.setReadFailure(true);
    await f.coordinator.submit(f.request(), f.caller);
    f.setReadFailure(false);
    assert.equal(
      (await f.coordinator.submit(f.request(), f.caller)).state,
      "confirmed-success",
    );
    assert.equal(f.writes(), 1);
    assert.equal(f.store.delivery(f.taskId)?.observation.number, 7);
  } finally {
    await f.close();
  }
});

test("reconciliation binds a confirmed create without replaying its uncertain write", async () => {
  const f = fixture();
  try {
    f.setUncertain();
    assert.equal(
      (await f.coordinator.submit(f.request(), f.caller)).state,
      "uncertain",
    );
    await f.coordinator.reconcile();
    assert.equal(f.store.delivery(f.taskId)?.leadAssignmentId, f.lead);
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});

test("auto-binding records an outside head through the registration store checks", async () => {
  const f = fixture();
  try {
    // Create authorization requires its expected head to be cab's last push; move it only after send.
    f.db
      .prepare(
        "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
      )
      .run("a".repeat(40), f.taskId);
    f.onRead(() => {
      f.db
        .prepare(
          "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
        )
        .run("c".repeat(40), f.taskId);
    });
    assert.equal(
      (await f.coordinator.submit(f.request(), f.caller)).state,
      "confirmed-success",
    );
    assert.equal(
      f.store.taskBranch(f.taskId, "R1")?.outsideHeadSha,
      "a".repeat(40),
    );
    assert.equal(f.store.delivery(f.taskId)?.leadAssignmentId, f.lead);
  } finally {
    await f.close();
  }
});

test("reuse refuses a moved head or base and rechecks authority after inspection", async () => {
  const f = fixture();
  try {
    await f.coordinator.submit(f.request(), f.caller);
    const request = f.request();
    f.setPr({ headSha: "d".repeat(40) });
    assert.equal(
      (await f.coordinator.submit(request, f.caller)).state,
      "confirmed-failure",
    );
    f.setPr({ headSha: "a".repeat(40), baseRef: "other" });
    assert.equal(
      (await f.coordinator.submit(f.request(), f.caller)).state,
      "confirmed-failure",
    );
    f.setPr({ baseRef: "main" });
    f.onRead(f.revoke);
    assert.equal(
      (await f.coordinator.submit(f.request(), f.caller)).state,
      "confirmed-failure",
    );
    assert.equal(f.writes(), 1);
  } finally {
    await f.close();
  }
});
