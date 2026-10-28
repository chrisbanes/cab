import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** The only `GIT_*` values a hardened Git child may see. */
export const hardenedGitEnvironment = {
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export type GitInvocation = { args: string; env: Record<string, string> };

/**
 * A `git` shim that logs the `GIT_*` environment of each invocation and then runs the real
 * Git. Pass `executable` to callers with a `gitExecutable` option; callers that spawn `git`
 * by name find it first on `PATH` inside `withPath`.
 */
export function gitEnvironmentProbe() {
  const directory = mkdtempSync(join(tmpdir(), "cab-git-environment-"));
  const binDirectory = join(directory, "bin");
  const log = join(directory, "invocations");
  mkdirSync(binDirectory);
  mkdirSync(log);
  const executable = join(binDirectory, "git");
  const realGit = spawnSync("which", ["git"], {
    encoding: "utf8",
  }).stdout.trim();
  writeFileSync(
    executable,
    `#!/bin/sh
# One file per invocation: concurrent probes must not interleave records.
{ printf '%s\\n' "--invocation $*"; /usr/bin/env | /usr/bin/grep '^GIT_' | /usr/bin/sort; } > '${log}'/$$
exec '${realGit}' "$@"
`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    binDirectory,
    invocations(): GitInvocation[] {
      const result: GitInvocation[] = [];
      const lines = readdirSync(log).flatMap((name) =>
        readFileSync(join(log, name), "utf8").split("\n"),
      );
      for (const line of lines) {
        if (line.startsWith("--invocation "))
          result.push({ args: line.slice(13), env: {} });
        else if (line.includes("=")) {
          const split = line.indexOf("=");
          const env = result.at(-1)?.env;
          if (env) env[line.slice(0, split)] = line.slice(split + 1);
        }
      }
      return result;
    },
    async withPath<T>(fn: () => Promise<T>): Promise<T> {
      const previous = process.env.PATH;
      process.env.PATH = `${binDirectory}${delimiter}${previous ?? ""}`;
      try {
        return await fn();
      } finally {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
      }
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with hostile `GIT_*` values in `process.env`, restoring the previous values. */
export async function withHostileGitEnvironment<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const decoy = mkdtempSync(join(tmpdir(), "cab-hostile-git-"));
  const cleanEnvironment = { ...process.env };
  for (const key of Object.keys(cleanEnvironment))
    if (key.startsWith("GIT_")) delete cleanEnvironment[key];
  execFileSync("git", ["init", "-q", "--bare", join(decoy, "decoy.git")], {
    env: cleanEnvironment,
  });
  const globalConfig = join(decoy, "global-config");
  writeFileSync(globalConfig, "[user]\n\tname = Hostile\n");
  const hostile: Record<string, string> = {
    GIT_DIR: join(decoy, "decoy.git"),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoy, "hostile.index"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.url",
    GIT_CONFIG_VALUE_0: "https://example.invalid/hostile/decoy.git",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_EXEC_PATH: join(decoy, "exec-path"),
    GIT_SSH_COMMAND: "false",
    GIT_ALLOW_PROTOCOL: "file:ssh:https",
    GIT_TERMINAL_PROMPT: "1",
    GIT_NO_LAZY_FETCH: "0",
    GIT_OPTIONAL_LOCKS: "1",
  };
  const previous = new Map(
    Object.keys(hostile).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, hostile);
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(decoy, { recursive: true, force: true });
  }
}
