# Task Git access sandbox probe

Recorded 2026-11-05 for [#1532](https://github.com/chrisbanes/cab/issues/1532). Candidate `00d262caef5b73582316276aa9ff9096ac1166c6` plus the uncommitted probe `test/execution/git-access-qualification/sandbox-git-probe.mjs`; no runtime code had changed. No credential, token or account data is recorded.

Command: `node test/execution/git-access-qualification/sandbox-git-probe.mjs --live --one-attempt`, with `CLAUDE_CODE_OAUTH_TOKEN` set from the operator's environment.

## Fixture

For each harness, in a fresh directory under `~/.cache`: a source repository with two commits, and a bare managed repository created with `git init --bare --template= --ref-format=reftable` whose `objects/info/alternates` names the source's `.git/objects`. The managed repository has `gc.auto=0`, `maintenance.auto=false` and `core.logAllRefUpdates=true`, and a branch `other` at the second commit. A detached worktree of it at the first commit is the task workspace's `repo-1`.

The writable roots are exactly the task workspace, the managed repository's `objects/` and `reftable/`, and the worktree's admin directory `worktrees/repo-1/`.

The fixed script runs `git switch -c probe`, a commit, `git commit --amend`, `git rebase other`, `git branch scratch` and `git branch -d scratch`, then tries `mkdir <managed>/hooks`, appending to `<managed>/config`, `touch <managed>/info` and `git -C <source> branch evil`.

- Codex: `codex sandbox` with `sandbox_mode="workspace-write"`, `exclude_slash_tmp`, `exclude_tmpdir_env_var` and the four `writable_roots`, an empty `CODEX_HOME`, and no model.
- Claude: one SDK `query()` with cab's sandbox options (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`, no allowed domains, `filesystem.allowWrite` the four roots), `settingSources: []` and only the Bash tool. The model ran the script with one Bash call.

## Result

Both harnesses pass. Every Git operation succeeded and every forbidden write was denied. Afterwards the probe branch held the first commit, the second commit and the amended commit, in that order; `scratch` was gone; the source's `for-each-ref` output and both configs were byte-identical; and the managed repository had no `hooks` or `info`. Both fixtures were removed.

The first run lost the Claude result to a defect in the probe's evidence assignment (the result was written to a replaced object); the probe was fixed and run once more. Its output follows, with the fixture path and home directory replaced.

```json
{
  "candidate": "00d262caef5b73582316276aa9ff9096ac1166c6",
  "node": "v26.13.0",
  "git": "git version 2.54.0 (Apple Git-157)",
  "codex": {
    "launcherSha256": "50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8",
    "version": "codex-cli 0.166.0-alpha.6",
    "result": {
      "exit": 0,
      "steps": {
        "switch": "ok",
        "add": "ok",
        "commit": "ok",
        "amend": "ok",
        "rebase": "ok",
        "branch": "ok",
        "branch-delete": "ok",
        "hooks": "denied",
        "config": "denied",
        "info": "denied",
        "source-branch": "denied"
      },
      "checks": {
        "requiredOk": true,
        "forbiddenDenied": true,
        "rebasedOrder": true,
        "amendedMessage": true,
        "scratchDeleted": true,
        "sourceRefsUnchanged": true,
        "sourceConfigUnchanged": true,
        "managedConfigUnchanged": true,
        "hooksAbsent": true,
        "infoAbsent": true
      },
      "pass": true
    },
    "pass": true
  },
  "claude": {
    "sdk": "0.3.316",
    "sdkDeclaredClaudeCode": "2.1.316",
    "installed": "2.1.318 (Claude Code)",
    "result": {
      "bashCalls": 1,
      "resultSubtype": "success",
      "steps": {
        "switch": "ok",
        "add": "ok",
        "commit": "ok",
        "amend": "ok",
        "rebase": "ok",
        "branch": "ok",
        "branch-delete": "ok",
        "hooks": "denied",
        "config": "denied",
        "info": "denied",
        "source-branch": "denied"
      },
      "checks": {
        "requiredOk": true,
        "forbiddenDenied": true,
        "rebasedOrder": true,
        "amendedMessage": true,
        "scratchDeleted": true,
        "sourceRefsUnchanged": true,
        "sourceConfigUnchanged": true,
        "managedConfigUnchanged": true,
        "hooksAbsent": true,
        "infoAbsent": true
      },
      "pass": true
    },
    "pass": true
  },
  "cleanup": {
    "fixtureRemoved": true
  },
  "failure": null
}
```
