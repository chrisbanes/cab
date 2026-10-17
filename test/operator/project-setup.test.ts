import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DomainCommands,
  DomainConflictError,
  DomainPolicyError,
  DomainStore,
} from "../../src/core/domain.js";
import {
  parseGitHubOrigin,
  type RepositoryVerifier,
} from "../../src/core/github-source.js";
import {
  OperatorApi,
  OperatorApiError,
} from "../../src/standalone/operator-api.js";
import { verifiedRepository } from "../../src/standalone/repository-verification.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { checkout, createSetupHome } from "../fixtures/setup-home.js";

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
  // Names are unique ignoring case, and a world creates several projects.
  name: `Atlas ${randomUUID().slice(0, 8)}`,
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
  assert.equal(github.readiness, null);
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

test("guided create records the setup source credential at version 1 and replays", async (t) => {
  const { f, home, api, db } = await setupWorld(t);
  const command = create({
    githubProject: { projectNodeId: "PVT_1" },
    sourceCredentialRef: "gh:github.com",
  });
  const receipt = await api.execute(command);
  const id = String(command.projectId);
  const read = () => f.service.domain().githubConfiguration(id);
  assert.equal(read().credentialRef, "gh:github.com");
  assert.equal(read().version, 1);
  assert.equal(
    Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM project_github_active WHERE projectId = ?",
          )
          .get(id) as { n: number }
      ).n,
    ),
    0,
  );
  await f.service.stop();
  await f.service.start();
  assert.equal(read().credentialRef, "gh:github.com");
  assert.equal(read().version, 1);
  const reopened = new OperatorApi(
    f.service,
    [f.directory],
    undefined,
    undefined,
    { home: home.home },
  );
  assert.deepEqual(await reopened.execute(command), receipt);
});

test("creates without the setup credential, and existing sources, are never re-defaulted", async (t) => {
  const { f, home, api, counts } = await setupWorld(t);
  const legacy = create({});
  assert.equal("sourceCredentialRef" in legacy, false);
  const receipt = await api.execute(legacy);
  const d = () => f.service.domain();
  const configure = (projectId: string, credentialRef: string | null) =>
    d().execute({
      type: "github.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: d().githubConfiguration(projectId).version,
      credentialRef,
      selections: [],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [],
    });
  const cleared = create({ sourceCredentialRef: "gh:github.com" });
  await api.execute(cleared);
  configure(String(cleared.projectId), null);
  const env = create({});
  await api.execute(env);
  configure(String(env.projectId), "env:SOURCE_TOKEN");
  const before = [legacy, cleared, env].map((c) =>
    d().githubConfiguration(String(c.projectId)),
  );
  assert.equal(before[0]?.credentialRef, null);
  await f.service.stop();
  await f.service.start();
  assert.deepEqual(
    [legacy, cleared, env].map((c) =>
      d().githubConfiguration(String(c.projectId)),
    ),
    before,
  );
  const reopened = new OperatorApi(
    f.service,
    [f.directory],
    undefined,
    undefined,
    { home: home.home },
  );
  assert.deepEqual(await reopened.execute(legacy), receipt);
  const recorded = counts();
  // Invalid input at both the operator and domain schemas; HTTP reports it as 400.
  for (const sourceCredentialRef of ["env:X", "gh:other.host", null]) {
    await assert.rejects(
      api.execute(create({ sourceCredentialRef })),
      (e) => e instanceof Error && e.name === "ZodError",
    );
    await assert.rejects(
      f.service.domain().createProject({
        ...create({ sourceCredentialRef }),
        actor: "operator",
      } as never),
      (e) => e instanceof Error && e.name === "ZodError",
    );
  }
  assert.deepEqual(counts(), recorded);
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

test("unsafe refs, agents and legacy creates keep their existing boundaries", async (t) => {
  const { f, db } = await setupWorld(t);
  let calls = 0;
  const spy: RepositoryVerifier = async () => {
    calls++;
    throw new Error("unexpected");
  };
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

test("a store without an injected verifier fails closed on guided create", async (t) => {
  const { home, db, counts } = await setupWorld(t);
  const before = counts();
  await assert.rejects(
    new DomainCommands(new DomainStore(db)).execute({
      ...create({
        instructions: "x",
        repositories: [atlas(join(home.home, "src", "atlas"))],
      }),
      actor: "operator",
    } as never),
    (e) =>
      e instanceof DomainPolicyError &&
      e.code === "invalid-input" &&
      JSON.stringify(e.fieldPaths) === '["repositories.0.path"]',
  );
  assert.deepEqual(counts(), before);
});

test("post-commit notification failure of a guided create stays unknown and replays once", async (t) => {
  const { f, home, db } = await setupWorld(t);
  let failure = true;
  const store = new DomainStore(
    db,
    () => {
      if (failure) throw new DomainPolicyError("invalid-input", "PRIVATE");
    },
    verifiedRepository,
  );
  const input = create({
    instructions: "x",
    repositories: [atlas(join(home.home, "src", "atlas"))],
  });
  const command = { ...input, actor: "operator" } as never;
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
      .filter((p) => p.id === input.projectId).length,
    1,
  );
});

test("verification Git never inherits a credential the command selects before it is recorded", async (t) => {
  const { f, api } = await setupWorld(t);
  const shim = await mkdtemp(join(tmpdir(), "ensemble-git-credential-"));
  t.after(() => rm(shim, { recursive: true, force: true }));
  const log = join(shim, "seen");
  const real = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  // Records only which names are present, never a value.
  await writeFile(
    join(shim, "git"),
    `#!/bin/sh\nfor n in GH_TOKEN GITHUB_TOKEN FIXTURE_PENDING_SOURCE; do eval "v=\\\${$n+x}"; [ -n "$v" ] && echo "$n" >> '${log}'; done; echo run >> '${log}'\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const saved = Object.fromEntries(
    ["PATH", "GH_TOKEN", "GITHUB_TOKEN", "FIXTURE_PENDING_SOURCE"].map((k) => [
      k,
      process.env[k],
    ]),
  );
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  process.env.PATH = `${shim}:${process.env.PATH ?? ""}`;
  process.env.GH_TOKEN = "fixture-pending-gh";
  process.env.GITHUB_TOKEN = "fixture-pending-github";
  process.env.FIXTURE_PENDING_SOURCE = "fixture-pending-env";
  const created = create({
    repositories: [atlas("~/src/atlas")],
    sourceCredentialRef: "gh:github.com",
  });
  await api.execute(created);
  const id = String(created.projectId);
  // Unrelated until selected below, so only the configure phase is checked for it.
  const seenBy = async () => {
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    await rm(log);
    return lines;
  };
  const creating = await seenBy();
  assert.ok(creating.filter((line) => line === "run").length >= 2);
  assert.deepEqual(
    creating.filter(
      (line) => line !== "run" && line !== "FIXTURE_PENDING_SOURCE",
    ),
    [],
  );
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: id,
    expectedVersion: 1,
    credentialRef: "env:FIXTURE_PENDING_SOURCE",
    selections: [],
    readiness: f.service.domain().githubConfiguration(id).readiness,
    repositories: [{ repositoryId: "R_atlas", ref: "main" }],
  });
  const configuring = await seenBy();
  assert.ok(configuring.includes("run"));
  assert.deepEqual(
    configuring.filter((line) => line !== "run"),
    [],
  );
  assert.equal(
    f.service.domain().githubConfiguration(id).credentialRef,
    "env:FIXTURE_PENDING_SOURCE",
  );
  assert.deepEqual(f.service.domain().pendingCredentialReferences(), []);
});
