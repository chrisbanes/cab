import { setImmediate as yieldLoop } from "node:timers/promises";
import {
  type WorkspaceMaintenanceAttention,
  type WorkspaceMaintenanceReason,
  workspaceMaintenanceBlockerLimit,
} from "../core/inbox-lifecycle.js";
import type { WorkspaceMaintenanceSettings } from "../operator/workspace-maintenance-settings.js";
import { workspaceMaintenanceSettings as definitions } from "../operator/workspace-maintenance-settings.js";
import type { MeasureRoot } from "./workspace-maintenance-worker.js";

/** The bounded periodic wake: internal scheduling, not a setting. */
export const MAINTENANCE_WAKE_MS = 60_000;
/** An unchanged root is walked again at most this often. */
export const MEASURE_REUSE_MS = 15 * 60_000;
/** A refused effect with unchanged facts waits this long, doubling up to an hour. */
export const REFUSAL_RETRY_MS = 5 * 60_000;
const REFUSAL_RETRY_MAX_MS = 3_600_000;

/**
 * One task workspace generation as stored facts: an advisory snapshot. It never authorizes an
 * effect; the service entry points re-derive every safety check for the named generation.
 */
export interface MaintenanceCandidate {
  taskId: string;
  workspaceId: string;
  /** Measured paths (the workspace root, then its owned Claude base); never leave the service. */
  roots: MeasureRoot["paths"];
  /** The project accepts writes: not archived and not being deleted. */
  writable: boolean;
  /** The task is done or cancelled now. */
  terminal: boolean;
  /** When the current terminal episode began; null when unknown or not terminal. */
  terminalAt: number | null;
  lastTurnEndedAt: number | null;
  /** A completed trim follows the last ended turn, so trimming again frees nothing new. */
  trimmedSinceTurn: boolean;
  /** The last confirmed task push, excluding pushes made by removal. */
  lastPushAt: number | null;
  /** The delivery store knows a push the lifecycle clock never recorded (legacy). */
  pushUnknown: boolean;
  /** First observation that every repository's change request is merged. */
  allMergedAt: number | null;
  /**
   * Stored facts whose change may let a refused effect succeed (task version, delivery policy,
   * last turn end and push). An unchanged one backs a refused effect off.
   */
  fingerprint: string;
}

/**
 * An automatic effect's refusal: a fixed blocker code, or `eligibility-changed` when the
 * service's re-derivation no longer supports the effect. That one is never a blocker and never
 * backs off; the next pass decides again from current facts.
 */
export type MaintenanceRefusal =
  | WorkspaceMaintenanceReason
  | "eligibility-changed";

export type MaintenanceOutcome =
  | { done: true }
  | { done: false; reason: MaintenanceRefusal };

/** What a pass decided an automatic effect from; the service re-derives it under its hold. */
export interface MaintenanceExpectation {
  /** The pass's snapshot: only its identity and clock basis are compared, never trusted. */
  candidate: MaintenanceCandidate;
  trigger: "idle" | "disk" | "delivered" | "merged";
  /** Disk only: the latest measured usage the effect is meant to relieve. */
  measuredBytes?: number | undefined;
}

export interface WorkspaceMaintenanceHost {
  candidates(): MaintenanceCandidate[];
  /** `measuredBytes` is the latest measured usage, for a disk trigger. */
  trim(
    candidate: MaintenanceCandidate,
    trigger: "idle" | "disk",
    measuredBytes?: number,
  ): Promise<MaintenanceOutcome>;
  remove(
    candidate: MaintenanceCandidate,
    trigger: "delivered" | "merged" | "disk",
    measuredBytes?: number,
  ): Promise<MaintenanceOutcome>;
  /** Refreshes the installation Inbox item, or resolves it with null. */
  report(attention: WorkspaceMaintenanceAttention | null): void;
}

export interface WorkspaceMaintenanceOptions {
  /** Read at each decision, never cached across a pass. */
  settings: WorkspaceMaintenanceSettings;
  host: WorkspaceMaintenanceHost;
  measure(
    roots: readonly MeasureRoot[],
    signal: AbortSignal,
  ): Promise<Map<string, number | null>>;
  /** Wall time, compared with persisted anchors; backward steps are clamped. */
  now?: () => number;
  /** Arms the periodic wake; returns its cancellation. */
  every?: (ms: number, wake: () => void) => () => void;
  /** Observes a pass failure; the next wake runs a new pass. */
  failed?: (error: unknown) => void;
}

/** What one pass did and found, for tests and the service log; no paths. */
export interface MaintenancePassReport {
  removed: Array<{ workspaceId: string; trigger: string }>;
  trimmed: Array<{ workspaceId: string; trigger: string }>;
  /** Candidates retained because a needed time fact is unknown. */
  gaps: Array<{ workspaceId: string; reason: "clock-unknown" }>;
  usage: { measuredBytes: number; capBytes: number } | "unknown" | null;
  attention: WorkspaceMaintenanceAttention | null;
}

const hours = (limit: number | "off") =>
  limit === "off" ? null : limit * 3_600_000;

/** Both retentions off disables every automatic removal, disk-triggered ones included. */
export const removalOn = (settings: WorkspaceMaintenanceSettings) =>
  settings.deliveredRetentionHours !== "off" ||
  settings.mergedRetentionHours !== "off";

export const capBytes = (settings: WorkspaceMaintenanceSettings) =>
  settings.diskCapGb === "off"
    ? null
    : settings.diskCapGb * definitions.diskCapGb.multiplier;

/** A trim would free something new and the workspace has been idle for the idle limit. */
export function idleDue(
  candidate: MaintenanceCandidate,
  settings: WorkspaceMaintenanceSettings,
  now: number,
): boolean {
  const idle = hours(settings.idleHours);
  return (
    idle !== null &&
    candidate.lastTurnEndedAt !== null &&
    !candidate.trimmedSinceTurn &&
    now - candidate.lastTurnEndedAt >= idle
  );
}

/** The stored facts an automatic decision rests on; a turn, push, reopen or merge changes them. */
const basis = (c: MaintenanceCandidate) =>
  JSON.stringify([
    c.taskId,
    c.workspaceId,
    c.terminal,
    c.terminalAt,
    c.lastTurnEndedAt,
    c.lastPushAt,
    c.pushUnknown,
    c.allMergedAt,
    c.fingerprint,
  ]);

/**
 * Whether an automatic effect is still due, re-derived from `current` stored facts and current
 * settings with the same rules the pass uses. Any change to the facts the pass decided from
 * refuses, even one that would leave the effect due: the next pass decides again.
 */
export function maintenanceStillDue(
  current: MaintenanceCandidate | undefined,
  expected: MaintenanceExpectation,
  kind: "trim" | "remove",
  settings: WorkspaceMaintenanceSettings,
  now: number,
): boolean {
  if (!current || basis(current) !== basis(expected.candidate)) return false;
  switch (expected.trigger) {
    case "idle":
      return kind === "trim" && idleDue(current, settings, now);
    case "delivered":
    case "merged": {
      const due = retentionDue(current, settings, now);
      return (
        kind === "remove" &&
        due !== null &&
        due !== "unknown" &&
        due.trigger === expected.trigger
      );
    }
    case "disk": {
      const cap = capBytes(settings);
      if (cap === null || !((expected.measuredBytes ?? 0) > cap)) return false;
      return kind === "trim"
        ? current.lastTurnEndedAt !== null && !current.trimmedSinceTurn
        : removalOn(settings) && current.terminal;
    }
  }
}

/**
 * The automatic removal a terminal candidate is due, if any: delivered retention from its last
 * push (or from becoming terminal with nothing pushed), or merged retention when that expires no
 * later. "unknown" when a needed anchor is missing; it is never treated as expired.
 */
export function retentionDue(
  candidate: MaintenanceCandidate,
  settings: WorkspaceMaintenanceSettings,
  now: number,
): { trigger: "delivered" | "merged"; expiredAt: number } | "unknown" | null {
  if (!candidate.terminal) return null;
  const delivered = hours(settings.deliveredRetentionHours),
    merged = hours(settings.mergedRetentionHours);
  const deliveredAnchor = candidate.pushUnknown
    ? null
    : (candidate.lastPushAt ?? candidate.terminalAt);
  const options = [
    merged !== null && candidate.allMergedAt !== null
      ? {
          trigger: "merged" as const,
          expiredAt: candidate.allMergedAt + merged,
        }
      : null,
    delivered !== null && deliveredAnchor !== null
      ? {
          trigger: "delivered" as const,
          expiredAt: deliveredAnchor + delivered,
        }
      : null,
  ]
    .filter((o) => o !== null)
    // The sooner wins; merged wins an exact tie.
    .sort((a, b) => a.expiredAt - b.expiredAt);
  const due = options.find((o) => o.expiredAt <= now);
  if (due) return due;
  if (options.length) return null;
  return delivered !== null || merged !== null ? "unknown" : null;
}

/** Oldest idle first; a workspace id breaks an exact tie. */
const idleOrder = (a: MaintenanceCandidate, b: MaintenanceCandidate) =>
  a.lastTurnEndedAt! - b.lastTurnEndedAt! ||
  a.workspaceId.localeCompare(b.workspaceId);

/**
 * Single-flight automatic workspace maintenance: idle trimming, delivered and merged retention,
 * and the disk cap. A pass awaits each effect and yields between candidates, so coordination is
 * never blocked, and new tasks never wait on it.
 */
export class WorkspaceMaintenance {
  private running: Promise<MaintenancePassReport | undefined> | undefined;
  private again = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private cancelWake: (() => void) | undefined;
  private lastNow = 0;
  /** Last-ended-turn epochs whose idle trim succeeded or was refused for good, in this process. */
  private readonly idleAttempted = new Map<string, number>();
  /**
   * Each root's last measurement.
   * shortcut: a hard-linked inode shared by roots measured in different batches counts twice,
   * upgrade to one batch per pass (or a persisted inode set) if shared hard links become common.
   */
  private readonly measured = new Map<
    string,
    { bytes: number; at: number; stamp: string }
  >();
  /** Refused effects, by `kind:workspaceId`; in memory, so a restart retries each once. */
  private readonly refusals = new Map<
    string,
    {
      fingerprint: string;
      reason: WorkspaceMaintenanceReason;
      retryAt: number;
      delay: number;
    }
  >();

  constructor(private readonly options: WorkspaceMaintenanceOptions) {}

  /** Runs a first pass now and then on every wake. */
  start(): void {
    if (this.stopped || this.cancelWake) return;
    const every =
      this.options.every ??
      ((ms, wake) => {
        const timer = setInterval(wake, ms).unref();
        return () => clearInterval(timer);
      });
    this.cancelWake = every(MAINTENANCE_WAKE_MS, () => void this.wake());
    void this.wake();
  }

  /** Starts a pass, or asks the running one to be followed by another. */
  wake(): Promise<MaintenancePassReport | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      let report: MaintenancePassReport | undefined;
      do {
        this.again = false;
        try {
          report = await this.pass();
        } catch (error) {
          if (!this.stopped) this.options.failed?.(error);
          report = undefined;
        }
      } while (this.again && !this.stopped);
      return report;
    })();
    this.running = run;
    void run.finally(() => {
      if (this.running === run) this.running = undefined;
    });
    return run;
  }

  /** Stops new work and cancels a measurement; `settle` then drains the effect in flight. */
  cancel(): void {
    this.stopped = true;
    this.cancelWake?.();
    this.cancelWake = undefined;
    this.abort.abort(new Error("Workspace maintenance stopped"));
  }

  async settle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  private now(): number {
    this.lastNow = Math.max(this.lastNow, (this.options.now ?? Date.now)());
    return this.lastNow;
  }

  private live(): void {
    if (this.stopped) throw new Error("Workspace maintenance stopped");
  }

  /**
   * Sizes of `candidates`, walking only roots not measured recently or whose last turn or trim
   * changed since; an unknown size is always walked again. A failure is unknown, never zero.
   */
  private async measure(
    candidates: readonly MaintenanceCandidate[],
    now: number,
  ): Promise<Map<string, number | null>> {
    this.live();
    const stamp = (c: MaintenanceCandidate) =>
      `${c.lastTurnEndedAt}:${c.trimmedSinceTurn}`;
    const stale = candidates.filter((c) => {
      const cached = this.measured.get(c.workspaceId);
      return (
        !cached ||
        cached.stamp !== stamp(c) ||
        now - cached.at >= MEASURE_REUSE_MS
      );
    });
    let fresh = new Map<string, number | null>();
    if (stale.length)
      try {
        fresh = await this.options.measure(
          stale.map((c) => ({ key: c.workspaceId, paths: c.roots })),
          this.abort.signal,
        );
      } catch {
        this.live();
      }
    this.live();
    const sizes = new Map<string, number | null>();
    for (const c of candidates) {
      const isStale = stale.includes(c);
      const bytes = isStale
        ? (fresh.get(c.workspaceId) ?? null)
        : this.measured.get(c.workspaceId)!.bytes;
      if (isStale && bytes !== null)
        this.measured.set(c.workspaceId, { bytes, at: now, stamp: stamp(c) });
      else if (isStale) this.measured.delete(c.workspaceId);
      sizes.set(c.workspaceId, bytes);
    }
    for (const id of [...this.measured.keys()])
      if (!sizes.has(id)) this.measured.delete(id);
    return sizes;
  }

  /** Runs one effect unless the same refusal stands on unchanged facts and is backing off. */
  private async attempt(
    kind: "trim" | "remove",
    candidate: MaintenanceCandidate,
    now: number,
    run: () => Promise<MaintenanceOutcome>,
  ): Promise<MaintenanceOutcome & { skipped?: true }> {
    const key = `${kind}:${candidate.workspaceId}`,
      prior = this.refusals.get(key),
      same = prior?.fingerprint === candidate.fingerprint;
    if (prior && same && now < prior.retryAt)
      return { done: false, reason: prior.reason, skipped: true };
    this.live();
    const outcome = await run();
    if (outcome.done) this.refusals.delete(key);
    else if (outcome.reason !== "eligibility-changed") {
      const delay =
        prior && same
          ? Math.min(prior.delay * 2, REFUSAL_RETRY_MAX_MS)
          : REFUSAL_RETRY_MS;
      this.refusals.set(key, {
        fingerprint: candidate.fingerprint,
        reason: outcome.reason,
        retryAt: now + delay,
        delay,
      });
    }
    return outcome;
  }

  private async pass(): Promise<MaintenancePassReport> {
    const { settings, host } = this.options;
    const now = this.now();
    const report: MaintenancePassReport = {
      removed: [],
      trimmed: [],
      gaps: [],
      usage: null,
      attention: null,
    };
    const retention: WorkspaceMaintenanceAttention["blockers"] = [];
    const blocker = (
      c: MaintenanceCandidate,
      condition: "disk-cap" | "retention",
      reason: WorkspaceMaintenanceReason,
    ) => ({ taskId: c.taskId, workspaceId: c.workspaceId, condition, reason });
    const isBlocker = (
      reason: MaintenanceRefusal,
    ): reason is WorkspaceMaintenanceReason => reason !== "eligibility-changed";
    const step = async () => {
      await yieldLoop();
      this.live();
    };
    // Facts can change while an effect awaits, so they are read again after every effect and
    // each decision uses the latest read. The service still re-derives each one under its hold.
    let candidates = host.candidates();
    const refresh = () => {
      candidates = host.candidates();
    };
    const latest = (workspaceId: string) =>
      candidates.find((c) => c.workspaceId === workspaceId);

    // Retention: a terminal workspace past its delivered or merged limit.
    if (removalOn(settings))
      for (const { workspaceId } of [...candidates]) {
        const candidate = latest(workspaceId);
        if (!candidate) continue;
        const due = retentionDue(candidate, settings, now);
        if (due === "unknown") {
          report.gaps.push({
            workspaceId: candidate.workspaceId,
            reason: "clock-unknown",
          });
          continue;
        }
        if (!due) continue;
        const outcome = candidate.writable
          ? await this.attempt("remove", candidate, now, () =>
              host.remove(candidate, due.trigger),
            )
          : { done: false as const, reason: "project-read-only" as const };
        if (!("skipped" in outcome)) refresh();
        if (outcome.done)
          report.removed.push({
            workspaceId: candidate.workspaceId,
            trigger: due.trigger,
          });
        else if (isBlocker(outcome.reason))
          retention.push(blocker(candidate, "retention", outcome.reason));
        await step();
      }

    // Idle: one trim attempt per last-ended-turn epoch.
    if (settings.idleHours !== "off")
      for (const { workspaceId } of [...candidates]) {
        const candidate = latest(workspaceId);
        const ended = candidate?.lastTurnEndedAt ?? null;
        if (
          !candidate ||
          ended === null ||
          !candidate.writable ||
          !idleDue(candidate, settings, now) ||
          this.idleAttempted.get(candidate.workspaceId) === ended
        )
          continue;
        const outcome = await this.attempt("trim", candidate, now, () =>
          host.trim(candidate, "idle"),
        );
        // A refusal that may clear by itself (a running turn, a hold, changed facts) retries in
        // this epoch; success or any other refusal ends the epoch.
        if (
          outcome.done ||
          (outcome.reason !== "unsettled" &&
            outcome.reason !== "maintenance-held" &&
            outcome.reason !== "eligibility-changed")
        )
          this.idleAttempted.set(candidate.workspaceId, ended);
        if (!("skipped" in outcome)) refresh();
        if (outcome.done)
          report.trimmed.push({
            workspaceId: candidate.workspaceId,
            trigger: "idle",
          });
        await step();
      }

    // Disk cap: trim oldest idle first, then remove terminal ones, remeasuring after each and
    // stopping once the latest measurement is within the cap.
    let cap: Pick<WorkspaceMaintenanceAttention, "usage" | "blockers"> = {
      usage: null,
      blockers: [],
    };
    if (capBytes(settings) !== null) {
      let sizes = await this.measure(candidates, now);
      const total = () =>
        candidates.reduce((sum, c) => sum + (sizes.get(c.workspaceId) ?? 0), 0);
      const unmeasured = () =>
        candidates.filter((c) => sizes.get(c.workspaceId) === null);
      // Only the root an effect touched is walked again; a removed one drops out.
      const remeasure = async () => {
        sizes = await this.measure(candidates, now);
      };
      const over = () => {
        const limit = capBytes(settings);
        return limit !== null && total() > limit;
      };
      if (!over() && unmeasured().length) {
        // Known usage is under the cap but some is unknown, so the cap is unconfirmed: name each
        // unmeasured workspace instead of resolving the condition.
        report.usage = "unknown";
        cap = {
          usage: null,
          blockers: unmeasured().map((c) =>
            blocker(c, "disk-cap", "unmeasured"),
          ),
        };
      } else if (over()) {
        const refused = new Map<string, WorkspaceMaintenanceReason>();
        // Workspaces whose facts changed under an effect: named by the next pass, not this one.
        const changed = new Set<string>();
        const ranked = () =>
          candidates
            .filter(
              (c) =>
                c.lastTurnEndedAt !== null && sizes.get(c.workspaceId) !== null,
            )
            .sort(idleOrder)
            .map((c) => c.workspaceId);
        const settle = async (
          candidate: MaintenanceCandidate,
          kind: "trim" | "remove",
          outcome: MaintenanceOutcome & { skipped?: true },
        ) => {
          if (outcome.done)
            report[kind === "trim" ? "trimmed" : "removed"].push({
              workspaceId: candidate.workspaceId,
              trigger: "disk",
            });
          else if (isBlocker(outcome.reason))
            refused.set(candidate.workspaceId, outcome.reason);
          else changed.add(candidate.workspaceId);
          if (!("skipped" in outcome)) {
            refresh();
            await remeasure();
          }
          await step();
        };
        for (const workspaceId of ranked()) {
          if (!over()) break;
          const candidate = latest(workspaceId);
          if (
            !candidate ||
            candidate.lastTurnEndedAt === null ||
            candidate.trimmedSinceTurn ||
            !(sizes.get(workspaceId) ?? 0)
          )
            continue;
          if (!candidate.writable) {
            refused.set(workspaceId, "project-read-only");
            continue;
          }
          const pressure = total();
          await settle(
            candidate,
            "trim",
            await this.attempt("trim", candidate, now, () =>
              host.trim(candidate, "disk", pressure),
            ),
          );
        }
        for (const workspaceId of ranked()) {
          if (!over()) break;
          const candidate = latest(workspaceId);
          if (
            !candidate?.terminal ||
            refused.has(workspaceId) ||
            changed.has(workspaceId)
          )
            continue;
          if (!removalOn(settings)) {
            refused.set(workspaceId, "removal-off");
            continue;
          }
          if (!candidate.writable) {
            refused.set(workspaceId, "project-read-only");
            continue;
          }
          const pressure = total();
          await settle(
            candidate,
            "remove",
            await this.attempt("remove", candidate, now, () =>
              host.remove(candidate, "disk", pressure),
            ),
          );
        }
        const limit = capBytes(settings);
        if (over() && limit !== null) {
          cap = {
            usage: { measuredBytes: total(), capBytes: limit },
            blockers: candidates
              .filter(
                (c) =>
                  (sizes.get(c.workspaceId) ?? 1) > 0 &&
                  !changed.has(c.workspaceId),
              )
              .map((c) =>
                blocker(
                  c,
                  "disk-cap",
                  sizes.get(c.workspaceId) === null
                    ? "unmeasured"
                    : c.lastTurnEndedAt === null
                      ? "clock-unknown"
                      : (refused.get(c.workspaceId) ??
                        (!c.writable
                          ? "project-read-only"
                          : c.terminal
                            ? "refused"
                            : "task-open")),
                ),
              ),
          };
        } else if (unmeasured().length) {
          // Effects brought known usage within the cap, but unknown usage leaves it unconfirmed.
          cap = {
            usage: null,
            blockers: unmeasured().map((c) =>
              blocker(c, "disk-cap", "unmeasured"),
            ),
          };
          report.usage = "unknown";
        }
        if (report.usage !== "unknown") report.usage = cap.usage;
      }
    }
    this.live();
    // A retention refusal is reported only while the latest facts still have it due; one whose
    // facts changed since (reopened, pushed, removed) is decided again by the next pass.
    const all = [
      ...retention.filter((b) => {
        const c = latest(b.workspaceId);
        const due = c && retentionDue(c, settings, now);
        return !!due && due !== "unknown";
      }),
      ...cap.blockers,
    ];
    const attention =
      cap.usage || all.length
        ? {
            usage: cap.usage,
            blockers: all.slice(0, workspaceMaintenanceBlockerLimit),
            total: all.length,
          }
        : null;
    report.attention = attention;
    host.report(attention);
    return report;
  }
}

/**
 * Fallback reason codes for a service refusal that carries no code; its text may carry Git or
 * provider detail, which never leaves here.
 */
export function maintenanceReason(reason: string): WorkspaceMaintenanceReason {
  const table: Array<[RegExp, WorkspaceMaintenanceReason]> = [
    [/^Only a done or cancelled task/, "task-open"],
    [/^Pushing .* was refused/, "push-refused"],
    [
      /unfinished maintenance|Workspace removal stopped|interrupted/i,
      "maintenance-held",
    ],
    [/^Uncommitted work remains/, "uncommitted"],
    [/^Result .* recorded uncommitted changes/, "pending-result"],
    [/does not provably follow|changed outside cab/, "history"],
    [/delivery actions/i, "delivery-unsettled"],
    [/not settled|is held|callback .* still running|replaced/i, "unsettled"],
    [/[Aa]rchived projects are read-only|being deleted/, "project-read-only"],
  ];
  return table.find(([pattern]) => pattern.test(reason))?.[1] ?? "refused";
}
