import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { type Database, transaction } from "../core/store.js";
import type { StandaloneDataDirectory } from "./data-directory.js";
import {
  MAX_SUPPORTED_SCHEMA_VERSION,
  type OperationsFaultStage,
  fsyncPath,
  snapshotOwnedDirectory,
  verifySnapshot,
} from "./operations.js";

const STATE_FORMAT = "cab-startup-state-v2";
const LEGACY_STATE_FORMAT = "cab-startup-state-v1";
export const STARTUP_STATE_NAME = "startup-state.json";
const STATE_TEMP_NAME = `${STARTUP_STATE_NAME}.tmp`;
const MAX_STATE_BYTES = 16_384;

export type StartupRefusal =
  | "startup-state-invalid"
  | "startup-database-invalid"
  | "startup-schema-newer"
  | "startup-snapshot-directory"
  | "startup-snapshot-failed";

/**
 * Startup refused before the database was migrated. The service log shows only an error's name and
 * code until the database is open, so each refusal carries a stable code.
 */
export class StartupRefusedError extends Error {
  override readonly name = "StartupRefusedError";
  constructor(
    readonly code: StartupRefusal,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type StartupFaultPoint =
  | OperationsFaultStage
  | "before-startup-snapshot-verification"
  | "after-startup-snapshot-record";

const snapshotSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    path: z.string(),
    verifiedAt: z.string().datetime(),
  })
  .strict();

const startupStateSchema = z.union([
  z
    .object({
      format: z.literal(STATE_FORMAT),
      /** The verified pre-migration snapshot taken for the latest migration level change. */
      snapshot: snapshotSchema.optional(),
    })
    .strict(),
  // Release-keyed state of earlier builds: accepted, but names no snapshot a level can reuse.
  z
    .object({
      format: z.literal(LEGACY_STATE_FORMAT),
      release: z.string().nullable(),
      snapshot: z
        .object({
          from: z.string().nullable(),
          to: z.string(),
          path: z.string(),
          verifiedAt: z.string().datetime(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .transform(
      () => ({ format: LEGACY_STATE_FORMAT, snapshot: undefined }) as const,
    ),
]);

export type StartupState = z.infer<typeof startupStateSchema>;

export type StartupSnapshotOptions = {
  /** Test override of the migration level this build applies. */
  level?: number | undefined;
  /** Defaults to `snapshots` beside the data directory. */
  directory?: string | undefined;
  fault?: ((point: StartupFaultPoint) => void) | undefined;
};

/**
 * The migration set this build applies. Bump it with any change to the schema `start()` creates
 * (a new table, column or index) and with any data-only migration, then pin the new schema in
 * the guard test; a database at a lower level is snapshotted before it is migrated, and one at a
 * higher level is refused.
 */
export const MIGRATION_LEVEL = 1;

/** The package version, resolved from dist/src/standalone in a checkout, an npm install and a release. */
export function releaseVersion(): string {
  return (
    JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string }
  ).version;
}

/** Undefined when no state was written; throws for a file that is not valid state. */
export function readStartupState(dataRoot: string): StartupState | undefined {
  const path = join(dataRoot, STARTUP_STATE_NAME);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.size > MAX_STATE_BYTES)
    throw new StartupRefusedError(
      "startup-state-invalid",
      "Startup state is invalid",
    );
  try {
    return startupStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new StartupRefusedError(
      "startup-state-invalid",
      "Startup state is invalid",
    );
  }
}

function writeStartupState(dataRoot: string, state: StartupState): void {
  const temporary = join(dataRoot, STATE_TEMP_NAME);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
  fsyncPath(temporary);
  renameSync(temporary, join(dataRoot, STARTUP_STATE_NAME));
  fsyncPath(dataRoot);
}

/**
 * The schema version and whether the database holds nothing a release could have written.
 * A cleanly stopped database is read from its file header, so a refused start opens no SQLite
 * connection (a read-only one leaves -wal and -shm files behind). Only a non-empty WAL, left by
 * a crash, needs SQLite to see the committed pages.
 */
function inspectDatabase(path: string): { version: number; fresh: boolean } {
  if (!existsSync(path) || lstatSync(path).size === 0)
    return { version: 0, fresh: true };
  const wal = `${path}-wal`;
  if (existsSync(wal) && lstatSync(wal).size > 0) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const version = (
        db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      const tables = db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )
        .get() as { count: number };
      return { version, fresh: version === 0 && tables.count === 0 };
    } finally {
      db.close();
    }
  }
  const header = Buffer.alloc(64);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (header.toString("latin1", 0, 16) !== "SQLite format 3\0")
    throw new StartupRefusedError(
      "startup-database-invalid",
      "Standalone database is not a SQLite database",
    );
  const version = header.readUInt32BE(60);
  // A table needs a page beyond the first, which holds only the schema table.
  const pageSize =
    header.readUInt16BE(16) === 1 ? 65_536 : header.readUInt16BE(16);
  return { version, fresh: version === 0 && lstatSync(path).size <= pageSize };
}

/**
 * The migration level a completed startup recorded; 0 for data no level-aware build has started.
 * A cleanly stopped database is opened immutable, which creates no -wal or -shm file and so
 * writes nothing; only a non-empty WAL, left by a crash, needs a live read-only connection.
 * Safe because the caller holds the owner lock.
 */
function readMigrationLevel(path: string): number {
  const wal = `${path}-wal`;
  const crashed = existsSync(wal) && lstatSync(wal).size > 0;
  const location = pathToFileURL(path);
  if (!crashed) location.search = "immutable=1";
  try {
    const db = new DatabaseSync(crashed ? path : location.href, {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          "SELECT level FROM startup_migration_level WHERE singleton = 1",
        )
        .get() as { level: number } | undefined;
      return row?.level ?? 0;
    } catch (error) {
      if (/no such table/.test((error as Error).message)) return 0;
      throw error;
    } finally {
      db.close();
    }
  } catch (error) {
    throw new StartupRefusedError(
      "startup-database-invalid",
      "The migration level of the standalone database cannot be read",
      { cause: error },
    );
  }
}

/** Created 0700 when missing; a directory the service account does not exclusively own is refused. */
function ensureSnapshotDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new StartupRefusedError(
      "startup-snapshot-directory",
      "Startup snapshot directory must be a private directory owned by the service account",
    );
}

function snapshotName(from: number, to: number): string {
  const time = new Date().toISOString().replace(/[-:.]/g, "");
  return `startup.${from}-to-${to}.${time}-${randomBytes(2).toString("hex")}`;
}

/**
 * Called with the owner lock held and before anything opens the database for writing.
 * An existing database with migrations pending (its recorded level is below this build's) is
 * snapshotted and the snapshot verified before the caller may migrate; a level above this
 * build's is refused. Any failure refuses startup and leaves the database untouched.
 */
export async function protectBeforeMigration(
  dataDirectory: StandaloneDataDirectory,
  options: StartupSnapshotOptions,
): Promise<StartupState> {
  const level = options.level ?? MIGRATION_LEVEL;
  const state = readStartupState(dataDirectory.root) ?? {
    format: STATE_FORMAT,
  };
  const database = inspectDatabase(dataDirectory.databasePath);
  if (database.version > MAX_SUPPORTED_SCHEMA_VERSION)
    throw new StartupRefusedError(
      "startup-schema-newer",
      `Database schema ${database.version} is newer than supported schema ${MAX_SUPPORTED_SCHEMA_VERSION}`,
    );
  if (database.fresh) return state;
  const recorded = readMigrationLevel(dataDirectory.databasePath);
  if (recorded > level)
    throw new StartupRefusedError(
      "startup-schema-newer",
      `Database is at migration level ${recorded}, newer than the ${level} this build applies`,
    );
  if (recorded === level) return state;

  const kept = state.snapshot;
  if (
    kept &&
    kept.from === recorded &&
    kept.to === level &&
    (await verifySnapshot(kept.path).then(
      () => true,
      () => false,
    ))
  )
    return state;

  const directory =
    options.directory ?? join(dirname(dataDirectory.root), "snapshots");
  const path = join(directory, snapshotName(recorded, level));
  const protectedState: StartupState = {
    format: STATE_FORMAT,
    snapshot: {
      from: recorded,
      to: level,
      path,
      verifiedAt: new Date().toISOString(),
    },
  };
  try {
    ensureSnapshotDirectory(directory);
    await snapshotOwnedDirectory(dataDirectory, path, {
      ...(options.fault ? { fault: options.fault } : {}),
    });
    options.fault?.("before-startup-snapshot-verification");
    await verifySnapshot(path);
    writeStartupState(dataDirectory.root, protectedState);
  } catch (error) {
    throw error instanceof StartupRefusedError
      ? error
      : new StartupRefusedError(
          "startup-snapshot-failed",
          "The pre-migration snapshot could not be taken and verified",
          { cause: error },
        );
  }
  options.fault?.("after-startup-snapshot-record");
  return protectedState;
}

/**
 * Records a completed startup, called after every migration has run: the database now holds
 * `level`. A snapshot stays recorded once it protected the level now running (`to` is this
 * level); one for another level change is dropped, so a later upgrade that finds the database
 * moved on takes a fresh snapshot. An earlier build's state file is rewritten in the current
 * format.
 */
export function recordMigrationLevel(
  db: Database,
  dataDirectory: StandaloneDataDirectory,
  state: StartupState,
  level: number,
): void {
  transaction(db, () => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS startup_migration_level (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), level INTEGER NOT NULL)",
    );
    db.prepare(
      "INSERT INTO startup_migration_level (singleton, level) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET level = excluded.level WHERE level <> excluded.level",
    ).run(level);
  });
  const current = state.snapshot;
  const kept = current?.to === level ? current : undefined;
  if (state.format === STATE_FORMAT && !current === !kept) return;
  writeStartupState(dataDirectory.root, {
    format: STATE_FORMAT,
    ...(kept ? { snapshot: kept } : {}),
  });
}
