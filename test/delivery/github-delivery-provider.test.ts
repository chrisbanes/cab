import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeGateReasons,
  ProjectFieldChangedRefusal,
} from "../../src/standalone/github-delivery.js";

test("actual classic queue, strict status, deployments and app identity hold merge", () => {
  const baseline: Parameters<typeof mergeGateReasons>[0] = {
    draft: false,
    merged: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    queue: false,
    reviewDecision: "APPROVED",
    unresolvedThreads: false,
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    strict: false,
    deployments: [],
    requiredEnvironments: [],
    checks: [
      { name: "build", appId: 17, sha: "1".repeat(40), status: "success" },
    ],
    requiredChecks: [{ name: "build", appId: 17 }],
    unsupportedRules: [],
    allowedMethods: ["squash"],
  };
  assert.deepEqual(mergeGateReasons(baseline), []);
  assert.deepEqual(mergeGateReasons({ ...baseline, queue: true }), [
    "merge-queue-required",
  ]);
  assert.ok(
    mergeGateReasons({
      ...baseline,
      strict: true,
      mergeStateStatus: "BEHIND",
    }).includes("strict-head-behind"),
  );
  assert.ok(
    mergeGateReasons({
      ...baseline,
      requiredEnvironments: ["production"],
    }).includes("deployment-production-unproved"),
  );
  assert.ok(
    mergeGateReasons({
      ...baseline,
      checks: [
        { name: "build", appId: 18, sha: "1".repeat(40), status: "success" },
      ],
    }).includes("check-build-unproved"),
  );
  assert.ok(
    mergeGateReasons({
      ...baseline,
      checks: [
        { name: "build", appId: 17, sha: "3".repeat(40), status: "success" },
      ],
    }).includes("check-build-unproved"),
  );
});

import { randomUUID } from "node:crypto";
import {
  GitHubHttpDeliveryProvider,
  IssueChangedRefusal,
} from "../../src/standalone/github-delivery.js";
import type { DeliveryActionRecord } from "../../src/core/delivery.js";
import { DomainPolicyError } from "../../src/core/domain.js";
function commentRecord(): DeliveryActionRecord {
  const projectId = randomUUID(),
    taskId = randomUUID(),
    operationId = randomUUID();
  return {
    operationId,
    request: {
      operationId,
      action: {
        kind: "issue.comment",
        target: { repositoryId: "R1", number: 7, nodeId: "I7" },
        body: "Reviewed text",
      },
    },
    binding: {
      projectId,
      taskId,
      assignmentId: randomUUID(),
      taskVersion: 1,
      assignmentVersion: 1,
      workId: "w",
      workRevision: 1,
      conversationRevision: 1,
    },
    policyVersion: 2,
    state: "attempting",
    attempts: 1,
    beforeState: { repositoryPath: "/repos/org/repo" },
    observation: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("provider rejects a non-comment operator action as typed policy before network access", async () => {
  let requests = 0;
  const provider = new GitHubHttpDeliveryProvider("fixture", async () => {
    requests++;
    throw new Error("provider should not be called");
  });
  const record = commentRecord();
  record.binding = {
    actor: "operator",
    principal: "installation-operator",
    projectId: randomUUID(),
    taskId: randomUUID(),
    taskVersion: 1,
    sourceId: randomUUID(),
    sourceRevision: 1,
    sourceDigest: "a".repeat(64),
    sourceNodeId: "I7",
    sourceRepositoryId: "R1",
    policyVersion: 2,
  };
  record.request.action = {
    kind: "issue.labels",
    target: { repositoryId: "R1", nodeId: "I7", number: 7 },
    add: ["progress"],
    remove: [],
  };
  await assert.rejects(
    provider.performAction(record),
    (error) =>
      error instanceof DomainPolicyError &&
      error.code === "forbidden" &&
      error.message ===
        "Operator delivery only permits the bound issue.comment",
  );
  assert.equal(requests, 0);
});
test("lost create response is reconciled only by complete exact-author marker readback", async () => {
  const record = commentRecord();
  let effects = 0;
  let duplicate = false;
  let partial = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST" && url.pathname.endsWith("/comments")) {
      effects++;
      throw new Error("lost response");
    }
    if (url.pathname === "/graphql")
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname === "/user") return Response.json({ node_id: "U1" });
    if (url.pathname.endsWith("/issues/7"))
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "open",
        title: "T",
        body: "B",
        labels: [],
      });
    if (url.searchParams.get("page") === "2") {
      if (partial) throw new Error("page lost");
      const c = {
        node_id: "C1",
        body: `Reviewed text\n\n<!-- ensemble-operation:${record.operationId} -->`,
        user: { node_id: "U1" },
      };
      return Response.json(duplicate ? [c, { ...c, node_id: "C2" }] : [c]);
    }
    if (url.pathname.endsWith("/comments"))
      return Response.json([], {
        headers: {
          link: '<https://api.github.com/repos/org/repo/issues/7/comments?page=2>; rel="next"',
        },
      });
    throw new Error("unexpected route");
  };
  const provider = new GitHubHttpDeliveryProvider("non-secret-marker", fetcher);
  assert.equal((await provider.performAction(record)).state, "uncertain");
  assert.equal(
    (await provider.inspectAction(record)).state,
    "confirmed-success",
  );
  assert.equal(effects, 1);
  duplicate = true;
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  duplicate = false;
  partial = true;
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  assert.equal(effects, 1);
});

function prProviderFixture(change: Record<string, unknown> = {}) {
  const head = "1".repeat(40),
    base = "2".repeat(40);
  let writes = 0;
  const graphPr = {
    id: "P7",
    number: 7,
    repository: { id: "R1", nameWithOwner: "org/repo" },
    baseRefName: "main",
    headRefName: "cb/change",
    headRefOid: head,
    baseRefOid: base,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isMergeQueueEnabled: false,
    closingIssuesReferences: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    baseRef: { target: { oid: base }, branchProtectionRule: null },
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...change,
  };
  const raw = {
    node_id: "P7",
    number: 7,
    title: "PR",
    body: "B",
    draft: false,
    merged: false,
    head: { sha: head, ref: "cb/change", repo: { node_id: "R1" } },
    base: { sha: base, ref: "main", repo: { node_id: "R1" } },
  };
  let protection: unknown = null;
  let threadPages: unknown[] | null = null;
  let rules: unknown[] = [],
    checks: unknown[] = [
      {
        node_id: "CR1",
        completed_at: "2026-10-01T10:00:00Z",
        started_at: null,
        name: "build",
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { id: 17 },
      },
    ];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT") {
      writes++;
      return Response.json({ merged: true });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("EnsembleDeliveryPr")) {
        assert.match(body.query, /isMergeQueueEnabled/);
        assert.match(body.query, /requiresDeployments/);
        assert.match(body.query, /requiredDeploymentEnvironments/);
        assert.match(body.query, /requiresStrictStatusChecks/);
        const after = body.variables.after as string | null;
        return Response.json({
          data: {
            node: threadPages
              ? {
                  ...graphPr,
                  reviewThreads:
                    threadPages[after === null ? 0 : Number(after)],
                }
              : graphPr,
          },
        });
      }
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    }
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname.endsWith("/pulls/7")) return Response.json(raw);
    if (url.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: checks.length, check_runs: checks });
    if (
      url.pathname.endsWith("/statuses") ||
      url.pathname.endsWith("/comments") ||
      url.pathname.endsWith("/reviews")
    )
      return Response.json([]);
    if (url.pathname.includes("/rules/branches/")) return Response.json(rules);
    if (url.pathname.endsWith("/protection"))
      return protection === null
        ? new Response("", { status: 404 })
        : Response.json(protection);
    if (url.pathname.endsWith("/deployments")) return Response.json([]);
    throw new Error("unexpected provider route");
  };
  const provider = new GitHubHttpDeliveryProvider("fixture-marker", fetcher),
    identity = {
      repositoryId: "R1",
      prNumber: 7,
      expectedPrNodeId: "P7",
      expectedHeadSha: head,
    };
  const policy = {
    version: 2,
    mode: "through-merge" as const,
    credentialRef: null,
    grants: [],
    requiredChecks: [{ name: "build", appId: 17 }],
  };
  return {
    provider,
    identity,
    policy,
    graphPr,
    raw,
    getWrites: () => writes,
    setThreadPages: (v: unknown[]) => {
      threadPages = v;
    },
    setProtection: (value: unknown) => {
      protection = value;
    },
    setRules: (v: unknown[]) => {
      rules = v;
    },
    setChecks: (v: unknown[]) => {
      checks = v;
    },
  };
}
test("HTTP provider holds actual classic queue/strict/deployment and unsupported effective update rules", async () => {
  for (const [change, reason] of [
    [{ isMergeQueueEnabled: true }, "merge-queue-required"],
    [
      {
        mergeStateStatus: "BEHIND",
        baseRef: {
          target: { oid: "2".repeat(40) },
          branchProtectionRule: {
            requiresDeployments: false,
            requiredDeploymentEnvironments: [],
            requiresStrictStatusChecks: true,
          },
        },
      },
      "strict-head-behind",
    ],
    [
      {
        baseRef: {
          target: { oid: "2".repeat(40) },
          branchProtectionRule: {
            requiresDeployments: true,
            requiredDeploymentEnvironments: ["production"],
            requiresStrictStatusChecks: false,
          },
        },
      },
      "deployment-production-unproved",
    ],
  ] as const) {
    const f = prProviderFixture(change);
    const observation = await f.provider.inspectPr(f.identity, f.policy);
    assert.ok(observation.mergeBlockers.includes(reason));
    await assert.rejects(
      () =>
        f.provider.preflight(
          {
            kind: "pr.merge",
            target: {
              repositoryId: "R1",
              number: 7,
              nodeId: "P7",
              baseRef: "main",
              headRef: "cb/change",
              expectedHeadSha: f.identity.expectedHeadSha,
            },
            method: "squash",
            reviewedResultIds: [],
          },
          f.policy,
        ),
      /gates-held/,
    );
    assert.equal(f.getWrites(), 0);
  }
  const f = prProviderFixture();
  f.setRules([{ type: "update" }]);
  assert.ok(
    (await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers.includes(
      "unsupported-rule-update",
    ),
  );
  assert.equal(f.getWrites(), 0);
});
test("HTTP exact-head observation rejects app spoofing, missing data and malformed classic queue", async () => {
  const f = prProviderFixture();
  assert.deepEqual(
    (await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers,
    [],
  );
  f.setChecks([
    {
      node_id: "CR2",
      completed_at: "2026-10-01T11:00:00Z",
      started_at: null,
      name: "build",
      head_sha: "1".repeat(40),
      status: "completed",
      conclusion: "success",
      app: { id: 18 },
    },
  ]);
  assert.ok(
    (await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers.includes(
      "check-build-unproved",
    ),
  );
  f.graphPr.isMergeQueueEnabled = null as unknown as boolean;
  await assert.rejects(() => f.provider.inspectPr(f.identity, f.policy));
  assert.equal(f.getWrites(), 0);
});

test("effective pull-request merge methods and conversation requirements constrain actual merge", async () => {
  const f = prProviderFixture({
    reviewThreads: {
      nodes: [
        {
          id: "T1",
          isResolved: false,
          firstComment: { nodes: [{ id: "C1" }] },
          latestComment: { nodes: [{ id: "C1" }] },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  });
  assert.ok(
    !(await f.provider.inspectPr(f.identity, f.policy)).mergeBlockers.includes(
      "unresolved-review-thread",
    ),
  );
  f.setRules([
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
  ]);
  const p = await f.provider.inspectPr(f.identity, f.policy);
  assert.deepEqual(p.allowedMethods, ["squash"]);
  assert.ok(p.mergeBlockers.includes("unresolved-review-thread"));
});

test("fresh closed-issue readback reports the latest ClosedEvent and its closer as facts", async () => {
  let state = "closed";
  let nodes: unknown[] = [];
  let nodeId = "I1";
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("EnsembleDeliveryClosure")) {
        assert.match(body.query, /ClosedEvent\{id closer/);
        return Response.json({
          data: {
            node: {
              id: nodeId,
              repository: { id: "R1" },
              timelineItems: { nodes },
            },
          },
        });
      }
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    }
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname.endsWith("/issues/1"))
      return Response.json({
        node_id: "I1",
        number: 1,
        state,
        title: "T",
        body: "O",
        labels: [{ name: "ready" }],
      });
    throw new Error("unexpected read");
  };
  const provider = new GitHubHttpDeliveryProvider("fixture-marker", fetcher),
    target = { repositoryId: "R1", nodeId: "I1", number: 1 };
  const event = async () => {
    const inspection = await provider.inspectClosedIssue(target);
    assert.equal(inspection.state, "closed");
    return inspection.state === "closed" ? inspection : assert.fail();
  };
  nodes = [{ id: "CE1", closer: { __typename: "PullRequest", id: "P7" } }];
  const merged = await event();
  assert.deepEqual(merged.snapshot.labels, ["ready"]);
  assert.deepEqual(merged.closedEvent, {
    id: "CE1",
    closerKind: "pull-request",
    closerPrNodeId: "P7",
  });
  nodes = [{ id: "CE2", closer: null }];
  assert.deepEqual((await event()).closedEvent, {
    id: "CE2",
    closerKind: "none",
    closerPrNodeId: null,
  });
  nodes = [{ id: "CE3", closer: { __typename: "Commit" } }];
  assert.deepEqual((await event()).closedEvent, {
    id: "CE3",
    closerKind: "other",
    closerPrNodeId: null,
  });
  nodes = [];
  assert.equal((await event()).closedEvent, null);
  nodeId = "I_other";
  await assert.rejects(
    () => provider.inspectClosedIssue(target),
    /identity-mismatch/,
  );
  state = "open";
  assert.deepEqual(await provider.inspectClosedIssue(target), {
    state: "open",
  });
});

import type { ExternalAction } from "../../src/core/delivery.js";
test("all eleven concrete action transports preserve exact target, incremental labels and readback", async () => {
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  let reads = 0;
  class DispatchProvider extends GitHubHttpDeliveryProvider {
    override async inspectAction() {
      reads++;
      return {
        state: "confirmed-success" as const,
        reason: null,
        receipt: { nodeId: "confirmed" },
      };
    }
  }
  const provider = new DispatchProvider(
    "fixture-marker",
    async (input, init) => {
      writes.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ data: {} });
    },
  );
  const issue = { repositoryId: "R1", nodeId: "I7", number: 7 },
    pr = {
      repositoryId: "R1",
      nodeId: "P7",
      number: 7,
      baseRef: "main",
      headRef: "cb/change",
      expectedHeadSha: "1".repeat(40),
    };
  const actions: ExternalAction[] = [
    { kind: "issue.comment", target: issue, body: "Comment" },
    { kind: "issue.labels", target: issue, add: ["progress"], remove: ["old"] },
    { kind: "issue.edit", target: issue, fields: { title: "Title" } },
    {
      kind: "project.field",
      target: issue,
      projectNodeId: "P1",
      itemNodeId: "ITEM1",
      fieldNodeId: "F1",
      optionNodeId: "O1",
    },
    {
      kind: "pr.create",
      target: {
        repositoryId: "R1",
        baseRef: "main",
        headRef: "cb/change",
        expectedHeadSha: "1".repeat(40),
      },
      title: "PR",
      body: "Body",
      draft: true,
    },
    { kind: "pr.edit", target: pr, fields: { body: "Reviewed" } },
    { kind: "pr.ready", target: pr },
    { kind: "pr.merge", target: pr, method: "squash", reviewedResultIds: [] },
    { kind: "issue.close", target: issue, reviewedResultIds: [] },
    {
      kind: "pr.thread.reply",
      target: { ...pr, threadNodeId: "T1" },
      body: "Fixed",
    },
    {
      kind: "pr.thread.resolve",
      target: { ...pr, threadNodeId: "T1" },
      expectedLatestCommentNodeId: "C2",
    },
  ];
  for (const action of actions) {
    const record = commentRecord();
    record.request.action = action;
    assert.equal(
      (await provider.performAction(record)).state,
      "confirmed-success",
    );
  }
  assert.equal(reads, 11);
  assert.deepEqual(
    writes.map((w) => [w.method, w.path]),
    [
      ["POST", "/repos/org/repo/issues/7/comments"],
      ["DELETE", "/repos/org/repo/issues/7/labels/old"],
      ["POST", "/repos/org/repo/issues/7/labels"],
      ["PATCH", "/repos/org/repo/issues/7"],
      ["POST", "/graphql"],
      ["POST", "/repos/org/repo/pulls"],
      ["PATCH", "/repos/org/repo/pulls/7"],
      ["POST", "/graphql"],
      ["PUT", "/repos/org/repo/pulls/7/merge"],
      ["PATCH", "/repos/org/repo/issues/7"],
      ["POST", "/graphql"],
      ["POST", "/graphql"],
    ],
  );
  assert.deepEqual(writes[8]?.body, {
    sha: pr.expectedHeadSha,
    merge_method: "squash",
  });
  assert.deepEqual(writes[2]?.body, { labels: ["progress"] });
  assert.match(JSON.stringify(writes[0]?.body), /ensemble-operation:/);
  assert.match(JSON.stringify(writes[5]?.body), /ensemble-operation:/);
});

test("legacy signature/update restrictions hold and linear history restricts merge method", async () => {
  const f = prProviderFixture();
  f.setProtection({
    required_signatures: { enabled: true },
    restrictions: { users: [], teams: [], apps: [] },
    required_linear_history: { enabled: true },
  });
  const p = await f.provider.inspectPr(f.identity, f.policy);
  assert.ok(p.mergeBlockers.includes("classic-signature-proof-unsupported"));
  assert.ok(p.mergeBlockers.includes("classic-update-restriction-unproved"));
  assert.deepEqual(p.allowedMethods, ["squash"]);
});

function redirectFixture(routes: Record<string, () => Response>) {
  const calls: Array<{
    method: string;
    href: string;
    redirect?: RequestRedirect;
  }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      method: init?.method ?? "GET",
      href: url.href,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    if (url.pathname === "/graphql")
      return Response.json({
        data: {
          node: String(init?.body).includes("EnsembleDeliveryClosure")
            ? {
                id: "I7",
                repository: { id: "R1" },
                timelineItems: { nodes: [] },
              }
            : { id: "R1", nameWithOwner: "org/repo" },
        },
      });
    const route = routes[url.pathname];
    if (route) return route();
    if (url.pathname.endsWith("/issues/7"))
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "closed",
        title: "T",
        body: "B",
        labels: [],
      });
    throw new Error(`unexpected provider route ${url.href}`);
  };
  return {
    calls,
    provider: new GitHubHttpDeliveryProvider("fixture-marker", fetcher),
  };
}
const target = { repositoryId: "R1", nodeId: "I7", number: 7 };
const repositoryJson = () =>
  Response.json({
    node_id: "R1",
    full_name: "org/repo",
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: false,
  });
const redirectTo = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });

test("a GET follows up to three same-origin redirects and a fourth fails", async () => {
  const routes = {
    "/repos/org/repo": () => redirectTo(301, "/repositories/1"),
    "/repositories/1": () =>
      redirectTo(302, "https://api.github.com/repositories/2"),
    "/repositories/2": () => redirectTo(307, "/repositories/3"),
    "/repositories/3": repositoryJson,
  };
  const followed = redirectFixture(routes);
  const inspection = await followed.provider.inspectClosedIssue(target);
  assert.equal(
    inspection.state === "closed" && inspection.snapshot.nodeId,
    "I7",
  );
  assert.deepEqual(
    followed.calls
      .filter((call) => call.method === "GET")
      .slice(0, 4)
      .map((call) => call.href),
    [
      "https://api.github.com/repos/org/repo",
      "https://api.github.com/repositories/1",
      "https://api.github.com/repositories/2",
      "https://api.github.com/repositories/3",
    ],
  );
  assert.ok(
    followed.calls
      .filter((call) => call.method === "GET")
      .every((call) => call.redirect === "manual"),
  );

  await assert.rejects(
    redirectFixture({
      ...routes,
      "/repositories/3": () => redirectTo(301, "/repositories/4"),
      "/repositories/4": repositoryJson,
    }).provider.inspectClosedIssue(target),
    /provider-origin-mismatch/,
  );
});

test("a GET refuses a redirect away from the API origin", async () => {
  for (const location of [
    "https://evil.example/repos/org/repo",
    "http://api.github.com/repos/org/repo",
  ]) {
    const { provider, calls } = redirectFixture({
      "/repos/org/repo": () => redirectTo(302, location),
    });
    await assert.rejects(
      provider.inspectClosedIssue(target),
      /provider-origin-mismatch/,
      location,
    );
    assert.equal(
      calls.filter((call) => call.method === "GET").length,
      1,
      location,
    );
  }
});

test("a POST refuses redirects instead of replaying the body", async () => {
  const record = commentRecord();
  const { provider, calls } = redirectFixture({
    "/repos/org/repo": repositoryJson,
    "/repos/org/repo/issues/7/comments": () =>
      redirectTo(307, "https://api.github.com/repos/org/repo/issues/7/other"),
  });
  assert.equal((await provider.performAction(record)).state, "uncertain");
  const posts = calls.filter(
    (call) => call.method === "POST" && call.href.endsWith("/comments"),
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.redirect, "error");
  assert.ok(calls.every((call) => !call.href.endsWith("/other")));
});

test("pagination follows only a same-origin next link", async () => {
  const record = commentRecord();
  const { provider } = redirectFixture({
    "/repos/org/repo": repositoryJson,
    "/user": () => Response.json({ node_id: "U1" }),
    "/repos/org/repo/issues/7/comments": () =>
      Response.json([], {
        headers: {
          link: '<https://evil.example/repos/org/repo/issues/7/comments?page=2>; rel="next"',
        },
      }),
  });
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
});

const prRepository = (url: URL) =>
  url.pathname === "/graphql"
    ? Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      })
    : url.pathname === "/repos/org/repo"
      ? Response.json({
          node_id: "R1",
          full_name: "org/repo",
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: false,
        })
      : null;

test("pr.create readback queries only the exact head and base and tolerates a deleted fork's PR", async () => {
  const record = commentRecord();
  const head = "1".repeat(40);
  record.request.action = {
    kind: "pr.create",
    target: {
      repositoryId: "R1",
      baseRef: "main",
      headRef: "cb/x",
      expectedHeadSha: head,
    },
    title: "PR",
    body: "Body",
    draft: true,
  };
  const marker = `<!-- ensemble-operation:${record.operationId} -->`;
  const listings: URL[] = [];
  const unmarked = new GitHubHttpDeliveryProvider(
    "fixture-marker",
    async (input) => {
      const url = new URL(String(input));
      const repository = prRepository(url);
      if (repository) return repository;
      if (url.pathname === "/user") return Response.json({ node_id: "U1" });
      listings.push(url);
      const repo = { node_id: "R1" };
      return Response.json([
        // A PR from a deleted fork: GitHub reports head.repo as null.
        { node_id: "P0", number: 1, body: null, head: { repo: null } },
        {
          node_id: "P9",
          number: 9,
          title: "PR",
          body: `Body\n\n${marker}`,
          draft: true,
          user: { node_id: "U1" },
          head: { sha: head, ref: "cb/x", repo },
          base: { ref: "main", repo },
        },
      ]);
    },
  );
  const observation = await unmarked.inspectAction(record);
  assert.equal(observation.state, "confirmed-success");
  assert.deepEqual(observation.receipt, {
    nodeId: "P9",
    number: 9,
    headSha: head,
  });
  assert.equal(listings.length, 1);
  assert.equal(listings[0]?.pathname, "/repos/org/repo/pulls");
  assert.equal(listings[0]?.searchParams.get("head"), "org:cb/x");
  assert.equal(listings[0]?.searchParams.get("base"), "main");
  assert.equal(listings[0]?.searchParams.get("state"), "all");
});

test("a rate-limited write is a retryable confirmed failure that names when to resume", async () => {
  for (const limited of [
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    () =>
      new Response("You have exceeded a secondary rate limit", {
        status: 403,
      }),
  ]) {
    const before = Date.now();
    const observation = await new GitHubHttpDeliveryProvider(
      "fixture-marker",
      async (input) => prRepository(new URL(String(input))) ?? limited(),
    ).performAction(commentRecord());
    assert.equal(observation.state, "confirmed-failure");
    assert.equal(observation.retryable, true);
    assert.ok((observation.resumeAt ?? 0) >= before + 30_000);
  }
  const denied = await new GitHubHttpDeliveryProvider(
    "fixture-marker",
    async (input) =>
      prRepository(new URL(String(input))) ??
      new Response("denied", { status: 403 }),
  ).performAction(commentRecord());
  assert.equal(denied.state, "confirmed-failure");
  assert.equal(denied.retryable, undefined);
});

test("pull-request observation lists every paginated review thread with first and latest comment", async () => {
  const f = prProviderFixture();
  const thread = (
    id: string,
    isResolved: boolean,
    first: string,
    last: string,
  ) => ({
    id,
    isResolved,
    firstComment: { nodes: [{ id: first }] },
    latestComment: { nodes: [{ id: last }] },
  });
  f.setThreadPages([
    {
      nodes: [thread("T2", true, "C3", "C3")],
      pageInfo: { hasNextPage: true, endCursor: "1" },
    },
    {
      nodes: [thread("T1", false, "C1", "C2")],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  ]);
  f.setRules([
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        required_review_thread_resolution: true,
      },
    },
  ]);
  const p = await f.provider.inspectPr(f.identity, f.policy);
  assert.deepEqual(p.reviewThreads, [
    {
      nodeId: "T1",
      isResolved: false,
      firstCommentNodeId: "C1",
      latestCommentNodeId: "C2",
    },
    {
      nodeId: "T2",
      isResolved: true,
      firstCommentNodeId: "C3",
      latestCommentNodeId: "C3",
    },
  ]);
  // An unresolved thread on a later page still holds the conversation gate.
  assert.ok(p.mergeBlockers.includes("unresolved-review-thread"));
});

/** A scripted GitHub holding one review thread; counts mutations and can lose their responses. */
function threadFixture() {
  const state = {
    resolved: false,
    resolvedBy: null as string | null,
    comments: [
      {
        id: "C1",
        body: "Please fix",
        state: "SUBMITTED",
        author: "U_REVIEWER",
      },
    ],
    pr: { id: "P7", number: 7, repository: { id: "R1" } },
    replies: 0,
    resolves: 0,
    lost: false,
    graphqlErrors: false,
    replyState: "SUBMITTED",
    status: 200,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/user") return Response.json({ node_id: "U1" });
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    assert.equal(url.pathname, "/graphql");
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /^(?:query|mutation) (\w+)/.exec(query)?.[1];
    if (operation === "EnsembleDeliveryRepository")
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    if (operation === "EnsembleDeliveryThread")
      return Response.json({
        data: {
          node: {
            id: "T1",
            isResolved: state.resolved,
            resolvedBy: state.resolvedBy ? { id: state.resolvedBy } : null,
            pullRequest: state.pr,
            latestComment: { nodes: [{ id: state.comments.at(-1)?.id }] },
            comments: {
              nodes: state.comments.map((c) => ({
                id: c.id,
                body: c.body,
                state: c.state,
                author: { __typename: "User", id: c.author },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    if (state.status !== 200) return new Response("", { status: state.status });
    if (operation === "EnsembleDeliveryThreadReply") {
      state.replies++;
      assert.equal(variables.thread, "T1");
      if (state.graphqlErrors)
        return Response.json({ data: null, errors: [{ message: "nope" }] });
      state.comments.push({
        id: `C${state.comments.length + 1}`,
        body: variables.body,
        state: state.replyState,
        author: "U1",
      });
    } else if (operation === "EnsembleDeliveryThreadResolve") {
      state.resolves++;
      assert.deepEqual(variables, { thread: "T1" });
      state.resolved = true;
      state.resolvedBy = "U1";
    } else throw new Error(`unexpected GraphQL ${operation}`);
    if (state.lost) throw new Error("scripted lost response");
    return Response.json({ data: {} });
  };
  const provider = new GitHubHttpDeliveryProvider("fixture-marker", fetcher);
  const target = {
    repositoryId: "R1",
    nodeId: "P7",
    number: 7,
    threadNodeId: "T1",
  };
  const record = (action: ExternalAction) => {
    const r = commentRecord();
    r.request.action = action;
    return r;
  };
  return {
    state,
    provider,
    policy: {
      version: 2,
      mode: "reviewable-pr" as const,
      credentialRef: null,
      grants: [],
      requiredChecks: [],
    },
    reply: record({ kind: "pr.thread.reply", target, body: "Fixed in abc" }),
    resolve: (expected: string) =>
      record({
        kind: "pr.thread.resolve",
        target,
        expectedLatestCommentNodeId: expected,
      }),
  };
}

test("thread reply is confirmed only by one exact submitted marker comment by the credential user", async () => {
  const f = threadFixture();
  const before = await f.provider.preflight(f.reply.request.action, f.policy);
  f.reply.beforeState = before;
  const result = await f.provider.performAction(f.reply);
  assert.equal(result.state, "confirmed-success");
  assert.equal(result.receipt?.nodeId, "C2");
  assert.equal(f.state.replies, 1);
  assert.match(
    f.state.comments[1]?.body ?? "",
    /^Fixed in abc\n\n<!-- ensemble-operation:/,
  );
  const exact = f.state.comments[1];
  assert.ok(exact);
  const unproved = async (change: () => void, restore: () => void) => {
    change();
    const o = await f.provider.inspectAction(f.reply);
    restore();
    assert.equal(o.state, "uncertain");
  };
  await unproved(
    () => (exact.state = "PENDING"),
    () => (exact.state = "SUBMITTED"),
  );
  await unproved(
    () => (exact.author = "U2"),
    () => (exact.author = "U1"),
  );
  await unproved(
    () => f.state.comments.push({ ...exact, id: "C9" }),
    () => f.state.comments.pop(),
  );
  await unproved(
    () => (f.state.pr = { ...f.state.pr, id: "P8" }),
    () => (f.state.pr = { ...f.state.pr, id: "P7" }),
  );
  assert.equal(
    (await f.provider.inspectAction(f.reply)).state,
    "confirmed-success",
  );
});

test("thread reply to an already resolved thread is allowed", async () => {
  const f = threadFixture();
  f.state.resolved = true;
  const before = await f.provider.preflight(f.reply.request.action, f.policy);
  assert.equal(before.isResolved, true);
});

test("thread resolve is refused in preflight when resolved, stale or on another PR, without any mutation", async () => {
  const f = threadFixture();
  const stale = f.resolve("C0").request.action;
  await assert.rejects(f.provider.preflight(stale, f.policy), /resolve-held/);
  f.state.resolved = true;
  await assert.rejects(
    f.provider.preflight(f.resolve("C1").request.action, f.policy),
    /resolve-held/,
  );
  f.state.resolved = false;
  f.state.pr = { ...f.state.pr, id: "P8" };
  await assert.rejects(
    f.provider.preflight(f.resolve("C1").request.action, f.policy),
    /thread-mismatch/,
  );
  f.state.pr = { ...f.state.pr, id: "P7" };
  f.state.comments.push({
    id: "C2",
    body: "More",
    state: "SUBMITTED",
    author: "U_REVIEWER",
  });
  await assert.rejects(
    f.provider.preflight(f.resolve("C1").request.action, f.policy),
    /resolve-held/,
  );
  assert.equal(f.state.resolves + f.state.replies, 0);
});

test("thread resolve is confirmed only when the credential user resolved the thread", async () => {
  const f = threadFixture();
  const record = f.resolve("C1");
  record.beforeState = await f.provider.preflight(
    record.request.action,
    f.policy,
  );
  const result = await f.provider.performAction(record);
  assert.deepEqual(
    [result.state, result.receipt?.nodeId],
    ["confirmed-success", "T1"],
  );
  assert.equal(f.state.resolves, 1);
  f.state.resolvedBy = "U_OTHER";
  assert.equal((await f.provider.inspectAction(record)).state, "uncertain");
  f.state.resolved = false;
  assert.equal((await f.provider.inspectAction(record)).state, "uncertain");
});

test("thread write failures are uncertain unless the provider definitively rejected the request", async () => {
  for (const [name, change, expected] of [
    [
      "lost response with effect",
      (s: ReturnType<typeof threadFixture>["state"]) => {
        s.lost = true;
      },
      "uncertain",
    ],
    [
      "GraphQL errors without effect",
      (s: ReturnType<typeof threadFixture>["state"]) => {
        s.graphqlErrors = true;
      },
      "uncertain",
    ],
    [
      "pending review comment",
      (s: ReturnType<typeof threadFixture>["state"]) => {
        s.replyState = "PENDING";
      },
      "uncertain",
    ],
    [
      "HTTP 403",
      (s: ReturnType<typeof threadFixture>["state"]) => {
        s.status = 403;
      },
      "confirmed-failure",
    ],
  ] as const) {
    const f = threadFixture();
    change(f.state);
    f.reply.beforeState = await f.provider.preflight(
      f.reply.request.action,
      f.policy,
    );
    const result = await f.provider.performAction(f.reply);
    assert.equal(result.state, expected, name);
    if (name === "HTTP 403") assert.equal(result.reason, "provider-http-403");
    // Only readback, never the lost response, proves the effect.
    if (name === "lost response with effect")
      assert.equal(
        (await f.provider.inspectAction(f.reply)).state,
        "confirmed-success",
      );
  }
});

function issueEditProvider(issue: { title: string; body: string | null }) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/graphql")
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname.endsWith("/issues/7"))
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "open",
        labels: [],
        ...issue,
      });
    throw new Error("unexpected route");
  };
  return {
    requests,
    provider: new GitHubHttpDeliveryProvider("non-secret-marker", fetcher),
  };
}
const editAction = (expected: { title: string; body: string }) =>
  ({
    kind: "issue.edit",
    target: { repositoryId: "R1", number: 7, nodeId: "I7" },
    fields: { title: "New title", body: "New body" },
    expected,
  }) as const;
const noPolicy = {} as Parameters<GitHubHttpDeliveryProvider["preflight"]>[1];

test("an operator edit is refused before any write when GitHub no longer shows the expected text", async () => {
  const mismatches = [
    { title: "Changed", body: "B" },
    { title: "T", body: "Changed" },
    // GitHub reports an empty body as null; the expectation is the synced "".
    { title: "T", body: null },
  ];
  for (const issue of mismatches) {
    const { provider, requests } = issueEditProvider(issue);
    await assert.rejects(
      provider.preflight(editAction({ title: "T", body: "B" }), noPolicy),
      (error) => error instanceof IssueChangedRefusal,
    );
    assert.ok(!requests.some((r) => r.startsWith("PATCH")), requests.join());
  }
});

test("an operator edit proceeds when GitHub shows the expected text, including an empty body", async () => {
  const same = issueEditProvider({ title: "T", body: "B" });
  assert.equal(
    (
      await same.provider.preflight(
        editAction({ title: "T", body: "B" }),
        noPolicy,
      )
    ).title,
    "T",
  );
  const empty = issueEditProvider({ title: "T", body: null });
  await empty.provider.preflight(
    editAction({ title: "T", body: "" }),
    noPolicy,
  );
  // An edit with nothing expected (the runtime path) is not compared.
  const runtime = issueEditProvider({ title: "Other", body: "Other" });
  await runtime.provider.preflight(
    { ...editAction({ title: "x", body: "y" }), expected: undefined },
    noPolicy,
  );
});

/** A Project item whose Status the fake GitHub holds; `movedAfterWrite` models a human move that lands with our write. */
function projectStatusFixture(
  initial: string | null,
  movedAfterWrite?: string,
) {
  let status = initial;
  const mutations: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/user") return Response.json({ node_id: "U1" });
    if (url.pathname === "/repos/org/repo") return repositoryJson();
    if (url.pathname === "/repos/org/repo/issues/7")
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "open",
        title: "T",
        body: "B",
        labels: [],
      });
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    if (query.includes("EnsembleDeliveryRepository"))
      return Response.json({
        data: { node: { id: "R1", nameWithOwner: "org/repo" } },
      });
    if (query.includes("mutation EnsembleDeliveryProject")) {
      mutations.push(variables);
      status = movedAfterWrite ?? variables.option ?? null;
      return Response.json({ data: {} });
    }
    return Response.json({
      data: {
        node: {
          id: "ITEM1",
          project: { id: "P1" },
          content: { id: "I7", repository: { id: "R1" } },
          fieldValues: {
            nodes: status
              ? [
                  {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    optionId: status,
                    field: { id: "F1" },
                  },
                ]
              : [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        field: {
          id: "F1",
          options: [{ id: "O1" }, { id: "O2" }, { id: "O3" }],
          project: { id: "P1" },
        },
      },
    });
  };
  const action = (expected?: {
    optionNodeId: string | null;
  }): Extract<ExternalAction, { kind: "project.field" }> => ({
    kind: "project.field",
    target: { repositoryId: "R1", nodeId: "I7", number: 7 },
    projectNodeId: "P1",
    itemNodeId: "ITEM1",
    fieldNodeId: "F1",
    optionNodeId: "O2",
    ...(expected ? { expected } : {}),
  });
  return {
    provider: new GitHubHttpDeliveryProvider("fixture-marker", fetcher),
    mutations,
    action,
    status: () => status,
  };
}
const projectPolicy = {
  version: 1,
  mode: "reviewable-pr" as const,
  credentialRef: null,
  grants: [],
  requiredChecks: [],
};

test("a project.field write whose expected Status no longer holds makes no mutation", async () => {
  const f = projectStatusFixture("O3");
  await assert.rejects(
    () => f.provider.preflight(f.action({ optionNodeId: "O1" }), projectPolicy),
    ProjectFieldChangedRefusal,
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(f.status(), "O3");
  // An item with no value is a different expectation from one holding an option.
  const empty = projectStatusFixture(null);
  await assert.rejects(
    () =>
      empty.provider.preflight(
        empty.action({ optionNodeId: "O1" }),
        projectPolicy,
      ),
    ProjectFieldChangedRefusal,
  );
});

test("a project.field write whose expected Status holds proceeds and is confirmed by readback", async () => {
  for (const [initial, expected] of [
    ["O1", "O1"],
    [null, null],
  ] as const) {
    const f = projectStatusFixture(initial);
    const action = f.action({ optionNodeId: expected });
    const before = await f.provider.preflight(action, projectPolicy);
    assert.equal(before.optionId, initial);
    const record = commentRecord();
    record.request.action = action;
    record.beforeState = before;
    const observation = await f.provider.performAction(record);
    assert.equal(observation.state, "confirmed-success");
    assert.equal(f.mutations.length, 1);
    assert.equal(f.status(), "O2");
  }
});

test("a move between the re-read and the write is detected on readback and stays uncertain", async () => {
  const f = projectStatusFixture("O1", "O3");
  const action = f.action({ optionNodeId: "O1" });
  const record = commentRecord();
  record.request.action = action;
  record.beforeState = await f.provider.preflight(action, projectPolicy);
  const observation = await f.provider.performAction(record);
  assert.equal(f.mutations.length, 1);
  assert.equal(observation.state, "uncertain");
  assert.equal(observation.reason, "provider-effect-unproved");
});

function publicationCaller(projectId = randomUUID()) {
  return {
    actor: "operator" as const,
    principal: "installation-operator" as const,
    purpose: "task-publication" as const,
    projectId,
    taskId: randomUUID(),
    publicationId: randomUUID(),
    sourceId: randomUUID(),
    selectionId: "repo",
    repositoryId: "R1",
    policyVersion: 1,
  };
}
function createRecord(): DeliveryActionRecord {
  const caller = publicationCaller();
  return {
    operationId: caller.publicationId,
    request: {
      operationId: caller.publicationId,
      action: {
        kind: "issue.create",
        target: { repositoryId: "R1" },
        title: "Publish me",
        body: "Do the thing",
        labels: ["ready"],
      },
    },
    binding: caller,
    policyVersion: 1,
    state: "attempting",
    attempts: 1,
    beforeState: { repositoryPath: "/repos/org/repo" },
    observation: null,
    createdAt: Date.parse("2026-10-21T10:00:00Z"),
    updatedAt: 1,
  };
}

/** A fake GitHub holding the issues listed for the credential user, and counting create POSTs. */
function issueFetcher(state: {
  posts: number;
  listed: unknown[];
  lists: string[];
  items?: { id: string; project: { id: string } }[];
  itemAdds?: number;
  login?: string;
}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      const query = String(JSON.parse(String(init?.body)).query);
      if (query.includes("EnsembleDeliveryRepository"))
        return Response.json({
          data: { node: { id: "R1", nameWithOwner: "org/repo" } },
        });
      if (query.includes("EnsembleDeliveryItemAdd")) {
        state.itemAdds = (state.itemAdds ?? 0) + 1;
        return Response.json({
          data: { addProjectV2ItemById: { item: { id: "ITEM1" } } },
        });
      }
      if (query.includes("EnsembleDeliveryIssueItems"))
        return Response.json({
          data: {
            node: {
              id: "I7",
              repository: { id: "R1" },
              projectItems: {
                nodes: state.items ?? [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
    }
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: "R1",
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    if (url.pathname === "/user")
      return Response.json({ node_id: "U1", login: state.login ?? "bot" });
    if (init?.method === "POST" && url.pathname === "/repos/org/repo/issues") {
      state.posts++;
      throw new Error("lost response");
    }
    if (url.pathname === "/repos/org/repo/issues") {
      state.lists.push(url.search);
      return Response.json(state.listed);
    }
    if (url.pathname === "/repos/org/repo/issues/7")
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "open",
        title: "Publish me",
        body: `Do the thing\n\n<!-- ensemble-operation:${state.lists.length ? "x" : "y"} -->`,
        labels: [{ name: "ready" }],
        user: { node_id: "U1" },
      });
    throw new Error(`unexpected route ${url.pathname}`);
  };
}
const markerIssue = (
  record: DeliveryActionRecord,
  patch: Record<string, unknown> = {},
) => ({
  node_id: "I7",
  number: 7,
  title: "Publish me",
  body: `Do the thing\n\n<!-- ensemble-operation:${record.operationId} -->`,
  labels: [{ name: "ready" }],
  user: { node_id: "U1" },
  ...patch,
});

test("a lost issue create is confirmed only by exactly one marker issue by the credential user", async () => {
  const record = createRecord();
  const state = { posts: 0, listed: [] as unknown[], lists: [] as string[] };
  const provider = new GitHubHttpDeliveryProvider(
    "non-secret-marker",
    issueFetcher(state),
  );
  // The POST posts once, with the response lost.
  assert.equal((await provider.performAction(record)).state, "uncertain");
  assert.equal(state.posts, 1);
  // Nothing listed proves nothing: it stays unproved and nothing is sent again.
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  assert.equal(state.posts, 1);
  // The list is the credential user's, from before the record was made.
  assert.match(state.lists[0] ?? "", /creator=bot/);
  assert.match(state.lists[0] ?? "", /state=all/);
  assert.match(
    decodeURIComponent(state.lists[0] ?? ""),
    /since=2026-10-21T09:59:00/,
  );
  state.listed = [markerIssue(record)];
  assert.deepEqual(await provider.inspectAction(record), {
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: "I7", number: 7 },
  });
  // Two marker issues cannot both be the one request.
  state.listed = [
    markerIssue(record),
    markerIssue(record, { node_id: "I8", number: 8 }),
  ];
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  // Another user's issue does not confirm.
  state.listed = [markerIssue(record, { user: { node_id: "U2" } })];
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  // Neither does changed text or a missing label.
  state.listed = [markerIssue(record, { title: "Other" })];
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  state.listed = [markerIssue(record, { labels: [] })];
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  // GitHub matches label names case-insensitively.
  state.listed = [markerIssue(record, { labels: [{ name: "Ready" }] })];
  assert.equal(
    (await provider.inspectAction(record)).state,
    "confirmed-success",
  );
  // A pull request in the list is ignored, even with the marker.
  state.listed = [
    markerIssue(record, { node_id: "PR1", number: 9, pull_request: {} }),
    markerIssue(record),
  ];
  assert.equal(
    (await provider.inspectAction(record)).state,
    "confirmed-success",
  );
});

/** A fake issue 7 carrying `labels`, answering each per-label DELETE with `deleteStatus` and recording writes. */
function labelsFixture(
  labels: string[],
  deleteStatus: number,
  issueStatus = 200,
) {
  const writes: string[] = [];
  const provider = new GitHubHttpDeliveryProvider(
    "fixture-marker",
    async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const repository = prRepository(url);
      if (repository) return repository;
      if (url.pathname === "/user")
        return Response.json({ node_id: "U1", login: "bot" });
      if (method !== "GET") writes.push(`${method} ${url.pathname}`);
      if (method === "DELETE")
        return new Response(null, { status: deleteStatus });
      if (method === "POST") return Response.json([]);
      if (issueStatus !== 200)
        return new Response(null, { status: issueStatus });
      return Response.json({
        node_id: "I7",
        number: 7,
        state: "open",
        title: "t",
        body: "b",
        labels: labels.map((name) => ({ name })),
      });
    },
  );
  const record = (add: string[], remove: string[]) => {
    const r = commentRecord();
    r.request.action = {
      kind: "issue.labels",
      target: { repositoryId: "R1", nodeId: "I7", number: 7 },
      add,
      remove,
    };
    return r;
  };
  return { provider, writes, record };
}

test("removing a label the issue does not carry still sends the add", async () => {
  const absent = labelsFixture(["in-progress"], 404);
  assert.equal(
    (
      await absent.provider.performAction(
        absent.record(["in-progress"], ["needs-triage"]),
      )
    ).state,
    "confirmed-success",
  );
  assert.deepEqual(absent.writes, [
    "DELETE /repos/org/repo/issues/7/labels/needs-triage",
    "POST /repos/org/repo/issues/7/labels",
  ]);
  // Any other failed removal stays unproved and sends no add.
  const failed = labelsFixture(["in-progress"], 500);
  assert.equal(
    (
      await failed.provider.performAction(
        failed.record(["in-progress"], ["needs-triage"]),
      )
    ).state,
    "uncertain",
  );
  assert.deepEqual(failed.writes, [
    "DELETE /repos/org/repo/issues/7/labels/needs-triage",
  ]);
  // A 404 because the issue is gone proves nothing: the readback cannot confirm it.
  const gone = labelsFixture([], 404, 404);
  const record = gone.record([], ["needs-triage"]);
  assert.equal((await gone.provider.inspectAction(record)).state, "uncertain");
});

test("a label change is read back by case-insensitive label name", async () => {
  const f = labelsFixture(["ready"], 204);
  assert.equal(
    (await f.provider.inspectAction(f.record(["Ready"], ["OLD"]))).state,
    "confirmed-success",
  );
  const still = labelsFixture(["Old"], 204);
  assert.equal(
    (await still.provider.inspectAction(still.record([], ["old"]))).state,
    "uncertain",
  );
});

test("an item add is confirmed by the Project's item on the issue and no other Project's", async () => {
  const caller = publicationCaller();
  const record: DeliveryActionRecord = {
    ...createRecord(),
    operationId: randomUUID(),
    request: {
      operationId: randomUUID(),
      action: {
        kind: "project.item.add",
        target: { repositoryId: "R1", number: 7, nodeId: "I7" },
        projectNodeId: "P1",
      },
    },
    binding: caller,
  };
  const state = {
    posts: 0,
    listed: [],
    lists: [],
    items: [{ id: "ITEM_OTHER", project: { id: "P2" } }],
    itemAdds: 0,
  };
  const provider = new GitHubHttpDeliveryProvider(
    "non-secret-marker",
    issueFetcher(state),
  );
  assert.equal((await provider.inspectAction(record)).state, "uncertain");
  state.items = [
    { id: "ITEM_OTHER", project: { id: "P2" } },
    { id: "ITEM1", project: { id: "P1" } },
  ];
  assert.deepEqual(await provider.inspectAction(record), {
    state: "confirmed-success",
    reason: null,
    receipt: { nodeId: "ITEM1" },
  });
});

test("Link reads the named issue and reports whether it carries the create's marker", async () => {
  const record = createRecord();
  const state = { posts: 0, listed: [], lists: [] as string[] };
  const provider = new GitHubHttpDeliveryProvider(
    "non-secret-marker",
    issueFetcher(state),
  );
  const inspected = await provider.inspectPublishedIssue(
    { repositoryId: "R1", number: 7 },
    record.operationId,
  );
  assert.equal(inspected.hasMarker, false);
  assert.equal(inspected.nodeId, "I7");
});

test("only the publication may create an issue or add an item at the provider", async () => {
  const provider = new GitHubHttpDeliveryProvider("x", async () => {
    throw new Error("provider should not be called");
  });
  const wrong = createRecord();
  wrong.binding = { ...publicationCaller(), repositoryId: "R2" };
  const runtime = commentRecord();
  runtime.request.action = createRecord().request.action;
  for (const record of [wrong, runtime])
    await assert.rejects(
      provider.performAction(record),
      (error) =>
        error instanceof DomainPolicyError && error.code === "forbidden",
    );
});
