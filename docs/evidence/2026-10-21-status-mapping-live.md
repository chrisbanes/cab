# Status mapping: bounded live run

Status: **bounded live Project write qualified at the coordinator level.** On a scratch
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
Deterministic tests cover those changes; the live allowance is spent, so this run did not exercise them.

## Authority

Maintainer decision 5 and the approved plan allow at most **2 attempts** and **0 model turns**,
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

## Cleanup proof

The harness closed issue #8 and deleted Project 15, then read both back. An independent `gh` read
after the run lists no Project 15 (`gh project list --owner chrisbanes` shows Verity, Ensemble S07a
qualification, Ensemble S06 qualification, Portico, Haze and Ensemble), reads the node as not found,
and shows issues #7 and #8 `CLOSED`. Project 6 was never read or written.

## Limits

Two attempts were used; none remain. The run exercised the re-read with a matching
Status, so a mismatch is covered only by the deterministic provider and service tests. The fixture
repository keeps two closed issues (#7, #8) from the two attempts.
