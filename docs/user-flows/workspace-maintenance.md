# Workspace maintenance

**Status:** built. The task page's Remove workspace… action and
`cab task workspace-remove` remove a done or cancelled task's workspace, and the task
page and `cab task show` show the latest removal and trim records. The automatic
maintenance pass trims and removes under the installation limits and raises one Inbox
item when it cannot meet them. Manual removal is covered by
`test/operator/operator-task-workspace-remove-browser.test.ts` at 1366 × 900 and
390 × 844, and the Inbox item by
`test/operator/operator-workspace-maintenance-browser.test.ts` at 1366 × 900.

## Goal

The operator frees a finished task's disk space without losing its delivered work,
and can later see when and why a workspace was removed or trimmed.

## Entry points

- Task header: Remove workspace… beside Edit task… from 760px; in Task actions on a
  phone. Offered while a done or cancelled task has a workspace that is not removed.
- Operator CLI: `cab task workspace-remove TASK_ID [--request-id UUID]`.
- Records: Task details on Overview (Workspace), `cab task show TASK_ID` or
  `cab task get TASK_ID`.
- Automatic: the Inbox's Workspace maintenance item (Request kind: Workspace
  maintenance), the Overview card that leads to it, a browser notification once per
  active episode, and `cab inbox list`.

## Steps

1. Remove workspace… opens one confirmation on Cancel. It lists what goes (each
   repository's worktree with its ignored files, scratch, other workspace-root files and
   the Claude temporary directory) and what stays (the task branch at its pushed commit
   in each repository, change requests, results and conversations), and says removal
   cannot be undone. Escape or Cancel returns to the action.
2. Remove workspace sends the command for the workspace the dialog was opened for. cab
   checks again, pushes committed but unpushed work to the task branch through normal
   delivery, and only then deletes.
3. On success the dialog says the workspace was removed and Close returns focus to the
   header. Task details shows "Workspace removed TIME (manual)" with each repository's
   pushed branch and commit, or "no task commits beyond" its base. Files and Changes say
   the workspace was removed; results and the conversation stay readable.
4. A later turn, or a reopened task, gets a new workspace at each repository's recorded
   commit. The removal record stays.

## Budget

| Entry point | Interactions to removal | First screen must show |
| --- | --- | --- |
| Task header (desktop) | 2 (Remove workspace…, Remove workspace) | what goes, what stays and that it cannot be undone |
| Task actions (phone) | 3 (Task actions, Remove workspace…, Remove workspace) | the same confirmation |

The operator CLI is outside the budget: it has no screens.

## Recovery

- A refusal keeps the dialog open with cab's reason, such as uncommitted work, unsettled
  execution or a refused push; nothing is deleted. Review current state closes it. To
  discard unwanted work, reset the task first; there is no force.
- A lost reply keeps the exact request: Check whether it saved sends the same key, and
  the service returns the original receipt without deleting anything again. The CLI
  reads a reused key back with `operation get` before sending.
- A confirmation left open while the task got a new workspace names the old one, and the
  service refuses it; the new workspace is untouched.
- A trim that stopped part way (a crash, a cancelled shutdown or an unreadable file)
  blocks nothing: the next turn is told some ignored or scratch files may be gone, and a
  later trim or removal runs normally.
- A removal that stopped part way stays held with its operation ID and is not retried.
  The task shows "Workspace maintenance in progress" and cannot run, the workspace shows
  as held, Remove workspace refuses because the workspace is held (a retry of the same
  request names the operation), and the Inbox item lists it once its retention has
  passed. cab has no command that reconciles it;
  this is a known limit, and the workspace and its journal need inspecting by hand.

## Automatic maintenance

The service applies the four installation limits
([configuration](../operations/standalone-macos.md#workspace-maintenance-configuration))
without an operator step: it trims a workspace after the idle limit, removes a done or
cancelled task's workspace after its delivered or merged retention, and over the disk
cap trims and then removes eligible workspaces oldest idle first. Records show the
trigger: "Trimmed TIME (idle limit)" or "Workspace removed TIME (delivered retention)".

When usage stays over the cap after a pass, or a workspace past its retention was
refused, the Inbox has one Workspace maintenance item:

1. The queue lists it under Intervention with what is unresolved, such as "Task
   workspaces use 12.3 GB, over the 10.0 GB disk limit". A project filter hides it.
2. Selecting it lists the blocking workspaces in two groups, Over the disk limit and
   Past retention, not removed, each by task and project with cab's reason, such as
   uncommitted work or unsettled execution.
3. A task link opens that task's page only; Back returns to the item with the Inbox
   filter and other drafts as they were. After a refusal, cab waits before trying the
   same workspace again: from 5 minutes, doubling to an hour, unless the task, its
   delivery policy, a turn or a push changes first. Removing the workspace by hand acts
   at once.
4. The next pass refreshes the same item. Once usage is within the limit and no expired
   workspace is refused it resolves on its own; it cannot be dismissed. A recurrence
   brings the same item back, with one new notification.
