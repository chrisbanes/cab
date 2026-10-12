import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
