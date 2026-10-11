import type { ChildProcess } from "node:child_process";

export function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("GIT_")) delete environment[key];
  environment.GIT_ALLOW_PROTOCOL = "";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

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
