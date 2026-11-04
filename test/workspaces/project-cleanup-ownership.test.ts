import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { gitEnvironment } from "../../src/core/child-environment.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { verifiedRepository } from "../../src/standalone/repository-verification.js";
import {
  runGit,
  type GitRunOptions,
} from "../../src/standalone/git-process.js";
import { SqliteWorkspaceBindingStore } from "../../src/standalone/workspaces.js";
import { transaction } from "../../src/core/store.js";
import { databaseOf } from "../fixtures/service-internals.js";
import {
  cleanupGit,
  cleanupRepository,
  deletedCleanupFixture,
} from "../fixtures/deleted-project-cleanup.js";

const execute = promisify(execFile);
async function separateRepository(outside: string, common: string) {
  await mkdir(dirname(common), { recursive: true });
  await execute(
    "git",
    ["init", "--initial-branch=main", "--separate-git-dir", common, outside],
    {
      env: gitEnvironment(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  await cleanupGit(
    outside,
    "config",
    "user.name",
    "Disposable Ownership Fixture",
  );
  await cleanupGit(
    outside,
    "config",
    "user.email",
    "ownership@example.invalid",
  );
  await writeFile(join(outside, "README.md"), "B checkout bytes\n");
  await cleanupGit(outside, "add", "README.md");
  await cleanupGit(outside, "commit", "-m", "Initial");
  await cleanupGit(
    outside,
    "remote",
    "add",
    "origin",
    "https://github.com/cleanup-owner/repository.git",
  );
  return verifiedRepository({
    repositoryId: "R_survivor",
    path: outside,
    ref: "main",
  });
}
async function commitDeletion(
  f: Awaited<ReturnType<typeof deletedCleanupFixture>>,
) {
  const preview = await f.deletion().preview(f.projectId);
  return f
    .deletion()
    .delete({ ...f.command, previewDigest: preview.previewDigest });
}
const linkRow = (path: string) => ({
  codeHost: "github" as const,
  host: "github.com" as const,
  repositoryId: "R_survivor",
  path,
  ref: "main",
});

for (const placement of ["child", "nested", "prefix-sibling"] as const) {
  test(`a real external checkout's ${placement} separate Git directory is preserved by cleanup`, async (t) => {
    const f = await deletedCleanupFixture(t, { workspaces: true });
    const db = databaseOf(f.service),
      root = f.binding!.path;
    db.prepare("DELETE FROM task_workspace_bindings WHERE taskId=?").run(
      f.taskB,
    );
    const common =
      placement === "prefix-sibling"
        ? `${root}-sibling/metadata`
        : placement === "nested"
          ? join(
              f.binding!.repositories[0]!.workspacePath,
              "subdir",
              "metadata",
            )
          : join(root, "metadata");
    const repository = await separateRepository(
      join(f.fixture.directory, "outside-B"),
      common,
    );
    await f.domain.configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: f.projectB,
      expectedVersion: f.domain.repositoryLinks(f.projectB).version,
      repositories: [linkRow(repository.path)],
    });
    const saved = db
      .prepare("SELECT * FROM project_repository_links WHERE projectId=?")
      .get(f.projectB);
    const bytes = await readFile(join(common, "HEAD"), "utf8");
    const config = await readFile(join(common, "config"), "utf8");
    await commitDeletion(f);
    await f.runner().sweep();
    assert.deepEqual(
      db
        .prepare("SELECT * FROM project_repository_links WHERE projectId=?")
        .get(f.projectB),
      saved,
    );
    assert.equal(
      db
        .prepare("SELECT 1 FROM task_workspace_bindings WHERE taskId=?")
        .get(f.taskB),
      undefined,
    );
    assert.equal(
      await readFile(join(repository.path, "README.md"), "utf8"),
      "B checkout bytes\n",
    );
    assert.equal(await readFile(join(common, "HEAD"), "utf8"), bytes);
    assert.equal(await readFile(join(common, "config"), "utf8"), config);
    assert.deepEqual(
      await verifiedRepository({
        repositoryId: "R_survivor",
        path: repository.path,
        ref: "main",
      }),
      repository,
    );
    if (placement === "prefix-sibling")
      await assert.rejects(lstat(root), { code: "ENOENT" });
    else {
      assert.ok(await lstat(root));
      assert.ok(f.store().pendingCleanup().length);
    }
  });
}

for (const metadata of [
  "number",
  "relative",
  "null",
  "missing",
  "invalid-json",
] as const) {
  test(`unprovable ${metadata} stored Git metadata cannot authorize physical removal`, async (t) => {
    const f = await deletedCleanupFixture(t, { workspaces: true });
    const common = join(f.binding!.path, "B-metadata");
    const repo = await separateRepository(
      join(f.fixture.directory, "outside-B"),
      common,
    );
    await commitDeletion(f);
    const value: Record<string, unknown> = {
      ...repo,
      codeHost: "github",
      host: "github.com",
    };
    if (metadata === "number") value.gitCommonDirectory = 42;
    if (metadata === "relative") value.gitCommonDirectory = "relative-metadata";
    if (metadata === "null") value.gitCommonDirectory = null;
    if (metadata === "missing") delete value.gitCommonDirectory;
    databaseOf(f.service)
      .prepare("UPDATE project_repository_links SET links=? WHERE projectId=?")
      .run(
        metadata === "invalid-json" ? "not-json" : JSON.stringify([value]),
        f.projectB,
      );
    let removals = 0;
    // biome-ignore lint/complexity/useLiteralKeys: count effects at the trusted fake-runner seam
    f.components.workspaces["options"].capturedGitRunner = async (options) => {
      if (options.args.includes("remove")) removals++;
      return runGit(options);
    };
    await f.runner().sweep();
    assert.equal(removals, 0);
    assert.equal(
      await readFile(join(common, "HEAD"), "utf8"),
      "ref: refs/heads/main\n",
    );
    assert.equal(
      await readFile(join(repo.path, "README.md"), "utf8"),
      "B checkout bytes\n",
    );
    assert.ok(await lstat(f.binding!.path));
  });
}

/** A fake owned child has already received removal; only this fixture can supply its positive exit. */
async function deferredRemoval(
  t: TestContext,
  f: Awaited<ReturnType<typeof deletedCleanupFixture>>,
) {
  let release!: () => void,
    removal: GitRunOptions | undefined,
    count = 0,
    accepting = true;
  const settlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = f.components.workspaces;
  // biome-ignore lint/complexity/useLiteralKeys: fake child through the existing captured runner seam
  manager["options"].capturedGitRunner = async (options) => {
    if (!options.args.includes("remove")) return runGit(options);
    assert.equal(
      ++count,
      1,
      "no second remove while an owned child is unobserved",
    );
    removal = options;
    return {
      status: "interrupted",
      kind: "timed-out",
      spawned: true,
      childExitObserved: false,
      childExitSignal: null,
      settlement,
    };
  };
  const runner = f.runner(undefined, { accepting: () => accepting });
  const finish = async (apply = false) => {
    assert.ok(removal, "the test reached a real captured destructive dispatch");
    // biome-ignore lint/complexity/useLiteralKeys: await the exact owned operation without process probes
    const operation = manager["inFlight"].get(f.taskId);
    assert.ok(
      operation,
      "the task lock is still owned by the unobserved child",
    );
    // biome-ignore lint/complexity/useLiteralKeys: await the enclosing effect too, not just its inner task lock
    const effects = [...runner["effects"].values()].map(
      (entry) => entry.effect,
    );
    if (apply) {
      assert.equal((await runGit(removal)).status, "ok");
      await assert.rejects(lstat(removal.args.at(-1)!), { code: "ENOENT" });
    }
    release();
    await operation;
    await Promise.all(effects);
  };
  t.after(() => {
    accepting = false;
    manager.cancelGitWork();
    release();
  });
  return {
    runner,
    finish,
    count: () => count,
    target: () => removal?.args.at(-1),
  };
}

for (const surface of [
  "domain-configure",
  "api-configure",
  "domain-setup",
  "api-setup",
] as const) {
  for (const owner of ["checkout-subdir", "separate-metadata"] as const) {
    test(`${surface} cannot acquire ${owner} after cleanup dispatch and verification await`, async (t) => {
      const f = await deletedCleanupFixture(t, { workspaces: true });
      const source =
        owner === "checkout-subdir"
          ? join(f.binding!.repositories[0]!.workspacePath, "B-source")
          : join(f.fixture.directory, "outside-B");
      if (owner === "checkout-subdir") {
        await mkdir(source);
        await writeFile(join(source, "B-owned.txt"), "B source bytes");
        await cleanupGit(
          source,
          "remote",
          "add",
          "origin",
          "https://github.com/cleanup-owner/repository.git",
        );
      } else
        await separateRepository(
          source,
          join(f.binding!.repositories[0]!.workspacePath, "B-metadata"),
        );
      const verified = await verifiedRepository({
        repositoryId: "R_survivor",
        path: source,
        ref: "main",
      });
      const content = await readFile(
        join(source, owner === "checkout-subdir" ? "B-owned.txt" : "README.md"),
        "utf8",
      );
      const head = await readFile(
        join(verified.gitCommonDirectory, "HEAD"),
        "utf8",
      );
      await commitDeletion(f);
      const gate = await deferredRemoval(t, f);
      let verifiedNow!: () => void, continueCommit!: () => void;
      const observed = new Promise<void>((resolve) => {
        verifiedNow = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        continueCommit = resolve;
      });
      t.after(() => continueCommit());
      Object.defineProperty(f.domain, "verifyRepository", {
        value: async (...args: Parameters<typeof verifiedRepository>) => {
          const result = await verifiedRepository(...args);
          verifiedNow();
          await wait;
          return result;
        },
      });
      const api = new OperatorApi(f.service, [f.fixture.directory]);
      const key = randomUUID(),
        newProject = randomUUID(),
        setup = surface.endsWith("setup");
      const configure = {
        type: "repositories.configure" as const,
        key,
        projectId: f.projectB,
        expectedVersion: f.domain.repositoryLinks(f.projectB).version,
        repositories: [linkRow(source)],
      };
      const create = {
        type: "project.create" as const,
        key,
        projectId: newProject,
        name: "New survivor",
        leadProfileId: null,
        repositories: [
          {
            repositoryId: "R_survivor",
            owner: "cleanup-owner",
            name: "repository",
            path: source,
            ref: "main",
          },
        ],
      };
      const before = databaseOf(f.service)
        .prepare("SELECT * FROM project_repository_links WHERE projectId=?")
        .get(f.projectB);
      const operation =
        surface === "domain-configure"
          ? f.domain.configureRepositories({ ...configure, actor: "operator" })
          : surface === "domain-setup"
            ? f.domain.createProject({ ...create, actor: "operator" })
            : api.execute(setup ? create : configure);
      const completed = operation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        observed,
        completed.then(() => {
          throw new Error(
            "Ownership command settled before reaching the verification gate",
          );
        }),
      ]);
      await gate.runner.sweep();
      assert.equal(gate.count(), 1);
      const removalPath = gate.target();
      assert.ok(removalPath);
      assert.ok(
        (owner === "checkout-subdir"
          ? verified.path
          : verified.gitCommonDirectory
        ).startsWith(`${removalPath}/`),
        "the ownership being refused lies inside the already-dispatched child's actual removal subtree",
      );
      continueCommit();
      const outcome = await completed;
      assert.ok("error" in outcome, "reserved ownership must not commit");
      const error = outcome.error;
      assert.ok(
        surface.startsWith("api")
          ? error instanceof OperatorApiError && error.status === 409
          : error instanceof Error && /reserved/.test(error.message),
      );
      const db = databaseOf(f.service);
      assert.deepEqual(
        db
          .prepare("SELECT * FROM project_repository_links WHERE projectId=?")
          .get(f.projectB),
        before,
      );
      for (const table of ["projects", "domain_projects"])
        assert.equal(
          db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(newProject),
          undefined,
        );
      assert.equal(
        db
          .prepare("SELECT 1 FROM project_repository_links WHERE projectId=?")
          .get(newProject),
        undefined,
      );
      assert.equal(
        db.prepare("SELECT 1 FROM command_receipts WHERE key=?").get(key),
        undefined,
      );
      assert.equal(
        await readFile(
          join(
            source,
            owner === "checkout-subdir" ? "B-owned.txt" : "README.md",
          ),
          "utf8",
        ),
        content,
      );
      assert.equal(
        await readFile(join(verified.gitCommonDirectory, "HEAD"), "utf8"),
        head,
      );
      await gate.runner.sweep();
      assert.equal(gate.count(), 1);
      await gate.finish();
      assert.equal(
        await readFile(
          join(
            source,
            owner === "checkout-subdir" ? "B-owned.txt" : "README.md",
          ),
          "utf8",
        ),
        content,
      );
    });
  }
}

for (const phase of ["pending-capture", "unobserved-child"] as const) {
  test(`bindRepository refuses a newly discovered separate Git directory during ${phase}`, async (t) => {
    const f = await deletedCleanupFixture(t, { workspaces: true });
    const common = join(
        f.binding!.repositories[0]!.workspacePath,
        "B-metadata",
      ),
      source = join(f.fixture.directory, "outside-B");
    const verified = await separateRepository(source, common);
    await commitDeletion(f);
    const gate = await deferredRemoval(t, f);
    if (phase === "unobserved-child") await gate.runner.sweep();
    const store = new SqliteWorkspaceBindingStore(databaseOf(f.service));
    const workspaceId = randomUUID();
    const binding = store.createOrGet(
      f.blockerB,
      workspaceId,
      join(f.roots.task, workspaceId),
      [
        {
          repositoryId: "R_survivor",
          sourcePath: source,
          workspacePath: join(f.roots.task, workspaceId, "repo-1"),
          ref: "main",
          gitCommonDir: null,
          commit: null,
        },
      ],
    );
    const commit = await cleanupGit(source, "rev-parse", "main");
    assert.throws(
      () =>
        store.bindRepository(
          f.blockerB,
          "R_survivor",
          verified.gitCommonDirectory,
          commit,
        ),
      /reserved/,
    );
    assert.deepEqual(store.get(f.blockerB), binding);
    assert.equal(
      await readFile(join(common, "HEAD"), "utf8"),
      "ref: refs/heads/main\n",
    );
    assert.equal(
      await readFile(join(source, "README.md"), "utf8"),
      "B checkout bytes\n",
    );
    if (phase === "unobserved-child") await gate.finish();
  });
  for (const table of [
    "task_workspace_bindings",
    "drafting_workspace_bindings",
  ] as const) {
    test(`${table} acquisition refuses known separate metadata during ${phase} in the caller transaction`, async (t) => {
      const f = await deletedCleanupFixture(t, { workspaces: true });
      const common = join(
          f.binding!.repositories[0]!.workspacePath,
          "B-metadata",
        ),
        source = join(f.fixture.directory, "outside-B");
      const verified = await separateRepository(source, common);
      await commitDeletion(f);
      const gate = await deferredRemoval(t, f);
      if (phase === "unobserved-child") await gate.runner.sweep();
      const db = databaseOf(f.service),
        store = new SqliteWorkspaceBindingStore(db, table),
        workspaceId = randomUUID();
      assert.throws(
        () =>
          transaction(db, () =>
            store.createOrGet(
              f.blockerB,
              workspaceId,
              join(f.roots.task, workspaceId),
              [
                {
                  repositoryId: "R_survivor",
                  sourcePath: source,
                  workspacePath: join(f.roots.task, workspaceId, "repo-1"),
                  ref: "main",
                  gitCommonDir: verified.gitCommonDirectory,
                  commit: null,
                },
              ],
            ),
          ),
        /reserved/,
      );
      assert.equal(store.get(f.blockerB), undefined);
      assert.equal(
        await readFile(join(common, "HEAD"), "utf8"),
        "ref: refs/heads/main\n",
      );
      if (phase === "unobserved-child") await gate.finish();
    });
  }
}

test("unrelated and prefix-sibling repository ownership can commit while a different child remains uncertain", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await commitDeletion(f);
  const gate = await deferredRemoval(t, f);
  await gate.runner.sweep();
  const sibling = await separateRepository(
    join(f.fixture.directory, "outside-B"),
    `${f.binding!.path}-sibling/metadata`,
  );
  const api = new OperatorApi(f.service, [f.fixture.directory]);
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId: f.projectB,
    expectedVersion: f.domain.repositoryLinks(f.projectB).version,
    repositories: [linkRow(sibling.path)],
  });
  const path = await cleanupRepository(f.fixture.directory, "unrelated-source");
  await cleanupGit(
    path,
    "remote",
    "add",
    "origin",
    "https://github.com/cleanup-owner/repository.git",
  );
  const projectId = randomUUID();
  await f.domain.createProject({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Unrelated survivor",
    leadProfileId: null,
    repositories: [
      {
        repositoryId: "R_other",
        owner: "cleanup-owner",
        name: "repository",
        path,
        ref: "main",
      },
    ],
  });
  const verified = await verifiedRepository({
    repositoryId: "R_other",
    path,
    ref: "main",
  });
  const store = new SqliteWorkspaceBindingStore(databaseOf(f.service)),
    workspaceId = randomUUID();
  store.createOrGet(f.blockerB, workspaceId, join(f.roots.task, workspaceId), [
    {
      repositoryId: "R_other",
      sourcePath: path,
      workspacePath: join(f.roots.task, workspaceId, "repo-1"),
      ref: "main",
      gitCommonDir: null,
      commit: null,
    },
  ]);
  assert.equal(
    store.bindRepository(
      f.blockerB,
      "R_other",
      verified.gitCommonDirectory,
      await cleanupGit(path, "rev-parse", "main"),
    ).repositories[0]!.gitCommonDir,
    verified.gitCommonDirectory,
  );
  assert.equal(
    f.domain.repositoryLinks(f.projectB).links[0]!.gitCommonDirectory,
    sibling.gitCommonDirectory,
  );
  assert.equal(f.domain.project(projectId).name, "Unrelated survivor");
  await gate.runner.sweep();
  assert.equal(gate.count(), 1);
  assert.equal(
    await readFile(join(sibling.path, "README.md"), "utf8"),
    "B checkout bytes\n",
  );
  await gate.finish();
});

test("positive cleanup completion releases path admission, while replay never touches its new owner", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await commitDeletion(f);
  const db = databaseOf(f.service),
    receipt = db
      .prepare("SELECT resultJson FROM project_tombstones WHERE projectId=?")
      .get(f.projectId);
  const gate = await deferredRemoval(t, f);
  await gate.runner.sweep();
  await gate.finish(true);
  await gate.runner.sweep();
  await gate.runner.sweep();
  const pending = f.store().pendingCleanup();
  assert.equal(
    pending.length,
    0,
    JSON.stringify(
      pending.map((row) =>
        row.cleanup.items.map((item) => ({
          kind: item.kind,
          state: item.state,
          ...(item.state === "pending"
            ? { reason: item.reason, uncertainGit: !!item.gitRemoval }
            : {}),
        })),
      ),
    ),
  );
  await assert.rejects(lstat(f.binding!.path), { code: "ENOENT" });
  const repo = await separateRepository(
    join(f.fixture.directory, "new-outside-B"),
    join(f.binding!.path, "new-B-metadata"),
  );
  const api = new OperatorApi(f.service, [f.fixture.directory]);
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId: f.projectB,
    expectedVersion: f.domain.repositoryLinks(f.projectB).version,
    repositories: [linkRow(repo.path)],
  });
  await gate.runner.sweep();
  assert.equal(
    await readFile(join(repo.path, "README.md"), "utf8"),
    "B checkout bytes\n",
  );
  assert.equal(
    await readFile(join(repo.gitCommonDirectory, "HEAD"), "utf8"),
    "ref: refs/heads/main\n",
  );
  assert.deepEqual(
    db
      .prepare("SELECT resultJson FROM project_tombstones WHERE projectId=?")
      .get(f.projectId),
    receipt,
  );
  assert.equal(gate.count(), 1);
});
