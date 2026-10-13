# GitHub source credentials — 2026-10-13

Live qualification is pending. This record describes offline implementation and
validation; it does not demonstrate that a launchd service can read the selected
real source credential, preview the real Project selection or import its issue.

## Candidate and surfaces

The implementation adds explicit project-source `gh:github.com` alongside
`env:NAME`. Installation discovery is independent; routing and delivery remain
environment-reference only. Each public selection, native blocker and retained
issue-status read resolves the selected credential freshly. Successfully resolved
gh values are retained only for process-lifetime exclusion/redaction, including
past rotations after Clear, and are never used as a read cache or persisted.
Individual values are bounded to 512 bytes; distinct rotations grow this set
until restart.

The production synchronizer, JSON previews, advanced HTML and operator CLI share
the source-explicit reader/status paths. React source settings expose safe
kind/account/usability, Change/Cancel/Clear, retained failed/unknown drafts and
exact-key reconciliation. Source, Sync & placement, project summary and phone
next-step links expose the same actionable recovery. Saved readbacks omit private
reference names and values. Desktop/phone screenshots were inspected for clipping.

Missing/unusable credentials invalidate affected project knowledge atomically
under captured configuration-version/reference fences. Existing observations lose
completeness without fabricated provider attempts or new inactive sync rows;
native rows, source definitions, history and independent holds remain. Delayed
failures cannot poison newer source evidence. Successful credential status alone
restores no provider knowledge. Exact recorded command replay precedes fresh
credential checks. Configuration/observation/advanced-HTML readbacks retry once
when version/reference/activation changes during a credential check.

Codex uses its existing spawn snapshot and needs service restart after credential
configuration changes. Both Claude credential branches and ordinary helpers use
source exclusions. Agents with host keychain access can invoke gh independently;
Ensemble does not provide a separate runtime/keychain sandbox.

## Offline evidence

The accepted later controlled source suites and qualification harness used
temporary real SQLite, explicit fake gh, guarded fake provider reads and runtimes
that reject model execution. They do not prove the initial fixture path was safe.

An initial CLI helper run reached host `gh auth status` because the fixture's
service path did not receive the API's deliberate missing-gh executable. Token or
provider invocation and counts are unproved; no token output was observed. The
original log was overwritten, leaving an evidence gap. The repaired fixture now
defaults the service to a deliberate absent executable and wires advanced HTML to
the service reader/status seams. Later explicit-fake tests prove those controlled
paths. Host keychain access cannot be claimed untouched. No LaunchAgent or
production/Haze installation was exercised by the offline qualification harness.

| Evidence | Result |
| --- | --- |
| T3 service/privacy/fence integration | 29/29 |
| Source/discovery gh resolver/helper/readers | 31/31 |
| React settings/source/layout browser suites | 24/24 before added missing-executable case |
| State/presentation and source safe-copy parity | 21/21 |
| Missing source executable and credential-only Cancel browser/state | 14/14 |
| Accepted CLI + React integrated affected suites | 42/42 |
| Production SQLite qualification harness | 10/10 including owned log inspection |

The qualification harness independently proves complete preview activation and
subsequent import of the selected external identity, label readiness and source
membership. A simulated lost preview reply reuses the exact original command.
Clear retains imported history and makes native/local blocker knowledge unknown;
changing to env requires the new source version/preview before fresh recovery.
Persistence is checked across service restart. Missing, not-signed-in, unreadable
and ten-second hanging gh refusals make no provider reads or activation; absent
source references have no discovery fallback or invented sync row. Invalid gh
hosts are rejected without replacing the saved reference. Public projections and
summaries omit credential and issue-body canaries.

Preparation tests create private auth/plist/manifest artifacts without launching.
They inject plist lint to validate the exact path handed to the native linter;
actual `plutil` lint runs only on the lead-supplied preparation. Mismatched consumed
records, a rejecting bootstrap callback, artifact changes and a reused preparation
cannot bootstrap. Filter metadata rejects broad, truncated or mismatched issue
selections. Monotonic deadline tests reserve cleanup time and preserve state when
process ownership or shutdown is unknown. Owned terminal log tests prove safe
inspection before deletion; standard GitHub token patterns and fixed canaries
cause a controlled retained-fixture result without extracting any matched bytes.
Original protected logs stay in that private fixture for recovery and never enter
public evidence. These are offline guard proofs, not live process-containment
evidence.

The first full host `npm run check` completed with 1,839 passes, eight failures
and one skip. Repairs preserve missing-project 404 mapping before the source fence,
move shared safe guidance to a pure operator module, contain source helper options
factory failures without host-gh fallback, and update stale fixture/control
expectations. Renewed affected host tests pass 79/79 and offline
resolver/state/presentation/qualification tests pass 63/63. A passing full check
is still required at this draft.
Complete private command
logs remain in the delivery run directory, not in the repository. Initial loopback
sandbox failures required exact host retries. The retained
`944-integrated-surfaces-sandbox.log` contains successful host output despite its
filename; its original sandbox output was overwritten. The private delivery
record labels that evidence accurately and records the separate overwritten
initial helper log. Full-check attempt logs are preserved separately.

## Live boundary and remaining evidence

The harness prepare-only interface accepts root-supplied complete one-page Project
metadata and exact private root/label/Node/CLI/port paths. It performs no provider,
gh, model or launchctl call. The rendered plist, auth verifier and compiled tree
are digest-bound to the manifest. Passwords stay in protected private files and
never enter argv, plist, manifest or logs.

Prepared execution requires the lead's separate durable consumed record matching
manifest digest, candidate SHA, label, root/path and one-attempt limits. A callback
and exclusive private marker guard the first and only bootstrap. The harness
never edits or resets the lead's allowance. The outer monotonic limit is 300
seconds, startup/authentication 60 seconds, preview 60 seconds, optional same-key
unknown-reply reconciliation 30 seconds, refresh 90 seconds and cleanup reserve
30 seconds. Cleanup targets only the recorded GUI job; deleting its exact root
requires label absence, recorded owned PID exit and a closed loopback port.
Uncertainty retains private state and reports a hold.

The single live allowance remains unspent. Before execution, the lead must inspect
the final candidate, full checks and independent integrated review, then supply
fresh exact metadata and prepared paths, and record consumption immediately before
bootstrap. Completion requires separate real preview/activation/import evidence,
zero model turns/provider writes and proved cleanup. No live success is claimed.
