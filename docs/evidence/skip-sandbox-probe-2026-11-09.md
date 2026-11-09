# Skip-sandbox host-tools probe

Recorded 2026-11-09 for [#1584](https://github.com/chrisbanes/cab/issues/1584). Candidate `4b85e35148dc2d3f52738128d08b11fd091866b5` (the probe `test/execution/skip-sandbox-qualification/sandbox-host-tools-probe.mjs`); no runtime code had changed. No credential, token or account data is recorded. The sanitised output is [skip-sandbox-probe-2026-11-09.json](skip-sandbox-probe-2026-11-09.json), verbatim.

Command: `node test/execution/skip-sandbox-qualification/sandbox-host-tools-probe.mjs --live --one-attempt`, with `CLAUDE_CODE_OAUTH_TOKEN` set from the operator's environment. Exit 0.

Host: macOS 27.0.1, Apple silicon (arm64), Node v26.13.0.

## Versions

- Codex: the approved launcher `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` reports `codex-cli 0.167.0-alpha.3.2` (SHA-256 `50ab38ba...379c8`). The `codex` on `PATH` is 0.166.0; the probe does not use it.
- Claude: SDK 0.3.319 (declares Claude Code 2.1.319); installed `claude` 2.1.318.

## Fixture

For each leg, a fresh task workspace under `~/.cache` holding one fixed Node script. It launches headless Chromium through the repository's Playwright on a `data:` URL and reads the title. It then starts the `Medium_Phone` AVD (`-port 5580 -no-window -no-audio -no-snapshot -no-boot-anim`), polls `adb shell getprop sys.boot_completed` for up to 300 s, and stops only the emulator it started (`adb -s emulator-5580 emu kill`, falling back to its own child PID). Each step records `ok` or its error text.

- Codex: `codex sandbox` with `sandbox_mode="workspace-write"`, `exclude_slash_tmp`, `exclude_tmpdir_env_var` and `network_access` false, an empty `CODEX_HOME`, and no model.
- Claude, sandboxed: one SDK `query()` with cab's sandbox options (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`, `network.allowedDomains: []`, `filesystem.allowWrite` the workspace), `settingSources: []` and only the Bash tool. The model ran the script with one Bash call.
- Claude, sandbox disabled: the same options with `sandbox: { enabled: false }`.

## Result

| Leg                              | Chromium                                                                                                           | Emulator                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Codex, sandboxed                 | failed: `browserType.launch: EPERM: operation not permitted, mkdtemp '/tmp/playwright-artifacts-...'`              | failed: emulator exited `SIGILL`; adb could not start its daemon (`cannot open /tmp/adb.501.log: Operation not permitted`) |
| Claude, sandboxed                | failed: `browserType.launch: Target page, context or browser has been closed` at launch of `chrome-headless-shell` | failed: emulator exited `SIGILL`; adb daemon did not ACK (log under `/tmp/claude-501/`)                                    |
| Claude, `sandbox.enabled: false` | `ok`                                                                                                               | `ok` (`sys.boot_completed` = 1)                                                                                            |

- Codex's Chromium failure is the temp-directory write (`mkdtemp /tmp`, EPERM), not `MachPortRendezvous`.
- Each sandboxed leg made one Bash call and ended `success`; the fixtures were removed.

## Verdict

Pass against the plan's condition: both sandboxed legs fail both checks, and the Claude `enabled: false` leg passes both. `verdict` in the JSON is all true and `pass` is true.

## Limits

- The probe does not cover the Codex per-turn `dangerFullAccess` path on a `workspace-write` thread; the later live service run proves it.
- The SDK warned twice (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) that bare `allowedTools` shadows `canUseTool`. This is specific to the probe and does not affect cab, whose runtime relies on its PreToolUse hook.
