import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { DeliveryStore } from "../../src/core/delivery.js";
import {
  ProjectArchivedError,
  ProjectArchiveBlockedError,
} from "../../src/core/project-lifecycle.js";
import { archivedProjectFixture } from "../fixtures/archived-project.js";

async function stackFixture(t: TestContext) {
  const f = await archivedProjectFixture(t, false),
    store = f.service.delivery();
  f.domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "pr.create", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  const branch = store.assignTaskBranchWithinTransaction(f.taskId, "R1");
  const headSha = "a".repeat(40),
    operationId = randomUUID();
  f.db
    .prepare("UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?")
    .run(headSha, f.taskId);
  const caller = {
    projectId: f.projectId,
    taskId: f.taskId,
    taskVersion: Number(f.domain.task(f.taskId).version),
    assignmentId: f.assignmentId,
    assignmentVersion: 1,
    workId: f.workId,
    workRevision: 1,
    conversationRevision: 1,
  };
  const request = {
    operationId,
    action: {
      kind: "pr.create" as const,
      target: {
        repositoryId: "R1",
        baseRef: "cab/blocker",
        headRef: branch.branch,
        expectedHeadSha: headSha,
      },
      title: "Dependent",
      body: "",
      draft: true,
    },
  };
  const identity = {
    blockerTaskId: f.blockerTaskId,
    repositoryId: "R1",
    blockerBranch: "cab/blocker",
    blockerPrNodeId: "P1",
    blockerPrNumber: 1,
    dependentPrNodeId: "P2",
    dependentPrNumber: 2,
  };
  const create = {
    blockerTaskId: identity.blockerTaskId,
    repositoryId: identity.repositoryId,
    blockerBranch: identity.blockerBranch,
    blockerPrNodeId: identity.blockerPrNodeId,
    blockerPrNumber: 1,
    blockerHeadSha: "b".repeat(40),
  };
  const receipt = { nodeId: "P2", number: 2, headSha };
  store.prepareAction(request, caller, false);
  store.prepareStackCreate(operationId, create, () => {});
  const recordReceipt = () => {
    store.beginAttempt(operationId, {});
    store.recordStackReceipt(operationId, identity, receipt, () => {});
  };
  const settle = (refused = false) => {
    recordReceipt();
    store.beginStackLink(operationId, () => {}, null);
    return store.recordObservation(operationId, {
      state: "confirmed-success",
      reason: null,
      receipt,
      stack: refused ? null : { id: 1, number: 1, position: 2, size: 2 },
      ...(refused ? { stackLinkRefused: true } : {}),
    });
  };
  const refuse = () =>
    assert.throws(
      f.freeze,
      (error) =>
        error instanceof ProjectArchiveBlockedError &&
        error.blockers.some(
          (b) => b.kind === "delivery-action" && b.operationId === operationId,
        ),
    );
  const replace = (change: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(
      (
        f.db
          .prepare(
            "SELECT recordJson FROM delivery_actions WHERE operationId=?",
          )
          .get(operationId) as { recordJson: string }
      ).recordJson,
    ) as Record<string, unknown>;
    change(value);
    f.db
      .prepare("UPDATE delivery_actions SET recordJson=? WHERE operationId=?")
      .run(JSON.stringify(value), operationId);
  };
  return {
    ...f,
    store,
    operationId,
    identity,
    create,
    receipt,
    recordReceipt,
    settle,
    refuse,
    replace,
  };
}

for (const phase of [
  "prepared",
  "receipt-recorded",
  "link-attempting",
] as const)
  test(`archive refuses the actual durable stack phase ${phase}`, async (t) => {
    const f = await stackFixture(t);
    if (phase !== "prepared") f.recordReceipt();
    if (phase === "link-attempting")
      f.store.beginStackLink(f.operationId, () => {}, null);
    f.refuse();
    assert.ok(
      new DeliveryStore(f.db).projectStackArchiveBlockers(f.projectId).length,
    );
    assert.equal(f.fixture.runtime.turns, 0);
  });

for (const damage of [
  "unknown-phase",
  "missing-target",
  "receipt-only-success",
  "mismatched-receipt",
] as const)
  test(`an outer successful row cannot hide ${damage} in its nested journal`, async (t) => {
    const f = await stackFixture(t);
    f.settle();
    f.replace((value) => {
      const link = value.stackLink as Record<string, unknown>;
      if (damage === "unknown-phase") link.phase = "future-phase";
      if (damage === "missing-target") delete link.target;
      if (damage === "receipt-only-success") link.phase = "receipt-recorded";
      if (damage === "mismatched-receipt")
        (
          (value.observation as Record<string, unknown>).receipt as Record<
            string,
            unknown
          >
        ).nodeId = "Foreign";
    });
    f.refuse();
    assert.equal(f.domain.project(f.projectId).archived, 0);
  });

for (const refused of [false, true])
  test(`settled stack history permits archive with a proved ${refused ? "link refusal" : "link outcome"}`, async (t) => {
    const f = await stackFixture(t);
    f.settle(refused);
    const before = f.store.action(f.operationId);
    f.freeze();
    assert.deepEqual(f.store.action(f.operationId), before);
    assert.throws(
      () => f.store.prepareStackCreate(f.operationId, f.create, () => {}),
      ProjectArchivedError,
    );
    assert.throws(
      () =>
        f.store.recordStackReceipt(
          f.operationId,
          f.identity,
          f.receipt,
          () => {},
        ),
      ProjectArchivedError,
    );
    assert.throws(
      () => f.store.beginStackLink(f.operationId, () => {}, null),
      ProjectArchivedError,
    );
    f.restore();
    assert.equal(f.domain.project(f.projectId).paused, 1);
  });

test("a proved stack-create failure before any PR receipt is settled history", async (t) => {
  const f = await stackFixture(t);
  f.store.recordObservation(f.operationId, {
    state: "confirmed-failure",
    reason: "preflight-refused",
    receipt: null,
  });
  f.freeze();
  assert.equal(f.domain.project(f.projectId).archived, 1);
});

test("a persisted stack receipt still refuses archive after service restart without sending effects", async (t) => {
  const f = await stackFixture(t);
  f.recordReceipt();
  await f.service.stop();
  await f.service.start();
  const domain = f.service.domain();
  assert.throws(
    () =>
      domain.execute({
        type: "project.archive",
        actor: "operator",
        key: randomUUID(),
        projectId: f.projectId,
        expectedVersion: Number(domain.project(f.projectId).version),
      }),
    ProjectArchiveBlockedError,
  );
  assert.equal(f.fixture.runtime.turns, 0);
});

test("stack drain includes project-owned base tasks lacking a domain row", async (t) => {
  const f = await archivedProjectFixture(t, false),
    taskId = randomUUID(),
    operationId = randomUUID();
  f.db
    .prepare(
      "INSERT INTO tasks (id,projectId,title) VALUES (?,?,'Legacy history')",
    )
    .run(taskId, f.projectId);
  // Adversarial retained legacy data: normal writes enforce this foreign key.
  f.db.exec("PRAGMA foreign_keys=OFF");
  f.db
    .prepare(
      "INSERT INTO delivery_actions (operationId,taskId,materialHash,recordJson) VALUES (?,?,'fixture',?)",
    )
    .run(
      operationId,
      taskId,
      JSON.stringify({
        state: "confirmed-success",
        stackLink: { phase: "future-phase" },
      }),
    );
  f.db.exec("PRAGMA foreign_keys=ON");
  assert.throws(
    f.freeze,
    (error) =>
      error instanceof ProjectArchiveBlockedError &&
      error.blockers.some(
        (b) => b.kind === "delivery-action" && b.taskId === taskId,
      ),
  );
});
