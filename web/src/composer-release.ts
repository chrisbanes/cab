import { z } from "zod";
import { uuid } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import type { RecoveryStorage } from "./composer-state.js";

/** Draft releases still owed to the service, kept apart from the composer's own input. */
export const releaseStorageKey = "ensemble.ui03.composer.releases.v1";
const releaseSchema = z
  .object({ runId: uuid, stopKey: uuid, discardKey: uuid })
  .strict();
const releasesSchema = z.array(releaseSchema);
export type DraftRelease = z.infer<typeof releaseSchema>;

/**
 * A draft that must end whatever the composer does next (a project change, discarded
 * input, a created task). Each release keeps its two command keys, so repeating it after
 * an unknown outcome is safe, and it survives a reload until the service confirms it.
 */
export class PendingReleases {
  private items: DraftRelease[];
  constructor(private readonly storage: RecoveryStorage) {
    this.items = this.read();
  }
  private read(): DraftRelease[] {
    try {
      const bytes = this.storage.getItem(releaseStorageKey);
      return bytes ? releasesSchema.parse(JSON.parse(bytes)) : [];
    } catch {
      return [];
    }
  }
  private write() {
    try {
      if (this.items.length)
        this.storage.setItem(releaseStorageKey, JSON.stringify(this.items));
      else this.storage.removeItem(releaseStorageKey);
    } catch {
      // Held in memory for this page; storage only adds survival across a reload.
    }
  }
  list(): DraftRelease[] {
    return [...this.items];
  }
  add(runId: string): DraftRelease {
    const existing = this.items.find((item) => item.runId === runId);
    if (existing) return existing;
    const release = {
      runId,
      stopKey: crypto.randomUUID(),
      discardKey: crypto.randomUUID(),
    };
    // Never evicted: only a confirmed (or unknown-to-the-service) run leaves the list.
    this.items = [...this.items, release];
    this.write();
    return release;
  }
  /** A fresh Stop key, so a later attempt reaches the service instead of a stored receipt. */
  restop(runId: string) {
    this.items = this.items.map((item) =>
      item.runId === runId ? { ...item, stopKey: crypto.randomUUID() } : item,
    );
    this.write();
  }
  remove(runId: string) {
    this.items = this.items.filter((item) => item.runId !== runId);
    this.write();
  }
}

/**
 * One pass at ending a draft: Stop, then discard once it has ended. Both go out under the
 * release's own keys. `retry` means the Stop's outcome is unknown, so the same release is
 * tried again under the same keys. `restop` means the Stop was recorded but the run is still
 * ending (a held copy, a runtime not yet seen to end): the next attempt uses a new Stop key,
 * because a replayed key returns its old receipt without retrying the service's cleanup.
 * Stop is idempotent by run state. A run the service does not know is done.
 */
export async function attemptRelease(
  client: OperatorClient,
  csrfToken: string,
  release: DraftRelease,
): Promise<"done" | "retry" | "restop"> {
  const { runId } = release;
  const stop = await client.command(
    { type: "drafting.stop", key: release.stopKey, runId },
    csrfToken,
  );
  if (stop.state === "rejected" && stop.code === "not-found") return "done";
  if (stop.state !== "recorded") return "retry";
  const discard = await client.command(
    {
      type: "drafting.settle",
      key: release.discardKey,
      runId,
      disposition: "discard",
    },
    csrfToken,
  );
  if (discard.state === "recorded") return "done";
  if (discard.state === "rejected" && discard.code === "not-found")
    return "done";
  return "restop";
}
