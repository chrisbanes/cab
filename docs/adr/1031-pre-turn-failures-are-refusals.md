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
- **Old holds.** Holds recorded earlier have no persisted stage, but cab has another record of
  its own. It saves the thread binding before it calls `startTurn`, and a failed save stops the
  submission before `startTurn`. Neither harness sends input before `startTurn`. So a held
  generation whose saved thread and turn are both null never sent a turn, on any build. cab
  releases such a generation, whatever its hold reason, when nothing else holds it: no pre-turn
  or no-turn witness, Stop, task hold, unfinished callback, known survivor or other pending
  effect. The release records the same refusal, with its own reason, so Start again becomes
  available. It runs at startup for every eligible generation and through
  `cab recovery release` (or the recovery page's Release action) after one confirmation, with
  no operator evidence. A generation with a saved thread or turn keeps its hold and its
  recovery. Existing pre-turn and no-turn witnesses and receipts keep recovering through their
  routes, and receipts of the retired adoption commands still read back. New archived-resume
  rejections no longer capture a witness: they are ordinary refusals.

## Considered options

- **Keep the holds and add a message-matched recovery path.** Rejected. It keeps capacity
  consumed until an operator acts, and it repeats the fault that left these holds stranded: a
  proof keyed to an exact error string fails for every error it did not anticipate.
- **A migration that recognises persisted reason strings.** Rejected. A reason string is
  diagnostic text, not proof that `startTurn` was not called. The saved thread binding is that
  proof, and it needs no migration: the release reads it as it stands.
- **Operator-adopted evidence for old holds.** Rejected. It asked one local operator for
  hashes, review references and an independent-review attestation about facts cab already
  records, so the attestation could only be invented.

## Consequences

Start again's witness-only proof accepts two origins: a revision refusal at admission, and a
pre-turn refusal that may keep an idle thread and its turn-less recovery identity. An idle,
unobserved thread can be left behind after a pre-turn failure. The recovery read reports a path
as eligible only when the checks its command runs can pass, and names the failing check
otherwise.
