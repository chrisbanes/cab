import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { startCliService } from "../fixtures/operator-cli.js";
import { databaseDigest } from "../fixtures/database-digest.js";
import {
  containsControlCharacters,
  decodeSegment,
} from "../../src/standalone/operator-routes.js";

const removed: Array<[string, string]> = [
  ["POST", "/login"],
  ["POST", "/logout"],
  ["POST", "/command"],
  ...[
    "pre-turn/adopt",
    "pre-turn/recover",
    "no-turn/adopt",
    "no-turn/recover",
    "conversation-replace",
    "capacity",
    "bound-turn/review",
    "bound-turn/check",
    "bound-turn/recover",
  ].map((path): [string, string] => ["POST", `/runtime/control/${path}`]),
];

test("removed operator paths return ordinary not-found before session, Origin or CSRF processing", async (t) => {
  const s = await startCliService(t);
  const identities: Array<Record<string, string>> = [
    {},
    { cookie: s.cookie },
    { authorization: "Bearer removed-path-probe" },
  ];
  for (const headers of identities) {
    for (const [method, path] of removed) {
      const response = await fetch(s.origin + path, {
        method,
        redirect: "manual",
        headers: {
          ...headers,
          origin: "https://invalid.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        ...(method === "POST"
          ? { body: "csrfToken=invalid&payload=%7B%7D" }
          : {}),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("location"), null);
      assert.equal(await response.text(), "Not found");
    }
  }
  assert.equal((await fetch(s.origin + "/login")).status, 200);
  const forged = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      s.origin + "/api/operator/session",
      {
        headers: {
          host: "attacker.invalid",
          "x-forwarded-host": new URL(s.origin).host,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forged, 403);
});

test("the site root serves the shell without minting a session", async (t) => {
  const s = await startCliService(t);
  for (const headers of [{}, { cookie: s.cookie }]) {
    const response = await fetch(s.origin + "/", {
      redirect: "manual",
      headers,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("old command and capacity form payloads replay original receipts through JSON without another effect", async (t) => {
  const s = await startCliService(t);
  const d = s.f.service.domain();
  const profileId = randomUUID();
  const create = {
    type: "profile.create" as const,
    key: randomUUID(),
    profileId,
    name: "Old form profile",
    instructions: "",
    capabilities: "",
  };
  d.execute({ ...create, actor: "operator" });
  const capacity = {
    type: "capacity.configure" as const,
    key: randomUUID(),
    globalLimit: 3,
    projectOverrides: {},
  };
  await s.f.service.configureCapacity({
    key: capacity.key,
    globalLimit: capacity.globalLimit,
    projectOverrides: capacity.projectOverrides,
  });
  for (const command of [create, capacity]) {
    const original = d.recordedCommand({ ...command, actor: "operator" });
    assert.notEqual(original, undefined);
    const before = databaseDigest(s.f);
    const response = await s.sessionPost("/api/operator/commands", command);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.key, command.key);
    assert.equal(receipt.recorded, true);
    assert.deepEqual(
      d.recordedCommand({ ...command, actor: "operator" }),
      original,
    );
    assert.equal(databaseDigest(s.f), before);
    assert.deepEqual(
      await (await s.sessionPost("/api/operator/commands", command)).json(),
      receipt,
    );
    assert.equal(databaseDigest(s.f), before);
  }
  assert.equal(d.profiles().filter((p) => p.id === profileId).length, 1);
  assert.equal(s.f.service.capacityLimits().globalLimit, 3);
});

test("shared URL decoding rejects encoded separators and control characters", () => {
  for (const segment of ["%", "%2F", "%5c", "%00", ".", "..", "%2e%2e", ""])
    assert.equal(decodeSegment(segment), undefined);
  assert.equal(decodeSegment("a%20b"), "a b");
  assert.equal(containsControlCharacters("a\n"), true);
  assert.equal(containsControlCharacters("safe"), false);
});
