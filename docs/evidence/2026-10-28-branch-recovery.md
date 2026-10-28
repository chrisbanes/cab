# Task branch recovery: bounded live run

Status: **bounded live recovery qualified at the coordinator level.** One run on the
maintainer's fixture repository published a task commit with `branch.push`, opened a draft
PR with `pr.create`, pushed a repair, then met two real foreign heads on the task branch.
It recovered the first with an approved `branch.force-push` overwrite and the second with an
approved `branch.adopt`, and pushed a merge on top of the adopted head. It is not a service
or lead-turn run: the harness drove the real delivery coordinator, provider, HTTPS push and
HTTPS fetch child directly with **0 model turns**, and stood in for the operator's approval
of the two recoveries (the approval path itself is covered by the deterministic
`delivery-integration` journeys). The harness, not an agent, wrote every commit, including
the two outside commits, which it made through GitHub's git-data API. This does not
establish production merge authority or release.

Contract: [ADR-1016](../adr/1016-ensemble-owned-commit-publication.md) and the issue
[#1206](https://github.com/chrisbanes/ensemble/issues/1206). Harness:
`test/delivery/github-qualification/live-publication.mjs`, run from candidate
`351029d6a06d81015c74dc47332e44c13f8bbbb1` (PR #1278) on Node v24.22.1.

## Authority

The maintainer approved the grant (issue comment
[6463416711](https://github.com/chrisbanes/ensemble/issues/1206#issuecomment-6463416711)).
The manifest and grant were files outside the repository: manifest SHA-256
`076f47876b409d8a7c8cadc204f303be653722b19ab9b85ccdc49b6056bc3017`, naming exactly
`branch.push`, `branch.force-push`, `branch.adopt` and `pr.create`, branch prefix `s07a-pub/`,
no model turns, a grant expiring 2026-10-28T19:30:00Z, and cleanup limited to the recorded PR
and head. The GitHub credential came in-process from the product's `ghToken()` (the
maintainer's `gh` login). It reached only the guarded REST client and the push and fetch
children's `ENSEMBLE_PUSH_TOKEN`; it was never printed or stored. The guard validated the
manifest and grant before the credential was read, and permitted only `api.github.com`, the
fixture repository, one draft PR from the recorded branch, two outside commits (each with one
parent) and two non-forced moves of that branch, and closing that PR and deleting that head.

## Fixture identities

- Repository `chrisbanes/ensemble-s07a-fixture` (node `R_kgDOU35McQ`, public, default and
  base branch `qualification`).
- Account `chrisbanes` (node `MDQ6VXNlcjIyNzQ4Ng==`).

## Result

Sanitized harness result (run `6f8e7082`):

```json
{
  "turns": 0,
  "publication": "passed",
  "overwrite": "passed",
  "adopt": "passed",
  "cleanup": "verified",
  "branch": "s07a-pub/02223475-publication-6f8e7082",
  "firstCommit": "7756dbce9b8eac9979f504c339c247e443a179ec",
  "repairCommit": "f930bc6bc1b7c7a357f350d683ebca655041185f",
  "outsideCommits": [
    "c23d5cfb03ad3d92e3e8cb0a66f4f12be6f96f24",
    "6e2589e87ce92375e5560850610c9b529015e38a"
  ],
  "overwriteCommit": "6702e01f489fb5c05b339911a810811bb060466d",
  "adoptedMergeCommit": "2527c270da3fae595ee929755d9a20628951d1de",
  "pullRequest": 17,
  "pushes": 4,
  "outsidePushEvents": 2,
  "credentialExposures": 0,
  "writes": [
    "POST /repos/chrisbanes/ensemble-s07a-fixture/pulls",
    "POST /repos/chrisbanes/ensemble-s07a-fixture/git/commits",
    "PATCH /repos/chrisbanes/ensemble-s07a-fixture/git/refs/heads/s07a-pub/02223475-publication-6f8e7082",
    "POST /repos/chrisbanes/ensemble-s07a-fixture/git/commits",
    "PATCH /repos/chrisbanes/ensemble-s07a-fixture/git/refs/heads/s07a-pub/02223475-publication-6f8e7082",
    "PATCH /repos/chrisbanes/ensemble-s07a-fixture/pulls/17",
    "DELETE /repos/chrisbanes/ensemble-s07a-fixture/git/refs/heads/s07a-pub/02223475-publication-6f8e7082"
  ]
}
```

Pass conditions, each checked by the harness:

- The first push and the repair push ended `confirmed-success`, an independent `gh api` read
  of the remote branch equalled the pushed commit, and draft PR #17 was created from the
  assigned branch with Ensemble's PR observation following the head.
- **Overwrite.** The first outside commit (`c23d5cfb`, a child of the repair commit) moved the
  branch by a fast-forward through the REST API. The lead's next plain push was refused as an
  outside change, the outside head was recorded and the lead woken once. The approved
  `branch.force-push` naming that head, the branch and the last push replaced it with
  `6702e01f` under a lease on `c23d5cfb`; the remote equalled the overwriting commit and the
  outside change cleared.
- **Adopt.** The second outside commit (`6e2589e8`, a child of the overwriting commit) moved
  the branch the same way and was detected and recorded the same way. The approved
  `branch.adopt` fetched exactly that sha from github.com in the isolated child, proved it
  descends from the provisioned base, and recorded it as the last push. The harness then
  merged it in the worktree, which adopt had not touched, and the plain push of the merge
  (`2527c270`) succeeded as a fast-forward. GitHub's PR head and Ensemble's observation both
  advanced to the merge, so **GitHub served the fetch by exact sha.**
- Exactly one outside-push wake was sent per outside commit, and nothing held completion
  afterwards.
- The credential did not appear in any file under the clone or worktree, or in the Git
  configuration of either, and not in this result.
- The guard permitted no other repository or host.

## Cleanup proof

Ensemble never deletes branches, so the harness closed PR #17 (`PATCH` with
`state: closed`) and deleted the scratch head, then read both back. An independent read
after the run shows PR #17 `closed`, not merged, with head `2527c270`, and
`GET /git/ref/heads/s07a-pub/02223475-publication-6f8e7082` returning 404. The fixture's
branches are `main` and `qualification`.

## Limits

One run, no retries. The two recoveries were requested by the harness through the real
coordinator with its own stand-in for the operator's approval, so the approval request, the
operator decision and the lead tool path were not exercised live; the deterministic
`delivery-integration` journeys cover them. The outside commits were made through the git-data
API rather than a foreign `git push`, and each was a child of the branch head, so a rebased
foreign head was covered only by the deterministic fetch tests. The adopt fetch was a small
history, so its time and size bounds were not stressed. No Codex lead turn ran.
