import assert from "node:assert/strict";
import {
  type ChildProcess,
  execFile,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { treeDigest } from "../../src/cli/release-tree.js";
import {
  type CliDeps,
  installCli,
  operatorConnection,
} from "../../src/cli/main.js";
import {
  installService,
  type ServiceHost,
  type ServiceOptions,
  uninstallService,
  upgradeService,
} from "../../src/cli/service.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import { MemoryKeychain } from "../fixtures/cli-harness.js";
import {
  globalPackage,
  installGlobal,
  packCab,
  uninstallGlobal,
} from "../fixtures/npm-package.js";
import { tmpdir } from "../fixtures/temp.js";

const run = promisify(execFile);
const { fakeCodex } = (await import(
  pathToFileURL(resolve("scripts/package-release.mjs")).href
)) as { fakeCodex: string };

const PASSWORD = "npm lifecycle password";
const LABEL = "local.cab.npmtest";

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

const unescape = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** The strings of a plist `<array>` or the key/string pairs of a `<dict>` that follow `key`. */
function plistSection(plist: string, key: string) {
  return new RegExp(
    `<key>${key}</key>\\s*<(array|dict)>([\\s\\S]*?)</\\1>`,
  ).exec(plist)?.[2] as string;
}

/**
 * launchd for one label: `bootstrap` runs the rendered plist's ProgramArguments and
 * EnvironmentVariables as a real child process, and `bootout` ends it. Everything else is real.
 */
class SpawningLaunchd {
  jobs = new Map<string, { path: string; child: ChildProcess }>();
  readonly all = new Set<ChildProcess>();

  constructor(
    readonly home: string,
    readonly codexDir: string,
  ) {}

  alive = (child: ChildProcess) =>
    child.exitCode === null && child.signalCode === null;

  async stop(child: ChildProcess) {
    if (!this.alive(child)) return;
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(timer);
  }

  async stopAll() {
    for (const child of this.all) await this.stop(child);
  }

  host(): ServiceHost {
    return {
      uid: process.getuid?.() ?? -1,
      isRoot: () => false,
      daemonsDir: () => join(this.home, "daemons"),
      portOwner: async () => [],
      launchctl: async (args) => {
        const [command, target = "", path = ""] = args;
        const label = target.split("/").at(-1) as string;
        const job = this.jobs.get(label);
        if (command === "print")
          return job && !target.startsWith("system/")
            ? {
                status: 0,
                stdout: `${target} = {\n\tpath = ${job.path}\n\tstate = running\n\tpid = ${job.child.pid}\n}\n`,
              }
            : { status: 113, stdout: "" };
        if (command === "bootstrap") {
          const plist = readFileSync(path, "utf8");
          const argv = [
            ...plistSection(plist, "ProgramArguments").matchAll(
              /<string>([^<]*)<\/string>/g,
            ),
          ].map((match) => unescape(match[1] as string));
          const environment = Object.fromEntries(
            [
              ...plistSection(plist, "EnvironmentVariables").matchAll(
                /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g,
              ),
            ].map((match) => [match[1], unescape(match[2] as string)]),
          );
          const [stdout, stderr] = ["StandardOutPath", "StandardErrorPath"].map(
            (key) =>
              openSync(
                unescape(
                  new RegExp(
                    `<key>${key}</key>\\s*<string>([^<]*)</string>`,
                  ).exec(plist)?.[1] as string,
                ),
                "a",
              ),
          );
          const child = spawn(argv[0] as string, argv.slice(1), {
            env: {
              ...environment,
              HOME: this.home,
              PATH: `${this.codexDir}:${environment.PATH}`,
            },
            stdio: ["ignore", stdout, stderr],
          });
          closeSync(stdout as number);
          closeSync(stderr as number);
          this.all.add(child);
          this.jobs.set(basename(path, ".plist"), { path, child });
          return { status: 0, stdout: "" };
        }
        if (command === "bootout") {
          this.jobs.delete(label);
          if (job) await this.stop(job.child);
          return { status: job ? 0 : 3, stdout: "" };
        }
        return { status: 1, stdout: "" };
      },
      lint: async () => true,
      captureIdentity: async (pid) => ({ processId: String(pid) }),
      exited: async (identity) => {
        const { processId } = identity as { processId: string };
        return ![...this.all].some(
          (child) => String(child.pid) === processId && this.alive(child),
        );
      },
      fetch,
      now: Date.now,
      sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 100))),
      timeout: (ms) => AbortSignal.timeout(ms),
      rename: renameSync,
      extract: async () => false,
      nodeVersion: async (path) =>
        (await run(path, ["--version"])).stdout.trim(),
      open: async () => {},
      hostname: () => "test-host",
      account: () => ({ name: "operator", home: this.home }),
      ghTokenStorage: async () => "unknown",
    };
  }
}

const capture = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => {
    out += chunk;
  });
  stderr.on("data", (chunk) => {
    err += chunk;
  });
  return {
    io: {
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    },
    stdout: () => out,
    stderr: () => err,
  };
};

/** One sandbox: a HOME, STATE, an isolated npm prefix, a fake `codex` and the spawning launchd. */
async function sandbox(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cab-npm-lifecycle-"));
  chmodSync(dir, 0o700);
  const home = join(dir, "home");
  const prefix = join(dir, "prefix");
  const codexDir = join(dir, "codex-bin");
  for (const path of [home, codexDir])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(codexDir, "fake-codex.mjs"), fakeCodex);
  writeFileSync(
    join(codexDir, "codex"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(codexDir, "fake-codex.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  const launchd = new SpawningLaunchd(home, codexDir);
  t.after(async () => {
    await launchd.stopAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const stateDir = join(home, "Library", "Application Support", "cab");
  const options: ServiceOptions = {
    stateDir,
    logDir: join(home, "Library", "Logs", "cab"),
    agentsDir: join(home, "Library", "LaunchAgents"),
    daemonsDir: join(home, "daemons"),
    label: LABEL,
    port: await freePort(),
  };
  mkdirSync(options.agentsDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configDir = join(dir, "config");
  const deps = {
    env: { HOME: home, CAB_CLI_CONFIG_DIR: configDir },
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: new PassThrough(),
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    fetch,
    platform: "linux",
    keychain: () => new MemoryKeychain(),
    now: Date.now,
  } satisfies CliDeps;
  const origin = `http://127.0.0.1:${options.port}`;
  return {
    dir,
    home,
    prefix,
    stateDir,
    options,
    launchd,
    host: launchd.host(),
    deps,
    origin,
    configDir,
    install: async (root: string, tokenFile?: string) => {
      const out = capture();
      const code = await installService(options, root, launchd.host(), out.io, {
        connection: "local",
        open: false,
        tokenFile,
        cli: {
          ...installCli(deps),
          interactive: true,
          readPassword: async () => PASSWORD,
        },
      });
      return { code, stdout: out.stdout(), stderr: out.stderr() };
    },
    upgrade: async (root: string) => {
      const out = capture();
      const code = await upgradeService(
        options,
        root,
        operatorConnection(deps, "local"),
        launchd.host(),
        out.io,
        { implicit: true },
      );
      return { code, stdout: out.stdout(), stderr: out.stderr() };
    },
    uninstall: async () => {
      const out = capture();
      const code = await uninstallService(options, launchd.host(), out.io);
      return { code, stdout: out.stdout(), stderr: out.stderr() };
    },
    record: () =>
      JSON.parse(
        readFileSync(join(stateDir, "launchd", `${LABEL}.json`), "utf8"),
      ),
  };
}

/** A password sign-in as the browser does it: the session cookie and CSRF token. */
async function signIn(origin: string, password: string) {
  let cookie = "";
  const call = async (
    method: string,
    path: string,
    csrf = "",
    body?: object,
  ) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return response;
  };
  const first = (await (await call("GET", "/api/operator/session")).json()) as {
    csrfToken: string;
  };
  const login = await call("POST", "/api/operator/login", first.csrfToken, {
    password,
  });
  assert.equal(login.status, 200);
  const session = (await login.json()) as { csrfToken: string };
  return {
    session: async () =>
      (await (await call("GET", "/api/operator/session")).json()) as {
        authenticated: boolean;
      },
    mint: async () => {
      const response = await call(
        "POST",
        "/api/operator/credentials",
        session.csrfToken,
        { name: "npm lifecycle", scope: "read", expiresInDays: 1 },
      );
      assert.equal(response.status, 200);
      return ((await response.json()) as { token: string }).token;
    },
  };
}

const fingerprint = (path: string) =>
  existsSync(path) ? treeDigest(path) : "absent";

/** Waits for the app to answer; the job's own wait is not involved in a hand restart. */
async function appServed(origin: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await fetch(`${origin}/app`).catch(() => undefined))?.status === 200)
      return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail("the app did not answer after the restart");
}

/** The first operator asset the app links, served from disk by the running service. */
async function assetStatus(origin: string) {
  const html = await (await fetch(`${origin}/app`)).text();
  const asset = html.match(/\/assets\/[^"']+/)?.[0] as string;
  assert.ok(asset, "the app links an asset");
  return (await fetch(`${origin}${asset}`)).status;
}

test("a service installed from a global npm package keeps running from its own copy through package update, upgrade, uninstall and reinstall", async (t) => {
  const s = await sandbox(t);
  const packages = join(s.dir, "packages");
  mkdirSync(packages);
  const a = await packCab(packages, "0.1.0");
  const b = await packCab(packages, "0.2.0");
  const root = await installGlobal(s.prefix, a.tarball, s.home);
  assert.equal(root, globalPackage(s.prefix));
  const tokenFile = join(s.dir, "local.token");

  // Calibration: the first install serves the app from a process run from the staged copy.
  const installed = await s.install(root, tokenFile);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).version, "0.1.0");
  const stageA = join(s.stateDir, "versions", "0.1.0");
  const cliPath = join(stageA, "dist", "src", "standalone", "cli.js");
  assert.equal(s.record().configuration.cliPath, cliPath);
  assert.equal(s.record().configuration.nodePath, realNode());
  const job = s.launchd.jobs.get(LABEL);
  assert.ok(job?.child.pid);
  const pid = job.child.pid;
  assert.equal((await fetch(`${s.origin}/app`)).status, 200);
  assert.equal(await assetStatus(s.origin), 200);

  await t.test(
    "the install authenticates the CLI and refuses an unauthenticated read",
    async () => {
      assert.ok(existsSync(tokenFile));
      const checks = await operatorConnection(s.deps, "local").readiness(
        AbortSignal.timeout(30_000),
      );
      assert.ok(checks.every((check) => check.status !== "fail"));
      const browser = await signIn(s.origin, PASSWORD);
      assert.equal((await browser.session()).authenticated, true);
      assert.equal(
        (await fetch(`${s.origin}/api/operator/readiness`)).status,
        401,
      );
    },
  );

  const digestA = await treeDigest(stageA);
  await t.test(
    "updating then removing the package changes nothing the service runs",
    async () => {
      await installGlobal(s.prefix, b.tarball, s.home);
      await uninstallGlobal(s.prefix, s.home);
      assert.ok(!existsSync(root));
      assert.equal(await treeDigest(stageA), digestA);
      assert.ok(s.launchd.alive(job.child));
      assert.equal(s.launchd.jobs.get(LABEL)?.child.pid, pid);
      assert.equal((await fetch(`${s.origin}/app`)).status, 200);
      assert.equal(await assetStatus(s.origin), 200);
      const state = JSON.parse(
        readFileSync(join(s.stateDir, "data", "startup-state.json"), "utf8"),
      );
      assert.equal(state.release, "0.1.0");
      // A restart of the recorded job, with the package gone, needs only the staged files.
      const target = `gui/${s.host.uid}/${LABEL}`;
      await s.host.launchctl(["bootout", target]);
      assert.equal(s.launchd.alive(job.child), false);
      await s.host.launchctl([
        "bootstrap",
        `gui/${s.host.uid}`,
        join(s.options.agentsDir, `${LABEL}.plist`),
      ]);
      await appServed(s.origin);
    },
  );

  await t.test(
    "upgrade from the new package reaches readiness on its version with a verified snapshot",
    async () => {
      const reinstalled = await installGlobal(s.prefix, b.tarball, s.home);
      const upgraded = await s.upgrade(reinstalled);
      assert.equal(upgraded.code, 0, upgraded.stderr);
      const report = JSON.parse(upgraded.stdout);
      assert.equal(report.version, "0.2.0");
      assert.ok(
        report.readiness.every(
          (check: { status: string }) => check.status !== "fail",
        ),
      );
      assert.equal(typeof report.snapshot, "string");
      assert.equal(
        spawnSync(
          join(s.prefix, "bin", "cab"),
          ["snapshot", "verify", report.snapshot],
          {
            env: { PATH: process.env.PATH ?? "", HOME: s.home },
          },
        ).status,
        0,
      );
      assert.ok(existsSync(stageA), "the old stage stays");
      assert.equal(s.record().version, "0.2.0");
      assert.equal((await fetch(`${s.origin}/app`)).status, 200);
    },
  );

  await t.test(
    "uninstall keeps data, auth, snapshots and versions, and a reinstall reuses them",
    async () => {
      // SQLite's journal, shm and wal files exist only while the service has the database open.
      const dataNames = () =>
        readdirSync(join(s.stateDir, "data"))
          .filter((name) => !/-(journal|shm|wal)$/.test(name))
          .sort();
      const keep = async () =>
        Promise.all(
          ["auth", "snapshots", "versions"].map((name) =>
            fingerprint(join(s.stateDir, name)),
          ),
        );
      const authFile = join(s.stateDir, "auth", "operator-auth.json");
      const authBytes = readFileSync(authFile);
      const names = dataNames();
      const before = await keep();
      const removed = await s.uninstall();
      assert.equal(removed.code, 0, removed.stderr);
      assert.equal(s.launchd.jobs.size, 0);
      assert.deepEqual(await keep(), before);
      assert.deepEqual(dataNames(), names);
      assert.equal(
        existsSync(join(s.options.agentsDir, `${LABEL}.plist`)),
        false,
      );

      const again = await s.install(
        globalPackage(s.prefix),
        join(s.dir, "again.token"),
      );
      assert.equal(again.code, 0, again.stderr);
      assert.equal(JSON.parse(again.stdout).version, "0.2.0");
      assert.deepEqual(
        readFileSync(authFile),
        authBytes,
        "the existing auth is kept",
      );
      assert.equal((await fetch(`${s.origin}/app`)).status, 200);
    },
  );
});

test("the packaged CLI works against a service with no local server files", async (t) => {
  const s = await sandbox(t);
  const packages = join(s.dir, "packages");
  mkdirSync(packages);
  await installGlobal(s.prefix, (await packCab(packages)).tarball, s.home);
  // A service started by hand elsewhere: no install record, LaunchAgent or STATE in the CLI's HOME.
  const serviceHome = join(s.dir, "service-home");
  mkdirSync(serviceHome, { mode: 0o700 });
  const authFile = join(serviceHome, "operator-auth.json");
  await OperatorAuth.initialize(authFile, PASSWORD);
  const child = spawn(
    process.execPath,
    [
      resolve("dist/src/cli/main.js"),
      "service",
      "operator",
      join(serviceHome, "data"),
      String(s.options.port),
    ],
    {
      env: {
        HOME: serviceHome,
        PATH: `${s.launchd.codexDir}:${process.env.PATH}`,
        CAB_OPERATOR_AUTH_FILE: authFile,
        CAB_OPERATOR_ORIGIN: s.origin,
      },
      stdio: "ignore",
    },
  );
  s.launchd.all.add(child);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (
      await fetch(`${s.origin}/app`).then(
        (r) => r.status === 200,
        () => false,
      )
    )
      break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const token = await (await signIn(s.origin, PASSWORD)).mint();
  const tokenFile = join(s.dir, "remote.token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const cliHome = join(s.dir, "cli-home");
  mkdirSync(cliHome);
  const cab = (args: string[]) =>
    run(join(s.prefix, "bin", "cab"), args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cliHome,
        CAB_CLI_CONFIG_DIR: join(cliHome, "config"),
      },
    });
  await cab([
    "auth",
    "login",
    "--connection",
    "remote",
    "--url",
    s.origin,
    "--token-file",
    tokenFile,
  ]);
  const doctor = await cab(["doctor", "--connection", "remote"]);
  assert.match(doctor.stdout, /\S/);
  assert.deepEqual(readdirSync(cliHome).sort(), ["config"]);
});

const realNode = () => realpathSync(process.execPath);
