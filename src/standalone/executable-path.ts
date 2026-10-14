import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The first `PATH` directory holding an executable regular file called `name`, as that
 * directory's own entry (a symlink is followed to test it, but not resolved in the result).
 */
export async function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    // shortcut: relative and empty entries depend on the cwd; skipped, not resolved.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep searching.
    }
  }
  return null;
}

/** How long a probe child gets to exit on SIGTERM before it is killed. */
const killGraceMs = 1000;
const maxOutputBytes = 4096;

/**
 * What `path --version` prints on stdout. The child's environment is `PATH` alone, because the
 * service environment holds credentials. After `timeoutMs` the child gets SIGTERM, then SIGKILL
 * after a grace period, and the promise settles only once it has exited, so a hung `claude`
 * never outlives its probe. Rejects on a spawn failure, a non-zero exit or the timeout.
 * shortcut: descendants the child started are not tracked; upgrade to a process group if a
 * wrapper `claude` must be covered.
 */
export function printVersion(
  path: string,
  searchPath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["--version"], {
      env: { PATH: searchPath },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk}`.slice(0, maxOutputBytes);
    });
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const settle = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      child.stdout.destroy();
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Already gone: a descendant holds the pipe, and there is no child left to wait for.
      if (child.exitCode !== null || child.signalCode !== null)
        return settle(new Error("Version probe timed out"));
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, timeoutMs);
    // A spawn failure has no exit to wait for.
    child.once("error", settle);
    child.once("exit", () => {
      if (timedOut) settle(new Error("Version probe timed out"));
    });
    // Close, not exit, so a normal run's output is complete before it is read.
    child.once("close", (code) =>
      settle(
        timedOut || code !== 0 ? new Error("Version probe failed") : undefined,
      ),
    );
  });
}
