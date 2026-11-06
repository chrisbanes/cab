import { useEffect, useRef, useState } from "react";

/** The part of `EventSource` the stream uses. */
export interface ChangeSource {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export interface TaskChangeStreamOptions {
  url: string;
  /** Refetch the task read (and with it the timeline): a `read` notice, or a (re)connect that may have missed one. */
  onRead: () => void;
  /** Refetch only the newest timeline page. */
  onTimeline: () => void;
  onHealthy: (healthy: boolean) => void;
  open?: (url: string) => ChangeSource;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
  random?: () => number;
  /** Whether the page is hidden, and a subscription to changes; returns the unsubscribe. */
  visibility?: {
    hidden: () => boolean;
    watch: (changed: () => void) => () => void;
  };
}

export const streamTiming = {
  debounceMs: 300,
  maxWaitMs: 2_000,
  firstRetryMs: 1_000,
  maxRetryMs: 30_000,
  jitter: 0.2,
  silenceMs: 45_000,
  hiddenCloseMs: 60_000,
} as const;

/**
 * One task's change stream. Healthy from the first frame of a connection,
 * which also refetches once; reconnects with jittered back-off after an error
 * or 45 s of silence; closes after 60 s hidden and reopens when visible.
 * Notices are debounced (trailing, with a maximum wait).
 */
export class TaskChangeStream {
  private source: ChangeSource | undefined;
  private healthy = false;
  private attempt = 0;
  private retry: unknown;
  private silence: unknown;
  private hiding: unknown;
  private hiddenClosed = false;
  private flushTimer: unknown;
  private pending: "read" | "timeline" | undefined;
  private pendingSince = 0;
  private disposed = false;
  private readonly unwatch: () => void;
  private readonly open: (url: string) => ChangeSource;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly visibility: NonNullable<
    TaskChangeStreamOptions["visibility"]
  >;

  constructor(private readonly options: TaskChangeStreamOptions) {
    this.open = options.open ?? ((url) => new EventSource(url));
    this.setTimer =
      options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms));
    this.clearTimer =
      options.clearTimer ??
      ((timer) =>
        globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.visibility = options.visibility ?? {
      hidden: () => document.visibilityState === "hidden",
      watch: (changed) => {
        document.addEventListener("visibilitychange", changed);
        return () => document.removeEventListener("visibilitychange", changed);
      },
    };
    this.unwatch = this.visibility.watch(() => this.visibilityChanged());
    this.connect();
    this.visibilityChanged();
  }

  dispose(): void {
    this.disposed = true;
    this.unwatch();
    this.disconnect();
    this.clearTimer(this.retry);
    this.clearTimer(this.hiding);
    this.clearTimer(this.flushTimer);
  }

  private connect(): void {
    const source = this.open(this.options.url);
    this.source = source;
    const frame = (kind?: "read" | "timeline") => () => {
      if (this.source !== source) return;
      this.watchSilence();
      if (!this.healthy) {
        this.healthy = true;
        this.attempt = 0;
        this.options.onHealthy(true);
        this.options.onRead();
      }
      if (kind) this.notice(kind);
    };
    source.addEventListener("heartbeat", frame());
    source.addEventListener("read", frame("read"));
    source.addEventListener("timeline", frame("timeline"));
    // Native EventSource gives up on a non-200 answer; this stream owns every retry.
    source.addEventListener("error", () => {
      if (this.source === source) this.reconnect();
    });
    this.watchSilence();
  }

  /** Closes the source; the 15-second poll covers the page until a frame arrives again. */
  private disconnect(): void {
    this.source?.close();
    this.source = undefined;
    this.clearTimer(this.silence);
    if (this.healthy) {
      this.healthy = false;
      this.options.onHealthy(false);
    }
  }

  private reconnect(): void {
    this.disconnect();
    const base = Math.min(
      streamTiming.maxRetryMs,
      streamTiming.firstRetryMs * 2 ** this.attempt,
    );
    this.attempt += 1;
    const delay = base * (1 + (this.random() * 2 - 1) * streamTiming.jitter);
    this.retry = this.setTimer(() => {
      if (!this.disposed && !this.hiddenClosed) this.connect();
    }, delay);
  }

  private watchSilence(): void {
    this.clearTimer(this.silence);
    this.silence = this.setTimer(
      () => this.reconnect(),
      streamTiming.silenceMs,
    );
  }

  private visibilityChanged(): void {
    if (this.disposed) return;
    this.clearTimer(this.hiding);
    if (this.visibility.hidden()) {
      this.hiding = this.setTimer(() => {
        this.hiddenClosed = true;
        this.clearTimer(this.retry);
        this.disconnect();
      }, streamTiming.hiddenCloseMs);
    } else if (this.hiddenClosed) {
      this.hiddenClosed = false;
      this.attempt = 0;
      this.connect();
    }
  }

  private notice(kind: "read" | "timeline"): void {
    if (this.pending === undefined) this.pendingSince = this.now();
    this.pending = this.pending === "read" ? "read" : kind;
    this.clearTimer(this.flushTimer);
    const wait = Math.min(
      streamTiming.debounceMs,
      this.pendingSince + streamTiming.maxWaitMs - this.now(),
    );
    this.flushTimer = this.setTimer(() => this.flush(), Math.max(0, wait));
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === "read") this.options.onRead();
    else if (pending === "timeline") this.options.onTimeline();
  }
}

/** The task's change stream while `enabled`; `healthy` suspends the page's polling. */
export function useTaskChangeStream({
  taskId,
  enabled,
  onRead,
  onTimeline,
}: {
  taskId: string;
  enabled: boolean;
  onRead: () => void;
  onTimeline: () => void;
}): { healthy: boolean } {
  const [healthy, setHealthy] = useState(false);
  const handlers = useRef({ onRead, onTimeline });
  handlers.current = { onRead, onTimeline };
  useEffect(() => {
    if (!enabled) return;
    const stream = new TaskChangeStream({
      url: `/api/operator/tasks/${encodeURIComponent(taskId)}/stream`,
      onRead: () => handlers.current.onRead(),
      onTimeline: () => handlers.current.onTimeline(),
      onHealthy: setHealthy,
    });
    return () => {
      stream.dispose();
      setHealthy(false);
    };
  }, [taskId, enabled]);
  return { healthy: enabled && healthy };
}
