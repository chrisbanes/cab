import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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

/** A temporary HOME, with a LaunchDaemon install record under the default state directory when asked. */
function daemonHome(
  t: Parameters<typeof harness>[0],
  mode: "daemon" | "agent" | null,
) {
  const home = mkdtempSync(join(tmpdir(), "ensemble-doctor-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
          ...(mode === "daemon" ? { userName: "operator", home } : {}),
        },
      }),
    );
  }
  return home;
}

test("doctor daemon host warns about a keychain gh login on stderr only", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);
  const gh = fakeStatusGh(t);
  const home = daemonHome(t, "daemon");
  const env = {
    ...gh.env("keyring"),
    ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
    HOME: home,
  };
  const result = await h.run(["doctor", "--output", "json"], { env });
  assert.equal(result.code, 0, result.err);
  const api = readinessSchema.parse(
    await (await s.bearer(read.token, "/api/operator/readiness")).json(),
  );
  assert.deepEqual(result.json().data, api.data);
  assert.ok(result.err.includes(WARNING));
  assert.equal(result.out.includes(WARNING), false);
  for (const text of [result.out, result.err])
    assert.equal(text.includes("canary"), false);
  const argv = readFileSync(gh.log, "utf8");
  assert.equal(
    argv.split("\n")[0],
    "auth status --active --hostname github.com --json hosts",
  );
  assert.equal(/auth token|--show-token/.test(argv), false);
});

test("doctor daemon host stays silent without a daemon record or with a file login", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);

  const gh = fakeStatusGh(t);
  const none = await h.run(["doctor", "--output", "json"], {
    env: {
      ...gh.env("keyring"),
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      HOME: daemonHome(t, null),
    },
  });
  assert.equal(none.code, 0, none.err);
  assert.equal(none.err.includes(WARNING), false);
  assert.equal(existsSync(gh.log), false, "gh is never run without a record");

  const agent = await h.run(["doctor", "--output", "json"], {
    env: {
      ...gh.env("keyring"),
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      HOME: daemonHome(t, "agent"),
    },
  });
  assert.equal(agent.code, 0, agent.err);
  assert.equal(agent.err.includes(WARNING), false);
  assert.equal(existsSync(gh.log), false, "a LaunchAgent record never runs gh");

  const file = await h.run(["doctor", "--output", "json"], {
    env: {
      ...gh.env("/Users/operator/.config/gh/hosts.yml"),
      ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
      HOME: daemonHome(t, "daemon"),
    },
  });
  assert.equal(file.code, 0, file.err);
  assert.equal(file.err.includes(WARNING), false);
  assert.equal(existsSync(gh.log), true, "gh ran for the daemon record");
});
