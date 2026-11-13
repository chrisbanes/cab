---
status: accepted
---

# Escalate single commands through the harness

A project's verification needs host tools that the harness sandbox blocks, such as Chromium and
Android emulators ([ADR-1029](1029-skip-sandbox-for-host-tools.md)). Skipping the sandbox unblocks
them by removing confinement for every command of every task turn. #1585 proposed a cab tool that
runs operator-declared checks outside the sandbox instead.

Both harnesses already let an agent ask to run one command outside the sandbox and have that request
approved or reviewed. Codex's app server accepts a granular approval policy that prompts only for
sandbox escalations, and a per-turn `approvalsReviewer` of `user` or `auto_review`; `auto_review`
has a reviewer subagent approve or deny each escalation with a risk level and rationale. Claude
Code runs a Bash call with `dangerouslyDisableSandbox` outside its sandbox when
`allowUnsandboxedCommands` is on; its `auto` permission mode has a model classifier decide, and
`canUseTool` hears what it cannot. cab disables all of this today: Codex runs with approval policy
`never`, Claude with `dontAsk` and `allowUnsandboxedCommands: false`, and cab's PreToolUse hook
refuses `dangerouslyDisableSandbox`.

## Decision

A per-project **sandbox level** replaces `dangerouslySkipSandbox`. It is a versioned
`project.configure` field that only the operator changes, in Settings or with `project prepare`,
recorded when a turn is admitted like local listening
([ADR-1027](1027-local-listening-for-test-fixtures.md)). It applies to every task turn of the
project; draft turns, drafting runs, read-only turns and turns without a task binding stay
`strict`.

| Level | Escalation |
| --- | --- |
| `strict` (default) | Refused, as today. |
| `escalate-approval` | Each escalation waits for the operator in the Inbox. |
| `escalate-auto-review` | The harness reviewer decides each escalation. |
| `unsandboxed` | No sandbox, as ADR-1029's skip sandbox. Turning it on in Settings needs the same risk confirmation. |

A store migration maps `dangerouslySkipSandbox: true` to `unsandboxed`, everything else to
`strict`, and removes the old field. `--dangerously-skip-sandbox` is replaced by a level flag.

- **Codex.** At the escalate levels a task turn sends the granular approval policy with only
  `sandbox_approval` enabled, so rule, skill, permission and MCP prompts stay refused. The reviewer
  is `user` at `escalate-approval` and `auto_review` at `escalate-auto-review`. cab answers an
  escalation only with `accept` or `decline`, never `acceptForSession` or an execpolicy amendment,
  so no approval outlives its request or reaches other threads.
- **Claude Code.** At the escalate levels a task turn runs in `auto` permission mode with
  `allowUnsandboxedCommands: true`. `dontAsk` is not used for escalated calls, because it refuses
  them even after the hook allows them. Bash leaves `allowedTools`, because an allow rule would
  decide an escalated call before the hook and the classifier. Sandboxed Bash still runs through
  `autoAllowBashIfSandboxed`. A turn whose model lacks auto mode waits with a named reason and is
  never downgraded. An escalate turn whose start reports another permission mode fails, and its
  hook refuses escalated Bash until the start confirms `auto`. Claude Code does not start in
  `auto` with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, so escalate turns run without the
  subprocess environment scrub: sandboxed Bash there can read the service's credential-filtered
  environment. Strict, draft and read-only turns keep the scrub.
  - **At `escalate-approval`:** the PreToolUse hook holds each Bash call with
    `dangerouslyDisableSandbox` for the Inbox. Its matcher has a 960-second timeout and
    `onFailure: "block"`, so the service's 15-minute expiry answers first, and a hook timeout or
    failure refuses the call rather than passing it to the classifier.
  - **The classifier after an approval:** the hook's `allow` is not shown to stop the classifier
    from deciding the call, so Claude's classifier can still refuse a call the operator approved.
    If the classifier asks `canUseTool` about an accepted call, cab allows that one call once, so
    no second Inbox item opens.
  - **At `escalate-auto-review`:** the hook still denies every call outside today's allowlist
    before the classifier sees it, so the classifier decides only escalated Bash. Undecided calls
    reach the Inbox through `canUseTool`. Claude Code reports no classifier decision as such:
    cab records an approval when an escalated call runs with no `canUseTool` callback, and a
    denial from a `permission_denied` message whose reason type is `classifier`. Neither has a
    risk level, and only Claude Code's reason is kept as a denial's rationale.
  - **Bash timeouts:** at the escalate levels and `unsandboxed`, a Bash call can request up to
    60 minutes. A timed-out command moves to the background and keeps running, so the request
    ceiling does not bound execution.
- **Operator approval.** The Inbox item shows the command, working directory, the agent's reason
  and the workspace identity (HEAD, branch, uncommitted-changes flag). The operator approves or
  declines that one request; there are no remembered rules. A request unanswered after 15 minutes
  is declined and its Inbox item resolves as expired. The turn holds its slot and writer while it
  waits.
- **Reviewer denials.** A Codex `auto_review` denial offers an Inbox overrule that calls
  `thread/approveGuardianDeniedAction`. It is advisory: Codex tells the agent the exact action is
  approved, and the agent's retry is reviewed again. Claude classifier denials have no overrule.
- **Evidence.** cab records each escalation on the task and shows it in the task and the CLI:
  command, working directory, workspace identity, who decided (the reviewer with its risk level and
  rationale, or the operator), the decision, exit code and duration. Output stays in the agent
  conversation; cab keeps no copy ([ADR-1033](1033-results-reference-git.md)).
- **Where it runs.** An escalated command runs in place in the task workspace, synchronously
  inside the agent's turn, as a child of the harness. A dirty workspace is allowed; the evidence
  records it.
- Every surface that shows the effective policy states the level and its risks, per harness.

Implementation is gated on live qualification in both harnesses: `strict` refuses escalation;
approval, decline, expiry, reviewer approval and denial and the Codex overrule behave as above;
Claude's PreToolUse hook runs before its classifier; an approved command runs outside the sandbox;
and the reviewer decisions cab records are observable. A behaviour that fails or cannot be observed
is recorded as a limit before the level ships.

The Claude probes ([2026-11-11](../evidence/sandbox-escalation-probe-2026-11-11.md),
[2026-11-12](../evidence/2026-11-12-claude-auto-hook-allow-probe.md)) found:

- `dontAsk` refuses an escalated call that the hook allowed.
- Under `auto`, unflagged Bash runs sandboxed, and a call the hook held for 75 seconds and then
  allowed ran outside the sandbox.
- The installed Claude Code honours `onFailure` and reports `supportsAutoMode` for each model.
- No per-call classifier signal was observable, so whether the classifier also decides a
  hook-allowed call is a recorded limit.
- The 15-minute hold and the 60-minute ceiling are inferred from bounded runs.

## Threat model

An escalated command acts with the service user's full filesystem, process, network and credential
access. It usually runs code the agent wrote, such as a test suite or build script, so neither
reviewer can contain a hostile or prompt-injected agent: they judge the command they see, not the
code it runs. The escalate levels narrow what runs unsandboxed to commands the agent explicitly
requested and someone approved, and record each one. They are not a boundary against an agent the
operator does not trust.

- Processes an escalated command starts, such as emulators and browsers, can outlive the turn.
  They belong to the harness, and cab does not clean them up, as in ADR-1029.
- cab respects the operator's own harness configuration and does not police it. Codex execpolicy
  `allow` rules in `$CODEX_HOME/rules`, or in a project's `.codex/rules` when the operator trusts
  that path, run matching commands outside the sandbox without a cab decision. An escalated
  command can write such a rule and so escalate later commands in every project.
- `auto_review` and Claude's `auto` mode cost extra model calls and depend on the account and model
  offering them.
- Only macOS is qualified.

## Considered options

- **A cab verification tool (#1585's proposal).** cab would run operator-declared checks outside
  the sandbox and record results against an exact head. Rejected: the check still runs code the
  agent wrote, so it contains no more than an escalation does, and it needs its own declaration
  surface, process supervision, asynchronous delivery and evidence store that the harnesses
  already provide or make unnecessary.
- **Remembered exact or prefix rules.** Rejected. Codex loads execpolicy rules only from system,
  user and trusted-project configuration, never per thread, and under `auto_review` it rarely asks
  the client, so cab could not apply its own rules consistently. A matched command text also
  says little about the agent-edited scripts it runs.
- **Keep skip sandbox as a separate field.** Rejected for one ordered setting that shows every
  level of host access in one place.
- **Wait indefinitely for the operator.** Rejected. A waiting turn holds a slot and its writer.
- **Clean up escalated processes.** Rejected. Neither harness reports the processes reliably, and
  cab never kills a shared Codex App Server ([ADR-1032](1032-cab-proves-operator-confirms.md)).

## Consequences

- Task turns of a project at an escalate level can run browsers and emulators while every other
  command stays sandboxed.
- `dangerouslySkipSandbox`, its CLI flag and their documentation are replaced by the sandbox level.
  The parts of ADR-1029 that define skip sandbox's scope, threat model and harness settings carry
  over to `unsandboxed`.
- cab takes harness approval traffic it refused before, so the approval paths owned by S02 (#689) and S05 (#695)
  must be qualified for these decisions, not only for refusal.
- `docs/SPEC.md`, `CONTEXT.md`, the operations guide and the operator UI change with the
  implementation.
