import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createFakeGlab } from "../fixtures/fake-glab.js";
import { scriptedGitLabRemote } from "../fixtures/gitlab-remote.js";
import { git } from "../fixtures/publication.js";
import {
  GitLabGuard,
  GuardDenied,
  cleanupWrites,
  liveInvocation,
  maxWrites,
  qualificationProject,
} from "./gitlab-qualification/gitlab-guard.js";
import { runGitLabStackQualification } from "./gitlab-qualification/gitlab-stack-journey.js";

const glabToken = "gloas-synthetic-glab-stack-token";
const { id, path: projectPath } = qualificationProject;

/** A scripted gitlab.com project, whose pipelines pass between polls, and the checkout the run clones. */
function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cab-gitlab-stack-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  git(source, "commit", "-q", "--allow-empty", "-m", "base");
  const remote = scriptedGitLabRemote({ repositoryId: id });
  remote.state.project = { id: Number(id), path_with_namespace: projectPath };
  remote.state.mainHead = git(source, "rev-parse", "HEAD");
  const glab = createFakeGlab();
  glab.setToken(glabToken);
  t.after(() => glab.close());
  const guard = new GitLabGuard(maxWrites, 0, cleanupWrites, "stack");
  const run = () =>
    runGitLabStackQualification({
      guard,
      fetcher: remote.fetcher,
      source,
      credentialRef: "glab:gitlab.com",
      glabExecutable: glab.executable,
      token: async () => glabToken,
      push: async (request) => {
        remote.state.heads.set(request.branch, request.commitSha);
        for (const mr of remote.state.mergeRequests)
          if (mr.source_branch === request.branch) mr.sha = request.commitSha;
        return "pushed";
      },
      adopt: async () => "adopted",
      pause: async () => {
        for (const mr of remote.state.mergeRequests)
          if (mr.state === "opened")
            mr.head_pipeline = {
              id: mr.iid + 50,
              sha: mr.sha,
              status: "success",
              started_at: "2026-01-01T00:00:00Z",
              finished_at: "2026-01-01T00:04:00Z",
            };
      },
    });
  return { remote, guard, run };
}

test("the stack journey passes on a scripted gitlab.com within its write cap and cleans up", async (t) => {
  const w = world(t);
  const evidence = await w.run();
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.qualification, "passed");
  assert.equal(evidence.cleanup, "verified");
  assert.deepEqual(w.guard.denied, []);
  assert.ok(w.guard.writeCount <= maxWrites, String(w.guard.writeCount));
  assert.equal(w.guard.mergeCount, 2);
  assert.deepEqual(
    w.remote.merges.map((m) => Object.keys(m.body).sort()),
    [
      ["auto_merge", "sha", "should_remove_source_branch", "squash"],
      ["auto_merge", "sha", "squash"],
    ],
  );
  assert.deepEqual(
    evidence.requests?.map((r) => r.route),
    [
      "git push",
      "POST merge_requests",
      "git push",
      "POST merge_requests",
      "git push",
      "POST merge_requests",
      "PUT merge",
      "PUT retarget merge_request",
      "PUT merge",
      "PUT close merge_request",
      "DELETE branch",
      "DELETE branch",
    ],
  );
  assert.deepEqual(
    w.remote.state.mergeRequests.map((m) => m.state),
    ["merged", "merged", "closed"],
  );
  assert.equal(
    [...w.remote.state.heads.keys()].some((b) => b.startsWith("cab/")),
    false,
    "every run branch was deleted",
  );
  assert.equal(JSON.stringify(evidence).includes(glabToken), false);
});

test("the stack guard allows one removal merge of the bottom layer, a plain middle merge and one top retarget", async () => {
  const guard = new GitLabGuard(maxWrites, 0, 0, "stack");
  let created = 0;
  const fetcher = guard.fetcher((async () => {
    created++;
    return Response.json({ id: 100 + created, iid: created }, { status: 201 });
  }) as typeof fetch);
  const project = `/api/v4/projects/${id}`;
  const call = (method: string, path: string, body?: unknown) =>
    fetcher(`https://gitlab.com${project}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const denied = (promise: Promise<unknown>) =>
    assert.rejects(promise, (error) => error instanceof GuardDenied);
  const push = guard.guardPush(async () => "pushed");
  for (const branch of ["cab/a", "cab/b", "cab/c"])
    await push({ host: "gitlab.com", nameWithOwner: projectPath, branch });
  await denied(
    push({ host: "gitlab.com", nameWithOwner: projectPath, branch: "cab/d" }),
  );
  await call("POST", "/merge_requests", {
    source_branch: "cab/a",
    target_branch: "main",
  });
  await call("POST", "/merge_requests", {
    source_branch: "cab/b",
    target_branch: "cab/a",
  });
  await denied(
    call("POST", "/merge_requests", {
      source_branch: "cab/c",
      target_branch: "elsewhere",
    }),
  );
  await call("POST", "/merge_requests", {
    source_branch: "cab/c",
    target_branch: "cab/b",
  });
  const body = { sha: "a".repeat(40), squash: false, auto_merge: false };
  const removal = { ...body, should_remove_source_branch: true };
  guard.allowMerge(1, true);
  guard.allowMerge(2);
  // The removal key only on the bottom layer, and each merge once.
  await denied(call("PUT", "/merge_requests/2/merge", removal));
  await call("PUT", "/merge_requests/1/merge", removal);
  await denied(call("PUT", "/merge_requests/1/merge", removal));
  await call("PUT", "/merge_requests/2/merge", body);
  // A train or another merge request is never merged.
  await denied(call("POST", "/merge_trains/merge_requests/3", body));
  await denied(call("PUT", "/merge_requests/3/merge", body));
  // Only the allowed merge request is retargeted, only to main, and once.
  guard.allowRetarget(3);
  await denied(call("PUT", "/merge_requests/2", { target_branch: "main" }));
  await denied(call("PUT", "/merge_requests/3", { target_branch: "cab/a" }));
  await denied(
    call("PUT", "/merge_requests/3", { target_branch: "main", title: "x" }),
  );
  await call("PUT", "/merge_requests/3", { target_branch: "main" });
  await denied(call("PUT", "/merge_requests/3", { target_branch: "main" }));
  // Nothing else the delivery journey may write.
  await denied(call("POST", "/merge_requests/3/discussions", { body: "x" }));
  await denied(call("PUT", "/merge_requests/3", { title: "x" }));
  assert.equal(guard.mergeCount, 2);
  assert.deepEqual(
    guard.mergeBodies.map((m) => m.iid),
    [1, 2],
  );
});

test("the live stack invocation needs --live and an absolute result path, and no glab token variable", () => {
  assert.deepEqual(liveInvocation(["--live"], {}, false), {
    resultPath: undefined,
  });
  for (const [args, extra] of [
    [[], {}],
    [["--live", "--result", "relative.json"], {}],
    [["--live"], { GITLAB_TOKEN: "x" }],
    [["--live"], { GITLAB_ACCESS_TOKEN: "x" }],
    [["--live"], { OAUTH_TOKEN: "x" }],
  ] as const)
    assert.throws(
      () => liveInvocation(args, extra, false),
      /Refusing execution/,
      JSON.stringify(args),
    );
  const result = spawnSync(
    process.execPath,
    ["test/delivery/gitlab-qualification/live-gitlab-stack.mjs"],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing execution/);
});
