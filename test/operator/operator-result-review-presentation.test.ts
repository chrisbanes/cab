import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TaskRead } from "../../src/operator/contracts.js";
import {
  missingEvidence,
  pendingReviews,
  resultHeadComparison,
  resultIdentity,
  reviewStatus,
  type ResultReview,
  uncertaintyLines,
} from "../../web/src/result-review-presentation.js";

const review = (patch: Partial<ResultReview> = {}): ResultReview => ({
  reviewId: randomUUID(),
  resultId: randomUUID(),
  workId: "work",
  workRevision: 2,
  requestingAssignmentId: randomUUID(),
  decision: "Should the toolbar ship behind the flag?",
  recommendation: "Ship it behind the flag.",
  uncertainties: null,
  status: "pending",
  revision: 1,
  response: null,
  supersededByResultId: null,
  withdrawReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

test("every review state is worded, and a pending review has no banner", () => {
  const responded = (response: "reviewed" | "feedback") =>
    review({
      status: "responded",
      response: { response, message: null, eventId: null, respondedAt: 1 },
    });
  assert.equal(reviewStatus(review()), null);
  assert.equal(reviewStatus(responded("reviewed")), "Reviewed");
  assert.equal(reviewStatus(responded("feedback")), "Feedback sent");
  assert.equal(
    reviewStatus(review({ status: "superseded" })),
    "Superseded by a newer result",
  );
  assert.equal(
    reviewStatus(review({ status: "withdrawn", withdrawReason: "Not needed" })),
    "Withdrawn by the lead: Not needed",
  );
  assert.equal(
    reviewStatus(review({ status: "withdrawn" })),
    "Withdrawn by the lead",
  );
  assert.equal(
    reviewStatus(review({ status: "closed" })),
    "Closed with the task",
  );
});

test("an omitted uncertainty list is not an empty one, and neither reads as none", () => {
  assert.deepEqual(uncertaintyLines(null), {
    items: [],
    empty: "No remaining uncertainty recorded",
  });
  assert.deepEqual(uncertaintyLines([]), {
    items: [],
    empty: "The lead listed no remaining uncertainty",
  });
  assert.deepEqual(uncertaintyLines(["Safari unchecked", null]), {
    items: ["Safari unchecked", "Unavailable or redacted"],
    empty: null,
  });
});

test("a checked head is compared with the head cab recorded for the result", () => {
  const head = "a".repeat(40),
    workspace = [
      { repositoryId: "R1", headCommit: head, branch: "main", dirty: false },
    ];
  assert.equal(
    resultHeadComparison(head, workspace),
    "Checked the head recorded for this result",
  );
  assert.equal(
    resultHeadComparison("b".repeat(40), workspace),
    "Checked a different head than the one recorded for this result",
  );
  assert.equal(
    resultHeadComparison(undefined, workspace),
    "Head comparison unknown",
  );
  assert.equal(resultHeadComparison(head, []), "Head comparison unknown");
  assert.equal(
    resultHeadComparison(head, [{ ...workspace[0]!, dirty: true }]),
    "Checked the head recorded for this result, which had uncommitted changes",
  );
});

test("the result identity names its revision, and missing evidence is stated", () => {
  const first = randomUUID(),
    second = randomUUID(),
    data = {
      results: [
        { resultId: first, workRevision: 1, createdAt: 1_800_000_000 },
        { resultId: second, workRevision: 3, createdAt: 1_800_000_000 },
      ],
      review: { results: [{ resultId: first }] },
    } as unknown as TaskRead["data"];
  assert.match(
    resultIdentity(data, second),
    /^R2 · work revision 3 · recorded /,
  );
  assert.equal(resultIdentity(data, randomUUID()), "Result unavailable");
  assert.equal(missingEvidence(data, first), null);
  assert.equal(
    missingEvidence(data, second),
    "The lead recorded no criteria, validations or artifacts for this result.",
  );
});

test("only pending, undismissed reviews wait on the operator", () => {
  const pending = review(),
    dismissed = review({
      lifecycle: {
        status: "dismissed",
        revision: 2,
        createdAt: 1,
        resolvedAt: null,
        resolution: null,
        dismissedAt: 2,
        note: null,
      },
    });
  assert.deepEqual(
    pendingReviews({
      resultReviews: [pending, dismissed, review({ status: "closed" })],
    }),
    [pending],
  );
  assert.deepEqual(pendingReviews({}), []);
});
