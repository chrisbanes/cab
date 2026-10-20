import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PushFunction } from "../../src/standalone/github-delivery.js";
import { git } from "../fixtures/publication.js";
import {
  PublicationGuard,
  publicationManifestSchema,
} from "./github-qualification/publication-fixture.js";
import { runPublicationJourney } from "./github-qualification/publication-journey.js";

const fullName = "chrisbanes/ensemble-s07a-fixture";
const repositoryNode = "R_fixture";
const token = "ghp_live_publication_secret_0123456789";

const manifest = () => ({
  version: 1,
  provider: "github.com",
  account: { nodeId: "U_owner", login: "chrisbanes" },
  repository: {
    nodeId: repositoryNode,
    fullName,
    private: false,
    defaultBranch: "qualification",
  },
  credential: "gh-cli",
  actions: ["branch.push", "pr.create"],
  runtimeTurnLimit: 0,
  branchPrefix: "s07a-pub/",
});
function files(
  change: Record<string, unknown> = {},
  expiresAt = "2099-01-01T00:00:00Z",
) {
  const raw = JSON.stringify({ ...manifest(), ...change });
  const grant = {
    version: 1,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
    accountNodeId: "U_owner",
    repositoryNodeId: repositoryNode,
    repositoryVisibility: "public",
    credential: "gh-cli",
    actions: ["branch.push", "pr.create"],
    runtimeTurnLimit: 0,
    expiresAt,
    cleanup: { closeRecordedPrs: true, deleteRecordedHeads: true },
  };
  return { raw, grant };
}

test("the publication guard enforces the exact grant and the fixture's resources", () => {
  const f = files();
  assert.throws(() => new PublicationGuard(f.raw, undefined), /grant/);
  assert.throws(() => new PublicationGuard(`${f.raw} `, f.grant), /manifest/);
  assert.throws(
    () => new PublicationGuard(f.raw, { ...f.grant, actions: ["branch.push"] }),
  );
  assert.throws(
    () =>
      new PublicationGuard(f.raw, {
        ...f.grant,
        expiresAt: "2000-01-01T00:00:00Z",
      }),
    /expired/,
  );
  assert.throws(
    () =>
      new PublicationGuard(f.raw, {
        ...f.grant,
        cleanup: { closeRecordedPrs: true, deleteRecordedHeads: false },
      }),
  );
  for (const change of [
    {
      repository: { ...manifest().repository, fullName: "chrisbanes/ensemble" },
    },
    { branchPrefix: "cb/" },
    { credential: "env:S07A_GITHUB_TOKEN" },
    { actions: ["branch.push", "pr.create", "pr.merge"] },
    { runtimeTurnLimit: 4 },
  ])
    assert.equal(
      publicationManifestSchema.safeParse({ ...manifest(), ...change }).success,
      false,
      JSON.stringify(change),
    );

  const g = new PublicationGuard(f.raw, f.grant);
  const api = (path: string) => `https://api.github.com${path}`;
  const root = `/repos/${fullName}`;
  g.assertRequest(api("/user"));
  g.assertRequest(api(`${root}/git/ref/heads/qualification`));
  for (const [url, init] of [
    [`https://attacker.example${root}/pulls`, { method: "POST" }],
    [api("/repos/chrisbanes/ensemble/issues/1"), {}],
    [api(`${root}/pulls/3/merge`), { method: "PUT", body: "{}" }],
    [
      api(`${root}/pulls`),
      {
        method: "POST",
        body: JSON.stringify({
          head: "s07a-pub/x",
          base: "qualification",
          draft: true,
        }),
      },
    ],
    [api(`${root}/git/refs/heads/qualification`), { method: "DELETE" }],
    [
      api("/graphql"),
      { method: "POST", body: JSON.stringify({ query: "mutation M { x }" }) },
    ],
  ] as const)
    assert.throws(() => g.assertRequest(url, init), /./, url);
  g.recordBranch("s07a-pub/abc");
  assert.throws(() => g.recordBranch("main"));
  g.assertRequest(api(`${root}/pulls`), {
    method: "POST",
    body: JSON.stringify({
      head: "s07a-pub/abc",
      base: "qualification",
      draft: true,
    }),
  });
  assert.throws(() =>
    g.assertRequest(api(`${root}/pulls`), {
      method: "POST",
      body: JSON.stringify({
        head: "s07a-pub/abc",
        base: "qualification",
        draft: true,
      }),
    }),
  );
  g.assertRequest(api(`${root}/git/refs/heads/s07a-pub/abc`), {
    method: "DELETE",
  });
  assert.throws(() =>
    g.assertPush({
      nameWithOwner: "chrisbanes/ensemble",
      branch: "s07a-pub/abc",
    }),
  );
  assert.throws(() =>
    g.assertPush({ nameWithOwner: fullName, branch: "s07a-pub/other" }),
  );
});

test("the live script refuses before any credential read, process or request", (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-pub-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A `gh` that records being run: a refusal must never reach the credential.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const marker = join(dir, "gh-ran");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const f = files();
  const manifestPath = join(dir, "manifest.json");
  const grantPath = join(dir, "grant.json");
  writeFileSync(manifestPath, f.raw);
  writeFileSync(grantPath, JSON.stringify(f.grant));
  const bad = files({
    repository: { ...manifest().repository, fullName: "chrisbanes/ensemble" },
  });
  const badManifest = join(dir, "bad-manifest.json");
  writeFileSync(badManifest, bad.raw);
  const stale = join(dir, "stale-grant.json");
  writeFileSync(
    stale,
    JSON.stringify({ ...f.grant, manifestSha256: "0".repeat(64) }),
  );
  const expired = join(dir, "expired-grant.json");
  writeFileSync(
    expired,
    JSON.stringify({ ...f.grant, expiresAt: "2000-01-01T00:00:00Z" }),
  );
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const script = "test/delivery/github-qualification/live-publication.mjs";
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  for (const args of [
    [],
    ["--manifest", manifestPath, "--grant", grantPath],
    ["--live", "--manifest", "manifest.json", "--grant", grantPath],
    ["--live", "--manifest", join(dir, "missing.json"), "--grant", grantPath],
    ["--live", "--manifest", badManifest, "--grant", grantPath],
    ["--live", "--manifest", manifestPath, "--grant", stale],
    ["--live", "--manifest", manifestPath, "--grant", expired],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(
      existsSync(marker),
      false,
      `${args.join(" ")} read the credential`,
    );
  }
});

/** A fake GitHub for the fixture repository, a local repository as its clone source and a fake push. */
function fakeWorld(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-pub-journey-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote");
  mkdirSync(remote);
  git(remote, "init", "-q", "-b", "qualification");
  writeFileSync(join(remote, "README.md"), "fixture\n");
  git(remote, "add", ".");
  git(remote, "commit", "-q", "-m", "fixture base");
  const baseSha = git(remote, "rev-parse", "HEAD");
  const refs: Record<string, string> = { qualification: baseSha };
  let pull: null | {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
    state: string;
  } = null;
  const requests: string[] = [];
  const root = `/repos/${fullName}`;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const sent = (): Record<string, unknown> =>
      JSON.parse(String(init?.body ?? "{}"));
    if (url.pathname === "/graphql")
      return Response.json({
        data: { node: { id: repositoryNode, nameWithOwner: fullName } },
      });
    if (url.pathname === "/user") return Response.json({ node_id: "U_owner" });
    if (url.pathname === root && method === "GET")
      return Response.json({
        node_id: repositoryNode,
        full_name: fullName,
        private: false,
        default_branch: "qualification",
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: false,
      });
    const refPrefix = `${root}/git/ref/heads/`;
    if (url.pathname.startsWith(refPrefix)) {
      const branch = decodeURIComponent(url.pathname.slice(refPrefix.length));
      return refs[branch]
        ? Response.json({
            ref: `refs/heads/${branch}`,
            object: { sha: refs[branch] },
          })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (method === "POST" && url.pathname === `${root}/pulls`) {
      const b = sent();
      pull = {
        title: String(b.title),
        body: String(b.body),
        head: String(b.head),
        base: String(b.base),
        draft: b.draft === true,
        state: "open",
      };
      return Response.json({ number: 9 });
    }
    if (method === "GET" && url.pathname === `${root}/pulls` && pull)
      return Response.json([
        {
          node_id: "PR_9",
          number: 9,
          title: pull.title,
          body: pull.body,
          draft: pull.draft,
          user: { node_id: "U_owner" },
          head: {
            sha: refs[pull.head],
            ref: pull.head,
            repo: { node_id: repositoryNode },
          },
          base: { ref: pull.base, repo: { node_id: repositoryNode } },
        },
      ]);
    if (method === "GET" && url.pathname === `${root}/pulls/9` && pull)
      return Response.json({ state: pull.state });
    if (method === "PATCH" && url.pathname === `${root}/pulls/9` && pull) {
      pull.state = "closed";
      return Response.json({});
    }
    const refsPrefix = `${root}/git/refs/heads/`;
    if (method === "DELETE" && url.pathname.startsWith(refsPrefix)) {
      delete refs[url.pathname.slice(refsPrefix.length)];
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected route ${method} ${url.pathname}`);
  };
  const pushed: string[] = [];
  const push =
    (outcome: "pushed" | "rejected-remote"): PushFunction =>
    async (request) => {
      assert.equal(request.token, token);
      if (outcome === "pushed") {
        refs[request.branch] = request.commitSha;
        pushed.push(request.commitSha);
      }
      return outcome;
    };
  return {
    remote,
    refs,
    requests,
    pushed,
    push,
    fetcher,
    pullState: () => pull?.state,
    options: (outcome: "pushed" | "rejected-remote" = "pushed") => {
      const f = files();
      const guard = new PublicationGuard(f.raw, f.grant);
      return {
        guard,
        token,
        cloneUrl: remote,
        fetcher,
        push: push(outcome),
        readRef: (branch: string) => refs[branch] ?? null,
        readPrHead: () => refs[pull?.head ?? ""] ?? "",
        inspectPr: async () => ({
          repositoryId: repositoryNode,
          nodeId: "PR_9",
          number: 9,
          baseRef: "qualification",
          headRef: pull?.head ?? "",
          headSha: refs[pull?.head ?? ""] ?? "",
          baseSha: baseSha,
          state: "OPEN" as const,
          draft: true,
          merged: false,
          reviewDecision: null,
          checks: [],
          closedIssueNodeIds: [],
          mergeBlockers: [],
          allowedMethods: ["squash" as const],
        }),
      };
    },
  };
}

test("the publication journey publishes, opens the PR, pushes a repair and cleans up what it created", async (t) => {
  const world = fakeWorld(t);
  const evidence = await runPublicationJourney(world.options());
  assert.equal(evidence.failure, undefined);
  assert.equal(evidence.publication, "passed");
  assert.equal(evidence.cleanup, "verified");
  assert.equal(evidence.turns, 0);
  assert.equal(evidence.pushes, 2);
  assert.equal(world.pushed.length, 2);
  assert.match(String(evidence.branch), /^s07a-pub\/[0-9a-f]{8}-publication-/);
  assert.equal(world.pullState(), "closed");
  assert.deepEqual(
    Object.keys(world.refs),
    ["qualification"],
    "scratch head deleted",
  );
  assert.equal(JSON.stringify(evidence).includes(token), false);
  assert.deepEqual(
    (evidence.writes as string[]).map((w) => w.split(" ")[0]),
    ["POST", "PATCH", "DELETE"],
  );
});

test("a refused push fails the run but still proves cleanup", async (t) => {
  const world = fakeWorld(t);
  const evidence = await runPublicationJourney(
    world.options("rejected-remote"),
  );
  assert.equal(evidence.publication, "failed");
  assert.match(String(evidence.failure), /first push/);
  assert.equal(evidence.cleanup, "verified");
  assert.deepEqual(Object.keys(world.refs), ["qualification"]);
  assert.equal(world.pullState(), undefined, "no PR was opened");
  assert.equal(JSON.stringify(evidence).includes(token), false);
});
