# Workspace maintenance

**Status:** manual removal is built. The task page's Remove workspace… action and
`cab task workspace-remove` remove a done or cancelled task's workspace, and the task
page and `cab task show` show the latest removal and trim records. The automatic
maintenance pass (idle trimming, delivered and merged retention, the disk cap and its
Inbox item) is planned; nothing schedules trimming or removal yet. The flow is covered
by `test/operator/operator-task-workspace-remove-browser.test.ts` at 1366 × 900 and
390 × 844.

## Goal

The operator frees a finished task's disk space without losing its delivered work,
and can later see when and why a workspace was removed or trimmed.

## Entry points

- Task header: Remove workspace… beside Edit task… from 760px; in Task actions on a
  phone. Offered while a done or cancelled task has a workspace that is not removed.
- Operator CLI: `cab task workspace-remove TASK_ID [--request-id UUID]`.
- Records: Task details on Overview (Workspace), `cab task show TASK_ID` or
  `cab task get TASK_ID`.

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
- A removal that stopped part way stays held with its operation ID and is not retried;
  it needs reconciliation.
