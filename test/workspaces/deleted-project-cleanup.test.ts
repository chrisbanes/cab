import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  lstat,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runGit } from "../../src/standalone/git-process.js";
import { ProjectTombstones } from "../../src/standalone/project-deletion.js";
import { materialDigest } from "../../src/core/delivery.js";
import {
  WorkspaceManager,
  SqliteWorkspaceBindingStore,
} from "../../src/standalone/workspaces.js";
import { capturedWorkspaceUnclaimed } from "../../src/standalone/project-cleanup-reservations.js";
import { DeletedProjectRedactionStore } from "../../src/core/deleted-project-redaction.js";
import { databaseOf, startedOf } from "../fixtures/service-internals.js";
import {
  cleanupGit,
  deletedCleanupFixture,
} from "../fixtures/deleted-project-cleanup.js";

async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("postcommit cleanup force-discards captured dirty task/draft worktrees and private temp, retaining shared Git refs", async (t) => {
  const f = await deletedCleanupFixture(t, {
    workspaces: true,
    draft: true,
    temp: true,
  });
  const before = await f.contents(),
    refs = await cleanupGit(f.sources[0]!, "show-ref");
  const result = await f.service.deleteProject(f.command);
  assert.equal(result.kind, "project-deleted");
  f.assertDeleted();
  await absent(f.binding!.path);
  await absent(f.draftBinding!.path);
  await absent(f.temp!);
  assert.deepEqual(await f.contents(), before);
  assert.equal(
    await cleanupGit(f.sources[0]!, "show-ref"),
    refs,
    "no local branch or provider mutation",
  );
  const row = databaseOf(f.service)
    .prepare(
      "SELECT cleanupJson,cleanupState FROM project_tombstones WHERE projectId=?",
    )
    .get(f.projectId)!;
  assert.equal(row.cleanupState, "complete");
  for (const path of [f.binding!.path, f.sources[0]!, f.temp!])
    assert.equal(String(row.cleanupJson).includes(path), false);
  assert.equal(f.fixture.runtime.turns, 0);
});

test("startup resumes pending cleanup after commit with no live project, bindings or intents", async (t) => {
  const f = await deletedCleanupFixture(t, {
    workspaces: true,
    draft: true,
    temp: true,
  });
  await f.commit();
  f.assertDeleted();
  assert.ok(f.store().pendingCleanup().length);
  const ledger = new DeletedProjectRedactionStore(
    databaseOf(f.service),
    false,
  ).fingerprint([]);
  await f.service.stop();
  await f.service.start();
  await startedOf(f.service).projectDeletionCleanup.sweep();
  f.assertDeleted();
  await absent(f.binding!.path);
  await absent(f.draftBinding!.path);
  await absent(f.temp!);
  assert.equal(f.store().pendingCleanup().length, 0);
  assert.equal(
    new DeletedProjectRedactionStore(databaseOf(f.service), false).fingerprint(
      [],
    ),
    ledger,
  );
  assert.equal(
    databaseOf(f.service)
      .prepare("SELECT 1 FROM execution_intents WHERE workId=?")
      .get(f.workId),
    undefined,
  );
});

test("a crash midway through multi-repository removal leaves pending and resumes from captured identities", async (t) => {
  const f = await deletedCleanupFixture(t, {
    workspaces: true,
    repositories: 2,
  });
  await f.commit();
  const second = f.binding!.repositories[1]!.workspacePath;
  const failing = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(databaseOf(f.service)),
    f.roots.task,
    {
      beforePathAccess: (path) => {
        if (path === second)
          throw new Error("Injected crash after first repository removal");
      },
    },
  );
  await f
    .runner(undefined, {
      workspaces: { task: failing, drafting: f.components.draftingWorkspaces },
    })
    .sweep();
  await absent(f.binding!.repositories[0]!.workspacePath);
  assert.ok(await lstat(second));
  assert.ok(f.store().pendingCleanup().length);
  await f.runner().sweep();
  await absent(f.binding!.path);
  assert.equal(f.store().pendingCleanup().length, 0);
  f.assertDeleted();
});

test("failed Git retains the committed deletion and pending identity, then a healthy retry completes", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const failing = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(databaseOf(f.service)),
    f.roots.task,
    { gitExecutable: join(f.fixture.directory, "missing-git") },
  );
  await f
    .runner(undefined, {
      workspaces: { task: failing, drafting: f.components.draftingWorkspaces },
    })
    .sweep();
  f.assertDeleted();
  assert.ok(await lstat(f.binding!.path));
  assert.ok(f.store().pendingCleanup().length);
  await f.runner().sweep();
  await absent(f.binding!.path);
  assert.equal(f.store().pendingCleanup().length, 0);
});

for (const change of [
  "symlink",
  "replacement",
  "repository-replacement",
  "git-metadata-replacement",
  "new-binding",
] as const)
  test(`captured worktree cleanup refuses ${change} and preserves unrelated content`, async (t) => {
    const f = await deletedCleanupFixture(t, { workspaces: true });
    await f.commit();
    const path = f.binding!.path,
      repo = f.binding!.repositories[0]!,
      marker = join(f.fixture.directory, "unrelated");
    await mkdir(marker);
    await writeFile(join(marker, "keep"), "Unrelated checkout content");
    if (change === "symlink" || change === "replacement") {
      await rename(path, `${path}-retained`);
      if (change === "symlink") await symlink(marker, path, "dir");
      else {
        await mkdir(path);
        await writeFile(join(path, "keep"), "Replacement content");
      }
    } else if (change === "repository-replacement") {
      await rename(repo.workspacePath, `${repo.workspacePath}-retained`);
      await mkdir(repo.workspacePath);
      await writeFile(
        join(repo.workspacePath, "keep"),
        "Replacement repository",
      );
    } else if (change === "git-metadata-replacement") {
      await rename(repo.gitCommonDir!, `${repo.gitCommonDir!}-retained`);
      await mkdir(repo.gitCommonDir!);
    } else {
      const store = new SqliteWorkspaceBindingStore(databaseOf(f.service));
      assert.throws(
        () => store.createOrGet(f.blockerB, randomUUID(), path, []),
        /reserved/,
      );
      // Simulate a competing/legacy writer bypassing the supported reservation check.
      const now = new Date().toISOString();
      databaseOf(f.service)
        .prepare(
          "INSERT INTO task_workspace_bindings VALUES (?,?,?,'[]','ready',NULL,0,?,?)",
        )
        .run(f.blockerB, randomUUID(), path, now, now);
    }
    await f.runner().sweep();
    f.assertDeleted();
    assert.ok(f.store().pendingCleanup().length);
    assert.equal(
      await readFile(join(marker, "keep"), "utf8"),
      "Unrelated checkout content",
    );
    if (change === "replacement")
      assert.equal(
        await readFile(join(path, "keep"), "utf8"),
        "Replacement content",
      );
    if (change === "repository-replacement")
      assert.equal(
        await readFile(join(repo.workspacePath, "keep"), "utf8"),
        "Replacement repository",
      );
  });

for (const change of ["unsafe-mode", "symlink", "replacement"] as const)
  test(`captured Claude temporary cleanup refuses ${change} without discarding unrelated files`, async (t) => {
    const f = await deletedCleanupFixture(t, { workspaces: true, temp: true });
    await f.commit();
    const temp = f.temp!,
      unrelated = join(f.fixture.directory, "unrelated-temp");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "Keep");
    if (change === "unsafe-mode") await chmod(temp, 0o755);
    else {
      await rename(temp, `${temp}-retained`);
      t.after(() => rm(`${temp}-retained`, { recursive: true, force: true }));
      if (change === "symlink") await symlink(unrelated, temp, "dir");
      else {
        await mkdir(temp, { mode: 0o700 });
        await writeFile(join(temp, "keep"), "Replacement");
      }
    }
    await f.runner().sweep();
    f.assertDeleted();
    const status = f.store().status(f.projectId)!;
    assert.ok(
      status.cleanup.some(
        (item) => item.kind === "claude-temp" && item.state === "pending",
      ),
    );
    assert.equal(await readFile(join(unrelated, "keep"), "utf8"), "Keep");
    if (change === "replacement")
      assert.equal(await readFile(join(temp, "keep"), "utf8"), "Replacement");
  });

test("missing worktrees/temp converge and duplicate sweeps share one bounded pass", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true, temp: true });
  await f.commit();
  for (const repository of f.binding!.repositories)
    await cleanupGit(
      repository.sourcePath,
      "worktree",
      "remove",
      "--force",
      repository.workspacePath,
    );
  await rm(f.binding!.path, { recursive: true });
  await rm(f.temp!, { recursive: true });
  const runner = f.runner(),
    first = runner.sweep(),
    second = runner.sweep();
  assert.equal(first, second);
  await first;
  assert.equal(f.store().pendingCleanup().length, 0);
  f.assertDeleted();
});

test("a success followed by a lost checkpoint retries absence and prunes the captured payload", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  let interrupted = false;
  await f
    .runner(undefined, {
      afterEffect: async (item) => {
        if (item.kind === "workspace") {
          interrupted = true;
          throw new Error("Lost checkpoint");
        }
      },
    })
    .sweep();
  assert.ok(interrupted);
  await absent(f.binding!.path);
  assert.ok(f.store().pendingCleanup().length);
  await f.runner().sweep();
  assert.equal(f.store().pendingCleanup().length, 0);
  f.assertDeleted();
});

test("captured discard holds the existing task lock against concurrent normal workspace inspection", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const manager = f.components.workspaces;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((done) => {
      enter = done;
    }),
    gate = new Promise<void>((done) => {
      release = done;
    });
  t.after(() => release());
  // biome-ignore lint/complexity/useLiteralKeys: narrow fixture gate around the real Git seam
  const original = manager["capturedGit"].bind(manager);
  let first = true;
  // biome-ignore lint/complexity/useLiteralKeys: narrow fixture gate around the real Git seam
  manager["capturedGit"] = async (cwd, args) => {
    if (first) {
      first = false;
      enter();
      await gate;
    }
    return original(cwd, args);
  };
  const cleanup = f.runner().sweep();
  await entered;
  let inspected = false;
  const inspection = manager.get(f.taskId).then((binding) => {
    inspected = true;
    return binding;
  });
  await Promise.resolve();
  assert.equal(inspected, false);
  release();
  await cleanup;
  assert.equal(await inspection, undefined);
  assert.equal(inspected, true);
});

test("an older descriptor lacking Git identity proof remains pending rather than guessing permission", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const db = databaseOf(f.service),
    row = db
      .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId=?")
      .get(f.projectId)!;
  const cleanup = JSON.parse(String(row.cleanupJson)) as {
    items: { kind: string; captured?: { gitIdentities?: unknown } }[];
  };
  for (const item of cleanup.items)
    if (item.kind === "workspace" && item.captured)
      delete item.captured.gitIdentities;
  db.prepare(
    "UPDATE project_tombstones SET cleanupJson=? WHERE projectId=?",
  ).run(JSON.stringify(cleanup), f.projectId);
  await f.runner().sweep();
  assert.ok(await lstat(f.binding!.path));
  assert.ok(f.store().pendingCleanup().length);
  f.assertDeleted();
});

test("a Git-locked worktree remains pending until its existing lock is released", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const repo = f.binding!.repositories[0]!;
  await cleanupGit(repo.sourcePath, "worktree", "lock", repo.workspacePath);
  await f.runner().sweep();
  assert.ok(await lstat(repo.workspacePath));
  assert.ok(f.store().pendingCleanup().length);
  await cleanupGit(repo.sourcePath, "worktree", "unlock", repo.workspacePath);
  await f.runner().sweep();
  await absent(f.binding!.path);
  assert.equal(f.store().pendingCleanup().length, 0);
});

test("a new binding committed during async identity inspection prevents the physical operation", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const db = databaseOf(f.service),
    repo = f.binding!.repositories[0]!;
  let inserted = false;
  const manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    f.roots.task,
    {
      beforePathAccess: (path) => {
        if (path !== repo.workspacePath || inserted) return;
        inserted = true;
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO task_workspace_bindings VALUES (?,?,?,'[]','ready',NULL,0,?,?)",
        ).run(f.blockerB, randomUUID(), f.binding!.path, now, now);
      },
    },
  );
  await f
    .runner(undefined, {
      workspaces: { task: manager, drafting: f.components.draftingWorkspaces },
    })
    .sweep();
  assert.ok(inserted);
  assert.equal(
    await readFile(join(repo.workspacePath, "untracked.txt"), "utf8"),
    "Untracked work\n",
  );
  assert.ok(f.store().pendingCleanup().length);
  f.assertDeleted();
});

for (const owner of [
  "binding",
  "draft-binding",
  "sourcePath",
  "workspacePath",
  "gitCommonDir",
  "execution",
  "request",
  "admission",
  "repository-link",
] as const) {
  for (const location of ["exact", "descendant", "prefix-sibling"] as const) {
    test(`cleanup respects ${owner} ownership at ${location} removal boundary`, async (t) => {
      const f = await deletedCleanupFixture(t, { workspaces: true });
      await f.commit();
      const binding = f.binding!,
        db = databaseOf(f.service);
      const path =
        location === "exact"
          ? owner === "sourcePath"
            ? binding.repositories[0]!.workspacePath
            : binding.path
          : location === "descendant"
            ? join(binding.repositories[0]!.workspacePath, "subdir")
            : `${binding.path}-other/subdir`;
      if (owner === "sourcePath" && location !== "prefix-sibling") {
        await mkdir(path, { recursive: true });
        assert.equal(
          await cleanupGit(path, "rev-parse", "--show-toplevel"),
          binding.repositories[0]!.workspacePath,
        );
        await writeFile(join(path, "surviving-owner.txt"), "B source content");
      }
      if (owner === "binding") {
        db.prepare(
          "UPDATE task_workspace_bindings SET path=? WHERE taskId=?",
        ).run(path, f.taskB);
      } else if (owner === "draft-binding") {
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO drafting_workspace_bindings VALUES (?,?,?,'[]','ready',NULL,0,?,?)",
        ).run(f.blockerB, randomUUID(), path, now, now);
      } else if (owner === "request") {
        db.prepare("UPDATE turn_requests SET workspace=? WHERE workId=?").run(
          path,
          f.workB,
        );
      } else if (owner === "admission") {
        db.prepare(
          "INSERT INTO task_writer_admissions (workId,workspace) VALUES (?,?) ON CONFLICT(workId) DO UPDATE SET workspace=excluded.workspace",
        ).run(f.workB, path);
      } else if (owner === "execution") {
        db.prepare(
          "UPDATE execution_intents SET workspace=? WHERE workId=?",
        ).run(path, f.workB);
      } else if (owner === "repository-link") {
        db.prepare(
          "UPDATE project_repository_links SET links=? WHERE projectId=?",
        ).run(JSON.stringify([{ path }]), f.projectB);
      } else {
        const repositories = f.survivor!.repositories.map((repo) => ({
          ...repo,
          [owner]: path,
        }));
        db.prepare(
          "UPDATE task_workspace_bindings SET repositories=? WHERE taskId=?",
        ).run(JSON.stringify(repositories), f.taskB);
      }
      const before = await f.contents();
      assert.equal(
        capturedWorkspaceUnclaimed(db, binding),
        location === "prefix-sibling",
      );
      if (location !== "prefix-sibling") {
        await f.runner().sweep();
        assert.equal(
          await readFile(
            join(binding.repositories[0]!.workspacePath, "untracked.txt"),
            "utf8",
          ),
          "Untracked work\n",
        );
        assert.deepEqual(await f.contents(), before);
        if (owner === "sourcePath")
          assert.equal(
            await readFile(join(path, "surviving-owner.txt"), "utf8"),
            "B source content",
          );
        assert.ok(f.store().pendingCleanup().length);
      } else {
        await f.runner().sweep();
        await absent(binding.path);
        assert.deepEqual(await f.contents(), before);
        assert.equal(f.store().pendingCleanup().length, 0);
      }
      f.assertDeleted();
    });
  }
}

test("a source registered inside the removal tree during awaited Git inspection fences final mutation", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const db = databaseOf(f.service),
    manager = f.components.workspaces;
  const repo = f.binding!.repositories[0]!;
  const before = await f.contents();
  const source = join(repo.workspacePath, "subdir");
  await mkdir(source);
  assert.equal(
    await cleanupGit(source, "rev-parse", "--show-toplevel"),
    repo.workspacePath,
  );
  await writeFile(join(source, "surviving-owner.txt"), "B source content");
  // biome-ignore lint/complexity/useLiteralKeys: fixture intercepts the actual async identity seam
  const original = manager["capturedGit"].bind(manager);
  let registered = false;
  // biome-ignore lint/complexity/useLiteralKeys: fixture intercepts the actual async identity seam
  manager["capturedGit"] = async (cwd, args) => {
    const result = await original(cwd, args);
    if (!registered) {
      registered = true;
      const repositories = f.survivor!.repositories.map((r) => ({
        ...r,
        sourcePath: join(repo.workspacePath, "subdir"),
      }));
      db.prepare(
        "UPDATE task_workspace_bindings SET repositories=? WHERE taskId=?",
      ).run(JSON.stringify(repositories), f.taskB);
    }
    return result;
  };
  await f.runner().sweep();
  assert.ok(registered);
  assert.equal(
    await readFile(join(repo.workspacePath, "untracked.txt"), "utf8"),
    "Untracked work\n",
  );
  assert.deepEqual(await f.contents(), before);
  assert.equal(
    await readFile(join(source, "surviving-owner.txt"), "utf8"),
    "B source content",
  );
  assert.ok(f.store().pendingCleanup().length);
});

async function unobservedRemovalFixture(t: TestContext) {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  let release!: () => void,
    removals = 0,
    accepting = true;
  const settlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = f.components.workspaces;
  // biome-ignore lint/complexity/useLiteralKeys: install the trusted fake runner on the service-owned manager
  manager["options"].capturedGitRunner = async (options) => {
    if (!options.args.includes("remove")) return runGit(options);
    removals++;
    assert.equal(options.observeSettlement, true);
    assert.equal(
      removals,
      1,
      "an unsettled destructive effect must never be sent twice",
    );
    const item = f
      .store()
      .pendingCleanupProject(f.projectId)!
      .cleanup.items.find((i) => i.kind === "workspace")!;
    assert.equal(item.state, "pending");
    if (item.state === "pending")
      assert.ok(item.gitRemoval, "reservation is durable before dispatch");
    return {
      status: "interrupted",
      kind: "timed-out",
      spawned: true,
      childExitObserved: false,
      childExitSignal: null,
      settlement,
    };
  };
  const runner = f.runner(undefined, {
    workspaces: { task: manager, drafting: f.components.draftingWorkspaces },
    accepting: () => accepting,
  });
  const pendingWorkspace = () =>
    f
      .store()
      .pendingCleanupProject(f.projectId)!
      .cleanup.items.find((i) => i.kind === "workspace")!;
  t.after(() => {
    accepting = false;
    manager.cancelGitWork();
    release();
  });
  return {
    ...f,
    manager,
    runner,
    release,
    pendingWorkspace,
    removals: () => removals,
    stopAccepting: () => {
      accepting = false;
    },
  };
}

test("unobserved destructive Git retains its lock across repeated sweeps until positive exit and fenced convergence", async (t) => {
  const f = await unobservedRemovalFixture(t),
    before = await f.contents();
  const receipt = () =>
    databaseOf(f.service)
      .prepare(
        "SELECT commandKey,payloadHash,resultJson FROM project_tombstones WHERE projectId=?",
      )
      .get(f.projectId);
  const originalReceipt = receipt();
  await f.runner.sweep();
  assert.deepEqual(receipt(), originalReceipt);
  assert.equal(f.removals(), 1);
  const reserved = f.pendingWorkspace();
  assert.equal(reserved.state, "pending");
  if (reserved.state === "pending") assert.ok(reserved.gitRemoval);
  let inspected = false;
  const inspection = f.manager.get(f.taskId).then((binding) => {
    inspected = true;
    return binding;
  });
  await Promise.resolve();
  assert.equal(
    inspected,
    false,
    "the existing task lock survives the bounded unobserved result",
  );
  const repo = f.binding!.repositories[0]!;
  const refs = await cleanupGit(repo.sourcePath, "show-ref");
  const config = await readFile(join(repo.gitCommonDir!, "config"), "utf8");
  for (let i = 0; i < 3; i++) await f.runner.sweep();
  assert.equal(inspected, false);
  assert.equal(f.removals(), 1);
  assert.deepEqual(await f.contents(), before);
  assert.equal(await cleanupGit(repo.sourcePath, "show-ref"), refs);
  assert.equal(
    await readFile(join(repo.gitCommonDir!, "config"), "utf8"),
    config,
  );
  // Fake child applies its effect in this disposable tree, then supplies positive exit.
  await cleanupGit(
    repo.sourcePath,
    "worktree",
    "remove",
    "--force",
    repo.workspacePath,
  );
  await f.runner.sweep();
  assert.equal(
    f.pendingWorkspace().state,
    "pending",
    "absent worktree is not child-exit proof",
  );
  assert.equal(inspected, false);
  f.release();
  assert.equal(await inspection, undefined);
  await f.runner.sweep();
  await f.runner.sweep();
  await absent(f.binding!.path);
  assert.equal(f.removals(), 1);
  assert.equal(f.store().pendingCleanup().length, 0);
  assert.deepEqual(
    receipt(),
    originalReceipt,
    "cleanup uncertainty and settlement never replace the original deletion receipt",
  );
  assert.deepEqual(await f.contents(), before);
});

test("positive exit cannot clear an uncertain removal after a descendant owner appears", async (t) => {
  const f = await unobservedRemovalFixture(t),
    before = await f.contents();
  await f.runner.sweep();
  // biome-ignore lint/complexity/useLiteralKeys: exact owned operation settlement
  const operation = f.manager["inFlight"].get(f.taskId)!;
  const source = join(f.binding!.repositories[0]!.workspacePath, "subdir");
  await mkdir(source);
  assert.equal(
    await cleanupGit(source, "rev-parse", "--show-toplevel"),
    f.binding!.repositories[0]!.workspacePath,
  );
  await writeFile(join(source, "surviving-owner.txt"), "B source content");
  const db = databaseOf(f.service),
    repositories = f.survivor!.repositories.map((r) => ({
      ...r,
      sourcePath: join(f.binding!.repositories[0]!.workspacePath, "subdir"),
    }));
  db.prepare(
    "UPDATE task_workspace_bindings SET repositories=? WHERE taskId=?",
  ).run(JSON.stringify(repositories), f.taskB);
  const owner = db
    .prepare("SELECT * FROM task_workspace_bindings WHERE taskId=?")
    .get(f.taskB);
  f.release();
  await operation;
  await f.runner.sweep();
  const item = f.pendingWorkspace();
  assert.equal(item.state, "pending");
  if (item.state === "pending") assert.ok(item.gitRemoval);
  assert.equal(f.removals(), 1);
  assert.deepEqual(
    db
      .prepare("SELECT * FROM task_workspace_bindings WHERE taskId=?")
      .get(f.taskB),
    owner,
  );
  assert.deepEqual(await f.contents(), before);
  assert.equal(
    await readFile(join(source, "surviving-owner.txt"), "utf8"),
    "B source content",
  );
  assert.equal(
    await readFile(
      join(f.binding!.repositories[0]!.workspacePath, "untracked.txt"),
      "utf8",
    ),
    "Untracked work\n",
  );
});

test("shutdown does not wait for an unobserved child and late exit cannot touch a closed database", async (t) => {
  const f = await unobservedRemovalFixture(t);
  await f.runner.sweep();
  // biome-ignore lint/complexity/useLiteralKeys: exact owned operation settlement
  const operation = f.manager["inFlight"].get(f.taskId)!;
  f.stopAccepting();
  f.manager.cancelGitWork();
  // These complete while the fake child is still deliberately unresolved.
  await Promise.all([f.manager.settle(), f.runner.settle()]);
  const checkpoint = t.mock.method(
    ProjectTombstones.prototype,
    "checkpointWorkspaceRemovalWithinTransaction",
  );
  await f.service.stop();
  assert.equal(f.db.isOpen, false);
  const before = checkpoint.mock.callCount();
  f.release();
  await operation;
  assert.equal(
    checkpoint.mock.callCount(),
    before,
    "late callback must not checkpoint or start new work",
  );
  assert.equal(f.removals(), 1);
});

test("restart without child proof remains read-only even when the captured removal paths are absent", async (t) => {
  const f = await unobservedRemovalFixture(t),
    before = await f.contents();
  await f.runner.sweep();
  // biome-ignore lint/complexity/useLiteralKeys: exact owned operation settlement
  const operation = f.manager["inFlight"].get(f.taskId)!;
  const repo = f.binding!.repositories[0]!;
  await cleanupGit(
    repo.sourcePath,
    "worktree",
    "remove",
    "--force",
    repo.workspacePath,
  );
  await rm(f.binding!.path, { recursive: true });
  f.stopAccepting();
  f.manager.cancelGitWork();
  await Promise.all([f.manager.settle(), f.runner.settle()]);
  await f.service.stop();
  await f.service.start();
  const restarted = startedOf(f.service).projectDeletionCleanup;
  await restarted.sweep();
  await restarted.sweep();
  f.release();
  await operation;
  await restarted.sweep();
  const item = f.pendingWorkspace();
  assert.equal(item.state, "pending");
  if (item.state === "pending") assert.ok(item.gitRemoval);
  assert.equal(f.removals(), 1);
  assert.deepEqual(await f.contents(), before);
  f.assertDeleted();
});

test("a failed write-ahead reservation prevents destructive Git dispatch", async (t) => {
  const f = await deletedCleanupFixture(t, { workspaces: true });
  await f.commit();
  const db = databaseOf(f.service);
  db.exec(
    "CREATE TEMP TRIGGER refuse_cleanup_checkpoint BEFORE UPDATE OF cleanupJson ON project_tombstones BEGIN SELECT RAISE(ABORT,'injected reservation failure'); END",
  );
  let removals = 0;
  const manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    f.roots.task,
    {
      capturedGitRunner: async (options) => {
        if (options.args.includes("remove")) removals++;
        return runGit(options);
      },
    },
  );
  await f
    .runner(undefined, {
      workspaces: { task: manager, drafting: f.components.draftingWorkspaces },
    })
    .sweep();
  assert.equal(removals, 0);
  assert.ok(await lstat(f.binding!.path));
  f.assertDeleted();
  db.exec("DROP TRIGGER refuse_cleanup_checkpoint");
  await f.runner().sweep();
  await absent(f.binding!.path);
});

for (const invalid of [
  "legacy-unknown",
  "wrong-digest",
  "wrong-repository",
  "extra-field",
] as const) {
  test(`cleanup preserves ${invalid} reservation without guessing effect settlement`, async (t) => {
    const f = await deletedCleanupFixture(t, { workspaces: true });
    await f.commit();
    const db = databaseOf(f.service),
      row = db
        .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId=?")
        .get(f.projectId)!;
    const cleanup = JSON.parse(String(row.cleanupJson)) as {
      items: Record<string, unknown>[];
    };
    const item = cleanup.items.find((i) => i.kind === "workspace")!;
    item.reason = "unknown";
    if (invalid !== "legacy-unknown")
      item.gitRemoval = {
        repositoryId:
          invalid === "wrong-repository"
            ? "foreign-repository"
            : f.binding!.repositories[0]!.repositoryId,
        capturedDigest:
          invalid === "wrong-digest"
            ? "0".repeat(64)
            : materialDigest(item.captured),
        ...(invalid === "extra-field" ? { unsafeExtra: true } : {}),
      };
    const retained = JSON.stringify(cleanup);
    db.prepare(
      "UPDATE project_tombstones SET cleanupJson=? WHERE projectId=?",
    ).run(retained, f.projectId);
    await f.runner().sweep();
    assert.equal(
      db
        .prepare("SELECT cleanupJson FROM project_tombstones WHERE projectId=?")
        .get(f.projectId)!.cleanupJson,
      retained,
    );
    assert.ok(await lstat(f.binding!.path));
    f.assertDeleted();
  });
}
