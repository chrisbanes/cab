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

test("global live facets explicitly cap each attempt and session", async () => {
  const { FACETS, GLOBAL_CAPS, parseArgs } = await import(
    pathToFileURL(
      resolve("test/execution/mixed-runtime-qualification/harness.mjs"),
    ).href
  );
  assert.equal(
    parseArgs(["--live", "--facet", "claude-global-skill"]),
    "claude-global-skill",
  );
  assert.deepEqual(FACETS["claude-global-skill"], { claude: 3, codex: 0 });
  assert.deepEqual(FACETS["codex-global-skill"], { claude: 0, codex: 3 });
  assert.deepEqual(GLOBAL_CAPS, { claude: 30, codex: 10 });
});

test("global live measurement rejects omitted, stale and leaked answers", async () => {
  const { assertGlobalMeasurement } = await import(
    pathToFileURL(
      resolve("test/execution/mixed-runtime-qualification/global-fixture.mjs"),
    ).href
  );
  assertGlobalMeasurement("fresh-answer", "fresh-answer");
  for (const actual of ["RESOURCE_MISSING", "stale-answer", "UNSELECTED_LEAK"])
    assert.throws(
      () => assertGlobalMeasurement(actual, "fresh-answer"),
      /resource answer/,
    );
});

test("additional grant admits five global attempts and leaves other facets at two", async () => {
  const { FACETS, beginAttempt, finishAttempt, emptyLedger, BudgetExhausted } =
    await import(
      pathToFileURL(
        resolve("test/execution/mixed-runtime-qualification/harness.mjs"),
      ).href
    );
  for (const facet of Object.keys(FACETS)) {
    const limit = ["claude-global-skill", "codex-global-skill"].includes(facet)
      ? 5
      : 2;
    let ledger = emptyLedger();
    for (let i = 0; i < limit; i++)
      ledger = finishAttempt(beginAttempt(ledger, facet), "failed", "harness");
    assert.throws(() => beginAttempt(ledger, facet), BudgetExhausted, facet);
  }
});

test("global follow-up uses the current assignment version rather than its execution snapshot", async () => {
  const { postGlobalFollowUp } = await import(
    pathToFileURL(
      resolve("test/execution/mixed-runtime-qualification/service-child.mjs"),
    ).href
  );
  let posted: Record<string, unknown> | undefined;
  const service = {
    recoveryForTask: () => [
      { binding: { assignmentId: "assignment", assignmentVersion: 1 } },
    ],
    domain: () => ({ assignment: () => ({ version: 7 }) }),
    coordinationView: () => ({
      postOperatorMessage: async (message: Record<string, unknown>) => {
        posted = message;
      },
    }),
  };
  await postGlobalFollowUp(service, "task", "brief");
  assert.equal(posted?.recipientAssignmentId, "assignment");
  assert.equal(posted?.expectedAssignmentVersion, 7);
  assert.equal(posted?.message, "brief");
});

test("integrated global fixture updates linked sources without a synthetic adapter and removes the probe resource", async (t) => {
  const { createRoot } = await harness();
  const root = createRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { writeGlobalSource } = await import(
    pathToFileURL(
      resolve("test/execution/mixed-runtime-qualification/global-fixture.mjs"),
    ).href
  );
  const first = writeGlobalSource(root, "v1", "first");
  assert.equal(
    readFileSync(join(first.source, "resources/answer.txt"), "utf8"),
    "first",
  );
  assert.equal(existsSync(join(root, "adapter-v1")), false);
  const second = writeGlobalSource(root, "v2", "second");
  assert.equal(second.source, first.source);
  assert.equal(
    readFileSync(join(second.source, "resources/answer.txt"), "utf8"),
    "second",
  );
  writeGlobalSource(root, "omitted", "hidden", { omitResource: true });
  assert.equal(existsSync(join(second.source, "resources/answer.txt")), false);
  assert.equal(
    existsSync(join(first.home, ".agents/skills/cab-unselected/SKILL.md")),
    true,
  );
});
