import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * What `path --version` prints on stdout. The child's environment is `PATH` alone, because the
 * service environment holds credentials. Rejects on a failure or after `timeoutMs`.
 */
export async function printVersion(
  path: string,
  searchPath: string,
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync(path, ["--version"], {
    env: { PATH: searchPath },
    timeout: timeoutMs,
    maxBuffer: 4096,
  });
  return stdout;
}
