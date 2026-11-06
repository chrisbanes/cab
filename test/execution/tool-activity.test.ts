import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "../fixtures/temp.js";
import {
  changedPaths,
  claudeToolTarget,
  relativeToWorkspace,
  workspaceRoots,
} from "../../src/standalone/tool-activity.js";

const outside = "outside workspace";
const roots = ["/w"];

test("paths are relative to the workspace or masked", () => {
  assert.equal(relativeToWorkspace(roots, "/w/src/a.ts"), "src/a.ts");
  assert.equal(relativeToWorkspace(roots, "/w/src/../b.ts"), "b.ts");
  assert.equal(relativeToWorkspace(roots, "src/a.ts"), "src/a.ts");
  assert.equal(relativeToWorkspace(roots, "/w/../etc/x"), outside);
  assert.equal(relativeToWorkspace(roots, "../x"), outside);
  assert.equal(relativeToWorkspace(roots, "/w2/a.ts"), outside);
  assert.equal(relativeToWorkspace(roots, "/etc/x"), outside);
  assert.equal(relativeToWorkspace([], "a"), outside);
});

test("a path under the real path of a symlinked root is relative", () => {
  const dir = mkdtempSync(join(tmpdir(), "roots-"));
  try {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const resolved = workspaceRoots(join(dir, "link"));
    assert.equal(relativeToWorkspace(resolved, join(dir, "real", "a")), "a");
    assert.equal(relativeToWorkspace(resolved, join(dir, "link", "a")), "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changed paths are capped and flagged", () => {
  const many = Array.from({ length: 26 }, (_, i) => `/w/f${i}`);
  const capped = changedPaths(roots, many);
  assert.equal(capped.paths.length, 25);
  assert.equal(capped.truncated, true);
  const long = changedPaths(roots, ["/w/ok", `/w/${"a".repeat(257)}`]);
  assert.deepEqual(long, { paths: ["ok"], truncated: true });
  assert.deepEqual(changedPaths(roots, ["/etc/x", "/w/a"]), {
    paths: [outside, "a"],
    truncated: false,
  });
});

test("only allowlisted Claude tools have a target", () => {
  const t = (name: string, input: unknown) =>
    claudeToolTarget(roots, name, input);
  assert.equal(t("Read", { file_path: "/w/a.ts" }), "a.ts");
  assert.equal(t("Write", { file_path: "/etc/x" }), outside);
  assert.equal(t("Edit", { file_path: "/w/b.ts", new_string: "S" }), "b.ts");
  assert.equal(t("Grep", { pattern: "foo.*" }), "foo.*");
  assert.equal(t("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(t("Agent", { subagent_type: "explore" }), "explore");
  assert.equal(t("mcp__srv__t", {}), "srv/t");
  assert.equal(t("Grep", { pattern: "x".repeat(513) }), undefined);
  assert.equal(t("Bash", { command: "ls" }), undefined);
  assert.equal(t("Skill", { skill: "s" }), undefined);
  assert.equal(t("mcp__cab__x", {}), undefined);
  assert.equal(t("cab_x", {}), undefined);
  assert.equal(t("Read", null), undefined);
});
