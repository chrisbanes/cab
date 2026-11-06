# Local listening live qualification

Recorded 2026-11-06 for [#1534](https://github.com/chrisbanes/cab/issues/1534). Both runs are at candidate `abd20d0d5cc6f9ed36268d048b8a1fb30b9cf8fa` plus the uncommitted harness `test/execution/local-listening-qualification/live-local-listening.mjs` and its `package.json` script; no runtime code changed afterwards. No credential, token or account data is recorded.

Commands: `npm run local-listening:live -- --harness=codex` and `npm run local-listening:live -- --harness=claude`, the second with `CLAUDE_CODE_OAUTH_TOKEN` set from the operator's environment. The harness reads only that variable, hands it to the service through an `env:` reference after the first service generation has stopped, and never reads operator data.

Each run starts the real `StandaloneService` on a disposable data directory under `~/.cache` and creates one Ready local task in a project with local listening on. For Codex, command network access is on too, because a Codex command can listen only with network access. The harness forwards exactly one `startTurn`, found by its marker, and refuses the lead's automatic repair turn. The agent runs a fixed Node script in its task workspace: bind `127.0.0.1:0`, connect to it and read one byte, then connect to `1.1.1.1:443`.

## Result

Both harnesses pass every check:

- The turn completed. Claude's `startTurn` policy was exactly `{ networkAccess: false, localListening: true }`, and the service recorded local listening on at its admission. Codex's was `{ networkAccess: true }`, with no local listening, and its admission recorded local listening off.
- The listener bound `127.0.0.1` and served in both harnesses. Claude's outbound connection failed with `EPERM`; Codex's succeeded, as command network access allows.
- The service stopped and the fixture was removed. Codex's App Server exit was verified by exact process identity; Claude runs one `claude` process per turn and has no long-lived identity to verify.

Each harness ran once; neither needed a repeat.

| Harness | Runtime | Result |
| --- | --- | --- |
| Codex | `codex-cli 0.166.0-alpha.6`, launcher SHA-256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` | pass |
| Claude | Claude Code 2.1.318, Agent SDK 0.3.316, model `sonnet` | pass |

The full output of both runs is in [the JSON record](2026-11-06-local-listening-live.json).
