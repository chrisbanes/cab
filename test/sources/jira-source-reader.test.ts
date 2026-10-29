import assert from "node:assert/strict";
import { test } from "node:test";
import { JiraSourceReader } from "../../src/standalone/jira-source.js";
import {
  adfParagraph,
  fakeJira,
  type JiraHandler,
  jiraIssue,
  json,
} from "../fixtures/fake-jira.js";

const access = {
  instance: "example.atlassian.net",
  email: "chris@example.test",
  token: "jira-token-canary-1318",
};
const selection = { id: "S-1", kind: "jql" as const, jql: "project = ABC" };
const reader = (handler: JiraHandler) => {
  const jira = fakeJira(handler);
  return { ...jira, reader: new JiraSourceReader(() => access, jira.fetcher) };
};

test("a search across pages is one complete snapshot with Markdown bodies and Jira statuses", async () => {
  const { reader: r, requests } = reader((req) =>
    (req.body as { nextPageToken?: string }).nextPageToken
      ? json({ issues: [jiraIssue(2, { done: true })] })
      : json({ issues: [jiraIssue(1)], nextPageToken: "page-2" }),
  );
  const snapshot = await r.readSelection(selection);
  assert.equal(snapshot.complete, true);
  assert.deepEqual(
    snapshot.issues.map((i) => [
      i.nodeId,
      i.repositoryName,
      i.number,
      i.state,
      i.body,
    ]),
    [
      ["10001", "ABC", 1, "open", "Body 1"],
      ["10002", "ABC", 2, "closed", "Body 2"],
    ],
  );
  assert.deepEqual(snapshot.issues[0]?.status, {
    id: "1",
    name: "To Do",
    categoryKey: "new",
  });
  assert.equal(snapshot.issues[0]?.providerInstance, "example.atlassian.net");
  assert.deepEqual(
    requests.map((q) => [q.method, q.url.origin, q.url.pathname]),
    [
      ["POST", "https://example.atlassian.net", "/rest/api/3/search/jql"],
      ["POST", "https://example.atlassian.net", "/rest/api/3/search/jql"],
    ],
  );
  assert.equal(
    (requests[1]?.body as { nextPageToken: string }).nextPageToken,
    "page-2",
  );
});

test("a description that is absent reads as empty and an unreadable one as a placeholder", async () => {
  const { reader: r } = reader(() =>
    json({
      issues: [
        jiraIssue(1, { description: null }),
        jiraIssue(2, { description: { nonsense: true } }),
        jiraIssue(3, { description: adfParagraph("ok") }),
      ],
    }),
  );
  const snapshot = await r.readSelection(selection);
  assert.deepEqual(
    snapshot.issues.map((i) => i.body),
    ["", "[Jira description could not be read]", "ok"],
  );
});

test("every failure is an incomplete read with a stable reason, never an empty complete one", async () => {
  const cases: [string, JiraHandler, string, number?][] = [
    [
      "rate limit",
      () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
      "rate-limited",
    ],
    ["unauthorized", () => new Response("", { status: 401 }), "unauthorized"],
    ["not found", () => new Response("", { status: 404 }), "not-found"],
    ["server error", () => new Response("", { status: 500 }), "unavailable"],
    [
      "redirect",
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://other.test/" },
        }),
      "redirected",
    ],
    ["malformed page", () => json({ issues: [{ id: "x" }] }), "malformed"],
    ["not json", () => new Response("<html>", { status: 200 }), "not-json"],
  ];
  for (const [name, handler, reason] of cases) {
    const snapshot = await reader(handler).reader.readSelection(selection);
    assert.equal(snapshot.complete, false, name);
    assert.equal(snapshot.reason, reason, name);
  }
  const limited = await reader(
    () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
  ).reader.readSelection(selection);
  assert.ok(!limited.complete && (limited.resumeAt ?? 0) > Date.now() + 20_000);
  const network = await new JiraSourceReader(() => access, (async () => {
    throw new Error("boom");
  }) as typeof fetch).readSelection(selection);
  assert.deepEqual(
    [network.complete, network.reason],
    [false, "site-unreachable"],
  );
  const missing = await new JiraSourceReader(() => ({
    reason: "missing-credential",
  })).readSelection(selection);
  assert.deepEqual(
    [missing.complete, missing.reason],
    [false, "missing-credential"],
  );
});

test("a failure after the first page keeps what was read but claims nothing complete", async () => {
  const { reader: r } = reader((req) =>
    (req.body as { nextPageToken?: string }).nextPageToken
      ? new Response("", { status: 500 })
      : json({ issues: [jiraIssue(1)], nextPageToken: "page-2" }),
  );
  const snapshot = await r.readSelection(selection);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.issues.length, 1);
});

test("pagination stops at the page cap and at a repeated token, as incomplete", async () => {
  let n = 0;
  const endless = await reader(() =>
    json({ issues: [], nextPageToken: `t${n++}` }),
  ).reader.readSelection(selection);
  assert.deepEqual([endless.complete, endless.reason], [false, "page-limit"]);
  assert.equal(n, 100);
  const loop = await reader(() =>
    json({ issues: [], nextPageToken: "same" }),
  ).reader.readSelection(selection);
  assert.deepEqual([loop.complete, loop.reason], [false, "malformed"]);
});

test("requests stay on the site origin and the credential never leaves the Authorization header", async () => {
  const { reader: r, requests } = reader(() => json({ issues: [] }));
  await r.readSelection(selection);
  await r.preview("project = ABC");
  for (const request of requests) {
    assert.equal(request.url.origin, "https://example.atlassian.net");
    assert.equal(request.redirect, "manual");
    assert.equal(JSON.stringify(request.body).includes(access.token), false);
    assert.equal(request.url.href.includes(access.token), false);
  }
});

test("JQL validation surfaces Jira's messages and preview returns at most 20 matches", async () => {
  const { reader: r, requests } = reader((req) =>
    req.url.pathname.endsWith("/jql/parse")
      ? json({
          queries: [
            (req.body as { queries: string[] }).queries[0] === "bad ="
              ? {
                  query: "bad =",
                  errors: ["Error in the JQL Query: unexpected end."],
                }
              : { query: "ok" },
          ],
        })
      : json({
          issues: Array.from({ length: 20 }, (_, i) => jiraIssue(i + 1)),
          nextPageToken: "more",
        }),
  );
  assert.deepEqual(await r.parseJql("bad ="), [
    "Error in the JQL Query: unexpected end.",
  ]);
  assert.deepEqual(await r.parseJql("project = ABC"), []);
  assert.equal(requests[0]?.url.search, "?validation=strict");
  const preview = await r.preview("project = ABC");
  assert.equal(preview.matches.length, 20);
  assert.equal(preview.more, true);
  assert.deepEqual(preview.matches[0], {
    key: "ABC-1",
    title: "Issue 1",
    status: "To Do",
  });
  assert.equal(
    (requests.at(-1)?.body as { maxResults: number }).maxResults,
    20,
  );
});

test("a 400 from Jira on parse is an answer about the JQL, not a failed read", async () => {
  const { reader: r } = reader(() =>
    json({ errorMessages: ["bad query"], errors: {} }, { status: 400 }),
  );
  assert.deepEqual(await r.parseJql("x"), ["bad query"]);
});
