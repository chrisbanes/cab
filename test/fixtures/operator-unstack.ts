import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  UnstackMaterial,
  UnstackProvider,
  UnstackReadback,
} from "../../src/standalone/unstack.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { stackedDeliveryFixture } from "./stacked-delivery.js";

export async function operatorUnstackFixture(t: TestContext) {
  let material!: UnstackMaterial,
    observed!: UnstackReadback,
    sends = 0,
    retargets = 0,
    partial = false,
    unavailable = false;
  const provider: UnstackProvider = {
    read: async () => observed,
    sendUnstack: async (_, guard) => {
      guard();
      sends++;
      observed = partial
        ? { state: "changed" }
        : { state: "removed", baseRef: material.pr.baseRef, baseSha: f.base };
      return "unknown";
    },
    sendRetarget: async (_, guard) => {
      guard();
      retargets++;
      observed = { state: "removed", baseRef: "main", baseSha: f.base };
      return "unknown";
    },
  };
  const f = await stackedDeliveryFixture(t, {
    unstack: {
      prepare: async () => {
        if (unavailable) throw new Error("provider-credential-unavailable");
        return material;
      },
      provider,
    },
  });
  const [lower, taskId] = f.tasks as [string, string];
  await f.waitTurn(lower);
  assert.equal(
    (await f.push(lower, await f.commit(lower, "lower"))).success,
    true,
  );
  await f.showPr(lower);
  await f.service.refreshGitHub();
  await f.waitTurn(taskId);
  assert.equal(
    (await f.push(taskId, await f.commit(taskId, "upper"))).success,
    true,
  );
  await f.showPr(taskId, { baseRef: f.branchOf(lower)!.branch });
  const lo = f.prs.get(`PR-${lower}`)!,
    own = f.prs.get(`PR-${taskId}`)!;
  material = {
    repositoryPath: "/repos/fixture/private",
    pr: {
      nodeId: own.nodeId,
      number: own.number,
      headRef: own.headRef,
      headSha: own.headSha,
      baseRef: own.baseRef,
    },
    stack: {
      id: 1,
      number: 1,
      baseRef: "main",
      members: [lo, own].map((p) => ({
        nodeId: p.nodeId,
        number: p.number,
        headRef: p.headRef,
        headSha: p.headSha,
        state: p.state,
      })),
    },
  };
  observed = { state: "member", material };
  return {
    ...f,
    taskId,
    lower,
    material,
    api: new OperatorApi(f.service, [f.root]),
    previewUnavailable: () => {
      unavailable = true;
    },
    partial: () => {
      partial = true;
    },
    counts: () => ({ sends, retargets }),
    failed: async () => {
      f.prs.set(lo.nodeId, { ...lo, state: "CLOSED", merged: false });
      material.stack.members[0]!.state = "CLOSED";
      await f.service.refreshGitHub();
    },
  };
}
