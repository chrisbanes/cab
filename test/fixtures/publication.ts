import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  type DeliveryCaller,
  DeliveryStore,
  type ExternalAction,
  type PrDeliveryObservation,
} from "../../src/core/delivery.js";
import { DomainStore } from "../../src/core/domain.js";
import { GitHubSourceStore } from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { DeliveryCoordinator } from "../../src/standalone/delivery.js";
import type { PushOutcome } from "../../src/standalone/git-push.js";
import {
  GitHubHttpDeliveryProvider,
  type PushFunction,
} from "../../src/standalone/github-delivery.js";
import { verifyTaskPush } from "../../src/standalone/push-verification.js";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  ).trim();
}

/** A source repository and a detached task worktree provisioned at its `base` commit. */
export function taskWorktree(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ensemble-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "z.txt"), "z\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "before-base");
  const beforeBase = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, "a.txt"), "a\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  const workspace = join(root, "workspace");
  git(source, "worktree", "add", "-q", "--detach", workspace, base);
  let counter = 0;
  return {
    root,
    source,
    workspace,
    base,
    beforeBase,
    /** Commits a new file in the worktree; returns the new commit. */
    commit(message = `change ${++counter}`) {
      writeFileSync(join(workspace, `${randomUUID()}.txt`), `${message}\n`);
      git(workspace, "add", ".");
      git(workspace, "commit", "-q", "-m", message);
      return git(workspace, "rev-parse", "HEAD");
    },
    /** Rewrites the tip commit, so the new one does not descend from the old. */
    amend() {
      git(workspace, "commit", "-q", "--amend", "-m", `amended ${++counter}`);
      return git(workspace, "rev-parse", "HEAD");
    },
  };
}

export const repositoryId = "R1";
const header = { "content-type": "application/json" };

/**
 * Real SQLite stores and a real coordinator over a real task worktree, with a fake GitHub (one
 * repository and one branch head) and a fake HTTPS push.
 */
export function publicationWorld(
  t: TestContext,
  options: {
    grants?: Array<
      | "branch.push"
      | "branch.force-push"
      | "pr.create"
      | "pr.merge"
      | "pr.ready"
      | "pr.edit"
    >;
    deliveryMode?: "reviewable-pr" | "through-merge";
    mode?: "allow" | "approval";
    branchPrefix?: string;
    title?: string;
  } = {},
) {
  const tree = taskWorktree(t);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db);
  domain.migrate();
  const projectId = randomUUID(),
    taskId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "P",
    leadProfileId: null,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: options.title ?? "Fix the login bug!",
    outcome: "O",
  });
  new GitHubSourceStore(db).migrate();
  const store = new DeliveryStore(db);
  store.migrate();
  const configure = (grants: NonNullable<typeof options.grants>) =>
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: store.configuration(projectId).version,
      mode: options.deliveryMode ?? "reviewable-pr",
      credentialRef: null,
      ...(options.branchPrefix === undefined
        ? {}
        : { branchPrefix: options.branchPrefix }),
      grants: grants.map((action) => ({
        action,
        repositoryId,
        mode: options.mode ?? "allow",
      })),
      requiredChecks: [],
    });
  configure(options.grants ?? ["branch.push", "branch.force-push"]);

  const remote: { head: string | null } = { head: null };
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/graphql")
      return Response.json({
        data: { node: { id: repositoryId, nameWithOwner: "org/repo" } },
      });
    if (url.pathname === "/repos/org/repo")
      return Response.json({
        node_id: repositoryId,
        full_name: "org/repo",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    const prefix = "/repos/org/repo/git/ref/heads/";
    if (url.pathname.startsWith(prefix)) {
      if (refReadsFail) return Response.json({}, { status: 500 });
      if (!remote.head)
        return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(
        {
          ref: `refs/heads/${decodeURIComponent(url.pathname.slice(prefix.length))}`,
          object: { sha: remote.head },
        },
        { headers: header },
      );
    }
    throw new Error(`unexpected route ${url.pathname}`);
  };

  /** What the fake HTTPS push does with a request, set per test. */
  const pushes: Array<Parameters<PushFunction>[0]> = [];
  let pushBehaviour:
    | "apply"
    | "uncertain-applied"
    | "uncertain-lost"
    | "outside-during-push"
    | "applied-but-unread"
    | "not-attempted"
    | "remote-rejected"
    | "applied-then-moved"
    | "stale-unchanged"
    | "stale-readback-fails"
    | "applied-then-deleted" = "apply";
  let racer: string | null = null;
  let movedHead = "9".repeat(40);
  let refReadsFail = false;
  const push: PushFunction = async (request): Promise<PushOutcome> => {
    pushes.push(request);
    // Another writer moves the branch after Ensemble's preflight and before its push.
    if (racer) {
      remote.head = racer;
      racer = null;
    }
    if (pushBehaviour === "uncertain-lost") return "uncertain";
    if (pushBehaviour === "applied-but-unread") return "pushed";
    if (pushBehaviour === "not-attempted") return "not-attempted";
    if (pushBehaviour === "stale-unchanged") return "rejected-lease";
    if (pushBehaviour === "stale-readback-fails") {
      refReadsFail = true;
      return "rejected-lease";
    }
    if (pushBehaviour === "applied-then-deleted") {
      // Git succeeds, then another writer deletes the branch before Ensemble reads it back.
      remote.head = null;
      return "pushed";
    }
    if (pushBehaviour === "applied-then-moved") {
      // Git succeeds, then another writer moves the branch before Ensemble reads it back.
      remote.head = movedHead;
      return "pushed";
    }
    if (pushBehaviour === "remote-rejected") return "rejected-remote";
    if (pushBehaviour === "outside-during-push") {
      remote.head = "d".repeat(40);
      return "rejected-lease";
    }
    if (remote.head !== request.lease) return "rejected-lease";
    remote.head = request.commitSha;
    return pushBehaviour === "uncertain-applied" ? "uncertain" : "pushed";
  };

  let observed: PrDeliveryObservation | undefined;
  const wakes: Array<{ reason: string; identity: string }> = [];
  const caller: DeliveryCaller = {
    projectId,
    taskId,
    assignmentId: randomUUID(),
    taskVersion: 1,
    assignmentVersion: 1,
    workId: "w",
    workRevision: 1,
    conversationRevision: 1,
  };
  const coordinatorFor = (verify = true) => {
    const real = new GitHubHttpDeliveryProvider("token", fetcher, push);
    const provider = Object.assign(Object.create(real), {
      async inspectPr() {
        if (!observed) throw new Error("no PR");
        return observed;
      },
    });
    return new DeliveryCoordinator(store, {
      providerFactory: () => provider,
      authorize: () => {},
      approved: () => false,
      feedback: (_task, reason, identity) => wakes.push({ reason, identity }),
      ...(verify
        ? {
            verifyPush: async (input) =>
              verifyTaskPush(
                { workspacePath: tree.workspace, baseCommit: tree.base },
                input.commitSha,
                input.lastPushedSha,
              ),
          }
        : {}),
    });
  };
  const coordinator = coordinatorFor();
  const submit = (
    kind: "branch.push" | "branch.force-push",
    commitSha: string,
    who: DeliveryCoordinator = coordinator,
  ) =>
    who.submit(
      {
        operationId: randomUUID(),
        action: { kind, target: { repositoryId }, commitSha },
      },
      caller,
    );
  return {
    ...tree,
    db,
    domain,
    store,
    coordinator,
    coordinatorFor,
    projectId,
    taskId,
    caller,
    remote,
    requests,
    pushes,
    wakes,
    submit,
    configure,
    failRefReads: (fail: boolean) => {
      refReadsFail = fail;
    },
    movedHeadAfterPush: (head: string) => {
      movedHead = head;
    },
    raceBeforeNextPush: (head: string) => {
      racer = head;
    },
    setPush: (behaviour: typeof pushBehaviour) => {
      pushBehaviour = behaviour;
    },
    /** The PR GitHub shows for the task, as the coordinator's PR inspection will read it. */
    showPr(headSha: string, headRef: string) {
      observed = {
        repositoryId,
        nodeId: "P7",
        number: 7,
        baseRef: "main",
        headRef,
        headSha,
        baseSha: tree.base,
        state: "OPEN",
        draft: false,
        merged: false,
        reviewDecision: null,
        checks: [],
        closedIssueNodeIds: [],
        mergeBlockers: [],
        allowedMethods: ["squash"],
      };
      return observed;
    },
    request: (action: ExternalAction) => ({
      operationId: randomUUID(),
      action,
    }),
  };
}
