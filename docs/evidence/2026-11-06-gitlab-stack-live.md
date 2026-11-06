# GitLab stacking: bounded live run on gitlab.com

Status: **qualified, with the limits below.** Attempt 2, run `20261106071357-9117` from candidate
`9c6a74a050ad23cdecd94ace95c9b004770aef20`, passed every step of the live-run contract. It made 11 of
16 provider writes, including both planned merges, GitLab answered no 429, and cleanup was verified.
Attempt 1, run `20261106061858-e98a` from `d2dc2aff578d26816ca9a6bb54d54b2c1013dd05`, failed at the
middle layer's merge. That failure led to the pipeline fix that attempt 2 ran with; both attempts are
recorded below. Each attempt had 0 model turns, and the maintainer authorised attempt 2 after attempt 1.

Contract: issue [#1437](https://github.com/chrisbanes/cab/issues/1437), its agent brief and the approved
plan's live-run contract; [ADR-1023](../adr/1023-stacked-dependencies.md) and the GitLab stacking
paragraphs of [SPEC](../SPEC.md). Harness: `test/delivery/gitlab-qualification/live-gitlab-stack.mjs`
(journey `gitlab-stack-journey.ts`, guard and cleanup in the same directory), on Node v26.13.0. The raw
results are [`2026-11-06-gitlab-stack-live.json`](2026-11-06-gitlab-stack-live.json) (attempt 1) and
[`2026-11-06-gitlab-stack-live-attempt-2.json`](2026-11-06-gitlab-stack-live-attempt-2.json); neither
holds a credential.

## Command

```sh
env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN \
  node test/delivery/gitlab-qualification/live-gitlab-stack.mjs --live --result /tmp/gitlab-stack-live-2.json
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
- `main` before attempt 1: `6eb0c4bcf08479a16e3e9c8529701140f4b255d8`; before attempt 2:
  `74e1da6d42bf09367a885adcd2d1191373f20772` (read from the project after attempt 1). Each equalled the local clone
  `/Users/chris/dev/Banes-project` when its run started.
- Each run has three tasks: B is blocked by A and C by B, in a stacking project with the required
  check `pipeline` and merge method `merge`.

## Attempt 2 results

Merge requests: !11 (A, on `main`), !12 (B, on A's branch), !13 (C, on B's branch).

| Step (live-run contract) | Result |
| --- | --- |
| 1. Three pushes; !11 on `main`, !12 on A's branch, !13 on B's | passed |
| 2. B's `pr.create` naming `main` refused (`stacked-pr-base-must-match-blocker-branch`), zero requests | passed |
| 3. B's `pr.merge` before A merged refused (`stacked-lower-pr-unmerged`), zero requests | passed |
| 4. A's merge body `{sha, squash: false, auto_merge: false, should_remove_source_branch: true}`, settled `confirmed-success` | passed |
| 5. A's branch reads 404; !12 targets `main`; cab accepted the retarget; B's head unchanged, no adoption | passed |
| 6. Unstack of C: preview `codeHost: "gitlab"`, members `[!12, !13]`; one `{target_branch: "main"}` edit; journal `confirmed`; C's edge retired; one restack notice queued | passed |
| 7. B's merge body `{sha, squash: false, auto_merge: false}`, with no removal key, settled `confirmed-success` | passed |
| 8. Pipeline on `main` after the merges | `success` (`main` read at `d66002663c` after the run) |
| 9. Cleanup | verified: !11 and !12 `merged`, !13 `closed`, all three branches read 404; `guard.denied` empty; no 429 |

Writes: **11 of 16**, 2 merges. In order: push and create for each of A, B and C; A's merge; C's
retarget; B's merge; close !13; delete C's branch. GitLab had already removed A's and B's branches.
142 API requests, none answered 429. Seven of them read a merge request's pipeline list, the fallback
the provider uses when a merge request has no head pipeline. The result does not record which merge
request those reads were for, so that they are what made B mergeable is inferred.

Before attempt 2's run, one invocation of the same command was refused before any write
(`clone-main-stale`): the local clone's `main` still pointed at the commit from before attempt 1. Its
`main` was fast-forwarded from the project with `git fetch origin main:main`, and the command was run
again. The refused invocation made 0 writes and does not count as an attempt.

## Attempt 1

Merge requests: !8 (A, on `main`), !9 (B, on A's branch), !10 (C, on B's branch).

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

### Why step 7 failed

After the run, read-only checks of the three merge requests showed:

- !9, which GitLab retargeted when A's branch was removed, has `head_pipeline: null`. Its pipeline
  list still holds the successful push pipeline at its head (`bbc50e59eb`).
- !10, which cab retargeted through Unstack, and !8 both keep their head pipeline.

So GitLab's automatic retarget clears the merge request's head pipeline. cab read the required
`pipeline` check only from `head_pipeline`, so B's check stayed unproved and the merge gate held it.
The run did not record B's merge blockers, so this cause is inferred from those reads. The project
does not require pipelines to succeed (`only_allow_merge_if_pipeline_succeeds: false`, read after the
run), so GitLab's own merge status does not depend on the head pipeline there; cab's required check
was the only gate the missing head pipeline could hold. The harness
now names the blockers when that wait times out.

This is a plan assumption that failed: the plan expected a retargeted dependent to merge as it is.
The fix, made after this run and qualified by attempt 2: when `head_pipeline` is null, the provider
reads the merge request's newest pipeline at its head, by id, from `GET .../merge_requests/:iid/pipelines`.
The scripted instance now clears the head pipeline on retarget, and the assembled bottom-up test fails
without the fallback.

## Residue

- `main` gained three merge commits: attempt 1's `74e1da6d42` (A), and attempt 2's A and B merges up to
  `d66002663c`. They add `qual/20261106061858-e98a-stack-a.md`, `qual/20261106071357-9117-stack-a.md` and
  `qual/20261106071357-9117-stack-b.md`. **The merges are real and irreversible**; cab has no unmerge or revert.
- The merged !8, !11 and !12, the closed !9, !10 and !13, and their pipelines.

## Limits of this evidence

- The project removes source branches after merge by default, and that default applies to merge
  requests cab creates: in attempt 2, GitLab removed B's branch after a merge that sent no removal
  flag. So on this fixture A's branch removal cannot be credited to cab's flag; only the recorded
  merge body proves what cab sent.
- It covers gitlab.com SaaS at `19.6.0-pre` only, one personal project with no concurrent activity,
  no merge trains, no restart and no rate limiting. The harness reads with the first `glab` token
  until cleanup, which reads it again; a token that expires mid-run fails the run but not its cleanup.
