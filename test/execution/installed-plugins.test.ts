import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { profileSkillsSchema } from "../../src/core/execution-runtime.js";
import {
  InstalledPluginError,
  resolveInstalledPlugin,
} from "../../src/standalone/installed-plugins.js";
import {
  digestPlugin,
  listInstalledPlugins,
  loadProfilePlugins,
  skillFieldErrors,
} from "../../src/standalone/skill-plugins.js";
import { installedPluginHomes } from "../fixtures/installed-plugins.js";
import {
  writeNestedSkillPlugin,
  writeSkillPlugin,
} from "../fixtures/skill-plugin.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cab-installed-plugins-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** The resolver's reason, which must name the plugin and no path below `root`. */
async function reason(
  ref: `claude:${string}` | `codex:${string}`,
  environment: NodeJS.ProcessEnv,
  root: string,
): Promise<string> {
  try {
    await resolveInstalledPlugin(ref, environment);
  } catch (error) {
    assert.ok(error instanceof InstalledPluginError);
    assert.ok(error.message.includes(ref), error.message);
    assert.ok(!error.message.includes(root), error.message);
    assert.ok(!error.message.includes("/"), error.message);
    return error.message;
  }
  assert.fail(`${ref} resolved`);
}

test("a Claude Code plugin resolves through its enabled user-scope install record, and fails closed otherwise", async () => {
  const s = sandbox();
  try {
    const homes = installedPluginHomes(s.root);
    const env = homes.environment;
    const directory = homes.installClaude("demo@m");
    assert.equal(await resolveInstalledPlugin("claude:demo@m", env), directory);
    // An update repoints the record; the old directory stays, as Claude Code leaves it.
    const updated = homes.installClaude("demo@m", { version: "1.1.0" });
    assert.equal(await resolveInstalledPlugin("claude:demo@m", env), updated);

    homes.setClaudeEnabled("demo@m", false);
    assert.equal(
      await reason("claude:demo@m", env, s.root),
      "Skill plugin claude:demo@m is disabled in Claude Code",
    );
    homes.setClaudeEnabled("demo@m", true);
    assert.equal(
      await reason("claude:other@m", env, s.root),
      "Skill plugin claude:other@m is not installed in Claude Code",
    );

    // Project and local installs belong to a repository's settings: only user scope counts.
    homes.installClaude("demo@m", {
      extra: [
        {
          scope: "project",
          installPath: join(s.root, "project"),
          projectPath: "/r",
        },
      ],
    });
    assert.equal(await resolveInstalledPlugin("claude:demo@m", env), directory);
    const record = join(homes.claudeHome, "plugins", "installed_plugins.json");
    writeFileSync(
      record,
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@m": [{ scope: "project", installPath: directory }],
        },
      }),
    );
    assert.match(
      await reason("claude:demo@m", env, s.root),
      /is not installed in Claude Code$/,
    );
    writeFileSync(
      record,
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@m": [
            { scope: "user", installPath: directory },
            { scope: "user", installPath: updated },
          ],
        },
      }),
    );
    assert.match(
      await reason("claude:demo@m", env, s.root),
      /has more than one installed version in Claude Code$/,
    );
    for (const text of [
      JSON.stringify({ version: 3, plugins: {} }),
      JSON.stringify({
        version: 2,
        plugins: { "demo@m": [{ scope: "user", installPath: "relative" }] },
      }),
      JSON.stringify({ version: 2, plugins: { "demo@m": "x" } }),
      "{not json",
    ]) {
      writeFileSync(record, text);
      assert.match(
        await reason("claude:demo@m", env, s.root),
        /has an unrecognised install record in Claude Code$/,
        text,
      );
    }
    rmSync(record);
    assert.match(
      await reason("claude:demo@m", env, s.root),
      /is not installed in Claude Code$/,
    );
  } finally {
    s.done();
  }
});

test("a Codex plugin resolves to its single enabled version directory, and fails closed otherwise", async () => {
  const s = sandbox();
  try {
    const homes = installedPluginHomes(s.root);
    const env = homes.environment;
    const directory = homes.installCodex("demo@m");
    // Codex's in-progress installs and dot-entries are not versions.
    const cache = join(homes.codexHome, "plugins", "cache", "m", "demo");
    mkdirSync(join(cache, "plugin-install-x1"));
    writeFileSync(join(cache, ".DS_Store"), "");
    mkdirSync(join(cache, ".tmp"));
    assert.equal(await resolveInstalledPlugin("codex:demo@m", env), directory);

    homes.installCodex("demo@m", { version: "1.1.0", keepOld: true });
    assert.equal(
      await reason("codex:demo@m", env, s.root),
      "Skill plugin codex:demo@m has more than one installed version in Codex",
    );
    const updated = homes.installCodex("demo@m", { version: "1.1.0" });
    assert.equal(await resolveInstalledPlugin("codex:demo@m", env), updated);

    homes.setCodexEnabled("demo@m", false);
    assert.equal(
      await reason("codex:demo@m", env, s.root),
      "Skill plugin codex:demo@m is disabled in Codex",
    );
    assert.equal(
      await reason("codex:other@m", env, s.root),
      "Skill plugin codex:other@m is not installed in Codex",
    );
    const config = join(homes.codexHome, "config.toml");
    // TOML spellings a line matcher would miss are read as TOML.
    writeFileSync(config, 'plugins = { "demo@m" = { enabled = true } }\n');
    assert.equal(await resolveInstalledPlugin("codex:demo@m", env), updated);
    writeFileSync(config, '[plugins]\n"demo@m".enabled = false\n');
    assert.match(
      await reason("codex:demo@m", env, s.root),
      /is disabled in Codex$/,
    );
    writeFileSync(config, 'model = "x"\n');
    assert.match(
      await reason("codex:demo@m", env, s.root),
      /is disabled in Codex$/,
    );
    for (const text of [
      '[plugins."demo@m"]\nenabled = "yes"\n',
      '[plugins."demo@m"]\nother = 1\n',
      'plugins = "x"\n',
      "[plugins\n",
    ]) {
      writeFileSync(config, text);
      assert.match(
        await reason("codex:demo@m", env, s.root),
        /has an unrecognised install record in Codex$/,
        text,
      );
    }
    rmSync(cache, { recursive: true });
    homes.setCodexEnabled("demo@m", true);
    mkdirSync(join(cache, "plugin-install-only"), { recursive: true });
    assert.match(
      await reason("codex:demo@m", env, s.root),
      /is not installed in Codex$/,
    );
  } finally {
    s.done();
  }
});

test("installed entries load and digest their current install, refuse duplicates by name, and never name a path", async () => {
  const s = sandbox();
  try {
    const homes = installedPluginHomes(s.root);
    const env = homes.environment;
    const claudeDir = homes.installClaude("demo@m", { skills: ["a", "b"] });
    const codexDir = homes.installCodex("tools@n", {
      write: (dir) =>
        writeNestedSkillPlugin(
          dir,
          { eng: ["deep"] },
          { name: "tools", claude: false },
        ),
    });
    const loaded = await loadProfilePlugins(
      {
        plugins: [
          { plugin: "claude:demo@m", skills: ["a"] },
          { plugin: "codex:tools@n", skills: ["deep"] },
        ],
      },
      "codex",
      env,
    );
    assert.deepEqual(
      loaded.map(({ path, name, skills }) => ({ path, name, skills })),
      [
        { path: claudeDir, name: "demo", skills: ["a"] },
        { path: codexDir, name: "tools", skills: ["deep"] },
      ],
    );
    // The same digest as the directory named by path.
    assert.equal(loaded[0]!.digest, await digestPlugin(claudeDir, ["a"]));

    // An update changes the content the next load digests.
    const updated = homes.installClaude("demo@m", {
      version: "2.0.0",
      write: (dir) => {
        writeSkillPlugin(dir, ["a", "b"], "demo");
        writeFileSync(
          join(dir, "skills", "a", "SKILL.md"),
          "---\nname: a\n---\nv2\n",
        );
      },
    });
    const next = await loadProfilePlugins(
      { plugins: [{ plugin: "claude:demo@m", skills: ["a"] }] },
      "claude",
      env,
    );
    assert.equal(next[0]!.path, updated);
    assert.notEqual(next[0]!.digest, loaded[0]!.digest);

    // A Codex-only plugin serves Codex profiles only.
    const codexOnly = {
      plugins: [{ plugin: "codex:tools@n" as const, skills: ["deep"] }],
    };
    assert.deepEqual(await skillFieldErrors(codexOnly, "claude", env), [
      "skills.plugins.0.plugin",
    ]);
    await assert.rejects(
      loadProfilePlugins(codexOnly, "claude", env),
      /Skill plugin tools has no Claude plugin manifest$/,
    );

    // The same plugin from both tools, or from a local copy, is one plugin enabled twice.
    homes.installCodex("demo@m", { skills: ["a"] });
    const twice = {
      plugins: [
        { plugin: "claude:demo@m" as const, skills: ["a"] },
        { plugin: "codex:demo@m" as const, skills: ["a"] },
      ],
    };
    assert.deepEqual(await skillFieldErrors(twice, "codex", env), [
      "skills.plugins.1.plugin",
    ]);
    await assert.rejects(
      loadProfilePlugins(twice, "codex", env),
      /Skill plugin demo is enabled more than once/,
    );
    const local = writeSkillPlugin(join(s.root, "local"), ["a"], "demo");
    assert.deepEqual(
      await skillFieldErrors(
        {
          plugins: [
            { plugin: "claude:demo@m", skills: ["a"] },
            { path: local, skills: ["a"] },
          ],
        },
        "claude",
        env,
      ),
      ["skills.plugins.1.path"],
    );

    // Unavailable at save and at load: the field, and a reason naming the plugin only.
    homes.setClaudeEnabled("demo@m", false);
    const disabled = {
      plugins: [{ plugin: "claude:demo@m" as const, skills: ["a", "zz"] }],
    };
    assert.deepEqual(await skillFieldErrors(disabled, "claude", env), [
      "skills.plugins.0.plugin",
    ]);
    await assert.rejects(
      loadProfilePlugins(disabled, "claude", env),
      (error) => {
        assert.equal(
          (error as Error).message,
          "Skill plugin claude:demo@m is disabled in Claude Code",
        );
        return true;
      },
    );
    homes.setClaudeEnabled("demo@m", true);
    assert.deepEqual(await skillFieldErrors(disabled, "claude", env), [
      "skills.plugins.0.skills.1",
    ]);
  } finally {
    s.done();
  }
});

test("the installed listing offers enabled plugins with skills from both tools, with no path", async () => {
  const s = sandbox();
  try {
    const homes = installedPluginHomes(s.root);
    const env = homes.environment;
    homes.installClaude("demo@m", { skills: ["b", "a"] });
    homes.installClaude("off@m", { enabled: false });
    homes.installCodex("tools@n", {
      write: (dir) =>
        writeNestedSkillPlugin(
          dir,
          { eng: ["deep"] },
          { name: "tools", claude: false },
        ),
    });
    // An app-only plugin (no skills) and a disabled one are not offered.
    homes.installCodex("mail@n", {
      write: (dir) => {
        mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
        writeFileSync(
          join(dir, ".codex-plugin", "plugin.json"),
          JSON.stringify({ name: "mail" }),
        );
      },
    });
    homes.installCodex("quiet@n", { enabled: false });
    const listing = await listInstalledPlugins(env);
    assert.deepEqual(listing, {
      plugins: [
        {
          plugin: "claude:demo@m",
          tool: "claude",
          name: "demo",
          claude: true,
          skills: [
            { name: "a", claude: true },
            { name: "b", claude: true },
          ],
        },
        {
          plugin: "codex:tools@n",
          tool: "codex",
          name: "tools",
          claude: false,
          skills: [{ name: "deep", claude: false }],
        },
      ],
      status: { claude: "available", codex: "available" },
    });
    assert.ok(!JSON.stringify(listing).includes(s.root));

    writeFileSync(join(homes.codexHome, "config.toml"), "[plugins\n");
    rmSync(join(homes.claudeHome, "plugins"), { recursive: true });
    assert.deepEqual(await listInstalledPlugins(env), {
      plugins: [],
      status: { claude: "none", codex: "unreadable" },
    });
  } finally {
    s.done();
  }
});

test("profile entries name a local directory or an installed plugin by tool and id", () => {
  // A revision stored before installed plugins parses unchanged.
  assert.ok(
    profileSkillsSchema.safeParse({
      plugins: [{ path: "/plugins/demo", skills: ["a"] }],
    }).success,
  );
  assert.ok(
    profileSkillsSchema.safeParse({
      plugins: [
        { plugin: "claude:demo@m", skills: ["a"] },
        { plugin: "codex:demo@m", skills: ["a"] },
        { path: "/plugins/demo", skills: ["a"] },
      ],
    }).success,
  );
  for (const plugin of [
    "claude:demo",
    "claude:../x@m",
    "codex:demo@m/x",
    "gemini:demo@m",
    "claude:@m",
    "claude:demo@m@n",
  ])
    assert.ok(
      !profileSkillsSchema.safeParse({ plugins: [{ plugin, skills: ["a"] }] })
        .success,
      plugin,
    );
  assert.ok(
    !profileSkillsSchema.safeParse({
      plugins: [
        { plugin: "claude:demo@m", skills: ["a"] },
        { plugin: "claude:demo@m", skills: ["b"] },
      ],
    }).success,
  );
  assert.ok(
    !profileSkillsSchema.safeParse({
      plugins: [{ plugin: "claude:demo@m", path: "/x", skills: ["a"] }],
    }).success,
  );
});
