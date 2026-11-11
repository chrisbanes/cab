import type { HeldTurnCandidate, HeldTurnReleaseBasis } from "./state.js";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { SupervisorClock } from "./supervisor.js";

/** What held-turn release reads and writes; the service binds it to its state and runtimes. */
export interface HeldTurnReleaseHost {
  candidates(): HeldTurnCandidate[];
  /** Durable and in-process holds other than the turn itself; any one keeps the turn held. */
  blockers(workId: string): readonly string[];
  /** The bound runtime's `interruptTurn`; never a stop or restart of the runtime. */
  interrupt(candidate: HeldTurnCandidate & { turnId: string }): Promise<void>;
  recordInterrupt(
    candidate: HeldTurnCandidate,
    state: "pending" | "acknowledged" | "failed" | "unbound",
  ): void;
  /** The runtime durably reported this exact turn's terminal. */
  turnEnded(candidate: HeldTurnCandidate): boolean;
  /** The recorded process was verified to have exited (false for Claude, which has none). */
  processExited(workId: string): Promise<boolean>;
  release(workId: string, basis: HeldTurnReleaseBasis): boolean;
  released(workId: string, basis: HeldTurnReleaseBasis): void;
  failed(error: unknown): void;
}

export interface HeldTurnReleaseOptions {
  /** Quiet period after the interrupt, the last runtime event or callback, or service start. */
  quietMs?: number;
  /** How often held turns are checked; default one minute. */
  pollMs?: number;
  clock?: SupervisorClock;
  wallNow?: () => number;
}

const defaultClock: SupervisorClock = {
  monotonicNow: () => performance.now(),
  async sleep(milliseconds, signal) {
    try {
      await delay(milliseconds, undefined, { signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  },
};

interface Watch {
  /** The turn last interrupted; `undefined` before the first interrupt. */
  interrupted: string | null | undefined;
  quietFrom: number;
  exited: boolean;
  /** When process exit was last checked, so wake-driven passes don't repeat it. */
  exitCheckedAt: number | undefined;
}

/**
 * Interrupts each held turn once and releases its writer and capacity on the first of: the
 * runtime reports the turn ended, its process is verified to have exited, or the quiet period
 * passes. The quiet clock is in memory, so after a restart it starts again from service start.
 */
export class HeldTurnRelease {
  private readonly watches = new Map<string, Watch>();
  private readonly controller = new AbortController();
  private readonly clock: SupervisorClock;
  private readonly quietMs: number;
  private readonly pollMs: number;
  private readonly wallNow: () => number;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly host: HeldTurnReleaseHost,
    options: HeldTurnReleaseOptions = {},
  ) {
    this.clock = options.clock ?? defaultClock;
    this.quietMs = options.quietMs ?? 30 * 60_000;
    this.pollMs = options.pollMs ?? 60_000;
    this.wallNow = options.wallNow ?? Date.now;
  }

  /** Checks held turns every poll interval until `stop`. */
  start(): void {
    void (async () => {
      const { signal } = this.controller;
      while (!signal.aborted) {
        await this.clock.sleep(this.nextWakeMs(), signal);
        if (!signal.aborted) await this.sweep();
      }
    })();
  }

  /** The poll interval, or sooner when a quiet period ends first. */
  private nextWakeMs(): number {
    const now = this.clock.monotonicNow();
    let wake = this.pollMs;
    // A turn whose ID was never saved has no quiet deadline, and a deadline a pass has
    // already judged waits for the next poll, so an unreleased watch never spins the loop.
    for (const watch of this.watches.values()) {
      const left = watch.quietFrom + this.quietMs - now;
      if (watch.interrupted !== null && left > 0) wake = Math.min(wake, left);
    }
    return Math.max(1, Math.ceil(wake));
  }

  stop(): void {
    this.controller.abort();
  }

  /** A runtime event or callback for this work restarts its quiet period. */
  noteActivity(workId: string): void {
    const watch = this.watches.get(workId);
    if (watch) watch.quietFrom = this.clock.monotonicNow();
  }

  /** When a waiting held turn's quiet period ends, as wall-clock milliseconds; activity moves it. */
  releasesBy(workId: string): number | undefined {
    const watch = this.watches.get(workId);
    if (
      !watch ||
      watch.interrupted === null ||
      this.host.blockers(workId).length
    )
      return undefined;
    return Math.round(
      this.wallNow() +
        watch.quietFrom +
        this.quietMs -
        this.clock.monotonicNow(),
    );
  }

  /** One serialized pass; a call during a pass runs another after it. */
  sweep(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (error) {
          this.host.failed(error);
        }
      } while (this.again && !this.controller.signal.aborted);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const candidates = this.host.candidates();
    const live = new Set(candidates.map((candidate) => candidate.workId));
    for (const workId of this.watches.keys())
      if (!live.has(workId)) this.watches.delete(workId);
    for (const candidate of candidates) {
      if (this.controller.signal.aborted) return;
      const now = this.clock.monotonicNow();
      let watch = this.watches.get(candidate.workId);
      if (this.host.blockers(candidate.workId).length) {
        // Independent holds win; the quiet period counts from when they clear.
        if (watch) watch.quietFrom = now;
        continue;
      }
      if (!watch) {
        watch = {
          interrupted: undefined,
          quietFrom: now,
          exited: false,
          exitCheckedAt: undefined,
        };
        this.watches.set(candidate.workId, watch);
      }
      // The process may exit at any time, the interrupt among the causes, so exit is checked
      // again on later passes, at most once a poll interval however often cab wakes.
      if (
        !watch.exited &&
        !this.host.turnEnded(candidate) &&
        (watch.exitCheckedAt === undefined ||
          now - watch.exitCheckedAt >= this.pollMs)
      ) {
        watch.exitCheckedAt = now;
        watch.exited = await this.host
          .processExited(candidate.workId)
          .catch(() => false);
        if (this.controller.signal.aborted) return;
      }
      if (this.host.blockers(candidate.workId).length) continue;
      const proven: HeldTurnReleaseBasis | undefined = this.host.turnEnded(
        candidate,
      )
        ? "turn-ended"
        : watch.exited
          ? "process-exited"
          : undefined;
      // Interrupted once per bound turn; the record it writes is what a release completes.
      if (watch.interrupted !== candidate.turnId) {
        watch.interrupted = candidate.turnId;
        watch.quietFrom = this.clock.monotonicNow();
        this.interrupt(candidate);
      }
      // Without a saved turn, cab cannot attribute the turn's activity to it, so silence
      // proves nothing: such a turn releases only on a verified process exit.
      const basis =
        proven ??
        (candidate.turnId !== null &&
        this.clock.monotonicNow() - watch.quietFrom >= this.quietMs
          ? "quiet-period"
          : undefined);
      if (basis && this.host.release(candidate.workId, basis)) {
        this.watches.delete(candidate.workId);
        this.host.released(candidate.workId, basis);
      }
    }
  }

  private interrupt(candidate: HeldTurnCandidate): void {
    const { turnId } = candidate;
    if (turnId === null) {
      this.host.recordInterrupt(candidate, "unbound");
      return;
    }
    this.host.recordInterrupt(candidate, "pending");
    const record = (state: "acknowledged" | "failed") => {
      try {
        if (this.watches.get(candidate.workId)?.interrupted === turnId)
          this.host.recordInterrupt(candidate, state);
      } catch (error) {
        this.host.failed(error);
      }
    };
    // A failed interrupt is recorded and the other release bases still apply.
    this.host.interrupt({ ...candidate, turnId }).then(
      () => record("acknowledged"),
      () => record("failed"),
    );
  }
}
