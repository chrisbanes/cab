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
import { test } from "node:test";
import {
  WorkspaceManager,
  SqliteWorkspaceBindingStore,
} from "../../src/standalone/workspaces.js";
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
