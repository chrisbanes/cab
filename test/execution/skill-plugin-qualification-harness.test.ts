import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const directory = resolve("test/execution/skill-plugin-qualification");
const load = (file: string) =>
  import(pathToFileURL(join(directory, file)).href);
const harness = () =>
  import(
    pathToFileURL(resolve("test/execution/claude-qualification/harness.mjs"))
      .href
  );
const probeRoots = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("cab-claude-c0-"));

test("skill-plugin driver refuses anything but the exact live grammar and creates nothing", () => {
  const before = probeRoots();
  for (const args of [
    [],
    ["q1"],
    ["--live"],
    ["--live", "bogus"],
    ["--live", "q1"],
    ["--live", "init", "--root", "/tmp"],
    ["summary"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(directory, "run.mjs"), ...args],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Refusing skill-plugin probes/);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(probeRoots(), before);
});

test("plugin fixture declares a skill, hook and MCP server inside the root, and omits them on request", async (t) => {
  const { createRoot } = await harness();
  const { writePluginFixture, PLUGIN_NAME, SKILL_NAME } =
    await load("fixture.mjs");
  const root = createRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const full = writePluginFixture(root, { nonce: "n1" });
  const bare = writePluginFixture(root, {
    dir: "bare",
    nonce: "n1",
    hooks: false,
    mcp: false,
  });
  for (const path of [
    join(full.dir, ".claude-plugin", "plugin.json"),
    join(full.dir, "skills", SKILL_NAME, "SKILL.md"),
    full.script,
    join(full.dir, "hooks", "hooks.json"),
    join(full.dir, ".mcp.json"),
  ])
    assert.ok(existsSync(path), path);
  for (const path of Object.values(full))
    assert.ok(String(path).startsWith(root), String(path));
  assert.equal(
    JSON.parse(
      readFileSync(join(full.dir, ".claude-plugin", "plugin.json"), "utf8"),
    ).name,
    PLUGIN_NAME,
  );
  assert.match(
    readFileSync(join(full.dir, "hooks", "hooks.json"), "utf8"),
    /PreToolUse/,
  );
  assert.ok(existsSync(join(bare.dir, "skills", SKILL_NAME, "SKILL.md")));
  assert.equal(existsSync(join(bare.dir, "hooks")), false);
  assert.equal(existsSync(join(bare.dir, ".mcp.json")), false);
});

test("probe facets cover every ADR-1021 question once", async () => {
  const { facetIds } = await load("claude-probes.mjs");
  assert.deepEqual([...facetIds].sort(), [
    "F1.1",
    "F1.2",
    "F1.3",
    "F1.4",
    "F2.1",
    "F2.2",
    "F3.1",
    "F3.2",
    "F3.3",
    "F3.4",
  ]);
});
