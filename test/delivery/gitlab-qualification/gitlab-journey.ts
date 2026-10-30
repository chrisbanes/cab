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
import type { DeliveryPolicy } from "../../../src/core/delivery.js";
import {
  type AdoptFunction,
  adoptOutsideHead,
} from "../../../src/standalone/git-fetch.js";
import { pushTaskCommit } from "../../../src/standalone/git-push.js";
import type { PushFunction } from "../../../src/standalone/github-delivery.js";
import { GitLabHttpDeliveryProvider } from "../../../src/standalone/gitlab-delivery.js";
import { GitLabDiscoveryReader } from "../../../src/standalone/gitlab-discovery.js";
import { publicationWorld } from "../../fixtures/delivery-integration.js";
import { git } from "../../fixtures/publication.js";
import { type GitLabGuard, qualificationProject } from "./gitlab-guard.js";

const { host, id: repositoryId, path: projectPath } = qualificationProject;
const base = `/api/v4/projects/${repositoryId}`;

export interface GitLabQualificationOptions {
  guard: GitLabGuard;
  /** The raw HTTP transport the guard wraps; production passes `fetch`, tests a scripted host. */
  fetcher: typeof fetch;
  /** The checkout the run clones; its `main` must equal the project's. */
  source: string;
  /** The delivery credential: `glab:gitlab.com` in production. */
  credentialRef: string;
  /** The two credentials the probe compares, read in process and never stored or printed. */
  tokens: {
    env: () => string | undefined;
    glab: () => Promise<string | undefined>;
  };
  push?: PushFunction;
  adopt?: AdoptFunction;
  /** Waits between polls of the pipeline; tests advance their scripted host here. */
  pause?: () => Promise<void>;
  /** The most polls one wait makes. */
  maxPolls?: number;
}

type World = Awaited<ReturnType<typeof publicationWorld>>;
type Step = { step: string; result: "passed" | "failed"; detail?: string };
type CredentialProbe = {
  kind: "oauth" | "personal-access-token" | "unproved";
  bearer: Record<"user" | "projects" | "delivery", "passed">;
};

/** What a run reports: every field is a status, a count or an identifier, never a credential value. */
export interface GitLabEvidence {
  runId: string;
  project: { host: string; id: string; path: string };
  qualification: "passed" | "failed";
  cleanup: "not-run" | "verified" | "failed";
  failure?: string;
  gitlab?: {
    version: string;
    squashOption: string | null;
    mergeTrainsEnabled: boolean;
  };
  account?: { id: number };
  probe?: {
    env: CredentialProbe;
    glab: CredentialProbe;
    sameAccount: true;
  };
  mainPipelineAfterMerge?: string;
  cleanupReads: Array<{ resource: string; result: string }>;
  steps: Record<"probe" | "a" | "b", Step[]>;
  writes?: { count: number; merges: number };
  requests?: GitLabGuard["log"];
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** The few fields of each GitLab response the run reads; anything else is a failure, not a guess. */
const shapes = {
  version: z.object({ version: z.string() }),
  project: z.object({
    id: z.number().int(),
    path_with_namespace: z.string(),
    squash_option: z.string().nullish(),
    merge_trains_enabled: z.boolean().nullish(),
  }),
  branch: z.object({ commit: z.object({ id: sha }) }),
  user: z.object({ id: z.number().int() }),
  discussion: z.object({
    id: z.string().min(1),
    notes: z.array(z.object({ id: z.number().int() })).min(1),
  }),
  commit: z.object({ id: sha }),
  mergeRequest: z.object({ state: z.string() }),
  pipelines: z.array(z.object({ sha: z.string(), status: z.string() })),
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const wakes = (w: World) =>
  w.f.readDb(
    (db) =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_inbox_events WHERE eventType='pr-delivery'",
          )
          .get() as { n: number }
      ).n,
  );

/**
 * The bounded GitLab qualification: a credential probe, then two sequential journeys through the real
 * service, delivery coordinator and GitLab provider, with the fixture's scripted lead runtime (no model
 * turns). Journey A is reviewable-pr: push, draft merge request, ready, a failing pipeline, a discussion
 * reply and resolve, and the operator's handback settlement. Journey B is through-merge: push, merge
 * request, an outside commit adopted as the recovery, a refused merge, then the one merge. Cleanup closes
 * and deletes only what the guard recorded. Returns evidence that holds no credential value.
 */
export async function runGitLabQualification(
  options: GitLabQualificationOptions,
): Promise<GitLabEvidence> {
  const { guard } = options;
  const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
  const fetcher = guard.fetcher(options.fetcher);
  const steps: Record<"probe" | "a" | "b", Step[]> = {
    probe: [],
    a: [],
    b: [],
  };
  const evidence: GitLabEvidence = {
    runId,
    project: { host, id: repositoryId, path: projectPath },
    qualification: "failed",
    cleanup: "not-run",
    cleanupReads: [],
    steps,
  };
  // Read once, so nothing that is reported can carry either value.
  const credentials = {
    env: options.tokens.env(),
    glab: await options.tokens.glab(),
  };
  const clean = (value: unknown) =>
    [credentials.env, credentials.glab].reduce<string>(
      (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
      String(value),
    );
  const pass = (journey: "a" | "b", step: string, detail?: string) =>
    steps[journey].push({
      step,
      result: "passed",
      ...(detail === undefined ? {} : { detail }),
    });
  const api = async (
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ) => {
    const token = init.token ?? credentials.env ?? credentials.glab;
    assert.ok(token, "harness credential unavailable");
    const response = await fetcher(`https://${host}${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      json: (text ? JSON.parse(text) : null) as unknown,
    };
  };

  const temp = realpathSync(mkdtempSync(join(tmpdir(), "cab-gitlab-qual-")));
  const worlds: World[] = [];
  /** A merge request whose merge was sent but not proved: cleanup leaves it open. */
  let pendingMerge: { iid: number; branch: string } | null = null;
  try {
    // Reads only, before anything is written: the project, its settings and that the clone is current.
    const version = await api("/api/v4/version");
    const info = await api(base);
    assert.equal(info.status, 200);
    const project = shapes.project.parse(info.json);
    assert.equal(String(project.id), repositoryId);
    assert.equal(project.path_with_namespace, projectPath);
    const mainHead = await api(`${base}/repository/branches/main`);
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
    assert.equal(
      git(clone, "rev-parse", "main"),
      shapes.branch.parse(mainHead.json).commit.id,
      "clone-main-stale",
    );
    evidence.gitlab = {
      version: shapes.version.parse(version.json).version,
      squashOption: project.squash_option ?? null,
      mergeTrainsEnabled: project.merge_trains_enabled === true,
    };
    const user = await api("/api/v4/user");
    evidence.account = { id: shapes.user.parse(user.json).id };

    const link = (mode: "reviewable-pr" | "through-merge") =>
      publicationWorld(
        "allow",
        {
          host,
          repositoryId,
          projectPath,
          origin: `https://${host}/${projectPath}.git`,
          delivery: {
            fetcher,
            push: guard.guardPush(options.push ?? pushTaskCommit),
            adopt: guard.guardAdopt(options.adopt ?? adoptOutsideHead),
          },
        },
        { source: clone, deliveryMode: mode },
      );
    const configure = (w: World, grants: string[]) => {
      const domain = w.f.service.domain();
      domain.execute({
        type: "code-host-credential.configure",
        actor: "operator",
        key: randomUUID(),
        codeHost: "gitlab",
        host,
        credentialRef: options.credentialRef,
      } as never);
      w.f.grant(
        ...grants.map((action) => ({
          action,
          mode:
            action === "branch.adopt"
              ? ("approval" as const)
              : ("allow" as const),
        })),
      );
      const delivery = w.f.service.delivery();
      domain.execute({
        type: "delivery.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: w.f.projectId,
        expectedVersion: delivery.configuration(w.f.projectId).version,
        mode: delivery.configuration(w.f.projectId).mode,
        credentialRef: null,
        grants: delivery.configuration(w.f.projectId).grants,
        requiredChecks: [{ name: "pipeline" }],
      } as never);
    };
    const workspaceOf = async (w: World) => {
      const binding = await w.f.service.taskWorkspace(w.f.taskId);
      const path = binding?.repositories[0]?.workspacePath;
      assert.ok(path);
      return path;
    };
    const commitFiles = (workspace: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(workspace, name)), { recursive: true });
        writeFileSync(join(workspace, name), text);
      }
      git(workspace, "add", ".");
      git(workspace, "commit", "-q", "-m", `Qualification ${runId}`);
      return git(workspace, "rev-parse", "HEAD");
    };
    const branchOf = (w: World) =>
      w.f.service.delivery().taskBranch(w.f.taskId, repositoryId);
    const bound = (w: World) => w.f.service.delivery().delivery(w.f.taskId);
    const refresh = (w: World) =>
      w.f.service.coordinationView().refreshDelivery(w.f.taskId);
    const completion = (w: World) =>
      w.f.service
        .delivery()
        .completionBlockers(
          w.f.taskId,
          Number(w.f.service.domain().task(w.f.taskId).version),
        );
    const act = (
      w: World,
      action: Record<string, unknown>,
      index?: number,
      approval?: object,
    ) =>
      w.f.call(
        "cab_external_action",
        {
          operationId: randomUUID(),
          action,
          ...(approval ? { approval } : {}),
        },
        index,
      );
    /** Refreshes until `done`; returns the wakes the last refresh added. */
    const pollUntil = async (w: World, label: string, done: () => boolean) => {
      for (let n = 0; n < (options.maxPolls ?? 60); n++) {
        const before = wakes(w);
        await refresh(w);
        if (done()) return wakes(w) - before;
        await (options.pause ? options.pause() : sleep(10_000));
      }
      throw new Error(`Timed out: ${label}`);
    };
    const open = async (
      w: World,
      name: string,
      files: Record<string, string>,
      draft: boolean,
    ) => {
      const sha = commitFiles(await workspaceOf(w), files);
      const pushed = await w.push(sha);
      assert.equal(pushed.success, true, `${name} push: ${clean(pushed.text)}`);
      const headRef = String(branchOf(w)?.branch);
      const created = await act(w, {
        kind: "pr.create",
        target: {
          repositoryId,
          baseRef: "main",
          headRef,
          expectedHeadSha: sha,
        },
        title: `Qualification ${runId} ${name}`,
        body: `Bounded cab qualification run ${runId}. Safe to close.`,
        draft,
      });
      assert.equal(
        created.success,
        true,
        `${name} create: ${clean(created.text)}`,
      );
      const number = [...guard.requests.keys()].at(-1);
      assert.ok(number);
      const request = guard.requests.get(number);
      assert.ok(request);
      const target = {
        repositoryId,
        number,
        nodeId: String(request.id),
        baseRef: "main",
        headRef,
        expectedHeadSha: sha,
      };
      const registered = await w.f.call("cab_register_pr", {
        repositoryId,
        prNumber: number,
        expectedPrNodeId: String(request.id),
        expectedHeadSha: sha,
      });
      assert.equal(
        registered.success,
        true,
        `${name} register: ${clean(registered.text)}`,
      );
      return { sha, headRef, number, target, id: request.id };
    };

    // Journey A: reviewable-pr.
    const a = await link("reviewable-pr");
    worlds.push(a);
    configure(a, [
      "branch.push",
      "pr.create",
      "pr.ready",
      "pr.thread.reply",
      "pr.thread.resolve",
    ]);
    try {
      const mr = await open(
        a,
        "a",
        {
          FAIL_PIPELINE: "",
          [`qual/${runId}-a.md`]: `Qualification ${runId}\n`,
        },
        true,
      );
      pass("a", "push and draft merge request registered", `!${mr.number}`);

      // The probe: both credentials authenticate with Bearer on the account, project and delivery reads.
      try {
        evidence.probe = await probe(credentials, fetcher, mr);
        steps.probe.push({ step: "bearer reads", result: "passed" });
      } catch (error) {
        steps.probe.push({ step: "bearer reads", result: "failed" });
        throw error;
      }

      const ready = await act(a, { kind: "pr.ready", target: mr.target });
      assert.equal(ready.success, true, clean(ready.text));
      await refresh(a);
      assert.equal(bound(a)?.observation.draft, false);
      pass("a", "ready (GraphQL mergeRequestSetDraft)");

      // A failing pipeline wakes the lead once, and an unchanged refresh adds no wake.
      const failureWakes = await pollUntil(a, "pipeline failure", () =>
        Boolean(
          bound(a)?.observation.checks.some(
            (c) => c.name === "pipeline" && c.status === "failure",
          ),
        ),
      );
      assert.equal(failureWakes, 1, "the failing pipeline wakes the lead once");
      const unchanged = wakes(a);
      await refresh(a);
      assert.equal(wakes(a), unchanged, "an unchanged refresh adds no wake");
      pass("a", "pipeline failure observed; unchanged refresh adds no wake");

      const discussion = await api(
        `${base}/merge_requests/${mr.number}/discussions`,
        {
          method: "POST",
          body: { body: `Qualification ${runId}: please reply and resolve.` },
        },
      );
      assert.equal(discussion.status, 201);
      const created = shapes.discussion.parse(discussion.json);
      const threadId = created.id;
      const setupNote = String(created.notes[0]?.id);
      const beforeThread = wakes(a);
      await refresh(a);
      assert.ok(
        bound(a)?.observation.reviewThreads?.some((t) => t.nodeId === threadId),
      );
      assert.equal(wakes(a) - beforeThread, 1, "a new thread wakes once");
      const thread = {
        repositoryId,
        number: mr.number,
        nodeId: String(mr.id),
        threadNodeId: threadId,
      };
      const replied = await act(a, {
        kind: "pr.thread.reply",
        target: thread,
        body: `Reply for qualification ${runId}.`,
      });
      assert.equal(replied.success, true, clean(replied.text));
      const afterReply = guard.writeCount;
      const stale = await act(a, {
        kind: "pr.thread.resolve",
        target: thread,
        expectedLatestCommentNodeId: setupNote,
      });
      assert.equal(stale.success, false);
      assert.equal(
        guard.writeCount,
        afterReply,
        "a stale resolve makes no write",
      );
      const latest = bound(a)?.observation.reviewThreads?.find(
        (t) => t.nodeId === threadId,
      )?.latestCommentNodeId;
      assert.ok(latest && latest !== setupNote);
      const resolved = await act(a, {
        kind: "pr.thread.resolve",
        target: thread,
        expectedLatestCommentNodeId: latest,
      });
      assert.equal(resolved.success, true, clean(resolved.text));
      pass(
        "a",
        "discussion reply, stale resolve refused with no write, resolve",
      );

      await a.f.terminal(1);
      assert.ok(
        completion(a).includes("reviewable-pr-awaiting-current-settlement"),
      );
      const settlement = {
        ...a.f.settlement(),
        repositoryId,
        prNumber: mr.number,
        expectedPrNodeId: String(mr.id),
        expectedHeadSha: mr.sha,
      };
      await a.f.service.settleHandback(settlement);
      assert.ok(bound(a)?.settlement);
      pass("a", "handback waited for settlement and the operator settled it");
    } catch (error) {
      steps.a.push({
        step: "journey a",
        result: "failed",
        detail: clean(error instanceof Error ? error.message : error),
      });
      throw error;
    }

    // Journey B: through-merge.
    const b = await link("through-merge");
    worlds.push(b);
    configure(b, ["branch.push", "branch.adopt", "pr.create", "pr.merge"]);
    try {
      const mr = await open(
        b,
        "b",
        { [`qual/${runId}-b.md`]: `Qualification ${runId}\n` },
        false,
      );
      pass("b", "push and merge request registered", `!${mr.number}`);
      // An outside commit on the task branch, made as the operator's account.
      const outside = await api(`${base}/repository/commits`, {
        method: "POST",
        body: {
          branch: mr.headRef,
          commit_message: `Qualification ${runId} outside change`,
          actions: [
            {
              action: "create",
              file_path: `qual/${runId}-outside.md`,
              content: `Outside change ${runId}\n`,
            },
          ],
        },
      });
      assert.equal(outside.status, 201);
      const outsideSha = shapes.commit.parse(outside.json).id;
      await pollUntil(
        b,
        "outside head recorded",
        () => branchOf(b)?.outsideHeadSha === outsideSha,
      );
      pass("b", "outside head recorded");
      const material = {
        kind: "branch.adopt",
        target: { repositoryId },
        branch: mr.headRef,
        outsideHeadSha: outsideSha,
        lastPushedSha: mr.sha,
      };
      const approval = await b.approve(material, b.f.runtime.turns);
      const adopted = await act(b, material, b.f.runtime.turns, approval);
      assert.equal(adopted.success, true, clean(adopted.text));
      assert.equal(branchOf(b)?.lastPushedSha, outsideSha);
      pass("b", "outside head adopted (recovery)");

      // The lead takes the pending wake-ups, then a merge before the pipeline passes is refused.
      const drain = async () => {
        const turn = b.f.runtime.turns;
        await b.f.terminal(turn);
        await b.f.waitTurn(turn + 1);
      };
      const mergeAction = (method: "merge" | "squash") => ({
        kind: "pr.merge",
        target: { ...mr.target, expectedHeadSha: outsideSha },
        method,
        reviewedResultIds: [],
      });
      await drain();
      const writesBefore = guard.writeCount;
      const early = await act(b, mergeAction("squash"));
      assert.equal(early.success, false);
      assert.match(
        clean(early.text),
        /provider-preflight-held/,
        "the provider refused the merge, not an earlier hold",
      );
      assert.equal(
        guard.writeCount,
        writesBefore,
        "a refused merge makes no write",
      );
      await refresh(b);
      const blockers = bound(b)?.observation.mergeBlockers ?? [];
      assert.ok(blockers.length > 0, "the refusal names a blocker");
      pass("b", "merge refused before the pipeline passed", blockers.join(","));

      await pollUntil(
        b,
        "pipeline success",
        () => bound(b)?.observation.mergeBlockers.length === 0,
      );
      const allowed = bound(b)?.observation.allowedMethods ?? [];
      const method = allowed.includes("squash") ? "squash" : "merge";
      assert.ok(allowed.includes(method));
      await drain();
      guard.allowMerge(mr.number);
      const merged = await act(b, mergeAction(method));
      if (!merged.success && guard.mergeMayBePending())
        pendingMerge = { iid: mr.number, branch: mr.headRef };
      assert.equal(merged.success, true, clean(merged.text));
      await refresh(b);
      assert.equal(bound(b)?.observation.merged, true);
      assert.deepEqual(completion(b), []);
      pass("b", "merge settled as acceptance", method);
      // The merge ran a pipeline on main: wait for the one at main's head to finish.
      let mainStatus = "unproved";
      for (let n = 0; n < (options.maxPolls ?? 60); n++) {
        const head = shapes.branch.parse(
          (await api(`${base}/repository/branches/main`)).json,
        ).commit.id;
        const [latest] = shapes.pipelines.parse(
          (await api(`${base}/pipelines?ref=main&per_page=1`)).json,
        );
        mainStatus = latest?.sha === head ? latest.status : "unproved";
        if (
          ![
            "unproved",
            "created",
            "waiting_for_resource",
            "preparing",
            "pending",
            "running",
          ].includes(mainStatus)
        )
          break;
        await (options.pause ? options.pause() : sleep(10_000));
      }
      evidence.mainPipelineAfterMerge = mainStatus;
      assert.equal(mainStatus, "success", "main pipeline after the merge");
      pass("b", "main pipeline after the merge succeeded");
    } catch (error) {
      steps.b.push({
        step: "journey b",
        result: "failed",
        detail: clean(error instanceof Error ? error.message : error),
      });
      throw error;
    }
    // A refusal by the guard is a defect in the run, even when the product handled it.
    assert.deepEqual(guard.denied, [], "the guard refused a request");
    evidence.qualification = "passed";
  } catch (error) {
    evidence.failure = clean(
      String(error instanceof Error ? error.message : error),
    );
  } finally {
    // Cleanup acts only on what the run recorded, and counts toward pass or fail.
    const cleanup: Array<{ resource: string; result: string }> = [];
    // Each resource is cleaned on its own, so one failure leaves no other behind.
    const attempt = async (resource: string, work: () => Promise<string>) => {
      try {
        cleanup.push({ resource, result: await work() });
      } catch (error) {
        cleanup.push({
          resource,
          result: `failed: ${clean(error instanceof Error ? error.message : error)}`,
        });
      }
    };
    for (const [iid] of guard.requests)
      await attempt(`merge_request !${iid}`, async () => {
        const route = `${base}/merge_requests/${iid}`;
        const state = (): Promise<string> =>
          api(route).then((r) => shapes.mergeRequest.parse(r.json).state);
        const current = await state();
        if (current !== "opened") return current;
        if (iid === pendingMerge?.iid) return "pending-merge";
        await api(route, { method: "PUT", body: { state_event: "close" } });
        return state();
      });
    for (const branch of guard.branches)
      await attempt(
        `branch ${branch.replace(/^cab\/.*/, "cab/<task>")}`,
        async () => {
          // A branch under a merge that may still land is left with it.
          if (branch === pendingMerge?.branch) return "pending-merge";
          const route = `${base}/repository/branches/${encodeURIComponent(branch)}`;
          if ((await api(route)).status === 200)
            await api(route, { method: "DELETE" });
          return (await api(route)).status === 404 ? "deleted" : "present";
        },
      );
    evidence.cleanupReads = cleanup;
    evidence.cleanup = cleanup.every((c) =>
      ["closed", "merged", "deleted", "pending-merge"].includes(c.result),
    )
      ? "verified"
      : "failed";
    for (const w of worlds) await w.f.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
  evidence.writes = { count: guard.writeCount, merges: guard.mergeCount };
  evidence.requests = guard.log;
  return evidence;
}

/**
 * Both credentials authenticate with `Authorization: Bearer` on three product reads (the account, the
 * project list and a merge request), act as one account, and are classified without exposing a value.
 */
async function probe(
  credentials: { env: string | undefined; glab: string | undefined },
  fetcher: typeof fetch,
  mr: { number: number; id: number; sha: string },
): Promise<NonNullable<GitLabEvidence["probe"]>> {
  const policy = { requiredChecks: [] } as unknown as DeliveryPolicy;
  const result = {} as Record<"env" | "glab", CredentialProbe>;
  const accounts = new Set<string>();
  for (const name of ["env", "glab"] as const) {
    const token = credentials[name];
    // Both credentials must authenticate for the probe to pass.
    if (!token) throw new Error(`probe: ${name} credential unavailable`);
    const status = async (path: string) =>
      (
        await fetcher(`https://${host}${path}`, {
          method: "GET",
          redirect: "manual",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    const reads = {} as Record<"user" | "projects" | "delivery", "passed">;
    const reader = new GitLabDiscoveryReader(host, token, fetcher);
    const { username } = await reader.user();
    reads.user = "passed";
    const { projects } = await reader.projects();
    assert.ok(projects.some((p) => p.repositoryId === repositoryId));
    reads.projects = "passed";
    const provider = new GitLabHttpDeliveryProvider({
      host,
      link: (id) => (id === repositoryId ? { projectPath } : null),
      token: async () => token,
      fetcher,
    });
    await provider.inspectPr(
      {
        repositoryId,
        prNumber: mr.number,
        expectedPrNodeId: String(mr.id),
        expectedHeadSha: mr.sha,
      },
      policy,
    );
    reads.delivery = "passed";
    accounts.add(username);
    const oauth = (await status("/oauth/token/info")) === 200;
    const pat = (await status("/api/v4/personal_access_tokens/self")) === 200;
    result[name] = {
      kind: oauth ? "oauth" : pat ? "personal-access-token" : "unproved",
      bearer: reads,
    };
  }
  assert.equal(accounts.size, 1, "probe: the credentials act as one account");
  return { ...result, sameAccount: true };
}
