import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainCommands, DomainStore } from "../../src/core/domain.js";
import { DomainPolicyError } from "../../src/core/domain-errors.js";
import { Store } from "../../src/core/store.js";

const link = (repositoryId: string, path: string, ref = "main") => ({
  codeHost: "github" as const,
  host: "github.com" as const,
  repositoryId,
  path,
  ref,
});

function fixture(verify?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cab-repository-links-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  new Store(db).ensureHost("test");
  const domain = new DomainStore(db, undefined, async (input) => {
    verify?.(input.path);
    return { ...input, gitCommonDirectory: `${input.path}/.git` };
  });
  domain.migrate();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Alpha",
    leadProfileId: null,
  });
  const configure = (
    expectedVersion: number,
    repositories: ReturnType<typeof link>[] | Record<string, unknown>[],
    key: string = randomUUID(),
  ) =>
    new DomainCommands(domain).execute({
      type: "repositories.configure",
      actor: "operator",
      key,
      projectId,
      expectedVersion,
      repositories: repositories as ReturnType<typeof link>[],
    });
  return {
    db,
    domain,
    projectId,
    configure,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("repository links from the previous schema migrate as GitHub on github.com", () => {
  const f = fixture();
  try {
    const old = [
      { repositoryId: "R_1", path: "/src/one", ref: "main" },
      { repositoryId: "R_2", path: "/src/two", ref: "dev" },
    ].map((l) => ({ ...l, gitCommonDirectory: `${l.path}/.git` }));
    // The previous schema kept the links in the GitHub source row.
    f.db.exec("DROP TABLE project_repository_links");
    f.db.exec(
      "ALTER TABLE project_github_sources ADD COLUMN repositories TEXT NOT NULL DEFAULT '[]'",
    );
    f.db
      .prepare(
        "UPDATE project_github_sources SET repositories = ? WHERE projectId = ?",
      )
      .run(JSON.stringify(old), f.projectId);
    f.domain.migrate();
    const migrated = f.domain.repositoryLinks(f.projectId);
    assert.equal(migrated.version, 1);
    assert.deepEqual(
      migrated.links,
      old.map((l) => ({ ...l, codeHost: "github", host: "github.com" })),
    );
    assert.equal(
      (
        f.db.prepare("PRAGMA table_info(project_github_sources)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "repositories"),
      false,
    );
    // Running again changes nothing.
    f.domain.migrate();
    assert.deepEqual(f.domain.repositoryLinks(f.projectId), migrated);
  } finally {
    f.close();
  }
});

test("a failed migration commits nothing", () => {
  const f = fixture();
  try {
    f.db.exec("DROP TABLE project_repository_links");
    f.db.exec(
      "ALTER TABLE project_github_sources ADD COLUMN repositories TEXT NOT NULL DEFAULT '[]'",
    );
    f.db
      .prepare(
        "UPDATE project_github_sources SET repositories = '[{\"repositoryId\":1}]'",
      )
      .run();
    assert.throws(() => f.domain.migrate());
    assert.equal(
      (
        f.db.prepare("PRAGMA table_info(project_github_sources)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "repositories"),
      true,
    );
  } finally {
    f.close();
  }
});

test("repository links are added, changed and removed with a version fence and receipt", async () => {
  const verified: string[] = [];
  const f = fixture((path) => verified.push(path));
  try {
    assert.deepEqual(f.domain.repositoryLinks(f.projectId), {
      version: 1,
      links: [],
    });
    const key = randomUUID();
    const added = await f.configure(
      1,
      [link("R_1", "/src/one"), link("R_2", "/src/two", "dev")],
      key,
    );
    assert.equal(added.version, 2);
    assert.deepEqual(
      added.repositories.map((r) => [r.repositoryId, r.codeHost, r.host]),
      [
        ["R_1", "github", "github.com"],
        ["R_2", "github", "github.com"],
      ],
    );
    // The same key replays its receipt without verifying again.
    verified.length = 0;
    assert.deepEqual(
      await f.configure(
        1,
        [link("R_1", "/src/one"), link("R_2", "/src/two", "dev")],
        key,
      ),
      added,
    );
    assert.deepEqual(verified, []);
    assert.deepEqual(
      f.domain.recordedResult(f.projectId, key, "repositories.configure"),
      { type: "repositories.configure", result: added },
    );

    // A link without a path keeps its saved path; only the ref changes.
    const changed = await f.configure(2, [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_1",
        ref: "dev",
      },
      link("R_2", "/src/two", "dev"),
    ]);
    assert.equal(changed.version, 3);
    assert.deepEqual(
      changed.repositories.map((r) => [r.repositoryId, r.path, r.ref]),
      [
        ["R_1", "/src/one", "dev"],
        ["R_2", "/src/two", "dev"],
      ],
    );

    await assert.rejects(f.configure(2, []), /version conflict/i);
    const removed = await f.configure(3, [link("R_2", "/src/two", "dev")]);
    assert.deepEqual(
      removed.repositories.map((r) => r.repositoryId),
      ["R_2"],
    );
    assert.equal((await f.configure(4, [])).repositories.length, 0);
    assert.equal(f.domain.repositoryLinks(f.projectId).version, 5);
    // Links never move the GitHub source version.
    assert.equal(f.domain.githubConfiguration(f.projectId).version, 1);
  } finally {
    f.close();
  }
});

test("a link that fails verification, or has no saved path, records nothing", async () => {
  const f = fixture((path) => {
    if (path === "/src/bad") throw new Error("not a checkout");
  });
  try {
    for (const repositories of [
      [link("R_1", "/src/bad")],
      [
        {
          codeHost: "github",
          host: "github.com",
          repositoryId: "R_1",
          ref: "main",
        },
      ],
    ]) {
      const key = randomUUID();
      await assert.rejects(
        f.configure(1, repositories, key),
        (error) =>
          error instanceof DomainPolicyError &&
          error.code === "invalid-input" &&
          error.fieldPaths?.[0] === "repositories",
      );
      assert.equal(f.domain.recordedResult(f.projectId, key), undefined);
    }
    assert.deepEqual(f.domain.repositoryLinks(f.projectId), {
      version: 1,
      links: [],
    });
  } finally {
    f.close();
  }
});

test("GitHub source configuration refuses links but older recorded commands still replay", async () => {
  const f = fixture();
  try {
    await f.configure(1, [link("R_1", "/src/one")]);
    const source = {
      type: "github.configure" as const,
      actor: "operator" as const,
      projectId: f.projectId,
      credentialRef: null,
      selections: [],
      readiness: null,
    };
    // Saving the source leaves the links and their version unchanged.
    f.domain.execute({ ...source, key: randomUUID(), expectedVersion: 1 });
    assert.deepEqual(
      f.domain.repositoryLinks(f.projectId).links.map((l) => l.repositoryId),
      ["R_1"],
    );
    assert.equal(f.domain.repositoryLinks(f.projectId).version, 2);
    assert.equal(f.domain.githubConfiguration(f.projectId).version, 2);

    // A new command that carries links is refused, and nothing is recorded.
    for (const repositories of [[], [{ repositoryId: "R_1", ref: "main" }]]) {
      const key = randomUUID();
      assert.throws(
        () =>
          f.domain.execute({
            ...source,
            key,
            expectedVersion: 2,
            repositories,
          }),
        (error) =>
          error instanceof DomainPolicyError &&
          error.code === "invalid-input" &&
          error.fieldPaths?.[0] === "repositories",
      );
      assert.equal(f.domain.recordedResult(f.projectId, key), undefined);
    }
    assert.equal(f.domain.githubConfiguration(f.projectId).version, 2);

    // A command recorded before the move carried the links and replays its recorded result.
    const old = {
      ...source,
      key: randomUUID(),
      expectedVersion: 1,
      repositories: [{ repositoryId: "R_1", path: "/src/one", ref: "main" }],
    };
    const recorded = {
      version: 2,
      credentialRef: null,
      selections: [],
      readiness: null,
      closedIssues: "skip",
      repositories: [
        {
          repositoryId: "R_1",
          path: "/src/one",
          ref: "main",
          gitCommonDirectory: "/src/one/.git",
        },
      ],
    };
    const { createHash } = await import("node:crypto");
    const canonical = (value: unknown): string =>
      Array.isArray(value)
        ? `[${value.map(canonical).join(",")}]`
        : value && typeof value === "object"
          ? `{${Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
              .join(",")}}`
          : JSON.stringify(value);
    f.db
      .prepare(
        "INSERT INTO command_receipts (scope, key, payloadHash, result) VALUES (?, ?, ?, ?)",
      )
      .run(
        f.projectId,
        old.key,
        createHash("sha256").update(canonical(old)).digest("hex"),
        JSON.stringify(recorded),
      );
    assert.deepEqual(f.domain.execute(old), recorded);
    assert.deepEqual(await new DomainCommands(f.domain).execute(old), recorded);
    assert.equal(f.domain.repositoryLinks(f.projectId).version, 2);
  } finally {
    f.close();
  }
});
