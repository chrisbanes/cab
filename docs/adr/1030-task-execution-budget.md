---
status: proposed
---

# Bound task work by cab-admitted turns

Proposal for [#1573](https://github.com/chrisbanes/cab/issues/1573).
This document requests a product decision. It changes no accepted contract and
authorises no implementation, configuration changes, billing or runtime runs.

## Recommendation

Offer an optional **task admission budget**: a positive integer maximum of
cab-admitted turns across the task's lead and every delegated assignment.
Default to unconfigured, with no numerical preset until there is task-consumption
evidence. Configure it per task through an explicit operator action; agents
cannot set, extend or remove it. Do not add project defaults in the first version.

At the limit, hold subsequent admissions and raise operator attention. Allow
already-admitted turns to finish under their existing permissions and lifecycle;
do not automatically Stop them. Count admissions even when they fail to launch.
This bounds repeated service-controlled work, including repairs and follow-ups,
without depending on runtime token reporting or cancellation.

The supported promise would be: **after a limit is enabled, cab never commits an
admission that would exceed that task's cumulative allowance**. An operator may
lower a limit below already-consumed work; this holds future admissions and does
not retroactively revoke any admission. Explicit extensions change the allowance.

This is useful for limiting repeated delegation/repair chains. It does **not**
bound unattended elapsed time, model calls, runtime-internal turns, tokens or
spend. One admitted turn can continue indefinitely. The issue establishes the
missing task-wide boundary, but supplies no measured incident distribution or
turn-count threshold. The choice of this narrower guarantee needs maintainer
approval before cab advertises it as a budget.

## Current controls and concrete gaps

The inspected source baseline is `ea3b0c2c79395255a0cae621b996f49db5832a76`.
The references below describe that baseline, rather than evidence that the
proposed behaviour already exists.

| Mechanism | Reusable control | Gap for this proposal |
| --- | --- | --- |
| [`SchedulerStore`](../../src/standalone/scheduler.ts), `turn_requests` | Durable request key, work identity, task/assignment binding, predecessor and FIFO sequence | Queuing is not admission. No cumulative task charge exists. |
| [`ExecutionState.begin`](../../src/standalone/state.ts), called by [`service.ts`](../../src/standalone/service.ts) | Transactional validation, transition to `submitting`, writer admission and capacity reservation before runtime dispatch | Add the task-wide check and unique charge in this transaction; every task-bound path must pass it. Do not enforce in agent instructions or only at delegation. |
| Capacity in `state.ts`; [SPEC execution/recovery](../SPEC.md#execution-and-recovery) | Global default 4, project default 2; reservations survive uncertain execution; lowering holds new work | Concurrency is reusable admission policy, not a lifetime counter. A yielded slot does not refund an admission. |
| Retry chains/attempts in `state.ts`; [`retry.test.ts`](../../test/coordination/retry.test.ts) | Persisted chain allowance, exact failed-generation evidence, backoff, effect/ownership checks, `budget-exhausted` disposition | Separate allowance: at most two combined cab/harness retries, only with supported and complete evidence. Claude automatic retry is disabled; Codex terminal classification supplies unknown harness retry count, preventing that retry path. A new chain can otherwise start fresh. |
| Stop, shutdown and bound-turn recovery in `service.ts`/`state.ts` | Durable Stop, best-effort interrupt, exact process/turn identity, callback/effect reconciliation | Stop does not prove termination or release ownership. It is unnecessary for an admission-only limit. Recovery must not refund its charge. |
| [`task-restart.ts`](../../src/standalone/task-restart.ts), follow-up in [`coordination.ts`](../../src/core/coordination.ts) | Explicit Start again, Reset task and newer assignment work revisions, with independent recovery gates | Work/conversation replacement is not a new task and must not reset consumption. |
| [`claude.ts`](../../src/standalone/claude.ts), [`codex.ts`](../../src/standalone/codex.ts), [`runtime-retention.ts`](../../src/standalone/runtime-retention.ts) | Attributable runtime identity and terminal failure facts | No retained task token/cost ledger. Claude result validation drops usage fields; Codex has no token-usage accounting path. |

`task_writer_admissions` is not a permanent accounting ledger: retry resolution
deletes predecessor rows. `execution_capacity_reservations` is released on normal
settlement. Neither can serve as the consumed total. Persist an independent,
append-only admission fact with unique work identity, task identity, captured
budget revision and admission order, atomically with admission. Exact schema and
command names remain implementation details, not a new framework.

Project drafting runs are a separate exception to the issue brief's broad
description of existing limits: `drafting.ts` and `service.ts` already apply a
10-minute drafting-run timer. They have no task binding and are outside this
proposal; that timer does not bound task execution. Task **draft turns** do have
a task binding and are included.

## Accounting rules

1. Charge one unit when a task-bound work generation commits admission into
   `submitting`, before releasing a prompt or dispatching runtime work. Waiting
   on capacity, readiness, CI, external feedback or operator input costs no unit.
   Pre-admission refusals and model-free capability probes cost none. Runtime
   tools and internal model iterations are not separate cab admissions.
2. Charge the lead, delegates, repair requests, result continuations, operator
   replies that cause another turn, explicit follow-ups, draft turns and
   replacement conversations to the same task. One admission is one unit on
   either harness, regardless of how much work its query/turn contains.
3. A newly admitted retry or planned-shutdown requeue costs another unit; neither
   bypasses the task limit nor changes its own retry-chain rules. Runtime-native
   retries inside one admitted execution are outside the turn count. Polling,
   duplicate notifications, receipt replay and reattaching to the same admitted
   generation do not charge again.
4. Commit check, charge, writer and capacity acquisition in one transaction. If
   any acquisition fails, roll back the charge. With one unit left, competing
   eligible admissions across assignments can commit only one charge, even if
   future workspace rules permit concurrency. No per-assignment allowances or
   reserved final lead turn: those would make the first budget harder to explain.
5. After admission commits, never refund, including known launch failure,
   ambiguous submission, failed terminal, operator Stop or manual recovery.
   Restart restores the existing total before scheduling. An unknown send is
   already charged and retains its existing ownership holds; it is not resent.
6. Reset task, conversation replacement, continuation and source resync preserve
   task identity and consumption. Workspace cleanup and conversation archival do
   not erase the ledger. A separately created task has its own allowance; this
   is not a project-wide or host-wide control.
7. Start collecting durable admission facts for all tasks when this feature is
   deployed, including those without a configured limit, so first-time enabling
   and disable/re-enable cannot replenish the allowance. Existing pre-feature
   history is not reliably reconstructible from mutable admission rows. Mark a
   one-time accounting start explicitly; charge every unresolved pre-feature
   admitted generation once before enabling scheduling, without claiming older
   settled work was counted. Display this coverage boundary permanently.

## Exhaustion, ownership and recovery

The last allowed admission may run normally. When consumed reaches the limit,
show “Admission budget exhausted; active work may continue” with the last charge
and any pending work. Hold subsequent task admissions, including callbacks that
queue a lead continuation. Keep their original request identities and instructions;
do not turn them into failed requests needing Start again. Raise one durable
attention item per exhaustion episode, without repeated alerts on scheduler polls.

Continue accepting valid results, questions, observations and external-effect
receipts from already-admitted turns under the existing rules. An admitted turn
can still delegate/queue work, but the queued work cannot run without allowance.
Keep result delivery durable even when its recipient cannot yet be admitted.
Permission revocations and existing effect, source, Stop and ownership holds still
apply. Exhaustion neither authorises a new external effect nor revokes authority
already granted to an active turn. It requests no interrupt, synthesises no
terminal status and clears no callback, writer, capacity or delivery hold.

Exhaustion alone never marks the task Done, Cancelled, successfully handed back
or safe for workspace release. If already-admitted work independently satisfies
normal completion and cleanup rules, those rules may finish it; consumption is
retained. Otherwise the task remains open with a budget reason. Do not reuse the
retry disposition `budget-exhausted` without identifying which allowance ran out.

Task detail and the operator CLI should show: configured limit or unconfigured,
consumed and remaining admissions, accounting start/coverage, budget revision,
admission breakdown by assignment/work, last exhaustion reason/time, queued work,
active or uncertain execution and independent holds. Link the attention item to
that view. Never display tokens or money as zero merely because unavailable.

An operator extension is an explicit, version-checked, idempotent **Extend and
resume admissions** action: choose a new total greater than consumed, inspect the
pending requests and acknowledge that existing queued work becomes eligible. The
receipt keeps actor, old/new limit, consumption and revision. Replayed or uncertain
commands reconcile the original receipt, never enqueue work again. It wakes the
existing queue once through normal scheduling, clears only the budget attention,
and leaves all other holds in force. Resuming Stop does not extend the budget.
An operator answer may be recorded while exhausted without starting a turn.

Changing a limit affects future admissions only. Lowering to or below consumed
exhausts it immediately; raising while not exhausted changes future allowance.
Raising an exhausted limit requires the explicit resume acknowledgement above.
Removing an exhausted limit likewise requires an explicit “remove limit and resume
admissions” acknowledgement. Removal preserves consumption and history, and
admissions continue to be counted. Enabling a limit on an active task includes
already-recorded charges; active work is never interrupted by that edit.

## Runtime measurement and guarantee boundary

Both harnesses support the same exact **cab admission count**. Neither needs usage
events to enforce it. The following native data is available in documented
interfaces, not currently retained as cab accounting or qualified by this proposal.

| Runtime | Observed protocol/SDK fields | Estimate or unavailable guarantee |
| --- | --- | --- |
| Codex App Server | [`thread/tokenUsage/updated`](https://developers.openai.com/codex/app-server) identifies thread usage. The [protocol schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadTokenUsageUpdatedNotification.json) includes `threadId`, `turnId`, `tokenUsage.total` and `.last`, with input, cached input, output, reasoning output and total token fields. | Reports are runtime observations, not a pre-authorised token allocation. cab does not retain them. No task USD charge or exact task spend cap is established. `sessionBudgetExceeded`/`usageLimitExceeded` are failure codes, currently unknown/non-retryable classifications, not a configured cab allowance. |
| Claude Code SDK | [`SDKResultMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage) exposes `num_turns`, `duration_ms`, `duration_api_ms`, `usage`, `modelUsage` and `total_cost_usd`. cab runs one `query()` per cab turn and resumes session identity; SDK turns are not cab admissions. | `maxTurns` and `maxBudgetUsd` exist but cab sets neither; limit error subtypes are permanent failures. SDK limits operate within a query, not across task assignments. `duration_api_ms` is not task active execution time. |

Claude's [cost-accounting guidance](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
describes `total_cost_usd` as a client price-table estimate, not billing. Resumed
results can include earlier session totals: blindly summing them duplicates usage.
`usage` excludes subagents; `modelUsage` and the cost estimate include them within
the reported boundary. Crash results can zero totals; per-step output can be a
placeholder. Missing results leave gaps. A later observation feature would need
session baselines, deduplication and explicit incomplete coverage; it must not
advertise a spend cap. Subscription consumption is not a USD invoice.

Native subagents do not consume separate cab admissions. Current Codex policy
disables subagents; Claude's `Agent` remains available, including disclosed
background Stop/resume limits. Trusted native hooks, skills and MCP servers can
do work or invoke other services outside cab tools. Their independent work and
billing are outside this measurable boundary, even when some native usage appears
in a parent result. No host-wide execution or billing cap is promised.
[ADR-1021](1021-profile-skill-plugins-and-subagents.md) and #1569 are the trust
boundary to recheck at implementation; do not require or assume universal extension
containment or infer final-head qualification from accepted native-loading policy.

## Alternatives and ADR compatibility

| Alternative | Why not first |
| --- | --- |
| Wall-clock deadline from first admission | Clear unit, but includes CI, capacity, operator waits and downtime. A gate-only deadline still leaves an admitted turn running. A timer plus best-effort Stop is a different useful guarantee (“request Stop by deadline while cab is available”), not proven termination; restart/clock changes need explicit semantics. Return this option for a separate product decision if elapsed duration is the actual requirement. |
| Active execution time | Sum of admitted intervals charges concurrent work multiple times; union measures elapsed active time. Both include blocked tools and uncertain ownership, and neither identifies model compute. More accounting and clock/restart policy without a stronger termination guarantee. |
| Token limit or exact spend cap | Delayed/missing observations, resume baselines, native work and subscription pricing prevent a reliable common hard cap. Claude SDK query limits are not interchangeable with a task-wide cap. |
| Observe usage and alert only | Useful later, but requires two accounting integrations and does not itself bound repeated admissions. Do not make telemetry a prerequisite for the service-owned counter. |
| Stop all active work at turn-count exhaustion | Interrupts the final authorised turn as soon as it starts, spends a unit without letting it finish, and inherits every Stop uncertainty. An operator can still choose Stop explicitly. |

This recommendation does not conflict with ADR-1001's silence policy: it does
not detect inactivity, terminate or restart on silence. Leave ADR-1001 and the
accepted SPEC unchanged pending decision. A future explicit deadline with Stop
would be distinct from silence detection, but should return a proposed ADR-1001/
SPEC clarification for maintainer review rather than silently overriding policy.

Non-goals: a scheduler replacement, configured development stages, automatic
increases, new model calls, usage collection, billing, descendant containment,
runtime configuration changes, #180 pipeline compatibility or a release/cutover
gate. #1146 qualification continues independently; #1566–#1568 and epic #649 keep
their existing scope.

## Focused validation after approval

Deterministic service checks should extend existing coordination scheduler/retry,
execution restart/recovery and operator command fixtures:

| Scenario | Required assertion |
| --- | --- |
| Delegation and capacity one | Lead, delegate and lead result continuation charge the same task; yielding capacity refunds nothing. Exhaustion retains the child's result and holds its recipient once. |
| Concurrent admission near limit | Barrier two otherwise-eligible requests with one unit remaining: one transaction charges/admit, the other holds. Other tasks remain eligible. Failed writer/capacity acquisition rolls back. |
| Failed start, unknown send and replay | Post-commit failure keeps the charge; repeated callbacks/receipts and recovery do not recharge. Ambiguous execution retains holds and cannot duplicate dispatch. |
| Retry and planned shutdown | Each fresh admitted generation charges once; queued backoff/requeue costs none. Existing retry allowance and uncertain-ownership rules still apply independently. |
| Restart and upgrade | Crash on each side of admission commit: all-or-nothing charge/ownership. Reload before scheduling; preserve exhausted state and attention without duplicates. Record each unresolved legacy generation once and disclose historical coverage. |
| Follow-up, reset and replacement | Same task total survives each action and archival. A queued/refused request costs none until admitted; draft turns count, project drafting runs do not. |
| Exhaustion with active work | Withhold terminal/callback/effect settlement and exhaust the allowance: no interrupt or release occurs. Results/answers persist, queued successors stay held and normal completion needs its own evidence. |
| Extension and changed limits | Version conflict refuses; matching replay returns the receipt. Raise/remove with explicit resume wakes existing eligible requests once. Lowering never interrupts; Stop/source/ownership holds remain; disable/re-enable retains consumption. |
| Operator surfaces | CLI and task detail agree on total, coverage and holds; attention links to the reason. Uncertain extension preserves the original command/key for reconciliation. |

The admission invariant is service-owned and needs no live model run to prove.
Only if a later implementation changes adapter dispatch or exposes native usage,
qualify that affected boundary separately with explicit authority and a finite
budget: at most one task per affected harness, no API/provider fallback, no reruns
without approval. For a changed dispatch boundary, allow at most two cab admissions
(lead plus one delegate), set the task allowance to two and use fake delivery:
retain the requested lead continuation, then verify that only an explicit extension
admits it. An extension journey would need a separately authorised third admission.
Record installed versions and all calls. No such run is authorised here, and no
live test can prove universal cancellation or billing containment.

## Maintainer decision and implementation boundary

The principal decision is whether the admission-only guarantee is useful enough
for the first version. Recommended: accept this narrow direction, opt-in with no
numerical preset, preserving active turns. Alternatives: observe-only first, or
return for an elapsed-deadline/Stop proposal. Do not describe any choice as an
accepted promise before review.

Also confirm the conservative no-refund rule, inclusion of draft turns and
planned-shutdown requeues, explicit queue-resume acknowledgement, and one-time
upgrade accounting boundary. These are reviewable parts of this recommendation,
not authority to implement them. A requested time bound or guaranteed termination
would materially change it.

After acceptance, refine #1573 or create its implementation follow-up with the
chosen guarantee and the validation rows above as acceptance criteria. Scope it
to the durable admission facts and atomic gate, task-level operator commands and
readback/attention, and lifecycle preservation. Update SPEC/glossary and mark this
ADR accepted only for the approved semantics. Reject implementation completion
unless all task-bound admissions use the gate, restart cannot replenish allowance,
extensions cannot duplicate execution and every surface states that active work
can continue. If the maintainer chooses another direction, replace this scope
before coding. This proposal creates no implementation framework or new gate.
