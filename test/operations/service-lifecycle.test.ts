import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { basename, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  defaultServiceHost,
  daemonVerifyCommand,
  ghTokenStorage,
  type FirstRun,
  type GhTokenStorage,
  type InstallCli,
  installService,
  LIFECYCLE_OPTIONS,
  lifecycleOptions,
  type OperatorConnection,
  type ServiceHost,
  type ServiceOptions,
  SERVICE_USAGE,
  serviceCommand,
  uninstallService,
  upgradeService,
  VERIFY_OPTIONS,
} from "../../src/cli/service.js";
import type { CliDeps } from "../../src/cli/types.js";
import { StandaloneDataDirectory } from "../../src/standalone/data-directory.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import { fakeStatusGh } from "../fixtures/fake-status-gh.js";
import { markedDataDirectory } from "../fixtures/marked-data.js";
import { tmpdir } from "../fixtures/temp.js";

/** The owner of what these tests create, whoever runs them: the fake host's uid is never the process's. */
const UID = (() => {
  const probe = mkdtempSync(join(tmpdir(), "ensemble-uid-"));
  try {
    return statSync(probe).uid;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** launchd as a label map; `print` renders the fields that ownership reads. */
class FakeLaunchd {
  calls: string[][] = [];
  events: string[] = [];
  jobs = new Map<string, { path: string; pid: number }>();
  /** Jobs in the `system` domain, keyed by label; the gui `jobs` map is untouched by them. */
  systemJobs = new Map<string, { path: string; pid: number }>();
  /** The account a daemon plist runs as; setup points `home` at the fixture home. */
  home = "";
  /** Who listens on the daemon's port; by default the system job's own pid. */
  listeners: number[] | null | undefined;
  ghStorage: GhTokenStorage = "unknown";
  ghProbes = 0;
  alive = new Set<number>();
  /** Start time of a pid that is not the default, to model pid reuse. */
  pidStarts = new Map<number, string>();
  linted: string[] = [];
  fetched: string[] = [];
  clock = Date.UTC(2026, 9, 14, 12);
  nextPid = 4000;
  failBootstrap = false;
  stuck = false;
  identityUnavailable = false;
  printPath: string | undefined;
  health = 200;
  /** Operator API requests the install's sign-in made. */
  requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  password = "test-password";
  loginStatus: number | undefined;
  revokeStatus = 200;
  logoutStatus = 200;
  onApi: (path: string) => void = () => {};
  opened: string[] = [];
  onBootstrap: () => void = () => {};
  overrides: Partial<ServiceHost> = {};

  constructor(
    readonly snapshots: string,
    readonly daemonsDir = "",
  ) {}

  host(): ServiceHost {
    return {
      uid: UID,
      // Never the runner's own identity; the root refusal test overrides it.
      isRoot: () => false,
      daemonsDir: () => this.daemonsDir,
      launchctl: async (args) => {
        this.calls.push(args);
        const [command, target = ""] = args;
        const label = target.split("/").at(-1) ?? "";
        const system = target.startsWith("system/") || args[1] === "system";
        // Daemon mode must never mutate launchd: no test needs a system mutation to succeed.
        if (system && command !== "print")
          throw new Error(`unexpected system launchctl ${command}`);
        if (command === "print") {
          const job = (system ? this.systemJobs : this.jobs).get(label);
          return job
            ? {
                status: 0,
                stdout: `${target} = {\n\tpath = ${this.printPath ?? job.path}\n\tstate = running\n\tpid = ${job.pid}\n\tendpoints = {\n\t\tpath = /elsewhere\n\t}\n}\n`,
              }
            : { status: 113, stdout: "" };
        }
        if (command === "bootstrap") {
          this.events.push(
            `bootstrap snapshots=${readdirSync(this.snapshots).length}`,
          );
          this.onBootstrap();
          if (this.failBootstrap) return { status: 5, stdout: "" };
          const path = args[2] ?? "";
          const pid = this.nextPid++;
          this.alive.add(pid);
          this.jobs.set(basename(path, ".plist"), { path, pid });
          return { status: 0, stdout: "" };
        }
        if (command === "bootout") {
          this.events.push("bootout");
          const job = this.jobs.get(label);
          this.jobs.delete(label);
          if (job && !this.stuck) this.alive.delete(job.pid);
          return { status: job ? 0 : 3, stdout: "" };
        }
        return { status: 1, stdout: "" };
      },
      lint: async (path) => {
        this.linted.push(path);
        assert.ok(existsSync(path), "lint sees the staged plist");
        return true;
      },
      captureIdentity: async (pid) =>
        this.identityUnavailable
          ? null
          : {
              processId: String(pid),
              processStartedAt: this.pidStarts.get(pid) ?? "start-0",
              bootId: "boot-1",
            },
      // As the real verifier: absent, reused (another start time) or a new boot is gone.
      exited: async (identity) => {
        const { processId, processStartedAt, bootId } = identity as {
          processId: string;
          processStartedAt: string;
          bootId: string;
        };
        const pid = Number(processId);
        const exited =
          !this.alive.has(pid) ||
          (this.pidStarts.get(pid) ?? "start-0") !== processStartedAt ||
          bootId !== "boot-1";
        if (exited) this.events.push("exited");
        return exited;
      },
      fetch: async (url, init) => {
        const { pathname } = new URL(String(url));
        if (pathname.startsWith("/api/operator/"))
          return this.api(pathname, init);
        this.fetched.push(String(url));
        return new Response(null, { status: this.health });
      },
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms;
      },
      // Probe timeouts run 1000 times faster; the polling sleep advances the fake clock.
      timeout: (ms) => AbortSignal.timeout(Math.max(1, ms / 1000)),
      // Directories are separate volumes here: only a rename within one directory works.
      rename: (from, to) => {
        if (dirname(dirname(from)) !== dirname(to))
          throw Object.assign(new Error("cross-device link"), {
            code: "EXDEV",
          });
        renameSync(from, to);
      },
      extract: async (tarball, dir) => {
        execFileSync("tar", [
          "-xzf",
          tarball,
          "--strip-components",
          "1",
          "-C",
          dir,
        ]);
        return true;
      },
      open: async (url) => {
        this.opened.push(url);
      },
      hostname: () => "test-host",
      account: () => ({ name: "operator", home: this.home }),
      portOwner: async () => {
        if (this.listeners !== undefined) return this.listeners;
        const job = [...this.systemJobs.values()][0];
        return job && job.pid > 0 ? [job.pid] : [];
      },
      ghTokenStorage: async () => {
        this.ghProbes += 1;
        return this.ghStorage;
      },
      ...this.overrides,
    };
  }

  mutations() {
    return this.calls.filter(([command]) => command !== "print");
  }

  /** The operator session, login, credential, revoke and logout routes, as the contract states them. */
  api(path: string, init: RequestInit | undefined): Response {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({
      method: init?.method ?? "GET",
      path,
      headers,
      body,
    });
    this.onApi(path);
    init?.signal?.throwIfAborted();
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "set-cookie": "session=abc; HttpOnly" },
      });
    const csrfToken = "c".repeat(43);
    if (path === "/api/operator/session")
      return json({ authenticated: false, csrfToken });
    if (path === "/api/operator/login")
      return body.password === this.password
        ? json({ authenticated: true, csrfToken })
        : new Response(null, { status: this.loginStatus ?? 401 });
    if (path === "/api/operator/credentials")
      return json({
        credential: {
          id: "11111111-1111-4111-8111-111111111111",
          name: body.name,
          scope: body.scope,
          createdAt: 1,
          expiresAt: 2,
          lastUsedAt: null,
          revokedAt: null,
          replacesId: null,
          state: "active",
        },
        token: `ens_11111111-1111-4111-8111-111111111111_${"s".repeat(43)}`,
      });
    if (path.endsWith("/revoke"))
      return new Response("{}", { status: this.revokeStatus });
    if (path === "/api/operator/logout")
      return new Response("{}", { status: this.logoutStatus });
    return json({});
  }
}

function release(stateDir: string, version: string, manifestVersion = version) {
  const root = join(stateDir, "versions", version);
  mkdirSync(join(root, "node", "bin"), { recursive: true });
  mkdirSync(join(root, "dist", "src", "standalone"), { recursive: true });
  writeFileSync(join(root, "node", "bin", "node"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  writeFileSync(join(root, "dist", "src", "standalone", "cli.js"), "\n");
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      schema: "ensemble.release/v1",
      platform: "darwin-arm64",
      version: manifestVersion,
    }),
  );
  return root;
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/** Relative path, mode and content hash of every entry under `root`. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries: string[] = [];
  const visit = (path: string) => {
    const state = lstatSync(path);
    entries.push(
      `${relative(root, path)} ${state.mode & 0o777} ${state.isFile() ? sha256(path) : "dir"}`,
    );
    if (state.isDirectory())
      for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return entries;
}

function capture() {
  const out = { stdout: "", stderr: "" };
  const io = {
    stdout: {
      write: (text: string) => {
        out.stdout += text;
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    stderr: {
      write: (text: string) => {
        out.stderr += text;
        return true;
      },
    } as unknown as NodeJS.WritableStream,
  };
  return { out, io };
}

async function setup(
  t: { after(fn: () => void): void },
  data = false,
  { unpacked = true, auth = true } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-service-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stateDir = join(home, "Library", "Application Support", "Ensemble");
  mkdirSync(join(stateDir, "auth"), { recursive: true, mode: 0o755 });
  chmodSync(join(stateDir, "auth"), 0o700);
  writeFileSync(join(stateDir, "config.yaml"), "legacy: pipeline\n");
  const authFile = join(stateDir, "auth", "operator-auth.json");
  if (auth) writeFileSync(authFile, "{}\n", { mode: 0o600 });
  const releaseA = unpacked
    ? release(stateDir, "0.1.0")
    : join(stateDir, "versions", "0.1.0");
  if (data) markedDataDirectory(join(stateDir, "data"));
  const options: ServiceOptions = {
    stateDir,
    logDir: join(home, "Library", "Logs", "Ensemble"),
    agentsDir: join(home, "Library", "LaunchAgents"),
    daemonsDir: join(root, "daemons"),
    daemonPlistOwner: UID,
    label: "local.ensemble.test",
    port: await freePort(),
  };
  const snapshots = join(stateDir, "snapshots");
  mkdirSync(snapshots, { mode: 0o700 });
  const launchd = new FakeLaunchd(snapshots, options.daemonsDir);
  launchd.home = home;
  mkdirSync(options.daemonsDir, { mode: 0o755 });
  const activation = join(options.agentsDir, `${options.label}.plist`);
  const recordPath = join(stateDir, "launchd", `${options.label}.json`);
  const record = () => JSON.parse(readFileSync(recordPath, "utf8"));
  const install = async (diagnostic?: ServiceOptions["diagnostic"]) => {
    const { out, io } = capture();
    const code = await installService(
      diagnostic ? { ...options, diagnostic } : options,
      releaseA,
      launchd.host(),
      io,
    );
    return { code, ...out };
  };
  const uninstall = async () => {
    const { out, io } = capture();
    const code = await uninstallService(options, launchd.host(), io);
    return { code, ...out };
  };
  const installDaemon = async (first: Partial<FirstRun> = {}) => {
    const { out, io } = capture();
    const code = await installService(options, releaseA, launchd.host(), io, {
      connection: "local",
      open: false,
      ...first,
      mode: "daemon",
    });
    return { code, ...out };
  };
  const installDaemonWith = (io: ReturnType<typeof capture>["io"]) =>
    installService(options, releaseA, launchd.host(), io, {
      connection: "local",
      open: false,
      mode: "daemon",
    });
  const staged = join(stateDir, "launchd", `${options.label}.plist`);
  const installed = join(options.daemonsDir, `${options.label}.plist`);
  return {
    home,
    stateDir,
    authFile,
    releaseA,
    options,
    launchd,
    activation,
    recordPath,
    record,
    snapshots,
    install,
    uninstall,
    installDaemon,
    installDaemonWith,
    staged,
    installed,
  };
}

function programArguments(plist: string): string[] {
  const array =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      readFileSync(plist, "utf8"),
    )?.[1];
  return [...(array ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(
    (match) => match[1] as string,
  );
}

test("install renders, lints, records and bootstraps the versioned LaunchAgent", async (t) => {
  const f = await setup(t);
  const legacy = readFileSync(join(f.stateDir, "config.yaml"));
  const result = await f.install();
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.version, "0.1.0");

  assert.equal(statSync(f.activation).mode & 0o777, 0o600);
  assert.deepEqual(programArguments(f.activation), [
    join(f.releaseA, "node", "bin", "node"),
    join(f.releaseA, "dist", "src", "standalone", "cli.js"),
    "operator",
    join(f.stateDir, "data"),
    String(f.options.port),
  ]);
  const record = f.record();
  assert.equal(record.plistSha256, sha256(f.activation));
  assert.equal(record.version, "0.1.0");
  assert.equal(statSync(f.recordPath).mode & 0o777, 0o600);
  assert.deepEqual(f.launchd.mutations(), [
    ["bootstrap", `gui/${UID}`, f.activation],
  ]);
  assert.equal(f.launchd.linted.length, 1);
  assert.match(
    f.launchd.linted[0] ?? "",
    /\/LaunchAgents\/\.local\.ensemble\.test\.staging-[^/]+\/local\.ensemble\.test\.plist$/,
  );
  assert.deepEqual(readdirSync(join(f.stateDir, "launchd")), [
    "local.ensemble.test.json",
  ]);
  assert.deepEqual(readdirSync(f.options.agentsDir), [
    "local.ensemble.test.plist",
  ]);
  assert.equal(
    existsSync(join(f.stateDir, ".local.ensemble.test.lock")),
    false,
  );
  for (const name of ["data", "snapshots", "launchd"])
    assert.equal(statSync(join(f.stateDir, name)).mode & 0o777, 0o700, name);
  assert.deepEqual(readFileSync(join(f.stateDir, "config.yaml")), legacy);
  for (const log of output.logs)
    assert.ok(
      log.startsWith(join(f.options.logDir, "local.ensemble.test.0.1.0.")),
    );
});

test("lifecycle options default under HOME", async (t) => {
  const f = await setup(t);
  const fake = new FakeLaunchd(f.snapshots, f.options.daemonsDir);
  const { out, io } = capture();
  const deps = { env: { HOME: f.home }, ...io } as unknown as CliDeps;
  const unused = (): OperatorConnection => {
    throw new Error("unused");
  };
  assert.equal(
    await serviceCommand(["uninstall"], deps, unused, () => fake.host()),
    0,
  );
  assert.deepEqual(fake.calls, [
    ["print", `gui/${UID}/local.ensemble.service`],
    ["print", "system/local.ensemble.service"],
  ]);
  assert.equal(JSON.parse(out.stdout).installed, false);
  // The checkout is not a release under the default state directory.
  assert.equal(
    await serviceCommand(["install"], deps, unused, () => fake.host()),
    1,
  );
  assert.ok(
    out.stderr.includes(
      join(f.home, "Library", "Application Support", "Ensemble", "versions"),
    ),
  );
  assert.equal(
    await serviceCommand(["install", "--port", "0"], deps, unused, () =>
      fake.host(),
    ),
    2,
  );
  assert.equal(
    await serviceCommand(["uninstall", "--port", "9"], deps, unused, () =>
      fake.host(),
    ),
    2,
  );
  assert.equal(
    await serviceCommand(["uninstall", "--connection", "x"], deps, unused, () =>
      fake.host(),
    ),
    2,
  );
});

test("install refusals change nothing and never bootstrap", async (t) => {
  const cases: [
    string,
    (f: Awaited<ReturnType<typeof setup>>) => unknown,
    RegExp,
  ][] = [
    [
      "label already loaded",
      (f) => f.launchd.jobs.set(f.options.label, { path: "/x", pid: 1 }),
      /already loaded/,
    ],
    [
      "existing record",
      (f) => {
        mkdirSync(join(f.stateDir, "launchd"), { mode: 0o700 });
        writeFileSync(f.recordPath, "{}");
      },
      /already installed/,
    ],
    [
      "existing activation",
      (f) => {
        mkdirSync(f.options.agentsDir, { recursive: true });
        writeFileSync(f.activation, "");
      },
      /already installed/,
    ],
    ["missing auth", (f) => rmSync(f.authFile), /service init-auth/],
    [
      "release outside versions",
      (f) => {
        f.releaseA = join(f.home, "elsewhere");
      },
      /unpacked directory in/,
    ],
    [
      "manifest version mismatch",
      (f) => {
        f.releaseA = release(f.stateDir, "0.3.0", "0.4.0");
      },
      /manifest\.json/,
    ],
  ];
  for (const [name, arrange, reason] of cases) {
    const f = await setup(t);
    arrange(f);
    const before = tree(f.home);
    const { out, io } = capture();
    const code = await installService(
      f.options,
      f.releaseA,
      f.launchd.host(),
      io,
    );
    assert.equal(code, 1, name);
    const report = JSON.parse(out.stderr);
    assert.equal(report.stage, "preflight", name);
    assert.match(report.error, reason, name);
    assert.deepEqual(f.launchd.mutations(), [], name);
    assert.deepEqual(tree(f.home), before, name);
  }

  const f = await setup(t);
  const busy = createServer().listen(f.options.port, "127.0.0.1");
  await new Promise((done) => busy.once("listening", done));
  try {
    const before = tree(f.home);
    const result = await f.install();
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /in use/);
    assert.deepEqual(f.launchd.mutations(), []);
    assert.deepEqual(tree(f.home), before);
  } finally {
    await new Promise((done) => busy.close(done));
  }
});

test("a failed bootstrap or health check undoes the install and keeps data and auth", async (t) => {
  const f = await setup(t, true);
  const data = tree(join(f.stateDir, "data"));
  const auth = readFileSync(f.authFile);
  f.launchd.failBootstrap = true;
  let result = await f.install();
  assert.equal(result.code, 1);
  let report = JSON.parse(result.stderr);
  assert.equal(report.stage, "start");
  assert.equal(report.jobStopped, true);
  assert.equal(report.logs.length, 2);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), false);
  assert.deepEqual(tree(join(f.stateDir, "data")), data);
  assert.deepEqual(readFileSync(f.authFile), auth);

  f.launchd.failBootstrap = false;
  f.launchd.health = 503;
  f.launchd.calls = [];
  result = await f.install();
  assert.equal(result.code, 1);
  report = JSON.parse(result.stderr);
  assert.equal(report.stage, "health");
  assert.equal(report.jobStopped, true);
  assert.deepEqual(
    f.launchd.mutations().map(([command]) => command),
    ["bootstrap", "bootout"],
  );
  assert.deepEqual(f.launchd.mutations()[1], [
    "bootout",
    `gui/${UID}/${f.options.label}`,
  ]);
  assert.equal(f.launchd.jobs.size, 0);
  assert.equal(f.launchd.alive.size, 0);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), false);
  assert.deepEqual(readFileSync(f.authFile), auth);
});

test("uninstall boots out the owned job and keeps every state directory", async (t) => {
  const f = await setup(t, true);
  assert.equal((await f.install()).code, 0);
  const kept = ["data", "auth", "snapshots", "versions"].map((name) =>
    tree(join(f.stateDir, name)),
  );
  const logs = tree(f.options.logDir);
  f.launchd.calls = [];
  const result = await f.uninstall();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).installed, true);
  assert.deepEqual(f.launchd.mutations(), [
    ["bootout", `gui/${UID}/${f.options.label}`],
  ]);
  assert.equal(f.launchd.alive.size, 0);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), false);
  assert.deepEqual(
    ["data", "auth", "snapshots", "versions"].map((name) =>
      tree(join(f.stateDir, name)),
    ),
    kept,
  );
  assert.deepEqual(tree(f.options.logDir), logs);

  f.launchd.calls = [];
  const again = await f.uninstall();
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.stdout).installed, false);
  assert.deepEqual(f.launchd.mutations(), []);

  // Install after uninstall reuses the same data and auth.
  const auth = readFileSync(f.authFile);
  assert.equal((await f.install()).code, 0);
  assert.deepEqual(tree(join(f.stateDir, "data")), kept[0]);
  assert.deepEqual(readFileSync(f.authFile), auth);
});

test("uninstall refuses a job or activation file it does not own", async (t) => {
  const f = await setup(t);
  assert.equal((await f.install()).code, 0);
  writeFileSync(f.activation, `${readFileSync(f.activation, "utf8")}\n`);
  let before = tree(f.home);
  f.launchd.calls = [];
  let result = await f.uninstall();
  assert.equal(result.code, 1);
  assert.match(
    JSON.parse(result.stderr).error,
    /not created by this installation/,
  );
  assert.deepEqual(f.launchd.mutations(), []);
  assert.deepEqual(tree(f.home), before);

  const g = await setup(t);
  assert.equal((await g.install()).code, 0);
  g.launchd.printPath = "/Library/LaunchAgents/other.plist";
  before = tree(g.home);
  g.launchd.calls = [];
  result = await g.uninstall();
  assert.equal(result.code, 1);
  assert.deepEqual(g.launchd.mutations(), []);
  assert.deepEqual(tree(g.home), before);
});

test("uninstall without a confirmed exit removes the activation and keeps the record", async (t) => {
  const f = await setup(t);
  assert.equal((await f.install()).code, 0);
  f.launchd.stuck = true;
  const result = await f.uninstall();
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error, /run service uninstall again/);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), true);
});

test("plutil accepts the installed plist", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const f = await setup(t);
  assert.equal((await f.install()).code, 0);
  execFileSync("/usr/bin/plutil", ["-lint", f.activation]);
});

/** The EnvironmentVariables dictionary of a rendered plist. */
function environment(plist: string): Record<string, string> {
  const dict =
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
      readFileSync(plist, "utf8"),
    )?.[1];
  return Object.fromEntries(
    [
      ...(dict ?? "").matchAll(
        /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );
}

const RETENTION = "ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS";
const STORAGE = "ENSEMBLE_DIAGNOSTIC_STORAGE_MIB";

/** Installs 0.1.0 over marked data and adds release 0.2.0. */
async function installed(
  t: { after(fn: () => void): void },
  diagnostic?: ServiceOptions["diagnostic"],
) {
  const f = await setup(t, true);
  assert.equal((await f.install(diagnostic)).code, 0);
  const releaseB = release(f.stateDir, "0.2.0");
  let checks = [
    { id: "codex-login", status: "pass" },
    { id: "claude-token", status: "not-configured" },
  ];
  let origin: string | Error = `http://127.0.0.1:${f.options.port}`;
  let readFailure: Error | undefined;
  const connection: OperatorConnection = {
    origin: async () => {
      if (origin instanceof Error) throw origin;
      return origin;
    },
    readiness: async () => {
      f.launchd.events.push("readiness");
      if (readFailure) throw readFailure;
      return checks;
    },
  };
  const upgrade = async (
    target = releaseB,
    signal?: AbortSignal,
    diagnostic?: ServiceOptions["diagnostic"],
  ) => {
    const { out, io } = capture();
    const code = await upgradeService(
      // Upgrade keeps the installed port whatever --port defaults to.
      { ...f.options, port: 1, ...(diagnostic ? { diagnostic } : {}) },
      target,
      connection,
      f.launchd.host(),
      { ...io, signal },
    );
    return {
      code,
      ...out,
      report: JSON.parse(out.stdout || out.stderr),
    };
  };
  f.launchd.calls = [];
  f.launchd.events = [];
  f.launchd.clock += 60_000;
  return {
    ...f,
    releaseB,
    upgrade,
    setChecks: (value: typeof checks) => {
      checks = value;
    },
    setReadFailure: (value: Error | undefined) => {
      readFailure = value;
    },
    setOrigin: (value: string | Error) => {
      origin = value;
    },
  };
}

function verifySnapshot(path: string) {
  return spawnSync(
    process.execPath,
    [resolve("dist/src/cli/main.js"), "snapshot", "verify", path],
    { encoding: "utf8" },
  ).status;
}

test("upgrade stops, snapshots, re-renders, starts and checks readiness in order", async (t) => {
  const f = await installed(t);
  const oldLogs = f.record().configuration.stdoutPath;
  const result = await f.upgrade();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.launchd.events, [
    "readiness", // Preflight read while the old job still runs.
    "bootout",
    "exited",
    "bootstrap snapshots=1",
    "readiness",
  ]);
  const { report } = result;
  assert.equal(report.version, "0.2.0");
  assert.deepEqual(
    new Set(f.launchd.fetched),
    new Set([`http://127.0.0.1:${f.options.port}/app`]),
  );
  assert.deepEqual(report.readiness, [
    { id: "codex-login", status: "pass" },
    { id: "claude-token", status: "not-configured" },
  ]);
  assert.match(
    basename(report.snapshot),
    /^local\.ensemble\.test\.0\.1\.0-to-0\.2\.0\.\d{8}T\d{6}Z$/,
  );
  assert.equal(verifySnapshot(report.snapshot), 0);
  assert.equal(f.record().version, "0.2.0");
  assert.equal(f.record().plistSha256, sha256(f.activation));
  assert.equal(
    programArguments(f.activation)[0],
    join(f.releaseB, "node", "bin", "node"),
  );
  assert.notEqual(f.record().configuration.stdoutPath, oldLogs);
  assert.deepEqual(report.logs, [
    f.record().configuration.stdoutPath,
    f.record().configuration.stderrPath,
  ]);
});

test("an upgrade failing at start leaves the job stopped with a verified snapshot", async (t) => {
  const f = await installed(t);
  f.launchd.failBootstrap = true;
  const result = await f.upgrade();
  assert.equal(result.code, 1);
  const { report } = result;
  assert.equal(report.stage, "start");
  assert.equal(report.jobStopped, true);
  assert.equal(verifySnapshot(report.snapshot), 0);
  assert.equal(report.logs.length, 2);
  assert.equal(f.launchd.jobs.size, 0);
  assert.equal(existsSync(f.activation), false);
  assert.equal(f.record().version, "0.2.0");

  // Recovery: another upgrade from the stopped state with a working release.
  f.launchd.failBootstrap = false;
  f.launchd.clock += 60_000;
  const retry = await f.upgrade();
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(f.launchd.jobs.size, 1);
  assert.equal(existsSync(f.activation), true);
});

test("an upgrade failing readiness boots out the new job and removes the activation", async (t) => {
  const f = await installed(t);
  f.setChecks([{ id: "codex-login", status: "fail" }]);
  const result = await f.upgrade();
  assert.equal(result.code, 1);
  const { report } = result;
  assert.equal(report.stage, "readiness");
  assert.equal(report.jobStopped, true);
  assert.equal(verifySnapshot(report.snapshot), 0);
  assert.deepEqual(
    f.launchd.mutations().map(([command]) => command),
    ["bootout", "bootstrap", "bootout"],
  );
  assert.equal(f.launchd.alive.size, 0);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), true);
});

test("an upgrade that cannot confirm the old process exited takes no snapshot", async (t) => {
  for (const arrange of [
    (l: FakeLaunchd) => {
      l.identityUnavailable = true;
    },
    (l: FakeLaunchd) => {
      l.stuck = true;
    },
  ]) {
    const f = await installed(t);
    arrange(f.launchd);
    const result = await f.upgrade();
    assert.equal(result.code, 1);
    assert.equal(result.report.stage, "stop");
    assert.equal(result.report.jobStopped, false);
    assert.equal(result.report.snapshot, null);
    assert.deepEqual(readdirSync(f.snapshots), []);
    assert.ok(!f.launchd.events.includes("bootstrap snapshots=0"));
  }
});

test("upgrade preflight refusals make no launchd change", async (t) => {
  const f = await installed(t);
  const before = tree(f.home);
  const refusals: [() => void, string, RegExp][] = [
    [() => f.setOrigin(new Error("logged out")), f.releaseB, /auth login/],
    [
      () => f.setOrigin("http://127.0.0.1:1"),
      f.releaseB,
      /not for http:\/\/127\.0\.0\.1/,
    ],
    [
      () => f.setOrigin(`http://127.0.0.1:${f.options.port}`),
      join(f.home, "x"),
      /unpacked/,
    ],
  ];
  for (const [arrange, target, reason] of refusals) {
    arrange();
    const result = await f.upgrade(target);
    assert.equal(result.code, 1);
    assert.equal(result.report.stage, "preflight");
    assert.equal(result.report.jobStopped, null);
    assert.match(result.report.error, reason);
  }
  const mismatched = release(f.stateDir, "0.5.0", "0.6.0");
  const after = tree(f.home);
  const result = await f.upgrade(mismatched);
  assert.equal(result.report.stage, "preflight");
  assert.match(result.report.error, /manifest\.json/);
  assert.deepEqual(f.launchd.mutations(), []);
  assert.deepEqual(tree(f.home), after);
  assert.ok(before.length < after.length);
});

test("upgrade preflight refuses a credential that cannot read readiness before stopping the old job", async (t) => {
  const f = await installed(t);
  f.setReadFailure(new Error("401 unauthenticated"));
  const result = await f.upgrade();
  assert.equal(result.code, 1);
  assert.equal(result.report.stage, "preflight");
  assert.equal(result.report.jobStopped, null);
  assert.match(result.report.error, /cannot read readiness/);
  assert.deepEqual(f.launchd.mutations(), []);
  assert.equal(f.launchd.jobs.size, 1);
  assert.equal(existsSync(f.activation), true);
});

test("an upgrade fails at snapshot, job stopped, while another process owns the data", async (t) => {
  const f = await installed(t);
  const owner = StandaloneDataDirectory.openExclusive(join(f.stateDir, "data"));
  try {
    const result = await f.upgrade();
    assert.equal(result.code, 1);
    assert.equal(result.report.stage, "snapshot");
    assert.equal(result.report.jobStopped, true);
    assert.equal(result.report.snapshot, null);
    assert.equal(f.launchd.jobs.size, 0);
    assert.equal(existsSync(f.activation), false);
    assert.equal(f.record().version, "0.1.0");
  } finally {
    owner.close();
  }
});

test("upgrade preflight refuses an unowned activation or an invalid record", async (t) => {
  const f = await installed(t);
  writeFileSync(f.activation, `${readFileSync(f.activation, "utf8")}\n`);
  let result = await f.upgrade();
  assert.equal(result.report.stage, "preflight");
  assert.match(result.report.error, /not created by this installation/);
  assert.deepEqual(f.launchd.mutations(), []);

  writeFileSync(f.recordPath, '{"schema":"ensemble.service/v1"');
  result = await f.upgrade();
  assert.equal(result.report.stage, "preflight");
  assert.match(result.report.error, /install record .* is invalid/);
  assert.equal((await f.uninstall()).code, 1);
  assert.deepEqual(f.launchd.mutations(), []);

  const g = await installed(t);
  rmSync(join(g.releaseB, "dist", "src", "standalone", "cli.js"));
  result = await g.upgrade();
  assert.equal(result.report.stage, "preflight");
  assert.match(result.report.error, /release is incomplete/);
  assert.deepEqual(g.launchd.mutations(), []);
});

test("an interrupted upgrade still leaves the job stopped", async (t) => {
  const f = await installed(t);
  const interrupt = new AbortController();
  f.setChecks([{ id: "codex-login", status: "fail" }]);
  f.launchd.onBootstrap = () => interrupt.abort();
  const result = await f.upgrade(f.releaseB, interrupt.signal);
  assert.equal(result.code, 1);
  // The interrupt arrives at bootstrap, so the next wait (health) fails.
  assert.equal(result.report.stage, "health");
  assert.equal(result.report.error, "interrupted");
  assert.equal(result.report.jobStopped, true);
  assert.equal(f.launchd.jobs.size, 0);
  assert.equal(existsSync(f.activation), false);
});

test("a stalled readiness read fails at readiness on the deadline and stops the job", {
  timeout: 20_000,
}, async (t) => {
  const f = await installed(t);
  const signals: AbortSignal[] = [];
  const stalled: OperatorConnection = {
    origin: async () => `http://127.0.0.1:${f.options.port}`,
    readiness: (signal) => {
      // The preflight read succeeds; only the post-start reads stall.
      if (!signals.length) {
        signals.push(signal);
        return Promise.resolve([]);
      }
      signals.push(signal);
      return new Promise(() => {});
    },
  };
  const { out, io } = capture();
  const code = await upgradeService(
    f.options,
    f.releaseB,
    stalled,
    f.launchd.host(),
    io,
  );
  assert.equal(code, 1);
  const report = JSON.parse(out.stderr);
  assert.equal(report.stage, "readiness");
  assert.equal(report.jobStopped, true);
  assert.equal(f.launchd.jobs.size, 0);
  assert.equal(existsSync(f.activation), false);
  assert.ok(signals.length > 2 && signals.slice(1).every((s) => s.aborted));
});

test("a stalled /app response fails install at health on the deadline", {
  timeout: 20_000,
}, async (t) => {
  const f = await setup(t);
  const stalled = createHttpServer(() => {});
  t.after(() => {
    stalled.closeAllConnections();
    stalled.close();
  });
  f.launchd.onBootstrap = () => {
    stalled.listen(f.options.port, "127.0.0.1");
  };
  f.launchd.overrides = { fetch };
  const result = await f.install();
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stderr);
  assert.equal(report.stage, "health");
  assert.equal(report.jobStopped, true);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), false);
});

test("an interrupt during a probe that then succeeds still fails and undoes the install", async (t) => {
  const f = await setup(t);
  const interrupt = new AbortController();
  f.launchd.overrides = {
    fetch: async () => {
      interrupt.abort();
      return new Response(null, { status: 200 });
    },
  };
  const { out, io } = capture();
  const code = await installService(f.options, f.releaseA, f.launchd.host(), {
    ...io,
    signal: interrupt.signal,
  });
  assert.equal(code, 1);
  const report = JSON.parse(out.stderr);
  assert.equal(report.stage, "health");
  assert.equal(report.error, "interrupted");
  assert.equal(report.jobStopped, true);
  assert.equal(f.launchd.jobs.size, 0);
  assert.equal(existsSync(f.activation), false);
  assert.equal(existsSync(f.recordPath), false);
});

test("each readiness read may run longer than the service's own 10 s check bound", async (t) => {
  const f = await installed(t);
  const fake = f.launchd.host();
  const limits: number[] = [];
  f.launchd.overrides = {
    timeout: (ms) => {
      limits.push(ms);
      return fake.timeout(ms);
    },
  };
  const result = await f.upgrade();
  assert.equal(result.code, 0, result.stderr);
  // The preflight read, one health probe capped at 5 s, then one readiness read allowed over 10 s.
  assert.deepEqual(limits, [20_000, 5_000, 20_000]);
});

test("an interrupt during the stop poll still confirms the exit before failing", async (t) => {
  const f = await installed(t);
  const interrupt = new AbortController();
  let polls = 0;
  f.launchd.stuck = true;
  f.launchd.overrides = {
    exited: async () => {
      interrupt.abort();
      return ++polls > 2;
    },
  };
  const result = await f.upgrade(f.releaseB, interrupt.signal);
  assert.equal(result.code, 1);
  assert.equal(result.report.stage, "snapshot");
  assert.equal(result.report.error, "interrupted");
  assert.equal(result.report.jobStopped, true);
  assert.equal(polls, 3);
  assert.equal(result.report.snapshot, null);
  assert.deepEqual(
    f.launchd.mutations().map(([command]) => command),
    ["bootout"],
  );
});

test("an interrupt before the stop leaves the old job running", async (t) => {
  const f = await installed(t);
  const interrupt = new AbortController();
  interrupt.abort();
  const result = await f.upgrade(f.releaseB, interrupt.signal);
  assert.equal(result.code, 1);
  assert.equal(result.report.stage, "preflight");
  assert.equal(result.report.jobStopped, null);
  assert.deepEqual(f.launchd.mutations(), []);
  assert.equal(f.launchd.jobs.size, 1);
});

test("a launchctl failure while confirming the stop reports the exit unconfirmed", async (t) => {
  const f = await installed(t);
  const host = f.launchd.host();
  let bootedOut = false;
  let failed = false;
  f.launchd.overrides = {
    launchctl: async (args) => {
      if (args[0] === "bootout") bootedOut = true;
      else if (bootedOut && args[0] === "print" && !failed) {
        failed = true;
        return { status: 1, stdout: "" };
      }
      return host.launchctl(args);
    },
  };
  const result = await f.upgrade();
  assert.equal(result.code, 1);
  assert.equal(result.report.stage, "stop");
  assert.equal(result.report.jobStopped, false);
  assert.equal(result.report.snapshot, null);
});

test("overlapping installs: the loser fails fast on the lock and leaves the winner untouched", async (t) => {
  const f = await setup(t);
  const [first, second] = await Promise.all([f.install(), f.install()]);
  const loser = first.code === 0 ? second : first;
  assert.deepEqual([first.code, second.code].sort(), [0, 1]);
  const report = JSON.parse(loser.stderr);
  assert.equal(report.stage, "preflight");
  assert.match(
    report.error,
    /Another service command holds .*\.local\.ensemble\.test\.lock/,
  );
  assert.deepEqual(f.launchd.mutations(), [
    ["bootstrap", `gui/${UID}`, f.activation],
  ]);
  assert.equal(f.launchd.jobs.size, 1);
  assert.equal(f.record().plistSha256, sha256(f.activation));
  assert.equal(
    existsSync(join(f.stateDir, ".local.ensemble.test.lock")),
    false,
  );

  // A stale lock is never taken over; removing it, as the error says, recovers.
  const lock = join(f.stateDir, ".local.ensemble.test.lock");
  writeFileSync(lock, '{"pid":999999}\n', { mode: 0o600 });
  const blocked = await f.uninstall();
  assert.equal(blocked.code, 1);
  assert.match(JSON.parse(blocked.stderr).error, /pid 999999.*remove/);
  assert.equal(f.launchd.jobs.size, 1);
  rmSync(lock);
  assert.equal((await f.uninstall()).code, 0);
});

test("an interrupt during the render never bootstraps the upgraded release", async (t) => {
  const f = await installed(t);
  const interrupt = new AbortController();
  f.launchd.overrides = {
    lint: async () => {
      interrupt.abort();
      return true;
    },
  };
  const result = await f.upgrade(f.releaseB, interrupt.signal);
  assert.equal(result.code, 1);
  assert.equal(result.report.stage, "render");
  assert.equal(result.report.error, "interrupted");
  assert.equal(result.report.jobStopped, true);
  assert.deepEqual(
    f.launchd.mutations().map(([command]) => command),
    ["bootout"],
  );
  assert.equal(existsSync(f.activation), false);
});

test("the plist is staged on the LaunchAgents volume, and a failed move leaves nothing staged", async (t) => {
  const f = await setup(t);
  // The fixture's state and LaunchAgents directories are separate volumes for rename.
  assert.equal((await f.install()).code, 0, "same-volume staging installs");
  assert.equal((await f.uninstall()).code, 0);

  f.launchd.calls = [];
  f.launchd.overrides = {
    rename: () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    },
  };
  const result = await f.install();
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).stage, "render");
  assert.deepEqual(readdirSync(f.options.agentsDir), []);
  assert.equal(existsSync(f.recordPath), false);
  assert.deepEqual(f.launchd.mutations(), []);
});

test("install writes and records the diagnostic retention values only when given", async (t) => {
  const plain = await setup(t);
  assert.equal((await plain.install()).code, 0);
  assert.equal(RETENTION in environment(plain.activation), false);
  assert.equal(STORAGE in environment(plain.activation), false);
  assert.equal(
    "diagnosticRetentionDays" in plain.record().configuration,
    false,
  );

  const f = await setup(t);
  const result = await f.install({ retentionDays: 7, storageMib: 256 });
  assert.equal(result.code, 0, result.stderr);
  const env = environment(f.activation);
  assert.equal(env[RETENTION], "7");
  assert.equal(env[STORAGE], "256");
  assert.equal(f.record().configuration.diagnosticRetentionDays, 7);
  assert.equal(f.record().configuration.diagnosticStorageMib, 256);
  assert.equal(f.record().plistSha256, sha256(f.activation));
});

test("upgrade keeps, changes and clears the recorded diagnostic values", async (t) => {
  const f = await installed(t, { retentionDays: 7, storageMib: 256 });
  let result = await f.upgrade();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(environment(f.activation)[RETENTION], "7");
  assert.equal(environment(f.activation)[STORAGE], "256");
  assert.equal(f.record().configuration.diagnosticRetentionDays, 7);

  // The same release directory is the reload route; advance past the snapshot stamp.
  f.launchd.clock += 60_000;
  result = await f.upgrade(f.releaseB, undefined, { retentionDays: null });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(RETENTION in environment(f.activation), false);
  assert.equal(environment(f.activation)[STORAGE], "256");
  assert.equal("diagnosticRetentionDays" in f.record().configuration, false);

  f.launchd.clock += 60_000;
  result = await f.upgrade(f.releaseB, undefined, { storageMib: 512 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(environment(f.activation)[STORAGE], "512");
  assert.equal(f.record().plistSha256, sha256(f.activation));
});

test("upgrade to the installed release re-renders a changed value through every stage", async (t) => {
  const f = await installed(t);
  f.launchd.events = [];
  const result = await f.upgrade(f.releaseA, undefined, { retentionDays: 90 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.launchd.events, [
    "readiness",
    "bootout",
    "exited",
    "bootstrap snapshots=1",
    "readiness",
  ]);
  assert.equal(environment(f.activation)[RETENTION], "90");
  assert.equal(f.record().version, "0.1.0");
  assert.equal(verifySnapshot(result.report.snapshot), 0);
});

test("service install, upgrade and uninstall validate diagnostic options before acting", async (t) => {
  const f = await setup(t);
  const fake = new FakeLaunchd(f.snapshots, f.options.daemonsDir);
  const { io } = capture();
  const deps = { env: { HOME: f.home }, ...io } as unknown as CliDeps;
  const unused = (): OperatorConnection => ({
    origin: async () => {
      throw new Error("unused");
    },
    readiness: async () => {
      throw new Error("unused");
    },
  });
  const run = (args: string[]) =>
    serviceCommand(args, deps, unused, () => fake.host());
  for (const bad of [
    ["--diagnostic-retention-days", "0"],
    ["--diagnostic-retention-days", "366"],
    ["--diagnostic-retention-days", "abc"],
    ["--diagnostic-retention-days", "1.5"],
    ["--diagnostic-retention-days", "007x"],
    ["--diagnostic-storage-mib", "15"],
    ["--diagnostic-storage-mib", "1048577"],
  ]) {
    assert.equal(await run(["install", ...bad]), 2, bad.join(" "));
    assert.equal(await run(["upgrade", "/x", ...bad]), 2, bad.join(" "));
  }
  for (const flag of [
    "--diagnostic-retention-days",
    "--diagnostic-storage-mib",
  ])
    assert.equal(await run(["uninstall", flag, "default"]), 2);
  assert.deepEqual(fake.calls, []);

  // `default` parses; the failure is the unusable release, not a usage error.
  assert.notEqual(
    await run(["upgrade", "/x", "--diagnostic-retention-days", "default"]),
    2,
  );
});

test("an install record written before the diagnostic fields still upgrades", async (t) => {
  const f = await installed(t);
  const record = f.record();
  assert.equal("diagnosticRetentionDays" in record.configuration, false);
  const result = await f.upgrade();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(RETENTION in environment(f.activation), false);
});

test("a record holding an out-of-range diagnostic value is refused before anything stops", async (t) => {
  const f = await installed(t, { retentionDays: 7 });
  const original = readFileSync(f.recordPath, "utf8");
  for (const [field, value] of [
    ["diagnosticRetentionDays", 366],
    ["diagnosticRetentionDays", 0],
    ["diagnosticStorageMib", 15],
    ["diagnosticStorageMib", 1.5],
  ] as const) {
    const record = JSON.parse(original);
    record.configuration[field] = value;
    writeFileSync(f.recordPath, JSON.stringify(record));
    const result = await f.upgrade();
    assert.equal(result.code, 1);
    assert.equal(result.report.stage, "preflight");
    assert.match(result.report.error, /install record .* is invalid/);
    assert.deepEqual(f.launchd.mutations(), [], `${field}=${value}`);
  }
  assert.equal(f.launchd.jobs.has(f.options.label), true);
  writeFileSync(f.recordPath, original);
  assert.equal((await f.upgrade()).code, 0);
});

const TOKEN = `ens_11111111-1111-4111-8111-111111111111_${"s".repeat(43)}`;

class FakeCli implements InstallCli {
  interactive = true;
  /** undefined cancels the prompt. */
  password: string | undefined = "test-password";
  failLogin = false;
  prompts: string[] = [];
  calls: string[] = [];
  logins: unknown[][] = [];
  signals: unknown[] = [];

  /** Set to make the prompt wait until its signal aborts, like an open terminal prompt. */
  hang = false;
  /** Runs once the hanging prompt is open. */
  onPrompt: () => void = () => {};

  async readPassword(prompt: string, signal?: AbortSignal) {
    this.prompts.push(prompt);
    if (this.hang) {
      const closed = new Promise<string>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      this.onPrompt();
      return closed;
    }
    if (this.password === undefined) throw new Error("cancelled");
    return this.password;
  }
  async login(...args: unknown[]) {
    this.calls.push("login");
    this.logins.push(args.slice(0, 4));
    this.signals.push(args[4]);
    if (this.failLogin) throw new Error("keychain unavailable");
  }
  /** Doctor never answers until released. */
  doctorHangs = false;
  releaseDoctor: () => void = () => {};

  async doctor(connection: string) {
    this.calls.push(`doctor ${connection}`);
    // A referenced timer, so a lone run keeps the event loop alive until the bound fires.
    if (this.doctorHangs)
      await new Promise<void>((resolve) => {
        this.releaseDoctor = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(resolve, 10_000);
      });
  }
}

/** A release tarball whose single top directory holds the release; `note` makes its manifest differ. */
function tarballOf(
  root: string,
  version: string,
  note?: string,
  omit?: string,
) {
  const build = mkdtempSync(join(root, "build-"));
  release(build, version);
  if (omit) rmSync(join(build, "versions", version, omit));
  if (note)
    writeFileSync(
      join(build, "versions", version, "manifest.json"),
      JSON.stringify({
        schema: "ensemble.release/v1",
        platform: "darwin-arm64",
        version,
        note,
      }),
    );
  const file = join(
    root,
    `ensemble-${version}${note ?? ""}${omit ? "-incomplete" : ""}.tar.gz`,
  );
  execFileSync("tar", ["-czf", file, "-C", join(build, "versions"), version]);
  rmSync(build, { recursive: true, force: true });
  return file;
}

async function tarballSetup(
  t: { after(fn: () => void): void },
  fixture: Parameters<typeof setup>[2] & { data?: boolean } = {},
) {
  const f = await setup(t, fixture.data, { unpacked: false, ...fixture });
  const tarball = tarballOf(dirname(f.home), "0.1.0");
  const origin = `http://127.0.0.1:${f.options.port}`;
  const run = async (
    overrides: Partial<FirstRun> = {},
    cli: FakeCli = new FakeCli(),
    signal?: AbortSignal,
  ) => {
    const { out, io } = capture();
    const code = await installService(
      f.options,
      f.releaseA,
      f.launchd.host(),
      { ...io, signal },
      { tarball, cli, connection: "local", open: true, ...overrides },
    );
    return { code, ...out, cli };
  };
  return { ...f, tarball, origin, run };
}

test("install TARBALL unpacks, asks for the password, signs in, runs doctor and opens the app", async (t) => {
  const f = await tarballSetup(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(join(f.stateDir, "versions")), ["0.1.0"]);
  assert.equal(
    programArguments(f.activation)[0],
    join(f.stateDir, "versions", "0.1.0", "node", "bin", "node"),
  );
  assert.deepEqual(result.cli.prompts, ["Ensemble operator password: "]);
  assert.deepEqual(
    f.launchd.requests.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /api/operator/session",
      "POST /api/operator/login",
      "POST /api/operator/credentials",
      "POST /api/operator/logout",
    ],
  );
  const credential = f.launchd.requests[2];
  assert.deepEqual(credential?.body, {
    name: "install · test-host",
    scope: "read",
    expiresInDays: 90,
  });
  assert.equal(credential?.headers.origin, f.origin);
  assert.equal(credential?.headers["x-csrf-token"], "c".repeat(43));
  assert.equal(credential?.headers.cookie, "session=abc");
  assert.deepEqual(result.cli.logins, [["local", f.origin, TOKEN, undefined]]);
  assert.ok(result.cli.signals[0] instanceof AbortSignal);
  assert.deepEqual(result.cli.calls, ["login", "doctor local"]);
  assert.deepEqual(f.launchd.opened, [`${f.origin}/app`]);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.connection, "local");
  assert.match(result.stderr, new RegExp(`Open ${f.origin}/app`));
  assert.doesNotMatch(result.stderr + result.stdout, /test-password|ens_/);
});

test("install creates the auth file from the password when it is missing", async (t) => {
  const f = await tarballSetup(t, { auth: false });
  f.launchd.password = "new-password";
  const cli = new FakeCli();
  cli.password = "new-password";
  const result = await f.run({}, cli);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(cli.prompts, ["New Ensemble operator password: "]);
  assert.equal(statSync(f.authFile).mode & 0o777, 0o600);
  const auth = await OperatorAuth.open({
    authFile: f.authFile,
    origin: "http://127.0.0.1:8787",
  });
  try {
    assert.ok(
      await auth.authenticate(auth.createAnonymousSession().id, "new-password"),
    );
  } finally {
    auth.close();
  }
  assert.equal(JSON.parse(result.stdout).connection, "local");
});

test("a missing auth file without a usable password refuses before anything changes", async (t) => {
  for (const arrange of [
    (cli: FakeCli) => {
      cli.interactive = false;
    },
    (cli: FakeCli) => {
      cli.password = undefined;
    },
    (cli: FakeCli) => {
      cli.password = "";
    },
  ]) {
    const f = await tarballSetup(t, { auth: false });
    const cli = new FakeCli();
    arrange(cli);
    const before = tree(f.home);
    const result = await f.run({}, cli);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).stage, "preflight");
    assert.deepEqual(f.launchd.mutations(), []);
    assert.deepEqual(tree(f.home), before);
    assert.equal(existsSync(f.authFile), false);
  }
});

test("tarball install keeps every refusal and creates nothing for the cheap ones", async (t) => {
  const cases: [
    string,
    (f: Awaited<ReturnType<typeof tarballSetup>>) => unknown,
    RegExp,
  ][] = [
    [
      "label already loaded",
      (f) => f.launchd.jobs.set(f.options.label, { path: "/x", pid: 1 }),
      /already loaded/,
    ],
    [
      "existing record",
      (f) => {
        mkdirSync(join(f.stateDir, "launchd"), { mode: 0o700 });
        writeFileSync(f.recordPath, "{}");
      },
      /already installed/,
    ],
    ["tarball is not a file", (f) => rmSync(f.tarball), /not a readable file/],
  ];
  for (const [name, arrange, reason] of cases) {
    const f = await tarballSetup(t);
    arrange(f);
    const before = tree(f.home);
    const result = await f.run();
    assert.equal(result.code, 1, name);
    const report = JSON.parse(result.stderr);
    assert.equal(report.stage, "preflight", name);
    assert.match(report.error, reason, name);
    assert.deepEqual(f.launchd.mutations(), [], name);
    assert.deepEqual(tree(f.home), before, name);
    assert.deepEqual(result.cli.prompts, [], name);
  }
  const f = await tarballSetup(t);
  const busy = createServer().listen(f.options.port, "127.0.0.1");
  await new Promise((done) => busy.once("listening", done));
  try {
    const before = tree(f.home);
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /in use/);
    assert.deepEqual(tree(f.home), before);
  } finally {
    await new Promise((done) => busy.close(done));
  }
});

test("an existing version directory is reused when its manifest matches and refused otherwise", async (t) => {
  const same = await setup(t);
  writeFileSync(join(same.releaseA, "marker"), "kept");
  const reused = await installService(
    same.options,
    same.releaseA,
    same.launchd.host(),
    capture().io,
    {
      tarball: tarballOf(dirname(same.home), "0.1.0"),
      cli: new FakeCli(),
      connection: "local",
      open: false,
    },
  );
  assert.equal(reused, 0);
  assert.equal(readFileSync(join(same.releaseA, "marker"), "utf8"), "kept");
  assert.deepEqual(readdirSync(join(same.stateDir, "versions")), ["0.1.0"]);

  const other = await setup(t);
  const before = tree(join(other.stateDir, "versions"));
  const { out, io } = capture();
  const code = await installService(
    other.options,
    other.releaseA,
    other.launchd.host(),
    io,
    {
      tarball: tarballOf(dirname(other.home), "0.1.0", "different"),
      cli: new FakeCli(),
      connection: "local",
      open: false,
    },
  );
  assert.equal(code, 1);
  const report = JSON.parse(out.stderr);
  assert.equal(report.stage, "unpack");
  assert.equal(report.jobStopped, null);
  assert.match(report.error, /already holds a different release/);
  assert.deepEqual(tree(join(other.stateDir, "versions")), before);
  assert.deepEqual(other.launchd.mutations(), []);
});

test("a wrong password, cancelled prompt or failed store leaves the service installed with the manual login line", async (t) => {
  const login = (f: { origin: string }) =>
    `ensemble auth login --connection local --url ${f.origin}`;
  const settled = async (
    f: Awaited<ReturnType<typeof tarballSetup>>,
    result: Awaited<ReturnType<typeof f.run>>,
  ) => {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(f.recordPath), true);
    assert.equal(existsSync(f.activation), true);
    assert.deepEqual(f.launchd.mutations(), [
      ["bootstrap", `gui/${UID}`, f.activation],
    ]);
    assert.equal(JSON.parse(result.stdout).connection, null);
    assert.ok(result.stderr.includes(login(f)));
    assert.ok(result.stderr.includes("Then run: ensemble doctor"));
    assert.deepEqual(
      result.cli.calls.filter((c) => c.startsWith("doctor")),
      [],
    );
  };

  let f = await tarballSetup(t);
  f.launchd.password = "other-password";
  await settled(f, await f.run());
  assert.deepEqual(
    f.launchd.requests.map(({ path }) => path),
    ["/api/operator/session", "/api/operator/login"],
  );

  f = await tarballSetup(t);
  const cancelled = new FakeCli();
  cancelled.password = undefined;
  await settled(f, await f.run({}, cancelled));
  assert.deepEqual(f.launchd.requests, []);

  f = await tarballSetup(t);
  const failing = new FakeCli();
  failing.failLogin = true;
  await settled(f, await f.run({}, failing));
  const revokes = f.launchd.requests.filter(({ path }) =>
    path.endsWith("/revoke"),
  );
  assert.equal(revokes.length, 1);
  assert.equal(
    revokes[0]?.path,
    "/api/operator/credentials/11111111-1111-4111-8111-111111111111/revoke",
  );
  assert.equal(f.launchd.requests.at(-1)?.path, "/api/operator/logout");
});

test("an unconfirmed revoke or logout is reported in the result and on stderr, and the install still succeeds", async (t) => {
  const f = await tarballSetup(t);
  f.launchd.revokeStatus = 500;
  f.launchd.logoutStatus = 500;
  const failing = new FakeCli();
  failing.failLogin = true;
  const result = await f.run({}, failing);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.connection, null);
  assert.equal(output.credentialActive, true);
  assert.equal(output.sessionOpen, true);
  assert.match(
    result.stderr,
    /The credential "install · test-host" may still be active; revoke it in Settings → CLI credentials\./,
  );
  assert.match(result.stderr, /could not be closed/);
  assert.equal(existsSync(f.recordPath), true);
  // The revoke is tried twice.
  assert.equal(
    f.launchd.requests.filter(({ path }) => path.endsWith("/revoke")).length,
    2,
  );

  const clean = await tarballSetup(t);
  const ok = await clean.run();
  assert.equal(JSON.parse(ok.stdout).credentialActive, false);
  assert.equal(JSON.parse(ok.stdout).sessionOpen, false);
});

test("a doctor that never answers is abandoned on its bound and the URL is still printed and opened", async (t) => {
  const f = await tarballSetup(t);
  const cli = new FakeCli();
  cli.doctorHangs = true;
  t.after(() => cli.releaseDoctor());
  const result = await f.run({}, cli);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`Open ${f.origin}/app`));
  assert.deepEqual(f.launchd.opened, [`${f.origin}/app`]);
});

test("an interrupt while signing in leaves the service installed", async (t) => {
  const f = await tarballSetup(t);
  const interrupt = new AbortController();
  f.launchd.onApi = (path) => {
    if (path === "/api/operator/login") interrupt.abort();
  };
  const result = await f.run({}, new FakeCli(), interrupt.signal);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.launchd.mutations(), [
    ["bootstrap", `gui/${UID}`, f.activation],
  ]);
  assert.equal(existsSync(f.recordPath), true);
  assert.equal(JSON.parse(result.stdout).connection, null);
  assert.deepEqual(result.cli.calls, []);
  assert.deepEqual(f.launchd.opened, []);
});

test("--no-open skips the browser and --token-file reaches the CLI login", async (t) => {
  const f = await tarballSetup(t);
  const tokenFile = join(dirname(f.home), "install.token");
  const result = await f.run({ open: false, tokenFile });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.launchd.opened, []);
  assert.deepEqual(result.cli.logins, [["local", f.origin, TOKEN, tokenFile]]);
});

test("upgrade never signs in or mints a credential", async (t) => {
  const f = await tarballSetup(t, { data: true });
  assert.equal((await f.run()).code, 0);
  f.launchd.requests = [];
  f.launchd.clock += 60_000;
  const releaseB = release(f.stateDir, "0.2.0");
  const code = await upgradeService(
    { ...f.options, port: 1 },
    releaseB,
    {
      origin: async () => f.origin,
      readiness: async () => [{ id: "codex-login", status: "pass" }],
    },
    f.launchd.host(),
    capture().io,
  );
  assert.equal(code, 0);
  assert.deepEqual(f.launchd.requests, []);
});

test("install accepts a tarball, a connection, a token file and --no-open; other commands do not", async (t) => {
  const f = await setup(t);
  const fake = new FakeLaunchd(f.snapshots, f.options.daemonsDir);
  const { io } = capture();
  const deps = { env: { HOME: f.home }, ...io } as unknown as CliDeps;
  const unused = (): OperatorConnection => {
    throw new Error("unused");
  };
  const run = (...argv: string[]) =>
    serviceCommand(argv, deps, unused, () => fake.host());
  for (const argv of [
    ["install", "a.tgz", "b.tgz"],
    ["install", "--connection", "bad name"],
    ["upgrade", f.releaseA, "--token-file", "x"],
    ["upgrade", f.releaseA, "--no-open"],
    ["uninstall", "--token-file", "x"],
    ["uninstall", "--no-open"],
    ["uninstall", "--connection", "x"],
  ])
    assert.equal(await run(...argv), 2, argv.join(" "));
  // Accepted: it then refuses the missing tarball before touching launchd.
  assert.equal(
    await run(
      "install",
      join(f.home, "missing.tar.gz"),
      "--connection",
      "live",
      "--token-file",
      join(f.home, "token"),
      "--no-open",
      "--label",
      f.options.label,
    ),
    1,
  );
  assert.deepEqual(fake.mutations(), []);
});

test("a first install with no state directory creates it and still holds the lock", async (t) => {
  const f = await tarballSetup(t, { auth: false });
  rmSync(f.stateDir, { recursive: true });
  const lock = join(f.stateDir, `.${f.options.label}.lock`);
  let lockedAtBootstrap = false;
  f.launchd.onBootstrap = () => {
    lockedAtBootstrap = existsSync(lock);
  };
  const cli = new FakeCli();
  f.launchd.password = "test-password";
  const result = await f.run({}, cli);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(lockedAtBootstrap, true);
  assert.equal(existsSync(lock), false);
  assert.equal(statSync(f.stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(f.authFile).mode & 0o777, 0o600);
});

test("an interrupt during the tarball extraction stops before the auth file, the LaunchAgent or any launchd change", async (t) => {
  for (const extracted of [false, true]) {
    const f = await tarballSetup(t, { auth: false });
    const interrupt = new AbortController();
    const real = f.launchd.host().extract;
    // `false` is tar killed by the signal; `true` is tar finishing just as the interrupt lands.
    f.launchd.overrides.extract = async (tarball, dir, signal) => {
      assert.equal(signal, interrupt.signal);
      if (extracted) await real(tarball, dir);
      interrupt.abort();
      return extracted;
    };
    const result = await f.run({}, new FakeCli(), interrupt.signal);
    assert.equal(result.code, 1, String(extracted));
    const report = JSON.parse(result.stderr);
    assert.equal(report.stage, "unpack");
    assert.equal(report.error, "interrupted");
    assert.equal(existsSync(f.authFile), false);
    assert.equal(existsSync(f.activation), false);
    assert.equal(existsSync(f.recordPath), false);
    assert.deepEqual(f.launchd.mutations(), []);
    assert.deepEqual(readdirSync(join(f.stateDir, "versions")), []);
    assert.deepEqual(f.launchd.requests, []);
  }
});

test("the default tar extraction is killed when its signal aborts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-extract-"));
  // tar blocks opening a FIFO that has no writer, standing in for a long extraction.
  const fifo = join(root, "release.tar.gz");
  execFileSync("mkfifo", [fifo]);
  const destination = join(root, "out");
  mkdirSync(destination);
  // Only this process's own child counts: GNU tar forks a helper that the abort cannot reach,
  // which is released below.
  const running = () =>
    execFileSync(
      "ps",
      ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "args="],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .some((line) => {
        const [, parent] = line.trim().split(/\s+/);
        return Number(parent) === process.pid && line.includes(fifo);
      });
  t.after(() => {
    // Release a blocked GNU helper first, then remove the directory.
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is waiting.
    }
    rmSync(root, { recursive: true, force: true });
  });
  const interrupt = new AbortController();
  const extraction = defaultServiceHost().extract(
    fifo,
    destination,
    interrupt.signal,
  );
  const deadline = Date.now() + 5000;
  while (!running() && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(running(), true, "tar started");
  const started = Date.now();
  interrupt.abort();
  assert.equal(await extraction, false);
  assert.ok(Date.now() - started < 5000, "returns promptly");
  while (running() && Date.now() < deadline + 5000)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(running(), false, "tar was terminated");
  assert.deepEqual(readdirSync(destination), []);
});

test("an interrupt before or during the password prompt stops the install before it changes anything", async (t) => {
  for (const when of ["before", "during"] as const) {
    const f = await tarballSetup(t, { auth: false });
    const interrupt = new AbortController();
    const cli = new FakeCli();
    if (when === "before") interrupt.abort();
    else {
      cli.hang = true;
      cli.onPrompt = () => interrupt.abort();
    }
    const before = tree(f.home);
    const result = await f.run({}, cli, interrupt.signal);
    assert.equal(result.code, 1, when);
    const report = JSON.parse(result.stderr);
    assert.equal(report.stage, "preflight", when);
    assert.equal(report.error, "interrupted", when);
    assert.deepEqual(
      cli.prompts,
      when === "before" ? [] : ["New Ensemble operator password: "],
    );
    assert.equal(existsSync(f.authFile), false, when);
    assert.deepEqual(f.launchd.mutations(), [], when);
    assert.deepEqual(tree(f.home), before, when);
    assert.equal(
      existsSync(join(f.stateDir, `.${f.options.label}.lock`)),
      false,
      when,
    );
  }
});

test("a tarball with an incomplete release is refused before publishing, and a rerun with a good one succeeds", async (t) => {
  for (const omit of ["node/bin/node", "dist/src/standalone/cli.js"]) {
    const f = await tarballSetup(t);
    const bad = tarballOf(dirname(f.home), "0.1.0", undefined, omit);
    const refused = await f.run({ tarball: bad });
    assert.equal(refused.code, 1, omit);
    const report = JSON.parse(refused.stderr);
    assert.equal(report.stage, "unpack", omit);
    assert.match(report.error, /incomplete/, omit);
    assert.deepEqual(readdirSync(join(f.stateDir, "versions")), [], omit);
    assert.deepEqual(f.launchd.mutations(), [], omit);
    const retried = await f.run();
    assert.equal(retried.code, 0, retried.stderr);
    assert.deepEqual(readdirSync(join(f.stateDir, "versions")), ["0.1.0"]);
  }
});

test("an incomplete or empty version directory is replaced, a complete different one is not", async (t) => {
  for (const damage of ["missing node", "empty"]) {
    const f = await tarballSetup(t);
    const target = join(f.stateDir, "versions", "0.1.0");
    release(f.stateDir, "0.1.0");
    if (damage === "empty") {
      rmSync(target, { recursive: true });
      mkdirSync(target);
    } else rmSync(join(target, "node", "bin", "node"));
    const result = await f.run();
    assert.equal(result.code, 0, `${damage}: ${result.stderr}`);
    assert.ok(existsSync(join(target, "node", "bin", "node")), damage);
    assert.deepEqual(readdirSync(join(f.stateDir, "versions")), ["0.1.0"]);
  }
});

test("a symlinked versions directory is refused before anything is extracted", async (t) => {
  const f = await tarballSetup(t);
  const elsewhere = join(dirname(f.home), "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(f.stateDir, "versions"));
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).stage, "unpack");
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.deepEqual(f.launchd.mutations(), []);
});

test("a staging directory left by a dead install is swept, a live one is kept", async (t) => {
  const f = await tarballSetup(t);
  const versions = join(f.stateDir, "versions");
  mkdirSync(versions, { recursive: true });
  const dead = spawnSync("true").pid;
  mkdirSync(join(versions, `.staging-${dead}-abc`));
  mkdirSync(join(versions, `.staging-${process.pid}-abc`));
  assert.equal((await f.run()).code, 0);
  assert.deepEqual(
    readdirSync(versions).sort(),
    ["0.1.0", `.staging-${process.pid}-abc`].sort(),
  );
});

test("a token file that already exists is refused before anything changes or any credential is minted", async (t) => {
  for (const tokenFile of [
    (f: { home: string }) => f.home,
    (f: { home: string }) => join(f.home, "missing", "token"),
  ]) {
    const f = await tarballSetup(t);
    const before = tree(f.home);
    const result = await f.run({ tokenFile: tokenFile(f) });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).stage, "preflight");
    assert.deepEqual(f.launchd.requests, []);
    assert.deepEqual(f.launchd.mutations(), []);
    assert.deepEqual(tree(f.home), before);
  }
});

/** A path as the printed sudo steps quote it: bare when plain, else single-quoted. */
const quoted = (path: string) =>
  /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path}'`;
const ROOT_MESSAGE =
  "Ensemble does not run as root; run it as the account that owns the service";
const KEYCHAIN_WARNING = "gh auth login --insecure-storage";

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Copies the staged plist into the daemons directory and loads it, as the sudo steps would. */
function runSudoSteps(f: Fixture) {
  copyFileSync(f.staged, f.installed);
  chmodSync(f.installed, 0o644);
  f.launchd.systemJobs.set(f.options.label, { path: f.installed, pid: 5000 });
  f.launchd.alive.add(5000);
}

/** What the operator's `bootout` and `rm` leave: no job and no plist; the process is separate. */
function runSudoUninstallSteps(f: Fixture) {
  f.launchd.systemJobs.clear();
  rmSync(f.installed, { force: true });
}

const stateTrees = (f: Fixture) =>
  [f.stateDir, f.options.agentsDir, f.options.daemonsDir].map(tree);

test("daemon mode install renders, lints and records without touching launchd", async (t) => {
  const f = await setup(t);
  const result = await f.installDaemon();
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "daemon");
  assert.equal(output.started, false);
  assert.equal(output.plist, f.staged);
  // The state path holds a space, so the steps are quoted.
  assert.ok(f.staged.includes(" "));
  assert.deepEqual(output.steps, [
    `sudo /usr/bin/install -m 0644 -o root -g wheel ${quoted(f.staged)} ${quoted(f.installed)}`,
    `sudo /bin/launchctl bootstrap system ${quoted(f.installed)}`,
  ]);
  for (const step of output.steps) assert.ok(result.stderr.includes(step));
  assert.ok(
    result.stderr.includes(
      `Then run the same install command again, with the same options and no TARBALL, to verify: ${quoted(join(f.stateDir, "versions", "0.1.0", "bin", "ensemble"))} service install --state-dir ${quoted(f.stateDir)} --log-dir ${quoted(f.options.logDir)} --launch-agents-dir ${quoted(f.options.agentsDir)} --label ${f.options.label} --port ${f.options.port} --connection local --mode daemon`,
    ),
    result.stderr,
  );

  const record = f.record();
  assert.equal(record.mode, "daemon");
  assert.equal(record.plistSha256, sha256(f.staged));
  assert.equal(record.configuration.userName, "operator");
  assert.equal(record.configuration.home, f.home);
  assert.equal(statSync(f.staged).mode & 0o777, 0o600);
  const plist = readFileSync(f.staged, "utf8");
  assert.match(plist, /<key>UserName<\/key>\s*<string>operator<\/string>/);
  assert.equal(environment(f.staged).HOME, f.home);
  assert.deepEqual(readdirSync(join(f.stateDir, "launchd")).sort(), [
    "local.ensemble.test.json",
    "local.ensemble.test.plist",
  ]);

  // Only reads reach launchd; nothing is written to either plist directory.
  assert.ok(f.launchd.calls.length > 0);
  assert.deepEqual(f.launchd.mutations(), []);
  assert.equal(existsSync(f.options.agentsDir), false);
  assert.deepEqual(readdirSync(f.options.daemonsDir), []);
  assert.deepEqual(f.launchd.fetched, []);
  assert.deepEqual(f.launchd.requests, []);
  assert.equal(f.launchd.linted.length, 1);
  assert.match(
    f.launchd.linted[0] ?? "",
    /\/launchd\/\.local\.ensemble\.test\.staging-[^/]+\/local\.ensemble\.test\.plist$/,
  );
  assert.equal(
    existsSync(join(f.stateDir, ".local.ensemble.test.lock")),
    false,
  );
});

test("daemon mode plist passes plutil -lint", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  execFileSync("/usr/bin/plutil", ["-lint", f.staged]);
});

test("daemon mode failed render or lint leaves no record or staged plist and never calls launchd", async (t) => {
  const failures: [string, Partial<ServiceHost>][] = [
    [
      "the move",
      {
        rename: () => {
          throw Object.assign(new Error("cross-device link"), {
            code: "EXDEV",
          });
        },
      },
    ],
    ["the lint", { lint: async () => false }],
  ];
  for (const [name, overrides] of failures) {
    const f = await setup(t);
    f.launchd.overrides = overrides;
    const result = await f.installDaemon();
    assert.equal(result.code, 1, name);
    const report = JSON.parse(result.stderr);
    assert.equal(report.stage, "render", name);
    assert.equal(report.jobStopped, null, name);
    assert.deepEqual(readdirSync(join(f.stateDir, "launchd")), [], name);
    assert.deepEqual(f.launchd.mutations(), [], name);
    assert.deepEqual(readdirSync(f.options.daemonsDir), [], name);
  }
});

test("daemon mode re-run verifies the installed plist and job against the record", async (t) => {
  const f = await setup(t);
  const first = JSON.parse((await f.installDaemon()).stdout);
  const recordBytes = readFileSync(f.recordPath);
  const recordState = statSync(f.recordPath);
  const sameRecord = () => {
    const now = statSync(f.recordPath);
    assert.deepEqual(readFileSync(f.recordPath), recordBytes);
    assert.equal(now.ino, recordState.ino);
    assert.equal(now.mtimeMs, recordState.mtimeMs);
  };

  // Not loaded yet: the same steps again, and nothing recorded again.
  f.launchd.calls = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await f.installDaemon();
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.started, false);
    assert.deepEqual(output.steps, first.steps);
    sameRecord();
    assert.deepEqual(f.launchd.mutations(), []);
    assert.deepEqual(f.launchd.fetched, []);
  }

  // Only the copy was run: the root-owned plist matches, so only loading is printed.
  copyFileSync(f.staged, f.installed);
  chmodSync(f.installed, 0o644);
  const copied = await f.installDaemon();
  assert.equal(copied.code, 0, copied.stderr);
  assert.deepEqual(JSON.parse(copied.stdout).steps, [first.steps[1]]);
  assert.equal(JSON.parse(copied.stdout).started, false);
  assert.ok(!copied.stderr.includes("/usr/bin/install"));
  // That no longer needs the staged copy.
  const stagedBytes = readFileSync(f.staged);
  rmSync(f.staged);
  assert.deepEqual(JSON.parse((await f.installDaemon()).stdout).steps, [
    first.steps[1],
  ]);
  writeFileSync(f.staged, stagedBytes);
  rmSync(f.installed);

  // The operator ran the steps: loaded, matching, and the app answers.
  runSudoSteps(f);
  const verified = await f.installDaemon({ open: true });
  assert.equal(verified.code, 0, verified.stderr);
  const output = JSON.parse(verified.stdout);
  assert.equal(output.started, true);
  assert.deepEqual(output.steps, []);
  assert.equal(output.plist, f.installed);
  assert.deepEqual(f.launchd.fetched, [
    `http://127.0.0.1:${f.options.port}/app`,
  ]);
  assert.match(verified.stderr, /ensemble auth login --connection local/);
  assert.match(verified.stderr, /Open http:\/\/127\.0\.0\.1:\d+\/app/);
  assert.deepEqual(f.launchd.mutations(), []);
  assert.deepEqual(f.launchd.requests, []);
  // Verifying never opens the browser, even when open is the default.
  assert.deepEqual(f.launchd.opened, []);
  // The running service is recorded, as the process to confirm gone at uninstall.
  const observed = f.record();
  assert.deepEqual(observed.observed, {
    processes: [
      { processId: "5000", processStartedAt: "start-0", bootId: "boot-1" },
    ],
    unidentified: false,
    identified: true,
  });
  assert.deepEqual(
    { ...observed, observed: undefined },
    { ...JSON.parse(recordBytes.toString("utf8")), observed: undefined },
  );
  // Verifying the same process again rewrites nothing.
  const stable = statSync(f.recordPath);
  assert.equal((await f.installDaemon()).code, 0);
  assert.equal(statSync(f.recordPath).ino, stable.ino);
  assert.equal(statSync(f.recordPath).mtimeMs, stable.mtimeMs);
  // A restarted job is another process, and the first is still unconfirmed: both are kept.
  f.launchd.systemJobs.set(f.options.label, { path: f.installed, pid: 5001 });
  f.launchd.alive.add(5001);
  assert.equal((await f.installDaemon()).code, 0);
  assert.deepEqual(
    f
      .record()
      .observed.processes.map((p: { processId: string }) => p.processId),
    ["5000", "5001"],
  );
  // Once the first is confirmed gone the next observation drops it, and only it.
  f.launchd.alive.delete(5000);
  assert.equal((await f.installDaemon()).code, 0);
  assert.deepEqual(
    f
      .record()
      .observed.processes.map((p: { processId: string }) => p.processId),
    ["5001"],
  );
  assert.equal(f.record().observed.identified, true);
});

test("daemon mode re-run refuses a plist or job that does not match the record", async (t) => {
  const cases: [string, (f: Fixture) => unknown, RegExp][] = [
    [
      "tampered plist, job loaded",
      (f) => {
        runSudoSteps(f);
        appendFileSync(f.installed, "\n<!-- changed -->\n");
      },
      /does not match the install record/,
    ],
    [
      "tampered plist, not loaded",
      (f) => {
        copyFileSync(f.staged, f.installed);
        appendFileSync(f.installed, "\n<!-- changed -->\n");
      },
      /does not match the install record/,
    ],
    [
      "job loaded from another path",
      (f) => {
        copyFileSync(f.staged, f.installed);
        f.launchd.systemJobs.set(f.options.label, {
          path: "/elsewhere.plist",
          pid: 5000,
        });
      },
      /does not match the install record/,
    ],
    [
      "job loaded without the installed plist",
      (f) =>
        f.launchd.systemJobs.set(f.options.label, {
          path: f.installed,
          pid: 5000,
        }),
      /does not match the install record/,
    ],
    [
      "symlinked plist with the recorded content",
      (f) => symlinkSync(f.staged, f.installed),
      /does not match the install record/,
    ],
    [
      "plist writable by others",
      (f) => {
        copyFileSync(f.staged, f.installed);
        chmodSync(f.installed, 0o666);
      },
      /does not match the install record/,
    ],
    [
      "plist not owned by root",
      (f) => {
        copyFileSync(f.staged, f.installed);
        chmodSync(f.installed, 0o644);
        f.options.daemonPlistOwner = UID + 1;
      },
      /does not match the install record/,
    ],
    [
      "staged plist changed",
      (f) => appendFileSync(f.staged, "\n<!-- changed -->\n"),
      /staged plist .* does not match the install record/,
    ],
    [
      "staged plist missing",
      (f) => rmSync(f.staged),
      /staged plist .* does not match the install record/,
    ],
    [
      "different port",
      (f) => {
        f.options.port += 1;
      },
      /installed on port \d+; pass --port \d+/,
    ],
  ];
  for (const [name, arrange, error] of cases) {
    const f = await setup(t);
    assert.equal((await f.installDaemon()).code, 0, name);
    arrange(f);
    const bytes = readFileSync(f.recordPath);
    f.launchd.calls = [];
    const result = await f.installDaemon();
    assert.equal(result.code, 1, name);
    assert.match(JSON.parse(result.stderr).error, error, name);
    assert.deepEqual(readFileSync(f.recordPath), bytes, name);
    assert.deepEqual(f.launchd.mutations(), [], name);
    assert.deepEqual(f.launchd.fetched, [], name);
  }

  // Another release, or a tarball, never re-runs over the record.
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  const releaseB = release(f.stateDir, "0.2.0");
  const { out, io } = capture();
  assert.equal(
    await installService(f.options, releaseB, f.launchd.host(), io, {
      connection: "local",
      open: false,
      mode: "daemon",
    }),
    1,
  );
  assert.match(JSON.parse(out.stderr).error, /installed at 0\.1\.0/);
  const tarball = join(f.home, "release.tgz");
  writeFileSync(tarball, "");
  const withTarball = await f.installDaemon({ tarball });
  assert.equal(withTarball.code, 1);
  assert.match(JSON.parse(withTarball.stderr).error, /already installed/);
  assert.equal(f.record().version, "0.1.0");
});

test("daemon mode install refuses while the LaunchAgent exists, and agent install refuses while the daemon exists", async (t) => {
  type Arrange = (f: Fixture) => Promise<unknown> | unknown;
  const agentArtifacts: [string, Arrange][] = [
    [
      "agent record",
      async (f) => {
        assert.equal((await f.install()).code, 0);
        rmSync(f.activation);
        f.launchd.jobs.clear();
      },
    ],
    [
      "gui job",
      (f) =>
        f.launchd.jobs.set(f.options.label, { path: "/other.plist", pid: 7 }),
    ],
    [
      "agent plist",
      (f) => {
        mkdirSync(f.options.agentsDir, { recursive: true });
        writeFileSync(f.activation, "<plist/>");
      },
    ],
  ];
  const daemonArtifacts: [string, Arrange][] = [
    [
      "daemon record",
      async (f) => assert.equal((await f.installDaemon()).code, 0),
    ],
    [
      "system job",
      (f) =>
        f.launchd.systemJobs.set(f.options.label, {
          path: "/other.plist",
          pid: 7,
        }),
    ],
    ["daemons directory plist", (f) => writeFileSync(f.installed, "<plist/>")],
  ];
  for (const [direction, artifacts] of [
    ["daemon", agentArtifacts],
    ["agent", daemonArtifacts],
  ] as const)
    for (const [name, arrange] of artifacts) {
      const f = await setup(t);
      await arrange(f);
      const before = stateTrees(f);
      f.launchd.calls = [];
      f.launchd.fetched = [];
      const result =
        direction === "daemon" ? await f.installDaemon() : await f.install();
      const label = `${direction} install over ${name}`;
      assert.equal(result.code, 1, label);
      const report = JSON.parse(result.stderr);
      assert.equal(report.stage, "preflight", label);
      assert.match(
        report.error,
        new RegExp(
          `already present in ${direction === "daemon" ? "agent" : "daemon"} mode; run .ensemble service uninstall`,
        ),
        label,
      );
      assert.deepEqual(stateTrees(f), before, label);
      assert.deepEqual(f.launchd.mutations(), [], label);
      assert.deepEqual(f.launchd.fetched, [], label);
    }
});

test("daemon mode uninstall prints the sudo steps until the job and plist are gone, then removes the record", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  const bootout = `sudo /bin/launchctl bootout system/${f.options.label}`;
  const remove = `sudo /bin/rm -f ${quoted(f.installed)}`;

  f.launchd.calls = [];
  let result = await f.uninstall();
  assert.equal(result.code, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.equal(output.mode, "daemon");
  assert.equal(output.complete, false);
  assert.deepEqual(output.steps, [bootout, remove]);
  assert.match(result.stderr, /ensemble service uninstall` again/);
  assert.equal(existsSync(f.recordPath), true);
  assert.equal(existsSync(f.staged), true);
  assert.deepEqual(f.launchd.mutations(), []);

  // Only the plist is left: only its removal is printed.
  f.launchd.systemJobs.clear();
  output = JSON.parse((await f.uninstall()).stdout);
  assert.equal(output.complete, false);
  assert.deepEqual(output.steps, [remove]);

  rmSync(f.installed);
  // The job's process, recorded while it was loaded, has exited too.
  assert.equal(f.record().observed.processes[0].processId, "5000");
  f.launchd.alive.delete(5000);
  result = await f.uninstall();
  assert.equal(result.code, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.complete, true);
  assert.equal("steps" in output, false);
  assert.equal(existsSync(f.recordPath), false);
  assert.equal(existsSync(f.staged), false);
  assert.deepEqual(f.launchd.mutations(), []);
  assert.deepEqual(readdirSync(join(f.stateDir, "launchd")), []);

  // Nothing installed any more.
  assert.equal(JSON.parse((await f.uninstall()).stdout).installed, false);
});

test("daemon mode uninstall refuses daemon artifacts it does not own", async (t) => {
  const cases: [string, (f: Fixture) => unknown][] = [
    [
      "a system job without a record",
      (f) =>
        f.launchd.systemJobs.set(f.options.label, {
          path: f.installed,
          pid: 7,
        }),
    ],
    [
      "a daemons directory plist without a record",
      (f) => writeFileSync(f.installed, "<plist/>"),
    ],
  ];
  for (const [name, arrange] of cases) {
    const f = await setup(t);
    arrange(f);
    const before = stateTrees(f);
    const jobs = f.launchd.systemJobs.size;
    const result = await f.uninstall();
    assert.equal(result.code, 1, name);
    assert.match(
      JSON.parse(result.stderr).error,
      /not created by this installation/,
    );
    assert.deepEqual(stateTrees(f), before, name);
    assert.equal(f.launchd.systemJobs.size, jobs, name);
    assert.deepEqual(f.launchd.mutations(), [], name);
  }

  // With a record, a plist or job that differs from it is not ours either.
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  writeFileSync(f.installed, "<plist>other</plist>");
  const before = stateTrees(f);
  const result = await f.uninstall();
  assert.equal(result.code, 1);
  assert.match(
    JSON.parse(result.stderr).error,
    /does not match the install record/,
  );
  assert.deepEqual(stateTrees(f), before);
});

test("daemon mode switch-back restores the LaunchAgent, and the LaunchAgent switches to daemon", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  assert.equal(JSON.parse((await f.uninstall()).stdout).complete, true);

  const agent = await f.install();
  assert.equal(agent.code, 0, agent.stderr);
  assert.equal(JSON.parse(agent.stdout).mode, "agent");
  assert.deepEqual(f.launchd.mutations(), [
    ["bootstrap", `gui/${UID}`, f.activation],
  ]);
  assert.equal(existsSync(f.activation), true);
  assert.equal(f.record().mode, "agent");
  assert.equal(f.record().configuration.userName, undefined);

  assert.equal((await f.uninstall()).code, 0);
  assert.equal(existsSync(f.activation), false);
  const daemon = await f.installDaemon();
  assert.equal(daemon.code, 0, daemon.stderr);
  assert.equal(f.record().mode, "daemon");
  assert.equal(JSON.parse(daemon.stdout).started, false);
});

test("daemon mode upgrade refuses before stopping anything", async (t) => {
  const f = await setup(t, true);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  const releaseB = release(f.stateDir, "0.2.0");
  const reads: string[] = [];
  const connection: OperatorConnection = {
    origin: async () => {
      reads.push("origin");
      return "http://127.0.0.1:1";
    },
    readiness: async () => {
      reads.push("readiness");
      return [];
    },
  };
  const bytes = readFileSync(f.recordPath);
  f.launchd.calls = [];
  const { out, io } = capture();
  const code = await upgradeService(
    f.options,
    releaseB,
    connection,
    f.launchd.host(),
    io,
  );
  assert.equal(code, 1);
  const report = JSON.parse(out.stderr);
  assert.equal(report.stage, "preflight");
  assert.equal(report.jobStopped, null);
  assert.match(report.error, /switch back first/);
  assert.match(report.error, /service install --mode daemon/);
  assert.deepEqual(f.launchd.calls, []);
  assert.deepEqual(reads, []);
  assert.deepEqual(readdirSync(f.snapshots), []);
  assert.deepEqual(readFileSync(f.recordPath), bytes);
  assert.equal(f.launchd.systemJobs.size, 1);
});

test("daemon mode root refusal changes nothing", async (t) => {
  const f = await setup(t);
  f.launchd.overrides = { isRoot: () => true };
  const before = stateTrees(f);
  const unused: OperatorConnection = {
    origin: async () => {
      throw new Error("unused");
    },
    readiness: async () => {
      throw new Error("unused");
    },
  };
  const fresh = { ...f.options, stateDir: join(f.home, "fresh state") };
  const tarball = join(f.home, "release.tgz");
  writeFileSync(tarball, "");
  const runs: [
    string,
    (io: ReturnType<typeof capture>["io"]) => Promise<number>,
  ][] = [
    [
      "agent install",
      (io) => installService(f.options, f.releaseA, f.launchd.host(), io),
    ],
    ["daemon install", (io) => f.installDaemonWith(io)],
    [
      "daemon install of a tarball into a new state directory",
      (io) =>
        installService(fresh, f.releaseA, f.launchd.host(), io, {
          tarball,
          connection: "local",
          open: false,
          mode: "daemon",
        }),
    ],
    [
      "upgrade",
      (io) =>
        upgradeService(f.options, f.releaseA, unused, f.launchd.host(), io),
    ],
    ["uninstall", (io) => uninstallService(f.options, f.launchd.host(), io)],
  ];
  for (const [name, run] of runs) {
    const { out, io } = capture();
    assert.equal(await run(io), 1, name);
    const report = JSON.parse(out.stderr);
    assert.equal(report.ok, false, name);
    assert.equal(report.stage, "preflight", name);
    assert.equal(report.error, ROOT_MESSAGE, name);
    assert.equal(report.jobStopped, null, name);
    assert.equal(out.stderr.includes(f.home), false, name);
  }
  assert.deepEqual(f.launchd.calls, []);
  assert.deepEqual(stateTrees(f), before);
  assert.equal(existsSync(fresh.stateDir), false);
  assert.equal(f.launchd.ghProbes, 0);
});

test("daemon mode install warns about a keychain gh login without blocking", async (t) => {
  for (const storage of ["file", "unknown"] as const) {
    const f = await setup(t);
    f.launchd.ghStorage = storage;
    const result = await f.installDaemon();
    assert.equal(result.code, 0, storage);
    assert.equal(result.stderr.includes(KEYCHAIN_WARNING), false, storage);
  }
  const f = await setup(t);
  f.launchd.ghStorage = "keyring";
  const result = await f.installDaemon();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).started, false);
  assert.ok(result.stderr.includes(KEYCHAIN_WARNING));
  assert.match(
    result.stderr,
    /login keychain, which a LaunchDaemon cannot read before you log in/,
  );
  // A re-run warns too, and a failing probe never fails the install.
  assert.ok((await f.installDaemon()).stderr.includes(KEYCHAIN_WARNING));
  f.launchd.overrides = {
    ghTokenStorage: async () => {
      throw new Error("probe failed");
    },
  };
  assert.equal((await f.installDaemon()).code, 0);

  // The LaunchAgent never probes.
  const agent = await setup(t);
  agent.launchd.ghStorage = "keyring";
  const installedAgent = await agent.install();
  assert.equal(installedAgent.code, 0, installedAgent.stderr);
  assert.equal(agent.launchd.ghProbes, 0);
  assert.equal(installedAgent.stderr.includes(KEYCHAIN_WARNING), false);
});

test("daemon mode gh token storage probe never reads a token", async (t) => {
  const gh = fakeStatusGh(t);
  assert.equal(await ghTokenStorage(gh.env("keyring")), "keyring");
  const lines = readFileSync(gh.log, "utf8").trim().split("\n");
  assert.equal(
    lines[0],
    "auth status --active --hostname github.com --json hosts",
  );
  assert.deepEqual(lines.slice(1), [
    "GH_TOKEN=unset",
    "GITHUB_TOKEN=unset",
    "GH_ENTERPRISE_TOKEN=unset",
    "GITHUB_ENTERPRISE_TOKEN=unset",
    "GH_PROMPT_DISABLED=1",
  ]);
  const everything = readFileSync(gh.log, "utf8");
  assert.equal(/auth token|--show-token/.test(everything), false);

  const outcomes: [string, GhTokenStorage][] = [
    ["/Users/operator/.config/gh/hosts.yml", "file"],
    ["GH_TOKEN", "unknown"],
    ["", "unknown"],
    ["fail", "unknown"],
    ["garbage", "unknown"],
  ];
  for (const [mode, expected] of outcomes) {
    const result = await ghTokenStorage(gh.env(mode));
    assert.equal(result, expected, mode);
    assert.equal(JSON.stringify(result).includes("canary"), false);
  }
  // No gh on the PATH is unknown, not an error.
  assert.equal(
    await ghTokenStorage({ ...gh.env("keyring"), PATH: "/nonexistent" }),
    "unknown",
  );
});

test("daemon mode CLI parses --mode only for install", async (t) => {
  const f = await setup(t);
  const fake = new FakeLaunchd(f.snapshots, f.options.daemonsDir);
  const { io } = capture();
  const deps = { env: { HOME: f.home }, ...io } as unknown as CliDeps;
  const unused = (): OperatorConnection => {
    throw new Error("unused");
  };
  const run = (...argv: string[]) =>
    serviceCommand(argv, deps, unused, () => fake.host());
  for (const argv of [
    ["install", "--mode", "daemon", "--token-file", "x"],
    ["install", "--mode", "bogus"],
    ["install", "--mode"],
    ["upgrade", f.releaseA, "--mode", "daemon"],
    ["upgrade", f.releaseA, "--mode", "agent"],
    ["uninstall", "--mode", "daemon"],
    ["uninstall", "--mode", "agent"],
    ["init-auth", "--mode", "daemon"],
  ])
    assert.equal(await run(...argv), 2, argv.join(" "));
  // Accepted: each then refuses (the checkout is not a release) before touching launchd.
  for (const mode of ["agent", "daemon"])
    assert.equal(await run("install", "--mode", mode), 1, mode);
  assert.deepEqual(fake.mutations(), []);
  assert.match(SERVICE_USAGE, /service install .*\[--mode agent\|daemon\]/);
});

test("daemon mode records are refused by a v1 reader without mode, and a record without mode is an agent", async (t) => {
  const olderReader = z
    .object({
      schema: z.literal("ensemble.service/v1"),
      label: z.string(),
      version: z.string(),
      plistSha256: z.string(),
      configuration: z
        .object({
          label: z.string(),
          nodePath: z.string(),
          cliPath: z.string(),
          dataDirectory: z.string(),
          authFile: z.string(),
          origin: z.string(),
          port: z.number(),
          stdoutPath: z.string(),
          stderrPath: z.string(),
        })
        .strict(),
    })
    .strict();
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  assert.equal(olderReader.safeParse(f.record()).success, false);

  assert.equal((await f.uninstall()).code, 0);
  assert.equal((await f.install()).code, 0);
  // An agent record is also written with its mode, so an older CLI changes nothing.
  assert.equal(olderReader.safeParse(f.record()).success, false);
  const { mode: _mode, ...legacy } = f.record();
  writeFileSync(f.recordPath, JSON.stringify(legacy));
  assert.equal(olderReader.safeParse(legacy).success, true);
  const result = await f.uninstall();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "agent");
  assert.equal(existsSync(f.activation), false);

  // A daemon record without its account, or an agent record with one, is invalid.
  assert.equal((await f.installDaemon()).code, 0);
  const record = f.record();
  for (const broken of [
    {
      ...record,
      configuration: { ...record.configuration, userName: undefined },
    },
    { ...record, mode: "agent" },
  ]) {
    writeFileSync(f.recordPath, JSON.stringify(broken));
    const refused = await f.uninstall();
    assert.equal(refused.code, 1);
    assert.match(
      JSON.parse(refused.stderr).error,
      /install record .* is invalid/,
    );
  }
});

/** Installs the daemon, runs its steps and has uninstall record the running process. */
async function runningDaemon(t: { after(fn: () => void): void }) {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  assert.equal((await f.uninstall()).code, 0);
  assert.equal(
    JSON.parse(readFileSync(f.recordPath, "utf8")).observed.processes[0]
      .processId,
    "5000",
  );
  // The operator boots the job out and removes the plist; the process is separate.
  runSudoUninstallSteps(f);
  return f;
}

const HOLD = /could not be confirmed stopped/;

test("daemon mode uninstall keeps the record while the booted-out process is still alive", async (t) => {
  const f = await runningDaemon(t);
  const bytes = readFileSync(f.recordPath);
  const before = stateTrees(f);
  f.launchd.calls = [];
  // Still terminating: bootout removed the registration, the process did not exit.
  const held = await f.uninstall();
  assert.equal(held.code, 1);
  const error = JSON.parse(held.stderr).error;
  assert.match(error, HOLD);
  assert.match(error, /recorded process may still be running/);
  assert.match(
    error,
    /launchctl print system\/local\.ensemble\.test` exits 113/,
  );
  assert.match(error, /lsof -nP -iTCP:\d+ -sTCP:LISTEN/);
  assert.deepEqual(readFileSync(f.recordPath), bytes);
  assert.deepEqual(stateTrees(f), before);
  assert.deepEqual(f.launchd.mutations(), []);

  // Nothing else may start while it is held: the record still names the daemon.
  const agent = await f.install();
  assert.equal(agent.code, 1);
  assert.match(
    JSON.parse(agent.stderr).error,
    /already present in daemon mode/,
  );
  assert.deepEqual(f.launchd.mutations(), []);
  const { out, io } = capture();
  const connection: OperatorConnection = {
    origin: async () => "http://127.0.0.1:1",
    readiness: async () => [],
  };
  assert.equal(
    await upgradeService(
      f.options,
      release(f.stateDir, "0.2.0"),
      connection,
      f.launchd.host(),
      io,
    ),
    1,
  );
  assert.match(JSON.parse(out.stderr).error, /switch back first/);
  // A daemon install only re-verifies the recorded daemon; it starts nothing and writes nothing in /Library.
  const rerun = await f.installDaemon();
  assert.equal(JSON.parse(rerun.stdout).started, false);
  assert.deepEqual(readFileSync(f.recordPath), bytes);

  // Held again on a repeat, then complete once the process has exited.
  assert.equal((await f.uninstall()).code, 1);
  f.launchd.alive.delete(5000);
  const done = await f.uninstall();
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).complete, true);
  assert.equal(existsSync(f.recordPath), false);
  assert.equal((await f.install()).code, 0, "the LaunchAgent can start now");
});

test("daemon mode uninstall treats a reused pid as the process gone", async (t) => {
  const f = await runningDaemon(t);
  // Pid 5000 lives on, but it is another process now: another start time.
  f.launchd.pidStarts.set(5000, "start-9");
  const done = await f.uninstall();
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).complete, true);
  assert.equal(existsSync(f.recordPath), false);
});

test("daemon mode uninstall holds while the port is still in use", async (t) => {
  const f = await runningDaemon(t);
  f.launchd.alive.delete(5000);
  const listener = createServer().listen(f.options.port, "127.0.0.1");
  await new Promise((done) => listener.once("listening", done));
  try {
    const held = await f.uninstall();
    assert.equal(held.code, 1);
    assert.match(JSON.parse(held.stderr).error, /its port is still in use/);
    assert.equal(existsSync(f.recordPath), true);
  } finally {
    await new Promise((done) => listener.close(done));
  }
  assert.equal(JSON.parse((await f.uninstall()).stdout).complete, true);
});

test("daemon mode uninstall holds a process that was never recorded or could not be identified", async (t) => {
  // The operator booted it out by hand before Ensemble ever saw it loaded: a log file shows it ran.
  let f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  writeFileSync(f.record().configuration.stdoutPath, "started\n");
  let held = await f.uninstall();
  assert.equal(held.code, 1);
  assert.match(
    JSON.parse(held.stderr).error,
    /may have run without being recorded/,
  );
  assert.equal(existsSync(f.recordPath), true);

  // Its port is busy and no process was recorded.
  f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  const listener = createServer().listen(f.options.port, "127.0.0.1");
  await new Promise((done) => listener.once("listening", done));
  try {
    held = await f.uninstall();
    assert.equal(held.code, 1);
    assert.match(JSON.parse(held.stderr).error, /its port is still in use/);
  } finally {
    await new Promise((done) => listener.close(done));
  }

  // The process was loaded but its identity could not be read: held, with the process gone.
  f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  f.launchd.identityUnavailable = true;
  assert.equal((await f.uninstall()).code, 0);
  assert.equal(f.record().observed.unidentified, true);
  runSudoUninstallSteps(f);
  f.launchd.alive.delete(5000);
  held = await f.uninstall();
  assert.equal(held.code, 1);
  assert.match(JSON.parse(held.stderr).error, /could not be identified/);
  assert.equal(existsSync(f.recordPath), true);

  // A job seen with no process yet is not "never started": it may start in the sudo window.
  f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  f.launchd.systemJobs.set(f.options.label, { path: f.installed, pid: 0 });
  copyFileSync(f.staged, f.installed);
  chmodSync(f.installed, 0o644);
  assert.equal((await f.uninstall()).code, 0);
  assert.deepEqual(f.record().observed, {
    processes: [],
    unidentified: false,
    identified: false,
  });
  // Launchd starts it before the operator's bootout; it has not bound the port, but it logged.
  writeFileSync(f.record().configuration.stderrPath, "starting\n");
  runSudoUninstallSteps(f);
  held = await f.uninstall();
  assert.equal(held.code, 1);
  assert.match(
    JSON.parse(held.stderr).error,
    /may have run without being recorded/,
  );
  assert.equal(existsSync(f.recordPath), true);

  // The same sequence with no sign of a run completes.
  f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  f.launchd.systemJobs.set(f.options.label, { path: f.installed, pid: 0 });
  copyFileSync(f.staged, f.installed);
  chmodSync(f.installed, 0o644);
  assert.equal((await f.uninstall()).code, 0);
  runSudoUninstallSteps(f);
  assert.equal(JSON.parse((await f.uninstall()).stdout).complete, true);
});

test("daemon mode verify and uninstall runs interleave without losing the recorded process", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  const recorded = () => f.record().observed?.processes[0]?.processId;
  assert.equal((await f.installDaemon()).code, 0);
  assert.equal(recorded(), "5000");
  assert.equal((await f.uninstall()).code, 0);
  assert.equal(recorded(), "5000");
  assert.equal(
    (await f.installDaemon()).code,
    0,
    "verify while the steps are pending",
  );
  assert.equal(recorded(), "5000");
  // After bootout the process is still running; verify and uninstall both keep the record.
  runSudoUninstallSteps(f);
  assert.equal((await f.uninstall()).code, 1);
  assert.equal(recorded(), "5000");
  assert.equal((await f.uninstall()).code, 1);
  f.launchd.alive.delete(5000);
  assert.equal(JSON.parse((await f.uninstall()).stdout).complete, true);
  assert.equal(existsSync(f.recordPath), false);
});

test("daemon mode only an agent record never carries an observed process", async (t) => {
  const f = await setup(t);
  assert.equal((await f.install()).code, 0);
  writeFileSync(
    f.recordPath,
    JSON.stringify({
      ...f.record(),
      observed: { processes: [], unidentified: false, identified: false },
    }),
  );
  const refused = await f.uninstall();
  assert.equal(refused.code, 1);
  assert.match(
    JSON.parse(refused.stderr).error,
    /install record .* is invalid/,
  );
});

test("daemon mode exit confirmation treats a reused pid or a new boot as gone, and a live process as running", {
  skip: process.platform !== "darwin",
}, async () => {
  const host = defaultServiceHost();
  const identity = (await host.captureIdentity(process.pid)) as {
    processId: string;
    processStartedAt: string;
    bootId: string;
  };
  assert.ok(identity, "this process has an identity");
  assert.equal(await host.exited(identity), false);
  assert.equal(
    await host.exited({
      ...identity,
      processStartedAt: "Thu Jan  1 00:00:00 1970",
    }),
    true,
  );
  assert.equal(
    await host.exited({ ...identity, bootId: "another-boot" }),
    true,
  );
  const child = spawnSync("/bin/sleep", ["0"]);
  assert.equal(child.status, 0);
  assert.equal(await host.exited({ ...identity, processId: "99999999" }), true);
});

test("daemon mode record update failure leaves the record intact, fails with a fixed message and never reports complete", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  const launchd = join(f.stateDir, "launchd");
  const bytes = readFileSync(f.recordPath);
  // A directory sits where the record's temporary file goes, so the write fails the same
  // way for every user, root included, and the record is never replaced.
  const blocker = `${f.recordPath}.${process.pid}.tmp`;
  mkdirSync(blocker);
  const before = readdirSync(launchd).sort();
  f.launchd.calls = [];

  const verify = await f.installDaemon();
  assert.equal(verify.code, 1);
  assert.match(
    JSON.parse(verify.stderr).error,
    /install record could not be updated/,
  );
  assert.doesNotMatch(verify.stderr, /EISDIR|EACCES|EPERM|permission denied/i);
  assert.equal(verify.stderr.includes(f.stateDir), false);
  assert.deepEqual(f.launchd.fetched, [], "it did not go on to wait for /app");

  const uninstall = await f.uninstall();
  assert.equal(uninstall.code, 1);
  assert.match(
    JSON.parse(uninstall.stderr).error,
    /install record could not be updated/,
  );
  assert.equal(uninstall.stdout, "", "no steps and no complete result");
  assert.deepEqual(f.launchd.mutations(), []);
  assert.deepEqual(readFileSync(f.recordPath), bytes);
  assert.deepEqual(
    readdirSync(launchd).sort(),
    before,
    "nothing else is left behind",
  );

  // Writable again: the same commands now record the process and carry on.
  rmSync(blocker, { recursive: true });
  assert.equal((await f.installDaemon()).code, 0);
  assert.equal(f.record().observed.processes[0].processId, "5000");
});

test("daemon mode refuses the service and init-auth as root before starting or creating anything", async (t) => {
  const f = await setup(t);
  const root = new FakeLaunchd(f.snapshots, f.options.daemonsDir);
  root.overrides = { isRoot: () => true };
  const { out, io } = capture();
  // A terminal that has already ended, so a missing guard fails instead of waiting for a password.
  const tty = Object.assign(new PassThrough(), {
    isTTY: true,
  }) as unknown as NodeJS.ReadStream;
  tty.end();
  const deps = {
    env: { HOME: f.home },
    ...io,
    stdin: tty,
    stdout: { ...io.stdout, isTTY: true },
  } as unknown as CliDeps;
  const unused = (): OperatorConnection => {
    throw new Error("unused");
  };
  const authDir = join(f.home, "fresh-state", "auth");
  // No data directory: were a guard missing, the service would refuse its arguments and exit
  // at once rather than start.
  for (const argv of [
    ["serve"],
    ["operator"],
    ["init-auth", "--state-dir", join(f.home, "fresh-state")],
  ])
    assert.equal(
      await serviceCommand(argv, deps, unused, () => root.host()),
      1,
      argv.join(" "),
    );
  assert.equal(out.stderr.split(`${ROOT_MESSAGE}\n`).length - 1, 3);
  assert.equal(existsSync(authDir), false);
  assert.deepEqual(root.calls, []);
});

test("daemon mode verify never reports started for a loaded job without a process or a port another process holds", async (t) => {
  const cases: [string, (f: Fixture) => unknown, RegExp][] = [
    [
      "loaded with no pid",
      (f) => {
        f.launchd.systemJobs.set(f.options.label, {
          path: f.installed,
          pid: 0,
        });
      },
      /loaded but has no running process/,
    ],
    [
      "identity unreadable",
      (f) => {
        runSudoSteps(f);
        f.launchd.identityUnavailable = true;
      },
      /process could not be identified/,
    ],
    [
      "another process answers on the port",
      (f) => {
        runSudoSteps(f);
        f.launchd.listeners = [9999];
      },
      /another process answers on the port/,
    ],
    [
      "listeners shared with another process",
      (f) => {
        runSudoSteps(f);
        f.launchd.listeners = [5000, 9999];
      },
      /another process answers on the port/,
    ],
    [
      "the listener cannot be established",
      (f) => {
        runSudoSteps(f);
        f.launchd.listeners = null;
      },
      /could not be established/,
    ],
    [
      "the job's process does not serve the port",
      (f) => {
        runSudoSteps(f);
        f.launchd.listeners = [];
      },
      /not serving the port/,
    ],
  ];
  for (const [name, arrange, error] of cases) {
    const f = await setup(t);
    assert.equal((await f.installDaemon()).code, 0, name);
    copyFileSync(f.staged, f.installed);
    chmodSync(f.installed, 0o644);
    arrange(f);
    const result = await f.installDaemon();
    assert.equal(result.code, 1, name);
    assert.equal(result.stdout, "", `${name}: no started result`);
    const message = JSON.parse(result.stderr).error;
    assert.match(message, error, name);
    assert.match(message, /could not be confirmed running/, name);
    assert.match(message, /lsof -nP -iTCP:\d+ -sTCP:LISTEN/, name);
    assert.equal(existsSync(f.recordPath), true, name);
    assert.deepEqual(f.launchd.mutations(), [], name);
  }
  // A foreign listener never gets /app asked of it: only the job's own pid is probed.
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  f.launchd.listeners = [9999];
  assert.equal((await f.installDaemon()).code, 1);
  assert.deepEqual(f.launchd.fetched, []);
});

test("daemon mode a pid that appears after the job was seen without one is recorded and never lost", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  // First seen loaded with no process yet (it starts in the sudo window).
  f.launchd.systemJobs.set(f.options.label, { path: f.installed, pid: 0 });
  copyFileSync(f.staged, f.installed);
  chmodSync(f.installed, 0o644);
  assert.equal((await f.uninstall()).code, 0);
  assert.equal(f.record().observed.identified, false);
  // It started: the next look records its identity on top of the earlier observation.
  runSudoSteps(f);
  assert.equal((await f.installDaemon()).code, 0);
  assert.equal(f.record().observed.identified, true);
  assert.equal(f.record().observed.processes[0].processId, "5000");
  // Booted out while that process lives on: held, whatever else the logs and port say.
  runSudoUninstallSteps(f);
  const held = await f.uninstall();
  assert.equal(held.code, 1);
  assert.match(
    JSON.parse(held.stderr).error,
    /recorded process may still be running/,
  );
  assert.equal(existsSync(f.recordPath), true);
  f.launchd.alive.delete(5000);
  assert.equal(JSON.parse((await f.uninstall()).stdout).complete, true);
});

test("daemon mode verify holds when the job's process changes while it waits for /app", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  // The job exits and launchd starts another process while the first /app answer is read.
  f.launchd.overrides = {
    fetch: async () => {
      f.launchd.systemJobs.set(f.options.label, {
        path: f.installed,
        pid: 5001,
      });
      return new Response(null, { status: 200 });
    },
  };
  const result = await f.installDaemon();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(
    JSON.parse(result.stderr).error,
    /its process changed while verifying/,
  );
});

test("daemon mode verify fails when the job's own process listens but never serves /app", async (t) => {
  const f = await setup(t);
  assert.equal((await f.installDaemon()).code, 0);
  runSudoSteps(f);
  f.launchd.health = 503;
  const result = await f.installDaemon();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "", "never reported started");
  assert.match(
    JSON.parse(result.stderr).error,
    /did not serve \/app within 120 s/,
  );
  assert.equal(existsSync(f.recordPath), true);
  assert.ok(f.launchd.fetched.length > 0, "its own process was asked");
});

test("the default host treats an effective uid of 0 as root even when the real uid is not", () => {
  const original = process.geteuid;
  process.geteuid = () => 0;
  try {
    assert.equal(defaultServiceHost().isRoot(), true);
  } finally {
    process.geteuid = original as () => number;
  }
});

/** Splits a command the way a POSIX shell would for the plain and single-quoted words shellWord prints. */
function shellSplit(command: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|([^\s']+)/g;
  for (const match of command.matchAll(pattern))
    words.push(
      match[1] !== undefined
        ? match[1].replaceAll("'\\''", "'")
        : (match[2] as string),
    );
  return words;
}

test("daemon mode verify command carries every install option that matters and drops the rest on purpose", async (t) => {
  // A new `service install` option must be classified before this passes.
  assert.deepEqual(
    Object.keys(VERIFY_OPTIONS).sort(),
    Object.keys(LIFECYCLE_OPTIONS).sort(),
  );
  const f = await setup(t);
  const options: ServiceOptions = {
    ...f.options,
    stateDir: join(f.home, "state with 'quote' and space"),
    logDir: join(f.home, "logs & more"),
    agentsDir: join(f.home, "agents $dir"),
    port: 18_787,
    diagnostic: { retentionDays: 7 },
  };
  const first: FirstRun = {
    connection: "work-box",
    open: false,
    tokenFile: undefined,
    tarball: join(f.home, "ensemble.tar.gz"),
    mode: "daemon",
  };
  const command = daemonVerifyCommand(options, first, "0.1.0");
  const [cli, service, install, ...args] = shellSplit(command);
  assert.equal(
    cli,
    join(options.stateDir, "versions", "0.1.0", "bin", "ensemble"),
  );
  assert.deepEqual([service, install], ["service", "install"]);
  const flags = args.filter((word) => word.startsWith("--"));
  for (const [name, kind] of Object.entries(VERIFY_OPTIONS)) {
    if (kind === "carried") assert.ok(flags.includes(`--${name}`), name);
    else assert.equal(flags.includes(`--${name}`), false, name);
  }
  assert.equal(command.includes("ensemble.tar.gz"), false, "no TARBALL");
  // Round trip: the printed command parses back to the effective options it was built from.
  const parsed = lifecycleOptions(args, { HOME: f.home }, options.daemonsDir);
  assert.ok(parsed);
  assert.deepEqual(
    {
      stateDir: parsed.options.stateDir,
      logDir: parsed.options.logDir,
      agentsDir: parsed.options.agentsDir,
      label: parsed.options.label,
      port: parsed.options.port,
      connection: parsed.connection,
      mode: parsed.mode,
      tokenFile: parsed.tokenFile,
      positionals: parsed.positionals,
    },
    {
      stateDir: options.stateDir,
      logDir: options.logDir,
      agentsDir: options.agentsDir,
      label: options.label,
      port: options.port,
      connection: "work-box",
      mode: "daemon",
      tokenFile: undefined,
      positionals: [],
    },
  );
  // The rejected option really is rejected for daemon mode.
  const fake = new FakeLaunchd(f.snapshots, f.options.daemonsDir);
  const { io } = capture();
  const deps = { env: { HOME: f.home }, ...io } as unknown as CliDeps;
  const unused = (): OperatorConnection => {
    throw new Error("unused");
  };
  assert.equal(
    await serviceCommand(
      ["install", "--mode", "daemon", "--token-file", "x"],
      deps,
      unused,
      () => fake.host(),
    ),
    2,
  );

  // A real install with a named connection prints it, and the verify guidance follows it.
  const real = await f.installDaemon({ connection: "work-box" });
  assert.equal(real.code, 0, real.stderr);
  assert.ok(real.stderr.includes("--connection work-box --mode daemon"));
  runSudoSteps(f);
  const verified = await f.installDaemon({ connection: "work-box" });
  assert.match(
    verified.stderr,
    /ensemble auth login --connection work-box --url/,
  );
});

/** Every path under `root` with its mode and content hash, as a map. */
function treeMap(root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of tree(root)) {
    const cut = entry.lastIndexOf(" ", entry.lastIndexOf(" ") - 1);
    map.set(entry.slice(0, cut), entry.slice(cut + 1));
  }
  return map;
}

function changes(before: Map<string, string>, after: Map<string, string>) {
  const created = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...after.keys()]
    .filter((path) => before.has(path) && before.get(path) !== after.get(path))
    .sort();
  return { created, removed, changed };
}

test("daemon mode commands write exactly the documented set of files and directories", async (t) => {
  const f = await setup(t);
  const root = dirname(f.home);
  const rel = (path: string) => relative(root, path);
  const launchd = join(f.stateDir, "launchd");
  const record = rel(f.recordPath);
  const staged = rel(f.staged);
  const nothing = { created: [], removed: [], changed: [] };
  let before = treeMap(root);
  const step = () => {
    const after = treeMap(root);
    const result = changes(before, after);
    before = after;
    return result;
  };

  // First run: the log directory (outside STATE, with its missing parents), the data and
  // launchd directories, the install record and the staged plist, and nothing else; the
  // lock, the staging directory and the record's temporary file are gone again.
  assert.equal((await f.installDaemon()).code, 0);
  assert.deepEqual(step(), {
    created: [
      rel(join(f.stateDir, "data")),
      rel(launchd),
      record,
      staged,
      rel(join(f.home, "Library", "Logs")),
      rel(f.options.logDir),
    ].sort(),
    removed: [],
    changed: [],
  });
  assert.equal(
    existsSync(f.options.agentsDir),
    false,
    "no LaunchAgents directory",
  );
  assert.deepEqual(
    readdirSync(f.options.daemonsDir),
    [],
    "nothing under the daemons directory",
  );
  assert.deepEqual(
    readdirSync(f.options.logDir),
    [],
    "launchd creates the log files, not Ensemble",
  );

  // A re-run that finds nothing loaded writes nothing at all.
  assert.equal((await f.installDaemon()).code, 0);
  assert.deepEqual(step(), nothing);

  // The operator's sudo steps are not Ensemble's writes; verify then records the process.
  runSudoSteps(f);
  step();
  assert.equal((await f.installDaemon()).code, 0);
  assert.deepEqual(step(), { created: [], removed: [], changed: [record] });
  assert.equal((await f.installDaemon()).code, 0);
  assert.deepEqual(step(), nothing);

  // Uninstall with the job loaded changes nothing it already recorded; once everything is
  // gone it removes the staged plist and the record and creates nothing.
  assert.equal((await f.uninstall()).code, 0);
  assert.deepEqual(step(), nothing);
  runSudoUninstallSteps(f);
  f.launchd.alive.delete(5000);
  step();
  assert.equal((await f.uninstall()).code, 0);
  assert.deepEqual(step(), {
    created: [],
    removed: [record, staged].sort(),
    changed: [],
  });
});
