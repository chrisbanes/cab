import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  externalActionArgumentsSchema,
  type PrDeliveryObservation,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";

test("immutable intents precede effects and reject denied, readiness, and changed-key material", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID(),
      taskId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "A",
      leadProfileId: null,
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
    });
    const delivery = new DeliveryStore(db);
    delivery.migrate();
    const binding = {
      projectId,
      taskId,
      taskVersion: 1,
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "work",
      workRevision: 1,
      conversationRevision: 1,
    };
    const action = {
      kind: "issue.comment" as const,
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      body: "Reviewed comment",
    };
    const operationId = randomUUID();
    assert.equal(
      delivery.prepareAction(
        { operationId: randomUUID(), action },
        binding,
        false,
      ).state,
      "denied",
    );
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        { action: "issue.comment", repositoryId: "R1", mode: "allow" },
        { action: "issue.labels", repositoryId: "R1", mode: "allow" },
        {
          action: "project.field",
          repositoryId: "R1",
          mode: "allow",
          projectNodeId: "P1",
          fieldNodeId: "F1",
          optionNodeIds: ["O1", "O2"],
        },
      ],
      requiredChecks: [],
    });
    const intent = delivery.prepareAction(
      { operationId, action },
      binding,
      false,
    );
    assert.equal(intent.state, "prepared");
    assert.deepEqual(
      delivery.prepareAction({ operationId, action }, binding, false),
      intent,
    );
    assert.throws(
      () =>
        delivery.prepareAction(
          { operationId, action: { ...action, body: "Other" } },
          binding,
          false,
        ),
      /different/,
    );
    assert.equal(
      delivery.prepareAction(
        {
          operationId: randomUUID(),
          action: {
            ...action,
            target: { ...action.target, repositoryId: "R2" },
          },
        },
        binding,
        false,
      ).state,
      "denied",
    );
    assert.equal(
      delivery.prepareAction(
        {
          operationId: randomUUID(),
          action: {
            kind: "issue.labels",
            target: action.target,
            add: ["ready"],
            remove: [],
          },
        },
        binding,
        false,
      ).state,
      "denied",
    );
    const field = {
      kind: "project.field" as const,
      target: action.target,
      projectNodeId: "P1",
      itemNodeId: "ITEM1",
      fieldNodeId: "F1",
      optionNodeId: "O1",
    };
    for (const change of [
      { projectNodeId: "P2" },
      { fieldNodeId: "F2" },
      { optionNodeId: "O3" },
    ])
      assert.equal(
        delivery.prepareAction(
          { operationId: randomUUID(), action: { ...field, ...change } },
          binding,
          false,
        ).state,
        "denied",
      );
    const projectB = randomUUID(),
      taskB = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId: projectB,
      name: "B",
      leadProfileId: null,
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: projectB,
      taskId: taskB,
      title: "T",
      outcome: "O",
    });
    assert.equal(
      delivery.prepareAction(
        { operationId: randomUUID(), action },
        { ...binding, projectId: projectB, taskId: taskB },
        false,
      ).state,
      "denied",
    );
    assert.throws(() =>
      delivery.prepareAction(
        {
          operationId: randomUUID(),
          action: { ...action, url: "https://attacker.example" },
        },
        binding,
        false,
      ),
    );
    delivery.beginAttempt(operationId, { nodeId: "I1" });
    assert.equal(delivery.action(operationId).state, "attempting");
    delivery.recordObservation(operationId, {
      state: "uncertain",
      reason: "read-unavailable",
      receipt: null,
    });
    assert.deepEqual(delivery.actionBlockers(taskId), [
      "external-action-uncertain",
    ]);
  } finally {
    db.close();
  }
});

test("agents cannot change readiness labels or fields, and no readiness rule protects none", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "A",
      leadProfileId: null,
    });
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [
        { action: "issue.labels", repositoryId: "R1", mode: "allow" },
        {
          action: "project.field",
          repositoryId: "R1",
          mode: "allow",
          projectNodeId: "P1",
          fieldNodeId: "F1",
          optionNodeIds: ["O1"],
        },
      ],
      requiredChecks: [],
    });
    const delivery = new DeliveryStore(db);
    delivery.migrate();
    const binding = {
      projectId,
      taskId: randomUUID(),
      taskVersion: 1,
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "work",
      workRevision: 1,
      conversationRevision: 1,
    };
    const target = { repositoryId: "R1", number: 1, nodeId: "I1" };
    const labels = () =>
      delivery.authorize(
        {
          operationId: randomUUID(),
          action: { kind: "issue.labels", target, add: ["ready"], remove: [] },
        },
        binding,
        false,
      );
    const field = () =>
      delivery.authorize(
        {
          operationId: randomUUID(),
          action: {
            kind: "project.field",
            target,
            projectNodeId: "P1",
            itemNodeId: "ITEM1",
            fieldNodeId: "F1",
            optionNodeId: "O1",
          },
        },
        binding,
        false,
      );
    assert.equal(domain.githubConfiguration(projectId).readiness, null);
    labels();
    field();
    domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      credentialRef: null,
      selections: [],
      readiness: {
        mode: "any",
        conditions: [
          { kind: "label", name: "ready" },
          {
            kind: "project-field",
            projectNodeId: "P1",
            fieldNodeId: "F1",
            optionNodeId: "O2",
          },
        ],
      },
      repositories: [],
    });
    assert.throws(labels, /readiness labels/);
    assert.throws(field, /readiness fields/);
  } finally {
    db.close();
  }
});

test("review thread actions are granted per repository and bound to the task's observed PR thread", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new Store(db).ensureHost("test");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID(),
      taskId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "A",
      leadProfileId: null,
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
    });
    const delivery = new DeliveryStore(db);
    delivery.migrate();
    const caller = {
      projectId,
      taskId,
      taskVersion: 1,
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "work",
      workRevision: 1,
      conversationRevision: 1,
    };
    const target = {
      repositoryId: "R1",
      number: 7,
      nodeId: "P7",
      threadNodeId: "T1",
    };
    const reply = { kind: "pr.thread.reply" as const, target, body: "Fixed" };
    const resolve = {
      kind: "pr.thread.resolve" as const,
      target,
      expectedLatestCommentNodeId: "C1",
    };
    // Settles each prepared action so the next is not blocked by an unresolved one.
    const prepare = (action: unknown, approved = false) => {
      const record = delivery.prepareAction(
        { operationId: randomUUID(), action },
        caller,
        approved,
      );
      if (record.state === "prepared")
        delivery.recordObservation(record.operationId, {
          state: "confirmed-failure",
          reason: "test",
          receipt: null,
        });
      return record;
    };
    const grants = (mode: "allow" | "approval", version: number) =>
      domain.execute({
        type: "delivery.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: version,
        mode: "reviewable-pr",
        credentialRef: null,
        grants: (["pr.thread.reply", "pr.thread.resolve"] as const).map(
          (action) => ({ action, repositoryId: "R1", mode }),
        ),
        requiredChecks: [],
      });
    const observation = {
      repositoryId: "R1",
      nodeId: "P7",
      number: 7,
      baseRef: "main",
      headRef: "work",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      state: "OPEN",
      draft: false,
      merged: false,
      reviewDecision: null,
      checks: [],
      mergeBlockers: [],
      closedIssueNodeIds: [],
      allowedMethods: ["squash"],
      reviewThreads: [
        {
          nodeId: "T1",
          isResolved: false,
          firstCommentNodeId: "C1",
          latestCommentNodeId: "C1",
        },
      ],
    } satisfies PrDeliveryObservation;
    for (const action of [reply, resolve])
      assert.equal(prepare(action).state, "denied", "no grant");
    grants("allow", 1);
    for (const action of [reply, resolve])
      assert.equal(prepare(action).state, "denied", "no PR binding");
    delivery.registerPrWithinTransaction(
      caller,
      observation,
      caller.assignmentId,
    );
    for (const action of [reply, resolve])
      assert.equal(prepare(action).state, "prepared", "allow");
    const operationId = randomUUID();
    const prepared = delivery.prepareAction(
      { operationId, action: reply },
      caller,
      false,
    );
    assert.throws(
      () =>
        delivery.prepareAction(
          { operationId, action: { ...reply, body: "Other" } },
          caller,
          false,
        ),
      /different/,
    );
    assert.equal(
      delivery.prepareAction({ operationId, action: reply }, caller, false)
        .operationId,
      prepared.operationId,
    );
    delivery.recordObservation(operationId, {
      state: "confirmed-failure",
      reason: "test",
      receipt: null,
    });
    for (const other of [
      { ...target, threadNodeId: "T_OTHER" },
      { ...target, nodeId: "P8" },
      { ...target, number: 8 },
      { ...target, repositoryId: "R2" },
    ])
      for (const action of [reply, resolve])
        assert.equal(
          prepare({ ...action, target: other }).state,
          "denied",
          JSON.stringify(other),
        );
    grants("approval", 2);
    for (const action of [reply, resolve]) {
      assert.equal(prepare(action, false).state, "denied", "approval pending");
      assert.equal(prepare(action, true).state, "prepared", "approved");
    }
    // Observations persisted before thread actions existed still parse and grant no thread.
    const { reviewThreads: _omitted, ...legacy } = observation;
    delivery.observePrWithinTransaction(taskId, legacy);
    for (const action of [reply, resolve])
      assert.equal(prepare(action, true).state, "denied", "legacy observation");
    assert.throws(() =>
      externalActionArgumentsSchema.parse({
        operationId: randomUUID(),
        action: { ...reply, body: "" },
      }),
    );
    assert.throws(() =>
      externalActionArgumentsSchema.parse({
        operationId: randomUUID(),
        action: { kind: resolve.kind, target },
      }),
    );
    const coordinator = new DeliveryCoordinator(delivery, {
      authorize: () => {},
      approved: () => true,
    });
    const operator = {
      actor: "operator" as const,
      principal: "installation-operator" as const,
      projectId,
      taskId,
      taskVersion: 1,
      sourceId: randomUUID(),
      sourceRevision: 1,
      sourceDigest: "c".repeat(64),
      sourceNodeId: "I7",
      sourceRepositoryId: "R1",
      policyVersion: 2,
    };
    for (const action of [reply, resolve])
      assert.throws(
        () =>
          coordinator.submit({ operationId: randomUUID(), action }, operator),
        /only permits issue\.comment/,
      );
  } finally {
    db.close();
  }
});
