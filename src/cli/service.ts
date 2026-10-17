import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { hostname, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { childProcessEnvironment } from "../core/child-environment.js";
import {
  operatorCredentialIssuedSchema,
  sessionSchema,
} from "../operator/contracts.js";
import {
  diagnosticRetentionDays,
  diagnosticStorageMib,
  isInBound,
} from "../operator/diagnostic-retention.js";
import { connectionNameSchema } from "./connections.js";
import {
  type DaemonFacts,
  type Job,
  type Listener,
  type Observed,
  daemonDecision,
  MAX_OBSERVED_PROCESSES,
  refineObserved,
  type Seen,
} from "./daemon-ownership.js";
import { DEFAULT_FIX, fixLine, shellWord } from "./remedy.js";
import type { CliDeps } from "./types.js";

// Service modules load on demand so the operator CLI never loads service state or SQLite.

const SERVICE_COMMANDS = `  service install [TARBALL] [--mode agent|daemon] [--connection NAME] [--token-file PATH] [--no-open] [SERVICE_OPTIONS]
  service upgrade VERSION_DIR [--connection NAME] [SERVICE_OPTIONS]
  service uninstall [SERVICE_OPTIONS]
  service init-auth [AUTH_FILE] [--state-dir DIR]
  service serve|operator|run|list ABSOLUTE_DATA_DIR [ARGS...]
`;
const SNAPSHOT_COMMANDS = `  snapshot create SOURCE_DATA_DIR SNAPSHOT
  snapshot verify SNAPSHOT
  snapshot restore SNAPSHOT DESTINATION_DATA_DIR
`;
const SERVICE_NOTES = `
SERVICE_OPTIONS:
  --state-dir DIR          default ~/Library/Application Support/Ensemble
  --log-dir DIR            default ~/Library/Logs/Ensemble
  --launch-agents-dir DIR  default ~/Library/LaunchAgents
  --label LABEL            default local.ensemble.service
  --port PORT              loopback port for install, default 8787
  --diagnostic-retention-days N|default  diagnostic retention (1-365, service default 30)
  --diagnostic-storage-mib N|default     diagnostic storage cap (16-1048576, service default 1024)

The diagnostic options (install and upgrade) are written into the LaunchAgent;
upgrade keeps the recorded values unless an option changes them, and default
clears one. To change a value, run upgrade with the installed release directory.
install binds the LaunchAgent to the release it runs from (STATE/versions/V), or
to TARBALL unpacked into STATE/versions. It asks once for the operator password
(creating the auth file when it is missing), then signs the CLI in with a read
credential (90 days, kept in the Keychain or --token-file), runs doctor and opens
the app. Those steps never undo a started service; if one fails, install prints
the manual login line. --connection defaults to local; --no-open skips the browser.
install --mode daemon prepares a LaunchDaemon that starts at boot, before anyone logs
in. It runs as you, never as root: it renders and records the plist, then prints the
sudo commands that install and start it; run them, then run the same install command
again, with the same options and no TARBALL, to verify; it reports started only when the
job's own process serves the port. It does not sign in or run doctor. The two modes are
never both installed; uninstall prints the matching sudo commands for a daemon and clears
its record only once every service process it saw has exited. upgrade
refuses a daemon install; see the macOS operations guide for the switch-back procedure.
upgrade stops the job, takes a verified snapshot, starts VERSION_DIR and checks
readiness through a logged-in CLI connection with a read credential. A failed
upgrade leaves the job stopped and reports the snapshot and logs; recover with
a fixed release and another upgrade, or snapshot restore. uninstall removes the
job and keeps data, auth, snapshots, versions and logs.
`;

export const SERVICE_USAGE = `Local service commands (run on the service's Mac):
${SERVICE_COMMANDS}${SNAPSHOT_COMMANDS}${SERVICE_NOTES}`;

type LocalArea = "service" | "snapshot";
const LIFECYCLE_COMMANDS = ["install", "upgrade", "uninstall", "init-auth"];

/**
 * The area whose help `argv` asks for: `service --help`, `service
 * install|upgrade|uninstall|init-auth ... --help` and `snapshot ... --help`. `service
 * serve|operator|run|list` forwards every argument, `--help` included, to the service.
 * Only words before a standalone `--` count.
 */
export function localHelpArea(argv: string[]): LocalArea | undefined {
  // After a standalone `--` every word is a positional value, even one spelled `--help`.
  const end = argv.indexOf("--");
  const words = end < 0 ? argv : argv.slice(0, end);
  const [area, command] = words;
  if (area === "snapshot") return words.includes("--help") ? area : undefined;
  if (
    area === "service" &&
    (command === "--help" ||
      (LIFECYCLE_COMMANDS.includes(command ?? "") && words.includes("--help")))
  )
    return area;
  return undefined;
}

export const serviceHelp = (area: LocalArea) =>
  area === "service"
    ? `Usage: ensemble service <command> [options]\n\n${SERVICE_COMMANDS}${SERVICE_NOTES}`
    : `Usage: ensemble snapshot <command>\n\n${SNAPSHOT_COMMANDS}`;

const STATE_DIR = "Library/Application Support/Ensemble";
const RECORD_SCHEMA = "ensemble.service/v1";
const NOT_LOADED = 113;
const STOP_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;
const HEALTH_PROBE_MS = 5_000;
// Above the service's own 10 s bound on its slowest readiness checks.
const READINESS_PROBE_MS = 20_000;
// Stops a stalled doctor read.
const DOCTOR_MS = 60_000;

/** An identity from `captureIdentity`, passed back unchanged to `exited`. */
export type ProcessIdentity = object;

/** Everything that reaches launchd, the OS or the network; tests use a fake. */
export type ServiceHost = {
  /** The account's uid: owner of the directories Ensemble checks, and the gui domain. */
  uid: number;
  /** Whether the process runs as root, which every command refuses. */
  isRoot(): boolean;
  /** Where a LaunchDaemon plist is installed. */
  daemonsDir(): string;
  /** Pids listening on TCP `port` on any address (read-only); null when that cannot be established. */
  portOwner(port: number): Promise<number[] | null>;
  launchctl(args: string[]): Promise<{ status: number; stdout: string }>;
  /** Whether `plutil -lint` accepts the file. */
  lint(path: string): Promise<boolean>;
  captureIdentity(pid: number): Promise<ProcessIdentity | null>;
  /** True only when that exact process is confirmed gone. */
  exited(identity: ProcessIdentity): Promise<boolean>;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Moves the staged plist into place; a rename within the LaunchAgents directory. */
  rename(from: string, to: string): void;
  /** A signal that aborts after `ms`; tests shorten it. */
  timeout(ms: number): AbortSignal;
  /** Unpacks a release tarball into `dir`, dropping its top directory; false on failure. */
  extract(tarball: string, dir: string, signal?: AbortSignal): Promise<boolean>;
  /** Opens a URL in the default browser. */
  open(url: string, signal?: AbortSignal): Promise<void>;
  hostname(): string;
  /** The account the service runs as (never `$HOME`): its user name and home directory. */
  account(): { name: string; home: string };
  /** Where the stored github.com login keeps its token; never reads the token. */
  ghTokenStorage(): Promise<GhTokenStorage>;
};

export type GhTokenStorage = "keyring" | "file" | "unknown";
export type ServiceMode = "agent" | "daemon";

/** The interactive CLI work around install; absent when a caller cannot sign in. */
export type InstallCli = {
  interactive: boolean;
  /** Rejects when `signal` aborts. */
  readPassword(prompt: string, signal?: AbortSignal): Promise<string>;
  login(
    connection: string,
    origin: string,
    token: string,
    tokenFile: string | undefined,
    /** Aborts the identity check and the storage; the caller then revokes the credential. */
    signal: AbortSignal,
  ): Promise<void>;
  /** Stops reading when `signal` aborts. */
  doctor(connection: string, signal: AbortSignal): Promise<void>;
};

/** What install adds beyond the LaunchAgent: unpack, password, login, doctor, open. */
export type FirstRun = {
  tarball?: string | undefined;
  cli?: InstallCli | undefined;
  connection: string;
  tokenFile?: string | undefined;
  open: boolean;
  /** Defaults to the LaunchAgent. */
  mode?: ServiceMode | undefined;
};

export type ServiceOptions = {
  stateDir: string;
  logDir: string;
  agentsDir: string;
  /** Where a LaunchDaemon plist is installed; /Library/LaunchDaemons, set only by the CLI and tests. */
  daemonsDir: string;
  /** The uid that must own an installed daemon plist; 0 (root) unless a test says otherwise. */
  daemonPlistOwner?: number | undefined;
  label: string;
  port: number;
  /** Absent keeps the recorded value, null clears it, a number sets it. */
  diagnostic?: { retentionDays?: number | null; storageMib?: number | null };
};

export type ServiceIo = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Aborted on SIGINT; a wait then fails at its stage, so failure handling still runs. */
  signal?: AbortSignal | undefined;
};

/** The upgrade's view of the operator's CLI connection. */
export type OperatorConnection = {
  /** The connection's origin once its token loads; throws when it is unusable. */
  origin(): Promise<string>;
  /** One authenticated readiness read, after the installation identity check; `signal` aborts it. */
  readiness(signal: AbortSignal): Promise<{ id: string; status: string }[]>;
};

const boundedInteger = (bound: Parameters<typeof isInBound>[1]) =>
  z.number().refine((value) => isInBound(value, bound));

const configurationSchema = z
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
type Configuration = z.infer<typeof configurationSchema>;

/** What `captureIdentity` returns on macOS: pid, start time and boot session of the service. */
const processIdentitySchema = z
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

const recordSchema = z
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
     * Daemon only: what Ensemble has seen of the service process under launchd. Absent
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
type InstallRecord = z.infer<typeof recordSchema>;

const manifestSchema = z.object({
  schema: z.literal("ensemble.release/v1"),
  platform: z.literal("darwin-arm64"),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/),
});

/** The first file a release needs to run that is missing from `root`, if any. */
const missingReleaseFile = (root: string) =>
  [
    join(root, "node", "bin", "node"),
    join(root, "dist", "src", "standalone", "cli.js"),
  ].find((file) => !lstatSync(file, { throwIfNoEntry: false })?.isFile());

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A failure with a fixed message; raw causes can hold paths or secrets and are never shown. */
class ServiceFailure extends Error {}

const refuse = (message: string) => new ServiceFailure(message);
const sha256 = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

class Service {
  readonly origin: string;
  readonly target: string;
  readonly activation: string;
  readonly launchdDir: string;
  /** LaunchDaemon: the job's launchd target and the plist as staged and as installed. */
  readonly systemTarget: string;
  readonly stagedDaemon: string;
  readonly installedDaemon: string;
  readonly recordPath: string;
  readonly dataDir: string;
  readonly authFile: string;
  /** Set once a bootout's process exit could not be confirmed. */
  exitUnconfirmed = false;
  /** Failure handling finishes its bounded stop even after an interrupt. */
  cleaningUp = false;

  constructor(
    readonly options: ServiceOptions,
    readonly host: ServiceHost,
    readonly io: ServiceIo,
  ) {
    const { stateDir, agentsDir, label, port } = options;
    this.origin = `http://127.0.0.1:${port}`;
    this.target = `gui/${host.uid}/${label}`;
    this.activation = join(agentsDir, `${label}.plist`);
    this.launchdDir = join(stateDir, "launchd");
    this.systemTarget = `system/${label}`;
    this.stagedDaemon = join(this.launchdDir, `${label}.plist`);
    this.installedDaemon = join(options.daemonsDir, `${label}.plist`);
    this.recordPath = join(this.launchdDir, `${label}.json`);
    this.dataDir = join(stateDir, "data");
    this.authFile = join(stateDir, "auth", "operator-auth.json");
  }

  write(stream: "stdout" | "stderr", value: object) {
    this.io[stream].write(`${JSON.stringify(value)}\n`);
  }

  stamp(): string {
    return new Date(this.host.now())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+/, "");
  }

  /** A real, canonical directory this user owns; `exclusive` also forbids group and other access. */
  requireDirectory(path: string, name: string, exclusive: boolean) {
    let ok = false;
    try {
      const state = lstatSync(path);
      ok =
        realpathSync(path) === path &&
        state.isDirectory() &&
        state.uid === this.host.uid &&
        (state.mode & (exclusive ? 0o077 : 0o022)) === 0;
    } catch {
      ok = false;
    }
    if (!ok)
      throw refuse(
        `${name} ${path} must be a real directory you own${exclusive ? " with mode 700" : " that only you can write"}`,
      );
  }

  /** The unpacked release directory's version, from its validated manifest. */
  releaseVersion(root: string): string {
    this.requireDirectory(this.options.stateDir, "State directory", false);
    const versions = join(this.options.stateDir, "versions");
    let canonical = false;
    try {
      canonical =
        realpathSync(root) === root &&
        realpathSync(versions) === versions &&
        dirname(root) === versions;
    } catch {
      canonical = false;
    }
    if (!canonical)
      throw refuse(`The release must be an unpacked directory in ${versions}`);
    let version: string | undefined;
    try {
      version = manifestSchema.parse(
        JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
      ).version;
    } catch {
      version = undefined;
    }
    if (version !== basename(root))
      throw refuse(
        "The release's manifest.json does not describe its version directory",
      );
    const missing = missingReleaseFile(root);
    if (missing)
      throw refuse(`The release is incomplete: ${missing} is missing`);
    return version;
  }

  /**
   * Unpack `tarball` into STATE/versions/<manifest version> through a staging directory,
   * publishing it only once complete. An existing complete version with the same manifest
   * is reused and a complete one with a different manifest is refused; an incomplete one
   * cannot be a running release, so it is replaced.
   */
  async unpack(tarball: string): Promise<string> {
    const { stateDir } = this.options;
    this.requireDirectory(stateDir, "State directory", false);
    const versions = join(stateDir, "versions");
    mkdirSync(versions, { recursive: true, mode: 0o700 });
    if (realpathSync(versions) !== versions)
      throw refuse(`${versions} must be a real directory`);
    // A killed install leaves its staging directory, named for its pid.
    for (const name of readdirSync(versions)) {
      const pid = /^\.staging-(\d+)-/.exec(name)?.[1];
      if (pid && !processAlive(Number(pid)))
        rmSync(join(versions, name), { recursive: true, force: true });
    }
    const staging = mkdtempSync(join(versions, `.staging-${process.pid}-`));
    const aside = `${staging}-old`;
    try {
      const unpacked = await this.host.extract(
        tarball,
        staging,
        this.io.signal,
      );
      // An interrupt kills the extraction; report it as such, not as a bad tarball.
      this.checkInterrupt();
      if (!unpacked)
        throw new ServiceFailure("The tarball could not be unpacked");
      let manifest: Buffer;
      let version: string;
      try {
        manifest = readFileSync(join(staging, "manifest.json"));
        version = manifestSchema.parse(
          JSON.parse(manifest.toString("utf8")),
        ).version;
      } catch {
        throw refuse("The tarball holds no valid release manifest.json");
      }
      const missing = missingReleaseFile(staging);
      if (missing)
        throw refuse(
          `The tarball's release is incomplete: ${relative(staging, missing)} is missing`,
        );
      const target = join(versions, version);
      const existing = lstatSync(target, { throwIfNoEntry: false });
      if (existing) {
        let same = false;
        try {
          same = readFileSync(join(target, "manifest.json")).equals(manifest);
        } catch {
          same = false;
        }
        if (existing.isDirectory() && !missingReleaseFile(target)) {
          if (same) return target;
          throw refuse(`${target} already holds a different release`);
        }
        renameSync(target, aside);
      }
      renameSync(staging, target);
      return target;
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(aside, { recursive: true, force: true });
    }
  }

  readRecord(): InstallRecord | null {
    if (!existsSync(this.recordPath)) return null;
    try {
      const record = recordSchema.parse(
        JSON.parse(readFileSync(this.recordPath, "utf8")),
      );
      if (record.label === this.options.label) return record;
    } catch {
      // Reported below with a fixed message.
    }
    throw refuse(`The install record ${this.recordPath} is invalid`);
  }

  writeRecord(record: InstallRecord) {
    const temporary = `${this.recordPath}.${process.pid}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.recordPath);
    const directory = openSync(dirname(this.recordPath), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  /** What the record says: absent, the mode it holds, or unreadable. */
  recordMode(): "none" | ServiceMode | "invalid" {
    if (!existsSync(this.recordPath)) return "none";
    try {
      return this.readRecord()?.mode ?? "none";
    } catch {
      return "invalid";
    }
  }

  /** The label's launchd job (the LaunchAgent unless `target` says otherwise), or null when it is not loaded. */
  async loadedJob(target = this.target): Promise<{
    path: string | undefined;
    pid: number | undefined;
  } | null> {
    const result = await this.host.launchctl(["print", target]);
    if (result.status === NOT_LOADED) return null;
    if (result.status !== 0) throw new ServiceFailure("launchctl print failed");
    // Top-level fields are indented by exactly one tab; nested sections by more.
    const field = (name: string) =>
      new RegExp(`^\\t${name} = (.*)$`, "m").exec(result.stdout)?.[1];
    const pid = field("pid");
    return {
      path: field("path"),
      pid: pid && /^[1-9]\d*$/.test(pid) ? Number(pid) : undefined,
    };
  }

  /** The loaded job and the activation file are ours: exact path and the recorded plist hash. */
  requireOwned(
    record: InstallRecord | null,
    job: { path: string | undefined } | null,
  ) {
    const activation = existsSync(this.activation);
    const activationOwned =
      !activation ||
      (record !== null && sha256(this.activation) === record.plistSha256);
    const jobOwned =
      job === null || (job.path === this.activation && activation);
    if (!activationOwned || !jobOwned)
      throw refuse(
        `The ${this.options.label} job or ${this.activation} was not created by this installation; nothing was changed`,
      );
  }

  /** Boot out the owned job, if it is loaded, and confirm that its process exited. */
  async stopOwned(record: InstallRecord | null) {
    const job = await this.loadedJob();
    if (!job) return;
    this.requireOwned(record, job);
    const identity =
      job.pid === undefined ? null : await this.host.captureIdentity(job.pid);
    if (job.pid !== undefined && !identity)
      throw new ServiceFailure(
        "The job's process identity could not be read; nothing was stopped",
      );
    // A bootout error can race the job's own exit; the poll below decides.
    await this.host.launchctl(["bootout", this.target]);
    const deadline = this.host.now() + STOP_TIMEOUT_MS;
    try {
      for (;;) {
        if (
          (await this.loadedJob()) === null &&
          (!identity || (await this.host.exited(identity)))
        )
          return;
        if (this.host.now() >= deadline)
          throw new ServiceFailure("process exit unconfirmed");
        // Once bootout is issued the bounded confirmation runs to the end, even after an
        // interrupt; the next stage then fails with the exit confirmed or reported unconfirmed.
        await this.host.sleep(POLL_MS);
      }
    } catch (error) {
      // The exit was never confirmed; cleanup must not report the job stopped.
      this.exitUnconfirmed = true;
      throw error;
    }
  }

  /**
   * After a failure: stop the owned job, then remove the activation file once the label is
   * gone so that nothing starts at login. Returns whether the job is confirmed stopped.
   */
  async leaveStopped(record: InstallRecord | null): Promise<boolean> {
    let stopped = false;
    this.cleaningUp = true;
    try {
      await this.stopOwned(record);
      stopped = !this.exitUnconfirmed;
    } catch {
      stopped = false;
    }
    try {
      if ((await this.loadedJob()) === null)
        rmSync(this.activation, { force: true });
    } catch {
      // The activation file stays; the job is reported as not confirmed stopped.
    }
    return stopped;
  }

  prepareDirectories(daemon = false) {
    const { stateDir, logDir, agentsDir } = this.options;
    for (const [path, name, exclusive] of [
      // A daemon is staged in the launchd directory; nothing is written to the LaunchAgents one.
      ...(daemon
        ? []
        : ([[agentsDir, "LaunchAgents directory", false]] as const)),
      [logDir, "Log directory", true],
      [this.dataDir, "Data directory", true],
      [join(stateDir, "snapshots"), "Snapshot directory", true],
      [this.launchdDir, "launchd directory", true],
    ] as const) {
      if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
      this.requireDirectory(path, name, exclusive);
    }
  }

  /**
   * Render, lint and record the version's LaunchAgent, then move it into place. The record
   * is written first, so an interrupted activation still leaves a record to recover from.
   */
  async activate(
    version: string,
    root: string,
    base: Pick<
      Configuration,
      | "dataDirectory"
      | "authFile"
      | "origin"
      | "port"
      | "diagnosticRetentionDays"
      | "diagnosticStorageMib"
    >,
    daemon = false,
  ): Promise<{ record: InstallRecord; logs: string[] }> {
    const { label, logDir, diagnostic } = this.options;
    const resolved = (override: number | null | undefined, kept?: number) =>
      override === undefined ? kept : (override ?? undefined);
    const retention = resolved(
      diagnostic?.retentionDays,
      base.diagnosticRetentionDays,
    );
    const storage = resolved(diagnostic?.storageMib, base.diagnosticStorageMib);
    const prefix = join(logDir, `${label}.${version}.${this.stamp()}`);
    const account = daemon ? this.host.account() : undefined;
    const destination = daemon ? this.stagedDaemon : this.activation;
    const configuration: Configuration = {
      label,
      nodePath: join(root, "node", "bin", "node"),
      cliPath: join(root, "dist", "src", "standalone", "cli.js"),
      dataDirectory: base.dataDirectory,
      authFile: base.authFile,
      origin: base.origin,
      port: base.port,
      stdoutPath: `${prefix}.out.log`,
      stderrPath: `${prefix}.err.log`,
      ...(retention === undefined
        ? {}
        : { diagnosticRetentionDays: retention }),
      ...(storage === undefined ? {} : { diagnosticStorageMib: storage }),
      ...(account ? { userName: account.name, home: account.home } : {}),
    };
    const logs = [configuration.stdoutPath, configuration.stderrPath];
    // Staged beside the activation so the final rename stays on one filesystem; launchd
    // loads only the directory's own .plist files, not this private subdirectory.
    const staging = mkdtempSync(
      join(dirname(destination), `.${label}.staging-`),
    );
    try {
      const staged = join(staging, `${label}.plist`);
      const { writeLaunchAgent } = await import("../standalone/launchd.js");
      try {
        writeLaunchAgent(configuration, staged);
      } catch {
        throw new ServiceFailure("The LaunchAgent configuration is invalid");
      }
      if (!(await this.host.lint(staged)))
        throw new ServiceFailure("plutil -lint rejected the plist");
      const record: InstallRecord = {
        schema: RECORD_SCHEMA,
        mode: daemon ? "daemon" : "agent",
        label,
        version,
        plistSha256: sha256(staged),
        configuration,
      };
      this.writeRecord(record);
      this.host.rename(staged, destination);
      return { record, logs };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async bootstrap() {
    const result = await this.host.launchctl([
      "bootstrap",
      `gui/${this.host.uid}`,
      this.activation,
    ]);
    if (result.status !== 0)
      throw new ServiceFailure("launchctl bootstrap failed");
  }

  daemonMismatch() {
    return refuse(
      `The ${this.options.label} job or ${this.installedDaemon} does not match the install record; nothing was changed`,
    );
  }

  /**
   * The installed daemon plist's hash, or null when it is absent. It must be a regular file
   * (never a symlink) owned by root and writable by no one else, as launchd itself requires;
   * the checks and the hash read one open descriptor.
   */
  installedDaemonHash(): string | null {
    let fd: number;
    try {
      fd = openSync(
        this.installedDaemon,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw this.daemonMismatch();
    }
    try {
      const state = fstatSync(fd);
      if (
        !state.isFile() ||
        state.uid !== (this.options.daemonPlistOwner ?? 0) ||
        (state.mode & 0o022) !== 0
      )
        throw this.daemonMismatch();
      return createHash("sha256").update(readFileSync(fd)).digest("hex");
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Folds what launchd runs now into the record: reads `launchctl print` output and the
   * process table only, and writes only the install record, atomically (temp file and
   * rename in the same directory, fsynced), and only when it changed. Observations only
   * move up and an identity is dropped only once its exit is confirmed, so a loaded job
   * with no pid yet is remembered as maybe-started, never as never-started. A record that
   * cannot be written stays as it was and fails the command with a fixed message.
   */
  async observeDaemon(
    record: InstallRecord,
    job: { pid: number | undefined },
  ): Promise<{ record: InstallRecord; seen: Seen }> {
    let seen: Seen = "no-process";
    if (job.pid !== undefined) {
      const parsed = processIdentitySchema.safeParse(
        await this.host.captureIdentity(job.pid),
      );
      seen = parsed.success ? parsed.data : "unreadable";
    }
    const previous = record.observed && {
      ...record.observed,
      processes: await this.unconfirmed(record.observed.processes),
    };
    const observed = refineObserved(previous, seen);
    if (JSON.stringify(observed) === JSON.stringify(record.observed))
      return { record, seen };
    const next: InstallRecord = { ...record, observed };
    try {
      this.writeRecord(next);
    } catch {
      throw new ServiceFailure(
        "The install record could not be updated with the running service process; nothing was changed",
      );
    }
    return { record: next, seen };
  }

  /** The recorded processes whose exit is not confirmed. */
  async unconfirmed(processes: Observed["processes"]) {
    const gone = await Promise.all(
      processes.map((process) => this.host.exited(process)),
    );
    return processes.filter((_, index) => !gone[index]);
  }

  /** The facts about the daemon that both verification and uninstall decide on. */
  async daemonFacts(
    operation: DaemonFacts["operation"],
    record: InstallRecord,
    job: Job,
    plistPresent: boolean,
    extra: Pick<DaemonFacts, "identityRead" | "listener">,
  ): Promise<DaemonFacts> {
    const { port, stdoutPath, stderrPath } = record.configuration;
    // Only an uninstall that could complete needs the process, port and log evidence.
    const settled =
      operation === "uninstall" && job.state === "absent" && !plistPresent;
    return {
      operation,
      job,
      plistPresent,
      observed: record.observed,
      processesGone: settled
        ? (await this.unconfirmed(record.observed?.processes ?? [])).length ===
          0
        : true,
      portBusy: settled ? !(await portIsFree(port)) : false,
      logsPresent: settled
        ? [stdoutPath, stderrPath].some(
            (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined,
          )
        : false,
      ...extra,
    };
  }

  /** The hold message: what is unconfirmed and the read-only checks, then the way on. */
  holdMessage(
    kind: "stopped" | "running",
    reason: string,
    record: InstallRecord,
  ): string {
    const { label } = this.options;
    const { port, cliPath } = record.configuration;
    const checks = `Check that \`launchctl print ${this.systemTarget}\` ${kind === "stopped" ? "exits 113" : "shows a pid"}, that \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` ${kind === "stopped" ? "prints nothing" : "lists only that pid"} and that \`ps -axo pid,lstart,command\` shows ${kind === "stopped" ? `no ${shellWord(cliPath)} process` : `that pid running ${shellWord(cliPath)}`}`;
    return kind === "stopped"
      ? `The ${label} service could not be confirmed stopped (${reason}); the install record is kept. ${checks}; then run \`ensemble service uninstall\` again, or, once you have confirmed none is running, remove ${shellWord(this.recordPath)} and ${shellWord(this.stagedDaemon)} yourself`
      : `The ${label} service could not be confirmed running (${reason}); the install record is kept. ${checks}; then run the install command again, or \`ensemble service uninstall\` to remove the daemon`;
  }

  /** Whether the staged plist is the one the record describes. */
  stagedDaemonMatches(record: InstallRecord): boolean {
    try {
      return sha256(this.stagedDaemon) === record.plistSha256;
    } catch {
      return false;
    }
  }

  /** Whether any artifact of the mode other than `installing` is present, whoever made it. */
  async otherModeConflict(installing: ServiceMode): Promise<boolean> {
    const present = (path: string) =>
      lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    if (installing === "agent")
      return (
        this.recordMode() === "daemon" ||
        (await this.loadedJob(this.systemTarget)) !== null ||
        present(this.installedDaemon)
      );
    return (
      this.recordMode() === "agent" ||
      (await this.loadedJob()) !== null ||
      present(this.activation)
    );
  }

  /** The command that verifies a daemon install: the installed release's own CLI, no TARBALL. */
  verifyCommand(version: string): string {
    const { stateDir, label, port } = this.options;
    const cli = join(stateDir, "versions", version, "bin", "ensemble");
    return `${shellWord(cli)} service install --mode daemon --state-dir ${shellWord(stateDir)} --label ${label} --port ${port}`;
  }

  /** The commands the operator runs with sudo to install and start the staged daemon plist. */
  installSteps(alreadyInstalled = false): string[] {
    const installed = shellWord(this.installedDaemon);
    return [
      // A root-owned copy that already matches the record is not copied again from the
      // operator-writable staged file; only loading it remains.
      ...(alreadyInstalled
        ? []
        : [
            `sudo /usr/bin/install -m 0644 -o root -g wheel ${shellWord(this.stagedDaemon)} ${installed}`,
          ]),
      `sudo /bin/launchctl bootstrap system ${installed}`,
    ];
  }

  checkInterrupt() {
    if (this.io.signal?.aborted && !this.cleaningUp)
      throw new ServiceFailure("interrupted");
  }

  async pause() {
    this.checkInterrupt();
    await this.host.sleep(POLL_MS);
  }

  /**
   * Poll until `probe` returns a value, or fail with `message` after the deadline. Each probe
   * is bounded by the remaining deadline and the interrupt, even if it ignores its signal.
   */
  async waitFor<T>(
    message: string,
    probeMs: number,
    probe: (signal: AbortSignal) => Promise<T | undefined>,
  ): Promise<T> {
    const deadline = this.host.now() + START_TIMEOUT_MS;
    for (;;) {
      this.checkInterrupt();
      const remaining = Math.max(1, deadline - this.host.now());
      const signal = AbortSignal.any([
        this.host.timeout(Math.min(probeMs, remaining)),
        ...(this.io.signal ? [this.io.signal] : []),
      ]);
      let value: T | undefined;
      try {
        value = await bounded(probe(signal), signal);
      } catch {
        value = undefined; // Not ready yet, or this probe timed out.
      }
      // An interrupt during a probe wins over its result.
      this.checkInterrupt();
      if (value !== undefined) return value;
      if (this.host.now() >= deadline) throw new ServiceFailure(message);
      await this.pause();
    }
  }

  /** One readiness read; refuses before anything is stopped when the connection cannot make it. */
  async requireReadable(connection: OperatorConnection) {
    const signal = AbortSignal.any([
      this.host.timeout(READINESS_PROBE_MS),
      ...(this.io.signal ? [this.io.signal] : []),
    ]);
    try {
      await bounded(connection.readiness(signal), signal);
    } catch {
      this.checkInterrupt();
      throw refuse(
        "The CLI connection cannot read readiness; run `ensemble auth login` with a read credential first",
      );
    }
  }

  /**
   * Waits for `/app` on the daemon's origin answering 200 while the listener on its port is
   * the job's own pid; returns who holds the port when that never happens, and throws the
   * usual health failure when the job's process listens but does not serve.
   */
  async waitForListener(
    pid: number,
    configuration: Pick<Configuration, "port" | "origin">,
  ): Promise<Listener> {
    let listener = "free" as Listener;
    try {
      await this.waitFor(
        "The service did not serve /app within 120 s",
        HEALTH_PROBE_MS,
        async (signal) => {
          const owners = await this.host.portOwner(configuration.port);
          listener =
            owners === null
              ? "unknown"
              : owners.length === 0
                ? "free"
                : owners.every((owner) => owner === pid)
                  ? "ours"
                  : "foreign";
          if (listener !== "ours") return undefined;
          const response = await this.host.fetch(
            `${configuration.origin}/app`,
            {
              signal,
            },
          );
          await response.body?.cancel();
          return response.status === 200 ? true : undefined;
        },
      );
    } catch (error) {
      // An interrupt, or the job's own process listening without serving, is a failure.
      if (this.io.signal?.aborted || listener === "ours") throw error;
    }
    return listener;
  }

  waitForApp(origin: string) {
    return this.waitFor(
      "The service did not serve /app within 120 s",
      HEALTH_PROBE_MS,
      async (signal) => {
        const response = await this.host.fetch(`${origin}/app`, { signal });
        await response.body?.cancel();
        return response.status === 200 ? true : undefined;
      },
    );
  }
}

/** Settles with `promise`, or rejects once `signal` aborts. */
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {}); // A late rejection after the abort is expected.
  return new Promise((done, fail) => {
    const abort = () => fail(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(done, fail)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Run one lifecycle command under an owner-only per-label lock file in the state directory,
 * so overlapping commands never act on the same job. A live holder is never displaced; a
 * stale lock (its process gone) is removed by the operator, as the error says.
 */
async function withLock(
  options: ServiceOptions,
  host: ServiceHost,
  io: ServiceIo,
  operation: string,
  run: () => Promise<number>,
): Promise<number> {
  const path = join(options.stateDir, `.${options.label}.lock`);
  // Without a state directory nothing is installed and nothing can install concurrently.
  if (!existsSync(options.stateDir)) return run();
  try {
    const holderProcess = await host.captureIdentity(process.pid);
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, process: holderProcess })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    let holder = "";
    try {
      holder = ` (pid ${z.object({ pid: z.number() }).parse(JSON.parse(readFileSync(path, "utf8"))).pid})`;
    } catch {
      // Unreadable lock: report it without a pid.
    }
    io.stderr.write(
      `${JSON.stringify({
        ok: false,
        operation,
        stage: "preflight",
        error:
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? `Another service command holds ${path}${holder}; nothing was changed. If that process has exited (check with ps -p), remove ${path} and retry.`
            : `Could not create the lock file ${path}`,
        jobStopped: null,
      })}\n`,
    );
    return 1;
  }
  try {
    return await run();
  } finally {
    rmSync(path, { force: true });
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

const message = (error: unknown) =>
  error instanceof ServiceFailure ? error.message : "operation failed";

/**
 * Sign in with the operator password over the session API the UI uses, issue one 90-day read
 * credential and hand its token to `store`. The session is always logged out again, and a
 * credential that could not be stored is revoked. Cleanup ignores the interrupt but is
 * bounded, and its result is verified: `credentialActive` and `sessionOpen` report a revoke
 * or logout that did not succeed, so the caller can tell the operator.
 */
export async function issueInstallCredential(
  host: ServiceHost,
  origin: string,
  password: string,
  name: string,
  store: (token: string, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<{
  outcome: "stored" | "wrong-password" | "failed";
  /** A minted credential that could not be confirmed revoked. */
  credentialActive: boolean;
  /** The sign-in session that could not be confirmed logged out. */
  sessionOpen: boolean;
}> {
  let cookie = "";
  let credentialActive = false;
  let sessionOpen = false;
  let csrf = "";
  // Cleanup calls ignore the interrupt: a minted credential must still be revoked.
  const call = async (
    method: string,
    path: string,
    body?: object,
    interruptible = true,
  ) => {
    const response = await host.fetch(`${origin}${path}`, {
      method,
      headers: {
        origin,
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([
        host.timeout(HEALTH_PROBE_MS),
        ...(interruptible && signal ? [signal] : []),
      ]),
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return response;
  };
  const nextSession = async (response: Response) => {
    csrf = sessionSchema.parse(await response.json()).csrfToken;
  };
  // One retry: a revoke that is not confirmed leaves a 90-day credential active.
  const revoke = async (id: string) => {
    for (let attempt = 0; attempt < 2; attempt += 1)
      try {
        const response = await call(
          "POST",
          `/api/operator/credentials/${id}/revoke`,
          {},
          false,
        );
        await response.body?.cancel();
        if (response.ok) return true;
      } catch {
        // Retried once, then reported.
      }
    return false;
  };
  let signedIn = false;
  // A login the server may have accepted whose reply never arrived: its session cannot be closed.
  let loginPending = false;
  let mintAccepted = false;
  let outcome: "stored" | "wrong-password" | "failed" = "failed";
  const attempt = async () => {
    await nextSession(await call("GET", "/api/operator/session"));
    loginPending = true;
    const login = await call("POST", "/api/operator/login", { password });
    loginPending = false;
    if (login.status === 401) {
      await login.body?.cancel();
      outcome = "wrong-password";
      return;
    }
    if (login.status !== 200) return;
    signedIn = true;
    await nextSession(login);
    // Nothing is minted once interrupted; past this point the mint is not interruptible, as an
    // abort after the server minted it would orphan the credential.
    if (signal?.aborted) return;
    // A mint that times out or resets in flight may still exist on the server.
    mintAccepted = true;
    const minted = await call(
      "POST",
      "/api/operator/credentials",
      { name, scope: "read", expiresInDays: 90 },
      false,
    );
    mintAccepted = minted.ok;
    const issued = operatorCredentialIssuedSchema.parse(await minted.json());
    mintAccepted = false;
    try {
      // `store` is awaited to the end so that what it persisted always matches what is
      // reported; its signal bounds and cancels its network check, and a failure revokes.
      await store(
        issued.token,
        AbortSignal.any([
          host.timeout(READINESS_PROBE_MS),
          ...(signal ? [signal] : []),
        ]),
      );
    } catch {
      credentialActive = !(await revoke(issued.credential.id));
      return;
    }
    outcome = "stored";
    return;
  };
  try {
    await attempt();
  } catch {
    // A mint the server accepted but whose reply was unusable cannot be revoked by id.
    credentialActive ||= mintAccepted;
    sessionOpen ||= loginPending;
  } finally {
    // The result is read after this runs, so a failed logout is reported.
    if (signedIn)
      sessionOpen = !(await call("POST", "/api/operator/logout", {}, false)
        .then(async (r) => {
          await r.body?.cancel();
          return r.ok;
        })
        .catch(() => false));
  }
  return { outcome, credentialActive, sessionOpen };
}

/**
 * Refuses before any lock, directory or launchctl call when the command runs as root:
 * Ensemble never runs as root, and a root-owned state tree would break the real owner.
 */
async function refusedAsRoot(
  host: ServiceHost,
  io: ServiceIo,
  operation: string,
): Promise<number | null> {
  if (!host.isRoot()) return null;
  const { ROOT_REFUSAL } = await import("../standalone/launchd.js");
  io.stderr.write(
    `${JSON.stringify({ ok: false, operation, stage: "preflight", error: ROOT_REFUSAL, jobStopped: null })}\n`,
  );
  return 1;
}

/** Install the LaunchAgent (or prepare the LaunchDaemon) for the release at `releaseRoot`; undoes itself on failure. */
export async function installService(
  options: ServiceOptions,
  releaseRoot: string,
  host: ServiceHost,
  io: ServiceIo,
  first: FirstRun = { connection: "local", open: false },
): Promise<number> {
  const refused = await refusedAsRoot(host, io, "install");
  if (refused !== null) return refused;
  // A first install has no state directory yet; create it so the lock below covers it.
  try {
    if (
      first.tarball &&
      statSync(first.tarball, { throwIfNoEntry: false })?.isFile()
    )
      mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  } catch {
    // The locked preflight reports what is wrong.
  }
  return withLock(options, host, io, "install", () =>
    installServiceLocked(options, releaseRoot, host, io, first),
  );
}

const NO_JOB_STAGES = ["preflight", "unpack", "auth"];

async function installServiceLocked(
  options: ServiceOptions,
  releaseRoot: string,
  host: ServiceHost,
  io: ServiceIo,
  first: FirstRun,
): Promise<number> {
  const service = new Service(options, host, io);
  const { tarball, cli } = first;
  const daemon = (first.mode ?? "agent") === "daemon";
  let stage = "preflight";
  let record: InstallRecord | null = null;
  let logs: string[] = [];
  try {
    let root = releaseRoot;
    let version = tarball ? undefined : service.releaseVersion(root);
    if (tarball) {
      try {
        accessSync(tarball, constants.R_OK);
      } catch {
        throw refuse(`${tarball} is not a readable file`);
      }
      if (!statSync(tarball).isFile())
        throw refuse(`${tarball} is not a readable file`);
    }
    if (cli && first.tokenFile) {
      // Found only after the mint it would waste a credential.
      if (lstatSync(first.tokenFile, { throwIfNoEntry: false }))
        throw refuse(
          `${first.tokenFile} already exists; choose another --token-file`,
        );
      if (!existsSync(dirname(first.tokenFile)))
        throw refuse(`The directory for ${first.tokenFile} does not exist`);
    }
    if (await service.otherModeConflict(daemon ? "daemon" : "agent"))
      throw refuse(
        `${options.label} is already present in ${daemon ? "agent" : "daemon"} mode; run \`ensemble service uninstall\` first (a daemon prints sudo steps to finish), then install in ${daemon ? "daemon" : "agent"} mode. Nothing was changed`,
      );
    if (daemon && service.recordMode() === "daemon") {
      if (tarball)
        throw refuse(
          `${options.label} is already installed as a daemon; verify it with the install command and no TARBALL, or run \`ensemble service uninstall\` before installing another release`,
        );
      stage = "verify";
      return await verifyDaemon(service, first, version as string, (next) => {
        stage = next;
      });
    }
    if (await service.loadedJob(daemon ? service.systemTarget : undefined))
      throw refuse(`The ${options.label} job is already loaded`);
    if (
      existsSync(service.recordPath) ||
      (daemon
        ? lstatSync(service.installedDaemon, { throwIfNoEntry: false }) !==
          undefined
        : existsSync(service.activation))
    )
      throw refuse(
        `${options.label} is already installed; use service upgrade or service uninstall`,
      );
    const authMissing = !existsSync(service.authFile);
    if (authMissing && !cli?.interactive)
      throw refuse(
        `${service.authFile} is missing; run install in an interactive terminal or run \`ensemble service init-auth\``,
      );
    if (!(await portIsFree(options.port)))
      throw refuse(`Port ${options.port} on 127.0.0.1 is in use`);
    // The one password prompt. A cancelled prompt only skips sign-in, unless the password
    // is needed to create the auth file.
    let password: string | undefined;
    service.checkInterrupt();
    // A daemon install signs in nowhere, so it asks only to create a missing auth file.
    if (cli?.interactive && (!daemon || authMissing))
      try {
        password =
          (await cli.readPassword(
            authMissing
              ? "New Ensemble operator password: "
              : "Ensemble operator password: ",
            io.signal,
          )) || undefined;
      } catch {
        password = undefined;
      }
    service.checkInterrupt();
    if (authMissing && password === undefined)
      throw refuse("An operator password is required to create the auth file");
    if (tarball) {
      stage = "unpack";
      root = await service.unpack(tarball);
      version = service.releaseVersion(root);
    }
    service.checkInterrupt();
    if (authMissing && password !== undefined) {
      stage = "auth";
      mkdirSync(dirname(service.authFile), { recursive: true, mode: 0o700 });
      const { OperatorAuth } = await import("../standalone/operator-auth.js");
      try {
        await OperatorAuth.initialize(service.authFile, password);
      } catch {
        throw new ServiceFailure("The operator auth file could not be created");
      }
    }
    service.checkInterrupt();
    stage = "render";
    service.prepareDirectories(daemon);
    ({ record, logs } = await service.activate(
      version as string,
      root,
      {
        dataDirectory: service.dataDir,
        authFile: service.authFile,
        origin: service.origin,
        port: options.port,
      },
      daemon,
    ));
    if (daemon) {
      // Nothing reaches launchd: the operator runs the printed steps with sudo.
      await finishDaemonInstall(service, version as string, logs, false, false);
      return 0;
    }
    service.checkInterrupt();
    stage = "start";
    await service.bootstrap();
    stage = "health";
    await service.waitForApp(service.origin);
    // From here the service stays installed whatever happens: nothing below may throw.
    const signInResult = await signIn(service, first, password);
    const { connection, credentialActive, sessionOpen } = signInResult;
    service.write("stdout", {
      ok: true,
      operation: "install",
      mode: "agent",
      label: options.label,
      version,
      origin: service.origin,
      plist: service.activation,
      logs,
      connection,
      credentialActive,
      sessionOpen,
    });
    await finishInstall(service, first, signInResult);
    return 0;
  } catch (error) {
    let jobStopped: boolean | null = null;
    if (daemon) {
      // No job was touched. A render that failed after the record was written removes the
      // record (the first run proved none existed) and this label's staged plist in our own
      // private directory.
      if (stage === "render") {
        rmSync(service.recordPath, { force: true });
        rmSync(service.stagedDaemon, { force: true });
      }
    } else if (!NO_JOB_STAGES.includes(stage)) {
      jobStopped = await service.leaveStopped(record);
      // Without a confirmed exit the record stays, so uninstall can finish the job.
      try {
        if (jobStopped) rmSync(service.recordPath, { force: true });
      } catch {
        jobStopped = false;
      }
    }
    service.write("stderr", {
      ok: false,
      operation: "install",
      stage,
      error: message(error),
      jobStopped,
      logs,
    });
    return 1;
  }
}

const GH_KEYCHAIN_WARNING =
  "The GitHub CLI login is in the login keychain, which a LaunchDaemon cannot read before you log in; run `gh auth login --insecure-storage` on this Mac (see the macOS operations guide).";

/** The fixed keychain warning, written without failing the install. */
async function warnGhKeychain(service: Service) {
  try {
    if ((await service.host.ghTokenStorage()) === "keyring")
      service.io.stderr.write(`${GH_KEYCHAIN_WARNING}\n`);
  } catch {
    // A warning only.
  }
}

/**
 * Report a daemon install: either it still needs the operator's sudo steps (`started` false)
 * or launchd already runs the verified plist. Never throws past its caller's catch.
 */
async function finishDaemonInstall(
  service: Service,
  version: string,
  logs: string[],
  started: boolean,
  alreadyInstalled: boolean,
  first?: FirstRun,
) {
  const steps = started ? [] : service.installSteps(alreadyInstalled);
  service.write("stdout", {
    ok: true,
    operation: "install",
    mode: "daemon",
    label: service.options.label,
    version,
    origin: service.origin,
    plist: started ? service.installedDaemon : service.stagedDaemon,
    logs,
    started,
    steps,
  });
  await warnGhKeychain(service);
  if (first) {
    // Verifying never opens the browser; the app URL is still printed.
    await finishInstall(
      service,
      { ...first, open: false },
      {
        connection: null,
        credentialName: "",
        credentialActive: false,
        sessionOpen: false,
      },
    );
    return;
  }
  const line = (text: string) => service.io.stderr.write(`${text}\n`);
  line("Run these commands to install and start the service at boot:");
  for (const step of steps) line(step);
  line(
    `Then run the same install command again, with the same options and no TARBALL, to verify: ${service.verifyCommand(version)}`,
  );
}

/**
 * Re-run of a daemon install: confirms what launchd and /Library hold against the record.
 * It changes nothing there and writes only the install record, to note the running service
 * process. Running and matching: wait for /app. Otherwise reprint the steps.
 */
async function verifyDaemon(
  service: Service,
  first: FirstRun,
  version: string,
  setStage: (stage: string) => void,
): Promise<number> {
  const record = service.readRecord() as InstallRecord;
  if (version !== record.version)
    throw refuse(
      `${record.label} is installed at ${record.version}; run \`ensemble service uninstall\` before installing ${version}`,
    );
  if (service.options.port !== record.configuration.port)
    throw refuse(
      `${record.label} is installed on port ${record.configuration.port}; pass --port ${record.configuration.port}`,
    );
  const job = await service.loadedJob(service.systemTarget);
  const installed = service.installedDaemonHash();
  if (
    (installed !== null && installed !== record.plistSha256) ||
    (job !== null &&
      (job.path !== service.installedDaemon || installed === null))
  )
    throw service.daemonMismatch();
  const logs = [
    record.configuration.stdoutPath,
    record.configuration.stderrPath,
  ];
  if (job !== null) {
    // What this run sees is recorded first: a record that cannot be written fails here.
    const { record: observed, seen } = await service.observeDaemon(record, job);
    setStage("health");
    // Started means this job's own process serves the port, not merely that something does.
    const listener: Listener =
      job.pid !== undefined && seen !== "unreadable"
        ? await service.waitForListener(job.pid, observed.configuration)
        : "free";
    const decision = daemonDecision(
      await service.daemonFacts(
        "verify",
        observed,
        { state: "loaded", pid: job.pid },
        true,
        { identityRead: seen !== "unreadable", listener },
      ),
    );
    if (decision.kind === "hold")
      throw refuse(service.holdMessage("running", decision.reason, observed));
    // It must still be the same process after the wait.
    if ((await service.loadedJob(service.systemTarget))?.pid !== job.pid)
      throw refuse(
        service.holdMessage(
          "running",
          "its process changed while verifying",
          observed,
        ),
      );
    await finishDaemonInstall(service, record.version, logs, true, true, first);
    return 0;
  }
  // Present and matching, not loaded: only loading remains, so the staged copy is not needed.
  if (installed === null && !service.stagedDaemonMatches(record))
    throw refuse(
      `The staged plist ${service.stagedDaemon} does not match the install record; run \`ensemble service uninstall\`, then install again`,
    );
  await finishDaemonInstall(
    service,
    record.version,
    logs,
    false,
    installed !== null,
  );
  return 0;
}

/** What the sign-in left behind: the stored connection name (else null) and any cleanup that failed. */
type SignIn = {
  connection: string | null;
  credentialName: string;
  credentialActive: boolean;
  sessionOpen: boolean;
};

/** Issues and stores the CLI credential. Never throws. */
async function signIn(
  service: Service,
  first: FirstRun,
  password: string | undefined,
): Promise<SignIn> {
  const { cli } = first;
  const none = {
    connection: null,
    credentialName: "",
    credentialActive: false,
    sessionOpen: false,
  };
  if (!cli || password === undefined) return none;
  try {
    const name = [...`install · ${service.host.hostname()}`]
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .slice(0, 64)
      .join("");
    const issued = await issueInstallCredential(
      service.host,
      service.origin,
      password,
      name,
      (token, storing) =>
        cli.login(
          first.connection,
          service.origin,
          token,
          first.tokenFile,
          storing,
        ),
      service.io.signal,
    );
    return {
      connection: issued.outcome === "stored" ? first.connection : null,
      credentialName: name,
      credentialActive: issued.credentialActive,
      sessionOpen: issued.sessionOpen,
    };
  } catch {
    return none;
  }
}

/** Doctor, the manual login line when not signed in, then the app URL. Human lines go to stderr; never throws. */
async function finishInstall(
  service: Service,
  first: FirstRun,
  { connection, credentialName, credentialActive, sessionOpen }: SignIn,
) {
  const app = `${service.origin}/app`;
  const line = (text: string) => service.io.stderr.write(`${text}\n`);
  const interrupted = () => service.io.signal?.aborted === true;
  try {
    if (connection !== null && !interrupted() && first.cli) {
      const stop = AbortSignal.any([
        service.host.timeout(DOCTOR_MS),
        ...(service.io.signal ? [service.io.signal] : []),
      ]);
      // Doctor stops its own reads on `stop`; `bounded` only backs that up.
      await bounded(first.cli.doctor(connection, stop), stop);
    }
  } catch {
    // The URL below is still printed.
  }
  try {
    if (credentialActive)
      line(
        `The credential "${credentialName}" may still be active; revoke it in Settings → CLI credentials.`,
      );
    if (sessionOpen)
      line(
        "The install's sign-in session could not be closed; it ends on its own.",
      );
    if (connection === null) {
      line(
        `Log in the CLI with a read credential from Settings → CLI credentials: ensemble auth login --connection ${first.connection} --url ${service.origin}`,
      );
      line("Then run: ensemble doctor");
    }
    line(`Open ${app}`);
    if (first.open && !interrupted())
      await service.host.open(app, service.io.signal);
  } catch {
    // Install already succeeded; a doctor or open failure is not an install failure.
  }
}

/** Stop, snapshot, re-render for `target`, start and check readiness. Never rolls back. */
export async function upgradeService(
  options: ServiceOptions,
  target: string,
  connection: OperatorConnection,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
  const refused = await refusedAsRoot(host, io, "upgrade");
  if (refused !== null) return refused;
  return withLock(options, host, io, "upgrade", () =>
    upgradeServiceLocked(options, target, connection, host, io),
  );
}

async function upgradeServiceLocked(
  options: ServiceOptions,
  target: string,
  connection: OperatorConnection,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
  const service = new Service(options, host, io);
  let stage = "preflight";
  let record: InstallRecord | null = null;
  let snapshot: string | null = null;
  let logs: string[] = [];
  try {
    record = service.readRecord();
    if (!record)
      throw refuse(
        `${options.label} is not installed; run \`ensemble service install\``,
      );
    if (record.mode === "daemon")
      throw refuse(
        "service upgrade does not support a LaunchDaemon install; switch back first: run `ensemble service uninstall` (and the sudo steps it prints), `ensemble service install`, upgrade, then uninstall and `ensemble service install --mode daemon` again (see the macOS operations guide)",
      );
    const from = record.version;
    const version = service.releaseVersion(target);
    service.requireOwned(record, await service.loadedJob());
    let origin: string | undefined;
    try {
      origin = await connection.origin();
    } catch {
      origin = undefined;
    }
    if (origin === undefined)
      throw refuse(
        "No usable CLI connection; run `ensemble auth login` with a read credential first",
      );
    if (origin !== record.configuration.origin)
      throw refuse(
        `The CLI connection is not for ${record.configuration.origin}`,
      );

    service.checkInterrupt();
    // The old job is still running: a credential that cannot read readiness would leave the
    // healthy new release stopped after the readiness deadline.
    await service.requireReadable(connection);
    service.checkInterrupt();
    stage = "stop";
    await service.stopOwned(record);
    // Nothing starts the old version at login from here on, and a torn render cannot leave
    // an activation that no longer matches the record.
    rmSync(service.activation, { force: true });

    stage = "snapshot";
    service.checkInterrupt();
    service.prepareDirectories();
    const path = join(
      options.stateDir,
      "snapshots",
      `${options.label}.${from}-to-${version}.${service.stamp()}`,
    );
    const { createSnapshot, verifySnapshot } = await import(
      "../standalone/operations.js"
    );
    try {
      await createSnapshot(record.configuration.dataDirectory, path);
      await verifySnapshot(path);
    } catch {
      throw new ServiceFailure("The snapshot could not be taken");
    }
    snapshot = path;

    stage = "render";
    // Nothing new starts once the operator has interrupted.
    service.checkInterrupt();
    ({ record, logs } = await service.activate(
      version,
      target,
      record.configuration,
    ));
    // The render awaits a dynamic import and plutil; nothing starts after an interrupt.
    service.checkInterrupt();
    stage = "start";
    await service.bootstrap();
    stage = "health";
    // The installed origin; upgrade never changes the port.
    await service.waitForApp(record.configuration.origin);
    stage = "readiness";
    const readiness = await service.waitFor(
      "Readiness did not report every check passing or not configured within 120 s",
      READINESS_PROBE_MS,
      async (signal) => {
        const checks = await connection.readiness(signal);
        return checks.some((check) => check.status === "fail")
          ? undefined
          : checks.map(({ id, status }) => ({ id, status }));
      },
    );
    service.write("stdout", {
      ok: true,
      operation: "upgrade",
      label: options.label,
      version,
      snapshot,
      logs,
      readiness,
    });
    return 0;
  } catch (error) {
    const jobStopped =
      stage === "preflight" ? null : await service.leaveStopped(record);
    service.write("stderr", {
      ok: false,
      operation: "upgrade",
      stage,
      error: message(error),
      jobStopped,
      snapshot,
      logs,
    });
    return 1;
  }
}

/** Remove the owned job and its activation; keep data, auth, snapshots, versions and logs. */
export async function uninstallService(
  options: ServiceOptions,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
  const refused = await refusedAsRoot(host, io, "uninstall");
  if (refused !== null) return refused;
  return withLock(options, host, io, "uninstall", () =>
    uninstallServiceLocked(options, host, io),
  );
}

async function uninstallServiceLocked(
  options: ServiceOptions,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
  const service = new Service(options, host, io);
  try {
    const record = service.readRecord();
    if (record?.mode === "daemon")
      return await uninstallDaemon(service, record);
    const job = await service.loadedJob();
    if (
      record === null &&
      ((await service.loadedJob(service.systemTarget)) !== null ||
        lstatSync(service.installedDaemon, { throwIfNoEntry: false }) !==
          undefined)
    )
      throw refuse(
        `The ${options.label} job or ${service.installedDaemon} was not created by this installation; nothing was changed`,
      );
    const installed =
      record !== null || job !== null || existsSync(service.activation);
    if (installed) {
      service.requireOwned(record, job);
      if (!(await service.leaveStopped(record)))
        throw new ServiceFailure(
          "The job could not be confirmed stopped; the install record is kept, run service uninstall again",
        );
      rmSync(service.activation, { force: true });
      rmSync(service.recordPath, { force: true });
    }
    service.write("stdout", {
      ok: true,
      operation: "uninstall",
      mode: "agent",
      label: options.label,
      installed,
    });
    return 0;
  } catch (error) {
    service.write("stderr", {
      ok: false,
      operation: "uninstall",
      error: message(error),
    });
    return 1;
  }
}

/**
 * A daemon is stopped and removed with sudo, which Ensemble never runs: print the steps for
 * what is still loaded or installed, and drop the record only once both are gone.
 */
async function uninstallDaemon(
  service: Service,
  record: InstallRecord,
): Promise<number> {
  const { label } = service.options;
  const job = await service.loadedJob(service.systemTarget);
  const hash = service.installedDaemonHash();
  if (
    (hash !== null && hash !== record.plistSha256) ||
    (job !== null && job.path !== service.installedDaemon)
  )
    throw service.daemonMismatch();
  // The last chance to read the running process before the operator boots it out.
  if (job !== null) record = (await service.observeDaemon(record, job)).record;
  const steps = [
    ...(job === null
      ? []
      : [`sudo /bin/launchctl bootout ${shellWord(service.systemTarget)}`]),
    ...(hash === null
      ? []
      : [`sudo /bin/rm -f ${shellWord(service.installedDaemon)}`]),
  ];
  const decision = daemonDecision(
    await service.daemonFacts(
      "uninstall",
      record,
      job === null ? { state: "absent" } : { state: "loaded", pid: job.pid },
      hash !== null,
      { identityRead: true, listener: "free" },
    ),
  );
  if (decision.kind === "hold")
    throw refuse(service.holdMessage("stopped", decision.reason, record));
  const complete = decision.kind === "complete";
  if (complete) {
    rmSync(service.stagedDaemon, { force: true });
    rmSync(service.recordPath, { force: true });
  } else {
    service.io.stderr.write(
      `Run these commands now, then run \`ensemble service uninstall\` again to finish (after a reboot or restart of the job, run \`ensemble service uninstall\` again first):\n${steps.join("\n")}\n`,
    );
  }
  service.write("stdout", {
    ok: true,
    operation: "uninstall",
    mode: "daemon",
    label,
    installed: true,
    complete,
    ...(complete ? {} : { steps }),
  });
  return 0;
}

function run(
  command: string,
  args: string[],
  timeout = 20_000,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = childProcessEnvironment(),
): Promise<{ status: number; stdout: string }> {
  return new Promise((done) =>
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        env,
        // Aborting kills the child.
        ...(signal ? { signal } : {}),
      },
      (error, stdout) =>
        done({
          status: !error ? 0 : typeof error.code === "number" ? error.code : -1,
          stdout,
        }),
    ),
  );
}

const GH_TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
const ghStatusSchema = z.object({
  hosts: z.record(
    z.string(),
    z.array(
      z.object({
        active: z.boolean().optional(),
        tokenSource: z.string().optional(),
      }),
    ),
  ),
});

/**
 * Where the stored github.com login keeps its token, from `gh auth status --json hosts`,
 * which reports the source and never the token. The token variables are removed so it
 * describes the stored login a LaunchDaemon would see. Anything unreadable is `unknown`.
 */
export async function ghTokenStorage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GhTokenStorage> {
  const scrubbed = childProcessEnvironment(env);
  for (const name of GH_TOKEN_VARIABLES) delete scrubbed[name];
  scrubbed.GH_PROMPT_DISABLED = "1";
  const result = await run(
    "gh",
    [
      "auth",
      "status",
      "--active",
      "--hostname",
      "github.com",
      "--json",
      "hosts",
    ],
    10_000,
    undefined,
    scrubbed,
  );
  if (result.status !== 0) return "unknown";
  try {
    const source = ghStatusSchema
      .parse(JSON.parse(result.stdout))
      .hosts["github.com"]?.find(
        (entry) => entry.active !== false,
      )?.tokenSource;
    if (source === "keyring") return "keyring";
    return source !== undefined && isAbsolute(source) ? "file" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The keychain warning `ensemble doctor` shows on a daemon host: only when a daemon install
 * record exists under the default state directory and the gh login is in the keychain.
 */
export async function daemonGhWarning(
  env: NodeJS.ProcessEnv,
  uid: number | undefined = process.getuid?.(),
): Promise<string | null> {
  // Never run gh as root: it could create root-owned state under the operator's HOME.
  if (uid === 0) return null;
  if (!env.HOME || !isAbsolute(env.HOME)) return null;
  const directory = join(env.HOME, STATE_DIR, "launchd");
  try {
    const isDaemon = readdirSync(directory).some((name) => {
      if (!name.endsWith(".json")) return false;
      try {
        return (
          recordSchema.parse(
            JSON.parse(readFileSync(join(directory, name), "utf8")),
          ).mode === "daemon"
        );
      } catch {
        return false;
      }
    });
    if (!isDaemon) return null;
  } catch {
    return null;
  }
  return (await ghTokenStorage(env)) === "keyring" ? GH_KEYCHAIN_WARNING : null;
}

export function defaultServiceHost(): ServiceHost {
  const termination = import("../standalone/termination.js");
  return {
    uid: process.getuid?.() ?? -1,
    isRoot: () => process.getuid?.() === 0 || process.geteuid?.() === 0,
    portOwner: async (port) => {
      const result = await run("/usr/sbin/lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-Fp",
      ]);
      // lsof exits 1 with no output when nothing listens; any other failure is unknown.
      if (result.status === 1 && result.stdout.trim() === "") return [];
      if (result.status !== 0) return null;
      return [...result.stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
    },
    daemonsDir: () => DAEMONS_DIR,
    launchctl: (args) => run("/bin/launchctl", args),
    lint: async (path) =>
      (await run("/usr/bin/plutil", ["-lint", path])).status === 0,
    captureIdentity: async (pid) =>
      (await termination).captureProcessIdentity(pid),
    exited: async (identity) => {
      const {
        MacProcessTerminationVerifier,
        PROCESS_IDENTIFIER_REUSED,
        HOST_BOOT_DIFFERS,
      } = await termination;
      const verifier = new MacProcessTerminationVerifier();
      const result = await verifier.verify(
        identity as Parameters<typeof verifier.verify>[0],
      );
      // A reused pid or a new boot also prove the original process is gone.
      return (
        result.kind === "verified" ||
        (result.kind === "conflict" &&
          (result.reason === PROCESS_IDENTIFIER_REUSED ||
            result.reason === HOST_BOOT_DIFFERS))
      );
    },
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    timeout: (ms) => AbortSignal.timeout(ms),
    rename: renameSync,
    // bsdtar refuses absolute and `..` member paths by default.
    extract: async (tarball, dir, signal) =>
      (
        await run(
          "/usr/bin/tar",
          ["-xzf", tarball, "--strip-components", "1", "-C", dir],
          300_000,
          signal,
        )
      ).status === 0,
    open: async (url, signal) => {
      await run("/usr/bin/open", [url], 20_000, signal);
    },
    hostname,
    account: () => {
      const { username, homedir } = userInfo();
      return { name: username, home: homedir };
    },
    ghTokenStorage: () => ghTokenStorage(process.env),
  };
}

/** A usage error names only the commands of the area it was typed in. */
function usage(deps: CliDeps, area: LocalArea): number {
  deps.stderr.write(
    `ensemble: Unexpected arguments. (usage)\nUsage:\n${area === "service" ? SERVICE_COMMANDS : SNAPSHOT_COMMANDS}${fixLine(DEFAULT_FIX.usage ?? "")}\n`,
  );
  return 2;
}

const LABEL = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DAEMONS_DIR = "/Library/LaunchDaemons";

export const LIFECYCLE_OPTIONS = {
  "state-dir": { type: "string" },
  "log-dir": { type: "string" },
  "launch-agents-dir": { type: "string" },
  label: { type: "string" },
  port: { type: "string" },
  connection: { type: "string" },
  "token-file": { type: "string" },
  "no-open": { type: "boolean" },
  "diagnostic-retention-days": { type: "string" },
  "diagnostic-storage-mib": { type: "string" },
  mode: { type: "string" },
} as const;

function parseLifecycleArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: LIFECYCLE_OPTIONS,
    });
  } catch {
    return null;
  }
}

/** A number within the service's bound, or `default` (null) to clear; undefined when absent, false for a usage error. */
function diagnosticValue(
  raw: string | undefined,
  bound: Parameters<typeof isInBound>[1],
): number | null | undefined | false {
  if (raw === undefined) return undefined;
  if (raw === "default") return null;
  return /^\d{1,10}$/.test(raw) && isInBound(Number(raw), bound)
    ? Number(raw)
    : false;
}

/** Lifecycle options with their defaults under HOME; null for a usage error. */
function lifecycleOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  daemonsDir: string,
) {
  const parsed = parseLifecycleArgs(args);
  if (!parsed) return null;
  const { values, positionals } = parsed;
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : undefined;
  const directory = (value: string | undefined, fallback: string) =>
    value !== undefined ? resolve(value) : home && join(home, fallback);
  const stateDir = directory(values["state-dir"], STATE_DIR);
  const logDir = directory(values["log-dir"], "Library/Logs/Ensemble");
  const agentsDir = directory(
    values["launch-agents-dir"],
    "Library/LaunchAgents",
  );
  const label = values.label ?? "local.ensemble.service";
  const mode = values.mode ?? "agent";
  const port = values.port ?? "8787";
  const retentionDays = diagnosticValue(
    values["diagnostic-retention-days"],
    diagnosticRetentionDays,
  );
  const storageMib = diagnosticValue(
    values["diagnostic-storage-mib"],
    diagnosticStorageMib,
  );
  if (
    retentionDays === false ||
    storageMib === false ||
    !stateDir ||
    !logDir ||
    !agentsDir ||
    (mode !== "agent" && mode !== "daemon") ||
    !LABEL.test(label) ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    Number(port) > 65_535
  )
    return null;
  const options: ServiceOptions = {
    stateDir,
    logDir,
    agentsDir,
    daemonsDir,
    label,
    port: Number(port),
    ...(retentionDays === undefined && storageMib === undefined
      ? {}
      : {
          diagnostic: {
            ...(retentionDays === undefined ? {} : { retentionDays }),
            ...(storageMib === undefined ? {} : { storageMib }),
          },
        }),
  };
  return {
    options,
    positionals,
    connection: values.connection,
    tokenFile: values["token-file"],
    noOpen: values["no-open"] === true,
    mode: mode as ServiceMode,
    modeGiven: values.mode !== undefined,
  };
}

/** `ensemble service …`: argv starts after `service`. */
export async function serviceCommand(
  argv: string[],
  deps: CliDeps,
  operatorConnection: (name: string | undefined) => OperatorConnection,
  host: () => ServiceHost = defaultServiceHost,
  cli?: InstallCli,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === "init-auth") return initAuth(args, deps, host);
  if (
    command === "install" ||
    command === "upgrade" ||
    command === "uninstall"
  ) {
    const serviceHost = host();
    const parsed = lifecycleOptions(args, deps.env, serviceHost.daemonsDir());
    if (
      !parsed ||
      parsed.positionals.length > (command === "uninstall" ? 0 : 1) ||
      parsed.positionals.length < (command === "upgrade" ? 1 : 0) ||
      (command === "uninstall" && parsed.connection !== undefined) ||
      (command !== "install" &&
        (parsed.tokenFile !== undefined ||
          parsed.noOpen ||
          parsed.modeGiven)) ||
      (parsed.mode === "daemon" && parsed.tokenFile !== undefined) ||
      (parsed.connection !== undefined &&
        command === "install" &&
        !connectionNameSchema.safeParse(parsed.connection).success) ||
      (command === "uninstall" && parsed.options.diagnostic !== undefined) ||
      (command !== "install" && args.some((arg) => arg.startsWith("--port")))
    )
      return usage(deps, "service");
    const { options } = parsed;
    if (command === "install")
      return installService(
        options,
        // dist/src/cli/service.js → the release root.
        resolve(fileURLToPath(new URL("../../..", import.meta.url))),
        serviceHost,
        deps,
        {
          tarball: parsed.positionals[0] && resolve(parsed.positionals[0]),
          cli,
          connection: parsed.connection ?? "local",
          tokenFile: parsed.tokenFile && resolve(parsed.tokenFile),
          open: !parsed.noOpen,
          mode: parsed.mode,
        },
      );
    if (command === "uninstall")
      return uninstallService(options, serviceHost, deps);
    return upgradeService(
      options,
      resolve(parsed.positionals[0] as string),
      operatorConnection(parsed.connection),
      serviceHost,
      deps,
    );
  }
  if (
    command === "serve" ||
    command === "operator" ||
    command === "run" ||
    command === "list"
  ) {
    // Ensemble never runs the service as root, whatever started it.
    if (host().isRoot()) {
      const { ROOT_REFUSAL } = await import("../standalone/launchd.js");
      deps.stderr.write(`${ROOT_REFUSAL}\n`);
      return 1;
    }
    const standalone = await import("../standalone/cli.js");
    try {
      await standalone.main(argv);
      return Number(process.exitCode ?? 0);
    } catch {
      deps.stderr.write(`ensemble: service ${command} failed\n`);
      return 1;
    }
  }
  return usage(deps, "service");
}

async function initAuth(
  args: string[],
  deps: CliDeps,
  host: () => ServiceHost,
): Promise<number> {
  const parsed = parseLifecycleArgs(args);
  if (!parsed || parsed.positionals.length > 1 || parsed.values.mode)
    return usage(deps, "service");
  const home = deps.env.HOME;
  const stateDir =
    parsed.values["state-dir"] !== undefined
      ? resolve(parsed.values["state-dir"])
      : home && isAbsolute(home)
        ? join(home, STATE_DIR)
        : undefined;
  if (parsed.positionals[0] === undefined && !stateDir)
    return usage(deps, "service");
  // Checked first so that a non-interactive run creates nothing.
  if (!deps.stdin.isTTY || !(deps.stdout as NodeJS.WriteStream).isTTY) {
    deps.stderr.write(
      "Operator authentication initialization failed: run it in an interactive terminal\n",
    );
    return 1;
  }
  if (host().isRoot()) {
    const { ROOT_REFUSAL } = await import("../standalone/launchd.js");
    deps.stderr.write(`${ROOT_REFUSAL}\n`);
    return 1;
  }
  let authFile = parsed.positionals[0];
  if (authFile === undefined) {
    const auth = join(stateDir as string, "auth");
    try {
      mkdirSync(auth, { recursive: true, mode: 0o700 });
    } catch {
      deps.stderr.write(`Could not create ${auth}\n`);
      return 1;
    }
    authFile = join(auth, "operator-auth.json");
  }
  const { runOperatorAuth } = await import(
    "../standalone/operator-auth-cli.js"
  );
  return runOperatorAuth(["init", resolve(authFile)], {
    stdin: deps.stdin,
    stdout: deps.stdout as NodeJS.WriteStream,
    stderr: deps.stderr,
  });
}

/** `ensemble snapshot create|verify|restore`, the offline operations. */
export async function snapshotCommand(
  argv: string[],
  deps: CliDeps,
): Promise<number> {
  const [command, ...args] = argv;
  const arity = { create: 2, verify: 1, restore: 2 }[command ?? ""];
  if (arity === undefined || args.length !== arity)
    return usage(deps, "snapshot");
  const { runOperations } = await import("../standalone/operations-cli.js");
  return runOperations(
    [command === "create" ? "backup" : (command as string), ...args],
    deps,
  );
}
