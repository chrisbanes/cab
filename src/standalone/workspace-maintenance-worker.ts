import { type BigIntStats, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { z } from "zod";

/**
 * Off-loop disk usage measurement. The worker gets only paths: no credentials (an empty
 * environment), no database handle and no service state. Its reply is validated, and a
 * cancellation terminates it.
 */
const marker = "cab-workspace-measure";
const pathSchema = z.string().min(1).max(16384);
const requestSchema = z.strictObject({
  roots: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(128),
        /** A required path that is missing or unreadable makes the root's usage unknown. */
        paths: z
          .array(z.strictObject({ path: pathSchema, optional: z.boolean() }))
          .min(1)
          .max(4),
      }),
    )
    .max(10_000),
});
const replySchema = z.strictObject({
  sizes: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(128),
        bytes: z.number().int().nonnegative().safe().nullable(),
      }),
    )
    .max(10_000),
});
export type MeasureRoot = z.infer<typeof requestSchema>["roots"][number];

/**
 * Allocated bytes under each root, as `du` counts them: links are never followed, and an inode
 * reached twice (a hard link, in this root or an earlier one) counts once. Any error but a
 * missing optional path makes that root's usage null, never zero.
 */
function measure(roots: MeasureRoot[]) {
  const seen = new Set<string>();
  return roots.map(({ key, paths }) => {
    let bytes = 0n;
    try {
      for (const { path, optional } of paths) {
        const stack = [path];
        for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
          let stat: BigIntStats;
          try {
            stat = lstatSync(next, { bigint: true });
          } catch (error) {
            if (
              next === path &&
              optional &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            )
              break;
            throw error;
          }
          const inode = `${stat.dev}:${stat.ino}`;
          if (seen.has(inode)) continue;
          seen.add(inode);
          bytes += stat.blocks * 512n;
          if (stat.isDirectory())
            for (const name of readdirSync(next)) stack.push(join(next, name));
        }
      }
      return {
        key,
        bytes: bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null,
      };
    } catch {
      return { key, bytes: null };
    }
  });
}

if (!isMainThread && workerData?.kind === marker) {
  const request = requestSchema.parse(workerData.request);
  parentPort!.postMessage({ sizes: measure(request.roots) });
}

/** Measures `roots` in a new worker thread; aborting `signal` terminates it and rejects. */
export function measureInWorker(
  roots: readonly MeasureRoot[],
  signal: AbortSignal,
): Promise<Map<string, number | null>> {
  const request = requestSchema.parse({ roots });
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: marker, request },
      env: {},
      stdout: true,
      stderr: true,
    });
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", abort);
      settle();
      void worker.terminate();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: unknown) => {
      const reply = replySchema.safeParse(message);
      finish(() =>
        reply.success &&
        reply.data.sizes.length === request.roots.length &&
        reply.data.sizes.every((s, i) => s.key === request.roots[i]!.key)
          ? resolve(new Map(reply.data.sizes.map((s) => [s.key, s.bytes])))
          : reject(new Error("Workspace measurement reply is invalid")),
      );
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", () =>
      finish(() => reject(new Error("Workspace measurement worker exited"))),
    );
  });
}
