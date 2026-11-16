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
}

export type MaintenanceOutcome =
  | { done: true }
  | { done: false; reason: WorkspaceMaintenanceReason };

export interface WorkspaceMaintenanceHost {
  candidates(): MaintenanceCandidate[];
  trim(
    candidate: MaintenanceCandidate,
    trigger: "idle" | "disk",
  ): Promise<MaintenanceOutcome>;
  remove(
    candidate: MaintenanceCandidate,
    trigger: "delivered" | "merged" | "disk",
  ): Promise<MaintenanceOutcome>;
  /** Refreshes the installation Inbox item, or resolves it with null. */
  report(attention: WorkspaceMaintenanceAttention | null): void;
}

export interface WorkspaceMaintenanceOptions {
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
  /** Last-ended-turn epochs already given one idle trim attempt in this process. */
  private readonly idleAttempted = new Map<string, number>();
  private previousCap: {
    usage: { measuredBytes: number; capBytes: number } | null;
    blockers: WorkspaceMaintenanceAttention["blockers"];
  } = { usage: null, blockers: [] };

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

  private async measure(
    candidates: readonly MaintenanceCandidate[],
  ): Promise<Map<string, number | null>> {
    this.live();
    try {
      const sizes = await this.options.measure(
        candidates.map((c) => ({ key: c.workspaceId, paths: c.roots })),
        this.abort.signal,
      );
      this.live();
      return sizes;
    } catch {
      this.live();
      // A failed measurement is unknown usage, never zero.
      return new Map(candidates.map((c) => [c.workspaceId, null]));
    }
  }

  private async pass(): Promise<MaintenancePassReport> {
    const { settings, host } = this.options;
    const now = this.now();
    const removalOn =
      settings.deliveredRetentionHours !== "off" ||
      settings.mergedRetentionHours !== "off";
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
    const step = async () => {
      await yieldLoop();
      this.live();
    };

    // Retention: a terminal workspace past its delivered or merged limit.
    if (removalOn)
      for (const candidate of host.candidates()) {
        const due = retentionDue(candidate, settings, now);
        if (due === "unknown") {
          report.gaps.push({
            workspaceId: candidate.workspaceId,
            reason: "clock-unknown",
          });
          continue;
        }
        if (!due) continue;
        this.live();
        const outcome = candidate.writable
          ? await host.remove(candidate, due.trigger)
          : { done: false as const, reason: "project-read-only" as const };
        if (outcome.done)
          report.removed.push({
            workspaceId: candidate.workspaceId,
            trigger: due.trigger,
          });
        else retention.push(blocker(candidate, "retention", outcome.reason));
        await step();
      }

    // Idle: one trim attempt per last-ended-turn epoch.
    const idle = hours(settings.idleHours);
    if (idle !== null)
      for (const candidate of host.candidates()) {
        const ended = candidate.lastTurnEndedAt;
        if (
          ended === null ||
          candidate.trimmedSinceTurn ||
          !candidate.writable ||
          now - ended < idle ||
          this.idleAttempted.get(candidate.workspaceId) === ended
        )
          continue;
        this.live();
        this.idleAttempted.set(candidate.workspaceId, ended);
        if ((await host.trim(candidate, "idle")).done)
          report.trimmed.push({
            workspaceId: candidate.workspaceId,
            trigger: "idle",
          });
        await step();
      }

    // Disk cap: trim oldest idle first, then remove terminal ones, remeasuring after each.
    let cap = { usage: null, blockers: [] } as typeof this.previousCap;
    if (settings.diskCapGb !== "off") {
      const capBytes = settings.diskCapGb * definitions.diskCapGb.multiplier;
      let candidates = host.candidates();
      let sizes = await this.measure(candidates);
      const total = () =>
        candidates.reduce((sum, c) => sum + (sizes.get(c.workspaceId) ?? 0), 0);
      const unknown = () =>
        candidates.some((c) => sizes.get(c.workspaceId) === null);
      const remeasure = async () => {
        candidates = host.candidates();
        sizes = await this.measure(candidates);
      };
      const over = () => total() > capBytes;
      if (!over() && unknown()) {
        // Known usage is under the cap but some is unknown: the cap's state is unknown.
        report.usage = "unknown";
        cap = this.previousCap;
      } else if (over()) {
        const refused = new Map<string, WorkspaceMaintenanceReason>();
        const ranked = () =>
          candidates
            .filter(
              (c) =>
                c.lastTurnEndedAt !== null && sizes.get(c.workspaceId) !== null,
            )
            .sort(idleOrder);
        for (const candidate of ranked()) {
          if (!over()) break;
          if (
            candidate.trimmedSinceTurn ||
            !(sizes.get(candidate.workspaceId) ?? 0)
          )
            continue;
          if (!candidate.writable) {
            refused.set(candidate.workspaceId, "project-read-only");
            continue;
          }
          this.live();
          const outcome = await host.trim(candidate, "disk");
          if (outcome.done)
            report.trimmed.push({
              workspaceId: candidate.workspaceId,
              trigger: "disk",
            });
          else refused.set(candidate.workspaceId, outcome.reason);
          await remeasure();
          await step();
        }
        for (const candidate of ranked()) {
          if (!over()) break;
          if (!candidate.terminal || refused.has(candidate.workspaceId))
            continue;
          if (!removalOn) {
            refused.set(candidate.workspaceId, "removal-off");
            continue;
          }
          if (!candidate.writable) {
            refused.set(candidate.workspaceId, "project-read-only");
            continue;
          }
          this.live();
          const outcome = await host.remove(candidate, "disk");
          if (outcome.done)
            report.removed.push({
              workspaceId: candidate.workspaceId,
              trigger: "disk",
            });
          else refused.set(candidate.workspaceId, outcome.reason);
          await remeasure();
          await step();
        }
        if (over()) {
          cap = {
            usage: { measuredBytes: total(), capBytes },
            blockers: candidates
              .filter((c) => (sizes.get(c.workspaceId) ?? 1) > 0)
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
        }
        report.usage = cap.usage;
      }
    }
    this.previousCap = cap;
    this.live();
    const attention =
      cap.usage || retention.length
        ? {
            usage: cap.usage,
            blockers: [...retention, ...cap.blockers].slice(
              0,
              workspaceMaintenanceBlockerLimit,
            ),
          }
        : null;
    report.attention = attention;
    host.report(attention);
    return report;
  }
}

/** Fixed reason codes for a service refusal; its text may carry Git or provider detail. */
export function maintenanceReason(reason: string): WorkspaceMaintenanceReason {
  const table: Array<[RegExp, WorkspaceMaintenanceReason]> = [
    [/^Only a done or cancelled task/, "task-open"],
    [
      /unfinished maintenance|Workspace removal stopped|interrupted/i,
      "maintenance-held",
    ],
    [/^Uncommitted work remains/, "uncommitted"],
    [/^Result .* recorded uncommitted changes/, "pending-result"],
    [/^Pushing .* was refused/, "push-refused"],
    [/does not provably follow|changed outside cab/, "history"],
    [/delivery actions/i, "delivery-unsettled"],
    [/not settled|is held|callback .* still running|replaced/i, "unsettled"],
    [/[Aa]rchived projects are read-only|being deleted/, "project-read-only"],
  ];
  return table.find(([pattern]) => pattern.test(reason))?.[1] ?? "refused";
}
