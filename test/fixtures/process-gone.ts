export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function waitForProcessGone(pid: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline)
      throw new Error(`Git child ${pid} is alive ${timeoutMs}ms after SIGKILL`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
