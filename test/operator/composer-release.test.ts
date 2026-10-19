import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { CommandState, OperatorClient } from "../../web/src/api.js";
import {
  attemptRelease,
  PendingReleases,
  releaseStorageKey,
} from "../../web/src/composer-release.js";

const storage = () => {
  const bytes = new Map<string, string>();
  return {
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => void bytes.set(key, value),
    removeItem: (key: string) => void bytes.delete(key),
  };
};

/** A client answering each command in turn: a receipt, or a failure of a given state. */
function client(
  ...answers: Array<"recorded" | "unknown" | "conflict" | "not-found">
) {
  const sent: Array<Record<string, unknown>> = [];
  const fake = {
    command: async (
      command: Record<string, unknown>,
    ): Promise<CommandState> => {
      sent.push(command);
      const answer = answers.shift() ?? "recorded";
      if (answer === "recorded")
        return {
          state: "recorded",
          receipt: {
            kind: "drafting",
            key: String(command.key),
            recorded: true,
            operation: "stop",
            runId: String(command.runId),
            state: "stopping",
          },
        };
      return answer === "not-found"
        ? { state: "rejected", command: command as never, code: "not-found" }
        : { state: answer, command: command as never, code: "x" };
    },
  };
  return { client: fake as unknown as OperatorClient, sent };
}

test("a release keeps its keys, so an unknown stop is repeated under the same key", async () => {
  const store = storage();
  const release = new PendingReleases(store).add(randomUUID());
  const first = client("unknown");
  assert.equal(await attemptRelease(first.client, "csrf", release), "retry");
  // Nothing was discarded while the stop is unconfirmed.
  assert.deepEqual(
    first.sent.map((c) => c.type),
    ["drafting.stop"],
  );
  const second = client();
  assert.equal(await attemptRelease(second.client, "csrf", release), "done");
  assert.equal(second.sent[0]?.key, first.sent[0]?.key);
  assert.deepEqual(
    second.sent.map((c) => c.type),
    ["drafting.stop", "drafting.settle"],
  );
  assert.equal(second.sent[1]?.key, release.discardKey);
});

test("a run that is still ending is discarded later under the same key, and an unknown run is done", async () => {
  const release = new PendingReleases(storage()).add(randomUUID());
  const ending = client("recorded", "conflict");
  assert.equal(await attemptRelease(ending.client, "csrf", release), "retry");
  const later = client();
  assert.equal(await attemptRelease(later.client, "csrf", release), "done");
  assert.equal(later.sent[1]?.key, ending.sent[1]?.key);
  const gone = client("not-found");
  assert.equal(await attemptRelease(gone.client, "csrf", release), "done");
});

test("pending releases survive a reload until they are removed", () => {
  const store = storage();
  const runId = randomUUID();
  const release = new PendingReleases(store).add(runId);
  assert.ok(store.getItem(releaseStorageKey));
  assert.deepEqual(new PendingReleases(store).list(), [release]);
  assert.deepEqual(new PendingReleases(store).add(runId), release);
  const reopened = new PendingReleases(store);
  reopened.remove(runId);
  assert.equal(store.getItem(releaseStorageKey), null);
});
