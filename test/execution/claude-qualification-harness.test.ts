import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const driver = resolve("test/execution/claude-qualification/run.mjs");
const harness = () =>
  import(
    pathToFileURL(resolve("test/execution/claude-qualification/harness.mjs"))
      .href
  );
const probeRoots = () =>
  readdirSync(tmpdir()).filter((name) =>
    name.startsWith("ensemble-claude-c0-"),
  );

test("driver refuses anything but the exact live grammar and creates nothing", () => {
  const before = probeRoots();
  for (const args of [[], ["p8"], ["--live"], ["--live", "bogus"]]) {
    const result = spawnSync(process.execPath, [driver, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Refusing Claude SDK probes/);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(probeRoots(), before);
});

test("buildEnv passes only the allowlist and never API-key credentials", async () => {
  const { buildEnv } = await harness();
  const source = {
    PATH: "/usr/bin",
    LANG: "en_GB.UTF-8",
    HOME: homedir(),
    ANTHROPIC_API_KEY: "api",
    ANTHROPIC_AUTH_TOKEN: "auth",
    ANTHROPIC_PROFILE: "profile",
    CLAUDE_CODE_USE_BEDROCK: "1",
    UNRELATED_SECRET: "secret",
  };
  assert.deepEqual(buildEnv("/r", "oauth", source), {
    PATH: "/usr/bin",
    TMPDIR: "/r/tmp",
    LANG: "en_GB.UTF-8",
    HOME: "/r/home",
    CLAUDE_CONFIG_DIR: "/r/config",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  });
  assert.equal(
    "CLAUDE_CODE_OAUTH_TOKEN" in buildEnv("/r", null, source),
    false,
  );
});

test("loadToken reads only CLAUDE_CODE_OAUTH_TOKEN", async (t) => {
  const { loadToken } = await harness();
  const dir = mkdtempSync(join(tmpdir(), "c0-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, ".env");
  writeFileSync(
    file,
    "export ANTHROPIC_API_KEY=nope\nexport CLAUDE_CODE_OAUTH_TOKEN='fake-oauth'\n",
  );
  assert.equal(loadToken({}, file), "fake-oauth");
  assert.equal(loadToken({ CLAUDE_CODE_OAUTH_TOKEN: "env" }, file), "env");
  writeFileSync(file, "export ANTHROPIC_API_KEY=nope\n");
  assert.equal(loadToken({}, file), null);
  assert.equal(loadToken({}, join(dir, "missing")), null);
});

test("redact removes tokens and private paths and truncates long fields", async () => {
  const { redact } = await harness();
  const context = {
    token: "fake-oauth-value",
    root: "/var/folders/x/T/ensemble-claude-c0-abc",
    repo: "/Users/someone/dev/ensemble",
    home: "/Users/someone",
  };
  const text = [
    "fake-oauth-value",
    "sk-ant-oat01-abc",
    "Bearer abc.def",
    "/var/folders/x/T/ensemble-claude-c0-abc/config",
    "/Users/someone/dev/ensemble/test",
    "/Users/someone/.claude",
    "projects/-var-folders-x-T-ensemble-claude-c0-abc-workspace",
  ].join(" ");
  const out = redact({ nested: [text] }, context).nested[0];
  for (const secret of [
    "fake-oauth",
    "sk-ant-",
    "abc.def",
    "/var/folders",
    "/Users/",
  ])
    assert.equal(out.includes(secret), false, secret);
  assert.match(
    out,
    /<redacted-token>.*<disposable-root>\/config.*<repo>\/test.*<user-home>\/\.claude/,
  );
  const long = redact("a".repeat(5000), context);
  assert.equal(long.startsWith("a".repeat(2048)), true);
  assert.match(long, /…\[truncated 2952 chars\]$/);
});

test("assertInside and assertCleanupRoot confine paths", async (t) => {
  const { assertInside, assertCleanupRoot, ROOT_PREFIX } = await harness();
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  const other = mkdtempSync(join(tmpdir(), "c0-other-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });
  mkdirSync(join(root, "workspace"));
  symlinkSync(other, join(root, "workspace", "escape"));
  assert.equal(
    assertInside(root, join(root, "workspace", "new.txt")),
    join(root, "workspace", "new.txt"),
  );
  assert.throws(() =>
    assertInside(root, join(root, "workspace", "..", "..", "x")),
  );
  assert.throws(() =>
    assertInside(root, join(root, "workspace", "escape", "x")),
  );
  assert.equal(assertCleanupRoot(root), root);
  assert.throws(() => assertCleanupRoot(other));
  assert.throws(() => assertCleanupRoot(join(root, "workspace")));
  assert.throws(() =>
    assertCleanupRoot(join(tmpdir(), `${ROOT_PREFIX}missing`)),
  );
});

test("dispositions follow the probe rule and return only failed ADR facets", async () => {
  const { facet, probeDisposition, returnedToChris } = await harness();
  const passed = facet("F1.1", true, "passed", {});
  const info = facet("F1.3", false, "failed", {});
  const failed = facet("F1.2", true, "failed", {});
  const untested = facet(
    "F1.4",
    false,
    "untested",
    null,
    "no subscription token",
  );
  assert.equal(probeDisposition([passed, info]), "passed");
  assert.equal(probeDisposition([passed, failed, untested]), "failed");
  assert.equal(probeDisposition([passed, untested]), "untested");
  assert.throws(() => facet("F1.5", true, "untested", null));
  assert.throws(() =>
    probeDisposition([{ id: "F1.5", adr: true, disposition: "untested" }]),
  );
  assert.deepEqual(returnedToChris([passed, info, failed, untested]), [failed]);
});

test("summarize rejects a result that omits a declared facet", async () => {
  const { facet, summarize } = await harness();
  const results = { p1: { facets: [facet("F1.1", true, "passed", {})] } };
  assert.equal(summarize(results, { p1: ["F1.1"] })[0].disposition, "passed");
  assert.throws(
    () => summarize(results, { p1: ["F1.1", "F1.2"] }),
    /omits facet F1.2/,
  );
  assert.throws(() => summarize({}, { p1: ["F1.1"] }), /Missing result file/);
});

test("p9 judges each TMPDIR facet and selects redirect, then deny, then shared", async () => {
  const { judge, selectOutcome } = await import(
    pathToFileURL(resolve("test/execution/claude-qualification/p9-tmpdir.mjs"))
      .href
  );
  const observed = {
    ran: true,
    insideWritten: true,
    insideResultClean: true,
    reportedIsShared: true,
    reportedIsTaskRoot: false,
    tmpdirWriteLanded: true,
    sharedWriteLanded: true,
  };
  assert.deepEqual(judge("F9.3", observed), ["passed"]);
  assert.deepEqual(judge("F9.2", observed), ["failed"]);
  assert.deepEqual(
    judge("F9.2", {
      ...observed,
      tmpdirWriteLanded: false,
      sharedWriteLanded: false,
    }),
    ["passed"],
  );
  assert.deepEqual(
    judge("F9.1", {
      ...observed,
      reportedIsShared: false,
      reportedIsTaskRoot: true,
      sharedWriteLanded: false,
    }),
    ["passed"],
  );
  assert.equal(judge("F9.1", { ...observed, ran: false })[0], "untested");
  // Commands that run but report errors (a denied cwd file) do not count as a working shell.
  assert.deepEqual(
    judge("F9.2", {
      ...observed,
      insideResultClean: false,
      tmpdirWriteLanded: false,
      sharedWriteLanded: false,
    }),
    ["failed"],
  );
  const rows = (one: string, two: string) => [
    { id: "F9.1", disposition: one },
    { id: "F9.2", disposition: two },
  ];
  assert.equal(selectOutcome(rows("passed", "failed")), "redirect");
  assert.equal(selectOutcome(rows("failed", "passed")), "deny");
  assert.equal(selectOutcome(rows("failed", "failed")), "shared");
  assert.equal(selectOutcome(rows("failed", "untested")), "undetermined");
});
