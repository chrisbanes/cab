import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  emptyLocal,
  type PublicationPolicy,
  publishView,
  stepStateWord,
} from "../../web/src/task-publish-model.js";

const policy = (
  steps: Array<{
    kind: "issue.create" | "project.item.add";
    state: string;
    retrying?: boolean;
  }>,
): PublicationPolicy =>
  ({
    available: false,
    reasonCode: "publication-unresolved",
    reason: null,
    targets: [],
    latest: {
      publicationId: randomUUID(),
      state: "sending",
      revision: 2,
      materialHash: "a".repeat(64),
      repository: "org/repo",
      issueNumber: 7,
      steps: steps.map((s) => ({
        operationId: randomUUID(),
        reason: null,
        retrying: false,
        ...s,
      })),
      createdAt: 1,
    },
  }) as unknown as PublicationPolicy;

test("the panel offers Link and Abandon only while the create itself is unproved", () => {
  // A confirmed create with a later step waiting on a retry is plain waiting.
  assert.equal(
    publishView(
      policy([
        { kind: "issue.create", state: "confirmed-success" },
        { kind: "project.item.add", state: "confirmed-failure" },
      ]),
      emptyLocal,
    ),
    "waiting",
  );
  assert.equal(
    publishView(
      policy([{ kind: "issue.create", state: "attempting" }]),
      emptyLocal,
    ),
    "waiting",
  );
  assert.equal(
    publishView(
      policy([{ kind: "issue.create", state: "uncertain" }]),
      emptyLocal,
    ),
    "uncertain",
  );
});

const step = (state: string, retrying: boolean) => ({
  operationId: randomUUID(),
  kind: "project.item.add" as const,
  state: state as "confirmed-failure",
  reason: null,
  retrying,
});

test("only a failure the server marks as retrying reads as waiting to retry", () => {
  // A retryable later step.
  assert.equal(
    stepStateWord(step("confirmed-failure", true)),
    "waiting to retry",
  );
  // A create GitHub refused for good, and an abandoned create, are failures.
  assert.equal(stepStateWord(step("confirmed-failure", false)), "failed");
  assert.equal(stepStateWord(step("confirmed-success", false)), "done");
  assert.equal(stepStateWord(step("uncertain", false)), "outcome unknown");
});
