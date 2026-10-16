import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  type FirstRun,
  type InstallCli,
  installService,
  type OperatorConnection,
  type ServiceHost,
  type ServiceOptions,
  serviceCommand,
  uninstallService,
  upgradeService,
} from "../../src/cli/service.js";
import type { CliDeps } from "../../src/cli/types.js";
import { StandaloneDataDirectory } from "../../src/standalone/data-directory.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import { markedDataDirectory } from "../fixtures/marked-data.js";
import { tmpdir } from "../fixtures/temp.js";

const UID = process.getuid?.() ?? 0;
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** launchd as a label map; `print` renders the fields that ownership reads. */
class FakeLaunchd {
  calls: string[][] = [];
  events: string[] = [];
  jobs = new Map<string, { path: string; pid: number }>();
  alive = new Set<number>();
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
  onApi: (path: string) => void = () => {};
  opened: string[] = [];
  onBootstrap: () => void = () => {};
  overrides: Partial<ServiceHost> = {};

  constructor(readonly snapshots: string) {}

  host(): ServiceHost {
    return {
      uid: UID,
      launchctl: async (args) => {
        this.calls.push(args);
        const [command, target = ""] = args;
        const label = target.split("/").at(-1) ?? "";
        if (command === "print") {
          const job = this.jobs.get(label);
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
        this.identityUnavailable ? null : { pid },
      exited: async (identity) => {
        const exited = !this.alive.has((identity as { pid: number }).pid);
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
    label: "local.ensemble.test",
    port: await freePort(),
  };
  const snapshots = join(stateDir, "snapshots");
  mkdirSync(snapshots, { mode: 0o700 });
  const launchd = new FakeLaunchd(snapshots);
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
  const fake = new FakeLaunchd(f.snapshots);
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
  const fake = new FakeLaunchd(f.snapshots);
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

  async readPassword(prompt: string) {
    this.prompts.push(prompt);
    if (this.password === undefined) throw new Error("cancelled");
    return this.password;
  }
  async login(...args: unknown[]) {
    this.calls.push("login");
    this.logins.push(args);
    if (this.failLogin) throw new Error("keychain unavailable");
  }
  async doctor(connection: string) {
    this.calls.push(`doctor ${connection}`);
  }
}

/** A release tarball whose single top directory holds the release; `note` makes its manifest differ. */
function tarballOf(root: string, version: string, note?: string) {
  const build = mkdtempSync(join(root, "build-"));
  release(build, version);
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
  const file = join(root, `ensemble-${version}${note ?? ""}.tar.gz`);
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

test("an interrupt while signing in leaves the service installed", async (t) => {
  const f = await tarballSetup(t);
  const interrupt = new AbortController();
  f.launchd.onApi = (path) => {
    if (path === "/api/operator/credentials") interrupt.abort();
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
  const result = await f.run({ open: false, tokenFile: "/x/token" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.launchd.opened, []);
  assert.deepEqual(result.cli.logins, [["local", f.origin, TOKEN, "/x/token"]]);
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
  const fake = new FakeLaunchd(f.snapshots);
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
