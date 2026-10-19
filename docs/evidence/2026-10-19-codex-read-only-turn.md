# Codex read-only turn on a workspace-write thread, 19 October 2026

Bounded live proof for issue #1193 (draft turns). It checks that Codex App Server honours
a per-turn read-only `sandboxPolicy` on a thread started with `sandbox: "workspace-write"`,
and that a later turn on the same thread with the ordinary `executionPolicy` can write.
The probe is `test/execution/runtime-qualification/read_only_turn_probe.py`; CI does not
repeat it.

## Runtime and policy

- Launcher: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`,
  `codex-cli 0.163.0-alpha.10.2`, already logged in with ChatGPT. No credential or
  configuration was read or printed.
- The policy shape came from `codex app-server generate-json-schema` for that CLI
  (`SandboxPolicy` in `TurnStartParams`): a `readOnly` variant with an optional
  `networkAccess` (default false).
- Read-only policy used for draft turns: `{"type": "readOnly", "networkAccess": false}`.
- Thread start used `sandbox: "workspace-write"` and `approvalPolicy: "never"`, as
  `CodexRuntime` does. The ordinary turn used the `executionPolicy(workspace)` shape.

## Runs

| Step                                                        | Model call | Outcome                                                                                                                            |
| ----------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `command/exec` with the read-only policy, no model          | No         | Policy accepted; write in `cwd` denied; read of a marker file succeeded; the same write under the workspace-write policy succeeded |
| Attempt 1: turn A (read-only) then turn B (workspace-write) | Yes        | All conditions true. The probe did not yet record command output, so the marker read was inferred from exit code 0                 |
| Attempt 2: same, probe now records output                   | Yes        | All conditions true, with the denial message and marker observed                                                                   |

Two model attempts were used of the two allowed; none remain. Each attempt used a fresh
disposable root, which is outside the repository.

Attempt 2 summary (attempt 1 differs only by lacking `turnAMarkerRead`):

```json
{
  "codexVersion": "codex-cli 0.163.0-alpha.10.2",
  "policy": { "type": "readOnly", "networkAccess": false },
  "policyAccepted": true,
  "execWriteDenied": true,
  "readAllowed": true,
  "execControlWrites": true,
  "turnAStatus": "completed",
  "turnAWriteAbsent": true,
  "turnBStatus": "completed",
  "turnBWritePresent": true,
  "turnAMarkerRead": true,
  "turnAAttemptedWrite": true
}
```

Turn A's command item ran `touch probe-a; cat marker` and reported
`touch: probe-a: Operation not permitted` followed by the synthetic marker. Turn B ran
`touch probe-b` on the same thread and the file exists afterwards.

## Limits

- This proves the per-turn write denial and that the next turn on the thread is not
  left read-only. It does not prove that reads are confined: Codex keeps broad host
  reads under a read-only policy, and Ensemble claims no independent sandbox.
- One Codex version, one model, two attempts. Network denial is requested by the policy
  but was not separately probed here.
- The Claude read-only path is covered by fake-SDK tests of its changed options, not by a
  live run.
