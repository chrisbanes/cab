import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  type AdoptFunction,
  adoptOutsideHead,
} from "../../../src/standalone/git-fetch.js";
import { pushTaskCommit } from "../../../src/standalone/git-push.js";
import type { PushFunction } from "../../../src/standalone/github-delivery.js";
import type { RateLimitPolicy } from "../../../src/standalone/gitlab-http.js";
import { OperatorApi } from "../../../src/standalone/operator-api.js";
import { git } from "../../fixtures/publication.js";
import { stackedDeliveryFixture } from "../../fixtures/stacked-delivery.js";
import { cleanUp, harnessApi } from "./gitlab-cleanup.js";
import { type GitLabGuard, qualificationProject } from "./gitlab-guard.js";

const { host, id: repositoryId, path: projectPath } = qualificationProject;
const base = `/api/v4/projects/${repositoryId}`;

export interface GitLabStackQualificationOptions {
  /** A guard in `stack` mode. */
  guard: GitLabGuard;
  /** The raw HTTP transport the guard wraps; production passes `fetch`, tests a scripted host. */
  fetcher: typeof fetch;
  /** The checkout the run clones; its `main` must equal the project's. */
  source: string;
  /** The delivery credential: `glab:gitlab.com` in production. */
  credentialRef: string;
  /** The same login's token, for the harness's own reads and cleanup; never stored or printed. */
  token: () => Promise<string | undefined>;
  glabExecutable?: string;
  push?: PushFunction;
  adopt?: AdoptFunction;
  /** Waits between polls; tests advance their scripted host here. */
  pause?: () => Promise<void>;
  maxPolls?: number;
  rateLimit?: RateLimitPolicy;
}

type Step = { step: string; result: "passed" | "failed"; detail?: string };

/** What a run reports: statuses, counts, identifiers and merge bodies, never a credential value. */
export interface GitLabStackEvidence {
  runId: string;
  project: { host: string; id: string; path: string };
  qualification: "passed" | "failed";
  cleanup: "not-run" | "verified" | "failed";
  failure?: string;
  gitlab?: {
    version: string;
    mergeMethod: string | null;
    squashOption: string | null;
    mergeTrainsEnabled: boolean;
    removeSourceBranchAfterMerge: boolean | null;
  };
  account?: { id: number };
  /** The run's merge requests by layer: A on `main`, B on A's branch, C on B's. */
  mergeRequests: Partial<Record<"a" | "b" | "c", number>>;
  steps: Step[];
  mergeBodies?: GitLabGuard["mergeBodies"];
  mainPipelineAfterMerge?: string;
  cleanupReads: Array<{ resource: string; result: string }>;
  writes?: { count: number; merges: number };
  requests?: GitLabGuard["log"];
  requestCounts?: GitLabGuard["counts"];
  rateLimited?: GitLabGuard["rateLimited"];
}

const shapes = {
  version: z.object({ version: z.string() }),
  project: z.object({
    id: z.number().int(),
    path_with_namespace: z.string(),
    merge_method: z.string().nullish(),
    squash_option: z.string().nullish(),
    merge_trains_enabled: z.boolean().nullish(),
    remove_source_branch_after_merge: z.boolean().nullish(),
  }),
  branch: z.object({ commit: z.object({ id: z.string() }) }),
  user: z.object({ id: z.number().int() }),
  mergeRequest: z.object({
    iid: z.number().int(),
    state: z.string(),
    target_branch: z.string(),
  }),
  pipelines: z.array(z.object({ sha: z.string(), status: z.string() })),
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The bounded GitLab stacking qualification on the fixture project: three tasks, B blocked by A and C by
 * B, through the real service, delivery coordinator and GitLab provider, with the stacked fixture's
 * scripted lead (no model turns). It opens the three-layer stack, proves the base and bottom-up refusals
 * send nothing, merges A with source-branch removal, waits for GitLab to retarget B and cab to accept it,
 * Unstacks C with one target-branch edit, merges B plainly, checks `main`'s pipeline, and cleans up only
 * what the guard recorded. Returns evidence that holds no credential value.
 */
export async function runGitLabStackQualification(
  options: GitLabStackQualificationOptions,
): Promise<GitLabStackEvidence> {
  const { guard } = options;
  const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
  const guarded = guard.fetcher(options.fetcher);
  /** Requests the product and harness sent, so a refusal can be shown to send none. */
  let sent = 0;
  const fetcher = ((input: string, init?: RequestInit) => {
    sent++;
    return guarded(input, init);
  }) as typeof fetch;
  const steps: Step[] = [];
  const evidence: GitLabStackEvidence = {
    runId,
    project: { host, id: repositoryId, path: projectPath },
    qualification: "failed",
    cleanup: "not-run",
    mergeRequests: {},
    steps,
    cleanupReads: [],
  };
  const token = await options.token();
  const clean = (value: unknown) =>
    token ? String(value).replaceAll(token, "[redacted]") : String(value);
  const pass = (step: string, detail?: string) =>
    steps.push({
      step,
      result: "passed",
      ...(detail === undefined ? {} : { detail }),
    });
  const api = harnessApi(fetcher, () => token, options.rateLimit);
  const wait = () => (options.pause ? options.pause() : sleep(10_000));
  const pollUntil = async (label: string, done: () => Promise<boolean>) => {
    for (let n = 0; n < (options.maxPolls ?? 60); n++) {
      if (await done()) return;
      await wait();
    }
    throw new Error(`Timed out: ${label}`);
  };

  const temp = realpathSync(mkdtempSync(join(tmpdir(), "cab-gitlab-stack-")));
  const after: Array<() => unknown> = [];
  let pendingMerge: { iid: number; branch: string } | null = null;
  try {
    // Reads only, before anything is written: the project, its settings and that the clone is current.
    const version = await api("/api/v4/version");
    const info = await api(base);
    assert.equal(info.status, 200);
    const project = shapes.project.parse(info.json);
    assert.equal(String(project.id), repositoryId);
    assert.equal(project.path_with_namespace, projectPath);
    evidence.gitlab = {
      version: shapes.version.parse(version.json).version,
      mergeMethod: project.merge_method ?? null,
      squashOption: project.squash_option ?? null,
      mergeTrainsEnabled: project.merge_trains_enabled === true,
      removeSourceBranchAfterMerge:
        project.remove_source_branch_after_merge ?? null,
    };
    assert.equal(project.merge_trains_enabled === true, false, "no trains");
    const mainHead = shapes.branch.parse(
      (await api(`${base}/repository/branches/main`)).json,
    ).commit.id;
    const clone = join(temp, "clone");
    git(
      temp,
      "clone",
      "-q",
      "--no-hardlinks",
      "--branch",
      "main",
      options.source,
      clone,
    );
    git(
      clone,
      "remote",
      "set-url",
      "origin",
      `https://${host}/${projectPath}.git`,
    );
    assert.equal(git(clone, "rev-parse", "main"), mainHead, "clone-main-stale");
    evidence.account = {
      id: shapes.user.parse((await api("/api/v4/user")).json).id,
    };

    const f = await stackedDeliveryFixture(
      { after: (fn: () => unknown) => after.push(fn) } as never,
      {
        tasks: 3,
        gitlab: {
          fetcher,
          push: guard.guardPush(options.push ?? pushTaskCommit),
          adopt: guard.guardAdopt(options.adopt ?? adoptOutsideHead),
          credentialRef: options.credentialRef,
          ...(options.glabExecutable
            ? { glabExecutable: options.glabExecutable }
            : {}),
          ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
          project: { repositoryId, host, projectPath },
          source: clone,
        },
      },
    );
    const [a, b, c] = f.tasks as [string, string, string];
    f.run({
      type: "project.configure",
      projectId: f.projectId,
      expectedVersion: Number(f.service.domain().project(f.projectId).version),
      instructions: "Bounded GitLab stacking qualification.",
    });
    const policy = f.service.delivery().configuration(f.projectId);
    f.run({
      type: "delivery.configure",
      projectId: f.projectId,
      expectedVersion: policy.version,
      mode: "through-merge",
      credentialRef: null,
      grants: [
        ...policy.grants,
        { action: "pr.create", repositoryId, mode: "allow" },
        { action: "pr.merge", repositoryId, mode: "allow" },
      ],
      requiredChecks: [],
      repositories: [
        {
          repositoryId,
          mergeMethod: "merge",
          requiredChecks: [{ name: "pipeline" }],
        },
      ],
    });

    const bound = (task: string) => f.service.delivery().delivery(task);
    const refresh = (task: string) =>
      f.service.coordinationView().refreshDelivery(task);
    const act = (task: string, action: Record<string, unknown>) =>
      f.call(task, "cab_external_action", {
        operationId: randomUUID(),
        action,
      });
    const last = (task: string, kind: string) =>
      f.service
        .delivery()
        .actions(task)
        .filter((x) => x.request.action.kind === kind)
        .at(-1);
    const sentDuring = async (run: () => Promise<unknown>) => {
      const before = sent;
      await run();
      return sent - before;
    };
    /** The lead takes its pending delivery events in a new turn: a merge waits for them. */
    const settle = async (task: string) => {
      const pending = () =>
        f.readDb(
          (db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM coordination_inbox_events e LEFT JOIN coordination_delivery_events d ON d.eventId=e.eventId WHERE e.taskId=? AND d.eventId IS NULL",
              )
              .get(task)?.n,
        );
      for (let n = 0; n < 5 && Number(pending()) > 0; n++) {
        const turns = (await f.turnsOf(task)).length;
        await f.complete(task);
        await f.waitTurn(task, turns + 1);
      }
    };
    const create = (task: string, name: string, baseRef: string) => {
      const branch = f.branchOf(task);
      assert.ok(branch?.lastPushedSha);
      return act(task, {
        kind: "pr.create",
        target: {
          repositoryId,
          baseRef,
          headRef: branch.branch,
          expectedHeadSha: branch.lastPushedSha,
        },
        title: `Qualification ${runId} stack-${name}`,
        body: `Bounded cab stacking qualification run ${runId}. Safe to close.`,
        draft: false,
      });
    };
    const push = async (task: string, name: string) => {
      await f.waitTurn(task);
      const { path } = await f.workspaceOf(task);
      const file = join(path, "qual", `${runId}-stack-${name}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `Qualification ${runId} stack-${name}\n`);
      git(path, "add", ".");
      git(path, "commit", "-q", "-m", `Qualification ${runId} stack-${name}`);
      const head = git(path, "rev-parse", "HEAD");
      const pushed = await f.push(task, head);
      assert.equal(pushed.success, true, `${name} push: ${clean(pushed.text)}`);
      return head;
    };
    const register = async (
      task: string,
      name: "a" | "b" | "c",
      baseRef: string,
    ) => {
      const created = await create(task, name, baseRef);
      assert.equal(
        created.success,
        true,
        `${name} create: ${clean(created.text)}`,
      );
      const iid = [...guard.requests.keys()].at(-1);
      const request = iid === undefined ? undefined : guard.requests.get(iid);
      assert.ok(iid && request);
      evidence.mergeRequests[name] = iid;
      const registered = await f.call(task, "cab_register_pr", {
        repositoryId,
        prNumber: iid,
        expectedPrNodeId: String(request.id),
        expectedHeadSha: f.branchOf(task)?.lastPushedSha,
      });
      assert.equal(
        registered.success,
        true,
        `${name} register: ${clean(registered.text)}`,
      );
      await refresh(task);
      return iid;
    };
    const mergeAction = (task: string, baseRef: string) => {
      const p = bound(task)?.observation;
      assert.ok(p);
      return {
        kind: "pr.merge",
        target: {
          repositoryId,
          nodeId: p.nodeId,
          number: p.number,
          baseRef,
          headRef: p.headRef,
          expectedHeadSha: p.headSha,
        },
        method: "merge",
        reviewedResultIds: [],
      };
    };
    /** Waits for the pipeline, then merges once; an unproved merge is read again, never sent again. */
    const merge = async (
      task: string,
      iid: number,
      removeSourceBranch: boolean,
    ) => {
      await pollUntil(`merge request !${iid} mergeable`, async () => {
        await refresh(task);
        return bound(task)?.observation.mergeBlockers.length === 0;
      });
      guard.allowMerge(iid, removeSourceBranch);
      // A wake that arrives before the merge holds it unsent; take it and ask again.
      for (let n = 0; n < 3; n++) {
        await settle(task);
        const writes = guard.writeCount;
        await act(task, mergeAction(task, "main"));
        if (
          last(task, "pr.merge")?.observation?.reason !==
            "delivery-authority-stale-or-held" ||
          guard.writeCount !== writes
        )
          break;
      }
      const state = () => last(task, "pr.merge")?.state;
      for (
        let n = 0;
        state() === "uncertain" &&
        guard.denied.length === 0 &&
        n < (options.maxPolls ?? 60);
        n++
      ) {
        await wait();
        await refresh(task);
      }
      if (state() !== "confirmed-success" && guard.mergeMayBePending())
        pendingMerge = {
          iid,
          branch: String(bound(task)?.observation.headRef),
        };
      assert.equal(
        state(),
        "confirmed-success",
        `merge of !${iid}: ${last(task, "pr.merge")?.observation?.reason}`,
      );
      return guard.mergeBodies.find((m) => m.iid === iid)?.body;
    };

    // 1. Three pushes and merge requests: A on main, B on A's branch, C on B's. B's create naming main
    //    is refused before any request.
    await push(a, "a");
    const iidA = await register(a, "a", "main");
    const branchA = f.branchOf(a)!.branch;
    const headB = await push(b, "b");
    assert.equal(await sentDuring(() => create(b, "b", "main")), 0);
    assert.equal(
      last(b, "pr.create")?.observation?.reason,
      "stacked-pr-base-must-match-blocker-branch",
    );
    pass("dependent create naming main refused with zero requests");
    const iidB = await register(b, "b", branchA);
    const branchB = f.branchOf(b)!.branch;
    await push(c, "c");
    const iidC = await register(c, "c", branchB);
    pass(
      "three pushes; A on main, B on A's branch, C on B's",
      `!${iidA} !${iidB} !${iidC}`,
    );

    // 2. B cannot merge before A.
    assert.equal(await sentDuring(() => act(b, mergeAction(b, branchA))), 0);
    assert.equal(
      last(b, "pr.merge")?.observation?.reason,
      "stacked-lower-pr-unmerged",
    );
    pass("B's merge before A refused with zero requests");

    // 3. A merges and asks GitLab to remove its branch.
    const bodyA = await merge(a, iidA, true);
    assert.deepEqual(Object.keys(bodyA ?? {}).sort(), [
      "auto_merge",
      "sha",
      "should_remove_source_branch",
      "squash",
    ]);
    assert.equal(bodyA?.should_remove_source_branch, true);
    assert.equal(bodyA?.squash, false);
    assert.equal(bodyA?.auto_merge, false);
    pass("A merged with source-branch removal", JSON.stringify(bodyA));

    // 4. GitLab removes A's branch and retargets B to main; cab accepts the retarget, adopting nothing.
    await pollUntil("A's branch removed and B retargeted", async () => {
      await refresh(b);
      const branch = await api(
        `${base}/repository/branches/${encodeURIComponent(branchA)}`,
      );
      const mr = shapes.mergeRequest.parse(
        (await api(`${base}/merge_requests/${iidB}`)).json,
      );
      return (
        branch.status === 404 &&
        mr.target_branch === "main" &&
        bound(b)?.acceptedBaseRef === "main"
      );
    });
    assert.equal(bound(b)?.acceptedRetarget?.fromRef, branchA);
    assert.equal(f.branchOf(b)?.lastPushedSha, headB);
    assert.equal(f.branchOf(b)?.outsideHeadSha, null);
    assert.equal(bound(b)?.rebaseProofs, undefined);
    pass(
      "A's branch removed, B retargeted to main and accepted; B's head unchanged",
    );

    // 5. Unstack C: one target-branch edit to main, the edge retired and one restack queued.
    const read = await new OperatorApi(f.service, [f.root]).readUnstack(c);
    const preview = read.data.preview;
    assert.ok(preview, `Unstack preview: ${read.data.unavailable}`);
    assert.equal(preview.codeHost, "gitlab");
    assert.deepEqual(
      preview.members.map((m) => m.number),
      [iidB, iidC],
    );
    guard.allowRetarget(iidC);
    const key = randomUUID();
    let unstacked = await f.service.unstackTask({
      key,
      taskId: c,
      expectedVersion: preview.expectedVersion,
      materialHash: preview.materialHash,
    });
    for (
      let n = 0;
      unstacked.phase !== "confirmed" && unstacked.phase !== "failed" && n < 5;
      n++
    ) {
      await wait();
      unstacked = await f.service.reconcileTaskUnstack(key);
    }
    assert.equal(unstacked.phase, "confirmed", `Unstack ${unstacked.reason}`);
    assert.equal(
      guard.log.filter((e) => e.route === "PUT retarget merge_request").length,
      1,
    );
    assert.equal(f.service.domain().activeStackedDependency(c), null);
    assert.equal(
      f.readDb(
        (db) =>
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM coordination_external_delivery_notices WHERE taskId=? AND identity=?",
            )
            .get(c, `unstack-restack:${key}`)?.n,
      ),
      1,
    );
    pass(
      "Unstack of C: one target_branch edit, edge retired, one restack queued",
    );

    // 6. B merges plainly: its dependent was Unstacked.
    const bodyB = await merge(b, iidB, false);
    assert.deepEqual(Object.keys(bodyB ?? {}).sort(), [
      "auto_merge",
      "sha",
      "squash",
    ]);
    pass("B merged without removal", JSON.stringify(bodyB));

    // 7. The merges ran a pipeline on main: wait for the one at main's head.
    let mainStatus = "unproved";
    await pollUntil("main pipeline", async () => {
      const head = shapes.branch.parse(
        (await api(`${base}/repository/branches/main`)).json,
      ).commit.id;
      const [latest] = shapes.pipelines.parse(
        (await api(`${base}/pipelines?ref=main&per_page=1`)).json,
      );
      mainStatus = latest?.sha === head ? latest.status : "unproved";
      return ![
        "unproved",
        "created",
        "waiting_for_resource",
        "preparing",
        "pending",
        "running",
      ].includes(mainStatus);
    });
    evidence.mainPipelineAfterMerge = mainStatus;
    assert.equal(mainStatus, "success", "main pipeline after the merges");
    pass("main pipeline after the merges succeeded");
    assert.deepEqual(guard.denied, [], "the guard refused a request");
    evidence.qualification = "passed";
  } catch (error) {
    evidence.failure = clean(error instanceof Error ? error.message : error);
    if (guard.denied.length)
      evidence.failure += ` [guard refused: ${[...new Set(guard.denied)].join(", ")}]`;
  } finally {
    // Cleanup acts only on what the run recorded, and counts toward pass or fail.
    Object.assign(evidence, await cleanUp(api, guard, pendingMerge, clean));
    for (const fn of after.reverse())
      await Promise.resolve(fn()).catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
  evidence.mergeBodies = guard.mergeBodies;
  evidence.writes = { count: guard.writeCount, merges: guard.mergeCount };
  evidence.requests = guard.log;
  evidence.requestCounts = guard.counts;
  evidence.rateLimited = guard.rateLimited.map((r) => ({
    ...r,
    headers: Object.fromEntries(
      Object.entries(r.headers).map(([name, value]) => [name, clean(value)]),
    ),
    body: clean(r.body).slice(0, 200),
  }));
  return evidence;
}
