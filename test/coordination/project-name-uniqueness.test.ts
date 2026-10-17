import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  DomainStore,
  type DomainCommand,
  ProjectNameTakenError,
} from "../../src/core/domain.js";
import { Store } from "../../src/core/store.js";

function fixture(
  verifyRepository?: ConstructorParameters<typeof DomainStore>[2],
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db, undefined, verifyRepository);
  domain.migrate();
  const create = (name: string, projectId = randomUUID()) => {
    domain.execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      name,
      leadProfileId: null,
    });
    return projectId;
  };
  const configure = (
    projectId: string,
    change: Record<string, unknown>,
    key = randomUUID(),
  ) =>
    domain.execute({
      type: "project.configure",
      key,
      actor: "operator",
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
      ...change,
    } as DomainCommand);
  const count = () =>
    Number(
      (
        db.prepare("SELECT count(*) AS n FROM domain_projects").get() as {
          n: number;
        }
      ).n,
    );
  return { db, domain, create, configure, count };
}

const taken = (existingName: string) => (error: unknown) => {
  assert.ok(error instanceof ProjectNameTakenError);
  assert.equal(error.code, "invalid-input");
  assert.deepEqual(error.fieldPaths, ["name"]);
  assert.equal(error.existingName, existingName);
  return true;
};

test("project creation refuses a name another project has, ignoring case and spacing", () => {
  const f = fixture();
  f.create("Atlas");
  assert.throws(() => f.create("atlas"), taken("Atlas"));
  assert.throws(() => f.create("ATLAS "), taken("Atlas"));
  assert.equal(f.count(), 1);
  f.create("Atlas 2");
  assert.equal(f.count(), 2);
});

test("project names compare composed and decomposed forms as equal", () => {
  const f = fixture();
  f.create("Café");
  assert.throws(() => f.create("Café"), taken("Café"));
  assert.equal(f.count(), 1);
});

test("a Cyrillic lookalike is a different name", () => {
  const f = fixture();
  f.create("Atlas");
  f.create("Аtlas");
  assert.equal(f.count(), 2);
});

test("renaming a project into another project's name is refused and changes nothing", () => {
  const f = fixture();
  f.create("Atlas");
  const b = f.create("Relay");
  const before = Number(f.domain.project(b).version);
  assert.throws(() => f.configure(b, { name: "atlas" }), taken("Atlas"));
  assert.equal(f.domain.project(b).name, "Relay");
  assert.equal(Number(f.domain.project(b).version), before);
  f.configure(b, { name: "Relay 2" });
  assert.equal(f.domain.project(b).name, "Relay 2");
});

test("a project saves under its own name, a case-only change and other fields next to an existing duplicate", () => {
  const f = fixture();
  f.create("Atlas");
  const b = f.create("Relay");
  // Predates the rule: a duplicate seeded straight into storage.
  f.db.prepare("UPDATE domain_projects SET name = 'Atlas' WHERE id = ?").run(b);
  const versionOf = () => Number(f.domain.project(b).version);
  let version = versionOf();
  f.configure(b, { name: "Atlas" });
  assert.equal(versionOf(), ++version);
  f.configure(b, { name: "ATLAS" });
  assert.equal(f.domain.project(b).name, "ATLAS");
  assert.equal(versionOf(), ++version);
  f.configure(b, { instructions: "Other fields" });
  assert.equal(versionOf(), ++version);
  f.configure(b, { name: "Atlas " });
  assert.equal(f.domain.project(b).name, "Atlas");
  assert.equal(versionOf(), ++version);
});

test("with three existing duplicates a fourth is refused and the list order is stable", () => {
  const f = fixture();
  const ids = ["Atlas", "Relay", "Beacon"].map((name) => f.create(name));
  for (const id of ids)
    f.db
      .prepare("UPDATE domain_projects SET name = 'Atlas' WHERE id = ?")
      .run(id);
  assert.throws(() => f.create("atlas"), taken("Atlas"));
  const listed = f.domain.projects();
  assert.deepEqual(
    listed.map((row) => row.id),
    [...ids].sort(),
  );
  assert.ok(listed.every((row) => row.name === "Atlas"));
});

test("replaying the original create returns its recorded result after a duplicate exists", () => {
  const f = fixture();
  const projectId = randomUUID();
  const command = {
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Atlas",
    leadProfileId: null,
  } as const;
  const first = f.domain.execute(command);
  const other = f.create("Relay");
  f.db
    .prepare("UPDATE domain_projects SET name = 'Atlas' WHERE id = ?")
    .run(other);
  assert.deepEqual(f.domain.execute(command), first);
  assert.equal(f.count(), 2);
});

test("a duplicate name is refused before any repository is probed", async () => {
  let probed = 0;
  const f = fixture(async (link) => {
    probed += 1;
    return { ...link, gitCommonDirectory: `${link.path}/.git` };
  });
  f.create("Atlas");
  const repositories = [
    {
      repositoryId: "R_1",
      path: "/repo",
      ref: "main",
      owner: "acme",
      name: "repo",
    },
  ];
  const create = (name: string) =>
    f.domain.createProject({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId: randomUUID(),
      name,
      leadProfileId: null,
      repositories,
    });
  await assert.rejects(create("atlas"), taken("Atlas"));
  assert.equal(probed, 0);
  assert.equal(f.count(), 1);
  await create("Atlas 2");
  assert.equal(probed, 1);
  // The same repository under a taken name fails on the name, not on a repository field.
  await assert.rejects(create("ATLAS 2"), taken("Atlas 2"));
});
