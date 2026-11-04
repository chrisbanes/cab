import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { main } from "../../src/standalone/cli.js";
import { OperatorAuth } from "../../src/standalone/operator-auth.js";
import { OperatorWebBundle } from "../../src/standalone/operator-web.js";
import { StandaloneService } from "../../src/standalone/service.js";

for (const invalid of [false, true]) {
  test(`operator refuses a ${invalid ? "invalid" : "missing"} bundle before constructing or starting the service`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cab-bundle-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bundlePath = join(root, "bundle");
    if (invalid) {
      await mkdir(join(bundlePath, "assets"), { recursive: true });
      await writeFile(
        join(bundlePath, "index.html"),
        '<script src="/assets/missing.js"></script>',
      );
    }
    const open = OperatorWebBundle.open.bind(OperatorWebBundle);
    t.mock.method(OperatorWebBundle, "open", () => open(bundlePath));
    let diagnostic = "";
    t.mock.method(process.stderr, "write", (chunk: string) => {
      diagnostic += chunk;
      return true;
    });
    let constructed = false;
    await assert.rejects(
      main(["operator", join(root, "data")], () => {
        constructed = true;
        throw new Error("service must not be constructed");
      }),
      /^Error: operator web UI not built; run npm run build:web$/,
    );
    assert.equal(constructed, false);
    assert.equal(
      diagnostic,
      "operator web UI not built; run npm run build:web\n",
    );
  });
}

test("a valid operator bundle reaches the real service-start seam", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cab-bundle-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, "bundle");
  await mkdir(join(bundlePath, "assets"), { recursive: true });
  await writeFile(join(bundlePath, "index.html"), "<html></html>");
  const open = OperatorWebBundle.open.bind(OperatorWebBundle);
  const steps: string[] = [];
  t.mock.method(OperatorWebBundle, "open", async () => {
    const bundle = await open(bundlePath);
    steps.push("bundle-validated");
    return bundle;
  });
  const authFile = join(root, "auth.json");
  await OperatorAuth.initialize(authFile, "fixture-password");
  const auth = await OperatorAuth.open({
    authFile,
    origin: "http://127.0.0.1:4799",
  });
  t.mock.method(OperatorAuth, "open", async () => auth);
  const service = new StandaloneService(join(root, "data"));
  const sentinel = new Error("service-start reached");
  let started = false;
  t.mock.method(service, "start", async () => {
    started = true;
    steps.push("service-start");
    throw sentinel;
  });
  t.mock.method(service, "stop", async () => {});
  await assert.rejects(
    main(["operator", join(root, "data")], () => {
      steps.push("service-constructed");
      return service;
    }),
    sentinel,
  );
  assert.equal(started, true);
  assert.deepEqual(steps, [
    "bundle-validated",
    "service-constructed",
    "service-start",
  ]);
});

for (const invalid of [false, true]) {
  test(`operator process exits nonzero for a ${invalid ? "invalid" : "missing"} bundle without service startup`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cab-bundle-entry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bundle = join(root, "bundle");
    if (invalid) {
      await mkdir(join(bundle, "assets"), { recursive: true });
      await writeFile(
        join(bundle, "index.html"),
        '<script src="/assets/missing.js"></script>',
      );
    }
    const child = spawn(
      process.execPath,
      [
        resolve("dist/test/fixtures/service-entry.js"),
        "bundle-preflight",
        "operator",
        join(root, "data"),
      ],
      {
        env: { ...process.env, FIXTURE_BUNDLE: bundle },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("bundle preflight fixture did not exit"));
      }, 20000);
      child.once("error", reject);
      child.once("close", (status) => {
        clearTimeout(timer);
        resolveExit(status);
      });
    });
    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /operator web UI not built; run npm run build:web/);
    assert.doesNotMatch(stderr, /ENOENT|unavailable asset/);
  });
}
