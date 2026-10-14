#!/usr/bin/env node
// Bounded live proof for #980: install release A, upgrade to release B, then
// uninstall, under a throwaway label with every path in a fresh private root.
// Only `launchctl print|bootout` of that label is used outside the commands
// under test, and only after its plist path matches the throwaway plist.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LAUNCHCTL = "/bin/launchctl";
const repo = process.cwd();
const started = Date.now();
const evidence = { steps: {}, durationsMs: {} };
let root;
let before;
let target;
let activation;
const pids = new Set();

function step(name, value) {
  evidence.steps[name] = value;
  evidence.durationsMs[name] = Date.now() - started;
  process.stderr.write(`[980-live] ${name}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    code: result.status,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
  };
}

function print() {
  const result = run(LAUNCHCTL, ["print", target], { timeout: 20_000 });
  if (result.code === 113) return null;
  assert.equal(result.code, 0, "launchctl print failed");
  const field = (name) =>
    new RegExp(`^\\t${name} = (.*)$`, "m").exec(result.out)?.[1];
  const pid = field("pid");
  return { path: field("path"), pid: pid ? Number(pid) : undefined };
}

const processGone = (pid) =>
  run("/bin/ps", ["-o", "pid=", "-p", String(pid)]).out.trim() === "";
const processCommand = (pid) =>
  run("/bin/ps", ["-o", "command=", "-p", String(pid)]).out.trim();

async function until(predicate, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} timed out`);
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** Real-folder listings that must not change: names, sizes and mtimes. */
function listing(path, recursive) {
  if (!existsSync(path)) return ["(absent)"];
  const out = [];
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      const state = statSync(full, { throwIfNoEntry: false });
      out.push(
        `${prefix}${name} ${state ? `${state.size} ${state.mtimeMs}` : "?"}`,
      );
      if (recursive && state?.isDirectory()) visit(full, `${prefix}${name}/`);
    }
  };
  visit(path, "");
  return out;
}

function baseline() {
  const library = join(homedir(), "Library");
  return {
    launchctlLabels: run(LAUNCHCTL, ["list"])
      .out.split("\n")
      .slice(1)
      .map((line) => line.split("\t")[2])
      .filter(Boolean)
      .sort(),
    launchAgents: listing(join(library, "LaunchAgents"), true),
    applicationSupportEnsemble: listing(
      join(library, "Application Support", "Ensemble"),
      true,
    ),
    // Other apps write here continuously, so only top-level names are compared.
    logs: listing(join(library, "Logs"), false).map(
      (line) => line.split(" ")[0],
    ),
  };
}

function diff(before, after) {
  const result = {};
  for (const key of Object.keys(before)) {
    const a = new Set(before[key]);
    const b = new Set(after[key]);
    result[key] = {
      removed: [...a].filter((x) => !b.has(x)),
      added: [...b].filter((x) => !a.has(x)),
    };
  }
  return result;
}

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** A version-bump-only commit with no branch or ref, so it cannot be pushed. */
function versionBumpCommit(version) {
  const index = join(root, "bump.index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", "HEAD"], { cwd: repo, env });
  const pkg = JSON.parse(git("show", "HEAD:package.json"));
  pkg.version = version;
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: `${JSON.stringify(pkg, null, 2)}\n`,
    encoding: "utf8",
  }).trim();
  execFileSync(
    "git",
    ["update-index", "--cacheinfo", `100644,${blob},package.json`],
    { cwd: repo, env },
  );
  const tree = execFileSync("git", ["write-tree"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  rmSync(index);
  return execFileSync(
    "git",
    ["commit-tree", tree, "-p", "HEAD", "-m", `Live #980 release ${version}`],
    { cwd: repo, encoding: "utf8" },
  ).trim();
}

function buildAndUnpack(commit, out, versions) {
  const built = run(
    process.execPath,
    ["scripts/package-release.mjs", "build", commit, "--out", out],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 },
  );
  assert.equal(
    built.code,
    0,
    `release build failed: ${built.err.slice(-2000)}`,
  );
  const tarball = readdirSync(out).find((name) => name.endsWith(".tar.gz"));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  const directory = join(versions, manifest.version);
  mkdirSync(directory);
  execFileSync("tar", [
    "-xzf",
    join(out, tarball),
    "--strip-components",
    "1",
    "-C",
    directory,
  ]);
  return { directory, version: manifest.version, commit: manifest.commit };
}

async function main() {
  assert.equal(process.platform, "darwin", "requires macOS");
  root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "ensemble-980-")),
  );
  chmodSync(root, 0o700);
  const label = `local.ensemble.validation-${randomBytes(4).toString("hex")}`;
  const uid = process.getuid();
  target = `gui/${uid}/${label}`;
  const state = join(root, "state");
  const logs = join(root, "logs");
  const agents = join(root, "agents");
  const cli = join(root, "cli");
  for (const dir of [state, logs, agents, cli, join(state, "versions")])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  activation = join(agents, `${label}.plist`);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  evidence.label = label;
  evidence.headCommit = git("rev-parse", "HEAD");
  assert.equal(print(), null, "throwaway label must start unloaded");
  step("1-preflight", { labelAbsent: true });

  const a = buildAndUnpack(
    "HEAD",
    join(root, "build-a"),
    join(state, "versions"),
  );
  const bumpCommit = versionBumpCommit("0.1.1-live.980");
  const b = buildAndUnpack(
    bumpCommit,
    join(root, "build-b"),
    join(state, "versions"),
  );
  step("2-build", {
    releaseA: { version: a.version, commit: a.commit },
    releaseB: {
      version: b.version,
      commit: b.commit,
      refs: "none (dangling commit)",
    },
  });

  // Baselines are taken right around the launchd work to limit unrelated churn.
  before = baseline();

  mkdirSync(join(state, "auth"), { mode: 0o700 });
  const authFile = join(state, "auth", "operator-auth.json");
  const password = randomBytes(24).toString("hex");
  const auth = run(
    join(a.directory, "node", "bin", "node"),
    [
      "--input-type=module",
      "-e",
      `const { OperatorAuth } = await import(${JSON.stringify(pathToFileURL(join(a.directory, "dist/src/standalone/operator-auth.js")).href)});
await OperatorAuth.initialize(process.env.AUTH_FILE, process.env.PASSWORD);`,
    ],
    { env: { PATH: "/usr/bin:/bin", AUTH_FILE: authFile, PASSWORD: password } },
  );
  assert.equal(auth.code, 0, "auth init failed");
  step("3-auth", {
    authFileMode: (statSync(authFile).mode & 0o777).toString(8),
  });

  const env = {
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home"),
    ENSEMBLE_CLI_CONFIG_DIR: join(cli, "config"),
  };
  const options = [
    "--label",
    label,
    "--state-dir",
    state,
    "--log-dir",
    logs,
    "--launch-agents-dir",
    agents,
  ];
  const ensemble = (release, args) =>
    run(join(release.directory, "bin", "ensemble"), args, { env });

  const install = ensemble(a, [
    "service",
    "install",
    ...options,
    "--port",
    String(port),
  ]);
  assert.equal(install.code, 0, `install failed: ${install.err}`);
  const lint = run("/usr/bin/plutil", ["-lint", activation]);
  assert.equal(lint.code, 0);
  const programNode = run("/usr/bin/plutil", [
    "-extract",
    "ProgramArguments.0",
    "raw",
    activation,
  ]).out.trim();
  assert.equal(programNode, join(a.directory, "node", "bin", "node"));
  const jobA = await until(() => print()?.pid && print(), 60_000, "job A pid");
  assert.equal(jobA.path, activation);
  pids.add(jobA.pid);
  const app = await fetch(`${origin}/app`);
  assert.equal(app.status, 200);
  step("4-install", {
    output: JSON.parse(install.out),
    plutilLint: "OK",
    programArguments0: "versions/0.1.0/node/bin/node",
    printPathIsActivation: true,
    pidPresent: true,
    appStatus: app.status,
  });

  let response = await fetch(`${origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  let csrf = (await response.json()).csrfToken;
  const post = (path, body) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  response = await post("/api/operator/login", { password });
  assert.equal(response.status, 200, "session login");
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  csrf = (await response.json()).csrfToken;
  response = await post("/api/operator/credentials", {
    name: "live-980",
    scope: "read",
    expiresInDays: 1,
  });
  assert.equal(response.status, 200, "issue read credential");
  const tokenFile = join(cli, "token");
  writeFileSync(tokenFile, `${(await response.json()).token}\n`, {
    mode: 0o600,
  });
  const login = ensemble(a, [
    "auth",
    "login",
    "--connection",
    "live",
    "--url",
    origin,
    "--token-file",
    tokenFile,
  ]);
  assert.equal(login.code, 0, `auth login failed: ${login.err}`);
  step("5-cli-login", { scope: "read" });

  const upgrade = ensemble(b, [
    "service",
    "upgrade",
    b.directory,
    "--connection",
    "live",
    ...options,
  ]);
  evidence.upgradeExit = upgrade.code;
  evidence.upgradeOutput = JSON.parse(upgrade.out || upgrade.err);
  assert.equal(upgrade.code, 0, `upgrade failed: ${upgrade.err}`);
  assert.ok(processGone(jobA.pid), "release A process exited");
  const jobB = await until(() => print()?.pid && print(), 60_000, "job B pid");
  pids.add(jobB.pid);
  assert.ok(
    processCommand(jobB.pid).includes(join(b.directory, "node", "bin", "node")),
  );
  const report = evidence.upgradeOutput;
  const verify = ensemble(b, ["snapshot", "verify", report.snapshot]);
  assert.equal(verify.code, 0, "snapshot verify");
  step("6-upgrade", {
    output: report,
    oldPidExited: true,
    newPidRunsReleaseB: true,
    snapshotVerify: JSON.parse(verify.out),
  });

  const uninstall = ensemble(b, ["service", "uninstall", ...options]);
  assert.equal(uninstall.code, 0, `uninstall failed: ${uninstall.err}`);
  assert.equal(print(), null);
  await until(() => [...pids].every(processGone), 30_000, "process exit");
  assert.equal(existsSync(activation), false);
  for (const kept of [
    join(state, "data"),
    authFile,
    report.snapshot,
    a.directory,
    b.directory,
    ...report.logs,
  ])
    assert.ok(existsSync(kept), `${kept} kept`);
  step("7-uninstall", {
    output: JSON.parse(uninstall.out),
    printExit: 113,
    pidsExited: true,
    activationRemoved: true,
    kept: ["data", "auth", "snapshot", "both versions", "logs"],
  });

  const after = baseline();
  const changes = diff(before, after);
  evidence.baseline = {
    counts: Object.fromEntries(
      Object.entries(before).map(([key, value]) => [key, value.length]),
    ),
    changes,
  };
  assert.ok(
    Object.values(changes).every((c) => !c.added.length && !c.removed.length),
    "real folders and launchd labels unchanged",
  );
  step("8-postflight", { unchanged: true });
  rmSync(root, { recursive: true });
  evidence.rootRemoved = true;
}

if (!process.argv.includes("--live")) {
  process.stderr.write("Refusing the live launchctl proof without --live.\n");
  process.exit(2);
}
try {
  await main();
  evidence.result = "pass";
} catch (error) {
  evidence.result = "fail";
  evidence.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  // Clean up only our own label, and only when launchd reports our plist.
  try {
    const job = target && print();
    if (job && job.path === activation) {
      if (job.pid) pids.add(job.pid);
      run(LAUNCHCTL, ["bootout", target], { timeout: 20_000 });
      await until(
        () => print() === null && [...pids].every(processGone),
        30_000,
        "cleanup exit",
      );
      evidence.cleanup = "throwaway job booted out and exit confirmed";
    } else if (job)
      evidence.cleanup = "label loaded with an unexpected path; left alone";
  } catch (cleanupError) {
    evidence.cleanup = `cleanup failed: ${cleanupError.message}`;
  }
  if (before) evidence.baselineChangesAfterFailure = diff(before, baseline());
  evidence.retainedRoot = root;
} finally {
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
