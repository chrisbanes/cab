import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  DeliveryActionRecord,
  DeliveryPolicy,
  ExternalAction,
} from "../../src/core/delivery.js";
import { DomainPolicyError } from "../../src/core/domain.js";
import type { AdoptOutcome } from "../../src/standalone/git-fetch.js";
import type { PushOutcome } from "../../src/standalone/git-push.js";
import {
  PublicationRefusal,
  type AdoptionContext,
  type PublicationContext,
} from "../../src/standalone/github-delivery.js";
import {
  gitLabDiscussion,
  gitLabMergeRequest,
  gitLabUser,
  scriptedGitLabRemote,
  type ScriptedMergeRequest,
} from "../fixtures/gitlab-remote.js";
import { GitLabHttpDeliveryProvider } from "../../src/standalone/gitlab-delivery.js";

const host = "gitlab.example.com";
const token = "glpat-synthetic-delivery-token";
const projectPath = "group/sub/app";
const repositoryId = "42";
const branch = "cab/abcd1234-task";
const old = "1".repeat(40);
const commit = "2".repeat(40);
const outside = "3".repeat(40);
const policy = {} as DeliveryPolicy;

function world(options: { token?: string | null } = {}) {
  const credential = {
    value: options.token === undefined ? token : options.token,
  };
  const remote = scriptedGitLabRemote({ repositoryId });
  const { state, requests } = remote;
  state.head = old;
  state.project = { id: 42, path_with_namespace: "Group/Sub/App" };
  const pushes: Array<Record<string, unknown>> = [];
  const adopts: Array<Record<string, unknown>> = [];
  const outcomes = {
    push: "pushed" as PushOutcome,
    adopt: "adopted" as AdoptOutcome,
    /** What a successful push does to the remote. */
    onPush: () => {
      state.head = commit;
    },
  };
  const provider = new GitLabHttpDeliveryProvider({
    host,
    link: (id) => (id === repositoryId ? { projectPath } : null),
    token: async () => credential.value,
    fetcher: remote.fetcher,
    push: async (request) => {
      // The real transport starts nothing without a token.
      if (!request.token) return "not-attempted";
      pushes.push({ ...request });
      if (outcomes.push === "pushed") outcomes.onPush();
      return outcomes.push;
    },
    adopt: async (request) => {
      if (!request.token) return "not-attempted";
      adopts.push({ ...request });
      return outcomes.adopt;
    },
  });
  return {
    state,
    requests,
    pushes,
    adopts,
    outcomes,
    provider,
    credential,
    fetchThrough: remote.fetcher,
  };
}

const publication = (
  extra: Partial<PublicationContext> = {},
): PublicationContext => ({
  workspacePath: "/work/tree",
  uncommittedEntries: 0,
  descendsFromLastPushed: true,
  branch,
  lastPushedSha: old,
  retry: false,
  ...extra,
});

const push = (kind: "branch.push" | "branch.force-push" = "branch.push") =>
  ({
    kind,
    target: { repositoryId },
    commitSha: commit,
  }) as ExternalAction;

function record(
  action: ExternalAction,
  beforeState: DeliveryActionRecord["beforeState"],
  extra: Partial<DeliveryActionRecord> = {},
): DeliveryActionRecord {
  const operationId = randomUUID();
  return {
    operationId,
    request: { operationId, action },
    binding: {
      projectId: randomUUID(),
      taskId: randomUUID(),
      assignmentId: randomUUID(),
      taskVersion: 1,
      assignmentVersion: 1,
      workId: "w",
      workRevision: 1,
      conversationRevision: 1,
    },
    policyVersion: 1,
    state: "attempting",
    attempts: 1,
    beforeState,
    observation: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

test("a push settles confirmed only when the branch read shows the commit", async () => {
  const w = world();
  const action = push();
  const before = await w.provider.preflight(action, policy, publication());
  assert.equal(before.beforeHead, old);
  assert.equal(before.repositoryPath, "/projects/42");
  // Git uses the path the API reports, not the link's spelling.
  assert.equal(before.projectPath, "Group/Sub/App");
  const observation = await w.provider.performAction(record(action, before));
  assert.equal(observation.state, "confirmed-success");
  assert.deepEqual(w.pushes, [
    {
      workspacePath: "/work/tree",
      commitSha: commit,
      branch,
      lease: old,
      host,
      codeHost: "gitlab",
      nameWithOwner: "Group/Sub/App",
      token,
    },
  ]);

  // Git reports success but the read still shows the old head: unproved, never "not applied".
  const lagging = world();
  lagging.outcomes.onPush = () => {};
  const unproved = await lagging.provider.performAction(
    record(
      action,
      await lagging.provider.preflight(action, policy, publication()),
    ),
  );
  assert.equal(unproved.state, "uncertain");
  assert.equal(unproved.pushed, true);
});

test("a lost push response stays uncertain and settles by the ref read without a second push", async () => {
  const w = world();
  w.outcomes.push = "uncertain";
  const action = push();
  const before = await w.provider.preflight(action, policy, publication());
  const first = await w.provider.performAction(record(action, before));
  assert.equal(first.state, "uncertain");
  assert.equal(w.pushes.length, 1);

  const attempting = record(action, before, { observation: first });
  // The ref still shows the old head: nothing proves the push either way.
  const still = await w.provider.inspectAction(attempting);
  assert.equal(still.state, "confirmed-failure");
  assert.equal(still.reason, "branch-push-not-applied");
  w.state.head = commit;
  const landed = await w.provider.inspectAction(attempting);
  assert.equal(landed.state, "confirmed-success");
  assert.equal(landed.receipt?.headSha, commit);
  assert.equal(w.pushes.length, 1);
});

test("a head cab did not push is an outside change at preflight and during the push", async () => {
  const w = world();
  w.state.head = outside;
  await assert.rejects(
    w.provider.preflight(push(), policy, publication()),
    (error) =>
      error instanceof PublicationRefusal &&
      error.reason === "branch-outside-change" &&
      error.outsideHeadSha === outside,
  );
  assert.equal(w.pushes.length, 0);

  const racing = world();
  const action = push();
  const before = await racing.provider.preflight(action, policy, publication());
  racing.state.head = outside;
  racing.outcomes.push = "rejected-lease";
  const observation = await racing.provider.performAction(
    record(action, before),
  );
  assert.equal(observation.state, "confirmed-failure");
  assert.equal(observation.reason, "branch-outside-change");
  assert.deepEqual(observation.receipt, {
    nodeId: repositoryId,
    ref: branch,
    headSha: outside,
  });
});

test("an overwrite leases on the approved outside head and a branch back at the last push is cleared", async () => {
  const w = world();
  w.state.head = outside;
  const action = push("branch.force-push");
  const before = await w.provider.preflight(
    action,
    policy,
    publication({ outsideHeadSha: outside }),
  );
  const done = await w.provider.performAction(record(action, before));
  assert.equal(done.state, "confirmed-success");
  assert.equal(w.pushes[0]?.lease, outside);

  const cleared = world();
  await assert.rejects(
    cleared.provider.preflight(
      action,
      policy,
      publication({ outsideHeadSha: outside }),
    ),
    (error) =>
      error instanceof PublicationRefusal &&
      error.reason === "branch-outside-cleared",
  );
  assert.equal(cleared.pushes.length, 0);
});

test("adoption re-reads the branch around the fetch and maps its failures", async () => {
  const adoption: AdoptionContext = {
    branch,
    lastPushedSha: old,
    workspacePath: "/work/tree",
    baseCommit: "4".repeat(40),
  };
  const action = {
    kind: "branch.adopt",
    target: { repositoryId },
    outsideHeadSha: outside,
  } as ExternalAction;
  const w = world();
  w.state.head = outside;
  const before = await w.provider.preflight(
    action,
    policy,
    undefined,
    adoption,
  );
  const adopted = await w.provider.performAction(record(action, before));
  assert.equal(adopted.state, "confirmed-success");
  assert.deepEqual(w.adopts, [
    {
      workspacePath: "/work/tree",
      baseCommit: "4".repeat(40),
      commitSha: outside,
      branch,
      host,
      codeHost: "gitlab",
      nameWithOwner: "Group/Sub/App",
      token,
    },
  ]);

  w.outcomes.adopt = "too-large";
  const large = await w.provider.performAction(record(action, before));
  assert.equal(large.reason, "branch-adopt-too-large");

  // A head that moves during the fetch is another outside change.
  const moving = world();
  moving.state.head = outside;
  moving.outcomes.adopt = "adopted";
  const moved = moving.provider.performAction(record(action, before));
  moving.state.head = "5".repeat(40);
  assert.equal((await moved).reason, "branch-outside-change");
});

test("a project that is not the linked one stops delivery before any Git transport", async () => {
  for (const project of [
    { id: 43, path_with_namespace: projectPath },
    { id: 42, path_with_namespace: "group/other" },
  ]) {
    const w = world();
    w.state.project = project;
    await assert.rejects(
      w.provider.preflight(push(), policy, publication()),
      /provider-repository-mismatch/,
    );
    const branchAction = {
      kind: "branch.adopt",
      target: { repositoryId },
      outsideHeadSha: outside,
    } as ExternalAction;
    await assert.rejects(
      w.provider.preflight(branchAction, policy, undefined, {
        branch,
        lastPushedSha: null,
        workspacePath: "/work/tree",
        baseCommit: old,
      }),
    );
    assert.deepEqual([w.pushes, w.adopts], [[], []]);
  }
  const unlinked = world();
  await assert.rejects(
    unlinked.provider.preflight(
      { ...push(), target: { repositoryId: "99" } } as ExternalAction,
      policy,
      publication(),
    ),
    /provider-repository-mismatch/,
  );
  assert.equal(unlinked.requests.length, 0);
});

test("every request stays on the host with a bearer token and refuses a redirect", async () => {
  const w = world();
  const action = push();
  const before = await w.provider.preflight(action, policy, publication());
  await w.provider.performAction(record(action, before));
  assert.ok(w.requests.length > 0);
  for (const { url, init } of w.requests) {
    assert.equal(new URL(url).origin, `https://${host}`);
    assert.equal(init.redirect, "manual");
    assert.equal(init.method, "GET");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${token}`);
    assert.equal(url.includes(token), false);
  }
  assert.ok(
    w.requests.some((r) =>
      r.url.endsWith(`/branches/${encodeURIComponent(branch)}`),
    ),
    "a branch containing / is addressed as one encoded segment",
  );

  const redirected = world();
  redirected.state.redirect = true;
  await assert.rejects(
    redirected.provider.preflight(action, policy, publication()),
    /provider-origin-mismatch/,
  );
  assert.equal(redirected.requests.length, 1);
});

test("a missing credential stops preflight without a request, and errors never carry the token", async () => {
  const w = world({ token: null });
  await assert.rejects(
    w.provider.preflight(push(), policy, publication()),
    /^Error: provider-credential-unavailable$/,
  );
  assert.equal(w.requests.length, 0);

  const failing = world();
  failing.state.project = { id: 42 };
  await assert.rejects(
    failing.provider.preflight(push(), policy, publication()),
    (error: Error) => !String(error.stack).includes(token),
  );
});

test("an absent branch reads as absent only while the project still reads", async () => {
  const action = {
    kind: "branch.adopt",
    target: { repositoryId },
    outsideHeadSha: outside,
  } as ExternalAction;
  const recorded = {
    repositoryPath: "/projects/42",
    projectPath,
    branch,
    workspacePath: "/work/tree",
    baseCommit: "4".repeat(40),
    lastPushedSha: old,
  };
  const deleted = world();
  deleted.state.head = null;
  const absent = await deleted.provider.performAction(record(action, recorded));
  assert.equal(absent.reason, "branch-outside-change");
  assert.equal(absent.receipt, null);

  const unreadable = world();
  unreadable.state.head = null;
  unreadable.state.project = { id: 42 };
  const unproved = await unreadable.provider.performAction(
    record(action, recorded),
  );
  assert.equal(unproved.reason, "branch-adopt-fetch-failed");
  assert.deepEqual(unreadable.adopts, []);
});

test("the provider delivers branch and merge request actions, but not a merge or an issue", async () => {
  const w = world();
  for (const kind of [
    "branch.push",
    "branch.force-push",
    "branch.adopt",
    "pr.create",
    "pr.edit",
    "pr.ready",
    "pr.thread.reply",
    "pr.thread.resolve",
  ] as const)
    assert.equal(w.provider.supportsAction(kind), true, kind);
  for (const kind of [
    "pr.merge",
    "issue.comment",
    "issue.create",
    "project.field",
  ] as const)
    assert.equal(w.provider.supportsAction(kind), false, kind);
  const comment = record(
    {
      kind: "issue.comment",
      target: { repositoryId, number: 1, nodeId: "I" },
      body: "B",
    } as ExternalAction,
    null,
  );
  await assert.rejects(
    w.provider.performAction(comment),
    (error) => error instanceof DomainPolicyError,
  );
  await assert.rejects(
    w.provider.preflight(
      {
        kind: "pr.merge",
        target: prTarget,
        method: "squash",
        reviewedResultIds: [],
      } as ExternalAction,
      policy,
    ),
    /provider-action-unsupported/,
  );
  assert.equal(w.requests.length, 0);
});

test("the credential is resolved on every use, and one that vanished after preflight means nothing was attempted", async () => {
  const w = world();
  const action = push();
  const before = await w.provider.preflight(action, policy, publication());
  // Rotated after preflight: the push and the readback use the new value.
  w.credential.value = `${token}-rotated`;
  const seen = w.requests.length;
  const done = await w.provider.performAction(record(action, before));
  assert.equal(done.state, "confirmed-success");
  assert.equal(w.pushes[0]?.token, `${token}-rotated`);
  assert.ok(
    w.requests
      .slice(seen)
      .every(
        (r) =>
          (r.init.headers as Record<string, string>).authorization ===
          `Bearer ${token}-rotated`,
      ),
  );

  const gone = world();
  const planned = await gone.provider.preflight(action, policy, publication());
  gone.credential.value = null;
  const failed = await gone.provider.performAction(record(action, planned));
  assert.equal(failed.state, "confirmed-failure");
  assert.equal(failed.reason, "push-not-attempted");
  assert.equal(failed.retryable, true);
  assert.equal(gone.pushes.length, 0);

  const adopting = world();
  adopting.state.head = outside;
  const adoption = {
    kind: "branch.adopt",
    target: { repositoryId },
    outsideHeadSha: outside,
  } as ExternalAction;
  const adoptState = await adopting.provider.preflight(
    adoption,
    policy,
    undefined,
    {
      branch,
      lastPushedSha: old,
      workspacePath: "/work/tree",
      baseCommit: "4".repeat(40),
    },
  );
  adopting.credential.value = null;
  // The ref read needs the credential too, so the adoption fails without fetching.
  const refused = await adopting.provider.performAction(
    record(adoption, adoptState),
  );
  assert.equal(refused.state, "confirmed-failure");
  assert.equal(adopting.adopts.length, 0);
});

test("a token that is not printable ASCII is unusable and never reaches a request or an error", async () => {
  for (const bad of ["glpat-a\r\nX-Evil: 1", "glpat-\0", "glpat-é", ""]) {
    const w = world({ token: bad });
    await assert.rejects(
      w.provider.preflight(push(), policy, publication()),
      (error: Error) =>
        error.message === "provider-credential-unavailable" &&
        !error.message.includes("glpat"),
    );
    assert.equal(w.requests.length, 0);
  }
});

test("a response that was redirected or came from another origin is refused", async () => {
  for (const tamper of [
    (r: Response) => Object.defineProperty(r, "redirected", { value: true }),
    (r: Response) =>
      Object.defineProperty(r, "url", { value: "https://evil.example/x" }),
  ]) {
    const w = world();
    const provider = new GitLabHttpDeliveryProvider({
      host,
      link: () => ({ projectPath }),
      token: async () => token,
      fetcher: (async (url: string, init: RequestInit) => {
        const response = await w.fetchThrough(url, init);
        tamper(response);
        return response;
      }) as typeof fetch,
    });
    await assert.rejects(
      provider.preflight(push(), policy, publication()),
      /provider-origin-mismatch/,
    );
  }
});

const iid = 12;
const prTarget = {
  repositoryId,
  number: iid,
  nodeId: "9001",
  baseRef: "main",
  headRef: branch,
  expectedHeadSha: commit,
};
const threadTarget = { ...prTarget, threadNodeId: "abc" };
const identity = {
  repositoryId,
  prNumber: iid,
  expectedPrNodeId: "9001",
  expectedHeadSha: commit,
};

/** A world with one merge request in the linked project and the branch at its head. */
function mergeRequestWorld(mr: Partial<ScriptedMergeRequest> = {}) {
  const w = world();
  w.state.head = commit;
  w.state.mergeRequests.push(gitLabMergeRequest(mr));
  return w;
}

const created = (
  a: Partial<Extract<ExternalAction, { kind: "pr.create" }>> = {},
) =>
  ({
    kind: "pr.create",
    target: {
      repositoryId,
      baseRef: "main",
      headRef: branch,
      expectedHeadSha: commit,
    },
    title: "Change",
    body: "Body",
    draft: false,
    ...a,
  }) as ExternalAction;

test("a merge request is observed as the same facts on every unchanged read", async () => {
  const w = mergeRequestWorld({
    head_pipeline: {
      id: 55,
      sha: commit,
      status: "failed",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:05:00Z",
    },
  });
  w.state.discussions.push(
    gitLabDiscussion("abc", [
      {
        type: "DiffNote",
        body: "x".repeat(3000),
        position: { head_sha: commit },
      },
      { author: { id: 7 }, resolved: true, resolved_by: { id: 7 } },
    ]),
    gitLabDiscussion("def", [
      { system: true, resolvable: false, body: "pushed" },
    ]),
    gitLabDiscussion("fed", [{ resolvable: false }], { individual_note: true }),
  );
  const first = await w.provider.inspectPr(identity, policy);
  assert.deepEqual(
    { ...first, feedback: undefined, reviewThreads: undefined },
    {
      repositoryId,
      nodeId: "9001",
      number: iid,
      baseRef: "main",
      headRef: branch,
      headSha: commit,
      baseSha: "b".repeat(40),
      state: "OPEN",
      draft: false,
      merged: false,
      reviewDecision: null,
      checks: [
        {
          name: "pipeline",
          appId: null,
          sha: commit,
          status: "failure",
          nodeId: "55",
          updatedAt: "2026-01-01T00:05:00Z",
        },
      ],
      feedback: undefined,
      reviewThreads: undefined,
      mergeBlockers: ["merge-unsupported"],
      closedIssueNodeIds: [],
      allowedMethods: [],
    },
  );
  // System notes are not feedback; a diff note is a review comment and the body is bounded.
  assert.deepEqual(
    first.feedback?.map((f) => [f.kind, f.state, f.commitSha, f.body.length]),
    [
      ["comment", "COMMENTED", null, 4],
      ["comment", "COMMENTED", null, 4],
      ["review-comment", "COMMENTED", commit, 2000],
    ],
  );
  // The thread's first and latest notes are its first and last, and only resolvable threads count.
  assert.deepEqual(first.reviewThreads, [
    {
      nodeId: "abc",
      isResolved: false,
      firstCommentNodeId: String(0xabc * 10),
      latestCommentNodeId: String(0xabc * 10 + 1),
    },
  ]);
  w.state.pageSize = 1;
  const again = await w.provider.inspectPr(identity, policy);
  assert.deepEqual(again, first);
  assert.ok(
    w.requests.some((r) => r.url.includes("page=3")),
    "lists are paged",
  );
  for (const { url, init } of w.requests) {
    assert.equal(new URL(url).origin, `https://${host}`);
    assert.equal(init.redirect, "manual");
    assert.equal(
      (init.headers as Record<string, string>).authorization,
      `Bearer ${token}`,
    );
  }
  assert.equal(JSON.stringify(first).includes(token), false);
});

test("a pipeline for another commit is not the head check, and statuses map to the three outcomes", async () => {
  const pipeline = (status: string, sha = commit) => ({
    id: 5,
    sha,
    status,
    started_at: null,
    finished_at: null,
  });
  const w = mergeRequestWorld({ head_pipeline: pipeline("running", old) });
  assert.deepEqual((await w.provider.inspectPr(identity, policy)).checks, []);
  for (const [status, expected] of [
    ["success", "success"],
    ["skipped", "success"],
    ["failed", "failure"],
    ["canceled", "failure"],
    ["running", "pending"],
    ["manual", "pending"],
  ] as const) {
    w.state.mergeRequests[0] = gitLabMergeRequest({
      head_pipeline: pipeline(status),
    });
    const [check] = (await w.provider.inspectPr(identity, policy)).checks;
    assert.equal(check?.status, expected, status);
    assert.equal(check?.updatedAt, "unproved");
  }
});

test("a merge request from a fork, another ID or without a base is never observed", async () => {
  for (const [mr, id] of [
    [{ source_project_id: 43 }, identity],
    [{ target_project_id: 43 }, identity],
    [{}, { ...identity, expectedPrNodeId: "1" }],
    [{ diff_refs: { base_sha: null } }, identity],
  ] as const) {
    const w = mergeRequestWorld(mr);
    await assert.rejects(w.provider.inspectPr(id, policy));
  }
  const merged = mergeRequestWorld({ state: "merged" });
  const observed = await merged.provider.inspectPr(identity, policy);
  assert.deepEqual([observed.state, observed.merged], ["MERGED", true]);
});

test("a merge request is created as a draft by title and settles only on the exact marker read", async () => {
  const w = world();
  w.state.head = commit;
  const action = created({ draft: true });
  const before = await w.provider.preflight(action, policy);
  assert.equal(before.headSha, commit);
  const done = await w.provider.performAction(record(action, before));
  assert.equal(done.state, "confirmed-success");
  const post = w.requests.find((r) => r.init.method === "POST");
  const body = JSON.parse(String(post?.init.body));
  assert.equal(body.title, "Draft: Change");
  assert.match(body.description, /^Body\n\n<!-- cab-operation:[0-9a-f-]+ -->$/);
  assert.equal("target_project_id" in body, false);
  assert.deepEqual(done.receipt, {
    nodeId: String(w.state.mergeRequests[0]?.id),
    number: w.state.mergeRequests[0]?.iid,
    headSha: commit,
  });
  assert.equal(JSON.stringify(done).includes(token), false);
});

test("a created merge request that is duplicated, by another author or on another commit stays unproved", async () => {
  for (const change of [
    (w: ReturnType<typeof world>) => {
      w.state.mergeRequests.push({
        ...w.state.mergeRequests[0]!,
        id: 1,
        iid: 99,
      });
    },
    (w: ReturnType<typeof world>) => {
      w.state.mergeRequests[0]!.author = { id: gitLabUser.id + 1 };
    },
    (w: ReturnType<typeof world>) => {
      w.state.mergeRequests[0]!.sha = old;
    },
    (w: ReturnType<typeof world>) => {
      w.state.mergeRequests[0]!.source_project_id = 43;
    },
  ]) {
    const w = world();
    w.state.head = commit;
    const action = created();
    const before = await w.provider.preflight(action, policy);
    const r = record(action, before);
    // The first answer is the write; the change then lands before the independent read.
    w.state.intercept = (method) => {
      if (method !== "GET") return undefined;
      w.state.intercept = undefined;
      change(w);
      return undefined;
    };
    await w.provider.performAction(r);
    const observed = await w.provider.inspectAction(r);
    assert.equal(observed.state, "uncertain");
    assert.equal(observed.receipt, null);
  }
});

test("a rejected create is a definitive failure and a lost one is unproved and not replayed", async () => {
  const w = world();
  w.state.head = commit;
  const action = created();
  const before = await w.provider.preflight(action, policy);
  w.state.intercept = (method) =>
    method === "POST" ? new Response("{}", { status: 409 }) : undefined;
  const rejected = await w.provider.performAction(record(action, before));
  assert.deepEqual(
    [rejected.state, rejected.reason],
    ["confirmed-failure", "provider-http-409"],
  );
  w.state.intercept = (method) => {
    if (method === "POST") throw new Error("connection lost");
    return undefined;
  };
  const posts = () => w.requests.filter((r) => r.init.method === "POST").length;
  const before409 = posts();
  const lost = await w.provider.performAction(record(action, before));
  assert.deepEqual(
    [lost.state, lost.reason],
    ["uncertain", "provider-effect-unproved"],
  );
  assert.equal(posts(), before409 + 1);
  assert.equal(w.state.mergeRequests.length, 0);
});

test("create is held when the branch moved, the base is missing or the title already says draft", async () => {
  const moved = world();
  moved.state.head = old;
  await assert.rejects(
    moved.provider.preflight(created(), policy),
    /provider-head-changed/,
  );
  const prefixed = world();
  prefixed.state.head = commit;
  await assert.rejects(
    prefixed.provider.preflight(created({ title: "draft: Change" }), policy),
    /provider-title-draft-prefix/,
  );
});

test("an edit keeps the merge request's draft status and settles on the written fields", async () => {
  for (const draft of [true, false]) {
    const w = mergeRequestWorld({
      draft,
      title: draft ? "Draft: Change" : "Change",
    });
    const action = {
      kind: "pr.edit",
      target: prTarget,
      fields: { title: "Renamed", body: "New body" },
    } as ExternalAction;
    const before = await w.provider.preflight(action, policy);
    assert.equal(before.draft, draft);
    const done = await w.provider.performAction(record(action, before));
    assert.equal(done.state, "confirmed-success");
    const put = w.requests.find((r) => r.init.method === "PUT");
    assert.deepEqual(JSON.parse(String(put?.init.body)), {
      title: draft ? "Draft: Renamed" : "Renamed",
      description: "New body",
    });
    assert.equal(w.state.mergeRequests[0]?.draft, draft);
  }
});

test("ready clears the draft with GraphQL on the verified project path and settles on the re-read", async () => {
  const w = mergeRequestWorld({ draft: true, title: "Draft: Change" });
  const action = { kind: "pr.ready", target: prTarget } as ExternalAction;
  const before = await w.provider.preflight(action, policy);
  const done = await w.provider.performAction(record(action, before));
  assert.equal(done.state, "confirmed-success");
  const graphql = w.requests.filter((r) => r.url.endsWith("/api/graphql"));
  assert.equal(graphql.length, 1);
  assert.equal(graphql[0]?.url, `https://${host}/api/graphql`);
  const sent = JSON.parse(String(graphql[0]?.init.body));
  assert.deepEqual(sent.variables, { projectPath: "Group/Sub/App", iid: "12" });
  assert.equal(
    (graphql[0]?.init.headers as Record<string, string> | undefined)
      ?.authorization,
    `Bearer ${token}`,
  );
  // A mutation that reports success but changed nothing is not success.
  const w2 = mergeRequestWorld({ draft: true, title: "Draft: Change" });
  const before2 = await w2.provider.preflight(action, policy);
  w2.state.intercept = (_m, path) =>
    path === "/api/graphql"
      ? new Response('{"errors":[{"message":"no"}]}', { status: 200 })
      : undefined;
  const none = await w2.provider.performAction(record(action, before2));
  assert.equal(none.state, "uncertain");
});

test("edit and ready refuse a merge request that changed or is not the target's", async () => {
  for (const mr of [
    { sha: old },
    { source_branch: "other" },
    { target_branch: "other" },
    { id: 5 },
    { source_project_id: 43 },
  ]) {
    const w = mergeRequestWorld(mr);
    await assert.rejects(
      w.provider.preflight(
        { kind: "pr.ready", target: prTarget } as ExternalAction,
        policy,
      ),
    );
  }
});

test("a thread reply settles on exactly one marker note by the credential user", async () => {
  const w = mergeRequestWorld();
  w.state.discussions.push(gitLabDiscussion("abc", [{}]));
  const action = {
    kind: "pr.thread.reply",
    target: threadTarget,
    body: "Fixed",
  } as ExternalAction;
  const before = await w.provider.preflight(action, policy);
  const r = record(action, before);
  const done = await w.provider.performAction(r);
  assert.equal(done.state, "confirmed-success");
  const post = w.requests.find((x) => x.init.method === "POST");
  assert.match(post?.url ?? "", /merge_requests\/12\/discussions\/abc\/notes$/);
  // The same marker twice proves nothing.
  const discussion = w.state.discussions[0]!;
  discussion.notes.push({ ...discussion.notes[1]! });
  const twice = await w.provider.inspectAction(r);
  assert.equal(twice.state, "uncertain");
  // A thread on another merge request's discussion list does not exist here.
  await assert.rejects(
    w.provider.preflight(
      {
        ...action,
        target: { ...threadTarget, threadNodeId: "zzz" },
      } as ExternalAction,
      policy,
    ),
  );
});

test("a resolve is refused without a write when the thread is resolved or has a newer note", async () => {
  const resolve = (latest: string) =>
    ({
      kind: "pr.thread.resolve",
      target: threadTarget,
      expectedLatestCommentNodeId: latest,
    }) as ExternalAction;
  const latest = String(0xabc * 10 + 1);
  const open = () => {
    const w = mergeRequestWorld();
    w.state.discussions.push(gitLabDiscussion("abc", [{}, {}]));
    return w;
  };
  const stale = open();
  await assert.rejects(
    stale.provider.preflight(resolve(String(0xabc * 10)), policy),
    /provider-thread-resolve-held/,
  );
  const done = open();
  const action = resolve(latest);
  const before = await done.provider.preflight(action, policy);
  const settled = await done.provider.performAction(record(action, before));
  assert.equal(settled.state, "confirmed-success");
  assert.deepEqual(settled.receipt, { nodeId: "abc" });
  const put = done.requests.find((r) => r.init.method === "PUT");
  assert.match(put?.url ?? "", /discussions\/abc\?resolved=true$/);
  const puts = () =>
    done.requests.filter((r) => r.init.method === "PUT").length;
  const written = puts();
  await assert.rejects(
    done.provider.preflight(action, policy),
    /provider-thread-resolve-held/,
  );
  assert.equal(puts(), written);
});

test("a redirect on a merge request route is refused and nothing carries the token", async () => {
  const w = mergeRequestWorld();
  w.state.discussions.push(gitLabDiscussion("abc", [{}]));
  w.state.intercept = (_m, path) =>
    path.endsWith("/discussions")
      ? new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/" },
        })
      : undefined;
  await assert.rejects(
    w.provider.inspectPr(identity, policy),
    /provider-origin-mismatch/,
  );
  for (const { url } of w.requests)
    assert.equal(new URL(url).origin, `https://${host}`);
  const w2 = mergeRequestWorld();
  w2.credential.value = null;
  await assert.rejects(
    w2.provider.inspectPr(identity, policy),
    /provider-credential-unavailable/,
  );
  assert.equal(w2.requests.length, 0);
});

test("text GitLab would run as a quick action is held before any write", async () => {
  const w = mergeRequestWorld();
  w.state.head = commit;
  w.state.discussions.push(gitLabDiscussion("abc", [{}]));
  for (const text of [
    "/merge",
    "Done\n/ready",
    "ok\n  /approve now",
    "\u00a0/merge",
  ]) {
    for (const action of [
      created({ body: text }),
      {
        kind: "pr.edit",
        target: prTarget,
        fields: { body: text },
      } as ExternalAction,
      {
        kind: "pr.thread.reply",
        target: threadTarget,
        body: text,
      } as ExternalAction,
    ])
      await assert.rejects(
        w.provider.preflight(action, policy),
        /provider-quick-action-held/,
        `${action.kind} ${JSON.stringify(text)}`,
      );
  }
  assert.equal(w.requests.filter((r) => r.init.method !== "GET").length, 0);
  // A slash inside a line is ordinary text.
  const fine = await w.provider.preflight(
    {
      kind: "pr.thread.reply",
      target: threadTarget,
      body: "see src/a.ts and https://x/y",
    } as ExternalAction,
    policy,
  );
  assert.equal(fine.threadNodeId, "abc");
});

test("a redirect on a write or the GraphQL route is refused and never followed", async () => {
  for (const [kind, path] of [
    ["pr.edit", "/merge_requests/12"],
    ["pr.ready", "/api/graphql"],
    ["pr.thread.reply", "/notes"],
  ] as const) {
    const w = mergeRequestWorld({ draft: true, title: "Draft: Change" });
    w.state.discussions.push(gitLabDiscussion("abc", [{}]));
    const action = (
      kind === "pr.edit"
        ? { kind, target: prTarget, fields: { title: "T" } }
        : kind === "pr.ready"
          ? { kind, target: prTarget }
          : { kind, target: threadTarget, body: "B" }
    ) as ExternalAction;
    const before = await w.provider.preflight(action, policy);
    w.state.intercept = (method, requestPath) =>
      method !== "GET" && requestPath.endsWith(path)
        ? new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/" },
          })
        : undefined;
    const done = await w.provider.performAction(record(action, before));
    assert.equal(done.state, "uncertain", kind);
    assert.ok(
      w.requests.some(
        (r) =>
          r.init.method !== "GET" && r.url.includes(path.replace(/^\//, "")),
      ),
      `${kind} was attempted`,
    );
    for (const { url } of w.requests)
      assert.equal(new URL(url).origin, `https://${host}`);
  }
});

test("a resolve settles on the latest resolution even when the last note was resolved by someone else earlier", async () => {
  const w = mergeRequestWorld();
  w.state.discussions.push(
    gitLabDiscussion("abc", [
      {},
      {
        resolved: true,
        resolved_by: { id: gitLabUser.id + 1 },
        resolved_at: "2026-01-01T00:00:00.000Z",
      },
    ]),
  );
  const action = {
    kind: "pr.thread.resolve",
    target: threadTarget,
    expectedLatestCommentNodeId: String(0xabc * 10 + 1),
  } as ExternalAction;
  const before = await w.provider.preflight(action, policy);
  const done = await w.provider.performAction(record(action, before));
  assert.equal(done.state, "confirmed-success");
  assert.deepEqual(done.receipt, { nodeId: "abc" });
});
