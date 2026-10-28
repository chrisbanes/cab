import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { tmpdir } from "../fixtures/temp.js";

const release = (await import(
  pathToFileURL(resolve("scripts/package-release.mjs")).href
)) as {
  launcher: string;
  nodeChecksum(shasumsText: string, fileName: string): string;
  downloadVerifiedNode(options: {
    version: string;
    directory: string;
    fetch: (url: string) => Promise<Response>;
  }): Promise<{ nodeDirectory: string; sha256: string }>;
  treeDigest(root: string): Promise<string>;
  checkTag(tag: string, version: string): void;
  checkOperatorUi(
    origin: string,
    child: { exitCode: number | null; signalCode: string | null },
    deadline: number,
    requestMs?: number,
  ): Promise<string>;
};

const VERSION = "24.21.0";
const NAME = `node-v${VERSION}-darwin-arm64`;
const hex = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

function temp(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cab-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("nodeChecksum accepts exactly one entry for the exact file name", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const text = `${a}  ${NAME}.tar.gz\n${b}  ${NAME}.tar.xz\n`;
  assert.equal(release.nodeChecksum(text, `${NAME}.tar.gz`), a);
  assert.throws(() => release.nodeChecksum(text, `${NAME}.pkg`));
  assert.throws(() =>
    release.nodeChecksum(`${b}  ${NAME}.tar.xz\n`, `${NAME}.tar.gz`),
  );
  assert.throws(() =>
    release.nodeChecksum(`${text}${a}  ${NAME}.tar.gz\n`, `${NAME}.tar.gz`),
  );
});

test("downloadVerifiedNode verifies before extracting and fails closed", async (t) => {
  const dir = temp(t);
  const fixture = join(dir, "fixture");
  mkdirSync(join(fixture, NAME, "bin"), { recursive: true });
  writeFileSync(join(fixture, NAME, "bin/node"), "#!/bin/sh\n");
  writeFileSync(join(fixture, NAME, "LICENSE"), "licence\n");
  const tarball = join(dir, "node.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", fixture, NAME]);
  const bytes = readFileSync(tarball);
  const sums = `${hex(bytes)}  ${NAME}.tar.gz\n`;
  const fake =
    (body: Buffer, shasums = sums, status = 200) =>
    async (url: string) => {
      assert.ok(url.startsWith(`https://nodejs.org/dist/v${VERSION}/`));
      return url.endsWith("SHASUMS256.txt")
        ? new Response(shasums)
        : new Response(new Uint8Array(body), { status });
    };
  const attempt = (directory: string, fetch: ReturnType<typeof fake>) =>
    release.downloadVerifiedNode({ version: VERSION, directory, fetch });

  for (const [label, fetch] of [
    ["hash mismatch", fake(Buffer.concat([bytes, Buffer.from("x")]))],
    ["tarball 404", fake(bytes, sums, 404)],
    ["missing entry", fake(bytes, `${hex(bytes)}  ${NAME}.tar.xz\n`)],
    ["SHASUMS 500", async () => new Response("", { status: 500 }) as Response],
  ] as const) {
    const out = join(dir, label);
    mkdirSync(out);
    await assert.rejects(attempt(out, fetch), label);
    assert.ok(!existsSync(join(out, NAME)), `${label} left no extraction`);
    assert.ok(!existsSync(join(out, `${NAME}.tar.gz`)), label);
  }

  const out = join(dir, "ok");
  mkdirSync(out);
  const result = await attempt(out, fake(bytes));
  assert.deepEqual(result, {
    nodeDirectory: join(out, NAME),
    sha256: hex(bytes),
  });
  assert.equal(readFileSync(join(out, NAME, "LICENSE"), "utf8"), "licence\n");
  assert.ok(!existsSync(join(out, `${NAME}.tar.gz`)));
});

test("treeDigest is order independent and covers content, modes, names and links", async (t) => {
  const dir = temp(t);
  const make = (name: string, reverse = false) => {
    const root = join(dir, name);
    mkdirSync(join(root, "a/b"), { recursive: true });
    const files: [string, string][] = [
      ["a/b/one.js", "one"],
      ["a/two", "two"],
      ["a/b/manifest.json", "nested"],
    ];
    for (const [path, body] of reverse ? files.reverse() : files)
      writeFileSync(join(root, path), body);
    chmodSync(join(root, "a/two"), 0o755);
    symlinkSync("b/one.js", join(root, "a/link"));
    return root;
  };
  const base = await release.treeDigest(make("x"));
  assert.equal(await release.treeDigest(make("y", true)), base);

  const changed = async (name: string, change: (root: string) => void) => {
    const root = make(name);
    change(root);
    assert.notEqual(await release.treeDigest(root), base, name);
  };
  await changed("content", (r) => writeFileSync(join(r, "a/two"), "2"));
  await changed("mode", (r) => chmodSync(join(r, "a/two"), 0o644));
  await changed("rename", (r) =>
    renameSync(join(r, "a/two"), join(r, "a/three")),
  );
  await changed("added", (r) => writeFileSync(join(r, "a/new"), ""));
  await changed("link", (r) => {
    rmSync(join(r, "a/link"));
    symlinkSync("two", join(r, "a/link"));
  });
  await changed("nested manifest", (r) =>
    writeFileSync(join(r, "a/b/manifest.json"), "other"),
  );

  const root = make("root manifest");
  writeFileSync(join(root, "manifest.json"), "{}");
  assert.equal(await release.treeDigest(root), base);

  const fifo = make("fifo");
  execFileSync("mkfifo", [join(fifo, "a/pipe")]);
  await assert.rejects(release.treeDigest(fifo), /Unsupported file type/);
});

test("checkTag accepts only v plus the package version", () => {
  release.checkTag("v0.1.0", "0.1.0");
  assert.throws(() => release.checkTag("v0.1.1", "0.1.0"));
  assert.throws(() => release.checkTag("0.1.0", "0.1.0"));
});

test("the launcher runs the bundled Node from a path with spaces", (t) => {
  const root = join(temp(t), "Application Support", "cab 0.1.0");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "node/bin"), { recursive: true });
  writeFileSync(join(root, "bin/cab"), release.launcher, { mode: 0o755 });
  writeFileSync(
    join(root, "node/bin/node"),
    `#!/bin/sh\nprintf '%s\\n' "$@"\n`,
    { mode: 0o755 },
  );
  const out = execFileSync(join(root, "bin/cab"), ["--version"], {
    encoding: "utf8",
  });
  assert.equal(out, `${root}/dist/src/cli/main.js\n--version\n`);
});

test("checkOperatorUi fails within its request bound when an asset stalls", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/app")
      response.end('<script src="/assets/index.js"></script>');
    // The asset request never receives a response.
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.closeAllConnections());
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const started = Date.now();
  await assert.rejects(
    release.checkOperatorUi(
      origin,
      { exitCode: null, signalCode: null },
      Date.now() + 60_000,
      200,
    ),
    { name: "TimeoutError" },
  );
  assert.ok(Date.now() - started < 5000);
});

test("checkOperatorUi requires the push worker at /app/ with the right headers", async (t) => {
  const good = {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    } as Record<string, string>,
    body: 'self.addEventListener("push", () => {});',
  };
  let worker = good;
  const server = createServer((request, response) => {
    if (request.url === "/app")
      response.end('<script src="/assets/index.js"></script>');
    else if (request.url === "/assets/index.js") response.end("");
    else if (request.url === "/app/service-worker.js") {
      response.writeHead(worker.status, worker.headers);
      response.end(worker.body);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.closeAllConnections());
  t.after(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const check = () =>
    release.checkOperatorUi(
      origin,
      { exitCode: null, signalCode: null },
      Date.now() + 60_000,
    );
  assert.equal(await check(), "/assets/index.js");
  worker = {
    ...good,
    headers: { ...good.headers, "service-worker-allowed": "/app/" },
  };
  assert.equal(await check(), "/assets/index.js");
  const bad: [RegExp, typeof good][] = [
    [/status 404/, { ...good, status: 404 }],
    [
      /non-JavaScript/,
      { ...good, headers: { ...good.headers, "content-type": "text/html" } },
    ],
    [
      /cacheable/,
      { ...good, headers: { ...good.headers, "cache-control": "max-age=60" } },
    ],
    [
      /wider than \/app\//,
      { ...good, headers: { ...good.headers, "service-worker-allowed": "/" } },
    ],
    [/no push handler/, { ...good, body: "// empty" }],
  ];
  for (const [message, served] of bad) {
    worker = served;
    await assert.rejects(check(), message);
  }
});
