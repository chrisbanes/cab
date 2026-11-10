import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unusedIssueInspection } from "../fixtures/delivery-fixture.js";
import { tmpdir } from "../fixtures/temp.js";
import { DatabaseSync } from "node:sqlite";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import {
  DeliveryStore,
  type DeliveryCaller,
  type PrDeliveryObservation,
} from "../../src/core/delivery.js";
import {
  DeliveryCoordinator,
  unresolvedThreadSummary,
} from "../../src/standalone/delivery.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import type { IssueTrackerWriter } from "../../src/standalone/issue-tracker.js";
import { coordinationFixture } from "../fixtures/coordination.js";

for (const disposition of ["open", "cancelled", "unbound"] as const)
  test(`a repeated outside head preserves uncertainty clearance wakes (${disposition} task)`, async () => {
    const f = coordinationFixture();
    const binding = f.domain.leadBindings()[0]!;
    const taskId = String(binding.taskId),
      assignmentId = String(binding.assignmentId);
    const projectId = String(f.domain.task(taskId).projectId);
    let store = new DeliveryStore(f.db);
    store.migrate();
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "through-merge",
      credentialRef: null,
      grants: [{ action: "branch.push", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    const caller: DeliveryCaller = {
      projectId,
      taskId,
      assignmentId,
      taskVersion: Number(f.domain.task(taskId).version),
      assignmentVersion: 1,
      workId: "w",
      workRevision: 1,
      conversationRevision: 1,
    };
    const outside = "9".repeat(40);
    const provider: CodeHostDeliveryProvider = {
      async inspectPr() {
        throw new Error("unused");
      },
      async preflight() {
        throw new Error("reconciliation must not send");
      },
      async performAction() {
        throw new Error("reconciliation must not send");
      },
      async inspectAction(record) {
        const action = record.request.action;
        assert.equal(action.kind, "branch.push");
        assert.ok("commitSha" in action);
        return {
          state: "confirmed-success",
          reason: "branch-push-confirmed-outside-change",
          receipt: { nodeId: "R1", headSha: action.commitSha },
          outsideHeadSha: outside,
        };
      },
    };
    let failClearance = false;
    const coordinatorFor = () =>
      new DeliveryCoordinator(store, {
        providerFactories: { github: () => provider },
        authorize: () => {},
        approved: () => false,
        feedback: (id, reason, identity) => {
          if (failClearance && identity.startsWith("external-action-resolved:"))
            throw new Error("clearance-transaction-fault");
          if (
            f.domain.task(id).state === "open" &&
            f.domain.leadBindings().some((b) => b.taskId === id)
          )
            return f.coordination.ensureDeliveryEventWithinTransaction(
              id,
              reason,
              identity,
            );
          return false;
        },
      });
    let coordinator = coordinatorFor();
    const uncertainPush = (sha: string) => {
      const record = store.prepareAction(
        {
          operationId: randomUUID(),
          action: {
            kind: "branch.push",
            target: { repositoryId: "R1" },
            commitSha: sha,
          },
        },
        caller,
        false,
      );
      assert.equal(record.state, "prepared");
      store.beginAttempt(record.operationId, {});
      store.recordObservation(record.operationId, {
        state: "uncertain",
        reason: "provider-effect-unproved",
        receipt: null,
      });
      return record.operationId;
    };
    const notices = () =>
      f.db
        .prepare(
          "SELECT n.identity,e.recipientAssignmentId,e.payload FROM coordination_external_delivery_notices n JOIN coordination_inbox_events e ON e.eventId=n.eventId WHERE n.taskId=? ORDER BY e.rowid",
        )
        .all(taskId);
    try {
      // The first visit to X records one outside notice, which also covers the clearance.
      uncertainPush("1".repeat(40));
      await coordinator.reconcile();
      assert.deepEqual(
        notices().map((n) => n.identity),
        [`outside-push:R1:${outside}`],
      );
      // Recover from X, then encounter it again in two separate uncertain push episodes.
      for (const sha of ["2".repeat(40), "3".repeat(40)]) {
        store.transaction(() => store.clearOutsideHead(taskId, "R1"));
        const operationId = uncertainPush(sha);
        if (disposition === "cancelled")
          f.domain.execute({
            type: "task.configure",
            actor: "operator",
            key: randomUUID(),
            projectId,
            taskId,
            expectedVersion: Number(f.domain.task(taskId).version),
            state: "cancelled",
          });
        else if (disposition === "unbound")
          f.db
            .prepare("DELETE FROM task_lead_bindings WHERE taskId=?")
            .run(taskId);
        const before = notices().length;
        if (disposition === "open") {
          failClearance = true;
          await assert.rejects(
            coordinator.reconcile(),
            /clearance-transaction-fault/,
          );
          assert.equal(store.hasUncertainAction(taskId), true);
          assert.equal(store.taskBranch(taskId, "R1")?.outsideHeadSha, null);
          assert.equal(notices().length, before);
          failClearance = false;
        }
        await coordinator.reconcile();
        assert.equal(store.hasUncertainAction(taskId), false);
        assert.equal(store.taskBranch(taskId, "R1")?.outsideHeadSha, outside);
        const events = notices();
        assert.equal(events.length, before + (disposition === "open" ? 1 : 0));
        if (disposition === "open") {
          assert.equal(
            events.at(-1)!.identity,
            `external-action-resolved:${operationId}:1`,
          );
          assert.equal(events.at(-1)!.recipientAssignmentId, assignmentId);
          assert.match(
            String(events.at(-1)!.payload),
            /branch.push.*confirmed-success/,
          );
        }
        await coordinator.reconcile();
        await coordinator.stop();
        f.reopen();
        store = new DeliveryStore(f.db);
        store.migrate();
        coordinator = coordinatorFor();
        await coordinator.reconcile();
        assert.deepEqual(
          notices(),
          events,
          "replay and restart add no notices",
        );
        if (disposition !== "open") break;
      }
    } finally {
      await coordinator.stop();
      f.close();
    }
  });

test("unchanged feedback is deduplicated and cached settlement never qualifies a changed provider head", async () => {
  const root = mkdtempSync(join(tmpdir(), "cab-feedback-restart-"));
  let db = new DatabaseSync(join(root, "state.sqlite"));
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
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
  let store = new DeliveryStore(db);
  store.migrate();
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId,
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  let p: PrDeliveryObservation = {
    repositoryId: "R1",
    nodeId: "P7",
    number: 7,
    baseRef: "main",
    headRef: "cb/change",
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    state: "OPEN",
    draft: false,
    merged: false,
    reviewDecision: null,
    checks: [],
    closedIssueNodeIds: [],
    mergeBlockers: [],
    allowedMethods: ["squash"],
  };
  let fail = false;
  let feedbackFailure = false;
  const events: string[] = [];
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    async inspectPr() {
      if (fail) throw new Error("raw provider detail");
      return p;
    },
    async preflight() {
      return {};
    },
    async performAction() {
      throw new Error("unused");
    },
    async inspectAction() {
      throw new Error("unused");
    },
  };
  const options = {
    providerFactories: { github: () => provider },
    issueTrackerFactories: { github: () => provider },
    authorize: () => {},
    approved: () => false,
    taskVersion: () => 1,
    feedback: (_task: string, _reason: string, key: string) => {
      if (feedbackFailure) throw new Error("feedback-transaction-fault");
      events.push(key);
    },
  };
  let coordinator = new DeliveryCoordinator(store, options);
  try {
    await coordinator.registerPr(
      {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: p.headSha,
      },
      caller,
    );
    assert.ok(
      store
        .completionBlockers(taskId, 1)
        .includes("reviewable-pr-awaiting-current-settlement"),
    );
    await coordinator.settleHandback({
      actor: "operator",
      key: randomUUID(),
      taskId,
      expectedTaskVersion: 1,
      expectedDeliveryRevision: 1,
      expectedPolicyVersion: 1,
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: p.headSha,
      decision: "accepted",
    });
    assert.deepEqual((await coordinator.qualifyCompletion(taskId))(), []);
    const count = events.length;
    await coordinator.refresh();
    await coordinator.refresh();
    assert.equal(events.length, count);
    p = {
      ...p,
      feedback: [
        {
          kind: "comment",
          nodeId: "C1",
          author: "U1",
          updatedAt: "2026-10-01T10:00:00Z",
          state: "COMMENTED",
          body: "Please address the failing scenario",
          commitSha: null,
        },
      ],
    } as PrDeliveryObservation;
    await coordinator.refresh();
    assert.equal(events.length, count + 1);
    await coordinator.refresh();
    assert.equal(events.length, count + 1);
    p = { ...p, headSha: "3".repeat(40) };
    assert.ok((await coordinator.qualifyCompletion(taskId))().length > 0);
    assert.equal(store.delivery(taskId)?.settlement, null);
    const changedCount = events.length;
    await coordinator.refresh();
    assert.equal(events.length, changedCount);
    await coordinator.stop();
    db.close();
    db = new DatabaseSync(join(root, "state.sqlite"));
    store = new DeliveryStore(db);
    store.migrate();
    coordinator = new DeliveryCoordinator(store, options);
    await coordinator.refresh();
    assert.equal(events.length, changedCount);
    p = { ...p, headSha: "1".repeat(40) };
    await coordinator.refresh();
    assert.equal(events.length, changedCount + 1);
    p = { ...p, headSha: "3".repeat(40) };
    await coordinator.refresh();
    assert.equal(events.length, changedCount + 2);
    assert.equal(new Set(events).size, events.length);
    feedbackFailure = true;
    p = { ...p, headSha: "4".repeat(40) };
    await assert.rejects(
      () => coordinator.refresh(),
      /feedback-transaction-fault/,
    );
    assert.equal(store.delivery(taskId)?.readError, null);
    feedbackFailure = false;
    fail = true;
    assert.deepEqual((await coordinator.qualifyCompletion(taskId))(), [
      "delivery-provider-read-unavailable",
    ]);
  } finally {
    await coordinator.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lead sees unresolved review threads with their latest comment, capped at twenty", () => {
  const thread = (i: number, isResolved = false) => ({
    nodeId: `T${i}`,
    isResolved,
    firstCommentNodeId: `F${i}`,
    latestCommentNodeId: i === 0 ? null : `L${i}`,
  });
  const summary = (reviewThreads?: ReturnType<typeof thread>[]) =>
    unresolvedThreadSummary({ reviewThreads } as PrDeliveryObservation);
  assert.equal(summary(), "");
  assert.equal(summary([thread(1, true)]), "");
  assert.equal(
    summary([thread(0), thread(1), thread(2, true)]),
    "review-thread T0 latest none\nreview-thread T1 latest L1",
  );
  const lines = summary(
    Array.from({ length: 23 }, (_, i) => thread(i + 1)),
  ).split("\n");
  assert.equal(lines.length, 21);
  assert.equal(lines[20], "3 more unresolved review threads omitted");
});
