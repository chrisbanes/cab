import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { tmpdir } from "../fixtures/temp.js";

test("native-setup qualification persists caps and refuses repeated attempts after reopen", async (t) => {
  const { beginAttempt, PLAN, readGrant, reserveTurn, saveGrant } =
    await import(
      pathToFileURL(
        resolve("test/execution/user-setup-qualification/grant.mjs"),
      ).href
    );
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-grant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "grant.json");
  saveGrant(path, {
    plan: PLAN,
    limit: 12,
    perHarness: 6,
    attempts: [],
    turns: [],
  });
  assert.throws(() => reserveTurn(path, "claude", "native", 1000), /expired/);
  beginAttempt(path, "claude", "native", 1000);
  reserveTurn(path, "claude", "native", 1001);
  reserveTurn(path, "claude", "native", 1002);
  assert.equal(readGrant(path).turns.length, 2);
  assert.throws(() => reserveTurn(path, "claude", "native", 1003), /Facet/);
  assert.throws(() => beginAttempt(path, "claude", "native", 1004), /consumed/);
  assert.throws(
    () => beginAttempt(path, "codex", "native", 1000 + 45 * 60_000),
    /expired/,
  );
  assert.equal(readGrant(path).attempts.length, 1);
});

test("native-setup preflight failure releases no model prompt, including a delayed input reader", async () => {
  const { gatedInput } = await import(
    pathToFileURL(resolve("test/execution/user-setup-qualification/grant.mjs"))
      .href
  );
  const refused = gatedInput({ prompt: "must not run" });
  const pending = refused.prompt().next();
  refused.close();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.throws(() => refused.admit(), /closed/);
  const allowed = gatedInput({ prompt: "reserved" });
  const iterator = allowed.prompt();
  allowed.admit();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { prompt: "reserved" },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("native-setup driver rejects ungranted live invocations before authentication or fixture creation", () => {
  const driver = resolve("test/execution/user-setup-qualification/run.mjs");
  for (const args of [
    [],
    ["--live"],
    ["--live", "--facet=native"],
    ["--live", "--facet=other", "--grant-file", "/missing"],
  ]) {
    const result = spawnSync(process.execPath, [driver, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Use --init-grant/);
  }
});

test("native-setup normal fixtures cannot shadow cab and explicitly approve only the harmless fixture tool", async (t) => {
  const { fixture } = await import(
    pathToFileURL(resolve("test/execution/user-setup-qualification/run.mjs"))
      .href
  );
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(root, "codex");
  const mcp = JSON.parse(readFileSync(join(f.cwd, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["native_fixture"]);
  const config = readFileSync(join(f.cwd, ".codex", "config.toml"), "utf8");
  assert.match(config, /\[mcp_servers.native_fixture.tools.native_mark\]/);
  assert.match(config, /approval_mode = "approve"/);
  assert.doesNotMatch(config, /mcp_servers.cab/);
});

test("native-setup retry authorization preserves consumed turns and refuses admission after expiry", async (t) => {
  const {
    assertAttemptAvailable,
    beginAttempt,
    PLAN,
    readGrant,
    reserveTurn,
    saveGrant,
  } = await import(
    pathToFileURL(resolve("test/execution/user-setup-qualification/grant.mjs"))
      .href
  );
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "grant.json");
  saveGrant(path, {
    plan: PLAN,
    limit: 12,
    perHarness: 6,
    nativeAttemptsPerHarness: 2,
    startedAt: 1000,
    attempts: [
      { harness: "codex", facet: "native", state: "failed", startedAt: 1000 },
    ],
    turns: [{ harness: "codex", facet: "native", reservedAt: 1001 }],
  });
  assert.throws(
    () =>
      assertAttemptAvailable(
        readGrant(path),
        "claude",
        "native",
        1000 + 45 * 60_000,
      ),
    /expired/,
  );
  beginAttempt(path, "codex", "native", 1002);
  reserveTurn(path, "codex", "native", 1003);
  const grant = readGrant(path);
  assert.equal(grant.attempts.length, 2);
  assert.equal(grant.attempts[0].state, "failed");
  assert.equal(grant.turns.length, 2);
  assert.equal(grant.startedAt, 1000);
  assert.throws(() => beginAttempt(path, "codex", "native", 1004), /consumed/);
  assert.throws(() => reserveTurn(path, "codex", "native", 1005), /Facet/);
});

test("native-setup explicit time renewal keeps original start and consumes the same turn budget", async (t) => {
  const {
    assertAttemptAvailable,
    beginAttempt,
    PLAN,
    readGrant,
    reserveTurn,
    saveGrant,
  } = await import(
    pathToFileURL(resolve("test/execution/user-setup-qualification/grant.mjs"))
      .href
  );
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "grant.json");
  saveGrant(path, {
    plan: PLAN,
    limit: 12,
    perHarness: 6,
    startedAt: 1,
    liveWindowStartedAt: 4_000_000,
    attempts: [],
    turns: [{ harness: "codex", facet: "native", reservedAt: 2 }],
  });
  assertAttemptAvailable(readGrant(path), "claude", "native", 4_000_001);
  beginAttempt(path, "claude", "native", 4_000_001);
  reserveTurn(path, "claude", "native", 4_000_002);
  const g = readGrant(path);
  assert.equal(g.startedAt, 1);
  assert.equal(g.turns.length, 2);
  assert.throws(
    () => reserveTurn(path, "claude", "native", 4_000_000 + 45 * 60_000),
    /expired/,
  );
});

test("consolidated native allowance preserves history and starts final validation's separate window only on dispatch", async (t) => {
  const {
    PLAN,
    saveGrant,
    readGrant,
    beginAttempt,
    reserveTurn,
    assertAttemptAvailable,
  } = await import(
    pathToFileURL(resolve("test/execution/user-setup-qualification/grant.mjs"))
      .href
  );
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-consolidated-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "grant.json");
  saveGrant(path, {
    plan: PLAN,
    limit: 13,
    perHarness: 6,
    allowanceRevision: "consolidated-2026-11-09",
    harnessLimits: { claude: 7, codex: 6 },
    nativeAttemptLimits: { claude: 3, codex: 2 },
    nativeTurnLimits: { claude: 3, codex: 2 },
    phaseWindows: {
      native: { durationMs: 15 * 60_000 },
      lifecycle: { durationMs: 30 * 60_000 },
    },
    startedAt: 1,
    attempts: [
      { harness: "claude", facet: "native", state: "failed" },
      { harness: "claude", facet: "native", state: "failed" },
    ],
    turns: [{ harness: "claude", facet: "native" }],
  });
  beginAttempt(path, "claude", "native", 1000);
  reserveTurn(path, "claude", "native", 1001);
  reserveTurn(path, "claude", "native", 1002);
  assert.equal(readGrant(path).turns.length, 3);
  assert.equal(readGrant(path).attempts.length, 3);
  assert.equal(readGrant(path).startedAt, 1);
  assert.throws(() => beginAttempt(path, "claude", "native", 1003), /consumed/);
  assert.throws(
    () => reserveTurn(path, "claude", "native", 1000 + 15 * 60_000),
    /expired/,
  );
  assertAttemptAvailable(readGrant(path), "claude", "lifecycle", 10_000_000);
  beginAttempt(path, "claude", "lifecycle", 10_000_000);
  reserveTurn(path, "claude", "lifecycle", 10_000_001);
  assert.equal(readGrant(path).phaseWindows.lifecycle.startedAt, 10_000_000);
  assert.throws(
    () => reserveTurn(path, "claude", "lifecycle", 10_000_000 + 30 * 60_000),
    /expired/,
  );
});

test("the lifecycle driver completes four bounded offline native turns, retains crash ownership and resumes only explicitly", {
  skip: process.platform !== "darwin",
  timeout: 60_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-lifecycle-offline-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFileSync(
    executable,
    readFileSync(
      "test/execution/user-setup-qualification/fake-codex.mjs",
      "utf8",
    ).replace("#!/usr/bin/env node", `#!${process.execPath}`),
  );
  chmodSync(executable, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    const evidence = join(root, "lifecycle/codex/evidence.json");
    if (
      !existsSync(evidence) ||
      JSON.parse(readFileSync(evidence, "utf8")).cleanup.every(
        (c: { exited?: boolean }) => c.exited === true,
      )
    )
      rmSync(root, { recursive: true, force: true });
  });
  const { saveGrant, PLAN, readGrant } = await import(
    pathToFileURL(resolve("test/execution/user-setup-qualification/grant.mjs"))
      .href
  );
  const path = join(root, "grant.json");
  saveGrant(path, {
    plan: PLAN,
    limit: 13,
    perHarness: 6,
    allowanceRevision: "consolidated-2026-11-09",
    harnessLimits: { claude: 7, codex: 6 },
    nativeAttemptLimits: { claude: 3, codex: 2 },
    nativeTurnLimits: { claude: 3, codex: 2 },
    phaseWindows: {
      native: { durationMs: 900000 },
      lifecycle: { durationMs: 1800000 },
    },
    attempts: [
      { harness: "claude", facet: "native", state: "passed" },
      { harness: "codex", facet: "native", state: "passed" },
    ],
    turns: [],
    root,
  });
  const { lifecycle } = await import(
    pathToFileURL(
      resolve("test/execution/user-setup-qualification/lifecycle.mjs"),
    ).href
  );
  await lifecycle(path, ["codex"]);
  const evidence = JSON.parse(
    readFileSync(join(root, "lifecycle/codex/evidence.json"), "utf8"),
  );
  assert.equal(evidence.state, "passed", JSON.stringify(evidence.failure));
  assert.equal(evidence.turns.length, 4);
  assert.ok(evidence.checks.recovery.noBlindResubmission);
  assert.ok(evidence.checks.recovery.sameThread);
  assert.equal(readGrant(path).turns.length, 4);
  assert.ok(
    evidence.cleanup.every((c: { exited?: boolean }) => c.exited === true),
  );
  await assert.rejects(lifecycle(path, ["codex"]), /Attempt already consumed/);
});

test("a lifecycle retry needs an explicit exact grant amendment and cannot renew time or refund turns", async (t) => {
  const { PLAN, saveGrant, readGrant, assertAttemptAvailable, beginAttempt } =
    await import(
      pathToFileURL(
        resolve("test/execution/user-setup-qualification/grant.mjs"),
      ).href
    );
  const root = mkdtempSync(join(tmpdir(), "cab-user-setup-retry-grant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "grant.json"),
    now = Date.now();
  const grant = {
    plan: PLAN,
    limit: 12,
    perHarness: 6,
    root,
    startedAt: now,
    attempts: [
      {
        harness: "claude",
        facet: "lifecycle",
        state: "failed",
        startedAt: now,
      },
    ],
    turns: [{ harness: "claude", facet: "native", reservedAt: now }],
  };
  saveGrant(path, grant);
  assert.throws(
    () => assertAttemptAvailable(readGrant(path), "claude", "lifecycle"),
    /Attempt already consumed/,
  );
  saveGrant(path, {
    ...grant,
    lifecycleAttemptLimits: { claude: 2, codex: 1 },
  });
  beginAttempt(path, "claude", "lifecycle", now + 1);
  const amended = readGrant(path);
  assert.equal(amended.startedAt, now);
  assert.deepEqual(amended.turns, grant.turns);
  assert.equal(amended.attempts.length, 2);
  assert.throws(
    () => assertAttemptAvailable(amended, "claude", "lifecycle"),
    /Attempt already consumed/,
  );
  assert.throws(
    () =>
      assertAttemptAvailable(
        { ...amended, attempts: grant.attempts },
        "claude",
        "lifecycle",
        now + 46 * 60000,
      ),
    /expired/,
  );
});
