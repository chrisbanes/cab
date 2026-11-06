import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createOperatorFixture } from "./operator-web.js";
import { seedReviewTask } from "./task-review.js";

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

/**
 * One task bound to a repository whose Branch comparison against `main` is two files:
 * guide.md (+2 -1) and notes.md (+1), with a result that names them.
 */
export async function seedChangedTask(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
) {
  const source = join(f.directory, "src-alpha");
  mkdirSync(source, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", source]);
  git(source, "config", "user.name", "Inspect Changes Test");
  git(source, "config", "user.email", "inspect-changes@example.invalid");
  writeFileSync(join(source, "guide.md"), "one\ntwo\nthree\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "base");
  const task = await seedReviewTask(
    f,
    "Inspect project",
    "Inspect task",
    "Body",
    [{ repositoryId: "repo-alpha", path: source, ref: "main" }],
  );
  const binding = await f.service.taskWorkspace(task.taskId);
  const workspace = binding?.repositories[0]?.workspacePath;
  assert.ok(workspace);
  writeFileSync(join(workspace, "guide.md"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(workspace, "notes.md"), "new\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "--quiet", "-m", "change");
  task.result("Inspect result summary", {
    sourceId: task.source.sourceId,
    changes: {
      files: ["guide.md", "notes.md"],
      commits: [],
      findings: [],
      diff: "",
    },
  });
  return task;
}
