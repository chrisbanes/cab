# Codex login symlink and refresh

Answers the open Codex login question of
[ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md) for
[#1336](https://github.com/chrisbanes/cab/issues/1336): whether Codex keeps a
`CODEX_HOME/auth.json` symlink to the operator's login when it refreshes credentials.
The probe never reads the contents of `auth.json`, a token or a hash. It inspects
only `lstat`/`stat` metadata and App Server `account/read` results, and the trace
holds no path or token.

## Environment

- Codex CLI 0.164.0, macOS 27.0.1, no model turn in either stage.
- Disposable `CODEX_HOME` and `HOME`; `OPENAI_API_KEY`/`CODEX_API_KEY` removed;
  `-c cli_auth_credentials_store=file` always, because the keyring and auto modes key
  credentials by the `CODEX_HOME` path and would ignore the link.

Commands, from the repository root:

```text
python3 test/execution/skill-plugin-qualification/codex_auth_link_probe.py --stage dummy /tmp/cab-codex-auth-<suffix>
python3 test/execution/skill-plugin-qualification/codex_auth_link_probe.py --stage operator --live /tmp/cab-codex-auth-<suffix>
```

## Stage A: dummy target (no network)

`home/auth.json` linked to a placeholder file in the disposable directory.

| Facet | Link intact | Target inode | Target mode | Target written | Result |
| --- | --- | --- | --- | --- | --- |
| `codex login --with-api-key` (fake key) | yes | unchanged | unchanged | yes (mtime +102 ms, non-empty) | pass |
| App Server `account/read {refreshToken: true}` | yes | unchanged | unchanged | no (none expected for an API-key login) | pass |

The App Server process group was killed by its recorded PID and was gone; the
directory was removed.

## Stage B: operator login (authenticated, run once)

`home/auth.json` linked to the operator's own file-backed `auth.json` (a regular
file, mode 0600, non-empty), then App Server `initialize` and
`account/read {refreshToken: true}`.

| Observation | Result |
| --- | --- |
| Link still a symlink to the same target | yes |
| Target inode and mode | unchanged |
| Target still a regular file | yes |
| Target mtime | advanced (a refresh write went through the link) |
| Account | present |
| Outcome | `passed`, exit 0 |

After cleanup the operator's file was still a regular file owned by the operator,
and no `cab-codex-auth-*` directory remained.

## Spawn overrides

The service's exact `codex app-server` overrides were accepted by Codex 0.164.0 in an
isolated home: `approval_policy=never`, `sandbox_mode=workspace-write`,
`cli_auth_credentials_store=file`, `features.multi_agent=false`,
`features.plugins=false`, `features.skill_mcp_dependency_install=false` and
`shell_environment_policy.set.HOME=<real home>`. `config/read` reported the
`features` and `shell_environment_policy.set` values, and App Server `command/exec`
under that start printed the real `HOME` (redacted as `<real-home>`) and cab's
`CODEX_HOME`. A model-driven shell command is not exercised here.

## Limits

- Stage B ran once. The mtime advance is attributed to the probe's refresh because
  the probe was the only intended writer; an unrelated Codex process sharing the
  login could in principle also write it.
- A keyring-backed login cannot be linked; the service spawns Codex with
  `cli_auth_credentials_store=file` and reports the missing target as not ready.
