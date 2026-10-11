import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  type CredentialStore,
  KeychainCredentialStore,
} from "../src/cli/connections.js";
import { type CliDeps, main } from "../src/cli/main.js";
import { startCliService } from "./fixtures/operator-cli.js";

const DAY = 24 * 60 * 60 * 1000;
type After = { after(fn: () => unknown): void };

class MemoryKeychain implements CredentialStore {
  items = new Map<string, string>();
  async set(account: string, token: string) {
    this.items.set(account, token);
  }
  async get(account: string) {
    const token = this.items.get(account);
    if (!token)
      throw Object.assign(new Error("missing"), {
        code: "credential-not-found",
      });
    return token;
  }
  async delete(account: string) {
    this.items.delete(account);
  }
}

function harness(t: After, overrides: Partial<CliDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, "config");
  const keychain = new MemoryKeychain();
  const outputs: string[] = [];
  const fetches: string[] = [];
  const run = async (args: string[], extra: Partial<CliDeps> = {}) => {
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    let out = "",
      err = "";
    stdout.on("data", (c) => {
      out += c;
    });
    for (const stream of [stderr, extra.stderr])
      (stream as PassThrough | undefined)?.on("data", (c) => {
        err += c;
      });
    const code = await main(args, {
      env: { ENSEMBLE_CLI_CONFIG_DIR: configDir },
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout,
      stderr: stderr as unknown as NodeJS.WriteStream,
      fetch: (input, init) => {
        fetches.push(String(input));
        return fetch(input, init);
      },
      platform: "darwin",
      keychain: () => keychain,
      now: Date.now,
      ...overrides,
      ...extra,
    });
    outputs.push(out, err);
    return { code, out, err, json: () => JSON.parse(out) };
  };
  const tokenFile = (token: string, name = `${randomUUID()}.token`) => {
    const path = join(dir, name);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return path;
  };
  return { dir, configDir, keychain, run, outputs, fetches, tokenFile };
}

async function fakeServer(
  t: After,
  handler: Parameters<typeof createServer>[1],
): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(
      `${request.method} ${request.url} ${request.headers.authorization ?? ""}`,
    );
    handler?.(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  return { origin: `http://127.0.0.1:${address.port}`, hits };
}

test("login, status and task get through a token file against the live service", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  const read = await s.issue("read", "laptop-ro");
  const file = h.tokenFile(read.token);
  let r = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Logged in to home .* as laptop-ro \(read\)/);
  r = await h.run(["auth", "status"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Credential: +laptop-ro \(read\)/);
  assert.match(r.out, /version 1; cli\.identity, task\.read/);
  r = await h.run(["task", "get", s.taskId]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Inspect me\n/);
  assert.match(r.out, new RegExp(`Task: +${s.taskId}`));
  assert.equal(r.err, "");
  r = await h.run(["task", "get", s.taskId, "--output", "json"]);
  assert.equal(r.code, 0);
  const envelope = r.json();
  assert.equal(envelope.schema, "ensemble.cli/v1");
  assert.equal(envelope.connection, "home");
  assert.deepEqual(envelope.service, {
    installationId: s.f.service.operatorCredentials().installationId(),
    origin: s.authOrigin,
    apiVersion: 1,
  });
  assert.equal(envelope.data.task.id, s.taskId);
  assert.equal(typeof envelope.observedAt, "number");
  r = await h.run(["task", "get", randomUUID(), "--output", "json"]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "not-found");
  assert.match(r.json().error.requestId, /^[0-9a-f-]{36}$/);

  // 2. The same read-only token cannot write directly.
  const direct = await s.bearer(read.token, "/api/operator/source-refresh", {
    method: "POST",
    body: {},
  });
  assert.equal(direct.status, 403);

  // Config holds a reference, never the token, and is private.
  const config = readFileSync(join(h.configDir, "connections.json"), "utf8");
  assert.ok(!config.includes(read.token));
  assert.equal(
    statSync(join(h.configDir, "connections.json")).mode & 0o777,
    0o600,
  );
  assert.equal(statSync(h.configDir).mode & 0o777, 0o700);

  // Logout removes only the local credential.
  r = await h.run(["auth", "logout"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /stays active/);
  assert.equal((await s.bearer(read.token, "/api/operator/cli")).status, 200);
  r = await h.run(["task", "get", s.taskId]);
  assert.equal(r.code, 3);
  for (const text of h.outputs) assert.ok(!text.includes(read.token));
});

test("expired, revoked and malformed credentials fail safely", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  const store = s.f.service.operatorCredentials();
  const expiring = store.issue(
    { name: "soon", scope: "read", expiresInDays: 1 },
    Date.now() - DAY + 1500,
  );
  const login = (name: string, file: string) =>
    h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      file,
    ]);
  assert.equal((await login("soon", h.tokenFile(expiring.token))).code, 0);
  const revoked = await s.issue("read", "revoked");
  assert.equal((await login("gone", h.tokenFile(revoked.token))).code, 0);
  store.revoke(revoked.credential.id);
  let r = await h.run(["task", "get", s.taskId, "--connection", "gone"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /credential-invalid/);
  // Expiry is decided by the service clock.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  r = await h.run([
    "auth",
    "status",
    "--connection",
    "soon",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json().error.code, "credential-invalid");
  assert.equal(r.json().error.category, "authentication");

  const valid = await s.issue("read");
  assert.equal((await login("bad", h.tokenFile("not-a-token"))).code, 2);
  const open = h.tokenFile(valid.token);
  chmodSync(open, 0o644);
  r = await login("open", open);
  assert.equal(r.code, 2);
  assert.match(r.err, /0600/);
  const link = join(h.dir, "link.token");
  symlinkSync(h.tokenFile(valid.token), link);
  assert.equal((await login("link", link)).code, 2);
  const config = JSON.parse(
    readFileSync(join(h.configDir, "connections.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(config.connections).sort(), ["gone", "soon"]);
  for (const text of h.outputs)
    for (const token of [expiring.token, revoked.token, valid.token])
      assert.ok(!text.includes(token));
});

test("Keychain store failures save nothing and never fall back to plaintext", async (t) => {
  const s = await startCliService(t);
  const token = (await s.issue("read")).token;
  const failing = new KeychainCredentialStore(
    "ensemble-cli-test",
    async () => ({
      code: 51,
      stdout: "",
    }),
  );
  const h = harness(t, { keychain: () => failing });
  const tty = Object.assign(new PassThrough(), {
    isTTY: true,
  }) as unknown as NodeJS.WriteStream;
  // Keychain login without a terminal is a usage error.
  let r = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
  ]);
  assert.equal(r.code, 2);
  // An injected terminal supplies the token; the failing Keychain refuses it.
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return stdin;
    },
  }) as unknown as NodeJS.ReadStream;
  setImmediate(() => (stdin as unknown as PassThrough).write(`${token}\r`));
  r = await h.run(
    ["auth", "login", "--connection", "home", "--url", s.origin],
    {
      stdin,
      stderr: tty,
    },
  );
  assert.equal(r.code, 3);
  assert.match(r.err, /credential-store-unavailable/);
  assert.deepEqual(readdirSyncSafe(h.configDir), []);

  // A read failure during status is an authentication-category failure.
  const memory = new MemoryKeychain();
  const ok = harness(t, { keychain: () => memory });
  const tty2 = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return tty2;
    },
  }) as unknown as NodeJS.ReadStream;
  setImmediate(() => (tty2 as unknown as PassThrough).write(`${token}\r`));
  r = await ok.run(
    ["auth", "login", "--connection", "home", "--url", s.origin],
    {
      stdin: tty2,
      stderr: Object.assign(new PassThrough(), {
        isTTY: true,
      }) as unknown as NodeJS.WriteStream,
    },
  );
  assert.equal(r.code, 0, r.err);
  assert.equal(memory.items.get("home"), token);
  r = await ok.run(["auth", "status"], { keychain: () => failing });
  assert.equal(r.code, 3);
  assert.match(r.err, /credential-store-unavailable/);
  // Switching the connection to a token file removes its Keychain item.
  r = await ok.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    ok.tokenFile(token),
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(memory.items.has("home"), false);

  // Without macOS and without --token-file there is no credential store.
  const linux = harness(t, { platform: "linux" });
  r = await linux.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
  ]);
  assert.equal(r.code, 3);
  assert.match(r.err, /credential-store-unavailable/);
  assert.deepEqual(readdirSyncSafe(linux.configDir), []);
  for (const text of [...h.outputs, ...ok.outputs, ...linux.outputs])
    assert.ok(!text.includes(token));
});

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

test("connection selection is explicit when several connections exist", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  for (const name of ["work", "home"]) {
    const token = (await s.issue("read", name)).token;
    assert.equal(
      (
        await h.run([
          "auth",
          "login",
          "--connection",
          name,
          "--url",
          s.origin,
          "--token-file",
          h.tokenFile(token),
        ])
      ).code,
      0,
    );
  }
  let r = await h.run(["task", "get", s.taskId]);
  assert.equal(r.code, 2);
  assert.match(r.err, /connection-ambiguous/);
  assert.match(r.err, /home, work/);
  assert.equal((await h.run(["connection", "use", "work"])).code, 0);
  r = await h.run(["connection", "list"]);
  assert.match(r.out, /\* work/);
  assert.equal((await h.run(["task", "get", s.taskId])).code, 0);
  assert.equal(
    (await h.run(["task", "get", s.taskId, "--connection", "home"])).code,
    0,
  );
  assert.equal((await h.run(["connection", "remove", "work"])).code, 0);
  r = await h.run(["connection", "list", "--output", "json"]);
  assert.deepEqual(
    r.json().data.connections.map((c: { name: string }) => c.name),
    ["home"],
  );
  assert.equal((await h.run(["connection", "use", "nope"])).code, 2);
});

test("managed assignments, URL rules, redirects and versions fail before or without credentials", async (t) => {
  const h = harness(t);
  const before = h.fetches.length;
  for (const args of [
    ["auth", "login", "--connection", "x", "--url", "https://example.test"],
    ["auth", "status"],
    ["task", "get", randomUUID()],
  ]) {
    const r = await h.run(args, {
      env: {
        ENSEMBLE_CLI_CONFIG_DIR: h.configDir,
        ENSEMBLE_MANAGED_ASSIGNMENT: "1",
      },
    });
    assert.equal(r.code, 3);
    assert.match(r.err, /managed-assignment/);
  }
  const token = `ens_${randomUUID()}_${"A".repeat(43)}`;
  const file = h.tokenFile(token);
  for (const url of [
    "http://example.test:1",
    "http://localhost:1",
    "http://127.0.0.1:1/path",
    "ftp://127.0.0.1:1",
    "https://user:pw@example.test",
  ]) {
    const r = await h.run([
      "auth",
      "login",
      "--connection",
      "x",
      "--url",
      url,
      "--token-file",
      file,
    ]);
    assert.equal(r.code, 2, url);
  }
  assert.equal(h.fetches.length, before, "no request before URL validation");

  const other = await fakeServer(t, (_q, response) => response.end("{}"));
  const redirect = await fakeServer(t, (_q, response) =>
    response
      .writeHead(307, { location: `${other.origin}/api/operator/cli` })
      .end(),
  );
  let r = await h.run([
    "auth",
    "login",
    "--connection",
    "x",
    "--url",
    redirect.origin,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 5);
  assert.match(r.err, /redirect-rejected/);
  assert.deepEqual(other.hits, []);

  const installationId = randomUUID();
  const identity = (
    apiVersion: number,
    capabilities: string[],
    id = installationId,
  ) => ({
    apiVersion,
    capabilities,
    service: { installationId: id, origin: "https://ensemble.example" },
    credential: {
      id: randomUUID(),
      name: "fake",
      scope: "read",
      createdAt: 1,
      expiresAt: Date.now() + DAY,
    },
  });
  let served = identity(1, ["cli.identity", "task.read"]);
  const fake = await fakeServer(t, (_q, response) =>
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(served)),
  );
  r = await h.run([
    "auth",
    "login",
    "--connection",
    "fake",
    "--url",
    fake.origin,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 0, r.err);
  served = identity(2, ["cli.identity", "task.read"]);
  r = await h.run([
    "auth",
    "status",
    "--output",
    "json",
    "--connection",
    "fake",
  ]);
  assert.equal(r.code, 7);
  assert.equal(r.json().error.code, "unsupported-service");
  served = identity(1, ["cli.identity"]);
  r = await h.run(["task", "get", randomUUID(), "--connection", "fake"]);
  assert.equal(r.code, 7);
  served = identity(1, ["cli.identity", "task.read"], randomUUID());
  r = await h.run(["task", "get", randomUUID(), "--connection", "fake"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /service-identity-changed/);

  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise((resolve) => closed.close(resolve));
  r = await h.run([
    "auth",
    "login",
    "--connection",
    "y",
    "--url",
    `http://127.0.0.1:${closedPort}`,
    "--token-file",
    file,
    "--output",
    "json",
  ]);
  assert.equal(r.code, 5);
  assert.equal(r.json().error.code, "unavailable");
  assert.equal(r.json().error.retryable, true);
  for (const text of h.outputs) assert.ok(!text.includes(token));
});

test("the CLI imports no service state or SQLite modules", () => {
  const dir = join(import.meta.dirname, "../../src/cli");
  for (const name of readdirSync(dir)) {
    const source = readFileSync(join(dir, name), "utf8");
    assert.doesNotMatch(source, /node:sqlite/);
    for (const match of source.matchAll(/from "(\.\.\/standalone\/[^"]+)"/g))
      assert.equal(match[1], "../standalone/operator-hidden-password.js", name);
  }
});

test("usage errors exit 2 and help exits 0", async (t) => {
  const h = harness(t);
  assert.equal((await h.run(["--help"])).code, 0);
  assert.equal((await h.run(["bogus"])).code, 2);
  assert.equal((await h.run(["task", "get", "not-a-uuid"])).code, 2);
  assert.equal(
    (await h.run(["task", "get", randomUUID(), "--token", "x"])).code,
    2,
  );
  assert.equal(
    (await h.run(["connection", "list", "--output", "yaml"])).code,
    2,
  );
});
