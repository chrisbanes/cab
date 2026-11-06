import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { taskGitWritableRoots } from "../../src/standalone/workspaces.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/questions.js";
import { checkout } from "../fixtures/setup-home.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.invalid",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();
const chmod = (mode: string, ...paths: string[]) =>
  execFileSync("chmod", [mode, ...paths]);

test("a task turn carries its Git roots, and Git confined to them can branch, commit, amend and rebase", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const run = (body: Record<string, unknown>) =>
    f.service
      .domain()
      .execute({ actor: "operator", key: randomUUID(), ...body } as never);
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
    name: "Git",
    leadProfileId: profileId,
  });
  const source = join(f.directory, "source");
  await checkout(source, "https://github.com/acme/atlas.git");
  await f.service.domain().configureRepositories({
    type: "repositories.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: f.service.domain().repositoryLinks(projectId).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_atlas",
        path: source,
        ref: "main",
      },
    ],
  } as never);
  run({
    type: "project.configure",
    projectId,
    expectedVersion: Number(f.service.domain().project(projectId).version),
    paused: false,
    commandNetworkAccess: true,
  });
  run({
    type: "task.create",
    projectId,
    taskId,
    title: "Git",
    outcome: "Commit work",
    ready: false,
  });
  // A draft turn is read-only: it gets no Git roots, whatever the binding allows.
  await f.service.startDraftTurn({
    key: randomUUID(),
    taskId,
    expectedVersion: 1,
    message: "Look first",
  });
  await until(() => f.runtime.turns === 1);
  assert.deepEqual(f.runtime.policies[0], {
    networkAccess: false,
    access: "read-only",
  });
  f.runtime.complete(1);
  run({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: Number(f.service.domain().task(taskId).version),
    ready: true,
  });
  await until(() => f.runtime.turns === 2);
  const binding = await f.service.taskWorkspace(taskId);
  assert.ok(binding);
  const repository = binding.repositories[0]!;
  const managed = repository.gitCommonDir!;
  const roots = taskGitWritableRoots(binding);
  assert.equal(roots.length, 3);
  assert.deepEqual(f.runtime.policies[1], {
    networkAccess: true,
    gitWritableRoots: roots,
  });

  // The closest offline equivalent of the sandbox: only the workspace and the roots are writable.
  if (process.getuid?.() === 0) return t.skip("root ignores file modes");
  const sourceRefs = git(source, "for-each-ref");
  const sourceGit = join(source, ".git");
  chmod("-R", "a-w", sourceGit);
  chmod("a-w", managed, join(managed, "config"));
  try {
    const workspace = repository.workspacePath;
    const base = git(workspace, "rev-parse", "HEAD");
    git(workspace, "switch", "-q", "-c", "other");
    await appendFile(join(workspace, "other.txt"), "other\n");
    git(workspace, "add", "other.txt");
    git(workspace, "commit", "-qm", "other");
    const other = git(workspace, "rev-parse", "HEAD");
    git(workspace, "switch", "-q", "-c", "probe", base);
    await appendFile(join(workspace, "probe.txt"), "probe\n");
    git(workspace, "add", "probe.txt");
    git(workspace, "commit", "-qm", "probe");
    git(workspace, "commit", "-q", "--amend", "-m", "probe amended");
    git(workspace, "rebase", "-q", "other");
    git(workspace, "branch", "-q", "-d", "other");
    assert.deepEqual(
      git(workspace, "rev-list", "--reverse", `${base}..probe`)
        .split("\n")
        .slice(0, 1),
      [other],
    );
    assert.equal(
      git(managed, "log", "-1", "--format=%s", "probe"),
      "probe amended",
    );
    await assert.rejects(appendFile(join(managed, "config"), "[evil]\n"), {
      code: "EACCES",
    });
    assert.equal(git(source, "for-each-ref"), sourceRefs);
  } finally {
    chmod("-R", "u+w", sourceGit);
    chmod("u+w", managed, join(managed, "config"));
  }
});
