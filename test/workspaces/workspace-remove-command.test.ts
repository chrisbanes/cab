import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { startedOf } from "../fixtures/service-internals.js";

/** A served service whose CLI task has a repository-free workspace, finished as done. */
async function removable(t: test.TestContext) {
  const s = await startCliService(t);
  const { f, taskId, projectId } = s;
  const domain = f.service.domain();
  const binding = await f.service.provisionTask(taskId, []);
  assert.equal(binding.state, "ready", binding.reason ?? "");
  writeFileSync(join(binding.path, "evidence.txt"), "root file\n");
  const configure = (state: "done" | "open") =>
    domain.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      expectedVersion: Number(domain.task(taskId).version),
      state,
    } as never);
  const rw = (await s.issue("read-write", "remove-rw")).token;
  const ro = (await s.issue("read", "remove-ro")).token;
  const post = (body: Record<string, unknown>, token = rw) =>
    s.bearer(token, "/api/operator/commands", { method: "POST", body });
  const command = (workspaceId: string, key = randomUUID()) => ({
    type: "task.workspace.remove",
    key,
    taskId,
    workspaceId,
  });
  const operation = (key: string) =>
    s.bearer(
      rw,
      `/api/operator/operations?scope=task:${taskId}&type=task.workspace.remove&key=${key}`,
    );
  const receiptRows = () => {
    let rows: { receiptJson: string }[] = [];
    f.seedPersistedState((db) => {
      rows = db
        .prepare(
          "SELECT receiptJson FROM task_control_receipts WHERE taskId = ?",
        )
        .all(taskId) as { receiptJson: string }[];
    });
    return rows;
  };
  const lifecycle = () =>
    // biome-ignore lint/complexity/useLiteralKeys: the service's own database
    new WorkspaceLifecycleStore(f.service["cache"]!);
  const stored = () => startedOf(f.service).workspaceBindings.get(taskId);
  return {
    s,
    f,
    taskId,
    binding,
    configure,
    rw,
    ro,
    post,
    command,
    operation,
    receiptRows,
    lifecycle,
    stored,
  };
}

const message = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } })
    .error;

test("removal needs a read-write credential and accepts only the task and workspace", async (t) => {
  const w = await removable(t);
  w.configure("done");
  const body = w.command(w.binding.workspaceId);
  assert.equal((await w.post(body, w.ro)).status, 403);
  // Safety is derived by cab: callers cannot assert it, force it or pick an automatic trigger.
  for (const extra of [
    { force: true },
    { confirmed: true },
    { deliveryConfirmed: true },
    { trigger: "delivered" },
  ]) {
    const response = await w.post({ ...body, ...extra });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  const { workspaceId: _omitted, ...unfenced } = body;
  assert.equal((await w.post(unfenced)).status, 400);
  assert.equal(existsSync(w.binding.path), true);
  assert.deepEqual(w.receiptRows(), []);

  const response = await w.post(body);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.deepEqual(
    { ...receipt, operationId: undefined, removedAt: undefined },
    {
      kind: "workspace-remove",
      key: body.key,
      recorded: true,
      taskId: w.taskId,
      workspaceId: w.binding.workspaceId,
      operationId: undefined,
      removedAt: undefined,
      repositories: [],
    },
  );
  assert.equal(existsSync(w.binding.path), false);
  assert.equal(w.stored()?.state, "archived");
  const record = w.lifecycle().removal(w.binding);
  assert.equal(record?.operationId, receipt.operationId);
  assert.equal(record?.trigger, "manual");
  assert.equal(record?.completedAt, receipt.removedAt);
  // The task read carries the record and the removed workspace, never its paths.
  const read = await (
    await w.s.bearer(w.ro, `/api/operator/tasks/${w.taskId}`)
  ).json();
  assert.deepEqual(read.data.workspace, {
    workspaceId: w.binding.workspaceId,
    state: "removed",
    trim: null,
    removal: {
      workspaceId: w.binding.workspaceId,
      at: receipt.removedAt,
      trigger: "manual",
      repositories: [],
    },
  });
  assert.equal(JSON.stringify(read).includes(w.binding.path), false);
});

test("same-key requests remove once and replay the receipt across a lost reply, restart and a new workspace", async (t) => {
  const w = await removable(t);
  w.configure("done");
  const body = w.command(w.binding.workspaceId);
  const [first, second] = await Promise.all([w.post(body), w.post(body)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const receipt = await first.json();
  assert.deepEqual(await second.json(), receipt);
  assert.equal(w.lifecycle().operations(w.binding).length, 1);
  assert.equal(w.receiptRows().length, 1);

  // A reply lost after the removal: its receipt is readable without resending anything.
  const read = await (await w.operation(body.key)).json();
  assert.deepEqual(read.data, { state: "recorded", receipt });

  await w.s.restart();
  assert.deepEqual(await (await w.post(body)).json(), receipt);

  // A new workspace after removal: the old key still replays, and never touches it.
  const again = await w.f.service.provisionTask(w.taskId, []);
  assert.notEqual(again.workspaceId, w.binding.workspaceId);
  assert.deepEqual(await (await w.post(body)).json(), receipt);
  assert.equal(existsSync(again.path), true);
  assert.equal(w.stored()?.state, "ready");
  // Reusing the key for the new workspace is a conflict, and so is a new key naming the old one.
  const reused = await w.post({ ...body, workspaceId: again.workspaceId });
  assert.equal(reused.status, 409);
  const stale = await w.post(w.command(w.binding.workspaceId));
  assert.equal(stale.status, 409);
  assert.equal(
    (await message(stale)).message,
    "Workspace not removed: The task's workspace was replaced after this removal was confirmed.",
  );
  assert.equal(existsSync(again.path), true);
  assert.equal(w.receiptRows().length, 1);
});

test("a refusal names its reason, records no receipt and leaves the key free", async (t) => {
  const w = await removable(t);
  const body = w.command(w.binding.workspaceId);
  const refused = await w.post(body);
  assert.equal(refused.status, 409);
  assert.deepEqual(await message(refused), {
    code: "conflict",
    message:
      "Workspace not removed: Only a done or cancelled task's workspace can be removed.",
  });
  assert.deepEqual(w.receiptRows(), []);
  assert.deepEqual((await (await w.operation(body.key)).json()).data, {
    state: "not-recorded",
  });
  assert.equal(existsSync(w.binding.path), true);
  // Nothing was deleted, so the same request may run once the task is done.
  w.configure("done");
  assert.equal((await w.post(body)).status, 200);
  assert.equal(existsSync(w.binding.path), false);
});

test("a held removal reports its operation, redacted, and never runs again", async (t) => {
  const w = await removable(t);
  w.configure("done");
  const body = w.command(w.binding.workspaceId);
  const operationId = randomUUID();
  const owner = { taskId: w.taskId, workspaceId: w.binding.workspaceId };
  // A removal that started deleting, then stopped on a reason naming the workspace's path.
  w.f.seedPersistedState((db) => {
    const lifecycle = new WorkspaceLifecycleStore(db as never);
    lifecycle.beginOperation(owner, {
      operationId,
      kind: "remove",
      trigger: "manual",
      startedAt: Date.now(),
    });
    lifecycle.startEffect(owner, operationId, {
      effectId: randomUUID(),
      target: { kind: "root" },
      startedAt: Date.now(),
    });
    lifecycle.holdOperation(
      owner,
      operationId,
      `Could not delete ${w.binding.path}/evidence.txt`,
    );
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason, ownerToken) VALUES (?, 'Workspace removal', ?)",
    ).run(w.taskId, operationId);
  });
  startedOf(w.f.service).state.reserveWorkspaceRemoval(body, operationId);
  await w.s.restart();
  const held = await w.post(body);
  assert.equal(held.status, 409);
  const { message: text } = await message(held);
  assert.match(text, new RegExp(`^Workspace removal ${operationId} stopped`));
  assert.equal(text.includes(w.binding.path), false, text);
  assert.equal(existsSync(join(w.binding.path, "evidence.txt")), true);
  assert.equal(w.lifecycle().operations(w.binding).length, 1);
  assert.deepEqual((await (await w.operation(body.key)).json()).data, {
    state: "not-recorded",
  });
});

test("a request interrupted before its operation began loses its hold at restart and removes once", async (t) => {
  for (const retry of ["same key", "new key"] as const) {
    const w = await removable(t);
    w.configure("done");
    const body = w.command(w.binding.workspaceId);
    const operationId = randomUUID();
    // Reserved and holding, then stopped during planning: no maintenance operation exists.
    startedOf(w.f.service).state.reserveWorkspaceRemoval(body, operationId);
    w.f.seedPersistedState((db) =>
      db
        .prepare(
          "INSERT INTO task_archival_holds (taskId, reason, ownerToken) VALUES (?, 'Workspace removal', ?)",
        )
        .run(w.taskId, operationId),
    );
    await w.s.restart();
    const response = await w.post(
      retry === "same key" ? body : w.command(w.binding.workspaceId),
    );
    assert.equal(response.status, 200, retry);
    assert.equal(existsSync(w.binding.path), false, retry);
    assert.deepEqual(
      w
        .lifecycle()
        .operations(w.binding)
        .map((o) => [o.kind, o.state]),
      [["remove", "completed"]],
      retry,
    );
  }
});

test("a reserved request whose removal completed records its receipt on replay", async (t) => {
  const w = await removable(t);
  w.configure("done");
  const body = w.command(w.binding.workspaceId);
  const operationId = randomUUID();
  startedOf(w.f.service).state.reserveWorkspaceRemoval(body, operationId);
  // The removal finished, but the receipt was never written (a crash before it).
  const removed = await w.f.service.removeTaskWorkspace(w.taskId, "manual", {
    workspaceId: w.binding.workspaceId,
    operationId,
  });
  assert.equal(removed.outcome, "cleaned");
  assert.equal(
    JSON.parse(w.receiptRows()[0]!.receiptJson).kind,
    "workspace-remove-pending",
  );
  const response = await w.post(body);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.operationId, operationId);
  assert.equal(
    receipt.removedAt,
    w.lifecycle().removal(w.binding)?.completedAt,
  );
  assert.deepEqual(JSON.parse(w.receiptRows()[0]!.receiptJson), receipt);
  assert.equal(w.lifecycle().operations(w.binding).length, 1);
});
