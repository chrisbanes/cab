import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startCliService } from "./fixtures/operator-cli.js";

const run = promisify(execFile);
const root = join(import.meta.dirname, "../..");

type Lock = {
  packages: Record<string, Record<string, unknown> & { dev?: boolean }>;
};

/** Installs the packed CLI offline from the npm cache with a lockfile derived from the repository's. */
async function installPacked(dir: string) {
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
    { cwd: root },
  );
  const [{ filename }] = JSON.parse(packed.stdout) as [{ filename: string }];
  const tarball = join(dir, filename);
  const project = join(dir, "project");
  rmSync(project, { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  ) as Lock;
  const packages: Lock["packages"] = {
    "": {
      name: "ensemble-cli-smoke",
      dependencies: { ensemble: `file:${tarball}` },
    },
    "node_modules/ensemble": {
      version: manifest.version,
      resolved: `file:${tarball}`,
      integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
      license: manifest.license,
      dependencies: manifest.dependencies,
      bin: manifest.bin,
      engines: manifest.engines,
    },
  };
  for (const [path, entry] of Object.entries(lock.packages))
    if (path && !entry.dev) packages[path] = entry;
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "ensemble-cli-smoke",
      private: true,
      dependencies: { ensemble: `file:${tarball}` },
    }),
  );
  writeFileSync(
    join(project, "package-lock.json"),
    JSON.stringify({
      name: "ensemble-cli-smoke",
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  );
  // --offline fails rather than silently resolving from the network.
  await run(
    "npm",
    [
      "ci",
      "--offline",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ],
    { cwd: project },
  );
  return project;
}

test("the packed CLI installs offline and works against a real service over loopback and verified HTTPS", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-cli-packed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = await installPacked(dir);
  const installed = join(project, "node_modules", "ensemble");
  assert.ok(existsSync(join(installed, "dist/src/cli/main.js")));
  assert.ok(!existsSync(join(installed, "dist/test")));
  const bin = join(project, "node_modules", ".bin", "ensemble");
  const config = join(dir, "config");
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    try {
      const r = await run(bin, args, {
        cwd: project,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          ENSEMBLE_CLI_CONFIG_DIR: config,
          ...env,
        },
      });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, out: e.stdout, err: e.stderr };
    }
  };
  const tokenFile = (token: string, name: string) => {
    const path = join(dir, name);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return path;
  };

  // Loopback.
  const s = await startCliService(t);
  const read = await s.issue("read", "packed");
  const file = tokenFile(read.token, "loopback.token");
  let r = await cli([
    "auth",
    "login",
    "--connection",
    "local",
    "--url",
    s.origin,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 0, r.err);
  r = await cli(["auth", "status"]);
  assert.equal(r.code, 0, r.err);
  r = await cli(["task", "get", s.taskId, "--output", "json"]);
  assert.equal(r.code, 0, r.err);
  const envelope = JSON.parse(r.out);
  assert.equal(envelope.schema, "ensemble.cli/v1");
  assert.equal(envelope.data.task.id, s.taskId);
  r = await cli(["task", "get", s.taskId], {
    ENSEMBLE_MANAGED_ASSIGNMENT: "1",
  });
  assert.equal(r.code, 3);
  r = await cli(["auth", "logout"]);
  assert.equal(r.code, 0, r.err);
  assert.equal((await s.bearer(read.token, "/api/operator/cli")).status, 200);

  // Verified HTTPS through a TLS-terminating proxy.
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { cwd: dir },
  );
  let target = 0;
  let proxied = 0;
  const proxy = createHttpsServer(
    {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    },
    (incoming, outgoing) => {
      proxied++;
      const upstream = request(
        {
          host: "127.0.0.1",
          port: target,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      incoming.pipe(upstream);
    },
  );
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const proxyPort = (proxy.address() as { port: number }).port;
  const remote = await startCliService(t, {
    authOrigin: `https://localhost:${proxyPort}`,
  });
  target = remote.port;
  const remoteToken = await remote.issue("read", "remote");
  const remoteFile = tokenFile(remoteToken.token, "remote.token");
  const url = `https://localhost:${proxyPort}`;
  r = await cli([
    "auth",
    "login",
    "--connection",
    "untrusted",
    "--url",
    url,
    "--token-file",
    remoteFile,
  ]);
  assert.equal(r.code, 5);
  assert.match(r.err, /tls-verification-failed/);
  assert.equal(proxied, 0, "no request reached the service");
  const trusted = { NODE_EXTRA_CA_CERTS: join(dir, "cert.pem") };
  r = await cli(
    [
      "auth",
      "login",
      "--connection",
      "remote",
      "--url",
      url,
      "--token-file",
      remoteFile,
    ],
    trusted,
  );
  assert.equal(r.code, 0, r.err);
  r = await cli(["auth", "status", "--connection", "remote"], trusted);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`Service: +https://localhost:${proxyPort}`));
  r = await cli(
    [
      "task",
      "get",
      remote.taskId,
      "--connection",
      "remote",
      "--output",
      "json",
    ],
    trusted,
  );
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).data.task.id, remote.taskId);
  r = await cli(["auth", "status", "--connection", "remote"]);
  assert.equal(r.code, 5, "verification is required on every use");

  // A redirect to another origin never forwards the credential.
  const otherHits: string[] = [];
  const other = createHttpServer((incoming, outgoing) => {
    otherHits.push(String(incoming.headers.authorization));
    outgoing.end("{}");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const redirect = createHttpServer((_incoming, outgoing) =>
    outgoing
      .writeHead(307, {
        location: `http://127.0.0.1:${(other.address() as { port: number }).port}/api/operator/cli`,
      })
      .end(),
  );
  await new Promise<void>((resolve) =>
    redirect.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => new Promise((resolve) => redirect.close(resolve)));
  r = await cli([
    "auth",
    "login",
    "--connection",
    "redirect",
    "--url",
    `http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
    "--token-file",
    file,
  ]);
  assert.equal(r.code, 5);
  assert.match(r.err, /redirect-rejected/);
  assert.deepEqual(otherHits, []);
  const stored = readFileSync(join(config, "connections.json"), "utf8");
  for (const token of [read.token, remoteToken.token])
    assert.ok(!stored.includes(token));
});
