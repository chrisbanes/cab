import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Configuration exported by an enclosing `npm run` must not leak into the nested installs.
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)),
);
// Compiled to dist/test/fixtures, three levels below the repository root.
const root = join(import.meta.dirname, "../../..");

type Lock = {
  packages: Record<string, Record<string, unknown> & { dev?: boolean }>;
};

/** Installs the packed CLI offline from the npm cache with a lockfile derived from the repository's. */
export async function installPacked(dir: string) {
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
    { cwd: root, env: npmEnv },
  );
  // npm 11 prints an array of pack results; npm 12 keys them by package name.
  const results = JSON.parse(packed.stdout) as
    | { filename: string }[]
    | Record<string, { filename: string }>;
  const [result, ...extra] = Array.isArray(results)
    ? results
    : Object.values(results);
  assert.ok(
    result?.filename && extra.length === 0,
    packed.stdout.slice(0, 200),
  );
  const { filename } = result;
  const tarball = join(dir, filename);
  const project = join(dir, "project");
  rmSync(project, { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  ) as Lock;
  const packages: Lock["packages"] = {
    "": {
      name: "ensemble-cli-smoke",
      dependencies: { ensemble: `file:${tarball}` },
    },
    "node_modules/ensemble": {
      version: manifest.version,
      resolved: `file:${tarball}`,
      integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
      license: manifest.license,
      dependencies: manifest.dependencies,
      bin: manifest.bin,
      engines: manifest.engines,
    },
  };
  for (const [path, entry] of Object.entries(lock.packages))
    if (path && !entry.dev) packages[path] = entry;
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "ensemble-cli-smoke",
      private: true,
      dependencies: { ensemble: `file:${tarball}` },
    }),
  );
  writeFileSync(
    join(project, "package-lock.json"),
    JSON.stringify({
      name: "ensemble-cli-smoke",
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  );
  // --offline fails rather than silently resolving from the network.
  await run(
    "npm",
    [
      "ci",
      "--offline",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    { cwd: project, env: npmEnv },
  );
  return project;
}
