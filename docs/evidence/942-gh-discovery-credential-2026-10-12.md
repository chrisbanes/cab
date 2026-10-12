# #942 GitHub CLI login as the discovery credential

## Feasibility: gh login readable from a launchd job

Passed on 12 October 2026 (18:36:47Z). A launchd job in the per-user GUI domain read
the keychain-backed `gh` login for github.com without any prompt.

- **Host:** macOS, Apple silicon, `gh version 2.102.0 (2026-09-30)` at
  `/opt/homebrew/bin/gh`. No Ensemble LaunchAgent is installed on this host, so
  the probe was a disposable per-user job.
- **Job:** label `dev.ensemble.probe942.84396d`. It was bootstrapped into
  `gui/501` from an owner-only plist in a private scratch directory.
  - Its only environment variable was `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    the renderer's `LAUNCHD_PATH`.
  - It had `RunAtLoad=true` and `KeepAlive=false`.
- **Probe:** a shell script, with `GH_PROMPT_DISABLED=1`,
  `GH_NO_UPDATE_NOTIFIER=1`, stdin from `/dev/null` and a 10 s alarm, ran:
  - `gh auth status --active --hostname github.com --json hosts`;
  - `gh auth token --hostname github.com`.

  It recorded only exit codes, the status fields below and the token's length and
  character class. The token value was never written.

| Check | Result |
| --- | --- |
| Job last exit code | 0 |
| `gh auth status --json` exit | 0 |
| github.com account | `state: success`, `login: chrisbanes`, `tokenSource: keyring`, `active: true` |
| `gh auth token` exit | 0 |
| Token | non-empty, 40 characters, printable ASCII only |
| Keychain or other prompt | none observed |
| Cleanup | `launchctl bootout` exit 0; `launchctl print gui/501/<label>` then exited 113 (absent) |

The first run's token-format check failed because of the probe's own grep pattern:
BSD grep rejects a repetition bound above 255. The pattern was corrected and the
probe rerun with the same label and plist. Both runs reported the same exit codes,
status fields and token length.
