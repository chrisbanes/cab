import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readinessSchema } from "../src/operator/readiness.js";
import { fakeServer, harness } from "./fixtures/cli-harness.js";
import { startCliService } from "./fixtures/operator-cli.js";
import { tmpdir } from "./temp.js";

const CANARY = "doctor-canary-token-7742";

async function loggedIn(
  t: Parameters<typeof harness>[0],
  origin: string,
  token: string,
) {
  const h = harness(t);
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    origin,
    "--token-file",
    h.tokenFile(token),
  ]);
  assert.equal(login.code, 0, login.err);
  return h;
}

test("doctor reports the service's readiness checks, equal to the API read and without secrets", async (t) => {
  const s = await startCliService(t);
  const root = mkdtempSync(join(tmpdir(), "ensemble-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenPath = join(root, "claude-token");
  writeFileSync(tokenPath, `${CANARY}\n`);
  chmodSync(tokenPath, 0o644);
  s.f.service.domain().execute({
    type: "claude-token.configure",
    key: randomUUID(),
    actor: "operator",
    credentialRef: `file:${tokenPath}`,
  });
  const read = await s.issue("read", "doctor");
  const h = await loggedIn(t, s.origin, read.token);

  const json = await h.run(["doctor", "--output", "json"]);
  assert.equal(json.code, 0, json.err);
  const envelope = json.json();
  assert.equal(envelope.schema, "ensemble.cli/v1");
  const api = readinessSchema.parse(
    await (await s.bearer(read.token, "/api/operator/readiness")).json(),
  );
  assert.deepEqual(envelope.data, api.data);
  const claude = envelope.data.checks.find(
    (c: { id: string }) => c.id === "claude-token",
  );
  assert.equal(claude.status, "fail");
  assert.equal(claude.reason, "Token file permits group or other access");

  const human = await h.run(["doctor"]);
  assert.equal(human.code, 0, "a failing check does not fail the command");
  for (const check of api.data.checks)
    assert.ok(human.out.includes(check.label));
  assert.match(
    human.out,
    /Claude token\s+Fail\s+Token file permits group or other access/,
  );
  assert.match(
    human.out,
    /Fix Claude token: Make the token file a private regular file/,
  );
  assert.match(human.out, /GitHub discovery\s+Not configured/);

  const everything = [json.out, json.err, human.out, human.err].join("\n");
  for (const secret of [CANARY, tokenPath, root, s.f.directory])
    assert.ok(!everything.includes(secret), secret);
});

test("doctor exits 5 when the service is unavailable and takes no arguments", async (t) => {
  const identity = {
    apiVersion: 1,
    capabilities: ["cli.identity", "diagnostics.read"],
    service: {
      installationId: randomUUID(),
      origin: "https://ensemble.example",
    },
    credential: {
      id: randomUUID(),
      name: "fake",
      scope: "read",
      createdAt: 1,
      expiresAt: Date.now() + 86_400_000,
    },
  };
  const fake = await fakeServer(t, (request, response) => {
    if (request.url?.startsWith("/api/operator/cli"))
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(identity));
    else response.writeHead(503).end();
  });
  // Any well-formed token logs in; only the identity request reaches the fake.
  const s = await startCliService(t);
  const h = await loggedIn(t, fake.origin, (await s.issue("read")).token);
  const down = await h.run(["doctor", "--output", "json"]);
  assert.equal(down.code, 5);
  assert.equal(down.json().error.code, "unavailable");
  const extra = await h.run(["doctor", "extra"]);
  assert.equal(extra.code, 2);
});
