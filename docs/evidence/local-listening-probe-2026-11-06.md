# Local listening sandbox probe

Recorded 2026-11-06 for [#1534](https://github.com/chrisbanes/cab/issues/1534). Candidate `fa61e593598f9e2acb52ef5cc9b3122833f1e08c` plus the uncommitted probe `test/execution/local-listening-qualification/sandbox-listen-probe.mjs`; no runtime code had changed. No credential, token or account data is recorded.

Command: `node test/execution/local-listening-qualification/sandbox-listen-probe.mjs --live --one-attempt`, with `CLAUDE_CODE_OAUTH_TOKEN` set from the operator's environment.

## Fixture

For each case, a fresh task workspace under `~/.cache` holding one fixed Node script. The script binds `127.0.0.1:0`, connects to it and reads one byte; binds `0.0.0.0:0`; connects to `1.1.1.1:443` with a 4-second timeout; and connects to a `127.0.0.1` listener the probe process started outside the sandbox. Each step records `ok` or its error code.

- Codex: `codex sandbox` with `sandbox_mode="workspace-write"`, `exclude_slash_tmp`, `exclude_tmpdir_env_var` and `network_access` false, then true, an empty `CODEX_HOME`, and no model.
- Claude: one SDK `query()` per case with cab's sandbox options (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`, `network.allowedDomains: []`, `filesystem.allowWrite` the workspace), `settingSources: []` and only the Bash tool; first without `allowLocalBinding`, then with `allowLocalBinding: true`. The model ran the script with one Bash call each time.

## Result

Every gate passes, and the fixtures were removed.

| Case | Bind 127.0.0.1 | Serve | Bind 0.0.0.0 | Outbound 1.1.1.1:443 | Outside loopback listener |
| --- | --- | --- | --- | --- | --- |
| Codex, network off | `EPERM` | — | `EPERM` | `EPERM` | `EPERM` |
| Codex, network on | ok | ok | ok | ok | not measured (see below) |
| Claude, no option | `EPERM` | — | `EPERM` | `EPERM` | `EPERM` |
| Claude, `allowLocalBinding` | ok | ok | ok | `EPERM` | ok |

- With `allowLocalBinding`, Claude's sandbox does not restrict the bind address: binding `0.0.0.0` succeeds, so a listener can accept connections on every interface the host's firewall allows. Outbound network stays denied.
- With `allowLocalBinding`, a sandboxed Claude command can connect to other services already listening on the host's loopback interface.
- The Codex network-on `timeout` for the outside listener is a probe artifact: the probe runs `codex sandbox` through `spawnSync`, which blocks the event loop serving that listener. With network access on, Codex already permits outbound connections, so it is not a separate gate.

Output, with the fixture path and home directory replaced:

```json
{
  "candidate": "fa61e593598f9e2acb52ef5cc9b3122833f1e08c",
  "node": "v26.13.0",
  "codex": {
    "launcherSha256": "50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8",
    "version": "codex-cli 0.166.0-alpha.6",
    "networkOff": {
      "exit": 0,
      "steps": {
        "listenLoopback": "EPERM",
        "listenAny": "EPERM",
        "outbound": "EPERM",
        "outsideLoopback": "EPERM"
      }
    },
    "networkOn": {
      "exit": 0,
      "steps": {
        "listenLoopback": "ok",
        "serveLoopback": "ok",
        "listenAny": "ok",
        "outbound": "ok",
        "outsideLoopback": "timeout"
      }
    }
  },
  "claude": {
    "sdk": "0.3.316",
    "sdkDeclaredClaudeCode": "2.1.316",
    "installed": "2.1.318 (Claude Code)",
    "withoutOption": {
      "bashCalls": 1,
      "resultSubtype": "success",
      "steps": {
        "listenLoopback": "EPERM",
        "listenAny": "EPERM",
        "outbound": "EPERM",
        "outsideLoopback": "EPERM"
      }
    },
    "withOption": {
      "bashCalls": 1,
      "resultSubtype": "success",
      "steps": {
        "listenLoopback": "ok",
        "serveLoopback": "ok",
        "listenAny": "ok",
        "outbound": "EPERM",
        "outsideLoopback": "ok"
      }
    }
  },
  "cleanup": {
    "fixtureRemoved": true
  },
  "failure": null,
  "gates": {
    "codexOffDenied": true,
    "codexOnListens": true,
    "claudeWithoutOptionDenied": true,
    "claudeWithOptionListens": true,
    "fixtureRemoved": true
  },
  "pass": true
}
```
