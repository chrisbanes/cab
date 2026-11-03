import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkStatusWord,
  codeHostActionLabel,
  codeHostChecksSummary,
  codeHostMergeMethods,
  defaultBranchMethodsNote,
  mergeMethodNotAllowedWarning,
  noRequiredChecksWarning,
  deliveryActionLine,
  deliveryBlockerSentence,
  mergeBlockerText,
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

test("merge blockers without a check or a method read as sentences, and other codes pass through", () => {
  assert.equal(
    mergeBlockerText("no-required-checks"),
    "No required checks: neither the code host nor cab requires a check, so the merge is held.",
  );
  assert.equal(
    mergeBlockerText("merge-method-not-configured"),
    "No merge method: this repository has no configured merge method the code host allows, so the merge is held.",
  );
  assert.match(mergeBlockerText("pr-base-change-held"), /^Base changed: /);
  for (const code of [
    "check-build-unproved",
    "merge-status-checking",
    "constructor",
  ])
    assert.equal(mergeBlockerText(code), code);
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

test("each Jira status skip reads as its own sentence on a status-mapping write, and an agent's raw reason stays", () => {
  const line = (reason: string, caller: "service" | "agent" = "service") =>
    deliveryActionLine({
      kind: "issue.status",
      caller,
      event: caller === "service" ? "turnStarted" : null,
      state: "confirmed-failure",
      reason,
      operationId: "op-1",
    });
  const notes = [
    [
      "provider-issue-status-changed",
      "Skipped: the status changed in Jira since cab last saw it.",
    ],
    [
      "provider-issue-status-current",
      "Skipped: the issue is already in the mapped status.",
    ],
    [
      "provider-transition-unavailable",
      "Skipped: no available transition reaches the mapped status.",
    ],
    [
      "provider-transition-ambiguous",
      "Skipped: several transitions reach the mapped status.",
    ],
  ] as const;
  for (const [reason, note] of notes) {
    assert.match(line(reason), new RegExp(note.replace(/\./g, "\\.")));
    // An agent's issue.close ambiguity is not a status-mapping skip.
    assert.match(line(reason, "agent"), new RegExp(reason));
  }
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

import {
  repositoryDeliveryLevel,
  repositoryLevelGrants,
} from "../../src/core/delivery-levels.js";
import {
  deliveryLevelLabels,
  deliveryMergeWarning,
} from "../../web/src/delivery-presentation.js";

test("repository levels describe exact authority without crossing repository or tracker scopes", () => {
  for (const level of [
    "open-prs",
    "merge-with-approval",
    "merge-when-ready",
  ] as const) {
    const rows = repositoryLevelGrants("R", level);
    assert.equal(repositoryDeliveryLevel(rows, "R"), level);
    assert.equal(repositoryDeliveryLevel(rows, "42"), "not-set-up");
    assert.equal(
      repositoryDeliveryLevel(
        [
          ...rows,
          { action: "branch.adopt", repositoryId: "R", mode: "approval" },
        ],
        "R",
      ),
      level,
    );
    assert.equal(repositoryDeliveryLevel(rows.slice(1), "R"), "custom");
    for (const extra of [
      { ...rows[0]!, mode: "approval" as const },
      { ...rows[0]!, projectNodeId: "P" },
    ]) {
      assert.equal(
        repositoryDeliveryLevel([extra, ...rows.slice(1)], "R"),
        "custom",
      );
    }
    for (const duplicate of [
      [...rows, rows[0]!],
      [rows[0]!, ...rows],
    ])
      assert.equal(repositoryDeliveryLevel(duplicate, "R"), "custom");
    assert.equal(
      repositoryDeliveryLevel(
        [...rows, ...repositoryLevelGrants("42", "merge-when-ready")],
        "42",
      ),
      "merge-when-ready",
    );
  }
  assert.equal(repositoryDeliveryLevel([], "R"), "not-set-up");
  assert.equal(
    repositoryDeliveryLevel(
      [{ action: "issue.comment", repositoryId: "R", mode: "allow" }],
      "R",
    ),
    "not-set-up",
  );
  assert.equal(
    repositoryDeliveryLevel(
      [{ action: "branch.adopt", repositoryId: "R", mode: "approval" }],
      "R",
    ),
    "custom",
  );
  assert.equal(deliveryLevelLabels["open-prs"], "Open PRs");
  assert.equal(
    deliveryMergeWarning,
    "The lead will merge without asking once the merge gate reports no blockers. cab can't unmerge or revert a merge.",
  );
});

test("a repository's code-host checks read live, absent or unavailable, and no checks at all is a warning", () => {
  assert.equal(
    codeHostChecksSummary("github", { status: "live", checks: [{}] }),
    "GitHub requires these checks before merging:",
  );
  assert.equal(
    codeHostChecksSummary("gitlab", { status: "live", checks: [] }),
    "GitLab requires no checks before merging.",
  );
  for (const [reason, text] of [
    ["credential-missing", "no credential can read them"],
    ["provider-error", "the last read failed"],
    ["timeout", "the read took too long"],
    ["unsupported", "cab can't read them for this repository"],
  ] as const)
    assert.equal(
      codeHostChecksSummary(undefined, { status: "unavailable", reason }),
      `GitHub's required checks are unavailable: ${text}.`,
    );
  assert.equal(
    noRequiredChecksWarning("gitlab"),
    "No required checks: neither GitLab nor cab requires a check, so cab holds every merge for this repository. Add an additional required check or a code-host rule.",
  );
});

test("the default branch's merge methods are guidance, and a method it doesn't allow is a warning", () => {
  assert.deepEqual(codeHostMergeMethods.github, ["merge", "squash", "rebase"]);
  assert.deepEqual(codeHostMergeMethods.gitlab, ["merge", "squash"]);
  assert.equal(
    defaultBranchMethodsNote(["squash"]),
    "The default branch allows: squash. Merges into other branches follow their own rules.",
  );
  assert.equal(
    defaultBranchMethodsNote([]),
    "The default branch allows: no method cab can use. Merges into other branches follow their own rules.",
  );
  assert.equal(
    mergeMethodNotAllowedWarning("merge"),
    "The default branch doesn't allow merge commit, so cab holds merges into it until the method or the branch's rules change.",
  );
});
