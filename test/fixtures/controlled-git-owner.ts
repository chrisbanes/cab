import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import {
  type ControlledGitEvent,
  controlledGit,
  type ProcessIdentity,
} from "./controlled-git.js";

export type StalledGit = {
  controlled: ReturnType<typeof controlledGit>;
  git: ChildProcess;
  identities: ProcessIdentity[];
};

/** Start a stalled fake git whose descendant holds the inherited pipe. */
export async function startStalledGit(): Promise<StalledGit> {
  const controlled = controlledGit();
  controlled.setRule({
    commandPrefix: "status",
    behavior: "stall",
    holdPipe: true,
  });
  const git = spawn(controlled.executable, ["-C", controlled.root, "status"], {
    stdio: "pipe",
  });
  const deadline = Date.now() + 10_000;
  try {
    while (!controlled.events().some((event) => event.event === "ready")) {
      if (Date.now() > deadline)
        throw new Error("Controlled Git fixture never became ready");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    git.kill("SIGKILL");
    await controlled.cleanup().catch(() => {});
    rmSync(controlled.root, { recursive: true, force: true });
    throw error;
  }
  return { controlled, git, identities: recordedIdentities(controlled) };
}

function recordedIdentities(
  controlled: ReturnType<typeof controlledGit>,
): ProcessIdentity[] {
  return controlled
    .events()
    .filter(
      (event): event is ControlledGitEvent & { processStartedAt: string } =>
        (event.event === "start" || event.event === "descendant") &&
        typeof event.processStartedAt === "string",
    )
    .map((event) => ({
      pid: event.pid,
      fixtureToken: event.fixtureToken ?? "",
      processPath: event.processPath ?? "",
      processStartedAt: event.processStartedAt,
    }));
}

// Harness for controlled-git-fixture.test.ts: an owner process the test can
// kill or time out. It reports through a file because `node --test` rewrites
// stdout.
const mode = process.env.CONTROLLED_GIT_OWNER_MODE;
const reportPath = process.env.CONTROLLED_GIT_OWNER_REPORT;

function report(value: unknown): void {
  if (reportPath) appendFileSync(reportPath, `${JSON.stringify(value)}\n`);
}

if (mode === "owner-hold") {
  const { controlled, identities } = await startStalledGit();
  report({ root: controlled.root, identities });
  setInterval(() => {}, 1000);
} else if (mode === "timeout") {
  // node:test's timeout does not run `finally` before --test-force-exit ends
  // this process, so only the fixture's owner watch can clear its processes.
  test("stalled git times out", { timeout: 5000 }, async () => {
    const { controlled, identities } = await startStalledGit();
    report({ root: controlled.root, identities });
    await new Promise<never>(() => {});
  });
}
