import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { tmpdir } from "./temp.js";

const driver = resolve("test/c5/live-journeys.mjs");
const harness = () =>
  import(pathToFileURL(resolve("test/c5/harness.mjs")).href);
const SENTINEL = "c5-sentinel-token-8812";
const roots = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("ensemble-c5-"));
const ledgerFile = () => join(tmpdir(), "ensemble-c5.ledger.json");

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [driver, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
}

test("driver refuses anything but exactly --live --facet <name> and creates nothing", () => {
  const before = roots();
  const ledger = existsSync(ledgerFile());
  for (const args of [
    [],
    ["--live"],
    ["--facet", "scrub"],
    ["--live", "--facet", "bogus"],
    ["--live", "--facet"],
    ["--live", "--facet", "scrub", "--extra"],
    ["--facet", "scrub", "--live"],
  ]) {
    const result = run(args, {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
    });
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Refusing/);
    assert.equal(result.stdout, "");
    assert.equal(`${result.stdout}${result.stderr}`.includes(SENTINEL), false);
  }
  assert.deepEqual(roots(), before);
  assert.equal(existsSync(ledgerFile()), ledger);
});

test("a live facet without a token refuses before any root or ledger write", () => {
  const home = mkdtempSync(join(tmpdir(), "c5-empty-home-"));
  try {
    const before = roots();
    const ledger = existsSync(ledgerFile());
    const result = run(["--live", "--facet", "scrub"], {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      HOME: home,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /token unavailable/);
    assert.equal(result.stdout, "");
    assert.deepEqual(roots(), before);
    assert.equal(existsSync(ledgerFile()), ledger);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the ledger refuses the turn after each per-attempt cap and the global caps", async () => {
  const { FACETS, BudgetExhausted, beginAttempt, emptyLedger, reserveTurn } =
    await harness();
  for (const [facet, caps] of Object.entries(
    FACETS as Record<string, { claude: number; codex: number }>,
  ))
    for (const harnessName of ["claude", "codex"] as const) {
      let state = beginAttempt(emptyLedger(), facet);
      for (let i = 0; i < caps[harnessName]; i++)
        state = reserveTurn(state, harnessName);
      assert.throws(
        () => reserveTurn(state, harnessName),
        BudgetExhausted,
        `${facet} ${harnessName}`,
      );
    }
  const spent = {
    ...beginAttempt(emptyLedger(), "claude-only"),
    totals: { claude: 30, codex: 10 },
  };
  assert.throws(() => reserveTurn(spent, "claude"), /global claude/);
  const mixed = {
    ...beginAttempt(emptyLedger(), "mixed"),
    totals: spent.totals,
  };
  assert.throws(() => reserveTurn(mixed, "codex"), /global codex/);
  assert.equal(
    reserveTurn({ ...mixed, totals: { claude: 29, codex: 9 } }, "claude").totals
      .claude,
    30,
  );
});

test("attempts are capped at two, escalate to sonnet only after a compliance failure, and keep wall-time caps", async () => {
  const {
    beginAttempt,
    emptyLedger,
    finishAttempt,
    reserveTurn,
    BudgetExhausted,
  } = await harness();
  let state = beginAttempt(emptyLedger(), "stop");
  assert.equal(state.attempts.stop[0].model, "haiku");
  state = finishAttempt(state, "failed", "harness");
  state = beginAttempt(state, "stop");
  assert.equal(state.attempts.stop[1].model, "haiku");
  state = finishAttempt(state, "failed", "harness");
  assert.throws(() => beginAttempt(state, "stop"), BudgetExhausted);
  const compliance = finishAttempt(
    beginAttempt(emptyLedger(), "mixed"),
    "failed",
    "model-compliance",
  );
  assert.equal(
    beginAttempt(compliance, "mixed").attempts.mixed[1].model,
    "sonnet",
  );
  assert.throws(
    () => beginAttempt(emptyLedger(0), "scrub", 2 * 60 * 60_000 + 1),
    /session wall-time/,
  );
  const stale = beginAttempt(emptyLedger(0), "scrub", 0);
  assert.throws(
    () => reserveTurn(stale, "claude", 20 * 60_000 + 1),
    /attempt wall-time/,
  );
  assert.throws(() => reserveTurn(emptyLedger(), "claude"), /no open attempt/);
});

test("an attempt always closes, as failed when its body throws, and an open attempt refuses the next", async () => {
  const { withAttempt, readLedger, writeLedger, beginAttempt, emptyLedger } =
    await harness();
  const dir = mkdtempSync(join(tmpdir(), "c5-ledger-"));
  const file = join(dir, "ledger.json");
  try {
    await assert.rejects(
      withAttempt(file, "scrub", async () => {
        throw new Error("prelude failed");
      }),
      /prelude failed/,
    );
    let state = readLedger(file);
    assert.equal(state.current, null);
    assert.deepEqual(
      [state.attempts.scrub[0].outcome, state.attempts.scrub[0].failureKind],
      ["failed", "harness"],
    );
    await withAttempt(file, "scrub", async (attempt: { number: number }) => {
      assert.equal(attempt.number, 2);
      return { outcome: "passed", failureKind: null };
    });
    state = readLedger(file);
    assert.equal(state.current, null);
    assert.equal(state.attempts.scrub[1].outcome, "passed");
    writeLedger(beginAttempt(emptyLedger(), "stop"), file);
    let ran = false;
    await assert.rejects(
      withAttempt(file, "stop", async () => {
        ran = true;
      }),
      /still open/,
    );
    assert.equal(ran, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the leak scan flags secrets and local paths and passes a clean sample", async () => {
  const { scanForLeaks } = await harness();
  const context = {
    token: SENTINEL,
    roots: ["/private/tmp/ensemble-c5-abc"],
    home: "/Users/someone",
  };
  for (const [sample, label] of [
    [`x ${SENTINEL} y`, "token-value"],
    ["key sk-ant-x", "sk-ant-prefix"],
    ["Authorization: Bearer abc", "bearer"],
    ["CLAUDE_CODE_OAUTH_TOKEN=abc", "token-assignment"],
    ["at /private/tmp/ensemble-c5-abc/data", "disposable-root"],
    ["in /Users/someone/dev", "home-path"],
  ] as const)
    assert.deepEqual(scanForLeaks(sample, context), [label], sample);
  assert.deepEqual(
    scanForLeaks(
      '{"token":"<redacted-token>","path":"<disposable-root>","auth":"Bearer <redacted-token>"}',
      context,
    ),
    [],
  );
});

test("cleanup removes only a real ensemble-c5- directory directly under the temp root", async () => {
  const { removeRoot } = await harness();
  const root = mkdtempSync(join(tmpdir(), "ensemble-c5-"));
  mkdirSync(join(root, "data"));
  const other = mkdtempSync(join(tmpdir(), "c5-other-"));
  const nested = join(other, "ensemble-c5-nested");
  mkdirSync(nested);
  const link = join(tmpdir(), `ensemble-c5-link-${process.pid}`);
  symlinkSync(other, link);
  try {
    for (const path of [other, nested, link])
      assert.throws(() => removeRoot(path), /Refusing/);
    assert.ok(existsSync(other));
    assert.equal(removeRoot(root), true);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(link, { force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
