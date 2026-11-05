import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeliveryStore } from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import { scriptedStackDeliveryProvider } from "../fixtures/delivery-integration.js";
import { stackedDeliveryFixture } from "../fixtures/stacked-delivery.js";

function fixture(databasePath = ":memory:") {
  const db = new DatabaseSync(databasePath);
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
    name: "Stack",
    leadProfileId: null,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Dependent",
    outcome: "Deliver",
  });
  const store = new DeliveryStore(db);
  store.migrate();
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [{ action: "pr.create", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  const branch = store.assignTaskBranchWithinTransaction(taskId, "R1");
  const headSha = "a".repeat(40);
  db.prepare(
    "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
  ).run(headSha, taskId);
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
  const request = {
    operationId: randomUUID(),
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
  return { db, domain, store, caller, request, headSha };
}

test("stack receipt survives reopening the store and its send boundary cannot be replayed", () => {
  const f = fixture();
  try {
    const { operationId } = f.request;
    assert.equal(
      f.store.prepareAction(f.request, f.caller, false).state,
      "prepared",
    );
    const identity = {
      blockerTaskId: randomUUID(),
      repositoryId: "R1",
      blockerBranch: "cab/blocker",
      blockerPrNodeId: "P1",
      blockerPrNumber: 1,
      dependentPrNodeId: "P2",
      dependentPrNumber: 2,
    };
    f.store.prepareStackCreate(
      operationId,
      {
        blockerTaskId: identity.blockerTaskId,
        repositoryId: identity.repositoryId,
        blockerBranch: identity.blockerBranch,
        blockerPrNodeId: identity.blockerPrNodeId,
        blockerPrNumber: identity.blockerPrNumber,
        blockerHeadSha: "b".repeat(40),
      },
      () => {},
    );
    f.store.beginAttempt(operationId, {});
    const receipt = { nodeId: "P2", number: 2, headSha: f.headSha };
    const recorded = f.store.recordStackReceipt(
      operationId,
      identity,
      receipt,
      () => {},
    );
    assert.equal(recorded.state, "uncertain");
    const restarted = new DeliveryStore(f.db);
    assert.deepEqual(
      restarted.action(operationId).observation?.receipt,
      receipt,
    );
    assert.throws(
      () =>
        restarted.recordStackReceipt(
          operationId,
          { ...identity, blockerPrNumber: 3 },
          receipt,
          () => {},
        ),
      /immutable|does not match/,
    );
    assert.throws(
      () =>
        restarted.beginStackLink(
          operationId,
          () => {
            throw Error("authority moved");
          },
          null,
        ),
      /authority moved/,
    );
    assert.equal(
      restarted.action(operationId).stackLink?.phase,
      "receipt-recorded",
    );
    restarted.beginStackLink(operationId, () => {}, null);
    assert.throws(
      () => new DeliveryStore(f.db).beginStackLink(operationId, () => {}, null),
      /cannot be replayed/,
    );
    restarted.recordObservation(operationId, {
      state: "uncertain",
      reason: "provider-readback-unavailable",
      receipt: null,
    });
    assert.deepEqual(
      restarted.action(operationId).observation?.receipt,
      receipt,
    );
    assert.equal(
      restarted.action(operationId).stackLink?.phase,
      "link-attempting",
    );
    assert.throws(
      () =>
        restarted.recordObservation(operationId, {
          state: "uncertain",
          reason: "mismatched",
          receipt: { ...receipt, nodeId: "P99" },
        }),
      /immutable/,
    );
    assert.deepEqual(
      restarted.action(operationId).observation?.receipt,
      receipt,
    );
  } finally {
    f.db.close();
  }
});

test("wrong stacked create base is refused before provider selection", async () => {
  const f = fixture();
  const coordinator = new DeliveryCoordinator(f.store, {
    authorize: () => {},
    approved: () => false,
    stackedPrBase: () => ({
      blockerTaskId: randomUUID(),
      repositoryId: "R1",
      branch: "cab/blocker",
    }),
    providerFactories: {
      github: () => {
        throw Error("Provider must not be selected");
      },
    },
  });
  try {
    const result = await coordinator.submit(
      {
        ...f.request,
        action: {
          ...f.request.action,
          target: { ...f.request.action.target, baseRef: "main" },
        },
      },
      f.caller,
    );
    assert.equal(result.state, "confirmed-failure");
    assert.equal(
      result.observation?.reason,
      "stacked-pr-base-must-match-blocker-branch",
    );
    assert.equal(result.attempts, 0);
  } finally {
    await coordinator.stop();
    f.db.close();
  }
});

/** Assembles real SQLite, policy, coordinator and production GitHub HTTP parsing. */
function stackWorld(stacked = true) {
  const f = fixture();
  const scripted = scriptedStackDeliveryProvider(
    f.request.action.target.headRef,
    f.headSha,
  );
  const blockerTaskId = randomUUID();
  let authority = true;
  let branch = "cab/blocker";
  const options = {
    authorize: () => {
      if (!authority) throw Error("Authority revoked");
    },
    approved: () => false,
    stackedPrBase: () =>
      stacked
        ? {
            blockerTaskId,
            repositoryId: "R1",
            branch,
            blockerPrNodeId: "P1",
            blockerPrNumber: 1,
            blockerHeadSha: scripted.blockerSha,
          }
        : null,
    providerFactories: { github: () => scripted.provider },
  };
  let coordinator = new DeliveryCoordinator(f.store, options);
  return {
    ...f,
    scripted,
    submit: () => coordinator.submit(f.request, f.caller),
    async restart() {
      await coordinator.stop();
      coordinator = new DeliveryCoordinator(new DeliveryStore(f.db), options);
      await coordinator.reconcile();
      return f.store.action(f.request.operationId);
    },
    revoke: () => {
      authority = false;
    },
    moveBranch: () => {
      branch = "cab/changed";
    },
    async close() {
      await coordinator.stop();
      f.db.close();
    },
  };
}

for (const existing of [false, true]) {
  test(`stacked create ${existing ? "appends only to the verified top" : "creates an ordered stack"} in one journal`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.existing = existing;
      w.scripted.state.afterPrWrite = () => {
        const persisted = w.store.action(w.request.operationId);
        assert.equal(persisted.state, "attempting");
        assert.equal(persisted.stackCreate?.blockerPrNodeId, "P1");
        assert.equal(persisted.stackLink, undefined);
      };
      w.scripted.state.afterStackWrite = () => {
        const persisted = w.store.action(w.request.operationId);
        assert.equal(persisted.state, "uncertain");
        assert.equal(persisted.stackLink?.phase, "link-attempting");
        assert.equal(persisted.observation?.receipt?.nodeId, "P2");
      };
      const result = await w.submit();
      assert.equal(result.state, "confirmed-success");
      assert.equal(result.observation?.stack?.position, existing ? 3 : 2);
      assert.equal(result.observation?.stack?.size, existing ? 3 : 2);
      assert.deepEqual(w.scripted.state.stackBodies, [
        { pull_requests: existing ? [2] : [1, 2] },
      ]);
      assert.equal(w.store.actions(w.caller.taskId).length, 1);
      assert.equal((await w.restart()).state, "confirmed-success");
      assert.equal(w.scripted.state.prWrites, 1);
      assert.equal(w.scripted.state.stackWrites, 1);
    } finally {
      await w.close();
    }
  });
}

test("ordinary creates preserve their receipt and never read or write a stack", async () => {
  const w = stackWorld(false);
  try {
    assert.equal((await w.submit()).state, "confirmed-success");
    assert.equal(w.scripted.state.stackWrites, 0);
    assert.equal(
      w.scripted.state.requests.some(
        (r) => r.route.includes("/stacks") || /\/pulls\/\d+$/.test(r.route),
      ),
      false,
    );
    assert.equal(w.store.action(w.request.operationId).stackCreate, undefined);
  } finally {
    await w.close();
  }
});

for (const fault of [
  "nonTop",
  "missingMembership",
  "changedBlocker",
  "failStackReads",
] as const) {
  test(`stack preparation preserves the PR receipt and refuses replay after ${fault}`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.existing = true;
      w.scripted.state[fault] = true;
      const result = await w.submit();
      assert.equal(result.state, "uncertain");
      assert.equal(result.observation?.receipt?.nodeId, "P2");
      assert.equal(
        result.stackLink?.phase,
        fault === "missingMembership" ? "link-attempting" : "receipt-recorded",
      );
      await w.restart();
      assert.equal(
        w.scripted.state.stackWrites,
        fault === "missingMembership" ? 1 : 0,
      );
      assert.equal(w.scripted.state.prWrites, 1);
    } finally {
      await w.close();
    }
  });
}

for (const applied of [false, true]) {
  test(`409 ${applied ? "matching readback settles" : "absent readback holds"} without resending`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.existing = true;
      w.scripted.state.rejection = 409;
      w.scripted.state.applyOnConflict = applied;
      const result = await w.submit();
      assert.equal(result.state, applied ? "confirmed-success" : "uncertain");
      assert.equal(
        (await w.restart()).state,
        applied ? "confirmed-success" : "uncertain",
      );
      assert.equal(w.scripted.state.prWrites, 1);
      assert.equal(w.scripted.state.stackWrites, 1);
    } finally {
      await w.close();
    }
  });
}

test("422 persists a bounded reason and requires readback before confirming a plain chain", async () => {
  const w = stackWorld();
  try {
    w.scripted.state.rejection = 422;
    w.scripted.state.reason = "Rejected\n" + "x".repeat(600);
    w.scripted.state.afterStackWrite = () => {
      w.scripted.state.failStackReads = true;
    };
    const held = await w.submit();
    assert.equal(held.state, "uncertain");
    assert.equal(held.observation?.receipt?.nodeId, "P2");
    assert.equal(held.observation?.stackLinkRefused, true);
    assert.equal(held.observation?.hostReason?.length, 500);
    assert.equal(held.observation?.hostReason?.includes("\n"), false);
    assert.equal(held.observation?.stack, undefined);
    w.scripted.state.failStackReads = false;
    const recovered = await w.restart();
    assert.equal(recovered.state, "confirmed-success");
    assert.equal(
      recovered.observation?.reason,
      "stack-link-refused-plain-chain",
    );
    assert.equal(recovered.observation?.stack, null);
    assert.equal(
      recovered.observation?.hostReason,
      held.observation?.hostReason,
    );
    assert.equal(w.scripted.state.stackWrites, 1);
    assert.equal(w.scripted.state.prWrites, 1);
  } finally {
    await w.close();
  }
});

for (const fault of [
  "failStackReads",
  "inconsistentMembership",
  "missingMembership",
] as const) {
  test(`lost stack response with ${fault} recovers only by validated readback`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.loseStackResponse = true;
      w.scripted.state.afterStackWrite = () => {
        w.scripted.state[fault] = true;
      };
      const held = await w.submit();
      assert.equal(held.state, "uncertain");
      assert.equal(held.observation?.receipt?.nodeId, "P2");
      assert.equal(held.stackLink?.phase, "link-attempting");
      assert.equal((await w.restart()).state, "uncertain");
      w.scripted.state[fault] = false;
      assert.equal((await w.restart()).state, "confirmed-success");
      assert.equal(w.scripted.state.stackWrites, 1);
      assert.equal(w.scripted.state.prWrites, 1);
    } finally {
      await w.close();
    }
  });
}

test("lost PR create response is reconciled by marker before the stack effect, never by another create", async () => {
  const w = stackWorld();
  try {
    w.scripted.state.losePrResponse = true;
    assert.equal((await w.submit()).state, "uncertain");
    assert.equal(w.scripted.state.stackWrites, 0);
    assert.equal((await w.restart()).state, "confirmed-success");
    assert.equal(w.scripted.state.prWrites, 1);
    assert.equal(w.scripted.state.stackWrites, 1);
  } finally {
    await w.close();
  }
});

for (const boundary of [
  "before-receipt",
  "after-receipt",
  "after-link-intent",
] as const) {
  test(`restart at ${boundary} preserves the two-effect boundary`, async () => {
    const w = stackWorld();
    const receipt = w.store.recordStackReceipt.bind(w.store);
    const begin = w.store.beginStackLink.bind(w.store);
    try {
      if (boundary === "after-link-intent") {
        w.store.beginStackLink = (...args) => {
          begin(...args);
          throw Error("Crash after durable link intent, before POST");
        };
      } else {
        w.store.recordStackReceipt = (...args) => {
          if (boundary === "after-receipt") receipt(...args);
          throw Error("Crash at receipt boundary");
        };
      }
      const held = await w.submit();
      assert.equal(held.state, "uncertain");
      assert.equal(w.scripted.state.prWrites, 1);
      assert.equal(w.scripted.state.stackWrites, 0);
      const recovered = await w.restart();
      // A durable intent is possibly sent even when the test knows it crashed before POST.
      assert.equal(
        recovered.state,
        boundary === "after-link-intent" ? "uncertain" : "confirmed-success",
      );
      assert.equal(
        w.scripted.state.stackWrites,
        boundary === "after-link-intent" ? 0 : 1,
      );
      assert.equal(w.scripted.state.prWrites, 1);
    } finally {
      await w.close();
    }
  });
}

for (const change of ["authority", "branch"] as const) {
  test(`${change} changed after the PR effect holds the second effect and retains receipt`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.afterPrWrite =
        change === "authority" ? w.revoke : w.moveBranch;
      const result = await w.submit();
      assert.equal(result.state, "uncertain");
      assert.equal(result.observation?.receipt?.nodeId, "P2");
      assert.equal(w.scripted.state.prWrites, 1);
      assert.equal(w.scripted.state.stackWrites, 0);
      await w.restart();
      assert.equal(w.scripted.state.stackWrites, 0);
    } finally {
      await w.close();
    }
  });
}

for (const change of ["authority", "branch"] as const) {
  test(`${change} moving during stack preflight is rechecked synchronously before send intent`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.afterStackRead =
        change === "authority" ? w.revoke : w.moveBranch;
      const result = await w.submit();
      assert.equal(result.state, "uncertain");
      assert.equal(result.stackLink?.phase, "receipt-recorded");
      assert.equal(result.observation?.receipt?.nodeId, "P2");
      assert.equal(w.scripted.state.stackWrites, 0);
    } finally {
      await w.close();
    }
  });
}

test("422 with inconsistent readback retains refusal evidence and cannot claim a plain chain", async () => {
  const w = stackWorld();
  try {
    w.scripted.state.rejection = 422;
    w.scripted.state.afterStackWrite = () => {
      w.scripted.state.linked = true;
      w.scripted.state.inconsistentMembership = true;
    };
    const result = await w.submit();
    assert.equal(result.state, "uncertain");
    assert.equal(result.observation?.stackLinkRefused, true);
    assert.equal(result.observation?.hostReason, w.scripted.state.reason);
    assert.equal(result.observation?.stack, undefined);
    assert.equal((await w.restart()).state, "uncertain");
    assert.equal(w.scripted.state.stackWrites, 1);
  } finally {
    await w.close();
  }
});

for (const facts of [
  { repositoryId: "R1", branch: null },
  { repositoryId: "R2", branch: "cab/blocker" },
  { repositoryId: "R1", branch: "cab/blocker" },
]) {
  test(`unproved offline blocker facts ${JSON.stringify(facts)} refuse before provider calls`, async () => {
    const f = fixture();
    let selected = 0;
    const coordinator = new DeliveryCoordinator(f.store, {
      authorize: () => {},
      approved: () => false,
      stackedPrBase: () => ({ blockerTaskId: randomUUID(), ...facts }),
      providerFactories: {
        github: () => {
          selected++;
          throw Error("Unexpected provider selection");
        },
      },
    });
    try {
      const result = await coordinator.submit(f.request, f.caller);
      assert.equal(result.state, "confirmed-failure");
      assert.equal(result.attempts, 0);
      assert.equal(selected, 0);
    } finally {
      await coordinator.stop();
      f.db.close();
    }
  });
}

test("stack create identity is immutable and a bare PR receipt cannot complete the delivery", () => {
  const f = fixture();
  try {
    f.store.prepareAction(f.request, f.caller, false);
    const identity = {
      blockerTaskId: randomUUID(),
      repositoryId: "R1",
      blockerBranch: "cab/blocker",
      blockerPrNodeId: "P1",
      blockerPrNumber: 1,
      blockerHeadSha: "b".repeat(40),
    };
    f.store.prepareStackCreate(f.request.operationId, identity, () => {});
    assert.throws(
      () =>
        f.store.prepareStackCreate(
          f.request.operationId,
          { ...identity, blockerPrNodeId: "P99" },
          () => {},
        ),
      /immutable/,
    );
    assert.deepEqual(
      f.store.action(f.request.operationId).stackCreate,
      identity,
    );
    f.store.beginAttempt(f.request.operationId, {});
    const result = f.store.recordObservation(f.request.operationId, {
      state: "confirmed-success",
      reason: null,
      receipt: { nodeId: "P2", number: 2, headSha: f.headSha },
    });
    assert.equal(result.state, "uncertain");
    assert.equal(result.observation?.reason, "stack-link-pending");
    assert.equal(result.observation?.receipt?.nodeId, "P2");
  } finally {
    f.db.close();
  }
});

for (const fault of [
  "unmerged",
  "unknown",
  "cycle",
  "cross-repository",
  "mismatch",
] as const) {
  test(`offline merge refuses ${fault} lower layers before provider selection`, async () => {
    const f = fixture();
    const lowerId = randomUUID();
    f.domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId: f.caller.projectId,
      taskId: lowerId,
      title: "Lower",
      outcome: "Deliver lower",
    });
    f.db
      .prepare(
        "INSERT INTO stacked_dependencies(taskId,blockerTaskId,repositoryId,parentHead,restack,recordedAt) VALUES (?,?,?,?, 'current',1)",
      )
      .run(
        f.caller.taskId,
        fault === "cycle" ? f.caller.taskId : lowerId,
        fault === "cross-repository" ? "R2" : "R1",
        f.headSha,
      );
    const branch = f.store.assignTaskBranchWithinTransaction(lowerId, "R1");
    f.db
      .prepare(
        "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
      )
      .run(f.headSha, lowerId);
    if (fault !== "unknown")
      f.store.registerPrWithinTransaction(
        { ...f.caller, taskId: lowerId, workId: "lower" },
        {
          repositoryId: "R1",
          nodeId: "P1",
          number: 1,
          baseRef: "main",
          headRef: fault === "mismatch" ? "wrong" : branch.branch,
          headSha: f.headSha,
          baseSha: "b".repeat(40),
          state: "OPEN",
          draft: false,
          merged: false,
          reviewDecision: null,
          checks: [],
          mergeBlockers: [],
          allowedMethods: ["squash"],
          closedIssueNodeIds: [],
        },
        f.caller.assignmentId,
      );
    f.domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.caller.projectId,
      expectedVersion: 2,
      mode: "through-merge",
      credentialRef: null,
      grants: [{ action: "pr.merge", repositoryId: "R1", mode: "allow" }],
      requiredChecks: [],
    });
    let selected = 0;
    const coordinator = new DeliveryCoordinator(f.store, {
      authorize: () => {},
      approved: () => false,
      providerFactories: {
        github: () => {
          selected++;
          throw Error("Provider selected before offline guard");
        },
      },
    });
    try {
      const result = await coordinator.submit(
        {
          operationId: randomUUID(),
          action: {
            kind: "pr.merge",
            target: {
              repositoryId: "R1",
              nodeId: "P2",
              number: 2,
              baseRef: "cab/blocker",
              headRef: f.request.action.target.headRef,
              expectedHeadSha: f.headSha,
            },
            method: "squash",
            reviewedResultIds: [],
          },
        },
        f.caller,
      );
      assert.equal(result.state, "confirmed-failure");
      assert.match(result.observation?.reason ?? "", /^stacked-lower-pr-/);
      assert.equal(result.attempts, 0);
      assert.equal(selected, 0);
    } finally {
      await coordinator.stop();
      f.db.close();
    }
  });
}

for (const fault of [
  "unmerged",
  "missingMembership",
  "inconsistentMembership",
  "failStackReads",
] as const) {
  test(`fresh provider merge guard ${fault === "missingMembership" ? "accepts omitted membership" : `holds ${fault}`}`, async () => {
    const w = stackWorld();
    try {
      const created = await w.submit();
      assert.equal(created.state, "confirmed-success");
      if (fault !== "unmerged") w.scripted.state[fault] = true;
      const target = {
        repositoryId: "R1",
        nodeId: "P2",
        number: 2,
        baseRef: "cab/blocker",
        headRef: w.request.action.target.headRef,
        expectedHeadSha: w.headSha,
      };
      const result = await w.scripted.provider.performAction({
        ...created,
        request: {
          operationId: randomUUID(),
          action: {
            kind: "pr.merge",
            target,
            method: "squash",
            reviewedResultIds: [],
          },
        },
      });
      assert.notEqual(result.state, "confirmed-success");
      assert.equal(
        w.scripted.state.requests.some((r) => r.route.includes("merge-async")),
        fault === "missingMembership",
      );
    } finally {
      await w.close();
    }
  });
}

test("a proved merged lower layer permits the existing async merge path without resending", async () => {
  const w = stackWorld();
  try {
    const created = await w.submit();
    w.scripted.state.lowerMerged = true;
    const target = {
      repositoryId: "R1",
      nodeId: "P2",
      number: 2,
      baseRef: "cab/blocker",
      headRef: w.request.action.target.headRef,
      expectedHeadSha: w.headSha,
    };
    const record = {
      ...created,
      request: {
        operationId: randomUUID(),
        action: {
          kind: "pr.merge" as const,
          target,
          method: "squash" as const,
          reviewedResultIds: [],
        },
      },
    };
    const pending = await w.scripted.provider.performAction(record);
    assert.equal(pending.state, "uncertain");
    assert.equal(pending.mergeRequest?.uuid, "stack-merge-1");
    await w.scripted.provider.inspectAction({
      ...record,
      observation: pending,
    });
    assert.equal(
      w.scripted.state.requests.filter(
        (r) => r.route.startsWith("PUT ") && r.route.includes("merge-async"),
      ).length,
      1,
    );
  } finally {
    await w.close();
  }
});

test("offline merge walks every lower layer and changes its proof when a cached fact moves", () => {
  const f = fixture();
  try {
    let child = f.caller.taskId;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      ids.push(id);
      f.domain.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId: f.caller.projectId,
        taskId: id,
        title: `Lower ${i}`,
        outcome: "O",
      });
      f.db
        .prepare(
          "INSERT INTO stacked_dependencies(taskId,blockerTaskId,repositoryId,parentHead,restack,recordedAt) VALUES (?,?,?,?, 'current',1)",
        )
        .run(child, id, "R1", f.headSha);
      const branch = f.store.assignTaskBranchWithinTransaction(id, "R1");
      f.db
        .prepare(
          "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
        )
        .run(f.headSha, id);
      f.store.registerPrWithinTransaction(
        { ...f.caller, taskId: id, workId: id },
        {
          repositoryId: "R1",
          nodeId: `P-${i}`,
          number: i + 1,
          baseRef: "main",
          headRef: branch.branch,
          headSha: f.headSha,
          baseSha: "b".repeat(40),
          state: "MERGED",
          draft: false,
          merged: true,
          reviewDecision: null,
          checks: [],
          mergeBlockers: [],
          allowedMethods: ["squash"],
          closedIssueNodeIds: [],
        },
        f.caller.assignmentId,
      );
      child = id;
    }
    const before = f.store.stackMergeGuard(f.caller.taskId, "R1");
    assert.equal(before.reason, null);
    f.store.recordPrReadFailure(ids[1]!);
    const after = f.store.stackMergeGuard(f.caller.taskId, "R1");
    assert.equal(after.reason, "stacked-lower-pr-unproved");
    assert.notEqual(before.material, after.material);
  } finally {
    f.db.close();
  }
});

test("a lower dependency appearing during provider preflight is refused at the transactional merge boundary", async () => {
  const f = fixture();
  const lower = randomUUID();
  f.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: f.caller.projectId,
    taskId: lower,
    title: "Lower",
    outcome: "O",
  });
  f.domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.caller.projectId,
    expectedVersion: 2,
    mode: "through-merge",
    credentialRef: null,
    grants: [{ action: "pr.merge", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [],
  });
  let writes = 0;
  const coordinator = new DeliveryCoordinator(f.store, {
    authorize: () => {},
    approved: () => false,
    providerFactories: {
      github: () => ({
        async preflight() {
          await Promise.resolve();
          f.db
            .prepare(
              "INSERT INTO stacked_dependencies(taskId,blockerTaskId,repositoryId,parentHead,restack,recordedAt) VALUES (?,?,?,?, 'current',1)",
            )
            .run(f.caller.taskId, lower, "R1", f.headSha);
          return {};
        },
        async performAction() {
          writes++;
          return {
            state: "uncertain" as const,
            reason: "unexpected",
            receipt: null,
          };
        },
        async inspectAction() {
          throw Error("Unexpected readback");
        },
        async inspectPr() {
          throw Error("Unexpected PR read");
        },
      }),
    },
  });
  try {
    const result = await coordinator.submit(
      {
        operationId: randomUUID(),
        action: {
          kind: "pr.merge",
          target: {
            repositoryId: "R1",
            nodeId: "P2",
            number: 2,
            baseRef: "cab/blocker",
            headRef: f.request.action.target.headRef,
            expectedHeadSha: f.headSha,
          },
          method: "squash",
          reviewedResultIds: [],
        },
      },
      f.caller,
    );
    assert.equal(result.state, "confirmed-failure");
    assert.equal(
      result.observation?.reason,
      "delivery-authority-stale-or-held",
    );
    assert.equal(result.attempts, 0);
    assert.equal(writes, 0);
  } finally {
    await coordinator.stop();
    f.db.close();
  }
});

test("a persisted 422 reason survives matching linked readback and restart", async () => {
  const w = stackWorld();
  try {
    w.scripted.state.rejection = 422;
    w.scripted.state.afterStackWrite = () => {
      w.scripted.state.linked = true;
    };
    const linked = await w.submit();
    assert.equal(linked.state, "confirmed-success");
    assert.equal(linked.observation?.stack?.position, 2);
    assert.equal(linked.observation?.stackLinkRefused, true);
    assert.equal(linked.observation?.hostReason, w.scripted.state.reason);
    const restarted = await w.restart();
    assert.deepEqual(restarted.observation, linked.observation);
    assert.equal(w.scripted.state.prWrites, 1);
    assert.equal(w.scripted.state.stackWrites, 1);
  } finally {
    await w.close();
  }
});

test("GitLab stacked dependents retain plain chained MR creation and offline base refusal", async () => {
  const f = fixture();
  let selected = 0,
    creates = 0;
  const blockerTaskId = randomUUID();
  const coordinator = new DeliveryCoordinator(f.store, {
    authorize: () => {},
    approved: () => false,
    codeHostOf: () => ({ codeHost: "gitlab", host: "gitlab.example.com" }),
    stackedPrBase: () => ({
      blockerTaskId,
      repositoryId: "R1",
      branch: "cab/blocker",
    }),
    providerFactories: {
      gitlab: () => {
        selected++;
        return {
          async preflight() {
            return {};
          },
          async performAction() {
            creates++;
            return {
              state: "confirmed-success" as const,
              reason: null,
              receipt: {
                nodeId: "gid://gitlab/MergeRequest/2",
                number: 2,
                headSha: f.headSha,
              },
            };
          },
          async inspectAction() {
            throw Error("Unexpected readback");
          },
          async inspectPr() {
            throw Error("Unexpected PR read");
          },
        };
      },
    },
  });
  try {
    const wrong = await coordinator.submit(
      {
        ...f.request,
        operationId: randomUUID(),
        action: {
          ...f.request.action,
          target: { ...f.request.action.target, baseRef: "main" },
        },
      },
      f.caller,
    );
    assert.equal(
      wrong.observation?.reason,
      "stacked-pr-base-must-match-blocker-branch",
    );
    assert.equal(selected, 0);
    const created = await coordinator.submit(f.request, f.caller);
    assert.equal(created.state, "confirmed-success");
    assert.equal(created.stackCreate, undefined);
    assert.equal(created.stackLink, undefined);
    assert.equal(selected, 1);
    assert.equal(creates, 1);
  } finally {
    await coordinator.stop();
    f.db.close();
  }
});

for (const phase of ["prepared", "retry-due"] as const) {
  for (const stale of [
    "policy",
    "assignment",
    "branch",
    "pr",
    "absent",
    "unread",
  ] as const) {
    test(`${phase} stacked create with stale ${stale} survives SQLite reopen and does not abort refresh`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "cab-stack-preparation-"));
      const path = join(directory, "store.sqlite");
      const f = fixture(path);
      const identity = {
        blockerTaskId: randomUUID(),
        repositoryId: "R1",
        blockerBranch: "cab/blocker",
        blockerPrNodeId: "P1",
        blockerPrNumber: 1,
        blockerHeadSha: "b".repeat(40),
      };
      f.store.prepareAction(f.request, f.caller, false);
      f.store.prepareStackCreate(f.request.operationId, identity, () => {});
      if (phase === "retry-due") {
        f.store.beginAttempt(f.request.operationId, {});
        f.store.recordObservation(f.request.operationId, {
          state: "confirmed-failure",
          reason: "provider-http-429",
          receipt: null,
          retryable: true,
          resumeAt: 1,
        });
      }
      if (stale === "policy")
        f.domain.execute({
          type: "delivery.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: f.caller.projectId,
          expectedVersion: 2,
          mode: "reviewable-pr",
          credentialRef: null,
          grants: [{ action: "pr.create", repositoryId: "R1", mode: "allow" }],
          requiredChecks: [],
        });
      const otherId = randomUUID();
      f.domain.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId: f.caller.projectId,
        taskId: otherId,
        title: "Unrelated",
        outcome: "O",
      });
      const branch = f.store.assignTaskBranchWithinTransaction(otherId, "R1");
      f.db
        .prepare(
          "UPDATE delivery_task_branches SET lastPushedSha=? WHERE taskId=?",
        )
        .run(f.headSha, otherId);
      const other = {
        ...f.request,
        operationId: randomUUID(),
        action: {
          ...f.request.action,
          target: {
            ...f.request.action.target,
            headRef: branch.branch,
            baseRef: "main",
          },
        },
      };
      f.store.prepareAction(other, { ...f.caller, taskId: otherId }, false);
      f.db.close();
      const db = new DatabaseSync(path),
        store = new DeliveryStore(db);
      const sends: string[] = [],
        selections: string[] = [];
      const coordinator = new DeliveryCoordinator(store, {
        approved: () => false,
        authorize: (caller) => {
          if (caller.taskId === f.caller.taskId && stale === "assignment")
            throw Error("Assignment expired");
        },
        stackedPrBase: (taskId) => {
          if (taskId !== f.caller.taskId || stale === "absent") return null;
          if (stale === "unread") throw Error("Current blocker unavailable");
          return {
            blockerTaskId: identity.blockerTaskId,
            repositoryId: "R1",
            branch: stale === "branch" ? "cab/moved" : identity.blockerBranch,
            blockerPrNodeId: stale === "pr" ? "P99" : identity.blockerPrNodeId,
            blockerPrNumber: identity.blockerPrNumber,
            blockerHeadSha: identity.blockerHeadSha,
          };
        },
        providerFactories: {
          github: () => {
            selections.push("selected");
            return {
              async preflight() {
                return {};
              },
              async performAction(record) {
                sends.push(record.operationId);
                return {
                  state: "confirmed-success" as const,
                  reason: null,
                  receipt: { nodeId: "Other", number: 8, headSha: f.headSha },
                };
              },
              async inspectAction() {
                throw Error(
                  "No recovery read expected for a proved unsent failure",
                );
              },
              async inspectPr() {
                throw Error("No binding expected");
              },
            };
          },
        },
      });
      try {
        await coordinator.refresh();
        const held = store.action(f.request.operationId);
        assert.equal(held.state, "confirmed-failure");
        assert.equal(
          held.observation?.reason,
          "delivery-authority-stale-or-held",
        );
        assert.equal(held.observation?.receipt, null);
        assert.equal(held.attempts, phase === "prepared" ? 0 : 1);
        assert.deepEqual(held.stackCreate, identity);
        assert.equal(
          store.action(other.operationId).state,
          "confirmed-success",
        );
        assert.deepEqual(sends, [other.operationId]);
        assert.equal(selections.length, 1);
        await coordinator.refresh();
        assert.deepEqual(
          sends,
          [other.operationId],
          "settled stale intent never retries or starves other actions",
        );
      } finally {
        await coordinator.stop();
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const origin of ["authority-read", "journal-write"] as const) {
  test(`stack preparation does not conceal a ${origin} database fault`, async () => {
    const f = fixture();
    const error = Object.assign(Error("SQLite unavailable"), {
      code: "ERR_SQLITE_ERROR",
    });
    const identity = {
      blockerTaskId: randomUUID(),
      repositoryId: "R1",
      branch: "cab/blocker",
      blockerPrNodeId: "P1",
      blockerPrNumber: 1,
      blockerHeadSha: "b".repeat(40),
    };
    f.store.prepareAction(f.request, f.caller, false);
    if (origin === "journal-write")
      f.store.prepareStackCreate = () => {
        throw error;
      };
    const coordinator = new DeliveryCoordinator(f.store, {
      authorize: () => {},
      approved: () => false,
      stackedPrBase: () => {
        if (origin === "authority-read") throw error;
        return identity;
      },
      providerFactories: {
        github: () => {
          throw Error("No provider selection permitted");
        },
      },
    });
    try {
      await assert.rejects(coordinator.refresh(), (caught) => caught === error);
      assert.equal(f.store.action(f.request.operationId).state, "prepared");
      assert.equal(f.store.action(f.request.operationId).attempts, 0);
    } finally {
      await coordinator.stop();
      f.db.close();
    }
  });
}

test("a possibly sent retry retains unknown evidence and recovers its PR only by readback under stale authority", async () => {
  const w = stackWorld();
  try {
    w.scripted.state.losePrResponse = true;
    assert.equal((await w.submit()).state, "uncertain");
    w.store.recordObservation(w.request.operationId, {
      state: "confirmed-failure",
      reason: "provider-effect-unproved",
      receipt: null,
      retryable: true,
      ambiguous: true,
      hostReason: "Retained uncertain evidence",
    });
    w.revoke();
    const held = await w.restart();
    assert.equal(held.state, "uncertain");
    assert.equal(held.observation?.ambiguous, true);
    assert.equal(held.observation?.hostReason, "Retained uncertain evidence");
    assert.equal(w.scripted.state.prWrites, 1);
    assert.equal(w.scripted.state.stackWrites, 0);
    const readback = await w.restart();
    assert.equal(readback.state, "uncertain");
    assert.equal(readback.observation?.receipt?.nodeId, "P2");
    assert.equal(w.scripted.state.prWrites, 1);
    assert.equal(w.scripted.state.stackWrites, 0);
  } finally {
    await w.close();
  }
});

test("assembled service startup settles a prepared stacked create whose assignment authority expired", async (t) => {
  const f = await stackedDeliveryFixture(t);
  const [blocker, dependent] = f.tasks as [string, string];
  await f.waitTurn(blocker);
  const parent = await f.commit(blocker, "parent-before-recovery");
  await f.push(blocker, parent);
  await f.showPr(blocker);
  await f.service.refreshGitHub();
  await f.waitTurn(dependent);
  const head = await f.commit(dependent, "dependent-before-recovery");
  await f.push(dependent, head);
  const policy = f.service.delivery().configuration(f.projectId);
  f.run({
    type: "delivery.configure",
    projectId: f.projectId,
    expectedVersion: policy.version,
    mode: policy.mode,
    credentialRef: policy.credentialRef,
    grants: [
      ...policy.grants,
      { action: "pr.create", repositoryId: "R1", mode: "allow" },
    ],
    requiredChecks: policy.requiredChecks,
  });
  const own = f.branchOf(dependent),
    lower = f.branchOf(blocker);
  assert.ok(own && lower);
  const operationId = randomUUID();
  const assignment = f.service
    .domain()
    .leadBindings()
    .find((b) => b.taskId === dependent);
  assert.ok(assignment);
  const caller = {
    projectId: f.projectId,
    taskId: dependent,
    taskVersion: Number(f.service.domain().task(dependent).version),
    assignmentId: String(assignment.assignmentId),
    assignmentVersion: 1,
    workId: "expired-work-before-restart",
    workRevision: 1,
    conversationRevision: 1,
  };
  f.readDb((db) => {
    const store = new DeliveryStore(db);
    const prepared = store.prepareAction(
      {
        operationId,
        action: {
          kind: "pr.create",
          target: {
            repositoryId: "R1",
            baseRef: lower.branch,
            headRef: own.branch,
            expectedHeadSha: head,
          },
          title: "Prepared before restart",
          body: "",
          draft: true,
        },
      },
      caller,
      false,
    );
    assert.equal(prepared.state, "prepared");
    store.prepareStackCreate(
      operationId,
      {
        blockerTaskId: blocker,
        repositoryId: "R1",
        blockerBranch: lower.branch,
        blockerPrNodeId: `PR-${blocker}`,
        blockerPrNumber: 1,
        blockerHeadSha: parent,
      },
      () => {},
    );
  });
  await f.restart();
  const recovered = f.service.delivery().action(operationId);
  assert.equal(recovered.state, "confirmed-failure");
  assert.equal(
    recovered.observation?.reason,
    "delivery-authority-stale-or-held",
  );
  assert.equal(recovered.attempts, 0);
  assert.equal(recovered.observation?.receipt, null);
  assert.equal(recovered.stackCreate?.blockerPrNodeId, `PR-${blocker}`);
});

test("stale authority after link intent still permits readback without repeating either effect", async () => {
  const w = stackWorld();
  try {
    w.scripted.state.afterStackWrite = () => {
      w.scripted.state.failStackReads = true;
    };
    const attempted = await w.submit();
    assert.equal(attempted.state, "uncertain");
    assert.equal(attempted.stackLink?.phase, "link-attempting");
    assert.equal(attempted.observation?.receipt?.nodeId, "P2");
    w.revoke();
    w.scripted.state.failStackReads = false;
    const recovered = await w.restart();
    assert.equal(recovered.state, "confirmed-success");
    assert.equal(recovered.observation?.receipt?.nodeId, "P2");
    assert.equal(w.scripted.state.prWrites, 1);
    assert.equal(w.scripted.state.stackWrites, 1);
  } finally {
    await w.close();
  }
});

test("a journal failure replacing a validation rejection still propagates", async () => {
  const f = fixture();
  const storage = Object.assign(Error("Transaction unwind failed"), {
    code: "ERR_SQLITE_ERROR",
  });
  f.store.prepareAction(f.request, f.caller, false);
  f.store.prepareStackCreate = (_operationId, _identity, validate) => {
    try {
      validate();
    } catch {
      throw storage;
    }
    throw Error("Expected stale authority rejection");
  };
  const coordinator = new DeliveryCoordinator(f.store, {
    approved: () => false,
    authorize: () => {
      throw Error("Assignment expired");
    },
    stackedPrBase: () => ({
      blockerTaskId: randomUUID(),
      repositoryId: "R1",
      branch: "cab/blocker",
      blockerPrNodeId: "P1",
      blockerPrNumber: 1,
      blockerHeadSha: "b".repeat(40),
    }),
    providerFactories: {
      github: () => {
        throw Error("No provider call permitted");
      },
    },
  });
  try {
    await assert.rejects(coordinator.refresh(), (error) => error === storage);
    assert.equal(f.store.action(f.request.operationId).state, "prepared");
  } finally {
    await coordinator.stop();
    f.db.close();
  }
});
