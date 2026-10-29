import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import { StandaloneDataDirectory } from "../../src/standalone/data-directory.js";
import {
  createSnapshot,
  verifySnapshot,
} from "../../src/standalone/operations.js";
import { StandaloneService } from "../../src/standalone/service.js";
import {
  compareReleaseVersions,
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

async function run(data: string, release: string, fault?: Fault) {
  const service = new StandaloneService(data, stubRuntime, undefined, {
    startupSnapshot: { release, ...(fault ? { fault } : {}) },
  });
  await service.start();
  await service.stop();
}

/** Start and stop at `from`, then remove a table that a later startup recreates. */
async function olderDatabase(data: string, from = "0.0.1") {
  await run(data, from);
  const db = new DatabaseSync(join(data, "standalone.sqlite"));
  db.exec("DROP TABLE status_mappings");
  db.close();
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
      await assert.rejects(run(dirs.data, "0.1.0"), /already owned/);
    } finally {
      owner.close();
    }
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
    assert.equal(schemaState(dirs.data), before);

    const running = new StandaloneService(dirs.data, stubRuntime, undefined, {
      startupSnapshot: { release: "0.1.0" },
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

test("an older release's data is snapshotted and verified before it is migrated", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    await run(dirs.data, "0.1.0");

    const [name, ...others] = startupSnapshots(dirs.snapshots);
    assert.equal(others.length, 0);
    assert.match(
      name ?? "",
      /^startup\.0\.0\.1-to-0\.1\.0\.\d{8}T\d{9}Z-[0-9a-f]{4}$/,
    );
    const path = join(dirs.snapshots, name as string);
    await verifySnapshot(path);
    const snapshotDb = new DatabaseSync(join(path, "standalone.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      snapshotDb
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'status_mappings'",
        )
        .get()?.n,
      0,
    );
    snapshotDb.close();
    assert.match(schemaState(dirs.data), /status_mappings/);
    assert.deepEqual(readStartupState(dirs.data)?.snapshot?.path, path);
    assert.equal(readStartupState(dirs.data)?.release, "0.1.0");
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
      const state = readFileSync(dirs.statePath);
      await assert.rejects(
        run(dirs.data, "0.1.0", (stage) => {
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
      assert.deepEqual(readFileSync(dirs.statePath), state);
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
      run(dirs.data, "0.1.0", (stage) => {
        if (stage === "before-snapshot-commit") throw new Error("interrupted");
      }),
      /could not be taken and verified/,
    );
    const [partial] = startupSnapshots(dirs.snapshots);
    assert.deepEqual(readdirSync(join(dirs.snapshots, partial as string)), [
      "standalone.sqlite",
    ]);

    await run(dirs.data, "0.1.0");
    const names = startupSnapshots(dirs.snapshots);
    assert.equal(names.length, 2);
    // The completed upgrade's snapshot stays recorded across later restarts.
    const completed = readStartupState(dirs.data)?.snapshot;
    await run(dirs.data, "0.1.0");
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
      run(dirs.data, "0.1.0", (stage) => {
        if (stage === "after-startup-snapshot-record")
          throw new Error("failed after the snapshot");
      }),
      /failed after the snapshot/,
    );
    assert.equal(readStartupState(dirs.data)?.release, "0.0.1");
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);

    await run(dirs.data, "0.1.0");
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);
    assert.equal(readStartupState(dirs.data)?.release, "0.1.0");
    await run(dirs.data, "0.1.0");
    assert.equal(startupSnapshots(dirs.snapshots).length, 1);
  } finally {
    dirs.cleanup();
  }
});

test("an older binary or a newer schema is refused without writing", async () => {
  const dirs = layout();
  try {
    await run(dirs.data, "0.2.0");
    const database = join(dirs.data, "standalone.sqlite");
    const bytes = readFileSync(database);
    const state = readFileSync(dirs.statePath);
    await assert.rejects(
      run(dirs.data, "0.1.0"),
      /last started by cab 0\.2\.0, newer than 0\.1\.0/,
    );
    assert.deepEqual(readFileSync(database), bytes);
    assert.deepEqual(readFileSync(dirs.statePath), state);
    assert.equal(existsSync(`${database}-wal`), false);
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);

    const db = new DatabaseSync(database);
    db.exec("PRAGMA user_version = 7");
    db.close();
    const newerSchema = readFileSync(database);
    await assert.rejects(
      run(dirs.data, "0.3.0"),
      /schema 7 is newer than supported schema 6/,
    );
    assert.deepEqual(readFileSync(database), newerSchema);
    assert.deepEqual(readFileSync(dirs.statePath), state);
    assert.equal(existsSync(`${database}-wal`), false);
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
  } finally {
    dirs.cleanup();
  }
});

test("a snapshot is not reused once a start has completed at the recorded release", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    await assert.rejects(
      run(dirs.data, "0.1.0", (stage) => {
        if (stage === "after-startup-snapshot-record")
          throw new Error("failed");
      }),
      /failed/,
    );
    const [first] = startupSnapshots(dirs.snapshots);
    // The database moves on under the old release, which then completes a start.
    await run(dirs.data, "0.0.1");
    assert.equal(readStartupState(dirs.data)?.snapshot, undefined);
    await run(dirs.data, "0.1.0");
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

test("a retained snapshot for another release change or that no longer verifies is not reused", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    const interrupted: Fault = (stage) => {
      if (stage === "after-startup-snapshot-record") throw new Error("failed");
    };
    await assert.rejects(run(dirs.data, "0.1.0", interrupted), /failed/);
    // Another target release: the retained 0.0.1-to-0.1.0 snapshot does not apply.
    await assert.rejects(run(dirs.data, "0.2.0", interrupted), /failed/);
    assert.equal(startupSnapshots(dirs.snapshots).length, 2);
    assert.equal(readStartupState(dirs.data)?.snapshot?.to, "0.2.0");

    // The retained snapshot fails verification: a new one is taken.
    const retained = readStartupState(dirs.data)?.snapshot?.path as string;
    writeFileSync(join(retained, "manifest.json"), "{}");
    await run(dirs.data, "0.2.0");
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
      run(dirs.data, "0.1.0"),
      refusal("startup-state-invalid"),
    );
    writeFileSync(
      dirs.statePath,
      JSON.stringify({
        format: "cab-startup-state-v1",
        release: "0.0.1",
        extra: 1,
      }),
    );
    await assert.rejects(
      run(dirs.data, "0.1.0"),
      refusal("startup-state-invalid"),
    );
    assert.deepEqual(readFileSync(database), bytes);

    writeFileSync(
      dirs.statePath,
      JSON.stringify({ format: "cab-startup-state-v1", release: "0.0.1" }),
    );
    writeFileSync(database, "x".repeat(200));
    await assert.rejects(
      run(dirs.data, "0.1.0"),
      refusal("startup-database-invalid"),
    );
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
  } finally {
    dirs.cleanup();
  }
});

test("a schema version only a crash-left WAL records still refuses startup", async () => {
  const dirs = layout();
  try {
    await run(dirs.data, "0.2.0");
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
    await assert.rejects(
      run(dirs.data, "0.3.0"),
      refusal("startup-schema-newer"),
    );
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
  } finally {
    dirs.cleanup();
  }
});

test("a fresh directory takes no snapshot and records the release", async () => {
  const dirs = layout();
  try {
    await run(dirs.data, "0.1.0");
    assert.deepEqual(startupSnapshots(dirs.snapshots), []);
    assert.deepEqual(readStartupState(dirs.data), {
      format: "cab-startup-state-v1",
      release: "0.1.0",
    });
  } finally {
    dirs.cleanup();
  }
});

test("a database with no recorded release is snapshotted as unrecorded", async () => {
  const dirs = layout();
  try {
    await olderDatabase(dirs.data);
    unlinkSync(dirs.statePath);
    await run(dirs.data, "0.1.0");
    const [name] = startupSnapshots(dirs.snapshots);
    assert.match(name ?? "", /^startup\.unrecorded-to-0\.1\.0\./);
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
    await assert.rejects(run(dirs.data, "0.1.0"), /private directory/);
    assert.equal(schemaState(dirs.data), schema);

    rmSync(dirs.snapshots, { recursive: true });
    const elsewhere = join(dirs.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, dirs.snapshots, "dir");
    await assert.rejects(run(dirs.data, "0.1.0"), /private directory/);
    assert.equal(schemaState(dirs.data), schema);
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally {
    dirs.cleanup();
  }
});

test("release versions compare by semantic-version precedence", () => {
  const ordered = [
    "0.1.0",
    "0.1.1-live.980",
    "0.1.1",
    "0.2.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (const [index, left] of ordered.entries())
    for (const [other, right] of ordered.entries())
      assert.equal(
        Math.sign(compareReleaseVersions(left, right)),
        Math.sign(index - other),
        `${left} vs ${right}`,
      );
  assert.equal(compareReleaseVersions("1.0.0+a", "1.0.0+b"), 0);
  assert.throws(() => compareReleaseVersions("1.0", "1.0.0"), /semantic/);
});

test("the service entry reports a refused startup in its log with nothing listening", () => {
  const dirs = layout();
  try {
    mkdirSync(dirs.data, { mode: 0o700 });
    writeFileSync(join(dirs.data, ".cab-standalone"), "cab-standalone-v1\n", {
      mode: 0o600,
    });
    writeFileSync(join(dirs.data, ".cab-owner.sqlite"), "", { mode: 0o600 });
    writeFileSync(
      dirs.statePath,
      JSON.stringify({ format: "cab-startup-state-v1", release: "9.9.9" }),
      { mode: 0o600 },
    );
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
    assert.equal(records[0].error.code, "startup-release-newer");
  } finally {
    dirs.cleanup();
  }
});
