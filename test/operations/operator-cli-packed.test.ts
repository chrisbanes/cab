import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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
import { startCliService } from "../fixtures/operator-cli.js";
import { installPacked } from "../fixtures/packed-cli.js";

const run = promisify(execFile);

test("the packed CLI installs offline and works against a real service over loopback and verified HTTPS", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cab-cli-packed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installStarted = performance.now();
  const project = await installPacked(dir).catch((error: unknown) => {
    throw new Error(
      `Packed install failed after ${Math.round(performance.now() - installStarted)}ms: ${String(error)}`,
      { cause: error },
    );
  });
  const installed = join(project, "node_modules", "@chrisbanes", "cab");
  assert.equal(
    JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).name,
    "@chrisbanes/cab",
  );
  assert.ok(existsSync(join(installed, "dist/src/cli/main.js")));
  assert.ok(!existsSync(join(installed, "dist/test")));
  assert.ok(existsSync(join(installed, "dist/operator/index.html")));
  const bin = join(project, "node_modules", ".bin", "cab");
  const config = join(dir, "config");
  const steps = [`install ${Math.round(performance.now() - installStarted)}ms`];
  // A failed assertion carries `detail`: the step, its exit, its stderr and every step so far.
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const started = performance.now();
    const result = await run(bin, args, {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        CAB_CLI_CONFIG_DIR: config,
        ...env,
      },
    }).then(
      (r) => ({ code: 0 as number | string, out: r.stdout, err: r.stderr }),
      (error: unknown) => {
        const e = error as {
          code: number | string;
          signal?: string;
          stdout: string;
          stderr: string;
        };
        return {
          code: e.code,
          out: e.stdout,
          err: e.stderr,
          signal: e.signal,
        };
      },
    );
    const shown = args.map((arg, i) =>
      args[i - 1] === "--token-file" ? "<token-file>" : arg,
    );
    const step = `cab ${shown.join(" ")} -> exit ${result.code}${"signal" in result && result.signal ? ` signal ${result.signal}` : ""} in ${Math.round(performance.now() - started)}ms`;
    steps.push(step);
    const detail = `${step}\nstderr tail: ${result.err.slice(-500)}\nsteps so far:\n${steps.join("\n")}`;
    return { ...result, detail };
  };
  const tokenFile = (token: string, name: string) => {
    const path = join(dir, name);
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return path;
  };

  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const versionRun = await cli(["--version"]);
  assert.deepEqual(
    { code: versionRun.code, out: versionRun.out, err: versionRun.err },
    { code: 0, out: `cab ${version}\n`, err: "" },
    versionRun.detail,
  );

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
  assert.equal(r.code, 0, r.detail);
  r = await cli(["auth", "status"]);
  assert.equal(r.code, 0, r.detail);
  r = await cli(["task", "get", s.taskId, "--output", "json"]);
  assert.equal(r.code, 0, r.detail);
  const envelope = JSON.parse(r.out);
  assert.equal(envelope.schema, "cab.cli/v1");
  assert.equal(envelope.data.task.id, s.taskId);
  r = await cli(["project", "list", "--output", "json"]);
  assert.equal(r.code, 0, r.detail);
  assert.ok(
    JSON.parse(r.out).data.projects.some(
      (p: { id: string }) => p.id === s.projectId,
    ),
  );
  r = await cli(["task", "list", "--output", "json"]);
  assert.equal(r.code, 0, r.detail);
  const list = JSON.parse(r.out);
  assert.equal(list.coverage.complete, true);
  assert.deepEqual(
    list.data.tasks.map((x: { id: string }) => x.id),
    [s.taskId],
  );
  r = await cli(["execution", "list", "--task", s.taskId, "--output", "json"]);
  assert.equal(r.code, 0, r.detail);
  assert.deepEqual(JSON.parse(r.out).data.executions, []);
  r = await cli(["logs", "--execution", "unknown-work", "--output", "jsonl"]);
  assert.equal(r.code, 2, r.detail);
  const record = JSON.parse(r.out);
  assert.equal(record.type, "error");
  assert.equal(record.error.code, "not-found");
  // One reviewed write through the installed binary.
  const write = await s.issue("read-write", "packed-rw");
  r = await cli([
    "auth",
    "login",
    "--connection",
    "rw",
    "--url",
    s.origin,
    "--token-file",
    tokenFile(write.token, "loopback-rw.token"),
  ]);
  assert.equal(r.code, 0, r.detail);
  const change = join(dir, "capacity.json");
  r = await cli([
    "capacity",
    "prepare",
    "--global-limit",
    "6",
    "--out",
    change,
    "--connection",
    "rw",
  ]);
  assert.equal(r.code, 0, r.detail);
  r = await cli([
    "capacity",
    "apply",
    "--file",
    change,
    "--connection",
    "rw",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.detail);
  const applied = JSON.parse(r.out);
  assert.equal(applied.data.receipt.result.globalLimit, 6);
  r = await cli([
    "operation",
    "get",
    applied.request.key,
    "--scope",
    "system:capacity",
    "--type",
    "capacity.configure",
    "--connection",
    "rw",
    "--output",
    "json",
  ]);
  assert.deepEqual(JSON.parse(r.out).data.receipt, applied.data.receipt);
  // CLI5: the inbox read and a receipted Stop through the installed binary.
  r = await cli(["inbox", "list", "--connection", "local", "--output", "json"]);
  assert.equal(r.code, 0, r.detail);
  assert.deepEqual(JSON.parse(r.out).data.items, []);
  r = await cli([
    "task",
    "stop",
    s.taskId,
    "--connection",
    "rw",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.detail);
  assert.equal(JSON.parse(r.out).data.receipt.kind, "task-stop");
  assert.equal(s.f.service.isTaskStopped(s.taskId), true);
  // CLI4: one source read and one delivery read through the installed binary.
  r = await cli([
    "project",
    "sources",
    s.projectId,
    "--connection",
    "local",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.detail);
  assert.deepEqual(JSON.parse(r.out).data.source.selections, []);
  r = await cli([
    "delivery",
    "get",
    s.taskId,
    "--connection",
    "local",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 0, r.detail);
  assert.equal(JSON.parse(r.out).data.issue, null);
  // CLI6: the installed binary reaches the recovery read (no assignment here).
  r = await cli([
    "recovery",
    "get",
    randomUUID(),
    "--connection",
    "local",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 2, r.detail);
  assert.equal(JSON.parse(r.out).error.code, "not-found");
  r = await cli(["task", "get", s.taskId], {
    CAB_MANAGED_ASSIGNMENT: "1",
  });
  assert.equal(r.code, 3, r.detail);
  r = await cli(["auth", "logout", "--connection", "local"]);
  assert.equal(r.code, 0, r.detail);
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
  assert.equal(r.code, 5, r.detail);
  assert.match(r.err, /tls-verification-failed/, r.detail);
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
  assert.equal(r.code, 0, r.detail);
  r = await cli(["auth", "status", "--connection", "remote"], trusted);
  assert.equal(r.code, 0, r.detail);
  assert.match(r.out, new RegExp(`URL: +https://localhost:${proxyPort}$`, "m"));
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
  assert.equal(r.code, 0, r.detail);
  assert.equal(JSON.parse(r.out).data.task.id, remote.taskId);
  r = await cli(["auth", "status", "--connection", "remote"]);
  assert.equal(r.code, 5, `verification is required on every use: ${r.detail}`);

  // A redirect to another origin never forwards the credential.
  // Only a request for the redirect's own path counts: another process's stray client can
  // reach an ephemeral port (observed under concurrent load) and must not read as a followed redirect.
  const redirectPath = `/api/operator/cli?redirect=${randomUUID()}`;
  const otherHits: string[] = [];
  const other = createHttpServer((incoming, outgoing) => {
    if (incoming.url === redirectPath)
      otherHits.push(String(incoming.headers.authorization));
    outgoing.end("{}");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const redirect = createHttpServer((_incoming, outgoing) =>
    outgoing
      .writeHead(307, {
        location: `http://127.0.0.1:${(other.address() as { port: number }).port}${redirectPath}`,
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
  assert.equal(r.code, 5, r.detail);
  assert.match(r.err, /redirect-rejected/, r.detail);
  assert.deepEqual(otherHits, []);
  const stored = readFileSync(join(config, "connections.json"), "utf8");
  for (const token of [read.token, remoteToken.token])
    assert.ok(!stored.includes(token));
});
