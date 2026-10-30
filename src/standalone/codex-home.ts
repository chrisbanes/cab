import { lstat, mkdir, readlink, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** cab's own Codex home and the empty `HOME` Codex runs under; the login is a link into the operator's. */
export interface CodexHome {
  home: string;
  userHome: string;
}

export const codexHomeFor = (dataDir: string): CodexHome => ({
  home: join(dataDir, "codex", "home"),
  userHome: join(dataDir, "codex", "user"),
});

/** The service user's real home, which agent shell commands keep. */
export const realHome = (environment: NodeJS.ProcessEnv): string =>
  environment.HOME || homedir();

/** The operator's own login file: `$CODEX_HOME/auth.json` from the service environment, else `~/.codex/auth.json`. */
export const operatorAuthFile = (environment: NodeJS.ProcessEnv): string =>
  join(
    environment.CODEX_HOME || join(realHome(environment), ".codex"),
    "auth.json",
  );

/** Thrown by `thread/resume` for a Codex conversation started under the previous Codex home. */
export class PreviousCodexHomeError extends Error {
  constructor() {
    super("Started under the previous Codex home; restart the task");
  }
}

export type CodexLoginLink =
  /** Not created yet. */
  | "unlinked"
  | "ok"
  /** The link is intact but the operator's login file is absent or not a regular file. */
  | "missing-target"
  /** A regular file, or a link to another target, stands where the link belongs. */
  | "replaced";

/** Inspects only `lstat`/`stat` metadata; never opens the login file. */
export async function codexLoginLink(
  codex: CodexHome,
  environment: NodeJS.ProcessEnv,
): Promise<CodexLoginLink> {
  const target = operatorAuthFile(environment);
  const link = join(codex.home, "auth.json");
  const entry = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return "unlinked";
  if (!entry.isSymbolicLink() || (await readlink(link)) !== target)
    return "replaced";
  const resolved = await stat(target).catch(() => undefined);
  return resolved?.isFile() ? "ok" : "missing-target";
}

/**
 * Creates both directories owner-only and links `auth.json` into cab's home. The login is
 * never copied: a regular file or a link to another target is refused, not repaired.
 */
export async function prepareCodexHome(
  codex: CodexHome,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(codex.home, { recursive: true, mode: 0o700 });
  await mkdir(codex.userHome, { recursive: true, mode: 0o700 });
  const state = await codexLoginLink(codex, environment);
  if (state === "replaced")
    throw new Error(
      "Codex login link in cab's Codex home was replaced; remove it and restart",
    );
  if (state === "unlinked")
    await symlink(operatorAuthFile(environment), join(codex.home, "auth.json"));
}
