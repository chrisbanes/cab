/** Polls `check` every 10 ms until it returns a truthy value; throws on timeout. */
export async function until(
  check: () => unknown | Promise<unknown>,
  description = "condition",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
