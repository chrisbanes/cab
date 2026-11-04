import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DomainCommand } from "../../src/core/domain.js";
import { ProjectArchivedError } from "../../src/core/project-lifecycle.js";
import { archivedProjectFixture } from "../fixtures/archived-project.js";

/** Schema-valid commands: the archived admission guard precedes target-specific mutation. */
function commands(
  projectId: string,
  taskId: string,
  assignmentId: string,
  blockerTaskId: string,
  profileId: string,
): DomainCommand[] {
  const base = { actor: "operator" as const, key: randomUUID(), projectId };
  return [
    {
      actor: "operator",
      key: randomUUID(),
      type: "capacity.configure",
      globalLimit: 2,
      projectOverrides: { [projectId]: 1 },
    },
    {
      ...base,
      type: "task.create",
      taskId: randomUUID(),
      title: "New",
      outcome: "New",
      ready: false,
    },
    {
      ...base,
      type: "task.configure",
      taskId,
      expectedVersion: 1,
      ready: true,
    },
    { ...base, type: "project.configure", expectedVersion: 2, paused: false },
    {
      ...base,
      type: "project.configure",
      expectedVersion: 2,
      instructions: "Replacement",
    },
    {
      ...base,
      type: "routing.configure",
      expectedVersion: 1,
      enabled: false,
      candidateProfileIds: [],
    },
    {
      ...base,
      type: "repositories.configure",
      expectedVersion: 1,
      repositories: [],
    },
    {
      ...base,
      type: "github.configure",
      expectedVersion: 1,
      credentialRef: null,
      selections: [],
      readiness: null,
    },
    {
      ...base,
      type: "jira.configure",
      expectedVersion: 1,
      instance: "example.atlassian.net",
      selections: [],
      readiness: null,
    },
    {
      ...base,
      type: "github.activate",
      expectedVersion: 1,
      selectionId: "repo",
    },
    {
      ...base,
      type: "assignment.create",
      taskId,
      assignmentId: randomUUID(),
      profileId,
      brief: "New",
      resultDestination: "lead",
      requesterAssignmentId: null,
    },
    {
      ...base,
      type: "imported-blockers.set",
      taskId,
      expectedVersion: 1,
      state: "clear",
    },
    {
      ...base,
      type: "delivery.configure",
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      grants: [],
      requiredChecks: [],
    },
    { ...base, type: "assignment.apply", assignmentId, expectedVersion: 1 },
    {
      ...base,
      type: "dependency.add",
      taskId,
      blockerTaskId,
      expectedVersion: 1,
    },
    {
      ...base,
      type: "dependency.remove",
      taskId,
      blockerTaskId,
      expectedVersion: 1,
    },
    {
      ...base,
      type: "source.review",
      taskId,
      expectedVersion: 1,
      decision: "resume-source-hold",
    },
    {
      ...base,
      type: "github.place",
      taskId,
      expectedVersion: 1,
      chosenProjectId: projectId,
    },
    {
      ...base,
      type: "status-mapping.configure",
      expectedVersion: 1,
      mapping: null,
    },
  ];
}

test("each project command family refuses new archived writes without altering owned rows", async (t) => {
  const f = await archivedProjectFixture(t),
    before = f.snapshot();
  for (const command of commands(
    f.projectId,
    f.taskId,
    f.assignmentId,
    f.blockerTaskId,
    f.profileId,
  ))
    assert.throws(
      () => f.domain.execute({ ...command, key: randomUUID() }),
      ProjectArchivedError,
      command.type,
    );
  assert.throws(
    () =>
      f.components.coordination.postTaskComment({
        actor: "operator",
        key: randomUUID(),
        taskId: f.taskId,
        body: "New comment",
        recipients: [],
      }),
    ProjectArchivedError,
  );
  assert.throws(
    () => f.components.statusMappings.watch(f.taskId),
    ProjectArchivedError,
  );
  assert.throws(
    () =>
      f.components.coordination
        .taskReview()
        .recordViewed(f.taskId, randomUUID(), null, []),
    ProjectArchivedError,
  );
  assert.throws(
    () =>
      f.components.workspaceBindings.createOrGet(
        f.taskId,
        randomUUID(),
        "/disposable/archived",
        [],
      ),
    ProjectArchivedError,
  );
  await assert.rejects(f.service.provisionTask(f.taskId), ProjectArchivedError);
  await assert.rejects(
    f.components.workspaces.discard(f.taskId),
    ProjectArchivedError,
  );
  assert.equal(f.snapshot(), before);
});

test("archived project receipt replay remains readable and another project can still change", async (t) => {
  const f = await archivedProjectFixture(t, false),
    key = randomUUID();
  const command = {
    type: "task.configure" as const,
    actor: "operator" as const,
    key,
    projectId: f.projectId,
    taskId: f.taskId,
    expectedVersion: 1,
    title: "Before archive",
  };
  const receipt = f.domain.execute(command);
  f.freeze();
  const before = f.snapshot();
  assert.deepEqual(f.domain.execute(command), receipt);
  const projectId = randomUUID();
  f.domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Still active",
    leadProfileId: null,
  });
  f.domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: randomUUID(),
    title: "Other",
    outcome: "Other",
    ready: false,
  });
  assert.equal(f.snapshot(), before);
});
