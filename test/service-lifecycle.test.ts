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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  installService,
  type OperatorConnection,
  type ServiceHost,
  type ServiceOptions,
  serviceCommand,
  uninstallService,
  upgradeService,
} from "../src/cli/service.js";
import type { CliDeps } from "../src/cli/types.js";
import { StandaloneDataDirectory } from "../src/standalone/data-directory.js";
import { markedDataDirectory } from "./fixtures/marked-data.js";
import { tmpdir } from "./temp.js";

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
      fetch: async (url) => {
        this.fetched.push(String(url));
        return new Response(null, { status: this.health });
      },
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms;
      },
      // Probe timeouts run 1000 times faster; the polling sleep advances the fake clock.
      timeout: (ms) => AbortSignal.timeout(Math.max(1, ms / 1000)),
      ...this.overrides,
    };
  }

  mutations() {
    return this.calls.filter(([command]) => command !== "print");
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

async function setup(t: { after(fn: () => void): void }, data = false) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-service-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const stateDir = join(home, "Library", "Application Support", "Ensemble");
  mkdirSync(join(stateDir, "auth"), { recursive: true, mode: 0o755 });
  chmodSync(join(stateDir, "auth"), 0o700);
  writeFileSync(join(stateDir, "config.yaml"), "legacy: pipeline\n");
  const authFile = join(stateDir, "auth", "operator-auth.json");
  writeFileSync(authFile, "{}\n", { mode: 0o600 });
  const releaseA = release(stateDir, "0.1.0");
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
  const install = async () => {
    const { out, io } = capture();
    const code = await installService(options, releaseA, launchd.host(), io);
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
    /\/launchd\/\.staging-[^/]+\/local\.ensemble\.test\.plist$/,
  );
  assert.deepEqual(readdirSync(join(f.stateDir, "launchd")), [
    "local.ensemble.test.json",
  ]);
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

/** Installs 0.1.0 over marked data and adds release 0.2.0. */
async function installed(t: { after(fn: () => void): void }) {
  const f = await setup(t, true);
  assert.equal((await f.install()).code, 0);
  const releaseB = release(f.stateDir, "0.2.0");
  let checks = [
    { id: "codex-login", status: "pass" },
    { id: "claude-token", status: "not-configured" },
  ];
  let origin: string | Error = `http://127.0.0.1:${f.options.port}`;
  const connection: OperatorConnection = {
    origin: async () => {
      if (origin instanceof Error) throw origin;
      return origin;
    },
    readiness: async () => {
      f.launchd.events.push("readiness");
      return checks;
    },
  };
  const upgrade = async (target = releaseB, signal?: AbortSignal) => {
    const { out, io } = capture();
    const code = await upgradeService(
      // Upgrade keeps the installed port whatever --port defaults to.
      { ...f.options, port: 1 },
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
  assert.ok(signals.length > 1 && signals.every((signal) => signal.aborted));
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
  // One health probe capped at 5 s, then one readiness read allowed over 10 s.
  assert.deepEqual(limits, [5_000, 20_000]);
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
