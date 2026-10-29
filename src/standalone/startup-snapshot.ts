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
import { z } from "zod";
import type { StandaloneDataDirectory } from "./data-directory.js";
import {
  MAX_SUPPORTED_SCHEMA_VERSION,
  type OperationsFaultStage,
  fsyncPath,
  snapshotOwnedDirectory,
  verifySnapshot,
} from "./operations.js";

const STATE_FORMAT = "cab-startup-state-v1";
export const STARTUP_STATE_NAME = "startup-state.json";
const STATE_TEMP_NAME = `${STARTUP_STATE_NAME}.tmp`;
const MAX_STATE_BYTES = 16_384;

export type StartupRefusal =
  | "startup-state-invalid"
  | "startup-database-invalid"
  | "startup-schema-newer"
  | "startup-release-newer"
  | "startup-release-invalid"
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

const startupStateSchema = z
  .object({
    format: z.literal(STATE_FORMAT),
    /** The release whose startup last completed; null when it was never recorded. */
    release: z.string().nullable(),
    /** The verified pre-migration snapshot taken for the latest release change. */
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
  .strict();

export type StartupState = z.infer<typeof startupStateSchema>;

export type StartupSnapshotOptions = {
  release: string;
  /** Defaults to `snapshots` beside the data directory. */
  directory?: string | undefined;
  fault?: ((point: StartupFaultPoint) => void) | undefined;
};

/** The package version, resolved from dist/src/standalone in a checkout, an npm install and a release. */
export function releaseVersion(): string {
  return (
    JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string }
  ).version;
}

const RELEASE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseRelease(value: string) {
  const match = RELEASE.exec(value);
  if (!match)
    throw new StartupRefusedError(
      "startup-release-invalid",
      "Release version is not a semantic version",
    );
  return {
    core: match.slice(1, 4).map((part) => BigInt(part)),
    pre: match[4]?.split("."),
  };
}

/** Semantic-version precedence: negative when `left` is older than `right`. */
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseRelease(left);
  const b = parseRelease(right);
  for (const [index, part] of a.core.entries()) {
    const other = b.core[index] as bigint;
    if (part !== other) return part < other ? -1 : 1;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (const [index, part] of a.pre.entries()) {
    const other = b.pre[index];
    if (other === undefined) return 1;
    const numeric = /^\d+$/.test(part);
    const otherNumeric = /^\d+$/.test(other);
    if (numeric && otherNumeric) {
      if (BigInt(part) !== BigInt(other))
        return BigInt(part) < BigInt(other) ? -1 : 1;
    } else if (numeric !== otherNumeric) {
      return numeric ? -1 : 1;
    } else if (part !== other) {
      return part < other ? -1 : 1;
    }
  }
  return a.pre.length === b.pre.length ? 0 : -1;
}

/** Undefined when no release has recorded itself; throws for a file that is not valid state. */
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

function snapshotName(from: string | null, to: string): string {
  const time = new Date().toISOString().replace(/[-:.]/g, "");
  return `startup.${from ?? "unrecorded"}-to-${to}.${time}-${randomBytes(2).toString("hex")}`;
}

/**
 * Called with the owner lock held and before anything opens the database for writing.
 * An existing database last started by an older or unrecorded release is snapshotted and
 * the snapshot verified before the caller may migrate; any failure refuses startup and
 * leaves the database untouched.
 */
export async function protectBeforeMigration(
  dataDirectory: StandaloneDataDirectory,
  options: StartupSnapshotOptions,
): Promise<StartupState> {
  const { release } = options;
  parseRelease(release);
  const state = readStartupState(dataDirectory.root);
  const recorded = state?.release ?? null;
  const current: StartupState = {
    format: STATE_FORMAT,
    release: recorded,
    ...(state?.snapshot ? { snapshot: state.snapshot } : {}),
  };
  const database = inspectDatabase(dataDirectory.databasePath);
  if (database.version > MAX_SUPPORTED_SCHEMA_VERSION)
    throw new StartupRefusedError(
      "startup-schema-newer",
      `Database schema ${database.version} is newer than supported schema ${MAX_SUPPORTED_SCHEMA_VERSION}`,
    );
  if (recorded !== null && compareReleaseVersions(recorded, release) > 0)
    throw new StartupRefusedError(
      "startup-release-newer",
      `Database was last started by cab ${recorded}, newer than ${release}`,
    );
  if (database.fresh || recorded === release) return current;

  const kept = state?.snapshot;
  if (
    kept &&
    kept.from === recorded &&
    kept.to === release &&
    (await verifySnapshot(kept.path).then(
      () => true,
      () => false,
    ))
  )
    return current;

  const directory =
    options.directory ?? join(dirname(dataDirectory.root), "snapshots");
  const path = join(directory, snapshotName(recorded, release));
  const protectedState: StartupState = {
    format: STATE_FORMAT,
    release: recorded,
    snapshot: {
      from: recorded,
      to: release,
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
 * Records a completed startup. The verified snapshot stays recorded for the release change it
 * protected; a completed start at the recorded release drops it, so a later upgrade that
 * finds the database moved on takes a fresh one.
 */
export function recordStartedRelease(
  dataDirectory: StandaloneDataDirectory,
  state: StartupState,
  release: string,
): void {
  if (state.release === release && !state.snapshot) return;
  writeStartupState(dataDirectory.root, {
    format: STATE_FORMAT,
    release,
    ...(state.release !== release && state.snapshot
      ? { snapshot: state.snapshot }
      : {}),
  });
}
