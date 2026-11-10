---
status: accepted
---

# cab proves, the operator confirms

Recovery asked the operator to vouch for facts cab already holds. A bound-turn, pre-turn or
no-turn recovery needs a receipt restating that the process exited, effects settled and the
workspace was preserved, and cab then verifies the same facts itself. The retired adoption
commands asked for review and approval references, five hashes and an "independently reviewed"
attestation. Continuing after recovery took three operator steps: the receipt, an explicit
conversation replacement and a new message. Some holds had no way out at all: a request held as
obsolete after its task revision moved on (#1632) offered neither Start again nor release.

On the development installation, all six bound-turn recoveries recorded the runtime process as
absent on the same boot, which cab had already observed; the receipts added nothing.
[ADR-1031](1031-pre-turn-failures-are-refusals.md) applied this rule to pre-turn failures. This
decision applies it to the remaining recovery, stale-request and external-action paths.

## Decision

cab establishes machine facts from its own records and the runtime: process exit, whether
`startTurn` was called, the invocation ledger, git identity. It never asks the operator to
attest to a fact it records or can observe. The operator gives at most one confirmation, and
only for a judgement, such as whether the work is still wanted.

- **Ending a held turn.** For a generation with a saved thread or turn, cab interrupts exactly
  that turn (`turn/interrupt` on Codex, `interruptTurn` on Claude). It releases writer ownership
  and capacity when the runtime reports the turn ended, when cab verifies the exact runtime
  process exited (process ID, start time and boot ID), or after 30 minutes with no runtime event
  or callback for that turn. cab never kills a shared Codex App Server to end one turn. Claude
  records no process identity, so a Claude turn releases on a reported end or the quiet period.
- **Late activity.** A runtime event or callback that arrives after release records an
  uncertainty hold and retracts admitted successors, as late callbacks do today.
- **Continuing.** Once released, the task offers Start again after one confirmation. It resumes
  the last completed conversation or starts a new one. No receipt, separate conversation
  replacement or new operator message is required.
- **Independent holds win.** A Stop, a task hold or a pending external effect keeps the execution
  held, as in ADR-1031.
- **Stale requests.** A request that has not sent a turn and whose captured task, assignment or
  profile revisions no longer match is refused, not held, and the task offers Start again.
  Pause, unreadiness and blockers remain waits that clear on their own.
- **External actions.** The allow-by-default kinds are `branch.push`; `pr.create`, `pr.edit`
  and `pr.ready`; `pr.thread.reply` and `pr.thread.resolve`; and `issue.comment`,
  `issue.labels`, `project.item.add` and `project.field`. New grants for them default to
  `allow`, and a migration switches existing `approval` grants of these kinds to `allow`. It
  creates no grant, so no project gains an action it could not take before. The operator can
  set any grant back to `approval` in project settings. `pr.merge`, `issue.close`, `issue.edit`,
  `issue.create`, `branch.force-push` and `branch.adopt` keep approval bound to the exact
  material, and the approval review shows that material readably.
- **Entry points.** `cab recovery prepare|submit`, the recovery evidence-file schema and the
  recovery page's evidence forms are removed. `cab recovery restart` and a matching recovery-page
  action confirm once and offer Start again. `recovery get` and `release` remain, and recorded
  receipts of removed commands still read back unchanged.

## Considered options

- **Keep operator receipts.** Rejected. Each field restates a fact cab verifies, so the operator
  can only copy it or invent it.
- **Never release without verified process exit.** Rejected. A Claude turn has no process
  identity, and a Codex turn shares its App Server with other tasks, so this keeps capacity held
  indefinitely for an operator to clear with an attestation.
- **Kill the App Server to prove exit.** Rejected. It ends every task's turn, and tool processes
  can outlive it.
- **Approve an action kind instead of exact material.** Rejected. Actions that still need
  approval are the irreversible or outward-facing ones, where binding the exact material is the
  control.
- **Apply new defaults to new grants only.** Rejected by the operator: existing projects should
  get the simpler defaults too.

## Consequences

Two writers in one worktree become possible but bounded: a tool process that outlives the
interrupt and stays silent for 30 minutes can still write after release. Any later activity
re-holds the task and retracts successors, but cannot undo those writes. The approval migration
widens authority on existing projects for the allow-by-default kinds. `docs/SPEC.md` recovery,
hold and policy sections, `CONTEXT.md` and the CLI usage change with the implementation.
