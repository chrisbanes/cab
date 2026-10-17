import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { daemonGhWarning } from "../../src/cli/service.js";
import { readinessSchema } from "../../src/operator/readiness.js";
import { fakeServer, harness } from "../fixtures/cli-harness.js";
import { fakeStatusGh } from "../fixtures/fake-status-gh.js";
import { startCliService } from "../fixtures/operator-cli.js";
import { tmpdir } from "../fixtures/temp.js";

const CANARY = "doctor-canary-token-7742";

async function loggedIn(
  t: Parameters<typeof harness>[0],
  origin: string,
  token: string,
) {
  const h = harness(t);
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    origin,
    "--token-file",
    h.tokenFile(token),
  ]);
  assert.equal(login.code, 0, login.err);
  return h;
}

test("doctor reports the service's readiness checks, equal to the API read and without secrets", async (t) => {
  const s = await startCliService(t, {
    service: { runtimeHarnesses: ["codex", "claude"] },
  });
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenPath = join(root, "claude-token");
  writeFileSync(tokenPath, `${CANARY}\n`);
  chmodSync(tokenPath, 0o644);
  s.f.service.domain().execute({
    type: "claude-token.configure",
    key: randomUUID(),
    actor: "operator",
    credentialRef: `file:${tokenPath}`,
  });
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);

  const json = await h.run(["doctor", "--output", "json"]);
  assert.equal(json.code, 0, json.err);
  const envelope = json.json();
  assert.equal(envelope.schema, "ensemble.cli/v1");
  const api = readinessSchema.parse(
    await (await s.bearer(read.token, "/api/operator/readiness")).json(),
  );
  assert.deepEqual(envelope.data, api.data);
  const claude = envelope.data.checks.find(
    (c: { id: string }) => c.id === "claude-token",
  );
  assert.equal(claude.status, "fail");
  assert.equal(claude.reason, "Token file permits group or other access");

  const human = await h.run(["doctor"]);
  assert.equal(human.code, 0, "a failing check does not fail the command");
  for (const check of api.data.checks)
    assert.ok(human.out.includes(check.label));
  assert.match(
    human.out,
    /Claude token\s+Fail\s+Token file permits group or other access/,
  );
  assert.match(
    human.out,
    /Fix Claude token: Make the token file a private regular file/,
  );
  assert.match(human.out, /GitHub discovery\s+Not configured/);
  assert.ok(api.data.checks.some((c) => c.status === "pass"));
  assert.ok(!human.out.includes("(unavailable)"), "a pass has no reason");

  const everything = [json.out, json.err, human.out, human.err].join("\n");
  for (const secret of [CANARY, tokenPath, root, s.f.directory])
    assert.ok(!everything.includes(secret), secret);
  // With no runtime enabled the first row fails with its Settings fix.
  for (const harness of ["codex", "claude"] as const)
    await s.f.service.configureRuntime({
      key: randomUUID(),
      harness,
      enabled: false,
    });
  const none = await h.run(["doctor"]);
  assert.match(
    none.out,
    /An execution runtime is enabled\s+Fail\s+No execution runtime is enabled/,
  );
  assert.match(
    none.out,
    /Fix An execution runtime is enabled: Enable a runtime in Settings → Runtime/,
  );
  assert.match(none.out, /Codex login\s+Not configured\s+Disabled in Settings/);
});

test("doctor exits 5 when the service is unavailable and takes no arguments", async (t) => {
  const identity = {
    apiVersion: 1,
    capabilities: ["cli.identity", "diagnostics.read"],
    service: {
      installationId: randomUUID(),
      origin: "https://ensemble.example",
    },
    credential: {
      id: randomUUID(),
      name: "fake",
      scope: "read",
      createdAt: 1,
      expiresAt: Date.now() + 86_400_000,
    },
  };
  const fake = await fakeServer(t, (request, response) => {
    if (request.url?.startsWith("/api/operator/cli"))
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(identity));
    else response.writeHead(503).end();
  });
  // Any well-formed token logs in; only the identity request reaches the fake.
  const s = await startCliService(t);
  const h = await loggedIn(t, fake.origin, (await s.issue("read")).token);
  const down = await h.run(["doctor", "--output", "json"]);
  assert.equal(down.code, 5);
  assert.equal(down.json().error.code, "unavailable");
  const extra = await h.run(["doctor", "extra"]);
  assert.equal(extra.code, 2);
});

const WARNING = "gh auth login --insecure-storage";

/**
 * A temporary HOME, with a LaunchDaemon install record under the default state directory
 * when asked. The record names `account` as the daemon's HOME, which is where its gh
 * login is read from; by default that is the same directory.
 */
function daemonHome(
  t: Parameters<typeof harness>[0],
  mode: "daemon" | "agent" | null,
  account?: string,
) {
  const home = mkdtempSync(join(tmpdir(), "ensemble-doctor-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const accountHome = account ?? home;
  if (mode) {
    const launchd = join(
      home,
      "Library",
      "Application Support",
      "Ensemble",
      "launchd",
    );
    mkdirSync(launchd, { recursive: true });
    writeFileSync(
      join(launchd, "local.ensemble.service.json"),
      JSON.stringify({
        schema: "ensemble.service/v1",
        mode,
        label: "local.ensemble.service",
        version: "0.1.0",
        plistSha256: "0".repeat(64),
        configuration: {
          label: "local.ensemble.service",
          nodePath: "/n",
          cliPath: "/c",
          dataDirectory: "/d",
          authFile: "/a",
          origin: "http://127.0.0.1:8787",
          port: 8787,
          stdoutPath: "/o",
          stderrPath: "/e",
          ...(mode === "daemon"
            ? { userName: "operator", home: accountHome }
            : {}),
        },
      }),
    );
  }
  return home;
}

/** A gh login stored as a file under `home`, as `gh auth login --insecure-storage` leaves it. */
function fileLogin(home: string, directory = join(home, ".config", "gh")) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "hosts.yml"), "github.com:\n    user: fake\n");
}

test("doctor daemon host warns about a keychain gh login on stderr only", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);
  const gh = fakeStatusGh(t);
  const home = daemonHome(t, "daemon");
  const env = { ENSEMBLE_CLI_CONFIG_DIR: h.configDir, HOME: home };
  const result = await h.run(["doctor", "--output", "json"], {
    env,
    uid: 501,
    ghExecutable: gh.exe,
  });
  assert.equal(result.code, 0, result.err);
  const api = readinessSchema.parse(
    await (await s.bearer(read.token, "/api/operator/readiness")).json(),
  );
  assert.deepEqual(result.json().data, api.data);
  assert.ok(result.err.includes(WARNING));
  assert.ok(result.err.includes(home), "the warning names the daemon's HOME");
  assert.equal(result.out.includes(WARNING), false);
  assert.equal(existsSync(join(home, ".gh-probe.log")), true);
});

test("doctor daemon host stays silent without a daemon record or with a file login", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);
  const gh = fakeStatusGh(t);
  const run = (home: string) =>
    h.run(["doctor", "--output", "json"], {
      uid: 501,
      ghExecutable: gh.exe,
      env: { ENSEMBLE_CLI_CONFIG_DIR: h.configDir, HOME: home },
    });

  const noRecord = daemonHome(t, null);
  const none = await run(noRecord);
  assert.equal(none.code, 0, none.err);
  assert.equal(none.err.includes(WARNING), false);
  assert.equal(
    existsSync(join(noRecord, ".gh-probe.log")),
    false,
    "gh is never run without a record",
  );

  const agentHome = daemonHome(t, "agent");
  const agent = await run(agentHome);
  assert.equal(agent.code, 0, agent.err);
  assert.equal(agent.err.includes(WARNING), false);
  assert.equal(
    existsSync(join(agentHome, ".gh-probe.log")),
    false,
    "a LaunchAgent record never runs gh",
  );

  const fileHome = daemonHome(t, "daemon");
  fileLogin(fileHome);
  const file = await run(fileHome);
  assert.equal(file.code, 0, file.err);
  assert.equal(file.err.includes(WARNING), false);
  assert.equal(
    existsSync(join(fileHome, ".gh-probe.log")),
    true,
    "gh ran for the daemon record",
  );
});

test("doctor daemon host reads the login the daemon will see, not the shell's", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);
  const gh = fakeStatusGh(t);
  const shell = mkdtempSync(join(tmpdir(), "ensemble-doctor-shell-"));
  t.after(() => rmSync(shell, { recursive: true, force: true }));

  // The shell has a file login through GH_CONFIG_DIR and XDG_CONFIG_HOME; the daemon's HOME
  // has only the keychain, which launchd's environment cannot redirect: warned.
  const account = mkdtempSync(join(tmpdir(), "ensemble-doctor-account-"));
  t.after(() => rmSync(account, { recursive: true, force: true }));
  fileLogin(shell, join(shell, "custom-gh"));
  fileLogin(shell, join(shell, "xdg", "gh"));
  const warned = await h.run(["doctor", "--output", "json"], {
    uid: 501,
    ghExecutable: gh.exe,
    env: {
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      HOME: daemonHome(t, "daemon", account),
      GH_CONFIG_DIR: join(shell, "custom-gh"),
      XDG_CONFIG_HOME: join(shell, "xdg"),
      GH_TOKEN: "canary-shell-token",
    },
  });
  assert.equal(warned.code, 0, warned.err);
  assert.ok(warned.err.includes(WARNING));
  assert.ok(warned.err.includes(account));

  // The reverse: the daemon's HOME has the file login, the shell's overrides point at nothing.
  const filed = mkdtempSync(join(tmpdir(), "ensemble-doctor-account-"));
  t.after(() => rmSync(filed, { recursive: true, force: true }));
  fileLogin(filed);
  const quiet = await h.run(["doctor", "--output", "json"], {
    uid: 501,
    ghExecutable: gh.exe,
    env: {
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      HOME: daemonHome(t, "daemon", filed),
      GH_CONFIG_DIR: join(shell, "empty"),
      XDG_CONFIG_HOME: join(shell, "empty-xdg"),
    },
  });
  assert.equal(quiet.code, 0, quiet.err);
  assert.equal(quiet.err.includes(WARNING), false);
});

test("doctor daemon host never runs gh as root", async (t) => {
  const gh = fakeStatusGh(t);
  const home = daemonHome(t, "daemon");
  const env = { HOME: home };
  assert.equal(await daemonGhWarning(env, 0, gh.exe), null);
  assert.equal(
    existsSync(join(home, ".gh-probe.log")),
    false,
    "gh is not run as root",
  );
  assert.ok((await daemonGhWarning(env, 501, gh.exe))?.includes(WARNING));
});
