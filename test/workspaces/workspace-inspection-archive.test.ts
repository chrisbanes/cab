import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProjectArchiveBlockedError,
  ProjectArchivedError,
} from "../../src/core/project-lifecycle.js";
import { controlledGit } from "../fixtures/controlled-git.js";
import { processIdentityDenied } from "../fixtures/host-access.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/questions.js";
import { startedOf } from "../fixtures/service-internals.js";
import { checkout } from "../fixtures/setup-home.js";

/** A paused, drained project whose task workspace inspection stalls in its identity read. */
async function stalledInspection(t: test.TestContext) {
  const controlled = controlledGit();
  const f = await createOperatorFixture(
    null,
    undefined,
    undefined,
    {},
    undefined,
    {
      workspaceManager: {
        gitExecutable: controlled.executable,
        gitTimeoutMs: { "repository-identity": 1500 },
      },
    },
  );
  t.after(async () => {
    try {
      await f.close();
    } finally {
      await controlled.cleanup();
    }
  });
  const domain = f.service.domain();
  const run = (body: Record<string, unknown>) =>
    domain.execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  run({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Work",
    capabilities: "local",
  });
  run({
    type: "project.create",
    projectId,
    name: "Inspection",
    leadProfileId: profileId,
  });
  const source = join(f.directory, "source");
  await checkout(source, "https://github.com/acme/atlas.git");
  run({
    type: "task.create",
    projectId,
    taskId,
    title: "Inspect",
    outcome: "Work",
    ready: false,
  });
  const provisioned = await startedOf(f.service).workspaces.provision(taskId, [
    { repositoryId: "R_atlas", path: source, ref: "main" },
  ]);
  assert.equal(provisioned.state, "ready");
  if (!domain.project(projectId).paused)
    run({
      type: "project.configure",
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
      paused: true,
    });
  assert.deepEqual(f.service.projectLifecycleStatus(projectId), []);
  const stored = () => startedOf(f.service).workspaceBindings.get(taskId);
  const before = stored();
  const workspacePath = provisioned.repositories[0]!.workspacePath;
  const seen = controlled.events().length;
  controlled.setRule({
    commandPrefix: "rev-parse --show-toplevel",
    cwd: workspacePath,
    behavior: "stall",
  });
  // No reuse option, so the read runs a Git child.
  const inspection = f.service.taskWorkspace(taskId);
  inspection.catch(() => {});
  await until(() =>
    controlled
      .events()
      .slice(seen)
      .some(
        (e) => e.event === "ready" && e.operation === "repository-identity",
      ),
  );
  const archive = () =>
    run({
      type: "project.archive",
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
    });
  return { f, domain, projectId, inspection, stored, before, archive };
}

test("a workspace inspection read in flight does not block archive", {
  skip: processIdentityDenied(),
}, async (t) => {
  const { f, domain, projectId, archive } = await stalledInspection(t);
  assert.deepEqual(f.service.projectLifecycleStatus(projectId), []);
  assert.doesNotThrow(archive, ProjectArchiveBlockedError);
  assert.ok(domain.project(projectId).archived);
});

test("an inspection whose check fails after archive writes nothing", {
  skip: processIdentityDenied(),
}, async (t) => {
  const { inspection, stored, before, archive } = await stalledInspection(t);
  archive();
  await assert.rejects(inspection, ProjectArchivedError);
  const after = stored();
  assert.equal(after?.state, "ready");
  assert.equal(after?.gitUncertain, false);
  assert.equal(after?.updatedAt, before?.updatedAt);
});
