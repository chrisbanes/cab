# #1144 LaunchDaemon mode evidence — 2026-10-17

## Outcome

Recorded the read-only and unprivileged facts that `ensemble service install --mode daemon`
rests on, and one bounded run of its install, re-run and uninstall with a throwaway
label and temporary directories. It does **not** qualify a real LaunchDaemon: nothing here
used `sudo`, wrote under `/Library`, loaded a `system/` job, rebooted, ran `fdesetup`,
read before a GUI login, or changed any gh, Codex or Claude login. Those are untested here
and belong to [#1149](https://github.com/chrisbanes/ensemble/issues/1149), using the
[procedure](../operations/standalone-macos.md#real-host-qualification-procedure-1149).

## Identity

- Host: macOS 27.0.1, Apple silicon. `gh version 2.102.0 (2026-09-30)`. Node v24.22.0.
- Code: branch `cb/issue-1144-launchdaemon-mode`, built with `npm run build:service`.
- Throwaway label `local.ensemble.evidence1144` on a random loopback port. State, logs and
  the (never created) LaunchAgents directory lived under one private temporary directory,
  written `<TMP>` below. The real `/Library/LaunchDaemons` was only read: `launchctl print`
  and `ls`.

## Probes

| Probe | Result |
| --- | --- |
| `gh auth status --active --hostname github.com --json hosts --jq '…{state,active,tokenSource}'` on the host login, with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` removed | `{"active":true,"state":"success","tokenSource":"keyring"}`. The host login is keychain-backed, so install and doctor show the keychain warning here. |
| The same command with an isolated `GH_CONFIG_DIR` holding a fake file-based `hosts.yml` (token `ghp_FAKE…`, never printed, mode `0600`) | `{"active":true,"state":"error","tokenSource":"<TMP>/ghcfg/hosts.yml"}`. The source is the file path (`error` only because GitHub rejects the fake token), which is what the probe maps to `file`. The token is read from the file, not the keychain. |
| `stat -f '%Sp %Su' ~/.codex/auth.json` (metadata only) | `-rw------- chris`: the Codex login is a file the service account reads without a GUI session. |
| `~/.ensemble/claude/claude-token` (the suggested path; metadata only) | Absent on this Mac. Whether a `file:` Claude token is configured elsewhere is not read here; the setting lives in the service, not on disk metadata. |
| `launchctl print system/local.ensemble.evidence1144` | Exit 113 (not loaded). |
| `ls -ld /Library/LaunchDaemons` | `drwxr-xr-x  3 root  wheel`: only root writes it, so the plist copy needs `sudo`. |

## Throwaway-label run

The CLI ran from a release layout under `<TMP>/state/versions/0.1.0`, with an auth file made by
`OperatorAuth.initialize` and `--state-dir`, `--log-dir` and `--launch-agents-dir` in `<TMP>`.
The printed `sudo` steps were never run. Daemon verify and uninstall write only the install record
under `STATE/launchd`, and only to note a loaded job's process; none was loaded here.

| Step | Result |
| --- | --- |
| `service install --mode daemon --port <P>` | Exit 0. JSON: `"mode":"daemon"`, `"started":false`, `"plist":"<TMP>/state/launchd/local.ensemble.evidence1144.plist"` and the two steps `sudo /usr/bin/install -m 0644 -o root -g wheel <staged> /Library/LaunchDaemons/local.ensemble.evidence1144.plist` and `sudo /bin/launchctl bootstrap system /Library/LaunchDaemons/local.ensemble.evidence1144.plist`. stderr showed the keychain warning (`…run gh auth login --insecure-storage on this Mac…`), the steps and the verify line. |
| Second `service install --mode daemon` | Exit 0 with the same steps and `"started":false`: the job is not loaded and `/Library/LaunchDaemons` holds no plist. The record was not rewritten. |
| `plutil -lint <staged plist>` | `OK`. |
| Staged plist | `UserName` `chris`, `HOME` `/Users/chris`, the fixed `PATH`, the auth-file path, the origin, both log paths, `RunAtLoad` true, `KeepAlive` false, and no other environment variable. No token or password appears. |
| Directories | The LaunchAgents directory was never created; the daemons directory was not written (`ls /Library/LaunchDaemons` unchanged). `STATE/launchd` held only the record and the staged plist (both mode `0600`). |
| `launchctl print system/<label>` after install | Exit 113. |
| `service uninstall` | Exit 0: `"mode":"daemon"`, `"installed":true`, `"complete":true`, because nothing was loaded or installed, no process was ever recorded, no log file existed and the port was free. The record and staged plist were removed; data, auth and versions remained. |

## Untested here

- A read before any GUI login: that discovery and `git push` through `gh auth git-credential`
  succeed from a LaunchDaemon with a file-based gh login (#1149).
- The owner of the log files launchd creates under `UserName` (#1149).
- The real `sudo` install, the verify re-run against a loaded `system/` job, `sudo fdesetup
  authrestart` and a reboot (#1149).
- A Claude token or Codex login behaving before login on a real daemon host.
- Unattended recovery from a FileVault power cut, which stays a disclosed limit.
