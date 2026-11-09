# Skip sandbox live qualification

Recorded 2026-11-09 for [#1584](https://github.com/chrisbanes/cab/issues/1584). Both runs are at candidate `6a21d5e43692f964ca8273fecfb7e48a99782237`, built into `dist` from that tree. No credential, token or account data is recorded.

Commands: `npm run skip-sandbox:live -- --harness=codex` and `npm run skip-sandbox:live -- --harness=claude`, each exiting 0 after one attempt per cell. Claude runs on the service user's native Claude Code login; the harness reads no secret and never reads operator data.

Each run starts the real `StandaloneService` on a disposable data directory under `~/.cache`, once per cell, and creates one Ready local task in a project whose `dangerouslySkipSandbox` is off (first cell) or on (second cell), set through `project.configure`. The harness forwards exactly one `startTurn`, found by its marker, and refuses the lead's automatic repair turn (one refused in each off cell). The agent runs a fixed Node script in its task workspace: launch headless Chromium through Playwright, then boot `Medium_Phone` on fixed console port 5580, poll `sys.boot_completed` for up to 300 s and kill only that emulator.

## Result

| Harness | Runtime |
| --- | --- |
| Codex | launcher `codex-cli 0.167.0-alpha.3.2`, SHA-256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` |
| Claude | Claude Code 2.1.318, Agent SDK 0.3.319, model `sonnet` |

Node v26.13.0 on macOS. Every cell passed all seven checks: turn completed, exactly one turn, admitted value, policy at `startTurn`, policy sent to the runtime, Chromium and emulator as expected. A cell whose script wrote no step never passes.

| Harness | Setting | Admitted | Policy sent to the runtime | Chromium | Emulator |
| --- | --- | --- | --- | --- | --- |
| Codex | off | false | `turn/start` `workspaceWrite` (network off), approval `never` | `browserType.launch: EPERM: operation not permitted, mkdtemp '/var/folders/…/T/playwright-artifacts-…'` | `emulator exited: exit=SIGILL`; `adb` could not open its log in the temporary directory: `Operation not permitted` |
| Codex | on | true | `turn/start` `{ type: "dangerFullAccess" }`, approval `never` | `ok` | `ok` |
| Claude | off | false | `options.sandbox.enabled: true` | `browserType.launch: Target page, context or browser has been closed` | `emulator exited: exit=SIGILL`; `adb` server did not start (`ADB server didn't ACK`) |
| Claude | on | true | `options.sandbox: { enabled: false }` | `ok` | `ok` |

The full step texts and per-cell checks are in the JSON records: [Codex](2026-11-09-skip-sandbox-live-codex.json) and [Claude](2026-11-09-skip-sandbox-live-claude.json).

## Verdict

With the setting on, an agent turn of each harness launched Chromium and booted the Android emulator; with it off, both failed under the harness sandbox. Both verdicts (`offBlocked`, `onWorks`) are true for both harnesses.

This settles the plan's open question: Codex accepts a per-turn `dangerFullAccess` sandbox policy on a thread that was started `workspace-write`, and the turn ran unsandboxed.

## Notes

- An earlier Claude attempt failed in setup, before any turn ran, on the retired `claude-token.configure` command. It is superseded by the native-login run above and is not a sandbox result.
- The SDK printed its `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning during the Claude run: `canUseTool` is not consulted for tools in `allowedTools`. That is existing cab runtime behaviour, not introduced by this setting.
- The user's own emulators were untouched. The harness refuses to start if `emulator-5580` is already listed and kills only that serial; no cell found it left running (`emulatorKilled: false`).
