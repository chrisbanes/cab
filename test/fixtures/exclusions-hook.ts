import type { OperatorApi } from "../../src/standalone/operator-api.js";

/**
 * Wraps the task-scoped exclusion lookups of one `OperatorApi`, the awaited point where
 * instruction, binding and visibility races are injected. `wrap` runs before and/or after
 * `run`; the returned function restores the original lookup.
 */
export function wrapTaskExclusions(
  api: OperatorApi,
  wrap: (taskId: string, run: () => Promise<unknown>) => Promise<unknown>,
): () => void {
  const target = api as unknown as {
    exclusions: (...args: unknown[]) => Promise<unknown>;
  };
  const original = target.exclusions;
  target.exclusions = function (this: OperatorApi, ...args: unknown[]) {
    const taskId = args[1];
    return typeof taskId === "string"
      ? wrap(taskId, () => original.apply(this, args))
      : original.apply(this, args);
  };
  return () => {
    target.exclusions = original;
  };
}
