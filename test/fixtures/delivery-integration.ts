import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  mkdtempSync as makeTemp,
  writeFileSync as writeFile,
  realpathSync,
} from "node:fs";
import { tmpdir as osTmp } from "node:os";
import { canonicalMaterial } from "../../src/core/delivery.js";
import type { StandaloneServiceOptions } from "../../src/standalone/service.js";
import { git as runGit } from "./publication.js";
import { GitHubHttpDeliveryProvider } from "../../src/standalone/github-delivery.js";
import type { RoutingChoiceClient } from "../../src/standalone/routing.js";
import type { RuntimeConversationEvent } from "../../src/standalone/codex.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import type { FixtureLifecycleOptions } from "./fixture-lifecycle.js";
import {
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./operator-web.js";
import { until } from "./until.js";
export { until };

class ReleaseRuntime extends OperatorFixtureRuntime {
  private readonly generation = randomUUID();
  private conversationEvent:
    | ((event: RuntimeConversationEvent) => void)
    | undefined;
  onConversationEvent(listener: (event: RuntimeConversationEvent) => void) {
    this.conversationEvent = listener;
  }
  emitHistory(index: number, text: string) {
    this.conversationEvent?.({
      threadId: this.threadFor(index),
      turnId: this.turnId(index),
      itemId: randomUUID(),
      kind: "completed",
      text,
    });
  }
  private readonly terminals = new Map<
    string,
    (value: "completed" | "failed") => void
  >();
  private readonly threads = new Map<number, string>();
  threadFor(index: number) {
    const thread = this.threads.get(index);
    assert.ok(thread);
    return thread;
  }
  turnId(index: number) {
    return `release-turn-${this.generation}-${index}`;
  }
  override async startThread() {
    return `release-thread-${randomUUID()}`;
  }
  override async resumeThread() {}
  override async startTurn(
    thread?: string,
    _workspace?: string,
    prompt?: string,
  ) {
    assert.ok(thread);
    if (prompt) this.prompts.push(prompt);
    this.threads.set(++this.turns, thread);
    return this.turnId(this.turns);
  }
  override waitForTurn(
    _thread: string,
    turn: string,
  ): Promise<"completed" | "failed"> {
    return new Promise((resolve) => this.terminals.set(turn, resolve));
  }
  override complete(index: number) {
    this.terminals.get(this.turnId(index))?.("completed");
  }
  override async stop() {
    for (const resolve of this.terminals.values()) resolve("completed");
  }
}

/** Closed dispatcher: these synthetic responses can never reach external fetch. */
export function scriptedDeliveryProvider() {
  const state = {
    head: "1".repeat(40),
    base: "2".repeat(40),
    merged: false,
    /** The bound PR reads as a draft, or as closed without merging. */
    draft: false,
    closed: false,
    check: "success",
    feedback: false,
    outage: false,
    lostResponse: false,
    unknownEffect: false,
    writes: 0,
    sourceBody: "Deliver O",
    sourceReads: 0,
    sourceWait: undefined as Promise<void> | undefined,
    commentWrites: 0,
    unknownComment: false,
    /** The comment is created but its response is lost. */
    lostComment: false,
    comments: [] as Array<{
      node_id: string;
      user: { node_id: string };
      body: string;
    }>,
    requests: [] as string[],
    /** One review thread on the bound PR; null leaves the PR without threads. */
    thread: null as null | {
      resolved: boolean;
      resolvedBy: string | null;
      comments: Array<{
        id: string;
        body: string;
        state: string;
        author: string;
      }>;
    },
    threadReplies: 0,
    threadResolves: 0,
    /** Remote branch heads by name, and the pull request opened from one. */
    refs: { main: "2".repeat(40) } as Record<string, string>,
    pushes: [] as Array<{
      branch: string;
      commitSha: string;
      lease: string | null;
    }>,
    /** Outside heads fetched for adoption. */
    adopts: [] as Array<{ branch: string; commitSha: string }>,
    created: null as null | {
      title: string;
      body: string;
      head: string;
      base: string;
      draft: boolean;
    },
    /** The mutation takes effect but its response is lost. */
    lostThreadReply: false,
    lostThreadResolve: false,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    state.requests.push(route);
    assert.equal(url.origin, "https://api.github.com");
    if (state.outage) throw Error("scripted provider unavailable");
    if (route === "PUT /repos/org/repo/pulls/7/merge") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        sha: state.head,
        merge_method: "squash",
      });
      state.writes++;
      if (!state.unknownEffect) state.merged = true;
      if (state.lostResponse || state.unknownEffect)
        throw Error("scripted lost merge response");
      return Response.json({ merged: true });
    }
    if (route === "POST /repos/org/repo/issues/1/comments") {
      state.commentWrites++;
      if (state.unknownComment) throw Error("scripted unknown comment effect");
      state.comments.push({
        node_id: `COMMENT${state.commentWrites}`,
        user: { node_id: "U1" },
        body: JSON.parse(String(init?.body)).body,
      });
      if (state.lostComment) throw Error("scripted lost comment response");
      return Response.json({ id: state.commentWrites });
    }
    if (route === "POST /repos/org/repo/pulls") {
      state.created = JSON.parse(String(init?.body));
      return Response.json({ number: 7 });
    }
    if (url.pathname.startsWith("/repos/org/repo/git/ref/heads/")) {
      const branch = decodeURIComponent(
        url.pathname.slice("/repos/org/repo/git/ref/heads/".length),
      );
      const head = state.refs[branch];
      return head
        ? Response.json({ ref: `refs/heads/${branch}`, object: { sha: head } })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (route === "GET /repos/org/repo/pulls" && state.created) {
      const made = state.created;
      return Response.json([
        {
          node_id: "P7",
          number: 7,
          title: made.title,
          body: made.body,
          draft: made.draft,
          user: { node_id: "U1" },
          head: {
            sha: state.refs[made.head],
            ref: made.head,
            repo: { node_id: "R1" },
          },
          base: { ref: made.base, repo: { node_id: "R1" } },
        },
      ]);
    }
    if (route === "POST /graphql") {
      const query = JSON.parse(String(init?.body)).query as string;
      if (query.includes("CabDeliveryRepository"))
        return Response.json({
          data: { node: { id: "R1", nameWithOwner: "org/repo" } },
        });
      const thread = state.thread;
      if (thread && query.includes("CabDeliveryThreadReply")) {
        state.threadReplies++;
        thread.comments.push({
          id: `C${thread.comments.length + 1}`,
          body: JSON.parse(String(init?.body)).variables.body,
          state: "SUBMITTED",
          author: "U1",
        });
        if (state.lostThreadReply) throw Error("scripted lost reply response");
        return Response.json({ data: {} });
      }
      if (thread && query.includes("CabDeliveryThreadResolve")) {
        state.threadResolves++;
        thread.resolved = true;
        thread.resolvedBy = "U1";
        if (state.lostThreadResolve)
          throw Error("scripted lost resolve response");
        return Response.json({ data: {} });
      }
      if (thread && query.includes("CabDeliveryThread"))
        return Response.json({
          data: {
            node: {
              id: "T1",
              isResolved: thread.resolved,
              resolvedBy: thread.resolvedBy ? { id: thread.resolvedBy } : null,
              pullRequest: { id: "P7", number: 7, repository: { id: "R1" } },
              latestComment: { nodes: [{ id: thread.comments.at(-1)?.id }] },
              comments: {
                nodes: thread.comments.map((c) => ({
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
      if (query.includes("CabDeliveryClosure"))
        return Response.json({
          data: {
            node: {
              id: "I1",
              repository: { id: "R1" },
              timelineItems: {
                nodes: [
                  {
                    id: "CE1",
                    closer: { __typename: "PullRequest", id: "P7" },
                  },
                ],
              },
            },
          },
        });
      if (query.includes("CabDeliveryPr"))
        return Response.json({
          data: {
            node: {
              id: "P7",
              number: 7,
              repository: { id: "R1", nameWithOwner: "org/repo" },
              baseRefName: "main",
              headRefName: "cb/change",
              headRefOid: state.head,
              baseRefOid: state.base,
              state: state.merged ? "MERGED" : state.closed ? "CLOSED" : "OPEN",
              isDraft: state.draft,
              merged: state.merged,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              isMergeQueueEnabled: false,
              closingIssuesReferences: {
                nodes: [
                  {
                    id: "I1",
                    state: state.merged ? "CLOSED" : "OPEN",
                    repository: { id: "R1" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              baseRef: {
                target: { oid: state.base },
                branchProtectionRule: null,
              },
              reviewThreads: {
                nodes: state.thread
                  ? [
                      {
                        id: "T1",
                        isResolved: state.thread.resolved,
                        firstComment: {
                          nodes: [{ id: state.thread.comments[0]?.id }],
                        },
                        latestComment: {
                          nodes: [{ id: state.thread.comments.at(-1)?.id }],
                        },
                      },
                    ]
                  : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      throw Error(`Unhandled scripted GraphQL document: ${query}`);
    }
    if (method !== "GET") throw Error(`Unhandled scripted write: ${route}`);
    switch (url.pathname) {
      case "/user":
        return Response.json({ node_id: "U1" });
      case "/repos/org/repo":
        return Response.json({
          node_id: "R1",
          full_name: "org/repo",
          allow_merge_commit: false,
          allow_squash_merge: true,
          allow_rebase_merge: false,
        });
      case "/repos/org/repo/pulls/7":
        return Response.json({
          node_id: "P7",
          number: 7,
          title: "Release PR",
          body: "Closes #1",
          merged: state.merged,
          draft: false,
          head: { sha: state.head, ref: "cb/change", repo: { node_id: "R1" } },
          base: { sha: state.base, ref: "main", repo: { node_id: "R1" } },
        });
      case "/repos/org/repo/issues/1":
        return Response.json({
          node_id: "I1",
          number: 1,
          state: state.merged ? "closed" : "open",
          title: "Release delivery",
          body: "Deliver O",
          labels: [{ name: "ready" }],
        });
      case `/repos/org/repo/commits/${state.head}/check-runs`:
        return Response.json({
          total_count: 1,
          check_runs: [
            {
              node_id: "CR1",
              name: "build",
              head_sha: state.head,
              status: "completed",
              conclusion: state.check,
              completed_at: "2026-10-05T12:00:00Z",
              started_at: null,
              app: { id: 17 },
            },
          ],
        });
      case `/repos/org/repo/commits/${state.head}/statuses`:
      case "/repos/org/repo/pulls/7/reviews":
      case "/repos/org/repo/pulls/7/comments":
      case "/repos/org/repo/rules/branches/main":
      case "/repos/org/repo/deployments":
        return Response.json([]);
      case "/repos/org/repo/issues/1/comments":
        return Response.json(state.comments);
      case "/repos/org/repo/issues/7/comments":
        return Response.json(
          state.feedback
            ? [
                {
                  node_id: "C1",
                  user: { node_id: "U1" },
                  body: "Repair literal feedback C1",
                  updated_at: "2026-10-05T12:01:00Z",
                },
              ]
            : [],
        );
      case "/repos/org/repo/branches/main/protection":
        return new Response("", { status: 404 });
      default:
        throw Error(`Unhandled scripted endpoint: ${route}`);
    }
  };
  return {
    state,
    provider: new GitHubHttpDeliveryProvider(
      "synthetic-release-marker",
      fetcher,
      async (request) => {
        // A lease on any other head rejects the push, as Git does.
        if ((state.refs[request.branch] ?? null) !== request.lease)
          return "rejected-lease";
        state.pushes.push({
          branch: request.branch,
          commitSha: request.commitSha,
          lease: request.lease,
        });
        state.refs[request.branch] = request.commitSha;
        return "pushed";
      },
      async (request) => {
        state.adopts.push({
          branch: request.branch,
          commitSha: request.commitSha,
        });
        return "adopted";
      },
    ),
  };
}

/** The GitLab project a delivery fixture links its repository to, and the seams that stand in for GitLab. */
export interface GitLabLink {
  host: string;
  repositoryId: string;
  projectPath: string;
  /** The checkout's `origin` remote. */
  origin: string;
  delivery: StandaloneServiceOptions["delivery"];
  /** The `glab` executable behind a `glab:` credential; fixtures otherwise point it at nothing. */
  glabExecutable?: string;
}

export async function createReleaseDeliveryFixture(
  mode: "reviewable-pr" | "through-merge" = "reviewable-pr",
  lifecycleOptions: FixtureLifecycleOptions = {},
  localTask = false,
  routingClient: RoutingChoiceClient | null = null,
  /** A local Git repository to provision as repository R1 (local tasks only). */
  repositoryPath?: string,
  /** Links `repositoryPath` as this GitLab project instead of R1, with these delivery seams. */
  gitlab?: GitLabLink,
) {
  const scripted = scriptedDeliveryProvider();
  const readerFactory: GitHubReaderFactory = () => ({
    async readSelection() {
      scripted.state.sourceReads++;
      await scripted.state.sourceWait;
      return {
        complete: true,
        reason: null,
        issues: scripted.state.merged
          ? []
          : [
              {
                providerInstance: "github.com",
                nodeId: "I1",
                repositoryId: "R1",
                repositoryName: "org/repo",
                number: 1,
                title: "Release delivery",
                body: scripted.state.sourceBody,
                state: "open",
                labels: ["ready"],
                projectFields: [],
              },
            ],
      };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: scripted.state.merged ? "closed" : "open" };
    },
  });
  const f = await createOperatorFixture(
    routingClient,
    readerFactory,
    {
      providerFactories: { github: () => scripted.provider },
      issueTrackerFactories: { github: () => scripted.provider },
      ...gitlab?.delivery,
    },
    lifecycleOptions,
    () => new ReleaseRuntime(),
    gitlab?.glabExecutable ? { glabExecutable: gitlab.glabExecutable } : {},
  );
  const projectId = randomUUID(),
    profileId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Lead",
    instructions: "Lead",
    capabilities: "work",
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Release project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    instructions: "Deliver scoped task",
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "env:SYNTHETIC_SOURCE",
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: {
      mode: "any",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: 2,
  });
  if (gitlab && repositoryPath)
    await d.configureRepositories({
      type: "repositories.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: d.repositoryLinks(projectId).version,
      repositories: [
        {
          codeHost: "gitlab",
          host: gitlab.host,
          repositoryId: gitlab.repositoryId,
          projectPath: gitlab.projectPath,
          path: repositoryPath,
          ref: "main",
        },
      ],
    } as never);
  let taskId: string;
  if (localTask) {
    taskId = randomUUID();
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: "Release delivery",
      outcome: "Deliver O",
      ready: true,
    });
  } else {
    await f.service.refreshGitHub();
    taskId = String(f.service.githubSources().issue("I1")?.taskId);
  }
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode,
    credentialRef: null,
    grants: [{ action: "pr.merge", repositoryId: "R1", mode: "allow" }],
    requiredChecks: [{ name: "build", appId: 17 }],
  });
  await f.service.provisionTask(
    taskId,
    repositoryPath
      ? [
          {
            repositoryId: gitlab?.repositoryId ?? "R1",
            path: repositoryPath,
            ...(gitlab ? { ref: "main" } : {}),
          },
        ]
      : [],
  );
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 2,
    paused: false,
  });
  const waitTurn = async (index = f.runtime.turns) => {
    await until(
      () =>
        f.service
          .list()
          .some(
            (i) =>
              i.turnId === f.runtime.turnId(index) && i.state === "running",
          ),
      "bound turn",
    );
    return {
      threadId: f.runtime.threadFor(index),
      turnId: f.runtime.turnId(index),
    };
  };
  const call = async (
    tool: string,
    args: Record<string, unknown>,
    index = f.runtime.turns,
  ) =>
    f.runtime.callTool({
      ...(await waitTurn(index)),
      callId: randomUUID(),
      tool,
      arguments: args,
    });
  await waitTurn(1);
  return Object.assign(f, {
    projectId,
    profileId,
    taskId,
    scripted,
    call,
    waitTurn,
    async register() {
      const r = await call("cab_register_pr", {
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: scripted.state.head,
      });
      assert.equal(r.success, true, r.text);
      return r;
    },
    async merge(operationId = randomUUID()) {
      return call("cab_external_action", {
        operationId,
        action: {
          kind: "pr.merge",
          target: {
            repositoryId: "R1",
            nodeId: "P7",
            number: 7,
            headRef: "cb/change",
            baseRef: "main",
            expectedHeadSha: scripted.state.head,
          },
          method: "squash",
          reviewedResultIds: [],
        },
      });
    },
    /** Replaces the project's delivery grants; the runtime keeps its bound lead turn. */
    grant(...grants: Array<{ action: string; mode: "allow" | "approval" }>) {
      d.execute({
        type: "delivery.configure",
        actor: "operator",
        key: randomUUID(),
        projectId,
        expectedVersion: f.service.delivery().configuration(projectId).version,
        mode,
        credentialRef: null,
        grants: grants.map((g) => ({
          ...g,
          repositoryId: gitlab?.repositoryId ?? "R1",
        })) as never,
        requiredChecks: f.service.delivery().configuration(projectId)
          .requiredChecks,
      });
    },
    async threadAction(
      action: Record<string, unknown>,
      operationId = randomUUID(),
      index = f.runtime.turns,
      approval?: { interactionId: string; expectedRevision: number },
    ) {
      return call(
        "cab_external_action",
        {
          operationId,
          action: {
            ...action,
            target: {
              repositoryId: "R1",
              nodeId: "P7",
              number: 7,
              threadNodeId: "T1",
            },
          },
          ...(approval ? { approval } : {}),
        },
        index,
      );
    },
    settlement() {
      const b = f.service.delivery().delivery(taskId);
      assert.ok(b);
      return {
        actor: "operator" as const,
        key: randomUUID(),
        taskId,
        expectedTaskVersion: Number(f.service.domain().task(taskId).version),
        expectedDeliveryRevision: b.revision,
        expectedPolicyVersion: f.service.delivery().configuration(projectId)
          .version,
        repositoryId: "R1",
        prNumber: 7,
        expectedPrNodeId: "P7",
        expectedHeadSha: scripted.state.head,
        decision: "accepted" as const,
      };
    },
    async terminal(index = f.runtime.turns) {
      f.runtime.complete(index);
      await until(
        () =>
          f.service
            .list()
            .some(
              (i) =>
                i.turnId === f.runtime.turnId(index) && i.state === "completed",
            ),
        "terminal settlement",
      );
    },
    /** Records the bound PR as belonging to another repository than its imported source; reopen to read it. */
    moveBoundPullRequestToRepository(repositoryId: string) {
      f.seedPersistedState((db) => {
        const row = db
          .prepare("SELECT recordJson FROM delivery_pr_bindings WHERE taskId=?")
          .get(taskId) as { recordJson: string };
        const record = JSON.parse(row.recordJson);
        record.observation.repositoryId = repositoryId;
        db.prepare(
          "UPDATE delivery_pr_bindings SET recordJson=? WHERE taskId=?",
        ).run(JSON.stringify(record), taskId);
      });
    },
    readDb<T>(read: (db: DatabaseSync) => T): T {
      const db = new DatabaseSync(
        join(f.directory, "data", "standalone.sqlite"),
      );
      try {
        return read(db);
      } finally {
        db.close();
      }
    },
  });
}

/** A repository with one commit, provisioned for the task as R1, or as the GitLab project when given. */
export async function publicationWorld(
  mode: "allow" | "approval",
  gitlab?: GitLabLink,
  options: {
    /** An existing checkout (already linked to its origin) to provision instead of a new repository. */
    source?: string;
    deliveryMode?: "reviewable-pr" | "through-merge";
  } = {},
) {
  const repositoryId = gitlab?.repositoryId ?? "R1";
  let source = options.source;
  if (!source) {
    source = realpathSync(makeTemp(join(osTmp(), "cab-publish-src-")));
    runGit(source, "init", "-q", "-b", "main");
    writeFile(join(source, "a.txt"), "a\n");
    runGit(source, "add", ".");
    runGit(source, "commit", "-q", "-m", "base");
    if (gitlab) runGit(source, "remote", "add", "origin", gitlab.origin);
  }
  const f = await createReleaseDeliveryFixture(
    options.deliveryMode ?? "reviewable-pr",
    {},
    true,
    null,
    source,
    gitlab,
  );
  f.grant(
    { action: "branch.push", mode },
    // Recovery is approval-gated whatever the grant: an overwrite is granted as allow on purpose.
    { action: "branch.force-push", mode: "allow" },
    { action: "branch.adopt", mode: "approval" },
    { action: "pr.create", mode: "allow" },
  );
  const binding = await f.service.taskWorkspace(f.taskId);
  const workspace = binding?.repositories[0]?.workspacePath;
  assert.ok(workspace);
  const commit = (name: string) => {
    writeFile(join(workspace, name), `${name}\n`);
    runGit(workspace, "add", ".");
    runGit(workspace, "commit", "-q", "-m", name);
    return runGit(workspace, "rev-parse", "HEAD");
  };
  const push = (commitSha: string, index?: number, approval?: object) =>
    f.call(
      "cab_external_action",
      {
        operationId: randomUUID(),
        action: {
          kind: "branch.push",
          target: { repositoryId },
          commitSha,
        },
        ...(approval ? { approval } : {}),
      },
      index,
    );
  const createPr = (headRef: string, expectedHeadSha: string) =>
    f.call("cab_external_action", {
      operationId: randomUUID(),
      action: {
        kind: "pr.create",
        target: {
          repositoryId,
          baseRef: "main",
          headRef,
          expectedHeadSha,
        },
        title: "Change",
        body: "Body",
        draft: true,
      },
    });
  const action = (
    kind: "branch.force-push" | "branch.adopt",
    material: Record<string, unknown>,
  ) => ({ kind, target: { repositoryId }, ...material });
  const recover = (
    recovery: Record<string, unknown>,
    index: number,
    approval?: object,
  ) =>
    f.call(
      "cab_external_action",
      {
        operationId: randomUUID(),
        action: recovery,
        ...(approval ? { approval } : {}),
      },
      index,
    );
  /** The lead requests approval of exact recovery material and the operator approves it. */
  const approve = async (recovery: Record<string, unknown>, turn: number) => {
    const requested = await f.call(
      "cab_request_approval",
      {
        action: recovery.kind,
        target: canonicalMaterial(recovery.target),
        material: recovery,
      },
      turn,
    );
    assert.equal(requested.success, true, requested.text);
    const interaction = f.service
      .coordinationView()
      .readTask(f.taskId)
      .approvals.filter((a) => a.status === "open")
      .at(-1);
    assert.ok(interaction);
    await f.terminal(turn);
    await f.service.coordinationView().decideApproval({
      taskId: f.taskId,
      key: randomUUID(),
      interactionId: interaction.interactionId,
      expectedRevision: 1,
      decision: "approved",
      action: String(recovery.kind),
      target: canonicalMaterial(recovery.target),
      material: recovery,
    });
    await f.waitTurn(turn + 1);
    return { interactionId: interaction.interactionId, expectedRevision: 2 };
  };
  return { f, commit, push, createPr, action, recover, approve };
}
