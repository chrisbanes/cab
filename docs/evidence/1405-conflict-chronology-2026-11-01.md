# Setup conflict action chronology

Source: [cab #1405](https://github.com/chrisbanes/cab/issues/1405),
[approved plan](https://github.com/chrisbanes/cab/issues/1405#issuecomment-6565084067).
Baseline: `2abe0e836fd0807115270cb569609ffdcbcadcbc`.
Platform: Darwin arm64, Node 26.13.0, npm 12.2.1, Playwright 1.64.1 Chromium.

## Classification and existing repair

The historical failure predates the synchronization already added by
[#1388](https://github.com/chrisbanes/cab/pull/1388). The failing push
[41191114026](https://github.com/chrisbanes/cab/actions/runs/41191114026)
used `3c94ceb654e2b4b68604e842ff9d163a185af44b`, committed at
2026-10-31T10:02:33Z. Its Setup journey did not wait for private values before
saving the source out of band. Commit
`13c72d5ecaff27d2cbcb1f5380341f1059be2fc1` at 18:21:12Z added both the
private response listener and that wait. `git show` confirms the difference.
The relevant production code in ReadyCheck, source naming, private reads,
resources, action feedback and ImportPanel is unchanged between the failing
revision and this task's baseline.

The controlled historical ordering reproduces removal of the conflict action:
a private read still pending at the external save returns source version 2;
`usePrivateValues` refreshes the loaded configuration from version 1 to version 2;
`ImportPanel` then selects the new version's draft rather than the refused
version-1 preview. The old button disconnects while the panel stays connected.
This is a semantic source-version transition, not evidence that equivalent React
renders repeatedly remount the action. The existing test wait excludes this
ordering: a response already started before the external save carries the
version-1 server snapshot even if React has not applied its body yet. Waiting for
that snapshot is sufficient for this race; no product lifetime change is needed.

The initial T1 investigation mistakenly required the historical failure to honor
the current wait. Comparing revisions resolves that factual plan assumption;
it does not establish a new post-wait defect. The controller allocated one
plan-mismatch diagnosis; no repair cycle was needed.

## Retained deterministic coverage

Two test-local cases use the real Setup, React import panel, service and fake
GitHub provider. A gate holds the first project-private request before its fetch.
The original journey and guarded case call the same extracted, unchanged
response-path wait, `waitForImportPrivateRead`.

| Schedule | Ordered observations | Result |
| --- | --- | --- |
| Historical no-wait | Configuration 1; private request held; external save 2; refused preview expectedVersion 1; release private response 2; automatic configuration response 2 | Old conflict button disconnects; original import panel stays connected |
| Current wait | Private request held; start wait then external-save continuation; verify save has not started; release private response 1; external save 2; refused preview expectedVersion 1 | Conflict remains usable; equivalent reads preserve identity and normal Review changes succeeds |

The guarded case replays two equivalent configuration-1 snapshots through the
real Check again control. Both the specific outcome and button remain connected.
A normal Review changes click then reads configuration 2. The unchanged original
journey independently proves the next preview uses version 2 and a fresh key,
then refreshes/imports. Existing unknown-preview, lost-reply, configuration draft
and private-owner/session tests cover their own recovery and privacy boundaries.
No reads activate the source, refresh sources, import tasks or Resume the project.

The regression is sensitive to the existing fix: temporarily replacing only
`waitForImportPrivateRead` with an immediately resolved promise makes the guarded
case fail deterministically: `external-save-start` appears while the private
response is still held (`true !== false`). The helper was restored before final
validation. The historical case independently demonstrates the subsequent
version-changing DOM removal. No forced click, fixed delay or timeout increase
is used. Two animation frames give the waiting flow/render an opportunity to run;
they do not claim to directly observe private React hook state. Response logs
record route-decoded versions and `observedAt` before fulfillment; DOM handles
establish subsequent identity/connection. Diagnostics are collected before state
assertions and printed on both success and failure, without private text.

The initial three-case calibration also exercised ordinary Check again reading
real configuration 2 after conflict: it removed the old action and retained the
panel. That operator path is reachable, but changes relevant state. The redundant
third test was removed after calibration; its chronology remains in the delivery
logs. Setup, GitHub source settings and Sync & placement share ImportPanel; no
production change affects any entry point. No context-menu, extension or
notification route invokes this action.

## Bounded later-failure search

The read-only Actions query returned 56 runs created after #1388's commit time
through run 41358258980, eight with current conclusion `failure`. Their job
metadata showed successful operator lanes except two operator-1 failures.
The failed operator-1 logs identify unrelated Jira and WebKit Overview tests.
The corresponding operator-2 logs explicitly pass this Setup journey:

- [Job 124640319937](https://github.com/chrisbanes/cab/actions/runs/41236096127/job/124640319937): pass at 2026-10-31T19:57:21Z, 2926.040356ms.
- [Job 124836658791](https://github.com/chrisbanes/cab/actions/runs/41302599771/job/124836658791): pass at 2026-11-01T11:43:04Z, 3330.414077ms.

That latter run's full compatibility job exited 124 before reaching the affected
journey; it supplies no result for it. No recurrence was found in this bounded
search or the read issue evidence. This is not a claim that every earlier attempt
of rerun-successful jobs was inspected, nor a reliability measurement. Metadata
and relevant log excerpts are retained with the delivery record.

## Validation and remaining gates

The original diagnostic candidate `5c4644e7c0b1d06e978140140815a369c2408e0b`
is preserved as an ancestor. The current changes repair forward, retain two
purposeful cases instead of three, and add no production code. `npm ci` and browser
installation remain valid with unchanged pinned dependencies. Initial targeted
calibration passed all three selected cases (historical, guarded and original),
with zero skips. The guard-removal negative control failed as expected.

The restored candidate passed typecheck, lint and format check. The planned
six-file `CAB_TEST_BROWSER_ENGINE=all node --test` selection passed 213 tests,
with zero failures or skips in 107.496 seconds. This covers Setup, source import,
project configuration, resource polling, settings state and private values.
The final gate-cleanup registration restores the already-qualified cleanup from
the initial candidate; targeted cases and static checks were renewed afterwards.
The single delivery record in `.scratch/1405/delivery.md` records the final
candidate, exact commands, static/build results and qualification logs. It also retains initial diagnostic build/teardown errors and sandbox
localhost `listen EPERM`; those instrumentation/environment failures are distinct
from the demonstrated race. The initial candidate passed 214 focused tests;
changed test inputs require renewed qualification and are not credited from that
older result.

No supported local Linux execution tool was found (`docker`, `podman`, `colima`,
`orb`, `limactl`, `nerdctl`). T3 remains outstanding: the controller must run three
consecutive complete Linux operator Chromium owning-shard passes, retaining all
attempts with separate temporary/evidence roots and unchanged concurrency/timeouts.
Current runner selection still places the affected file in shard 2/2 (66 files).
Use `npm run test:built -- --suite=operator --profile=chromium --shard=2/2`
after one pinned-toolchain build, with a unique `CAB_TEST_EVIDENCE_DIR` and TMPDIR
per attempt. Each pass must include the historical, guarded and original cases
without skips. Independent review and the final-head required GitHub `check`
remain controller-owned. No remote mutation or push was performed. This record
does not satisfy #1404's two-week operational measurement.
