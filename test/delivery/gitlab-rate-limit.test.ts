import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryPolicy } from "../../src/core/delivery.js";
import { GitLabDiscoveryReader } from "../../src/standalone/gitlab-discovery.js";
import { GitLabHttpDeliveryProvider } from "../../src/standalone/gitlab-delivery.js";
import {
  fetchRateLimited,
  rateLimitDelayMs,
  readJson,
  type RateLimitPolicy,
} from "../../src/standalone/gitlab-http.js";
import {
  gitLabMergeRequest,
  scriptedGitLabRemote,
} from "../fixtures/gitlab-remote.js";

const limited = (headers: Record<string, string> = {}) =>
  new Response("Retry later\n", { status: 429, headers });
const ok = () => Response.json({ ok: true });

/** A fetcher that answers from a script and records each call; waits are recorded, not taken. */
function script(...answers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const waits: number[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    assert.ok(answer);
    return answer();
  }) as typeof fetch;
  const policy: RateLimitPolicy = {
    now: () => 1_000_000_000_000,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
  return { fetcher, calls, waits, policy };
}
const send = (
  s: ReturnType<typeof script>,
  policy: RateLimitPolicy = s.policy,
  init: RequestInit = { method: "GET" },
) =>
  fetchRateLimited(
    s.fetcher,
    "https://gitlab.com/api/v4/user",
    () => init,
    policy,
  );

test("a 429 names its wait in Retry-After seconds, an HTTP date, or RateLimit-Reset against the clock", () => {
  const now = 1_000_000_000_000;
  const delay = (headers: Record<string, string>) =>
    rateLimitDelayMs(new Headers(headers), now);
  assert.equal(delay({ "retry-after": "30" }), 30_000);
  assert.equal(
    delay({ "retry-after": new Date(now + 5_000).toUTCString() }),
    5_000,
  );
  // GitLab sends the reset as Unix seconds; Retry-After wins when both are present.
  assert.equal(delay({ "ratelimit-reset": String(now / 1000 + 12) }), 12_000);
  assert.equal(
    delay({ "retry-after": "3", "ratelimit-reset": String(now / 1000 + 12) }),
    3_000,
  );
  assert.equal(delay({ "ratelimit-reset": String(now / 1000 - 5) }), 0);
  assert.equal(delay({}), null);
  assert.equal(delay({ "retry-after": "soon", "ratelimit-reset": "x" }), null);
  // A decimal or negative value is no wait time (Date.parse alone would read "1.5" as a date).
  assert.equal(delay({ "retry-after": "1.5" }), null);
  assert.equal(delay({ "retry-after": "-5" }), null);
  // The right shape but no real date falls through, never to NaN.
  assert.equal(delay({ "retry-after": "Xyz, 99 Abc 2026 99:99:99 GMT" }), null);
});

test("a 429 is sent again after the wait it asks for, with the same method and body", async () => {
  const s = script(
    () => limited({ "retry-after": "2" }),
    () => limited({ "ratelimit-reset": String(1_000_000_000 + 7) }),
    ok,
  );
  const init = { method: "POST", body: JSON.stringify({ a: 1 }) };
  const response = await send(s, s.policy, init);
  assert.equal(response.status, 200);
  assert.deepEqual(s.waits, [2_000, 7_000]);
  assert.equal(s.calls.length, 3);
  for (const call of s.calls) assert.deepEqual(call.init, init);
});

test("only a 429 is sent again, never another failure", async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 500, 502]) {
    const s = script(() => new Response("no", { status }));
    assert.equal((await send(s)).status, status);
    assert.equal(s.calls.length, 1);
    assert.deepEqual(s.waits, []);
  }
});

test("the retries and the total wait are bounded, and the last 429 is returned", async () => {
  const forever = () => limited({ "retry-after": "1" });
  const retries = script(forever);
  assert.equal((await send(retries)).status, 429);
  assert.equal(retries.calls.length, 4, "three retries after the first send");
  assert.deepEqual(retries.waits, [1_000, 1_000, 1_000]);

  const custom = script(forever);
  await send(custom, { ...custom.policy, maxRetries: 1 });
  assert.equal(custom.calls.length, 2);

  // A wait longer than the budget is not started at all.
  const long = script(() => limited({ "retry-after": "61" }));
  assert.equal((await send(long)).status, 429);
  assert.equal(long.calls.length, 1);
  assert.deepEqual(long.waits, []);

  // Waits add up: 40 s then another 40 s passes the 60 s budget.
  const sum = script(() => limited({ "retry-after": "40" }), ok);
  const first = await send(sum);
  assert.equal(first.status, 200);
  const twice = script(() => limited({ "retry-after": "40" }));
  assert.equal((await send(twice)).status, 429);
  assert.deepEqual(twice.waits, [40_000]);
});

test("a 429 with no reset time, as the Projects API sends, waits a doubling fallback", async () => {
  const s = script(
    () => limited(),
    () => limited(),
    ok,
  );
  assert.equal((await send(s)).status, 200);
  assert.deepEqual(s.waits, [20_000, 40_000]);
  const capped = script(() => limited());
  assert.equal((await send(capped)).status, 429);
  // 20 s + 40 s fill the 60 s budget; the next 80 s would pass it.
  assert.deepEqual(capped.waits, [20_000, 40_000]);
});

test("a wait ends when it is cancelled, and nothing is sent after", async () => {
  const controller = new AbortController();
  const s = script(() => limited({ "retry-after": "30" }), ok);
  const policy: RateLimitPolicy = {
    signal: controller.signal,
    now: s.policy.now,
    // The real timer, so the abort must interrupt a wait that would otherwise last 30 s.
  };
  const pending = send(s, policy);
  await new Promise((r) => setImmediate(r));
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
  assert.equal(s.calls.length, 1);
  await assert.rejects(send(s, policy), /stopped/);
  assert.equal(s.calls.length, 1, "an aborted signal sends nothing");
});

test("a body that is not JSON is a plain failure that quotes nothing", async () => {
  await assert.rejects(
    readJson(new Response("Rate limit exceeded: retry in 30s")),
    (error) =>
      error instanceof Error &&
      error.message === "provider-response-unreadable",
  );
  assert.deepEqual(await readJson(Response.json({ a: 1 })), { a: 1 });
});

const identity = {
  repositoryId: "42",
  prNumber: 12,
  expectedPrNodeId: "9001",
  expectedHeadSha: "2".repeat(40),
};
const policy = { requiredChecks: [] } as unknown as DeliveryPolicy;
function provider(rateLimit: RateLimitPolicy) {
  const remote = scriptedGitLabRemote({ repositoryId: "42" });
  remote.state.project = { id: 42, path_with_namespace: "group/sub/app" };
  remote.state.head = "2".repeat(40);
  remote.state.mergeRequests.push(gitLabMergeRequest());
  return {
    remote,
    provider: new GitLabHttpDeliveryProvider({
      host: "gitlab.example.com",
      link: (id) => (id === "42" ? { projectPath: "group/sub/app" } : null),
      token: async () => "glpat-synthetic-rate-limit-token",
      fetcher: remote.fetcher,
      rateLimit,
    }),
  };
}

test("delivery reads wait out a 429 and then succeed, and give up past the bounds", async () => {
  const waits: number[] = [];
  const w = provider({ sleep: async (ms) => void waits.push(ms) });
  let limitedOnce = 1;
  w.remote.state.intercept = (_method, path) =>
    path.endsWith("/merge_requests/12") && limitedOnce-- > 0
      ? limited({ "retry-after": "4" })
      : undefined;
  const observed = await w.provider.inspectPr(identity, policy);
  assert.equal(observed.number, 12);
  assert.deepEqual(waits, [4_000]);

  const stuck = provider({ sleep: async (ms) => void waits.push(ms) });
  stuck.remote.state.intercept = (_method, path) =>
    path.endsWith("/merge_requests/12")
      ? limited({ "retry-after": "1" })
      : undefined;
  await assert.rejects(
    stuck.provider.inspectPr(identity, policy),
    /provider-http-429/,
  );
});

test("a write answered 429 is sent again once, and the merge request exists once", async () => {
  const w = provider({ sleep: async () => {} });
  w.remote.state.mergeRequests.length = 0;
  let limitedOnce = 1;
  w.remote.state.intercept = (method, path) =>
    method === "POST" && path.endsWith("/merge_requests") && limitedOnce-- > 0
      ? limited({ "retry-after": "1" })
      : undefined;
  const action = {
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
  const before = await w.provider.preflight(action, policy);
  const done = await w.provider.performAction({
    operationId: "11111111-1111-4111-8111-111111111111",
    request: { operationId: "11111111-1111-4111-8111-111111111111", action },
    binding: {
      projectId: "p",
      taskId: "t",
      assignmentId: "a",
      taskVersion: 1,
      assignmentVersion: 1,
      workId: "w",
      workRevision: 1,
      conversationRevision: 1,
    },
    policyVersion: 1,
    state: "attempting",
    attempts: 1,
    beforeState: before,
    observation: null,
    createdAt: 1,
    updatedAt: 1,
  } as never);
  assert.equal(done.state, "confirmed-success");
  assert.equal(w.remote.state.mergeRequests.length, 1);
});

test("discovery reads wait out a 429 too, and report the rate limit once the bounds are spent", async () => {
  const waits: number[] = [];
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return calls === 1
      ? limited({ "retry-after": "2" })
      : Response.json({ username: "cab" });
  }) as typeof fetch;
  const reader = new GitLabDiscoveryReader("gitlab.com", "glpat-x", fetcher, {
    sleep: async (ms) => void waits.push(ms),
  });
  assert.deepEqual(await reader.user(), { username: "cab" });
  assert.deepEqual(waits, [2_000]);

  const never = new GitLabDiscoveryReader(
    "gitlab.com",
    "glpat-x",
    (async () => limited({ "retry-after": "1" })) as typeof fetch,
    { sleep: async () => {}, maxRetries: 1 },
  );
  await assert.rejects(never.user(), { reason: "rate-limited" });
});
