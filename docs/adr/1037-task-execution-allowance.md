---
status: accepted
---

# Bound a task's new admissions with an optional execution allowance

Decision for [#1573](https://github.com/chrisbanes/cab/issues/1573).

cab limits how many turns run at once, not how many turns one task gets. A lead can
delegate, receive results, repair work and continue in a replacement conversation;
each admission can be valid while the task's total work keeps growing. The investigation
established no observed runaway incident and no suitable numeric threshold.

## Decision

Add an optional allowance on **net charged execution generations**, shared by the task's
lead and every cab delegate (including task draft turns). It is disabled by default and
has no universal numeric default; an operator who enables it selects an explicit
non-negative whole-number total per task, and zero holds all new task admissions.

- **Unit.** One unit per distinct admitted execution generation (`workId`). Creating an
  assignment, a callback, a queued request or a conversation replacement costs nothing.
  Task identity survives assignment versions, conversation replacement and native
  session changes. Direct work without a task and project-level drafting runs are
  excluded and are disclosed as such.
- **Admission.** The check and a provisional charge are made in the existing atomic
  `ExecutionState.begin` transaction, with the writer and capacity reservations. Admission
  requires charged count `U` below total `L`. A rolled-back admission charges nothing.
  Preflight waits and refusals before `begin` charge nothing.
- **Correction.** When cab proves `startTurn` was never called, the existing
  `refuseBeforeTurn` safety path cancels that provisional charge, once, and records both
  the admission and the correction. A lost response, absent turn ID, timeout, ordinary
  failure, interrupted or quiet-released turn, storage failure or operator assertion
  never refunds a charge. A crash before the proof keeps it charged.
- **Retries, restarts and replacement.** A fresh admitted cab retry, planned-shutdown
  requeue, follow-up or Start again each charge one unit. Reset task and conversation
  replacement keep the total and consumption. The allowance is independent of the
  transient-retry allowance; both apply.
- **Exhaustion.** At `U = L` new admissions are held with a visible reason. Already
  admitted work finishes under today's execution and recovery rules; results, questions
  and effect reconciliation stay receivable, and any new execution they queue waits.
  There is no free wrap-up turn, no automatic Stop and no completion claim. Exhaustion
  does not release or refund anything, and does not alter ADR-1032 held-turn release.
- **Operator control.** The Execution and attention surfaces, with a CLI/API projection,
  show the state, charged and remaining units, provisional charges, excluded work, work
  held by the allowance and independent Stop or ownership reasons. One attention
  condition exists for an exhausted task that still needs another admission. The one
  operator action sets a new absolute total through the existing keyed, version-fenced
  receipt pattern. Raising it lifts only the allowance gate, so the same queued request
  becomes eligible under every other check; no follow-up is created. Agents cannot extend
  their own task's allowance. Lowering to or below `U` holds further admissions without
  revoking admitted work. Removing the allowance is an explicit operator decision.
  Admission records are kept while enforcement is off, so toggling cannot reset the
  count; activation is refused when history cannot be proved, and an enabled task whose
  accounting is missing or inconsistent holds affected admissions visibly. The total is
  configured per task; enabling it after admissions requires provable history.
  Configure and admit serialize.

## Non-guarantees

The allowance gates new admissions against net charged generations. It does not cap raw
admission attempts, because repeated proved pre-turn refusals return consumption to zero.
It does not bound a turn's duration, runtime agentic steps, native subagents, tool work,
tokens or cost. It is not a deadline, a spend cap, a host-wide limit or bounded unattended
execution, and documentation must not describe it as one.

## Left to the operator or implementation

The total for any task, whether to enable the allowance at all, and the exact surface
wording. Usage or token reporting is separate from admission enforcement and is not part
of this decision; any such reporting must label missing or conflicting reports as
unknown, not zero.

## Alternatives not chosen

- **Observe-first usage reporting.** Bounds nothing; a reasonable later study to choose
  defaults.
- **Elapsed-time deadline with automatic Stop.** Wall time includes CI, capacity, human
  input and downtime, and neither a deadline nor an interrupt proves termination. It
  would need its own accepted policy and runtime qualification.
- **Token or estimated-dollar allowance.** Provider reports are delayed, cumulative,
  missing and scope-limited, so they cannot give a common strict spend cap.
- **Charge every admitted attempt, even proved never-submitted ones.** Simpler, but
  consumes allowance for non-execution.

## Consequences

Admission-only enforcement needs no change to the ADR-1001 silence policy or ADR-1032.
A task can be left unfinished just before final handback; that is the intended operator
intervention point. Clean planned-shutdown requeues cost a unit, a conservative product
choice. Implementation needs fixtures for the atomic last-unit race, once-only correction,
restart, and configure-versus-admit races.
