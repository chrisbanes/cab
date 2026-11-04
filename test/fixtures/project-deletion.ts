import { ExecutionDiagnosticsStore } from "../../src/standalone/execution-diagnostics.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { transaction } from "../../src/core/store.js";
import { ProjectDeletion } from "../../src/standalone/project-deletion.js";
import {
  captureDeletionOwnership,
  type ProjectOwnership,
} from "../../src/standalone/project-deletion-ownership.js";
import { projectDeletionInventory } from "../../src/standalone/project-deletion-inventory.js";
import { prepareDeletionPrivateInputs } from "../../src/standalone/project-deletion-private.js";
import { archivedProjectFixture } from "./archived-project.js";

export const deletionCanary = "removed-private-project-instruction";
export function fixtureUuid(label: string) {
  const h = createHash("sha256").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export async function projectDeletionFixture(t: TestContext, freeze = true) {
  const f = await archivedProjectFixture(t, false),
    projectB = randomUUID(),
    taskB = randomUUID(),
    blockerB = randomUUID(),
    assignmentB = randomUUID(),
    workB = randomUUID();
  f.domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: projectB,
    name: "Surviving",
    leadProfileId: null,
    candidateProfileIds: [f.profileId],
  });
  f.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: projectB,
    taskId: taskB,
    title: "Surviving task",
    outcome: "Preserve",
    ready: false,
  });
  f.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: projectB,
    taskId: blockerB,
    title: "Surviving blocker",
    outcome: "Preserve",
    ready: false,
  });
  f.domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: projectB,
    taskId: taskB,
    assignmentId: assignmentB,
    profileId: f.profileId,
    brief: "Shared profile",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  f.db
    .prepare("UPDATE domain_assignments SET state='completed' WHERE id=?")
    .run(assignmentB);
  f.components.schedulerStore.ensure({
    requestKey: randomUUID(),
    workId: workB,
    kind: "direct",
    taskId: taskB,
    projectId: projectB,
    assignmentId: null,
    taskVersion: 1,
    assignmentVersion: null,
    instructionsRevision: null,
    profileRevision: null,
    prompt: "Surviving history",
    workspace: null,
    previousWorkId: null,
  });
  const intentB = f.components.state.create(
    workB,
    "Surviving history",
    f.fixture.directory,
  );
  f.db
    .prepare("UPDATE execution_intents SET state='completed' WHERE workId=?")
    .run(workB);
  f.db
    .prepare("UPDATE turn_requests SET state='completed' WHERE workId=?")
    .run(workB);
  f.components.coordination.postTaskComment({
    actor: "operator",
    key: randomUUID(),
    taskId: taskB,
    body: deletionCanary,
    recipients: [],
  });
  f.domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: Number(f.domain.project(f.projectId).version),
    instructions: deletionCanary,
  });
  const diagnostics = new ExecutionDiagnosticsStore(f.db);
  for (const [workId, taskId, projectId, assignmentId] of [
    [f.workId, f.taskId, f.projectId, f.assignmentId],
    [workB, taskB, projectB, assignmentB],
  ]) {
    diagnostics.begin({
      workId: workId!,
      taskId: taskId!,
      projectId: projectId!,
      assignmentId: assignmentId!,
      assignmentVersion: 1,
      instructionsRevision: 1,
      profileRevision: 1,
      conversationRevision: 1,
      harness: "codex",
      mode: "enhanced",
      eventSource: "supported",
    });
    diagnostics.record(
      workId!,
      "runtime",
      "retained",
      "info",
      undefined,
      { owner: taskId, body: "Retained diagnostic" },
      [],
    );
    diagnostics.finish(workId!);
  }
  if (freeze) f.freeze();
  const roots = {
    task: join(f.fixture.directory, "data", "workspaces"),
    drafting: join(f.fixture.directory, "data", "drafting-workspaces"),
  };
  const deletion = (
    overrides: Partial<ConstructorParameters<typeof ProjectDeletion>[1]> = {},
  ) =>
    new ProjectDeletion(f.db, {
      roots,
      drain: (id) => f.domain.projectArchiveBlockersWithinTransaction(id),
      privateInputs: (owner, paths) =>
        prepareDeletionPrivateInputs(f.db, owner, paths, {
          extra: () => [],
          resolveReference: async () => {
            throw new Error("No credential resolution expected");
          },
        }),
      ...overrides,
    });
  const command = async () => {
    const preview = await deletion().preview(f.projectId);
    return {
      type: "project.delete" as const,
      actor: "operator" as const,
      key: randomUUID(),
      projectId: f.projectId,
      expectedVersion: preview.version,
      confirmationName: preview.name,
      previewDigest: preview.previewDigest,
    };
  };
  return {
    ...f,
    projectB,
    taskB,
    blockerB,
    assignmentB,
    workB,
    intentB,
    roots,
    deletion,
    command,
  };
}
export function databaseSnapshot(db: DatabaseSync) {
  return JSON.stringify(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => [
        row.name,
        db.prepare(`SELECT * FROM ${String(row.name)} ORDER BY rowid`).all(),
      ]),
  );
}
export function preservedSnapshot(db: DatabaseSync, ownerB: ProjectOwnership) {
  const keep = Object.entries(projectDeletionInventory).filter(
    ([name, spec]) =>
      spec.ownership.startsWith("KEEP") &&
      !["deleted_project_redaction_values", "project_tombstones"].includes(
        name,
      ),
  );
  return JSON.stringify({
    global: keep.map(([name]) => [
      name,
      db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    ]),
    owned: ownerB.rows,
  });
}
export function capture(db: DatabaseSync, projectId: string) {
  return transaction(db, () => captureDeletionOwnership(db, projectId));
}

/** Independent reference audit: exact structured identifiers, never text substring matching. */
export function assertNoDeletedReferences(
  db: DatabaseSync,
  owner: ProjectOwnership,
) {
  const ids = new Set(
    Object.entries(owner.parameters).flatMap(([key, value]) =>
      key === "projectId"
        ? [value as string]
        : Array.isArray(value) && value.every((v) => typeof v === "string")
          ? (value as string[])
          : [],
    ),
  );
  const identifierColumns = new Set([
    "projectId",
    "taskId",
    "blockerTaskId",
    "assignmentId",
    "requesterAssignmentId",
    "recipientAssignmentId",
    "requestingAssignmentId",
    "targetAssignmentId",
    "leadAssignmentId",
    "workId",
    "previousWorkId",
    "priorWorkId",
    "leadWorkId",
    "requestingWorkId",
    "deliveryWorkId",
    "registeredWorkId",
    "missedWorkId",
    "repairWorkId",
    "oldWorkId",
    "newWorkId",
    "chainId",
    "failedWorkId",
    "retryWorkId",
    "interruptedWorkId",
    "requeueWorkId",
    "refusedWorkId",
    "intentId",
    "threadId",
    "eventId",
    "operatorEventId",
    "batchId",
    "interactionId",
    "commentId",
    "operationId",
    "reviewId",
    "groupId",
    "submittedContextId",
    "draftId",
    "anchorId",
    "resultId",
  ]);
  const opaqueFields = new Set([
    "source_closures.operationId",
    "source_closures.closedEventId",
    "source_closures.snapshotJson",
    "source_closure_supersessions.operationId",
    "operator_push_alerts.key",
  ]);
  const jsonFields = new Set([
    "result",
    "material",
    "payloadMaterial",
    "receiptJson",
    "recordJson",
    "responseJson",
    "requestJson",
    "draftJson",
    "payloadJson",
    "identityJson",
    "proofMaterial",
    "batchMaterial",
    "operatorEventPayload",
    "snapshotJson",
    "manifestJson",
    "provenanceJson",
    "anchorIdsJson",
  ]);
  const visit = (value: unknown, path: string) => {
    if (value === null || typeof value !== "object") {
      if (typeof value === "string")
        assert.equal(ids.has(value), false, `unapproved JSON owner at ${path}`);
      return;
    }
    for (const [key, item] of Object.entries(value))
      visit(item, `${path}.${key}`);
  };
  for (const [table, spec] of Object.entries(projectDeletionInventory)) {
    if (
      ["project_tombstones", "deleted_project_redaction_values"].includes(table)
    )
      continue;
    for (const row of db.prepare(`SELECT * FROM ${table}`).all())
      for (const column of spec.columns) {
        const value = row[column],
          path = `${table}.${column}`;
        if (opaqueFields.has(path)) continue;
        if (identifierColumns.has(column) && typeof value === "string")
          assert.equal(ids.has(value), false, path);
        if (jsonFields.has(column) && typeof value === "string")
          visit(JSON.parse(value), path);
        if (column === "scope" && table === "command_receipts")
          assert.notEqual(value, owner.parameters.projectId);
      }
  }
}
