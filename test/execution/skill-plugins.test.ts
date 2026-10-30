import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
  skillFieldErrors,
  SkillPluginError,
} from "../../src/standalone/skill-plugins.js";
import { writeSkillPlugin } from "../fixtures/skill-plugin.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cab-skill-plugins-"));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a plugin digest is stable, changes with any file, and ignores timestamps", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a", "b"]);
    const first = await digestPlugin(plugin);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await digestPlugin(plugin), first);
    // The same tree through an aliased path has the same digest.
    assert.equal(await digestPlugin(`${plugin}/.`), first);
    assert.equal(await digestPlugin(`${plugin}//`), first);
    const skill = join(plugin, "skills", "a", "SKILL.md");
    writeFileSync(skill, "changed\n");
    const changed = await digestPlugin(plugin);
    assert.notEqual(changed, first);
    // An added or renamed file also changes it.
    writeFileSync(join(plugin, "skills", "a", "extra.sh"), "x");
    assert.notEqual(await digestPlugin(plugin), changed);
    // Same bytes in a copy at another path hash the same.
    const copy = writeSkillPlugin(join(s.root, "q"), ["a", "b"]);
    writeFileSync(join(copy, "skills", "a", "SKILL.md"), "changed\n");
    writeFileSync(join(copy, "skills", "a", "extra.sh"), "x");
    assert.equal(await digestPlugin(copy), await digestPlugin(plugin));
  } finally {
    s.done();
  }
});

test("a plugin with a symbolic link, a special file or too many files is refused", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"));
    symlinkSync("/etc/hosts", join(plugin, "link"));
    await assert.rejects(digestPlugin(plugin), SkillPluginError);
    rmSync(join(plugin, "link"));
    const big = join(plugin, "many");
    mkdirSync(big);
    for (let i = 0; i <= maxPluginFiles; i++)
      writeFileSync(join(big, `f${i}`), "");
    await assert.rejects(digestPlugin(plugin), /too large/);
    await assert.rejects(
      digestPlugin(join(s.root, "absent")),
      /not a directory/,
    );
  } finally {
    s.done();
  }
});

test("skill fields name the plugin and skill that are missing, and loading never names a path", async () => {
  const s = sandbox();
  try {
    const plugin = writeSkillPlugin(join(s.root, "p"), ["a"]);
    const bare = join(s.root, "bare");
    mkdirSync(bare);
    assert.deepEqual(
      await skillFieldErrors({
        plugins: [
          { path: plugin, skills: ["a", "missing"] },
          { path: bare, skills: ["a"] },
          { path: join(s.root, "absent"), skills: ["a"] },
        ],
      }),
      [
        "skills.plugins.0.skills.1",
        "skills.plugins.1.path",
        "skills.plugins.2.path",
      ],
    );
    assert.deepEqual(
      await skillFieldErrors({ plugins: [{ path: plugin, skills: ["a"] }] }),
      [],
    );
    await assert.rejects(
      loadProfilePlugins({ plugins: [{ path: bare, skills: ["a"] }] }),
      (error) =>
        error instanceof SkillPluginError &&
        !error.message.includes(s.root) &&
        /Skill plugin 1/.test(error.message),
    );
    const loaded = await loadProfilePlugins({
      plugins: [{ path: plugin, skills: ["a"] }],
    });
    assert.equal(loaded[0]?.name, "unit-plugin");
    assert.equal(loaded[0]?.digest, await digestPlugin(plugin));
  } finally {
    s.done();
  }
});
