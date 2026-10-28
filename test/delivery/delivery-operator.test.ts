import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainStore } from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";
import { LocalOperatorUi } from "../../src/standalone/operator.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { deliveryFixture } from "../fixtures/delivery-fixture.js";

test("operator policy form exposes current version and grants without credential reference names", async () => {
  const db = new DatabaseSync(":memory:");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID();
  try {
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "P",
      leadProfileId: null,
    });
    const ui = new LocalOperatorUi(domain);
    assert.match(ui.project(projectId), /data-command="delivery.configure"/);
    await ui.submit({
      type: "delivery.configure",
      key: randomUUID(),
      projectId,
      expectedVersion: "1",
      mode: "reviewable-pr",
      credentialRef: "env:PRIVATE_DELIVERY_KEY",
      branchPrefix: "team/",
      grants:
        '[{"action":"issue.comment","repositoryId":"R1","mode":"approval"}]',
      requiredChecks: "[]",
    });
    assert.doesNotMatch(ui.project(projectId), /PRIVATE_DELIVERY_KEY/);
    assert.match(ui.project(projectId), /Credential reference configured/);
    assert.match(
      ui.project(projectId),
      /name="branchPrefix"[^>]*value="team\/"/,
    );
  } finally {
    db.close();
  }
});

type Fixture = Awaited<ReturnType<typeof deliveryFixture>>;
const conflict = (error: unknown) =>
  error instanceof OperatorApiError &&
  error.status === 409 &&
  error.code === "conflict";

async function registered(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await deliveryFixture();
  t.after(() => f.close());
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
  return { f, api: new OperatorApi(f.service, [f.root]) };
}

/** A settlement bound to what the task read currently shows, with any field overridden. */
async function settlement(
  f: Fixture,
  api: OperatorApi,
  over: Partial<{
    expectedTaskVersion: number;
    expectedDeliveryRevision: number;
    expectedPolicyVersion: number;
    expectedHeadSha: string;
    decision: "accepted" | "closed";
  }> = {},
) {
  const read = (await api.readTask(f.taskId)).data;
  const binding = read.delivery?.binding;
  assert.ok(read.delivery && binding);
  return {
    type: "delivery.settle" as const,
    key: randomUUID(),
    taskId: f.taskId,
    expectedTaskVersion: read.task.version,
    expectedDeliveryRevision: binding.revision,
    expectedPolicyVersion: read.delivery.policyVersion,
    expectedHeadSha: binding.headSha,
    decision: "accepted" as const,
    ...over,
  };
}

const settled = async (f: Fixture, api: OperatorApi) =>
  (await api.readTask(f.taskId)).data.delivery?.binding?.settlement;

async function refresh(f: Fixture, api: OperatorApi) {
  await api.execute({
    type: "delivery.refresh",
    key: randomUUID(),
    taskId: f.taskId,
  });
}

test("delivery.settle accepts the shown head once, replays by key and refuses changed material", async (t) => {
  const { f, api } = await registered(t);
  const before = (await api.readTask(f.taskId)).data.delivery?.binding;
  assert.ok(before);
  assert.equal(before.settlement, null);
  const current = await settlement(f, api);
  for (const stale of [
    { expectedHeadSha: "4".repeat(40) },
    { expectedDeliveryRevision: before.revision + 1 },
    { expectedPolicyVersion: current.expectedPolicyVersion + 1 },
    { expectedTaskVersion: current.expectedTaskVersion + 1 },
  ])
    await assert.rejects(
      api.execute({ ...current, key: randomUUID(), ...stale }),
      conflict,
    );
  assert.equal(await settled(f, api), null);
  assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);

  const receipt = await api.execute(current);
  assert.deepEqual(receipt, {
    kind: "delivery-settlement",
    key: current.key,
    recorded: true,
    taskId: f.taskId,
    decision: "accepted",
    revision: before.revision + 1,
  });
  assert.deepEqual(await settled(f, api), {
    decision: "accepted",
    headSha: before.headSha,
  });
  assert.deepEqual(await api.execute(current), receipt);
  // A reused key never records different material.
  await assert.rejects(
    api.execute({ ...current, decision: "closed" }),
    conflict,
  );
  assert.equal((await settled(f, api))?.decision, "accepted");
  assert.equal(f.domain.task(f.taskId).state, "open");
});

test("delivery.settle as closed records the outcome without accepting the head", async (t) => {
  const { f, api } = await registered(t);
  const command = await settlement(f, api, { decision: "closed" });
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "delivery-settlement");
  assert.equal(
    receipt.kind === "delivery-settlement" && receipt.decision,
    "closed",
  );
  assert.equal((await settled(f, api))?.decision, "closed");
  assert.deepEqual(await api.execute(command), receipt);
});

test("a draft or closed PR cannot be accepted but its outcome can still be closed", async (t) => {
  const { f, api } = await registered(t);
  f.setPr({ ...f.getPr(), draft: true });
  await refresh(f, api);
  assert.equal(
    (await api.readTask(f.taskId)).data.delivery?.binding?.draft,
    true,
  );
  await assert.rejects(api.execute(await settlement(f, api)), conflict);
  f.setPr({ ...f.getPr(), draft: false, state: "CLOSED" });
  await refresh(f, api);
  assert.equal(
    (await api.readTask(f.taskId)).data.delivery?.binding?.state,
    "CLOSED",
  );
  await assert.rejects(api.execute(await settlement(f, api)), conflict);
  assert.equal(await settled(f, api), null);
  await api.execute(await settlement(f, api, { decision: "closed" }));
  assert.equal((await settled(f, api))?.decision, "closed");
});

test("a branch pushed outside cab cannot be accepted", async (t) => {
  const { f, api } = await registered(t);
  const db = new DatabaseSync(join(f.root, "data", "standalone.sqlite"));
  try {
    db.prepare(
      "INSERT INTO delivery_task_branches (taskId,repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt) VALUES (?,?,?,?,?,1)",
    ).run(f.taskId, "R1", f.getPr().headRef, "9".repeat(40), "8".repeat(40));
  } finally {
    db.close();
  }
  assert.equal(
    (await api.readTask(f.taskId)).data.delivery?.branches[0]?.outsideHeadSha,
    "8".repeat(40),
  );
  await assert.rejects(api.execute(await settlement(f, api)), conflict);
  assert.equal(await settled(f, api), null);
});

test("an externally changed head or a provider outage settles nothing and shows feedback as literal text", async (t) => {
  const { f, api } = await registered(t);
  const stale = await settlement(f, api);
  f.setPr({
    ...f.getPr(),
    headSha: "3".repeat(40),
    feedback: [
      {
        kind: "comment",
        nodeId: "C1",
        author: "U1",
        updatedAt: "2026-10-01T12:00:00Z",
        state: "COMMENTED",
        body: "<script>hostile()</script>",
        commitSha: null,
      },
    ],
  });
  await assert.rejects(api.execute(stale), conflict);
  assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
  assert.equal(f.domain.task(f.taskId).state, "open");
  // The rejected command still leaves the changed observation to review.
  const binding = (await api.readTask(f.taskId)).data.delivery?.binding;
  assert.equal(binding?.headSha, "3".repeat(40));
  assert.equal(binding?.feedback[0]?.body, "<script>hostile()</script>");
  const fresh = await settlement(f, api);
  f.failReads(true);
  await assert.rejects(api.execute(fresh));
  assert.equal(f.service.delivery().delivery(f.taskId)?.settlement, null);
});
