import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  digestPlugin,
  loadProfilePlugins,
  maxPluginFiles,
  readPlugin,
  skillFieldErrors,
  SkillPluginError,
} from "../../src/standalone/skill-plugins.js";
import {
  writeNestedSkillPlugin,
  writeSkillPlugin,
} from "../fixtures/skill-plugin.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cab-skill-plugins-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a plugin digest is stable, changes with any file of an enabled skill, and ignores timestamps", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a", "b"]);
    const first = await digestPlugin(plugin, ["a"]);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await digestPlugin(plugin, ["a"]), first);
    // The same tree through an aliased path has the same digest.
    assert.equal(await digestPlugin(`${plugin}/.`, ["a"]), first);
    assert.equal(await digestPlugin(`${plugin}//`, ["a"]), first);
    const skill = join(plugin, "skills", "a", "SKILL.md");
    writeFileSync(skill, "---\nname: a\n---\nchanged\n");
    const changed = await digestPlugin(plugin, ["a"]);
    assert.notEqual(changed, first);
    // An added or renamed file also changes it.
    writeFileSync(join(plugin, "skills", "a", "extra.sh"), "x");
    assert.notEqual(await digestPlugin(plugin, ["a"]), changed);
    // Same bytes in a copy at another path hash the same.
    const copy = writeSkillPlugin(join(s.root, "q"), ["a", "b"]);
    writeFileSync(
      join(copy, "skills", "a", "SKILL.md"),
      "---\nname: a\n---\nchanged\n",
    );
    writeFileSync(join(copy, "skills", "a", "extra.sh"), "x");
    assert.equal(
      await digestPlugin(copy, ["a"]),
      await digestPlugin(plugin, ["a"]),
    );
    // Enabling another skill widens the scope.
    assert.notEqual(
      await digestPlugin(plugin, ["a", "b"]),
      await digestPlugin(plugin, ["a"]),
    );
  } finally {
    s.done();
  }
});

test("only the manifests and the enabled skills are in the load scope", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a", "b"]);
    const before = await digestPlugin(plugin, ["a"]);
    // A large non-skill tree, with links that escape it, is outside the scope.
    const modules = join(plugin, "node_modules", "dep");
    mkdirSync(modules, { recursive: true });
    mkdirSync(join(plugin, "node_modules", ".bin"));
    for (let i = 0; i <= maxPluginFiles; i++)
      writeFileSync(join(modules, `f${i}`), "x");
    symlinkSync("/etc/hosts", join(plugin, "node_modules", ".bin", "out"));
    writeFileSync(join(plugin, "skills", "b", "SKILL.md"), "changed\n");
    assert.equal(await digestPlugin(plugin, ["a"]), before);
    writeFileSync(join(modules, "f0"), "changed");
    assert.equal(await digestPlugin(plugin, ["a"]), before);
    // The manifest is in it.
    writeFileSync(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "unit-plugin", version: "0.0.2" }),
    );
    assert.notEqual(await digestPlugin(plugin, ["a"]), before);
  } finally {
    s.done();
  }
});

test("links inside the plugin are followed, and an escaping link, a special file or too many files is refused", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a"]);
    const dir = join(plugin, "skills", "a");
    writeFileSync(join(plugin, "CLAUDE.md"), "shared\n");
    symlinkSync("../../CLAUDE.md", join(dir, "AGENTS.md"));
    mkdirSync(join(plugin, "shared"));
    writeFileSync(join(plugin, "shared", "lib.sh"), "echo\n");
    symlinkSync("../../shared", join(dir, "shared"));
    const linked = await digestPlugin(plugin, ["a"]);
    // A followed link hashes its target's content.
    writeFileSync(join(plugin, "shared", "lib.sh"), "echo changed\n");
    assert.notEqual(await digestPlugin(plugin, ["a"]), linked);
    symlinkSync("/etc/hosts", join(dir, "outside"));
    await assert.rejects(digestPlugin(plugin, ["a"]), /outside the plugin/);
    rmSync(join(dir, "outside"));
    symlinkSync(s.root, join(dir, "parent"));
    await assert.rejects(digestPlugin(plugin, ["a"]), /outside the plugin/);
    rmSync(join(dir, "parent"));
    const big = join(dir, "many");
    mkdirSync(big);
    for (let i = 0; i <= maxPluginFiles; i++)
      writeFileSync(join(big, `f${i}`), "");
    await assert.rejects(digestPlugin(plugin, ["a"]), /too large/);
    await assert.rejects(
      digestPlugin(join(s.root, "absent"), ["a"]),
      SkillPluginError,
    );
  } finally {
    s.done();
  }
});

test("skills are discovered from the Claude manifest, the Codex manifest and the flat scan, named by frontmatter or directory", async () => {
  const s = sandbox();
  try {
    const nested = writeNestedSkillPlugin(join(s.root, "nested"), {
      engineering: ["tdd", "review"],
      productivity: ["grilling"],
    });
    // A skill outside the manifest's list and the flat scan is not loaded, as in the CLI.
    mkdirSync(join(nested, "skills", "misc", "unlisted", "deeper"), {
      recursive: true,
    });
    writeFileSync(
      join(nested, "skills", "misc", "unlisted", "deeper", "SKILL.md"),
      "no frontmatter\n",
    );
    const claudeOnly = writeNestedSkillPlugin(
      join(s.root, "claude-only"),
      { engineering: ["tdd"], misc: [] },
      { codex: false },
    );
    mkdirSync(join(claudeOnly, "skills", "misc", "unlisted"), {
      recursive: true,
    });
    writeFileSync(
      join(claudeOnly, "skills", "misc", "unlisted", "SKILL.md"),
      "x\n",
    );
    const claude = await readPlugin(claudeOnly);
    assert.deepEqual([...(claude?.skills.keys() ?? [])], ["tdd"]);
    assert.equal(claude?.claude, true);
    // The Codex manifest's directory is scanned deep; a skill without frontmatter is named by its directory.
    const both = await readPlugin(nested);
    assert.deepEqual([...(both?.skills.keys() ?? [])].sort(), [
      "deeper",
      "grilling",
      "review",
      "tdd",
    ]);
    // A Codex-only plugin is read, and named by its Codex manifest.
    const codexOnly = writeNestedSkillPlugin(
      join(s.root, "codex-only"),
      { engineering: ["tdd"] },
      { name: "codex-plugin", claude: false },
    );
    const codex = await readPlugin(codexOnly);
    assert.equal(codex?.name, "codex-plugin");
    assert.equal(codex?.claude, false);
    // A frontmatter name differs from its directory.
    writeFileSync(
      join(nested, "skills", "engineering", "review", "SKILL.md"),
      "---\nname: 'code-review'\n---\n",
    );
    assert.ok((await readPlugin(nested))?.skills.has("code-review"));
    // YAML scalar rules: an inline comment is not part of a plain or quoted name.
    writeFileSync(
      join(nested, "skills", "engineering", "review", "SKILL.md"),
      "---\nname: review-a # renamed\n---\n",
    );
    writeFileSync(
      join(nested, "skills", "engineering", "tdd", "SKILL.md"),
      '---\nname: "tdd-b" # quoted\n---\n',
    );
    const commented = await readPlugin(nested);
    assert.ok(commented?.skills.has("review-a"));
    assert.ok(commented?.skills.has("tdd-b"));
    assert.equal(await readPlugin(join(s.root, "absent")), undefined);
  } finally {
    s.done();
  }
});

test("a manifest reached through a link is read only when the link stays inside the plugin", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a"]);
    const outside = join(s.root, "outside-manifest");
    renameSync(join(plugin, ".claude-plugin"), outside);
    symlinkSync(outside, join(plugin, ".claude-plugin"));
    assert.equal(await readPlugin(plugin), undefined);
    assert.deepEqual(
      await skillFieldErrors(
        { plugins: [{ path: plugin, skills: ["a"] }] },
        "claude",
      ),
      ["skills.plugins.0.path"],
    );
    rmSync(join(plugin, ".claude-plugin"));
    renameSync(outside, join(plugin, "meta"));
    symlinkSync("meta", join(plugin, ".claude-plugin"));
    assert.equal((await readPlugin(plugin))?.name, "unit-plugin");
    assert.match(await digestPlugin(plugin, ["a"]), /^[a-f0-9]{64}$/);
  } finally {
    s.done();
  }
});

test("skill fields name missing, duplicate and Claude-incompatible plugins, and loading never names a path", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a"]);
    const bare = join(s.root, "bare");
    mkdirSync(bare);
    assert.deepEqual(
      await skillFieldErrors(
        {
          plugins: [
            { path: plugin, skills: ["a", "missing"] },
            { path: bare, skills: ["a"] },
            { path: join(s.root, "absent"), skills: ["a"] },
          ],
        },
        "codex",
      ),
      [
        "skills.plugins.0.skills.1",
        "skills.plugins.1.path",
        "skills.plugins.2.path",
      ],
    );
    assert.deepEqual(
      await skillFieldErrors(
        { plugins: [{ path: plugin, skills: ["a"] }] },
        "claude",
      ),
      [],
    );
    // Two skills of one plugin with the same name: the enabled one is refused.
    const duplicate = writeNestedSkillPlugin(join(s.root, "dup"), {
      engineering: ["tdd", "other"],
      productivity: ["tdd"],
    });
    assert.deepEqual(
      await skillFieldErrors(
        { plugins: [{ path: duplicate, skills: ["other", "tdd"] }] },
        "codex",
      ),
      ["skills.plugins.0.skills.1"],
    );
    await assert.rejects(
      loadProfilePlugins(
        { plugins: [{ path: duplicate, skills: ["tdd"] }] },
        "codex",
      ),
      /more than one skill named tdd/,
    );
    // A nested skill reached only through the Codex manifest is not one the Claude CLI loads.
    const codexReached = writeNestedSkillPlugin(
      join(s.root, "codex-reached"),
      { engineering: ["deep"] },
      { name: "both" },
    );
    writeFileSync(
      join(codexReached, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "both" }),
    );
    const reached = { plugins: [{ path: codexReached, skills: ["deep"] }] };
    assert.deepEqual(await skillFieldErrors(reached, "codex"), []);
    assert.deepEqual(await skillFieldErrors(reached, "claude"), [
      "skills.plugins.0.skills.0",
    ]);
    await assert.rejects(
      loadProfilePlugins(reached, "claude"),
      /Skill plugin 1 cannot be loaded: has no skill named deep/,
    );
    // A Codex-only plugin serves Codex profiles only.
    const codexOnly = writeNestedSkillPlugin(
      join(s.root, "codex-only"),
      { engineering: ["tdd"] },
      { name: "codex-plugin", claude: false },
    );
    const codexSkills = { plugins: [{ path: codexOnly, skills: ["tdd"] }] };
    assert.deepEqual(await skillFieldErrors(codexSkills, "codex"), []);
    assert.deepEqual(await skillFieldErrors(codexSkills, "claude"), [
      "skills.plugins.0.path",
    ]);
    assert.equal(
      (await loadProfilePlugins(codexSkills, "codex"))[0]?.name,
      "codex-plugin",
    );
    await assert.rejects(
      loadProfilePlugins(codexSkills, "claude"),
      (error) =>
        error instanceof SkillPluginError &&
        !error.message.includes(s.root) &&
        /codex-plugin has no Claude plugin manifest/.test(error.message),
    );
    await assert.rejects(
      loadProfilePlugins({ plugins: [{ path: bare, skills: ["a"] }] }, "codex"),
      (error) =>
        error instanceof SkillPluginError &&
        !error.message.includes(s.root) &&
        /Skill plugin 1/.test(error.message),
    );
    const loaded = await loadProfilePlugins(
      { plugins: [{ path: plugin, skills: ["a"] }] },
      "claude",
    );
    assert.equal(loaded[0]?.name, "unit-plugin");
    assert.equal(loaded[0]?.digest, await digestPlugin(plugin, ["a"]));
  } finally {
    s.done();
  }
});
