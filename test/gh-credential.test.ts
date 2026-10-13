import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialFreeEnvironment } from "../src/core/child-environment.js";
import {
  credentialReferenceExclusions,
  detectGh,
  ghEnvironment,
  ghToken,
} from "../src/standalone/gh-credential.js";
import {
  createFakeGh,
  fakeGhToken,
  type FakeGhState,
} from "./fixtures/fake-gh.js";

test("gh detection and token resolution map every state without revealing the token", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const options = { executable: gh.executable, timeoutMs: 5000 };
  const cases: [FakeGhState | "missing", unknown, unknown][] = [
    [
      "signed-in",
      { state: "signed-in", login: "octo" },
      { token: fakeGhToken },
    ],
    ["not-signed-in", { state: "not-signed-in" }, { state: "not-signed-in" }],
    ["unreadable", { state: "unreadable" }, { state: "unreadable" }],
    ["hang", { state: "unreadable" }, { state: "unreadable" }],
    [
      "invalid-token",
      { state: "signed-in", login: "octo" },
      { state: "unreadable" },
    ],
    ["missing", { state: "not-installed" }, { state: "not-installed" }],
  ];
  for (const [state, detected, token] of cases) {
    const run = { ...options };
    if (state === "missing") run.executable = gh.missing;
    else gh.set(state);
    if (state === "hang") run.timeoutMs = 200;
    const started = Date.now();
    const results = [await detectGh(run), await ghToken(run)];
    assert.deepEqual(results, [detected, token], state);
    if (state === "hang") assert.ok(Date.now() - started < 5000);
    if (state !== "signed-in")
      assert.equal(JSON.stringify(results).includes(fakeGhToken), false);
  }
  for (const environment of gh.environments()) {
    assert.equal(environment.GH_PROMPT_DISABLED, "1");
    assert.equal(environment.GH_NO_UPDATE_NOTIFIER, "1");
  }
});

test("source gh environment ignores discovery choice and removes unrelated credential aliases", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const environment = {
    PATH: process.env.PATH,
    SOURCE: "source-canary",
    SOURCE_ALIAS: "source-canary",
    DISCOVERY: "discovery-canary",
    DISCOVERY_ALIAS: "discovery-canary",
    DELIVERY: "delivery-canary",
    DELIVERY_ALIAS: "delivery-canary",
    CLAUDE: "claude-canary",
    CLAUDE_ALIAS: "claude-canary",
    GH_TOKEN: "chosen-gh-canary",
    GITHUB_TOKEN: "chosen-github-canary",
    GH_ALIAS: "chosen-gh-canary",
    SAFE: "safe-value",
  };
  for (const discovery of [null, "env:DISCOVERY"]) {
    const domain = {
      claudeTokenReference: () => "env:CLAUDE",
      projects: () => [{ id: "p" }] as never,
      deliveryCredentialReference: () => "env:DELIVERY",
      discoveryCredentialReference: () => discovery,
      githubConfiguration: () => ({ credentialRef: "env:SOURCE" }) as never,
    };
    const child = ghEnvironment(domain, {
      reference: "gh:github.com",
      environment,
    });
    assert.equal(child.GH_TOKEN, environment.GH_TOKEN);
    assert.equal(child.GITHUB_TOKEN, environment.GITHUB_TOKEN);
    assert.equal(child.SAFE, "safe-value");
    assert.equal(child.GH_ALIAS, undefined);
    for (const name of [
      "SOURCE",
      "SOURCE_ALIAS",
      "DELIVERY",
      "DELIVERY_ALIAS",
      "CLAUDE",
      "CLAUDE_ALIAS",
      ...(discovery ? ["DISCOVERY", "DISCOVERY_ALIAS"] : []),
    ])
      assert.equal(child[name], undefined, name);
    await ghToken({ executable: gh.executable, environment: child });
    const received = gh.environments().at(-1);
    assert.ok(received);
    assert.equal(received.GH_TOKEN, environment.GH_TOKEN);
    assert.equal(received.SOURCE_ALIAS, undefined);
    const detection = ghEnvironment(domain, { reference: null, environment });
    assert.equal(detection.GH_TOKEN, undefined);
    assert.equal(detection.GITHUB_TOKEN, undefined);
  }
});

test("resolved values survive more than eight rotations and Clear for exclusion only", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const options = { executable: gh.executable };
  const tokens = Array.from(
    { length: 12 },
    (_, i) => `gho_lifetime-rotation-${i}`,
  );
  for (const token of tokens) {
    gh.setToken(token);
    assert.deepEqual(await ghToken(options), { token });
  }
  const environment = {
    OLD_ALIAS: tokens[0],
    NEW_ALIAS: tokens.at(-1),
    KEEP: "safe",
  };
  for (const ref of ["gh:github.com", "env:OTHER", null]) {
    const excluded = credentialReferenceExclusions(ref, environment);
    for (const token of tokens) {
      assert.ok(excluded.values.includes(token));
      assert.ok(excluded.redactions.includes(token));
    }
    const child = credentialFreeEnvironment(
      environment,
      excluded.names,
      environment,
      excluded.values,
    );
    assert.deepEqual(child, { KEEP: "safe" });
  }
  gh.set("not-signed-in");
  assert.deepEqual(await ghToken(options), { state: "not-signed-in" });
});

test("gh token values have a 512-byte bound and invalid output is not remembered", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const valid = "x".repeat(512);
  gh.setToken(valid);
  assert.deepEqual(await ghToken({ executable: gh.executable }), {
    token: valid,
  });
  for (const invalid of [
    "x".repeat(513),
    "bad token",
    "token\nsecond-line",
    "",
  ]) {
    gh.setToken(invalid);
    assert.deepEqual(await ghToken({ executable: gh.executable }), {
      state: "unreadable",
    });
    assert.equal(
      credentialReferenceExclusions(null).values.includes(invalid),
      false,
    );
  }
});

test("gh runs without the Claude token or delivery credentials but keeps GH_TOKEN", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const values = {
    FIXTURE_GH_CLAUDE: "gh-claude-canary-31",
    FIXTURE_GH_DELIVERY: "gh-delivery-canary-31",
    GH_TOKEN: "gh-env-canary-31",
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const environment = ghEnvironment({
    claudeTokenReference: () => "env:FIXTURE_GH_CLAUDE",
    projects: () => [{ id: "p" }] as never,
    deliveryCredentialReference: () => "env:FIXTURE_GH_DELIVERY",
    discoveryCredentialReference: () => "gh:github.com",
  });
  assert.deepEqual(await detectGh({ executable: gh.executable, environment }), {
    state: "signed-in",
    login: "octo",
  });
  const received = gh.environments().at(-1);
  assert.ok(received);
  assert.equal(received.FIXTURE_GH_CLAUDE, undefined);
  assert.equal(received.FIXTURE_GH_DELIVERY, undefined);
  const text = JSON.stringify(received);
  assert.equal(text.includes(values.FIXTURE_GH_CLAUDE), false);
  assert.equal(text.includes(values.FIXTURE_GH_DELIVERY), false);
  assert.equal(received.GH_TOKEN, values.GH_TOKEN);
  assert.equal(received.GH_PROMPT_DISABLED, "1");
});

test("gh detection never receives an env discovery credential or its aliases", async (t) => {
  const gh = createFakeGh();
  t.after(() => gh.close());
  const values = {
    FIXTURE_GH_DISCOVERY: "gh-discovery-canary-44",
    FIXTURE_GH_DISCOVERY_ALIAS: "gh-discovery-canary-44",
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const environment = ghEnvironment({
    claudeTokenReference: () => null,
    projects: () => [],
    deliveryCredentialReference: () => null,
    discoveryCredentialReference: () => "env:FIXTURE_GH_DISCOVERY",
  });
  await detectGh({ executable: gh.executable, environment });
  const received = gh.environments().at(-1);
  assert.ok(received);
  assert.equal(
    JSON.stringify(received).includes(values.FIXTURE_GH_DISCOVERY),
    false,
  );
});
