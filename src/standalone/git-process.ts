import type { ChildProcess } from "node:child_process";

export { gitEnvironment } from "../core/child-environment.js";

export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export async function stopOwnedChild(
  child: ChildProcess,
  graceMs: number,
  observationMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    // The exact child may already have closed.
  }
  if (await waitForExit(child, graceMs)) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    // The exact child may already have closed.
  }
  return waitForExit(child, observationMs);
}
