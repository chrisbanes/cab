import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const entry = resolve("dist/test/fixtures/service-entry.js");
const secret = "fixture-entry-secret-1185";

async function run(mode: string, signal?: NodeJS.Signals) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-entry-")));
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  try {
    const child = spawn(process.execPath, [entry, mode, "serve", data], {
      env: { ...process.env, FIXTURE_SECRET: secret },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let signalled = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (signal && !signalled && stderr.includes('"service-start"')) {
        signalled = true;
        child.kill(signal);
      }
    });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`entry fixture ${mode} did not exit`));
      }, 20000);
      child.once("exit", (status) => {
        clearTimeout(timer);
        resolveExit(status);
      });
    });
    const lines = stderr.split("\n").filter(Boolean);
    return {
      code,
      stdout,
      stderr,
      lines,
      records: lines.map((l) => JSON.parse(l)),
      data,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("serve logs one start line and one signal exit line, and exits successfully", async () => {
  const { code, stdout, records } = await run("signal", "SIGTERM");
  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.equal(records.length, 2);
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(records[0].event, "service-start");
  assert.equal(records[0].version, version);
  assert.equal(records[0].mode, "serve");
  assert.equal(records[0].port, null);
  assert.match(records[0].serviceId, /^[0-9a-f-]{36}$/);
  assert.equal(records[1].event, "service-exit");
  assert.equal(records[1].reason, "signal");
  assert.equal(records[1].signal, "SIGTERM");
});

for (const [mode, label] of [
  ["uncaught", "an uncaught exception"],
  ["rejection", "an unhandled rejection"],
] as const) {
  test(`${label} writes one sanitised crash line and exits unsuccessfully`, async () => {
    const { code, stderr, lines, records, data } = await run(mode);
    assert.notEqual(code, 0);
    assert.ok(
      lines.every((line) => line.startsWith("{")),
      "no default stack",
    );
    assert.deepEqual(
      records.map((record) => record.event),
      ["service-start", "service-exit"],
    );
    assert.equal(records[1].reason, "crash");
    assert.equal(records[1].error.redaction, "applied");
    assert.equal(stderr.includes(secret), false);
    assert.equal(stderr.includes(data), false);
  });
}

test("an error escaping the entry point writes the identifier-only crash line", async () => {
  const { code, stderr, lines, records } = await run("start-failure");
  assert.notEqual(code, 0);
  assert.equal(lines.length, 1);
  assert.equal(records[0].event, "service-exit");
  assert.equal(records[0].reason, "crash");
  assert.deepEqual(Object.keys(records[0].error).sort(), ["name", "redaction"]);
  assert.equal(records[0].error.redaction, "unavailable");
  assert.equal(stderr.includes(secret), false);
});

test("a crash exits even when cleanup leaves a referenced handle open", async () => {
  const { code, records } = await run("open-handle");
  assert.equal(code, 1);
  assert.equal(records.at(-1).reason, "crash");
});
