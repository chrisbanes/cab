import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DomainCommands,
  DomainConflictError,
  DomainPolicyError,
  DomainStore,
} from "../src/core/domain.js";
import {
  checkoutOrigin,
  parseGitHubOrigin,
  verifiedRepository,
} from "../src/core/github-source.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../src/standalone/operator-api.js";
import {
  gitEnvironmentProbe,
  hardenedGitEnvironment,
  withHostileGitEnvironment,
} from "./fixtures/git-environment.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { checkout, createSetupHome, git } from "./fixtures/setup-home.js";

async function setupWorld(t: { after(fn: () => unknown): void }) {
  const f = await createOperatorFixture();
  const home = await createSetupHome();
  t.after(async () => {
    await f.close();
    await home.close();
  });
  const db = new DatabaseSync(join(f.directory, "data", "standalone.sqlite"));
  t.after(() => db.close());
  const api = new OperatorApi(f.service, [f.directory], undefined, undefined, {
    home: home.home,
  });
  const counts = () =>
    [
      "domain_projects",
      "project_instruction_revisions",
      "command_receipts",
    ].map((table) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ),
    );
  return { f, home, db, api, counts };
}
const atlas = (path: string, ref = "main") => ({
  repositoryId: "R_atlas",
  owner: "acme",
  name: "atlas",
  path,
  ref,
});
const create = (extra: Record<string, unknown>) => ({
  type: "project.create",
  key: randomUUID(),
  projectId: randomUUID(),
  name: "Atlas",
  leadProfileId: null,
  ...extra,
});

test("origin parsing accepts github.com forms and never returns the URL", () => {
  for (const url of [
    "https://user:SECRETPASS@github.com/Acme/Atlas",
    "git@github.com:acme/atlas.git",
    "ssh://git@github.com/acme/atlas.git",
    "git://github.com/acme/atlas",
    "https://GitHub.com/acme/atlas.git/",
  ])
    assert.deepEqual(
      Object.keys(parseGitHubOrigin(url) ?? {}),
      ["owner", "name"],
      url,
    );
  for (const url of [
    "https://gitlab.com/acme/atlas",
    "https://github.example.com/acme/atlas",
    "https://github.com:8443/acme/atlas",
    "https://github.com/acme/atlas/extra",
    "https://github.com/acme/..",
    "file:///tmp/atlas",
    "/tmp/atlas",
  ])
    assert.equal(parseGitHubOrigin(url), null, url);
});

test("guided create records instructions, verified repositories and one inactive source atomically and replays", async (t) => {
  const { f, home, api, db } = await setupWorld(t);
  const command = create({
    instructions: "PRIVATE SETUP SENTINEL",
    repositories: [atlas("~/src/atlas")],
    githubProject: { projectNodeId: "PVT_1" },
  });
  const receipt = await api.execute(command);
  const d = f.service.domain();
  const project = d.project(String(command.projectId));
  assert.equal(project.version, 1);
  assert.equal(project.paused, 1);
  assert.equal(project.instructions, "PRIVATE SETUP SENTINEL");
  assert.equal(project.instructionsRevision, 1);
  const real = await realpath(join(home.home, "src", "atlas"));
  const github = d.githubConfiguration(String(command.projectId));
  assert.deepEqual(github.repositories, [
    {
      repositoryId: "R_atlas",
      path: real,
      ref: "main",
      gitCommonDirectory: join(real, ".git"),
    },
  ]);
  assert.deepEqual(github.selections, [
    { id: "S-1", kind: "project", projectNodeId: "PVT_1", filter: "" },
  ]);
  assert.equal(github.version, 1);
  assert.deepEqual(github.readiness, {
    mode: "all",
    conditions: [{ kind: "label", name: "ready" }],
  });
  assert.equal(
    Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM project_github_active WHERE projectId = ?",
          )
          .get(String(command.projectId)) as { n: number }
      ).n,
    ),
    0,
  );
  const text = JSON.stringify(receipt);
  assert.equal(text.includes("PRIVATE SETUP SENTINEL"), false);
  assert.equal(text.includes(home.home), false);
  assert.equal(text.includes("src/atlas"), false);
  await f.service.stop();
  await f.service.start();
  const reopened = new OperatorApi(
    f.service,
    [f.directory],
    undefined,
    undefined,
    { home: home.home },
  );
  assert.deepEqual(await reopened.execute(command), receipt);
  await assert.rejects(
    reopened.execute({ ...command, instructions: "changed" }),
    (e) => e instanceof OperatorApiError && e.status === 409,
  );
  assert.equal(f.runtime.turns, 0);
});

test("origin and ref checks report one field, keep nothing and never echo credentials", async (t) => {
  const { home, api, counts, db } = await setupWorld(t);
  const src = join(home.home, "src");
  for (const [origin, name] of [
    ["https://user:SECRETPASS@github.com/Acme/Atlas", "a1"],
    ["git@github.com:acme/atlas.git", "a2"],
    ["ssh://git@github.com/acme/atlas.git", "a3"],
    ["git://github.com/acme/atlas", "a4"],
  ] as const) {
    await checkout(join(src, name), origin);
    const receipt = await api.execute(
      create({ repositories: [atlas(`~/src/${name}`)] }),
    );
    assert.equal(JSON.stringify(receipt).includes("SECRETPASS"), false);
  }
  const stored =
    JSON.stringify(db.prepare("SELECT * FROM project_github_sources").all()) +
    JSON.stringify(db.prepare("SELECT * FROM command_receipts").all());
  assert.equal(stored.includes("SECRETPASS"), false);
  await checkout(join(src, "none"));
  await mkdir(join(src, "plain"), { recursive: true });
  await checkout(
    join(src, "enterprise"),
    "https://github.example.com/acme/atlas",
  );
  const before = counts();
  for (const [path, ref, field] of [
    ["~/src/relay", "main", "repositories.0.path"],
    ["~/src/gitlab", "main", "repositories.0.path"],
    ["~/src/enterprise", "main", "repositories.0.path"],
    ["~/src/none", "main", "repositories.0.path"],
    ["~/src/plain", "main", "repositories.0.path"],
    ["src/atlas", "main", "repositories.0.path"],
    ["~/src/missing", "main", "repositories.0.path"],
    ["~/src/atlas", "nope", "repositories.0.ref"],
    // A ref must name a commit, not a blob.
    ["~/src/atlas", "main:README.md", "repositories.0.ref"],
  ] as const)
    await assert.rejects(
      api.execute(create({ repositories: [atlas(path, ref)] })),
      (e) =>
        e instanceof OperatorApiError &&
        e.status === 400 &&
        JSON.stringify(e.fieldPaths) === JSON.stringify([field]) &&
        !e.message.includes("SECRETPASS"),
      path,
    );
  // One repository twice under a typed and a discovered identity is invalid input.
  await assert.rejects(
    api.execute(
      create({
        repositories: [
          atlas("~/src/atlas"),
          {
            ...atlas("~/src/atlas"),
            repositoryId: "github.com/acme/atlas",
            owner: "Acme",
          },
        ],
      }),
    ),
    (e) => String(e).includes("Repositories must be unique"),
  );
  // All-or-nothing: the second row fails, nothing is recorded.
  await assert.rejects(
    api.execute(
      create({
        instructions: "PRIVATE",
        repositories: [
          atlas("~/src/atlas"),
          { ...atlas("~/src/relay"), repositoryId: "R_docs", name: "docs" },
        ],
      }),
    ),
    (e) =>
      e instanceof OperatorApiError &&
      JSON.stringify(e.fieldPaths) === '["repositories.1.path"]',
  );
  assert.deepEqual(counts(), before);
});

test("the verifier reports typed reasons and keeps the no-origin path for configured links", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const src = join(home.home, "src");
  const reason = (p: Promise<unknown>) =>
    p.then(
      () => "verified",
      (e: { reason?: string; actual?: string }) =>
        `${e.reason}${e.actual ? `:${e.actual}` : ""}`,
    );
  const link = (path: string, ref = "main") => ({
    repositoryId: "R",
    path,
    ref,
  });
  const expected = { owner: "acme", name: "atlas" };
  assert.equal(
    await reason(verifiedRepository(link(join(src, "relay")), expected)),
    "origin-mismatch:acme/relay",
  );
  assert.equal(
    await reason(
      verifiedRepository(link(join(src, "atlas"), "nope"), expected),
    ),
    "ref-unavailable",
  );
  // Mismatch is reported ahead of a missing ref.
  assert.equal(
    await reason(
      verifiedRepository(link(join(src, "relay"), "nope"), expected),
    ),
    "origin-mismatch:acme/relay",
  );
  assert.equal(
    await reason(verifiedRepository(link(join(src, "gitlab")), expected)),
    "origin-provider",
  );
  // Without an expected origin the remote is not consulted (github.configure and admission).
  assert.equal(
    await reason(verifiedRepository(link(join(src, "gitlab")))),
    "verified",
  );
  await git(join(src, "atlas"), "remote", "remove", "origin");
  assert.equal(
    await reason(verifiedRepository(link(join(src, "atlas")))),
    "verified",
  );
});

test("repository verification ignores inherited GIT_* overrides", async (t) => {
  const home = await createSetupHome();
  const probe = gitEnvironmentProbe();
  t.after(() => {
    home.close();
    probe.close();
  });
  const path = await realpath(join(home.home, "src", "atlas"));
  const commonDirectory = await realpath(
    (
      await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    ).stdout.trim(),
  );
  const hadGitDirectory = "GIT_DIR" in process.env;

  const [verified, origin] = await withHostileGitEnvironment(() =>
    probe.withPath(async () => [
      await verifiedRepository(
        { repositoryId: "R", path, ref: "main" },
        { owner: "acme", name: "atlas" },
      ),
      await checkoutOrigin(path),
    ]),
  );

  assert.equal(
    (verified as { gitCommonDirectory: string }).gitCommonDirectory,
    commonDirectory,
  );
  assert.deepEqual(origin, { owner: "acme", name: "atlas" });
  const invocations = probe.invocations();
  assert.ok(invocations.length >= 4, "every verification call is recorded");
  for (const invocation of invocations)
    assert.deepEqual(invocation.env, hardenedGitEnvironment, invocation.args);
  assert.equal("GIT_DIR" in process.env, hadGitDirectory);
});

test("unsafe refs, agents and legacy creates keep their existing boundaries", async (t) => {
  const { f, db } = await setupWorld(t);
  let calls = 0;
  const spy = (async () => {
    calls++;
    throw new Error("unexpected");
  }) as unknown as typeof verifiedRepository;
  const commands = new DomainCommands(new DomainStore(db, undefined, spy));
  for (const ref of ["--help", "-x", "a b", "a\u0000b"])
    await assert.rejects(async () =>
      commands.execute({
        ...create({ repositories: [atlas("/tmp/x", ref)] }),
        actor: "operator",
      } as never),
    );
  assert.equal(calls, 0);
  await assert.rejects(
    async () =>
      commands.execute({
        ...create({ repositories: [atlas("/tmp/x")] }),
        actor: "agent",
      } as never),
    (e) => e instanceof DomainPolicyError && e.code === "forbidden",
  );
  assert.equal(calls, 0);
  // A create without the setup fields keeps the synchronous path and its receipt.
  const legacy = { ...create({}), actor: "operator" } as never;
  const store = f.service.domain();
  const first = store.execute(legacy);
  assert.deepEqual(store.execute(legacy), first);
  assert.throws(
    () => store.execute({ ...(legacy as object), name: "Other" } as never),
    DomainConflictError,
  );
});

test("post-commit notification failure of a guided create stays unknown and replays once", async (t) => {
  const { f, home, db } = await setupWorld(t);
  let failure = true;
  const store = new DomainStore(db, () => {
    if (failure) throw new DomainPolicyError("invalid-input", "PRIVATE");
  });
  const command = {
    ...create({
      instructions: "x",
      repositories: [atlas(join(home.home, "src", "atlas"))],
    }),
    actor: "operator",
  } as never;
  await assert.rejects(
    store.createProject(command),
    (e) =>
      e instanceof Error &&
      !(e instanceof DomainPolicyError) &&
      e.message === "Command committed but change notification failed",
  );
  failure = false;
  const original = store.recordedCommand(command);
  assert.ok(original);
  assert.deepEqual(await store.createProject(command), original);
  // The synchronous path replays a recorded guided create but cannot apply one.
  assert.deepEqual(store.execute(command), original);
  assert.equal(
    f.service
      .domain()
      .projects()
      .filter((p) => p.name === "Atlas").length,
    1,
  );
});
