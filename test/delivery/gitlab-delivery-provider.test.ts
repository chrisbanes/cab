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
import { scriptedGitLabRemote } from "../fixtures/gitlab-remote.js";
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

test("the provider delivers only branch actions", async () => {
  const w = world();
  assert.equal(w.provider.supportsAction("branch.push"), true);
  assert.equal(w.provider.supportsAction("branch.force-push"), true);
  assert.equal(w.provider.supportsAction("branch.adopt"), true);
  for (const kind of [
    "pr.create",
    "pr.merge",
    "issue.comment",
    "issue.create",
    "project.field",
  ] as const)
    assert.equal(w.provider.supportsAction(kind), false, kind);
  await assert.rejects(
    w.provider.inspectPr({} as never, policy),
    /unavailable/,
  );
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
