import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  emptyLocal,
  type PublicationPolicy,
  publishView,
} from "../../web/src/task-publish-model.js";

const policy = (
  steps: Array<{ kind: "issue.create" | "project.item.add"; state: string }>,
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
        ...s,
      })),
      createdAt: 1,
    },
  }) as PublicationPolicy;

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
