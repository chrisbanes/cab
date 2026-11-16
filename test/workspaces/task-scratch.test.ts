import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../../src/core/store.js";
import {
  SqliteWorkspaceBindingStore,
  taskScratchPath,
  WorkspaceManager,
} from "../../src/standalone/workspaces.js";
import { tmpdir } from "../fixtures/temp.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cab-task-scratch-"));
  const db = new DatabaseSync(join(root, "standalone.sqlite"));
  new Store(db).ensureHost("task-scratch-test");
  const manager = new WorkspaceManager(
    new SqliteWorkspaceBindingStore(db),
    join(root, "task-workspaces"),
  );
  return {
    root,
    manager,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function repository(root: string): string {
  const path = join(root, "source");
  mkdirSync(path);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.name", "Scratch Test");
  git("config", "user.email", "scratch-test@example.invalid");
  writeFileSync(join(path, "README.md"), "scratch\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "initial");
  return path;
}

test("provisioning creates a private task scratch and repeated admission keeps its contents", async () => {
  const f = fixture();
  try {
    const source = repository(f.root);
    for (const [taskId, repositories] of [
      ["repository-free", []],
      ["with-repository", [{ repositoryId: "repo", path: source }]],
    ] as const) {
      const binding = await f.manager.provision(taskId, [...repositories]);
      assert.equal(binding.state, "ready");
      const scratch = taskScratchPath(binding.path);
      assert.equal(scratch, join(binding.path, "scratch"));
      const info = lstatSync(scratch);
      assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.equal(info.mode & 0o777, 0o700);
      writeFileSync(join(scratch, "kept.txt"), "kept");
      for (let i = 0; i < 2; i++)
        assert.equal((await f.manager.forExecution(taskId)).state, "ready");
      assert.equal(readFileSync(join(scratch, "kept.txt"), "utf8"), "kept");
    }
  } finally {
    f.close();
  }
});

test("a workspace provisioned before task scratch gets it at admission", async () => {
  const f = fixture();
  try {
    const binding = await f.manager.provision("legacy");
    rmSync(taskScratchPath(binding.path), { recursive: true });
    await f.manager.forExecution("legacy");
    assert.ok(statSync(taskScratchPath(binding.path)).isDirectory());
  } finally {
    f.close();
  }
});

test("an occupied scratch path refuses admission and keeps what is there", async () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "outside");
    for (const [taskId, occupy] of [
      ["symlink", (scratch: string) => symlinkSync(outside, scratch, "dir")],
      ["file", (scratch: string) => writeFileSync(scratch, "file contents")],
    ] as const) {
      const binding = await f.manager.provision(taskId);
      const scratch = taskScratchPath(binding.path);
      rmSync(scratch, { recursive: true });
      occupy(scratch);
      await assert.rejects(
        f.manager.forExecution(taskId),
        /Task scratch path is not a real directory/,
      );
      if (taskId === "symlink") assert.equal(readlinkSync(scratch), outside);
      else assert.equal(readFileSync(scratch, "utf8"), "file contents");
    }
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside");
  } finally {
    f.close();
  }
});
