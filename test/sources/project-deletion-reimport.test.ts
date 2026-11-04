import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { IssueSnapshot } from "../../src/core/github-source.js";
import { projectDeletionFixture } from "../fixtures/project-deletion.js";

test("deleting the owner releases shared selections/placement and normal sync reimports into B", async (t) => {
  const f = await projectDeletionFixture(t, false),
    envKey = "CAB_PROJECT_DELETION_FIXTURE",
    prior = process.env[envKey];
  process.env[envKey] = "disposable-credential-value";
  t.after(() => {
    if (prior === undefined) delete process.env[envKey];
    else process.env[envKey] = prior;
  });
  for (const projectId of [f.projectId, f.projectB]) {
    f.domain.execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.githubConfiguration(projectId).version),
      credentialRef: `env:${envKey}`,
      selections: [
        {
          id: "shared",
          kind: "repository",
          repositoryId: "R_shared",
          owner: "fixture",
          name: "shared",
        },
      ],
      readiness: null,
    });
    f.domain.execute({
      type: "github.activate",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(f.domain.githubConfiguration(projectId).version),
      selectionId: "shared",
    });
  }
  const issue: IssueSnapshot = {
    providerInstance: "github.com",
    nodeId: "external-shared",
    repositoryId: "R_shared",
    repositoryName: "fixture/shared",
    number: 1,
    title: "Shared issue",
    body: "Public outcome",
    state: "open",
    labels: [],
    projectFields: [],
  };
  const source = f.components.githubSources;
  assert.ok(
    source.reconcileSelection(f.projectId, "shared", {
      complete: true,
      issues: [issue],
      reason: null,
    }),
  );
  assert.ok(
    source.reconcileSelection(f.projectB, "shared", {
      complete: true,
      issues: [issue],
      reason: null,
    }),
  );
  const oldTask = String(source.issue(issue.nodeId)!.taskId);
  f.db
    .prepare(
      "INSERT OR REPLACE INTO source_placement_decisions (provider,instance,externalId,projectId) VALUES ('github','github.com',?,?)",
    )
    .run(issue.nodeId, f.projectId);
  f.freeze();
  // Explicit provider-global exceptions are not live cab ownership roots.
  f.db
    .prepare(
      "INSERT OR REPLACE INTO source_closures (provider,instance,externalId,operationId,closerChangeRequestId,snapshotJson,closedEventId) VALUES ('github','github.com',?,?,NULL,?,NULL)",
    )
    .run(
      issue.nodeId,
      f.workId,
      JSON.stringify({ retainedOpaqueProjectId: f.projectId }),
    );
  const globals = () =>
    JSON.stringify([
      f.db.prepare("SELECT * FROM source_closures").all(),
      f.db.prepare("SELECT * FROM external_item_status").all(),
      f.db.prepare("SELECT * FROM source_field_names").all(),
    ]);
  const before = globals(),
    preview = await f.service.projectDeletionPreview(f.projectId);
  assert.deepEqual(preview.affectedProjects, [
    { projectId: f.projectB, name: "Surviving" },
  ]);
  await f.service.deleteProject({
    type: "project.delete",
    actor: "operator",
    key: randomUUID(),
    projectId: f.projectId,
    expectedVersion: preview.version,
    confirmationName: preview.name,
    previewDigest: preview.previewDigest,
  });
  assert.equal(globals(), before);
  assert.equal(source.issue(issue.nodeId), undefined);
  assert.deepEqual(source.memberships(issue.nodeId), []);
  assert.equal(
    f.db
      .prepare("SELECT 1 FROM source_placement_decisions WHERE externalId=?")
      .get(issue.nodeId),
    undefined,
  );
  assert.ok(
    source.reconcileSelection(f.projectB, "shared", {
      complete: true,
      issues: [issue],
      reason: null,
    }),
  );
  const imported = source.issue(issue.nodeId);
  assert.ok(imported);
  assert.notEqual(imported.taskId, oldTask);
  assert.equal(f.domain.task(String(imported.taskId)).projectId, f.projectB);
  assert.equal(f.fixture.runtime.turns, 0);
});
