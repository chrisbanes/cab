import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fakeJiraSite, siteAccount } from "../fixtures/fake-jira-site.js";
import { scriptedGitLabRemote } from "../fixtures/gitlab-remote.js";
import { git } from "../fixtures/publication.js";
import {
  GitLabGuard,
  GuardDenied,
  qualificationProject,
} from "./gitlab-qualification/gitlab-guard.js";
import { cleanupJiraRun } from "./jira-qualification/jira-cleanup.js";
import {
  cleanupInvocation,
  JiraGuard,
  liveInvocation,
  maxJiraWrites,
  qualificationSite,
  runJql,
} from "./jira-qualification/jira-guard.js";
import { runJiraQualification } from "./jira-qualification/jira-journey.js";

const canary = {
  CAB_JIRA_SITE: `https://${qualificationSite.host}`,
  CAB_JIRA_EMAIL: "qualification@example.test",
  CAB_JIRA_API_TOKEN: "jira-token-canary-1321-live",
  CAB_GITLAB_TOKEN: "glpat-synthetic-canary-1321-live",
};
const { id, path: projectPath } = qualificationProject;

/** A scripted Jira site and gitlab.com project, and the checkout the run clones. */
function world(t: TestContext, options: { staleClone?: boolean } = {}) {
  for (const [name, value] of Object.entries(canary)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  const root = mkdtempSync(join(tmpdir(), "cab-jira-live-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  git(root, "init", "-q", "-b", "main", source);
  git(source, "commit", "-q", "--allow-empty", "-m", "base");
  const jira = fakeJiraSite();
  const remote = scriptedGitLabRemote({ repositoryId: id });
  remote.state.project = { id: Number(id), path_with_namespace: projectPath };
  remote.state.mainHead = options.staleClone
    ? "9".repeat(40)
    : git(source, "rev-parse", "HEAD");
  remote.state.tokenKinds.set(canary.CAB_GITLAB_TOKEN, "pat");
  const pushes: string[] = [];
  const jiraGuard = new JiraGuard();
  const gitlabGuard = new GitLabGuard(6, 0, 2);
  const run = (
    extra: Partial<Parameters<typeof runJiraQualification>[0]> = {},
  ) =>
    runJiraQualification({
      jira: jiraGuard,
      gitlab: gitlabGuard,
      jiraFetcher: jira.fetcher,
      gitlabFetcher: remote.fetcher,
      source,
      push: async (request) => {
        pushes.push(request.branch);
        remote.state.heads.set(request.branch, request.commitSha);
        return "pushed";
      },
      adopt: async () => "adopted",
      pause: async () => {},
      ...extra,
    });
  return { jira, remote, jiraGuard, gitlabGuard, run, pushes };
}

/** The writes the scripted site itself received, to compare with what the guard counted. */
const siteWrites = (w: ReturnType<typeof world>) =>
  w.jira.requests.filter(
    (r) =>
      r.method !== "GET" &&
      !["/search/jql", "/comment/list"].some((p) => r.url.pathname.endsWith(p)),
  );

test("the journey passes on a scripted site, within the write caps, and cleans up what it created", async (t) => {
  const w = world(t);
  const evidence = await w.run();
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.qualification, "passed");
  assert.equal(evidence.cleanup, "verified");
  // Nine journey writes (five by the harness, four by the product) and two of cleanup; two and two on GitLab.
  assert.deepEqual(evidence.writes, { jira: 11, gitlab: 4, merges: 0 });
  assert.ok((evidence.writes?.jira ?? 99) <= maxJiraWrites);
  assert.deepEqual(w.jiraGuard.denied, []);
  assert.deepEqual(w.gitlabGuard.denied, []);
  assert.deepEqual(
    evidence.requests?.jira.map((r) => r.route),
    [
      "POST issue",
      "POST issue",
      "POST issueLink",
      "POST transition",
      "POST transition",
      "POST comment",
      "PUT labels",
      "POST transition",
      "POST transition",
      "DELETE issue",
      "DELETE issue",
    ],
  );
  assert.deepEqual(
    evidence.requests?.gitlab.map((r) => r.route),
    [
      "git push",
      "POST merge_requests",
      "PUT close merge_request",
      "DELETE branch",
    ],
  );
  assert.equal(evidence.account?.jira, siteAccount);
  // A "is blocked by" the blocker, as the source reads a dependency.
  assert.deepEqual(
    evidence.links?.afterCreate?.map((l) => [l.direction, l.label, l.other]),
    [["inward", "is blocked by", evidence.issues?.blocker.key]],
  );
  assert.equal(w.jira.state.issues.size, 0, "both issues deleted");
  assert.equal(w.remote.state.heads.size, 0, "the branch was deleted");
  assert.deepEqual(
    w.remote.state.mergeRequests.map((m) => m.state),
    ["closed"],
  );
  assert.equal(w.remote.merges.length, 0, "nothing merged");
  assert.deepEqual(
    evidence.steps.map((s) => s.result),
    Array(evidence.steps.length).fill("passed"),
  );
  assert.deepEqual(evidence.polls, {
    "issues and link indexed": 1,
    "blocker done indexed": 1,
    "A done indexed": 1,
  });
  // The service's status writes, in order: the skips are recorded, not sent.
  assert.deepEqual(
    evidence.statusWrites.map((s) =>
      `${s.event} ${s.state} ${s.reason ?? ""}`.trim(),
    ),
    [
      "held confirmed-failure provider-issue-status-current",
      "turnStarted confirmed-success",
      "handedBack confirmed-failure provider-issue-status-changed",
      "done confirmed-failure provider-issue-status-current",
    ],
  );
  // The merge request title and branch carry the issue key.
  const [mr] = w.remote.state.mergeRequests;
  assert.match(
    String(mr?.title),
    /^KAN-\d+ Qualification \d{14}-[0-9a-f]{4} a$/,
  );
  assert.match(String(mr?.source_branch), /^cab\/KAN-\d+-[0-9a-f]{8}-/);
  // Every request went to the fixture hosts, without following a redirect, and no credential is reported.
  for (const request of w.jira.requests) {
    assert.equal(request.url.origin, `https://${qualificationSite.host}`);
    assert.equal(request.redirect, "manual");
  }
  for (const request of w.remote.requests)
    assert.equal(new URL(request.url).origin, "https://gitlab.com");
  const text = JSON.stringify(evidence);
  for (const secret of Object.values(canary).filter(
    (v) => !v.startsWith("https:"),
  ))
    assert.equal(text.includes(secret), false);
  assert.equal(siteWrites(w).length, evidence.writes?.jira);
});

test("a stale clone stops the run before any write", async (t) => {
  const w = world(t, { staleClone: true });
  const evidence = await w.run();
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /clone-main-stale/);
  assert.equal(w.jiraGuard.writeCount, 0);
  assert.equal(w.gitlabGuard.writeCount, 0);
  assert.deepEqual(w.pushes, []);
  assert.equal(evidence.cleanup, "verified");
});

test("search lag is waited out by a bounded poll that records its count; never listed fails before any product write", async (t) => {
  const w = world(t);
  w.jira.state.searchLag = 2;
  const evidence = await w.run();
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.polls["issues and link indexed"], 3);

  const never = world(t);
  never.jira.state.searchLag = Number.POSITIVE_INFINITY;
  const failed = await never.run({ maxPolls: 3 });
  assert.equal(failed.qualification, "failed");
  assert.match(String(failed.failure), /Timed out: issues and link indexed/);
  // Only the harness's three setup writes, then cleanup deleting both issues.
  assert.deepEqual(
    failed.requests?.jira.map((r) => r.route),
    [
      "POST issue",
      "POST issue",
      "POST issueLink",
      "DELETE issue",
      "DELETE issue",
    ],
  );
  assert.equal(never.jira.state.issues.size, 0);
  assert.equal(failed.cleanup, "verified");
  assert.deepEqual(never.gitlabGuard.log, []);
});

test("a link Jira reads the other way round fails at once from a direct read of A, naming the direction, and cleans up", async (t) => {
  const w = world(t);
  w.jira.state.reversedLinks = true;
  const evidence = await w.run();
  assert.equal(evidence.qualification, "failed");
  assert.match(String(evidence.failure), /link-direction: KAN-\d+ shows/);
  // A reads "blocks" B: the outward side, not "is blocked by".
  assert.deepEqual(
    evidence.links?.afterCreate?.map((l) => [l.direction, l.label]),
    [["outward", "blocks"]],
  );
  assert.deepEqual(evidence.polls, {}, "no poll was needed to find it");
  assert.equal(evidence.cleanup, "verified");
  assert.equal(w.jira.state.issues.size, 0);
  assert.deepEqual(
    evidence.requests?.jira.map((r) => r.route),
    [
      "POST issue",
      "POST issue",
      "POST issueLink",
      "DELETE issue",
      "DELETE issue",
    ],
  );
});

test("a poll that times out records what the search showed for A's links", async (t) => {
  const w = world(t);
  // The index never catches up past its first, empty view.
  w.jira.state.searchLag = Number.POSITIVE_INFINITY;
  const evidence = await w.run({ maxPolls: 2 });
  assert.match(String(evidence.failure), /Timed out: issues and link indexed/);
  assert.deepEqual(evidence.links?.lastSearch, []);
  assert.equal(
    evidence.links?.afterCreate?.[0]?.other.startsWith("KAN-"),
    true,
  );
});

const limited = () =>
  new Response("Too many requests\n", {
    status: 429,
    headers: {
      "retry-after": "30",
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "0",
      "ratelimit-reason": "jira-quota-global-based",
      "beta-retry-after": "29",
    },
  });

test("a 429 on a harness write is waited out and recorded with every rate-limit header, and the write still counts", async (t) => {
  const w = world(t);
  const waits: number[] = [];
  let once = true;
  // The first create is answered with Jira's headers and not processed.
  const fetcher: typeof fetch = (input, init) => {
    if (
      once &&
      init?.method === "POST" &&
      String(input).endsWith("/rest/api/3/issue")
    ) {
      once = false;
      return Promise.resolve(limited());
    }
    return w.jira.fetcher(input, init);
  };
  const evidence = await w.run({
    jiraFetcher: fetcher,
    rateLimit: { jira: { sleep: async (ms) => void waits.push(ms) } },
  });
  assert.equal(evidence.failure, undefined);
  assert.deepEqual(waits, [30_000]);
  const headers = {
    "beta-retry-after": "29",
    "ratelimit-reason": "jira-quota-global-based",
    "retry-after": "30",
    "x-ratelimit-limit": "100",
    "x-ratelimit-remaining": "0",
  };
  assert.equal(evidence.rateLimited?.jira.length, 1);
  const [limit] = evidence.rateLimited?.jira ?? [];
  assert.equal(limit?.route, "POST /issue");
  assert.deepEqual(limit?.headers, headers);
  assert.equal(limit?.retryAfter, "30");
  assert.equal(limit?.body, "Too many requests\n");
  assert.ok((limit?.request ?? 0) > 0 && (limit?.lastMinute ?? 0) >= 1);
  assert.deepEqual(evidence.lastRateHeaders, headers);
  // Eleven planned writes plus the one that was answered 429.
  assert.equal(evidence.writes?.jira, 12);
  assert.equal(evidence.requestCounts?.jira["POST /issue"], 3);
});

test("the guard allows only the site, project KAN, the run's recorded issues and the write caps", async () => {
  const guard = new JiraGuard(4, 0, 1);
  const seen: string[] = [];
  const next = (async (url: string) => {
    seen.push(String(url));
    return Response.json({ id: "10101", key: "KAN-2" }, { status: 201 });
  }) as typeof fetch;
  const fetcher = guard.fetcher(next);
  const site = `https://${qualificationSite.host}/rest/api/3`;
  const call = (
    method: string,
    path: string,
    body?: unknown,
    options: { origin?: string; redirect?: RequestRedirect } = {},
  ) =>
    fetcher(`${options.origin ?? site}${path}`, {
      method,
      redirect: options.redirect ?? "manual",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const denied = (promise: Promise<unknown>) =>
    assert.rejects(promise, (error) => error instanceof GuardDenied);
  const run = "20261031090415-5b1c";
  const search = { jql: runJql(run), fields: ["summary"] };
  const issue = (summary: string, extra: object = {}) => ({
    fields: {
      project: { id: "10001" },
      summary,
      labels: [`cab-qual-${run}`],
      ...extra,
    },
  });
  // Nothing is allowed before the run is fixed, or to another host, path or redirect mode.
  await denied(call("POST", "/search/jql", search));
  guard.bindRun(run);
  await denied(
    call("GET", "/myself", undefined, {
      origin: "https://evil.example/rest/api/3",
    }),
  );
  await denied(
    call("GET", "/myself", undefined, {
      origin: "http://banes-team.atlassian.net/rest/api/3",
    }),
  );
  await denied(
    fetcher(`https://${qualificationSite.host}/rest/api/2/myself`, {
      redirect: "manual",
    }),
  );
  await denied(call("GET", "/myself", undefined, { redirect: "follow" }));
  await denied(fetcher(new Request(`${site}/myself`)));
  // Reads: only the run's JQL, and only issues the run recorded.
  await denied(
    call("POST", "/search/jql", { jql: 'project = KAN AND labels = "other"' }),
  );
  await denied(call("POST", "/search/jql", { jql: "project = KAN" }));
  await denied(call("GET", "/issue/KAN-1"));
  await denied(call("GET", "/issue/10001/comment"));
  await denied(call("GET", "/project/10002/statuses"));
  await call("POST", "/search/jql", search);
  // Writes: other projects, other labels, other summaries and unrecorded issues are refused.
  await denied(
    call(
      "POST",
      "/issue",
      issue(`Qualification ${run} a`, { project: { id: "10002" } }),
    ),
  );
  await denied(
    call(
      "POST",
      "/issue",
      issue(`Qualification ${run} a`, { labels: ["other"] }),
    ),
  );
  await denied(call("POST", "/issue", issue("Someone's issue")));
  await denied(
    call("PUT", "/issue/KAN-1", {
      update: { labels: [{ add: `cab-qual-${run}-x` }] },
    }),
  );
  await denied(
    call("POST", "/issue/10999/transitions", { transition: { id: "t10005" } }),
  );
  assert.equal(guard.writeCount, 0);
  await call("POST", "/issue", issue(`Qualification ${run} a`));
  assert.deepEqual([...guard.issues], [["10101", "KAN-2"]]);
  await call("GET", "/issue/10101/transitions");
  // A link needs both ends recorded; a deletion or the readiness label's removal is for a cleanup only.
  await denied(
    call("POST", "/issueLink", {
      type: { name: "Blocks" },
      inwardIssue: { key: "KAN-2" },
      outwardIssue: { key: "KAN-1" },
    }),
  );
  await denied(call("DELETE", "/issue/10101"));
  await denied(
    call("PUT", "/issue/10101", {
      update: { labels: [{ remove: "cab-ready" }] },
    }),
  );
  await denied(
    call("PUT", "/issue/10101", { update: { labels: [{ remove: "other" }] } }),
  );
  await denied(call("PUT", "/issue/10101", { fields: { summary: "x" } }));
  // The cap is four writes and one is kept for cleanup: a third journey write is the last.
  await call("POST", "/issue/10101/comment", { body: {}, properties: [] });
  await call("POST", "/issue/10101/transitions", { transition: { id: "t3" } });
  await denied(
    call("POST", "/issue/10101/transitions", { transition: { id: "t3" } }),
  );
  assert.equal(guard.writeCount, 3);
  guard.cleaning = true;
  await call("DELETE", "/issue/10101");
  await denied(call("DELETE", "/issue/10101"));
  assert.ok(guard.denied.includes("write-cap"));
  assert.ok(guard.denied.includes("cleanup-only"));
  assert.equal(seen.length, 6);

  // A merge is refused by the other guard: nothing is recorded for it to merge.
  await denied(
    new GitLabGuard().fetcher(next)(
      `https://gitlab.com/api/v4/projects/${id}/merge_requests/1/merge`,
      {
        method: "PUT",
        body: JSON.stringify({ sha: "a".repeat(40), auto_merge: false }),
      },
    ),
  );
});

test("retries cannot use the writes kept for cleanup, and a send answered 429 counts as a write", async () => {
  const guard = new JiraGuard(4, 0, 2);
  const next = (async () => limited()) as unknown as typeof fetch;
  guard.bindRun("20261031090415-5b1c");
  guard.recordExisting("10101", "KAN-2");
  const send = () =>
    guard.fetcher(next)(
      `https://${qualificationSite.host}/rest/api/3/issue/10101/transitions`,
      {
        method: "POST",
        redirect: "manual",
        body: JSON.stringify({ transition: { id: "t3" } }),
      },
    );
  await send();
  await send();
  await assert.rejects(send(), (error) => error instanceof GuardDenied);
  assert.equal(guard.writeCount, 2);
  assert.equal(guard.rateLimited.length, 2);
  assert.deepEqual(guard.denied, ["write-cap"]);
});

test("requests are spaced by the pace even when sent together", async () => {
  const guard = new JiraGuard(maxJiraWrites, 40);
  const starts: number[] = [];
  const fetcher = guard.fetcher((async () => {
    starts.push(Date.now());
    return Response.json({});
  }) as typeof fetch);
  const url = `https://${qualificationSite.host}/rest/api/3/myself`;
  const init = { redirect: "manual" } as const;
  await Promise.all([
    fetcher(url, init),
    fetcher(url, init),
    fetcher(url, init),
  ]);
  const gaps = [1, 2].map((i) => Number(starts[i]) - Number(starts[i - 1]));
  assert.ok(
    gaps.every((gap) => gap >= 35),
    String(gaps),
  );
});

/** A site holding two runs' issues, an unrelated issue and one that only looks like a run's. */
function leftovers(t: TestContext) {
  const w = world(t);
  const mine = "20261031090415-5b1c";
  const other = "20260101000000-abcd";
  const a = w.jira.add({
    summary: `Qualification ${mine} a`,
    labels: ["cab-ready", `cab-qual-${mine}`],
  });
  const b = w.jira.add({
    summary: `Qualification ${mine} blocker`,
    labels: [`cab-qual-${mine}`],
  });
  const elsewhere = w.jira.add({
    summary: `Qualification ${other} a`,
    labels: [`cab-qual-${other}`],
  });
  const lookalike = w.jira.add({
    summary: `Qualification ${mine} a`,
    labels: ["cab-ready"],
  });
  const unrelated = w.jira.add({
    summary: "Someone's issue",
    labels: ["cab-ready"],
  });
  const clean = (extra: { run?: string; issue?: string }) =>
    cleanupJiraRun({
      guard: new JiraGuard(),
      fetcher: w.jira.fetcher,
      access: () => ({
        email: canary.CAB_JIRA_EMAIL,
        token: canary.CAB_JIRA_API_TOKEN,
      }),
      ...extra,
    });
  return { w, mine, a, b, elsewhere, lookalike, unrelated, clean };
}

test("a cleanup by run id finds and deletes only that run's issues, and a second one has nothing to do", async (t) => {
  const f = leftovers(t);
  const first = await f.clean({ run: f.mine });
  assert.equal(first.cleanup, "verified");
  assert.equal(first.found, 2);
  assert.deepEqual(
    first.cleanupReads.map((r) => r.result),
    ["deleted", "deleted"],
  );
  assert.deepEqual(
    [...f.w.jira.state.issues.keys()].sort(),
    [f.elsewhere.id, f.lookalike.id, f.unrelated.id].sort(),
  );
  const again = await f.clean({ run: f.mine });
  assert.equal(again.found, 0);
  assert.equal(again.cleanup, "verified");
  assert.equal(f.w.jira.state.issues.size, 3);
});

test("a cleanup by issue key deletes one run issue and refuses any other", async (t) => {
  const f = leftovers(t);
  for (const other of [f.unrelated, f.lookalike, f.elsewhere]) {
    const out = await f.clean({ issue: other.key });
    assert.equal(out.found, f.elsewhere === other ? 1 : 0);
  }
  assert.ok(f.w.jira.state.issues.has(f.unrelated.id));
  assert.ok(f.w.jira.state.issues.has(f.lookalike.id));
  const out = await f.clean({ issue: f.a.key });
  assert.equal(out.found, 1);
  assert.equal(f.w.jira.find(f.a.key), undefined);
  assert.ok(f.w.jira.find(f.b.key));
});

test("when the credential may not delete, cab-ready is removed and read back as kept-not-ready", async (t) => {
  const f = leftovers(t);
  f.w.jira.state.canDelete = false;
  const out = await f.clean({ run: f.mine });
  assert.equal(out.cleanup, "verified");
  assert.deepEqual(
    out.cleanupReads.map((r) => r.result),
    ["kept-not-ready", "kept-not-ready"],
  );
  assert.deepEqual(f.a.labels, [`cab-qual-${f.mine}`]);
  assert.ok(f.w.jira.find(f.a.key), "kept, not deleted");
  // Only the issue that had the label needed a write.
  assert.equal(f.w.jira.requests.filter((r) => r.method === "PUT").length, 1);
});

test("a cleanup by issue key treats only a missing issue as done, not an error answer", async (t) => {
  const f = leftovers(t);
  const missing = await f.clean({ issue: "KAN-999" });
  assert.equal(missing.found, 0);
  assert.equal(missing.cleanup, "verified");
  for (const status of [401, 403, 500]) {
    f.w.jira.state.fail.set("GET /issue/:id", { status, count: 1 });
    await assert.rejects(
      f.clean({ issue: f.a.key }),
      new RegExp(`issue lookup failed: ${status}`),
    );
  }
  assert.ok(f.w.jira.find(f.a.key), "nothing was deleted");
});

test("a cleanup that cannot delete or remove the label reports failure", async (t) => {
  const f = leftovers(t);
  f.w.jira.state.fail.set("DELETE /issue/:id", { status: 500, count: 2 });
  const out = await f.clean({ run: f.mine });
  assert.equal(out.cleanup, "failed");
  assert.ok(out.cleanupReads.every((r) => r.result === "present"));
});

test("the live invocation needs --live, an absolute result path, the four variables and no glab token variable", () => {
  const env = { ...canary };
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
    [["--live"], { CAB_JIRA_SITE: "" }],
    [["--live"], { CAB_JIRA_SITE: "https://other.atlassian.net" }],
    [["--live"], { CAB_JIRA_EMAIL: "" }],
    [["--live"], { CAB_JIRA_API_TOKEN: "" }],
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

test("the cleanup invocation needs --live, exactly one of a run id or an issue key, and the four variables", () => {
  const env = { ...canary };
  const run = "20261031090415-5b1c";
  assert.deepEqual(cleanupInvocation(["--live", "--run", run], env), { run });
  assert.deepEqual(
    cleanupInvocation(
      ["--live", "--issue", "KAN-3", "--result", "/tmp/r.json"],
      env,
    ),
    {
      issue: "KAN-3",
      resultPath: "/tmp/r.json",
    },
  );
  for (const args of [
    [],
    ["--run", run],
    ["--live"],
    ["--live", "--run", run, "--issue", "KAN-3"],
    ["--live", "--run", "latest"],
    ["--live", "--issue", "KAN-0"],
    ["--live", "--issue", "ABC-3"],
    ["--live", "--issue", "KAN-3", "extra"],
    ["--live", "--issue", "KAN-3", "--result", "relative.json"],
  ])
    assert.throws(() => cleanupInvocation(args, env), /Refusing execution/);
  assert.throws(
    () => cleanupInvocation(["--live", "--run", run], {}),
    /Refusing execution/,
  );
  assert.throws(
    () =>
      cleanupInvocation(["--live", "--run", run], {
        ...env,
        GITLAB_TOKEN: "x",
      }),
    /Refusing execution/,
  );
});

test("the live and cleanup scripts refuse to start without the fixture variables, before any request", () => {
  for (const script of ["live-jira-delivery.mjs", "cleanup-jira-run.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [
        `test/delivery/jira-qualification/${script}`,
        "--live",
        ...(script.startsWith("cleanup")
          ? ["--run", "20261031090415-5b1c"]
          : []),
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing execution/);
  }
});
