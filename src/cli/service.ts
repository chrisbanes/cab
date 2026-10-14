import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { childProcessEnvironment } from "../core/child-environment.js";
import type { CliDeps } from "./types.js";

// Service modules load on demand so the operator CLI never loads service state or SQLite.

export const SERVICE_USAGE = `Local service commands (run on the service's Mac):
  service install [SERVICE_OPTIONS]
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

install binds the LaunchAgent to the release it runs from (STATE/versions/V).
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
};

export type ServiceOptions = {
  stateDir: string;
  logDir: string;
  agentsDir: string;
  label: string;
  port: number;
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
    for (const file of [
      join(root, "node", "bin", "node"),
      join(root, "dist", "src", "standalone", "cli.js"),
    ])
      if (!lstatSync(file, { throwIfNoEntry: false })?.isFile())
        throw refuse(`The release is incomplete: ${file} is missing`);
    return version;
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
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.recordPath);
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
    base: Pick<Configuration, "dataDirectory" | "authFile" | "origin" | "port">,
  ): Promise<{ record: InstallRecord; logs: string[] }> {
    const { label, logDir } = this.options;
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

/** Install the LaunchAgent for the release at `releaseRoot`; undoes itself on failure. */
export function installService(
  options: ServiceOptions,
  releaseRoot: string,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
  return withLock(options, host, io, "install", () =>
    installServiceLocked(options, releaseRoot, host, io),
  );
}

async function installServiceLocked(
  options: ServiceOptions,
  releaseRoot: string,
  host: ServiceHost,
  io: ServiceIo,
): Promise<number> {
  const service = new Service(options, host, io);
  let stage = "preflight";
  let record: InstallRecord | null = null;
  let logs: string[] = [];
  try {
    const version = service.releaseVersion(releaseRoot);
    if (await service.loadedJob())
      throw refuse(`The ${options.label} job is already loaded`);
    if (existsSync(service.recordPath) || existsSync(service.activation))
      throw refuse(
        `${options.label} is already installed; use service upgrade or service uninstall`,
      );
    if (!existsSync(service.authFile))
      throw refuse(
        `${service.authFile} is missing; run \`ensemble service init-auth\``,
      );
    if (!(await portIsFree(options.port)))
      throw refuse(`Port ${options.port} on 127.0.0.1 is in use`);
    stage = "render";
    service.prepareDirectories();
    ({ record, logs } = await service.activate(version, releaseRoot, {
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
    service.write("stdout", {
      ok: true,
      operation: "install",
      label: options.label,
      version,
      origin: service.origin,
      plist: service.activation,
      logs,
    });
    return 0;
  } catch (error) {
    let jobStopped: boolean | null = null;
    if (stage !== "preflight") {
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
): Promise<{ status: number; stdout: string }> {
  return new Promise((done) =>
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 20_000, env: childProcessEnvironment() },
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
      },
    });
  } catch {
    return null;
  }
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
  if (
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
  };
  return { options, positionals, connection: values.connection };
}

/** `ensemble service …`: argv starts after `service`. */
export async function serviceCommand(
  argv: string[],
  deps: CliDeps,
  operatorConnection: (name: string | undefined) => OperatorConnection,
  host: () => ServiceHost = defaultServiceHost,
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
      parsed.positionals.length !== (command === "upgrade" ? 1 : 0) ||
      (command !== "upgrade" && parsed.connection !== undefined) ||
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
