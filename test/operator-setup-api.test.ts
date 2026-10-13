import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { z } from "zod";
import { deliveryPolicySchema } from "../src/core/delivery.js";
import { DomainPolicyError } from "../src/core/domain.js";
import { githubConfigurationSchema } from "../src/core/github-source-contracts.js";
import { operatorCommandSchema } from "../src/operator/contracts.js";
import { coordinationTools } from "../src/standalone/coordination-tools.js";
import { DiscoveryFailure } from "../src/standalone/github-discovery.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../src/standalone/operator-api.js";
import {
  listHomeFolders,
  verifyCheckout,
} from "../src/standalone/operator-setup.js";
import { createFakeGh, fakeGhToken } from "./fixtures/fake-gh.js";
import {
  gitEnvironmentProbe,
  hardenedGitEnvironment,
  withHostileGitEnvironment,
} from "./fixtures/git-environment.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { createSetupHome, fakeDiscovery, git } from "./fixtures/setup-home.js";

const configure = (credentialRef: string | null) => ({
  type: "discovery.configure",
  key: randomUUID(),
  credentialRef,
});

test("the discovery credential reference is set, shown only as configured and cleared", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const gh = createFakeGh();
  t.after(() => gh.close());
  const setup = { ghExecutable: gh.missing };
  const api = new OperatorApi(
    f.service,
    [f.directory],
    undefined,
    undefined,
    setup,
  );
  const set = configure("env:FIXTURE_DISCOVERY");
  const receipt = await api.execute(set);
  assert.deepEqual(receipt, {
    kind: "configuration",
    key: set.key,
    recorded: true,
    result: {
      commandType: "discovery.configure",
      resourceId: "system:discovery",
      configured: true,
    },
  });
  assert.deepEqual((await api.readDiscoveryStatus()).data, {
    configured: true,
    available: false,
    source: "env",
    gh: { state: "not-installed" },
  });
  const previous = process.env.FIXTURE_DISCOVERY;
  process.env.FIXTURE_DISCOVERY = "PRIVATE DISCOVERY TOKEN";
  try {
    const status = await api.readDiscoveryStatus();
    assert.deepEqual(status.data, {
      configured: true,
      available: true,
      source: "env",
      gh: { state: "not-installed" },
    });
    const text = JSON.stringify([
      status,
      receipt,
      await api.readWorkspace(),
      await api.readRuntimeSettings(),
    ]);
    assert.equal(text.includes("FIXTURE_DISCOVERY"), false);
    assert.equal(text.includes("PRIVATE DISCOVERY TOKEN"), false);
  } finally {
    if (previous === undefined) delete process.env.FIXTURE_DISCOVERY;
    else process.env.FIXTURE_DISCOVERY = previous;
  }
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "env:FIXTURE_DISCOVERY",
  );
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(
    f.service,
    [f.directory],
    undefined,
    undefined,
    setup,
  );
  assert.deepEqual(await reopened.execute(set), receipt);
  const clear = configure(null);
  await reopened.execute(clear);
  assert.deepEqual((await reopened.readDiscoveryStatus()).data, {
    configured: false,
    available: false,
    source: null,
    gh: { state: "not-installed" },
  });
  assert.deepEqual(await reopened.execute(set), receipt);
  assert.equal(f.service.domain().discoveryCredentialReference(), null);
  for (const bad of [
    "env:lower",
    "FIXTURE",
    "env:",
    "gh:",
    "gh:github.example.com",
    "gh:GITHUB.COM",
    "gh:github.com/x",
    "GH:github.com",
  ])
    await assert.rejects(reopened.execute(configure(bad)));
  assert.throws(
    () =>
      f.service
        .domain()
        .execute({ ...configure(null), actor: "agent" } as never),
    (e) => e instanceof DomainPolicyError && e.code === "forbidden",
  );
});

test("discovery reads list through the injected reader, fail closed and store nothing", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const state: { failure?: Error; calls: string[] } = { calls: [] };
  let constructed = 0;
  const factory = fakeDiscovery(state);
  const api = new OperatorApi(f.service, [f.directory], undefined, undefined, {
    discovery: (ref) => {
      constructed++;
      return factory(ref);
    },
  });
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const counts = () =>
    ["command_receipts", "project_github_sources", "domain_projects"].map(
      (table) =>
        Number(
          (
            db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
              n: number;
            }
          ).n,
        ),
    );
  const query = new URLSearchParams({ repository: "acme/atlas" });
  assert.deepEqual((await api.readDiscoveryRepositories()).data, {
    state: "unavailable",
    reason: "unconfigured",
  });
  assert.equal(constructed, 0);
  await api.execute(configure("env:FIXTURE_DISCOVERY"));
  const before = counts();
  const repositories = await api.readDiscoveryRepositories();
  assert.equal(repositories.data.state, "ready");
  assert.equal(
    repositories.data.state === "ready" &&
      repositories.data.repositories.length,
    3,
  );
  assert.deepEqual((await api.readDiscoveryBranches(query)).data, {
    state: "ready",
    branches: ["develop", "main"],
    truncated: false,
  });
  const projects = (await api.readDiscoveryProjects(query)).data;
  assert.equal(
    projects.state === "ready" && projects.linked[0]?.title,
    "Atlas roadmap",
  );
  state.failure = new DiscoveryFailure("unauthorized");
  assert.deepEqual((await api.readDiscoveryRepositories()).data, {
    state: "unavailable",
    reason: "unauthorized",
  });
  state.failure = new Error("PRIVATE FAILURE DETAIL");
  const failed = await api.readDiscoveryBranches(query);
  assert.deepEqual(failed.data, { state: "unavailable", reason: "unreadable" });
  assert.equal(JSON.stringify(failed).includes("PRIVATE"), false);
  assert.deepEqual(counts(), before);
  for (const bad of [
    new URLSearchParams(),
    new URLSearchParams("repository=acme"),
    new URLSearchParams("repository=a/b/c"),
    new URLSearchParams("repository=acme/atlas&repository=acme/relay"),
    new URLSearchParams("repository=acme/atlas&x=1"),
  ])
    assert.throws(() => api.readDiscoveryProjects(bad), { status: 400 });
});

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      const s = await stat(p).catch(() => null);
      out.push(`${p}:${s?.size}:${s?.mtimeMs}`);
      if (d.isDirectory() && d.name !== ".git") await walk(p);
    }
  };
  await walk(root);
  return out.sort();
}

test("setup probes run with the hardened environment", async (t) => {
  const home = await createSetupHome();
  const probe = gitEnvironmentProbe();
  t.after(() => {
    home.close();
    probe.close();
  });
  await git(join(home.home, "src", "relay"), "checkout", "--detach", "--quiet");
  const input = {
    path: "~/src/atlas",
    repository: { owner: "acme", name: "atlas" },
    ref: "main",
  };
  const expected = {
    listing: await listHomeFolders(home.home, { path: "~/src" }),
    verification: await verifyCheckout(home.home, input),
  };

  const hostile = await withHostileGitEnvironment(() =>
    probe.withPath(async () => ({
      listing: await listHomeFolders(home.home, { path: "~/src" }),
      verification: await verifyCheckout(home.home, input),
    })),
  );

  assert.deepEqual(hostile, expected);
  assert.deepEqual(hostile.verification, {
    state: "verified",
    origin: "acme/atlas",
    branch: "main",
  });
  const relay = hostile.listing.entries.find((e) => e.name === "relay");
  assert.deepEqual(relay, {
    name: "relay",
    kind: "git",
    origin: "acme/relay",
    branch: null,
  });
  const invocations = probe.invocations();
  for (const command of ["remote", "symbolic-ref", "rev-parse"])
    assert.ok(
      invocations.some((item) => item.args.includes(command)),
      `${command} was recorded`,
    );
  for (const invocation of invocations)
    assert.deepEqual(invocation.env, hardenedGitEnvironment, invocation.args);
});

test("malformed verified repository output is unavailable, not invalid user input", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  Object.defineProperty(f.service.domain(), "verifyRepository", {
    value: async (link: {
      repositoryId: string;
      path: string;
      ref: string;
    }) => ({ ...link, gitCommonDirectory: "relative/.git" }),
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const projectId = randomUUID();
  await assert.rejects(
    api.execute({
      type: "project.create",
      key: randomUUID(),
      projectId,
      name: "Alpha",
      leadProfileId: null,
      repositories: [
        {
          repositoryId: "R_1",
          owner: "acme",
          name: "repo",
          path: "/repo",
          ref: "main",
        },
      ],
    }),
    (error: unknown) =>
      error instanceof OperatorApiError &&
      error.status === 503 &&
      error.code === "unavailable",
  );
  assert.equal(f.service.domain().projectListed(projectId), false);
});

test("home folder listing stays inside home, lists names and Git status only and verifies checkouts", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const realHome = await realpath(home.home);
  await mkdir(join(home.home, "src", ".private", "inner"), { recursive: true });
  await symlink(join(home.home, ".ssh"), join(home.home, "src", "dotlink"));
  const before = await snapshot(home.home);
  const listing = await listHomeFolders(home.home, { path: "~/src" });
  assert.deepEqual(listing, {
    path: "~/src",
    parent: "~",
    entries: [
      { name: "atlas", kind: "git", origin: "acme/atlas", branch: "main" },
      { name: "gitlab", kind: "git", origin: null, branch: "main" },
      { name: "leaky", kind: "git", origin: "acme/leaky", branch: "main" },
      { name: "relay", kind: "git", origin: "acme/relay", branch: "main" },
      { name: "archive", kind: "folder", origin: null, branch: null },
      { name: "design-notes", kind: "folder", origin: null, branch: null },
    ],
    truncated: false,
  });
  const text = JSON.stringify(listing);
  for (const leak of [
    "notes.txt",
    "PRIVATE FILE CONTENT",
    "SECRETPASS",
    "escape",
    home.home,
    realHome,
  ])
    assert.equal(text.includes(leak), false, leak);
  const root = await listHomeFolders(home.home, { path: "~" });
  assert.deepEqual(
    root.entries.map((e) => e.name),
    ["big", "src"],
  );
  assert.equal(root.parent, null);
  let probes = 0;
  const big = await listHomeFolders(home.home, { path: "~/big" }, (path) => {
    probes++;
    return lstat(path);
  });
  assert.equal(big.entries.length, 200);
  assert.equal(big.truncated, true);
  // Probing is bounded by the page, not by the directory's 205 children.
  assert.equal(probes, 200);
  const status = (path: string) =>
    listHomeFolders(home.home, { path }).then(
      () => 200,
      (e: { status?: number }) => e.status,
    );
  for (const bad of [
    "~/..",
    "~/src/../../..",
    "/etc",
    "~other",
    "~/src//atlas",
    "~/src/\0",
    "src",
  ])
    assert.equal(await status(bad), 400, bad);
  assert.equal(await status("~/src/escape"), 403);
  // Hidden folders are refused at any depth, typed or behind a symlink.
  for (const hidden of ["~/.ssh", "~/src/.private", "~/src/.private/inner"])
    assert.equal(await status(hidden), 400, hidden);
  assert.equal(await status("~/src/dotlink"), 403);
  assert.equal(await status("~/missing"), 404);
  assert.equal(await status("~/src/notes.txt"), 404);
  assert.deepEqual(await snapshot(home.home), before);
});

test("setup routes require an operator session, CSRF and same origin and are not agent tools", async (t) => {
  const home = await createSetupHome();
  const f = await createOperatorFixture();
  t.after(async () => {
    await f.close();
    await home.close();
  });
  const web = await f.startWeb([f.directory], {
    home: home.home,
    discovery: fakeDiscovery(),
  });
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const cookieOf = (r: Response) =>
    r.headers.get("set-cookie")?.split(";")[0] ?? "";
  const anon = (await anonymous.json()) as { csrfToken: string };
  const login = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: cookieOf(anonymous),
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anon.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  const cookie = cookieOf(login);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${web.origin}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: web.origin,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const verify = (path: string, owner = "acme", name = "atlas", ref = "main") =>
    post("/api/operator/setup/verify-checkout", {
      path,
      repository: { owner, name },
      ref,
    }).then(async (r) => ((await r.json()) as { data: unknown }).data);
  const folders = await post("/api/operator/setup/folders", { path: "~/src" });
  assert.equal(folders.status, 200);
  const realAtlas = await realpath(join(home.home, "src", "atlas"));
  assert.deepEqual(await verify("~/src/atlas"), {
    state: "verified",
    origin: "acme/atlas",
    branch: "main",
  });
  assert.deepEqual(await verify(realAtlas), await verify("~/src/atlas"));
  for (const [path, reason, origin, ref] of [
    ["~/src/relay", "origin-mismatch", "acme/relay", "main"],
    ["~/src/design-notes", "not-checkout", null, "main"],
    ["~/src/gitlab", "origin-provider", null, "main"],
    ["~/src/atlas", "ref-unavailable", null, "nope"],
    ["src/atlas", "path-invalid", null, "main"],
  ] as const)
    assert.deepEqual(await verify(path, "acme", "atlas", ref), {
      state: "rejected",
      reason,
      origin,
    });
  assert.equal(
    (await post("/api/operator/setup/folders", { path: "~/src/escape" }))
      .status,
    403,
  );
  assert.equal(
    (await post("/api/operator/setup/folders", { path: "~/.." })).status,
    400,
  );
  for (const path of [
    "/api/operator/setup/folders",
    "/api/operator/setup/verify-checkout",
  ]) {
    const body = { path: "~/src" };
    const anonymousPost = await fetch(`${web.origin}${path}`, {
      method: "POST",
      headers: { origin: web.origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(anonymousPost.status, 401);
    assert.equal(
      (await post(path, body, { "x-csrf-token": "wrong" })).status,
      403,
    );
    assert.equal(
      (await post(path, body, { origin: "http://evil.example" })).status,
      403,
    );
    assert.equal(
      (await fetch(`${web.origin}${path}`, { headers: { cookie } })).status,
      405,
    );
  }
  for (const path of [
    "/api/operator/discovery",
    "/api/operator/discovery/repositories",
    "/api/operator/discovery/branches?repository=acme/atlas",
    "/api/operator/discovery/projects?repository=acme/atlas",
  ]) {
    assert.equal((await fetch(`${web.origin}${path}`)).status, 401, path);
    assert.equal(
      (await fetch(`${web.origin}${path}`, { headers: { cookie } })).status,
      200,
      path,
    );
    assert.equal((await post(path.split("?")[0] ?? path, {})).status, 405);
  }
  for (const path of [
    "/api/operator/discovery/branches",
    "/api/operator/discovery/branches?repository=acme/atlas&repository=acme/relay",
    "/api/operator/discovery/projects?repository=../x",
    "/api/operator/discovery?x=1",
  ])
    assert.equal(
      (await fetch(`${web.origin}${path}`, { headers: { cookie } })).status,
      400,
      path,
    );
  assert.equal(
    coordinationTools.some((tool) =>
      /folder|discover|setup|checkout/i.test(tool.name),
    ),
    false,
  );
});

test("task text holding the discovery credential is never captured, before or after the reference changes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const previous = process.env.FIXTURE_CAPTURE_DISCOVERY;
  // The name deliberately avoids the generic TOKEN/SECRET environment pattern.
  process.env.FIXTURE_CAPTURE_DISCOVERY = "CAPTUREDISCOVERYCANARY841";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_CAPTURE_DISCOVERY;
    else process.env.FIXTURE_CAPTURE_DISCOVERY = previous;
  });
  const api = new OperatorApi(f.service, [f.directory]);
  await api.execute(configure("env:FIXTURE_CAPTURE_DISCOVERY"));
  const d = f.service.domain();
  const projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Capture",
    leadProfileId: null,
  } as never);
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Uses CAPTUREDISCOVERYCANARY841",
    outcome: "Read with CAPTUREDISCOVERYCANARY841",
    ready: false,
  } as never);
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const stored = () =>
    JSON.stringify([
      db.prepare("SELECT * FROM task_review_sources").all(),
      db.prepare("SELECT * FROM task_review_search").all(),
    ]);
  assert.equal(stored().includes("CAPTUREDISCOVERYCANARY841"), false);
  for (const next of ["env:OTHER_DISCOVERY", null]) {
    await api.execute(configure(next));
    const reads = JSON.stringify([
      // Captured review sources and search; the task row itself is operator input.
      (await api.readReview(taskId)).data,
      await api.readSearch(
        new URLSearchParams({ query: "CAPTUREDISCOVERYCANARY841" }),
      ),
    ]);
    assert.equal(
      reads.includes("CAPTUREDISCOVERYCANARY841"),
      false,
      String(next),
    );
    assert.equal(stored().includes("CAPTUREDISCOVERYCANARY841"), false);
  }
});

test("a task read fences when the discovery reference or its value changes mid-read", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const previous = process.env.FIXTURE_FENCE_DISCOVERY;
  // The name deliberately avoids the generic TOKEN/SECRET environment pattern.
  process.env.FIXTURE_FENCE_DISCOVERY = "FENCEDISCOVERYCANARY841";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_FENCE_DISCOVERY;
    else process.env.FIXTURE_FENCE_DISCOVERY = previous;
  });
  const api = new OperatorApi(f.service, [f.directory]);
  const d = f.service.domain();
  const projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Fence",
    leadProfileId: null,
  } as never);
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Mentions FENCEDISCOVERYCANARY841",
    outcome: "Fence",
    ready: false,
  } as never);
  // Interleave a change after the read has taken its exclusion snapshot.
  const during = async (
    change: () => void,
    read: () => Promise<unknown> = () => api.readTask(taskId),
  ) => {
    const target = api as unknown as {
      exclusions: (...args: unknown[]) => Promise<unknown>;
    };
    const original = target.exclusions;
    let changed = false;
    target.exclusions = async (...args: unknown[]) => {
      const snapshot = await original.apply(api, args);
      if (!changed) {
        changed = true;
        change();
      }
      return snapshot;
    };
    try {
      return await read().then(
        (r) => JSON.stringify(r),
        (e: { status?: number }) => e.status,
      );
    } finally {
      target.exclusions = original;
    }
  };
  // The reference is configured mid-read: the read is refused, not returned unredacted.
  assert.equal(
    await during(() =>
      d.execute({
        type: "discovery.configure",
        actor: "operator",
        key: randomUUID(),
        credentialRef: "env:FIXTURE_FENCE_DISCOVERY",
      } as never),
    ),
    503,
  );
  // The same reference resolves to a new value mid-read: refused as well.
  process.env.FIXTURE_FENCE_DISCOVERY = "SOMETHING ELSE";
  assert.equal(
    await during(() => {
      process.env.FIXTURE_FENCE_DISCOVERY = "FENCEDISCOVERYCANARY841";
    }),
    503,
  );
  // Reads guarded by the shared workspace snapshot fence the same way.
  for (const read of [
    () => api.readProject(projectId),
    () => api.readTaskListPage(new URLSearchParams()),
    () => api.readComposerOptions(projectId),
    () => api.readRuntimeSettings(),
  ]) {
    process.env.FIXTURE_FENCE_DISCOVERY = "SOMETHING ELSE";
    assert.equal(
      await during(() => {
        process.env.FIXTURE_FENCE_DISCOVERY = "FENCEDISCOVERYCANARY841";
      }, read),
      503,
      String(read),
    );
  }
  // Settled reads exclude the current value.
  assert.equal(
    JSON.stringify(await api.readTask(taskId)).includes(
      "FENCEDISCOVERYCANARY841",
    ),
    false,
  );
});

test("a discovery result read with a credential that changed meanwhile is read again", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const used: string[] = [];
  let configureDuringRead: (() => void) | undefined;
  const api = new OperatorApi(f.service, [f.directory], undefined, undefined, {
    discovery: (ref) => ({
      async repositories() {
        used.push(ref);
        const change = configureDuringRead;
        configureDuringRead = undefined;
        change?.();
        return {
          repositories: [
            {
              repositoryId: `R_${ref.slice(4)}`,
              owner: "acme",
              name: "atlas",
              defaultBranch: "main",
            },
          ],
          truncated: false,
        };
      },
      branches: async () => ({ branches: [], truncated: false }),
      projects: async () => ({
        ownerLogin: "acme",
        linked: [],
        owned: [],
        truncated: false,
      }),
    }),
  });
  await api.execute(configure("env:FIRST_DISCOVERY"));
  // The reference switches while the first read is in flight: its result is discarded.
  configureDuringRead = () =>
    f.service.domain().execute({
      ...configure("env:SECOND_DISCOVERY"),
      actor: "operator",
    } as never);
  const switched = (await api.readDiscoveryRepositories()).data;
  assert.deepEqual(used, ["env:FIRST_DISCOVERY", "env:SECOND_DISCOVERY"]);
  assert.equal(
    switched.state === "ready" && switched.repositories[0]?.repositoryId,
    "R_SECOND_DISCOVERY",
  );
  // Cleared in flight: nothing read with the old credential is returned.
  used.length = 0;
  configureDuringRead = () =>
    f.service.domain().execute({
      ...configure(null),
      actor: "operator",
    } as never);
  assert.deepEqual((await api.readDiscoveryRepositories()).data, {
    state: "unavailable",
    reason: "unconfigured",
  });
  assert.deepEqual(used, ["env:SECOND_DISCOVERY"]);
});

test("a gh discovery reference reads with the gh login on every read and never reveals its token", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const gh = createFakeGh();
  t.after(() => gh.close());
  const tokens: (string | undefined)[] = [];
  const factory = fakeDiscovery();
  const api = new OperatorApi(f.service, [f.directory], undefined, undefined, {
    ghExecutable: gh.executable,
    discovery: (ref, token) => {
      tokens.push(token);
      return factory(ref);
    },
  });
  // Unconfigured status still reports the detected login, so the choice can be offered.
  assert.deepEqual((await api.readDiscoveryStatus()).data, {
    configured: false,
    available: false,
    source: null,
    gh: { state: "signed-in", login: "octo" },
  });
  const receipt = await api.execute(configure("gh:github.com"));
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  const status = await api.readDiscoveryStatus();
  assert.deepEqual(status.data, {
    configured: true,
    available: true,
    source: "gh",
    gh: { state: "signed-in", login: "octo" },
  });
  const repositories = await api.readDiscoveryRepositories();
  assert.equal(repositories.data.state, "ready");
  assert.deepEqual(tokens, [fakeGhToken]);
  await api.readDiscoveryRepositories();
  // Resolved again for the second read, never cached.
  assert.deepEqual(tokens, [fakeGhToken, fakeGhToken]);
  for (const [state, reason, detected] of [
    ["not-signed-in", "gh-not-signed-in", { state: "not-signed-in" }],
    ["unreadable", "gh-unreadable", { state: "unreadable" }],
    ["invalid-token", "gh-unreadable", { state: "signed-in", login: "octo" }],
  ] as const) {
    gh.set(state);
    assert.deepEqual((await api.readDiscoveryRepositories()).data, {
      state: "unavailable",
      reason,
    });
    const failed = await api.readDiscoveryStatus();
    assert.deepEqual(failed.data, {
      configured: true,
      available: state === "invalid-token",
      source: "gh",
      gh: detected,
    });
  }
  const missing = new OperatorApi(
    f.service,
    [f.directory],
    undefined,
    undefined,
    { ghExecutable: gh.missing, discovery: factory },
  );
  assert.deepEqual((await missing.readDiscoveryRepositories()).data, {
    state: "unavailable",
    reason: "gh-not-installed",
  });
  assert.equal(tokens.length, 2);
  gh.set("signed-in");
  const web = await f.startWeb([f.directory], {
    ghExecutable: gh.executable,
    discovery: factory,
  });
  const cookieOf = (r: Response) =>
    r.headers.get("set-cookie")?.split(";")[0] ?? "";
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anon = (await anonymous.json()) as { csrfToken: string };
  const login = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: cookieOf(anonymous),
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anon.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  const cookie = cookieOf(login);
  const body = await (
    await fetch(`${web.origin}/api/operator/discovery`, { headers: { cookie } })
  ).text();
  assert.deepEqual(JSON.parse(body).data, status.data);
  const text = JSON.stringify([
    status,
    receipt,
    body,
    repositories,
    await api.readWorkspace(),
  ]);
  assert.equal(text.includes(fakeGhToken), false);
});

test("routing and delivery stay env-only while sources accept the exact gh login", () => {
  const routing = operatorCommandSchema.options.find(
    (o) => o.shape.type.value === "routing.configure",
  ) as unknown as { shape: { credentialRef: z.ZodType } } | undefined;
  assert.ok(routing);
  for (const field of [
    routing.shape.credentialRef,
    deliveryPolicySchema.shape.credentialRef,
  ]) {
    assert.equal(field.safeParse("env:FIXTURE_SOURCE").success, true);
    assert.equal(field.safeParse("gh:github.com").success, false);
  }
  const source = githubConfigurationSchema.shape.credentialRef;
  assert.equal(source.safeParse("env:FIXTURE_SOURCE").success, true);
  assert.equal(source.safeParse("gh:github.com").success, true);
  assert.equal(source.safeParse("gh:other.host").success, false);
  assert.equal(source.safeParse(null).success, true);
});
