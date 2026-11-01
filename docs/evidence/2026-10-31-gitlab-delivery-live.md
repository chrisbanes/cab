# GitLab delivery: bounded live run on gitlab.com

Status: **qualified, with the limits below.** Run `20261031183634-78a4` (attempt 4) passed every step of the
credential probe and both journeys, made 12 provider writes including the one merge, answered no 429, and
verified its own cleanup. Earlier attempts failed for reasons recorded under [Attempts](#attempts); the product
and harness changes they led to are part of the code this run used. The run had **0 model turns**.

Contract: [ADR-1020](../adr/1020-code-hosts-and-issue-trackers.md), the GitLab paragraphs of
[SPEC](../SPEC.md), and the issue [#1315](https://github.com/chrisbanes/cab/issues/1315) (epic #1306). Harness:
`test/delivery/gitlab-qualification/live-gitlab-delivery.mjs` (journey, guard and cleanup in the same
directory), from candidate `b476f2bb7f2a157d61272e4fc1d2bb6b974db344` on Node v24.22.2.

## Command

```sh
eval "$(grep 'CAB_GITLAB_TOKEN=' ~/.env)"
env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN \
  node test/delivery/gitlab-qualification/live-gitlab-delivery.mjs --live --result /tmp/gitlab-live-attempt4.json
```

The wrapper refuses to start without `--live` and `CAB_GITLAB_TOKEN`, with a stray argument, a relative result path,
or any of `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` and `OAUTH_TOKEN` set (`glab` would use one of those instead of its own
login, which would defeat the probe).

## Authority and guard

The plan allowed at most 2 write attempts, 0 model turns, writes only to the fixture project, and at most 16 provider
writes per attempt. Attempt 1 was run by the ticket agent and attempts 2 to 4 by the user, so this run is the fourth write attempt, beyond the
planned two. Every request, Git push and fetch of the run went through a guard that permits only:

- `https://gitlab.com` and project `88319115` (`banes3/Banes-project`); reads under it, the account, and the two token probes;
- writes only to the branches and merge requests the run recorded, one setup discussion, one setup commit (under `qual/`) and one merge, with
  `auto_merge: false` and no other keys, and never a merge-train or auto-merge request;
- the one GraphQL document that makes a draft ready, for a recorded merge request;
- Git pushes of `cab/` task branches only, and fetches of branches the run pushed;
- at most 16 writes, of which 4 are kept for cleanup; a 429-answered send counts as a write.

The guard refused nothing in this run (`guard.denied` is empty, and the journey fails if it is not).
Neither credential was printed or stored: the harness result carries statuses, counts, identifiers and the
rate-limit headers GitLab sent, and the result file is the only artifact (kept outside the repository and transcribed here).

## Fixture identities

- Project [`banes3/Banes-project`](https://gitlab.com/banes3/Banes-project), id `88319115`, private, `main` protected with Maintainer merge,
  no approval rules; `.gitlab-ci.yml` job `qualify` fails when a `FAIL_PIPELINE` file exists. Settings read at run time:
  squash option `default_off`, merge trains disabled.
- Instance: gitlab.com at version `19.6.0-pre` (`GET /api/v4/version`). Account id `43935395`.
- Run `20261031183634-78a4`: merge requests !5 (journey A) and !6 (journey B).
- The checkout was cloned from `/Users/chris/dev/Banes-project` (`main`, equal to the project's `main` before any write).

## What the run does

1. **Probe, read-only.** Each credential, the `env:CAB_GITLAB_TOKEN` variable and the `glab:gitlab.com` login, must authenticate with
   `Authorization: Bearer` on three reads: the account (`GitLabDiscoveryReader.user()`), the project list (it must contain `88319115`), and one
   delivery read (`GitLabHttpDeliveryProvider.inspectPr` on journey A's merge request). Both must act as the same account. The kind of
   each is classified from `GET /oauth/token/info` and `GET /api/v4/personal_access_tokens/self`, never from a value.
2. **Journey A (reviewable-pr).** A task pushes a commit that adds `FAIL_PIPELINE`, opens a merge request, waits for the `qualify` pipeline to
   fail, the harness (as the operator's account) creates one resolvable discussion, the lead replies, a stale resolve naming the setup note is
   refused with zero writes, the lead resolves, and the operator settles the handback.
3. **Journey B (through-merge).** A second task pushes a commit and opens a **draft** merge request; the harness adds one outside commit on the task branch;
   the lead adopts it (the one recovery, approved as the operator); a merge is refused while the request is a draft; `pr.ready` makes it ready;
   after the pipeline passes the lead merges once (`squash`) and the merge settles as acceptance. A pipeline on `main` after the merge must succeed.
4. **Cleanup,** which counts toward pass or fail: it closes every open merge request the run created (leaving one whose merge may still be pending) and
   deletes its branches, then reads each back.

## Results

| Item (issue #1315 and plan) | Result |
| --- | --- |
| Push, merge request registered (A) | passed, !5 |
| Pipeline failure observed; exactly one wake names it; an unchanged refresh adds no wake (A) | passed |
| Discussion reply, stale resolve refused with no write, resolve (A) | passed |
| Handback waits for settlement, operator settles it (A) | passed |
| Push, draft merge request registered (B) | passed, !6 |
| Outside head recorded; adopted as the recovery (B) | passed |
| Merge refused with GitLab's reason while a draft: blockers `pr-draft`, `merge-status-draft_status`, zero writes (B) | passed |
| Ready through GraphQL `mergeRequestSetDraft` (B) | passed |
| Merge passes the expected head as `sha` with `auto_merge: false`, settles `confirmed-success`, merged merge request is acceptance (B) | passed, method `squash` |
| Pipeline on `main` after the merge | `success` |
| Probe: `env:` token is a personal access token, `glab:` login is an OAuth token; both read the account, the project list and the merge request with `Authorization: Bearer`; same account | passed (settles #1351) |
| Cleanup | verified |

Writes: **12 of 16**, 1 merge. In order: `git push`, create merge request, discussion, reply, resolve (A); `git push`, create merge request, commit, ready, merge (B); close !5,
delete A's branch. GitLab appears to have removed journey B's source branch itself when the merge request merged (cleanup found it already gone and sent one delete), so the plan's 13th write was not needed.

Request counts (110 API requests plus 2 `glab` runs, no 429): `GET /projects/:n` 8, `GET .../branches/:branch` 18, `GET /user` 5, merge request reads 32, discussion reads 21 and 5,
and 2 each for `/oauth/token/info` and `/personal_access_tokens/self`. The 21 and 32 are decision-gating reads that are never kept.

## Cleanup and residue

Cleanup reads: merge request !5 `closed`, !6 `merged`, both task branches `deleted` (404 on read-back). Persistent residue on the fixture project:

- `main` gained one squash commit that merged journey B: `qual/20261031183634-78a4-b.md` and the outside commit's `qual/20261031183634-78a4-outside.md`. **The merge is real and irreversible**; cab has no unmerge or revert.
- The closed and merged merge requests with their notes, and their pipelines, plus the closed merge requests of the earlier attempts (!1 to !4).

## Attempts

| # | Run | By | Outcome |
| --- | --- | --- | --- |
| 0 | two zero-write invocations | agent | The first push was held as `provider-credential-unavailable` before any write: the fixture service points `glab` at a path that does not exist, so a `glab:` login could not resolve. Fixed by plumbing the real executable. Not counted: no write was made. |
| 1 | `20261030230713-e3de` | agent | 5 writes. Probe passed, merge request !1 opened and made ready; the harness assertion that the failing pipeline wakes the lead measured one refresh while the service's own post-action refresh had already seen the failure. Counting the wakes that name the failure fixed it. Cleanup verified. |
| 2 | `20261031090415-5b1c` | user | 5 writes (push, merge request !2, ready, discussion, reply), no merge. gitlab.com answered a plain-text rate-limit body; reading the reply back ended `uncertain (provider-readback-unavailable)` and both cleanup reads failed to parse the plain text. **Cleanup failed:** !2 and its branch were closed and removed manually by the operator. Led to the 429 retry, request pacing and the re-runnable cleanup. |
| 3 | `20261031102238-a16e` | user | One 429 on `GET .../merge_requests/:n` (`Retry-After: 25`; headers `ratelimit-limit`, `-name`, `-observed`, `-remaining`, `-reset`, `-resettime` and `retry-after` present, values not yet recorded; body "Rate limit exceeded; see https://docs.gitlab.com/user/gitlab_com/rate_limits/ ..."). Journey B failed: the early merge reached `PUT /merge` because the pipeline had finished during the wait and the request was genuinely mergeable (the guard denied it), so the timing-dependent assertion was wrong, not preflight. 13 writes, no merge. Cleanup verified (!3, !4). Led to the request-volume work and the draft-based refusal. |
| 4 | `20261031183634-78a4` | user | Passed, as above. |

Which named limit fired in attempt 3 is **not proved**: the header values were not recorded then. The likely one is gitlab.com's per-user API burst limit
(the [rate limits page](https://docs.gitlab.com/user/gitlab_com/rate_limits/) lists 100 requests a minute for the Free plan as proposed, and says GitLab applies the lower of the
current and plan limits), reached because each product request also ran `glab`, which asks GitLab to check the token: about 273 calls in a fast fake run against about 116 now.
The harness now records every `ratelimit-*` header value, the request number and the volume in the preceding minute of any 429, and attempt 4 saw none.

## Limits of this evidence

- gitlab.com SaaS at `19.6.0-pre`, Free tier. It does **not** prove a self-managed instance's version or settings (ADR-1020), nor merge trains, approvals or merged-results pipelines;
  the merge-train path is qualified only by scripted tests.
- **The live run no longer exercises "merge refused while the pipeline has not passed".** That gate (cab's required `pipeline` check and `detailed_merge_status` other than `mergeable` for a
  running pipeline) is covered by the scripted tests only. The live refusal is made deterministic by journey B's draft merge request, which proves GitLab's own merge status (`draft_status`) is consulted and that
  a refused merge sends no write, but not the pipeline timing. This is a deliberate change from the plan, made because the pipeline's speed is not under the run's control (attempt 3).
- One personal project with a protected `main`, no concurrent human activity, no restart or rate-limit coverage in the live run (the deterministic tests own restart and 429 retries), and one page of discussions.
- The `glab` token is kept by the service for up to 5 minutes, so an outside `glab auth login` as another account can leave delivery acting as the previous account for that long or until its first 401.
- Which limit the 429 in attempt 3 hit, and the headers gitlab.com sends on the Projects API's 429, are unproved here; the retry design follows GitLab's documentation (`Retry-After`, then `RateLimit-Reset`, then a doubling fallback).
- The request counts above are one passing run, not a bound.
