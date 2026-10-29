import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  type DeliveryCaller,
  type PrDeliveryObservation,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import type { GitHubDeliveryProvider } from "../../src/standalone/github-delivery.js";

test("handback settlement inspects provider-only head changes and rechecks local revisions after await", async () => {
  const db = new DatabaseSync(":memory:");
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
  const store = new DeliveryStore(db);
  store.migrate();
  let observation: PrDeliveryObservation = {
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
  let mutate: (() => void) | undefined;
  const provider: GitHubDeliveryProvider = {
    async inspectPr() {
      mutate?.();
      return observation;
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
  const feedback: string[] = [];
  const coordinator = new DeliveryCoordinator(store, {
    providerFactory: () => provider,
    authorize: () => {},
    approved: () => false,
    taskVersion: () => Number(domain.task(taskId).version),
    feedback: (_task, reason) => {
      feedback.push(reason);
    },
  });
  try {
    await coordinator.registerPr(
      {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: observation.headSha,
      },
      caller,
    );
    const binding = store.delivery(taskId);
    assert.ok(binding);
    const command = {
      actor: "operator" as const,
      key: randomUUID(),
      taskId,
      expectedTaskVersion: 1,
      expectedDeliveryRevision: binding.revision,
      expectedPolicyVersion: 1,
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: observation.headSha,
      decision: "accepted" as const,
    };
    observation = { ...observation, headSha: "3".repeat(40) };
    await assert.rejects(() => coordinator.settleHandback(command), /changed/);
    assert.equal(store.delivery(taskId)?.settlement, null);
    assert.ok(feedback.length > 0);
    const currentBinding = store.delivery(taskId);
    assert.ok(currentBinding);
    const updated = {
      ...command,
      key: randomUUID(),
      expectedDeliveryRevision: currentBinding.revision,
      expectedHeadSha: observation.headSha,
    };
    mutate = () =>
      domain.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        taskId,
        expectedVersion: 1,
        outcome: "Changed",
      });
    await assert.rejects(() => coordinator.settleHandback(updated), /changed/);
    assert.equal(store.delivery(taskId)?.settlement, null);
  } finally {
    await coordinator.stop();
    db.close();
  }
});

import { deliveryFixture } from "../fixtures/delivery-fixture.js";
for (const mode of ["reviewable-pr", "through-merge"] as const)
  test(`${mode} issue close cannot bypass the configured PR delivery boundary`, async () => {
    const f = await deliveryFixture(mode, true);
    try {
      const p = f.getPr();
      assert.equal(
        (
          await f.call("cab_register_pr", {
            repositoryId: "R1",
            prNumber: 7,
            expectedPrNodeId: "P7",
            expectedHeadSha: p.headSha,
          })
        ).success,
        true,
      );
      const result = await f.call("cab_external_action", {
        operationId: randomUUID(),
        action: {
          kind: "issue.close",
          target: { repositoryId: "R1", nodeId: "I1", number: 1 },
          reviewedResultIds: [],
        },
      });
      assert.equal(result.success, false, result.text);
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });
async function registerFixturePr(
  f: Awaited<ReturnType<typeof deliveryFixture>>,
) {
  assert.equal(
    (
      await f.call("cab_register_pr", {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: f.getPr().headSha,
      })
    ).success,
    true,
  );
}
async function settleFixturePr(f: Awaited<ReturnType<typeof deliveryFixture>>) {
  f.turns[0]?.release();
  const deadline = Date.now() + 3000;
  while (
    !f.service
      .list()
      .some((i) => i.turnId === f.turns[0]?.turnId && i.state === "completed")
  ) {
    if (Date.now() > deadline) throw new Error("Lead did not enter PR waiting");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const b = f.service.delivery().delivery(f.taskId);
  assert.ok(b);
  await f.service.settleHandback({
    actor: "operator",
    key: randomUUID(),
    taskId: f.taskId,
    expectedTaskVersion: Number(f.domain.task(f.taskId).version),
    expectedDeliveryRevision: b.revision,
    expectedPolicyVersion: f.service.delivery().configuration(f.projectId)
      .version,
    repositoryId: "R1",
    prNumber: 7,
    expectedPrNodeId: "P7",
    expectedHeadSha: f.getPr().headSha,
    decision: "accepted",
  });
  await f.waitTurn(1);
}
async function closeFixtureIssue(
  f: Awaited<ReturnType<typeof deliveryFixture>>,
) {
  return f.call("cab_external_action", {
    operationId: randomUUID(),
    action: {
      kind: "issue.close",
      target: { repositoryId: "R1", nodeId: "I1", number: 1 },
      reviewedResultIds: [],
    },
  });
}
test("non-code issue close remains permitted without a PR delivery binding", async () => {
  const f = await deliveryFixture("reviewable-pr", true);
  try {
    const result = await closeFixtureIssue(f);
    assert.equal(result.success, true, result.text);
    assert.deepEqual(
      f.effects.map((a) => a.kind),
      ["issue.close"],
    );
  } finally {
    await f.close();
  }
});
test("an outside head on a task branch holds issue close without a PR delivery binding", async () => {
  const f = await deliveryFixture("reviewable-pr", true);
  try {
    const store = f.service.delivery();
    store.transaction(() =>
      store.assignTaskBranchWithinTransaction(f.taskId, "R1"),
    );
    (f.service as unknown as { db: DatabaseSync }).db
      .prepare("UPDATE delivery_task_branches SET outsideHeadSha=?")
      .run("5".repeat(40));
    const result = await closeFixtureIssue(f);
    assert.equal(result.success, false, result.text);
    assert.match(result.text, /held/i);
    assert.deepEqual(f.effects, []);
  } finally {
    await f.close();
  }
});
for (const mode of ["reviewable-pr", "through-merge"] as const)
  test(`${mode} issue close passes a current settled or merged PR boundary`, async () => {
    const f = await deliveryFixture(mode, true);
    try {
      if (mode === "through-merge")
        f.setPr({ ...f.getPr(), state: "MERGED", merged: true });
      await registerFixturePr(f);
      if (mode === "reviewable-pr") await settleFixturePr(f);
      const result = await closeFixtureIssue(f);
      assert.equal(result.success, true, result.text);
      assert.deepEqual(
        f.effects.map((a) => a.kind),
        ["issue.close"],
      );
    } finally {
      await f.close();
    }
  });
for (const fault of [
  "provider-head",
  "provider-outage",
  "task-revision",
  "policy-revision",
  "delivery-revision",
  "work-revision",
] as const)
  test(`issue close holds fresh PR evidence after ${fault}`, async () => {
    const f = await deliveryFixture("reviewable-pr", true);
    try {
      await registerFixturePr(f);
      await settleFixturePr(f);
      if (fault === "provider-head")
        f.setPr({ ...f.getPr(), headSha: "3".repeat(40) });
      else if (fault === "provider-outage") f.failReads(true);
      else
        f.onInspection(async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (fault === "delivery-revision")
            f.service.delivery().transaction(() => {
              f.service.delivery().observePrWithinTransaction(f.taskId, {
                ...f.getPr(),
                headSha: "4".repeat(40),
              });
            });
          else if (fault === "work-revision") {
            f.turns[1]?.release();
            const deadline = Date.now() + 3000;
            while (
              f.service
                .list()
                .some(
                  (i) =>
                    i.turnId === f.turns[1]?.turnId && i.state === "running",
                )
            ) {
              if (Date.now() > deadline)
                throw new Error("Work did not leave running state");
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          } else if (fault === "task-revision")
            f.domain.execute({
              type: "task.configure",
              actor: "operator",
              key: randomUUID(),
              taskId: f.taskId,
              projectId: f.projectId,
              expectedVersion: Number(f.domain.task(f.taskId).version),
              outcome: "Changed",
            });
          else {
            const policy = f.service.delivery().configuration(f.projectId);
            f.domain.execute({
              type: "delivery.configure",
              actor: "operator",
              key: randomUUID(),
              projectId: f.projectId,
              expectedVersion: policy.version,
              mode: policy.mode,
              credentialRef: null,
              grants: policy.grants,
              requiredChecks: [],
            });
          }
        });
      const result = await closeFixtureIssue(f);
      assert.equal(result.success, false, result.text);
      assert.equal(f.effects.length, 0);
    } finally {
      await f.close();
    }
  });
test("running retained lead performs explicit through-merge only after all existing action gates pass", async () => {
  const f = await deliveryFixture("through-merge");
  try {
    const p = f.getPr();
    assert.equal(
      (
        await f.call("cab_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: p.headSha,
        })
      ).success,
      true,
    );
    const target = {
      repositoryId: "R1",
      number: 7,
      nodeId: "P7",
      baseRef: "main",
      headRef: "cb/change",
      expectedHeadSha: p.headSha,
    };
    f.setPr({ ...p, mergeBlockers: ["check-build-unproved"] });
    assert.equal(
      (
        await f.call("cab_external_action", {
          operationId: randomUUID(),
          action: {
            kind: "pr.merge",
            target,
            method: "squash",
            reviewedResultIds: [],
          },
        })
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    f.setPr(p);
    const result = await f.call("cab_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.merge",
        target,
        method: "squash",
        reviewedResultIds: [],
      },
    });
    assert.equal(result.success, true, result.text);
    assert.equal(f.effects.length, 1);
    assert.equal(
      f.service.delivery().delivery(f.taskId)?.observation.merged,
      true,
    );
    assert.equal(f.domain.task(f.taskId).state, "open");
  } finally {
    await f.close();
  }
});
test("reviewable delivery retains lead waiting and requires fresh operator settlement", async () => {
  const f = await deliveryFixture();
  try {
    const p = f.getPr();
    assert.equal(
      (
        await f.call("cab_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: p.headSha,
        })
      ).success,
      true,
    );
    const completion = await f.call("cab_request_completion", {
      reviewedResultIds: [],
    });
    assert.equal(completion.success, false);
    assert.match(completion.text, /awaiting-current-settlement/);
    assert.equal(f.effects.length, 0);
    f.turns[0]?.release();
    const deadline = Date.now() + 3000;
    while (!f.service.list().some((i) => i.state === "completed")) {
      if (Date.now() > deadline) throw new Error("terminal not settled");
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(
      f.service.coordinationView().readTask(f.taskId).attention.completions
        .length,
      0,
    );
    assert.equal(f.domain.task(f.taskId).state, "open");
    const b = f.service.delivery().delivery(f.taskId);
    assert.ok(b);
    await f.service.settleHandback({
      actor: "operator",
      key: randomUUID(),
      taskId: f.taskId,
      expectedTaskVersion: Number(f.domain.task(f.taskId).version),
      expectedDeliveryRevision: b.revision,
      expectedPolicyVersion: 2,
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: p.headSha,
      decision: "accepted",
    });
    await f.waitTurn(1);
    assert.equal(
      (await f.call("cab_request_completion", { reviewedResultIds: [] }, 1))
        .success,
      true,
    );
    f.turns[1]?.release();
    const finishDeadline = Date.now() + 3000;
    while (f.domain.task(f.taskId).state !== "done") {
      if (Date.now() > finishDeadline)
        throw new Error(
          JSON.stringify(
            f.service.coordinationView().readTask(f.taskId).completionRequests,
          ),
        );
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

import {
  GitHubSourceStore,
  type IssueSnapshot,
} from "../../src/core/github-source.js";
for (const readiness of [
  { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
  null,
] as const)
  test(`only confirmed own closure continues a withdrawn open-issue selection while independent source gates remain (${readiness ? "label rule" : "no rule"})`, () => {
    const db = new DatabaseSync(":memory:");
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const sources = new GitHubSourceStore(db);
    sources.migrate();
    const projectId = randomUUID(),
      profileId = randomUUID();
    const execute = (command: object) =>
      domain.execute({
        actor: "operator",
        key: randomUUID(),
        ...command,
      } as never);
    try {
      execute({
        type: "profile.create",
        profileId,
        name: "Lead",
        instructions: "Lead",
        capabilities: "work",
      });
      execute({
        type: "project.create",
        projectId,
        name: "P",
        leadProfileId: profileId,
      });
      execute({
        type: "project.configure",
        projectId,
        expectedVersion: 1,
        paused: false,
      });
      execute({
        type: "github.configure",
        projectId,
        expectedVersion: 1,
        credentialRef: null,
        selections: [
          {
            id: "repo",
            kind: "repository",
            repositoryId: "R1",
            owner: "org",
            name: "repo",
          },
        ],
        readiness,
      });
      execute({
        type: "github.activate",
        projectId,
        selectionId: "repo",
        expectedVersion: 2,
      });
      const issue: IssueSnapshot = {
        providerInstance: "github.com",
        nodeId: "I1",
        repositoryId: "R1",
        repositoryName: "org/repo",
        number: 1,
        title: "T",
        body: "O",
        state: "open",
        labels: ["ready"],
        projectFields: [],
      };
      sources.reconcileSelection(projectId, "repo", {
        complete: true,
        issues: [issue],
        reason: null,
      });
      sources.reconcileBlockers("I1", {
        complete: true,
        blockers: [],
        reason: null,
      });
      const taskId = String(sources.issue("I1")?.taskId);
      assert.equal(domain.admission(taskId).eligible, true);
      execute({
        type: "delivery.configure",
        projectId,
        expectedVersion: 1,
        mode: "reviewable-pr",
        credentialRef: null,
        grants: [{ action: "issue.close", repositoryId: "R1", mode: "allow" }],
        requiredChecks: [],
      });
      const delivery = new DeliveryStore(db),
        operationId = randomUUID();
      delivery.prepareAction(
        {
          operationId,
          action: {
            kind: "issue.close",
            target: { repositoryId: "R1", nodeId: "I1", number: 1 },
            reviewedResultIds: [],
          },
        },
        {
          projectId,
          taskId,
          taskVersion: Number(domain.task(taskId).version),
          assignmentId: randomUUID(),
          assignmentVersion: 1,
          workId: "w",
          workRevision: 1,
          conversationRevision: 1,
        },
        false,
      );
      delivery.beginAttempt(operationId, { state: "open" });
      sources.reconcileSelection(projectId, "repo", {
        complete: true,
        issues: [{ ...issue, state: "closed" }],
        reason: null,
      });
      sources.reconcileSelection(projectId, "repo", {
        complete: true,
        issues: [],
        reason: null,
      });
      assert.ok(
        domain.admission(taskId, true).reasons.includes("source-withdrawn"),
      );
      delivery.recordObservation(operationId, {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "I1", issueClosed: true },
      });
      sources.recordDeliveryClosure(
        projectId,
        2,
        { ...issue, state: "closed" },
        operationId,
        null,
        null,
      );
      assert.equal(domain.admission(taskId, true).eligible, true);
      assert.ok(domain.admission(taskId).reasons.includes("task-unready"));
      assert.equal(domain.task(taskId).ready, 0);
      sources.recordDeliveryClosure(
        projectId,
        2,
        { ...issue, state: "closed", labels: [] },
        operationId,
        null,
        null,
      );
      // Lost labels only lose readiness under a label rule; with no rule the closure stands.
      if (readiness)
        assert.ok(
          domain.admission(taskId, true).reasons.includes("source-hold"),
        );
      else assert.equal(domain.admission(taskId, true).eligible, true);
      sources.reconcileBlockers("I1", {
        complete: false,
        blockers: [],
        reason: "unavailable",
      });
      assert.ok(
        domain
          .admission(taskId, true)
          .reasons.includes("imported-blockers-unknown"),
      );
      sources.reconcileBlockers("I1", {
        complete: true,
        blockers: [],
        reason: null,
      });
      sources.reconcileSelection(projectId, "repo", {
        complete: false,
        issues: [],
        reason: "unavailable",
      });
      assert.ok(
        domain.admission(taskId, true).reasons.includes("source-withdrawn"),
      );
    } finally {
      db.close();
    }
  });

test("imported service completes after own merge with actual open-only discovery and current closure label proof", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    assert.equal(
      (
        await f.call("cab_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
        })
      ).success,
      true,
    );
    const merged = await f.call("cab_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.merge",
        target: {
          repositoryId: "R1",
          nodeId: "P7",
          number: 7,
          headRef: "cb/change",
          baseRef: "main",
          expectedHeadSha: f.getPr().headSha,
        },
        method: "squash",
        reviewedResultIds: [],
      },
    });
    assert.equal(merged.success, true);
    assert.equal(
      f.service.githubSources().issue("I1")?.observedState,
      "closed",
    );
    assert.equal(f.service.githubSources().memberships("I1").length, 0);
    assert.equal(f.domain.admission(f.taskId, true).eligible, true);
    assert.equal(f.domain.task(f.taskId).ready, 0);
    f.turns[0]?.release();
    await f.waitTurn(1);
    assert.equal(
      (await f.call("cab_request_completion", { reviewedResultIds: [] }, 1))
        .success,
      true,
    );
    f.turns[1]?.release();
    const deadline = Date.now() + 5000;
    while (f.domain.task(f.taskId).state !== "done") {
      if (Date.now() > deadline)
        throw new Error("Own-closure completion did not finalize");
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test("own merge cannot hide simultaneous independent readiness label loss", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    assert.equal(
      (
        await f.call("cab_register_pr", {
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
        })
      ).success,
      true,
    );
    f.setSourceLabels([]);
    assert.equal(
      (
        await f.call("cab_external_action", {
          operationId: randomUUID(),
          action: {
            kind: "pr.merge",
            target: {
              repositoryId: "R1",
              nodeId: "P7",
              number: 7,
              headRef: "cb/change",
              baseRef: "main",
              expectedHeadSha: f.getPr().headSha,
            },
            method: "squash",
            reviewedResultIds: [],
          },
        })
      ).success,
      true,
    );
    assert.ok(
      f.domain.admission(f.taskId, true).reasons.includes("source-hold"),
    );
    assert.equal(f.domain.task(f.taskId).state, "open");
  } finally {
    await f.close();
  }
});

type Fixture = Awaited<ReturnType<typeof deliveryFixture>>;
async function treatClosureAs(f: Fixture, closedIssues: "done" | "skip") {
  const { version } = f.domain.githubConfiguration(f.projectId);
  f.domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: version,
    credentialRef: "env:FIXTURE_SOURCE",
    selections: [{ id: "repo", keep: true }],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    closedIssues,
  });
  f.domain.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    selectionId: "repo",
    expectedVersion: version + 1,
  });
  await f.service.refreshGitHub();
}
async function mergeFixturePr(f: Fixture) {
  await registerFixturePr(f);
  const merged = await f.call("cab_external_action", {
    operationId: randomUUID(),
    action: {
      kind: "pr.merge",
      target: {
        repositoryId: "R1",
        nodeId: "P7",
        number: 7,
        headRef: "cb/change",
        baseRef: "main",
        expectedHeadSha: f.getPr().headSha,
      },
      method: "squash",
      reviewedResultIds: [],
    },
  });
  assert.equal(merged.success, true, merged.text);
  f.setIssueOpen(false);
  await f.service.refreshGitHub();
}
async function closeOwnFixtureIssue(f: Fixture) {
  f.setActionOutcome({
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: "I1", issueClosed: true },
  });
  const closed = await closeFixtureIssue(f);
  assert.equal(closed.success, true, closed.text);
  f.setIssueOpen(false);
  await f.service.refreshGitHub();
}
function supersessions(f: Fixture) {
  const db = (f.service as unknown as { db: DatabaseSync }).db;
  return db
    .prepare("SELECT operationId FROM github_delivery_closure_supersessions")
    .all()
    .map((row) => String(row.operationId));
}
/** Releases the running lead turn and refreshes until the task settles into `state`. */
async function settleInto(f: Fixture, state: "done" | "open") {
  f.turns.at(-1)?.release();
  const deadline = Date.now() + 5000;
  for (;;) {
    await f.service.refreshGitHub();
    if (
      f.domain.task(f.taskId).state === state &&
      !f.service.list().some((i) => i.state === "running")
    )
      return;
    if (Date.now() > deadline) throw new Error(`Task did not settle ${state}`);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}
const independentClose = {
  state: "closed" as const,
  closedEvent: {
    id: "CE2",
    closerKind: "none" as const,
    closerPrNodeId: null,
  },
};

for (const mode of ["done", "skip"] as const)
  test(`own merge, reopen, then independent closure is provider closure (${mode})`, async () => {
    const f = await deliveryFixture("through-merge", true);
    try {
      await treatClosureAs(f, mode);
      await mergeFixturePr(f);
      const sources = f.service.githubSources();
      assert.equal(sources.deliveryClosure("I1")?.closedEventId, "CE1");
      assert.equal(f.domain.hasOwnDeliveryClosure(f.taskId), true);
      f.setClosedIssue({ state: "open" });
      f.setIssueOpen(true);
      await f.service.refreshGitHub();
      assert.equal(supersessions(f).length, 1);
      assert.equal(sources.hold("I1")?.reason, "closed");
      assert.equal(sources.issue("I1")?.observedState, "open");
      f.setClosedIssue(independentClose);
      f.setIssueOpen(false);
      await f.service.refreshGitHub();
      assert.equal(f.domain.providerClosure(f.taskId), "held");
      await settleInto(f, mode === "done" ? "done" : "open");
      assert.equal(
        sources.providerCompletion(f.taskId) !== undefined,
        mode === "done",
      );
      if (mode === "skip") assert.equal(sources.hold("I1")?.reason, "closed");
    } finally {
      await f.close();
    }
  });

test("an own closure that is never reopened is not provider-completed", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    await treatClosureAs(f, "done");
    await mergeFixturePr(f);
    await f.service.refreshGitHub();
    const sources = f.service.githubSources();
    assert.equal(
      sources.completeFromProviderClosure(f.taskId, () => true),
      false,
    );
    assert.equal(f.domain.providerClosure(f.taskId), null);
    assert.deepEqual(supersessions(f), []);
    f.turns[0]?.release();
    await f.waitTurn(1);
    assert.equal(
      (await f.call("cab_request_completion", { reviewedResultIds: [] }, 1))
        .success,
      true,
    );
    await settleInto(f, "done");
    assert.equal(sources.providerCompletion(f.taskId), undefined);
  } finally {
    await f.close();
  }
});

for (const kind of ["pr.merge", "issue.close"] as const)
  test(`a reopen and independent re-close between passes is not re-attributed (${kind})`, async () => {
    const f = await deliveryFixture(
      kind === "pr.merge" ? "through-merge" : "reviewable-pr",
      true,
    );
    try {
      await treatClosureAs(f, "done");
      if (kind === "pr.merge") await mergeFixturePr(f);
      else await closeOwnFixtureIssue(f);
      const sources = f.service.githubSources();
      assert.equal(sources.deliveryClosure("I1")?.closedEventId, "CE1");
      assert.equal(f.domain.hasOwnDeliveryClosure(f.taskId), true);
      f.setClosedIssue(independentClose);
      await f.service.refreshGitHub();
      assert.equal(supersessions(f).length, 1);
      // The pin is kept as audit history; it is not re-recorded for the new closure.
      assert.equal(sources.deliveryClosure("I1")?.closedEventId, "CE1");
      assert.equal(f.domain.hasOwnDeliveryClosure(f.taskId), false);
      assert.equal(f.domain.providerClosure(f.taskId), "held");
      await settleInto(f, "done");
      assert.notEqual(sources.providerCompletion(f.taskId), undefined);
    } finally {
      await f.close();
    }
  });

test("unproved merge attribution gets an explained hold, distinct from a failed read", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    await treatClosureAs(f, "done");
    f.setClosedIssue({
      state: "closed",
      closedEvent: {
        id: "CE9",
        closerKind: "pull-request",
        closerPrNodeId: "P9",
      },
    });
    await mergeFixturePr(f);
    const sources = f.service.githubSources();
    assert.equal(sources.hold("I1")?.reason, "closure-attribution-unproved");
    assert.equal(sources.deliveryClosure("I1"), undefined);
    assert.equal(f.domain.providerClosure(f.taskId), "unattributed");
    assert.equal(
      sources.completeFromProviderClosure(f.taskId, () => true),
      false,
    );
    // Reopening, the recovery, supersedes the own closure although the reopened issue
    // has left the merged PR's closed list; a later closure is provider closure.
    f.setClosedIssue({ state: "open" });
    f.setIssueOpen(true);
    await f.service.refreshGitHub();
    assert.deepEqual(f.getPr().closedIssueNodeIds, ["I1"]);
    assert.equal(sources.hold("I1")?.reason, "closed");
    assert.equal(supersessions(f).length, 1);
    assert.equal(f.domain.providerClosure(f.taskId), null);
    f.setClosedIssue(independentClose);
    f.setIssueOpen(false);
    await settleInto(f, "done");
    assert.notEqual(sources.providerCompletion(f.taskId), undefined);
  } finally {
    await f.close();
  }
  const failed = await deliveryFixture("through-merge", true);
  try {
    failed.setClosedIssue(new Error("unavailable"));
    await mergeFixturePr(failed);
    assert.equal(
      failed.service.githubSources().hold("I1")?.reason,
      "closure-read-unavailable",
    );
    assert.equal(failed.domain.providerClosure(failed.taskId), null);
  } finally {
    await failed.close();
  }
});

test("issue.close attribution without a pin requires a null closer", async () => {
  const f = await deliveryFixture("reviewable-pr", true);
  try {
    f.setClosedIssue({
      state: "closed",
      closedEvent: {
        id: "CE1",
        closerKind: "pull-request",
        closerPrNodeId: "P7",
      },
    });
    await closeOwnFixtureIssue(f);
    const sources = f.service.githubSources();
    assert.equal(sources.hold("I1")?.reason, "closure-attribution-unproved");
    assert.equal(f.domain.providerClosure(f.taskId), "unattributed");
    assert.equal(f.domain.hasOwnDeliveryClosure(f.taskId), false);
  } finally {
    await f.close();
  }
});

test("a done task's confirmed own closure is not re-read on refresh", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    await treatClosureAs(f, "done");
    await mergeFixturePr(f);
    f.turns[0]?.release();
    await f.waitTurn(1);
    assert.equal(
      (await f.call("cab_request_completion", { reviewedResultIds: [] }, 1))
        .success,
      true,
    );
    await settleInto(f, "done");
    assert.equal(f.domain.task(f.taskId).state, "done");
    assert.equal(f.domain.hasOwnDeliveryClosure(f.taskId), true);
    const before = f.closedIssueReads();
    f.setClosedIssue(new Error("unavailable"));
    await f.service.refreshGitHub();
    assert.equal(f.closedIssueReads(), before);
    assert.notEqual(
      f.service.githubSources().hold("I1")?.reason,
      "closure-read-unavailable",
    );
  } finally {
    await f.close();
  }
});

test("a confirmed merge keeps its successful receipt when the follow-up refresh fails", async () => {
  const f = await deliveryFixture("through-merge", true);
  try {
    await treatClosureAs(f, "done");
    await registerFixturePr(f);
    (f.service as unknown as { refreshGitHub(): Promise<void> }).refreshGitHub =
      async () => {
        throw new Error("refresh failed");
      };
    const merged = await f.call("cab_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.merge",
        target: {
          repositoryId: "R1",
          nodeId: "P7",
          number: 7,
          headRef: "cb/change",
          baseRef: "main",
          expectedHeadSha: f.getPr().headSha,
        },
        method: "squash",
        reviewedResultIds: [],
      },
    });
    assert.equal(merged.success, true, merged.text);
    assert.match(merged.text, /: confirmed-success/);
    assert.doesNotMatch(merged.text, /rejected or held/);
    const deadline = Date.now() + 5000;
    while (!f.service.backgroundFailureObserved()) {
      if (Date.now() > deadline) throw new Error("No background failure");
      await new Promise<void>((r) => setTimeout(r, 5));
    }
  } finally {
    await f.close();
  }
});
