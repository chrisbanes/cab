import { childProcessEnvironment } from "../core/child-environment.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual, promisify } from "node:util";
import type { PowerEventCursor } from "./state.js";
import type { ExecutionState } from "./state.js";

export interface PowerEvent {
  cursor: PowerEventCursor;
  previousCursor: PowerEventCursor | null;
  transition: "sleep" | "wake";
}

export interface PowerEventBatch {
  complete: boolean;
  fromCursor: PowerEventCursor | null;
  cursor: PowerEventCursor | null;
  events: PowerEvent[];
}

export interface PowerEventSource {
  readSince(cursor: PowerEventCursor | null): Promise<PowerEventBatch>;
  /** Wall-clock ms of the latest sleep or wake since boot (0 for none); throws when unknown. */
  lastSleepOrWakeAt?(): Promise<number>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export type PowerLogReader = (
  command: string,
  args: string[],
  options: { timeoutMs: number; idleTimeoutMs: number; maxLineBytes: number },
) => AsyncIterable<string>;

/** A power-log read killed for making no output progress or for running too long. */
export class PowerLogReadTimeout extends Error {
  constructor(readonly kind: "idle" | "total") {
    super(`Power-log read timed out (${kind})`);
    this.name = "PowerLogReadTimeout";
  }
}

const pmsetTimeCursor = /^pmset-time:(\d+)$/;
const pmsetEventCursorPattern = /^pmset-event:(\d+):(\d+):([a-f0-9]{16})$/;
const timestampPrefix =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(.+)$/;
const sleepWakeType = /^(Sleep|Wake|DarkWake)\b\s*(.*)$/i;

function createPmsetEventCursor(value: string): PowerEventCursor {
  return { version: 1, value };
}

function parseTimestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function knownPmsetSummary(line: string): boolean {
  const value = line.trim();
  return (
    value === "" ||
    value.startsWith("PM ASL data store:") ||
    value.startsWith("Assertion status system-wide:") ||
    value.startsWith("Listed by owning process:") ||
    value.startsWith("Kernel Assertions:") ||
    /^(pid |id=|Details:|Localized=)/.test(value)
  );
}

// macOS 27 prints these three lines, in order, before the first timestamped row.
const pmsetPreamble = [
  /^Time stamp\s+Domain\s+Message\b.*\bDuration\s+Delay$/,
  /^=+(?:\s+=+)*$/,
  /^UUID: (?:\(null\)|[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})$/,
];

/**
 * Incremental parser for the documented, timestamped Sleep/Wake rows of
 * `pmset -g log`. Feed it exactly the pieces of `output.split(/\r?\n/)` so
 * persisted line-index cursors stay valid; state grows with events, not log size.
 */
function createPmsetParser(requested: PowerEventCursor | null) {
  const requestedTime = requested?.value.match(pmsetTimeCursor);
  const requestedEvent = requested?.value.match(pmsetEventCursorPattern);
  const rejected = (): PowerEventBatch => ({
    complete: false,
    fromCursor: requested,
    cursor: requested,
    events: [],
  });
  const unusable =
    requested !== null &&
    (requested.version !== 1 || (!requestedTime && !requestedEvent));

  const events: Array<{
    cursor: PowerEventCursor;
    timestamp: number;
    lineIndex: number;
    transition: "sleep" | "wake";
  }> = [];
  let earliestTimestamp: number | undefined;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let malformed = false;
  let inSummary = false;
  let preambleStage = 0;
  let lineIndex = -1;

  function line(text: string): void {
    lineIndex++;
    if (unusable) return;
    const trimmed = text.trimEnd();
    if (trimmed.trim().startsWith("Assertion status system-wide:")) {
      inSummary = true;
      return;
    }
    if (inSummary || knownPmsetSummary(trimmed)) return;
    const normalized = trimmed.trim();
    // Each preamble line is accepted once, in order, and only before the first
    // row, so a header in the middle of the history still fails closed.
    if (
      earliestTimestamp === undefined &&
      pmsetPreamble[preambleStage]?.test(normalized)
    ) {
      preambleStage++;
      return;
    }
    const match = timestampPrefix.exec(normalized);
    if (!match) {
      malformed = true;
      return;
    }
    const timestamp = parseTimestamp(match[1] ?? "");
    if (timestamp === undefined || timestamp < previousTimestamp) {
      malformed = true;
      return;
    }
    // A started preamble must be complete before the first row.
    if (
      earliestTimestamp === undefined &&
      preambleStage > 0 &&
      preambleStage < pmsetPreamble.length
    ) {
      malformed = true;
      return;
    }
    earliestTimestamp ??= timestamp;
    previousTimestamp = timestamp;
    const body = match[2] ?? "";
    const [, kind, detail] = sleepWakeType.exec(body) ?? [];
    if (kind) {
      const hash = createHash("sha256")
        .update(normalized)
        .digest("hex")
        .slice(0, 16);
      events.push({
        cursor: createPmsetEventCursor(
          `pmset-event:${timestamp}:${lineIndex}:${hash}`,
        ),
        timestamp,
        lineIndex,
        transition: kind.toLowerCase() === "sleep" ? "sleep" : "wake",
      });
      return;
    }
    const category = body.split(/\s+/, 1)[0] ?? "";
    if (
      category.toLowerCase() !== "assertions" &&
      /sleep|wake/i.test(`${category} ${detail ?? body}`)
    )
      malformed = true;
  }

  function finish(): PowerEventBatch {
    if (unusable || malformed || earliestTimestamp === undefined)
      return rejected();
    let afterLine = Number.NEGATIVE_INFINITY;
    if (requestedEvent) {
      const timestamp = Number(requestedEvent[1]);
      const requestedLine = Number(requestedEvent[2]);
      // A cursor saved before macOS 27 predates the preamble, so its row moved
      // later by an unknown number of lines. With the preamble present, accept
      // the one later row with the same timestamp and hash; zero or several fail.
      const exact = events.find(
        (event) => event.cursor.value === requested?.value,
      );
      const moved =
        exact || preambleStage !== pmsetPreamble.length
          ? []
          : events.filter(
              (event) =>
                event.timestamp === timestamp &&
                event.lineIndex > requestedLine &&
                event.cursor.value.endsWith(`:${requestedEvent[3]}`),
            );
      const found = exact ?? (moved.length === 1 ? moved[0] : undefined);
      if (!found) return rejected();
      afterLine = found.lineIndex;
    } else if (requestedTime) {
      const timestamp = Number(requestedTime[1]);
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        earliestTimestamp > timestamp
      )
        return rejected();
    }

    const selected = events.filter((event) =>
      requestedEvent
        ? event.lineIndex > afterLine
        : requestedTime
          ? event.timestamp >= Number(requestedTime[1])
          : false,
    );
    let previous = requested;
    const chained: PowerEvent[] = selected.map((event) => {
      const item = {
        cursor: event.cursor,
        previousCursor: previous,
        transition: event.transition,
      };
      previous = event.cursor;
      return item;
    });
    return {
      complete: true,
      fromCursor: requested,
      cursor: chained.at(-1)?.cursor ?? requested,
      events: chained,
    };
  }

  return { line, finish };
}

/** Parses only the documented, timestamped Sleep/Wake rows from `pmset -g log`. */
export function parsePmsetPowerLog(
  output: string,
  requested: PowerEventCursor | null,
): PowerEventBatch {
  const parser = createPmsetParser(requested);
  for (const line of output.split(/\r?\n/)) parser.line(line);
  return parser.finish();
}

/**
 * Streams stdout of a child as the same pieces `split(/\r?\n/)` yields, with no
 * total-size cap. An over-long line or non-zero exit rejects; no output for
 * `idleTimeoutMs` or a read over `timeoutMs` rejects with `PowerLogReadTimeout`.
 * The child is killed on any of those or when the consumer stops early.
 */
export async function* spawnPowerLogReader(
  command: string,
  args: string[],
  options: { timeoutMs: number; idleTimeoutMs: number; maxLineBytes: number },
): AsyncGenerator<string> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "ignore"],
    env: childProcessEnvironment(),
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited (${code ?? signal})`)),
    );
  });
  exited.catch(() => {});
  let timedOut: "idle" | "total" | undefined;
  const expire = (kind: "idle" | "total") => () => {
    timedOut ??= kind;
    child.kill("SIGKILL");
  };
  const total = setTimeout(expire("total"), options.timeoutMs);
  const idle = setTimeout(expire("idle"), options.idleTimeoutMs);
  const checked = (line: string) => {
    if (Buffer.byteLength(line) > options.maxLineBytes)
      throw new Error("Power-log line exceeds the line limit");
    return line;
  };
  try {
    child.stdout.setEncoding("utf8");
    let pending = "";
    for await (const chunk of child.stdout) {
      idle.refresh();
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const end = pending[newline - 1] === "\r" ? newline - 1 : newline;
        yield checked(pending.slice(0, end));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      checked(pending);
    }
    if (timedOut) throw new PowerLogReadTimeout(timedOut);
    yield checked(pending);
    await exited;
  } catch (error) {
    // Any failure after a bound fired, such as the killed child's exit, is that timeout.
    throw timedOut ? new PowerLogReadTimeout(timedOut) : error;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

export type SleepClockReader = () => Promise<string>;

const readSleepClock: SleepClockReader = async () =>
  (
    await promisify(execFile)(
      "/usr/sbin/sysctl",
      ["-n", "kern.sleeptime", "kern.waketime"],
      { timeout: 5000, env: childProcessEnvironment() },
    )
  ).stdout;

const sysctlTimeval = /^\{ sec = (\d+), usec = (\d+) \}/;

/**
 * Reads a bounded macOS power history; missing or unfamiliar history is incomplete
 * and a read killed by its idle or total bound throws `PowerLogReadTimeout`. The
 * total bound matches the longest power poll interval.
 */
export class MacPowerEventSource implements PowerEventSource {
  constructor(
    private readonly readLog: PowerLogReader = spawnPowerLogReader,
    private readonly timeoutMs = 60_000,
    private readonly idleTimeoutMs = 10_000,
    private readonly maxLineBytes = 64 * 1024,
    private readonly now: () => number = Date.now,
    private readonly readSleepTimes: SleepClockReader = readSleepClock,
  ) {
    if (
      ![timeoutMs, idleTimeoutMs, maxLineBytes].every(
        (bound) => Number.isSafeInteger(bound) && bound > 0,
      )
    )
      throw new Error("Power-event read bounds must be positive integers");
    if (idleTimeoutMs > timeoutMs)
      throw new Error("Power-event idle bound must not exceed the total bound");
  }

  /** The later of `kern.sleeptime` and `kern.waketime`; unfamiliar output throws. */
  async lastSleepOrWakeAt(): Promise<number> {
    const lines = (await this.readSleepTimes()).trimEnd().split("\n");
    if (lines.length !== 2)
      throw new Error("Sleep and wake times are not readable");
    return Math.max(
      ...lines.map((line) => {
        const [, sec, usec] = sysctlTimeval.exec(line) ?? [];
        const ms = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
        if (!sec || !Number.isSafeInteger(ms))
          throw new Error("Sleep and wake times are not readable");
        return ms;
      }),
    );
  }

  async readSince(cursor: PowerEventCursor | null): Promise<PowerEventBatch> {
    try {
      const parser = createPmsetParser(cursor);
      for await (const line of this.readLog("/usr/bin/pmset", ["-g", "log"], {
        timeoutMs: this.timeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        maxLineBytes: this.maxLineBytes,
      }))
        parser.line(line);
      const parsed = parser.finish();
      if (cursor !== null) return parsed;
      const now = this.now();
      return parsed.complete && Number.isSafeInteger(now) && now >= 0
        ? {
            complete: true,
            fromCursor: null,
            cursor: createPmsetEventCursor(`pmset-time:${now}`),
            events: [],
          }
        : parsed;
    } catch (error) {
      if (error instanceof PowerLogReadTimeout) throw error;
      return { complete: false, fromCursor: cursor, cursor, events: [] };
    }
  }
}

export type CaffeinateSpawn = (command: string, args: string[]) => ChildProcess;

/** Owns one macOS idle-sleep assertion and reports unexpected child failure. */
export class CaffeinateAssertion extends EventEmitter {
  private child: ChildProcess | undefined;
  private stopping = false;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly spawnProcess: CaffeinateSpawn = (command, args) =>
      spawn(command, args, { stdio: "ignore", env: childProcessEnvironment() }),
    private readonly stopTimeoutMs = 1000,
  ) {
    super();
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0)
      throw new Error("Caffeinate stop timeout must be a positive integer");
  }

  start(): Promise<void> {
    return this.runTransition(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    let child: ChildProcess;
    try {
      // -w ties the assertion to this process so a crash cannot leak it.
      child = this.spawnProcess("/usr/bin/caffeinate", [
        "-i",
        "-w",
        String(process.pid),
      ]);
    } catch {
      this.emit("failure", "caffeinate process failed to start");
      return;
    }
    this.child = child;
    child.once("error", () => {
      if (this.child === child && !this.stopping)
        this.emit("failure", "caffeinate process failed");
    });
    child.once(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.child !== child) return;
        this.child = undefined;
        if (!this.stopping)
          this.emit(
            "failure",
            `caffeinate process exited (${code === null ? (signal ?? "unknown") : code})`,
          );
      },
    );
  }

  stop(): Promise<void> {
    return this.runTransition(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.stopTimeoutMs);
      timer.unref();
      child.once("close", finish);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
    if (this.child === child) this.child = undefined;
    this.stopping = false;
  }

  private runTransition(action: () => Promise<void>): Promise<void> {
    const current = this.transition.then(action, action);
    this.transition = current.catch(() => {});
    return current;
  }
}

function validCursor(value: unknown): value is PowerEventCursor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.value === "string" &&
    candidate.value.length > 0 &&
    candidate.value.length <= 512
  );
}

function sameCursor(
  left: PowerEventCursor | null,
  right: PowerEventCursor | null,
): boolean {
  return isDeepStrictEqual(left, right);
}

function validBatch(
  value: unknown,
  requested: PowerEventCursor | null,
): value is PowerEventBatch {
  if (typeof value !== "object" || value === null) return false;
  const batch = value as Record<string, unknown>;
  if (
    typeof batch.complete !== "boolean" ||
    !sameCursor(batch.fromCursor as PowerEventCursor | null, requested) ||
    (batch.cursor !== null && !validCursor(batch.cursor)) ||
    !Array.isArray(batch.events)
  )
    return false;

  let previous = requested;
  const seen = new Set<string>();
  for (const item of batch.events) {
    if (typeof item !== "object" || item === null) return false;
    const event = item as Record<string, unknown>;
    if (
      !validCursor(event.cursor) ||
      (event.previousCursor !== null && !validCursor(event.previousCursor)) ||
      !sameCursor(event.previousCursor as PowerEventCursor | null, previous) ||
      (event.transition !== "sleep" && event.transition !== "wake")
    )
      return false;
    const key = `${event.cursor.version}:${event.cursor.value}`;
    if (seen.has(key) || sameCursor(event.cursor, previous)) return false;
    seen.add(key);
    previous = event.cursor;
  }
  if (
    batch.events.length === 0 &&
    requested !== null &&
    !sameCursor(batch.cursor as PowerEventCursor | null, requested)
  )
    return false;
  if (
    batch.events.length > 0 &&
    !sameCursor(batch.cursor as PowerEventCursor | null, previous)
  )
    return false;
  return true;
}

const assertionRestartMinIntervalMs = 1000;

/** Owns active-only sleep assertion and durable sleep/wake admission quarantine. */
export class ExecutionPower {
  private readonly activeWork = new Set<string>();
  private assertionFailure: string | null = null;
  private lastAssertionRestartAt = 0;
  private started = false;
  private polling: Promise<void> | undefined;
  // Wall clock, comparable with the kernel's sleep and wake times.
  private lastEndedAt: number | undefined;
  private observedPollStartedAt: number | undefined;
  private observedPollCompletedAt: number | undefined;

  constructor(
    private readonly state: ExecutionState,
    private readonly events: PowerEventSource,
    private readonly assertion: CaffeinateAssertion,
    private readonly reconcile: () => Promise<void>,
    private readonly admissionResumed: () => Promise<void> = async () => {},
  ) {
    this.assertion.on("failure", (reason: unknown) => {
      this.assertionFailure =
        typeof reason === "string"
          ? reason.slice(0, 500)
          : "caffeinate process failed";
      // The assertion otherwise only starts when work goes 0 to 1. start() is a no-op while a
      // child exists, so this cannot double-spawn; the interval stops an immediate-failure loop.
      const now = Date.now();
      if (
        this.activeWork.size === 0 ||
        now - this.lastAssertionRestartAt < assertionRestartMinIntervalMs
      )
        return;
      this.lastAssertionRestartAt = now;
      this.assertion.start().catch(() => {
        this.assertionFailure = "caffeinate process failed to restart";
      });
    });
  }

  async start(): Promise<void> {
    await this.events.start?.();
    this.started = true;
  }

  async executionStarted(workId: string): Promise<void> {
    if (!this.started)
      throw new Error("Execution power supervision is not started");
    if (this.activeWork.has(workId)) return;
    this.activeWork.add(workId);
    if (this.activeWork.size === 1) {
      try {
        await this.assertion.start();
      } catch {
        this.assertionFailure = "caffeinate process failed to start";
      }
    }
  }

  async executionEnded(workId: string): Promise<void> {
    this.lastEndedAt = Date.now();
    this.activeWork.delete(workId);
    if (this.activeWork.size === 0) await this.assertion.stop();
  }

  async poll(): Promise<void> {
    if (!this.started)
      throw new Error("Execution power supervision is not started");
    if (this.polling) return this.polling;
    const startedAt = Date.now();
    const current = this.pollUnlocked().then(async () => {
      // Node's monotonic clock keeps running during macOS sleep, so only the
      // kernel's sleep/wake times show whether the Mac slept during this poll.
      // Completion is taken first; a later sleep still ages it by wall clock.
      const completedAt = Date.now();
      let freshFrom = startedAt;
      if (this.events.lastSleepOrWakeAt) {
        let transitionAt: number;
        try {
          transitionAt = await this.events.lastSleepOrWakeAt();
        } catch {
          transitionAt = Number.POSITIVE_INFINITY;
        }
        if (transitionAt >= startedAt) {
          this.observedPollStartedAt = undefined;
          return;
        }
        freshFrom = completedAt;
      }
      this.observedPollStartedAt = startedAt;
      this.observedPollCompletedAt = freshFrom;
    });
    this.polling = current;
    try {
      await current;
    } finally {
      if (this.polling === current) this.polling = undefined;
    }
  }

  private async pollUnlocked(): Promise<void> {
    const persisted = this.state.powerAdmissionState();
    let batch: unknown;
    try {
      batch = await this.events.readSince(persisted.cursor);
    } catch (error) {
      await this.holdAndReconcile(
        error instanceof PowerLogReadTimeout
          ? "Power-event history read timed out"
          : "Power-event history is unavailable",
      );
      return;
    }

    if (!validBatch(batch, persisted.cursor) || !batch.complete) {
      await this.holdAndReconcile(
        "Power-event history is incomplete or ambiguous",
      );
      return;
    }

    const active = this.state.admittedWorkIds().length > 0;
    if (
      persisted.cursor === null &&
      batch.events.length === 0 &&
      !persisted.held
    ) {
      if (batch.cursor && this.state.setPowerCursorBaseline(batch.cursor))
        return;
      await this.holdAndReconcile(
        "Power-event baseline is missing for admitted work",
      );
      return;
    }

    if (persisted.cursor === null && batch.events.length === 0 && active) {
      await this.holdAndReconcile(
        "Power-event history is missing for admitted work",
      );
      return;
    }

    if (batch.events.length === 0 && !persisted.held) return;

    let cursor = batch.cursor;
    let revision = this.state.holdPowerAdmission(
      batch.events.length > 0
        ? "Power transition requires execution reconciliation"
        : "Power-event admission is awaiting reconciliation",
    );
    await this.reconcileSafely();
    if (this.state.powerReconciliationPending() > 0) return;

    // Re-read from the source's high-water cursor after T4 reconciliation. Any
    // newly observed transition refreshes the durable pending set before the
    // next asynchronous pass; only an empty complete advancement can clear it.
    for (let pass = 0; pass < 4; pass++) {
      if (!cursor) return;
      let next: unknown;
      try {
        next = await this.events.readSince(cursor);
      } catch (error) {
        this.state.holdPowerAdmission(
          error instanceof PowerLogReadTimeout
            ? "Power-event advancement read timed out"
            : "Power-event advancement is unavailable",
        );
        return;
      }
      if (!validBatch(next, cursor) || !next.complete) {
        this.state.holdPowerAdmission(
          "Power-event advancement is incomplete or ambiguous",
        );
        return;
      }
      if (next.events.length === 0) {
        if (this.state.powerReconciliationPending() > 0) return;
        const resumed = this.state.completePowerReconciliation(
          next.cursor ?? cursor,
          revision,
        );
        if (resumed) {
          try {
            await this.admissionResumed();
          } catch {
            // Admission is durable; the service scheduler can be woken again.
          }
        }
        return;
      }
      cursor = next.cursor;
      revision = this.state.holdPowerAdmission(
        "Power transition arrived during execution reconciliation",
      );
      await this.reconcileSafely();
      if (this.state.powerReconciliationPending() > 0) return;
    }
  }

  private async holdAndReconcile(reason: string): Promise<void> {
    this.state.holdPowerAdmission(reason);
    await this.reconcileSafely();
  }

  private async reconcileSafely(): Promise<void> {
    try {
      await this.reconcile();
    } catch {
      // Keep the durable gate and pending-generation ledger for a later pass.
    }
  }

  /**
   * True when a poll that started after the last execution ended is less than
   * 15 s old. When the source proves no sleep or wake happened during the poll,
   * age counts from completion, so a read slower than 15 s still admits instead
   * of re-polling forever; otherwise, or without that proof, from its start.
   */
  observedForAdmission(now = Date.now()): boolean {
    const startedAt = this.observedPollStartedAt;
    const completedAt = this.observedPollCompletedAt;
    if (startedAt === undefined || completedAt === undefined) return false;
    if (this.lastEndedAt !== undefined && startedAt <= this.lastEndedAt)
      return false;
    const age = now - completedAt;
    return age >= 0 && age < 15_000;
  }

  admissionHeld(): boolean {
    return this.state.powerAdmissionState().held;
  }

  status(): {
    assertionFailure: string | null;
    admissionHeld: boolean;
    admissionReason: string | null;
  } {
    const gate = this.state.powerAdmissionState();
    return {
      assertionFailure: this.assertionFailure,
      admissionHeld: gate.held,
      admissionReason: gate.reason,
    };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.activeWork.clear();
    await this.polling?.catch(() => {});
    const failures: Array<{ stage: string; error: unknown }> = [];
    try {
      await this.assertion.stop();
    } catch (error) {
      failures.push({ stage: "assertion stop", error });
    }
    try {
      await this.events.stop?.();
    } catch (error) {
      failures.push({ stage: "power event source stop", error });
    }
    if (failures.length === 1) {
      const [failure] = failures;
      if (failure) throw failure.error;
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures.map(({ error }) => error),
        `Execution power shutdown failed during ${failures.map(({ stage }) => stage).join(", ")}`,
      );
  }
}
