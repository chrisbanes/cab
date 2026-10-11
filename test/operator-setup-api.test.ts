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
import { DomainPolicyError } from "../src/core/domain.js";
import { coordinationTools } from "../src/standalone/coordination-tools.js";
import { DiscoveryFailure } from "../src/standalone/github-discovery.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { listHomeFolders } from "../src/standalone/operator-setup.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { createSetupHome, fakeDiscovery } from "./fixtures/setup-home.js";

const configure = (credentialRef: string | null) => ({
  type: "discovery.configure",
  key: randomUUID(),
  credentialRef,
});

test("the discovery credential reference is set, shown only as configured and cleared", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const api = new OperatorApi(f.service, [f.directory]);
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
  assert.deepEqual(api.readDiscoveryStatus().data, {
    configured: true,
    available: false,
  });
  const previous = process.env.FIXTURE_DISCOVERY;
  process.env.FIXTURE_DISCOVERY = "PRIVATE DISCOVERY TOKEN";
  try {
    const status = api.readDiscoveryStatus();
    assert.deepEqual(status.data, { configured: true, available: true });
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
  const reopened = new OperatorApi(f.service, [f.directory]);
  assert.deepEqual(await reopened.execute(set), receipt);
  const clear = configure(null);
  await reopened.execute(clear);
  assert.deepEqual(reopened.readDiscoveryStatus().data, {
    configured: false,
    available: false,
  });
  assert.deepEqual(await reopened.execute(set), receipt);
  assert.equal(f.service.domain().discoveryCredentialReference(), null);
  for (const bad of ["env:lower", "FIXTURE", "env:"])
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
