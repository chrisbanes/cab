# Task Git access live qualification

Recorded 2026-11-05 and repeated 2026-11-06 for [#1532](https://github.com/chrisbanes/cab/issues/1532). The runs below are at candidate `603a2277d192f6e128a4d8cb6630afdde78d0aa2`, a clean checkout; this record is the only later change. No credential, token or account data is recorded, and the data-directory path is replaced by `<managed>`.

Commands: `npm run git-access:live -- --harness=codex` and `npm run git-access:live -- --harness=claude`, the second with `CLAUDE_CODE_OAUTH_TOKEN` set from the operator's environment. The harness reads only that variable, hands it to the service through an `env:` reference after the first service generation has stopped, and never reads operator data.

Each run starts the real `StandaloneService` on a disposable data directory under `~/.cache`, links a fixture source repository to a project and creates one Ready local task. The harness forwards exactly one `startTurn`, found by its marker, and refuses the lead's automatic repair turn. The agent runs a fixed script in its workspace: create and commit on `other`, switch to `probe` at the base, commit, amend, rebase onto `other` and delete `other`, then try to append to the managed repository's `config`, create its `hooks/` and run `git -C <source> branch evil`.

## Result

Both harnesses pass every check:

- The turn completed, and its `startTurn` policy carried exactly the binding's three roots: the managed repository's `objects/` and `reftable/` and `worktrees/repo-1/`.
- Every Git step succeeded. The managed repository's `probe` branch holds the base, `other` and the amended commit, in that order.
- The three forbidden writes were denied. The managed config has no added section and no `hooks/`. The source's refs, config and hooks digest is unchanged, and the source's worktree list does not hold the workspace.
- The service stopped and the fixture was removed. Codex's App Server exit was verified by exact process identity; Claude runs one `claude` process per turn and has no long-lived identity to verify.

Earlier runs on 2026-11-05, against the uncommitted candidate, also passed for both harnesses. Before them, one Claude run stopped before any turn with `Database facade is closed`, because the harness kept the domain from the service generation it had stopped; the harness was fixed to read the domain after the restart. These runs repeat both at the committed head, after the review repairs.

| Harness | Runtime | Result |
| --- | --- | --- |
| Codex | `codex-cli 0.166.0-alpha.6`, launcher SHA-256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` | pass |
| Claude | Claude Code 2.1.318, Agent SDK 0.3.316, model `sonnet` | pass |

The full output of both runs is in [the JSON record](2026-11-05-task-git-access-live.json).
