import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { type BrowseContext, cursorQuery } from "../../src/cli/browse.js";
import { browseCommands, writeCommands } from "../../src/cli/commands.js";
import { CHANGE_COMMANDS } from "../../src/cli/configure.js";
import {
  CliError,
  KeychainCredentialStore,
  readTokenFile,
} from "../../src/cli/connections.js";
import { type CliDeps, EXIT } from "../../src/cli/main.js";
import { CATEGORY_FIX, DEFAULT_FIX, remedyFor } from "../../src/cli/remedy.js";
import { logsCommand } from "../../src/cli/logs-follow.js";
import {
  fakeServer,
  harness,
  MemoryKeychain,
} from "../fixtures/cli-harness.js";
import { startCliOperator, startCliService } from "../fixtures/operator-cli.js";

const DAY = 24 * 60 * 60 * 1000;
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

test("--version prints the package version", async (t) => {
  const r = await harness(t).run(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, `ensemble ${version}\n`);
});

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

  // Service text cannot drive the terminal in human output.
  const hostileId = randomUUID();
  const created = await s.sessionPost("/api/operator/commands", {
    type: "task.create",
    key: randomUUID(),
    projectId: s.projectId,
    taskId: hostileId,
    title: "Safe\u001b]52;c;cGF3bmVk\u0007 \u001b[31mred",
    outcome: "line one\nline two\u009b",
    ready: false,
  });
  assert.equal(created.status, 200);
  r = await h.run(["task", "get", hostileId]);
  assert.equal(r.code, 0, r.err);
  for (const control of ["\u001b", "\u0007", "\u009b"])
    assert.ok(!r.out.includes(control));
  assert.match(r.out, /line one\nline two/);
  r = await h.run(["task", "get", hostileId, "--output", "json"]);
  assert.ok(r.json().data.task.title.includes("\u001b[31m"));
  assert.ok(!r.out.includes("\u009b"), "JSON output escapes C1 controls");
  assert.match(r.out, /line two\\u009b/);

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
  const fifo = join(h.dir, "pipe.token");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  assert.equal((await login("fifo", fifo)).code, 2);
  const config = JSON.parse(
    readFileSync(join(h.configDir, "connections.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(config.connections).sort(), ["gone", "soon"]);
  for (const text of h.outputs)
    for (const token of [expiring.token, revoked.token, valid.token])
      assert.ok(!text.includes(token));
});

test("auth login defaults to the local connection and says where the token comes from", async (t) => {
  const s = await startCliService(t);
  const other = await startCliService(t);
  const h = harness(t);
  const configFile = join(h.configDir, "connections.json");
  const sentence = (origin: string) =>
    `Create a token in Settings → CLI credentials in the web UI, then run: ensemble auth login --url ${origin}`;
  // Tokens are issued per service.
  const first = { origin: s.origin, token: (await s.issue("read", "a")).token };
  const second = {
    origin: other.origin,
    token: (await other.issue("read", "b")).token,
  };
  const loginFile = (
    service: { origin: string; token: string },
    ...extra: string[]
  ) =>
    h.run([
      "auth",
      "login",
      "--url",
      service.origin,
      "--token-file",
      h.tokenFile(service.token),
      ...extra,
    ]);

  // 1. No --connection: the name is local, and every command finds it.
  let r = await loginFile(first, "--output", "json");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().connection, "local");
  const saved = JSON.parse(readFileSync(configFile, "utf8"));
  assert.deepEqual(Object.keys(saved.connections), ["local"]);
  assert.equal(saved.connections.local.url, s.origin);
  r = await h.run(["task", "get", s.taskId]);
  assert.equal(r.code, 0, r.err);

  // 5. Logging in again to the same origin replaces it; one connection remains.
  r = await loginFile(first);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(configFile, "utf8")).connections),
    ["local"],
  );
  assert.equal((await h.run(["task", "get", s.taskId])).code, 0);

  // 4. A defaulted name never re-points local at another origin: nothing is
  // prompted, fetched, written or stored.
  const before = readFileSync(configFile, "utf8");
  const keychainBefore = [...h.keychain.items];
  const fetchesBefore = h.fetches.length;
  const prompts = new PassThrough();
  let prompted = "";
  prompts.on("data", (c) => {
    prompted += c;
  });
  const ttyIn = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
  }) as unknown as NodeJS.ReadStream;
  const ttyOut = Object.assign(prompts, {
    isTTY: true,
  }) as unknown as NodeJS.WriteStream;
  // The terminal run has no token file, so only the guard keeps the prompt from showing.
  for (const [tokenFile, extra] of [
    [true, {}],
    [false, { stdin: ttyIn, stderr: ttyOut }],
  ] as [boolean, Partial<CliDeps>][]) {
    r = await h.run(
      [
        "auth",
        "login",
        "--url",
        other.origin,
        ...(tokenFile ? ["--token-file", h.tokenFile(second.token)] : []),
      ],
      extra,
    );
    assert.equal(r.code, 2);
    assert.match(r.err, /Connection local already points at /);
    assert.match(r.err, /\(usage\)/);
    assert.equal(fixLines(r.err).length, 1);
    assert.match(fixLines(r.err)[0] ?? "", /--connection NAME/);
  }
  assert.doesNotMatch(prompted, /Ensemble CLI token|Create a token/);
  assert.equal(readFileSync(configFile, "utf8"), before);
  assert.deepEqual([...h.keychain.items], keychainBefore);
  assert.equal(h.fetches.length, fetchesBefore);
  // An explicit --connection still replaces it, and a named one is added.
  r = await loginFile(second, "--connection", "local");
  assert.equal(r.code, 0, r.err);
  assert.equal(
    JSON.parse(readFileSync(configFile, "utf8")).connections.local.url,
    other.origin,
  );
  r = await loginFile(first, "--connection", "work");
  assert.equal(r.code, 0, r.err);

  // 7. A defaulted name never adds a second connection for a service that already has
  // one under another name: nothing is prompted, fetched, written or stored, and the
  // single Fix line names the real connections.
  const g = harness(t);
  const configG = join(g.configDir, "connections.json");
  const loginG = (service: typeof first, ...extra: string[]) =>
    g.run([
      "auth",
      "login",
      "--url",
      service.origin,
      "--token-file",
      g.tokenFile(service.token),
      ...extra,
    ]);
  const names = () =>
    Object.keys(JSON.parse(readFileSync(configG, "utf8")).connections).sort();
  r = await loginG(first, "--connection", "home");
  assert.equal(r.code, 0, r.err);
  const homeOnly = readFileSync(configG, "utf8");
  const fetchesG = g.fetches.length;
  const promptsG = new PassThrough();
  let promptedG = "";
  promptsG.on("data", (c) => {
    promptedG += c;
  });
  for (const [tokenFile, extra] of [
    [true, {}],
    [
      false,
      {
        stdin: Object.assign(new PassThrough(), {
          isTTY: true,
          isRaw: false,
        }) as unknown as NodeJS.ReadStream,
        stderr: Object.assign(promptsG, {
          isTTY: true,
        }) as unknown as NodeJS.WriteStream,
      },
    ],
  ] as [boolean, Partial<CliDeps>][]) {
    r = await g.run(
      [
        "auth",
        "login",
        "--url",
        first.origin,
        ...(tokenFile ? ["--token-file", g.tokenFile(first.token)] : []),
      ],
      extra,
    );
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /Connection home already points at /);
    assert.match(r.err, /\(usage\)/);
    assert.deepEqual(fixLines(r.err), [
      `Fix: Run 'ensemble auth login --url ${first.origin} --connection home' to replace the token, or pass --connection local (or another name) to add a second connection.`,
    ]);
  }
  assert.doesNotMatch(promptedG, /Ensemble CLI token|Create a token/);
  assert.equal(readFileSync(configG, "utf8"), homeOnly);
  assert.equal(g.fetches.length, fetchesG);
  assert.equal(g.keychain.items.size, 0);
  // A name given on purpose is always allowed, and so is a different origin.
  r = await loginG(first, "--connection", "work");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(names(), ["home", "work"]);
  r = await loginG(first);
  assert.equal(r.code, 2);
  assert.match(r.err, /Connections home, work already point at /);
  assert.deepEqual(fixLines(r.err), [
    `Fix: Run 'ensemble auth login --url ${first.origin} --connection home' or 'ensemble auth login --url ${first.origin} --connection work' to replace the token, or pass --connection local (or another name) to add a second connection.`,
  ]);
  assert.deepEqual(names(), ["home", "work"]);
  r = await loginG(second);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(names(), ["home", "local", "work"], "a new origin is local");
  // With local at this origin, a bare login replaces it as before.
  r = await loginG(second);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(names(), ["home", "local", "work"]);
  r = await loginG(first, "--connection", "local");
  assert.equal(r.code, 0, r.err);
  r = await loginG(first);
  assert.equal(r.code, 0, "local is at this origin, so it is replaced");
  assert.deepEqual(names(), ["home", "local", "work"]);

  // 6. ENSEMBLE_CONNECTION names the connection; an empty value is a bad name, as it is
  // for every other command; a bad name is a usage error that changes nothing.
  const e = harness(t);
  r = await e.run(
    [
      "auth",
      "login",
      "--url",
      s.origin,
      "--token-file",
      e.tokenFile(first.token),
      "--output",
      "json",
    ],
    {
      env: {
        ENSEMBLE_CLI_CONFIG_DIR: e.configDir,
        ENSEMBLE_CONNECTION: "env-name",
      },
    },
  );
  assert.equal(r.json().connection, "env-name");
  r = await e.run(
    [
      "auth",
      "login",
      "--url",
      s.origin,
      "--token-file",
      e.tokenFile(first.token),
      "--output",
      "json",
    ],
    { env: { ENSEMBLE_CLI_CONFIG_DIR: e.configDir, ENSEMBLE_CONNECTION: "" } },
  );
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "usage");
  assert.deepEqual(readdirSyncSafe(e.configDir), ["connections.json"]);
  assert.deepEqual(
    Object.keys(
      JSON.parse(readFileSync(join(e.configDir, "connections.json"), "utf8"))
        .connections,
    ),
    ["env-name"],
  );
  const bad = harness(t);
  for (const name of ["bad name", "", ".dot", "x".repeat(65)]) {
    r = await bad.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      bad.tokenFile(first.token),
    ]);
    assert.equal(r.code, 2, name);
    assert.match(r.err, /\(usage\)/);
  }
  assert.deepEqual(readdirSyncSafe(bad.configDir), []);
  assert.deepEqual(bad.fetches, []);

  // 2. A missing --url is a usage error with the acceptance sentence and no side effects.
  const none = harness(t);
  for (const extra of [[], ["--connection", "home"]]) {
    r = await none.run(["auth", "login", ...extra]);
    assert.equal(r.code, 2);
    assert.match(r.err, /\(usage\)/);
    assert.ok(r.err.includes(sentence("http://127.0.0.1:8787")), r.err);
    assert.equal(fixLines(r.err).length, 1);
    r = await none.run(["auth", "login", ...extra, "--output", "json"]);
    assert.equal(r.json().error.code, "usage");
    assert.equal(r.json().error.message, sentence("http://127.0.0.1:8787"));
  }
  assert.deepEqual(none.fetches, []);
  assert.deepEqual(readdirSyncSafe(none.configDir), []);

  // 3. The prompt names the given origin, then asks for the token.
  const memory = new MemoryKeychain();
  const p = harness(t, { keychain: () => memory });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return stdin;
    },
  }) as unknown as NodeJS.ReadStream;
  setImmediate(() =>
    (stdin as unknown as PassThrough).write(`${first.token}\r`),
  );
  r = await p.run(["auth", "login", "--url", s.origin], {
    stdin,
    stderr: Object.assign(new PassThrough(), {
      isTTY: true,
    }) as unknown as NodeJS.WriteStream,
  });
  assert.equal(r.code, 0, r.err);
  assert.ok(
    r.err.startsWith(`${sentence(s.origin)}\nEnsemble CLI token: `),
    r.err,
  );
  assert.equal(memory.items.get("local"), first.token);
  assert.ok(!r.out.includes(first.token) && !r.err.includes(first.token));
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
  const dir = join(import.meta.dirname, "../../../src/cli");
  for (const name of readdirSync(dir)) {
    const source = readFileSync(join(dir, name), "utf8");
    assert.doesNotMatch(source, /node:sqlite/);
    for (const match of source.matchAll(/from "(\.\.\/standalone\/[^"]+)"/g))
      assert.equal(match[1], "../standalone/operator-hidden-password.js", name);
  }
});

test("usage errors exit 2 and help exits 0", async (t) => {
  const h = harness(t);
  const help = await h.run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /--version/);
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

test("streamed logs cannot drive the terminal in human or JSON Lines output", async () => {
  const hostile = "tool\u001b]52;c;cGF3bmVk\u0007\u009b";
  const run = async (output: string | undefined) => {
    let out = "";
    const ctx = {
      positionals: ["logs"],
      values: { execution: "w-1", follow: true, output, "max-duration": "1" },
      deps: {
        stdout: { write: (text: string) => (out += text) },
        now: () => 0,
        sleep: async () => {},
      },
      connect: async () => ({
        get: async () => ({
          observedAt: 0,
          data: {
            workId: "w-1",
            items: [
              {
                sequence: 1,
                createdAt: 0,
                severity: "info",
                kind: "tool",
                name: hostile,
                state: "available",
                payload: { text: hostile },
              },
            ],
            gaps: [],
            resumeAfter: 1,
            more: false,
            finished: true,
          },
        }),
      }),
    } as unknown as BrowseContext;
    await logsCommand.run(ctx);
    return out;
  };
  const human = await run(undefined);
  for (const control of ["\u001b", "\u0007", "\u009b"])
    assert.ok(!human.includes(control));
  assert.match(human, /tool.*52;c;cGF3bmVk/);
  const lines = await run("jsonl");
  assert.ok(!lines.includes("\u009b"));
  const item = JSON.parse(lines.split("\n")[0] as string);
  assert.equal(item.item.name, hostile);
});

const syntheticToken = () => `ens_${randomUUID()}_${"A".repeat(43)}`;
const refused =
  (code: string): typeof fetch =>
  async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
  };
const fixLines = (text: string) =>
  text.split("\n").filter((line) => /^Fix: /.test(line));

test("every CLI error code has a one-line Fix remedy", () => {
  for (const code of Object.keys(EXIT)) {
    const fix = DEFAULT_FIX[code];
    assert.ok(fix && !fix.includes("\n"), `${code} has a one-line default`);
    assert.equal(remedyFor(new CliError(code, "x"), "usage"), fix);
  }
  for (const code of Object.keys(DEFAULT_FIX))
    assert.ok(code in EXIT, `${code} is an error code of the CLI`);
  for (const category of [
    "usage",
    "authentication",
    "conflict",
    "unavailable",
    "uncertain",
    "unsupported",
  ]) {
    const fix = remedyFor(new CliError("service-only-code", "x"), category);
    assert.ok(fix && !fix.includes("\n"), `${category} has a one-line default`);
  }
  assert.equal(
    remedyFor(
      new CliError("conflict", "x", { fix: "site remedy." }),
      "conflict",
    ),
    "site remedy.",
  );
  // Text inside a fix cannot start a second Fix line.
  assert.equal(
    remedyFor(
      new CliError("conflict", "x", { fix: "a\nFix: b\r\nc" }),
      "conflict",
    ),
    "a Fix: b c",
  );
  for (const fix of [
    ...Object.values(DEFAULT_FIX),
    ...Object.values(CATEGORY_FIX),
  ])
    assert.ok(!/chmod (?!600\b)|sudo|\brm -/.test(fix), fix);
});

test("human errors end with exactly one Fix line and JSON errors are unchanged", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  assert.equal(
    (
      await h.run([
        "auth",
        "login",
        "--connection",
        "home",
        "--url",
        s.origin,
        "--token-file",
        h.tokenFile((await s.issue("read")).token),
      ])
    ).code,
    0,
  );
  const tooLarge: typeof fetch = async (input, init) =>
    String(input).includes("/api/operator/tasks/")
      ? Response.json(
          { error: { code: "body-too-large", message: "Too big." } },
          { status: 413 },
        )
      : fetch(input, init);
  const notADirectory = join(h.dir, "not-a-directory");
  writeFileSync(notADirectory, "x");
  const sites: [string, string[], Partial<CliDeps>, number, string][] = [
    ["usage", ["task", "get"], {}, 2, "usage"],
    [
      "unexpected failure",
      ["connection", "list"],
      { env: { ENSEMBLE_CLI_CONFIG_DIR: notADirectory } },
      5,
      "unavailable",
    ],
    [
      "unknown service code",
      ["task", "get", s.taskId],
      { fetch: tooLarge },
      2,
      "body-too-large",
    ],
  ];
  for (const [name, args, extra, exit, code] of sites) {
    const human = await h.run(args, extra);
    assert.equal(human.code, exit, name);
    assert.equal(human.out, "", name);
    assert.equal(fixLines(human.err).length, 1, name);
    const last = human.err.trimEnd().split("\n").at(-1) ?? "";
    assert.match(last, /^Fix: \S.*\S$/, name);
    assert.match(human.err, new RegExp(`\\(${code}[,)]`), name);

    const json = await h.run([...args, "--output", "json"], extra);
    assert.equal(json.code, exit, name);
    assert.equal(json.err, "", name);
    assert.deepEqual(
      Object.keys(json.json().error).sort(),
      ["category", "code", "message", "outcome", "requestId", "retryable"],
      name,
    );
    assert.equal(json.json().error.code, code, name);
    assert.ok(!json.out.includes("Fix:"), name);
  }
});

test("a refused or unresolved connection names the origin and no request id", async (t) => {
  const o = await startCliOperator(t);
  const origin = o.s.origin;
  const login = (code: string, h = harness(t)) =>
    h.run(
      [
        "auth",
        "login",
        "--connection",
        "a",
        "--url",
        "http://127.0.0.1:9",
        "--token-file",
        h.tokenFile(syntheticToken()),
      ],
      { fetch: refused(code) },
    );
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
    // A read: the request never left, so the human line has no request id.
    const r = await login(code);
    assert.equal(r.code, 5, code);
    assert.match(
      r.err,
      /^ensemble: The service is unavailable\. \(unavailable\)\n/,
    );
    assert.ok(!r.err.includes("request"), code);
    assert.deepEqual(fixLines(r.err), [
      "Fix: Check that the service at http://127.0.0.1:9 is running, or check the URL with 'ensemble connection list'.",
    ]);
  }
  // The machine-readable id stays.
  const h = harness(t);
  const json = await h.run(
    [
      "auth",
      "login",
      "--connection",
      "a",
      "--url",
      "http://127.0.0.1:9",
      "--token-file",
      h.tokenFile(syntheticToken()),
      "--output",
      "json",
    ],
    { fetch: refused("ECONNREFUSED") },
  );
  assert.equal(json.code, 5);
  assert.equal(json.json().error.code, "unavailable");
  assert.match(json.json().error.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(json.json().error.outcome, "not-applied");
  assert.equal(json.json().error.retryable, true);

  // A write refused before sending: definitely not applied, with its receipt identity.
  const post: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/operator/commands"))
      return refused("ECONNREFUSED")(input, init);
    return fetch(input, init);
  };
  const human = await o.h.run(
    ["task", "stop", o.s.taskId, "--connection", "rw"],
    { fetch: post },
  );
  assert.equal(human.code, 5);
  assert.ok(!human.err.includes("request"), human.err);
  assert.deepEqual(fixLines(human.err), [
    `Fix: Check that the service at ${origin} is running, or check the URL with 'ensemble connection list'.`,
  ]);
  const stop = await o.cli("rw", ["task", "stop", o.s.taskId], { fetch: post });
  assert.equal(stop.code, 5);
  const error = stop.json().error;
  assert.equal(error.code, "unavailable");
  assert.equal(error.outcome, "not-applied");
  assert.match(error.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(error.request.type, "task.stop");
  const journal = readFileSync(join(o.h.configDir, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((line) => line.key === error.request.key);
  assert.deepEqual(
    journal.map((line) => line.state),
    ["sending", "rejected"],
  );
  assert.equal(o.s.f.service.isTaskStopped(o.s.taskId), false);

  // A reset after the request may have been sent keeps its id.
  const reset = await o.h.run(
    ["task", "get", o.s.taskId, "--connection", "ro"],
    {
      fetch: async (input, init) =>
        String(input).includes("/api/operator/tasks/")
          ? refused("ECONNRESET")(input, init)
          : fetch(input, init),
    },
  );
  assert.equal(reset.code, 5);
  assert.match(reset.err, /\(unavailable, request [0-9a-f-]{36}\)/);
  assert.equal(fixLines(reset.err).length, 1);
});

test("a TLS verification failure has no request id in human output", async (t) => {
  const h = harness(t);
  const args = [
    "auth",
    "login",
    "--connection",
    "a",
    "--url",
    "https://ensemble.example",
    "--token-file",
    h.tokenFile(syntheticToken()),
  ];
  const r = await h.run(args, { fetch: refused("SELF_SIGNED_CERT_IN_CHAIN") });
  assert.equal(r.code, 5);
  assert.match(r.err, /\(tls-verification-failed\)\n/);
  assert.ok(!r.err.includes("request"), r.err);
  assert.equal(fixLines(r.err).length, 1);
  assert.match(r.err, /Fix: .*NODE_EXTRA_CA_CERTS/);
  const json = await h.run([...args, "--output", "json"], {
    fetch: refused("SELF_SIGNED_CERT_IN_CHAIN"),
  });
  assert.equal(json.json().error.code, "tls-verification-failed");
  assert.match(json.json().error.requestId, /^[0-9a-f-]{36}$/);
});

test("a rejected token file names the fix", async (t) => {
  const h = harness(t);
  const login = (file: string) =>
    h.run([
      "auth",
      "login",
      "--connection",
      "a",
      "--url",
      "http://127.0.0.1:9",
      "--token-file",
      file,
    ]);
  const real = h.tokenFile(syntheticToken());
  chmodSync(real, 0o644);
  let r = await login(real);
  assert.equal(r.code, 2);
  assert.match(r.err, /\(invalid-token-file\)/);
  assert.match(r.err, /Token file rejected: its mode is 0644; it must be 0600/);
  assert.deepEqual(fixLines(r.err), [`Fix: chmod 600 ${real}`]);

  const missing = join(h.dir, "missing.token");
  r = await login(missing);
  assert.equal(r.code, 2);
  assert.match(r.err, /Token file rejected: it does not exist\./);
  assert.deepEqual(fixLines(r.err), [
    "Fix: Check the path given to --token-file.",
  ]);

  chmodSync(real, 0o600);
  const link = join(h.dir, "link.token");
  symlinkSync(real, link);
  r = await login(link);
  assert.equal(r.code, 2);
  assert.match(r.err, /Token file rejected: it is a symlink\./);
  assert.deepEqual(fixLines(r.err), [
    "Fix: Pass the file itself, not a symlink to it.",
  ]);

  // Nothing was sent, saved or stored by any refusal.
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(readdirSyncSafe(h.configDir), []);
  assert.equal(h.keychain.items.size, 0);

  // Another owner's file never recommends a chmod.
  const foreign = await readTokenFile(
    real,
    (process.getuid?.() ?? 0) + 1,
  ).catch((error: unknown) => error);
  assert.ok(foreign instanceof CliError);
  assert.equal(foreign.code, "invalid-token-file");
  assert.match(foreign.message, /it is owned by another user/);
  assert.ok(!foreign.extra.fix?.includes("chmod"));
  // A path that a shell would expand is quoted so the fix cannot run anything.
  const odd = join(h.dir, "$(touch pwned)`x`.token");
  writeFileSync(odd, `${syntheticToken()}\n`, { mode: 0o644 });
  r = await login(odd);
  assert.deepEqual(fixLines(r.err), [`Fix: chmod 600 '${odd}'`]);
});

test("defaults name a runnable command for auth and cursor failures", async (t) => {
  const s = await startCliService(t);
  const h = harness(t);
  const fix = (err: string) => fixLines(err)[0] ?? "";

  // No saved connection at all.
  let r = await h.run(["task", "get", s.taskId]);
  assert.equal(r.code, 2);
  assert.match(r.err, /\(connection-not-found\)/);
  assert.match(
    fix(r.err),
    /ensemble auth login --connection NAME --url ORIGIN/,
  );

  // A revoked credential.
  const revoked = await s.issue("read", "revoked");
  const login = (name: string) =>
    h.run([
      "auth",
      "login",
      "--connection",
      name,
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(revoked.token),
    ]);
  assert.equal((await login("gone")).code, 0);
  s.f.service.operatorCredentials().revoke(revoked.credential.id);
  r = await h.run(["task", "get", s.taskId, "--connection", "gone"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /\(credential-invalid[,)]/);
  assert.match(fix(r.err), /ensemble auth login/);

  // A connection that was logged out names the exact login to repeat.
  r = await h.run(["auth", "logout", "--connection", "gone"]);
  assert.equal(r.code, 0, r.err);
  r = await h.run(["task", "get", s.taskId, "--connection", "gone"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /\(credential-not-found\)/);
  assert.equal(
    fix(r.err),
    `Fix: Run 'ensemble auth login --connection gone --url ${s.origin}' to store a credential.`,
  );

  // An unknown connection name.
  r = await h.run(["task", "get", s.taskId, "--connection", "nowhere"]);
  assert.equal(r.code, 2);
  assert.match(fix(r.err), /ensemble connection list/);

  // A cursor the service refuses restarts without --cursor.
  const cursor = Buffer.from(
    JSON.stringify({
      v: 1,
      k: "task list",
      q: cursorQuery({}),
      c: randomUUID(),
    }),
  ).toString("base64url");
  const read = await s.issue("read", "paging");
  assert.equal(
    (
      await h.run([
        "auth",
        "login",
        "--connection",
        "paging",
        "--url",
        s.origin,
        "--token-file",
        h.tokenFile(read.token),
      ])
    ).code,
    0,
  );
  r = await h.run([
    "task",
    "list",
    "--cursor",
    cursor,
    "--connection",
    "paging",
  ]);
  assert.equal(r.code, 4);
  assert.match(r.err, /\(cursor-stale[,)]/);
  assert.match(fix(r.err), /without --cursor/);
  assert.equal(fixLines(r.err).length, 1);
});

const builtinCommands = [
  "auth login",
  "auth status",
  "auth logout",
  "connection list",
  "connection use",
  "connection remove",
  "task get",
];
const knownCommand = (words: string[]) => {
  const [first, second] = words;
  if (first === "service" || first === "snapshot") return true;
  const keys = [
    ...builtinCommands,
    ...browseCommands.keys(),
    ...writeCommands.keys(),
  ];
  return keys.some(
    (key) =>
      key === `${first} ${second}` || (!key.includes(" ") && key === first),
  );
};

test("every command a remedy names exists in the CLI", () => {
  // The per-kind table that remedies draw their prepare and read commands from.
  for (const [kind, commands] of Object.entries(CHANGE_COMMANDS)) {
    for (const command of [commands.prepare, commands.read(randomUUID())]) {
      const words = command.split(" ").slice(1);
      assert.ok(knownCommand(words), `${kind}: ${command}`);
    }
  }
  // Every `ensemble <command>` written in a CLI source file, remedy or not.
  const dir = join(process.cwd(), "src", "cli");
  const unknown: string[] = [];
  let seen = 0;
  assert.equal(knownCommand(["task", "bogus"]), false, "the check can fail");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts")))
    for (const m of readFileSync(join(dir, name), "utf8").matchAll(
      /\bensemble ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g,
    )) {
      seen++;
      if (!knownCommand([m[1] ?? "", m[2] ?? ""]))
        unknown.push(`${name}: ${m[0]}`);
    }
  assert.ok(seen > 50, `scanned ${seen} command mentions`);
  assert.deepEqual(unknown, []);
});

test("service and snapshot usage errors end with one Fix line", async (t) => {
  const h = harness(t);
  for (const args of [
    ["service", "bogus"],
    ["snapshot", "create"],
  ]) {
    const r = await h.run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.out, "");
    assert.equal(fixLines(r.err).length, 1);
    assert.equal(
      r.err.trimEnd().split("\n").at(-1),
      "Fix: Run 'ensemble --help'.",
    );
  }
});

test("every usage-error path ends with one Fix line and help and version stay clean", async (t) => {
  const h = harness(t);
  // [name, args, stream carrying the usage text]
  const paths: [string, string[], "stdout" | "stderr"][] = [
    ["bare invocation", [], "stdout"],
    ["unknown top-level command", ["bogus"], "stderr"],
    ["unknown subcommand", ["task", "bogus"], "stderr"],
    ["the word help", ["help"], "stderr"],
    ["missing positionals", ["task", "get"], "stderr"],
    ["unknown flag", ["task", "list", "--bogus-flag"], "stderr"],
    ["invalid --output", ["task", "list", "--output", "yaml"], "stderr"],
    ["service usage", ["service", "bogus"], "stderr"],
    ["snapshot usage", ["snapshot", "create"], "stderr"],
  ];
  for (const [name, args, stream] of paths) {
    const r = await h.run(args);
    assert.equal(r.code, 2, name);
    const usage = stream === "stdout" ? r.out : r.err;
    if (name !== "invalid --output") assert.match(usage, /Usage:/, name);
    if (stream === "stderr") assert.equal(r.out, "", name);
    assert.equal(fixLines(r.err).length, 1, name);
    assert.equal(
      r.err.trimEnd().split("\n").at(-1),
      "Fix: Run 'ensemble --help'.",
      name,
    );
    // JSON: the error envelope (or, for a bare invocation, today's usage text) is unchanged
    // and nothing is written to stderr.
    // These commands take no --output, so there is no JSON variant of them.
    if (["invalid --output", "service usage", "snapshot usage"].includes(name))
      continue;
    const json = await h.run([...args, "--output", "json"]);
    assert.equal(json.code, 2, name);
    // A flag-parse failure is raised before --output is read, so it stays human-only.
    if (name === "unknown flag") continue;
    assert.equal(json.err, "", name);
    assert.ok(!json.out.includes("Fix:"), name);
    if (args.length)
      assert.deepEqual(
        Object.keys(json.json().error).sort(),
        ["category", "code", "message", "outcome", "requestId", "retryable"],
        name,
      );
  }
  for (const [name, args] of [
    ["--help", ["--help"]],
    ["--version", ["--version"]],
  ] as const) {
    const r = await h.run([...args]);
    assert.equal(r.code, 0, name);
    assert.equal(r.err, "", name);
    assert.ok(!r.out.includes("Fix:"), name);
  }
});
