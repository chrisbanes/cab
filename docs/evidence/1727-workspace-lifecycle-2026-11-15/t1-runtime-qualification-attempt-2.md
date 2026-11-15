# Task-scoped runtime environment qualification, attempt 2

Date: 2026-11-15. Grant `1727-t1-20261115-b`: one attempt of
`node test/execution/workspace-environment-qualification/runtime-contract.mjs --live --one-attempt`,
at most eight model turns, 15-minute harness deadline, both runtimes. Plan r1 digest
`5d2a4fa84fc5ecab2a0d0e8f27181e43dc10aefa7ca8e4ddfeefa72dda81a245`; grant record digest
`1413f9b0158cffafdafdab0a59be90104548bd58445a33228bd47b55bd5b2efe`. Code under test: PR #1734
head `e79720f38ebd760913ac3e875f0458847a127bb3` (main `f4ac390a`, which includes the #1754
Claude admission wait, merged in).

**Outcome: failed.** Codex passed all four phases. Claude was admitted and its first turn
completed. The harness then failed its first Claude measurement assertion: it expected
`CLAUDE_CODE_TMPDIR` in the shell to equal the managed base, but it was the per-user directory
inside that base. The attempt stopped as the grant requires. The
grant is consumed.

## Setup

- Runtimes: `codex-cli 0.169.0` and `Claude Code 2.1.325`, each on its installed default model
  and effort (grant `model`/`effort` null; no override was sent).
- Offline gate at the same head: `npm run test:built -- --suite=execution --profile=service`
  ran 1,168 tests: 1,155 passed, 0 failed, 13 skipped.
- Native authentication and disposable resources were wired as in attempt 1. The disposable
  root was under the OS temporary directory, mode 0700. The Codex home held only an `auth.json`
  symlink to the operator login. The Claude config directory started empty, with
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` empty so the native login was used. API-key and
  OAuth-token variables were unset. No credential contents were read, copied, hashed or
  printed. The Codex login file's metadata was unchanged after the run.

## Results

| Phase | Harness | Result |
| --- | --- | --- |
| A, fresh root | Codex | Passed. `cwd` was the A root; `CAB_SCRATCH_DIR` and `TMPDIR` were `A/scratch`; the sentinel was written and read through `TMPDIR`. |
| B, fresh root | Codex | Passed. A distinct thread; paths were B's own, with no A leakage. |
| A follow-up, same root | Codex | Passed. The same thread and A paths. |
| A after App Server restart, resumed at a fresh root | Codex | Passed. The same thread; `cwd`, `CAB_SCRATCH_DIR` and `TMPDIR` all moved to the new root. |
| A, fresh root | Claude | Admitted, and the turn completed. Observed: `cwd` was the A root, `CAB_SCRATCH_DIR` was `A/scratch`, and the sentinel was written and read through `TMPDIR`. **Harness assertion failed:** observed `CLAUDE_CODE_TMPDIR` = `TMPDIR` = `<managed base>/claude-<uid>`, while the harness expected `CLAUDE_CODE_TMPDIR` = `<managed base>`. |

The Codex results repeat attempt 1, so the Codex hypothesis has now held in two attempts.

For Claude, #1754's bounded MCP admission wait now admits the turn on Claude Code 2.1.325, so
the #1747 refusal did not recur. The harness asserted the Claude
`cwd`, scratch, nonce and sentinel only up to the failing check. The observed values were the
following:

- `CAB_SCRATCH_DIR` reached the shell.
- `TMPDIR` and `CLAUDE_CODE_TMPDIR` were both the per-user directory `claude-<uid>` inside
  cab's per-workspace managed temporary base (`claudeTemporaryBase`).

The failing check was `observed.claudeBase === claudeTemporaryBase(workspace)`. It ran before
the `TMPDIR` `startsWith(base/)` check, so that later check was not reached; the observed
`TMPDIR` does lie inside the base. The product already documents this layout:
`claudeTurnEnvironment` sets `CLAUDE_CODE_TMPDIR` to the base and notes that Claude Code moves
the sandbox `$TMPDIR` to `<base>/claude-<uid>` (#825 T1 F9.1). The harness expectation
therefore contradicts the product's documented contract, so the failure is a harness defect
rather than a product defect. Even so, the harness did not pass. Claude's B, follow-up and moved-root resume phases are **untested**.

## Accounting

- Turns: the harness counted five against the allowance: four Codex turns, then one Claude turn
  that reached the model and completed. Three remained and lapse with the grant.
- Elapsed: 53.3 s, from 18:32:06Z to 18:32:59Z.
- Settlement: `ended`. Reconciliation made one read and found the Claude turn's exact terminal
  status `completed`, with no conflict and no active callbacks. The harness's
  no-unexpected-request and zero-callback assertions ran after the turn and passed. The harness stopped both runtimes and exited by itself (exit code 1). No
  Codex or Claude process referring to the disposable root or the Claude base remained.
- Cleanup: removed the disposable root, its Codex symlink (never the target), the Claude config
  directory with its session files, the fixture database, and the Claude workspace's temporary
  base. No resources were leaked. No installed cab data, settings or workspaces were used.

## Next step

T2 and its dependants stay blocked. A new attempt needs a new grant, and before it the harness
expectation needs a decision. The proposed repair is offline only: expect
`CLAUDE_CODE_TMPDIR` and `TMPDIR` both to equal `<managed base>/claude-<uid>`, the documented
layout, and keep the offline crossed-expectation case failing. Either a fresh full attempt could then re-run both runtimes, or the Codex
result could be reused, as the controller decides.
