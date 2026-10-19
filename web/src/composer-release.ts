import { z } from "zod";
import { uuid } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import type { ComposerInput, RecoveryStorage } from "./composer-state.js";

/** Draft releases still owed to the service, kept apart from the composer's own input. */
export const releaseStorageKey = "ensemble.ui03.composer.releases.v1";
/** The start a release may still have to settle: sent again under its key until known. */
const startSchema = z
  .object({ key: uuid, projectId: uuid, idea: z.string().min(1).max(16000) })
  .strict();
export type DraftStart = z.infer<typeof startSchema>;
const releaseSchema = z
  .object({
    runId: uuid,
    stopKey: uuid,
    discardKey: uuid,
    start: startSchema.optional(),
  })
  .strict();
const releasesSchema = z.array(releaseSchema);
export type DraftRelease = z.infer<typeof releaseSchema>;

/** The start a composer sent for its run, as a release needs it; absent if none was recorded. */
export function startOf(input: ComposerInput): DraftStart | undefined {
  return input.draftingKey && input.draftingStart
    ? { key: input.draftingKey, ...input.draftingStart }
    : undefined;
}

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
  add(runId: string, start?: DraftStart): DraftRelease {
    const existing = this.items.find((item) => item.runId === runId);
    if (existing) return existing;
    const release: DraftRelease = {
      runId,
      stopKey: crypto.randomUUID(),
      discardKey: crypto.randomUUID(),
      ...(start ? { start } : {}),
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
 * Stop is idempotent by run state. A run the service does not know is done. A release that
 * carries its start first sends that start again under its key (a replay returns the stored
 * receipt), so a start whose outcome was never seen cannot land afterwards unreachable.
 */
export async function attemptRelease(
  client: OperatorClient,
  csrfToken: string,
  release: DraftRelease,
): Promise<"done" | "retry" | "restop"> {
  const { runId } = release;
  if (release.start) {
    const started = await client.command(
      {
        type: "drafting.start",
        key: release.start.key,
        runId,
        projectId: release.start.projectId,
        idea: release.start.idea,
      },
      csrfToken,
    );
    // Only a refusal of the start itself means no run exists; anything else is tried again.
    if (
      started.state === "conflict" ||
      (started.state === "rejected" && started.code === "invalid-input")
    )
      return "done";
    if (started.state !== "recorded") return "retry";
  }
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
