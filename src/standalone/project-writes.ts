import {
  assertProjectWritable,
  type ArchiveBlocker,
  type ProjectLifecycleSnapshot,
} from "../core/project-lifecycle.js";
import type { Database } from "../core/store.js";

/** Cab-owned asynchronous writes, registered before the first await and released in finally. */
export class ProjectWrites {
  private readonly pending = new Map<
    string,
    Map<symbol, "callback" | "provider-write">
  >();
  constructor(private readonly db: Database) {}

  blockers(projectId: string): ArchiveBlocker[] {
    return [...new Set(this.pending.get(projectId)?.values() ?? [])].map(
      (kind) => ({
        kind,
        reason:
          kind === "callback"
            ? "A cab callback is still running"
            : "A provider write is still running",
      }),
    );
  }

  begin(projectId: string, kind: "callback" | "provider-write") {
    const snapshot = assertProjectWritable(this.db, projectId);
    const token = Symbol();
    const operations = this.pending.get(projectId) ?? new Map();
    operations.set(token, kind);
    this.pending.set(projectId, operations);
    let ended = false;
    return {
      snapshot,
      end: () => {
        if (ended) return;
        ended = true;
        operations.delete(token);
        if (operations.size === 0) this.pending.delete(projectId);
      },
    };
  }

  async run<T>(
    projectId: string,
    kind: "callback" | "provider-write",
    write: (snapshot: ProjectLifecycleSnapshot) => Promise<T>,
  ): Promise<T> {
    // No await between the final lifecycle check and registration.
    const lease = this.begin(projectId, kind);
    try {
      return await write(lease.snapshot);
    } finally {
      lease.end();
    }
  }
}
