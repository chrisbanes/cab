import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../../src/core/store.js";
import { tmpdir } from "../fixtures/temp.js";
import {
  SqliteWorkspaceBindingStore,
  WorkspaceManager,
} from "../../src/standalone/workspaces.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("a drafting workspace is discarded even with written files, apart from task workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-drafting-workspace-"));
  const db = new DatabaseSync(join(root, "standalone.sqlite"));
  new Store(db).ensureHost("drafting-workspace-test");
  try {
    const source = join(root, "source");
    mkdirSync(source);
    execFileSync("git", ["init", "--quiet", source]);
    git(source, "config", "user.name", "Drafting Test");
    git(source, "config", "user.email", "drafting-test@example.invalid");
    writeFileSync(join(source, "README.md"), "hello\n");
    git(source, "add", "README.md");
    git(source, "commit", "--quiet", "-m", "initial");
    const commit = git(source, "rev-parse", "HEAD");

    const taskBindings = new SqliteWorkspaceBindingStore(db);
    const draftingBindings = new SqliteWorkspaceBindingStore(
      db,
      "drafting_workspace_bindings",
    );
    const manager = new WorkspaceManager(
      draftingBindings,
      join(root, "drafting-workspaces"),
    );
    const binding = await manager.provision("run-1", [
      { repositoryId: "repo", path: source, ref: "HEAD" },
    ]);
    assert.equal(binding.state, "ready");
    assert.equal(draftingBindings.unarchived().length, 1);
    const worktree = binding.repositories[0]?.workspacePath as string;
    assert.equal(git(worktree, "rev-parse", "HEAD"), commit);
    writeFileSync(join(worktree, "scratch.txt"), "untracked\n");
    writeFileSync(join(worktree, "README.md"), "edited\n");

    const discarded = await manager.discard("run-1");
    assert.equal(discarded?.state, "archived");
    assert.equal(existsSync(binding.path), false);
    assert.equal(
      git(source, "worktree", "list", "--porcelain").includes(worktree),
      false,
    );
    assert.deepEqual(taskBindings.list(), []);
    assert.equal(
      await manager.discard("run-1").then((value) => value?.state),
      "archived",
    );
    assert.equal(await manager.discard("never-provisioned"), undefined);
    // Archived rows stay recorded but are not listed as copies that may still exist.
    assert.deepEqual(draftingBindings.unarchived(), []);
    assert.equal(draftingBindings.list().length, 1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
