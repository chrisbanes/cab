import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import { StandaloneDataDirectory } from "../../src/standalone/data-directory.js";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "../../src/standalone/operations.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  MIGRATION_LEVEL,
  readStartupState,
  type StartupFaultPoint,
} from "../../src/standalone/startup-snapshot.js";
import { tmpdir } from "../fixtures/temp.js";

const stubRuntime = () =>
  ({
    async start() {},
    async stop() {},
    onUnexpectedRequest() {},
  }) as unknown as Runtime;

type Fault = (point: StartupFaultPoint) => void;

function layout() {
  const root = mkdtempSync(join(tmpdir(), "cab-startup-snapshot-"));
  return {
    root,
    data: join(root, "data"),
    snapshots: join(root, "snapshots"),
    statePath: join(root, "data", "startup-state.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Levels the tests start at; the service applies `level` as if it were this build's. */
const PRIOR = 1;
const NEXT = 2;

async function run(data: string, level = MIGRATION_LEVEL, fault?: Fault) {
  const service = new StandaloneService(data, stubRuntime, undefined, {
    startupSnapshot: { level, ...(fault ? { fault } : {}) },
  });
  await service.start();
  await service.stop();
}

/** Start and stop at `from`, then remove tables that a later startup recreates. */
async function olderDatabase(data: string, from = PRIOR) {
  await run(data, from);
  const db = new DatabaseSync(join(data, "standalone.sqlite"));
  db.exec("DROP TABLE status_mappings; DROP TABLE project_repository_links");
  db.close();
}

/** The level a completed startup recorded in the database; undefined without the table. */
function recordedLevel(data: string): number | undefined {
  const db = new DatabaseSync(join(data, "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    return (
      db.prepare("SELECT level FROM startup_migration_level").get() as
        | { level: number }
        | undefined
    )?.level;
  } finally {
    db.close();
  }
}

/** user_version, the schema text and every table's row count. */
function schemaState(data: string) {
  const db = new DatabaseSync(join(data, "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    const master = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>;
    return JSON.stringify({
      version: db.prepare("PRAGMA user_version").get(),
      master,
      counts: master
        .filter((row) => row.type === "table")
        .map(
          (row) =>
            db.prepare(`SELECT count(*) AS n FROM "${row.name}"`).get()?.n,
        ),
    });
  } finally {
    db.close();
  }
}

const refusal = (code: string) => (error: Error & { code?: string }) => {
  assert.equal(error.code, code);
  return true;
};

const startupSnapshots = (snapshots: string) =>
  existsSync(snapshots) ? readdirSync(snapshots).sort() : [];

test("startup refuses while another process owns the data directory and changes nothing", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    const before = schemaState(dirs.data);
    const owner = StandaloneDataDirectory.openExclusive(dirs.data);
    try {
      await assert.rejects(run(dirs.data, NEXT), /already owned/);
    } finally {
      owner.close();
    }
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
    assert.equal(schemaState(dirs.data), before);

    const running = new StandaloneService(dirs.data, stubRuntime, undefined, {
      startupSnapshot: { level: NEXT },
    });
    await running.start();
    try {
      await assert.rejects(
        createSnapshot(dirs.data, join(dirs.root, "manual")),
        /already owned/,
      );
    } finally {
      await running.stop();
    }
  } finally {
    dirs.cleanup();
  }
});

test("pending migrations are snapshotted and verified before they run, whatever the package version", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    assert.equal(recordedLevel(dirs.data), PRIOR);
    await run(dirs.data, NEXT);

    const [name, ...others] = startupSnapshots(dirs.snapshots);
    assert.equal(others.length, 0);
    assert.match(name ?? "", /^startup\.1-to-2\.\d{8}T\d{9}Z-[0-9a-f]{4}$/);
    const path = join(dirs.snapshots, name as string);
    await verifySnapshot(path);
    const snapshotDb = new DatabaseSync(join(path, "standalone.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      snapshotDb
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('status_mappings', 'project_repository_links')",
        )
        .get()?.n,
      0,
    );
    snapshotDb.close();
    assert.match(schemaState(dirs.data), /status_mappings/);
    assert.match(schemaState(dirs.data), /project_repository_links/);
    assert.equal(recordedLevel(dirs.data), NEXT);
    const state = readStartupState(dirs.data);
    assert.equal(state?.format, "cab-startup-state-v2");
    assert.equal(state?.snapshot?.path, path);
    assert.equal(state?.snapshot?.from, PRIOR);
    assert.equal(state?.snapshot?.to, NEXT);
  } finally {
    dirs.cleanup();
  }
});

test("a start with no pending migrations takes no snapshot and keeps the recorded one", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    await run(dirs.data, NEXT);
    const [taken] = startupSnapshots(dirs.snapshots);
    const recorded = readStartupState(dirs.data);
    assert.ok(recorded?.snapshot);

    await run(dirs.data, NEXT);
    await run(dirs.data, NEXT);
    assert.deepEqual(startupSnapshots(dirs.snapshots), [taken]);
    assert.deepEqual(readStartupState(dirs.data), recorded);

    const fresh = layout();
    try {
      await run(fresh.data);
      await run(fresh.data);
      assert.deepEqual(startupSnapshots(fresh.snapshots), []);
      assert.equal(recordedLevel(fresh.data), MIGRATION_LEVEL);
      // Nothing to protect or remember: no state file.
      assert.equal(readStartupState(fresh.data), undefined);
    } finally {
      fresh.cleanup();
    }
  } finally {
    dirs.cleanup();
  }
});

test("data from before levels were recorded is level 0 and is snapshotted once", async () => {
  const dirs = layout();
  try {
    await run(dirs.data);
    const db = new DatabaseSync(join(dirs.data, "standalone.sqlite"));
    db.exec("DROP TABLE startup_migration_level");
    db.close();

    await run(dirs.data);
    const [name, ...others] = startupSnapshots(dirs.snapshots);
    assert.equal(others.length, 0);
    assert.match(
      name ?? "",
      new RegExp(`^startup\\.0-to-${MIGRATION_LEVEL}\\.`),
    );
    assert.equal(recordedLevel(dirs.data), MIGRATION_LEVEL);

    await run(dirs.data);
    assert.deepEqual(startupSnapshots(dirs.snapshots), [name]);
  } finally {
    dirs.cleanup();
  }
});

test("a directory restored from a snapshot already at the current level takes no snapshot", async () => {
  const dirs = layout();
  try {
    await run(dirs.data);
    const manual = join(dirs.root, "manual");
    await createSnapshot(dirs.data, manual);
    const restored = join(dirs.root, "restored");
    await restoreSnapshot(manual, restored);
    assert.equal(existsSync(join(restored, "startup-state.json")), false);

    await run(restored);
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
    assert.equal(recordedLevel(restored), MIGRATION_LEVEL);

    // A snapshot from before the migration is behind this build, so it is still protected.
    const behind = join(dirs.root, "behind");
    await olderDatabase(behind);
    const old = join(dirs.root, "old");
    await createSnapshot(behind, old);
    const oldRestored = join(dirs.root, "old-restored");
    await restoreSnapshot(old, oldRestored);
    await run(oldRestored, NEXT);
    assert.equal(
      startupSnapshots(dirs.snapshots).filter((name) =>
        name.startsWith("startup.1-to-2."),
      ).length,
      1,
    );
  } finally {
    dirs.cleanup();
  }
});

for (const [name, point, message] of [
  ["creation", "before-snapshot-commit", /injected creation/],
  ["verification", "before-startup-snapshot-verification", /createdAt/],
] as const) {
  test(`a failed snapshot ${name} refuses startup with the database unmigrated`, async () => {
    const dirs = layout();
    try {
      await olderDatabase(dirs.data);
      const schema = schemaState(dirs.data);
      await assert.rejects(
        run(dirs.data, NEXT, (stage) => {
          if (stage !== point) return;
          if (point === "before-snapshot-commit")
            throw new Error("injected creation failure");
          const [created] = startupSnapshots(dirs.snapshots);
          writeFileSync(
            join(dirs.snapshots, created as string, "manifest.json"),
            "{}",
          );
        }),
        (error: Error & { code?: string; cause?: Error }) => {
          assert.equal(error.code, "startup-snapshot-failed");
          assert.match(error.cause?.message ?? "", message);
          return true;
        },
      );
      assert.equal(schemaState(dirs.data), schema);
      assert.equal(existsSync(dirs.statePath), false);
    } finally {
      dirs.cleanup();
    }
  });
}

test("a start after an interrupted snapshot takes a new one and leaves the partial untouched", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    await assert.rejects(
      run(dirs.data, NEXT, (stage) => {
        if (stage === "before-snapshot-commit") throw new Error("interrupted");
      }),
      /could not be taken and verified/,
    );
    const [partial] = startupSnapshots(dirs.snapshots);
    assert.deepEqual(readdirSync(join(dirs.snapshots, partial as string)), [
      "standalone.sqlite",
    ]);

    await run(dirs.data, NEXT);
    const names = startupSnapshots(dirs.snapshots);
    assert.equal(names.length, 2);
    // The completed upgrade's snapshot stays recorded across later restarts.
    const completed = readStartupState(dirs.data)?.snapshot;
    assert.ok(completed);
    await run(dirs.data, NEXT);
    assert.deepEqual(readStartupState(dirs.data)?.snapshot, completed);
    assert.deepEqual(readdirSync(join(dirs.snapshots, partial as string)), [
      "standalone.sqlite",
    ]);
    const recorded = readStartupState(dirs.data)?.snapshot?.path;
    assert.notEqual(recorded, join(dirs.snapshots, partial as string));
    await verifySnapshot(recorded as string);
  } finally {
    dirs.cleanup();
  }
});

test("repeated starts reuse a verified snapshot and take no duplicate", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    await assert.rejects(
      run(dirs.data, NEXT, (stage) => {
        if (stage === "after-startup-snapshot-record")
          throw new Error("failed after the snapshot");
      }),
      /failed after the snapshot/,
    );
    // Level and state record a completed start only: the interrupted one left the old level.
    assert.equal(recordedLevel(dirs.data), PRIOR);
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);

    await run(dirs.data, NEXT);
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);
    assert.equal(recordedLevel(dirs.data), NEXT);
    await run(dirs.data, NEXT);
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);
  } finally {
    dirs.cleanup();
  }
});

test("a database at a higher migration level or schema version is refused without writing", async () => {
  const dirs = layout();
  try {
    await run(dirs.data, NEXT);
    const database = join(dirs.data, "standalone.sqlite");
    const bytes = readFileSync(database);
    const schema = schemaState(dirs.data);
    // schemaState's read-only connection leaves these; a refused start must not add them.
    for (const suffix of ["-wal", "-shm"])
      rmSync(`${database}${suffix}`, { force: true });
    await assert.rejects(
      run(dirs.data, PRIOR),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "startup-schema-newer");
        assert.match(error.message, /migration level 2, newer than the 1/);
        return true;
      },
    );
    assert.deepEqual(readFileSync(database), bytes);
    for (const suffix of ["-wal", "-shm"])
      assert.equal(existsSync(`${database}${suffix}`), false, suffix);
    assert.equal(schemaState(dirs.data), schema);
    assert.equal(existsSync(dirs.statePath), false);
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);

    const db = new DatabaseSync(database);
    db.exec("PRAGMA user_version = 7");
    db.close();
    const newerSchema = readFileSync(database);
    await assert.rejects(
      run(dirs.data, 3),
      /schema 7 is newer than supported schema 6/,
    );
    assert.deepEqual(readFileSync(database), newerSchema);
    assert.equal(existsSync(`${database}-wal`), false);
    assert.equal(existsSync(dirs.statePath), false);
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
  } finally {
    dirs.cleanup();
  }
});

test("a snapshot is not reused once a start has completed at the recorded level", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    await assert.rejects(
      run(dirs.data, NEXT, (stage) => {
        if (stage === "after-startup-snapshot-record")
          throw new Error("failed");
      }),
      /failed/,
    );
    const [first] = startupSnapshots(dirs.snapshots);
    // The database stays at the old level, whose build then completes a start.
    await run(dirs.data, PRIOR);
    assert.equal(readStartupState(dirs.data)?.snapshot, undefined);
    await run(dirs.data, NEXT);
    const names = startupSnapshots(dirs.snapshots);
    assert.equal(names.length, 2);
    assert.notEqual(
      readStartupState(dirs.data)?.snapshot?.path,
      join(dirs.snapshots, first as string),
    );
  } finally {
    dirs.cleanup();
  }
});

test("a retained snapshot for another level change or that no longer verifies is not reused", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    const interrupted: Fault = (stage) => {
      if (stage === "after-startup-snapshot-record") throw new Error("failed");
    };
    await assert.rejects(run(dirs.data, NEXT, interrupted), /failed/);
    // Another target level: the retained 1-to-2 snapshot does not apply.
    await assert.rejects(run(dirs.data, 3, interrupted), /failed/);
    assert.equal(startupSnapshots(dirs.snapshots).length, 2);
    assert.equal(readStartupState(dirs.data)?.snapshot?.to, 3);

    // The retained snapshot fails verification: a new one is taken.
    const retained = readStartupState(dirs.data)?.snapshot?.path as string;
    writeFileSync(join(retained, "manifest.json"), "{}");
    await run(dirs.data, 3);
    assert.equal(startupSnapshots(dirs.snapshots).length, 3);
    await verifySnapshot(readStartupState(dirs.data)?.snapshot?.path as string);
  } finally {
    dirs.cleanup();
  }
});

test("an invalid state file or a database that is not SQLite refuses startup without writing", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    const database = join(dirs.data, "standalone.sqlite");
    const bytes = readFileSync(database);
    writeFileSync(dirs.statePath, "not json");
    await assert.rejects(
      run(dirs.data, NEXT),
      refusal("startup-state-invalid"),
    );
    for (const invalid of [
      { format: "cab-startup-state-v1", release: "0.0.1", extra: 1 },
      { format: "cab-startup-state-v2", release: "0.0.1" },
    ]) {
      writeFileSync(dirs.statePath, JSON.stringify(invalid));
      await assert.rejects(
        run(dirs.data, NEXT),
        refusal("startup-state-invalid"),
      );
    }
    assert.deepEqual(readFileSync(database), bytes);

    writeFileSync(
      dirs.statePath,
      JSON.stringify({ format: "cab-startup-state-v2" }),
    );
    writeFileSync(database, "x".repeat(200));
    await assert.rejects(
      run(dirs.data, NEXT),
      refusal("startup-database-invalid"),
    );
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
  } finally {
    dirs.cleanup();
  }
});

test("a v1 state file is accepted, names no reusable snapshot and is rewritten as v2", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    // A snapshot that verifies, so only the format keeps it from being reused.
    const legacy = join(dirs.root, "legacy-snapshot");
    await createSnapshot(dirs.data, legacy);
    writeFileSync(
      dirs.statePath,
      JSON.stringify({
        format: "cab-startup-state-v1",
        release: "0.0.1",
        snapshot: {
          from: "0.0.1",
          to: "0.1.0",
          path: legacy,
          verifiedAt: new Date().toISOString(),
        },
      }),
    );
    assert.equal(readStartupState(dirs.data)?.format, "cab-startup-state-v1");
    assert.equal(readStartupState(dirs.data)?.snapshot, undefined);

    await run(dirs.data, NEXT);
    const [name, ...others] = startupSnapshots(dirs.snapshots);
    assert.equal(others.length, 0);
    const state = readStartupState(dirs.data);
    assert.equal(state?.format, "cab-startup-state-v2");
    assert.equal(state?.snapshot?.path, join(dirs.snapshots, name as string));

    // With nothing pending the old file is still rewritten, without the snapshot it named.
    writeFileSync(
      dirs.statePath,
      JSON.stringify({ format: "cab-startup-state-v1", release: "0.1.0" }),
    );
    await run(dirs.data, NEXT);
    assert.deepEqual(readStartupState(dirs.data), {
      format: "cab-startup-state-v2",
    });
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);
  } finally {
    dirs.cleanup();
  }
});

test("a schema version only a crash-left WAL records still refuses startup", async () => {
  const dirs = layout();
  try {
    await run(dirs.data, NEXT);
    const database = join(dirs.data, "standalone.sqlite");
    const live = new DatabaseSync(database);
    live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    live.exec("PRAGMA user_version = 7");
    // What a crash leaves: the main file at version 6 and the committed change in the WAL.
    copyFileSync(database, `${database}.copy`);
    copyFileSync(`${database}-wal`, `${database}.copy-wal`);
    live.close();
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(`${database}${suffix}`, { force: true });
    copyFileSync(`${database}.copy`, database);
    copyFileSync(`${database}.copy-wal`, `${database}-wal`);
    await assert.rejects(run(dirs.data, 3), refusal("startup-schema-newer"));
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
  } finally {
    dirs.cleanup();
  }
});

test("a snapshot directory the service account does not exclusively own refuses startup", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    const schema = schemaState(dirs.data);
    mkdirSync(dirs.snapshots, { mode: 0o755 });
    chmodSync(dirs.snapshots, 0o755);
    await assert.rejects(run(dirs.data, NEXT), /private directory/);
    assert.equal(schemaState(dirs.data), schema);

    rmSync(dirs.snapshots, { recursive: true });
    const elsewhere = join(dirs.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, dirs.snapshots, "dir");
    await assert.rejects(run(dirs.data, NEXT), /private directory/);
    assert.equal(schemaState(dirs.data), schema);
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally {
    dirs.cleanup();
  }
});

/**
 * Digest of the schema a fresh start creates: columns, foreign keys, and the SQL of every index,
 * trigger and view. It reads `PRAGMA table_xinfo`, not the stored CREATE TABLE text, so it does
 * not change with how a migration spells or reaches the same table. CHECK constraints are not
 * covered.
 */
function schemaDigest(data: string): string {
  const db = new DatabaseSync(join(data, "standalone.sqlite"), {
    readOnly: true,
  });
  try {
    const objects = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>;
    const inventory = objects.map(({ type, name, sql }) =>
      type === "table"
        ? {
            table: name,
            columns: db.prepare(`PRAGMA table_xinfo("${name}")`).all(),
            foreignKeys: db.prepare(`PRAGMA foreign_key_list("${name}")`).all(),
          }
        : { type, name, sql },
    );
    return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  } finally {
    db.close();
  }
}

/** The schema digest each migration level created. Append an entry with every level bump. */
const SCHEMA_PINS: Record<number, string> = {
  1: "a3a94c41a7e1d0922e131d0d8c9de4d331bd350d5e21b0b90930b0b69ecac22a",
};

test("the migration level matches the schema this build creates", async () => {
  const dirs = layout();
  try {
    await run(dirs.data);
    const pinned = Object.keys(SCHEMA_PINS).map(Number);
    assert.equal(
      Math.max(...pinned),
      MIGRATION_LEVEL,
      "Bump MIGRATION_LEVEL to the highest pinned level, or pin the new level here.",
    );
    assert.equal(
      schemaDigest(dirs.data),
      SCHEMA_PINS[MIGRATION_LEVEL],
      "The schema a fresh start creates changed: bump MIGRATION_LEVEL in src/standalone/startup-snapshot.ts and add the new schema digest for the new level to SCHEMA_PINS.",
    );
  } finally {
    dirs.cleanup();
  }
});

test("the service entry reports a refused startup in its log with nothing listening", async () => {
  const dirs = layout();
  try {
    await run(dirs.data, MIGRATION_LEVEL + 1);
    const result = spawnSync(
      process.execPath,
      [
        resolve("dist/test/fixtures/service-entry.js"),
        "plain",
        "serve",
        dirs.data,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const records = result.stderr
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].reason, "crash");
    // The log carries only the stable name and code before the database is open.
    assert.equal(records[0].error.name, "StartupRefusedError");
    assert.equal(records[0].error.code, "startup-schema-newer");
  } finally {
    dirs.cleanup();
  }
});
