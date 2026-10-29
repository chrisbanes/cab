# cab

cab coordinates agents working on tasks within projects. Agents decide
how work proceeds; cab owns durable coordination.

## Language

**Operator CLI**:
A command-line interface through which the operator or an external agent acting
on their behalf inspects and manages cab. It is distinct from the tools
used by an assignee to carry out its assignment.
See the [accepted operator CLI contract](docs/design/operator-cli.md).
_Avoid_: Agent callback interface

**Attention inbox**:
A cross-project collection of unresolved questions, approvals and problems requiring operator action, including an execution runtime whose automatic restarts are exhausted.
Routine progress and completed work that needs no decision belong outside this inbox.
_Avoid_: Notification feed or conversation history

**Push subscription**:
A browser's opt-in to attention notifications, created in Settings → Notifications and
revocable there. Each new Inbox alert, including an exhausted runtime, becomes one
minimal push to every active subscription: a title and a link to the Inbox, never its
content. The Inbox stays the only source of truth.
_Avoid_: Notification feed

**Project**:
A container for tasks, optional linked repositories, agent profiles, instructions, and permissions.
Its identity belongs to cab and is independent of the application hosting it.
_Avoid_: Board or GitHub Project when referring to the cab container

**Task**:
A piece of work belonging to one project, created locally or linked to an external item.
_Avoid_: Issue when referring to work independently of its external provider

**Readiness condition**:
One test of a project's readiness rule: a label the issue has or lacks, or a Project field whose
value is in or not in a set of options. A rule is a flat all/any list of them.
_Avoid_: Readiness filter

**Task dependency**:
A directed relationship in which a task's work depends on another task or an
external work item. It is distinct from readiness, source membership, and
dependencies between assignments within a task.
_Avoid_: Assignment dependency when referring to a relationship between tasks

**Project pause**:
An operator hold on a project that lets active turns finish while holding its
queued and new turns. Pause belongs to the project; a task has no pause of its own.
_Avoid_: Task pause

**Task stop**:
An operator hold on an open task that holds its pending work and requests
best-effort cancellation of its active executions. It is neither cancellation
nor completion, and it does not apply to a finished task.
_Avoid_: Cancel or abort when referring to a stop

**Shutdown requeue**:
The fresh generation that planned shutdown queues for a task turn it interrupted
and recorded as ended: the same request resumes the same thread on the next start
under every current admission check. It is not a retry and does not use the
transient-retry allowance. Any turn shutdown could not record as ended keeps its
restart hold.
_Avoid_: Retry when referring to a restart

**Closure hold**:
The hold on an imported open task whose external item was closed without
cab delivering it. It is distinct from a project pause. An own closure that a
reopen superseded no longer exempts the task.
_Avoid_: Paused when referring to an externally closed task

**Task source**:
A project-scoped origin of tasks: built-in local creation or a configured external source supplied by a plugin.
_Avoid_: Project when referring to a source such as a GitHub Project

**Issue tracker**:
An external system that holds work items a task source imports and cab
writes progress, status and closure back to, such as GitHub Issues or Jira.
_Avoid_: Source when referring to the external system rather than the project's task source

**Code host**:
An external system that hosts a linked repository's remote, receives task
branches and reviews change requests, such as GitHub or a GitLab instance.
_Avoid_: Forge, Git provider

**Repository link**:
A project's binding of a local checkout and base ref to one repository on a code
host. It belongs to the project, independently of any task source, and grants
access only to that repository.
_Avoid_: Source repository when referring to a project's linked repository

**Change request**:
A code host's request to merge a task branch into its base: a GitHub pull request
or a GitLab merge request.
_Avoid_: PR or MR when not referring to a specific code host

**External reference**:
The stable identity of a task's corresponding item in an external system, independent of which sources discover it.
_Avoid_: Source configuration when referring to external task identity

**Task publication**:
The operator creating an external item from a local task, so that the same task
takes the item's external reference and becomes imported.
_Avoid_: Export or sync when referring to creating the external item

**Status mapping**:
A project's rules for which external status option cab writes when its own
work reaches a given point. It reflects cab work back to the external system
and never makes a task Ready.
_Avoid_: Board sync or column mapping

**Drafting run**:
A run belonging to a project rather than a task, in which the project lead
proposes either a task title and outcome from the operator's rough idea, or an
improved title and body for an imported issue from the text it was synced with.
It changes nothing until the operator accepts and sends the result.
_Avoid_: Draft task, which is an unready task

**Draft turn**:
A project-lead turn the operator starts on a task that is not Ready, limited to
investigating and talking with the operator. It grants no readiness and carries
out no implementation.
_Avoid_: Triage turn

**Start again**:
The operator action that queues an assignment's request again when it was refused at
admission before it ran, at the current revisions. The refused request stays as history.
_Avoid_: Retry, which resends work that may have run

**Reset task**:
The operator action that replaces every assignment's conversation and starts the project
lead fresh in the same workspace. The old conversations and the workspace stay readable;
it is not undone.
_Avoid_: Restart, which a runtime does to a process

**Project lead**:
The agent accountable for task outcomes across a project, including coordination,
planning and allocation exceptions. Delegating work does not transfer that accountability.
_Avoid_: Task owner as a separate accountability role

**Agent profile**:
A reusable, operator-defined identity and instructions, selected for project leads and task assignments. Its execution settings are validated for the selected runtime.
_Avoid_: Bot identity or assignment when referring to reusable configuration

**Assignment**:
A durable unit of work delegated to an agent within a task that can continue across agent conversations.
_Avoid_: Step when referring to delegated work

**Assignment assignee**:
The agent tasked with carrying out an assignment and returning its result.
_Avoid_: Task owner when referring to the agent executing an assignment

**Follow-up**:
An explicit request that continues a completed assignment with new instructions,
keeping its identity and history as newer work. An operator follow-up sends
feedback to a task's completed project lead while the task is still open; it
never reopens a done task.
_Avoid_: Reassignment or a new assignment when the same assignment continues

**Agent conversation**:
The interaction history used by an agent to carry out work. An assignment can continue across replacement conversations.
_Avoid_: Assignment when referring only to its conversation history

**Execution runtime**:
The agent harness or execution engine that carries out admitted agent turns and
reports their observations to cab.
_Avoid_: Scheduler when referring to the system executing one agent turn; runtime provider

**Disabled runtime**:
An execution runtime the operator has turned off for the installation. Disabled is
one cause of a runtime being not enabled; a missing binary is the other. An enabled
runtime that fails to start is unavailable, not disabled or not enabled.
_Avoid_: Not enabled when meaning the operator's choice

**Credential reference**:
Where the service reads a credential, never the credential itself. `env:NAME` names
a service environment variable; `file:/absolute/path` an owner-only file (Claude
token only); `gh:github.com` the GitHub CLI's login for github.com (discovery or
an explicitly configured project source), read per use without caching;
`glab:<host>` the GitLab CLI's login for that host (an installation GitLab
credential, which is also the identity GitLab branch delivery acts as), likewise read per use. GitHub
delivery and routing references remain env-only. Reads report whether a reference is configured
and usable and its kind, never its variable name, path or value.
_Avoid_: Token or secret when referring to the stored reference

**Execution binding**:
The association between an assignment and its runtime-specific session or process
identity and validated execution settings.
_Avoid_: Assignment identity when referring only to an execution session

**Task workspace**:
The working files allocated to a task, retained independently of its conversations.
A local task's holds the project's repository links; an imported task's holds its source
repository.
_Avoid_: Conversation when referring to a task's working files

**Task branch**:
The one branch cab assigns a task in each repository and pushes its commits
to; agents cannot choose or push it. A change request for the task uses it as its head.
A remote head on it that cab did not push is an outside change.
_Avoid_: Head branch when meaning the assigned, cab-published branch

**Outside change**:
A task branch head that cab did not push, or a deleted branch, seen at a push or
on the task's change request. Plain pushes are refused and completion held until the lead recovers
the branch, with the operator's approval, by overwriting the outside head or adopting it.
_Avoid_: Outside push

**Branch adoption**:
The recovery that records an outside head as the task branch's last push after proving
it descends from the task's provisioned base, without moving the task workspace. The
agent then integrates the outside commits offline and pushes on top of the adopted head.
_Avoid_: Merge or sync when meaning the record cab keeps

**Current workspace contents**:
The files observed in a task workspace at an identified inspection time. They may
change as work continues and do not represent a historical result.
_Avoid_: Result revision when referring to the files currently present

**Retained result evidence**:
The bounded file contents and diffs preserved for a particular recorded result,
remaining attributable to it after the task workspace changes or is removed.
It is not a snapshot of the whole task workspace.
_Avoid_: Workspace snapshot when referring only to result-linked evidence

**Code review**:
A batch of operator line comments and an optional summary sent together to a
task's accountable project lead. It is local feedback, not a code host review or
an approval or completion decision.
_Avoid_: Approval when referring to submitted review feedback

**Review anchor**:
The exact task, repository/file content, line range and applicable diff side
that a review comment addresses. Later file changes do not move the anchor.
_Avoid_: Current line number when referring to historical reviewed content

**Local review**:
A code review composed and sent inside cab, with no code host involvement.
It is delivered to the accountable project lead as one operator message.
_Avoid_: Change request review

**Review draft**:
The unsent summary, comments and anchor groups an operator session is composing
for a task. It belongs to that session and is frozen while sending and once sent.
_Avoid_: Saved review when referring to unsent text

**Anchor group**:
The review anchors captured together for one comment, kept or discarded as a
unit. Sending seals the groups into submitted context.
_Avoid_: Selection when referring to the retained, sealed anchors

**Review operation**:
One frozen send of a review draft, identified by the operator's command key. It
ends as recorded (the message was queued), rejected (definitively not sent) or
not-recorded (fenced by reconciliation); until then it is prepared and its
outcome is unknown.
_Avoid_: Delivery when the outcome is unknown or not recorded
