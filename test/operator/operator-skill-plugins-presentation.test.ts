import assert from "node:assert/strict";
import { test } from "node:test";
import {
  entryErrors,
  entryLabel,
  entryUnavailable,
  filterSkills,
  type InstalledPlugin,
  installedStatusNotes,
  offeredPlugins,
  parseSkillsDraft,
  selectableSkills,
  skillsDraft,
  skillsSummary,
  typedSkills,
  withEntry,
  withoutEntry,
} from "../../web/src/skill-plugins.js";

const demo: InstalledPlugin = {
  plugin: "claude:demo@m",
  tool: "claude",
  name: "demo",
  claude: true,
  skills: [
    { name: "review", claude: true },
    { name: "codex-only", claude: false },
  ],
};
const demoInCodex: InstalledPlugin = {
  ...demo,
  plugin: "codex:demo@m",
  tool: "codex",
};
const tools: InstalledPlugin = {
  plugin: "codex:tools@n",
  tool: "codex",
  name: "tools",
  claude: false,
  skills: [{ name: "deep", claude: false }],
};
const installed = [demo, demoInCodex, tools];

test("rows name an installed plugin by name and tool, a local one by directory, and mark one no longer installed", () => {
  assert.equal(
    entryLabel({ plugin: "claude:demo@m", skills: ["review"] }, installed),
    "demo · Claude Code",
  );
  // Before the listing loads, or once uninstalled, the id stands in for the name.
  assert.equal(
    entryLabel({ plugin: "codex:gone@n", skills: ["x"] }, installed),
    "gone@n · Codex",
  );
  assert.equal(
    entryLabel({ path: "/p/demo", skills: ["x"] }, undefined),
    "/p/demo",
  );
  assert.equal(
    entryUnavailable({ plugin: "codex:gone@n", skills: ["x"] }, installed),
    true,
  );
  assert.equal(
    entryUnavailable({ plugin: "codex:gone@n", skills: ["x"] }, undefined),
    false,
  );
  assert.equal(
    entryUnavailable({ path: "/p", skills: ["x"] }, installed),
    false,
  );
});

test("the select offers each plugin once, never a second copy of one added, and only Claude-loadable ones on Claude", () => {
  const none = { plugins: [] };
  assert.deepEqual(
    offeredPlugins(installed, "codex", none).map((p) => p.plugin),
    ["claude:demo@m", "codex:demo@m", "codex:tools@n"],
  );
  assert.deepEqual(
    offeredPlugins(installed, "claude", none).map((p) => p.plugin),
    ["claude:demo@m", "codex:demo@m"],
  );
  // demo from Claude Code is added: neither copy of demo is offered again.
  assert.deepEqual(
    offeredPlugins(installed, "codex", {
      plugins: [{ plugin: "claude:demo@m", skills: ["review"] }],
    }).map((p) => p.plugin),
    ["codex:tools@n"],
  );
  assert.deepEqual(selectableSkills(demo, "claude"), ["review"]);
  assert.deepEqual(selectableSkills(demo, "codex"), ["review", "codex-only"]);
});

test("skills filter by name, typed names split on commas, and entries are added, replaced and removed", () => {
  assert.deepEqual(filterSkills(["Review", "plan", "deep"], " RE "), [
    "Review",
  ]);
  assert.deepEqual(filterSkills(["a", "b"], ""), ["a", "b"]);
  assert.deepEqual(typedSkills(" review, plan,,review "), ["review", "plan"]);
  const one = withEntry({ plugins: [] }, { path: "/p", skills: ["a"] });
  const two = withEntry(one, { plugin: "claude:demo@m", skills: ["review"] });
  assert.deepEqual(
    withEntry(two, { path: "/p", skills: ["a", "b"] }, 0).plugins[0],
    { path: "/p", skills: ["a", "b"] },
  );
  assert.deepEqual(withoutEntry(two, 0), {
    plugins: [{ plugin: "claude:demo@m", skills: ["review"] }],
  });
  assert.equal(skillsSummary(two), "2 plugins, 2 skills");
  assert.equal(skillsSummary({ plugins: [] }), "none");
});

test("the draft round-trips entries and refuses ones a profile cannot hold", () => {
  const skills = {
    plugins: [
      { plugin: "codex:tools@n" as const, skills: ["deep"] },
      { path: "/p", skills: ["a"] },
    ],
  };
  assert.deepEqual(parseSkillsDraft(skillsDraft(skills)), skills);
  assert.deepEqual(parseSkillsDraft(""), { plugins: [] });
  assert.equal(parseSkillsDraft("not json"), null);
  assert.equal(
    parseSkillsDraft(
      skillsDraft({ plugins: [{ path: "relative", skills: ["a"] }] }),
    ),
    null,
  );
});

test("server field errors are worded for their row, and unreadable tool records are noted", () => {
  const entry = {
    plugin: "claude:demo@m" as const,
    skills: ["review", "plan"],
  };
  const errors = {
    "skills.plugins.1.plugin": "invalid",
    "skills.plugins.1.skills.1": "invalid",
    "skills.plugins.0.path": "invalid",
  };
  assert.deepEqual(entryErrors(errors, 1, entry), [
    "Not installed and enabled for the service user now, or the same plugin as another entry.",
    "Skill plan is not in the plugin.",
  ]);
  assert.deepEqual(entryErrors(errors, 0, { path: "/p", skills: ["a"] }), [
    "Not a loadable plugin directory on the service host, or the same plugin as another entry.",
  ]);
  assert.deepEqual(
    installedStatusNotes({ claude: "unreadable", codex: "none" }),
    ["Claude Code's plugin records could not be read."],
  );
  assert.deepEqual(
    installedStatusNotes({ claude: "available", codex: "none" }),
    [],
  );
});
