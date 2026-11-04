import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { Runtime } from "../../src/standalone/codex.js";
import { claudeTemporaryBase } from "../../src/standalone/claude.js";
import { ProjectDeletionCleanup } from "../../src/standalone/project-deletion-cleanup.js";
import { ProjectTombstones } from "../../src/standalone/project-deletion.js";
import { projectDeletionFixture } from "./project-deletion.js";
import { databaseOf, startedOf } from "./service-internals.js";

const execute = promisify(execFile);
export async function cleanupGit(cwd: string, ...args: string[]) {
  return (
    await execute("git", ["-C", cwd, ...args], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
export async function cleanupRepository(root: string, name: string) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await execute("git", ["init", "--initial-branch=main", path]);
  await cleanupGit(path, "config", "user.name", "Disposable Cleanup Fixture");
  await cleanupGit(path, "config", "user.email", "cleanup@example.invalid");
  await writeFile(join(path, "README.md"), "Committed source\n");
  await cleanupGit(path, "add", "README.md");
  await cleanupGit(path, "commit", "-m", "Initial");
  return path;
}
export async function deletedCleanupFixture(
  t: TestContext,
  options: {
    workspaces?: boolean;
    draft?: boolean;
    temp?: boolean;
    repositories?: number;
    thread?: boolean;
  } = {},
) {
  const f = await projectDeletionFixture(t, false),
    threadId = randomUUID();
  if (options.thread) {
    f.db
      .prepare("UPDATE execution_intents SET threadId=? WHERE workId=?")
      .run(threadId, f.workId);
    f.components.state.registerRuntimeThreadTools(threadId, "a".repeat(64));
  }
  const sources: string[] = [];
  for (
    let i = 0;
    i < (options.workspaces ? (options.repositories ?? 1) : 0);
    i++
  )
    sources.push(await cleanupRepository(f.fixture.directory, `source-${i}`));
  const inputs = sources.map((path, index) => ({
    repositoryId: `R_${index}`,
    path,
    ref: "main",
  }));
  const binding = options.workspaces
    ? await f.components.workspaces.provision(f.taskId, inputs)
    : undefined;
  if (binding) assert.equal(binding.state, "ready");
  const survivor = options.workspaces
    ? await f.components.workspaces.provision(f.taskB, inputs)
    : undefined;
  let draftBinding: typeof binding;
  if (options.draft) {
    const runId = randomUUID();
    f.components.drafting.create({
      runId,
      projectId: f.projectId,
      idea: "Disposable draft",
      harness: "codex",
      profileId: f.profileId,
      profileRevision: 1,
      instructionsRevision: 1,
    });
    draftBinding = await f.components.draftingWorkspaces.provision(
      runId,
      inputs,
    );
    f.db
      .prepare("UPDATE drafting_runs SET state='expired' WHERE runId=?")
      .run(runId);
  }
  let temp: string | undefined;
  if (options.temp && binding) {
    temp = claudeTemporaryBase(binding.path);
    await mkdir(temp, { mode: 0o700 });
    await writeFile(join(temp, "disposable"), "Private temporary content");
    // This is an exclusively created fixture path, not an installed Claude directory.
    t.after(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(temp!, { recursive: true, force: true });
    });
  }
  if (binding)
    for (const repository of binding.repositories) {
      await writeFile(
        join(repository.workspacePath, "local.txt"),
        "Local committed work\n",
      );
      await cleanupGit(repository.workspacePath, "add", "local.txt");
      await cleanupGit(
        repository.workspacePath,
        "-c",
        "user.name=Disposable",
        "-c",
        "user.email=cleanup@example.invalid",
        "commit",
        "-m",
        "Local unpushed commit",
      );
      await cleanupGit(
        repository.workspacePath,
        "branch",
        `retain-${f.projectId}`,
      );
      await writeFile(
        join(repository.workspacePath, "README.md"),
        "Dirty tracked work\n",
      );
      await writeFile(
        join(repository.workspacePath, "untracked.txt"),
        "Untracked work\n",
      );
      await writeFile(
        join(repository.workspacePath, ".gitignore"),
        "ignored.bin\n",
      );
      await writeFile(
        join(repository.workspacePath, "ignored.bin"),
        "Ignored work\n",
      );
    }
  f.freeze();
  const command = await f.command();
  const commit = () => f.deletion().delete(command); // Simulates process loss before service's postcommit hook.
  const store = () => new ProjectTombstones(databaseOf(f.service), false);
  const runner = (
    runtime: () => Runtime | undefined = () => undefined,
    overrides: Partial<
      ConstructorParameters<typeof ProjectDeletionCleanup>[1]
    > = {},
  ) => {
    const c = startedOf(f.service);
    return new ProjectDeletionCleanup(databaseOf(f.service), {
      roots: f.roots,
      workspaces: { task: c.workspaces, drafting: c.draftingWorkspaces },
      archival: c.conversationArchival,
      runtime,
      accepting: () => true,
      ...overrides,
    });
  };
  const assertDeleted = () =>
    assert.equal(
      databaseOf(f.service)
        .prepare("SELECT 1 FROM domain_projects WHERE id=?")
        .get(f.projectId),
      undefined,
    );
  const contents = async () => ({
    source: await Promise.all(
      sources.map((path) => readFile(join(path, "README.md"), "utf8")),
    ),
    survivor: survivor
      ? await Promise.all(
          survivor.repositories.map((r) =>
            readFile(join(r.workspacePath, "README.md"), "utf8"),
          ),
        )
      : [],
  });
  return {
    ...f,
    threadId,
    sources,
    binding,
    survivor,
    draftBinding,
    temp,
    command,
    commit,
    store,
    runner,
    assertDeleted,
    contents,
  };
}
