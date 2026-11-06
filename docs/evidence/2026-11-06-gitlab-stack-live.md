# GitLab stacking: bounded live run on gitlab.com

Status: **not qualified.** The single authorised write attempt, run `20261106061858-e98a`, passed the
create, bottom-up, removal-merge, retarget and Unstack steps. It failed at the middle layer's merge,
which never became mergeable within the poll bound. Cleanup was verified. The run made 12 of 16
provider writes, including 1 of the 2 planned merges. GitLab answered no 429, and the run had 0
model turns. A second attempt needs maintainer authorisation.

Contract: issue [#1437](https://github.com/chrisbanes/cab/issues/1437), its agent brief and the approved
plan's live-run contract; [ADR-1023](../adr/1023-stacked-dependencies.md) and the GitLab stacking
paragraphs of [SPEC](../SPEC.md). Harness: `test/delivery/gitlab-qualification/live-gitlab-stack.mjs`
(journey `gitlab-stack-journey.ts`, guard and cleanup in the same directory), from candidate
`d2dc2aff578d26816ca9a6bb54d54b2c1013dd05` on Node v26.13.0. The raw result is
[`2026-11-06-gitlab-stack-live.json`](2026-11-06-gitlab-stack-live.json); it holds no credential.

## Command

```sh
env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN \
  node test/delivery/gitlab-qualification/live-gitlab-stack.mjs --live --result /tmp/gitlab-stack-live.json
```

The product credential and the harness's own reads used the `glab:gitlab.com` login (account id
`43935395`); `CAB_GITLAB_TOKEN` was not used.

## Guard

The guard in `stack` mode permits only:

- gitlab.com and project `88319115` (`banes3/Banes-project`), reads under it and the account;
- three pushes of the run's `cab/` task branches and three merge request creates, each on `main` or
  a branch of the run;
- one merge of the recorded bottom merge request, with `should_remove_source_branch: true`, and one
  plain merge of the recorded middle one, each with `auto_merge: false`;
- one `target_branch`-only edit of the recorded top merge request, to `main`;
- cleanup closes and branch deletes.

Every route is limited to 16 writes, 4 of them kept for cleanup. The guard refused nothing
(`guard.denied` is empty).

## Fixture

- Project [`banes3/Banes-project`](https://gitlab.com/banes3/Banes-project), id `88319115`, gitlab.com
  `19.6.0-pre`. Settings read at run time: merge method `merge`, squash option `default_off`, merge
  trains disabled, `remove_source_branch_after_merge: true`.
- `main` before the run: `6eb0c4bcf08479a16e3e9c8529701140f4b255d8`, equal to the local clone
  `/Users/chris/dev/Banes-project`.
- Merge requests: !8 (A, on `main`), !9 (B, on A's branch), !10 (C, on B's branch). B is blocked
  by A and C by B, in a stacking project with the required check `pipeline` and merge method `merge`.

## Results

| Step (live-run contract) | Result |
| --- | --- |
| 1. Three pushes; !8 on `main`, !9 on A's branch, !10 on B's | passed |
| 2. B's `pr.create` naming `main` refused (`stacked-pr-base-must-match-blocker-branch`), zero requests | passed |
| 3. B's `pr.merge` before A merged refused (`stacked-lower-pr-unmerged`), zero requests | passed |
| 4. A's merge body `{sha, squash: false, auto_merge: false, should_remove_source_branch: true}`, settled `confirmed-success` | passed |
| 5. A's branch reads 404; !9 targets `main`; cab accepted the retarget (`acceptedBaseRef: "main"`, `acceptedRetarget.fromRef` = A's branch); B's head unchanged, no adoption | passed |
| 6. Unstack of C: preview `codeHost: "gitlab"`, members `[!9, !10]`; one `{target_branch: "main"}` edit; journal `confirmed`; C's edge retired; one restack notice queued | passed |
| 7. B's merge without the removal key | **failed**: timed out waiting for !9 to become mergeable; no merge was sent |
| 8. Pipeline on `main` after the merges | not reached. `main`'s pipeline at A's merge commit `74e1da6d42` succeeded |
| 9. Cleanup | verified: !8 `merged`, !9 and !10 `closed`, all three branches read 404; no 429 |

Writes: **12 of 16**, 1 merge. In order: push and create for each of A, B and C; A's merge; C's
retarget; close !9 and !10; delete B's and C's branches. A's branch was already gone. About 515 API
requests, none answered 429.

## Why step 7 failed

After the run, read-only checks of the three merge requests showed:

- !9, which GitLab retargeted when A's branch was removed, has `head_pipeline: null`. Its pipeline
  list still holds the successful push pipeline at its head (`bbc50e59eb`).
- !10, which cab retargeted through Unstack, and !8 both keep their head pipeline.

So GitLab's automatic retarget clears the merge request's head pipeline. cab read the required
`pipeline` check only from `head_pipeline`, so B's check stayed unproved and the merge gate held it.
The run did not record B's merge blockers, so this cause is inferred from those reads. The harness
now names the blockers when that wait times out.

This is a plan assumption that failed: the plan expected a retargeted dependent to merge as it is.
The fix, made after this run and not yet qualified live: when `head_pipeline` is null, the provider
reads the merge request's newest pipeline at its head from `GET .../merge_requests/:iid/pipelines`.
The scripted instance now clears the head pipeline on retarget, and the assembled bottom-up test fails
without the fallback.

## Residue

- `main` gained A's merge commit `74e1da6d42` (`qual/20261106061858-e98a-stack-a.md`). **The merge is real
  and irreversible**; cab has no unmerge or revert.
- The merged !8, the closed !9 and !10, and their pipelines.

## Limits of this evidence

- This run does not qualify the merge of a dependent that GitLab retargeted, or the `main` pipeline
  after both merges.
- The project removes source branches after merge by default, so the live run cannot show whether
  GitLab removed A's branch because cab asked or because of that default. Only the recorded merge
  body proves what cab sent.
- It covers gitlab.com SaaS at `19.6.0-pre` only, one personal project with no concurrent activity,
  no merge trains, no restart and no rate limiting. The harness reads with the first `glab` token
  until cleanup, which reads it again; a token that expires mid-run fails the run but not its cleanup.
