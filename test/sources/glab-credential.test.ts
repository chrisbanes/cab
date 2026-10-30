import assert from "node:assert/strict";
import { test } from "node:test";
import { glabCredentialReference } from "../../src/core/credential-reference.js";
import {
  gitLabCredentialExclusions,
  glabEnvironment,
  glabOverridden,
  glabTimeoutMs,
  glabToken,
} from "../../src/standalone/glab-credential.js";
import {
  createFakeGlab,
  fakeGlabToken,
  type FakeGlabState,
} from "../fixtures/fake-glab.js";

const host = "gitlab.example.com";

test("glab token resolution maps every state without revealing the token", async (t) => {
  const glab = createFakeGlab();
  t.after(() => glab.close());
  const cases: [FakeGlabState | "missing", unknown][] = [
    ["signed-in", { token: fakeGlabToken }],
    ["legacy-format", { token: fakeGlabToken }],
    ["not-signed-in", { state: "not-signed-in" }],
    ["unreadable", { state: "unreadable" }],
    ["masked", { state: "unreadable" }],
    ["network-error", { state: "unreachable" }],
    ["hang", { state: "unreachable" }],
    ["missing", { state: "not-installed" }],
  ];
  for (const [state, expected] of cases) {
    const options = { executable: glab.executable, timeoutMs: 5000 };
    if (state === "missing") options.executable = glab.missing;
    else glab.set(state);
    if (state === "hang") options.timeoutMs = 200;
    const started = Date.now();
    const result = await glabToken(host, options);
    assert.deepEqual(result, expected, state);
    if (state === "hang") assert.ok(Date.now() - started < 5000);
    if (!("token" in result))
      assert.equal(JSON.stringify(result).includes(fakeGlabToken), false);
  }
  glab.set("signed-in");
  for (const argv of glab.commands())
    assert.deepEqual(argv, [
      "auth",
      "status",
      "--hostname",
      host,
      "--show-token",
    ]);
  for (const environment of glab.environments()) {
    assert.equal(environment.NO_PROMPT, "1");
    assert.equal(environment.GLAB_CHECK_UPDATE, "false");
  }
});

test("the default glab timeout is inside readiness's 10 second bound", () => {
  assert.equal(glabTimeoutMs, 8_000);
});

test("glab is run on every use and nothing is cached", async (t) => {
  const glab = createFakeGlab();
  t.after(() => glab.close());
  const options = { executable: glab.executable };
  assert.deepEqual(await glabToken(host, options), { token: fakeGlabToken });
  glab.setToken("glpat-rotated-311");
  assert.deepEqual(await glabToken(host, options), {
    token: "glpat-rotated-311",
  });
  assert.equal(glab.commands().length, 2);
});

test("an override is detected and its token wins in glab's own output", async (t) => {
  for (const name of ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"])
    assert.equal(glabOverridden({ [name]: "x" }), true, name);
  assert.equal(glabOverridden({ GITLAB_TOKEN: "", SAFE: "x" }), false);
  const glab = createFakeGlab();
  t.after(() => glab.close());
  assert.deepEqual(
    await glabToken(host, {
      executable: glab.executable,
      environment: { GITLAB_TOKEN: "glpat-override-311" },
    }),
    { token: "glpat-override-311" },
  );
});

test("exclusions cover glab's variables, resolved values and env references", async (t) => {
  const glab = createFakeGlab();
  t.after(() => glab.close());
  glab.setToken("glpat-excluded-311");
  await glabToken(host, { executable: glab.executable });
  const env = { GITLAB_TOKEN: "glpat-env-311", CAB_GL: "glpat-named-311" };
  const g = gitLabCredentialExclusions([`glab:${host}`], env);
  assert.deepEqual(g.names, [
    "GITLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
    "OAUTH_TOKEN",
  ]);
  for (const value of ["glpat-excluded-311", "glpat-env-311"]) {
    assert.ok(g.values.includes(value), value);
    assert.ok(g.redactions.includes(value), value);
  }
  const e = gitLabCredentialExclusions(["env:CAB_GL"], env);
  assert.deepEqual(e.names, ["CAB_GL"]);
  assert.ok(e.values.includes("glpat-named-311"));
  assert.ok(e.redactions.includes("CAB_GL"));
  assert.deepEqual(gitLabCredentialExclusions([], {}).names, []);
});

test("glab environment keeps only glab's variables and drops every other credential", () => {
  const environment = {
    SOURCE: "source-canary",
    DELIVERY: "delivery-canary",
    DISCOVERY: "discovery-canary",
    CLAUDE: "claude-canary",
    OTHER_GL: "gitlab-env-canary",
    GH_TOKEN: "gh-canary",
    GH_ALIAS: "gh-canary",
    GITLAB_TOKEN: "glab-canary",
    SAFE: "safe-value",
  };
  const child = glabEnvironment(
    {
      claudeTokenReference: () => "env:CLAUDE",
      projects: () => [{ id: "p" }] as never,
      deliveryCredentialReference: () => "env:DELIVERY",
      discoveryCredentialReference: () => "env:DISCOVERY",
      githubConfiguration: () => ({ credentialRef: "env:SOURCE" }) as never,
      codeHostCredentials: () => [{ credentialRef: "env:OTHER_GL" }],
    },
    environment,
  );
  assert.deepEqual(child, { GITLAB_TOKEN: "glab-canary", SAFE: "safe-value" });
});

test("glab references are lowercase hosts other than github.com", () => {
  assert.ok(glabCredentialReference.safeParse(`glab:${host}`).success);
  for (const bad of [
    "glab:",
    "glab:GitLab.com",
    "glab:github.com",
    "glab:a b",
    "glab:host/x",
  ])
    assert.equal(glabCredentialReference.safeParse(bad).success, false, bad);
});
