import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { installCli, saveLogin } from "../../src/cli/main.js";
import { ConnectionConfig } from "../../src/cli/connections.js";
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
  const { outcome } = await issueInstallCredential(
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
  const { outcome } = await issueInstallCredential(
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
  const { outcome } = await issueInstallCredential(
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
  await cli.doctor("local", never);
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
    const { outcome } = await issueInstallCredential(
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

/** A connection config whose write fails after the login validated the token. */
class FailingWrite extends ConnectionConfig {
  override async write(): Promise<void> {
    throw new Error("disk full");
  }
}

test("a login whose config write fails restores the prior Keychain token and removes a new one", async (t) => {
  const f = await installFixture(t);
  const h = harness(t);
  const first = await f.s.issue("read", "install · first", 90);
  const second = await f.s.issue("read", "install · second", 90);
  const keychain = new MemoryKeychain();
  const deps = {
    env: {},
    fetch: f.rewritten,
    platform: "darwin",
    keychain: () => keychain,
  } as unknown as CliDeps;
  const good = new ConnectionConfig(h.configDir);
  const failing = new FailingWrite(h.configDir);
  const save = (config: ConnectionConfig, token: string, tokenFile?: string) =>
    saveLogin(config, deps, "local", f.origin, token, tokenFile, never);

  // No prior connection: the failed login leaves no Keychain item behind.
  await assert.rejects(save(failing, second.token), /disk full/);
  assert.equal(keychain.items.size, 0);

  // A prior Keychain connection keeps its token and its config entry.
  await save(good, first.token);
  const file = join(h.configDir, "connections.json");
  const config = readFileSync(file);
  await assert.rejects(save(failing, second.token), /disk full/);
  assert.equal(keychain.items.get("local"), first.token);
  assert.deepEqual(readFileSync(file), config);
  assert.equal(
    (await f.s.bearer(first.token, "/api/operator/cli")).status,
    200,
  );

  // A Keychain write that saves the token and then fails also restores the prior one.
  const savesThenFails = {
    get: (account: string) => keychain.get(account),
    delete: (account: string) => keychain.delete(account),
    set: async (account: string, token: string) => {
      await keychain.set(account, token);
      if (token === second.token) throw new Error("read-back mismatch");
    },
  };
  await assert.rejects(
    saveLogin(
      good,
      { ...deps, keychain: () => savesThenFails } as unknown as CliDeps,
      "local",
      f.origin,
      second.token,
      undefined,
      never,
    ),
    /read-back mismatch/,
  );
  assert.equal(keychain.items.get("local"), first.token);
  assert.deepEqual(readFileSync(file), config);

  // A token-file login keeps the prior Keychain item until the config is written.
  await assert.rejects(
    save(failing, second.token, join(h.dir, "install.token")),
    /disk full/,
  );
  assert.equal(keychain.items.get("local"), first.token);
  await save(good, second.token, join(h.dir, "install.token"));
  assert.equal(keychain.items.has("local"), false);
});

test("a Keychain write that blocks is cancelled by the interrupt and nothing is stored", async (t) => {
  const f = await installFixture(t);
  const h = harness(t);
  const stored: string[] = [];
  const blocking = {
    set: (_account: string, _token: string, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => interrupt.abort(), 20);
      }),
    get: async () => {
      throw new Error("none");
    },
    delete: async () => {
      stored.push("delete");
    },
  };
  const deps = {
    env: { ENSEMBLE_CLI_CONFIG_DIR: h.configDir },
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    fetch: f.rewritten,
    platform: "darwin",
    keychain: () => blocking,
    now: Date.now,
  } as unknown as CliDeps;
  const interrupt = new AbortController();
  const { outcome } = await issueInstallCredential(
    {
      fetch: f.rewritten,
      timeout: (ms: number) => AbortSignal.timeout(ms),
    } as unknown as ServiceHost,
    f.origin,
    "fixture-password",
    "install · test-host",
    (token, signal) =>
      installCli(deps).login("local", f.origin, token, undefined, signal),
    interrupt.signal,
  );
  assert.equal(outcome, "failed");
  const named = f
    .credentials()
    .filter((credential) => credential.name === "install · test-host");
  assert.equal(named[0]?.state, "revoked");
  assert.equal(existsSync(join(h.configDir, "connections.json")), false);
});

/** The install's cleanup after a failed store, with the revoke or logout answered by `intercept`. */
async function failedStore(
  t: Parameters<typeof startCliService>[0],
  intercept: (path: string) => Response | Promise<Response> | undefined,
) {
  const f = await installFixture(t);
  const api: typeof fetch = async (input, init) =>
    (await intercept(new URL(String(input)).pathname)) ??
    f.rewritten(input, init);
  const result = await issueInstallCredential(
    {
      fetch: api,
      timeout: (ms: number) => AbortSignal.timeout(ms),
    } as unknown as ServiceHost,
    f.origin,
    "fixture-password",
    "install · test-host",
    async () => {
      throw new Error("keychain unavailable");
    },
  );
  const state = f
    .credentials()
    .find((credential) => credential.name === "install · test-host")?.state;
  return { result, state };
}

test("a revoke that is not confirmed is reported and the credential is not treated as revoked", async (t) => {
  const revoke = (path: string) => path.endsWith("/revoke");
  const cases: [string, (path: string) => Response | undefined][] = [
    [
      "server error",
      (path) =>
        revoke(path) ? new Response("{}", { status: 500 }) : undefined,
    ],
    [
      "forbidden",
      (path) =>
        revoke(path) ? new Response("{}", { status: 403 }) : undefined,
    ],
  ];
  for (const [name, intercept] of cases) {
    const { result, state } = await failedStore(t, intercept);
    assert.equal(result.outcome, "failed", name);
    assert.equal(result.credentialActive, true, name);
    assert.equal(state, "active", name);
  }
  // A network error on both attempts is reported the same way.
  const network = await failedStore(t, (path) => {
    if (revoke(path)) throw new TypeError("fetch failed");
  });
  assert.equal(network.result.credentialActive, true);
  assert.equal(network.state, "active");
  // One failed attempt is retried and then confirmed.
  let attempts = 0;
  const retried = await failedStore(t, (path) => {
    if (!revoke(path)) return undefined;
    attempts += 1;
    return attempts === 1 ? new Response("{}", { status: 503 }) : undefined;
  });
  assert.equal(retried.result.credentialActive, false);
  assert.equal(retried.state, "revoked");
  assert.equal(attempts, 2);
});

test("a logout that is not confirmed is reported", async (t) => {
  const { result, state } = await failedStore(t, (path) =>
    path.endsWith("/logout") ? new Response("{}", { status: 500 }) : undefined,
  );
  assert.equal(state, "revoked");
  assert.equal(result.credentialActive, false);
  assert.equal(result.sessionOpen, true);
});

test("a Keychain cleanup that blocks is bounded: the new login stays, the restore ignores the interrupt", async (t) => {
  const f = await installFixture(t);
  const h = harness(t);
  const first = await f.s.issue("read", "install · first", 90);
  const second = await f.s.issue("read", "install · second", 90);
  const memory = new MemoryKeychain();
  const seen: { op: string; signal?: AbortSignal | undefined }[] = [];
  const interrupt = new AbortController();
  // delete blocks until its signal fires; set records the signal it was given.
  const keychain = {
    get: (account: string) => memory.get(account),
    set: async (account: string, token: string, signal?: AbortSignal) => {
      seen.push({ op: "set", signal });
      await memory.set(account, token);
    },
    delete: (_account: string, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        seen.push({ op: "delete", signal });
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        // The interrupt arrives while the delete is blocked.
        setTimeout(() => interrupt.abort(), 10);
      }),
  };
  const deps = {
    env: { ENSEMBLE_CLI_CONFIG_DIR: h.configDir },
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    fetch: f.rewritten,
    platform: "darwin",
    keychain: () => keychain,
    now: Date.now,
  } as unknown as CliDeps;
  // A prior Keychain-backed `local`, then an install login by token file replaces it.
  await installCli(deps).login(
    "local",
    f.origin,
    first.token,
    undefined,
    never,
  );
  const started = Date.now();
  const host = {
    fetch: f.rewritten,
    // Only the 20 s storage bound is shortened.
    timeout: (ms: number) => AbortSignal.timeout(ms),
  } as unknown as ServiceHost;
  const result = await issueInstallCredential(
    host,
    f.origin,
    "fixture-password",
    "install · test-host",
    (token, signal) =>
      installCli(deps).login(
        "local",
        f.origin,
        token,
        join(h.dir, "install.token"),
        signal,
      ),
    interrupt.signal,
  );
  assert.ok(Date.now() - started < 5000, "bounded");
  // The delete is best effort after the config write: the new login is kept and reported.
  assert.equal(result.outcome, "stored");
  assert.equal(result.sessionOpen, false);
  assert.equal(
    seen.find((call) => call.op === "delete")?.signal?.aborted,
    true,
  );
  const saved = JSON.parse(
    readFileSync(join(h.configDir, "connections.json"), "utf8"),
  ).connections.local;
  assert.deepEqual(saved.credential, {
    kind: "token-file",
    path: join(h.dir, "install.token"),
  });
  assert.ok(existsSync(join(h.dir, "install.token")));

  // A failed config write restores the prior token with a bound that outlives the interrupt.
  await installCli(deps).login(
    "prior",
    f.origin,
    first.token,
    undefined,
    never,
  );
  seen.length = 0;
  class Failing extends ConnectionConfig {
    override async write(): Promise<void> {
      throw new Error("disk full");
    }
  }
  interrupt.abort();
  await assert.rejects(
    saveLogin(
      new Failing(h.configDir),
      deps,
      "prior",
      f.origin,
      second.token,
      undefined,
      interrupt.signal,
    ),
    /disk full/,
  );
  const restore = seen.at(-1);
  assert.equal(restore?.op, "set");
  assert.notEqual(restore?.signal, interrupt.signal);
  assert.equal(restore?.signal?.aborted, false);
  assert.equal(await memory.get("prior"), first.token);
});

test("a mint whose creation is not confirmed is reported as possibly active", async (t) => {
  const mint = (path: string) => path === "/api/operator/credentials";
  const cases: [string, (path: string) => Response | undefined][] = [
    [
      "connection lost in flight",
      (path) => {
        if (mint(path)) throw new TypeError("fetch failed");
      },
    ],
    [
      "unusable reply",
      (path) =>
        mint(path) ? new Response("not json", { status: 200 }) : undefined,
    ],
  ];
  for (const [name, intercept] of cases) {
    const { result } = await failedStore(t, intercept);
    assert.equal(result.outcome, "failed", name);
    assert.equal(result.credentialActive, true, name);
  }
  // A refused mint (4xx) created nothing.
  const refused = await failedStore(t, (path) =>
    mint(path) ? new Response("{}", { status: 400 }) : undefined,
  );
  assert.equal(refused.result.credentialActive, false);
});

test("installCli doctor stops reading when its signal aborts", async (t) => {
  const f = await installFixture(t);
  const issued = await f.s.issue("read", "install · test-host", 90);
  const h = harness(t);
  const keychain = new MemoryKeychain();
  const requests: string[] = [];
  const stop = new AbortController();
  const stalled: typeof fetch = (input, init) => {
    if (!String(input).endsWith("/api/operator/readiness"))
      return f.rewritten(input, init);
    requests.push(String(input));
    // Abort while the readiness read is in flight, not on a timer.
    setTimeout(() => stop.abort(), 10);
    return new Promise((_, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason),
      ),
    );
  };
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
  const cli = installCli(deps);
  await cli.login("local", f.origin, issued.token, undefined, never);
  const started = Date.now();
  await cli.doctor("local", stop.signal);
  assert.equal(requests.length, 1, "the readiness read was in flight");
  assert.ok(Date.now() - started < 5000, "doctor returned on the abort");
});
