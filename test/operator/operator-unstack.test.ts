import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OperatorApiError } from "../../src/standalone/operator-api.js";
import { operatorCommandSchema } from "../../src/operator/contracts.js";
import {
  unstackReadSchema,
  unstackReceiptSchema,
} from "../../src/operator/unstack-contracts.js";
import { operatorUnstackFixture } from "../fixtures/operator-unstack.js";

test("Unstack API validates the exact filtered preview, typed receipt and read-only original operation lookup", async (t) => {
  const f = await operatorUnstackFixture(t),
    view = unstackReadSchema.parse(await f.api.readUnstack(f.taskId));
  assert.ok(view.data.preview);
  const p = view.data.preview,
    c = {
      type: "task.unstack" as const,
      key: randomUUID(),
      taskId: f.taskId,
      expectedVersion: p.expectedVersion,
      materialHash: p.materialHash,
    };
  assert.throws(() =>
    operatorCommandSchema.parse({ ...c, materialHash: "wrong" }),
  );
  await assert.rejects(
    f.api.execute({ ...c, materialHash: "a".repeat(64) }),
    (e) => e instanceof OperatorApiError && e.status === 409,
  );
  assert.deepEqual(f.counts(), { sends: 0, retargets: 0 });
  const receipt = unstackReceiptSchema.parse(await f.api.execute(c));
  assert.equal(receipt.phase, "confirmed");
  const lookup = new URLSearchParams({
    scope: `task:${f.taskId}`,
    type: c.type,
    key: c.key,
  });
  assert.deepEqual((await f.api.readOperation(lookup)).data, {
    state: "recorded",
    receipt,
  });
  assert.deepEqual(f.counts(), { sends: 1, retargets: 1 });
  assert.equal((await f.api.readUnstack(f.taskId)).data.preview, null);
});

test("partial result remains pending, status/receipt GET never resends and a replacement key is refused", async (t) => {
  const f = await operatorUnstackFixture(t),
    p = (await f.api.readUnstack(f.taskId)).data.preview!;
  f.partial();
  const c = {
    type: "task.unstack",
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: p.expectedVersion,
    materialHash: p.materialHash,
  };
  const receipt = unstackReceiptSchema.parse(await f.api.execute(c));
  assert.equal(receipt.phase, "unstack-attempting");
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (await f.api.readUnstack(f.taskId)).data.unavailable,
      "pending",
    );
    await f.api.readOperation(
      new URLSearchParams({
        scope: `task:${f.taskId}`,
        type: c.type,
        key: c.key,
      }),
    );
  }
  await assert.rejects(f.api.execute({ ...c, key: randomUUID() }));
  assert.deepEqual(f.counts(), { sends: 1, retargets: 0 });
});

test("excluded member material withholds preview and receipts; archived state never offers writes", async (t) => {
  const f = await operatorUnstackFixture(t),
    privateNode = f.material.stack.members[0]!.nodeId;
  f.readDb((db) =>
    db
      .prepare("INSERT INTO deleted_project_redaction_values VALUES (?)")
      .run(privateNode),
  );
  const view = await f.api.readUnstack(f.taskId);
  assert.equal(view.data.preview, null);
  assert.equal(view.data.unavailable, "unproved");
  assert.equal(JSON.stringify(view).includes(privateNode), false);
  f.readDb((db) =>
    db
      .prepare(
        "UPDATE domain_projects SET archived=1,version=version+1 WHERE id=?",
      )
      .run(f.projectId),
  );
  const archived = await f.api.readUnstack(f.taskId);
  assert.equal(archived.data.readOnly, true);
  assert.equal(archived.data.cancelAvailable, false);
  assert.deepEqual(f.counts(), { sends: 0, retargets: 0 });
});

test("failed blocker exposes separate Cancel with durable typed lookup and no Stop/provider closure", async (t) => {
  const f = await operatorUnstackFixture(t);
  await f.failed();
  assert.equal((await f.api.readUnstack(f.taskId)).data.cancelAvailable, true);
  const c = {
    type: "task.cancel",
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: Number(f.service.domain().task(f.taskId).version),
  };
  const receipt = await f.api.execute(c);
  assert.equal(receipt.kind, "task-cancel");
  assert.equal(
    (await f.api.readUnstack(f.taskId)).data.cancelOperation?.key,
    c.key,
  );
  assert.equal(f.service.domain().task(f.taskId).state, "cancelled");
  const lookup = await f.api.readOperation(
    new URLSearchParams({
      scope: `task:${f.taskId}`,
      type: c.type,
      key: c.key,
    }),
  );
  assert.equal(lookup.data.state, "recorded");
  assert.deepEqual(f.counts(), { sends: 0, retargets: 0 });
});

test("original confirmed Unstack receipt survives archive as a filtered read and terminal replay without provider calls", async (t) => {
  const f = await operatorUnstackFixture(t),
    p = (await f.api.readUnstack(f.taskId)).data.preview!;
  const c = {
    type: "task.unstack",
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: p.expectedVersion,
    materialHash: p.materialHash,
  };
  const receipt = await f.api.execute(c);
  f.readDb((db) =>
    db
      .prepare(
        "UPDATE domain_projects SET archived=1,version=version+1 WHERE id=?",
      )
      .run(f.projectId),
  );
  assert.equal((await f.api.readUnstack(f.taskId)).data.readOnly, true);
  const read = await f.api.readOperation(
    new URLSearchParams({
      scope: `task:${f.taskId}`,
      type: c.type,
      key: c.key,
    }),
  );
  assert.deepEqual(read.data, { state: "recorded", receipt });
  assert.deepEqual(await f.api.execute(c), receipt);
  assert.deepEqual(f.counts(), { sends: 1, retargets: 1 });
});

test("excluded receipt identity never leaks through status or operation lookup", async (t) => {
  const f = await operatorUnstackFixture(t),
    p = (await f.api.readUnstack(f.taskId)).data.preview!;
  const c = {
    type: "task.unstack",
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: p.expectedVersion,
    materialHash: p.materialHash,
  };
  await f.api.execute(c);
  f.readDb((db) =>
    db
      .prepare("INSERT INTO deleted_project_redaction_values VALUES (?)")
      .run(f.material.stack.members[0]!.nodeId),
  );
  await assert.rejects(
    f.api.readOperation(
      new URLSearchParams({
        scope: `task:${f.taskId}`,
        type: c.type,
        key: c.key,
      }),
    ),
    (e) => e instanceof OperatorApiError && e.status === 503,
  );
  await assert.rejects(
    f.api.readUnstack(f.taskId),
    (e) => e instanceof OperatorApiError && e.status === 503,
  );
  assert.deepEqual(f.counts(), { sends: 1, retargets: 1 });
});

test("provider preview unavailability preserves independent failed-blocker Cancel and never authorizes Unstack", async (t) => {
  const f = await operatorUnstackFixture(t);
  await f.failed();
  f.previewUnavailable();
  const view = await f.api.readUnstack(f.taskId);
  assert.equal(view.data.preview, null);
  assert.equal(view.data.available, false);
  assert.equal(view.data.cancelAvailable, true);
  const c = {
    type: "task.cancel",
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: Number(f.service.domain().task(f.taskId).version),
  };
  assert.equal((await f.api.execute(c)).kind, "task-cancel");
  assert.deepEqual(f.counts(), { sends: 0, retargets: 0 });
});

test("malformed persisted Unstack material remains a visible read fault and never becomes an available replacement command", async (t) => {
  const f = await operatorUnstackFixture(t),
    p = (await f.api.readUnstack(f.taskId)).data.preview!;
  f.partial();
  const c = {
    type: "task.unstack",
    key: randomUUID(),
    taskId: f.taskId,
    expectedVersion: p.expectedVersion,
    materialHash: p.materialHash,
  };
  await f.api.execute(c);
  let original = "";
  f.readDb((db) => {
    original = String(
      (
        db
          .prepare(
            "SELECT recordJson FROM delivery_unstack_operations WHERE operationId=?",
          )
          .get(c.key) as { recordJson: string }
      ).recordJson,
    );
    db.prepare(
      "UPDATE delivery_unstack_operations SET recordJson='{}' WHERE operationId=?",
    ).run(c.key);
  });
  try {
    await assert.rejects(f.api.readUnstack(f.taskId));
    await assert.rejects(
      f.api.readOperation(
        new URLSearchParams({
          scope: `task:${f.taskId}`,
          type: c.type,
          key: c.key,
        }),
      ),
    );
    await assert.rejects(f.api.execute({ ...c, key: randomUUID() }));
    assert.deepEqual(f.counts(), { sends: 1, retargets: 0 });
  } finally {
    f.readDb((db) =>
      db
        .prepare(
          "UPDATE delivery_unstack_operations SET recordJson=? WHERE operationId=?",
        )
        .run(original, c.key),
    );
  }
});
