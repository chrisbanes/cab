import assert from "node:assert/strict";
import { test } from "node:test";
import {
  maxErrorCauseDepth,
  maxErrorMessageBytes,
  maxErrorStackFrameBytes,
  maxErrorStackFrames,
  sanitizeError,
  ServiceLog,
} from "../../src/standalone/service-log.js";

const secret = "fixture-secret-value-1185";
const privatePath = "/private/fixture/data";

function leaky(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? {} : { cause });
  error.stack = `Error: ${message}\n    at read (${privatePath}/a.js:1:1)\n    at ${secret} (x.js:2:2)`;
  return error;
}

test("an error's message, stack and causes lose exclusion values and private paths", () => {
  const error = Object.assign(
    leaky(
      `failed with ${secret} in ${privatePath}`,
      leaky(`inner ${secret}`, leaky(`root ${privatePath}`)),
    ),
    { code: "E_FIXTURE" },
  );
  const record = sanitizeError(error, [secret, privatePath]);
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /fixture-secret-value-1185|\/private\/fixture/);
  assert.match(text, /\[redacted\]/);
  assert.equal(record.name, "Error");
  assert.equal(record.code, "E_FIXTURE");
  assert.equal(record.redaction, "applied");
  assert.equal(record.cause?.cause?.redaction, "applied");
});

test("a token= assignment is redacted even without an exclusion entry", () => {
  const record = sanitizeError(
    new Error(`poll failed token=ghp_${"a1".repeat(18)}`),
    [],
  );
  assert.doesNotMatch(JSON.stringify(record), /ghp_/);
});

test("without exclusions only identifier-shaped name and code remain", () => {
  const error = Object.assign(leaky(`secret ${secret}`), { code: 42 });
  const record = sanitizeError(error, undefined);
  assert.deepEqual(record, {
    name: "Error",
    code: 42,
    redaction: "unavailable",
  });
  assert.deepEqual(
    Object.keys(sanitizeError(new Error("x"), undefined)).sort(),
    ["name", "redaction"],
  );
});

test("message, stack frames and cause depth are bounded", () => {
  let chain: Error = leaky("root");
  for (let depth = 0; depth < 6; depth++) chain = leaky("link", chain);
  const wide = new Error("x".repeat(10 * 1024), { cause: chain });
  wide.stack = `Error: x\n${Array.from({ length: 50 }, () => `    at frame ${"y".repeat(2000)}`).join("\n")}`;
  const record = sanitizeError(wide, [secret]);
  assert.ok(Buffer.byteLength(record.message ?? "") <= maxErrorMessageBytes);
  assert.equal(record.messageTruncated, true);
  assert.equal(record.stack?.length, maxErrorStackFrames);
  for (const frame of record.stack ?? [])
    assert.ok(Buffer.byteLength(frame) <= maxErrorStackFrameBytes);
  let depth = 0;
  let node = record;
  while (node.cause) {
    node = node.cause;
    depth++;
  }
  assert.equal(depth, maxErrorCauseDepth);
  assert.equal(node.causeOmitted, true);

  const huge = sanitizeError(new Error(`${secret}${"z".repeat(70 * 1024)}`), [
    secret,
  ]);
  assert.equal(huge.message, undefined);
  assert.doesNotMatch(JSON.stringify(huge), /fixture-secret/);
});

test("hostile names, codes and non-Error throwables fall back", () => {
  const hostile = Object.assign(new Error("m"), {
    name: `Bad ${secret}\n`,
    code: `${secret} with spaces`,
  });
  assert.deepEqual(sanitizeError(hostile, [secret]).name, "Error");
  assert.equal(sanitizeError(hostile, [secret]).code, undefined);
  assert.deepEqual(sanitizeError(`thrown ${secret}`, [secret]), {
    name: "NonError",
    redaction: "applied",
  });
  assert.equal(
    sanitizeError(
      new Proxy(new Error("x"), {
        get() {
          throw new Error(secret);
        },
      }),
      [secret],
    ).redaction,
    "unavailable",
  );
});

test("a service log writes one exit line and survives a failing writer", () => {
  const lines: string[] = [];
  const log = new ServiceLog((line) => void lines.push(line));
  log.attach({ failureExclusions: () => [secret] });
  log.exited({ reason: "crash", error: new Error(secret) });
  log.exited({ reason: "signal", signal: "SIGTERM" });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /fixture-secret/);
  assert.equal(JSON.parse(lines[0] ?? "").reason, "crash");

  const broken = new ServiceLog(() => {
    throw new Error("stderr closed");
  });
  broken.started({ version: "1", mode: "serve", port: null, serviceId: "s" });
  broken.failure("service-shutdown", new Error("x"));
  broken.exited({ reason: "shutdown-failure" });
});

test("a credential placed in name or code is dropped, with or without a usable list", () => {
  const token = "ghp_fixtureTokenInNameOrCode1185";
  const error = Object.assign(new Error("m"), { name: token, code: token });
  const lists: [string, readonly string[] | undefined][] = [
    ["applied", [token]],
    // 129 values exceed the sanitiser's bound, so the list is unusable.
    ["unusable", [token, ...Array.from({ length: 128 }, (_, i) => `v${i}`)]],
    ["absent", undefined],
  ];
  for (const [label, exclusions] of lists) {
    const record = sanitizeError(error, exclusions);
    if (label === "absent") {
      // Nothing is known to exclude: the identifier-shaped value stays.
      assert.equal(record.code, token);
      continue;
    }
    assert.doesNotMatch(JSON.stringify(record), /ghp_fixture/, label);
    assert.equal(record.name, "Error", label);
    assert.equal(record.code, undefined, label);
  }
  const numeric = Object.assign(new Error("m"), { code: 424242 });
  assert.equal(sanitizeError(numeric, ["424242"]).code, undefined);
  const anchored = Object.assign(new Error("m"), { code: "token:abc123" });
  assert.equal(sanitizeError(anchored, undefined).code, undefined);
});
