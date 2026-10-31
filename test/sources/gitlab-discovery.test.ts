import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitLabDiscoveryFailure,
  GitLabDiscoveryReader,
} from "../../src/standalone/gitlab-discovery.js";

const token = "glpat-fake-reader-canary";
type Call = {
  url: string;
  method: string;
  token: string | null;
  privateToken: string | null;
  redirect: string | undefined;
};
function fake(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      token: new Headers(init?.headers).get("authorization"),
      privateToken: new Headers(init?.headers).get("private-token"),
      redirect: init?.redirect,
    });
    return respond(calls.at(-1) as Call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetcher };
}
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
const project = (id: number, path = `group/p${id}`) => ({
  id,
  path_with_namespace: path,
  default_branch: "main",
});
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => {
      assert.ok(e instanceof GitLabDiscoveryFailure);
      assert.equal(e.message.includes(token), false);
      assert.equal(e.message.includes("gitlab.example.com"), false);
      return e.reason;
    },
  );

test("user sends the token only as a header to the host's API and never follows a redirect", async () => {
  const f = fake(() => json({ username: "fake-user" }));
  const reader = new GitLabDiscoveryReader(
    "gitlab.example.com",
    token,
    f.fetcher,
  );
  assert.deepEqual(await reader.user(), { username: "fake-user" });
  assert.deepEqual(f.calls, [
    {
      url: "https://gitlab.example.com/api/v4/user",
      method: "GET",
      token: `Bearer ${token}`,
      privateToken: null,
      redirect: "manual",
    },
  ]);
});

test("an OAuth-shaped token is sent as the same Authorization header for user and projects", async () => {
  const oauth = "gloas-fake-oauth-shaped-canary";
  const f = fake((call) =>
    json(call.url.endsWith("/user") ? { username: "fake-user" } : []),
  );
  const reader = new GitLabDiscoveryReader(
    "gitlab.example.com",
    oauth,
    f.fetcher,
  );
  await reader.user();
  await reader.projects();
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.token, `Bearer ${oauth}`);
    assert.equal(call.privateToken, null);
  }
});

test("projects follow x-next-page, drop projects without a default branch and stop at ten pages", async () => {
  const two = fake((_, i) =>
    json(
      i === 0
        ? [project(1), { ...project(2), default_branch: null }]
        : [project(3, "group/sub/app")],
      i === 0 ? { "x-next-page": "2" } : {},
    ),
  );
  const reader = (f: typeof two) =>
    new GitLabDiscoveryReader("gitlab.example.com", token, f.fetcher);
  assert.deepEqual(await reader(two).projects(), {
    projects: [
      { repositoryId: "1", projectPath: "group/p1", defaultBranch: "main" },
      {
        repositoryId: "3",
        projectPath: "group/sub/app",
        defaultBranch: "main",
      },
    ],
    truncated: false,
  });
  assert.match(two.calls[0]?.url ?? "", /archived=false.*&page=1$/);
  assert.match(two.calls[1]?.url ?? "", /&page=2$/);
  const twelve = fake((_, i) =>
    json([project(i + 1)], { "x-next-page": String(i + 2) }),
  );
  const result = await reader(twelve).projects();
  assert.equal(twelve.calls.length, 10);
  assert.equal(result.projects.length, 10);
  assert.equal(result.truncated, true);
});

test("failures map to reason codes that never reveal the token or URL", async () => {
  const cases: [() => Response | Error, string][] = [
    [() => new Response("{}", { status: 401 }), "unauthorized"],
    [() => new Response("{}", { status: 403 }), "forbidden"],
    [() => new Response("{}", { status: 429 }), "rate-limited"],
    [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        }),
      "unreadable",
    ],
    [() => new Response("{}", { status: 500 }), "unreadable"],
    [() => new Response("not json", { status: 200 }), "unreadable"],
    [() => json({ username: 7 }), "unreadable"],
    [() => new Error(`connect failed with ${token}`), "unreachable"],
    [() => new TypeError("fetch failed"), "unreachable"],
    [
      () => new DOMException("The operation timed out.", "TimeoutError"),
      "unreachable",
    ],
  ];
  for (const [outcome, expected] of cases) {
    const f = fake(() => {
      const made = outcome();
      if (made instanceof Error) throw made;
      return made;
    });
    // No retries: a 429 is waited out elsewhere (gitlab-rate-limit.test.ts); here it is just a reason.
    const reader = new GitLabDiscoveryReader(
      "gitlab.example.com",
      token,
      f.fetcher,
      { maxRetries: 0 },
    );
    assert.equal(await reason(reader.user()), expected);
    assert.equal(f.calls.length, 1, "a 3xx is not followed");
  }
  // A token that cannot be a header value is not a host failure.
  for (const bad of ["", "a\nb", "tökén"])
    assert.throws(
      () => new GitLabDiscoveryReader("gitlab.example.com", bad),
      (e) => e instanceof GitLabDiscoveryFailure && e.reason === "unreadable",
    );
  assert.throws(
    () => new GitLabDiscoveryReader("github.com", token),
    (e) => e instanceof GitLabDiscoveryFailure && e.reason === "unreadable",
  );
});
