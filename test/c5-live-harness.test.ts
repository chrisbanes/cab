import assert from "node:assert/strict";
import { execFileSync, fork, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Runtime } from "../src/standalone/codex.js";
import { StandaloneService } from "../src/standalone/service.js";
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

test("a service child whose parent disconnects exits, even before it starts a service", async () => {
  const child = fork(resolve("test/c5/service-child.mjs"), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<number | null>((done) =>
    child.once("exit", (code) => done(code)),
  );
  await new Promise<void>((ready, failed) => {
    child.once("error", failed);
    child.once("message", () => ready());
  });
  child.disconnect();
  const code = await Promise.race([
    exited,
    new Promise<"timeout">((done) =>
      setTimeout(() => done("timeout"), 10_000).unref(),
    ),
  ]);
  if (code === "timeout") child.kill("SIGKILL");
  assert.equal(code, 0);
});

test("facet turns that follow their brief need no repair turn, and the crash follow-up resumes the session", async () => {
  const { SLEEP, facetOutcome, setupJourney, shellOnly } = await import(
    pathToFileURL(resolve("test/c5/service-child.mjs")).href
  );
  // The bundled CLI refuses a command whose first part is `sleep N`, N >= 25.
  for (const brief of [
    facetOutcome("stop", { workerProfileId: "w", nonce: "n" }),
    shellOnly(SLEEP),
  ])
    assert.doesNotMatch(brief, /verbatim: sleep\s+\d/);
  const root = mkdtempSync(join(tmpdir(), "c5-repair-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=C5",
    "-c",
    "user.email=c5@invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const prompts: string[] = [];
  const threads: string[] = [];
  // Completes each turn, reporting a result only when the prompt asks for one.
  let listener: Parameters<NonNullable<Runtime["onToolCall"]>>[0];
  const runtime = {
    async start() {},
    async stop() {},
    async startThread() {
      return `thread-${prompts.length + 1}`;
    },
    async resumeThread() {},
    async startTurn(thread: string, _workspace: string, prompt: string) {
      prompts.push(prompt);
      threads.push(thread);
      return `turn-${prompts.length}`;
    },
    async interruptTurn() {},
    async waitForTurn(threadId: string, turnId: string) {
      if (prompts.at(-1)?.includes("ensemble_report_result"))
        await listener({
          threadId,
          turnId,
          callId: `call-${turnId}`,
          tool: "ensemble_report_result",
          arguments: { summary: "C5 probe done" },
        });
      return "completed" as const;
    },
    onUnexpectedRequest() {},
    onToolCall(next: typeof listener) {
      listener = next;
    },
  } as unknown as Runtime;
  const service = new StandaloneService(
    join(root, "data"),
    () => runtime,
    undefined,
    {
      runtimeHarnesses: ["codex", "claude"],
      power: { enabled: false },
      routingClient: null,
    },
  );
  try {
    await service.start();
    const settle = async (count: number) => {
      for (let i = 0; i < 40 && prompts.length < count; i++)
        await new Promise((done) => setTimeout(done, 100));
      await new Promise((done) => setTimeout(done, 500));
    };
    for (const facet of ["scrub", "stop", "crash"]) {
      const before = prompts.length;
      const { taskId } = await setupJourney(service, {
        facet,
        model: "haiku",
        repository,
      });
      await settle(before + 1);
      assert.equal(prompts.length - before, 1, facet);
      assert.equal(
        service.coordinationView().readTask(taskId).results.length,
        1,
        facet,
      );
      if (facet !== "crash") continue;
      // The crash facet kills a follow-up, so recovery has a session to resume.
      const binding = service.recoveryForTask(taskId)[0]?.binding;
      assert.ok(binding);
      await service.coordinationView().postOperatorMessage({
        key: crypto.randomUUID(),
        taskId,
        recipientAssignmentId: binding.assignmentId,
        expectedAssignmentVersion: binding.assignmentVersion,
        message: shellOnly(SLEEP),
      });
      await settle(before + 2);
      assert.equal(prompts.length - before, 2);
      assert.equal(threads.at(-1), threads.at(-2));
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("only a passed attempt with a clean leak scan exits 0; inconclusive fails", async () => {
  const { exitCode } = await harness();
  const clean = { leaks: [], failure: null };
  assert.equal(exitCode({ ...clean, outcome: "passed" }), 0);
  assert.equal(exitCode({ ...clean, outcome: "inconclusive" }), 1);
  assert.equal(exitCode({ ...clean, outcome: "failed" }), 1);
  assert.equal(
    exitCode({ leaks: ["home-path"], failure: null, outcome: "passed" }),
    1,
  );
  assert.equal(
    exitCode({ leaks: [], failure: { kind: "harness" }, outcome: "passed" }),
    1,
  );
});

/** Runs `script` in `count` concurrent Node processes; resolves their stdout. */
function concurrently(count: number, script: string) {
  const url = pathToFileURL(resolve("test/c5/harness.mjs")).href;
  return Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<string>((done, failed) => {
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const h = await import(${JSON.stringify(url)});\n${script}`,
            ],
            { stdio: ["ignore", "pipe", "inherit"] },
          );
          let out = "";
          child.stdout.on("data", (chunk) => {
            out += chunk;
          });
          child.once("error", failed);
          child.once("exit", () => done(out.trim()));
        }),
    ),
  );
}

test("concurrent drivers cannot exceed a cap or open two attempts on one ledger", async () => {
  const { beginAttempt, emptyLedger, readLedger, writeLedger } =
    await harness();
  const dir = mkdtempSync(join(tmpdir(), "c5-ledger-race-"));
  const file = join(dir, "ledger.json");
  try {
    writeLedger(beginAttempt(emptyLedger(), "claude-only"), file);
    const reserved = await concurrently(
      4,
      `let n = 0;
for (let i = 0; i < 5; i++)
  try { h.reserveTurnInFile("claude", ${JSON.stringify(file)}); n++; }
  catch (error) { if (!(error instanceof h.BudgetExhausted)) throw error; }
console.log(n);`,
    );
    const state = readLedger(file);
    assert.equal(
      reserved.reduce((sum, n) => sum + Number(n), 0),
      8,
    );
    assert.equal(state.totals.claude, 8);
    assert.equal(state.attempts["claude-only"][0].turns.claude, 8);

    writeLedger(emptyLedger(), file);
    const opened = await concurrently(
      3,
      `try {
  await h.withAttempt(${JSON.stringify(file)}, "scrub", async () => {
    await new Promise((done) => setTimeout(done, 500));
    return { outcome: "passed", failureKind: null };
  });
  console.log("opened");
} catch (error) {
  console.log(error instanceof h.BudgetExhausted ? "refused" : String(error));
}`,
    );
    assert.deepEqual(opened.sort(), ["opened", "refused", "refused"]);
    assert.equal(readLedger(file).attempts.scrub.length, 1);
    assert.equal(existsSync(`${file}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ledger lock left by an exited driver is stale and removed", async () => {
  const {
    beginAttempt,
    emptyLedger,
    readLedger,
    reserveTurnInFile,
    writeLedger,
  } = await harness();
  const dir = mkdtempSync(join(tmpdir(), "c5-ledger-stale-"));
  const file = join(dir, "ledger.json");
  try {
    const exited = spawnSync(process.execPath, ["-e", "0"]);
    assert.equal(exited.status, 0);
    writeLedger(beginAttempt(emptyLedger(), "scrub"), file);
    writeFileSync(`${file}.lock`, String(exited.pid));
    reserveTurnInFile("claude", file);
    assert.equal(readLedger(file).totals.claude, 1);
    assert.equal(existsSync(`${file}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
