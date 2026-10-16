import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
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
import { hostname } from "node:os";
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
import type { CliDeps } from "./types.js";

// Service modules load on demand so the operator CLI never loads service state or SQLite.

export const SERVICE_USAGE = `Local service commands (run on the service's Mac):
  service install [TARBALL] [--connection NAME] [--token-file PATH] [--no-open] [SERVICE_OPTIONS]
  service upgrade VERSION_DIR [--connection NAME] [SERVICE_OPTIONS]
  service uninstall [SERVICE_OPTIONS]
  service init-auth [AUTH_FILE] [--state-dir DIR]
  service serve|operator|run|list ABSOLUTE_DATA_DIR [ARGS...]
  snapshot create SOURCE_DATA_DIR SNAPSHOT
  snapshot verify SNAPSHOT
  snapshot restore SNAPSHOT DESTINATION_DATA_DIR

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
upgrade stops the job, takes a verified snapshot, starts VERSION_DIR and checks
readiness through a logged-in CLI connection with a read credential. A failed
upgrade leaves the job stopped and reports the snapshot and logs; recover with
a fixed release and another upgrade, or snapshot restore. uninstall removes the
job and keeps data, auth, snapshots, versions and logs.
`;

const STATE_DIR = "Library/Application Support/Ensemble";
const RECORD_SCHEMA = "ensemble.service/v1";
const NOT_LOADED = 113;
const STOP_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 1_000;
const HEALTH_PROBE_MS = 5_000;
// Above the service's own 10 s bound on its slowest readiness checks.
const READINESS_PROBE_MS = 20_000;
// Doctor reads readiness with the CLI's own request bound; this stops a stalled one.
const DOCTOR_MS = 60_000;

/** An identity from `captureIdentity`, passed back unchanged to `exited`. */
export type ProcessIdentity = object;

/** Everything that reaches launchd, the OS or the network; tests use a fake. */
export type ServiceHost = {
  uid: number;
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
  open(url: string): Promise<void>;
  hostname(): string;
};

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
  doctor(connection: string): Promise<void>;
};

/** What install adds beyond the LaunchAgent: unpack, password, login, doctor, open. */
export type FirstRun = {
  tarball?: string | undefined;
  cli?: InstallCli | undefined;
  connection: string;
  tokenFile?: string | undefined;
  open: boolean;
};

export type ServiceOptions = {
  stateDir: string;
  logDir: string;
  agentsDir: string;
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
  })
  .strict();
type Configuration = z.infer<typeof configurationSchema>;

const recordSchema = z
  .object({
    schema: z.literal(RECORD_SCHEMA),
    label: z.string(),
    version: z.string(),
    plistSha256: z.string().regex(/^[0-9a-f]{64}$/),
    configuration: configurationSchema,
  })
  .strict();
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

  /** The label's launchd job, or null when it is not loaded. */
  async loadedJob(): Promise<{
    path: string | undefined;
    pid: number | undefined;
  } | null> {
    const result = await this.host.launchctl(["print", this.target]);
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

  prepareDirectories() {
    const { stateDir, logDir, agentsDir } = this.options;
    for (const [path, name, exclusive] of [
      [agentsDir, "LaunchAgents directory", false],
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
    };
    const logs = [configuration.stdoutPath, configuration.stderrPath];
    // Staged beside the activation so the final rename stays on one filesystem; launchd
    // loads only the directory's own .plist files, not this private subdirectory.
    const staging = mkdtempSync(
      join(this.options.agentsDir, `.${label}.staging-`),
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
        label,
        version,
        plistSha256: sha256(staged),
        configuration,
      };
      this.writeRecord(record);
      this.host.rename(staged, this.activation);
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
  let mintAccepted = false;
  let outcome: "stored" | "wrong-password" | "failed" = "failed";
  const attempt = async () => {
    await nextSession(await call("GET", "/api/operator/session"));
    const login = await call("POST", "/api/operator/login", { password });
    if (login.status === 401) {
      await login.body?.cancel();
      outcome = "wrong-password";
      return;
    }
    if (login.status !== 200) return;
    signedIn = true;
    await nextSession(login);
    // Not interruptible: an abort after the server minted it would orphan the credential.
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

/** Install the LaunchAgent for the release at `releaseRoot`; undoes itself on failure. */
export function installService(
  options: ServiceOptions,
  releaseRoot: string,
  host: ServiceHost,
  io: ServiceIo,
  first: FirstRun = { connection: "local", open: false },
): Promise<number> {
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
    if (await service.loadedJob())
      throw refuse(`The ${options.label} job is already loaded`);
    if (existsSync(service.recordPath) || existsSync(service.activation))
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
    if (cli?.interactive)
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
    service.prepareDirectories();
    ({ record, logs } = await service.activate(version as string, root, {
      dataDirectory: service.dataDir,
      authFile: service.authFile,
      origin: service.origin,
      port: options.port,
    }));
    service.checkInterrupt();
    stage = "start";
    await service.bootstrap();
    stage = "health";
    await service.waitForApp(service.origin);
    // From here the service stays installed whatever happens: nothing below may throw.
    const signedIn = await signIn(service, first, password);
    const { connection, credentialActive, sessionOpen } = signedIn;
    service.write("stdout", {
      ok: true,
      operation: "install",
      label: options.label,
      version,
      origin: service.origin,
      plist: service.activation,
      logs,
      connection,
      credentialActive,
      sessionOpen,
    });
    await finishInstall(service, first, signedIn);
    return 0;
  } catch (error) {
    let jobStopped: boolean | null = null;
    if (!NO_JOB_STAGES.includes(stage)) {
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

/** Issues and stores the CLI credential; the connection name when stored, else null. Never throws. */
type SignIn = {
  connection: string | null;
  credentialName: string;
  credentialActive: boolean;
  sessionOpen: boolean;
};

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
    // Abandoning doctor on the bound or an interrupt loses only its stderr output.
    if (connection !== null && !interrupted() && first.cli)
      await bounded(
        first.cli.doctor(connection),
        AbortSignal.any([
          service.host.timeout(DOCTOR_MS),
          ...(service.io.signal ? [service.io.signal] : []),
        ]),
      );
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
    if (first.open && !interrupted()) await service.host.open(app);
  } catch {
    // Install already succeeded; a doctor or open failure is not an install failure.
  }
}

/** Stop, snapshot, re-render for `target`, start and check readiness. Never rolls back. */
export function upgradeService(
  options: ServiceOptions,
  target: string,
  connection: OperatorConnection,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
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
export function uninstallService(
  options: ServiceOptions,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
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
    const job = await service.loadedJob();
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

function run(
  command: string,
  args: string[],
  timeout = 20_000,
  signal?: AbortSignal,
): Promise<{ status: number; stdout: string }> {
  return new Promise((done) =>
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        env: childProcessEnvironment(),
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

export function defaultServiceHost(): ServiceHost {
  const termination = import("../standalone/termination.js");
  return {
    uid: process.getuid?.() ?? -1,
    launchctl: (args) => run("/bin/launchctl", args),
    lint: async (path) =>
      (await run("/usr/bin/plutil", ["-lint", path])).status === 0,
    captureIdentity: async (pid) =>
      (await termination).captureProcessIdentity(pid),
    exited: async (identity) => {
      const { MacProcessTerminationVerifier } = await termination;
      const verifier = new MacProcessTerminationVerifier();
      const result = await verifier.verify(
        identity as Parameters<typeof verifier.verify>[0],
      );
      return result.kind === "verified";
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
    open: async (url) => {
      await run("/usr/bin/open", [url]);
    },
    hostname,
  };
}

function usage(deps: CliDeps): number {
  deps.stderr.write(`Usage:\n${SERVICE_USAGE}`);
  return 2;
}

const LABEL = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function parseLifecycleArgs(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
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
      },
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
function lifecycleOptions(args: string[], env: NodeJS.ProcessEnv) {
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
    !LABEL.test(label) ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    Number(port) > 65_535
  )
    return null;
  const options: ServiceOptions = {
    stateDir,
    logDir,
    agentsDir,
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
  if (command === "init-auth") return initAuth(args, deps);
  if (
    command === "install" ||
    command === "upgrade" ||
    command === "uninstall"
  ) {
    const parsed = lifecycleOptions(args, deps.env);
    if (
      !parsed ||
      parsed.positionals.length > (command === "uninstall" ? 0 : 1) ||
      parsed.positionals.length < (command === "upgrade" ? 1 : 0) ||
      (command === "uninstall" && parsed.connection !== undefined) ||
      (command !== "install" &&
        (parsed.tokenFile !== undefined || parsed.noOpen)) ||
      (parsed.connection !== undefined &&
        command === "install" &&
        !connectionNameSchema.safeParse(parsed.connection).success) ||
      (command === "uninstall" && parsed.options.diagnostic !== undefined) ||
      (command !== "install" && args.some((arg) => arg.startsWith("--port")))
    )
      return usage(deps);
    const { options } = parsed;
    if (command === "install")
      return installService(
        options,
        // dist/src/cli/service.js → the release root.
        resolve(fileURLToPath(new URL("../../..", import.meta.url))),
        host(),
        deps,
        {
          tarball: parsed.positionals[0] && resolve(parsed.positionals[0]),
          cli,
          connection: parsed.connection ?? "local",
          tokenFile: parsed.tokenFile && resolve(parsed.tokenFile),
          open: !parsed.noOpen,
        },
      );
    if (command === "uninstall") return uninstallService(options, host(), deps);
    return upgradeService(
      options,
      resolve(parsed.positionals[0] as string),
      operatorConnection(parsed.connection),
      host(),
      deps,
    );
  }
  if (
    command === "serve" ||
    command === "operator" ||
    command === "run" ||
    command === "list"
  ) {
    const standalone = await import("../standalone/cli.js");
    try {
      await standalone.main(argv);
      return Number(process.exitCode ?? 0);
    } catch {
      deps.stderr.write(`ensemble: service ${command} failed\n`);
      return 1;
    }
  }
  return usage(deps);
}

async function initAuth(args: string[], deps: CliDeps): Promise<number> {
  const parsed = parseLifecycleArgs(args);
  if (!parsed || parsed.positionals.length > 1) return usage(deps);
  const home = deps.env.HOME;
  const stateDir =
    parsed.values["state-dir"] !== undefined
      ? resolve(parsed.values["state-dir"])
      : home && isAbsolute(home)
        ? join(home, STATE_DIR)
        : undefined;
  if (parsed.positionals[0] === undefined && !stateDir) return usage(deps);
  // Checked first so that a non-interactive run creates nothing.
  if (!deps.stdin.isTTY || !(deps.stdout as NodeJS.WriteStream).isTTY) {
    deps.stderr.write(
      "Operator authentication initialization failed: run it in an interactive terminal\n",
    );
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
  if (arity === undefined || args.length !== arity) return usage(deps);
  const { runOperations } = await import("../standalone/operations-cli.js");
  return runOperations(
    [command === "create" ? "backup" : (command as string), ...args],
    deps,
  );
}
