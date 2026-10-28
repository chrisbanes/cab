import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DeliveryStore,
  isRecoveryAction,
  type DeliveryCaller,
} from "../../../src/core/delivery.js";
import { DomainStore } from "../../../src/core/domain.js";
import { Store } from "../../../src/core/store.js";
import { DeliveryCoordinator } from "../../../src/standalone/delivery.js";
import {
  type AdoptFunction,
  adoptOutsideHead,
} from "../../../src/standalone/git-fetch.js";
import { pushTaskCommit } from "../../../src/standalone/git-push.js";
import {
  GitHubHttpDeliveryProvider,
  type PushFunction,
} from "../../../src/standalone/github-delivery.js";
import { verifyTaskPush } from "../../../src/standalone/push-verification.js";
import type { PrDeliveryObservation } from "../../../src/core/delivery.js";
import type { PublicationGuard } from "./publication-fixture.js";

export interface PublicationJourneyOptions {
  guard: PublicationGuard;
  token: string;
  /** Where the fixture is cloned from; production is its public https URL. */
  cloneUrl: string;
  /** The raw HTTP transport the guard wraps; tests pass a fake GitHub. */
  fetcher?: typeof fetch;
  /** The HTTPS push; tests pass a fake. */
  push?: PushFunction;
  /** The HTTPS fetch of an adopted head; tests pass a fake. */
  adopt?: AdoptFunction;
  /** Independent readbacks of the remote branch head and the PR head (production uses the `gh` CLI). */
  readRef(branch: string): string | null;
  readPrHead(number: number): string;
  /** Tests stand in for the PR GraphQL inspection. */
  inspectPr?(): Promise<PrDeliveryObservation>;
}

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...env,
    },
  }).trim();

function filesContaining(directory: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && readFileSync(path).includes(needle))
        found.push(path);
    }
  };
  walk(directory);
  return found;
}

/**
 * One bounded publication on the fixture repository: a real task worktree, Ensemble's coordinator and
 * HTTPS push for a first commit, `pr.create` on the assigned branch, and a repair push to the same
 * branch. Then the harness plays an outside writer twice: the first outside commit is overwritten, the
 * second is adopted and pushed on top of, each recovery approved as the operator would. Cleanup (closing the PR, deleting the scratch head) is the harness's own, because Ensemble
 * never deletes branches. Never throws for an assertion: returns the evidence with `publication: "failed"`.
 */
export async function runPublicationJourney(
  options: PublicationJourneyOptions,
) {
  const { guard, token } = options;
  const manifest = guard.manifest;
  const fullName = manifest.repository.fullName;
  const repositoryId = manifest.repository.nodeId;
  const runId = randomBytes(4).toString("hex");
  const redact = (text: string) => text.split(token).join("[redacted]");
  const evidence: Record<string, unknown> = {
    version: 1,
    repository: fullName,
    runId,
    turns: 0,
    publication: "failed",
    cleanup: "unverified",
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ensemble-s07a-pub-")));
  const db = new DatabaseSync(":memory:");
  let branch: string | undefined;
  let prNumber: number | undefined;
  let prAttempted = false;
  const raw = options.fetcher ?? fetch;
  const guardedFetch: typeof fetch = async (input, init) => {
    guard.assertRequest(input, init);
    // A redirect would leave the guarded path; the provider sets its own policy for reads.
    return raw(input, { ...init, redirect: init?.redirect ?? "error" });
  };
  const api = async (method: string, path: string, body?: unknown) => {
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
    return {
      status: response.status,
      json:
        response.status === 204 || response.status === 404
          ? null
          : await response.json(),
    };
  };
  try {
    // Fixture identity and visibility, from a read, before anything is written.
    const repo = await api("GET", `/repos/${fullName}`);
    const observed = repo.json as {
      node_id: string;
      private: boolean;
      default_branch: string;
    };
    if (
      observed.node_id !== repositoryId ||
      observed.default_branch !== manifest.repository.defaultBranch
    )
      throw new Error("Fixture identity does not match the manifest");
    guard.assertRepositoryVisibility(observed.private);

    const clone = join(root, "clone");
    git(
      root,
      [
        "clone",
        "--quiet",
        "--single-branch",
        "--branch",
        manifest.repository.defaultBranch,
        options.cloneUrl,
        clone,
      ],
      { GIT_ALLOW_PROTOCOL: "https:file" },
    );
    const workspace = join(root, "workspace");
    const base = git(clone, ["rev-parse", "HEAD"]);
    git(clone, ["worktree", "add", "--quiet", "--detach", workspace, base]);
    const commit = (name: string) => {
      mkdirSync(join(workspace, "qualification"), { recursive: true });
      writeFileSync(
        join(workspace, "qualification", name),
        `publication ${runId}\n`,
      );
      git(workspace, ["add", "."]);
      git(workspace, [
        "-c",
        "user.name=Ensemble qualification",
        "-c",
        "user.email=qualification@example.invalid",
        "commit",
        "--quiet",
        "-m",
        `Publication qualification ${runId}`,
      ]);
      return git(workspace, ["rev-parse", "HEAD"]);
    };

    new Store(db).ensureHost("publication-qualification");
    const domain = new DomainStore(db);
    domain.migrate();
    const projectId = randomUUID(),
      taskId = randomUUID();
    domain.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Publication qualification",
      leadProfileId: null,
    });
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title: `Publication ${runId}`,
      outcome: "Publish and repair",
    });
    const store = new DeliveryStore(db);
    store.migrate();
    domain.execute({
      type: "delivery.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      mode: "reviewable-pr",
      credentialRef: null,
      branchPrefix: manifest.branchPrefix,
      grants: manifest.actions.map((action) => ({
        action,
        repositoryId,
        // Adoption is only grantable with approval.
        mode:
          action === "branch.adopt"
            ? ("approval" as const)
            : ("allow" as const),
      })),
      requiredChecks: [],
    });
    const caller: DeliveryCaller = {
      projectId,
      taskId,
      assignmentId: randomUUID(),
      taskVersion: 1,
      assignmentVersion: 1,
      workId: "work",
      workRevision: 1,
      conversationRevision: 1,
    };
    const wakes: string[] = [];
    let pushes = 0;
    const push: PushFunction = async (request) => {
      guard.assertPush(request);
      guard.recordBranch(request.branch);
      // Known before the push can fail, so cleanup deletes a head even when the run does not finish.
      branch = request.branch;
      pushes++;
      return (options.push ?? pushTaskCommit)(request);
    };
    const adopt: AdoptFunction = async (request) => {
      guard.assertAdopt(request);
      return (options.adopt ?? adoptOutsideHead)(request);
    };
    const real = new GitHubHttpDeliveryProvider(
      token,
      guardedFetch,
      push,
      adopt,
    );
    const provider = options.inspectPr
      ? Object.assign(Object.create(real), { inspectPr: options.inspectPr })
      : real;
    const coordinator = new DeliveryCoordinator(store, {
      providerFactory: () => provider,
      authorize: () => {},
      // The harness stands in for the operator's approval of a recovery, and of nothing else.
      approved: (request) => isRecoveryAction(request.action),
      taskWorkspace: async () => ({
        workspacePath: workspace,
        baseCommit: base,
      }),
      leadAssignmentId: () => caller.assignmentId,
      feedback: (_task, _reason, identity) => wakes.push(identity),
      verifyPush: async (input) =>
        verifyTaskPush(
          { workspacePath: workspace, baseCommit: base },
          input.commitSha,
          input.lastPushedSha,
        ),
    });
    const submit = (action: Record<string, unknown>) =>
      coordinator.submit({ operationId: randomUUID(), action }, caller);
    const mustSucceed = (
      label: string,
      record: { state: string; observation: { reason: string | null } | null },
    ) => {
      if (record.state !== "confirmed-success")
        throw new Error(
          `${label}: ${record.state} (${record.observation?.reason ?? "no reason"})`,
        );
    };

    const first = commit(`publication-${runId}.md`);
    const pushOne = await submit({
      kind: "branch.push",
      target: { repositoryId },
      commitSha: first,
    });
    branch = store.taskBranch(taskId, repositoryId)?.branch;
    mustSucceed("first push", pushOne);
    if (!branch) throw new Error("No task branch was assigned");
    if (options.readRef(branch) !== first)
      throw new Error("Remote branch is not the first commit");

    prAttempted = true;
    const created = await submit({
      kind: "pr.create",
      target: {
        repositoryId,
        baseRef: manifest.repository.defaultBranch,
        headRef: branch,
        expectedHeadSha: first,
      },
      title: `Publication qualification ${runId}`,
      body: "Bounded Ensemble publication qualification. Closed by the harness.",
      draft: true,
    });
    mustSucceed("pr.create", created);
    // The confirmed readback receipt names the PR; no list query decides which one to close.
    const receipt = created.observation?.receipt;
    if (!receipt?.number) throw new Error("pr.create receipt names no PR");
    const pull = { number: receipt.number, node_id: receipt.nodeId };
    prNumber = pull.number;
    guard.recordPr(pull.number, pull.node_id);
    await coordinator.registerPr(
      {
        repositoryId,
        prNumber: pull.number,
        expectedPrNodeId: pull.node_id,
        expectedHeadSha: first,
      },
      caller,
    );

    const second = commit(`publication-${runId}-repair.md`);
    mustSucceed(
      "repair push",
      await submit({
        kind: "branch.push",
        target: { repositoryId },
        commitSha: second,
      }),
    );
    if (options.readRef(branch) !== second)
      throw new Error("Remote branch is not the repair commit");
    if (options.readPrHead(pull.number) !== second)
      throw new Error("PR head did not advance to the repair commit");
    const observedHead = store.delivery(taskId)?.observation.headSha;
    if (observedHead !== second)
      throw new Error("Ensemble's PR observation did not advance");
    if (wakes.some((w) => w.startsWith("outside-push:")))
      throw new Error("An outside push was reported");

    // The harness plays the outside writer: a commit on top of the branch head, moved there by a
    // fast-forward through the REST API, which the lead then finds at its next plain push.
    const outsideMove = async (parent: string, label: string) => {
      const found = await api(
        "GET",
        `/repos/${fullName}/git/commits/${parent}`,
      );
      const tree = (found.json as { tree: { sha: string } }).tree.sha;
      const made = await api("POST", `/repos/${fullName}/git/commits`, {
        message: `Outside change ${label} ${runId}`,
        tree,
        parents: [parent],
      });
      const outside = (made.json as { sha?: string } | null)?.sha;
      if (!outside) throw new Error(`Outside commit ${label} was not created`);
      const moved = await api(
        "PATCH",
        `/repos/${fullName}/git/refs/heads/${branch}`,
        { sha: outside, force: false },
      );
      if (moved.status !== 200 || options.readRef(branch ?? "") !== outside)
        throw new Error(`Outside commit ${label} did not move the branch`);
      return outside;
    };
    const mustRefuseOutside = async (label: string, sha: string) => {
      const refused = await submit({
        kind: "branch.push",
        target: { repositoryId },
        commitSha: sha,
      });
      if (refused.observation?.reason !== "branch-outside-change")
        throw new Error(`${label}: the outside change was not detected`);
      const recorded = store.taskBranch(taskId, repositoryId);
      if (!recorded?.outsideHeadSha || !branch)
        throw new Error(`${label}: no outside head was recorded`);
      return recorded;
    };

    // Overwrite: the outside head is replaced under a lease on it.
    const outsideOne = await outsideMove(second, "one");
    const thirdLocal = commit(`publication-${runId}-overwrite.md`);
    const heldOne = await mustRefuseOutside("overwrite", thirdLocal);
    if (heldOne.outsideHeadSha !== outsideOne)
      throw new Error("The recorded outside head is not the outside commit");
    mustSucceed(
      "overwrite",
      await submit({
        kind: "branch.force-push",
        target: { repositoryId },
        commitSha: thirdLocal,
        branch: heldOne.branch,
        outsideHeadSha: outsideOne,
        lastPushedSha: heldOne.lastPushedSha,
      }),
    );
    if (options.readRef(branch) !== thirdLocal)
      throw new Error("Remote branch is not the overwriting commit");
    if (store.taskBranch(taskId, repositoryId)?.outsideHeadSha !== null)
      throw new Error("The outside change did not clear after the overwrite");

    // Adopt: the second outside commit is kept, integrated offline and pushed on top of.
    const outsideTwo = await outsideMove(thirdLocal, "two");
    const diverged = commit(`publication-${runId}-adopt.md`);
    const heldTwo = await mustRefuseOutside("adopt", diverged);
    if (heldTwo.outsideHeadSha !== outsideTwo)
      throw new Error("The recorded outside head is not the second commit");
    mustSucceed(
      "adopt",
      await submit({
        kind: "branch.adopt",
        target: { repositoryId },
        branch: heldTwo.branch,
        outsideHeadSha: outsideTwo,
        lastPushedSha: heldTwo.lastPushedSha,
      }),
    );
    const adopted = store.taskBranch(taskId, repositoryId);
    if (
      adopted?.lastPushedSha !== outsideTwo ||
      adopted.outsideHeadSha !== null
    )
      throw new Error("The adopted head was not recorded as the last push");
    // The agent's integration: merge the adopted head in the worktree, which adopt never touched.
    git(workspace, [
      "-c",
      "user.name=Ensemble qualification",
      "-c",
      "user.email=qualification@example.invalid",
      "merge",
      "--quiet",
      "--no-edit",
      outsideTwo,
    ]);
    const merged = git(workspace, ["rev-parse", "HEAD"]);
    mustSucceed(
      "push after adopt",
      await submit({
        kind: "branch.push",
        target: { repositoryId },
        commitSha: merged,
      }),
    );
    if (options.readRef(branch) !== merged)
      throw new Error(
        "Remote branch is not the merge on top of the adopted head",
      );
    if (options.readPrHead(pull.number) !== merged)
      throw new Error("PR head did not advance to the merge");
    if (store.delivery(taskId)?.observation.headSha !== merged)
      throw new Error("Ensemble's PR observation did not advance");
    const recoveryWakes = wakes.filter((w) => w.startsWith("outside-push:"));
    if (
      recoveryWakes.join() !==
      [outsideOne, outsideTwo]
        .map((sha) => `outside-push:${repositoryId}:${sha}`)
        .join()
    )
      throw new Error("The lead was not woken once per outside change");
    if (store.completionBlockers(taskId).includes("task-branch-outside-change"))
      throw new Error("The outside change still holds completion");

    // The credential is nowhere Ensemble or the harness wrote.
    const leaked = [
      ...filesContaining(root, token),
      ...[
        git(clone, ["config", "--list", "--show-origin"]),
        git(workspace, ["config", "--list", "--show-origin"]),
      ].filter((c) => c.includes(token)),
    ];
    if (leaked.length)
      throw new Error(
        "The credential appears in Git configuration or worktree files",
      );
    Object.assign(evidence, {
      publication: "passed",
      branch,
      firstCommit: first,
      repairCommit: second,
      overwrite: "passed",
      adopt: "passed",
      outsideCommits: [outsideOne, outsideTwo],
      overwriteCommit: thirdLocal,
      adoptedMergeCommit: merged,
      pullRequest: pull.number,
      pushes,
      outsidePushEvents: 2,
      credentialExposures: 0,
    });
  } catch (error) {
    evidence.failure = redact(
      String(error instanceof Error ? error.message : error),
    );
  } finally {
    // The harness owns cleanup: close the recorded PR, delete the recorded head, then prove both.
    try {
      if (prNumber !== undefined)
        await api("PATCH", `/repos/${fullName}/pulls/${prNumber}`, {
          state: "closed",
        });
      if (branch)
        await api("DELETE", `/repos/${fullName}/git/refs/heads/${branch}`);
      const closed =
        prNumber === undefined
          ? !prAttempted
          : (
              (await api("GET", `/repos/${fullName}/pulls/${prNumber}`))
                .json as { state: string }
            ).state === "closed";
      const gone =
        !branch ||
        (await api("GET", `/repos/${fullName}/git/ref/heads/${branch}`))
          .status === 404;
      evidence.cleanup = closed && gone ? "verified" : "unverified";
    } catch (error) {
      evidence.cleanup = "unverified";
      evidence.cleanupFailure = redact(
        String(error instanceof Error ? error.message : error),
      );
    }
    evidence.writes = guard.writes;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
  return evidence;
}
