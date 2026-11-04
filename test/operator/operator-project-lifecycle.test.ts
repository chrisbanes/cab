import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  projectSchema,
  operatorCommandSchema,
} from "../../src/operator/contracts.js";
import { projectDeletePreviewSchema } from "../../src/operator/project-lifecycle-contracts.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { archivedProjectFixture } from "../fixtures/archived-project.js";

const code = (status: number) => (error: unknown) =>
  error instanceof OperatorApiError && error.status === status;

test("public project lifecycle routes distinguish default active lists, archived direct reads and paused restoration", async (t) => {
  const f = await archivedProjectFixture(t);
  const api = new OperatorApi(f.service, [f.fixture.directory]);
  assert.equal(
    (await api.readWorkspace()).data.projects.some((p) => p.id === f.projectId),
    false,
  );
  assert.equal(
    (await api.readWorkspace(true)).data.projects.find(
      (p) => p.id === f.projectId,
    )?.archived,
    true,
  );
  const archived = projectSchema.parse(await api.readProject(f.projectId)).data;
  assert.equal(archived.state, "live");
  if (archived.state !== "live") throw Error("expected archived history");
  assert.equal(archived.project.archived, true);
  assert.ok(archived.tasks.some((task) => task.id === f.taskId));
  const task = await api.readTask(f.taskId);
  assert.equal(task.data.project?.archived, true);
  assert.equal(
    task.data.assignments.find((a) => a.assignmentId === f.assignmentId)
      ?.readOnly,
    true,
  );
  const restore = {
    type: "project.restore",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: archived.project.version,
  };
  const receipt = await api.execute(restore);
  assert.equal(receipt.kind, "configuration");
  if (
    receipt.kind !== "configuration" ||
    receipt.result.commandType !== "project.restore"
  )
    throw Error("wrong receipt");
  assert.equal(receipt.result.archived, false);
  assert.equal(receipt.result.paused, true);
  assert.deepEqual(await api.execute(restore), receipt);
  const active = (await api.readProject(f.projectId)).data;
  if (active.state !== "live") throw Error("expected restored project");
  const command = {
    type: "project.archive",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: active.project.version,
  };
  const archivedReceipt = await api.execute(command);
  assert.deepEqual(
    (
      await api.readOperation(
        new URLSearchParams({
          scope: `project:${f.projectId}`,
          type: "project.archive",
          key: command.key,
        }),
      )
    ).data,
    { state: "recorded", receipt: archivedReceipt },
  );
});

test("public delete preview and tombstone never serialize cleanup bindings; deleted operation lookup keeps its original receipt", async (t) => {
  const f = await archivedProjectFixture(t);
  const api = new OperatorApi(f.service, [f.fixture.directory]);
  const preview = projectDeletePreviewSchema.parse(
    await api.readProjectDeletePreview(f.projectId),
  ).data;
  assert.equal(preview.archived, true);
  assert.equal(preview.forceDiscard, true);
  assert.equal(preview.outsideDiscovery, "recorded-identities-only");
  for (const worktree of preview.worktrees)
    assert.deepEqual(Object.keys(worktree).sort(), [
      "dirty",
      "inspection",
      "kind",
      "unpushed",
    ]);
  const command = {
    type: "project.delete",
    key: randomUUID(),
    projectId: f.projectId,
    confirmationName: preview.name,
    expectedVersion: preview.version,
    previewDigest: preview.previewDigest,
  };
  const receipt = await api.execute(command);
  assert.equal(receipt.kind, "configuration");
  if (
    receipt.kind !== "configuration" ||
    receipt.result.commandType !== "project.delete"
  )
    throw Error("wrong receipt");
  assert.deepEqual(Object.keys(receipt.result).sort(), [
    "commandType",
    "deletedAt",
    "resourceId",
  ]);
  const deleted = projectSchema.parse(await api.readProject(f.projectId)).data;
  assert.equal(deleted.state, "deleted");
  assert.deepEqual(await api.execute(command), receipt);
  const recorded = await new OperatorApi(f.service, [
    f.fixture.directory,
  ]).readOperation(
    new URLSearchParams({
      scope: `project:${f.projectId}`,
      type: "project.delete",
      key: command.key,
    }),
  );
  assert.deepEqual(recorded.data, { state: "recorded", receipt });
  const text = JSON.stringify(deleted);
  for (const privateIdentity of [
    f.fixture.directory,
    f.workId,
    f.assignmentId,
    "cleanupJson",
    "commandKey",
    "payloadHash",
    "instructions",
  ])
    assert.equal(text.includes(privateIdentity), false, privateIdentity);
  await assert.rejects(
    api.execute({ ...command, key: randomUUID() }),
    code(409),
  );
  await assert.rejects(
    api.readProjectDeletePreview(f.projectId),
    (error) => error instanceof OperatorApiError,
  );
});

test("lifecycle commands validate exact confirmation and closed JSON input at runtime", () => {
  const base = {
    type: "project.delete",
    key: randomUUID(),
    projectId: randomUUID(),
    expectedVersion: 1,
    confirmationName: "Exact name",
    previewDigest: "a".repeat(64),
  };
  assert.equal(operatorCommandSchema.safeParse(base).success, true);
  for (const patch of [
    { force: true },
    { yes: true },
    { expectedVersion: 0 },
    { previewDigest: "unknown" },
    { confirmationName: "" },
  ])
    assert.equal(
      operatorCommandSchema.safeParse({ ...base, ...patch }).success,
      false,
    );
});
