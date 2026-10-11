import { type ChildProcess, spawn } from "node:child_process";
import { gitEnvironment } from "../core/child-environment.js";

export { gitEnvironment };

export type GitRunFailureKind =
  | "failed"
  | "timed-out"
  | "cancelled"
  | "output-limit";

export interface GitRunOptions {
  /** Test-only override; production callers run `git` from `PATH`. */
  executable?: string;
  args: readonly string[];
  cwd?: string;
  /** Written to stdin, then closed; without it stdin is ignored. */
  input?: Buffer;
  timeoutMs: number;
  terminationGraceMs: number;
  observationMs: number;
  /** Stdout plus stderr bytes; the child is stopped when exceeded. */
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type GitRunResult =
  /** The child exited with code 0. */
  | { status: "ok"; stdout: Buffer }
  /** The child ran to completion and exited non-zero or by signal. */
  | {
      status: "exit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      childExitObserved: boolean;
      stdout: Buffer;
    }
  /** Spawn failure, timeout, abort, output cap or a post-spawn error. */
  | {
      status: "interrupted";
      kind: GitRunFailureKind;
      spawned: boolean;
      childExitObserved: boolean;
      childExitSignal: NodeJS.Signals | null;
    };

/**
 * Run one Git child with the hardened environment and bounded time and output. Only the
 * spawned child is signalled (SIGTERM, then SIGKILL after the grace); a child whose exit is
 * not observed within the window is reported with `childExitObserved: false`, never as
 * settled. Never rejects.
 */
export function runGit(options: GitRunOptions): Promise<GitRunResult> {
  const { signal } = options;
  if (signal?.aborted)
    return Promise.resolve({
      status: "interrupted",
      kind: "cancelled",
      spawned: false,
      childExitObserved: false,
      childExitSignal: null,
    });

  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable ?? "git", [...options.args], {
        cwd: options.cwd,
        env: gitEnvironment(),
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
        windowsHide: true,
      });
    } catch {
      resolvePromise({
        status: "interrupted",
        kind: "failed",
        spawned: false,
        childExitObserved: false,
        childExitSignal: null,
      });
      return;
    }

    let settled = false;
    let spawned = false;
    let closeObserved = false;
    let childExitObserved = false;
    let childExitSignal: NodeJS.Signals | null = null;
    let outputBytes = 0;
    let failureKind: GitRunFailureKind | undefined;
    const stdout: Buffer[] = [];
    let deadlineTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let observationTimer: NodeJS.Timeout | undefined;
    let termSent = false;

    const clearTimer = (timer: NodeJS.Timeout | undefined) => {
      if (timer) clearTimeout(timer);
    };

    const cleanup = (detach: boolean) => {
      clearTimer(deadlineTimer);
      clearTimer(graceTimer);
      clearTimer(observationTimer);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      if (detach) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
    };

    const finishFailure = () => {
      if (settled || failureKind === undefined) return;
      settled = true;
      cleanup(!closeObserved);
      resolvePromise({
        status: "interrupted",
        kind: failureKind,
        spawned,
        childExitObserved,
        childExitSignal,
      });
    };

    const finishNormally = (
      code: number | null,
      closeSignal: NodeJS.Signals | null,
    ) => {
      if (settled) return;
      settled = true;
      cleanup(false);
      const output = Buffer.concat(stdout);
      if (code !== 0 || closeSignal !== null) {
        resolvePromise({
          status: "exit",
          exitCode: code,
          signal: childExitSignal ?? closeSignal,
          childExitObserved,
          stdout: output,
        });
        return;
      }
      resolvePromise({ status: "ok", stdout: output });
    };

    const beginObservation = () => {
      if (observationTimer || settled) return;
      observationTimer = setTimeout(finishFailure, options.observationMs);
    };

    const sendTerm = () => {
      if (termSent || childExitObserved || settled) return;
      try {
        termSent = child.kill("SIGTERM");
      } catch {
        termSent = false;
      }
    };

    const beginFailure = (kind: GitRunFailureKind) => {
      if (settled || failureKind !== undefined) return;
      failureKind = kind;
      sendTerm();
      graceTimer = setTimeout(() => {
        if (!childExitObserved) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The exact owned child is still observed for only the bounded window.
          }
        }
        beginObservation();
      }, options.terminationGraceMs);
      if (childExitObserved) {
        clearTimer(graceTimer);
        graceTimer = undefined;
        beginObservation();
      }
    };

    const onSpawn = () => {
      spawned = true;
      if (failureKind !== undefined && !termSent) sendTerm();
    };
    const onError = () => {
      if (!spawned) {
        failureKind = "failed";
        finishFailure();
        return;
      }
      beginFailure("failed");
    };
    const onExit = (
      _code: number | null,
      exitSignal: NodeJS.Signals | null,
    ) => {
      childExitObserved = true;
      childExitSignal = exitSignal;
      if (failureKind !== undefined) {
        clearTimer(graceTimer);
        graceTimer = undefined;
        beginObservation();
      }
    };
    const onClose = (
      code: number | null,
      closeSignal: NodeJS.Signals | null,
    ) => {
      closeObserved = true;
      if (failureKind !== undefined) finishFailure();
      else finishNormally(code, closeSignal);
    };
    const appendOutput = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (outputBytes + buffer.length > options.maxOutputBytes) {
        beginFailure("output-limit");
        return;
      }
      outputBytes += buffer.length;
      return buffer;
    };
    const onStdout = (chunk: Buffer | string) => {
      const buffer = appendOutput(chunk);
      if (buffer) stdout.push(buffer);
    };
    const onStderr = (chunk: Buffer | string) => {
      appendOutput(chunk);
    };
    const onAbort = () => beginFailure("cancelled");

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(
      () => beginFailure("timed-out"),
      options.timeoutMs,
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => beginFailure("failed"));
      child.stdin?.end(options.input);
    }
    if (signal?.aborted) onAbort();
  });
}
