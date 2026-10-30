# Codex per-thread skill scoping and subagent coverage

Authenticated proof for [#1336](https://github.com/chrisbanes/cab/issues/1336) and
[ADR-1021](../adr/1021-profile-skill-plugins-and-subagents.md): whether one Codex App
Server can give different threads different skills, whether that scope survives
`thread/resume`, and whether a model-driven shell keeps the real `HOME`. Redacted trace of
the recorded run: [`codex-skill-scope-probes-2026-10-30.jsonl`](codex-skill-scope-probes-2026-10-30.jsonl).

Probe: `test/execution/skill-plugin-qualification/codex_skill_scope_probe.py`.

```text
python3 test/execution/skill-plugin-qualification/codex_skill_scope_probe.py --live /tmp/cab-codex-scope-<suffix>
```

## Environment

- Codex CLI 0.164.0, macOS, model `gpt-6-luna` at low effort, at most 12 model turns on each App Server.
- Laid out as cab lays it out: a disposable `CODEX_HOME` whose `auth.json` is a symlink to
  the operator's own login, an empty `HOME`, `cli_auth_credentials_store=file`,
  `features.plugins=false`, `features.multi_agent=false`,
  `features.skill_mcp_dependency_install=false`, and `shell_environment_policy.set.HOME`
  set to the real home. `OPENAI_API_KEY`/`CODEX_API_KEY` removed.
- Only `lstat`/`stat` metadata of the operator's `auth.json` is read: never its contents, a
  token or a hash. The trace holds no path (the real home appears as `<real-home>`).
- The two fixture skills are `probe-skill` and `other-skill`; each runs a command that writes
  a marker file in the task workspace.

## Results

| Facet | Check | Result |
| --- | --- | --- |
| S1 | `skills/extraRoots/set` with the fixture directory, then `skills/list` | Demonstrated. Both fixture skills are listed as user skills with plugins disabled. Five bundled `.system` skills are listed from cab's Codex home. |
| S2 | Thread A started with `config.skills.config` disabling `other-skill` and every bundled skill; thread B with nothing disabled, on the same App Server | Demonstrated. A lists only `probe-skill`, runs it, and asked for `other-skill` answers that it has none (no marker). B lists all six and runs `other-skill`. |
| S3 | A new App Server process (as after a cab restart) is told `thread/unsubscribe` for A (its status is `notLoaded`, not an error), then resumes A with the same config | Demonstrated. The resumed thread lists only `probe-skill` and cannot run `other-skill`. Resume without the config was not run: cab sends the config on every start and resume. |
| S4 | A model-driven shell prints `$HOME`; `skills/list` loads nothing from the real home | Demonstrated. The command printed the real home, and no skill came from it. |
| S5 | `lstat`/`stat` of the link after every turn group | Demonstrated. The link stayed a symlink to the same target, the target's inode is unchanged, and it is still a regular file. |
| S3b | A loaded thread started without scope gets a resume with the scope config: first a plain `thread/resume` with config, then `thread/unsubscribe` and a resume | Demonstrated. A resume alone changes nothing (the thread still lists every skill); after `thread/unsubscribe` the next resume applies the scope and the thread lists only `probe-skill`. A plain `thread/resume` without config does not reset a scoped thread. |
| S3c | A second plugin root (`third-skill`) joins the process after thread A was scoped | Demonstrated. Thread A then lists `third-skill` as well as `probe-skill` (a loaded thread sees later roots), and after `thread/unsubscribe` plus a resume with a refreshed disable list it lists only `probe-skill`. |
| S6 | Information only: a separate App Server with `features.multi_agent=true` and a prompt to delegate an outside write, a network attempt and a sleep to a subagent | Untested. The model used no subagent tool in the recorded run (item kinds: agent and user messages only), so no subagent sandbox, network or interrupt behaviour was observed. An earlier, unrecorded run did show subagent activity with the outside write not landing; its interrupt and survivor behaviour were not observed either. Codex subagents stay disabled. |

## Attempts

- The first run passed S1 to S5. S6 showed no subagent tool use, and its outside-write
  target sat under `/tmp`, which workspace-write allows, so it was not meaningful; the target
  moved to the real home (removed afterwards).
- A later run failed S4 once because the model answered without using its shell tool (no
  command item), exit 5. The prompt now names the shell tool and uses a fresh thread; two
  further runs passed S1 to S5; the recorded run is the last, after S3 was changed to resume on a restarted App Server.
- Bundled skills are listed under cab's Codex home, not the real one, so disabling them
  per thread does not touch any shared file.

## Limits

- Scoping is shown for a model that is asked to list and use skills. A thread can still read
  a disabled skill's `SKILL.md` if it is given the path; this is not an isolation boundary.
- One model, one Codex version.
