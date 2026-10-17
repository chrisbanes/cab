import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type {
  RuntimeRestartAttempt,
  RuntimeRestartFailure,
} from "../operator/contracts.js";
import type { SupervisorClock } from "./supervisor.js";

/** Delay before attempt 1, 2 and 3; a fourth failure stops until the operator acts. */
export const runtimeRestartDelaysMs = [30_000, 120_000, 600_000] as const;
/** A runtime that stayed available this long starts a fresh schedule on its next failure. */
export const runtimeRestartStableMs = 600_000;

export interface RuntimeRestartOptions {
  /** Backoff and stability follow this monotonic clock; a wall-clock jump never moves an attempt. */
  clock?: SupervisorClock;
  /** Shown and serialised times (`since`, `nextAt`, attempt `at`) only. */
  wallNow?: () => number;
}

/** Sleeps never keep the process alive; an aborted sleep resolves, so callers check the signal. */
export const defaultRestartClock: SupervisorClock = {
  monotonicNow: () => performance.now(),
  async sleep(milliseconds, signal) {
    try {
      await delay(milliseconds, undefined, { signal, ref: false });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  },
};

/** One harness's in-memory schedule; see StandaloneService.noteRuntimeUnavailable. */
export interface RestartState {
  /** Attempts consumed since the last reset (0..3). */
  attempts: number;
  history: RuntimeRestartAttempt[];
  /** Monotonic time the runtime last started; cleared when it is next noted unavailable. */
  availableAt: number | undefined;
  /** The first failure of the current unavailable episode. */
  lastFailure: RuntimeRestartFailure | undefined;
  /** A sleeping retry; its token identifies it to the callbacks it queues. */
  pending:
    | {
        token: object;
        abort: AbortController;
        attempt: number;
        nextAt: number;
      }
    | undefined;
  inFlight: boolean;
  /** Wall time the third failure stopped the schedule; cleared only by an operator toggle. */
  exhaustedAt: number | undefined;
}

export function newRestartState(): RestartState {
  return {
    attempts: 0,
    history: [],
    availableAt: undefined,
    lastFailure: undefined,
    pending: undefined,
    inFlight: false,
    exhaustedAt: undefined,
  };
}
