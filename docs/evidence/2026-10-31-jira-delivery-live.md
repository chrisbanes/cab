# Jira delivery and status mapping: bounded live run on Jira Cloud and gitlab.com

Status: **qualified, with the limits below.** Run `20261031211750-4a1a` (the second write attempt) passed every step
and every live prerequisite, made 11 Jira writes and 4 GitLab writes with 0 merges, answered no 429, and verified its
own cleanup. The first write attempt failed in the harness itself (a link created the wrong way round) and is recorded
under [Attempts](#attempts); the fix is part of the code this run used. The run had **0 model turns**.

Contract: [ADR-1020](../adr/1020-code-hosts-and-issue-trackers.md), the Jira paragraphs of [SPEC](../SPEC.md), and the
issue [#1321](https://github.com/chrisbanes/cab/issues/1321) (epic #1306). Harness:
`test/delivery/jira-qualification/live-jira-delivery.mjs` (journey, guard and cleanup in the same directory), from
candidate `f71d8de89a720050ca9af517c11078f2b3db0f32` on Node v24.22.2.

## Command

```sh
npm run build
eval "$(grep -E '^export (CAB_JIRA_SITE|CAB_JIRA_EMAIL|CAB_JIRA_API_TOKEN|CAB_GITLAB_TOKEN)=' ~/.env)"
env -u GITLAB_TOKEN -u GITLAB_ACCESS_TOKEN -u OAUTH_TOKEN \
  node test/delivery/jira-qualification/live-jira-delivery.mjs --live --result /tmp/jira-live-attempt3.json
```

The wrapper refuses to start without `--live` and all four variables (`CAB_JIRA_SITE`, `CAB_JIRA_EMAIL`,
`CAB_JIRA_API_TOKEN`, `CAB_GITLAB_TOKEN`), with `CAB_JIRA_SITE` other than `https://banes-team.atlassian.net`, with a stray
argument, a relative result path, or any of `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN` and `OAUTH_TOKEN` set. Delivery uses
`env:CAB_GITLAB_TOKEN`, so no `glab` ran.

## Authority and guard

The plan allowed at most 2 write attempts, 0 model turns, writes only to Jira project `KAN` (id `10001`) on
`banes-team.atlassian.net` and only to issues the run creates, plus GitLab project `88319115` and only the branch and merge
request the run creates, and no merge. This run is the second write attempt. Every Jira request went through `JiraGuard`
and every GitLab request, push and fetch through `GitLabGuard`; together they permit only:

- `https://banes-team.atlassian.net/rest/api/3` and, on GitLab, `https://gitlab.com` and project `88319115`;
- Jira reads of `/myself`, `/project/10001/statuses`, the run's own JQL (`project = KAN AND labels = "cab-qual-<run>"`), and the issues the run recorded;
- Jira writes only to recorded issues: at most 2 issue creates (project `10001`, the run label and summary), 1 `Blocks` link between recorded issues, 4 transitions, 1 comment, 1 label add (a label that begins with the run label); an issue delete and removal of `cab-ready` only during cleanup;
- on GitLab, pushes of `cab/` task branches, one merge request for a recorded branch, and the close and branch delete of cleanup; never a merge;
- at most 16 Jira writes with 4 kept for cleanup, and 6 GitLab writes with 2 kept; a 429-answered send counts as a write; requests are spaced 500 ms (Jira) and 750 ms (GitLab) apart.

The guards refused nothing (`guard.denied` is empty for both, and the journey fails if it is not). No credential was
printed or stored: the result file carries statuses, counts, identifiers, link summaries and rate-limit header values, and is the only artifact
(kept outside the repository and transcribed here). The Jira account id is omitted here.

## Fixture identities

- Jira Cloud site `banes-team.atlassian.net`, team-managed project `KAN` (id `10001`). Statuses To Do `10003`, In Progress `3`, In Review `10004`, Done `10005` (the only Done-category status), global any-to-any transitions; link type `Blocks`; label `cab-ready`; single-select field `customfield_10045` (High `10022`, Low `10023`).
- GitLab project [`banes3/Banes-project`](https://gitlab.com/banes3/Banes-project), id `88319115`, on gitlab.com `19.6.0-pre`; account id `43935395`. The checkout (`/Users/chris/dev/Banes-project`, `main` equal to the project's before any write) was cloned for the run.
- Run `20261031211750-4a1a`: Jira issues KAN-6 (A, id `10015`) and KAN-7 (B, the blocker, id `10016`); merge request !7 on branch `cab/KAN-6-9d3d9b02-qualification-20261031211750-4a1a-a`.

## What the run does

One journey through the real `StandaloneService`, delivery coordinator, Jira source and writer and GitLab provider, with a scripted lead:

1. **Setup.** The harness creates A (labels `cab-ready` and `cab-qual-<run>`, `customfield_10045 = 10022`) and B (blocker, run label only), links B as blocking A, and polls its own JQL until both are listed and A reads "is blocked by" B. A direct read of A also confirms the link direction.
2. **Configure (local).** Credential and source from the variables; readiness `all` of label `cab-ready`, `customfield_10045 in 10022`, status `in 10003, 3, 10004`; reviewable-pr delivery with grants for comment, labels, close and `issue.status` (statuses `3, 10003, 10004, 10005`), plus push and `pr.create` on the GitLab project. A mapping with `turnStarted → 10005` is refused (`readiness`), one using `10004` before its grant exists is refused (`ungranted`), then the mapping `turnStarted 3`, `handedBack 10004`, `held 10003`, `done 10005` is saved.
3. **Import, readiness, dependency.** A is Ready and held by B, which is Draft; the held write is skipped because A is already To Do.
4. **Dependency clears.** B is moved to Done, the harness waits for the index, the service refreshes, A is unblocked and its lead turn starts.
5. **Turn started.** The status write moves A from To Do to In Progress, read back.
6. **Comment and labels.** The lead's comment is confirmed by its marker and text; a label is added and read back; removing `cab-ready` is refused with no write.
7. **Key in branch and merge request.** The lead pushes (the branch carries the key `KAN-6`); a `pr.create` whose text says `Closes KAN-6` is refused with no write; `pr.create` with the title `KAN-6 Qualification <run> a` opens !7 (reviewable-pr).
8. **Changed skip.** The harness moves A from In Progress back to To Do as a person would; the service then registers the merge request and the `handedBack` write is skipped as changed, with no search and no transition POST in between.
9. **Closure.** The operator settles the handback; the lead closes the issue by the single transition to Done, proven by a changelog entry by the credential's account; the source is refreshed; the operator settles again (see [Limits](#limits-of-this-evidence)); the lead completes the task; the `done` write is skipped because A is already Done.
10. **Cleanup,** which counts toward pass or fail: the merge request is closed and its branch deleted, both issues are deleted, and each is read back.

## Results

| Item (issue #1321, acceptance criterion 3) | Result |
| --- | --- |
| Read-only preflight: accounts, the four status IDs, project, clone equals `main` | passed |
| Issues created and linked; A reads "is blocked by" B (direct read and search, first poll) | passed, KAN-6 blocked by KAN-7 |
| Mapping refused for readiness, then for a missing grant; then saved | passed |
| Import and readiness: A Ready, B Draft; dependency makes A `held`; held write skipped `provider-issue-status-current` | passed |
| Blocker Done, index shows it, refresh unblocks A, lead turn starts | passed |
| `turnStarted` moves A to In Progress (`issue.status`, read back by `GET /issue`) | passed, `confirmed-success` |
| Comment confirmed by marker and ADF text; label add read back; `cab-ready` removal refused, no write | passed |
| Branch `cab/KAN-6-...` carries the key; a closing keyword refused with no write; MR title `KAN-6 Qualification ... a` | passed, !7 |
| `handedBack` skipped when a person moved the status; no search or transition between | passed, `provider-issue-status-changed` |
| `issue.close` by the single transition to Done, proven by changelog; task completes; `done` skipped | passed, `provider-issue-status-current` |
| Cleanup | verified |

Live prerequisites from the plan: comment `properties` kept and returned by `/comment/list?expand=properties` and ADF readback matches: passed; changelog ids increase and carry the account id: passed; `update.labels` semantics: passed; the transition response is `204`: passed; search `issuelinks` carries the linked issue's status category (`new` before, `done` after): passed.

Status writes by the service, in order: `held` skipped (current), `turnStarted` confirmed, `handedBack` skipped (changed), `done` skipped (current).

Polls of the harness's own JQL: 1 for each of "issues and link indexed", "blocker done indexed" and "A done indexed". The index never lagged in this run; lag handling is covered by scripted tests only.

## Writes and request counts

- **Jira 11 of 16** (4 kept for cleanup): create A, create B, link, transition B to Done, transition A to In Progress (product), comment (product), label add (product), transition A to To Do (harness), transition A to Done (product `issue.close`), delete KAN-6, delete KAN-7. Responses `201`, `201`, `201`, `204`, `204`, `201`, `204`, `204`, `204`, `204`, `204`.
- **GitLab 4 of 6** (2 kept for cleanup): `git push`, create merge request, close !7, delete branch. 0 merges.
- Jira requests (61, no 429): `/myself` 7, project statuses 1, issue GET 21, search 8, transitions GET 4 and POST 4, changelog 7, comment GET 1 and POST 1, `comment/list` 1, create 2, link 1, label PUT 1, delete 2. GitLab (32 API requests plus the push, no 429): project 2, version 1, user 2, branch reads 7, merge request reads 9 and list 1, discussions 7, create 1, close 1, branch delete 1.
- Rate-limit headers on the last Jira response (no 429 occurred): `ratelimit: "jira-burst-based";r=398;t=1`, `ratelimit-policy: "jira-burst-based";q=150;w=1`, `x-ratelimit-limit: 400`, `x-ratelimit-remaining: 398`. The values are what Jira sent; which of them is the binding quota is not proved.

## Cleanup and residue

Cleanup reads: issue KAN-6 `deleted`, issue KAN-7 `deleted` (404 on read-back), merge request !7 `closed`, the task branch `deleted`.
The deletions are **irreversible**: the two Jira issues, with their comments, transitions and changelog, cannot be restored. Residue:

- On GitLab the closed merge request !7, its notes, and the pipeline its push started stay on the fixture project. Nothing was merged into `main`.
- In Jira the run's issue keys KAN-6 and KAN-7 (and KAN-4 and KAN-5 from the first attempt) are consumed; the project's issue counter does not go back.

## Attempts

| # | Run | By | Outcome |
| --- | --- | --- | --- |
| 0 | `20261031210904-5bc7` | controller | 0 writes. Stopped on `clone-main-stale` because the fixture clone's `main` was behind gitlab.com; the controller then fast-forwarded it to `6eb0c4bc`. Not counted: no write was made. |
| 1 | `20261031210951-4f4b` | controller, with Chris's approval | 5 Jira writes (create A, create B, link, two deletes), 0 GitLab. Timed out on "issues and link indexed" after 10 polls: the harness had created the `Blocks` link with `inwardIssue` = A and `outwardIssue` = B, and Jira reads `inwardIssue` as the issue that blocks, so A never read "is blocked by" B. The result did not record the link, so the cause was inferred. No 429. Cleanup verified (KAN-4 and KAN-5 deleted). Led to swapping the direction, a direct read of A right after the link that fails at once naming the direction, and recording A's links when a poll fails. |
| 2 | `20261031211750-4a1a` | controller, with Chris's approval | Passed, as above. A's links read `Blocks`, inward, "is blocked by", KAN-7 both after the create and in the last search. |

## Limits of this evidence

- One personal Jira Cloud site and one team-managed project (`KAN`) with global transitions. Several transitions to one status, or none, cannot occur there, so the "several transitions reach it" and "no available transition" skips are covered by scripted tests only; a company-managed workflow with conditions or validators is unproved. A work Jira site is out of scope for this epic.
- gitlab.com SaaS at `19.6.0-pre`, one personal project, one merge request in reviewable-pr mode with no merge; no self-managed GitLab.
- **The operator settles the handback twice.** The lead's `issue.close` takes the task out of Ready and so changes the task version the first settlement is bound to; the completion is held as `reviewable-pr-awaiting-current-settlement` until the operator settles again, and the lead takes the pending events in a further turn. The harness does that. Chris decided that a settlement should survive cab's own confirmed `issue.close`; that change is [#1395](https://github.com/chrisbanes/cab/issues/1395) (blocked by #1321). Until it lands the harness settles twice, and this run proves completion only with the second settlement.
- A Done transition made outside cab under the same Jira account cannot be told apart from cab's own (existing limit), so the run's outside move (to To Do) shows the status skip but not external-closure detection. Completing a Done-mode task whose issue is closed outside cab is [#1394](https://github.com/chrisbanes/cab/issues/1394), not covered here.
- 0 model turns: the lead is scripted. No restart, rate-limit (no 429 occurred) or index lag in the live run; the deterministic tests own those.
- The cleanup deleted the issues. A credential that may not delete would take the `kept-not-ready` path (remove `cab-ready`, read back), which this run did not exercise live.
- The harness's issue-link request format (`inwardIssue` = blocker) is proved only by this run. One run is not a bound on request counts.
