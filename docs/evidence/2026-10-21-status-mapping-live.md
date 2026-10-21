# Status mapping: bounded live run

Status: **bounded live Project write qualified at the coordinator level, on an earlier revision of
the candidate; the attempt on the final head failed in the harness's own setup.** On a scratch
user-owned Project, the real status-mapping writer, delivery coordinator and provider wrote the
Status for `turnStarted` and `handedBack` and read each back, and `gh` read both back
independently. It is not a service or lead-turn run: the harness drove the writer directly with
**0 model turns**, and induced the two events in local state (a stub for "a turn has bound", and a
local PR binding). The deterministic `status-mapping-service` tests cover event origin through the
service. This run covers the real Project write, the provider's re-read of the Status before the
write, and the readback; it does not exercise a Status moved by a human between the re-read and
the write, the skipped-write path, `held` or `done` against GitHub, or a Codex lead turn.

Contract: [ADR-1017](../adr/1017-non-agent-readiness-writes.md) and the issue
[#1194](https://github.com/chrisbanes/ensemble/issues/1194). Harness:
`test/delivery/github-qualification/live-status-mapping.mjs`, run from candidate
`b15fb387571ca0ea1bd205ee0e13a36fe609f296` (branch `cb/issue-1194-status-mapping`) on Node
v24.22.0. Later commits changed the live path: status writes run in their own queue with a time
limit, freshness is tracked per membership, handed back no longer ends when the PR closes, and Done
is also written for a done task whose issue is closed. They also changed tests, docs and this record.
Deterministic tests cover those changes; this run did not exercise them. Decision 9 then allowed one
more attempt on the final head (attempt 3, below).

## Authority

Maintainer decision 5 and the approved plan allowed at most **2 attempts** and **0 model turns**,
each creating and deleting its own scratch user-owned Project linked to
`chrisbanes/ensemble-s07a-fixture`. The ticket agent wrote the manifest and grant outside the
repository: manifest SHA-256 `0d4d98c95edad0b2aa5035cce750c2b8088bd269c123f3e4f421f291128eca99`, naming exactly `project.field`, no model turns, `maxAttempts: 2`, a 12-hour grant, and
cleanup limited to the recorded Project and fixture issue. The credential came in-process from the
product's `ghToken()` (the maintainer's `gh` login, which has the `project` scope); it reached only
the guarded HTTP client and was never printed or stored. `gh` ran under its own login, limited by the
guard to exact command shapes. The guard validated the manifest and grant before the credential was
read, and permitted only `api.github.com`, the fixture repository, the one Project the run created,
its recorded issue, item, field and options; it refuses Project number 6 and any Project linked to a
repository other than the fixture (including `chrisbanes/ensemble`).

## Fixture identities

- Repository `chrisbanes/ensemble-s07a-fixture` (node `R_kgDOU35McQ`, public, default branch
  `qualification`). Account `chrisbanes` (node `MDQ6VXNlcjIyNzQ4Ng==`).
- Attempt 2 Project: node `PVT_kwHOAAN4ns4BoHDJ`, number 15, fixture issue #8. Attempt 1 Project:
  node `PVT_kwHOAAN4ns4BoGth`, number 14, fixture issue #7.

## Attempts

**Attempt 1 (run `391c076b`, failed in the harness).** The harness created the Project, linked it,
set the four Status options, created issue #7 and added it at Todo. The product's Project read then
returned a complete snapshot that did not list exactly one issue (reported as "unexpected"), so the
run stopped before any Status write. Cleanup deleted the Project and closed the issue, but the harness
reported `cleanup: unverified` because a deleted Project answers GraphQL with a not-found error, not a
null node. An independent `gh` read afterwards showed Project 14 gone (`gh project list` and the node
read both absent) and issue #7 closed. The harness was then changed: it reads the Project again
(alternating the filters `""` and `is:issue`) before failing, records the read counts, treats a
not-found answer as proof of deletion, and attempts each cleanup step separately. The cause of the
attempt 1 read was not isolated: a late listing of the new item is the likely cause, since attempt 2
read the same Project shape on its first read.

**Attempt 2 (run `fc93c153`, passed).** Sanitized harness result:

```json
{
  "turns": 0,
  "qualification": "passed",
  "cleanup": "verified",
  "project": { "nodeId": "PVT_kwHOAAN4ns4BoHDJ", "number": 15 },
  "projectReads": { "reads": 1, "filter": "", "complete": true, "reason": null, "issues": 1 },
  "turnStarted": { "state": "confirmed-success", "providerReadback": "confirmed", "independentReadback": "In Progress" },
  "handedBack": { "state": "confirmed-success", "providerReadback": "confirmed", "independentReadback": "In review" },
  "credentialExposures": 0,
  "deletedProject": { "nodeId": "PVT_kwHOAAN4ns4BoHDJ", "number": 15, "deleted": true },
  "writes": [
    "gh project create", "gh project link", "gh api graphql", "gh issue create",
    "gh project item-add", "gh project item-edit",
    "POST /graphql updateProjectV2ItemFieldValue", "POST /graphql updateProjectV2ItemFieldValue",
    "gh issue close", "gh project delete"
  ]
}
```

Pass conditions, each checked by the harness:

- One real sync of the Project listed exactly one issue, recorded its Project item id, and the
  imported task was Ready.
- `turnStarted` produced one `project.field` operation to In Progress and `handedBack` one to In
  review, each `confirmed-success` by the provider's own readback and each equal to `gh project
  item-list`'s Status.
- A further pass with no transition wrote nothing (two Status mutations in all).
- The credential does not appear in the result.

**Attempt 3 (run `78410597`, failed in the harness setup, on the final head).** Maintainer decision 9
allowed one further attempt on the final head with the same limits (0 model turns, a scratch
Project created and deleted, Project 6 never used). It ran from `beddebd6793056287e955db6087857edeb5fee23`
under a new manifest (SHA-256 `9aeea720d5a698df4753d276226765733ec0f2384ff50b6f8453fcab7d3bab0a`,
`maxAttempts: 3`, a 12-hour grant; the only difference from the first manifest). The harness created
Project 16 (node `PVT_kwHOAAN4ns4BoIO6`) and linked it, set the Status options and created fixture
issue #9; then `gh project item-add` failed with GitHub's "Your attempt to move this item created a
temporary conflict. Please try again." No product code had run, so nothing was written to the Project's
Status. Cleanup closed the issue and deleted the Project, and the harness verified both
(`cleanup: verified`); an independent `gh` read afterwards shows Project 16 absent, its node not found,
and issues #7, #8 and #9 `CLOSED`. The allowance is spent. The harness has no retry for a transient
setup error.

## Cleanup proof

The harness closed issue #8 and deleted Project 15, then read both back. An independent `gh` read
after the run lists no Project 15 (`gh project list --owner chrisbanes` shows Verity, Ensemble S07a
qualification, Ensemble S06 qualification, Portico, Haze and Ensemble), reads the node as not found,
and shows issues #7 and #8 `CLOSED`. Project 6 was never read or written.

## Limits

Three attempts were used; none remain, and the only passing one (attempt 2) ran on an earlier
revision than the final head. The run exercised the re-read with a matching
Status, so a mismatch is covered only by the deterministic provider and service tests. The fixture
repository keeps three closed issues (#7, #8, #9) from the three attempts.
