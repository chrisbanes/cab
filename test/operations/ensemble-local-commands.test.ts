import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { StandaloneDataDirectory } from "../../src/standalone/data-directory.js";
import { markedDataDirectory } from "../fixtures/marked-data.js";
import { tmpdir } from "../fixtures/temp.js";

const MAIN = resolve("dist/src/cli/main.js");
const OPERATIONS = resolve("dist/src/standalone/operations-cli.js");

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-local-commands-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a --help after -- is the value of a service or snapshot command, not a help request", (t) => {
  const root = fixture(t);
  const home = { HOME: root };
  // The tarball named `--help` does not exist: install refuses in preflight and creates nothing.
  const install = run(MAIN, ["service", "install", "--", "--help"], home);
  assert.equal(install.code, 1);
  assert.equal(install.out, "");
  const report = JSON.parse(install.err);
  assert.equal(report.operation, "install");
  assert.equal(report.stage, "preflight");
  assert.match(report.error, /--help is not a readable file$/);
  assert.equal(existsSync(join(root, "Library")), false);
  // The version directory named `--help` is not an install to upgrade.
  const upgrade = run(MAIN, ["service", "upgrade", "--", "--help"], home);
  assert.equal(upgrade.code, 1);
  assert.equal(upgrade.out, "");
  assert.match(JSON.parse(upgrade.err).error, /is not installed/);
  // The authentication file named `--help`: init-auth stops before creating anything.
  const auth = run(MAIN, ["service", "init-auth", "--", "--help"], home);
  assert.equal(auth.code, 1);
  assert.equal(auth.out, "");
  assert.match(auth.err, /run it in an interactive terminal/);
  // snapshot takes no option terminator, so `--` and `--help` are two unexpected words.
  const snapshot = run(MAIN, ["snapshot", "verify", "--", "--help"], home);
  assert.equal(snapshot.code, 2);
  assert.equal(snapshot.out, "");
  assert.match(
    snapshot.err,
    /^ensemble: Unexpected arguments\. \(usage\)\nUsage:\n/,
  );
  assert.equal(existsSync(join(root, "Library")), false);
});

test("ensemble snapshot create, verify and restore match the operations entry point", (t) => {
  const root = fixture(t);
  const data = join(root, "data");
  markedDataDirectory(data);
  mkdirSync(join(root, "snapshots"), { mode: 0o700 });
  const snapshot = join(root, "snapshots", "one");

  const created = run(MAIN, ["snapshot", "create", data, snapshot]);
  assert.equal(created.code, 0, created.err);
  const backup = JSON.parse(created.out);
  assert.equal(backup.ok, true);
  assert.equal(backup.operation, "backup");

  const verified = run(MAIN, ["snapshot", "verify", snapshot]);
  assert.equal(verified.code, 0, verified.err);
  const legacy = run(OPERATIONS, ["verify", snapshot]);
  assert.equal(legacy.code, 0, legacy.err);
  assert.deepEqual(JSON.parse(verified.out), JSON.parse(legacy.out));
  assert.deepEqual(JSON.parse(verified.out).manifest, backup.manifest);

  const restored = run(MAIN, [
    "snapshot",
    "restore",
    snapshot,
    join(root, "restored"),
  ]);
  assert.equal(restored.code, 0, restored.err);
  assert.equal(JSON.parse(restored.out).operation, "restore");
  assert.deepEqual(JSON.parse(restored.out).manifest, backup.manifest);
});

test("ensemble snapshot create fails without a raw cause while the owner lock is held", (t) => {
  const root = fixture(t);
  const data = join(root, "data");
  markedDataDirectory(data);
  const owner = StandaloneDataDirectory.openExclusive(data);
  try {
    const result = run(MAIN, ["snapshot", "create", data, join(root, "snap")]);
    assert.equal(result.code, 1);
    assert.equal(result.err, '{"ok":false,"error":"operation failed"}\n');
  } finally {
    owner.close();
  }
  assert.equal(run(MAIN, ["snapshot", "create", data]).code, 2);
  assert.equal(run(MAIN, ["snapshot", "render-launch-agent"]).code, 2);
});

test("ensemble service init-auth needs a terminal and creates nothing without one", (t) => {
  const root = fixture(t);
  const authFile = join(root, "auth", "operator-auth.json");
  const result = run(MAIN, ["service", "init-auth", authFile]);
  assert.equal(result.code, 1);
  assert.match(result.err, /interactive terminal/);
  assert.equal(existsSync(join(root, "auth")), false);

  const home = join(root, "home");
  mkdirSync(home);
  assert.equal(run(MAIN, ["service", "init-auth"], { HOME: home }).code, 1);
  assert.equal(existsSync(join(home, "Library")), false);
});

test("ensemble service without a subcommand or data directory starts nothing", (t) => {
  const root = fixture(t);
  const bare = run(MAIN, ["service"]);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /service init-auth/);

  const list = run(MAIN, ["service", "list"], { HOME: root });
  assert.equal(list.code, 1);
  assert.equal(list.err, "ensemble: service list failed\n");
  assert.equal(list.out, "");
});

test("ensemble --help --all lists the local service and snapshot commands", () => {
  const help = run(MAIN, ["--help", "--all"]);
  assert.equal(help.code, 0);
  for (const command of [
    "service init-auth",
    "service serve|operator|run|list",
    "snapshot create",
    "snapshot verify",
    "snapshot restore",
  ])
    assert.ok(help.out.includes(command), command);
  assert.ok(!help.out.includes("rollback"));
  assert.ok(!help.out.includes("render-launch-agent"));

  // `ensemble service --help` shows the same service lines on stdout.
  const service = run(MAIN, ["service", "--help"]);
  assert.equal(service.code, 0);
  assert.equal(service.err, "");
  for (const command of [
    "service init-auth",
    "service serve|operator|run|list",
  ])
    assert.ok(service.out.includes(command), command);
  assert.ok(!service.out.includes("snapshot create"));
  // serve, operator, run and list hand `--help` to the service instead.
  const forwarded = run(MAIN, ["service", "list", "--help"]);
  assert.equal(forwarded.code, 1);
  assert.equal(forwarded.out, "");
  assert.equal(forwarded.err, "ensemble: service list failed\n");
});
