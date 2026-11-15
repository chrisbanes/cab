# Task-scoped runtime environment qualification, attempt 3

Date: 2026-11-15. Grant `1727-t1-20261115-c`: one attempt of
`node test/execution/workspace-environment-qualification/runtime-contract.mjs --live --one-attempt`
for the Claude runtime only. Limits were at most four model turns and a 15-minute harness
deadline. Plan r1 digest `5d2a4fa84fc5ecab2a0d0e8f27181e43dc10aefa7ca8e4ddfeefa72dda81a245`;
grant record digest `27dc0fefccf2eb3176497ddbd42478fb3b4b8f60b78e6f5eae3cb836c1741693`. Code
under test: PR #1734 head `cfd92bd45ba9537202e9a72bb46aa1312919af87`. Since attempt 2, that
head changes only the harness and its documentation:

- The harness expects the Claude CLI's per-user temporary directory.
- A grant may name Claude alone with four turns.

**Outcome: passed.** All four Claude phases passed. Together with the reused Codex pass, T1's
finite matrix is complete for both supported runtimes.

## Codex result reused

Codex was not run. The controller reused attempt 2's Codex pass, recorded in
`t1-runtime-qualification-attempt-2.md` and run at `e79720f3` with its evidence at `333bf88a`.
Its four phases passed on `codex-cli 0.169.0`. Since then the Codex adapter inputs
(`src/standalone/codex.ts` and the service code that calls it) are unchanged. The only harness
change on the Codex path is the turn allowance, which now follows the grant.

## Setup

- Runtime: `Claude Code 2.1.325` on its installed default model and effort (grant `model`
  and `effort` null). The binary hash matched attempt 2's.
- Offline gate at the same head: `npm run test:built -- --suite=execution --profile=service`
  ran 1,168 tests: 1,155 passed, 0 failed, 13 skipped.
- Native authentication and disposable resources were wired as in attempts 1 and 2.
  - The disposable root was under the OS temporary directory, mode 0700.
  - The Claude config directory started empty, with `CLAUDE_SECURESTORAGE_CONFIG_DIR` empty so
    the native login was used.
  - API-key and OAuth-token variables were unset.
  - No credential contents were read, copied, hashed or printed.

## Results

In every phase the shell saw `TMPDIR` = `CLAUDE_CODE_TMPDIR` = `<managed base>/claude-<uid>`,
where the managed base is `claudeTemporaryBase` of that phase's workspace.

| Phase | Result |
| --- | --- |
| A, fresh root | Passed. `cwd` was the A root, `CAB_SCRATCH_DIR` was `A/scratch`, and the sentinel was written and read through `TMPDIR`. |
| B, fresh root | Passed. A distinct thread and B's own root, scratch and managed base, with no A leakage. |
| A follow-up, same root | Passed. The same thread, root, scratch and base as A. |
| A after runtime restart, resumed at a fresh root | Passed. The same thread; `cwd`, `CAB_SCRATCH_DIR` and the managed base all moved to the new root's. |

These results show the following for Claude Code 2.1.325, in these four phases only:

- The per-turn `CAB_SCRATCH_DIR` reaches the shell.
- cab's per-workspace managed temporary base keeps every temporary path task-scoped.
- Resuming a conversation at a new workspace moves its working directory, scratch and base.

#1754's bounded MCP admission wait admitted every turn, so the #1747 refusal did not recur.
This is not a claim of provider-wide isolation.

## Accounting

- Turns: four of four used, all of which reached the model and completed; none remain.
- Elapsed: 56.4 s, from 19:09:02Z to 19:09:58Z.
- Settlement: `ended`. Every turn had an exact terminal status, no unexpected request and no cab
  callback. The harness stopped the runtime and exited by itself (exit code 0). No process
  referring to the disposable root or the managed bases remained.
- Cleanup: removed the disposable root, the Claude config directory with its session files,
  the fixture database, and the three workspaces' managed temporary bases. No resources were
  leaked. No installed cab data, settings or workspaces were used.
