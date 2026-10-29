import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Compiled to dist/test/fixtures, three levels below the repository root.
const root = join(import.meta.dirname, "../../..");

// Configuration exported by an enclosing `npm run` must not leak into the nested npm
// commands. A user-level .npmrc is ignored like CI, which has none.
const npmEnv = (home: string = homedir()): Record<string, string> => ({
  ...(Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => !/^npm_/i.test(key) && value !== undefined,
    ),
  ) as Record<string, string>),
  HOME: home,
  NPM_CONFIG_USERCONFIG: "/dev/null",
  // A throwaway HOME must not discard the cache that serves the installs.
  NPM_CONFIG_CACHE:
    process.env.npm_config_cache ??
    process.env.NPM_CONFIG_CACHE ??
    join(homedir(), ".npm"),
});

export type PackedTarball = {
  tarball: string;
  name: string;
  version: string;
  integrity: string;
  files: { path: string; mode: number }[];
};

/** `npm pack` in `cwd`; the output shape differs between npm 11 (an array) and npm 12 (keyed by name). */
export async function packTarball(
  cwd: string,
  destination: string,
): Promise<PackedTarball> {
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    { cwd, env: npmEnv() },
  );
  const results = JSON.parse(packed.stdout) as
    | PackResult[]
    | Record<string, PackResult>;
  const [result, ...extra] = Array.isArray(results)
    ? results
    : Object.values(results);
  if (!result?.filename || extra.length > 0)
    throw new Error(
      `Unexpected npm pack output: ${packed.stdout.slice(0, 200)}`,
    );
  return {
    tarball: join(destination, result.filename),
    name: result.name,
    version: result.version,
    integrity: result.integrity,
    files: result.files,
  };
}

type PackResult = Omit<PackedTarball, "tarball"> & { filename: string };

/** Packs the built package from the repository as `version`, from a copy of the files `package.json` publishes. */
export async function packCab(
  directory: string,
  version?: string,
): Promise<PackedTarball> {
  const source = join(directory, `source-${version ?? "built"}`);
  mkdirSync(source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ ...manifest, version: version ?? manifest.version }),
  );
  for (const path of ["LICENSE", "README.md", ...manifest.files])
    cpSync(join(root, path), join(source, path), { recursive: true });
  return packTarball(source, directory);
}

const globalArgs = (prefix: string) => [
  "--global",
  "--prefix",
  prefix,
  "--prefer-offline",
  "--no-audit",
  "--no-fund",
];

/** `npm install -g` of `tarball` into an isolated `prefix`, as a user with `home` would. */
export async function installGlobal(
  prefix: string,
  tarball: string,
  home: string,
) {
  await run("npm", ["install", ...globalArgs(prefix), tarball], {
    env: npmEnv(home),
    timeout: 300_000,
  });
  return globalPackage(prefix);
}

export async function uninstallGlobal(prefix: string, home: string) {
  await run("npm", ["uninstall", ...globalArgs(prefix), "@chrisbanes/cab"], {
    env: npmEnv(home),
    timeout: 120_000,
  });
}

/** The package root a global install under `prefix` creates. */
export const globalPackage = (prefix: string) =>
  join(prefix, "lib", "node_modules", "@chrisbanes", "cab");
