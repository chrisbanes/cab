import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ConnectionConfig } from "../../src/cli/connections.js";
import { localAccessDirectory } from "../../src/operator/local-access.js";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";

type Served = Awaited<ReturnType<typeof startCliService>>;

const DEFAULT_LABEL = "local.cab.service";

/** An install record as service management writes it: STATE/launchd/LABEL.json naming STATE/data. */
const recordFor = (state: string, label: string, port: number) => ({
  schema: "cab.service/v1",
  mode: "agent",
  label,
  version: "0.1.0",
  plistSha256: "0".repeat(64),
  configuration: {
    label,
    nodePath: "/usr/bin/node",
    cliPath: join(
      state,
      "versions",
      "0.1.0",
      "dist",
      "src",
      "standalone",
      "cli.js",
    ),
    dataDirectory: join(state, "data"),
    authFile: join(state, "auth", "operator-auth.json"),
    origin: `http://127.0.0.1:${port}`,
    port,
    stdoutPath: join(state, "logs", "out.log"),
    stderrPath: join(state, "logs", "err.log"),
  },
});

/**
 * Lays out an installation at `state` for the real service `s`: its record, and the service's
 * current local material where STATE/data's sidecar would be. Returns the record path.
 */
async function installation(s: Served, state: string, label: string) {
  await mkdir(join(state, "launchd"), { recursive: true, mode: 0o700 });
  await syncMaterial(s, state);
  const record = join(state, "launchd", `${label}.json`);
  await writeFile(record, JSON.stringify(recordFor(state, label, s.port)), {
    mode: 0o600,
  });
  return record;
}

/** The service's published material, as its own STATE/data would hold it after a (re)start. */
async function syncMaterial(s: Served, state: string) {
  const directory = localAccessDirectory(join(state, "data"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(
    join(localAccessDirectory(join(s.f.directory, "data")), "connection.json"),
    join(directory, "connection.json"),
  );
  await chmod(join(directory, "connection.json"), 0o600);
}

test("a bare command discovers the default installed service from its record without credentials", async (t) => {
  const s = await startCliService(t);
  const h = harness(t, {
    keychain: () => {
      throw Error("Keychain must not open");
    },
  });
  const home = join(h.dir, "home");
  const state = join(home, "Library", "Application Support", "cab");
  const record = await installation(s, state, DEFAULT_LABEL);
  // No CAB_LOCAL_STATE: only HOME's default record can be discovered.
  const env = { CAB_CLI_CONFIG_DIR: h.configDir, HOME: home };
  let r = await h.run(["auth", "status", "--output", "json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().data.accessMode, "local");
  assert.equal(r.json().data.credential.scope, "read-write");
  assert.equal(r.json().data.credential.expiresAt, null);
  assert.equal(r.json().service.url, s.origin);
  const id = r.json().service.installationId;
  r = await h.run(["task", "stop", s.taskId, "--output", "json"], { env });
  assert.equal(r.code, 0, r.err);
  // Discovery saves nothing.
  assert.deepEqual(
    (await new ConnectionConfig(h.configDir).read()).connections,
    {},
  );

  // An absent automatic record keeps the default foreground fallback: STATE/data under HOME.
  await rm(record);
  r = await h.run(["auth", "status", "--output", "json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().service.installationId, id);

  // A present but unusable record never falls through to the foreground data directory.
  const valid = recordFor(state, DEFAULT_LABEL, s.port);
  const fetched = h.fetches.length;
  for (const [content, mode] of [
    ["{}", 0o600],
    [JSON.stringify(valid), 0o644],
    [JSON.stringify({ ...valid, label: "local.cab.other" }), 0o600],
    [
      JSON.stringify({
        ...valid,
        configuration: {
          ...valid.configuration,
          dataDirectory: join(h.dir, "elsewhere", "data"),
        },
      }),
      0o600,
    ],
    // The recorded origin is not the one the material publishes.
    [
      JSON.stringify({
        ...valid,
        configuration: {
          ...valid.configuration,
          origin: `http://127.0.0.1:${s.port + 1}`,
          port: s.port + 1,
        },
      }),
      0o600,
    ],
    [
      JSON.stringify({
        ...valid,
        configuration: {
          ...valid.configuration,
          origin: `http://localhost:${s.port}`,
        },
      }),
      0o600,
    ],
  ] as const) {
    await rm(record, { force: true });
    await writeFile(record, content, { mode });
    await chmod(record, mode);
    r = await h.run(["auth", "status", "--output", "json"], { env });
    assert.equal(r.code, 3, `${content} ${mode.toString(8)}: ${r.out}`);
    assert.equal(r.json().error.code, "local-access-unavailable");
  }
  // A substituted record file or directory is refused too.
  await rm(record);
  const elsewhere = join(h.dir, "record.json");
  await writeFile(elsewhere, JSON.stringify(valid), { mode: 0o600 });
  await symlink(elsewhere, record);
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 3, r.err);
  await rm(record);
  await chmod(join(state, "launchd"), 0o755);
  await writeFile(record, JSON.stringify(valid), { mode: 0o600 });
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 3, r.err);
  assert.equal(h.fetches.length, fetched, "no unusable record reached HTTP");
  await chmod(join(state, "launchd"), 0o700);
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 0, r.err);

  // A restart rotates the material; the same discovery reads the new generation.
  await s.restart();
  r = await h.run(["auth", "status"], { env });
  assert.equal(r.code, 3, "the copied old generation is refused");
  await syncMaterial(s, state);
  r = await h.run(["doctor"], { env });
  assert.equal(r.code, 0, r.err);

  // A saved token connection keeps precedence over discovery and is never converted.
  const token = await s.issue("read");
  r = await h.run(
    [
      "auth",
      "login",
      "--connection",
      "work",
      "--url",
      s.origin,
      "--token-file",
      h.tokenFile(token.token),
    ],
    // saveLogin opens the store even for a token file; it is never written.
    { env, keychain: () => h.keychain },
  );
  assert.equal(r.code, 0, r.err);
  r = await h.run(["auth", "status", "--output", "json"], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().data.accessMode, "token");
  assert.equal(r.json().data.credential.scope, "read");
});

test("an explicit record selects one of two installations, adopts only after checking it and never guesses", async (t) => {
  const one = await startCliService(t);
  const two = await startCliService(t);
  const h = harness(t);
  const recordOne = await installation(
    one,
    join(h.dir, "one"),
    "local.cab.one",
  );
  const recordTwo = await installation(
    two,
    join(h.dir, "two"),
    "local.cab.two",
  );
  const idOf = async (record: string) => {
    const r = await h.run([
      "auth",
      "status",
      "--local",
      "--local-installation",
      record,
      "--output",
      "json",
    ]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().data.accessMode, "local");
    return [r.json().service.url, r.json().service.installationId];
  };
  const [urlOne, idOne] = await idOf(recordOne);
  const [urlTwo, idTwo] = await idOf(recordTwo);
  assert.equal(urlOne, one.origin);
  assert.equal(urlTwo, two.origin);
  assert.notEqual(idOne, idTwo);

  // Selector conflicts and empty input refuse before any read or request.
  const fetched = h.fetches.length;
  for (const args of [
    ["auth", "status", "--local-installation", recordOne],
    [
      "auth",
      "status",
      "--local",
      "--local-installation",
      recordOne,
      "--local-state",
      join(h.dir, "one", "data"),
    ],
    ["auth", "status", "--local", "--local-installation", ""],
    ["auth", "status", "--connection", "x", "--local-installation", recordOne],
  ]) {
    const r = await h.run([...args, "--output", "json"]);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.json().error.code, "usage");
  }
  // A managed assignment refuses before the record is read.
  let r = await h.run(
    ["auth", "status", "--local", "--local-installation", join(h.dir, "nope")],
    { env: { CAB_CLI_CONFIG_DIR: h.configDir, CAB_MANAGED_ASSIGNMENT: "1" } },
  );
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /cab-managed assignment/);
  assert.equal(h.fetches.length, fetched);

  // Material whose installation is not the live one refuses: same origin, foreign identity.
  const sidecar = join(
    localAccessDirectory(join(h.dir, "one", "data")),
    "connection.json",
  );
  const material = JSON.parse(await readFile(sidecar, "utf8"));
  await writeFile(
    sidecar,
    JSON.stringify({ ...material, installationId: randomUUID() }),
  );
  r = await h.run([
    "auth",
    "status",
    "--local",
    "--local-installation",
    recordOne,
  ]);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /does not match/);
  // Another service's material under this record: its origin is not the recorded one.
  await copyFile(
    join(localAccessDirectory(join(h.dir, "two", "data")), "connection.json"),
    sidecar,
  );
  r = await h.run([
    "auth",
    "status",
    "--local",
    "--local-installation",
    recordOne,
  ]);
  assert.equal(r.code, 3, r.err);
  assert.match(r.err, /not its recorded/);
  await syncMaterial(one, join(h.dir, "one"));

  // Adoption saves only a checked installation, and keeps the prior config on failure.
  const configFile = join(h.configDir, "connections.json");
  r = await h.run([
    "connection",
    "local",
    "two",
    "--local-installation",
    recordTwo,
  ]);
  assert.equal(r.code, 0, r.err);
  const before = await readFile(configFile, "utf8");
  assert.deepEqual(
    (await new ConnectionConfig(h.configDir).read()).connections.two,
    {
      url: two.origin,
      installationId: idTwo,
      credential: { kind: "local", state: join(h.dir, "two", "data") },
    },
  );
  r = await h.run([
    "connection",
    "local",
    "broken",
    "--local-installation",
    join(h.dir, "missing.json"),
  ]);
  assert.equal(r.code, 3, r.err);
  assert.equal(await readFile(configFile, "utf8"), before);
  // Re-adopting a name for another installation keeps the saved one.
  r = await h.run([
    "connection",
    "local",
    "two",
    "--local-installation",
    recordOne,
  ]);
  assert.equal(r.code, 3, r.err);
  assert.equal(await readFile(configFile, "utf8"), before);
  // The saved (sole) connection is now the bare selection, and stays bound to installation two.
  r = await h.run(["auth", "status", "--output", "json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().connection, "two");
  assert.equal(r.json().service.installationId, idTwo);
});
