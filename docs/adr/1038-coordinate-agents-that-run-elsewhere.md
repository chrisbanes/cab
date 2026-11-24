---
status: accepted
---

# Coordinate agents that run elsewhere through claimable tasks

cab organises each task as a tree. A project lead owns the outcome, delegates assignments,
and has to approve completion. cab runs every turn itself, through Codex App Server or
Claude Code. That shape fixes a working method in the product, even though
[ADR-1001](1001-agent-coordination-architecture.md) says the method belongs in agents'
instructions:

- Only the lead can add work, and only as a tree. Agents can't create tasks or
  dependencies ([ADR-1002](1002-task-dependency-authority.md)).
- An agent does nothing until an assignment wakes it.
- Running every turn makes cab responsible for task workspaces, capacity, Stop, recovery
  holds, sandbox policy and the host's sleep. Most of the open qualification work is
  there.

Meanwhile the hosts agents run on already provide execution and triggers. Orca bots wake
on GitHub, Slack and Linear events and on schedules. T3 Code runs agent threads. Claude
Code and Codex run from the command line. [Vercel Board](https://vercel.com/blog/introducing-vercel-board)
shows a different shape for coordinating them: agents running anywhere claim tasks on a
shared board, with leases, dependencies and threads.

## Decision

cab becomes a coordination service for agents that run elsewhere. It runs no agent turns.
It keeps the record of the work and the operator's attention: tasks and their
dependencies, claims, threads, the Inbox, the GitHub and Jira task sources, and the
operator interface.

### Tasks and dependencies

- **Where tasks come from.** Imported issues, which are claimable only once the project's
  readiness rule passes, as today. Tasks the operator creates. Tasks agents create.
- **What an agent in a project can do.** Membership is the grant. An agent can read and
  post in the project, claim any claimable task, create tasks, and add or remove local
  dependencies. It can't remove a blocker from a task it has claimed. Imported issues keep
  GitHub's native relationships as the authority for their dependencies.
- **New tasks.** A task an agent creates is Ready, and claimable once nothing blocks it.
- **Splitting work.** There is no parent or child state. An agent that splits a task makes
  the original depend on the new tasks. The original becomes claimable again once they're
  done, and finishes under its own done rule.
- **Root tasks and the creation cap.** An imported issue or an operator-created task is a
  root task. Tasks created beneath a root task count against its creation cap, which a
  project can change. At the cap, cab refuses further creation and raises an Inbox item.
- **Sub-issues.** A project setting, off by default, publishes tasks created beneath an
  imported GitHub issue as sub-issues of it. Tasks beneath a local root stay in cab.
- **Task references.** Each task has a short per-project reference, such as `HAZE-12`, that
  people and agents can type.

### Claims

- **Claimable.** A task is claimable when it's open and Ready, has no open local or imported
  blocker, belongs to a project that isn't paused, and has no active claim.
- **Claiming.** Claiming is atomic. A claim is a lease that the claimant renews while it
  works. Renewing, completing or releasing needs the current claim, so an agent whose lease
  expired can't complete a task someone else has since claimed.
- **Claim limit.** An agent holds one active claim at a time by default. The operator can
  raise the limit per agent.
- **Expiry.** When a lease expires, the task returns to the pool and cab posts a note in
  its thread. The next claimant reads the thread, including any branch or PR the last one
  reported. An open question from the claimant pauses the lease until the operator answers.
- **Done rule.** Each project chooses one: a task is done when its claimant completes it,
  or when its linked PR merges. Under either rule, a task with no linked PR is done when its
  claimant completes it.
- **Issue closure.** When an imported issue closes as completed, its task is done. When it
  closes as not planned, its task is cancelled, along with the open tasks created beneath
  it. Their claims are released. cab never closes issues; agents' PRs do.
- **Project pause.** A paused project refuses new claims and new tasks. Existing claims run
  until they're completed or expire. Events still flow, so questions can be answered.

### Threads, questions and approvals

- Each task has a thread, and each project has one channel. The operator and agents post in
  both.
- Mentioning an agent sends it an event. Mentioning the operator raises an Inbox item.
- Agents ask questions and request approvals through the CLI. They appear in the Inbox, and
  the answer or decision is delivered to the agent that asked. Approvals are advisory: cab
  records and delivers the decision, but doesn't enforce it.

### Waking agents

- **Event feed.** Each agent has a durable event feed with a cursor. Events are: a
  claimable task, a mention, an answer to its question, and a decision on its approval.
  An event is a notification; cab decides who gets a claim at claim time.
- **Schedules.** A recurring task in cab becomes a Ready task at its time and is claimed
  like any other.
- **Wrapper.** `cab agent run --as <agent> -- <command>` waits on the feed and runs the
  command once per event, with the event on stdin and its ID as an idempotency key. A host
  that only polls reads the same feed. The first hosts are:
  - Orca: `orca automations run <id>` on a bot automation, after which the bot reads its feed.
  - T3 Code: `t3 thread start` or `t3 thread send`.
  - Command line: `claude -p` or `codex exec`.
- **PR feedback.** cab doesn't deliver review, CI or conflict events. Orca bots wake on
  those GitHub events themselves.

### Agents and credentials

- An agent is an identity registered in cab, with project memberships. cab stores no
  instructions or execution settings for it. An agent's role instructions live on its
  host, and project conventions live in each repository's `AGENTS.md`.
- Each host has one revocable credential. It acts only as the agents registered to it,
  named on each call with `--as`. Any other name is refused.

### GitHub and Jira

- Agents do all code-host work with their own access: branches, pushes, PRs, comments and
  merges.
- cab writes only for [task publication](1018-task-publication-in-place.md) and
  [status mapping](1024-status-mapping-write-authority.md). Status mapping's four events
  become: first claimed, PR linked, waiting on the operator, and done.
- **Linking PRs.** An agent links its PR with `cab task link-pr <url>`. cab also links PRs
  whose closing references name an imported issue, and PRs whose body contains
  `cab: <task reference>`. cab checks that the PR belongs to one of the project's
  repositories, then watches it only for merge and close.
- cab fetches a read-only copy of each linked repository, for diffs and review in the
  operator interface. There are no task workspaces.
- Stacking is removed. Events include the linked PRs and branches of a task's blockers, so
  an agent can stack if its instructions say to.
- Jira task sources are unchanged.

### Operator interface

List and Board group tasks as Blocked, Ready, Claimed, Waiting on you and Done. A task page
centres on its thread, with its dependencies, linked PR and changes from the read-only copy.
The Inbox, the project channel and an Agents page (claims, last seen, unread events)
complete it.

### Removed

- **Execution:** the Codex and Claude Code runtimes, task workspaces and their managed
  repositories, capacity and writer limits, Stop, recovery holds, held-turn release,
  leftover execution, conversation capture and history, reasoning summaries, sandbox levels
  and escalation, runtime restarts, and the task execution allowance.
- **The lead tree:** project leads, assignments, delegation and withdrawal, follow-ups,
  routing, permitted agents, lead-gated completion, results and result review requests.
- **Agent-driven delivery:** guarded external actions, delivery intents and receipts, PR
  registration and restack requests.
- **Instructions in cab:** project and agent instructions, their revisions, instruction
  proposals and private-instruction redaction.
- **Features that run agent turns:** Draft with lead, Draft turns, Improve with lead,
  Start again and Reset task.

### Where it runs and how it's built

- cab runs on tower, an always-on home server, so it no longer depends on a Mac staying
  awake. It needs no Codex or Claude login. cab's service install targets macOS launchd,
  so running on tower needs a Linux deployment.
- cab evolves in place, on a fresh database. The schema resets to a new baseline, and the
  new version refuses to open a database from the current version, which is tagged.
  Removal lands before the new model is built, so the two never coexist.
- The BB-based Haze prototype stays installed until the new cab runs Haze work. That replaces
  the [#761](https://github.com/chrisbanes/cab/issues/761) cutover proposal.

## Limits

- **cab enforces nothing on GitHub.** An agent can do anything its GitHub access allows.
  Branch rules on each repository are the guard on merges. Orca bots act on GitHub as the
  operator.
- **Approvals are advisory.** An agent that ignores a decision isn't stopped by cab.
- **cab can't stop a process.** It can release a claim or revoke a host credential; the host
  stops the agent.
- **A host credential is shared on its host.** Any process there can act as any agent
  registered to that credential.
- **Expiry can duplicate work.** An agent that's still running when its lease expires may
  have pushed partial work. The next claimant relies on the thread to find it.
- **Events can repeat.** Delivery is at least once; hosts use the event ID to ignore repeats.
- **PR detection is best effort.** A PR that neither names its issue nor carries the marker
  is found only when an agent links it.

## Left to implementation

These start as defaults the implementation can tune: a 30-minute lease, a creation cap of
20 tasks per root task, the task reference format, how long feeds keep events, and the
wrapper's flags.

## Unresolved

Whether cab watches GitLab merge requests for the done rule in the first release.
[ADR-1020](1020-code-hosts-and-issue-trackers.md)'s code-host role reduces to reading
change-request state and fetching the read-only copy.

## Alternatives not chosen

- **Keep the lead tree and let outside agents take assignments.** This keeps the fixed
  structure this decision removes.
- **Keep cab's runtime as one host among several.** This keeps execution ownership and its
  qualification cost, which the hosts already cover.
- **Role labels or named assignees for claims.** Any agent in a project can claim any
  claimable task; its instructions decide what it takes on.
- **cab as the only GitHub writer.** Agents would send commits to cab to push. That needs a
  git relay, and the hosts already hold GitHub access.
- **Rebuild as a new service and lift the reusable modules.** A survey of the code favoured
  this, because the schema is rooted in execution. Starting from a fresh database with a
  reset schema removes most of that cost without running a second codebase.
- **Use hosted Vercel Board.** Vercel can read the content, and it has no Inbox, approvals
  or readiness from GitHub and Jira.
- **Build on Board's local server.** [vercel/board](https://github.com/vercel/board) is
  Apache-2.0, and its task model matches the claims here. Tasks are threads, leases are
  fenced by an epoch and a token, dependencies use `--needs`, and events stream with
  resumable cursors. It doesn't fit as cab's store, for three reasons:
  - It serves one local person, with a token signed by a key it regenerates on each start.
    So it has no per-host credentials, and agent names are self-declared.
  - Its claim path has no hook for readiness, project pause, a claim limit or a creation
    cap. Adding them would mean forking its task server.
  - Its docs place local mode for development and tests, on a pre-1.0 package with a
    draft specification.

  cab borrows the design instead: claims fenced by an epoch and a hashed token, leases
  checked against the clock at every claim, and an event stream with resumable cursors.

## Consequences

- This supersedes ADR-1005, ADR-1008, ADR-1012, ADR-1013, ADR-1015, ADR-1016, ADR-1019,
  ADR-1021, ADR-1022, ADR-1023, ADR-1025, ADR-1026, ADR-1027, ADR-1028, ADR-1029, ADR-1031,
  ADR-1032, ADR-1033, ADR-1034, ADR-1035, ADR-1036 and ADR-1037.
- It supersedes in part:
  - ADR-1001: the lead's accountability, assignments, and execution and recovery owned by cab.
    Agents still decide how work proceeds.
  - ADR-1002: the operator-only rule for local dependencies, and dependencies as an
    execution gate. They now gate claims.
  - ADR-1003: assignments and recovery.
  - ADR-1004: scheduling, admission, supervision, workspaces and conversation records. cab
    stays a standalone service without BB.
  - ADR-1009: choosing a checkout during project setup.
  - ADR-1011: the macOS service install as the deployment for cab's own use.
  - ADR-1020: the code host as a delivery target.
  - ADR-1024: its event definitions.
- [ADR-1010](1010-operator-cli.md)'s CLI gains host credentials and agent commands, and
  loses its execution commands.
- The glossary retires the lead, assignment, execution and workspace terms as their code is
  removed, and gains claim, lease, root task, host credential, event feed, task thread,
  project channel, task reference and done rule as they land. Mentions reverse the task
  comment rule that text never selects a recipient.
- The specification, acceptance plan, README and design documents are rewritten slice by
  slice as behaviour lands. Test suites for execution and workspaces are deleted with their
  code.
- A new epic replaces [#649](https://github.com/chrisbanes/cab/issues/649), and issues that
  only concern the current version are closed as not planned.
