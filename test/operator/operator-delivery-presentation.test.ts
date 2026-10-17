import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkStatusWord,
  deliveryBlockerSentence,
  pullRequestReference,
  pullRequestRepository,
  pullRequestStateLabel,
  safePullRequestUrl,
} from "../../web/src/delivery-presentation.js";

const fallback =
  "Delivery is waiting on a condition this version can't describe.";

test("delivery blockers read as sentences and unknown codes fall back", () => {
  const known = {
    "reviewable-pr-awaiting-current-settlement":
      "Waiting for the current PR head to be settled.",
    "pr-not-confirmed-merged": "Waiting for GitHub to confirm the PR merged.",
    "delivery-provider-read-unavailable":
      "The last GitHub read failed, so delivery state may be out of date.",
    "delivery-mode-changed":
      "The project's delivery mode changed after this PR was bound.",
    "external-action-prepared":
      "A GitHub action is prepared and has not been attempted.",
    "external-action-attempting": "A GitHub action is in progress.",
    "external-action-uncertain":
      "A GitHub action's outcome is unknown; check it before retrying.",
  };
  for (const [code, sentence] of Object.entries(known))
    assert.equal(deliveryBlockerSentence(code), sentence);
  for (const code of ["delivery-new-unknown-code", "constructor", ""])
    assert.equal(deliveryBlockerSentence(code), fallback);
});

test("pull request state labels cover open, draft, closed and merged", () => {
  assert.equal(pullRequestStateLabel("OPEN", false), "Open");
  assert.equal(pullRequestStateLabel("OPEN", true), "Draft");
  assert.equal(pullRequestStateLabel("OPEN", undefined), "Open");
  assert.equal(pullRequestStateLabel("CLOSED", true), "Closed");
  assert.equal(pullRequestStateLabel("MERGED", false), "Merged");
  assert.equal(checkStatusWord("success"), "Passed");
  assert.equal(checkStatusWord("pending"), "Pending");
  assert.equal(checkStatusWord("failure"), "Failed");
});

test("only an https github.com pull request URL is linkable", () => {
  const ok = "https://github.com/org/repo/pull/7";
  assert.equal(safePullRequestUrl(ok), ok);
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "http://github.com/org/repo/pull/7",
    "https://github.com.evil.example/org/repo/pull/7",
    "https://evil.example/org/repo/pull/7",
    "",
    "not a url",
    undefined,
  ])
    assert.equal(safePullRequestUrl(url), null, String(url));
});

test("a pull request is named by its repository only when the server verified the link", () => {
  const url = "https://github.com/acme/app/pull/12";
  const verified = { repositoryName: "acme/app", number: 12, url };
  assert.equal(pullRequestRepository(verified), "acme/app");
  assert.equal(pullRequestReference(verified), "acme/app#12");
  for (const unverified of [
    undefined,
    "javascript:alert(1)",
    "http://github.com/acme/app/pull/12",
  ]) {
    const binding = {
      repositoryName: "R_kgDOabc",
      number: 12,
      url: unverified,
    };
    assert.equal(pullRequestRepository(binding), null);
    assert.equal(pullRequestReference(binding), "PR #12");
  }
});
