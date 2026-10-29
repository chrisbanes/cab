import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TaskWorkspaceRepository } from "../../src/standalone/workspaces.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/questions.js";
import { startedOf } from "../fixtures/service-internals.js";
import { checkout, git } from "../fixtures/setup-home.js";

async function world() {
  const f = await createOperatorFixture();
  const projectId = randomUUID();
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const profileId = randomUUID();
  run({
    type: "profile.create",
    profileId,
    name: "Local lead",
    instructions: "Local work",
    capabilities: "local",
  });
  run({
    type: "project.create",
    projectId,
    name: "Linked project",
    leadProfileId: profileId,
  });
  const link = (repositoryId: string, path: string, extra = {}) => ({
    codeHost: "github" as const,
    host: "github.com" as const,
    repositoryId,
    path,
    ref: "main",
    ...extra,
  });
  const configure = async (
    repositories: Record<string, unknown>[],
    expectedVersion = f.service.domain().repositoryLinks(projectId).version,
  ) =>
    f.service.domain().configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion,
      repositories,
    } as never);
  const readyTask = () => {
    const taskId = randomUUID();
    run({
      type: "task.create",
      projectId,
      taskId,
      title: "Local",
      outcome: "Work in every linked repository",
      ready: true,
    });
    return taskId;
  };
  const unpause = () =>
    run({
      type: "project.configure",
      projectId,
      expectedVersion: 1,
      paused: false,
    });
  return { f, projectId, link, configure, readyTask, unpause };
}

test("a local task's first workspace holds every linked repository at its ref", async () => {
  const w = await world();
  try {
    const hub = join(w.f.directory, "hub");
    const lab = join(w.f.directory, "lab");
    await checkout(hub, "https://github.com/acme/atlas.git");
    await checkout(lab, "https://gitlab.example.com/group/atlas.git");
    await w.configure([
      w.link("R_hub", hub),
      {
        codeHost: "gitlab",
        host: "gitlab.example.com",
        repositoryId: "4242",
        projectPath: "group/atlas",
        path: lab,
        ref: "main",
      },
    ]);
    const taskId = w.readyTask();
    w.unpause();
    await until(() => w.f.runtime.turns === 1);
    const binding = await w.f.service.taskWorkspace(taskId);
    assert.equal(binding?.state, "ready");
    assert.deepEqual(binding?.repositories.map((r) => r.repositoryId).sort(), [
      "4242",
      "R_hub",
    ]);
    for (const [id, source] of [
      ["R_hub", hub],
      ["4242", lab],
    ] as const) {
      const repository: TaskWorkspaceRepository | undefined =
        binding?.repositories.find((r) => r.repositoryId === id);
      assert.ok(repository, id);
      assert.equal(repository.sourcePath, await realpath(source));
      assert.equal(repository.ref, "main");
      assert.equal(
        (await git(repository.workspacePath, "rev-parse", "HEAD")).stdout,
        (await git(source, "rev-parse", "main")).stdout,
      );
    }
    // A second read finds the same workspace and no second turn starts.
    assert.equal(
      (await w.f.service.taskWorkspace(taskId))?.workspaceId,
      binding?.workspaceId,
    );
    assert.equal(w.f.runtime.turns, 1);
  } finally {
    await w.f.close();
  }
});

test("a local task in a project with only a GitLab link provisions its workspace and runs", async () => {
  const w = await world();
  try {
    const lab = join(w.f.directory, "lab");
    await checkout(lab, "git@gitlab.example.com:group/atlas.git");
    await w.configure([
      {
        codeHost: "gitlab",
        host: "gitlab.example.com",
        repositoryId: "4242",
        projectPath: "group/atlas",
        path: lab,
        ref: "main",
      },
    ]);
    const taskId = w.readyTask();
    w.unpause();
    await until(() => w.f.runtime.turns === 1);
    const binding = await w.f.service.taskWorkspace(taskId);
    assert.equal(binding?.state, "ready");
    assert.deepEqual(
      binding?.repositories.map((r) => r.repositoryId),
      ["4242"],
    );
  } finally {
    await w.f.close();
  }
});

test("a local task waits without a workspace when a linked checkout's identity changed", async () => {
  const w = await world();
  try {
    const hub = join(w.f.directory, "hub");
    await checkout(hub, "https://github.com/acme/atlas.git");
    await w.configure([w.link("R_hub", hub)]);
    // The linked path now resolves to another checkout.
    const other = join(w.f.directory, "other");
    await checkout(other, "https://github.com/acme/atlas.git");
    await rm(hub, { recursive: true });
    await symlink(other, hub);
    const taskId = w.readyTask();
    w.unpause();
    await until(() =>
      startedOf(w.f.service)
        .schedulerStore.forTask(taskId)
        .some((r) => r.reason?.startsWith("Workspace admission waiting:")),
    );
    assert.equal(await w.f.service.taskWorkspace(taskId), undefined);
    assert.equal(w.f.runtime.turns, 0);
  } finally {
    await w.f.close();
  }
});

test("a project with no links still gives a repository-free workspace", async () => {
  const w = await world();
  try {
    const taskId = w.readyTask();
    w.unpause();
    await until(() => w.f.runtime.turns === 1);
    assert.deepEqual(
      (await w.f.service.taskWorkspace(taskId))?.repositories,
      [],
    );
  } finally {
    await w.f.close();
  }
});
