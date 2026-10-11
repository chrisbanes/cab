import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscoveryFailure,
  GitHubDiscoveryReader,
} from "../src/standalone/github-discovery.js";

const token = "PRIVATE DISCOVERY TOKEN";
type Call = { url: string; method: string; body?: string; auth?: string };
function fake(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(headers.get("authorization")
        ? { auth: headers.get("authorization") ?? "" }
        : {}),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetcher };
}
const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
const repo = (name: string) => ({
  node_id: `R_${name}`,
  name,
  owner: { login: "acme" },
  default_branch: "main",
});
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => {
      assert.ok(e instanceof DiscoveryFailure);
      assert.equal(e.message.includes(token), false);
      return e.reason;
    },
  );

test("repositories follow Link pages and mark truncation after ten pages", async () => {
  const two = fake((_, i) =>
    json([repo(`r${i}`)], {
      headers:
        i === 0
          ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' }
          : {},
    }),
  );
  const result = await new GitHubDiscoveryReader(
    token,
    two.fetcher,
  ).repositories();
  assert.deepEqual(result, {
    repositories: [
      {
        repositoryId: "R_r0",
        owner: "acme",
        name: "r0",
        defaultBranch: "main",
      },
      {
        repositoryId: "R_r1",
        owner: "acme",
        name: "r1",
        defaultBranch: "main",
      },
    ],
    truncated: false,
  });
  assert.match(
    two.calls[0]?.url ?? "",
    /^https:\/\/api\.github\.com\/user\/repos\?/,
  );
  const endless = fake((_, i) =>
    json([repo(`r${i}`)], {
      headers: {
        link: `<https://api.github.com/user/repos?page=${i + 2}>; rel="next"`,
      },
    }),
  );
  const many = await new GitHubDiscoveryReader(
    token,
    endless.fetcher,
  ).repositories();
  assert.equal(many.truncated, true);
  assert.equal(endless.calls.length, 10);
  const branches = fake((_, i) =>
    json([{ name: `b${i}` }], {
      headers: {
        link: `<https://api.github.com/x?page=${i + 2}>; rel="next"`,
      },
    }),
  );
  const b = await new GitHubDiscoveryReader(token, branches.fetcher).branches(
    "acme",
    "atlas",
  );
  assert.equal(b.truncated, true);
  assert.equal(branches.calls.length, 5);
  for (const call of [...two.calls, ...endless.calls, ...branches.calls]) {
    assert.equal(call.method, "GET");
    assert.equal(new URL(call.url).origin, "https://api.github.com");
    assert.equal(call.auth, `Bearer ${token}`);
  }
});

test("projects send one read-only query and list linked then the owner's open others", async () => {
  const projects = (nodes: unknown[], hasNextPage = false) => ({
    nodes,
    pageInfo: { hasNextPage },
  });
  const f = fake(() =>
    json({
      data: {
        repository: {
          projectsV2: projects([
            {
              id: "PVT_atlas",
              title: "Atlas roadmap",
              number: 1,
              closed: false,
            },
          ]),
        },
        repositoryOwner: {
          login: "acme",
          projectsV2: projects([
            {
              id: "PVT_atlas",
              title: "Atlas roadmap",
              number: 1,
              closed: false,
            },
            { id: "PVT_web", title: "Web", number: 2, closed: false },
            { id: "PVT_old", title: "Old", number: 3, closed: true },
          ]),
        },
      },
    }),
  );
  const result = await new GitHubDiscoveryReader(token, f.fetcher).projects(
    "acme",
    "atlas",
  );
  assert.deepEqual(result, {
    ownerLogin: "acme",
    linked: [{ projectNodeId: "PVT_atlas", title: "Atlas roadmap", number: 1 }],
    owned: [{ projectNodeId: "PVT_web", title: "Web", number: 2 }],
    truncated: false,
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call?.method, "POST");
  assert.equal(call?.url, "https://api.github.com/graphql");
  const body = JSON.parse(call?.body ?? "{}") as {
    query: string;
    variables: unknown;
  };
  assert.match(body.query, /^query /);
  assert.equal(/mutation/i.test(body.query), false);
  assert.deepEqual(body.variables, { owner: "acme", name: "atlas" });
});

test("failures are reason codes without the token", async () => {
  const none = fake(() => json([]));
  assert.equal(
    await reason(
      new GitHubDiscoveryReader(undefined, none.fetcher).repositories(),
    ),
    "missing-credential",
  );
  assert.equal(none.calls.length, 0);
  const cases: [() => Response, string][] = [
    [() => json({}, { status: 401 }), "unauthorized"],
    [
      () =>
        json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      "rate-limited",
    ],
    [() => json({}, { status: 429 }), "rate-limited"],
    [() => json({}, { status: 403 }), "forbidden"],
    [() => new Response("not json", { status: 200 }), "unreadable"],
    [() => json([{ unexpected: true }]), "unreadable"],
    [
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      "unreadable",
    ],
  ];
  for (const [respond, expected] of cases) {
    const f = fake(respond);
    assert.equal(
      await reason(new GitHubDiscoveryReader(token, f.fetcher).repositories()),
      expected,
    );
  }
  const graphErrors = fake(() =>
    json({ errors: [{ message: `scope ${token}` }], data: null }),
  );
  assert.equal(
    await reason(
      new GitHubDiscoveryReader(token, graphErrors.fetcher).projects(
        "acme",
        "atlas",
      ),
    ),
    "forbidden",
  );
  const redirect = fake(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      }),
  );
  assert.equal(
    await reason(
      new GitHubDiscoveryReader(token, redirect.fetcher).repositories(),
    ),
    "unreadable",
  );
  assert.equal(redirect.calls.length, 1);
});
