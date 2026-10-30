import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkStatusWord,
  codeHostActionLabel,
  deliveryActionLine,
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

test("a status-mapping write is named and a skipped one says why, while agent actions read as before", () => {
  const base = {
    kind: "project.field",
    caller: "agent",
    event: null,
    state: "confirmed-success",
    reason: null,
    operationId: "op-1",
  } as const;
  assert.equal(
    deliveryActionLine(base),
    "project.field: confirmed-success · receipt recorded · operation op-1",
  );
  assert.equal(
    deliveryActionLine({
      ...base,
      caller: "service",
      event: "handedBack",
      state: "confirmed-failure",
      reason: "provider-project-field-changed",
    }),
    "Status mapping (PR handed back for review) · project.field: confirmed-failure · Skipped: Status changed on GitHub since cab last saw it. · operation op-1",
  );
  // A GitLab merge train merge is described, not shown as a code.
  assert.equal(
    deliveryActionLine({
      ...base,
      kind: "pr.merge",
      state: "uncertain",
      reason: "provider-merge-train-pending",
    }),
    "pr.merge: uncertain · On the GitLab merge train; waits until it merges or drops out. · operation op-1",
  );
  assert.match(
    deliveryActionLine({
      ...base,
      kind: "pr.merge",
      state: "confirmed-failure",
      reason: "provider-merge-train-dropped",
    }),
    /Dropped from the GitLab merge train; nothing was merged\./,
  );
  // The same code on an agent action keeps its raw reason.
  assert.match(
    deliveryActionLine({ ...base, reason: "provider-http-404" }),
    /provider-http-404/,
  );
});

test("a GitLab merge request is named in GitLab's form and links only over https", () => {
  const url = "https://gitlab.example.com/group/sub/app/-/merge_requests/12";
  const binding = {
    repositoryName: "group/sub/app",
    number: 12,
    url,
    codeHost: "gitlab" as const,
  };
  assert.equal(pullRequestReference(binding), "group/sub/app!12");
  assert.equal(safePullRequestUrl(url, "gitlab"), url);
  assert.equal(
    safePullRequestUrl(url),
    null,
    "GitHub links stay on github.com",
  );
  assert.equal(
    safePullRequestUrl(url.replace("https", "http"), "gitlab"),
    null,
  );
  assert.equal(safePullRequestUrl("javascript:alert(1)", "gitlab"), null);
  assert.equal(
    pullRequestReference({ ...binding, url: undefined }),
    "Merge request !12",
  );
  assert.equal(
    deliveryBlockerSentence("pr-not-confirmed-merged", "gitlab"),
    "Waiting for GitLab to confirm the merge request merged.",
  );
});

test("code-host actions are named for their host, and an absent host is GitHub", () => {
  assert.equal(
    codeHostActionLabel("pr.thread.resolve", "gitlab"),
    "GitLab discussion",
  );
  assert.equal(
    codeHostActionLabel("pr.edit", "gitlab"),
    "GitLab merge request",
  );
  assert.equal(codeHostActionLabel("branch.push", "gitlab"), "GitLab branch");
  assert.equal(
    codeHostActionLabel("pr.thread.reply", undefined),
    "GitHub review thread",
  );
  assert.equal(
    codeHostActionLabel("pr.ready", "github"),
    "GitHub pull request",
  );
  assert.equal(codeHostActionLabel("issue.comment", "gitlab"), null);
});
