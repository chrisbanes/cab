import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  type ProcessIdentity,
  signalOwnedProcess,
  stopRecordedProcesses,
  verifyOwnedProcess,
} from "../fixtures/controlled-git.js";
import { startStalledGit } from "../fixtures/controlled-git-owner.js";
import { tmpdir } from "../fixtures/temp.js";

const harness = fileURLToPath(
  new URL("../fixtures/controlled-git-owner.js", import.meta.url),
);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function assertGone(identities: ProcessIdentity[]) {
  for (const identity of identities)
    await waitFor(
      async () => (verifyOwnedProcess(identity) === "owned" ? undefined : true),
      `process ${identity.pid} to exit`,
      5000,
    ).catch(() => assert.fail(`process ${identity.pid} is still owned`));
}

type Report = { root?: string; identities?: ProcessIdentity[]; cleaned?: true };

async function readReports(path: string): Promise<Report[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Report);
}

/** Run the harness in a temp dir; always reap what it recorded by identity. */
async function withHarness(
  mode: string,
  body: (run: {
    child: ReturnType<typeof spawn>;
    output: () => string;
    started: () => Promise<{ root: string; identities: ProcessIdentity[] }>;
    reports: () => Promise<Report[]>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "cab-controlled-git-owner-"));
  const reportPath = join(directory, "report.jsonl");
  const reports = () => readReports(reportPath);
  // An inherited NODE_TEST_CONTEXT makes the nested `node --test` skip its files.
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  const child = spawn(
    process.execPath,
    mode === "timeout" ? ["--test", "--test-force-exit", harness] : [harness],
    {
      env: {
        ...environment,
        CONTROLLED_GIT_OWNER_MODE: mode,
        CONTROLLED_GIT_OWNER_REPORT: reportPath,
      },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const started = () =>
    waitFor(async () => {
      const found = (await reports()).find((entry) => entry.identities);
      return found?.root && found.identities
        ? { root: found.root, identities: found.identities }
        : undefined;
    }, "harness report");
  try {
    await body({ child, output: () => output, started, reports });
  } catch (error) {
    if (error instanceof Error) error.message += `\nharness output:\n${output}`;
    throw error;
  } finally {
    const recorded = (await reports()).flatMap(
      (entry) => entry.identities ?? [],
    );
    for (const identity of recorded)
      if (verifyOwnedProcess(identity) === "owned")
        signalOwnedProcess(identity, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    for (const entry of await reports())
      if (entry.root) await rm(entry.root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

test("fixture processes exit when their owning test process is killed", async () => {
  await withHarness("owner-hold", async ({ child, started }) => {
    const { identities } = await started();
    assert.equal(identities.length, 2);
    for (const identity of identities)
      assert.equal(verifyOwnedProcess(identity), "owned");
    child.kill("SIGKILL");
    await once(child, "exit");
    await assertGone(identities);
  });
});

test("fixture processes exit when a test fails and cleans up", async () => {
  const { controlled, git, identities } = await startStalledGit();
  try {
    assert.equal(identities.length, 2);
    await assert.rejects(async () => {
      try {
        throw new Error("injected failure");
      } finally {
        await controlled.cleanup();
      }
    }, /injected failure/);
    await assertGone(identities);
  } finally {
    for (const identity of identities)
      if (verifyOwnedProcess(identity) === "owned")
        signalOwnedProcess(identity, "SIGKILL");
    git.kill("SIGKILL");
    await rm(controlled.root, { recursive: true, force: true });
  }
});

test("fixture processes exit when a test times out", async () => {
  await withHarness("timeout", async ({ child, output, started }) => {
    const { identities } = await started();
    assert.equal(identities.length, 2);
    const [code] = await once(child, "close");
    assert.notEqual(code, 0);
    assert.match(output(), /timed out|cancelled/);
    await assertGone(identities);
  });
});

test("an early fake git kill leaves the pipe holder until cleanup", async () => {
  const { controlled, git, identities } = await startStalledGit();
  try {
    const descendant = identities.find((identity) =>
      identity.processPath.includes("descendant"),
    );
    assert.ok(descendant);
    git.kill("SIGKILL");
    await once(git, "exit");
    await sleep(1000);
    assert.equal(verifyOwnedProcess(descendant), "owned");
    await controlled.cleanup();
    await assertGone(identities);
  } finally {
    for (const identity of identities)
      if (verifyOwnedProcess(identity) === "owned")
        signalOwnedProcess(identity, "SIGKILL");
    git.kill("SIGKILL");
    await rm(controlled.root, { recursive: true, force: true });
  }
});

test("cleanup stops the remaining recorded processes after one fails", async () => {
  const identity = (pid: number): ProcessIdentity => ({
    pid,
    fixtureToken: "t",
    processPath: "p",
    processStartedAt: "s",
  });
  const [a, b, c] = [identity(1), identity(2), identity(3)];
  const called: number[] = [];
  await assert.rejects(
    stopRecordedProcesses([a, b, c], async (value) => {
      called.push(value.pid);
      if (value === a) throw new Error("cannot stop a");
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      return true;
    },
  );
  assert.deepEqual(called, [1, 2, 3]);
});

test("cleanup removes the fixture root once every process is stopped", async () => {
  const { controlled, git, identities } = await startStalledGit();
  try {
    await controlled.cleanup();
    await assertGone(identities);
    await assert.rejects(access(controlled.root), { code: "ENOENT" });
  } finally {
    for (const identity of identities)
      if (verifyOwnedProcess(identity) === "owned")
        signalOwnedProcess(identity, "SIGKILL");
    git.kill("SIGKILL");
    await rm(controlled.root, { recursive: true, force: true });
  }
});
