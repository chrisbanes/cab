import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DomainCommands, DomainStore } from "../../src/core/domain.js";
import {
  DomainPolicyError,
  RepositoryVerificationRefusedError,
} from "../../src/core/domain-errors.js";
import type { RepositoryVerifier } from "../../src/core/github-source.js";
import { Store } from "../../src/core/store.js";
import { verifiedRepository } from "../../src/standalone/repository-verification.js";
import { checkout, createSetupHome } from "../fixtures/setup-home.js";

const link = (repositoryId: string, path: string, ref = "main") => ({
  codeHost: "github" as const,
  host: "github.com" as const,
  repositoryId,
  path,
  ref,
});

function fixture(
  verify?: (path: string) => void,
  verifier?: RepositoryVerifier,
) {
  const root = mkdtempSync(join(tmpdir(), "cab-repository-links-"));
  const db = new DatabaseSync(join(root, "db.sqlite"));
  new Store(db).ensureHost("test");
  const domain = new DomainStore(
    db,
    undefined,
    verifier ??
      (async (input) => {
        verify?.(input.path);
        return { ...input, gitCommonDirectory: `${input.path}/.git` };
      }),
  );
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

const gitlab = (
  repositoryId: string,
  path: string | undefined,
  projectPath: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  codeHost: "gitlab",
  host: "gitlab.example.com",
  repositoryId,
  ref: "main",
  ...(path === undefined ? {} : { path }),
  ...(projectPath === undefined ? {} : { projectPath }),
  ...extra,
});

test("GitLab links are recorded with their host and project path, and refused with a specific reason", async (t) => {
  const home = await createSetupHome();
  t.after(() => home.close());
  const hub = join(home.home, "hub");
  const lab = join(home.home, "lab");
  const other = join(home.home, "other");
  await checkout(hub, "https://github.com/acme/atlas.git");
  await checkout(lab, "git@gitlab.example.com:group/sub/atlas.git");
  await checkout(other, "https://gitlab.example.com/group/sub/other.git");
  const f = fixture(undefined, verifiedRepository);
  try {
    const saved = await f.configure(1, [
      link("R_1", hub),
      gitlab("4242", lab, "Group/Sub/Atlas"),
    ]);
    assert.deepEqual(
      f.domain
        .repositoryLinks(f.projectId)
        .links.map((l) => [
          l.repositoryId,
          l.codeHost,
          l.host,
          "projectPath" in l ? l.projectPath : null,
        ]),
      [
        ["R_1", "github", "github.com", null],
        ["4242", "gitlab", "gitlab.example.com", "Group/Sub/Atlas"],
      ],
    );
    // Keeping the GitLab link without path or projectPath keeps both.
    const kept = await f.configure(saved.version, [
      link("R_1", hub),
      gitlab("4242", undefined, undefined, { ref: "main" }),
    ]);
    assert.deepEqual(kept.repositories[1], saved.repositories[1]);

    const version = kept.version;
    const unchanged = () =>
      assert.equal(f.domain.repositoryLinks(f.projectId).version, version);
    await assert.rejects(
      f.configure(version, [
        link("R_1", hub),
        gitlab("4242", other, "Group/Sub/Atlas"),
      ]),
      (error) =>
        error instanceof RepositoryVerificationRefusedError &&
        error.reason === "origin-mismatch" &&
        error.fieldPaths?.[0] === "repositories.1.path" &&
        !error.message.includes(other),
    );
    unchanged();
    for (const repositories of [
      [gitlab("4242", lab, "Group/Sub/Atlas", { host: "github.com" })],
      [gitlab("abc", lab, "Group/Sub/Atlas")],
      [gitlab("4242", lab, "Group/Sub/Atlas", { codeHost: "github" })],
      // A kept link cannot change code host or host.
      [gitlab("R_1", undefined, undefined, { host: "gitlab.example.com" })],
      // A new GitLab link needs its project path.
      [gitlab("77", lab, undefined)],
      // Hosts and project paths are unique ignoring case.
      [
        gitlab("1", lab, "Group/Sub/Atlas"),
        gitlab("2", lab, "group/sub/atlas"),
      ],
    ]) {
      const key = randomUUID();
      await assert.rejects(
        async () => f.configure(version, repositories, key),
        (error) =>
          error instanceof Error &&
          (error instanceof DomainPolicyError
            ? error.code === "invalid-input"
            : error.name === "ZodError"),
      );
      assert.equal(f.domain.recordedResult(f.projectId, key), undefined);
    }
    unchanged();
  } finally {
    f.close();
  }
});
