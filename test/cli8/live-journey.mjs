// CLI8 assembled operator journey through the packed `ensemble` executable, installed
// outside the checkout and driven as a scripted external client.
//   --fixture [--keychain]          scripted runtime on loopback (CI); --keychain logs the
//                                   read/write connection in through the macOS Keychain.
//   --live --max-turns 2 [--retain DIR]
//                                   one bounded Codex journey; a guard refuses every
//                                   other turn before it reaches Codex.
//   --phase remote --data DIR --origin https://HOST --port N
//                                   no turns; fresh credentials for a granted second machine.
// Prints sanitised evidence JSON. Never reads operator data, ~/.env or real credentials.
// An interrupted run skips its final cleanup: revoke, delete the run's own Keychain item
// and remove its root by exact name.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { CodexRuntime } from "../../dist/src/standalone/codex.js";
import {
  LocalOperatorHttp,
  LocalOperatorUi,
} from "../../dist/src/standalone/operator.js";
import { OperatorApi } from "../../dist/src/standalone/operator-api.js";
import { OperatorAuth } from "../../dist/src/standalone/operator-auth.js";
import { OperatorRouteRegistry } from "../../dist/src/standalone/operator-routes.js";
import { runtimeOperatorRoutes } from "../../dist/src/standalone/operator-runtime.js";
import {
  OperatorWebBoundary,
  OperatorWebBundle,
} from "../../dist/src/standalone/operator-web.js";
import { StandaloneService } from "../../dist/src/standalone/service.js";
import { MacProcessTerminationVerifier } from "../../dist/src/standalone/termination.js";
import { OperatorFixtureRuntime } from "../../dist/test/fixtures/operator-web.js";
import { installPacked } from "../../dist/test/fixtures/packed-cli.js";
import { tmpdir } from "../../dist/test/temp.js";

const usage = `Usage:
  node test/cli8/live-journey.mjs --fixture [--keychain]
  node test/cli8/live-journey.mjs --live --max-turns 2 [--retain DIR]
  node test/cli8/live-journey.mjs --phase remote --data DIR --origin https://HOST --port N
`;
const refuse = (why) => {
  process.stderr.write(`Refusing: ${why}\n${usage}`);
  process.exit(2);
};
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const flags = argv.filter((a) => a.startsWith("--"));
const only = (...allowed) =>
  flags.every((f) => allowed.includes(f)) || refuse("unexpected flag");
let mode;
if (argv[0] === "--fixture") {
  only("--fixture", "--keychain");
  mode = "fixture";
} else if (argv.includes("--live")) {
  only("--live", "--max-turns", "--retain");
  if (option("--max-turns") !== "2") refuse("live needs --max-turns 2");
  mode = "live";
} else if (option("--phase") === "remote") {
  only("--phase", "--data", "--origin", "--port");
  mode = "remote";
} else refuse("no explicit mode; live execution needs --live --max-turns 2");
const keychainLogin =
  mode === "live" || (mode === "fixture" && argv.includes("--keychain"));
if (keychainLogin && process.platform !== "darwin")
  refuse("Keychain login needs macOS");

const codexExecutable =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
if (mode === "live" && !existsSync(codexExecutable))
  refuse("the approved Codex launcher is absent");

const run = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const checkout = resolve(import.meta.dirname, "../..");
const real = mode === "live" ? "real" : "synthetic";
const maxTurns = mode === "remote" ? 0 : 2;
const turnDeadlineMs = mode === "live" ? 10 * 60_000 : 30_000;
const quietMs = mode === "live" ? 15_000 : 1_500;
const secrets = [];

const evidence = {
  harness: "test/cli8/live-journey.mjs",
  mode,
  client: "scripted external client driving the installed binary",
  candidate: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim(),
  node: process.version,
  npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  platform: `${process.platform} ${process.arch}`,
  codex:
    mode === "live"
      ? {
          launcher: codexExecutable,
          launcherSha256: sha256(readFileSync(codexExecutable)),
          version: execFileSync(codexExecutable, ["--version"], {
            encoding: "utf8",
          }).trim(),
        }
      : null,
  service: null,
  install: null,
  credentials: {},
  turns: { maxTurns, startTurnCalls: 0, rejectedStartTurns: 0, h1: {} },
  steps: [],
  observations: {},
  leaks: null,
  cleanup: {},
  failure: null,
};
const stage = (name) => process.stderr.write(`[cli8-${mode}] ${name}\n`);

/** Admits turn 1, then exactly one turn after adoption; refuses all others before the runtime. */
const guard = { phase: "initial", prompts: [] };
const guarded = (runtime) => {
  const startTurn = runtime.startTurn.bind(runtime);
  runtime.startTurn = (threadId, workspace, prompt, settings) => {
    const admitted =
      evidence.turns.startTurnCalls < maxTurns &&
      guard.phase === (guard.prompts.length ? "post-adoption" : "initial");
    if (!admitted) {
      evidence.turns.rejectedStartTurns += 1;
      return Promise.reject(new Error("cli8 turn budget: start refused"));
    }
    evidence.turns.startTurnCalls += 1;
    guard.phase = "spent";
    guard.prompts.push(prompt);
    return startTurn(threadId, workspace, prompt, settings);
  };
  return runtime;
};

/** Fixture lead: one command item, then the result its captured profile instructions call for. */
class ScriptedRuntime extends OperatorFixtureRuntime {
  onDiagnosticEvent(listener) {
    this.diagnostic = listener;
  }
  waitForTurn(threadId, turnId) {
    const outcome = super.waitForTurn(threadId, turnId);
    void this.script(threadId, turnId, this.prompts.at(-1) ?? "");
    return outcome;
  }
  async script(threadId, turnId, prompt) {
    await new Promise((r) => setTimeout(r, 20));
    const item = {
      kind: "item",
      threadId,
      turnId,
      itemId: `command-${turnId}`,
      itemType: "commandExecution",
      command: shellCommand,
      cwd: "/fixture",
    };
    this.diagnostic?.({ ...item, phase: "started" });
    this.diagnostic?.({
      ...item,
      phase: "completed",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "1\n",
    });
    const phrase =
      /Captured profile instructions[\s\S]*CLI8_REQUIRED_PHRASE: ([\w-]+)/.exec(
        prompt,
      )?.[1];
    await this.callTool({
      threadId,
      turnId,
      callId: randomUUID(),
      tool: "ensemble_report_result",
      arguments: {
        summary: phrase ? `PASS ${phrase}` : "FAIL missing-required-phrase",
      },
    });
    await this.hold;
    this.hold = undefined;
    this.diagnostic?.({ kind: "turn", threadId, turnId, status: "completed" });
    this.complete(Number(turnId.split("-").at(-1)));
  }
}
const shellCommand = "printenv ENSEMBLE_MANAGED_ASSIGNMENT || echo unset";

/** A disposable root, its service on loopback, and a signed-in browser session. */
async function startService(root, dataDir, password) {
  const bundle = join(root, "bundle");
  mkdirSync(join(bundle, "assets"), { recursive: true });
  writeFileSync(join(bundle, "index.html"), "<html></html>");
  writeFileSync(join(bundle, "assets", "main.js"), "");
  const authFile = join(root, `auth-${randomUUID()}`);
  await OperatorAuth.initialize(authFile, password);
  const authOrigin = "http://127.0.0.1:1";
  let runtime;
  const service = new StandaloneService(
    dataDir,
    (context) => {
      runtime = guarded(
        mode === "live"
          ? new CodexRuntime(codexExecutable, context)
          : new ScriptedRuntime(),
      );
      return runtime;
    },
    undefined,
    { power: { enabled: false }, routingClient: null },
  );
  await service.start();
  const auth = await OperatorAuth.open({ authFile, origin: authOrigin });
  const routes = new OperatorRouteRegistry();
  routes.registerSlot("runtime", runtimeOperatorRoutes(service));
  const http = new LocalOperatorHttp(
    new LocalOperatorUi(service.domain()),
    auth,
    {
      routes,
      credentials: service.operatorCredentials(),
      web: new OperatorWebBoundary(
        await OperatorWebBundle.open(bundle),
        new OperatorApi(service, [root]),
      ),
    },
  );
  const port = await http.start(Number(option("--port") ?? 0) || undefined);
  const origin = `http://127.0.0.1:${port}`;
  let r = await fetch(`${origin}/api/operator/session`);
  let cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  let csrf = (await r.json()).csrfToken;
  const sessionPost = (path, body) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: authOrigin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  r = await sessionPost("/api/operator/login", { password });
  assert.equal(r.status, 200, "session login");
  cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  csrf = (await r.json()).csrfToken;
  const sessionGet = (path) =>
    fetch(`${origin}${path}`, { headers: { cookie } });
  /** Issued through the session route the Settings UI uses; never pre-seeded. */
  const issue = async (scope, name) => {
    const res = await sessionPost("/api/operator/credentials", {
      name,
      scope,
      expiresInDays: 1,
    });
    assert.equal(res.status, 200, `issue ${name}`);
    const issued = await res.json();
    secrets.push(issued.token);
    evidence.credentials[name] = { id: issued.credential.id, scope };
    return issued;
  };
  const revoke = async (name) => {
    const res = await sessionPost(
      `/api/operator/credentials/${evidence.credentials[name].id}/revoke`,
      {},
    );
    evidence.credentials[name].revoked = res.status === 200;
  };
  const bearer = (token, path, init = {}) =>
    fetch(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": init.type ?? "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  return {
    service,
    http,
    auth,
    port,
    origin,
    runtime: () => runtime,
    sessionPost,
    sessionGet,
    issue,
    revoke,
    bearer,
  };
}

/** Digest of persisted rows, excluding credential last-use metadata and diagnostics. */
function digest(dataDir) {
  const db = new DatabaseSync(join(dataDir, "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    const hash = createHash("sha256");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    for (const { name } of tables) {
      if (name === "operator_cli_credentials" || name.includes("diagnostic"))
        continue;
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      hash.update(
        `${name}\n${JSON.stringify(rows.map((r) => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v))).sort())}\n`,
      );
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let root;
let s;
let proxy;
let retain = false;
let keychainAccount;
const outputs = [];
try {
  if (mode === "remote") await remotePhase();
  else await journey();
} catch (error) {
  evidence.failure = String(error?.message ?? error);
} finally {
  try {
    // A failed run still revokes what it issued and removes its Keychain item.
    for (const [name, c] of Object.entries(evidence.credentials))
      if (!c.revoked) await s?.revoke(name).catch(() => {});
    if (keychainAccount) {
      await run("security", [
        "delete-generic-password",
        "-s",
        "ensemble-cli",
        "-a",
        keychainAccount,
      ]).catch(() => {});
      evidence.cleanup.keychainItemAbsent = await run("security", [
        "find-generic-password",
        "-s",
        "ensemble-cli",
        "-a",
        keychainAccount,
      ]).then(
        () => false,
        (e) => e.code === 44,
      );
    }
    await new Promise((r) => (proxy ? proxy.close(r) : r()));
    await s?.http.stop();
    const identity = await s?.runtime()?.processIdentity?.();
    await s?.service.stop();
    s?.auth.close?.();
    if (s) evidence.cleanup.serviceStopped = true;
    if (mode !== "fixture")
      evidence.cleanup.appServerExit = identity
        ? await verifyExit(identity)
        : "unproved: no process identity";
  } catch (error) {
    evidence.failure ??= `cleanup: ${String(error)}`;
  }
  if (root) {
    const dataDir = join(root, "data");
    const db = ["standalone.sqlite", "standalone.sqlite-wal"]
      .map((f) => join(dataDir, f))
      .filter(existsSync)
      .map((f) => readFileSync(f));
    evidence.leaks = {
      cliOutputs: outputs.some((o) => secrets.some((x) => o.includes(x))),
      databaseBytes: db.some((b) => secrets.some((x) => b.includes(x))),
    };
    for (const name of readdirSync(root))
      if (!(retain && name === "data"))
        rmSync(join(root, name), { recursive: true, force: true });
    if (!retain) rmSync(root, { recursive: true, force: true });
    evidence.cleanup.fixtureRemoved = retain
      ? readdirSync(root).join(",") === "data"
      : !existsSync(root);
    evidence.cleanup.retainedData = retain;
  }
}
let out = sanitize(JSON.stringify(evidence, null, 2));
evidence.leaks = {
  ...evidence.leaks,
  evidenceJson: secrets.some((x) => out.includes(x)),
};
out = sanitize(JSON.stringify(evidence, null, 2));
if (evidence.leaks.evidenceJson) out = '{"failure":"evidence withheld: leak"}';
process.stdout.write(`${out}\n`);
process.exitCode =
  evidence.failure || Object.values(evidence.leaks ?? {}).some(Boolean) ? 1 : 0;

function sanitize(text) {
  return (root ? text.replaceAll(root, "<root>") : text).replaceAll(
    process.env.HOME ?? "\0",
    "~",
  );
}

async function verifyExit(identity) {
  const verifier = new MacProcessTerminationVerifier();
  const until = Date.now() + 10_000;
  let result;
  do {
    result = await verifier.verify(identity);
    if (result.kind === "verified") break;
    await sleep(100);
  } while (Date.now() < until);
  return result.kind;
}

/** Runs the installed binary; `expect` is the required exit code. */
function cliRunner(bin, home) {
  const env = {
    PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`,
    // `security` finds the login Keychain through HOME; the CLI's own state stays disposable.
    HOME: keychainLogin ? process.env.HOME : home,
    ENSEMBLE_CLI_CONFIG_DIR: join(home, "config"),
  };
  const cli = async (step, args, expect = 0) => {
    let code = 0;
    let stdout = "";
    let stderr = "";
    try {
      const r = await run(bin, args, { env, timeout: 120_000 });
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (error) {
      code = error.code;
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
    }
    outputs.push(stdout, stderr);
    evidence.steps.push({
      step,
      command: sanitize(args.join(" ")),
      exit: code,
      expected: expect,
      observation: real,
    });
    assert.equal(
      code,
      expect,
      `${step}: exit ${code} ${stderr.slice(0, 300)} ${stdout.slice(0, 600)}`,
    );
    return { stdout, stderr, json: () => JSON.parse(stdout) };
  };
  /** Keychain login through a pseudo-terminal; the token goes to the hidden prompt, never argv. */
  const ptyLogin = (step, name, origin, token) =>
    new Promise((done, fail) => {
      const args = ["auth", "login", "--connection", name, "--url", origin];
      // Node's stdio are sockets, which script(1) rejects; cat bridges them to pipes.
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'cat | /usr/bin/script -q /dev/null "$@" | cat',
          "sh",
          bin,
          ...args,
        ],
        { env, detached: true },
      );
      let text = "";
      let sent = false;
      const timer = setTimeout(
        () => process.kill(-child.pid, "SIGTERM"),
        60_000,
      );
      child.stdout.on("data", (c) => {
        text += c;
        if (!sent && text.includes("Ensemble CLI token:")) {
          sent = true;
          child.stdin.end(`${token}\n`);
        }
      });
      child.stderr.on("data", (c) => {
        text += c;
      });
      child.on("error", fail);
      child.on("close", (code) => {
        clearTimeout(timer);
        outputs.push(text);
        evidence.steps.push({
          step,
          command: sanitize(args.join(" ")),
          exit: code,
          expected: 0,
          observation: real,
          storage: "keychain (pseudo-terminal)",
        });
        code === 0
          ? done()
          : fail(new Error(`${step}: exit ${code} ${text.slice(-300)}`));
      });
    });
  return { cli, ptyLogin, env };
}

async function journey() {
  stage("install");
  if (option("--retain")) {
    root = resolve(option("--retain"));
    if (existsSync(root) && readdirSync(root).length)
      throw new Error("--retain DIR must be empty or absent");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    retain = true;
  } else root = mkdtempSync(join(tmpdir(), "ensemble-cli8-"));
  chmodSync(root, 0o700);
  mkdirSync(join(root, "install"));
  const project = await installPacked(join(root, "install"));
  const bin = join(project, "node_modules", ".bin", "ensemble");
  evidence.install = {
    prefix: sanitize(project),
    outsideCheckout: !resolve(project).startsWith(`${checkout}/`),
    testsShipped: existsSync(
      join(project, "node_modules", "ensemble", "dist", "test"),
    ),
  };
  assert.ok(evidence.install.outsideCheckout, "installed outside the checkout");
  const home = join(root, "client");
  mkdirSync(home, { mode: 0o700 });
  const { cli, ptyLogin } = cliRunner(bin, home);

  stage("service");
  const dataDir = join(root, "data");
  const password = randomBytes(24).toString("hex");
  secrets.push(password);
  s = await startService(root, dataDir, password);
  const d = s.service.domain();
  const exec = (body) =>
    d.execute({ key: randomUUID(), actor: "operator", ...body });
  const profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const phrase = `amber-${randomBytes(3).toString("hex")}`;
  const v1 =
    "CLI8 lead profile. Keep every turn short and do exactly what the task says.";
  exec({
    type: "profile.create",
    profileId,
    name: "CLI8 lead",
    instructions: v1,
    capabilities: "shell",
  });
  exec({
    type: "project.create",
    projectId,
    name: "CLI8 journey",
    leadProfileId: profileId,
  });
  exec({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
    instructions: "CLI8 disposable qualification fixture.",
  });
  exec({
    type: "task.create",
    projectId,
    taskId,
    title: "CLI8 required phrase check",
    outcome: [
      "Disposable qualification probe. Each turn:",
      `1. Run exactly one shell command: ${shellCommand}`,
      "2. Look in your captured profile instructions for a line that starts with CLI8_REQUIRED_PHRASE followed by a colon and one word.",
      "3. Call ensemble_report_result once. If that line is absent, the summary is exactly: FAIL missing-required-phrase",
      "   If it is present, the summary is exactly PASS followed by a space and that word.",
      "4. End the turn. Do not call any other Ensemble tool and do not request completion.",
    ].join("\n"),
    ready: false,
  });
  await s.service.provisionTask(taskId);
  evidence.service = {
    transport: "loopback HTTP",
    installationId: null,
    seeding: "profile, project and task seeded host-locally; not a CLI step",
  };

  stage("credentials");
  const names = {
    ro: `cli8-${randomUUID()}`,
    rw: `cli8-${randomUUID()}`,
    follow: `cli8-${randomUUID()}`,
    lossy: `cli8-${randomUUID()}`,
  };
  const ro = await s.issue("read", "cli8-ro");
  const rw = await s.issue("read-write", "cli8-rw");
  const follow = await s.issue("read", "cli8-follow");
  const tokenFile = (name, token) => {
    const path = join(home, `${name}.token`);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return path;
  };
  const login = (step, name, token) =>
    cli(step, [
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      tokenFile(name, token),
    ]);
  await login("login-token-file", names.ro, ro.token);
  await login("login-token-file", names.follow, follow.token);
  if (keychainLogin) {
    keychainAccount = names.rw;
    await ptyLogin("login-keychain", names.rw, s.origin, rw.token);
  } else await login("login-token-file", names.rw, rw.token);
  let r = await cli("auth-status", [
    "auth",
    "status",
    "--connection",
    names.rw,
    "--output",
    "json",
  ]);
  evidence.service.installationId =
    r.json().data?.service?.installationId ?? null;
  r = await cli("connection-list", ["connection", "list", "--output", "json"]);
  evidence.observations.connections = r.json().data.connections.map((c) => ({
    credential: c.credential,
    sameService: c.installationId === evidence.service.installationId,
  }));
  await cli("connection-use", ["connection", "use", names.ro]);
  const json = async (step, args, connection = names.ro, expect = 0) =>
    (
      await cli(
        step,
        [...args, "--connection", connection, "--output", "json"],
        expect,
      )
    ).json();

  stage("turn 1");
  exec({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const settled = (count) =>
    until(
      () => {
        const work = s.service.list().filter((w) => w.workId.includes(":"));
        return (
          evidence.turns.startTurnCalls >= count &&
          work.length > 0 &&
          work.every((w) =>
            ["completed", "held", "resolved-failed"].includes(w.state),
          ) &&
          work
        );
      },
      turnDeadlineMs,
      `turn ${count} to settle`,
    );
  let work = await settled(1);
  await sleep(quietMs);
  evidence.turns.h1.afterResultNoAdmission =
    evidence.turns.startTurnCalls === 1 &&
    evidence.turns.rejectedStartTurns === 0;
  evidence.observations.turn1 = work.map((w) => ({
    state: w.state,
    reasonPresent: w.reason !== null,
  }));
  assert.ok(
    evidence.turns.h1.afterResultNoAdmission,
    "H1: no turn admitted before the operator acts",
  );

  stage("investigate");
  r = await json("task-list", ["task", "list"]);
  assert.ok(
    r.data.tasks.some((t) => t.id === taskId),
    "task listed",
  );
  r = await json("task-search", ["task", "search", "FAIL", "--type", "result"]);
  const found = r.data.matches.some((m) => m.taskId === taskId);
  evidence.observations.searchFoundFailure = found;
  const task = (await json("task-get", ["task", "get", taskId])).data;
  const leadId = task.leadAssignmentId;
  r = await json("result-list", ["result", "list", taskId]);
  const firstResult = r.data.results[0];
  r = await json("result-get", ["result", "get", taskId, firstResult.resultId]);
  const firstSummary =
    JSON.stringify(r.data).match(/(PASS|FAIL)[^"]*/)?.[0] ?? null;
  evidence.observations.turn1Result = firstSummary;
  r = await json("execution-list", ["execution", "list", "--task", taskId]);
  const firstWork = r.data.executions.at(-1).workId;
  await json("execution-get", ["execution", "get", firstWork]);
  const inputs1 = (
    await json("execution-inputs", [
      "execution",
      "inputs",
      firstWork,
      "--compare-current",
    ])
  ).data;
  const logs1 = (
    await json("logs", ["logs", "--execution", firstWork, "--limit", "200"])
  ).data;
  evidence.observations.execution1 = describe(inputs1, logs1, guard.prompts[0]);
  await json("assignment-get", ["assignment", "get", leadId]);
  r = await json("assignment-instructions", [
    "assignment",
    "instructions",
    leadId,
  ]);
  await json("profile-get", ["profile", "get", profileId]);
  await json("profile-revisions", ["profile", "revisions", profileId]);
  await json("profile-instructions", ["profile", "instructions", profileId]);

  stage("correct");
  const v2 = `${v1}\nCLI8_REQUIRED_PHRASE: ${phrase}`;
  const v2File = join(home, "profile-v2.md");
  writeFileSync(v2File, v2);
  const change = join(home, "profile-change.json");
  r = await json("profile-prepare", [
    "profile",
    "prepare",
    profileId,
    "--instructions-file",
    v2File,
    "--expected-version",
    "1",
    "--out",
    change,
  ]);
  evidence.observations.prepared = {
    mode: (statSync(change).mode & 0o777).toString(8),
    diff: r.data.document?.preview?.diff ?? r.data.diff ?? null,
  };
  let before = digest(dataDir);
  await cli(
    "readonly-denial-cli",
    ["profile", "apply", "--file", change, "--connection", names.ro],
    3,
  );
  const direct = await s.bearer(ro.token, "/api/operator/commands", {
    method: "POST",
    body: JSON.stringify({
      type: "profile.configure",
      key: randomUUID(),
      profileId,
      expectedVersion: 1,
      instructions: v2,
    }),
  });
  const directCode = (await direct.json()).error?.code;
  evidence.steps.push({
    step: "readonly-denial-direct",
    command: "POST /api/operator/commands (read bearer)",
    exit: direct.status,
    expected: 403,
    code: directCode,
    observation: real,
  });
  assert.equal(direct.status, 403);
  assert.equal(directCode, "insufficient-scope");
  evidence.observations.readOnlyDigestUnchanged = digest(dataDir) === before;
  assert.ok(evidence.observations.readOnlyDigestUnchanged);
  const applied = await json(
    "profile-apply",
    ["profile", "apply", "--file", change],
    names.rw,
  );
  const replay = await json(
    "profile-apply-replay",
    ["profile", "apply", "--file", change],
    names.rw,
  );
  evidence.observations.profileApply = {
    version: applied.data.receipt.result.version,
    replayedSameReceipt:
      JSON.stringify(replay.data.receipt) ===
      JSON.stringify(applied.data.receipt),
    replayReused: replay.request?.key === applied.request?.key,
  };
  assert.ok(evidence.observations.profileApply.replayedSameReceipt);

  stage("conflict and lost response");
  const projectVersion = () => Number(d.project(projectId).version);
  const renameDoc = join(home, "rename.json");
  await json("project-prepare", [
    "project",
    "prepare",
    projectId,
    "--name",
    "CLI8 journey (agent)",
    "--out",
    renameDoc,
  ]);
  const browser = await s.sessionPost("/api/operator/commands", {
    type: "project.configure",
    key: randomUUID(),
    projectId,
    expectedVersion: projectVersion(),
    name: "CLI8 journey (browser)",
  });
  assert.equal(browser.status, 200, "browser edit");
  before = digest(dataDir);
  await cli(
    "concurrent-conflict",
    ["project", "apply", "--file", renameDoc, "--connection", names.rw],
    4,
  );
  evidence.observations.conflictDigestUnchanged = digest(dataDir) === before;
  assert.ok(evidence.observations.conflictDigestUnchanged);
  // A loopback proxy that delivers the command, then drops its reply once.
  let drop = true;
  proxy = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        host: "127.0.0.1",
        port: s.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: `127.0.0.1:${s.port}` },
      },
      (answer) => {
        if (
          drop &&
          incoming.method === "POST" &&
          incoming.url === "/api/operator/commands"
        ) {
          drop = false;
          answer.resume();
          answer.on("end", () => outgoing.socket?.destroy());
          return;
        }
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    incoming.pipe(upstream);
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  const lossyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  await cli("login-token-file", [
    "auth",
    "login",
    "--connection",
    names.lossy,
    "--url",
    lossyOrigin,
    "--token-file",
    tokenFile(names.lossy, rw.token),
  ]);
  const lostDoc = join(home, "lost.json");
  await json("project-prepare", [
    "project",
    "prepare",
    projectId,
    "--name",
    "CLI8 journey (renamed)",
    "--out",
    lostDoc,
  ]);
  const versionBefore = projectVersion();
  r = await cli(
    "project-apply-lost-response",
    [
      "project",
      "apply",
      "--file",
      lostDoc,
      "--connection",
      names.lossy,
      "--output",
      "json",
    ],
    6,
  );
  const lost = r.json().error.request;
  r = await json("operation-get", [
    "operation",
    "get",
    lost.key,
    "--scope",
    lost.scope,
    "--type",
    lost.type,
  ]);
  const recordedState = r.data.state;
  const rerun = await json(
    "project-apply-lost-response",
    ["project", "apply", "--file", lostDoc],
    names.lossy,
  );
  evidence.observations.lostResponse = {
    operationState: recordedState,
    rerunSameKey: rerun.request.key === lost.key,
    versionBumps: projectVersion() - versionBefore,
    name: d.project(projectId).name,
  };
  assert.equal(recordedState, "recorded");
  assert.equal(evidence.observations.lostResponse.versionBumps, 1);

  stage("adopt and follow up");
  r = await json("assignment-instructions", [
    "assignment",
    "instructions",
    leadId,
  ]);
  evidence.observations.beforeAdoption = {
    boundIsCurrent: r.data.comparison?.boundIsCurrent ?? null,
  };
  const message = join(home, "follow-up.md");
  writeFileSync(
    message,
    "Your profile instructions were corrected. Repeat the check exactly as the task describes and report the result.",
  );
  const leadVersion = async () =>
    String(
      (await json("assignment-get", ["assignment", "get", leadId])).data
        .version,
    );
  // The follow-up resumes the lead under Stop so no turn is admitted before adoption
  // binds the corrected revision; Resume then admits the one turn.
  await json("task-stop", ["task", "stop", taskId], names.rw);
  await json(
    "task-follow-up",
    [
      "task",
      "follow-up",
      taskId,
      "--expected-version",
      await leadVersion(),
      "--message-file",
      message,
    ],
    names.rw,
  );
  await sleep(quietMs);
  evidence.turns.h1.stoppedNoAdmission =
    evidence.turns.startTurnCalls === 1 &&
    evidence.turns.rejectedStartTurns === 0;
  assert.ok(
    evidence.turns.h1.stoppedNoAdmission,
    "H1: no turn admitted under Stop",
  );
  await json(
    "assignment-apply-current",
    [
      "assignment",
      "apply-current",
      leadId,
      "--expected-version",
      await leadVersion(),
    ],
    names.rw,
  );
  r = await json("assignment-instructions", [
    "assignment",
    "instructions",
    leadId,
  ]);
  evidence.observations.afterAdoption = {
    boundIsCurrent: r.data.comparison?.boundIsCurrent ?? null,
  };
  assert.equal(evidence.observations.afterAdoption.boundIsCurrent, true);
  guard.phase = "post-adoption";
  // Fixture turn 2 stays open until the follow revocation is observed.
  if (mode === "fixture")
    s.runtime().hold = new Promise((r) => {
      s.runtime().release = r;
    });
  await json("task-resume", ["task", "resume", taskId], names.rw);

  stage("revoke during follow");
  // A live turn can settle before it is seen running; then the step is recorded as not run.
  const running = await until(
    () =>
      s.service.list().find((w) => w.state === "running") ??
      (evidence.turns.startTurnCalls >= 2 &&
        s.service
          .list()
          .every((w) =>
            ["completed", "held", "resolved-failed"].includes(w.state),
          ) &&
        "settled"),
    turnDeadlineMs,
    "turn 2 to run",
  );
  if (running === "settled") {
    await s.revoke("cli8-follow");
    evidence.steps.push({
      step: "logs-follow-revoke",
      command: "not run: turn 2 settled before it was observed running",
      exit: null,
      expected: null,
      observation: real,
    });
  } else {
    const follower = spawn(
      bin,
      [
        "logs",
        "--execution",
        running.workId,
        "--follow",
        "--interval",
        "1",
        "--max-duration",
        "60",
        "--output",
        "jsonl",
        "--connection",
        names.follow,
      ],
      { env: cliRunner(bin, home).env },
    );
    let followText = "";
    follower.stdout.on("data", (c) => {
      followText += c;
    });
    follower.stderr.on("data", (c) => {
      followText += c;
    });
    const followExit = new Promise((done) => follower.on("close", done));
    await sleep(2_500);
    await s.revoke("cli8-follow");
    const followCode = await Promise.race([
      followExit,
      sleep(30_000).then(() => "timeout"),
    ]);
    if (followCode === "timeout") follower.kill("SIGTERM");
    outputs.push(followText);
    evidence.steps.push({
      step: "logs-follow-revoke",
      command: "logs --execution <work> --follow --output jsonl",
      exit: followCode,
      expected: 3,
      observation: real,
      endedBeforeRevocation: followText.includes('"execution-finished"'),
    });
    // Live, the turn may finish before the revocation; that run is recorded, not asserted.
    if (mode === "fixture") assert.equal(followCode, 3);
  }
  s.runtime().release?.();

  stage("turn 2");
  work = await settled(2);
  await sleep(quietMs);
  evidence.turns.h1.exactlyTwo =
    evidence.turns.startTurnCalls === 2 &&
    evidence.turns.rejectedStartTurns === 0;
  r = await json("execution-list", ["execution", "list", "--task", taskId]);
  const secondWork = r.data.executions[0].workId;
  const inputs2 = (
    await json("execution-inputs", [
      "execution",
      "inputs",
      secondWork,
      "--compare-current",
    ])
  ).data;
  const logs2 = (
    await json("logs", ["logs", "--execution", secondWork, "--limit", "200"])
  ).data;
  evidence.observations.execution2 = describe(inputs2, logs2, guard.prompts[1]);
  evidence.observations.execution2.phrasePresent = inputs2.segments.some(
    (seg) =>
      seg.name === "profile-instructions" &&
      JSON.stringify(seg).includes(`CLI8_REQUIRED_PHRASE: ${phrase}`),
  );
  r = await json("result-list", ["result", "list", taskId]);
  const latest = r.data.results.find(
    (x) => x.resultId !== firstResult.resultId,
  );
  r = await json("result-get", ["result", "get", taskId, latest.resultId]);
  evidence.observations.turn2Result = (
    JSON.stringify(r.data).match(/(PASS|FAIL)[^"]*/)?.[0] ?? null
  )?.replace(phrase, "<phrase>");
  evidence.observations.turn2ExpectedPass =
    evidence.observations.turn2Result === "PASS <phrase>";
  evidence.observations.turn1ExpectedFail =
    firstSummary === "FAIL missing-required-phrase";

  if (mode === "fixture") {
    stage("third attempt");
    await json(
      "task-follow-up",
      [
        "task",
        "follow-up",
        taskId,
        "--expected-version",
        await leadVersion(),
        "--message-file",
        message,
      ],
      names.rw,
    );
    await until(
      () => evidence.turns.rejectedStartTurns > 0,
      15_000,
      "the guard to refuse a third start",
    );
    evidence.turns.h1.thirdRefusedBeforeRuntime =
      evidence.turns.startTurnCalls === 2 && s.runtime().turns === 2;
  }

  stage("remote authority and logout");
  for (const [method, path, body, type] of [
    [
      "POST",
      "/runtime/control/stop",
      `taskId=${taskId}`,
      "application/x-www-form-urlencoded",
    ],
    ["GET", "/api/operator/credentials"],
    [
      "POST",
      "/api/operator/credentials",
      JSON.stringify({ name: "x", scope: "read-write" }),
    ],
  ]) {
    const res = await s.bearer(rw.token, path, { method, body, type });
    evidence.steps.push({
      step: "remote-authority",
      command: `${method} ${path} (read/write bearer)`,
      exit: res.status,
      expected: 403,
      observation: real,
    });
    assert.equal(res.status, 403, path);
  }
  await cli("auth-logout", ["auth", "logout", "--connection", names.ro]);
  const stillActive = (await s.bearer(ro.token, "/api/operator/cli")).status;
  await s.revoke("cli8-ro");
  const afterRevoke = (await s.bearer(ro.token, "/api/operator/cli")).status;
  evidence.observations.logout = {
    serverCredentialAfterLocalLogout: stillActive,
    afterRevoke,
  };
  assert.equal(stillActive, 200);
  assert.equal(afterRevoke, 401);
  await cli("connection-remove", ["connection", "remove", names.rw]);
  await cli("connection-remove", ["connection", "remove", names.lossy]);
  await s.revoke("cli8-rw");
  evidence.cleanup.credentialsRevoked = Object.values(
    evidence.credentials,
  ).every((c) => c.revoked);
  evidence.cleanup.serverCredentialsRevoked = (
    await (await s.sessionGet("/api/operator/credentials")).json()
  ).data.credentials.every((c) => c.revokedAt !== null);
  stage("stop");
}

/** Bounded facts about one execution's captured inputs and events. */
function describe(inputs, logs, prompt) {
  const items = logs.items;
  const command = items.find((i) => i.name === "commandExecution/completed");
  return {
    segments: inputs.segments.map((seg) => ({
      name: seg.name,
      state: seg.state,
      revision: seg.revision ?? null,
    })),
    submittedDigestMatches:
      prompt !== undefined &&
      inputs.submitted?.sha256 === sha256(prompt) &&
      inputs.submitted?.bytes === Buffer.byteLength(prompt),
    comparison:
      inputs.comparison?.instructions?.map((c) => ({
        name: c.name,
        sameRevision: c.sameRevision,
      })) ?? null,
    kinds: [...new Set(items.map((i) => i.kind))],
    runtimeItems: [
      ...new Set(items.filter((i) => i.kind === "runtime").map((i) => i.name)),
    ],
    toolItems: items.filter((i) => i.kind === "tool").map((i) => i.name),
    service: items.filter((i) => i.kind === "service").map((i) => i.name),
    managedAssignmentOutput: command
      ? String(command.payload?.aggregatedOutput ?? "")
          .trim()
          .slice(0, 40)
      : null,
    gaps: logs.gaps.map((g) => g.code),
  };
}

/** Restarts the retained service with no turns and prints a remote checklist; waits for "done". */
async function remotePhase() {
  const data = resolve(option("--data") ?? "");
  const origin = option("--origin") ?? "";
  if (!/^https:\/\/[^/]+$/.test(origin))
    refuse("--origin must be an https origin");
  if (!Number(option("--port")))
    refuse("--port N is the loopback port the granted route targets");
  if (!existsSync(join(data, "data", "standalone.sqlite")))
    refuse("--data must be a retained journey root");
  root = data;
  retain = true;
  const password = randomBytes(24).toString("hex");
  secrets.push(password);
  s = await startService(root, join(root, "data"), password);
  const tokens = join(root, "remote");
  mkdirSync(tokens, { mode: 0o700 });
  for (const [name, scope] of [
    ["cli8-remote-ro", "read"],
    ["cli8-remote-rw", "read-write"],
  ])
    writeFileSync(
      join(tokens, `${name}.token`),
      `${(await s.issue(scope, name)).token}\n`,
      { mode: 0o600 },
    );
  evidence.service = {
    transport: `${origin} -> ${s.origin}`,
    turnsAdmitted: 0,
  };
  // Run on the peer with ENSEMBLE_CLI_CONFIG_DIR set to a temporary directory.
  const ro = "--connection remote-ro --output json";
  evidence.remoteChecklist = [
    [
      `auth login --connection remote-ro --url ${origin} --token-file RO_TOKEN_FILE`,
      0,
    ],
    [
      `auth login --connection remote-rw --url ${origin} --token-file RW_TOKEN_FILE`,
      0,
    ],
    [`auth status ${ro} (installationId must equal the host's)`, 0],
    [`task search FAIL --type result ${ro}`, 0],
    [`execution list --task TASK ${ro}`, 0],
    [`execution inputs WORK --compare-current ${ro}`, 0],
    [`logs --execution WORK ${ro}`, 0],
    ["profile apply --file CHANGE --connection remote-ro", 3],
    [
      "project prepare PROJECT --name NAME --out CHANGE --connection remote-ro",
      0,
    ],
    ["project apply --file CHANGE --connection remote-rw --output json", 0],
    [
      "operation get KEY --scope project:PROJECT --type project.configure --connection remote-ro",
      0,
    ],
    [
      `auth login --connection plain --url http://PEER-VISIBLE-HOST:${option("--port")} --token-file RO_TOKEN_FILE`,
      2,
    ],
  ].map(([command, exit]) => ({ command, expected: exit }));
  process.stderr.write(
    `${JSON.stringify(evidence.remoteChecklist, null, 2)}\n`,
  );
  process.stderr.write(
    `Token files: ${tokens} (copy to the peer as 0600). Type "done", or close stdin, to revoke and stop.\n`,
  );
  await new Promise((done) => {
    process.stdin.on("data", (c) => String(c).includes("done") && done());
    process.stdin.on("end", done);
  });
  for (const name of Object.keys(evidence.credentials)) await s.revoke(name);
  evidence.cleanup.credentialsRevoked = Object.values(
    evidence.credentials,
  ).every((c) => c.revoked);
}
