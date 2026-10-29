#!/usr/bin/env node
// Bounded live proof for #980 and #1080: install release A from its tarball with the
// one-command install (password prompt on a pseudo-terminal, read credential, CLI
// login, doctor), upgrade to release B, then uninstall, under a throwaway label with
// every path in a fresh private root. Only `launchctl print|bootout` of that label is
// used outside the commands under test, and only after its plist path matches the
// throwaway plist. It never touches the default label, the real Library folders, the
// login Keychain (the token goes to a file) or the browser (--no-open).
//
// `--npm` proves #1327 instead: it packs two local versions of the npm package, installs
// them with `npm install -g --prefix` into the private root, and drives the same lifecycle
// through that prefix's `cab` (install, package update and removal, upgrade, uninstall,
// reinstall). Local tarballs only; nothing is published.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  process.stderr.write(`[1080-live] ${name}\n`);
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

/**
 * Runs a command on a pseudo-terminal (stdout, stderr and stdin are all the pty) and types
 * `password` once, when `prompt` appears. The raw output is returned to the caller only
 * for assertions and is never written to the evidence.
 */
function runOnPty(command, args, { env, prompt, password }) {
  return new Promise((done, fail) => {
    // BSD script rejects a socket as stdin, which is what Node gives a piped child; `cat`
    // turns it into an anonymous pipe. It ends when stdin closes, right after the password.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'cat | "$@"',
        "sh",
        "/usr/bin/script",
        "-q",
        "/dev/null",
        command,
        ...args,
      ],
      {
        env: { ...env, TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    let output = "";
    let typed = false;
    const timer = setTimeout(() => {
      child.stdin.end();
      // The whole group: `cat`, `script` and `cab` outlive a kill of `sh` alone.
      process.kill(-child.pid, "SIGTERM");
    }, 600_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      // A refusal before the prompt must not leave `cat` waiting for input.
      if (!typed && output.includes('{"ok":false')) child.stdin.end();
      if (!typed && output.includes(prompt)) {
        typed = true;
        child.stdin.end(`${password}\r`);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output, typed });
    });
  });
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
      // Spotlight's mdworker.shared labels come and go on their own.
      .filter(
        (label) => label && !label.startsWith("com.apple.mdworker.shared."),
      )
      .sort(),
    launchAgents: listing(join(library, "LaunchAgents"), true),
    applicationSupportcab: listing(
      join(library, "Application Support", "cab"),
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
  return {
    directory,
    version: manifest.version,
    commit: manifest.commit,
    tarball: join(out, tarball),
  };
}

async function main() {
  assert.equal(process.platform, "darwin", "requires macOS");
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "cab-980-")));
  chmodSync(root, 0o700);
  const label = `local.cab.validation-${randomBytes(4).toString("hex")}`;
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

  // Release A is unpacked only to run its `cab`; install unpacks the tarball itself.
  mkdirSync(join(root, "bootstrap"), { mode: 0o700 });
  const a = buildAndUnpack(
    "HEAD",
    join(root, "build-a"),
    join(root, "bootstrap"),
  );
  const installedA = join(state, "versions", a.version);
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

  // The auth file is deliberately not created: install must create it from the prompt.
  const authFile = join(state, "auth", "operator-auth.json");
  const password = randomBytes(24).toString("hex");
  assert.equal(existsSync(authFile), false);

  const env = {
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home"),
    CAB_CLI_CONFIG_DIR: join(cli, "config"),
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
  const cab = (release, args) =>
    run(join(release.directory, "bin", "cab"), args, { env });

  const tokenFile = join(cli, "token");
  const installed = await runOnPty(
    join(a.directory, "bin", "cab"),
    [
      "service",
      "install",
      a.tarball,
      "--connection",
      "live",
      "--token-file",
      tokenFile,
      "--no-open",
      ...options,
      "--port",
      String(port),
    ],
    { env, prompt: "New operator password: ", password },
  );
  assert.ok(installed.typed, "the new-password prompt appeared");
  assert.equal(installed.code, 0, "install failed (output withheld)");
  assert.ok(
    !installed.output.includes(password) && !installed.output.includes("ens_"),
    "neither the password nor a token appears in the terminal output",
  );
  const result = JSON.parse(
    installed.output
      .split(/\r?\n/)
      .find((line) => line.startsWith('{"ok":true,"operation":"install"')),
  );
  assert.equal(result.connection, "live");
  assert.match(installed.output, /Check\s+Status\s+Reason/, "doctor table");
  assert.ok(installed.output.includes(`Open ${origin}/app`));
  assert.equal(
    statSync(authFile).mode & 0o777,
    0o600,
    "install created the auth file",
  );
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const lint = run("/usr/bin/plutil", ["-lint", activation]);
  assert.equal(lint.code, 0);
  const programNode = run("/usr/bin/plutil", [
    "-extract",
    "ProgramArguments.0",
    "raw",
    activation,
  ]).out.trim();
  assert.equal(programNode, join(installedA, "node", "bin", "node"));
  const jobA = await until(() => print()?.pid && print(), 60_000, "job A pid");
  assert.equal(jobA.path, activation);
  pids.add(jobA.pid);
  const app = await fetch(`${origin}/app`);
  assert.equal(app.status, 200);
  const status = cab(a, [
    "auth",
    "status",
    "--connection",
    "live",
    "--output",
    "json",
  ]);
  assert.equal(status.code, 0, `auth status failed: ${status.err}`);
  const { credential } = JSON.parse(status.out).data;
  assert.equal(credential.scope, "read");
  assert.ok(credential.name.startsWith("install · "));
  assert.equal(credential.expiresAt - credential.createdAt, 90 * 86_400_000);
  step("4-install", {
    output: result,
    passwordPromptOnPty: true,
    authFileCreatedByInstall: "0600",
    versionDirectoryCreatedByInstall: existsSync(installedA),
    plutilLint: "OK",
    programArguments0: `versions/${a.version}/node/bin/node`,
    printPathIsActivation: true,
    pidPresent: true,
    appStatus: app.status,
    doctorTableOnTerminal: true,
    outputHasNoPasswordOrToken: true,
  });
  step("5-cli-login", {
    credentialNamePrefix: "install · ",
    scope: credential.scope,
    expiresInDays: 90,
    tokenFileMode: "0600",
  });

  const upgrade = cab(b, [
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
  // Release B's own start took it: the CLI no longer snapshots.
  assert.ok(
    report.snapshot?.startsWith(
      join(state, "snapshots", `startup.${a.version}-to-${b.version}.`),
    ),
    `service-taken snapshot, got ${report.snapshot}`,
  );
  const verify = cab(b, ["snapshot", "verify", report.snapshot]);
  assert.equal(verify.code, 0, "snapshot verify");
  step("6-upgrade", {
    output: report,
    oldPidExited: true,
    newPidRunsReleaseB: true,
    snapshotVerify: JSON.parse(verify.out),
  });

  const uninstall = cab(b, ["service", "uninstall", ...options]);
  assert.equal(uninstall.code, 0, `uninstall failed: ${uninstall.err}`);
  assert.equal(print(), null);
  await until(() => [...pids].every(processGone), 30_000, "process exit");
  assert.equal(existsSync(activation), false);
  for (const kept of [
    join(state, "data"),
    authFile,
    report.snapshot,
    installedA,
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

/** The #1327 proof: the same throwaway label and private root, with the service installed from an npm prefix. */
async function npmMain() {
  assert.equal(process.platform, "darwin", "requires macOS");
  const { packCab, installGlobal, uninstallGlobal } = await import(
    pathToFileURL(join(repo, "dist/test/fixtures/npm-package.js")).href
  );
  const { treeDigest } = await import(
    pathToFileURL(join(repo, "dist/src/cli/release-tree.js")).href
  );
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "cab-1327-")));
  chmodSync(root, 0o700);
  const label = `local.cab.validation-${randomBytes(4).toString("hex")}`;
  target = `gui/${process.getuid()}/${label}`;
  const state = join(root, "state");
  const logs = join(root, "logs");
  const agents = join(root, "agents");
  const cli = join(root, "cli");
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  for (const dir of [state, logs, agents, cli, home])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  activation = join(agents, `${label}.plist`);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  evidence.label = label;
  evidence.headCommit = git("rev-parse", "HEAD");
  evidence.node = process.version;
  evidence.npm = run("npm", ["--version"]).out.trim();
  assert.equal(print(), null, "throwaway label must start unloaded");
  step("1-preflight", { labelAbsent: true });

  const packages = join(root, "packages");
  mkdirSync(packages);
  const a = await packCab(packages, "0.1.0");
  const b = await packCab(packages, "0.1.1-live.1327");
  evidence.packages = {
    a: { version: a.version, integrity: a.integrity },
    b: { version: b.version, integrity: b.integrity },
  };
  const installedRoot = await installGlobal(prefix, a.tarball, home);
  const cab = (args) =>
    run(join(prefix, "bin", "cab"), args, {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        CAB_CLI_CONFIG_DIR: join(cli, "config"),
      },
    });
  assert.equal(cab(["--version"]).out, `cab ${a.version}\n`);
  assert.equal(
    existsSync(join(home, "Library")),
    false,
    "install touched no HOME state",
  );
  assert.equal(
    existsSync(state) && readdirSync(state).length,
    0,
    "install created no STATE",
  );
  step("2-package-install", {
    version: a.version,
    startedNothing: print() === null,
  });

  before = baseline();
  const authFile = join(state, "auth", "operator-auth.json");
  const password = randomBytes(24).toString("hex");
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
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    CAB_CLI_CONFIG_DIR: join(cli, "config"),
  };
  const install = async (tokenName, prompt) => {
    const out = await runOnPty(
      join(prefix, "bin", "cab"),
      [
        "service",
        "install",
        "--connection",
        "live",
        "--token-file",
        join(cli, tokenName),
        "--no-open",
        ...options,
        "--port",
        String(port),
      ],
      { env, prompt, password },
    );
    assert.ok(out.typed, `${prompt} appeared`);
    assert.equal(out.code, 0, "install failed (output withheld)");
    assert.ok(
      !out.output.includes(password) && !out.output.includes("ens_"),
      "no password or token on the terminal",
    );
    return JSON.parse(
      out.output
        .split(/\r?\n/)
        .find((line) => line.startsWith('{"ok":true,"operation":"install"')),
    );
  };
  const stageDir = (version) => join(state, "versions", version);
  const programArgument = (index) =>
    run("/usr/bin/plutil", [
      "-extract",
      `ProgramArguments.${index}`,
      "raw",
      activation,
    ]).out.trim();

  const first = await install("token-1", "New operator password: ");
  assert.equal(first.version, a.version);
  assert.equal(programArgument(0), realpathSync(process.execPath));
  assert.equal(
    programArgument(1),
    join(stageDir(a.version), "dist", "src", "standalone", "cli.js"),
  );
  assert.equal(
    JSON.parse(readFileSync(join(stageDir(a.version), "manifest.json"), "utf8"))
      .schema,
    "cab.npm-stage/v1",
  );
  const jobA = await until(() => print()?.pid && print(), 60_000, "job A pid");
  assert.equal(jobA.path, activation);
  pids.add(jobA.pid);
  assert.equal((await fetch(`${origin}/app`)).status, 200);
  const auth = cab([
    "auth",
    "status",
    "--connection",
    "live",
    "--output",
    "json",
  ]);
  assert.equal(auth.code, 0, `auth status failed: ${auth.err}`);
  assert.equal(JSON.parse(auth.out).data.credential.scope, "read");
  step("3-service-install", {
    output: first,
    programArguments: [
      "bound Node.js (real path of the CLI's node)",
      `versions/${a.version}/dist/src/standalone/cli.js`,
    ],
    stageManifestSchema: "cab.npm-stage/v1",
    appStatus: 200,
    authenticatedCliRead: true,
  });

  const digestA = await treeDigest(stageDir(a.version));
  await installGlobal(prefix, b.tarball, home);
  await uninstallGlobal(prefix, home);
  assert.equal(existsSync(installedRoot), false, "the package is removed");
  assert.equal(
    await treeDigest(stageDir(a.version)),
    digestA,
    "the stage is unchanged",
  );
  assert.equal(print()?.pid, jobA.pid, "the same process still runs");
  assert.equal((await fetch(`${origin}/app`)).status, 200);
  assert.ok(
    processCommand(jobA.pid).includes(stageDir(a.version)),
    "the process runs from the stage",
  );
  step("4-package-update-and-removal", {
    stageDigestUnchanged: true,
    pidUnchanged: jobA.pid > 0,
    appStatus: 200,
  });

  await installGlobal(prefix, b.tarball, home);
  const upgrade = cab([
    "service",
    "upgrade",
    "--connection",
    "live",
    ...options,
  ]);
  evidence.upgradeExit = upgrade.code;
  assert.equal(upgrade.code, 0, `upgrade failed: ${upgrade.err}`);
  const report = JSON.parse(upgrade.out);
  assert.equal(report.version, b.version);
  assert.ok(processGone(jobA.pid), "release A process exited");
  const jobB = await until(() => print()?.pid && print(), 60_000, "job B pid");
  pids.add(jobB.pid);
  assert.ok(
    processCommand(jobB.pid).includes(stageDir(b.version)),
    "the new process runs from the new stage",
  );
  assert.ok(
    report.snapshot?.startsWith(
      join(state, "snapshots", `startup.${a.version}-to-${b.version}.`),
    ),
    `service-taken snapshot, got ${report.snapshot}`,
  );
  const verify = cab(["snapshot", "verify", report.snapshot]);
  assert.equal(verify.code, 0, "snapshot verify");
  assert.ok(existsSync(stageDir(a.version)), "the old stage stays");
  step("5-upgrade", {
    output: report,
    oldPidExited: true,
    newPidRunsStageB: true,
    snapshotVerify: JSON.parse(verify.out),
  });

  const authBytes = readFileSync(authFile);
  const uninstall = cab(["service", "uninstall", ...options]);
  assert.equal(uninstall.code, 0, `uninstall failed: ${uninstall.err}`);
  assert.equal(print(), null);
  await until(() => [...pids].every(processGone), 30_000, "process exit");
  for (const kept of [
    join(state, "data"),
    authFile,
    report.snapshot,
    stageDir(a.version),
    stageDir(b.version),
    ...report.logs,
  ])
    assert.ok(existsSync(kept), `${kept} kept`);
  step("6-uninstall", {
    output: JSON.parse(uninstall.out),
    printExit: 113,
    kept: ["data", "auth", "snapshot", "both stages", "logs"],
  });

  const again = await install("token-2", "Operator password: ");
  assert.equal(again.version, b.version);
  assert.deepEqual(
    readFileSync(authFile),
    authBytes,
    "the existing auth was kept",
  );
  const jobC = await until(() => print()?.pid && print(), 60_000, "job C pid");
  pids.add(jobC.pid);
  assert.equal((await fetch(`${origin}/app`)).status, 200);
  step("7-reinstall", {
    output: again,
    authFileUnchanged: true,
    appStatus: 200,
  });

  const final = cab(["service", "uninstall", ...options]);
  assert.equal(final.code, 0, `final uninstall failed: ${final.err}`);
  assert.equal(print(), null);
  await until(() => [...pids].every(processGone), 30_000, "process exit");
  assert.equal(existsSync(activation), false);

  const changes = diff(before, baseline());
  evidence.baseline = { changes };
  assert.ok(
    Object.values(changes).every((c) => !c.added.length && !c.removed.length),
    "real folders and launchd labels unchanged",
  );
  step("8-postflight", { unchanged: true });
  rmSync(root, { recursive: true });
  evidence.rootRemoved = true;
}

const npmMode = process.argv.includes("--npm");
if (!npmMode && !process.argv.includes("--live")) {
  process.stderr.write("Refusing the live launchctl proof without --live.\n");
  process.exit(2);
}
try {
  await (npmMode ? npmMain() : main());
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
