import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConnectionConfig } from "../../src/cli/connections.js";
import {
  LocalAccess,
  localAccessDirectory,
  localOrigin,
  readLocalAccess,
} from "../../src/operator/local-access.js";
import { sanitizeConversationText } from "../../src/standalone/conversation-history.js";
import { fakeServer, harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

test("empty connection selections refuse reads, writes and login before local discovery or HTTP", async (t) => {
  let requests = 0;
  const h = harness(t, {
    fetch: async () => {
      requests++;
      throw Error("Invalid selections must not send HTTP requests");
    },
    keychain: () => {
      throw Error("Invalid selections must not read credentials");
    },
  });
  const state = join(h.dir, "data");
  const access = await LocalAccess.create(state, randomUUID());
  await access.publish("http://127.0.0.1:8787");
  const env = { CAB_CLI_CONFIG_DIR: h.configDir, CAB_LOCAL_STATE: state };
  // Valid material would reach HTTP on fallback; malformed material would expose
  // a local-access error if resolution tried reading it before refusing the name.
  for (const malformed of [false, true]) {
    if (malformed)
      await writeFile(
        join(localAccessDirectory(state), "connection.json"),
        "{}",
      );
    for (const command of [
      ["auth", "status"],
      ["project", "list"],
      ["task", "stop", randomUUID()],
      ["auth", "login"],
    ]) {
      for (const selection of ["explicit", "environment"] as const) {
        const r = await h.run(
          [
            ...command,
            ...(selection === "explicit" ? ["--connection", ""] : []),
            "--output",
            "json",
          ],
          {
            env: {
              ...env,
              ...(selection === "environment" ? { CAB_CONNECTION: "" } : {}),
            },
          },
        );
        const context = `${command.join(" ")} ${selection} malformed=${malformed}`;
        assert.equal(r.code, 2, `${context}: ${r.out}`);
        assert.equal(
          r.json().error.code,
          command[1] === "login" ? "usage" : "connection-not-found",
          context,
        );
        assert.equal(requests, 0, context);
      }
    }
    for (const options of [
      ["--local", "--connection", ""],
      ["--url", ""],
      ["--token-file", ""],
      ["--local", "--url", ""],
      ["--local", "--token-file", ""],
      ["--local-state", ""],
    ]) {
      const r = await h.run(["auth", "login", ...options, "--output", "json"], {
        env,
      });
      assert.equal(r.code, 2, r.out);
      assert.equal(r.json().error.code, "usage");
      if (options.includes("--connection"))
        assert.match(r.json().error.message, /Choose --local or --connection/);
      assert.equal(requests, 0);
    }
  }
});

test("service local material rotates under one installation and refuses unsafe or foreign retained state", async (t) => {
  const h = harness(t),
    state = join(h.dir, "data"),
    id = randomUUID();
  const first = await LocalAccess.create(state, id);
  await assert.rejects(readLocalAccess(state), /not published/);
  await first.publish("http://127.0.0.1:8787");
  const before = await readLocalAccess(state);
  const second = await LocalAccess.create(state, id);
  assert.equal(second.verify(before.secret), false);
  await second.publish("http://127.0.0.1:8787");
  const after = await readLocalAccess(state);
  assert.notEqual(after.secret, before.secret);
  assert.equal(second.verify(after.secret), true);
  const file = join(localAccessDirectory(state), "connection.json");
  const saved = await readFile(file, "utf8");
  await assert.rejects(
    LocalAccess.create(state, randomUUID()),
    /another installation/,
  );
  assert.equal(await readFile(file, "utf8"), saved);
  await chmod(file, 0o644);
  await assert.rejects(LocalAccess.create(state, id), /owner-only/);
  assert.equal(await readFile(file, "utf8"), saved);
});

test("foreground local access reads, writes and restarts without token provisioning or Keychain", async (t) => {
  const s = await startCliService(t);
  const state = join(s.f.directory, "data");
  const h = harness(t, {
    keychain: () => {
      throw Error("Keychain must not open");
    },
  });
  const env = { CAB_CLI_CONFIG_DIR: h.configDir, CAB_LOCAL_STATE: state };
  let r = await h.run(["auth", "status", "--output", "json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().data.accessMode, "local");
  assert.equal(r.json().data.credential.scope, "read-write");
  assert.equal(r.json().data.credential.expiresAt, null);
  assert.equal(r.json().service.origin, s.authOrigin);
  assert.equal(r.json().service.url, s.origin);
  r = await h.run(["task", "stop", s.taskId, "--output", "json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(
    (await (await s.sessionGet(`/api/operator/tasks/${s.taskId}`)).json()).data
      .execution.holds.stop,
    true,
  );
  const before = await readLocalAccess(state);
  await s.restart();
  const after = await readLocalAccess(state);
  assert.equal(after.installationId, before.installationId);
  assert.notEqual(after.secret, before.secret);
  assert.equal(
    (await s.bearer(before.secret, "/api/operator/cli")).status,
    401,
  );
  r = await h.run(["task", "get", s.taskId], { env });
  assert.equal(r.code, 0, r.err);
  for (const verb of ["login", "logout"]) {
    r = await h.run(["auth", verb, "--local", "--local-state", state]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /OS account/);
  }
  assert.equal(
    (await new ConnectionConfig(h.configDir).read()).connections.local,
    undefined,
  );
  assert.ok(!h.outputs.join("").includes(after.secret));
});

test("local adoption validates before saving and keeps old token and operator file on failure and success", async (t) => {
  const s = await startCliService(t),
    h = harness(t);
  const state = join(s.f.directory, "data");
  const token = await s.issue("read");
  const file = h.tokenFile(token.token);
  let r = await h.run([
    "auth",
    "login",
    "--connection",
    "restricted",
    "--url",
    s.origin,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 0, r.err);
  const configFile = join(h.configDir, "connections.json");
  const before = await readFile(configFile, "utf8");
  const other = await startCliService(t);
  for (const invalid of [
    join(h.dir, "missing"),
    join(other.f.directory, "data"),
  ]) {
    r = await h.run([
      "connection",
      "local",
      "restricted",
      "--local-state",
      invalid,
    ]);
    assert.notEqual(r.code, 0);
    assert.equal(await readFile(configFile, "utf8"), before);
    assert.equal(await readFile(file, "utf8"), `${token.token}\n`);
  }
  r = await h.run([
    "connection",
    "local",
    "restricted",
    "--local-state",
    state,
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(
    (await new ConnectionConfig(h.configDir).read()).connections.restricted
      ?.credential?.kind,
    "local",
  );
  assert.equal(await readFile(file, "utf8"), `${token.token}\n`);
  assert.equal((await s.bearer(token.token, "/api/operator/cli")).status, 200);
  r = await h.run([
    "auth",
    "status",
    "--connection",
    "restricted",
    "--output",
    "json",
  ]);
  assert.equal(r.json().data.accessMode, "local");
  await s.restart();
  r = await h.run(["auth", "status", "--connection", "restricted"]);
  assert.equal(r.code, 0, r.err);
  const material = await readLocalAccess(state);
  const accessFile = join(localAccessDirectory(state), "connection.json");
  await writeFile(
    accessFile,
    JSON.stringify({ ...material, installationId: randomUUID() }),
  );
  r = await h.run(["auth", "status", "--connection", "restricted"]);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /different installation/);
  r = await h.run(["auth", "status", "--local", "--local-state", state]);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /does not match/);
});

test("selected localhost tokens preserve scope, expiry, revocation, logout and selection precedence", async (t) => {
  const s = await startCliService(t),
    h = harness(t);
  const state = join(s.f.directory, "data");
  const env = { CAB_CLI_CONFIG_DIR: h.configDir, CAB_LOCAL_STATE: state };
  const token = await s.issue("read");
  const file = h.tokenFile(token.token);
  let r = await h.run([
    "auth",
    "login",
    "--connection",
    "restricted",
    "--url",
    s.origin,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 0, r.err);
  r = await h.run(["task", "stop", s.taskId], { env });
  assert.equal(r.code, 3, r.err);
  const config = new ConnectionConfig(h.configDir);
  const current = await config.read();
  current.connections.second = { ...current.connections.restricted! };
  await config.write(current);
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /Choose a connection/);
  r = await h.run(["auth", "status"], {
    env: { ...env, CAB_CONNECTION: "restricted" },
  });
  assert.equal(r.code, 0, r.err);
  r = await h.run(["auth", "status", "--connection", "restricted"], {
    env: { ...env, CAB_CONNECTION: "missing" },
  });
  assert.equal(r.code, 0, r.err);
  r = await h.run(["connection", "use", "restricted"]);
  assert.equal(r.code, 0, r.err);
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 0, r.err);
  s.f.service.operatorCredentials().revoke(token.credential.id);
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 3, r.err);
  r = await h.run(["auth", "logout"], { env });
  assert.equal(r.code, 0, r.err);
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /logged out/);
  r = await h.run(["auth", "status", "--connection", "missing"], { env });
  assert.equal(r.code, 2, r.err);
  const expired = s.f.service
    .operatorCredentials()
    .issue({ name: "expired", scope: "read" }, Date.now() - 91 * 86400000);
  current.connections.expired = {
    url: s.origin,
    installationId: s.f.service.operatorCredentials().installationId(),
    credential: { kind: "token-file", path: h.tokenFile(expired.token) },
  };
  await config.write(current);
  r = await h.run(["auth", "status", "--connection", "expired"], { env });
  assert.equal(r.code, 3, r.err);
  // Explicit local selection remains deliberate even when restricted tokens are saved.
  r = await h.run(["auth", "status", "--local", "--local-state", state]);
  assert.equal(r.code, 0, r.err);
});

test("local state rejects missing, malformed, unsafe files, owners, parent substitutions and origins before HTTP", async (t) => {
  const h = harness(t);
  const state = join(h.dir, "data");
  const directory = localAccessDirectory(state),
    file = join(directory, "connection.json");
  const access = await LocalAccess.create(state, randomUUID());
  await access.publish("http://127.0.0.1:8787");
  const original = await readFile(file, "utf8");
  assert.equal((await readLocalAccess(state)).origin, "http://127.0.0.1:8787");
  const run = () =>
    h.run(["auth", "status", "--local", "--local-state", state]);
  for (const content of [
    "bad json",
    "{}",
    JSON.stringify({ ...JSON.parse(original), origin: "https://example.com" }),
    JSON.stringify({ ...JSON.parse(original), origin: null }),
  ]) {
    await writeFile(file, content);
    assert.equal((await run()).code, 3);
  }
  await writeFile(file, original);
  await chmod(file, 0o644);
  assert.equal((await run()).code, 3);
  await chmod(file, 0o600);
  await assert.rejects(readLocalAccess(state, (process.getuid?.() ?? 0) + 1));
  await link(file, `${file}.link`);
  assert.equal((await run()).code, 3);
  await unlink(`${file}.link`);
  await chmod(directory, 0o755);
  assert.equal((await run()).code, 3);
  await chmod(directory, 0o700);
  await rename(file, `${file}.old`);
  await symlink(`${file}.old`, file);
  assert.equal((await run()).code, 3);
  await unlink(file);
  await mkdir(file);
  assert.equal((await run()).code, 3);
  await rename(directory, `${directory}.old`);
  await symlink(`${directory}.old`, directory);
  assert.equal((await run()).code, 3);
  assert.equal(h.fetches.length, 0);
  for (const url of [
    "http://localhost:8787",
    "http://127.0.0.1:8787/path",
    "http://127.0.0.1:8787?x",
    "https://127.0.0.1:8787",
    "http://user@127.0.0.1:8787",
  ])
    assert.throws(() => localOrigin(url));
});

test("local material is never forwarded across redirects and stale material fails without fallback", async (t) => {
  const h = harness(t),
    state = join(h.dir, "data");
  const destination = await fakeServer(t, (_req, res) => res.end());
  const redirect = await fakeServer(t, (_req, res) => {
    res.writeHead(302, { location: destination.origin });
    res.end();
  });
  const access = await LocalAccess.create(state, randomUUID());
  await access.publish(redirect.origin);
  let r = await h.run(["auth", "status", "--local", "--local-state", state]);
  assert.equal(r.code, 5, r.err);
  assert.match(r.err, /redirect/);
  assert.equal(destination.hits.length, 0);
  const s = await startCliService(t);
  await access.publish(s.origin);
  r = await h.run(["auth", "status", "--local", "--local-state", state]);
  assert.equal(r.code, 3, r.err);
});

test("managed local commands refuse before material reads or authenticated HTTP", async (t) => {
  const h = harness(t);
  for (const command of [
    ["auth", "status"],
    ["auth", "login"],
    ["auth", "logout"],
    ["task", "get", randomUUID()],
    ["connection", "local", "saved"],
  ]) {
    const r = await h.run(
      [
        ...command,
        ...(command[0] === "connection" ? [] : ["--local"]),
        "--local-state",
        join(h.dir, "missing"),
      ],
      { env: { CAB_CLI_CONFIG_DIR: h.configDir, CAB_MANAGED_ASSIGNMENT: "1" } },
    );
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /cab-managed assignment/);
  }
  assert.equal(h.fetches.length, 0);
});

test("local capability shares route authority and known secrets remain excluded from diagnostics", async (t) => {
  const s = await startCliService(t);
  const material = await readLocalAccess(join(s.f.directory, "data"));
  for (const path of [
    "/api/operator/credentials",
    "/api/operator/session",
    "/api/operator/unknown",
  ]) {
    const r = await s.bearer(material.secret, path);
    assert.notEqual(r.status, 200, path);
  }
  assert.equal(
    (await s.bearer(material.secret, "/api/operator/cli")).status,
    200,
  );
  assert.ok(s.f.service.failureExclusions()?.includes(material.secret));
  assert.equal(
    sanitizeConversationText(`copied ${material.secret}`, []),
    "copied [redacted]",
  );
  assert.equal(
    sanitizeConversationText(`prefix${material.secret}suffix`, []),
    "prefix[redacted]suffix",
  );
});
