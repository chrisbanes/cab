# Task commit publication: bounded live run

Status: **bounded live publication qualified at the coordinator level.** One run on
the maintainer's fixture repository published a task commit through Ensemble's
`branch.push` path, opened a draft PR with `pr.create` on the assigned task branch,
pushed a repair commit to the same branch, and cleaned up what it created. It is not a
service or lead-turn run: the harness drove the real delivery coordinator, provider and
HTTPS push directly with **0 model turns**, and the harness, not an agent, wrote both
commits. The deterministic `delivery-integration` journeys cover the service wiring and
the lead's tool path. This does not establish the outside-change detection against a real
foreign push, production merge authority or release.

Contract: [ADR-1016](../adr/1016-ensemble-owned-commit-publication.md) and the issue
[#1199](https://github.com/chrisbanes/ensemble/issues/1199). Harness:
`test/delivery/github-qualification/live-publication.mjs`, run from candidate
`8806327c57ffa5727a1b5398cf8caaa67853af1a` (PR #1207) on Node v24.22.0.

## Authority

The maintainer approved the manifest and grant (issue comment
[6271205740](https://github.com/chrisbanes/ensemble/issues/1199#issuecomment-6271205740)).
Both were files outside the repository: manifest SHA-256
`31cf9ad59545858799a7abd3d0668d420ebab254effa4873e3afb623bfdec8fc`, naming exactly
`branch.push` and `pr.create`, branch prefix `s07a-pub/`, no model turns, a grant expiring
2026-10-21T00:00:00Z, and cleanup limited to the recorded PR and head. The GitHub
credential came in-process from the product's `ghToken()` (the maintainer's `gh` login).
It reached only the guarded REST client and the push child's `ENSEMBLE_PUSH_TOKEN`; it was
never printed or stored. The guard validated the manifest and grant before the credential
was read, and permitted only `api.github.com`, the fixture repository, one draft PR from the
recorded branch, and closing that PR and deleting that head.

## Fixture identities

- Repository `chrisbanes/ensemble-s07a-fixture` (node `R_kgDOU35McQ`, public, default and
  base branch `qualification`).
- Account `chrisbanes` (node `MDQ6VXNlcjIyNzQ4Ng==`).

## Result

Sanitized harness result (run `8a49f7c9`):

```json
{
  "turns": 0,
  "publication": "passed",
  "cleanup": "verified",
  "branch": "s07a-pub/c935a9e8-publication-8a49f7c9",
  "firstCommit": "ba16719dbb8ede1acd348a691d0388f50e499109",
  "repairCommit": "7f734353bbccd964f630b2162a4d33614a759edb",
  "pullRequest": 6,
  "pushes": 2,
  "outsidePushEvents": 0,
  "credentialExposures": 0,
  "writes": [
    "POST /repos/chrisbanes/ensemble-s07a-fixture/pulls",
    "PATCH /repos/chrisbanes/ensemble-s07a-fixture/pulls/6",
    "DELETE /repos/chrisbanes/ensemble-s07a-fixture/git/refs/heads/s07a-pub/c935a9e8-publication-8a49f7c9"
  ]
}
```

Pass conditions, each checked by the harness:

- The first push and the repair push each ended `confirmed-success`, and an independent
  `gh api` read of the remote branch equalled the pushed commit after each.
- `pr.create` created draft PR #6 from the assigned branch against `qualification`, with the
  head at the first commit; after the repair push, both GitHub's PR head and Ensemble's PR
  observation advanced to the repair commit.
- No outside-push event was reported.
- The credential did not appear in any file under the clone or worktree, or in the Git
  configuration of either, and not in this result.
- No repository other than the fixture was contacted.

## Cleanup proof

Ensemble never deletes branches, so the harness closed PR #6 (`PATCH` with
`state: closed`) and deleted the scratch head, then read both back. An independent read
after the run shows PR #6 `closed`, not merged, and
`GET /git/ref/heads/s07a-pub/c935a9e8-publication-8a49f7c9` returning 404. The fixture's
branches are `main` and `qualification`.

## Limits

One run, no retries. It exercised the HTTPS push, the credential helper, REST readback, a
real `pr.create` and a fast-forward repair on the same branch. It did not exercise a real
lease mismatch or force-push, approval mode, or a Codex lead turn.
