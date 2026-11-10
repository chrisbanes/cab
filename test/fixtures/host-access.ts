import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Host access some tests need but an agent sandbox may deny. Each probe runs once, up
 * front, and returns a skip reason for node:test's `skip` option, or `false` when the
 * access works, so the same assertions run in full wherever it is allowed (including CI).
 */

type SpawnResult = {
  error?: Error | undefined;
  status: number | null;
  stdout?: string | null;
};

/** Reading a process's start time with `ps`, as process-identity fixtures do. */
export function processIdentityProbe(
  run: () => SpawnResult = () =>
    spawnSync("ps", ["-ww", "-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 5000,
    }),
): string | false {
  const result = run();
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.error)
    return `process identity is unavailable here: ps failed to run (${code ?? result.error.message})`;
  if (result.status !== 0 || !result.stdout?.trim())
    return `process identity is unavailable here: ps exited ${result.status} without a start time`;
  return false;
}

/** Creating a directory directly under /tmp, as the Claude temporary base requires. */
export function slashTmpProbe(
  create: (path: string) => void = (path) => mkdirSync(path, { mode: 0o700 }),
  remove: (path: string) => void = rmdirSync,
): string | false {
  const path = join("/tmp", `cab-probe-${randomUUID()}`);
  try {
    create(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EROFS")
      return `writing directly under /tmp is denied here (${code})`;
    throw error;
  }
  remove(path);
  return false;
}

/**
 * Runs a probe on first use only; later calls return its first answer. With `CI` set,
 * a denial throws instead, so CI never skips these tests.
 */
export function once(
  probe: () => string | false,
  ci: boolean = !!process.env.CI,
): () => string | false {
  let answer: string | false | undefined;
  return () => {
    answer ??= probe();
    if (answer && ci) throw new Error(`CI must allow this access: ${answer}`);
    return answer;
  };
}

export const processIdentityDenied = once(() => processIdentityProbe());
export const slashTmpDenied = once(() => slashTmpProbe());
