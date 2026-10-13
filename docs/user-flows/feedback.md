# Action feedback

**Status:** implemented for configuration saves in Settings: projects, profiles,
routing, GitHub source, sync preview and placement, discovery credential, Claude
token, capacity and project setup. They share `web/src/action-feedback.tsx`: one
message per save, with the receipt in a collapsed Details disclosure. Planned: the
task composer, Stop and Resume, question answers, approvals, replies, comment
review, local review, sign-out and CLI credentials, and the read-only status, empty
and error copy. Those surfaces still use receipt vocabulary and raw codes in their
messages.

## Goal

Every operator action produces one message, sized to its outcome, in plain language
that says what happened and what, if anything, to do next.

## Applies to

Every write in the operator UI: configuration saves (projects, profiles, routing,
sources, sync preview and placement, discovery credential, Claude token, CLI
credentials, capacity, recovery), project setup, the task composer, task Stop and
Resume, question answers, approvals, replies, comment review, local review and
sign-out. The wording rules also apply to read-only status, empty and error copy.
Sign-out has no receipt and ends the session before it returns: an unconfirmed
sign-out re-reads the session, treats signed out as success, and shows no Details.
The operator CLI keeps its receipt output.

## Before the action

- The change list ("Changes to save") is the confirmation. Consequences belong here,
  in plain words: "Nothing resumes. fixture-app stays Paused."
- A confirmation dialog only for actions that are hard to undo or remove access
  (removing all repository access, Stop, revoking a credential). Use one
  confirmation per action: a dialog, or a confirm checkbox in the change list, never
  both and never an extra alert repeating it.
- A dialog states the consequence in one or two sentences.

## Outcomes

| Outcome              | Shown as                                                                | Example                                                                                  |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| In progress          | The action's label only                                                 | "Saving…"                                                                                |
| Succeeded            | One quiet inline line by the action, then the panel's saved time        | "Saved. Routing now uses Ada and Eli."                                                   |
| Rejected             | One error alert naming the cause; field errors name the fix             | "Couldn't save: ref mian doesn't exist in fixture-org/app. Your changes are still here." |
| Changed elsewhere    | One warning alert with one action                                       | "A newer version was saved elsewhere. **Review changes**"                                |
| Unknown              | One warning alert with one action; other edits stay blocked             | "We couldn't confirm the save. **Check whether it saved**"                               |
| Succeeded, will wait | The success line plus the wait reason and its Fix, never a second alert | "Task created. It will wait: fixture-app is Paused. **Resume project**"                  |

- One message per action. The shared save control owns it; pages and panels do not
  add their own copy of the same outcome.
- A success line replaces the previous outcome message for that action, and clears
  when the operator edits again.
- Success messages carry no caveats. Warnings belong to the outcomes they describe.
- Success is never silent. When a form closes on save, the row it returns to shows
  the saved line.
- In progress shows one indicator: the button label, or one status line when the
  action has no button. Never both.
- "Check whether it saved" resubmits the exact original request, so it never
  duplicates an effect.
- CLI credential create and rotate have no request key, so resubmitting would
  issue another credential. Their unknown outcome offers **Check the list**, which
  re-reads the credentials instead of resubmitting.

## Details

Each outcome message has a collapsed **Details** disclosure with the receipt:
command, resource ID, version, request key and any error code. Messages never show
these in their text. Details are copyable for support and debugging. The same
applies to read-only screens: hashes, comparison and operation IDs, raw states and
reason codes move into Details or metadata, and the visible line says what it
means.

## Wording

- Name what changed in the operator's terms: project, profile, repository, task.
- Avoid service vocabulary in messages: recorded, receipt, observation, admission,
  reconcile, submission, revision (say "version" only in Details).
- Say whether input is safe on every failure: "Your changes are still here."
- Use sentence case and no more than two short sentences.

## Recovery

Unchanged: rejected and conflicting saves keep input; an unknown outcome blocks
further edits until checked; Stop and Resume keep their existing semantics.
