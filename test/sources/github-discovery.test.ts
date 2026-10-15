import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscoveryFailure,
  GitHubDiscoveryReader,
} from "../../src/standalone/github-discovery.js";

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

test("project fields send one read-only query and list only single-select fields", async () => {
  const response = (node: unknown) => json({ data: { node } });
  const field = (id: string, name: string, options: string[]) => ({
    __typename: "ProjectV2SingleSelectField",
    id,
    name,
    options: options.map((o) => ({ id: `${id}_${o}`, name: o })),
  });
  const node = (nodes: unknown[], hasNextPage = false) => ({
    id: "PVT_atlas",
    fields: { nodes, pageInfo: { hasNextPage } },
  });
  const f = fake(() =>
    response(
      node([
        field("F_status", "Status", ["Todo", "Ready"]),
        { __typename: "ProjectV2Field", id: "F_text", name: "Notes" },
        field("F_priority", "Priority", ["High"]),
      ]),
    ),
  );
  assert.deepEqual(
    await new GitHubDiscoveryReader(token, f.fetcher).projectFields(
      "PVT_atlas",
    ),
    {
      fields: [
        {
          fieldNodeId: "F_status",
          name: "Status",
          options: [
            { optionNodeId: "F_status_Todo", name: "Todo" },
            { optionNodeId: "F_status_Ready", name: "Ready" },
          ],
        },
        {
          fieldNodeId: "F_priority",
          name: "Priority",
          options: [{ optionNodeId: "F_priority_High", name: "High" }],
        },
      ],
      truncated: false,
    },
  );
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call?.method, "POST");
  assert.equal(call?.url, "https://api.github.com/graphql");
  assert.equal(call?.auth, `Bearer ${token}`);
  const body = JSON.parse(call?.body ?? "{}") as {
    query: string;
    variables: unknown;
  };
  assert.match(body.query, /^query /);
  assert.equal(/mutation/i.test(body.query), false);
  assert.deepEqual(body.variables, { project: "PVT_atlas" });
  const read = (respond: () => Response) =>
    reason(
      new GitHubDiscoveryReader(token, fake(respond).fetcher).projectFields(
        "PVT_atlas",
      ),
    );
  const truncated = fake(() => response(node([], true)));
  assert.equal(
    (
      await new GitHubDiscoveryReader(token, truncated.fetcher).projectFields(
        "PVT_atlas",
      )
    ).truncated,
    true,
  );
  const none = fake(() => response(node([])));
  assert.equal(
    await reason(
      new GitHubDiscoveryReader(undefined, none.fetcher).projectFields("P"),
    ),
    "missing-credential",
  );
  assert.equal(none.calls.length, 0);
  assert.equal(await read(() => json({}, { status: 401 })), "unauthorized");
  assert.equal(
    await read(() => json({ errors: [{ message: token }], data: null })),
    "forbidden",
  );
  assert.equal(
    await read(() =>
      json({ errors: [{ type: "RATE_LIMITED", message: "x" }], data: null }),
    ),
    "rate-limited",
  );
  assert.equal(await read(() => response(null)), "forbidden");
  assert.equal(await read(() => response({})), "forbidden");
  assert.equal(
    await read(() =>
      response(
        node([{ __typename: "ProjectV2SingleSelectField", id: "F", name: 1 }]),
      ),
    ),
    "unreadable",
  );
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
  // Rate limits are told apart from refusals on both APIs.
  const limited: [() => Response, "repositories" | "projects", string][] = [
    [
      () =>
        json({
          errors: [{ type: "RATE_LIMITED", message: "limit" }],
          data: null,
        }),
      "projects",
      "rate-limited",
    ],
    [
      () =>
        json(
          { errors: [{ message: "limit" }], data: null },
          { headers: { "x-ratelimit-remaining": "0" } },
        ),
      "projects",
      "rate-limited",
    ],
    [
      () => json({}, { status: 403, headers: { "retry-after": "60" } }),
      "repositories",
      "rate-limited",
    ],
    [
      () =>
        json(
          { message: "You have exceeded a secondary rate limit." },
          { status: 403 },
        ),
      "repositories",
      "rate-limited",
    ],
    [
      () => json({ message: "Resource not accessible" }, { status: 403 }),
      "repositories",
      "forbidden",
    ],
  ];
  for (const [respond, read, expected] of limited) {
    const f = fake(respond);
    const reader = new GitHubDiscoveryReader(token, f.fetcher);
    assert.equal(
      await reason(
        read === "projects"
          ? reader.projects("acme", "atlas")
          : reader.repositories(),
      ),
      expected,
    );
  }
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
