import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeTokenCheckSchema,
  readinessSchema,
} from "../../src/operator/readiness.js";
import { CodexRuntime } from "../../src/standalone/codex.js";
import type { Runtime } from "../../src/standalone/codex.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import { harness } from "../fixtures/cli-harness.js";
import { startCliService } from "../fixtures/operator-cli.js";
import {
  ClaudeShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";
import { tmpdir } from "../fixtures/temp.js";

const READINESS = "/api/operator/readiness";
const TOKEN_CHECK = "/api/operator/readiness/claude-token";
const paths = [READINESS, TOKEN_CHECK];

test("both readiness reads are served on the cookie and bearer paths", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read");
  const write = await s.issue("read-write");
  for (const [path, schema] of [
    [READINESS, readinessSchema],
    [TOKEN_CHECK, claudeTokenCheckSchema],
  ] as const) {
    const cookie = await s.sessionGet(path);
    assert.equal(cookie.status, 200, path);
    schema.parse(await cookie.json());
    for (const token of [read.token, write.token]) {
      const bearer = await s.bearer(token, path);
      assert.equal(bearer.status, 200, path);
      schema.parse(await bearer.json());
    }
  }
});

test("anonymous, POST and query reads are refused like other status routes", async (t) => {
  const s = await startCliService(t);
  const anonymous = await fetch(`${s.origin}/api/operator/claude-token`);
  assert.ok(anonymous.status === 401 || anonymous.status === 403);
  for (const path of paths) {
    const denied = await fetch(`${s.origin}${path}`);
    assert.equal(denied.status, anonymous.status, path);
    const post = await s.sessionPost(path, {});
    assert.equal(post.status, 405, path);
    const query = await s.sessionGet(`${path}?verbose=1`);
    assert.equal(query.status, 400, path);
  }
});

test("reading readiness changes no persisted state and runs no model turn", async (t) => {
  const s = await startCliService(t);
  const read = await s.issue("read");
  const before = databaseDigest(s.f);
  for (let i = 0; i < 5; i++)
    for (const path of paths)
      assert.equal((await s.bearer(read.token, path)).status, 200);
  assert.equal(databaseDigest(s.f), before);
  assert.equal(s.f.runtime.turns, 0);
  assert.equal(s.f.runtime.loginVerifications, 5, "one per full read");
});

test("the readiness read reports a Claude token the service cannot use without its path", async (t) => {
  const s = await startCliService(t, {
    service: { runtimeHarnesses: ["codex", "claude"] },
  });
  const root = mkdtempSync(join(tmpdir(), "ensemble-ready-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenPath = join(root, "claude-token");
  writeFileSync(tokenPath, "ready-http-canary-token-9031\n");
  chmodSync(tokenPath, 0o644);
  s.f.service.domain().execute({
    type: "claude-token.configure",
    key: crypto.randomUUID(),
    actor: "operator",
    credentialRef: `file:${tokenPath}`,
  });
  const read = await s.issue("read");
  const response = await s.bearer(read.token, TOKEN_CHECK);
  const text = await response.text();
  const check = claudeTokenCheckSchema.parse(JSON.parse(text)).data;
  assert.equal(check.status, "fail");
  assert.equal(check.reason, "Token file permits group or other access");
  assert.ok(!text.includes(tokenPath));
  assert.ok(!text.includes("ready-http-canary-token-9031"));
});

test("verifyCodexLogin asks the App Server for account and config only", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-ready-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "fake-codex.mjs");
  const log = join(root, "methods.log");
  writeFileSync(
    executable,
    String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  appendFileSync(${JSON.stringify(log)}, message.method + "\n");
  let result = {};
  if (message.method === "account/read") result = existsSync(${JSON.stringify(join(root, "signed-out"))}) ? {account: null} : {account: {type: "chatgpt"}};
  if (message.method === "config/read") result = {config: {approval_policy: existsSync(${JSON.stringify(join(root, "policy"))}) ? "on-request" : "never", sandbox_mode: "workspace-write"}};
  process.stdout.write(JSON.stringify({id: message.id, result}) + "\n");
}
`,
  );
  chmodSync(executable, 0o700);
  const service = new StandaloneService(
    join(root, "data"),
    (context) => new CodexRuntime(executable, context),
    undefined,
    { power: { enabled: false } },
  );
  await service.start();
  t.after(() => service.stop());
  writeFileSync(log, "");
  assert.equal(await service.verifyCodexLogin(), "verified");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "account/read",
    "config/read",
  ]);

  // A policy mismatch is told apart from a missing login.
  writeFileSync(join(root, "policy"), "");
  assert.equal(await service.verifyCodexLogin(), "policy");
  rmSync(join(root, "policy"));
  writeFileSync(join(root, "signed-out"), "");
  assert.equal(await service.verifyCodexLogin(), "failed");
  rmSync(join(root, "signed-out"));
  assert.equal(await service.verifyCodexLogin(), "verified");

  // The runtime's own state is untouched by a failed read.
  const runtime = (
    service as unknown as { runtimes: Map<string, CodexRuntime> }
  ).runtimes.get("codex") as CodexRuntime;
  runtime.verifyLoginAndPolicy = async () => {
    throw new Error("account/read timed out");
  };
  assert.equal(await service.verifyCodexLogin(), "failed");
  assert.deepEqual(service.harnessStatuses()[0]?.state, "available");

  (
    service as unknown as { runtimeUnavailableSince: Map<string, number> }
  ).runtimeUnavailableSince.set("codex", 1);
  assert.equal(await service.verifyCodexLogin(), "unavailable");
});

test("a rejected profile's name never reaches readiness output", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-ready-name-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenPath = join(root, "claude-token");
  const TOKEN_VALUE = "ready-name-canary-token-5530";
  writeFileSync(tokenPath, `${TOKEN_VALUE}\n`, { mode: 0o600 });
  const PRIVATE_PATH = "/Users/private-owner/secret-project";
  const REFERENCE = "env:READY_NAME_CANARY_VARIABLE";
  const s = await startCliService(t, {
    service: { runtimeHarnesses: ["codex", "claude"] },
    runtimeFactory: ((_context: unknown, harness: string) =>
      harness === "claude"
        ? new ClaudeShapedFixtureRuntime()
        : new OperatorFixtureRuntime()) as unknown as () => Runtime,
  });
  const d = s.f.service.domain();
  d.execute({
    type: "claude-token.configure",
    key: crypto.randomUUID(),
    actor: "operator",
    credentialRef: `file:${tokenPath}`,
  });
  // The domain accepts a Claude model the runtime does not list, as after a runtime change.
  d.execute({
    type: "profile.create",
    key: crypto.randomUUID(),
    actor: "operator",
    profileId: crypto.randomUUID(),
    name: `${TOKEN_VALUE} ${tokenPath} ${PRIVATE_PATH} ${REFERENCE}`,
    summary: "canary",
    instructions: "canary",
    capabilities: "canary",
    runtime: { harness: "claude", model: "not-a-model", reasoningEffort: null },
  });
  const read = await s.issue("read");
  const api = await (await s.bearer(read.token, READINESS)).text();
  const h = harness(t);
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const doctor = await h.run(["doctor", "--output", "json"]);
  const human = await h.run(["doctor"]);
  assert.equal(doctor.code, 0, doctor.err);

  const harnessCheck = readinessSchema
    .parse(JSON.parse(api))
    .data.checks.find((c) => c.id === "runtime-harness");
  assert.equal(harnessCheck?.status, "fail");
  assert.equal(
    harnessCheck?.reason,
    "1 profile uses a model or reasoning effort the runtime does not accept",
  );
  const everything = [api, doctor.out, doctor.err, human.out, human.err].join(
    "\n",
  );
  for (const secret of [
    TOKEN_VALUE,
    tokenPath,
    PRIVATE_PATH,
    REFERENCE,
    "READY_NAME_CANARY_VARIABLE",
  ])
    assert.equal(everything.includes(secret), false, secret);
});
