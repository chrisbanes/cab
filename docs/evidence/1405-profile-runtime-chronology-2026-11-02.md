# Profile default assertion after a delayed workspace read

Source: [#1405](https://github.com/chrisbanes/cab/issues/1405),
[PR #1440](https://github.com/chrisbanes/cab/pull/1440),
[failed operator shard](https://github.com/chrisbanes/cab/actions/runs/41360522886/job/125016330929).
Frozen failing candidate: `d2675bd8dae561fa6c553c39911d9adf05b75625`.
Integrated main: `d7d6e091190c4621bad3f106e78bdb18d9d761ed`, via merge
`4b0b47ffd74675da9e37b7c10fffa2756f6332a7`.
Local runtime: Darwin arm64, Node 26.13.0, npm 12.2.1, Playwright 1.64.1.

## Failure and causal discrimination

Linux qualification attempt 3 failed only `New profile starts on the first enabled
runtime: Claude when Codex is disabled`: actual `codex`, expected `claude`.
All three Setup cases passed. The aggregate check reflects this same failure.
Attempts 1 and 2 remain historical successful shard runs; the required consecutive
success count is zero. The retained failure artifact's manifest contains no DOM,
screenshot or diagnostic chronology, so it cannot identify the precise historical
ordering. Its startup and cleanup completed.

A test-local route holds the **real** workspace response after fetching and decoding
it. The payload reports Codex disabled and Claude enabled. While it is held, the
visible Runtime selector reads `codex`. The conditional Model field is already
rendered: `RuntimeFields` renders it only after the draft has a Codex or Claude
harness, so the draft initialization effect has already run. This discriminates a
late workspace read from merely observing the native select before initialization.
Releasing the response changes the same Runtime DOM node to `claude`.

The original visibility wait and immediate assertion fail deterministically under
this ordering, with the same `codex !== claude` fingerprint. The retained log records:

1. Workspace snapshot: Codex `enabled=false`, Claude `enabled=true`.
2. Old assertion boundary: Runtime `codex`, one initialized Model field, Runtime not focused.
3. After release: Runtime `claude`, original Runtime node still connected.

This proves a sufficient causal schedule for the reported failure, not the exact
unrecorded historical event. Source inspection explains it: `defaultHarness(null)`
returns Codex; `ProfileCreate` initializes a clean draft again when the workspace's
default changes to Claude. No unchanged-state remount or choice-overwrite defect
was demonstrated. Production files were read only and remain unchanged by this
repair.

## Repair and retained counter-orders

The failing test now waits for the actual Runtime value `claude`, within the existing
default timeout, before reading it. A file-local helper expresses that one condition;
it does not change shared fixture policy or introduce a general retry framework.
The fixture setup is reused unchanged through a file-local helper.

Four controlled cases retain the real response gate and sanitized chronology:

| Schedule | Before workspace application | After application |
| --- | --- | --- |
| Late read, clean draft | Initialized Codex | Same selector becomes Claude |
| Late read, dirty name | Initialized Codex, operator edits name | Codex and edited name retained; disabled-Codex warning confirms payload application |
| Late read, explicit runtime/model | Operator selects Claude and enters model | Claude and exact model retained |
| Workspace first | Release read on Settings; wait for Connected; navigate to Create profile | Initialized Claude; no late default transition |

Connected alone is not the repaired assertion: the tests additionally wait for the
runtime draft value and the selected runtime's policy or disabled warning. The
workspace-first case navigates within the existing document, so its read is applied
before the profile form mounts. Late-read cases verify the original selector remains
connected. No private text is logged; only runtime enablement, observedAt, runtime
values, field-presence, focus and node connection appear in diagnostics. No arbitrary
sleep, forced click, reduced concurrency or timeout change is used.

These checks protect dirty input and an explicit runtime/model choice against the
same late read. They passed without production edits. The original Setup test and
all shared Settings/private-resource/API lifetimes remain unchanged. Profile
creation is exercised through its direct route and Settings' Create profile link.
Guided Setup shares some profile values code, but no shared behavior changed; the
complete Setup browser file is included in local qualification.

## Evidence and remaining qualification

The single `.scratch/1405/delivery.md` record retains the exact commands, results,
head identities, fixture cleanup and failed attempts. Relevant logs are under
`.scratch/1405/profile-repair/`:

- `late-workspace-red.log`: original visibility assertion fails with held response;
  release then confirms Claude on the same node; cleanup completes.
- `controlled-green.log`: repaired original case plus all four controlled cases pass,
  zero skips.
- `focused.log`: complete affected profile and preserved Setup browser files:
  81 passes, zero failures/cancellations/skips, 70536.004958ms; fixture cleanup completed.
- Full build, service build, typecheck, lint, format and diff checks passed;
  their logs retain the command results.

The existing 213-test Setup/import/privacy qualification remains attributed to its
original candidate. This repair renews the affected profile file and Setup coverage;
it does not claim new results for unrelated files or run the local full check.
The exact main integration imports only the already-delivered Jira changes; no
unpublished #1418 or #1416 branch is included.

Root owns independent review, publication and GitHub execution. Three consecutive
complete Linux operator Chromium owning-shard 2/2 passes at ordinary runner workload
must restart after repair, with separate temporary/evidence roots and all failures
retained. The required final-head aggregate check must also pass. Local Mac results
are not Linux load qualification. No push, rerun, PR operation or remote mutation
was performed by this implementation owner.
