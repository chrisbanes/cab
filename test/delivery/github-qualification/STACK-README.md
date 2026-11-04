# Stack journey source composition

**SOURCE ONLY / UNQUALIFIED / NOT GRANTABLE AS A LIVE RUN.**

`stack-guard.ts` is the previously qualified finite provider guard/runner. Its
bytes and old journeys are unchanged. `stack-journey.ts` adds an independently
runnable, dependency-injected offline composition; `live-stack.mjs` parses the
entrypoint. There is no default real host/service/runtime adapter. Neither this
README, the source, test fixtures, readiness format nor a historical grant
confers authority. No current fixture manifest, live operation grant or accepted
host/credential readiness receipt exists for this journey.

Importing the entrypoint does no work. A default invocation refuses before
input reads. An explicit invocation requires distinct absolute `--manifest`,
`--grant`, `--readiness` and `--result` paths plus `--live`. Input files are
bounded regular files. All authority checks precede port binding, credential
lookup, network, runtime or checkpoint effects. Even well-formed inputs refuse
real execution because the real adapter contract below is unresolved. Tests
inject synthetic ports; their result is always `mode: offline-injected`, never
live acceptance. Do not execute the entrypoint to inspect credential availability.

The proposed readiness/journey receipt is separate from the existing provider
manifest and grant. Its exact bytes must match `resource.materialSha256` in
both independently supplied documents. Its observed resource omits only that
self-referential digest; account/node/repository/visibility/base/refs/PRs/full
ordered membership must match. It also pins run, host/runtime descriptor,
credential reference, fresh observation/expiry, scenario, exact original
Unstack command or merge operation, optional fixture-equivalent operation,
cleanup ids and elapsed budget. This is a proposed composition format requiring
root review, not a claim that a host or credential has been accepted.

The orchestrator supports two separate prepared-resource scenarios:

- `merge-adoption`: two bounded runtime intents, exact lower async merge with
  `bypass_rules:false`, identity-bound PR readback, actual
  `StandaloneService.refreshGitHub`, then the service's verified-object proof
  and accepted base/head plus unchanged workspace HEAD/index/file digests.
  It records the observed async request id, rather than inventing one. If that
  response is lost, PR readback may prove a merge but cannot invent the missing
  async observation, so the journey stays held. If no platform head rebase is
  observed, it reports that fact. Only a separately listed and pinned exact
  non-force fixture ref update can exercise equivalent adoption; replay never
  relabels it as platform behavior. Without such authority, adoption stays
  unproved and no equivalent update is attempted.
- `unstack`: the existing filtered `OperatorApi.readUnstack`, exact frozen
  `task.unstack` command, and typed original operation lookup. Explicit
  `StandaloneService.reconcileTaskUnstack` is a separate coordinator continuation;
  it is not the pure status GET. Any partial HTTP200 with a captured unmerged
  member remaining stays original/readback-only. No repeated command, new key,
  Unstack send, queue cancellation, retarget, retirement or restack follows
  while unproved. A later confirmed full removal plus exact retarget must also
  show only the selected edge retired and exactly one matching restack, with
  the workspace image preserved. The real T3 coordinator owns these checks.

Every composed intent/send/readback and runtime reservation is durably recorded
before its callback, using an exclusive lock, atomic rename and file/directory
sync. The original baseline, deadline, identities and counters survive restart.
Each awaited port continuation is bounded by the remaining deadline and a 20-second
ceiling; a timeout retains its original unknown intent rather than repeating it.
Provider JSON is bounded to 64 KiB and checkpoints to 1 MiB.
The qualified provider runner independently checkpoints exact method/path/body
before credential access. No response body, commit text, prompt, credential or
arbitrary error text enters the composition result; private object evidence is
IDs/digests only. Unknown effects are never resent. Malformed/count/material
mismatches, stale locks, storage faults, expiry and exhausted budgets refuse;
no automatic lock removal, expiry extension or counter reset exists. All late
callbacks refuse after the composition closes. Cleanup is limited to explicit
captured-ref DELETE/readback operations and only follows a proved scenario;
unknown effects do not trigger opportunistic cleanup.

## Concrete real-adapter blockers

The real entrypoint deliberately refuses instead of guessing these contracts:

1. `StackFixtureGuard` permits only `/repos/<exact repository>/...` requests;
   it has no standalone observational GET authority, including `/user` for
   credential/account binding, `POST /graphql` for the exact `CabDeliveryPr`
   document/variables and fresh `baseRefOid`, or the repository/PR/stack reads performed before
   the real delivery provider sends. A provider grant is not service/bootstrap
   permission. Approve an additive exact read/bootstrap contract and a reviewed
   adapter that passes every provider request through it, without changing old
   guard behavior. `GitHubHttpDeliveryProvider.mergeOutcome` may also poll a
   newly observed merge-request UUID: that needs a bounded capture/read rule,
   not a guessed static id or an extra unlisted URL. Do not manufacture request
   ids or broaden an existing grant.
2. There is no installed-service construction/provisioning/cleanup authority.
   The adapter must bind only a captured disposable project/workspace/service,
   apply the durable turn gate to **every** actual Codex turn, bind task/work/
   thread/turn and process exit identity, and prove quiescence. The typed ports
   consume actual T1–T5 API method names; they do not create a new production
   endpoint or supply a stub lifecycle policy. Workspace-image and restack-count
   observers must read the captured fixture ownership, not infer success from
   a receipt. A reviewed concrete adapter/readiness contract is still required.
3. Actual `TaskUnstack.local` requires the selected PR's observed and accepted
   base to remain the selected lower branch. Completed merge/retarget/adoption
   moves that base to trunk, so the same edge cannot then exercise normal
   Unstack. Use **separate explicitly granted finite prepared task/PR pairs**
   for merge/adoption and healthy/failed Unstack scenarios. Do not recreate a
   retired edge, reset accepted metadata or expand the two-task resource set
   implicitly. Root should approve that fixture split before any live grant.

No fixture creation is implemented or implied. Pre-existing exact refs/PRs must
come from the future accepted manifest/readiness. Dynamic resource allocation,
installation, credential discovery and broad disposal are unsupported. The
historical public S07a fixture and its spent grants are not reused.

After root supplies a fresh exclusive local qualification lease, proposed
checks are pinned setup/static/format/build, the focused synthetic
`stack-entrypoint.test.ts` cases and unchanged `stack-live-harness.test.ts`,
then the complete delivery SERVICE suite. No executable checks have run on
this source composition. Parent integration, full coherent offline/browser
qualification, integrated independent review, final-head CI and separately
authorized complete T6 live acceptance remain required. Neither a partial
Unstack nor an offline injected result satisfies that live gate.
