# Command network access live qualification

Recorded 2026-10-19 for [#1191](https://github.com/chrisbanes/ensemble/issues/1191). Candidate `fb2b1014c5dd3b9b5789bcb5ccccad61a583bd27`, which is runtime-identical to the head this record lands on: the only later change is this file.

Launcher `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`, `codex-cli 0.163.0-alpha.10.2`, SHA-256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8`. Node v24.22.0. No credentials, tokens or account data were read or recorded.

## Per-turn control on the App Server (T1)

One attempt, one thread, three `turn/start` requests carrying `sandboxPolicy.networkAccess` false, true, false. Each asked the model to run `curl` against `https://registry.npmjs.org/` and write the status and exit code to a file in a disposable workspace. All three turns completed. The workspace was removed.

```json
{
 "version": "codex-cli 0.163.0-alpha.10.2",
 "results": [
  {
   "turn": 1,
   "requestNetworkAccess": false,
   "status": "completed",
   "file": "curl: (6) Could not resolve host: registry.npmjs.org\n000 exit=6"
  },
  {
   "turn": 2,
   "requestNetworkAccess": true,
   "status": "completed",
   "file": "200 exit=0"
  },
  {
   "turn": 3,
   "requestNetworkAccess": false,
   "status": "completed",
   "file": "curl: (6) Could not resolve host: registry.npmjs.org\n000 exit=6"
  }
 ]
}
```

The App Server honours the per-turn value in both directions, including an off turn after an on turn.

## Service run (`npm run network-access:live`)

One run through the real service. Task `off` was admitted with the setting at its default and task `on` after the operator enabled it with `project.configure`. The harness forwarded exactly one `startTurn` per task (two in all) and refused two further turns, the lead's automatic repair turns. Pass condition met: `off` recorded `false`, was called without a policy and its file shows a DNS failure with a non-zero exit; `on` recorded `true`, was called with `{ networkAccess: true }` and its file shows `200 exit=0`; both turns completed; the fixture was removed.

Earlier attempts hit defects in the harness itself (intent selection and turn accounting), fixed before this run; they are recorded in the pull request.

```json
{
  "candidate": "fb2b1014c5dd3b9b5789bcb5ccccad61a583bd27",
  "node": "v24.22.0",
  "codex": {
    "launcher": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "launcherSha256": "50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8",
    "version": "codex-cli 0.163.0-alpha.10.2"
  },
  "startTurnCalls": [
    {
      "phase": "off",
      "policy": null
    },
    {
      "phase": "on",
      "policy": {
        "networkAccess": true
      }
    }
  ],
  "refusedTurns": 2,
  "tasks": {
    "off": {
      "intentId": "9d8a6884-4042-4fa0-8d96-fbaa4237c07d",
      "state": "completed",
      "reason": null,
      "result": "curl: (6) Could not resolve host: registry.npmjs.org\n000 exit=6",
      "recorded": false
    },
    "on": {
      "intentId": "626e4de3-1717-445a-bac1-e3c1fffecb9c",
      "state": "completed",
      "reason": null,
      "result": "200 exit=0",
      "recorded": true
    }
  },
  "pass": true,
  "cleanup": {
    "serviceStopped": true,
    "processExit": "verified",
    "fixtureRemoved": true
  },
  "failure": null
}
```

## Limits

This shows that Codex command network access follows the per-turn value Ensemble sends. It is not a sandbox claim: Ensemble enforces only what it sends, and MCP and app tools, web tools and model transport are separate surfaces.
