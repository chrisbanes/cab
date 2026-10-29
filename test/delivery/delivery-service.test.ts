import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  type DeliveryCaller,
  type DeliveryPolicy,
  DeliveryStore,
  type ExternalAction,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import type { CodeHostDeliveryProvider } from "../../src/standalone/code-host.js";
import type { IssueTrackerWriter } from "../../src/standalone/issue-tracker.js";

test("persisted intent is visible before write and uncertain create is never replayed after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cab-delivery-")),
    file = join(directory, "db.sqlite");
  let db = new DatabaseSync(file);
  const projectId = randomUUID(),
    taskId = randomUUID();
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
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
  domain.execute({
    type: "delivery.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  let store = new DeliveryStore(db);
  store.migrate();
  let writes = 0,
    confirmed = false,
    valid = true;
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    async preflight() {
      return { nodeId: "I1" };
    },
    async performAction(record) {
      writes++;
      assert.equal(store.action(record.operationId).state, "attempting");
      return { state: "uncertain", reason: "lost-response", receipt: null };
    },
    async inspectAction() {
      return confirmed
        ? {
            state: "confirmed-success",
            reason: null,
            receipt: { nodeId: "C1" },
          }
        : { state: "uncertain", reason: "no-match", receipt: null };
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  const options = {
    providerFactories: { github: () => provider },
    issueTrackerFactories: { github: () => provider },
    authorize: () => {
      if (!valid) throw new Error("stale caller");
    },
    approved: () => false,
  };
  const request = {
    operationId: randomUUID(),
    action: {
      kind: "issue.comment" as const,
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      body: "B",
    },
  };
  try {
    let coordinator = new DeliveryCoordinator(store, options);
    const outcomes = await Promise.all([
      coordinator.submit(request, caller),
      coordinator.submit(request, caller),
    ]);
    assert.equal(outcomes[0]?.state, "uncertain");
    assert.equal(writes, 1);
    await coordinator.stop();
    db.close();
    db = new DatabaseSync(file);
    store = new DeliveryStore(db);
    store.migrate();
    coordinator = new DeliveryCoordinator(store, options);
    await coordinator.reconcile();
    assert.equal(writes, 1);
    assert.equal(store.action(request.operationId).state, "uncertain");
    confirmed = true;
    await coordinator.reconcile();
    assert.equal(store.action(request.operationId).state, "confirmed-success");
    assert.equal(writes, 1);
    valid = false;
    assert.equal(
      (
        await coordinator.submit(
          { ...request, operationId: randomUUID() },
          caller,
        )
      ).state,
      "denied",
    );
    assert.equal(writes, 1);
    await coordinator.stop();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import {
  deliveryFixture,
  unusedIssueInspection,
} from "../fixtures/delivery-fixture.js";
test("bound service delivery refuses spoofing and a revoked policy during asynchronous preflight", async () => {
  const f = await deliveryFixture();
  try {
    const args = {
      operationId: randomUUID(),
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", number: 1, nodeId: "I1" },
        body: "B",
      },
    };
    assert.equal(
      (
        await f.call("cab_external_action", {
          ...args,
          taskId: randomUUID(),
        })
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    let release!: () => void;
    f.holdPreflight(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.call("cab_external_action", args);
    let response: unknown;
    void pending.then((value) => {
      response = value;
    });
    const deadline = Date.now() + 3000;
    while (!f.service.delivery().actions(f.taskId).length) {
      if (Date.now() > deadline)
        throw new Error(
          JSON.stringify({
            response,
            admission: f.domain.admission(f.taskId),
            list: f.service.list(),
          }),
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [],
      requiredChecks: [],
    });
    release();
    assert.equal((await pending).success, false);
    assert.equal(f.effects.length, 0);
    assert.equal(
      f.service.delivery().actions(f.taskId)[0]?.state,
      "confirmed-failure",
    );
  } finally {
    await f.close();
  }
});

import { canonicalMaterial } from "../../src/core/delivery.js";
test("actual operator approval authorizes only exact material on the next eligible bound lead turn", async () => {
  const f = await deliveryFixture();
  try {
    const action = {
      kind: "issue.edit",
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      fields: { title: "Approved title" },
    };
    assert.equal(
      (
        await f.call("cab_external_action", {
          operationId: randomUUID(),
          action,
        })
      ).success,
      false,
    );
    const approval = await f.call("cab_request_approval", {
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    assert.equal(approval.success, true);
    const interaction = f.service.coordinationView().readTask(f.taskId)
      .approvals[0];
    assert.ok(interaction);
    f.turns[0]?.release();
    const deadline = Date.now() + 3000;
    while (!f.service.list().some((i) => i.state === "completed")) {
      if (Date.now() > deadline) throw new Error("terminal timeout");
      await new Promise<void>((r) => setImmediate(r));
    }
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: action.kind,
      target: canonicalMaterial(action.target),
      material: action,
    });
    await f.waitTurn(1);
    const approved = {
      interactionId: interaction.interactionId,
      expectedRevision: 2,
    };
    assert.equal(
      (
        await f.call(
          "cab_external_action",
          {
            operationId: randomUUID(),
            action: {
              ...action,
              fields: { title: "Changed unapproved title" },
            },
            approval: approved,
          },
          1,
        )
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
    assert.equal(
      (
        await f.call(
          "cab_external_action",
          { operationId: randomUUID(), action, approval: approved },
          1,
        )
      ).success,
      true,
    );
    assert.equal(f.effects.length, 1);
    assert.equal(
      (
        await f.call(
          "cab_external_action",
          { operationId: randomUUID(), action, approval: approved },
          1,
        )
      ).success,
      false,
    );
    assert.equal(f.effects.length, 1);
  } finally {
    await f.close();
  }
});

test("a bound denied operation remains denied after policy expansion and rejects changed material", async () => {
  const f = await deliveryFixture();
  try {
    const request = {
      operationId: randomUUID(),
      action: {
        kind: "issue.labels",
        target: { repositoryId: "R1", number: 1, nodeId: "I1" },
        add: ["progress"],
        remove: [],
      },
    };
    assert.equal((await f.call("cab_external_action", request)).success, false);
    assert.equal(
      f.service
        .delivery()
        .actions(f.taskId)
        .find((a) => a.operationId === request.operationId)?.state,
      "denied",
    );
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [{ action: "issue.labels", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    assert.equal((await f.call("cab_external_action", request)).success, false);
    assert.equal(f.effects.length, 0);
    assert.equal(
      (
        await f.call("cab_external_action", {
          ...request,
          action: { ...request.action, add: ["other"] },
        })
      ).success,
      false,
    );
    assert.equal(f.effects.length, 0);
  } finally {
    await f.close();
  }
});

function coordinatorFixture() {
  const root = mkdtempSync(join(tmpdir(), "cab-delivery-races-")),
    file = join(root, "state.sqlite");
  let db = new DatabaseSync(file);
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    tasks = [randomUUID(), randomUUID(), randomUUID()];
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "P",
    leadProfileId: null,
  });
  for (const taskId of tasks)
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "T",
      outcome: "O",
    });
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  let store = new DeliveryStore(db);
  store.migrate();
  const caller = (index: number): DeliveryCaller => ({
    projectId,
    taskId: String(tasks[index]),
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: `w${index}`,
    workRevision: 1,
    conversationRevision: 1,
  });
  const request = (number = 1) => ({
    operationId: randomUUID(),
    action: {
      kind: "issue.comment" as const,
      target: { repositoryId: "R1", nodeId: `I${number}`, number },
      body: "B",
    },
  });
  return {
    caller,
    request,
    store: () => store,
    reopen() {
      db.close();
      db = new DatabaseSync(file);
      store = new DeliveryStore(db);
      store.migrate();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("positively confirmed transient failures retry only twice, one attempt per reconcile, including persisted prior attempts", async () => {
  const f = coordinatorFixture();
  let effects = 0;
  const request = f.request(),
    caller = f.caller(0);
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    async preflight() {
      return {};
    },
    async performAction() {
      effects++;
      return {
        state: "confirmed-failure",
        reason: "confirmed-transient-no-effect",
        receipt: null,
        retryable: true,
      };
    },
    async inspectAction() {
      throw new Error("unused");
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const options = {
    providerFactories: { github: () => provider },
    issueTrackerFactories: { github: () => provider },
    authorize: () => {},
    approved: () => false,
  };
  let coordinator: DeliveryCoordinator | undefined;
  try {
    f.store().prepareAction(request, caller, false);
    f.store().beginAttempt(request.operationId, {});
    f.store().recordObservation(request.operationId, {
      state: "confirmed-failure",
      reason: "confirmed-transient-no-effect",
      receipt: null,
      retryable: true,
    });
    f.reopen();
    coordinator = new DeliveryCoordinator(f.store(), options);
    await coordinator.reconcile();
    assert.equal(effects, 1);
    assert.equal(f.store().action(request.operationId).attempts, 2);
    await coordinator.reconcile();
    assert.equal(effects, 2);
    assert.equal(f.store().action(request.operationId).attempts, 3);
    await coordinator.stop();
    f.reopen();
    coordinator = new DeliveryCoordinator(f.store(), options);
    await coordinator.reconcile();
    assert.equal(effects, 2);
    assert.equal(
      f.store().action(request.operationId).state,
      "confirmed-failure",
    );
  } finally {
    await coordinator?.stop();
    f.close();
  }
});
test("a rate-limited failure is not retried before its resume time and is retried after it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const f = coordinatorFixture();
  let effects = 0;
  const request = f.request(),
    caller = f.caller(0);
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    async preflight() {
      return {};
    },
    async performAction() {
      effects++;
      return {
        state: "confirmed-failure",
        reason: "provider-http-429",
        receipt: null,
        retryable: true,
        resumeAt: Date.now() + 60_000,
      };
    },
    async inspectAction() {
      throw new Error("unused");
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const coordinator = new DeliveryCoordinator(f.store(), {
    providerFactories: { github: () => provider },
    issueTrackerFactories: { github: () => provider },
    authorize: () => {},
    approved: () => false,
  });
  try {
    await coordinator.submit(request, caller);
    assert.equal(effects, 1);
    await coordinator.reconcile();
    assert.equal(effects, 1);
    t.mock.timers.tick(59_000);
    await coordinator.reconcile();
    assert.equal(effects, 1);
    t.mock.timers.tick(1_000);
    await coordinator.reconcile();
    assert.equal(effects, 2);
    assert.equal(f.store().action(request.operationId).attempts, 2);
  } finally {
    await coordinator.stop();
    f.close();
  }
});
test("reconciliation serializes the exact target against other task writes while unrelated targets proceed", async () => {
  const f = coordinatorFixture(),
    old = f.request(),
    caller = f.caller(0);
  f.store().prepareAction(old, caller, false);
  f.store().beginAttempt(old.operationId, {});
  f.store().recordObservation(old.operationId, {
    state: "uncertain",
    reason: "lost-response",
    receipt: null,
  });
  let release!: () => void, entered!: () => void;
  const inspectStarted = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const effects: number[] = [];
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    async preflight() {
      return {};
    },
    async inspectAction() {
      entered();
      await readGate;
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "C1" },
      };
    },
    async performAction(record) {
      effects.push(
        "number" in record.request.action.target
          ? record.request.action.target.number
          : 0,
      );
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "C2" },
      };
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const coordinator = new DeliveryCoordinator(f.store(), {
    providerFactories: { github: () => provider },
    issueTrackerFactories: { github: () => provider },
    authorize: () => {},
    approved: () => false,
  });
  try {
    const reconciliation = coordinator.reconcile();
    await inspectStarted;
    const same = coordinator.submit(f.request(1), f.caller(1));
    await coordinator.submit(f.request(2), f.caller(2));
    assert.deepEqual(effects, [2]);
    release();
    await Promise.all([same, reconciliation]);
    assert.deepEqual(effects, [2, 1]);
  } finally {
    release();
    await coordinator.stop();
    f.close();
  }
});
test("newly configured delivery credentials inherited by the current runtime hold activation until restart", async () => {
  const key = "S07A_ACTIVATION_SENTINEL",
    previous = process.env[key];
  process.env[key] = "private-activation-value";
  const f = await deliveryFixture();
  try {
    assert.equal(
      f.spawn()?.spawnEnvironment()[key],
      "private-activation-value",
    );
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: 2,
      mode: "reviewable-pr",
      credentialRef: `env:${key}`,
      grants: [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    const response = await f.call("cab_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", nodeId: "I1", number: 1 },
        body: "B",
      },
    });
    assert.equal(response.success, false);
    assert.equal(f.effects.length, 0);
    assert.doesNotMatch(
      JSON.stringify(f.service.delivery().publicTask(f.taskId)),
      /private-activation-value|S07A_ACTIVATION_SENTINEL/,
    );
  } finally {
    await f.close();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

import {
  StandaloneService,
  type StandaloneServiceOptions,
} from "../../src/standalone/service.js";
test("restart retains one unavailable PR binding while independent feedback and operator views continue", async () => {
  const f = await deliveryFixture();
  try {
    const register = (p: ReturnType<typeof f.getPr>) =>
      f.call("cab_register_pr", {
        repositoryId: p.repositoryId,
        prNumber: p.number,
        expectedPrNodeId: p.nodeId,
        expectedHeadSha: p.headSha,
      });
    assert.equal((await register(f.getPr())).success, true);
    f.turns[0]?.release();
    const waitCompleted = async (index: number) => {
      const deadline = Date.now() + 3000;
      while (
        !f.service
          .list()
          .some(
            (i) =>
              i.turnId === f.turns[index]?.turnId && i.state === "completed",
          )
      ) {
        if (Date.now() > deadline) throw new Error("Lead terminal not settled");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    await waitCompleted(0);
    const healthyTaskId = randomUUID();
    f.domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectId,
      taskId: healthyTaskId,
      title: "Healthy",
      outcome: "Healthy",
      ready: true,
    });
    await f.service.provisionTask(healthyTaskId);
    await f.waitTurn(1);
    const healthyPr = {
      ...f.getPr(),
      nodeId: "P8",
      number: 8,
      headRef: "cb/healthy",
    };
    f.setOtherPr(healthyPr);
    assert.equal((await register(healthyPr)).success, true);
    f.turns[1]?.release();
    await waitCompleted(1);
    await f.service.stop();
    f.failReads(true);
    f.setOtherPr({
      ...healthyPr,
      checks: [
        {
          name: "build",
          status: "failure",
          sha: healthyPr.headSha,
          appId: null,
        },
      ],
    });
    await f.service.start();
    const held = f.service.coordinationView().readTask(f.taskId).delivery;
    assert.equal(held?.binding?.readError, "provider-read-unavailable");
    assert.ok(held?.blockers.includes("delivery-provider-read-unavailable"));
    assert.equal(
      f.service.coordinationView().readTask(healthyTaskId).delivery?.binding
        ?.readError,
      null,
    );
    await f.waitTurn(2);
    assert.equal(f.turns[2]?.threadId, f.turns[1]?.threadId);
    const binding = f.service.delivery().delivery(f.taskId);
    assert.ok(binding);
    await assert.rejects(
      () =>
        f.service.settleHandback({
          actor: "operator",
          key: randomUUID(),
          taskId: f.taskId,
          expectedTaskVersion: Number(
            f.service.domain().task(f.taskId).version,
          ),
          expectedDeliveryRevision: binding.revision,
          expectedPolicyVersion: 2,
          repositoryId: "R1",
          prNumber: 7,
          expectedPrNodeId: "P7",
          expectedHeadSha: f.getPr().headSha,
          decision: "accepted",
        }),
      /inspection unavailable/,
    );
    assert.equal(f.service.domain().task(f.taskId).state, "open");
  } finally {
    await f.close();
  }
});
test("failed startup releases delivery state before a clean retry", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cab-delivery-startup-")),
  );
  const runtime = {
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
    async startThread() {
      return "t";
    },
    async resumeThread() {},
    async startTurn() {
      return "turn";
    },
    async interruptTurn() {},
    async waitForTurn() {
      return "completed" as const;
    },
  };
  // Read at each start: an invalid poll interval fails start-up after delivery opens.
  const options: StandaloneServiceOptions = {
    power: { enabled: true, pollIntervalMs: 0 },
  };
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    options,
  );
  try {
    await assert.rejects(() => service.start());
    assert.throws(() => service.delivery(), /Service is not started/);
    options.power = { enabled: false };
    await service.start();
    assert.deepEqual(service.delivery().actions(), []);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery resolves the code-host factory from the target's repository link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cab-delivery-")),
    db = new DatabaseSync(join(directory, "db.sqlite"));
  const projectId = randomUUID(),
    taskId = randomUUID();
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
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
  domain.execute({
    type: "delivery.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: ["R1", "R2"].map((repositoryId) => ({
      action: "branch.push" as const,
      repositoryId,
      mode: "allow" as const,
    })),
    requiredChecks: [],
  });
  const store = new DeliveryStore(db);
  store.migrate();
  const hosts: string[] = [];
  const provider: CodeHostDeliveryProvider = {
    async preflight() {
      return { nodeId: "I1" };
    },
    async performAction() {
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "C1" },
      };
    },
    async inspectAction() {
      throw new Error("unused");
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const requested: Array<[string, string]> = [];
  const coordinator = new DeliveryCoordinator(store, {
    providerFactories: {
      github: (_project, _policy, host) => {
        hosts.push(host);
        return provider;
      },
    },
    codeHostOf: (project, repositoryId) => {
      requested.push([project, repositoryId]);
      return repositoryId === "R1"
        ? { codeHost: "github", host: "github.com" }
        : null;
    },
    verifyPush: async () => ({
      workspacePath: directory,
      uncommittedEntries: 0,
      descendsFromLastPushed: null,
    }),
    authorize: () => {},
    approved: () => false,
  });
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  try {
    for (const repositoryId of ["R1", "R2"])
      assert.equal(
        (
          await coordinator.submit(
            {
              operationId: randomUUID(),
              action: {
                kind: "branch.push" as const,
                target: { repositoryId },
                commitSha: "a".repeat(40),
              },
            },
            caller,
          )
        ).state,
        "confirmed-success",
      );
    // The linked repository and the unlinked default both reach the GitHub factory on github.com.
    assert.deepEqual(hosts, ["github.com", "github.com"]);
    assert.deepEqual(requested, [
      [projectId, "R1"],
      [projectId, "R2"],
    ]);
    await coordinator.stop();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a delivery action naming a GitLab link is refused and nothing is pushed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cab-delivery-"));
  const db = new DatabaseSync(join(directory, "delivery.sqlite"));
  const projectId = randomUUID(),
    taskId = randomUUID();
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
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
  domain.execute({
    type: "delivery.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: ["R1", "4242"].flatMap((repositoryId) =>
      (["issue.comment", "branch.push"] as const).map((action) => ({
        action,
        repositoryId,
        mode: "allow" as const,
      })),
    ),
    requiredChecks: [],
  });
  const store = new DeliveryStore(db);
  store.migrate();
  const calls: string[] = [];
  const provider: CodeHostDeliveryProvider & IssueTrackerWriter = {
    ...unusedIssueInspection,
    async preflight() {
      calls.push("preflight");
      return { nodeId: "I1" };
    },
    async performAction() {
      calls.push("perform");
      return {
        state: "confirmed-success",
        reason: null,
        receipt: { nodeId: "C1" },
      };
    },
    async inspectAction() {
      throw new Error("unused");
    },
    async inspectPr() {
      throw new Error("unused");
    },
  };
  const coordinator = new DeliveryCoordinator(store, {
    providerFactories: {
      github: () => {
        calls.push("github");
        return provider;
      },
    },
    issueTrackerFactories: {
      github: () => {
        calls.push("issue-tracker");
        return provider;
      },
    },
    codeHostOf: (_project, repositoryId) =>
      repositoryId === "4242"
        ? { codeHost: "gitlab", host: "gitlab.example.com" }
        : { codeHost: "github", host: "github.com" },
    verifyPush: async () => {
      calls.push("verifyPush");
      return null;
    },
    push: async () => {
      calls.push("push");
      throw new Error("unused");
    },
    authorize: () => {},
    approved: () => true,
  });
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  const submit = (action: ExternalAction) =>
    coordinator.submit({ operationId: randomUUID(), action }, caller);
  try {
    const refused = await submit({
      kind: "branch.push",
      target: { repositoryId: "4242" },
      commitSha: "a".repeat(40),
    });
    assert.equal(refused.state, "confirmed-failure");
    assert.equal(refused.observation?.reason, "code-host-delivery-unavailable");
    assert.equal(refused.observation?.receipt, null);
    assert.deepEqual(calls, []);
    // Issue writes go to the issue-tracker writer, whatever code host the repository is linked to.
    for (const repositoryId of ["4242", "R1"]) {
      const delivered = await submit({
        kind: "issue.comment",
        target: { repositoryId, number: 1, nodeId: "I1" },
        body: "B",
      });
      assert.equal(delivered.state, "confirmed-success");
    }
    assert.deepEqual(calls, [
      "issue-tracker",
      "preflight",
      "perform",
      "issue-tracker",
      "preflight",
      "perform",
    ]);
    await coordinator.stop();

    // A GitLab provider that implements only branch actions refuses the rest before preflight.
    const seen: string[] = [];
    const branchOnly = new DeliveryCoordinator(store, {
      providerFactories: {
        gitlab: () => ({
          ...provider,
          supportsAction: (kind) => kind.startsWith("branch."),
        }),
      },
      codeHostOf: () => ({ codeHost: "gitlab", host: "gitlab.example.com" }),
      verifyPush: async () => {
        seen.push("verifyPush");
        return null;
      },
      authorize: () => {},
      approved: () => true,
    });
    const comment = await branchOnly.submit(
      {
        operationId: randomUUID(),
        action: {
          kind: "issue.comment",
          target: { repositoryId: "4242", number: 1, nodeId: "I1" },
          body: "B",
        },
      },
      caller,
    );
    assert.equal(comment.observation?.reason, "code-host-delivery-unavailable");
    assert.deepEqual(seen, []);
    const branch = await branchOnly.submit(
      {
        operationId: randomUUID(),
        action: {
          kind: "branch.push",
          target: { repositoryId: "4242" },
          commitSha: "a".repeat(40),
        },
      },
      caller,
    );
    // Supported, so it went on to the offline commit check.
    assert.equal(branch.observation?.reason, "push-commit-not-verified");
    assert.deepEqual(seen, ["verifyPush"]);
    await branchOnly.stop();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A coordinator over real SQLite whose grants and fakes the issue-tracker routing tests choose. */
function routingFixture(
  grants: DeliveryPolicy["grants"],
  options: Partial<ConstructorParameters<typeof DeliveryCoordinator>[1]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "cab-delivery-"));
  const db = new DatabaseSync(join(directory, "delivery.sqlite"));
  const projectId = randomUUID(),
    taskId = randomUUID();
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
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
  domain.execute({
    type: "delivery.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants,
    requiredChecks: [],
  });
  const store = new DeliveryStore(db);
  store.migrate();
  const coordinator = new DeliveryCoordinator(store, {
    authorize: () => {},
    approved: () => true,
    ...options,
  });
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  return {
    db,
    store,
    projectId,
    reconcile: () => coordinator.reconcile(),
    inspectOwnClosure: coordinator.inspectOwnClosure.bind(coordinator),
    taskId,
    submit: (action: ExternalAction) =>
      coordinator.submit({ operationId: randomUUID(), action }, caller),
    async close() {
      await coordinator.stop();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** A fake that records which role's calls reached it. */
function recordingFake(
  role: string,
  calls: string[],
  performed: "confirmed-success" | "uncertain" = "confirmed-success",
) {
  return {
    ...unusedIssueInspection,
    async inspectClosedIssue() {
      calls.push(`${role}:inspectClosedIssue`);
      return { state: "open" as const };
    },
    async preflight(action: ExternalAction) {
      calls.push(`${role}:preflight:${action.kind}`);
      return { nodeId: "I1", state: "open" };
    },
    async performAction() {
      return {
        state: performed,
        reason: performed === "uncertain" ? "response-lost" : null,
        receipt:
          performed === "uncertain"
            ? null
            : { nodeId: "C1", issueClosed: true },
      };
    },
    async inspectAction() {
      calls.push(`${role}:inspectAction`);
      return {
        state: "confirmed-success" as const,
        reason: null,
        receipt: { nodeId: "C1" },
      };
    },
    async inspectPr(): Promise<never> {
      throw new Error("unused");
    },
  };
}

test("delivery routes issue actions to the project's issue-tracker writer and code-host actions to the link's provider", async () => {
  const calls: string[] = [];
  const instances: string[] = [];
  const f = routingFixture(
    [
      { action: "issue.comment", repositoryId: "R1", mode: "allow" },
      { action: "issue.labels", repositoryId: "R1", mode: "allow" },
      { action: "issue.edit", repositoryId: "R1", mode: "allow" },
      { action: "branch.push", repositoryId: "R1", mode: "allow" },
      {
        action: "project.field",
        repositoryId: "R1",
        mode: "allow",
        projectNodeId: "PR",
        fieldNodeId: "F",
        optionNodeIds: ["O"],
      },
    ],
    {
      providerFactories: {
        github: () => recordingFake("code-host", calls),
      },
      issueTrackerFactories: {
        github: (_project, _policy, instance) => {
          instances.push(instance);
          return recordingFake("issue-tracker", calls);
        },
      },
      verifyPush: async () => ({
        workspacePath: tmpdir(),
        uncommittedEntries: 0,
        descendsFromLastPushed: null,
      }),
    },
  );
  try {
    const target = { repositoryId: "R1", number: 1, nodeId: "I1" };
    const actions: ExternalAction[] = [
      { kind: "issue.comment", target, body: "B" },
      { kind: "issue.labels", target, add: ["a"], remove: [] },
      { kind: "issue.edit", target, fields: { title: "New" } },
      {
        kind: "project.field",
        target,
        projectNodeId: "PR",
        itemNodeId: "IT",
        fieldNodeId: "F",
        optionNodeId: "O",
      },
      {
        kind: "branch.push",
        target: { repositoryId: "R1" },
        commitSha: "a".repeat(40),
      },
    ];
    for (const action of actions)
      assert.equal((await f.submit(action)).state, "confirmed-success");
    assert.deepEqual(calls, [
      "issue-tracker:preflight:issue.comment",
      "issue-tracker:preflight:issue.labels",
      "issue-tracker:preflight:issue.edit",
      "issue-tracker:preflight:project.field",
      "code-host:preflight:branch.push",
    ]);
    assert.deepEqual(instances, Array(4).fill("github.com"));
  } finally {
    await f.close();
  }
});

test("an issue tracker without a writer is refused before any provider call", async () => {
  const calls: string[] = [];
  const f = routingFixture(
    [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
    {
      providerFactories: {
        github: () => recordingFake("code-host", calls),
      },
      issueTrackerOf: () => ({
        issueTracker: "jira" as never,
        instance: "example.atlassian.net",
      }),
    },
  );
  try {
    const refused = await f.submit({
      kind: "issue.comment",
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      body: "B",
    });
    assert.equal(refused.state, "confirmed-failure");
    assert.equal(
      refused.observation?.reason,
      "issue-tracker-delivery-unavailable",
    );
    assert.equal(refused.observation?.receipt, null);
    assert.deepEqual(calls, []);
  } finally {
    await f.close();
  }
});

test("a recorded issue grant keeps its meaning without a repository link", async () => {
  const calls: string[] = [];
  const f = routingFixture([], {
    // The container is linked as a GitLab repository, which no longer matters for an issue write.
    codeHostOf: () => ({ codeHost: "gitlab", host: "gitlab.example.com" }),
    issueTrackerFactories: {
      github: () => recordingFake("issue-tracker", calls),
    },
  });
  try {
    // The policy exactly as an earlier release stored it.
    const recorded = f.db
      .prepare(
        "SELECT version, policyJson FROM delivery_policies WHERE projectId = ?",
      )
      .get(f.projectId) as { version: number; policyJson: string };
    const policy = JSON.parse(recorded.policyJson);
    policy.grants = [
      { action: "issue.comment", repositoryId: "4242", mode: "allow" },
    ];
    f.db
      .prepare(
        "UPDATE delivery_policies SET policyJson = ? WHERE projectId = ?",
      )
      .run(JSON.stringify(policy), f.projectId);
    const comment = (repositoryId: string) =>
      f.submit({
        kind: "issue.comment",
        target: { repositoryId, number: 1, nodeId: "I1" },
        body: "B",
      });
    assert.equal((await comment("4242")).state, "confirmed-success");
    assert.equal((await comment("9999")).state, "denied");
    assert.deepEqual(calls, ["issue-tracker:preflight:issue.comment"]);
  } finally {
    await f.close();
  }
});

test("reconciliation reads an issue action back through the issue-tracker writer", async () => {
  const calls: string[] = [];
  const f = routingFixture(
    [{ action: "issue.comment", repositoryId: "R1", mode: "allow" }],
    {
      providerFactories: {
        github: () => recordingFake("code-host", calls, "uncertain"),
      },
      issueTrackerFactories: {
        github: () => recordingFake("issue-tracker", calls, "uncertain"),
      },
    },
  );
  try {
    const comment = await f.submit({
      kind: "issue.comment",
      target: { repositoryId: "R1", number: 1, nodeId: "I1" },
      body: "B",
    });
    assert.equal(comment.state, "uncertain");
    await f.reconcile();
    assert.deepEqual(calls, [
      "issue-tracker:preflight:issue.comment",
      "issue-tracker:inspectAction",
    ]);
  } finally {
    await f.close();
  }
});

test("closure inspection reads the issue back through the issue-tracker writer", async () => {
  const calls: string[] = [];
  const f = routingFixture(
    [{ action: "issue.close", repositoryId: "R1", mode: "allow" }],
    {
      providerFactories: {
        github: () => recordingFake("code-host", calls),
      },
      issueTrackerFactories: {
        github: () => recordingFake("issue-tracker", calls),
      },
    },
  );
  try {
    const target = { repositoryId: "R1", number: 1, nodeId: "I1" };
    const close = await f.submit({
      kind: "issue.close",
      target,
      reviewedResultIds: [],
    });
    assert.equal(close.state, "confirmed-success");
    calls.length = 0;
    await f.inspectOwnClosure(f.taskId, target);
    assert.deepEqual(calls, ["issue-tracker:inspectClosedIssue"]);
  } finally {
    await f.close();
  }
});
