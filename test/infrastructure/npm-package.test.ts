import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  globalPackage,
  installGlobal,
  packCab,
  uninstallGlobal,
} from "../fixtures/npm-package.js";
import { tmpdir } from "../fixtures/temp.js";

const run = promisify(execFile);

test("the packed package holds the service, UI and cab executable, and installs globally without side effects", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cab-npm-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packed = await packCab(dir);
  const paths = packed.files.map((file) => file.path);
  for (const required of [
    "dist/src/cli/main.js",
    "dist/src/standalone/cli.js",
    "dist/operator/index.html",
    "package.json",
    "LICENSE",
  ])
    assert.ok(paths.includes(required), `${required} is packed`);
  assert.ok(
    paths.some((path) => /^dist\/operator\/assets\//.test(path)),
    "an operator asset is packed",
  );
  assert.deepEqual(
    paths.filter(
      (path) =>
        /^(test|dist\/test|src|web|scripts|docs|\.github|node_modules)\//.test(
          path,
        ) ||
        (/\.ts$/.test(path) && !/\.d\.ts$/.test(path)),
    ),
    [],
  );
  const { scripts = {} } = JSON.parse(
    readFileSync(join(dir, "source-built", "package.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(scripts).filter((name) =>
      /^(pre|post)?(install|prepare)$/.test(name),
    ),
    [],
    "an install must run no lifecycle script",
  );

  const home = join(dir, "home");
  const prefix = join(dir, "prefix");
  mkdirSync(home);
  const root = await installGlobal(prefix, packed.tarball, home);
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  // npm marks the bin executable on install; the empty PATH finds no checkout's node_modules.
  assert.ok(statSync(join(prefix, "bin", "cab")).mode & 0o111);
  assert.equal(
    (
      await run(join(prefix, "bin", "cab"), ["--version"], {
        env: { PATH: process.env.PATH ?? "", HOME: home },
      })
    ).stdout,
    `cab ${version}\n`,
  );
  const lock = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../package-lock.json"),
      "utf8",
    ),
  ) as { packages: Record<string, { dev?: boolean }> };
  const installedDev = Object.entries(lock.packages).filter(
    ([path, entry]) => path && entry.dev && existsSync(join(root, path)),
  );
  assert.deepEqual(installedDev, [], "no dev-only package is installed");
  assert.ok(
    existsSync(join(root, "node_modules", "zod")),
    "dependencies nest under the package root",
  );

  // The install created nothing a service would own, and removal leaves the HOME as it was.
  assert.ok(!existsSync(join(home, "Library")));
  const before = readdirSync(home, { recursive: true });
  await uninstallGlobal(prefix, home);
  assert.ok(!existsSync(root));
  assert.deepEqual(readdirSync(home, { recursive: true }), before);
  assert.ok(!existsSync(globalPackage(prefix)));
});
