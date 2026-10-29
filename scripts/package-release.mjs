#!/usr/bin/env node
// Builds and verifies the darwin-arm64 release tarball and packs and verifies the npm
// package (ADR-1011); see "Release build" and "Tagged releases" in
// docs/operations/standalone-macos.md.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PLATFORM = "darwin-arm64";
const SDK_PLATFORM_PREFIX = "claude-agent-sdk-";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const launcher = `#!/bin/sh
root=$(cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1
exec "$root/node/bin/node" "$root/dist/src/cli/main.js" "$@"
`;

/** The single SHASUMS256.txt hash for exactly `fileName`, or throw. */
export function nodeChecksum(shasumsText, fileName) {
  const matches = shasumsText
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 2 && fields[1] === fileName);
  if (matches.length !== 1 || !/^[0-9a-f]{64}$/.test(matches[0][0]))
    throw new Error(
      `Expected one SHASUMS256.txt entry for ${fileName}, found ${matches.length}`,
    );
  return matches[0][0];
}

async function download(fetchFn, url) {
  const response = await fetchFn(url);
  if (response.status !== 200)
    throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download the official darwin-arm64 Node tarball, verify it against the
 * published SHASUMS256.txt and only then extract it. There is no bypass.
 */
export async function downloadVerifiedNode({
  version,
  directory,
  fetch: fetchFn = fetch,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Invalid Node version ${version}`);
  const name = `node-v${version}-${PLATFORM}`;
  const base = `https://nodejs.org/dist/v${version}`;
  const tarball = join(directory, `${name}.tar.gz`);
  try {
    const expected = nodeChecksum(
      (await download(fetchFn, `${base}/SHASUMS256.txt`)).toString("utf8"),
      `${name}.tar.gz`,
    );
    const bytes = await download(fetchFn, `${base}/${name}.tar.gz`);
    const actual = sha256(bytes);
    if (actual !== expected)
      throw new Error(
        `${name}.tar.gz sha256 ${actual} does not match ${expected}`,
      );
    await writeFile(tarball, bytes);
    await run("tar", ["-xzf", tarball, "-C", directory]);
    return { nodeDirectory: join(directory, name), sha256: actual };
  } catch (error) {
    await rm(join(directory, name), { recursive: true, force: true });
    throw error;
  } finally {
    await rm(tarball, { force: true });
  }
}

/** cab-tree-sha256/v1 over a release root, excluding the root manifest.json. */
export async function treeDigest(root) {
  const lines = [];
  const walk = async (relative) => {
    for (const entry of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${entry}` : entry;
      if (path === "manifest.json") continue;
      if (path.includes("\n")) throw new Error(`Unsupported path ${path}`);
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isSymbolicLink())
        lines.push([path, `link ${await readlink(full)} ${path}\n`]);
      else if (stat.isFile())
        lines.push([
          path,
          `file ${stat.mode & 0o111 ? "0755" : "0644"} ${sha256(await readFile(full))} ${path}\n`,
        ]);
      else throw new Error(`Unsupported file type at ${path}`);
    }
  };
  await walk("");
  lines.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha256(lines.map(([, line]) => line).join(""));
}

export function checkTag(tag, version) {
  if (tag !== `v${version}`)
    throw new Error(
      `Tag ${tag} does not match package.json version ${version}`,
    );
}

/** Fail if any SDK platform package or lockfile dev-only package is installed. */
async function assertProductionTree(root) {
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  const scope = join(root, "node_modules/@anthropic-ai");
  const found = [
    ...(existsSync(scope) ? await readdir(scope) : [])
      .filter((name) => name.startsWith(SDK_PLATFORM_PREFIX))
      .map((name) => `node_modules/@anthropic-ai/${name}`),
    ...Object.entries(lock.packages)
      .filter(
        ([path, entry]) => path && entry.dev && existsSync(join(root, path)),
      )
      .map(([path]) => path),
  ];
  if (found.length)
    throw new Error(`Release contains forbidden packages: ${found.join(", ")}`);
}

const git = async (...args) => (await run("git", args)).stdout.trim();

async function runInherited(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const [code, signal] = await once(child, "exit");
  if (code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`);
}

/** Private state directories beside the default builds directory. */
async function prepareDefaultRoot(root) {
  const dirs = [
    root,
    ...["builds", "data", "auth", "snapshots"].map((d) => join(root, d)),
  ];
  // The service rejects symlinked state paths, and chmod would follow one.
  await mkdir(dirname(root), { recursive: true });
  if (realpathSync(dirname(root)) !== dirname(root))
    throw new Error(`${dirname(root)} must not contain symlinks`);
  for (const dir of dirs) {
    if ((await lstat(dir).catch(() => undefined))?.isSymbolicLink())
      throw new Error(`${dir} must not be a symlink`);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700);
  }
}

async function build(commit, out) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(`Release builds need a ${PLATFORM} host`);
  const sha = await git("rev-parse", "--verify", `${commit}^{commit}`);
  const pkg = JSON.parse(await git("show", `${sha}:package.json`));
  // Commits before the .nvmrc rename pin Node in .node-version.
  const nodeVersion = await git("show", `${sha}:.nvmrc`).catch(() =>
    git("show", `${sha}:.node-version`),
  );
  const root = join(homedir(), ".config/cab-dev");
  const output = resolve(out ?? join(root, "builds", sha));
  const partial = `${output}.partial`;
  for (const path of [output, partial])
    if (existsSync(path))
      throw new Error(`${path} already exists; remove it to rebuild`);
  if (!out) await prepareDefaultRoot(root);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(partial);
  try {
    const source = join(partial, "source");
    const work = join(partial, "work");
    await mkdir(source);
    await mkdir(work);
    await run("git", ["archive", "-o", join(work, "source.tar"), sha]);
    await run("tar", ["-xf", join(work, "source.tar"), "-C", source]);
    const node = await downloadVerifiedNode({
      version: nodeVersion,
      directory: work,
    });
    const reported = (
      await run(join(node.nodeDirectory, "bin/node"), ["--version"])
    ).stdout.trim();
    if (reported !== `v${nodeVersion}`)
      throw new Error(
        `Downloaded Node reports ${reported}, expected v${nodeVersion}`,
      );
    await runInherited(
      "npx",
      [
        "--yes",
        "--package",
        pkg.packageManager,
        "-c",
        "npm --version && npm ci && npm run build && npm prune --omit=dev",
      ],
      {
        cwd: source,
        env: {
          ...process.env,
          PATH: `${join(node.nodeDirectory, "bin")}:${process.env.PATH}`,
          // Ignore ~/.npmrc like CI, which has none: npm 12 rejects a user-level
          // allow-scripts in project installs, even when cleared through the environment.
          NPM_CONFIG_USERCONFIG: "/dev/null",
        },
      },
    );
    const scope = join(source, "node_modules/@anthropic-ai");
    for (const name of await readdir(scope))
      if (name.startsWith(SDK_PLATFORM_PREFIX))
        await rm(join(scope, name), { recursive: true });
    // Prune leaves empty scope directories such as node_modules/@biomejs.
    await run("find", [
      join(source, "node_modules"),
      "-type",
      "d",
      "-empty",
      "-delete",
    ]);
    await assertProductionTree(source);

    const name = `${basename(pkg.name)}-${pkg.version}-${PLATFORM}`;
    const release = join(partial, name);
    for (const path of [
      "dist/src",
      "dist/operator",
      "node_modules",
      "package.json",
      "package-lock.json",
      "LICENSE",
    ])
      await cp(join(source, path), join(release, path), {
        recursive: true,
        verbatimSymlinks: true,
      });
    for (const path of ["bin/node", "LICENSE"])
      await cp(join(node.nodeDirectory, path), join(release, "node", path));
    await mkdir(join(release, "bin"));
    await writeFile(join(release, "bin/cab"), launcher, { mode: 0o755 });
    const manifest = `${JSON.stringify(
      {
        schema: "cab.release/v1",
        name: pkg.name,
        version: pkg.version,
        platform: PLATFORM,
        commit: sha,
        node: { version: nodeVersion, sha256: node.sha256 },
        tree: {
          algorithm: "cab-tree-sha256/v1",
          digest: await treeDigest(release),
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(join(release, "manifest.json"), manifest);
    await writeFile(join(partial, "manifest.json"), manifest);
    const tarball = `${name}.tar.gz`;
    // COPYFILE_DISABLE stops macOS tar adding AppleDouble ._ entries for xattrs.
    await run("tar", ["-czf", join(partial, tarball), "-C", partial, name], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const sums = await Promise.all(
      [tarball, "manifest.json"].map(
        async (file) =>
          `${sha256(await readFile(join(partial, file)))}  ${file}\n`,
      ),
    );
    await writeFile(join(partial, "SHA256SUMS"), sums.join(""));
    await rm(source, { recursive: true });
    await rm(work, { recursive: true });
    await rename(partial, output);
    const releaseRoot = join(output, name);
    process.stdout.write(`Built ${sha}
Tarball: ${join(output, tarball)}
Release: ${releaseRoot}
Tree digest: ${JSON.parse(manifest).tree.digest}
${
  out
    ? ""
    : `Start:
  CAB_OPERATOR_AUTH_FILE="${root}/auth/operator-auth.json" \\
  CAB_OPERATOR_ORIGIN=http://127.0.0.1:8787 \\
  "${releaseRoot}/node/bin/node" "${releaseRoot}/dist/src/standalone/cli.js" operator "${root}/data" 8787
`
}`);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

async function checkSums(directory, required) {
  const path = join(directory, "SHA256SUMS");
  if (!existsSync(path)) return;
  const entries = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split(/ {2}/));
  if (!entries.some(([, file]) => file === required))
    throw new Error(`SHA256SUMS does not list ${required}`);
  for (const [hash, file] of entries)
    if (sha256(await readFile(join(directory, file))) !== hash)
      throw new Error(`SHA256SUMS mismatch for ${file}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

export const fakeCodex = [
  "import { createInterface } from 'node:readline';",
  "const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
  "for await (const line of createInterface({ input: process.stdin })) {",
  "  const message = JSON.parse(line);",
  "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
  "  else if (message.method === 'account/read') write({ id: message.id, result: { account: { type: 'chatgpt' } } });",
  "  else if (message.method === 'config/read') write({ id: message.id, result: { config: { approval_policy: 'never', sandbox_mode: 'workspace-write' } } });",
  "}",
].join("\n");

/**
 * Wait for the service to serve /app, then one of its assets. Every request is
 * bounded so a stalled response cannot keep verify (and the service) alive.
 */
export async function checkOperatorUi(
  origin,
  child,
  deadline,
  requestMs = 5000,
) {
  const html = await waitForApp(origin, child, deadline, requestMs);
  const asset = html.match(/\/assets\/[^"']+/)?.[0];
  if (
    !asset ||
    (
      await fetch(`${origin}${asset}`, {
        signal: AbortSignal.timeout(requestMs),
      })
    ).status !== 200
  )
    throw new Error(`Operator UI asset ${asset} was not served`);
  await checkServiceWorker(origin, requestMs);
  return asset;
}

/**
 * The push worker is optional to the service (a build without one serves a 404), so a release
 * that lost it would otherwise pass: it must be served as JavaScript, uncached, at /app/ scope.
 */
async function checkServiceWorker(origin, requestMs) {
  const response = await fetch(`${origin}/app/service-worker.js`, {
    signal: AbortSignal.timeout(requestMs),
  });
  const problem =
    response.status !== 200
      ? `status ${response.status}`
      : !/^text\/javascript/.test(response.headers.get("content-type") ?? "")
        ? "a non-JavaScript content type"
        : response.headers.get("cache-control") !== "no-store"
          ? "a cacheable response"
          : ![null, "/app/"].includes(
                response.headers.get("service-worker-allowed"),
              )
            ? "a scope wider than /app/"
            : !(await response.text()).includes('addEventListener("push"')
              ? "no push handler"
              : undefined;
  if (problem)
    throw new Error(`/app/service-worker.js was served with ${problem}`);
}

async function waitForApp(origin, child, deadline, requestMs) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Service exited (${child.signalCode ?? child.exitCode}) before serving /app`,
      );
    try {
      const response = await fetch(`${origin}/app`, {
        signal: AbortSignal.timeout(requestMs),
      });
      if (response.status === 200) return await response.text();
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Service did not serve /app within 120 s");
}

async function verify(tarballPath) {
  const tarball = resolve(tarballPath);
  await checkSums(dirname(tarball), basename(tarball));
  // The space exercises the quoted paths that the install location needs.
  const temp = await mkdtemp(join(realpathSync(tmpdir()), "cab verify-"));
  try {
    const unpacked = join(temp, "release");
    await mkdir(unpacked);
    await run("tar", ["-xzf", tarball, "-C", unpacked]);
    const [name, ...extra] = await readdir(unpacked);
    if (!name || extra.length)
      throw new Error("Tarball must contain one release directory");
    const release = join(unpacked, name);
    const manifestText = await readFile(join(release, "manifest.json"), "utf8");
    const outer = join(dirname(tarball), "manifest.json");
    if (existsSync(outer) && (await readFile(outer, "utf8")) !== manifestText)
      throw new Error(
        "manifest.json beside the tarball differs from the release's",
      );
    const manifest = JSON.parse(manifestText);
    const pkg = JSON.parse(
      await readFile(join(release, "package.json"), "utf8"),
    );
    if (
      manifest.schema !== "cab.release/v1" ||
      manifest.name !== pkg.name ||
      manifest.platform !== PLATFORM ||
      manifest.version !== pkg.version ||
      name !== `${basename(pkg.name)}-${pkg.version}-${PLATFORM}`
    )
      throw new Error("manifest.json does not describe this release");
    const digest = await treeDigest(release);
    if (digest !== manifest.tree.digest)
      throw new Error(
        `Tree digest ${digest} does not match manifest ${manifest.tree.digest}`,
      );
    await assertProductionTree(release);
    const node = join(release, "node/bin/node");
    if (
      (await run(node, ["--version"])).stdout.trim() !==
      `v${manifest.node.version}`
    )
      throw new Error("Bundled Node does not match manifest.node.version");

    const { origin, asset } = await serveAndCheck({
      temp,
      node,
      root: release,
      cab: join(release, "bin/cab"),
      version: manifest.version,
      isolatedPath: true,
    });
    process.stdout.write(
      `Verified ${name} (${manifest.commit})\nTree digest: ${digest}\nServed ${origin}/app and ${asset}\n`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Run the service from `root` on `node` with a generated fake `codex`, check its operator
 * UI and `cab --version`, and stop it. `isolatedPath` also requires that no `node` is on
 * the PATH, as for a release that bundles its own.
 */
async function serveAndCheck({ temp, node, root, cab, version, isolatedPath }) {
  const home = join(temp, "home");
  const codexDir = join(temp, "codex-bin");
  const data = join(temp, "data");
  const authFile = join(temp, "auth/operator-auth.json");
  for (const dir of [home, codexDir, dirname(authFile)])
    await mkdir(dir, { mode: 0o700 });
  await writeFile(join(codexDir, "fake-codex.mjs"), fakeCodex);
  await writeFile(
    join(codexDir, "codex"),
    `#!/bin/sh\nexec "${node}" "${join(codexDir, "fake-codex.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${codexDir}${isolatedPath ? "" : `:${dirname(node)}`}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
  };
  if (isolatedPath) {
    const nodeOnPath = await run("/bin/sh", ["-c", "command -v node"], {
      env,
    }).then(
      () => true,
      () => false,
    );
    if (nodeOnPath)
      throw new Error("node must not be on the verification PATH");
  }
  const versionLine = (await run(cab, ["--version"], { env })).stdout;
  if (versionLine !== `cab ${version}\n`)
    throw new Error(`cab --version printed ${JSON.stringify(versionLine)}`);

  const password = randomBytes(24).toString("hex");
  await run(
    node,
    [
      "--input-type=module",
      "-e",
      `const { OperatorAuth } = await import(${JSON.stringify(pathToFileURL(join(root, "dist/src/standalone/operator-auth.js")).href)});
await OperatorAuth.initialize(process.env.AUTH_FILE, process.env.PASSWORD);`,
    ],
    { env: { ...env, AUTH_FILE: authFile, PASSWORD: password } },
  );
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    node,
    [join(root, "dist/src/standalone/cli.js"), "operator", data, String(port)],
    {
      env: {
        ...env,
        CAB_OPERATOR_AUTH_FILE: authFile,
        CAB_OPERATOR_ORIGIN: origin,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  try {
    const asset = await checkOperatorUi(origin, child, Date.now() + 120_000);
    return { origin, asset };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      await exited;
      clearTimeout(timer);
    }
  }
}

const sri = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * Pack `HEAD` as the npm package: a clean `npm ci` and build of the archived commit, one
 * `npm pack`, and `npm-package.json`, which records the exact bytes later published.
 */
async function packNpm(out) {
  const sha = await git("rev-parse", "--verify", "HEAD^{commit}");
  const pkg = JSON.parse(await git("show", `${sha}:package.json`));
  const output = resolve(out);
  const work = await mkdtemp(join(realpathSync(tmpdir()), "cab-pack-npm-"));
  try {
    const source = join(work, "source");
    await mkdir(source);
    await run("git", ["archive", "-o", join(work, "source.tar"), sha]);
    await run("tar", ["-xf", join(work, "source.tar"), "-C", source]);
    await mkdir(output, { recursive: true });
    // Ignore ~/.npmrc like CI (see build).
    const env = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" };
    const npm = (script) => [
      "--yes",
      "--package",
      pkg.packageManager,
      "-c",
      script,
    ];
    await runInherited("npx", npm("npm --version && npm ci && npm run build"), {
      cwd: source,
      env,
    });
    const packed = await run(
      "npx",
      npm(`npm pack --ignore-scripts --json --pack-destination "${output}"`),
      { cwd: source, env },
    );
    // npm 11 prints an array of pack results; npm 12 keys them by package name.
    const results = JSON.parse(packed.stdout);
    const [result, ...extra] = Array.isArray(results)
      ? results
      : Object.values(results);
    if (!result || extra.length)
      throw new Error("npm pack did not report exactly one package");
    const tarball = join(output, result.filename);
    const record = {
      name: result.name,
      version: result.version,
      integrity: sri(await readFile(tarball)),
      shasum: result.shasum,
      filename: result.filename,
      commit: sha,
    };
    if (record.name !== pkg.name || record.integrity !== result.integrity)
      throw new Error("npm pack output does not describe the packed file");
    await writeFile(
      join(output, "npm-package.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    process.stdout.write(
      `Packed ${record.name}@${record.version} (${sha})\nPackage: ${tarball}\nIntegrity: ${record.integrity}\n`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Check that `tarball` is the file `npm-package.json` beside it describes, and fail closed
 * on any difference. Returns the record.
 */
export async function checkNpmRecord(tarball) {
  const path = resolve(tarball);
  const bytes = await readFile(path);
  const record = JSON.parse(
    await readFile(join(dirname(path), "npm-package.json"), "utf8"),
  );
  const unpacked = await mkdtemp(
    join(realpathSync(tmpdir()), "cab-npm-record-"),
  );
  try {
    await run("tar", ["-xzf", path, "-C", unpacked, "package/package.json"]);
    const pkg = JSON.parse(
      await readFile(join(unpacked, "package/package.json"), "utf8"),
    );
    const problems = [
      ["integrity", record.integrity, sri(bytes)],
      ["shasum", record.shasum, createHash("sha1").update(bytes).digest("hex")],
      ["filename", record.filename, basename(path)],
      ["name", record.name, pkg.name],
      ["version", record.version, pkg.version],
    ].filter(([, recorded, actual]) => recorded !== actual);
    if (problems.length)
      throw new Error(
        `npm-package.json does not describe ${basename(path)}: ${problems.map(([field]) => field).join(", ")}`,
      );
    return record;
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
}

/** Install the packed package globally into a temporary prefix and HOME, then serve its UI. */
async function verifyNpm(tarballPath) {
  const tarball = resolve(tarballPath);
  const record = await checkNpmRecord(tarball);
  const temp = await mkdtemp(join(realpathSync(tmpdir()), "cab verify-npm-"));
  try {
    const prefix = join(temp, "prefix");
    const home = join(temp, "npm-home");
    await mkdir(home, { mode: 0o700 });
    await run(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--prefer-offline",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      {
        env: { ...process.env, HOME: home, NPM_CONFIG_USERCONFIG: "/dev/null" },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const root = join(prefix, "lib/node_modules", record.name);
    // The install must not have started anything or created service state.
    if (existsSync(join(home, "Library")))
      throw new Error("Installing the package created service state");
    const { origin, asset } = await serveAndCheck({
      temp,
      node: realpathSync(process.execPath),
      root,
      cab: join(prefix, "bin/cab"),
      version: record.version,
      isolatedPath: false,
    });
    process.stdout.write(
      `Verified ${record.name}@${record.version} (${record.commit})\nIntegrity: ${record.integrity}\nServed ${origin}/app and ${asset}\n`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function cli([command, arg, ...rest]) {
  if (
    command === "build" &&
    arg &&
    (rest.length === 0 || (rest[0] === "--out" && rest[1] && rest.length === 2))
  )
    return build(arg, rest[1]);
  if (command === "verify" && arg && rest.length === 0) return verify(arg);
  if (command === "pack-npm" && arg === "--out" && rest.length === 1)
    return packNpm(rest[0]);
  if (command === "check-npm" && arg && rest.length === 0)
    return void (await checkNpmRecord(arg));
  if (command === "verify-npm" && arg && rest.length === 0)
    return verifyNpm(arg);
  if (command === "check-tag" && arg && rest.length === 0) {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    return checkTag(arg, pkg.version);
  }
  throw new Error(
    "Usage: package-release.mjs build COMMIT [--out DIR] | verify TARBALL | pack-npm --out DIR | verify-npm TGZ | check-npm TGZ | check-tag TAG",
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
