import type { ServerResponse } from "node:http";
import type {
  TaskChangeEvent,
  TaskChangeFeed,
  TaskChangeIds,
} from "./task-change-feed.js";

/** Open streams allowed per session and in total; HTTP/1.1 browsers allow six connections per origin. */
export const taskStreamLimits = { perSession: 3, total: 32 } as const;
const defaultHeartbeatMs = 15_000;

interface TaskStream {
  readonly sessionId: string;
  readonly response: ServerResponse;
  /** Whether the stream's session is still signed in; refreshes its idle timer. */
  readonly current: () => boolean;
  stop: () => void;
  stalledBeats: number;
}

function frame(event: "heartbeat" | Exclude<TaskChangeEvent, "gone">): string {
  return `event: ${event}\ndata: {}\n\n`;
}

/**
 * Open task change streams: content-free `read`, `timeline` and `heartbeat`
 * server-sent events. One shared timer sends heartbeats, ends a stream whose
 * session has ended and destroys one whose reader stalled for two beats.
 */
export class TaskStreams {
  private readonly streams = new Set<TaskStream>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly feed: TaskChangeFeed,
    private readonly heartbeatMs = defaultHeartbeatMs,
  ) {}

  /** Whether one more stream fits within `taskStreamLimits`. */
  admits(sessionId: string): boolean {
    if (this.streams.size >= taskStreamLimits.total) return false;
    let open = 0;
    for (const stream of this.streams)
      if (stream.sessionId === sessionId) open += 1;
    return open < taskStreamLimits.perSession;
  }

  /** Starts the event stream on an admitted response. */
  open(
    sessionId: string,
    response: ServerResponse,
    headers: Readonly<Record<string, string>>,
    resolve: () => TaskChangeIds | undefined,
    current: () => boolean,
  ): void {
    response.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.socket?.setTimeout(0);
    response.socket?.setKeepAlive(true);
    const stream: TaskStream = {
      sessionId,
      response,
      current,
      stop: () => undefined,
      stalledBeats: 0,
    };
    this.streams.add(stream);
    response.once("close", () => this.end(stream));
    response.write(frame("heartbeat"));
    // A slow reader's frames stay small and coalesced; the heartbeat destroys a stalled one.
    const stop = this.feed.watch(resolve, (event) =>
      event === "gone" ? this.end(stream) : response.write(frame(event)),
    );
    if (this.streams.has(stream)) stream.stop = stop;
    else stop();
    this.timer ??= setInterval(() => this.beat(), this.heartbeatMs).unref();
  }

  /** Ends the session's streams, as at sign-out. */
  closeSession(sessionId: string): void {
    for (const stream of this.streams)
      if (stream.sessionId === sessionId) this.end(stream);
  }

  closeAll(): void {
    for (const stream of this.streams) this.end(stream);
  }

  private beat(): void {
    for (const stream of this.streams) {
      if (!stream.current()) {
        this.end(stream);
        continue;
      }
      if (!stream.response.writableNeedDrain) stream.stalledBeats = 0;
      else if (++stream.stalledBeats >= 2) {
        this.end(stream);
        stream.response.destroy();
        continue;
      }
      stream.response.write(frame("heartbeat"));
    }
  }

  private end(stream: TaskStream): void {
    if (!this.streams.delete(stream)) return;
    stream.stop();
    if (!stream.response.writableEnded) stream.response.end();
    if (this.streams.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
