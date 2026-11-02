import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  diagnosticRetentionDays,
  diagnosticStorageMib,
  isInBound,
} from "../operator/diagnostic-retention.js";
import {
  checkPrivateDirectory,
  localOrigin,
} from "../operator/local-access.js";
import { readOwnerOnlyFile } from "./change-document.js";
import { CliError } from "./connections.js";
import { MAX_OBSERVED_PROCESSES } from "./daemon-ownership.js";

// The install record's schema, shared by service management and connection discovery.
// Discovery reads it only: no service state, domain or SQLite is loaded here.

export const RECORD_SCHEMA = "cab.service/v1";
export const DEFAULT_LABEL = "local.cab.service";
export const STATE_DIR = "Library/Application Support/cab";
const boundedInteger = (bound: Parameters<typeof isInBound>[1]) =>
  z.number().refine((value) => isInBound(value, bound));

export const configurationSchema = z
  .object({
    label: z.string(),
    nodePath: z.string(),
    cliPath: z.string(),
    dataDirectory: z.string(),
    authFile: z.string(),
    origin: z.string(),
    port: z.number().int(),
    stdoutPath: z.string(),
    stderrPath: z.string(),
    diagnosticRetentionDays: boundedInteger(diagnosticRetentionDays).optional(),
    diagnosticStorageMib: boundedInteger(diagnosticStorageMib).optional(),
    /** LaunchDaemon only. */
    userName: z.string().optional(),
    home: z.string().optional(),
  })
  .strict();
export type Configuration = z.infer<typeof configurationSchema>;

/** What `captureIdentity` returns on macOS: pid, start time and boot session of the service. */
export const processIdentitySchema = z
  .object({
    processId: z.string().regex(/^[1-9][0-9]{0,8}$/),
    processStartedAt: z.string().min(1).max(128),
    bootId: z.string().min(1).max(128),
  })
  .strict();

const observedSchema = z
  .object({
    processes: z.array(processIdentitySchema).max(MAX_OBSERVED_PROCESSES),
    unidentified: z.boolean(),
    identified: z.boolean(),
  })
  .strict();

export const recordSchema = z
  .object({
    schema: z.literal(RECORD_SCHEMA),
    // A record without `mode` is a LaunchAgent written before daemon mode; an older CLI
    // refuses one with it (strict), so it cannot act on a daemon install.
    mode: z.enum(["agent", "daemon"]).default("agent"),
    label: z.string(),
    version: z.string(),
    plistSha256: z.string().regex(/^[0-9a-f]{64}$/),
    configuration: configurationSchema,
    /**
     * Daemon only: what the service has seen of its process under launchd. Absent
     * means launchd was never seen running it. Uninstall clears the record only once
     * every process recorded here is confirmed gone (see daemon-ownership.ts).
     */
    observed: observedSchema.optional(),
  })
  .strict()
  .refine(
    ({ mode, configuration: { userName, home }, observed }) =>
      mode === "daemon"
        ? userName !== undefined && home !== undefined
        : userName === undefined &&
          home === undefined &&
          observed === undefined,
    "daemon fields do not match the mode",
  );
export type InstallRecord = z.infer<typeof recordSchema>;

/** The account's state directory: HOME as the lifecycle commands read it, else the OS home. */
export const defaultStateDirectory = (env: NodeJS.ProcessEnv) =>
  join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), STATE_DIR);

/** The one record automatic discovery reads: the default label under the default state. */
export const defaultInstallationRecord = (env: NodeJS.ProcessEnv) =>
  join(defaultStateDirectory(env), "launchd", `${DEFAULT_LABEL}.json`);

export const installationRecordPath = (stateDir: string, label: string) =>
  join(stateDir, "launchd", `${label}.json`);

const unusable = (path: string, why: string) =>
  new CliError(
    "local-access-unavailable",
    `The installation record ${path} ${why}; no other installation was tried.`,
    {
      fix: "Check the installation with 'cab service install' or its upgrade, or select another one with --local --local-installation RECORD_FILE.",
    },
  );

/** Whether the record exists at all; only an absent automatic record permits the foreground fallback. */
export async function recordExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unusable(path, "cannot be read");
  }
}

/**
 * Reads a protected install record and returns the data directory and loopback origin it names.
 * Its private directory, the file itself, and the canonical STATE/launchd/LABEL.json → STATE/data
 * layout are checked before any of its paths is used.
 */
export async function readInstallationRecord(
  path: string,
  uid = process.getuid?.(),
): Promise<{ dataDirectory: string; origin: string; label: string }> {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw unusable(path, "is not an absolute canonical path");
  try {
    await checkPrivateDirectory(dirname(path), uid);
  } catch {
    throw unusable(path, "is not in a private directory this account owns");
  }
  const text = await readOwnerOnlyFile(
    path,
    uid,
    (why) => unusable(path, `is unsafe: ${why}`),
    "",
  );
  let record: InstallRecord;
  try {
    record = recordSchema.parse(JSON.parse(text));
  } catch {
    throw unusable(path, "is malformed");
  }
  const { dataDirectory, origin, port, label } = record.configuration;
  if (
    record.label !== label ||
    basename(path) !== `${label}.json` ||
    dataDirectory !== join(dirname(dirname(path)), "data") ||
    origin !== `http://127.0.0.1:${port}`
  )
    throw unusable(path, "does not describe its own installation");
  try {
    localOrigin(origin);
  } catch {
    throw unusable(path, "names a non-loopback origin");
  }
  return { dataDirectory, origin, label };
}
