import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeliveryStore } from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import { scriptedStackDeliveryProvider } from "../fixtures/delivery-integration.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
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
  test(`stack preparation holds ${fault} without losing the created PR or sending a stack write`, async () => {
    const w = stackWorld();
    try {
      w.scripted.state.existing = true;
      w.scripted.state[fault] = true;
      const result = await w.submit();
      assert.equal(result.state, "uncertain");
      assert.equal(result.observation?.receipt?.nodeId, "P2");
      assert.equal(result.stackLink?.phase, "receipt-recorded");
      await w.restart();
      assert.equal(w.scripted.state.stackWrites, 0);
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
  test(`fresh provider merge guard holds ${fault} without a merge write`, async () => {
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
        false,
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
