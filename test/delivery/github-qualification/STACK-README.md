# Finite stack journeys

The v1 provider guard and injected composition remain in `stack-guard.ts` and
`stack-journey.ts`. Version 2 adds a concrete in-process `OperatorApi` /
`StandaloneService` / `CodexRuntime` adapter. It uses the real GitHub provider and
Git rebase-proof code. `live-stack.mjs` selects the version from the bounded
manifest input. Importing it or invoking it without the complete explicit
arguments performs no provider, credential, service or runtime operation.

The v2 source is under offline qualification. It is not live acceptance evidence.
No checked-in example supplies usable fixture authority. Local qualification
leases do not authorize credentials, GitHub requests, native processes or fixtures.
Actual T6 runs require independently supplied manifest, readiness and grant files.

## Inputs and default refusal

An invocation requires `--live --manifest ABS --grant ABS --readiness ABS --result ABS`.
Paths must be absolute and distinct, including checkpoint lock/temp paths. Inputs
are bounded regular files. Every schema is strict. Missing scope, unsupported
credential references or a mismatched digest refuses before credential resolution
or service construction. V1 has no default real adapter and retains its previous
refusal and offline injection behavior.

`stack-builders.ts` exposes machine-readable JSON Schemas and
`prepareStackV2Manifest`. The builder computes capture bindings; it does not issue
a grant, supply identities, choose budgets or discover a credential. Generated
JSON Schemas describe input shapes; runtime validation additionally checks path,
digest, relational, ownership and expiry constraints. Root must
independently review and supply grant issue/expiry/teardown times and the exact
manifest/readiness/authority/resource digests.

Root must capture these actual inputs for each independent pair:

- Exact actor/node, repository/node/visibility/default branch/merge capabilities,
  two task/assignment bindings, PR nodes/numbers/refs/heads, base SHA and ordered
  stack identity. No new resource is discovered into authority.
- Canonical disposable run root, prepared marked data directory, both task roots,
  repository worktrees, common object store, scratch parent and checkpoint path;
  filesystem device/inode identities and explicit necessary write paths.
- Source root/branch/commit/tree, HEAD/ref metadata and exact loaded module hashes,
  pinned Git/Node/Codex executable hashes, `.nvmrc`, package/lock hashes, versions,
  and the required package manager. Source HEAD/tree are checked with pinned
  offline Git before service construction.
- Checkpointed SQLite bytes, migration level 14 and schema fingerprint, exact
  project/task/lead/assignment configuration and immutable profile settings.
  `capturePreparedStackDatabase` computes the same readonly material. Unrelated
  projects, sources, workspaces, pending delivery/publication work or ownership
  holds refuse. Only the selected original Unstack journal may already exist.
- Fresh host-specific readiness and exact model/effort/settings/policy/revision
  bounds. The preprepared Codex home/login link and auth target metadata must
  match the accepted runtime credential reference. Preflight never opens its
  contents. The login target's necessary runtime write scope must be explicit.
- Exact `env:NAME` GitHub reference, literal per-request bodies/API versions,
  independently enumerated request/call rules and caps, root-supplied Unstack
  command, bounded observation timing, and separate main/teardown deadlines.

## Effect boundaries

`stack-authority.ts` reserves requests before credential callbacks and dispatch,
counts reservations and actual resolver/transport/runtime/service/callback
invocations separately, and persists intent before
effects. Already-queued completion evidence finishes before the serialized close;
no later effect is released. Token caching never bypasses validity. Source/binary/input pins are
checked before effects, using a bounded initial hash and metadata revalidation.
Changed pins hold the run; they do not grant a retry or replacement identity.
The original teardown horizon permits only owned stop/interrupt calls after a
main authority fault. It continues to verify canonical ownership. Failed runtime
identity capture does not revoke cleanup through that runtime's exact owned child
handle; cleanup remains journaled and cannot establish process exit without the
normal exact identity and termination proof. Abort is bound before adapter
construction, so preaborted journeys invoke no factory and in-flight bootstrap
abort holds authority before any later credential, provider or service effect.

Only exact `https://api.github.com` requests are permitted. REST reads and the two
literal read-only GraphQL documents have explicit per-rule versions. Captured PR
reads use 2026-03-10; repository, refs, checks, protection, GraphQL, merge polls and
feedback use 2022-11-28. Feedback consists of three independently listed GETs per
captured PR: issue comments, reviews and review comments, each with exactly
`?per_page=100`. Extra identities/query keys/pages/body/version, redirects, oversized
responses and next-page links refuse. Feedback remains data; evidence contains
hashes and counters, never raw feedback text.

Only one lower async merge is owned by the fixture script. It preserves actual
provider merge gates and stack qualification. The selected explicit 2026 merge
rule includes `merge_action:direct_merge` and `bypass_rules:false`; ordinary
production behavior retains its 2022 default. One actual 202/409 UUID is captured
with producing request/response hashes and time before exact polling. A durable
original-operation marker prevents another result filename from resending an
unknown merge. The service cannot also send that merge.

Fresh upper/base SHAs require agreement among actual REST, GraphQL and ref reads,
with at most one fresh value each. Stack base, ordered members, refs and heads
must remain in the captured tuple; any pagination Link header refuses. HTTP read permission is not adoption permission:
T1 raw commit-message/ordered-patch proof and T2's current transaction still decide
adoption. Direct Git proof/adoption has a separate precredential scope for the
exact repository, executable, worktree/common store, scratch parent, commits,
bytes/time/fetch/child counts. The Git call grant hashes the captured repository ID,
repository URL, workspace path, common directory, branch and initial commit list;
the exact response-derived request has its own durable intent digest before
credentials or fetch. Unknown children retain their scratch and ownership.

The runtime boundary applies to every scheduler turn and continuation. It checks
one current submitting work/request, assignment/task revisions, cwd, prompt digest,
settings and effective policy before reservation and after awaits, then binds the returned
thread/turn/process. The actual assembled prompt and original request have separate
digests; the service's omitted policy means network off. Early callbacks wait for
the exact returned turn to be persisted and handed back to the service. Optional
native archival/input-reply capabilities are absent; captured existing threads
must be unarchived. Only bound prepared PR registration and bounded result
callbacks reach cab. Resume grants hash the captured runtime scope and tools digest, while the actual
same-run-created or captured thread is checked and journaled separately before
resume. Future thread IDs need not be guessed in a grant. Historical thread
resume/read is not current execution proof.
This is a fixture authority boundary, not an independent model-tool or host sandbox;
normal deployment/runtime trust limits still apply.

## Scenarios and recovery

`stack-real-journey.ts` drives separate `merge-adoption`, `unstack-healthy` and
`unstack-failed` prepared pairs. It never reuses an adopted edge for Unstack.
Merge/adoption compares retained HEAD/index/file digests and checks the stored raw
proof, accepted base/head and branch metadata. An absent platform rebase remains
unproved. Equivalent publication, pushes, fixture creation and provider cleanup
are unsupported and denied; there is no fallback.

Unstack uses the actual preview, exact supplied command, separately budgeted
original-key reconciliation and typed original receipt lookup. An existing journal
is never executed again. Partial selected-member removal with a remaining sibling
stays unfinished across service restarts. No rekey, queue cancellation, forced
phase, early retarget or edge recreation is performed. `stack-audit.ts` reads a
consistent SQLite snapshot and requires the original journal, exact selected
edge generation, accepted base, one restack sequence increment and one exact
`unstack-restack:<originalKey>` notice joined to its actual inbox event and
captured recipient. Receipt phase alone cannot prove completion. The original typed receipt must
match the supplied key/task and confirmed phase. Retained workspace hashes and
writer/unfinished-execution audits also fence the final result.

All journeys stop only their owned service/process under the original teardown
scope. Exact process-exit verification, ended callbacks and no unknown Git child
are required. Checkpoints and exclusive locks remain for original-identity recovery;
never delete a lock or choose a new key merely to retry. An injected factory or transport is
always labelled `offline-injected`; it cannot supply live acceptance evidence.
