import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryPolicy } from "../../src/core/delivery.js";
import {
  GitLabHttpDeliveryProvider,
  gitLabDeliveryFactory,
} from "../../src/standalone/gitlab-delivery.js";
import { TtlCache, cacheTtlMs } from "../../src/standalone/gitlab-http.js";
import { createFakeGlab } from "../fixtures/fake-glab.js";
import {
  gitLabMergeRequest,
  scriptedGitLabRemote,
} from "../fixtures/gitlab-remote.js";

const host = "gitlab.example.com";
const identity = {
  repositoryId: "42",
  prNumber: 12,
  expectedPrNodeId: "9001",
  expectedHeadSha: "2".repeat(40),
};
const policy = { requiredChecks: [] } as unknown as DeliveryPolicy;

test("the cache reuses a read for its lifetime, shares one in flight, and forgets failures and refused results", async () => {
  let now = 1_000;
  const cache = new TtlCache(() => now);
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await cache.get("k", 100, load), 1);
  assert.equal(await cache.get("k", 100, load), 1);
  now += 99;
  assert.equal(await cache.get("k", 100, load), 1);
  now += 1;
  assert.equal(await cache.get("k", 100, load), 2, "it expires");
  // Concurrent readers share one load.
  const both = await Promise.all([
    cache.get("shared", 100, load),
    cache.get("shared", 100, load),
  ]);
  assert.deepEqual(both, [3, 3]);
  // A failed load, or one the caller refuses to keep, is read again.
  let failures = 0;
  await assert.rejects(
    cache.get("f", 100, async () => {
      failures++;
      throw new Error("no");
    }),
  );
  assert.equal(await cache.get("f", 100, async () => 7), 7);
  assert.equal(failures, 1);
  assert.equal(
    await cache.get(
      "n",
      100,
      async () => null,
      (v) => v !== null,
    ),
    null,
  );
  assert.equal(await cache.get("n", 100, async () => "x"), "x");
  // Dropping by prefix forgets exactly those entries.
  assert.equal(cache.drop("shared"), true);
  assert.equal(cache.drop("absent"), false);
  assert.equal(await cache.get("shared", 100, load), 4);
  assert.equal(await cache.get("k", 100, load), 2);
});

function world(now: () => number) {
  const remote = scriptedGitLabRemote({ repositoryId: "42" });
  remote.state.project = { id: 42, path_with_namespace: "group/sub/app" };
  remote.state.head = "2".repeat(40);
  remote.state.mergeRequests.push(gitLabMergeRequest());
  const cache = new TtlCache(now);
  const provider = new GitLabHttpDeliveryProvider({
    host,
    link: (id) => (id === "42" ? { projectPath: "group/sub/app" } : null),
    token: async () => "glpat-synthetic-cache-token",
    fetcher: remote.fetcher,
    cache,
  });
  const reads = (suffix: RegExp) =>
    remote.requests.filter((r) => suffix.test(new URL(r.url).pathname)).length;
  return { remote, provider, reads };
}

test("a project is read once for its lifetime across observations, but a merge reads it fresh", async () => {
  let now = 0;
  const w = world(() => now);
  const project = /\/projects\/42$/;
  await w.provider.inspectPr(identity, policy);
  await w.provider.inspectPr(identity, policy);
  assert.equal(w.reads(project), 1);
  // The merge request itself is read every time: it gates decisions.
  assert.equal(w.reads(/\/merge_requests\/12$/), 2);
  now += cacheTtlMs.project;
  await w.provider.inspectPr(identity, policy);
  assert.equal(w.reads(project), 2);
  const merge = {
    kind: "pr.merge",
    target: {
      repositoryId: "42",
      number: 12,
      nodeId: "9001",
      baseRef: "main",
      headRef: "cab/abcd1234-task",
      expectedHeadSha: "2".repeat(40),
    },
    method: "squash",
    reviewedResultIds: [],
  } as never;
  await w.provider.preflight(merge, policy);
  assert.equal(
    w.reads(project),
    3,
    "a merge's preflight reads the project fresh",
  );
  await w.provider.inspectPr(identity, policy);
  assert.equal(w.reads(project), 3, "and the read it made is kept");
  // A link that names another project is still refused, whatever was kept.
  const other = new GitLabHttpDeliveryProvider({
    host,
    link: () => ({ projectPath: "someone/else" }),
    token: async () => "glpat-synthetic-cache-token",
    fetcher: w.remote.fetcher,
    cache: new TtlCache(() => now),
  });
  await assert.rejects(
    other.inspectPr(identity, policy),
    /provider-repository-mismatch/,
  );
});

test("the account a token acts as is read once per token", async () => {
  const w = world(() => 0);
  const create = {
    kind: "pr.create",
    target: {
      repositoryId: "42",
      baseRef: "main",
      headRef: "cab/abcd1234-task",
      expectedHeadSha: "2".repeat(40),
    },
    title: "Change",
    body: "Body",
    draft: false,
  } as never;
  const record = (n: number) =>
    ({
      operationId: `0000000${n}-1111-4111-8111-111111111111`,
      request: {
        operationId: `0000000${n}-1111-4111-8111-111111111111`,
        action: create,
      },
      binding: {},
      beforeState: {
        repositoryPath: "/projects/42",
        projectPath: "group/sub/app",
      },
      observation: null,
    }) as never;
  await w.provider.inspectAction(record(1));
  await w.provider.inspectAction(record(2));
  assert.equal(w.reads(/\/api\/v4\/user$/), 1);
});

/** A service's GitLab seam over a fake glab login, as `gitLabDeliveryFactory` builds it. */
function factoryWorld(now: () => number) {
  const glab = createFakeGlab();
  glab.setToken("glpat-first-login");
  const remote = scriptedGitLabRemote({ repositoryId: "42" });
  remote.state.project = { id: 42, path_with_namespace: "group/sub/app" };
  remote.state.head = "2".repeat(40);
  remote.state.mergeRequests.push(gitLabMergeRequest());
  const used: string[] = [];
  let revoked: string | null = null;
  const fetcher = (async (url: string, init: RequestInit) => {
    const bearer = String(
      (init.headers as Record<string, string>).authorization,
    ).replace("Bearer ", "");
    used.push(bearer);
    return bearer === revoked
      ? new Response("{}", { status: 401 })
      : remote.fetcher(url, init);
  }) as typeof fetch;
  const credentialRef = { value: "glab:gitlab.example.com" };
  const domain = {
    claudeTokenReference: () => null,
    projects: () => [],
    deliveryCredentialReference: () => null,
    discoveryCredentialReference: () => null,
    codeHostCredentials: () => [
      { codeHost: "gitlab", host, credentialRef: credentialRef.value },
    ],
    repositoryLinks: () => ({
      links: [
        {
          codeHost: "gitlab",
          host,
          repositoryId: "42",
          projectPath: "group/sub/app",
        },
      ],
    }),
  } as never;
  const factory = gitLabDeliveryFactory(domain, {
    glabExecutable: glab.executable,
    fetcher,
    now,
  });
  const provider = () =>
    factory("project", policy, host) as GitLabHttpDeliveryProvider;
  return {
    glab,
    used,
    provider,
    revoke: (token: string) => {
      revoked = token;
    },
    credentialRef,
  };
}

test("a glab login is resolved once for a while across actions, and again after a 401", async () => {
  let now = 0;
  const w = factoryWorld(() => now);
  try {
    await w.provider().inspectPr(identity, policy);
    await w.provider().inspectPr(identity, policy);
    assert.equal(w.glab.commands().length, 1, "glab ran once for two actions");
    // The login is replaced and the old token revoked: the first 401 resolves it again and the request succeeds.
    w.glab.setToken("glpat-second-login");
    w.revoke("glpat-first-login");
    const before = w.used.length;
    const observed = await w.provider().inspectPr(identity, policy);
    assert.equal(observed.number, 12);
    assert.equal(w.glab.commands().length, 2);
    // The 401 request, then the project and merge request reads with the new token: no more than one retry.
    assert.deepEqual(
      [...new Set(w.used.slice(before))],
      ["glpat-first-login", "glpat-second-login"],
    );
    assert.equal(
      w.used.slice(before).filter((t) => t === "glpat-first-login").length,
      1,
    );
    // Kept tokens expire: after the lifetime glab is asked again.
    now += cacheTtlMs.token;
    await w.provider().inspectPr(identity, policy);
    assert.equal(w.glab.commands().length, 3);
    // A login that cannot be resolved is not kept.
    w.glab.set("not-signed-in");
    now += cacheTtlMs.token;
    await assert.rejects(
      w.provider().inspectPr(identity, policy),
      /credential-unavailable/,
    );
    w.glab.set("signed-in");
    await w.provider().inspectPr(identity, policy);
  } finally {
    w.glab.close();
  }
});

test("an env credential is read as it is every time, and a 401 is not retried for it", async () => {
  const w = factoryWorld(() => 0);
  const variable = "CAB_TEST_GITLAB_CACHE_TOKEN";
  try {
    w.credentialRef.value = `env:${variable}`;
    process.env[variable] = "glpat-env-one";
    await w.provider().inspectPr(identity, policy);
    process.env[variable] = "glpat-env-two";
    await w.provider().inspectPr(identity, policy);
    assert.equal(w.glab.commands().length, 0);
    assert.ok(
      w.used.includes("glpat-env-one") && w.used.includes("glpat-env-two"),
    );
    w.revoke("glpat-env-two");
    const before = w.used.length;
    await assert.rejects(
      w.provider().inspectPr(identity, policy),
      /provider-http-401/,
    );
    assert.equal(
      w.used.length - before,
      1,
      "no retry without a login to resolve again",
    );
  } finally {
    delete process.env[variable];
    w.glab.close();
  }
});
