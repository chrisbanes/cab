import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createFakeGlab } from "../fixtures/fake-glab.js";
import { git } from "../fixtures/publication.js";
import {
  gitLabMergeRequest,
  scriptedGitLabRemote,
} from "../fixtures/gitlab-remote.js";
import { cleanupGitLabRun } from "./gitlab-qualification/gitlab-cleanup.js";
import {
  cleanupInvocation,
  GitLabGuard,
  GuardDenied,
  liveInvocation,
  maxWrites,
  qualificationProject,
} from "./gitlab-qualification/gitlab-guard.js";
import { runGitLabQualification } from "./gitlab-qualification/gitlab-journey.js";

const envToken = "glpat-synthetic-env-qualification-token";
const glabToken = "gloas-synthetic-glab-qualification-token";
const { id, path: projectPath } = qualificationProject;

/** A scripted gitlab.com project and the checkout the run clones. */
function world(t: TestContext, options: { staleClone?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cab-gitlab-live-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  git(source, "commit", "-q", "--allow-empty", "-m", "base");
  const remote = scriptedGitLabRemote({ repositoryId: id });
  remote.state.project = { id: Number(id), path_with_namespace: projectPath };
  remote.state.mainHead = options.staleClone
    ? "9".repeat(40)
    : git(source, "rev-parse", "HEAD");
  remote.state.tokenKinds.set(envToken, "pat");
  remote.state.tokenKinds.set(glabToken, "oauth");
  // The delivery credential is a glab login, as in production; its token is the fake's.
  const glab = createFakeGlab();
  glab.setToken(glabToken);
  t.after(() => glab.close());
  const pushes: string[] = [];
  /** Moves each open merge request's pipeline on, as gitlab.com would between polls: A fails, B passes. */
  const advance = async () => {
    for (const mr of remote.state.mergeRequests) {
      if (mr.state !== "opened") continue;
      const status = mr.head_pipeline?.status;
      const next = !status
        ? "running"
        : status === "running"
          ? / a$/.test(mr.title)
            ? "failed"
            : "success"
          : status;
      mr.head_pipeline = {
        id: Number(mr.iid) + 50,
        sha: mr.sha,
        status: next,
        started_at: "2026-01-01T00:00:00Z",
        finished_at: next === "running" ? null : "2026-01-01T00:04:00Z",
      };
      mr.detailed_merge_status =
        next === "running"
          ? "ci_still_running"
          : next === "success"
            ? "mergeable"
            : "ci_must_pass";
    }
  };
  const guard = new GitLabGuard();
  const run = (
    extra: Partial<Parameters<typeof runGitLabQualification>[0]> = {},
  ) =>
    runGitLabQualification({
      guard,
      fetcher: remote.fetcher,
      source,
      credentialRef: "glab:gitlab.com",
      glabExecutable: glab.executable,
      tokens: { env: () => envToken, glab: async () => glabToken },
      push: async (request) => {
        pushes.push(request.branch);
        remote.state.heads.set(request.branch, request.commitSha);
        return "pushed";
      },
      adopt: async () => "adopted",
      pause: advance,
      ...extra,
    });
  return { remote, guard, run, pushes, glab };
}

const written = (w: ReturnType<typeof world>) =>
  w.remote.requests.filter((r) => r.init.method !== "GET");

test("both journeys pass on a scripted gitlab.com, within the write cap, and clean up what they created", async (t) => {
  const w = world(t);
  const evidence = await w.run();
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.qualification, "passed");
  assert.equal(evidence.cleanup, "verified");
  assert.ok(w.guard.writeCount <= maxWrites);
  assert.equal(w.guard.mergeCount, 1);
  assert.ok(
    w.glab.commands().length > 0,
    "the glab login supplied the delivery credential",
  );
  // Exactly the writes the plan lists: A's six, B's four, and the three cleanup writes.
  assert.deepEqual(
    evidence.requests?.map((r) => r.route),
    [
      "git push",
      "POST merge_requests",
      "POST graphql ready",
      "POST discussion",
      "POST reply",
      "PUT resolve",
      "git push",
      "POST merge_requests",
      "POST commit",
      "PUT merge",
      "PUT merge_request",
      "DELETE branch",
      "DELETE branch",
    ],
  );
  assert.deepEqual(w.guard.denied, []);
  assert.equal(
    evidence.steps.a.every((s) => s.result === "passed"),
    true,
  );
  assert.equal(
    evidence.steps.b.every((s) => s.result === "passed"),
    true,
  );
  const bearer = { user: "passed", projects: "passed", delivery: "passed" };
  assert.deepEqual(evidence.probe, {
    env: { kind: "personal-access-token", bearer },
    glab: { kind: "oauth", bearer },
    sameAccount: true,
  });
  // The merge never asked for auto-merge, and every merge request ended closed or merged.
  assert.deepEqual(
    w.remote.merges.map((m) => m.body.auto_merge),
    [false],
  );
  assert.deepEqual(w.remote.state.mergeRequests.map((m) => m.state).sort(), [
    "closed",
    "merged",
  ]);
  assert.equal(w.remote.state.heads.size, 0, "every branch was deleted");
  for (const request of w.remote.requests)
    assert.equal(new URL(request.url).origin, "https://gitlab.com");
  const text = JSON.stringify(evidence);
  for (const secret of [envToken, glabToken])
    assert.equal(text.includes(secret), false);
});

test("a merge whose response is lost is read again until it settles, and is never sent twice", async (t) => {
  const w = world(t);
  w.remote.state.loseMergeResponse = true;
  const evidence = await w.run();
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.qualification, "passed");
  assert.equal(w.remote.merges.length, 1);
});

test("a failure part way still closes and deletes what the run recorded", async (t) => {
  const w = world(t);
  const evidence = await w.run({ maxPolls: 1 });
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /Timed out: pipeline failure/);
  assert.equal(evidence.cleanup, "verified");
  assert.deepEqual(
    w.remote.state.mergeRequests.map((m) => m.state),
    ["closed"],
  );
  assert.equal(w.remote.state.heads.size, 0);
});

test("a merge that may still be pending is left open, not closed", async (t) => {
  const w = world(t);
  // The merge request is mergeable, but the instance drops the merge write before it takes effect.
  w.remote.state.intercept = (method, path) => {
    if (method === "PUT" && path.endsWith("/merge"))
      throw new TypeError("fetch failed");
    return undefined;
  };
  const evidence = await w.run();
  assert.equal(evidence.qualification, "failed");
  assert.ok(evidence.cleanupReads.some((c) => c.result === "pending-merge"));
  assert.equal(
    w.remote.state.mergeRequests.filter((m) => m.state === "opened").length,
    1,
  );
  // The branch under the pending merge is left with it; the other journey's branch is deleted.
  assert.equal(w.remote.state.heads.size, 1);
  assert.equal(w.guard.mergeCount, 1);
});

test("a stale clone stops the run before any write", async (t) => {
  const w = world(t, { staleClone: true });
  const evidence = await w.run();
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /clone-main-stale/);
  assert.equal(w.guard.writeCount, 0);
  assert.deepEqual(written(w), []);
  assert.deepEqual(w.pushes, []);
});

test("the guard allows only gitlab.com, project 88319115, recorded resources and the write cap", async () => {
  const response = () =>
    Promise.resolve(Response.json({ id: 1, iid: 1 }, { status: 201 }));
  const guard = new GitLabGuard(3);
  const seen: string[] = [];
  const next = (async (url: string) => {
    seen.push(String(url));
    return response();
  }) as typeof fetch;
  const fetcher = guard.fetcher(next);
  const call = (
    method: string,
    path: string,
    body?: unknown,
    origin = "https://gitlab.com",
  ) =>
    fetcher(`${origin}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const project = `/api/v4/projects/${id}`;
  const denied = (promise: Promise<unknown>) =>
    assert.rejects(promise, (error) => error instanceof GuardDenied);
  await denied(call("GET", `${project}`, undefined, "https://evil.example"));
  await denied(call("GET", "/api/v4/projects/1/repository/files"));
  await denied(call("GET", "/api/v4/groups"));
  await denied(fetcher(new Request(`https://gitlab.com${project}`)));
  await denied(call("GET", `${project}?x=1`, undefined, "http://gitlab.com"));
  await denied(call("POST", "/api/v4/projects/1/merge_requests", {}));
  // Nothing may be written before the run has recorded a branch.
  await denied(
    call("POST", `${project}/merge_requests`, {
      source_branch: "x",
      target_branch: "main",
    }),
  );
  await denied(
    call("PUT", `${project}/merge_requests/9`, { state_event: "close" }),
  );
  await denied(call("DELETE", `${project}/repository/branches/main`));
  await denied(
    call("POST", "/api/graphql", { query: "mutation { x }", variables: {} }),
  );
  assert.deepEqual(seen, []);
  await guard.guardPush(async () => "pushed")({
    host: "gitlab.com",
    nameWithOwner: projectPath,
    branch: "cab/x",
  });
  await call("POST", `${project}/merge_requests`, {
    source_branch: "cab/x",
    target_branch: "main",
  });
  assert.equal(guard.requests.size, 1);
  // Auto-merge in any form, an unrecorded merge request, a merge nobody allowed and a second merge are refused.
  await denied(
    call("PUT", `${project}/merge_requests/1`, {
      state_event: "close",
      merge_when_pipeline_succeeds: true,
    }),
  );
  await denied(
    call("PUT", `${project}/merge_requests/2`, { state_event: "close" }),
  );
  const mergeBody = { sha: "a".repeat(40), squash: true, auto_merge: false };
  await denied(call("PUT", `${project}/merge_requests/1/merge`, mergeBody));
  guard.allowMerge(1);
  await denied(
    call("PUT", `${project}/merge_requests/1/merge`, {
      ...mergeBody,
      auto_merge: true,
    }),
  );
  await call("PUT", `${project}/merge_requests/1/merge`, mergeBody);
  assert.equal(guard.mergeCount, 1);
  await denied(call("PUT", `${project}/merge_requests/1/merge`, mergeBody));
  // The cap is three writes: the push, the creation and the merge.
  assert.equal(guard.writeCount, 3);
  await denied(
    call("PUT", `${project}/merge_requests/1`, { state_event: "close" }),
  );
  assert.equal(seen.length, 2);
  // Nothing but a task branch is pushed: not the default branch, and every refusal is recorded.
  await denied(
    guard.guardPush(async () => "pushed")({
      host: "gitlab.com",
      nameWithOwner: projectPath,
      branch: "main",
    }),
  );
  // A push to another project is refused before it spends anything.
  await denied(
    guard.guardPush(async () => "pushed")({
      host: "gitlab.com",
      nameWithOwner: "someone/else",
      branch: "cab/y",
    }),
  );
  assert.ok(guard.denied.includes("write-cap"));
  assert.ok(guard.denied.includes("git-branch"));
});

test("the live invocation needs --live, an absolute result path, the fixture credential and no glab token variable", () => {
  const env = { CAB_GITLAB_TOKEN: "set" };
  assert.deepEqual(liveInvocation(["--live"], env), { resultPath: undefined });
  assert.deepEqual(liveInvocation(["--live", "--result", "/tmp/r.json"], env), {
    resultPath: "/tmp/r.json",
  });
  assert.deepEqual(liveInvocation(["--result", "/tmp/r.json", "--live"], env), {
    resultPath: "/tmp/r.json",
  });
  for (const [args, extra] of [
    [[], {}],
    [["--result", "/tmp/r.json"], {}],
    [["--live", "extra"], {}],
    [["--live", "--result"], {}],
    [["--live", "--result", "relative.json"], {}],
    [["--live"], { CAB_GITLAB_TOKEN: "" }],
    [["--live"], { GITLAB_TOKEN: "x" }],
    [["--live"], { GITLAB_ACCESS_TOKEN: "x" }],
    [["--live"], { OAUTH_TOKEN: "x" }],
  ] as const)
    assert.throws(
      () => liveInvocation(args, { ...env, ...extra }),
      /Refusing execution/,
      JSON.stringify(args),
    );
});

test("the live script refuses to start without the fixture credential, before any request", () => {
  const result = spawnSync(
    process.execPath,
    ["test/delivery/gitlab-qualification/live-gitlab-delivery.mjs", "--live"],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing execution/);
});

const limited = () =>
  new Response("Retry later\n", {
    status: 429,
    headers: { "retry-after": "30", "ratelimit-limit": "100" },
  });

test("a 429 mid-run is waited out by the service and the harness, and the run records what GitLab sent", async (t) => {
  const w = world(t);
  const waits: number[] = [];
  let once = 2;
  w.remote.state.intercept = (method, path) =>
    method === "GET" && /\/merge_requests\/\d+$/.test(path) && once-- > 0
      ? limited()
      : undefined;
  const evidence = await w.run({
    rateLimit: { sleep: async (ms) => void waits.push(ms) },
  });
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.qualification, "passed");
  assert.deepEqual(waits, [30_000, 30_000]);
  assert.deepEqual(
    evidence.rateLimited?.map((r) => [r.headers, r.retryAfter, r.body]),
    [
      [["ratelimit-limit", "retry-after"], "30", "Retry later\n"],
      [["ratelimit-limit", "retry-after"], "30", "Retry later\n"],
    ],
  );
  assert.ok((evidence.requestCounts?.["GET /api/v4/projects/:n"] ?? 0) > 0);
});

test("cleanup that was blocked can be run again against the run, or one merge request, without a journey", async (t) => {
  for (const by of ["run", "mr"] as const) {
    const w = world(t);
    const noWait = { sleep: async () => {}, maxRetries: 0 };
    // The writes of cleanup are rate limited and the instance sends plain text, as it did in the live run.
    w.remote.state.intercept = (method, path) =>
      (method === "PUT" && /\/merge_requests\/\d+$/.test(path)) ||
      method === "DELETE"
        ? limited()
        : undefined;
    const first = await w.run({ rateLimit: noWait });
    assert.equal(first.qualification, "passed");
    assert.equal(first.cleanup, "failed");
    const left = w.remote.state.mergeRequests.filter(
      (m) => m.state === "opened",
    );
    assert.equal(left.length, 1);
    assert.equal(w.remote.state.heads.size, 2);
    w.remote.state.intercept = undefined;
    const again = await cleanupGitLabRun({
      guard: new GitLabGuard(),
      fetcher: w.remote.fetcher,
      token: () => envToken,
      ...(by === "run" ? { run: first.runId } : { mr: Number(left[0]?.iid) }),
    });
    assert.equal(again.cleanup, "verified");
    assert.equal(
      w.remote.state.mergeRequests.filter((m) => m.state === "opened").length,
      0,
    );
    // The branch of the merged request goes with a run id; one merge request leaves the other's branch.
    assert.equal(w.remote.state.heads.size, by === "run" ? 0 : 1);
  }
});

test("a cleanup touches only a run's own merge requests", async (t) => {
  const w = world(t);
  const other = {
    id: 5,
    iid: 5,
    source_branch: "feature/unrelated",
    title: "Qualification 20260101000000-abcd a",
  };
  w.remote.state.mergeRequests.push(
    gitLabMergeRequest({
      ...other,
      source_project_id: Number(id),
      target_project_id: Number(id),
    }),
    gitLabMergeRequest({
      id: 6,
      iid: 6,
      source_branch: "cab/real",
      title: "Someone's change",
      source_project_id: Number(id),
      target_project_id: Number(id),
    }),
  );
  w.remote.state.heads.set("feature/unrelated", "a".repeat(40));
  w.remote.state.heads.set("cab/real", "b".repeat(40));
  for (const mr of [{ mr: 5 }, { mr: 6 }, { run: "20260101000000-abcd" }]) {
    const out = await cleanupGitLabRun({
      guard: new GitLabGuard(),
      fetcher: w.remote.fetcher,
      token: () => envToken,
      ...mr,
    });
    assert.equal(out.found, 0);
  }
  assert.deepEqual(
    w.remote.state.mergeRequests.map((m) => m.state),
    ["opened", "opened"],
  );
  assert.equal(w.remote.state.heads.size, 2);
  assert.deepEqual(written(w), []);
});

test("the cleanup invocation needs --live, exactly one of a run id or an IID, and the fixture credential", () => {
  const env = { CAB_GITLAB_TOKEN: "set" };
  const run = "20261031090415-5b1c";
  assert.deepEqual(cleanupInvocation(["--live", "--run", run], env), { run });
  assert.deepEqual(
    cleanupInvocation(["--live", "--mr", "2", "--result", "/tmp/r.json"], env),
    { mr: 2, resultPath: "/tmp/r.json" },
  );
  for (const args of [
    [],
    ["--run", run],
    ["--live"],
    ["--live", "--run", run, "--mr", "2"],
    ["--live", "--run", "latest"],
    ["--live", "--mr", "0"],
    ["--live", "--mr", "2", "extra"],
    ["--live", "--mr", "2", "--result", "relative.json"],
  ])
    assert.throws(() => cleanupInvocation(args, env), /Refusing execution/);
  assert.throws(
    () => cleanupInvocation(["--live", "--mr", "2"], {}),
    /Refusing execution/,
  );
});
