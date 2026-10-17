import type { SupervisorClock } from "../../src/standalone/supervisor.js";

/**
 * A fake clock for the runtime restart schedule: many concurrent sleepers, so a test can see
 * that exactly one is armed. Like the real clock, an aborted sleep resolves rather than rejects.
 * `wall` is the displayed time and moves independently of the monotonic clock.
 */
export class ManualRestartClock implements SupervisorClock {
  private now = 0;
  private readonly sleepers = new Set<{
    deadline: number;
    delay: number;
    resolve(): void;
  }>();
  /** Every sleep ever requested, in order. */
  readonly requested: number[] = [];
  private abortedCount = 0;
  wall = Date.UTC(2026, 9, 17, 14, 0, 0);

  monotonicNow() {
    return this.now;
  }

  readonly wallNow = () => this.wall;

  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.requested.push(milliseconds);
    return new Promise((resolve) => {
      const sleeper = {
        deadline: this.now + milliseconds,
        delay: milliseconds,
        resolve,
      };
      this.sleepers.add(sleeper);
      signal.addEventListener(
        "abort",
        () => {
          if (this.sleepers.delete(sleeper)) {
            this.abortedCount++;
            resolve();
          }
        },
        { once: true },
      );
    });
  }

  /** Sleeps still waiting. */
  pending() {
    return this.sleepers.size;
  }

  /** Sleeps cancelled before they fired. */
  aborted() {
    return this.abortedCount;
  }

  /** Moves both clocks, firing every sleeper whose deadline has passed. */
  advance(milliseconds: number) {
    this.now += milliseconds;
    this.wall += milliseconds;
    for (const sleeper of [...this.sleepers])
      if (this.now >= sleeper.deadline) {
        this.sleepers.delete(sleeper);
        sleeper.resolve();
      }
  }
}

/** Lets queued promise chains and I/O callbacks run for a fixed number of turns; never a timer. */
export async function flush(turns = 100) {
  for (let turn = 0; turn < turns; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs the event loop turn by turn until the condition holds; bounded by turns, not time. */
export async function settle(
  condition: () => boolean,
  describe: () => unknown = () => undefined,
  turns = 2000,
) {
  for (let turn = 0; turn < turns; turn++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!condition())
    throw new Error(`Condition not reached: ${JSON.stringify(describe())}`);
}
