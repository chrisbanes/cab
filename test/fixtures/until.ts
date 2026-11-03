/**
 * Polls `check` on every event-loop turn until it returns a truthy value; throws on
 * timeout. Yielding with setImmediate (not a timer) lets tests observe state as soon as
 * it is reached, so ordering-sensitive callers do not race the code under test.
 */
export async function until(
  check: () => unknown | Promise<unknown>,
  description = "condition",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * How long a test watches for a turn, confirmation or write that must NOT happen when no
 * event marks the work as settled. Generous so a loaded runner cannot let a regression
 * slip past a window that closed before it ran.
 */
export const QUIET_WINDOW_MS = 200;
