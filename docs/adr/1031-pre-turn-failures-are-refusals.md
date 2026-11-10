---
status: accepted
---

# Pre-turn failures are refusals

cab held every submission failure as "Runtime submission or observation uncertain", keeping
writer ownership and capacity until an operator supplied recovery evidence. When the failure
came before any turn was sent, that hold could be impossible to release. A cab schema defect
rejected the runtime's valid `thread/resume` response (#1620). The only applicable path matched
the exact archived-resume error message, and the witness, bound-identity and Start again routes
all refused. The tasks stayed stuck and the holds consumed the project's capacity.

## Decision

A submission that fails before cab calls `runtime.startTurn` is recorded as a request refused
before it ran. The boundary is the `startTurn` call itself, so failures while starting, resuming,
unarchiving or binding the thread, or while preparing the prompt, diagnostics or turn policy, all
qualify on both harnesses.

- **Proof.** cab is the only sender of a turn. Its own synchronous record that it did not call
  `startTurn`, in the process that caught the failure, proves that nothing ran. No runtime
  evidence is needed.
- **Accepted idle thread.** A thread may exist (created, resumed or unarchived) and stay idle and
  unobserved. The refusal keeps the thread it bound as evidence; Start again resumes the last
  completed conversation or starts a new one.
- **No termination proof.** Writer ownership and capacity release immediately, without an
  exact-process termination check and without restarting the shared App Server. Nothing ran, so
  nothing can still be writing.
- **Outcome.** The refusal records the stage (`thread`, `resume` or `bound`) and a failure
  class: cab rejected the runtime's response, the runtime rejected the request, or the outcome is
  unknown. Only the first tells the operator that a fixed build is expected to help. The task
  offers Start again with no operator evidence; cab never retries automatically.
- **Independent holds win.** A Stop, a task hold, an unfinished callback, a known survivor or
  another pending effect keeps the execution held. A failure after `startTurn` was called keeps
  the uncertain hold and its recovery unchanged.
- **Old holds.** Holds recorded earlier have no persisted stage, so this rule cannot recognise
  them. The operator-only historical no-turn adoption accepts a resume of a known completed
  predecessor. Its evidence is the reviewed source at that build showing that the failure
  happened before `startTurn`. Adoption produces the same refusal, so Start again becomes
  available. Existing pre-turn witnesses and receipts keep recovering through their routes. New
  archived-resume rejections no longer capture a witness: they are ordinary refusals.

## Considered options

- **Keep the holds and add a message-matched recovery path.** Rejected. It keeps capacity
  consumed until an operator acts, and it repeats the fault that left these holds stranded: a
  proof keyed to an exact error string fails for every error it did not anticipate.
- **A migration that recognises persisted reason strings.** Rejected. A reason string is
  diagnostic text, not proof that `startTurn` was not called. Old holds need the operator's
  reviewed evidence.

## Consequences

Start again's witness-only proof accepts two origins: a revision refusal at admission, and a
pre-turn refusal that may keep an idle thread and its turn-less recovery identity. An idle,
unobserved thread can be left behind after a pre-turn failure. The recovery read reports a path
as eligible only when the checks its command runs can pass, and names the failing check
otherwise.
