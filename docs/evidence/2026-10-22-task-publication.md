# Task publication: bounded live run

Status: **partly qualified; the allowance is spent (three attempts).** Attempt 2 published two Ready local tasks through
the real service, delivery coordinator and provider on a scratch user-owned Project: every step of both
publications was confirmed by the provider's own read-back, both tasks were converted in place, and one
sync imported no duplicate. Its last assertion failed: after that sync the repository-target task was
**not Ready**, and the cause was not isolated. The run had **0 model turns**. The deterministic
`task-publication`, `delivery-store`, `github-delivery-provider` and `operator-task-publish-*` tests cover
the same path against a fake GitHub, where both tasks stay Ready.

Contract: [ADR-1017](../adr/1017-non-agent-readiness-writes.md), [ADR-1018](../adr/1018-task-publication-in-place.md)
and the issue [#1167](https://github.com/chrisbanes/ensemble/issues/1167). Harness:
`test/delivery/github-qualification/live-task-publication.mjs`, from candidate
`6f0f86779e06ea2cb7f305bcee456a94b8189ba0` (attempt 1) and `a087ec534de1246d584f72b6c3059147ee267936`
(attempt 2), on Node v24.22.0. Attempt 2 ran on the product code of the final candidate: later commits
change only the harness's diagnostics and documents.

## Authority

The approved plan allowed at most **2 attempts**, **0 model turns** and **4 fixture issues**; after attempt 2 the
maintainer allowed one more attempt (decision 5 in the issue), which the ticket agent recorded as a second manifest
(SHA-256 `028f41bce2c19086e125c84242eea24baf70edb5ed2a579e376edaba500352e1`, `maxAttempts: 3`, `maxIssues: 6`: two
issues per attempt). Each attempt
creating and deleting its own scratch user-owned Project `ensemble-1167-<runid>` linked to
`chrisbanes/ensemble-s07a-fixture`. The ticket agent wrote the manifest and grant outside the repository:
manifest SHA-256 `2b319a8c94d89ecca106bf2315e1bf94f906c9b64bedcee2d1ad5cdb1bf26282`, naming exactly
`issue.create`, `project.item.add` and `project.field`, no model turns, `maxAttempts: 2`, `maxIssues: 4`,
a 12-hour grant, and cleanup limited to what the run recorded. The credential came in-process from the
product's `ghToken()` (the maintainer's `gh` login, which has the `project` scope); it reached only the
guarded HTTP client and was never printed or stored. `gh` ran under its own login, limited by the guard to
exact command shapes. The guard validated the manifest and grant before the credential was read, and
permitted only `api.github.com`, the fixture repository, its issue list and creates (two per attempt,
titled for the run and labelled only with the run's label), the one Project the run created, and the
recorded items, field and options. It refuses Project number 6 and any Project linked to a repository other
than the fixture (including `chrisbanes/ensemble`).

## Fixture identities

- Repository `chrisbanes/ensemble-s07a-fixture` (node `R_kgDOU35McQ`, public, default branch
  `qualification`). Account `chrisbanes` (node `MDQ6VXNlcjIyNzQ4Ng==`).
- Attempt 1: run `48c3710c`, Project node `PVT_kwHOAAN4ns4BoK-o` (number 18), fixture issues #11 and #12.
- Attempt 2: run `aeb6bd32`, Project node `PVT_kwHOAAN4ns4BoK_O` (number 19), fixture issues #13 and #14.
- Attempt 3: run `e52c53c5`, Project node `PVT_kwHOAAN4ns4BoNPW` (number 20), fixture issues #15 and #16.

## What each attempt does

Per attempt the harness creates the Project, links it to the fixture only, gives its Status field the
options Todo and Ready, and creates the label `ens-1167-<runid>`. It starts the real service over a
temporary data directory with no lead and no runtime, then: configures a `repository` and an unfiltered
`project` selection and the three `allow` grants; publishes a Ready local task to the Project under the
rule `all[label, Ready option]` (the plan's `any` rule would write only the label and never exercise the
field); reconfigures the rule to `any[label, Ready option]`; publishes a second Ready task to the
repository; waits until the Project lists its item; runs one sync; and reads the issues, the Project item
and its Status back with `gh`. It then closes the issues, deletes the Project and the label, and proves it.

## Attempts

**Attempt 1 (run `48c3710c`, failed in the harness).** Both creates posted once and the issues exist
(#11, #12), but the first read-back after each create did not list the new issue, so both stayed
`uncertain` and the harness, which then expected an immediate answer, stopped. Nothing was sent again.
Cleanup closed both issues and deleted the Project and the label, and the harness verified it. The harness
now refreshes the service, as the product does on each poll, up to eight times before it gives up (with a
test); the product behaviour is the designed one: an unproved create is read back later, never resent.

**Attempt 2 (run `aeb6bd32`, publications confirmed, last assertion failed).** Sanitized harness result:

```json
{
  "turns": 0,
  "qualification": "failed",
  "cleanup": "verified",
  "project": { "nodeId": "PVT_kwHOAAN4ns4BoK_O", "number": 19 },
  "publications": [
    { "target": "project", "immediate": "sending", "refreshPasses": 1, "state": "converted", "issueNumber": 13,
      "steps": ["issue.create", "project.item.add", "project.field"], "allSteps": "confirmed-success" },
    { "target": "repo", "immediate": "sending", "refreshPasses": 1, "state": "converted", "issueNumber": 14,
      "steps": ["issue.create"], "allSteps": "confirmed-success" }
  ],
  "projectListed": 1,
  "sync": { "tasksBeforeSync": 2, "tasksAfterSync": 2, "ready": [true, false] },
  "duplicateImports": 0,
  "failure": "A published task is not matched and Ready after sync",
  "deletedProject": { "nodeId": "PVT_kwHOAAN4ns4BoK_O", "number": 19, "deleted": true }
}
```

Held, each checked by the harness: both creates were proved by the read-back one refresh after the send
(so the first read-back was again too early and nothing was resent); the Project task's item add and Ready
option write were confirmed by the provider's readbacks; both tasks were converted in place; one real sync
matched both issues to their tasks with **0 duplicate imports** and no extra task. Independent `gh` events
show the label `ens-1167-aeb6bd32` applied to both issues at creation.

Failed: after the sync the Project task was Ready and the repository task was not. The harness did not yet
record the task's holds, memberships or labels, so the cause is not isolated. Candidates are a membership
the sync dropped because the issue list did not yet show a just-created issue (the same lag as the
read-back), or a product defect in how a repository-target task is carried through its first sync. The timing fits the
first candidate: the Project task's issue was created about 16 seconds before the repository task's, the
first read-back missed each new issue until a refresh several seconds later, and the final sync ran roughly
eight to fifteen seconds after the repository task's issue was created. A deterministic check with a source
read that omits the issue once shows the task dropping to not Ready with a `withdrawn` hold, and Ready again
on the next sync with the hold left in place. The deterministic tests, whose fake GitHub never lags, keep
both tasks Ready. The harness now records that
state when the check fails, but no attempt remains.


**Change after attempt 2 (maintainer decision 5).** GitHub's lists trail a create, so a converted task is now
forgiven one complete read that omits its issue, withdrawn on a second consecutive omission, and a withdrawal
produced by those two omissions is released when a later read lists the issue again and the task is Ready
(SPEC "Conversion", ADR-1018). On main, every other imported issue is withdrawn by the first omission and its
hold stays until the operator resolves it; that general behaviour is unchanged.

**Attempt 3 (run `e52c53c5`, failed in the harness before the sync, on the final product code).**
Head `74b2583bea3c6e8e5bfd509fa8298d353c009b1b`. Both publications were again confirmed step by step and
converted (issues #15 and #16; the Project task did issue, item add and Ready-field write), each after one
refresh because the first read-back did not yet list the new issue. The harness then waits for the Project to
list the published item before it syncs: ten reads over about 45 seconds, alternating the `""` and
`is:issue` filters, all showed no item (`projectListed: 0`), so it stopped with "The Project does not list the
published item". The sync, the Ready check and the independent reads were therefore not reached, and the
forgiveness rule is **not** qualified live. Whether the Project never listed the item or listed it late is not
known; attempt 2 listed it on the first read. Cleanup closed #15 and #16, deleted the Project and the label,
and the harness verified it.

## Cleanup proof

The harness closed both issues, deleted the Project and the label, and read them back
(`cleanup: verified`) in each attempt. An independent `gh` read afterwards lists no Project 18, 19 or 20
(`gh project list --owner chrisbanes` shows Verity, Ensemble S07a qualification, Ensemble S06
qualification, Portico, Haze and Ensemble), reads the nodes `PVT_kwHOAAN4ns4BoK_O` and
`PVT_kwHOAAN4ns4BoNPW` as not found, shows issues #11 to #16 closed, and lists no `ens-1167` label. Project 6 was never read or written.

## Limits

All three attempts are spent; no model turn ran. The uncertain, Link and Abandon paths are covered only by the
deterministic service tests. The fixture repository keeps six closed issues (#11 to #16) from these
attempts. The Ready-after-sync result for a repository-target task, with and without the forgiveness rule, is **unqualified live**: only the deterministic tests cover it.
