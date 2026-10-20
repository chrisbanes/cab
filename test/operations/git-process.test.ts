import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type GitRunOptions,
  runGit,
} from "../../src/standalone/git-process.js";
import {
  gitEnvironmentProbe,
  hardenedGitEnvironment,
  withHostileGitEnvironment,
} from "../fixtures/git-environment.js";

const windows = {
  timeoutMs: 2000,
  terminationGraceMs: 50,
  observationMs: 200,
  maxOutputBytes: 1024,
};

/** A temporary script standing in for Git; returns its path and a marker-file path. */
function script(t: TestContext, body: string) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-git-process-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "git");
  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);
  return { executable, marker: join(directory, "started") };
}

const run = (options: Partial<GitRunOptions> & { executable: string }) =>
  runGit({ args: [], ...windows, ...options });

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition was not reached in time");
}

test("the runner returns stdout and gives the child only the hardened environment", async (t) => {
  const probe = gitEnvironmentProbe();
  t.after(() => probe.close());
  const result = await withHostileGitEnvironment(() =>
    run({ executable: probe.executable, args: ["--version"] }),
  );
  assert.equal(result.status, "ok");
  assert.match(
    result.status === "ok" ? result.stdout.toString("utf8") : "",
    /^git version/,
  );
  const [invocation, ...rest] = probe.invocations();
  assert.equal(rest.length, 0);
  assert.deepEqual(invocation?.env, hardenedGitEnvironment);
});

test("input reaches stdin and is closed", async (t) => {
  const { executable } = script(t, "cat");
  const result = await run({ executable, input: Buffer.from("a\0b\0") });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.status === "ok" ? [...result.stdout] : [], [
    ...Buffer.from("a\0b\0"),
  ]);
});

test("a non-zero exit returns its code and stdout", async (t) => {
  const { executable } = script(t, "printf partial; exit 3");
  const result = await run({ executable });
  assert.equal(result.status, "exit");
  if (result.status !== "exit") return;
  assert.equal(result.exitCode, 3);
  assert.equal(result.childExitObserved, true);
  assert.equal(result.stdout.toString("utf8"), "partial");
});

test("a stalled child is stopped at its deadline and its exit is observed", async (t) => {
  const { executable } = script(t, "exec sleep 30");
  const result = await run({ executable, timeoutMs: 20 });
  assert.deepEqual(result, {
    status: "interrupted",
    kind: "timed-out",
    spawned: true,
    childExitObserved: true,
    childExitSignal: "SIGTERM",
  });
});

test("output above the cap interrupts the child", async (t) => {
  const { executable } = script(t, "head -c 100000 /dev/zero");
  const result = await run({ executable, maxOutputBytes: 1000 });
  assert.equal(result.status, "interrupted");
  assert.equal(
    result.status === "interrupted" ? result.kind : "",
    "output-limit",
  );
});

test("an abort after spawn stops the child; an already-aborted signal never spawns", async (t) => {
  const started = script(t, 'touch "$(dirname "$0")/started"; exec sleep 30');
  const controller = new AbortController();
  const running = run({
    executable: started.executable,
    signal: controller.signal,
  });
  await until(() => existsSync(started.marker));
  controller.abort();
  assert.deepEqual(await running, {
    status: "interrupted",
    kind: "cancelled",
    spawned: true,
    childExitObserved: true,
    childExitSignal: "SIGTERM",
  });

  const never = script(t, 'touch "$(dirname "$0")/started"');
  assert.deepEqual(
    await run({ executable: never.executable, signal: AbortSignal.abort() }),
    {
      status: "interrupted",
      kind: "cancelled",
      spawned: false,
      childExitObserved: false,
      childExitSignal: null,
    },
  );
  assert.equal(existsSync(never.marker), false);
});

test("a missing executable resolves as a failure that never spawned", async () => {
  assert.deepEqual(
    await run({ executable: join(tmpdir(), "ensemble-no-such-git") }),
    {
      status: "interrupted",
      kind: "failed",
      spawned: false,
      childExitObserved: false,
      childExitSignal: null,
    },
  );
});
