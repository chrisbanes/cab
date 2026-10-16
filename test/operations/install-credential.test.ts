import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { installCli } from "../../src/cli/main.js";
import {
  issueInstallCredential,
  type ServiceHost,
} from "../../src/cli/service.js";
import type { CliDeps } from "../../src/cli/types.js";
import { MemoryKeychain, harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

const DAY = 24 * 60 * 60 * 1000;
const never = new AbortController().signal;

/** The fixture's auth origin is fixed at 8787; requests for it go to the served port. */
async function installFixture(t: Parameters<typeof startCliService>[0]) {
  const s = await startCliService(t);
  const origin = s.authOrigin;
  const rewritten: typeof fetch = (input, init) =>
    fetch(String(input).replace(origin, s.origin), init);
  const host = {
    fetch: rewritten,
    timeout: (ms: number) => AbortSignal.timeout(ms),
  } as unknown as ServiceHost;
  const credentials = () => s.f.service.operatorCredentials().list();
  return { s, origin, host, rewritten, credentials };
}

test("install issues one 90-day read credential, hands it to the store and logs the session out", async (t) => {
  const f = await installFixture(t);
  let stored = "";
  const outcome = await issueInstallCredential(
    f.host,
    f.origin,
    "fixture-password",
    "install · test-host",
    async (token) => {
      stored = token;
    },
  );
  assert.equal(outcome, "stored");
  const response = await f.s.bearer(stored, "/api/operator/cli");
  const { credential } = (await response.json()) as {
    credential: {
      name: string;
      scope: string;
      createdAt: number;
      expiresAt: number;
    };
  };
  assert.equal(credential.name, "install · test-host");
  assert.equal(credential.scope, "read");
  assert.equal(credential.expiresAt - credential.createdAt, 90 * DAY);
});

test("a wrong password issues nothing and never calls the store", async (t) => {
  const f = await installFixture(t);
  const before = f.credentials().length;
  let calls = 0;
  const outcome = await issueInstallCredential(
    f.host,
    f.origin,
    "not-the-password",
    "install · test-host",
    async () => {
      calls += 1;
    },
  );
  assert.equal(outcome, "wrong-password");
  assert.equal(calls, 0);
  assert.equal(f.credentials().length, before);
});

test("a store that fails revokes the issued credential", async (t) => {
  const f = await installFixture(t);
  const outcome = await issueInstallCredential(
    f.host,
    f.origin,
    "fixture-password",
    "install · test-host",
    async () => {
      throw new Error("keychain unavailable");
    },
  );
  assert.equal(outcome, "failed");
  const named = f
    .credentials()
    .filter((credential) => credential.name === "install · test-host");
  assert.equal(named.length, 1);
  assert.equal(named[0]?.state, "revoked");
});

test("the install session is signed out, so its cookie no longer authenticates", async (t) => {
  const f = await installFixture(t);
  let cookie = "";
  const spy: typeof fetch = async (input, init) => {
    const response = await f.rewritten(input, init);
    cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
    return response;
  };
  await issueInstallCredential(
    { ...f.host, fetch: spy },
    f.origin,
    "fixture-password",
    "install · test-host",
    async () => {},
  );
  const session = await fetch(`${f.s.origin}/api/operator/session`, {
    headers: { cookie },
  });
  assert.equal(
    ((await session.json()) as { authenticated: boolean }).authenticated,
    false,
  );
});

test("installCli stores the login like auth login: token file at 0600, or the keychain", async (t) => {
  const f = await installFixture(t);
  const issued = await f.s.issue("read", "install · test-host", 90);
  const h = harness(t);
  const keychain = new MemoryKeychain();
  const deps = (): CliDeps =>
    ({
      env: { ENSEMBLE_CLI_CONFIG_DIR: h.configDir },
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      fetch: f.rewritten,
      platform: "darwin",
      keychain: () => keychain,
      now: Date.now,
    }) as unknown as CliDeps;
  const connections = () =>
    JSON.parse(readFileSync(join(h.configDir, "connections.json"), "utf8"));

  const tokenFile = join(h.dir, "install.token");
  await installCli(deps()).login(
    "local",
    f.origin,
    issued.token,
    tokenFile,
    never,
  );
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const saved = connections().connections.local;
  assert.equal(saved.url, f.origin);
  assert.deepEqual(saved.credential, { kind: "token-file", path: tokenFile });
  assert.match(saved.installationId, /^[0-9a-f-]{36}$/);
  // An existing token file is never overwritten.
  await assert.rejects(
    installCli(deps()).login("again", f.origin, issued.token, tokenFile, never),
  );
  assert.equal(readFileSync(tokenFile, "utf8").trim(), issued.token);

  await installCli(deps()).login(
    "kept",
    f.origin,
    issued.token,
    undefined,
    never,
  );
  assert.equal(keychain.items.get("kept"), issued.token);
  assert.deepEqual(connections().connections.kept.credential, {
    kind: "keychain",
    account: "kept",
  });

  // A failed validation leaves no token file behind.
  const bad = join(h.dir, "bad.token");
  await assert.rejects(
    installCli({
      ...deps(),
      fetch: async () => new Response("{}", { status: 500 }),
    }).login("bad", f.origin, issued.token, bad, never),
  );
  assert.equal(existsSync(bad), false);
});

test("installCli doctor writes the readiness table to stderr only", async (t) => {
  const f = await installFixture(t);
  const issued = await f.s.issue("read", "install · test-host", 90);
  const h = harness(t);
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
  const keychain = new MemoryKeychain();
  const deps = {
    env: { ENSEMBLE_CLI_CONFIG_DIR: h.configDir },
    stdin: new PassThrough(),
    stdout,
    stderr,
    fetch: f.rewritten,
    platform: "darwin",
    keychain: () => keychain,
    now: Date.now,
  } as unknown as CliDeps;
  const cli = installCli(deps);
  await cli.login("local", f.origin, issued.token, undefined, never);
  await cli.doctor("local");
  assert.equal(out, "");
  assert.match(err, /Check\s+Status\s+Reason/);
});

test("a stalled or interrupted credential store is bounded, revokes the credential and logs the session out", async (t) => {
  for (const cause of ["timeout", "interrupt"] as const) {
    const f = await installFixture(t);
    const h = harness(t);
    let cookie = "";
    const api: typeof fetch = async (input, init) => {
      const response = await f.rewritten(input, init);
      cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
      return response;
    };
    // The CLI's identity request never answers; only its signal ends it.
    const interrupt = new AbortController();
    const stalled: typeof fetch = (input, init) => {
      if (!String(input).endsWith("/api/operator/cli"))
        return f.rewritten(input, init);
      // The interrupt lands while the identity request is in flight.
      if (cause === "interrupt") setTimeout(() => interrupt.abort(), 20);
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      );
    };
    const keychain = new MemoryKeychain();
    const deps = {
      env: { ENSEMBLE_CLI_CONFIG_DIR: h.configDir },
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      fetch: stalled,
      platform: "darwin",
      keychain: () => keychain,
      now: Date.now,
    } as unknown as CliDeps;
    const started = Date.now();
    const outcome = await issueInstallCredential(
      {
        fetch: api,
        // Only the 20 s store bound is shortened; the sign-in requests keep real time.
        timeout: (ms: number) => AbortSignal.timeout(ms === 20_000 ? 200 : ms),
      } as unknown as ServiceHost,
      f.origin,
      "fixture-password",
      "install · test-host",
      (token, signal) =>
        installCli(deps).login("local", f.origin, token, undefined, signal),
      interrupt.signal,
    );
    assert.equal(outcome, "failed", cause);
    assert.ok(Date.now() - started < 5000, `${cause} is bounded`);
    const named = f
      .credentials()
      .filter((credential) => credential.name === "install · test-host");
    assert.equal(named.length, 1, cause);
    assert.equal(named[0]?.state, "revoked", cause);
    assert.equal(keychain.items.size, 0, cause);
    const session = await fetch(`${f.s.origin}/api/operator/session`, {
      headers: { cookie },
    });
    assert.equal(
      ((await session.json()) as { authenticated: boolean }).authenticated,
      false,
      cause,
    );
  }
});
