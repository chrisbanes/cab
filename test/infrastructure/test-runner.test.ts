import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { tmpdir } from "../fixtures/temp.js";

interface RunnerResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  exitObserved: boolean;
  elapsedMs: number;
  signalTarget: string;
  terminationSignals: string[];
  stdout: { lines: string[]; omitted: number; truncated: number };
  stderr: { lines: string[]; omitted: number; truncated: number };
}
const runner = (await import(
  pathToFileURL(resolve("scripts/run-tests.mjs")).href
)) as {
  discoverTestFiles(root: string): string[];
  logicalSuites: string[];
  parseTestOptions(args: string[]): {
    profile: string;
    suite: string;
    shard: number;
    shards: number;
    preflight: boolean;
  };
  selectTestFiles(
    files: string[],
    options: { suite: string; shard: number; shards: number },
    timings?: Record<string, number>,
  ): string[];
  runTestProcess(
    args: string[],
    options?: {
      cwd?: string;
      deadlineMs?: number;
      graceMs?: number;
      forceWaitMs?: number;
      ownedChild?: { child: ChildProcess; pid: number; ownsGroup: boolean };
    },
  ): Promise<RunnerResult>;
  runnerStatus(
    result: Pick<RunnerResult, "timedOut" | "exitObserved" | "code"> & {
      signal?: string | null;
      interrupted?: string | null;
    },
  ): number;
};

test("CI options reject ambiguous, empty and incompatible selections", () => {
  assert.deepEqual(runner.parseTestOptions([]), {
    profile: "all",
    suite: "all",
    shard: 1,
    shards: 1,
    preflight: false,
  });
  for (const args of [
    ["--profile=unknown"],
    ["--profile="],
    ["--suite=missing"],
    ["--shard=0/2"],
    ["--shard=3/2"],
    ["--shard=1/3"],
    ["--profile=all", "--profile=service"],
    ["--unknown"],
    ["--fixture-preflight", "--profile=service"],
    ["--fixture-preflight", "--suite=operator"],
    ["--fixture-preflight", "--shard=1/2"],
  ])
    assert.throws(() => runner.parseTestOptions(args), args.join(" "));
});

test("CI logical suite shards cover the current source inventory exactly once", () => {
  const all = runner.discoverTestFiles(".");
  const selected = runner.logicalSuites.flatMap((suite) =>
    suite === "operator"
      ? [1, 2].flatMap((shard) =>
          runner.selectTestFiles(all, { suite, shard, shards: 2 }),
        )
      : runner.selectTestFiles(all, { suite, shard: 1, shards: 1 }),
  );
  assert.equal(selected.length, new Set(selected).size);
  assert.deepEqual(selected.sort(), all);
  const service = [1, 2].flatMap((shard) =>
    runner.selectTestFiles(all, { suite: "all", shard, shards: 2 }),
  );
  assert.equal(service.length, new Set(service).size);
  assert.deepEqual(service.sort(), all);
});

test("weighted shards separate heavy files and include newly added files", () => {
  const files = ["heavy", "medium", "small", "new"].map(
    (name) => `dist/test/operator/${name}.test.js`,
  );
  const timings = {
    "test/operator/heavy.test.ts": 100,
    "test/operator/medium.test.ts": 80,
    "test/operator/small.test.ts": 20,
  };
  const first = runner.selectTestFiles(
    files,
    { suite: "operator", shard: 1, shards: 2 },
    timings,
  );
  const second = runner.selectTestFiles(
    files,
    { suite: "operator", shard: 2, shards: 2 },
    timings,
  );
  assert.notEqual(
    first.includes(files[0] as string),
    first.includes(files[1] as string),
  );
  assert.deepEqual([...first, ...second].sort(), files.sort());
  assert.throws(
    () => runner.selectTestFiles([], { suite: "all", shard: 1, shards: 1 }),
    /No tests selected/,
  );
  assert.throws(
    () =>
      runner.selectTestFiles([files[0] as string], {
        suite: "operator",
        shard: 2,
        shards: 2,
      }),
    /no tests/,
  );
});

test("test discovery includes nested suites once and ignores stale compiled tests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-test-discovery-"));
  try {
    for (const file of [
      "test/coordination/task.test.ts",
      "test/execution/runtime.test.ts",
      "test/execution/fixtures/helper.ts",
      "dist/test/coordination/task.test.js",
      "dist/test/execution/runtime.test.js",
      "dist/test/old-milestone.test.js",
    ]) {
      await mkdir(join(directory, file, ".."), { recursive: true });
      await writeFile(join(directory, file), "");
    }
    assert.deepEqual(runner.discoverTestFiles(directory), [
      "dist/test/coordination/task.test.js",
      "dist/test/execution/runtime.test.js",
    ]);
    await rm(join(directory, "dist/test/execution/runtime.test.js"));
    assert.throws(
      () => runner.discoverTestFiles(directory),
      /Compiled test missing: dist\/test\/execution\/runtime.test.js/,
    );
    await rm(join(directory, "test"), { recursive: true });
    assert.throws(
      () => runner.discoverTestFiles(directory),
      /No test source files found/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the owned runner preserves an actual npm run check failure status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ensemble-runner-status-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "synthetic-check-failure",
        scripts: { check: 'node -e "process.exit(23)"' },
      }),
    );
    const npmCli = process.env.npm_execpath;
    assert.ok(
      npmCli,
      "Run this test through the pinned npm process or supply its standard npm_execpath",
    );
    const result = await runner.runTestProcess([npmCli, "run", "check"], {
      cwd: directory,
      deadlineMs: 5000,
    });
    assert.equal(result.exitObserved, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 23);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Transfer only this exact test-owned child after its signal handler is ready.
async function readyChild(
  cooperative: boolean,
  ownsGroup = process.platform !== "win32",
) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.on("SIGTERM", ${cooperative ? "()=>process.exit(0)" : "()=>{}"}); setInterval(()=>{},1000); setTimeout(()=>process.exit(99),5000); process.send("ready");`,
    ],
    { detached: ownsGroup, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  assert.ok(child.pid);
  const ownedChild = { child, pid: child.pid, ownsGroup };
  try {
    const [message] = await once(child, "message", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(message, "ready");
    child.disconnect();
    return ownedChild;
  } catch (error) {
    if (child.connected) child.disconnect();
    if (child.exitCode === null && child.signalCode === null)
      await runner.runTestProcess([], {
        ownedChild,
        deadlineMs: 1,
        graceMs: 1000,
        forceWaitMs: 1000,
      });
    throw error;
  }
}

test("the runner deadline ends waiting and observes graceful exact-child exit", async () => {
  const result = await runner.runTestProcess([], {
    ownedChild: await readyChild(true),
    deadlineMs: 150,
    graceMs: 1000,
    forceWaitMs: 1000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.terminationSignals, ["SIGTERM"]);
  assert.ok(
    result.elapsedMs >= 140 && result.elapsedMs < 2400,
    `Observed ${result.elapsedMs}ms`,
  );
});

test("bounded followup forces only the retained child group after ignored SIGTERM", async () => {
  const result = await runner.runTestProcess([], {
    ownedChild: await readyChild(false),
    deadlineMs: 150,
    graceMs: 50,
    forceWaitMs: 1000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(result.terminationSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(
    result.elapsedMs >= 190 && result.elapsedMs < 1400,
    `Observed ${result.elapsedMs}ms`,
  );
});

test("runner evidence retains only bounded known synthetic stdout and stderr", async () => {
  const result = await runner.runTestProcess([
    "-e",
    'console.log("ensemble-test-evidence stdout synthetic-ci-probe"); console.error("ensemble-test-evidence stderr synthetic-ci-probe"); console.error("AssertionError [ERR_ASSERTION]: Injected CI browser assertion remains primary"); console.log("SYNTHETIC_PRIVATE_MARKER token=private"); console.error("x".repeat(10000)); for(let i=0;i<100;i++) console.log("ensemble-test-evidence stdout synthetic-ci-probe"); process.exitCode=1;',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.lines.length, 40);
  assert.equal(result.stdout.omitted, 62);
  assert.equal(result.stderr.truncated, 1);
  assert.deepEqual(result.stderr.lines, [
    "ensemble-test-evidence stderr synthetic-ci-probe",
    "AssertionError [ERR_ASSERTION]: Injected CI browser assertion remains primary",
  ]);
  assert.equal(
    JSON.stringify(result).includes("SYNTHETIC_PRIVATE_MARKER"),
    false,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result.stdout)) < 65536);
});

test("wrapper timeout and uncertainty statuses remain separate from observed child status", () => {
  assert.equal(
    runner.runnerStatus({ timedOut: true, exitObserved: true, code: 0 }),
    124,
  );
  assert.equal(
    runner.runnerStatus({ timedOut: true, exitObserved: false, code: null }),
    125,
  );
  assert.equal(
    runner.runnerStatus({ timedOut: false, exitObserved: false, code: null }),
    125,
  );
  assert.equal(
    runner.runnerStatus({ timedOut: false, exitObserved: true, code: 23 }),
    23,
  );
  assert.equal(
    runner.runnerStatus({
      timedOut: false,
      exitObserved: true,
      code: 0,
      interrupted: "SIGINT",
    }),
    130,
  );
  assert.equal(
    runner.runnerStatus({
      timedOut: false,
      exitObserved: true,
      code: 0,
      interrupted: "SIGTERM",
    }),
    143,
  );
  assert.equal(
    runner.runnerStatus({
      timedOut: false,
      exitObserved: false,
      code: null,
      interrupted: "SIGTERM",
    }),
    125,
  );
});

test("wrapper interruption uses bounded exact-child cleanup before returning", async () => {
  const code = `import {spawn} from "node:child_process"; import {once} from "node:events"; const {runTestProcess}=await import(${JSON.stringify(pathToFileURL(resolve("scripts/run-tests.mjs")).href)}); const ownsGroup=process.platform!=="win32"; const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);setTimeout(()=>process.exit(99),5000);process.send("ready")'],{detached:ownsGroup,stdio:["ignore","pipe","pipe","ipc"]}); const [ready]=await once(child,"message",{signal:AbortSignal.timeout(5000)}); if(ready!=="ready") throw Error("Expected child readiness"); child.disconnect(); const pending=runTestProcess([],{ownedChild:{child,pid:child.pid,ownsGroup},forwardSignals:true,deadlineMs:5000,graceMs:1000,forceWaitMs:1000}); setTimeout(()=>process.kill(process.pid,"SIGTERM"),150); const r=await pending; if(r.interrupted==="SIGTERM"&&r.exitObserved&&r.code===0&&!r.timedOut) console.log("ensemble-test-evidence stdout synthetic-ci-probe"); else process.exitCode=17;`;
  const result = await runner.runTestProcess(
    ["--input-type=module", "-e", code],
    { deadlineMs: 10000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout.lines, [
    "ensemble-test-evidence stdout synthetic-ci-probe",
  ]);
});

test("an ordinary observed child signal preserves its conventional failure status", async () => {
  const result = await runner.runTestProcess([
    "-e",
    'process.kill(process.pid,"SIGTERM")',
  ]);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(runner.runnerStatus(result), 143);
});

test("a transferred ready child without a detached group is signalled individually", async () => {
  const result = await runner.runTestProcess([], {
    ownedChild: await readyChild(true, false),
    deadlineMs: 150,
    graceMs: 1000,
    forceWaitMs: 1000,
  });
  assert.equal(result.signalTarget, "owned-root-child");
  assert.equal(result.exitObserved, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.terminationSignals, ["SIGTERM"]);
});
