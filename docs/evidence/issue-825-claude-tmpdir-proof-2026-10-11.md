# #825 Claude sandbox TMPDIR and gated-prompt proof, 11 October 2026

This records the bounded live proof (task T1 of
[#825](https://github.com/chrisbanes/ensemble/issues/825)) of how the Claude Code
sandbox temporary directory is handled under
[ADR-1008](../adr/1008-claude-code-execution-harness.md). C0
([#822](issue-822-claude-sdk-probes-2026-10-11.md), F6.1) found that sandboxed Bash
writes to `/tmp/claude-<uid>`, which is per OS user and shared across tasks. The
probe is `test/claude-c0/p9-tmpdir.mjs`, run through the guarded C0 driver in a
disposable root outside the repository. Trace:
[`issue-825-claude-tmpdir-proof-2026-10-11.jsonl`](issue-825-claude-tmpdir-proof-2026-10-11.jsonl)
(SHA-256 `36f40a6e3f1f8c921f7f3128fa11d2f3729cfdd3dc1bdfc1b170ddb39ed5552a`).

## Result

**Selected outcome: redirect (R).** Setting the Claude Code process environment
variable `CLAUDE_CODE_TMPDIR` to a per-task base directory moves the sandbox
`$TMPDIR` to `<base>/claude-<uid>`, and a sandboxed write to `/tmp/claude-<uid>` is
then refused. The base must be short: see the length limit below.

| Facet | Disposition | Observation |
| --- | --- | --- |
| F9.0 Gated prompt, model-free | passed | See below. No model call. |
| F9.1 Redirect via `CLAUDE_CODE_TMPDIR` | passed (attempt 2) | With `CLAUDE_CODE_TMPDIR=/tmp/ens-<8 hex>` and `sandbox.filesystem.allowWrite: [<workspace>, <base>]`, sandboxed Bash reported `TMPDIR=/tmp/ens-<8 hex>/claude-501`. The write to `"$TMPDIR/<nonce>"` landed there, the workspace write succeeded, and the write to `/tmp/claude-501/<nonce>` failed with `operation not permitted` (file absent). Every Bash result was clean (`isError: false`). |
| F9.2 Deny via `sandbox.filesystem.denyWrite` | failed (attempt 2) | With `denyWrite: ["/tmp/claude-501"]` and the default `$TMPDIR`, both writes into `/tmp/claude-501` were refused and the workspace write succeeded. However, every Bash call returned `isError: true` with `Exit code 1` and `operation not permitted: /tmp/claude-501/cwd-<4 hex>`, including the command whose own exit status was 0. The shell's per-command working-directory file lives in `$TMPDIR`, so denying that directory breaks the shell result for every command and masks real exit statuses. Not usable. |
| F9.3 Control | passed (attempt 2) | With no redirect and no deny, `$TMPDIR` was `/tmp/claude-501` and the writes to it and to `/tmp/claude-501/<nonce>` both landed, reproducing C0 F6.1. The workspace write succeeded with clean results. |

All facets are informational (`[I]`): ADR-1008 already decides redirect, deny or a
disclosed shared write root, so no outcome returns to Chris.

Model-backed queries: 6 of the 12 cap (3 per run: F9.3, F9.1, F9.2). All used
`haiku` at `effort: "low"` with a 120 s deadline and abort. Attempts per facet: 2
(two runs of the step). Every recorded CLI process identity was verified exited.

## Candidates found offline

Before any live call, the installed SDK `0.3.296` type declarations and the bundled
CLI `2.1.296` were inspected:

- `sdk.d.ts` has no temporary-directory option. `sandbox.filesystem` offers
  `allowWrite`, `denyWrite`, `denyRead`, `allowRead` and `disabled`. The `TMPDIR`
  variable in the SDK `env` option is ignored for the sandbox on macOS (C0 F6.1).
- The CLI reads the environment variable `CLAUDE_CODE_TMPDIR` (also
  `CLAUDE_TMPDIR` in one sandbox-proxy path). Its per-user directory is
  `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`.
- The CLI's child-process `$TMPDIR` falls back to `/tmp/claude-<uid>` when the
  per-user directory path is longer than 44 bytes, because it must fit an
  `AF_UNIX` socket path (the CLI's own message says "too long for AF_UNIX
  sockets"). This was read from the CLI binary and confirmed live (attempt 1).

## Attempts and corrections

| Run | Change | Result |
| --- | --- | --- |
| 1 | F9.1 used `<disposable-root>/task-tmp` as `CLAUDE_CODE_TMPDIR` and F9.2 judged only the file writes | F9.1 failed: `$TMPDIR` was still `/tmp/claude-501`, both writes landed. The CLI had created `task-tmp/claude-501/...` (its own task state) and `task-tmp/cc-socks`, so the variable was honoured, but the path `<disposable-root>/task-tmp/claude-501` exceeds 44 bytes and the child-process `$TMPDIR` fell back. F9.2 appeared to pass on the file writes alone. |
| 2 | F9.1 uses a short nonce directory `/tmp/ens-<8 hex>` (mode 0700, removed at the end by exact path). All facets also require a clean (`isError: false`) result for the command that succeeds. | F9.1 passed. F9.2 failed on the error results (above). F9.0 and F9.3 unchanged. |

## F9.0 gated prompt and model settings (no model call)

The prompt is an async iterable that yields nothing and releases only on abort. In
both runs:

- `spawnClaudeCodeProcess` had run before the first pull of the prompt
  (`procsAtFirstPull: 1`), and the process identity was captured and the CLI
  verified running while the gate was still closed. No prompt was yielded and no
  message was received.
- `supportedModels()` resolved without a prompt, listing `default` and `sonnet`
  (`claude-sonnet-5-5`), `fable` (`claude-fable-5-1`), `opus` (`claude-opus-5-5`) and
  `haiku` (`claude-haiku-5-5`), each with `supportsEffort: true` and efforts `low`,
  `medium`, `high`, `xhigh` and `max`.
- `initializationResult().claude_code_version` was `2.1.296` without a prompt.
- Abort settled in 0.6 to 0.7 s; the CLI exited with code 0 on its own and the exit
  was verified, with no harness signal. The query iterator ended with
  `Operation aborted`.

So the plan's start-time model-free settings read is available, and the static C0
F7.6 fallback is not needed.

## Implications for T5

- Use `CLAUDE_CODE_TMPDIR=<base>` in the Claude spawn environment, and add `<base>`
  to `sandbox.filesystem.allowWrite`. Do not use `denyWrite` for the shared
  directory.
- `<base>/claude-<uid>` must be at most 44 bytes. The planned
  `<dataDir>/claude/tmp/<sha256(workspace)[0:16]>` is too long on macOS, so the
  per-task base has to be a short path. Whether a short symlink to a longer
  directory is accepted is untested.
- The CLI keeps its own task state (`claude-<uid>/<project>/<session>/tasks`,
  `bash-edit-diff`) and sandbox proxy sockets (`cc-socks`) under the base, so the
  base must live as long as the task's workspace and sessions.

## Not tested

- A short symlink as `CLAUDE_CODE_TMPDIR`.
- Whether processes that sandboxed Bash starts keep using the redirected directory.
- Behaviour when two concurrent tasks use different bases (the redirect is
  per-process by construction).
- A base on another platform; this ran on macOS only.

## Method and cleanup

The driver ran `--live init` (the SDK `0.3.296` and `zod` installed only in the
disposable root), `--live p9`, `summary` and `export`. The only token read was
`CLAUDE_CODE_OAUTH_TOKEN`, by name, into the probe process environment. The
recorder redacts at write time. The probe deleted only the files it created
(nonce-named, at exact paths), including its attempt files in `/tmp/claude-501`,
and removed its `/tmp/ens-<8 hex>` base by exact path.
