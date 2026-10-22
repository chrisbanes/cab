import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DeliveryStore,
  externalActionArgumentsSchema,
  materialDigest,
  type PrDeliveryObservation,
} from "../../src/core/delivery.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";

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

const PUB_P = "P_1",
  PUB_F = "F_1",
  PUB_READY = "O_READY",
  PUB_OTHER = "O_OTHER";

/** A project whose readiness is the `ready` label or the Project field set to Ready, with grants for a publication. */
function publicationWorld(options: { ready: boolean; grants?: boolean }) {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const delivery = new DeliveryStore(db);
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
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:TEST_GITHUB",
    selections: [
      { id: "project", kind: "project", projectNodeId: PUB_P, filter: "" },
    ],
    readiness: {
      mode: "any",
      conditions: [
        { kind: "label", name: "ready" },
        {
          kind: "project-field",
          projectNodeId: PUB_P,
          fieldNodeId: PUB_F,
          optionNodeId: PUB_READY,
        },
      ],
    },
    repositories: [],
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Publish me",
    outcome: "Do the thing",
  });
  if (options.ready)
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: 1,
      ready: true,
    });
  const grants =
    options.grants === false
      ? []
      : [
          {
            action: "issue.create" as const,
            repositoryId: "R_1",
            mode: "allow" as const,
          },
          {
            action: "project.item.add" as const,
            repositoryId: "R_1",
            mode: "approval" as const,
            projectNodeId: PUB_P,
          },
          {
            action: "project.field" as const,
            repositoryId: "R_1",
            mode: "allow" as const,
            projectNodeId: PUB_P,
            fieldNodeId: PUB_F,
            optionNodeIds: [PUB_READY, PUB_OTHER],
          },
          {
            action: "issue.labels" as const,
            repositoryId: "R_1",
            mode: "allow" as const,
          },
        ];
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants,
    requiredChecks: [],
  });
  const sourceId = String(
    (
      db
        .prepare("SELECT sourceId FROM task_review_sources WHERE taskId=?")
        .get(taskId) as {
        sourceId: string;
      }
    ).sourceId,
  );
  const publicationId = randomUUID();
  const caller = {
    actor: "operator" as const,
    principal: "installation-operator" as const,
    purpose: "task-publication" as const,
    projectId,
    taskId,
    publicationId,
    sourceId,
    selectionId: "project",
    repositoryId: "R_1",
    policyVersion: delivery.configuration(projectId).version,
  };
  const runtime = {
    projectId,
    taskId,
    taskVersion: 1,
    assignmentId: randomUUID(),
    assignmentVersion: 1,
    workId: "work",
    workRevision: 1,
    conversationRevision: 1,
  };
  const create = (labels: string[]) => ({
    operationId: publicationId,
    action: {
      kind: "issue.create" as const,
      target: { repositoryId: "R_1" },
      title: "Publish me",
      body: "Do the thing",
      labels,
    },
  });
  return {
    db,
    domain,
    delivery,
    projectId,
    taskId,
    caller,
    runtime,
    create,
    publicationId,
  };
}

test("agent and service callers can never create an issue or add a Project item, even with grants", () => {
  const w = publicationWorld({ ready: false });
  try {
    const target = { repositoryId: "R_1", number: 1, nodeId: "I_1" };
    const item = () => ({
      operationId: randomUUID(),
      action: {
        kind: "project.item.add" as const,
        target,
        projectNodeId: PUB_P,
      },
    });
    for (const caller of [
      w.runtime,
      {
        actor: "service" as const,
        purpose: "status-mapping" as const,
        projectId: w.projectId,
        taskId: w.taskId,
        mappingVersion: 1,
        event: "turnStarted" as const,
      },
    ])
      for (const request of [
        { ...w.create([]), operationId: randomUUID() },
        item(),
      ]) {
        assert.throws(
          () => w.delivery.authorize(request, caller, true),
          /Only the operator's task publication|Status mapping caller only permits/,
        );
        assert.equal(
          w.delivery.prepareAction(request, caller, true).state,
          "denied",
        );
      }
  } finally {
    w.db.close();
  }
});

test("the publication caller needs its grant and the confirmed review, and is bound to its repository and text", () => {
  const noGrant = publicationWorld({ ready: false, grants: false });
  try {
    assert.throws(
      () =>
        noGrant.delivery.authorize(noGrant.create([]), noGrant.caller, true),
      /denied by project policy/,
    );
  } finally {
    noGrant.db.close();
  }
  const w = publicationWorld({ ready: false });
  try {
    // Without the confirmed review there is no approval, in either grant mode.
    assert.throws(
      () => w.delivery.authorize(w.create([]), w.caller, false),
      /approval required/,
    );
    w.delivery.authorize(w.create([]), w.caller, true);
    assert.throws(
      () =>
        w.delivery.authorize(
          {
            ...w.create([]),
            action: { ...w.create([]).action, target: { repositoryId: "R_2" } },
          },
          w.caller,
          true,
        ),
      /another repository/,
    );
    assert.throws(
      () =>
        w.delivery.authorize(
          {
            ...w.create([]),
            action: { ...w.create([]).action, title: "Changed" },
          },
          w.caller,
          true,
        ),
      /material changed/,
    );
    // The create is the publication's own operation.
    assert.throws(
      () =>
        w.delivery.authorize(
          { ...w.create([]), operationId: randomUUID() },
          w.caller,
          true,
        ),
      /material changed/,
    );
    assert.throws(
      () =>
        w.delivery.authorize(
          w.create([]),
          { ...w.caller, policyVersion: 99 },
          true,
        ),
      /authority changed/,
    );
  } finally {
    w.db.close();
  }
});

test("a Project item is added only to the created issue and to the granted Project", () => {
  const w = publicationWorld({ ready: false });
  try {
    const target = { repositoryId: "R_1", number: 7, nodeId: "I_7" };
    const item = (projectNodeId: string) => ({
      operationId: randomUUID(),
      action: { kind: "project.item.add" as const, target, projectNodeId },
    });
    // Before the create is confirmed there is no issue to add.
    assert.throws(
      () => w.delivery.authorize(item(PUB_P), w.caller, true),
      /Unknown delivery action/,
    );
    w.delivery.prepareAction(w.create([]), w.caller, true);
    w.delivery.beginAttempt(w.publicationId, {});
    w.delivery.recordObservation(w.publicationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_7", number: 7 },
    });
    // An approval-mode grant is satisfied by the confirmed review.
    w.delivery.authorize(item(PUB_P), w.caller, true);
    assert.throws(
      () => w.delivery.authorize(item(PUB_P), w.caller, false),
      /approval required/,
    );
    assert.throws(
      () => w.delivery.authorize(item("P_2"), w.caller, true),
      /denied by project policy/,
    );
    assert.throws(
      () =>
        w.delivery.authorize(
          {
            ...item(PUB_P),
            action: {
              ...item(PUB_P).action,
              target: { ...target, nodeId: "I_other" },
            },
          },
          w.caller,
          true,
        ),
      /did not create/,
    );
  } finally {
    w.db.close();
  }
});

test("only the publication of a Ready task may write exactly the readiness label or option the rule names", () => {
  const label = (
    w: ReturnType<typeof publicationWorld>,
    caller = w.caller as never,
  ) => w.delivery.authorize({ ...w.create(["ready"]) }, caller, true);
  const confirmedCreate = (w: ReturnType<typeof publicationWorld>) => {
    w.delivery.prepareAction(w.create([]), w.caller, true);
    w.delivery.beginAttempt(w.publicationId, {});
    w.delivery.recordObservation(w.publicationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "I_7", number: 7 },
    });
  };
  const field = (optionNodeId: string) => ({
    operationId: randomUUID(),
    action: {
      kind: "project.field" as const,
      target: { repositoryId: "R_1", number: 7, nodeId: "I_7" },
      projectNodeId: PUB_P,
      itemNodeId: "ITEM_1",
      fieldNodeId: PUB_F,
      optionNodeId,
    },
  });
  const ready = publicationWorld({ ready: true });
  try {
    label(ready);
    confirmedCreate(ready);
    ready.delivery.authorize(field(PUB_READY), ready.caller, true);
    // A granted option the rule does not name is not exempt.
    assert.throws(
      () => ready.delivery.authorize(field(PUB_OTHER), ready.caller, true),
      /readiness fields/,
    );
    // A label the rule does not name is not a readiness label, but it is not what a publication writes either.
    ready.delivery.authorize(
      {
        ...ready.create(["other"]),
        action: { ...ready.create(["other"]).action },
      },
      ready.caller,
      true,
    );
  } finally {
    ready.db.close();
  }
  const draft = publicationWorld({ ready: false });
  try {
    assert.throws(() => label(draft), /readiness labels/);
    confirmedCreate(draft);
    assert.throws(
      () => draft.delivery.authorize(field(PUB_READY), draft.caller, true),
      /readiness fields/,
    );
    // The agent and bound-issue refusals are unchanged.
    assert.throws(
      () =>
        draft.delivery.authorize(
          {
            operationId: randomUUID(),
            action: {
              kind: "issue.labels",
              target: { repositoryId: "R_1", number: 7, nodeId: "I_7" },
              add: ["ready"],
              remove: [],
            },
          },
          draft.runtime,
          false,
        ),
      /readiness labels/,
    );
    assert.throws(
      () => draft.delivery.authorize(field(PUB_READY), draft.runtime, false),
      /readiness fields/,
    );
  } finally {
    draft.db.close();
  }
});

test("persisted runtime, operator and service records parse and hash as they always did", () => {
  const w = publicationWorld({ ready: false });
  try {
    const target = { repositoryId: "R_1", number: 7, nodeId: "I_7" };
    const records = [
      {
        binding: {
          projectId: "11111111-1111-4111-8111-111111111111",
          taskId: "22222222-2222-4222-8222-222222222222",
          taskVersion: 1,
          assignmentId: "33333333-3333-4333-8333-333333333333",
          assignmentVersion: 1,
          workId: "work",
          workRevision: 1,
          conversationRevision: 1,
        },
        hash: "",
      },
      {
        binding: {
          actor: "operator",
          principal: "installation-operator",
          projectId: "11111111-1111-4111-8111-111111111111",
          taskId: "22222222-2222-4222-8222-222222222222",
          taskVersion: 2,
          sourceId: "44444444-4444-4444-8444-444444444444",
          sourceRevision: 1,
          sourceDigest: "a".repeat(64),
          sourceNodeId: "I_7",
          sourceRepositoryId: "R_1",
          policyVersion: 1,
        },
        hash: "",
      },
      {
        binding: {
          actor: "service",
          purpose: "status-mapping",
          projectId: "11111111-1111-4111-8111-111111111111",
          taskId: "22222222-2222-4222-8222-222222222222",
          mappingVersion: 1,
          event: "turnStarted",
        },
        hash: "",
      },
    ];
    for (const [index, { binding }] of records.entries()) {
      const operationId = randomUUID(),
        request = {
          operationId,
          action: { kind: "issue.comment" as const, target, body: "Hello" },
        },
        record = {
          operationId,
          request,
          binding,
          policyVersion: 1,
          state: "prepared",
          attempts: 0,
          beforeState: null,
          observation: null,
          createdAt: 1,
          updatedAt: 1,
        };
      w.db
        .prepare("INSERT INTO delivery_actions VALUES (?,?,?,?)")
        .run(
          operationId,
          w.taskId,
          materialDigest({ request, binding }),
          JSON.stringify(record),
        );
      // Each record still parses as the branch it was written as, and gains no key.
      assert.deepEqual(
        w.delivery.action(operationId).binding,
        binding,
        `record ${index}`,
      );
      assert.equal(
        w.delivery.prepareAction(request, binding as never, false).state,
        "prepared",
      );
    }
  } finally {
    w.db.close();
  }
});
