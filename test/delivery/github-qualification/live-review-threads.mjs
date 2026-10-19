// Bounded live qualification of the review-thread reply and resolve delivery actions.
// Run manually after `npm run build`: node test/delivery/github-qualification/live-review-threads.mjs --live
// Writes only to the maintainer-owned fixture repository, on one scratch branch and PR, and
// performs exactly two provider mutations (one reply, one resolve). Not a discovered test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ghToken } from "../../../dist/src/standalone/gh-credential.js";
import {
  deliveryDocuments,
  GitHubHttpDeliveryProvider,
} from "../../../dist/src/standalone/github-delivery.js";

const args = process.argv.slice(2);
const resultPath = args.includes("--result")
  ? args[args.indexOf("--result") + 1]
  : undefined;
if (!args.includes("--live"))
  throw new Error("Refusing execution: require --live");

const REPO = "chrisbanes/ensemble-s07a-fixture";
const REPO_NODE = "R_kgDOU35McQ";
const BASE = "qualification";
const root = `/repos/${REPO}`;
const runId = randomBytes(4).toString("hex");
const branch = `qual/review-threads-${runId}`;
const file = `qual-review-threads-${runId}.md`;
const marker = (id) => `<!-- ensemble-operation:${id} -->`;

const credential = await ghToken();
if (!("token" in credential))
  throw new Error(`Credential unavailable: ${credential.state}`);
const token = credential.token;
const redact = (text) => String(text).split(token).join("[redacted]");

// The ids the guard lets GraphQL variables name; extended as scratch resources are created.
const allowedIds = new Set([REPO_NODE]);
const documents = new Set(Object.values(deliveryDocuments));
const allowedWrites = []; // [method, exact path] pairs unlocked as resources appear
let providerMutations = 0;

/** Permits only api.github.com, the fixture repository, the scratch PR/thread and delivery documents. */
const guardedFetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method ?? "GET").toUpperCase();
  if (url.origin !== "https://api.github.com" || url.hash)
    throw new Error("guard: unexpected origin");
  if (url.pathname === "/graphql") {
    assert.equal(method, "POST", "guard: GraphQL method");
    const { query, variables = {} } = JSON.parse(String(init.body));
    assert.ok(documents.has(query), "guard: unexpected GraphQL document");
    for (const [key, value] of Object.entries(variables))
      if (key !== "after" && key !== "body" && typeof value === "string")
        assert.ok(allowedIds.has(value), `guard: unexpected id ${key}`);
    if (query.startsWith("mutation")) providerMutations++;
  } else if (method === "GET") {
    assert.ok(
      url.pathname === "/user" ||
        url.pathname === root ||
        url.pathname.startsWith(`${root}/`),
      "guard: unexpected GET path",
    );
  } else {
    assert.ok(
      allowedWrites.some(([m, p]) => m === method && p === url.pathname),
      `guard: unexpected write ${method} ${url.pathname}`,
    );
  }
  return fetch(input, init);
};

const api = async (method, path, body) => {
  const response = await guardedFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
};

// Independent readback through the gh CLI's own authentication, not this process's token.
const independentThread = (threadId) => {
  assert.ok(allowedIds.has(threadId));
  const query =
    "query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved resolvedBy{login} pullRequest{id} comments(first:100){nodes{id body state}}}}}";
  const out = execFileSync(
    "gh",
    ["api", "graphql", "-f", `query=${query}`, "-F", `id=${threadId}`],
    { encoding: "utf8", env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
  );
  return JSON.parse(out).data.node;
};

const provider = new GitHubHttpDeliveryProvider(token, guardedFetch);
const policy = {
  version: 1,
  mode: "reviewable-pr",
  credentialRef: null,
  grants: [],
  requiredChecks: [],
};
const summary = {
  version: 1,
  source: {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
  },
  repository: REPO,
  runId,
  steps: {},
  mutations: 0,
  passed: false,
  cleanup: "not-needed",
};
let pr;
const created = { branch: false };

const record = (action) => {
  const operationId = randomUUID();
  return {
    operationId,
    request: { operationId, action },
    binding: {
      projectId: randomUUID(),
      taskId: randomUUID(),
      taskVersion: 1,
      assignmentId: randomUUID(),
      assignmentVersion: 1,
      workId: "live-review-threads",
      workRevision: 1,
      conversationRevision: 1,
    },
    policyVersion: 1,
    state: "attempting",
    attempts: 1,
    beforeState: null,
    observation: null,
    createdAt: 1,
    updatedAt: 1,
  };
};
/** Mirrors the coordinator's order: preflight, then perform with its before-state. */
const attempt = async (action) => {
  const r = record(action);
  r.beforeState = await provider.preflight(action, policy);
  return { r, observation: await provider.performAction(r) };
};

try {
  const repo = await api("GET", root);
  assert.equal(repo.node_id, REPO_NODE);
  assert.equal(repo.default_branch, BASE);
  const user = await api("GET", "/user");
  const base = await api("GET", `${root}/git/ref/heads/${BASE}`);

  // Setup: one scratch branch with one file, one PR, one review comment (one thread).
  allowedWrites.push(["POST", `${root}/git/refs`]);
  await api("POST", `${root}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: base.object.sha,
  });
  created.branch = true;
  // Cleanup must be able to remove the branch even if a later setup step fails.
  allowedWrites.push(["DELETE", `${root}/git/refs/heads/${branch}`]);
  allowedWrites.push(["PUT", `${root}/contents/${file}`]);
  await api("PUT", `${root}/contents/${file}`, {
    message: "Review thread qualification scratch file",
    content: Buffer.from(`scratch ${runId}\n`).toString("base64"),
    branch,
  });
  allowedWrites.push(["POST", `${root}/pulls`]);
  pr = await api("POST", `${root}/pulls`, {
    title: `Review thread qualification ${runId}`,
    head: branch,
    base: BASE,
    body: "Scratch PR for bounded review-thread delivery qualification; closed after the run.",
    draft: true,
  });
  allowedIds.add(pr.node_id);
  allowedWrites.push(
    ["POST", `${root}/pulls/${pr.number}/comments`],
    ["PATCH", `${root}/pulls/${pr.number}`],
  );
  const setup = await api("POST", `${root}/pulls/${pr.number}/comments`, {
    body: "Qualification review comment",
    commit_id: pr.head.sha,
    path: file,
    line: 1,
    side: "RIGHT",
  });
  summary.pr = pr.number;
  summary.setupCommentNodeId = setup.node_id;

  // 1. Observation lists the thread unresolved, latest = the setup comment.
  const observed = await provider.inspectPr(
    {
      repositoryId: REPO_NODE,
      prNumber: pr.number,
      expectedPrNodeId: pr.node_id,
      expectedHeadSha: pr.head.sha,
    },
    policy,
  );
  assert.equal(observed.reviewThreads?.length, 1);
  const thread = observed.reviewThreads[0];
  allowedIds.add(thread.nodeId);
  summary.threadNodeId = thread.nodeId;
  assert.deepEqual(
    [thread.isResolved, thread.firstCommentNodeId, thread.latestCommentNodeId],
    [false, setup.node_id, setup.node_id],
  );
  summary.steps.observe = "thread-listed-unresolved";

  const target = {
    repositoryId: REPO_NODE,
    nodeId: pr.node_id,
    number: pr.number,
    threadNodeId: thread.nodeId,
  };

  // 2. Reply: preflight, perform, confirmed-success, exactly one marker comment.
  const reply = await attempt({
    kind: "pr.thread.reply",
    target,
    body: "Qualification reply",
  });
  assert.equal(reply.observation.state, "confirmed-success");
  const replyNodeId = reply.observation.receipt?.nodeId;
  assert.ok(replyNodeId);
  const afterReply = independentThread(thread.nodeId);
  const markers = afterReply.comments.nodes.filter((c) =>
    c.body.includes(marker(reply.r.operationId)),
  );
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, replyNodeId);
  assert.equal(markers[0].state, "SUBMITTED");
  summary.replyNodeId = replyNodeId;
  summary.steps.reply = reply.observation.state;

  // 3. A resolve naming the pre-reply comment is stale and is refused before any write.
  const before = providerMutations;
  await assert.rejects(
    provider.preflight(
      {
        kind: "pr.thread.resolve",
        target,
        expectedLatestCommentNodeId: setup.node_id,
      },
      policy,
    ),
    /provider-thread-resolve-held/,
  );
  assert.equal(providerMutations, before);
  summary.steps.staleResolve = "refused-in-preflight";

  // 4. A resolve naming the reply is confirmed, resolved by the credential user.
  const resolve = await attempt({
    kind: "pr.thread.resolve",
    target,
    expectedLatestCommentNodeId: replyNodeId,
  });
  assert.equal(resolve.observation.state, "confirmed-success");
  const resolved = independentThread(thread.nodeId);
  assert.equal(resolved.isResolved, true);
  assert.equal(resolved.resolvedBy.login, user.login);
  summary.steps.resolve = resolve.observation.state;

  // 5. A second resolve is refused as already resolved, without any write.
  const beforeRepeat = providerMutations;
  await assert.rejects(
    provider.preflight(
      {
        kind: "pr.thread.resolve",
        target,
        expectedLatestCommentNodeId: replyNodeId,
      },
      policy,
    ),
    /provider-thread-resolve-held/,
  );
  assert.equal(providerMutations, beforeRepeat);
  summary.steps.repeatResolve = "refused-in-preflight";

  // 6. Exactly two provider mutations.
  assert.equal(providerMutations, 2);
  summary.passed = true;
} catch (error) {
  summary.error = redact(error instanceof Error ? error.message : error);
  summary.failedAfter = Object.keys(summary.steps).at(-1) ?? "setup";
} finally {
  summary.mutations = providerMutations;
  // Cleanup is limited to the scratch PR and branch this run created.
  const cleanup = [];
  try {
    if (pr) {
      await api("PATCH", `${root}/pulls/${pr.number}`, { state: "closed" });
      cleanup.push("closed");
    }
    if (created.branch) {
      await api("DELETE", `${root}/git/refs/heads/${branch}`);
      cleanup.push("deleted");
    }
    summary.cleanup = cleanup.join("+") || "not-needed";
  } catch (error) {
    summary.cleanup = `${cleanup.join("+") || "none"}; failed: ${redact(error instanceof Error ? error.message : error)}`;
  }
}
const output = JSON.stringify(summary, null, 2);
if (resultPath) writeFileSync(resultPath, output, { mode: 0o600 });
console.log(output);
process.exitCode =
  summary.passed && summary.cleanup === "closed+deleted" ? 0 : 1;
