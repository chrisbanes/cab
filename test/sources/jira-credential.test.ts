import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jiraCredentialExclusions,
  jiraCredentialStatus,
  jiraSiteHost,
  resolveJiraAccess,
} from "../../src/standalone/jira-credential.js";
import { fakeJira, json } from "../fixtures/fake-jira.js";

const refs = {
  issueTracker: "jira" as const,
  instance: "example.atlassian.net",
  siteRef: "env:FIXTURE_JIRA_SITE",
  emailRef: "env:FIXTURE_JIRA_EMAIL",
  tokenRef: "env:FIXTURE_JIRA_TOKEN",
};
const env = {
  FIXTURE_JIRA_SITE: "https://example.atlassian.net",
  FIXTURE_JIRA_EMAIL: "chris@example.test",
  FIXTURE_JIRA_TOKEN: "jira-token-canary-1318",
};

test("only an https origin names a site", () => {
  assert.deepEqual(jiraSiteHost("https://Example.atlassian.net/"), {
    instance: "example.atlassian.net",
  });
  for (const value of [
    "http://example.atlassian.net",
    "https://example.atlassian.net/wiki",
    "https://example.atlassian.net:8443",
    "https://user:pw@example.atlassian.net",
    "https://example.atlassian.net?x=1",
    "not a url",
    "https://jira.example.test",
    "https://127.0.0.1",
    "https://atlassian.net",
    "https://example.atlassian.net.evil.test",
  ])
    assert.deepEqual(jiraSiteHost(value), { reason: "site-invalid" }, value);
  assert.deepEqual(jiraSiteHost(""), { reason: "missing-credential" });
});

test("a credential resolves on every use and fails closed when the site changes", () => {
  const access = resolveJiraAccess(refs, env);
  assert.deepEqual(access, {
    instance: "example.atlassian.net",
    email: env.FIXTURE_JIRA_EMAIL,
    token: env.FIXTURE_JIRA_TOKEN,
  });
  assert.deepEqual(resolveJiraAccess(undefined, env), {
    reason: "missing-credential",
  });
  assert.deepEqual(
    resolveJiraAccess(refs, { ...env, FIXTURE_JIRA_TOKEN: undefined }),
    { reason: "missing-credential" },
  );
  assert.deepEqual(
    resolveJiraAccess(refs, { ...env, FIXTURE_JIRA_SITE: "http://x.test" }),
    { reason: "site-invalid" },
  );
  assert.deepEqual(
    resolveJiraAccess(refs, {
      ...env,
      FIXTURE_JIRA_SITE: "https://evil.example.test",
    }),
    { reason: "site-mismatch" },
  );
});

test("status reports the account for a valid credential and a stable reason otherwise", async () => {
  const access = resolveJiraAccess(refs, env);
  const ok = fakeJira(() =>
    json({ accountId: "acct-1", displayName: "Chris", emailAddress: "x" }),
  );
  const status = await jiraCredentialStatus(access, ok.fetcher);
  assert.deepEqual(status, {
    usable: true,
    account: { accountId: "acct-1", displayName: "Chris" },
    reason: null,
  });
  const [request] = ok.requests;
  assert.equal(
    request?.url.href,
    "https://example.atlassian.net/rest/api/3/myself",
  );
  assert.equal(request?.redirect, "manual");
  assert.equal(
    request?.headers.get("authorization"),
    `Basic ${Buffer.from(`${env.FIXTURE_JIRA_EMAIL}:${env.FIXTURE_JIRA_TOKEN}`).toString("base64")}`,
  );
  const reasons = async (handler: () => Response) =>
    (await jiraCredentialStatus(access, fakeJira(handler).fetcher)).reason;
  assert.equal(
    await reasons(() => new Response("", { status: 401 })),
    "unauthorized",
  );
  assert.equal(
    await reasons(() => new Response("", { status: 403 })),
    "unauthorized",
  );
  assert.equal(
    await reasons(() => new Response("", { status: 404 })),
    "not-jira",
  );
  assert.equal(
    await reasons(() => new Response("<html>login</html>", { status: 200 })),
    "not-jira",
  );
  assert.equal(
    await reasons(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://login.example.test" },
        }),
    ),
    "not-jira",
  );
  assert.equal(
    (
      await jiraCredentialStatus(access, (async () => {
        throw new Error(`connect failed for ${env.FIXTURE_JIRA_TOKEN}`);
      }) as typeof fetch)
    ).reason,
    "site-unreachable",
  );
  assert.equal(
    (await jiraCredentialStatus({ reason: "site-mismatch" })).reason,
    "site-mismatch",
  );
});

test("no status, failure or exclusion output carries the email or token", async () => {
  const access = resolveJiraAccess(refs, env);
  for (const handler of [
    () => json({ accountId: "a", displayName: "Chris" }),
    () => new Response(`bad ${env.FIXTURE_JIRA_TOKEN}`, { status: 401 }),
  ]) {
    const text = JSON.stringify(
      await jiraCredentialStatus(access, fakeJira(handler).fetcher),
    );
    for (const secret of Object.values(env))
      assert.equal(text.includes(secret), false);
    for (const ref of [refs.siteRef, refs.emailRef, refs.tokenRef])
      assert.equal(text.includes(ref.slice(4)), false);
  }
  const excluded = jiraCredentialExclusions([refs], env);
  assert.deepEqual(excluded.names.sort(), Object.keys(env).sort());
  assert.deepEqual(excluded.values.sort(), Object.values(env).sort());
});
