# Task-scoped runtime environment qualification, attempt 1

Date: 2026-11-15. Grant `1727-t1-20261115-a`: one attempt of
`node test/execution/workspace-environment-qualification/runtime-contract.mjs --live --one-attempt`,
at most eight model turns, 15-minute harness deadline. Plan r1 digest
`5d2a4fa84fc5ecab2a0d0e8f27181e43dc10aefa7ca8e4ddfeefa72dda81a245`; grant record digest
`23490488f1ccc4cef1428c487ff2bf36af6bb02f7638d6983ff91773b8adafd1`.

**Outcome: failed.** Codex passed all four phases. The first Claude turn was refused at
admission, so the attempt stopped as the grant requires. The grant is consumed.

## Setup

- Runtimes: `codex-cli 0.169.0` and `Claude Code 2.1.325`, each on its installed default
  model and effort (grant `model`/`effort` null; no override was sent).
- Offline gate: `npm run test:built -- --suite=execution --profile=service` passed first,
  1,120 tests, 1,107 passed, 0 failed, 13 skipped.
- Disposable root under the OS temporary directory, mode 0700, created for this attempt and
  removed afterwards. The Codex home held only an `auth.json` symlink to the operator login.
  The Claude config directory started empty. API-key and OAuth-token variables were unset.
  No credential contents were read, copied, hashed or printed. The Codex login file's
  metadata was unchanged after the run.
- Claude wiring: `CLAUDE_CONFIG_DIR` was the disposable directory. Claude Code 2.1.325 names
  its Keychain item with a hash of `CLAUDE_CONFIG_DIR` unless
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set, and an empty value selects the default native
  login. The harness therefore sets it to empty and keeps the service user's `HOME`, as cab
  does in production.

## Results

| Phase | Harness | Result |
| --- | --- | --- |
| A, fresh root | Codex | Passed. `cwd` was the A root; `CAB_SCRATCH_DIR` and `TMPDIR` were `A/scratch`; the sentinel was written and read through `TMPDIR`. |
| B, fresh root | Codex | Passed. A distinct thread; paths were B's own, with no A leakage. |
| A follow-up, same root | Codex | Passed. The same thread and A paths. |
| A after App Server restart, resumed at a fresh root | Codex | Passed. The same thread; `cwd`, `CAB_SCRATCH_DIR` and `TMPDIR` all moved to the new root. |
| A, fresh root | Claude | **Refused at admission:** "Claude turn could not start: native subscription login or the reserved cab MCP endpoint is unavailable". |

The Codex results prove the plan's Codex hypothesis: per-thread
`shell_environment_policy.set` on `thread/start` and `thread/resume` binds the task scratch
and `TMPDIR`, and resume moves the thread's `cwd` to a new workspace. No global
configuration or App Server environment change was needed. This holds only for the four
phases above; it is not a claim of provider-wide isolation.

The Claude refusal comes from cab's admission check, which runs before the prompt is
released. It needs both `accountInfo()` to report a first-party subscription and cab's SDK
MCP server to be connected, and the error does not say which check failed. The Claude
process had settled before the harness returned. No Claude session transcript was written,
so the model got no prompt. Claude's measurement and its moved-root resume are **untested**.

## Accounting

- Turns: the harness counted five against the allowance (four Codex, plus one Claude
  reservation that never reached a model). Three were left unused and lapse with the grant.
- Elapsed: 41.2 s to the failure, from 11:07:30Z.
- Settlement: the harness recorded `unknown` because the refused Claude turn had no turn ID.
  When reconciled, no Claude process remained and all four Codex turns were terminal. The
  harness process stayed alive holding only the idle Codex App Server. It was stopped by its
  exact PID with SIGTERM, and its Codex children exited.
- Cleanup: the disposable root, its Codex symlink (never the target), the Claude config
  directory, the fixture database and the per-workspace Claude temporary base were removed.
  No resources were leaked. No installed cab data, settings or workspaces were used.

## Next step

Diagnosing Claude admission needs a new grant. A model-free check of `accountInfo()` and MCP
status under the same wiring would identify the failing condition before any turn is
spent. T2 and its dependants stay blocked until both harnesses pass.
