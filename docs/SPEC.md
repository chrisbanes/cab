# cab behavioural specification

This is the reviewed product behaviour contract for the standalone service. The
product scope, the minimum S01 integration contract, and assignment routing with
project-lead accountability ([ADR-1005](adr/1005-service-assignment-routing.md)) are
confirmed. Runtime-specific implementation contracts remain subject to S01 evidence.
[ADR-1004](adr/1004-standalone-service.md) removes BB from the target architecture.
This specification preserves the product policies from ADR-1001, ADR-1002 and
ADR-1003 with that ownership change. The BB prototype is preserved on branch
`cb/pipeline-implementation`.

## Implementation state

The standalone service implements durable scheduling, capacity admission,
supervision and conservative recovery; task coordination (durable results and
recipient inboxes, human requests, retained-assignee follow-up, revision-bound lead
completion and assignment routing); the authenticated operator UI; GitHub discovery
and scoped delivery; and an offline operations CLI. Release and cutover are not
qualified: access from an independent device, physical sleep/wake behaviour, final
operations and cutover still need evidence. Requirements below are product
obligations, not passing acceptance claims; where a behaviour is unimplemented or
unproved, it says so in place. See the [README](../README.md) for the current
summary, [epic #649](https://github.com/chrisbanes/cab/issues/649) for delivery
scope and status, and the [acceptance plan](acceptance.md) for required evidence.

## Purpose and scope

cab is one standalone service coordinating multiple projects for a trusted
single operator. It owns tasks, scheduling, assignments, execution supervision,
workspaces, durable conversations and an operator interface. Keep TypeScript,
Node.js and SQLite. The first deployment runs on Chris's Mac and serves a web
operator interface, using Codex with the existing operator login. Codex App
Server qualification remains a runtime gate. No BB installation is required by
the target product. Private remote access uses Tailscale plus a separate
cab operator login. The standalone installation starts with a fresh database;
historical BB record import is outside the first release.

Agent instructions determine how to plan, implement, review and revise work.
Those activities are not required stages or assignment types. Projects contain
optional linked repositories, reusable profiles, instructions and permissions.
The project lead is accountable for every task outcome, using a separate
conversation per task with the same lead profile. There is no separate task-owner
role. Assignees execute work and may delegate concurrent assignments. Agents may
select permitted profiles but cannot create profiles or expand project authority.

Local tasks are built in. GitHub.com repository issues and GitHub Projects are the
first external sources. Import the selected backlog, excluding PRs and draft
items; readiness is separate. Jira Cloud as an issue tracker and GitLab delivery,
including self-managed instances, as a code host are planned and not implemented; a
project can already link a GitLab checkout
([ADR-1020](adr/1020-code-hosts-and-issue-trackers.md)). Linear, GitHub Enterprise,
a plugin marketplace, multiple execution machines, team/RBAC administration and
migration of old live runs are outside the first release. Source interfaces follow
concrete integrations.

## Distribution

The first release uses one npm package, `@chrisbanes/cab`, containing the server,
built web UI and one `cab` executable for service management, offline operations
and authenticated operator commands. Users provide a supported Node.js LTS runtime;
no checkout or local build is required. Installing the package does not start a
service. The same package supports connecting to a remote service without a local
server installation. macOS Apple Silicon remains the first qualified service target.

Service upgrades must preserve data and recovery holds, stop the old service
before changing its runtime/files, and take and verify an offline snapshot before
migration. Package replacement must not mutate files used by a running service.
Service uninstall keeps data, auth and snapshots; reinstall finds retained state.
Migrations remain forward-only with the fix-forward recovery boundary in
[ADR-1011](adr/1011-packaging-and-distribution.md).

Service startup takes and verifies the offline snapshot before migrating (see
[ADR-1011](adr/1011-packaging-and-distribution.md)). These are target requirements:
npm publishing and the npm service lifecycle are not yet implemented or qualified. The existing bundled-Node
tarball is an optional channel. The desktop app and Homebrew channel are deferred
([ADR-1019](adr/1019-mac-app-channel.md)) and do not gate the npm release.

## Operator CLI

The accepted [operator CLI design](design/operator-cli.md) and
[ADR-1010](adr/1010-operator-cli.md) specify an additional operator interface for
external agents and terminal users. Its authentication foundation and read-only
browsing are implemented: Settings issues, lists, rotates and revokes CLI credentials,
and the packaged `cab` executable supports `auth login|status|logout`,
`connection list|use|remove`, project and profile list/get/instructions/revisions,
task list/search/get/messages, assignment get/history/instructions, result
list/get/evidence and artifact get. Supported profile, project, routing and
capacity configuration is changed through prepared, digest-bound change documents
applied once by request key; `assignment apply-current` adopts current instructions
for the next turn, and `operation get` reads configuration and adoption receipts
back by scope, type and key. `execution list|get|inputs` and `logs` read bounded,
redacted execution diagnostics captured for task-bound executions, with resumable
cursors, JSONL output and bounded following. `task create|configure|add-dependency|
remove-dependency|message|follow-up|draft-turn`, `inbox list`, `question get|answer`,
`approval get|decide` and `task stop|resume` operate tasks and attention through the
service's existing commands, plus receipted `task.stop` and `task.resume` commands
that share the web UI's Stop hold; Resume clears only the operator Stop.
`project sources|prepare-source|preview-source|place-task` inspect and change GitHub
sources (a `github.configure` change document applied with `project apply`), activate
a selection and place a conflicting imported task; `project prepare-repositories`
changes the project's repository links (a `repositories.configure` change document
applied the same way);
`delivery get|refresh|settle|review-comment|confirm-comment|send-comment` inspect delivery
and drive the existing refresh, handback settlement and staged comment commands;
`result deliver` delivers an undelivered result to its permitted recipient; and
`delivery publish-review|publish-confirm|publish-send|publish-link|publish-abandon`
publish a local task as a GitHub issue with the operator UI's own commands. `recovery
get|prepare|submit` inspect an assignment's held generations and submit the
existing adoption, pre-turn and no-turn recovery and conversation-replacement
commands from an owner-only, digest-bound document built from observed identity and
an explicit operator evidence file; none resumes or dispatches work. Further CLI
delivery sequencing belongs in GitHub under
[epic #893](https://github.com/chrisbanes/cab/issues/893).

The CLI uses the running service locally or over the existing private network,
with revocable read-only or read/write credentials. It covers everyday task
operations, supported configuration, diagnostics and existing evidence-bearing
recovery, retaining the service's policy, revision and receipt checks. Service
process management and offline backup/restore remain host-local.

Dedicated authenticated instruction views reconstruct current, historical and
assignment-bound instructions from retained revision records. New task-bound
executions capture their cab-supplied inputs before submission, observed
settings and available runtime, tool and service events under bounded retention,
unless a project reduces capture to the baseline. General conversation history retains its current
instruction redaction; historical gaps remain explicit. The diagnostic payload
retention policy does not delete durable safety records or change existing
result/review evidence contracts. The design defines capture limits, credential
lifecycle, command semantics and required acceptance evidence.

This does not reopen the deferred ChatGPT integration or change its narrower
content-access rules.

## Deferred ChatGPT and native Codex integration

Optional ChatGPT daily operations/events and native Codex task visibility/handover
(X01–X08) are deferred until after the standalone MVP. Planning, feasibility probes
and implementation are paused under
[epic #734](https://github.com/chrisbanes/cab/issues/734) until explicit
reopening and revalidation. They do not gate MVP release or cutover; Codex App
Server execution and the independently usable web UI remain in scope. The
following paragraphs retain future integration requirements for individual
macOS self-hosters.

Both operator interfaces support daily creation/tracking, durable messages, answers
and approvals; setup and recovery may remain in the web UI. ChatGPT receives only
explicitly enabled projects' task data, results and interaction material, excluding
credentials, private instructions and raw runtime logs. Subscribed completion,
question and approval events explain outcomes or request input; they grant no write
authority. Self-hosters supply a narrow authenticated HTTPS MCP endpoint using guided
setup; the operator UI and runtime remain private.

New tasks should appear as a main native Codex task with linked worker conversations.
Saved host project placement/linkage is optional; tasks belong to cab projects.
Repository tasks use retained cab worktrees. Inspection
is allowed without handover; native continuation requires explicit human control,
holding further cab task dispatch. Explicit return checks settled execution,
workspace changes and existing admission/ownership holds. Idleness or acknowledgement
cannot release those holds. Native API, visibility and handover feasibility must be
proved before future dependent implementation; failed proof returns evidence and integration
scope for review instead of silently substituting managed threads.

These are deferred requirements, not implemented capabilities. See
[ADR-1006](adr/1006-chatgpt-and-native-codex.md), the
[integration design](design/chatgpt-and-native-codex.md) and
[acceptance additions](acceptance.md#chatgpt-and-native-codex-acceptance).

## First local-task journey

The operator opens cab, creates a project, links optional repositories,
configures profiles and permissions, and creates a task with an expected outcome.
New projects start paused; new tasks start unready. Create and start may mark a
task Ready, but cannot bypass project pause. Enablement admits eligible work.

With routing enabled, the service uses the eligible task's requested outcome as
the initial assignment brief and invokes TypeSafe to select an assignee without
a preliminary lead turn. With routing disabled, the lead allocates work explicitly.
Assignees may investigate, delegate, yield writer access, receive results and
continue. Initial results wake the lead for assessment and a completion decision.
Questions appear in the attention inbox and task detail; answers resume the correct assignment. Outcomes,
evidence, conversations and artifacts remain available after restart. The operator
need not enter conversation IDs, poll workers or manually nudge each activity.

Test this entire journey with a disposable repository and a summary artifact,
plus separate repository-free, question, pause, stop and restart scenarios.
Artifact completion is not proof of GitHub delivery. The implementation agent runs
automated service/UI integration and bounded real-runtime validation before handback.

## Assignment routing and accountability

Routing is optional per project and part of the first standalone release. It
requires explicit project opt-in and configured TypeSafe credentials. The service
calls TypeSafe directly, with no PA agent turn. Supply the assignment brief,
relevant supplied findings, candidate descriptions and operator-written project
routing guidance; exclude credentials and full transcripts. Profile capabilities
and project guidance define suitability, not required development stages.

The service filters candidates by explicit eligibility and permissions. Route a
new assignment when no assignee was specified; honor an explicit permitted profile
selection without invoking TypeSafe. Routing does not authorize execution or grant
readiness. Recheck all admission controls before starting work. Select for fit,
then queue for capacity; do not substitute another profile merely because the
selected profile is busy. An in-scope repair retains its assignee and profile;
reassignment is explicit, rather than automatic routing on every follow-up.

Missing routing context, uncertain recommendations, no suitable candidate or
TypeSafe unavailability wake the project lead with the brief and available routing
evidence. The lead can allocate explicitly without another TypeSafe call. Material
ambiguity discovered during execution goes to the lead; the existing requirement
for operator input on unresolved material scope or authority still applies.

Initial assignment results return to the task-scoped lead conversation. Nested
assignment results return to their requester; the lead can inspect all work without
being woken for every child result. These destinations survive restart. All lead
turns, including draft turns, use normal admission and capacity accounting, including project pause, task
stop and writer controls. Project-wide coordination uses project context, separate from
individual task histories. The lead assesses initial results and requests further
work or task completion; the service enforces completion conditions and permissions.

See the [routing design](design/assignment-routing.md) for revision and failure
boundaries. Typed judgments and confidence are not proof of correctness or authority.

## Admission, project placement and task dependencies

The operator admits local work or configures the source's optional readiness rule.
Unready tasks run no turns, except that the operator can start a
[draft turn](#draft-turns) of the lead; the lead cannot grant readiness. For
GitHub, a rule uses simple all/any label (matched case-insensitively) and Project-field conditions; nested
expressions are deferred. A new project's source has no rule, and the operator may
add or remove one: with no rule, every open imported issue with current source
membership satisfies readiness whatever its labels or Project fields. Absence of a
rule is stored explicitly (`null`), never as an empty condition list, and a rule
withheld from a read is shown as unavailable, never as no rule. Readiness alone is
not admission: activation, complete source observations, placement, repository
access, dependencies, approvals, holds, pauses and capacity still apply. Each GitHub source also has a closed-issue mode, changed only through
its versioned configuration: **Skip closed issues** (the default) never imports an
issue first observed closed, and **Treat closure as Done** imports one as Done from a
complete read only. Membership in another source cannot grant admission. Each selection's
source observation counts its observed items (including closed issues skipped without a
task), open items and open items matching the readiness rule, and warns when a complete
read matches none; an imported open Draft task names the conditions it does not meet.
A GitHub Project selection's observation also lists each single-select field with how many
of its open items hold each option, and the operator can add an option as a
Project-field condition from that list; the condition still saves only with the
source configuration. Conditions, unmet reasons and observed field values read by the
field and option names the Project's last complete read listed; a partial read keeps
them, and a field or option no complete read has named shows its node ID. Names are
display only: rules, commands and readiness matching use node IDs.
These explanations are read-only projections of stored observations: they make no
provider read and grant no readiness, and matching the rule is neither Ready nor
admission. Ready authorizes work within scope, without a universal per-task plan approval.
Source syncs revise an imported task until its readiness and blockers settle, so its
first turn is queued only once the task is admissible, and a first turn that has never
run, including one waiting for capacity, takes the task's current revision when it is
admitted instead of being refused as stale.
(A [drafting run](#drafting-runs) is not task work: it needs no Ready task but counts
against the same global and project capacity. A [draft turn](#draft-turns) is task work
whose only exemption is that the task is not Ready.) Material ambiguity,
scope expansion or ungranted actions require operator input.

Dependencies gate execution separately from Ready. A blocked task remains visible
and Ready but starts no task execution, new turn or delegation. Only the operator edits
local task edges, within the same project; reject cycles and self-dependencies.
Local Done clears a blocker; cancellation does not. Imported GitHub tasks follow
native dependency edges, including blockers outside the selection, without importing
those blockers or granting repository access. No duplicate local edge or bypass is
provided for an extant native edge. Closure or edge removal releases that blocker;
reopening reapplies it. Native edges are read only for Ready open tasks (and a
task continuing from its own delivery closure); other imported tasks hold them as
unknown. Unknown or incomplete state holds dispatch even on first
observation or after prior clearance. Current turns may finish when a new blocker
appears; results and ownership remain. Clearance rechecks every other control.

External identity includes provider instance and is independent of source query.
Multiple sources in one project produce one task with multiple memberships.
Cross-project overlap requires operator placement: preserve existing project
placement and assignments; hold newly conflicted work without established assignments
and never combine permissions. Transfers of tasks with established assignments
between projects are deferred. Discovery grants no additional repository access.

Losing readiness, leaving all selections or external closure holds new delegation
and notifies the lead and active assignees to reach a safe stopping point. Operator resolution is needed
to resume, except confirmed closure from this task's own delivery and the two source-caused holds
that clear themselves: a readiness-lost or withdrawn hold (omitted, or leaving all selections) is released by a later complete read
that lists the issue again while the task is Ready, since the source has recovered. A partial read
releases nothing, and every other source hold, including changed text and closure, still needs
operator resolution. External closure
after import holds the task in both closed-issue modes, whatever its readiness. Under
Treat closure as Done, the service then completes it once current membership evidence
is complete and its execution has settled, with no writer, ambiguity or unfinished
execution; provider closure never resolves uncertain execution or clears other holds.
Reopening returns a provider-completed task to open and recomputes readiness from the
rule; reopening grants no readiness and keeps any closure hold. Switching a source to
Skip reopens its provider-completed tasks under a closure hold. Under Treat closure
as Done, a task the operator reopens while its issue stays closed is completed again
once settled; switching the source to Skip keeps it open; no mode or switch
deletes tasks or history. Once an issue this task's delivery closed is reopened, that
own closure is superseded: a later closure, by anyone but a new confirmed cab
closure, is provider closure in both modes. Supersession keeps the delivery history
and any closure hold. When GitHub shows the issue closed but not provably by the
task's own delivery, the task keeps the explained `closure-attribution-unproved`
hold, never a pending read, and is never completed by that closure; reopening the
issue supersedes the own closure, then the operator resolves the source hold. Harmless edits
can be incorporated; materially changed scope holds work for clarification.

## Execution and recovery

Pause allows active turns to finish but holds queued and new turns, including
result continuations. Results, observations and answers persist. Other projects
continue. Stop durably holds pending work and requests best-effort cancellation of
every active execution in the task, including its lead turn and delegated
assignments. Observe for a predeclared bounded interval;
effects may continue afterwards. Stop applies only to an open task; a Done or
Cancelled task refuses `task.stop`, and an existing Stop on it stays visible and
resumable. Stop is not task cancellation or completion.
Unverified termination retains Stop, writer and capacity holds and remains visibly
stopping/uncertain. Explicit resume clears only the operator Stop, never unresolved
execution ownership. Preserve files/history; time and acknowledgements cannot unlock.
Resume revalidates readiness, dependencies, permissions and execution ownership.
Hold a macOS sleep assertion while execution is active, releasing it when idle.
Forced sleep or wake requires execution reconciliation before admitting more work.

A planned restart (SIGINT or SIGTERM) stops admitting work, then interrupts each
running task turn through the Stop interrupt lifecycle, lets an in-flight
submission bind or fail, and waits one bounded, configurable interval (five seconds
by default) for terminal status. A turn whose interrupt was acknowledged and whose
exact bound turn reported a terminal failure is released when every cab
callback has ended and nothing else holds it: no known survivor and no pending
effect other than its own uncommitted assignment result, which is settled as
superseded. Its writer ownership and capacity go atomically and the same request is
requeued as a fresh generation on the same thread, admitted on the next start under
every current admission check, without using the transient-retry allowance. A turn
that completes within the interval completes normally. Everything else, including
drafting and direct turns, keeps today's restart hold.

cab owns capacity admission with both a global active-turn cap and a cap for
each project. Waiting for workers, people or external feedback
releases an execution slot; capacity one must not deadlock delegation. Default
to four active turns globally and two per project, editable in configuration.
Lowering a cap holds new admissions until active usage fits; it does not silently
terminate active turns. Fairness remains a technical contract to specify.
Retry confirmed transient
execution failures at most twice with backoff, persisting the allowance across
restart. Blind relaunches cannot reset it. Uncertain acceptance/effects must be
reconciled before retry. Silence flags attention, not automatic restart or termination.

Each assignment has durable identity independent of its conversation. Follow-up
retains history with a new work revision; stale results cannot complete newer work.
An assignment takes the current instructions and profile revisions when its first
turn is admitted. Once any turn has started for it, it retains those revisions until
an explicit apply for its next turn. Permission
revocations apply to subsequent actions regardless of snapshots.

A turn's input carries the project and profile instructions only when its thread has
not received that revision: the first turn on a thread, including a new thread after
conversation replacement or recovery, or a resumed turn whose bound revision differs
from the one the predecessor turn ran with. A changed revision is sent once, stated
as replacing the earlier instructions, with no revision numbers in the text. The
execution binding and execution diagnostics keep each turn's revisions and mark an
instruction segment not sent. A turn that resumes an interrupted predecessor, which may not have delivered its
prompt, sends both again as replacements. Instructions travel as user input on both harnesses, not as Codex
developer instructions or Claude's system prompt: Codex native-input qualification
pins the thread's developer instructions, so changing them disqualifies the thread,
and a conversation keeps its harness across a profile switch. Limit: a runtime's own
history compaction may summarise earlier instructions; cab resends them only when
a revision changes or a conversation gets a new thread.

Record results and handoffs through coordination commands, not transcript inference.
A successful process exit is not a task outcome. One reporting prompt may repair a
completed turn with neither result nor waiting reason; then hold for attention.
Persist that allowance and apply normal admission controls. Results arriving while
their recipient is active wait for its next turn; coalesce continuation wakeups while
retaining individual acknowledgements. Paused/stopped recipients retain their inbox.
Operator messages may target pending or running assignments, and the task's current
lead when its assignment is completed and the task is open: that message is an
[operator follow-up to a completed lead](#operator-follow-up-to-a-completed-lead).
Other held or completed assignments are not implicitly revived; resolve the hold or
create explicit follow-up/recovery first. Legacy inbox events do not dispatch a
completed assignment.

A retained canonical initial assignment request positively refused for captured task or
assignment revision mismatch before runtime admission can be continued by posting a
fresh operator message through the existing task inbox. The original held request,
intent and refusal remain immutable history; no replacement initial request is created
automatically. The fresh inbox work captures the current task revision and includes its
current title/outcome alongside the preserved assignment brief and instruction/profile
snapshots. Current admission, permissions, dependency, Stop and execution/effect holds
still apply. Runtime identity, writer admission, capacity reservation, recovery
identity, pending effects or a Stop target disqualify the historical refusal exemption.
Any initial inbox batch stays bound unless the existing narrow stale-delivery withdrawal
proves it safe to withdraw; continuation never orphans or replays that batch.
The operator can also clear such a refusal directly with
[Start again](#start-again-and-reset-task).

After exact-generation operator recovery, the old intent remains `reconciled` and
its turn request remains held; the validated recovery receipt alone does not dispatch
work. A new operator message to the same task/assignment can explicitly authorize a
fresh inbox continuation. The message transaction retains an immutable audit linking
the recovered work, receipt, message key/event and old batch. It processes the old
batch without replaying its events; task and assignment message views identify this
as `operator-reconciled`, distinct from successful runtime delivery. Message replay,
provider feedback and settlement cannot create or retarget that authority. Every
admission, completion and external completion action rechecks the audit and exact
recovered-generation proof, while current project/profile/dependency/permission and
Stop gates remain in force. Late callbacks or known survivors after a recorded
continuation persist an uncertainty hold and retract admitted successors; ending the
callback or restarting does not clear that hold. The recovery receipt, old intent and
continuation audit remain historical evidence, not a successful result or a force
unlock. Existing callbacks before any recorded continuation retain their previous
recovery behaviour.

A positively rejected archived `thread/resume` before turn submission has a
separate pre-turn recovery proof. The Codex adapter retains the exact correlated
RPC request, predecessor thread, `-32600` archived-session response and runtime
process identity. The service persists that witness against the admitted request
sequence, work revision and assignment binding before losing submission context.
Missing thread/turn identities, a timeout, malformed response, another RPC error or
a lost turn-start response cannot qualify. The never-admitted refusal and bound-turn
recovery proofs remain distinct.

A historical generation lacking that typed witness requires explicit authenticated
operator adoption. Its immutable command receipt binds the exact held generation,
predecessor, process and persisted response to operator attestations and reviewed
source/harness/evidence/approval references. The host operator verifies those
artifacts and the independently reviewed no-turn evidence; valid metadata syntax or
an error string alone does not establish proof. Model tools cannot adopt evidence.
Command replay returns the same result and rejects altered material or retargeting.
Adoption and recovery are authenticated advanced operator routes; they grant no
new model tool authority or automatic recovery control.

A keyed pre-turn recovery receipt requires the persisted witness, truthful null
thread/turn identities, independent exact-process termination verification and
settled workspace/effects. Recovery reconciles only that generation's ownership;
it leaves the old request held and does not dispatch a successor. An explicit
conversation replacement and a NEW operator message are then both required. The
replacement command checks captured assignment/conversation revisions, persists
its result and prevents duplicate revision increments on replay. The new work starts
a fresh thread. Existing receipts and continuation audits retain their identities
and material unchanged; the old batch is processed as `operator-reconciled` without
replay. Admission, completion and external actions revalidate the pre-turn witness,
receipt and continuation audit at use time. Independent holds, current admission
gates and persistent late-callback/survivor holds remain enforced.

A distinct historical no-turn-submission proof covers an admitted generation
with a captured known-null predecessor and unbound thread/turn identities. It is
operator-only adoption of independently reviewed frozen source, harness and a
complete synchronous write-ahead invocation ledger establishing that `startTurn`
was never called for the exact generation. A generic stop error, missing identities,
process absence or metadata syntax alone cannot establish this proof. An initial
`thread/start` may have created an unobserved idle thread; this contract does not
claim thread noncreation, a positive archived-resume rejection or successful work.
The existing archived-resume predicate and bound-turn proofs remain unchanged.

The separate no-turn witness and receipt discriminator bind request/work,
conversation/writer revisions, assignment snapshots, process and immutable operator
command material. Recovery independently verifies exact-process termination and
requires settled current workspace/effects, preserving null identities and all
older receipt/audit material. It leaves the request held and produces no successful
assignment result or automatic dispatch. Existing keyed conversation replacement
and a NEW authenticated operator message are both required for continuation. The
old batch records `operator-reconciled` processing without replay. Admission,
completion and actions recheck the distinct witness/receipt/audit and current gates;
late callbacks or known survivors persist a hold and retract successors across
restart. The advanced authenticated host routes expose bounded acknowledgement,
with no new model tool authority or forms in the curated operator UI.

Already-admitted execution and tools may survive coordinator or App Server failure
and continue effects. A crash releases neither writer ownership nor capacity. No
queued turn, follow-up, delegation or replacement may gain admission while cab
is unavailable. Retain unresolved holds rather than relaunching work. Historical
conversation resume does not prove reattachment to a live execution. A
[bounded real Codex journey](evidence/s04b-live-runtime-2026-09-29.md) observed
registered dynamic tools on resumed lead and worker threads after service/App Server
restart; this qualifies that tested journey only, not universal reattachment. If
unique live reattachment is unavailable, retain uncertainty and use the operator
recovery path in the
[standalone design](design/standalone.md#operator-recovery-of-uncertain-execution).

Persist launch and external-action intent before effects. Reconcile uncertain
acceptance, surviving executions and external writes after restart before competing
work can start. Zero search matches alone do not prove a request was never accepted.
Previously enabled standalone work resumes automatically after successful
reconciliation, subject to every current admission check. Preserve previous
pause/stop holds; a service restart never clears an operator stop. This applies
to the standalone database, not old BB assignments.
Uncertain effects hold dependent work; independent
work may proceed only when independence is established. No arbitrary external API
is promised exactly-once effects.

`cab snapshot create|verify|restore` provides generic standalone SQLite snapshot,
verification and restore. `cab service install|upgrade|uninstall` manages a
per-user LaunchAgent bound to an unpacked release: upgrade stops the job, then starts
the new release and checks readiness; the service takes and verifies a snapshot
before it migrates data an older release wrote, and refuses to start if it cannot.
Upgrade refuses a release older than the installed one. A failed
upgrade leaves the job stopped with no automatic rollback. `service install --mode daemon`
is the opt-in route to starting at boot before login: it prepares a LaunchDaemon that
runs as the service account, never as root, and prints the `sudo` commands that install
and start it; the two modes are never both installed, upgrade refuses a daemon install
and uninstall prints the matching `sudo` commands, clearing the record only once the
recorded service processes are confirmed gone and its port is free. A daemon cannot read the login
keychain, so GitHub access there needs a file-based `gh` login (a plaintext token at
rest), and a power cut with FileVault on leaves the disk locked until someone unlocks
it; a planned restart uses `sudo fdesetup authrestart`. These preserve database state and
use ordinary service-start reconciliation; they do not include workspace contents,
settle external effects, or qualify a final operational cutover. See the
[macOS operations procedure](operations/standalone-macos.md) and its
[bounded evidence](evidence/s08a-operations-2026-09-30.md).

## Workspaces and execution access

cab owns task workspace creation, identity, retention and cleanup. Use one
worktree per participating repository per task, shared by assignments with one
admitted writer generation at a time under the cooperative rule below. Independent
tasks can proceed concurrently; parallel reviews
reference a fixed revision. Repository-free tasks need no Git worktree.
A local task's workspace is created at its first admitted turn. An imported task's
is created then too, holding only its issue's source repository at the project's
linked path and ref, and only once the turn is otherwise admissible, so a held or
not-Ready task gets no checkout. An imported task whose source repository the
project does not link waits, without a workspace, until it is linked.

Normal successful completion trusts Codex's successful terminal status for the
bound thread/turn. After every cab-owned callback has ended, with no known
unfinished execution or other hold, persist completion and serialize ownership
release with admission of one successor. Detailed tool history supports diagnosis;
an absent item alone does not veto an otherwise qualified normal completion.
This accepts incomplete runtime observation and possible unobserved effects or
detached-child writes overlapping a successor. It does not prove physical writer
exclusion or the policy of an unobserved action. See the
[runtime trust boundary](design/standalone.md#runtime-trust-boundary).
Crash, Stop, failure/interruption, missing or conflicting terminal identity/status,
unfinished cab callbacks and known survivors retain holds until independently
resolved; the one exception is a task turn that a planned restart interrupted and
recorded as ended (see above).
A timer, expired lease, quiet interval, empty terminal list, acknowledged Stop or
operator acknowledgement cannot release them. Conversation replacement and archival
do not automatically delete
workspaces. Retain until operator archival by default; automatic cleanup requires
confirmed delivery and preservation checks for uncommitted work, handoffs and
reconciliation evidence. Missing workspaces hold affected execution visibly.

Every Git subprocess the service starts (workspace provisioning, cleanup and
identity checks, file and comparison reads, setup probes and repository
verification) clears inherited `GIT_*` variables, never prompts on a terminal,
lazily fetches objects or allows transport protocols, and uses bounded time and
output. A repository that needs the network to supply objects therefore fails
closed. This governs cab's own Git; agent processes run their own Git with
their runtime environment. The one exception is [task commit
publication](#github-and-completion): a single bounded HTTPS push to the verified
github.com repository, in a scratch repository that reads the worktree's objects, with
the delivery credential in that push child's environment only (never in argv, Git
configuration, a file or an agent environment) and no other transport.

New projects default to Codex `workspaceWrite` with explicit task writable roots,
command network access disabled and approval policy `never`. Broader command
sandbox escalation is denied; expanding that policy requires separate operator
approval and fresh admission.
Command network access is the one operator setting that expands it: a per-project,
versioned `project.configure` field, off by default, that only the operator can
change through project configuration or the operator CLI; agents have no tool for it.
Each Codex task turn records the setting when it is admitted and sends it as that
turn's `networkAccess`, so a change reaches only later admissions and a running turn
keeps its policy. Claude Code turns, drafting runs and any turn without a task
binding always run with it denied. Every place the effective policy is shown states
the setting and that network-enabled commands can reach whatever credentials and
logins the host exposes. cab enforces only what it sends the runtime; it is not
an allow-list, a proxy or a host filter, and MCP and app tools, web tools and model
transport are separate surfaces.
Reads retain Codex full read access subject to host permissions; outside-read
denial is not implied. Runtime temporary write roots and protected paths must be
disclosed with the effective policy. See the [default execution policy](design/standalone.md#default-execution-policy)
for supported controls, qualification and ambient-access limits.
cab enforces project policy on its own tools and integrations. Runtime and
OS/deployment controls govern shell, filesystem, network and ambient credentials;
disclose their actual limits and do not claim an independent sandbox. External
content is data, never authority. Runtime choice must establish caller identity
without trusting agent-supplied project or assignment IDs.

A [drafting run](#drafting-runs) works in a disposable worktree of the project's
linked repositories. The host-read disclosure above applies to it unchanged. A
[draft turn](#draft-turns) uses the task workspace read-only with command network
access off; the same disclosure applies, and cab's own refusals cover its tools.

## Operator interface and human requests

Make the next decision obvious, and keep its evidence close.

Provide project/task lists, task detail, conversations and execution history,
configuration and a shared attention inbox. Show capacity, source health, the lead, assignees,
results and artifacts. Distinguish empty, loading, stale, failed, paused, waiting,
stopping, disconnected and uncertain states. Provide both list and Kanban board
views, with the list as the initial default.
Keep known state and uncertainty legible and retain unfinished drafts across
transient failures.

The operator UI is a React application at `/app`, served with same-origin
`/api/operator` JSON by the production `operator` command. Approval decisions, handback
settlement, result-destination reconciliation and messages to delegated assignments
are task-view controls, and the CLI offers the same commands. Controls the app does not offer remain on retained
server-rendered routes: local task edits and source review decisions on `/task/:id`;
delivery policy on `/project/:id`; and Stop/Resume and recovery on
`/runtime/task/:id`. They are reached from a task's History tab, Project settings'
Open advanced editor and a task's Execution link. The technical
contracts are the [foundation](design/ui02-foundation.md),
[tasks](design/ui03-tasks.md), [configuration and recovery](design/ui06-configuration.md),
[components and tokens](design/ui08-foundation.md) and
[operator integration](design/s04d-operator-integration.md) designs. The
web-disabled diagnostic fallback is not qualified for production visual parity.

### Everyday navigation and attention

The daily operator flows each state their entry points, steps and an interaction
budget the interface must meet: [first run to first task](user-flows/first-run.md),
[create a task](user-flows/create-task.md),
[find tasks](user-flows/find-tasks.md),
[import issues from GitHub](user-flows/import-issues.md),
[answer a question](user-flows/answer-question.md),
[approve an exact action](user-flows/approve-action.md),
[inspect changes and reply](user-flows/inspect-changes.md),
[review a result](user-flows/review-result.md),
[unblock waiting work](user-flows/unblock-work.md) and
[triage an uncertain execution](user-flows/triage-uncertainty.md). A flow's
budget never overrides the rules in this specification; it bounds the path to them.

Open on an attention-first overview, with actionable items above a compact
cross-project work list and recent results shown separately. Keep projects in the
desktop sidebar. Present task activity, assignments, dependencies, results and
relevant controls together in task detail. Cover attention needed, normal work in
progress and first-project/first-task experiences.

The attention inbox contains unresolved questions, approvals and problems requiring
operator intervention, including an execution runtime whose automatic restarts are
exhausted. Routine progress, completions requiring no decision and
normal dependency waiting do not create attention items. Order attention by
urgency, then age: execution uncertainty and problems requiring intervention first,
then questions and approvals oldest first. Show project and task context on each
task item, or the runtime for a runtime problem. Unresolved questions, pending approvals and failures remain visible even
when related history is collapsed.

Each attention item explains the decision or intervention needed, its requester
when known, why the operator is needed, and the available response. Keep relevant
evidence beside the response or directly accessible within the task context.
Use the same meaning and action wording in Overview, Inbox, List/Board and task
detail. Returning from a request preserves the previous filters and position.

Distinguish work progress, the next actor and operator attention. Derive them from
recorded facts, showing unknown responsibility explicitly. Running activity alone
does not establish that an agent owns or is repairing a particular failure. A
failed check with an agent-owned repair does not itself create operator attention;
an independent question, approval or recovery problem remains visible. Capacity
waiting is normal progress unless a separate intervention is required.

### Kanban board

Provide a List/Board switch for cross-project and project task views. Both views
show the same tasks and respect the current project and task filters. Switching
views preserves those filters and does not change task state. The browser
remembers the filters per device and restores them on a task view opened without
any; Readiness defaults to Ready, so Draft tasks are shown by choosing Not Ready or
Any readiness.

Group board cards by cab work state, showing the task title, project, lead,
source identity when imported, and the reason for waiting or intervention. Keep
readiness and dependency holds distinct: a Ready task can still be blocked. Keep
uncertain and stopping work visible rather than implying completion. Cards open
the same task detail as list rows; the attention inbox remains available in either
view. Provide readable narrow-screen navigation between columns.

Attention appears alongside work state rather than replacing it. Keep actionable
readiness, successful completion, cancellation and provider closure without
delivery visibly distinguishable. Provider closure alone does not establish task
completion, except under a source's Treat closure as Done mode, which records the task
as completed by provider closure, distinct from cab or manual completion. Prioritise the task's meaning, current situation and next actor;
supporting identifiers and timestamps must remain readable and accessible without
competing with that information. These refinements do not change the existing
board state mapping.

Board columns describe cab work, not GitHub issue state or Project fields.
The board does not grant arbitrary status changes or require drag-and-drop for the
MVP. Any offered transition must use an existing permitted command and preserve
readiness, dependency, approval and source-ownership rules; moving a card cannot
bypass a hold or silently write to GitHub. A project's [status mapping](#github-and-completion)
reflects cab's work onto a Project's Status without changing these columns.

### Task creation and project setup

Provide a simple initial task composer that supports a substantial brief. Keep
project selection, title and desired outcome prominent. Progressively disclose
optional context, reference links, permitted explicit assignee selection and task
dependencies; show a summary of supplied optional settings when collapsed. Keep
entered values and field errors accessible through disclosure. Use Create and start
as the primary action and Save draft as the secondary action. Before submission,
state whether the task would start now or wait, with the reasons a new task in the
project and its chosen dependencies would have. Show the persisted state and the
reasons for any wait after submission; creation does not imply running. Task
detail, Inbox and the operator CLI list the same wait reasons in one fixed order,
the first primary. Where the operator can clear a wait (paused project, missing or
revoked project lead, unavailable runtime, unreadable Claude token, unconfigured
profile runtime), the reason carries a Fix that performs that one action: Resume
project confirms and sends only the project resume, and every other Fix opens the
screen that clears it (the CLI prints the command or Settings path). Dependency,
approval, source and capacity waits link to what blocks them and have no Fix. A power
supervision hold, which applies to every task while the supervisor holds admission, has
no Fix and shows the supervisor's hold reason. An assignment that is waiting to run
but is not admissible for its own reasons shows its own wait, named for its profile.
A revoked or changed profile opens that profile, which does not re-bind the
assignment; changed instructions, a profile that project routing does not permit and
a held assignment have no Fix; a held assignment is explained whether or not a turn
is queued for it. Revoked repository access (an imported task's ready workspace uses a
repository the project no longer links) opens the project's repository settings, names no
repository and grants nothing by itself. An assignment whose operator-reconciled
recovery has no recorded continuation has no Fix and links to its recovery; opening
it releases nothing. A request refused before it ran because the captured task or assignment
revisions changed is shown as **Not started** (`not-started`, reason
`refused-before-start`), not as a wait or as uncertain execution: Start again, a
recovery or a fresh operator message clears it. A Fix never clears
holds or grants access by implication. These controls must preserve existing
readiness and admission rules.

Until a task has started a turn, Home shows a getting-started checklist derived
from current service state: runtime readiness, GitHub discovery, lead profile,
an enabled project and the first task, with Claude optional. Afterwards Home shows
only rows that need attention. The account menu opens the checklist until the
operator dismisses it for the installation; Show getting started undoes that. A readiness check,
shared by Settings and the operator CLI, reports what the running service can use
and one fix per problem. The [user flows](user-flows/) define these journeys.

Use a short guided project setup: project name, lead profile, instructions and
optional repository access. Choose each repository and ref from lists discovered
on GitHub, with the default branch preselected, and choose its local checkout with
a folder picker. The service verifies that the folder is a checkout of the chosen
repository and that the ref is available. Setup may link a GitHub Project
discovered from the chosen repositories or owner; linking adds an inactive
discovery source, and preview, readiness and activation follow in project
configuration. When discovery is unavailable or a list is truncated, setup accepts
typed values and says so. The service lists folders only under the operator's home folder, and a typed
repository is recorded with a provisional identity until discovery can name it.
Advanced routing and external source configuration can follow later.
A project name is unique after trimming and Unicode default case folding after
normalization (Straße matches STRASSE, ς matches σ; dotless ı and dotted İ are not
unified with I, and lookalike letters from other scripts and spacing inside a name
stay different). Setup and
configuration refuse a name another project has, naming that project, and a project
can always be saved under its own current name. Projects created before the rule
keep their names; lists and selects tell them apart by the lead's name, or by the
first eight characters of the project ID when the leads match or are missing
(longer only when two IDs start alike); no two projects ever show the same label,
and a unique name stays plain (except when it equals another project's full-ID label); IDs that differ only in letter
case get " #1", " #2" after the full ID.
When no profile exists, setup creates the lead profile inline, asking only for a name
and runtime (summary and instructions are added later in Settings → Profiles),
without losing other setup values. While discovery is unconfigured the repository step
starts collapsed behind "Add a repository". The project is created paused; the ready
check then replaces the setup form, and its primary action resumes the project and
opens the composer, and its secondary action keeps it paused.
Discovery reads with an installation credential reference: `env:NAME`, or the GitHub
CLI login (`gh:github.com`), which Settings recommends, and which setup (step 3, opened or not), the Settings
discovery credential row, the Readiness GitHub discovery row and the project-configuration
readiness conditions each offer in one step, with the keychain caveat, when the service
detects it. These surfaces share one credential state: while a save from any of them is
unconfirmed, the others keep their offer and controls but do not act, until it is checked.
Discovery never reads with a login the operator did not choose for it. The discovery credential is excluded from agent and helper environments.
Discovery, source selection and a linked GitHub Project do not grant repository
access; access is exactly the repositories the operator adds. See
[ADR-1009](adr/1009-project-setup-discovery.md).

Project GitHub sources independently choose `env:NAME` or exactly `gh:github.com`.
Guided setup shows the GitHub CLI login a new project's source would use once a
repository is added and, when it is signed in and the project has at least one
repository, records `gh:github.com` as that source's credential at creation.
Otherwise the source starts without one: with a repository the ready check says it
cannot sync until one is set, and a repository-free project shows no credential line
and records none. Creates from the HTML fallback or CLI record no default. Existing,
environment-selected and cleared sources are never re-defaulted.
For a linked GitHub Project the ready check also offers the Import
issues panel before Resume, whose Preview and import now is an explicit press that
previews and activates the source and refreshes it; Resume stays primary and available
without it and opens the composer, since imported tasks wait while the project is
paused.
The discovery credential never supplies a missing source credential. Source settings
offer the detected GitHub CLI account or an environment variable, with Change,
Cancel and Clear. Every selection, preview, issue-status and blocker read resolves
the chosen credential afresh. Missing or unusable credentials show an actionable
reason in source settings, Sync & placement and preview, including before the first
sync attempt; unavailable provider knowledge is incomplete and blockers are unknown.
Change or Clear uses the versioned, keyed source save, preserves definitions and
imported history, invalidates activation and requires preview at the new version.
Unknown save outcomes retain the draft and reconcile the same request.

All source credentials are excluded by name and value from Codex spawn, Claude turns
and helper environments, independently of discovery. Successfully resolved gh values
remain in process memory solely for exclusion and redaction after Clear or rotation;
they are never reused for reads or persisted. Each value is bounded to 512 bytes,
while distinct rotations grow this retained set until restart. Existing Codex spawn
environments need a service restart to apply changed exclusions. Runtime permissions
may still let agents reach the host gh login or keychain. Delivery and routing remain
env-only, so a LaunchDaemon (whose plist carries no environment variable) cannot supply
a delivery credential yet; cab supplies no separate host sandbox. On a daemon host
the `gh:github.com` source credential works through a file-based `gh` login;
there is no `file:` GitHub reference. See the
[macOS operations procedure](operations/standalone-macos.md#launchdaemon-mode).

Settings present each project's repository links and GitHub discovery sources as
separate sections. Repository links are project configuration, not part of any
source: each link records its code host and host name (GitHub on `github.com`, or
GitLab on a configured host with the project's full path and numeric ID), and links
change through one versioned, receipted `repositories.configure` command that
verifies every checkout before anything is recorded. A GitLab link must also have an
`origin` remote on its host whose full project path matches, case-insensitively, and
a refusal names the link and reason without echoing a path or remote. Saving the GitHub source neither changes nor needs repository links, and
saving links neither deactivates a selection nor changes the source version.

An agent profile has a name, an optional short summary, private instructions and
capabilities. Settings and routing candidate lists show the name with its summary
(for example "Eli · Repairs"). Like capabilities, the summary describes
suitability; it grants no permission or repository access. A profile also selects
its execution runtime, by default the first enabled runtime (Codex, then Claude;
Codex when none is enabled), with a model and reasoning effort for either runtime
(blank uses the runtime's default). Each runtime reports the values it supports (Codex
from its App Server model list), a value outside them waits visibly and never falls
back to another model, effort or runtime, and a profile without settings runs on the
runtime's default exactly as before. An assignment conversation keeps the runtime that
started it; work for an unconfigured or unavailable runtime waits visibly and never
falls back to another. The operator UI selects and shows each profile's runtime,
the runtime of each assignment and each runtime's effective policy, and sets the
Claude token as a `file:/absolute/path` (owner-only file) or `env:NAME` reference
without showing it.

The operator enables or disables each execution runtime for the installation in
Settings → Runtime or with `cab runtime enable|disable`
([ADR-1012](adr/1012-operator-controlled-runtime-enablement.md)). A missing setting
means enabled. No runtime is required: the service starts and serves the operator UI
with none enabled, and an enabled runtime that fails to start, Codex included, is
unavailable without stopping the service. An enabled runtime that exits, or fails to
start at boot or in a retry, is restarted automatically after 30 s, 2 min and 10 min, and
the count starts afresh once a restarted runtime has stayed available for 10 minutes. A
restart replaces only the runtime process: held turns stay held for the recovery path,
queued work is admitted only after the new runtime passes the usual startup checks, and
nothing is relaunched or resumed implicitly. A disabled runtime is never restarted, and
disabling it or stopping the service cancels pending retries. After the third failed
attempt cab stops retrying and raises one runtime item in the attention inbox. The
item is derived from in-memory state, appears under All projects only and clears as soon
as the runtime recovers; turning the runtime off and on, or restarting the service,
starts a fresh schedule. The item is also delivered to subscribed browsers as one
notification per exhaustion episode. Restart state is never persisted. The Runtime page, the shell
alert and `runtime list` show "Restarting · attempt N of 3 · next at HH:MM" or "Retries
exhausted", and a failure is described by one of four fixed reasons, never by runtime
error text. Disabling takes effect at once for new
admissions; running turns finish and are never cancelled, the runtime stops once no
execution it owns remains, and work bound to it waits as not enabled until it is
enabled again. Disabling a runtime that bound tasks use asks for confirmation with
their count (`--yes` on the CLI). Enabling starts the runtime in the running service,
and is refused, with nothing saved, while its binary does not resolve on the service
`PATH`. Readiness fails "An execution runtime is enabled" when none is; a disabled
runtime's checks are Not configured and raise no alert. The Claude runtime is
qualified, with limits, by bounded live journeys
([evidence](evidence/issue-827-claude-journeys-2026-10-12.md)). Claude work without
an available token reference waits visibly. It runs the `claude` that resolves on the
service's fixed `PATH`, looked up when the runtime starts; without one the Claude
runtime is not enabled (Claude work waits as not enabled and never falls back),
and Codex is unaffected. Readiness reports the version it finds and never
compares it: only the Claude Code version the pinned SDK declares was qualified, and
another version is a disclosed limit
([ADR-1011](adr/1011-packaging-and-distribution.md)). Its execution policy differs from
Codex's ([ADR-1008](adr/1008-claude-code-execution-harness.md)):

- `dontAsk` permissions with an explicit tool allowlist and a `PreToolUse` hook that
  denies calls outside policy.
- Shell commands run in Claude Code's Seatbelt sandbox with no network and no
  unsandboxed retry.
- A sandbox self-test runs before each turn; if it fails, the work waits visibly.
- Each task has its own sandbox temporary directory (`CLAUDE_CODE_TMPDIR`).
- File-editing tools are confined by the hook, not by the OS sandbox.
- Claude loads no user, project or plugin configuration; repository instructions
  are supplied as text.
- Agents ask questions only through `cab_ask_question`.

Each runtime's effective policy lists its disclosed limits. For Claude, the
subprocess token scrub is qualified for sandboxed Bash only; hooks run in process and
no stdio MCP servers are allowed. A Claude CLI process can outlive a crashed service,
so the operator verifies its exit before recovering the turn; bound-turn recovery
has no operator HTTP or CLI route yet. Recovery continues
from the assignment's latest completed turn, so a crash during its first turn
continues in a fresh session. Surfaces the journeys did not test remain limits.
The token comes from the operator's own subscription through `claude setup-token`.
An unsafe token file (a symbolic link, not a regular file, not owned by the service
user, group- or other-accessible, over 4096 bytes or missing) is never read, and an
empty file or content other than one token is not used; Claude work waits with a
reason that names neither the path nor the value.
Anthropic's terms do not explicitly address a single-operator service driven by its
owner; the [current terms](https://code.claude.com/docs/en/legal-and-compliance)
are rechecked when self-hosting by others is considered.

Configuration forms edit current values in place rather than requiring a complete
replacement. The signed-in operator may reveal and edit instructions, routing guidance
and saved search queries in place, and local paths display plainly: the web session is
the operator's own private origin. Reveal is a dedicated read that requires that
session; no CLI credential can make it, whatever its scope. Reveals are not recorded.
Private values stay excluded from lists, exports, CLI coverage output, history and
agent environments, which are the surfaces the exclusions protect. GitHub Project
filters stay kept. Before saving, list every change, including access added or
removed and sources added inactive. Removing all repository access needs explicit
confirmation. A save is keyed against the loaded version: a conflict keeps the
input and shows the newer version, and an unknown outcome blocks further edits
until the original save is checked. Saving never resumes work, clears holds or
grants access by implication.

Every operator write gives one outcome message, sized to its outcome and in plain
language: a quiet inline line on success, and one alert with a single action when
a save is rejected, conflicts or has an unknown outcome. The change list is the
confirmation; consequences are stated there, before the action, not after it.
Identifiers, versions, command names and error codes stay available under a
Details disclosure rather than in the message. A task-view command whose outcome is
unconfirmed (approval, settlement, result delivery, assignment message, Start again,
Reset, question answer, viewing reference and delivery refresh) stays checkable after the
operator leaves the task and returns in the same session, on the task page even when the
service already acted and the item has left its list; a reload, sign-out or session
change discards it. The check resends the original key and body, and settles as refused
only on a definite domain refusal (a conflict or an invalid-input, body-too-large,
unsupported-media or redaction-limit rejection); an authentication, session, availability
or transport failure keeps it unconfirmed. See [action feedback](user-flows/feedback.md).

Project, task list, composer, runtime settings and assignment recovery reads
rebuild once if project or profile instruction revisions or a project's linked
repositories change while the read is in flight; a second change makes the read
unavailable. Project, task list,
composer, runtime settings, Inbox, search and execution list reads capture their
redaction exclusions once per attempt and derive every task's list from them; a
rebuild captures them afresh, and no exclusion list outlives its read. A task's prose is
withheld when its own retained turn requests or recovery identities exceed 128
(each counted separately); other tasks' history never counts. Operator reads redact
with every project's and profile's retained instruction revisions, every declared
credential and every repository path, not only the task's own, so one project's private
material never appears unredacted in another's prose. The installation bound is 4096
distinct values and 16 MiB; past it, reads and actions fail with `503 redaction-limit`
and agent result reports with review metadata fail with "Redaction exclusion limit
exceeded". Archived workspace bindings never count toward it. Credential and workspace
fences still reject changed access material. Comment send receipts recheck
visibility, task version and workspace after loading their redaction exclusions;
a conflict does not undo the recorded provider operation or authorize a resend.

Phone layouts support checking progress, creating tasks, messaging, answering
questions and reviewing approvals. Complex configuration and recovery are
desktop-first; narrow screens must still explain the current state and next step.

#### Drafting runs

In the composer, **Draft with lead** hands a rough idea to the project lead. A
**Drafting run** belongs to its project, not to a task: it creates no task,
assignment, task workspace, result, delivery or GitHub write. It is not a Draft task
whose first assignment writes its own brief: Draft tasks still never run and Ready
keeps its meaning ([ADR-1013](adr/1013-project-owned-drafting-runs.md)).

- **Profile.** The run uses the project lead's profile and runtime, Codex or Claude,
  with a fixed drafting instruction added to the lead's own instructions. A project
  with no active lead cannot draft: the composer says so without starting a run and
  the service refuses the start.
- **Access.** The lead works in a disposable detached worktree of exactly the
  project's linked repositories at their configured refs, each identity-checked like a
  task workspace, with command network access off. It is offered one result tool and
  no coordination, delivery or GitHub tools. A draft never widens repository access.
  This is not a read-only sandbox: reads keep the runtime's normal host access (see
  [Workspaces and execution access](#workspaces-and-execution-access)), and writes
  land only in the throwaway copy. The composer and docs say so.
- **Capacity.** A drafting run counts against the global and project active-turn
  limits and waits, with the same wait reason as any turn, when either is full. A
  paused project holds it like any other turn. Stop is available while it waits.
- **Result.** The lead returns a title and an outcome through the result tool. The
  service validates them against the composer's field limits, with a non-blank outcome
  as the composer requires, and lets the lead retry an invalid call; the last valid
  proposal wins. A proposal holding text the service withholds from the operator, such
  as a private path or credential, is refused the same way. A turn that ends without
  one fails the run with Retry.
- **Stop, the time cap and restart.** The operator can Stop a run, and the service
  stops it after a fixed 10 minutes from admission (a constant, not a setting). A
  service restart also ends it. In every case the run is held until the runtime is
  seen to end: terminal status, or verified termination of the recorded process after
  a runtime loss or restart. Acknowledging Stop, the cap expiring or a restart never
  releases capacity by itself. Only then is capacity released, the worktree deleted
  and the run settled as interrupted, with no recovery page or Inbox alert. If
  termination cannot be verified, or the working copy cannot be removed, the run keeps
  its capacity and the composer keeps showing it as stopping; the next service start
  retries the removal and settles the run as interrupted, so a proposal held back
  this way is not offered. Drafting has no operator recovery. A queued run that has
  not been admitted has no runtime to wait for: it is interrupted (or failed,
  after a workspace failure) as soon as its working copy is removed, and stays stopping, with Stop or the next start retrying, if
  the removal fails. A restart that finds a
  run's turn still live is held the same way, whether the runtime reports it live or
  cannot say: nothing interrupts a turn of a previous runtime process, since Codex
  and Claude Code cannot inspect or interrupt a historical execution by its recorded
  identity. The run keeps its capacity and its copy, shown as stopping, until a start
  verifies the recorded process ended. This is an accepted limit. The panel shows a run in progress from its own state even when
  the project has lost its lead; the lead only gates starting another.
- **Fill.** Nothing is saved or created until Save draft or Create. An empty title or
  outcome field is filled. A field the operator already typed in shows the proposal
  beside it with Replace or Keep, so typed text is never overwritten silently. An
  interrupted or failed run shows "Draft interrupted" or the failure with Retry, and
  keeps the operator's idea, title and outcome. The operator can cancel instead. A
  proposal that still cannot be shown when read, because the operator's exclusions
  would change it, is withheld whole: it is never shown empty or altered, never filled
  and never accepted automatically, and the operator can discard it. A run whose
  working copy could not be prepared settles as failed, however late its copy is
  finally removed.
- **Reattach.** The composer's local draft stores the run id, so leaving, reloading
  or locking a phone reattaches to the run. The service keeps a proposal until the
  operator accepts or discards it, or it expires 24 hours after it arrived. A draft
  belongs to the project it was started for: changing the composer's project, or
  discarding recovered input, stops or discards it, and the composer says so.
- **Issue runs.** Improve with lead is a second kind of drafting run with the same
  profile, access, capacity, Stop, cap, restart and reattach rules. `issue.draft.start`
  names an open imported task and an optional operator note (up to 16,000 characters). The
  run records the synced title and body it starts from, which the lead is shown with the
  note, and it may run while the task has work running. Its own result tool, not the
  brief tool, proposes a replacement title (1 to 512 characters) and a non-blank body (up
  to 64,000), the `issue.edit` limits; the text it replaces may be up to GitHub's 65,536
  characters, and a longer issue cannot start a draft; a brief run is offered only the brief tool and an
  issue run only the issue tool. A proposal is validated, checked against the operator's
  exclusions before it is stored, and withheld whole, never shown empty or accepted, if it
  cannot be shown. The operator's edited text is held in the browser session with the run
  id until it is reviewed or discarded; Redraft starts a new run from the current text.
  An issue run creates no task, assignment, result or delivery record.
- **Operator CLI.** The CLI does not offer drafting or Improve with lead; see
  [Operator CLI](design/operator-cli.md).

Status: implemented, on Codex and Claude with fake-host tests and on Codex in one
bounded live run ([evidence](evidence/2026-10-18-drafting-live-run.md); [acceptance plan](acceptance.md#drafting-runs)).
The operator API carries `drafting.start`, `drafting.stop` and `drafting.settle`
commands, plus `issue.draft.start` for an issue run, receipted by key, and one read of a
run by id that says its kind and carries a brief or an issue proposal. A run that is held because its
end cannot be verified stays held until a later start verifies it; there is no operator
recovery for drafting.

### Imported issues and source ownership

Make the distinction between local tasks and imported issues visible. Imported task
detail shows the provider, repository and issue identifier, a source link, the last
successful sync, refresh and any sync failure or stale state. Present external
issue status and Project fields separately from cab execution state; an open
GitHub issue can have work waiting for approval in cab.

For the MVP, imported titles and descriptions are read-only in the operator UI,
with Edit on GitHub linking to the source. The local task composer does not edit
imported issue content or create a competing local brief. This UI restriction does
not replace the separate approval required for any integration title/body edit.

**Improve with lead.** On an open imported task the operator can ask the project lead to
draft a better title and body, edit the draft, review it against the issue's current text
and send it as one GitHub issue edit ([drafting runs](#drafting-runs), [operator issue
edit](#github-and-completion)). It is offered on any open imported task, including one
with running work, one that is not Ready and a held one: an edit waits for none of them.
It needs the repository's `issue.edit` grant, a project lead and a delivery credential,
and is unavailable while an earlier GitHub action on the task has an unknown outcome. The
task read gives the first reason that applies, in that order: no source issue, task not
open, no edit grant, no project lead, an unresolved action, no delivery credential.
cab keeps no copy of the edited text and no local override: the edit goes to
GitHub, and the next sync observes the new title and body like a hand edit, including
any source review that raises. Nothing is sent without the operator reviewing it.

**Publish to GitHub.** The operator can turn a local task into a GitHub issue
([ADR-1018](adr/1018-task-publication-in-place.md)). It is initiated only from task detail
and the CLI, never by an agent, and the same task becomes that issue's imported task, so the
next sync matches it instead of importing a duplicate. This is the one place a task changes
from local to imported; its title and description are source-owned from then on.

- **Eligibility.** A never-started open local task: not imported, not started (no workspace
  or execution binding, which a draft turn creates), with no local dependency edges as a
  dependent (a task that blocks others may be published; edges are neither dropped nor
  converted), no unresolved publication, a GitHub source with a linked repository and a delivery
  credential. The task read gives the first reason that applies, in that order.
- **Targets.** Each `repository` selection whose repository is linked, and each unfiltered
  `project` selection crossed with each linked repository. `search` and filtered `project`
  selections are listed disabled (`selection-unpredictable`), because whether a new issue
  would match cannot be predicted. A target is also disabled without an `issue.create` grant on
  the repository, a `project.item.add` grant for the Project, or the `project.field` grants its
  readiness writes need; when a Ready task's rule needs a Project field the target cannot set
  (`readiness-unsatisfiable`); and for a Draft task where the project has no readiness rule,
  since a new issue would then make it Ready (`would-become-ready`). Every enabled target predicts
  that the new issue matches the selection and that the task stays as Ready as it is.
- **Ready.** A Draft task never receives readiness labels or fields. A Ready task gets what its
  rule needs on the new issue: under `all`, every label condition and every field condition on the
  target Project; under `any`, the first label condition, else the first field condition on the
  Project. The task keeps its Ready flag through conversion and the next sync recomputes it from
  GitHub; a write that did not land leaves the ordinary readiness-lost or withdrawn hold
  ([ADR-1017](adr/1017-non-agent-readiness-writes.md)).
- **Review, confirm, send.** Review freezes the exact issue (title, body, labels), the target and
  the operation ids of its steps; confirm is the approval in either grant mode and names the
  repository, the text, the labels and fields, the predicted selection and Ready, and that nothing
  reverses it. Send creates the issue, then for a Project target adds the item and sets each
  readiness field, each as its own recorded delivery action with intent before effect. Until the
  outcome is known the write shows as pending, the task is held, and its title, outcome, Ready,
  state and dependencies cannot be changed.
- **Conversion.** After the create is confirmed and the other steps are recorded (confirmed,
  failed or unknown), the task is converted in one transaction. No field is written to an item that is
  not known to exist. GitHub's lists trail a create, so a converted task is forgiven **one** complete
  read of a selection that omits its issue: it keeps its membership, its Ready flag and no hold. A
  second consecutive complete read that omits it (a failed or unknown item add leaves the predicted
  Project membership exactly this way) removes the membership and the ordinary withdrawn hold applies.
  A read that lists the issue again resets the count, and a complete one releases the withdrawn hold
  when the task is Ready, as on any imported task.
- **Unknown create.** The read-back confirms nothing from an empty list. The task stays held and
  nothing is sent again, across restart; a sync skips a new issue carrying an unresolved
  publication's marker. The operator can **Link** a named issue, which must carry the marker and the
  exact text, after which the remaining steps run and the task converts, or **Abandon**, which
  returns the task to local with a warning that GitHub may still have created the issue (the next sync
  would then import it as a separate task). A create GitHub provably refused leaves the task local.
- **Irreversible.** Closing the issue on GitHub is the only recovery. Bounded live evidence: [task publication live run](evidence/2026-10-22-task-publication.md). Publishing is offered only on
  task detail and by the CLI; the board, list and context menus do not offer it.

Label native GitHub dependencies as source-owned and link to the source; do not
offer local overrides. Distinguish Message lead from any permitted Post comment to
GitHub action, including the destination before submission. Local messages do not
implicitly publish comments or edit issues. Keep assignments, conversations,
execution controls and results distinct from provider-owned fields.

Show remote writes as pending until their outcome is known, then as confirmed
success, confirmed failure or uncertain. Do not present local or optimistic state
as a confirmed GitHub update. Refreshing or retrying must preserve the existing
remote-write reconciliation and permission rules.

### Task detail

The initial task view presents the outcome, current situation and next actor,
unresolved decisions, and relevant results or evidence before detailed history.
Keep delivery observations, artifacts, dependencies, assignments and captured
conversations accessible within task detail. Understanding current work
must not require reading raw runtime output.

Preserve the task, assignment and conversation hierarchy: the task retains the
outcome and accountable lead, assignments identify delegated responsibility, and
conversations supply supporting history. Use recorded facts and attributed,
source-faithful excerpts for the overview. Do not invent narrative summaries,
recommendations or ownership when the evidence is absent. Unavailable or stale
evidence remains explicit. This presentation adds no terminal, embedded browser
or complete-transcript capability.

Every entry point that opens a task (Overview, List/Board, Inbox, Search, recovery
links and assignment links) reaches the same task workspace at `/app/tasks/:id`.
Preserve visible actionable requests, reading position, disclosure choices and
unfinished replies as the task updates. Existing execution, recovery and
exact-material approval controls remain reachable.

### Draft turns

A **draft turn** is a turn of a task's project lead that the operator starts while the
task is not Ready ([ADR-1015](adr/1015-draft-turns.md)). It lets the lead read the task
and its repositories, investigate and ask the operator questions before anything is
admitted for work. It is not a new kind of request: it is a mode of the lead
assignment, so it keeps the lead's conversation, task workspace, questions, receipts and
history.

- **Entry points.** On a Draft task the task page's reply becomes **Start draft turn**,
  with the reason in its place when a draft turn is not available. A project without a
  lead, or a lead that has started, keeps the ordinary reply and its own sentence.
  `cab task draft-turn TASK_ID --expected-version N --message-file FILE
  [--request-id UUID]` does the same. Both send `task.draft-turn {key, taskId,
  expectedVersion, message}`; the message is trimmed and 1 to 16000 characters. The
  receipt records the lead assignment and the work ID and is replayed for the same key
  and content. The command cannot be retracted; Stop holds a queued draft turn and Resume
  releases it.
- **Availability.** The task must be open and not Ready, and have a configured,
  unrevoked lead that has not started ordinary work. One draft turn is queued, held or running
  per task. Otherwise the command is refused with 409 `conflict` and a reason
  (`task-not-open`, `task-ready`, `lead-unconfigured`, `lead-revoked`, `lead-unavailable`,
  `draft-turn-active`), which the task read also reports. A Ready task keeps the ordinary
  reply. Project pause, task Stop and capacity do not refuse a draft turn; they hold the
  queued turn like any other.
- **Admission.** Admission drops the task-unready reason for a draft turn, and the
  task-revision-changed reason only while the task's title and outcome match the digest
  captured when the turn was queued, so making the task Ready never makes it stale and
  any edit does. A draft turn refused before it ran gives its messages back (they are
  pending again) and stops counting as the task's draft turn. Ordinary work on a Draft
  task keeps every gate. A draft turn never changes the
  lead assignment's state, creates assignments, results, completion requests or pull
  request bindings, edits task fields, or grants readiness.
- **Tools.** The lead may ask questions, request approval, and use external actions of
  kind `issue.comment` and `issue.labels` where the project's grants allow them. The
  service refuses every other coordination tool with a deterministic message. The
  existing refusal of readiness labels and fields stays the only readiness protection; label names
  match case-insensitively, as on GitHub.
  An answer to a draft-turn question waits for the next draft turn or for Ready; it
  never starts a turn.
- **Access.** Codex runs the turn with a per-turn read-only sandbox policy and Claude with
  the workspace removed from its writable roots and file-edit hook. Command network
  access is off whatever the project setting says. Reads keep the runtime's host access.
  cab sends the policy and does not claim an independent sandbox. The Codex proof is
  [recorded](evidence/2026-10-19-codex-read-only-turn.md).
- **Ready.** The lead stays pending through draft turns. When the task becomes Ready,
  routing runs as for any task, without a preliminary lead turn, or, with routing off, the
  lead's initial turn runs as ordinary execution and resumes the same conversation. With
  routing on, a lead that has only had draft turns waits for the routing decision even
  when answers are pending, and after a routed assignment it waits for the routed result, so a message to it waits too. A draft turn that is still queued or running when the task
  becomes Ready finishes read-only first. Draft prompts and the first ordinary turn after
  draft turns carry the task's current title and outcome.
  Automatic draft turns, triage procedures and readiness proposals are not part of this.

### Start again and Reset task

Two keyed, task-versioned operator commands restart work without a force unlock: there
is no way to release an execution that may still be writing, and interrupted, unknown,
submitting and held work stays with the `recovery` commands.

- **Start again** (`task.start-again {key, taskId, expectedVersion, workId}`) queues an
  assignment's newest request again when a witness-only proof shows it was refused at
  admission before it ran: the request and intent are held with their matching revision
  refusal and an exact binding; no thread or turn, writer admission, capacity
  reservation, recovery identity, pending effect or stop target is recorded. It does not
  read the refusal's reasons; every current admission check applies again to the new
  request. The refused request and its refusal stay in the history, linked to the new
  request by a restart record, so the restarted work is historically resolved. The new
  request is captured at the current task, profile and instructions revisions, takes the
  assignment's inbox batch and any waiting events in order, and runs in the task's
  workspace. A conversation that has not seen the brief gets the task's current title and
  outcome with it. Nothing is sent to the lead. Replay returns the same receipt; another
  request under the key, a stale task version or a `workId` that is no longer the
  refused request is a conflict. When several assignments qualify the newest by sequence
  is the target.
- **Not offered** for a closed task (`task-not-open`), a source hold (`source-held`, review
  the source first), a held assignment (`assignment-held`), a request cut off during
  submission (`submission-interrupted`), any assignment's newest request that is held for another reason or a writer,
  ambiguity or archival hold (`execution-unresolved`) or when nothing was refused (`nothing-refused`).
  Each refusal is a 409 `conflict` with the reason, which the task read reports as
  `startAgain`, with the recovery that applies. A Stop hold, pause or capacity does not
  block it; the new request queues and is held like any turn.
- **Reset task** (`task.reset {key, taskId, expectedVersion}`) starts a new conversation
  for every assignment of the task: the existing conversation replacement, then a fresh
  first turn for the current lead only, who re-delegates. Other assignments are not
  revived. A completed lead is reopened for it. The old conversations, results, history
  and the workspace stay readable and are kept, not reprovisioned. The lead's refused
  request, if any, gets a restart record. Reset is available only on an open, Ready
  task whose lead has started, with no queued, running or unresolved execution, writer,
  capacity or effect state, and no task, Stop, source or assignment hold; otherwise it is
  refused with `task-not-open`, `task-not-ready`, `lead-unconfigured`, `nothing-to-reset`,
  `execution-unresolved` or `task-held`. It cannot be undone: there is no restore, and
  the operator UI and CLI say so before sending.
- **Entry points.** The task page's decisions, the Inbox intervention and Home's Needs
  you card offer **Start again** for the `not-started` attention code; the task header
  offers **Reset task…** behind a confirmation. `cab task start-again TASK_ID
  --expected-version N [--work WORK] [--request-id UUID]` and `cab task reset
  TASK_ID --expected-version N [--request-id UUID]` send the same commands and print
  the same reason text.

### Task brief, evidence and delegation

The task workspace brings the brief, delegation, latest result and supporting
evidence together:

- **Shared task brief.** Make the desired outcome, supplied acceptance criteria,
  current approach, recorded decisions and unresolved questions easy to find.
  Preserve provenance: imported GitHub content remains authoritative and read-only
  locally, while agent plans and decisions are distinguishable from requirements.
  Do not create a competing editable specification or invent missing criteria.
- **Evidence beside results.** Present relevant screenshots, artifacts and
  validation alongside the result or acceptance criterion they support, when that
  relationship is recorded. Identify the reporting assignment and relevant work
  or artifact revision. Distinguish agent-reported claims from recorded verification;
  absent, unavailable, stale or redacted evidence cannot imply a passed criterion.
  Keep earlier results accessible without presenting them as the current outcome.
- **Readable delegation.** Show each assignment's responsibility, assignee,
  requester, known reason for waiting and result destination. Keep the accountable
  project lead identifiable and distinguish assignments sharing a profile. Use
  durable coordination and runtime observations rather than inferring ownership,
  waiting or completion from conversation text. Unknown state stays explicit.
- **Compact progress across tasks.** Summarize the current work state, known wait
  reason and latest available result using source-faithful text. Keep ordinary
  progress and dependency waiting separate from decisions needing the operator.
  List, Board, overview and attention entry points must lead to a consistent task
  experience without losing project or source context.
- **Criterion outcomes.** Summarise supplied criteria using their recorded
  evidence relationships. Distinguish supported, failed, unverified and stale
  evidence; expose the supporting result, assignment and revision. Do not infer
  an overall pass from agent claims, missing checks or a count of supported rows.
  Criterion extraction covers supported literal checklists only; without
  structured records, direct the operator to the supplied brief rather than
  claiming no criteria were supplied.
- **Before/after comparison.** Pair recorded captures with labels identifying
  their role, result and work/artifact revision. Keep the relevant criterion and
  evidence context reachable. Missing, unavailable, redacted or mismatched
  captures remain explicit; an image comparison does not itself verify a
  criterion. Comparison is also usable on phone.
- **Contextual feedback.** From a result, criterion or artifact, let the operator
  inspect the context and edit an “Ask lead for changes” draft before sending.
  Show the accountable lead destination and preserve the exact recorded anchors.
  This is an ordinary local message under existing permissions: it does not
  approve, reject, change task readiness or completion, or post to GitHub. To a
  completed lead on an open task it is an
  [operator follow-up](#operator-follow-up-to-a-completed-lead). A confirmed
  failure retains an editable draft for retry; an unknown send outcome requires
  existing reconciliation before another send, and confirmed delivery has a
  receipt.
- **Changes since viewed.** Identify newer results, superseded evidence and
  changed source requirements relative to the recorded viewing reference.
  Keep earlier revisions accessible. Viewing is not approval. Show no baseline
  or unknown source comparison explicitly; a failed refresh cannot establish
  that requirements are unchanged.
- **Captured assignment context.** Show who supplied the brief, its captured
  version, recorded instruction/profile revisions and source references, with
  unavailable or incomplete capture explicit. Distinguish that assignment's
  captured context from current requirements. A reference being available does
  not establish that an agent read it. Do not expose secrets or imply complete
  runtime visibility.
- **Recorded changes and delivery.** Keep recorded files, commits, result diff,
  PR identity, checks and findings close to the result. Attribute repair ownership
  only when recorded. Identify provider state, the checked head/revision and
  stale or changed-head evidence; retain a useful no-PR state. Provider refresh
  is a read. A merged PR does not complete the cab task, and these views
  retain exact-material approvals and independent dependency/recovery holds.
- **Search recorded work.** Provide discoverable Search in shared desktop and
  phone navigation for retained tasks, decisions and results within permitted
  project access. Every match identifies its project, parent task and record type,
  including similar matches from different projects. Open the exact matching
  section and revision, with historical results labelled. Return preserves query,
  filters, selected match and reading position; returning to the originating
  workspace preserves its view state. Distinguish no matches, partial coverage
  and failed search. Search does not promise a complete runtime transcript or
  access to unavailable, redacted or unretained material.

Integrated editors, terminals, browsers, extra execution providers and remote
execution are outside this scope. The [task workspace evidence](evidence/ui04-task-workspace.md)
records deterministic qualification and its visual and runtime limits.

### Task workspace inspection and local review

The task workspace provides **Files**, **Changes**, **Retained result evidence**
and **Local review** sections of the authenticated task route, so every entry
point that opens a task reaches them. This is post-MVP capability; it adds no
release or cutover gate. The Files, Changes and Review entries under the latest
result scroll in place and keep the entry's origin for "Back to originating view". Exact links accept `path` with optional
`repository`, comparison `target`/`repository`/`base`, `result` with `evidence`,
and a sent `review` operation; missing or unauthorised targets explain their
state and never substitute other bytes.

- Give reviewing code changes and inspecting generated outputs equal weight,
  including repository-free task outputs.
- Preview text/code, Markdown, common raster images and PDFs. Inspection is
  preview-only: unsupported files remain visible with metadata, without file
  downloads, workspace export or execution.
- Preserve bounded copies of result-linked files and diffs so that exact result
  evidence remains inspectable after later workspace changes or removal. Do not
  promise a retained snapshot of the entire result workspace.
- Hide ignored clutter initially and allow the operator to reveal ignored files.
  Sensitive/private-path exclusions remain enforced in every inspection surface.
- Offer a comparison dropdown with Branch, Last turn and Uncommitted targets.
  Uncommitted supports staged and unstaged filters. Branch compares current
  contents against the merge base with the task's base branch, displaying that
  branch and exact baseline commit.
- Last turn means the actual most recent agent turn that could change the task
  workspace, not the latest reported result or completed assignment. It requires
  bounded before/after change capture, identifies the agent and discloses
  incomplete capture. Existing result/work revisions alone do not provide it.
- Keep only the latest finished turn's capture as turn history. Evidence retained
  with a result has its own lifetime and must not disappear when that turn
  capture is replaced.
- Keep the displayed inspection stable until explicit refresh, with observation
  time and known changes disclosed. Inspection does not pause agents or clear
  any execution, dependency or ownership hold.
- A capture that is excluded, oversized, unavailable or changing records a
  specific evidence gap rather than blocking the result. Never substitute later
  bytes for the missing historical capture.
- When the base branch cannot be established, show the missing baseline and let
  the operator select a locally available base branch for inspection. This does
  not fetch, check out a branch or silently substitute a guessed baseline.
- For a failed, interrupted or uncertain latest turn, show any available partial
  observation with its recorded outcome, time and unsettled state. Missing
  capture remains unavailable; observing a diff cannot establish that execution
  or further writes have ended.
- Identify each repository and its own comparison baseline. Repository-free
  workspaces support file inspection and turn capture; Git comparisons are
  unavailable there. Include untracked, deleted and renamed files where
  applicable, with truthful binary/unsupported states.
- Restrict every listing, preview and capture to authorised task contents.
  Reject unsafe paths and symlink escapes; enforce bounded reads and rendering
  without exposing excluded content or executing inspected content as the app.
  Existing historical results are not backfilled with later bytes. Editing,
  terminals, whole-workspace snapshots, arbitrary revision comparison and native
  desktop integration are outside this scope.

The [inspection acceptance scenarios](acceptance.md#post-mvp-task-workspace-inspection)
define the required evidence. The numeric limits below are engineering bounds
within these contracts.

#### Files and previews

Authenticated JSON GETs return a task workspace directory listing and one file
preview. Each request names a current task and either the repository-free
workspace root or an exact bound repository ID; clients cannot supply filesystem
roots. The session is checked again after the awaited read. These routes provide
no file download, terminal or edit action.

The server scans one directory level, with a maximum of 32 path segments and
2,048 UTF-8 path bytes, 4,096 entries scanned and 256 returned, a 2-second Git
ignore check with 1 MiB combined output cap, and a 2 MiB Git input cap. Text and
code are limited to 1 MiB; PNG, JPEG, GIF, WebP and PDF payloads are limited to
8 MiB. Raster dimensions are limited to 16 megapixels. PDF is returned only as
bounded base64 data with a 10-page display limit. Failed Git ignore
classification returns an incomplete availability result rather than revealing
entries whose ignore state is unknown.

Both workspace and repository scopes omit `.git`, `.ssh`, `.aws`, `.gnupg`,
`.netrc`, `.npmrc`, `.pypirc`, `.env`, `.env.*`, `*.pem` and `*.key` path
components, case-insensitively; direct requests return an empty excluded state.
`showIgnored` reveals Git-ignored repository files and the documented
repository-free clutter names (`.DS_Store`, `node_modules`, `.cache`,
`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache` and `coverage`),
but never overrides private-path exclusions. Previews require a regular
single-link file, a no-follow open and stable file, root and task-binding
identity around the read. Text, Markdown and HTML are inert UTF-8 in JSON;
raster and PDF bytes are typed base64 data, never navigable file responses.
These checks enforce path-based exclusions and bounded current-file reads;
they are not semantic secret scanning or host-wide read isolation.

The Files section renders Markdown inertly with a Source view, fits/zooms/pans
rasters, and renders PDFs through a pinned `pdfjs-dist` worker onto an app-owned
canvas. There is no download, export or execute action. Opening current contents
from retained evidence is a separate explicit action. Read-only inspection
rechecks may reuse a successful Git worktree identity read for up to 1 second
while the worktree root and its `.git` entry keep the same filesystem identity.
Execution admission always rereads Git.

#### Comparisons and turn capture

Authenticated JSON comparison reads are served at
`/api/operator/tasks/{taskId}/comparisons`. Branch reads compare against the
exact merge-base commit of an operator-selected local base branch. Without a
selection they default to the task repository's configured ref when it names a
local branch; otherwise the operator selects one. They do not guess a base or
fetch or check out refs. Uncommitted reads support all,
staged and unstaged changes. Repository-free tasks can be observed around an
actual workspace-capable turn, while Git comparisons remain unavailable.
Comparison IDs stay stable until an explicit refresh; an old ID is never
silently redirected to newer workspace contents. Current exclusion, binding,
task-access and session checks apply again before stored comparison projections
are returned. Local Git reads follow the Git subprocess rule under
[Workspaces and execution access](#workspaces-and-execution-access) and also
disable fsmonitor and replacement refs. Before a working-tree diff, the service
discovers only configured clean/process filter names, applies empty command-line overrides with
`required=false`, and checks the names again afterward. Discovery accepts at
most 64 ASCII driver names of at most 64 bytes and 16 KiB of key-name output;
malformed, oversized or changed names produce a gap. This recheck reports
observed name changes but does not claim containment of concurrent Git-config
edits outside that observation. The reader does not execute those filters or
write Git configuration.

The Changes section reads these exact-ID comparisons. Each repository keeps its
own local base and change set. Split and unified diffs share line selection, and
phone shows only the unified diff.

The durable SQLite turn slots keep the latest finished capture and a separate
pending or unsettled capture. A capture records the admitted task/work revision,
request sequence, assignment and profile revisions/IDs, exact runtime thread
and turn IDs when bound, outcome, timestamps, before/after observations, and
immutable comparison sides. Capture or store failure remains an explicit gap;
it does not determine runtime completion, clear a hold, or replace the previous
finished capture. Exported side text is checked against its original byte hash,
size, line count, path, side and range before it is retained or returned. This
export feeds retained result evidence and review context; the bounded copy
remains distinct from the latest-turn slot and from review delivery.

Comparison and each before/after observation scan at most 4,096 entries and
return at most 256. A text file or side is limited to 1 MiB, source bytes to
8 MiB per comparison/observation, combined Git-child output to 2 MiB, and
rendered diff output to 1 MiB. Diffs are limited to 2,048 lines per side and
4,000,000 diff operations. Each local Git child has a 1.5-second timeout, and
each comparison/observation has a 5-second clock. Durable serialized comparison,
side and capture payloads have a 20 MiB per-record limit.

The 5-second clock is an observation budget: when useful scan/read work exceeds
it, the comparison records a `time-limit` gap. Awaited workspace validation,
current-policy checks and bounded Git-child cleanup may extend beyond that
threshold, so it is not a strict wall-clock response guarantee. These limits
can produce incomplete comparisons and are engineering bounds, not a claim of a
whole-workspace snapshot. Real Codex turn capture is qualified by one bounded
repository-free journey ([evidence](evidence/wi03-turn-capture.md));
fake-runtime evidence does not establish broader native runtime behaviour.

#### Retained result evidence

The service captures bounded evidence during the accepted
`cab_report_result` callback, before recording its result and callback
receipt. Eligible sources are linked artifact files, supplied change-file
references read through the existing safe workspace reader, and a compatible
exact turn-comparison export. A direct result-recording path that does not pass
through this callback keeps its prior behavior; results recorded before retention
existed remain references and are never backfilled from current files. A callback
with no eligible file links records an empty manifest. Exact callback replay
returns the committed result and original manifest without rereading the workspace.

Each manifest binds its result, task, assignment and work revisions, request
sequence, profile/instructions revisions, runtime thread and turn, capture
time, and comparison observation identity. `taskVersion` is the exact revision
admitted by the turn request; `captureTaskVersion` is the current task revision
used for workspace and access-policy checks. A metadata edit after admission but
before the callback preserves the admitted request identity while capture uses
the current revision. If that current revision changes during capture, result,
receipt and evidence commit together only when the exact binding still matches;
otherwise the transaction is rejected without partial acceptance. Available
bytes live in SQLite BLOBs. Capture, policy, read, size and quota failures are
represented as explicit gaps while a valid result is recorded. A stale or
foreign result binding remains rejected; an unrecoverable SQLite result/receipt
commit failure rolls back the result and evidence together. Pending or unsettled
comparison exports produce a diff gap. The service does not substitute an older
turn or backfill that gap from a later comparison, and capture time does not
imply that the callback stopped later workspace writes.

Authenticated task-scoped reads resolve exact result and item IDs and recheck
the current task, project, session, repository and path exclusions. A retained
diff is withheld if any included path, including either rename path, is now
excluded. A new retained gap or unavailable item never falls through to a
matching live file. Legacy records without a retained manifest keep the
existing reference behavior. Text and image/PDF previews retain the original
captured bytes under the existing preview limits; original filesystem roots
remain internal. The Retained result evidence section shows capture provenance,
item states and original bytes; gaps are never backfilled from later bytes.

The logical payload limits are 1 MiB per retained text file, 8 MiB per image or
PDF, 1 MiB per serialized observed diff, 32 selected files and 32 MiB per
result, 128 MiB of result payload per task, and 512 MiB across retained result
and review payloads per installation. Review context is limited to 256 KiB per
anchor, 128 anchors and 16 MiB per task within the same installation pool.
Quota pressure records a gap for new material and never evicts referenced
bytes. These limits count logical BLOB payloads; SQLite pages, indexes, WAL and
filesystem overhead can increase disk use. Offline SQLite backup, verification
and restore include retained evidence BLOBs; managed workspace contents remain
outside the snapshot.

#### Local review

File inspection remains read-only; review drafts and submission are explicit local
feedback actions. The single-message contextual feedback workflow remains
available alongside batched reviews.

- Select a single line or range in supported text previews or either diff side,
  including deleted lines. Collect comments across files within the same task;
  add, edit or remove draft comments and supply an optional overall summary.
- Bind each comment to exact task/repository/file content identity, line range,
  applicable diff side and source comparison/result/turn context. Retain bounded
  reviewed context independently of latest-turn replacement or workspace cleanup;
  this extends retention to review anchors, not whole workspace snapshots.
- Later changes mark affected comments outdated without silently moving them to
  newer contents. Unavailable or unknown comparisons remain explicit; file paths
  and line numbers alone cannot establish exact identity. Retention limits and
  access exclusions still apply, and missing original context is never replaced
  with newer bytes.
- Let the operator inspect the complete draft and named project-lead destination
  before Send review. Submit the comments and optional summary together as one
  logical review, with a receipt and exact anchors available to the lead.
- Preserve drafts through navigation and refresh under existing session/privacy
  rules. Confirmed failures retain editable content; uncertain submissions keep
  their original payload and identity for reconciliation without duplicate sends.
  A draft write that is lost, or still unanswered when the operator leaves the
  task page, stays checkable from the Local review panel on return, and the check
  replays the same request. A browser reload discards that pending check; the
  server draft stays authoritative, so an anchor staged for a comment that was
  never saved is left unused.
- A review delivers local feedback only. It does not publish to GitHub, approve
  or reject work, change readiness, grant merge authority or clear holds, and it
  never reopens or completes a task. Sent to a completed lead on an open task, it
  resumes that lead assignment as an
  [operator follow-up](#operator-follow-up-to-a-completed-lead). Submitted reviews
  remain recorded feedback; draft removal does not retract a submitted review.
  Retraction, threaded resolution and formal review verdicts are not supported.

Review anchors retain a bounded original excerpt, exact source hash, line and
byte range, side, source identity and observation time. Comments stage exact
anchors through `review.anchor.stage` from a current file (`workspace-file`), a
comparison side (`comparison-side`) or a retained file item (`result-evidence`);
Shift extends a line range. Anchors are allowed for the repository-free root and
for repositories linked to the project, which is how production binds task
repositories. Drafts may select a current workspace file or
an exact comparison side without a result. A supplied result association is
validated against the same task/work and exact source comparison where
applicable; a comparison-side anchor remains comparison evidence even when
associated with a result whose callback-time diff is a gap. Sealing moves the
exact anchor IDs into a durable submitted-context reference; it is not a review
delivery or receipt. Discarding a sealed draft preserves its submitted context.
Anchors continue to resolve their original excerpt after file edits, latest-turn
replacement, workspace archive/cleanup and service restart; missing comparisons
are reported as unknown or unavailable without retargeting to newer bytes.

- `GET /api/operator/tasks/{taskId}/review-draft` returns the current
  session's draft. `review.draft.save` and `review.draft.discard` carry the
  expected draft version. Limits are 32 comments, 4,000 characters per comment
  or summary and 16,000 serialized bytes per draft; oversized drafts are
  rejected before any anchor seal or event. A sent draft stays frozen until
  discarded, which starts the next review and keeps submitted context.
- A draft belongs to its authenticated session and to an access fingerprint
  made of the task, project, workspace binding, exclusions, linked repositories
  and control paths. Sign-out, expiry and restart remove an editable draft.
  After an access change the draft's text and anchors are rechecked: it is
  kept and rebound when still permitted, and removed only when something is
  now excluded. A "removed unsent draft" notice appears only when the removed
  draft had text or anchors, and clears on the next draft save. Unrelated task,
  profile or configuration version changes do not remove a draft.
- `review.send` freezes one operation for the named project lead, who must be
  the task's current lead assignment: pending or running, or completed on an
  open task, which the review resumes as an operator follow-up. Any outcome
  without a receipt is unknown. The draft read exposes the owning session's
  frozen operation, and the browser keeps only its identity, never comment text.
  Reconciliation uses `review.send.reconcile` with the same key and material. A
  rejected or not-recorded receipt returns to the editable draft.
- The lead's message gives each comment's exact source: repository or task
  workspace, path, lines, context, side, comparison or result item, turn,
  source hash and retained anchor ID, plus an original excerpt of up to 12
  lines or 800 characters. A shortened excerpt is marked as shortened. When
  excerpts would take the message past 16,000 bytes, all excerpts are omitted
  and the message says so. If identities alone still exceed the limit, the send
  is refused with `local-review-batch-too-large` before any operation is
  recorded, and the draft stays editable.
  `GET /api/operator/tasks/{taskId}/local-reviews/{operationId}` shows the sent
  review with original anchor context under current access policy, and a
  recorded one carries `recordedAt`, the time it was recorded. Text from a
  rejected or not-recorded operation is shown only to its own session.
  `GET /api/operator/tasks/{taskId}/local-reviews` (no query parameters) lists
  up to 50 recorded reviews newest first, each with `operationId`, `reviewId`,
  `recipientAssignmentId`, `eventId` and `recordedAt`. Unsent operations are
  never listed. Both reads apply the current session and access policy.
- Definitive no-delivery outcomes keep the draft editable. A frozen operation
  whose anchor is unavailable when sent is rejected with `anchor-unavailable`
  (an excluded anchor with `excluded-anchor`). When the named recipient is not
  the task's current lead, the lead is held, the task is not open, or a
  completed lead's latest result is not its newest unambiguous work, the send
  is refused with `local-review-recipient-unavailable` (409) before any
  operation exists.
- Review delivery queues one local operator message and receipt; to a
  completed lead it queues one operator follow-up instead. It never calls
  GitHub or changes approval, readiness, merge authority or holds, and it never
  reopens or completes a task.

#### Operator follow-up to a completed lead

Addressing feedback to the task's lead is the request to resume it. A review can
therefore change the lead assignment's state, but never the task's readiness or
completion.

- An ordinary or contextual operator message, or a local review, sent to the
  task's current lead whose assignment is completed, while the task is open,
  records an operator **follow-up**: the same lead assignment returns to pending
  under a new assignment version and work revision, linked to the lead's latest
  result. The message or review is delivered as the follow-up's instructions with
  exact anchors, and its receipt records that the send resumed the lead.
- Before sending, every entry point that addresses the lead states that the lead
  has completed and will resume. Send keeps its label; messages and reviews use
  the same wording.
- If the lead completes after the operator began composing, the send is still
  delivered as a follow-up and the receipt records the resume.
- Feedback is refused, with the draft kept editable, when the task is done or
  cancelled, the lead is held, the addressee is not the current lead, or the
  lead's latest result is not its newest unambiguous work. Feedback never
  reopens a task; that remains a separate explicit action.
- Receipts, idempotent replay and unknown-outcome reconciliation are unchanged;
  replaying a send never resumes the lead twice. A delivered follow-up cannot be
  retracted; the existing pause and stop controls are the recovery path.
- Holds, approval, readiness, merge authority and delivery settlement are
  unchanged. On a paused project, admission still holds dispatch.
- A local review does not resume a lead whose recovery continuation is waiting
  on an operator message. While that continuation waits, the Local review panel
  says that sending the review will not resume the lead and that an ordinary
  message is needed.

Contract details:

- The follow-up reuses the agent follow-up mechanism: one
  `assignment-follow-up` inbox event whose `instructions` are the message or
  the rendered review (with any contextual `reference`), and one
  `coordination_follow_ups` row whose `requester` is `operator`. The resumed
  turn's new work revision is allocated at admission, as for agent follow-ups.
- The `message` command's `coordination` receipt, the `review.send` and
  `review.send.reconcile` `local-review-operation` receipts and the local review
  operation read carry `resumedLead: true` when the send resumed the lead.
  Replay returns the same receipt.
- Refusals for a completed lead are definitive 409s: `conflict` for messages
  (`Follow-up unavailable: task is not open`, `Follow-up unavailable: latest
  result is not the newest unambiguous work`, or the existing
  pending-or-running refusal for a held lead or non-lead) and
  `local-review-recipient-unavailable` for reviews. A defensive guard also
  refuses a result that already has a follow-up (`Follow-up unavailable: latest
  result already has a follow-up`); a follow-up returns the lead to pending and
  any turn that completes it again has newer work, so this is not expected to
  occur.
- Resumability keys on the result's work identity, not the assignment version:
  the lead's latest result stays resumable while it is the newest unambiguous
  work of the current conversation. Adopting current instructions on a completed
  lead therefore keeps it resumable, and the resumed turn runs under the adopted
  revisions.
- The operator task read adds optional `leadFeedback`: `mode` is `receives`,
  `resumes` or `unavailable`, computed by the same rule that accepts the send,
  and `awaitingRecoveryMessage` is true while an ordinary operator message to
  the lead would record a waiting recovery continuation. A follow-up never
  records a recovery continuation.
- The operator task read adds optional `repositoryLinked`: true when the task's
  project links at least one GitHub repository. It carries no names or paths. The
  task page shows delivery status and refresh only for a task with a GitHub
  source, a linked repository or a bound pull request.
- The task Reply composer (including contextual "Ask lead about …" drafts) and
  the Local review panel show one status line from `web/src/lead-feedback.ts`:
  "<Lead> has completed its assignment and will resume to address this
  feedback." A resumed send reports "Sent. <Lead> resumed with this
  feedback." in the composer and "<Lead> was resumed with this review as a
  follow-up." in Local review. Local review shows the recovery-continuation
  copy while `awaitingRecoveryMessage` is true; Send stays enabled.
- "Newest" is judged within the lead's current conversation: work revisions
  restart after a conversation replacement, and a result from an earlier
  conversation is never resumed.
- Follow-up messages in the operator task read carry `requester`
  (`assignment` or `operator`), shown in the task message history.
- The task view offers a message composer only for pending or running
  delegated assignments, the same rule the API enforces.

### Readable task histories

Default to meaningful task activity and group conversation content by durable
assignment. Identify each group by assignment, assignee, latest status and time,
with a source-faithful excerpt rather than an invented summary. Older completed
groups can be collapsed. Opening a group initially shows a bounded recent preview
and its result, with Show earlier for the rest. The preview count is a presentation
choice, not a fixed acceptance requirement. Long messages have
expandable previews. Provide Expand all, Collapse all and a chronological view of
available captured conversation content, retaining omission and redaction notices.

Preserve expansion choices, unfinished replies and reading position as updates
arrive. Follow new messages only when the operator is already at the end of the
conversation; otherwise show a new-updates control without moving their position.
Updates must not reopen collapsed groups or replace unfinished replies.

The assignment view retains sanitized completed assistant text bound to the exact
task, assignment, work and runtime turn, including its instruction and conversation
revisions. Partial text is not persisted. Streamed byte counts for an unfinished
item are batched and written when the item completes or is omitted, at turn end or
shutdown, or about one second after the first unwritten delta, so a crash can lose
about one second of those counts; completed text is unaffected. The view labels unfinished or
omitted items and limits the displayed item history; it is not a complete model/tool
transcript. Known private instructions, all projects' declared routing, GitHub
source and delivery credential references, their environment key names and values,
environment values whose names match `TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL`,
and workspace/control paths are excluded before storage; current exclusions are
also applied when reading history. If safe redaction is unavailable, text is
omitted. Diagnostic capture failures and missing history cannot establish
completion, release ownership or bypass an execution hold.

### Human requests and execution controls

Support agent requests for user input as first-class durable questions, including
structured question interactions such as AskUserQuestion or the selected runtime's
equivalent. Adapt supported runtime requests into the same cab question model
as `cab_ask_question`; tool names alone do not establish runtime support.
Preserve the originating task, assignment, conversation and request identity, and
surface the question in the attention inbox and task detail.

Support a single question or a related set, free-text answers, single-choice and
multiple-choice answers. Preserve question text, option labels and descriptions,
selection constraints, and an explicit recommended option when supplied. Allow
custom text when the request permits it. A recommended or preselected option is
not a submitted answer. Validate each answer against its question and keep
unfinished input on submission failure.

The full cab question model is distinct from the selected runtime's supported
native inputs. The full form model is qualified through deterministic
service/browser tests or cab question tools. Native runtime input is supported
only for the bounded shapes qualified in the
[native input evidence](evidence/ui01-runtime-input.md): the observed
single-choice/custom-text round trip and deterministic grouped-shape coverage.
Native standalone free text, multiple selection and recommendation fields are not
MVP runtime-proof gates, and no broader native availability is claimed.
Unsupported native requests remain visibly unresolved, without fabricated answers
or silent chat conversion.

Persist answers before confirming submission and route them to the requesting
assignment/runtime request, rather than treating them as an unrelated message to
the lead. Replayed submissions must not answer or resume work twice. Restart must
preserve unresolved questions and recorded answers; stale, cancelled or already
answered requests must not accept a new answer as current. Answer delivery and
continuation respect pause, stop, dependencies and ownership holds. Present an
unavailable or unsupported runtime interaction explicitly rather than fabricating
an answer or silently treating it as ordinary chat. Structured runtime bridging
requires qualification; the existing plain-text question tool alone is not evidence
of support for these interactions.

The action Inbox at `/app/inbox` and the shared exact request view at
`/app/tasks/:taskId?request=:interactionId` present these requests. The summary
queue uses 100-row fingerprinted pages over the bounded 10,000-task catalog.
Selected forms are read independently of queue and history pages. Approval and
recovery items retain their exact existing material/control destinations. Unknown
ownership or age is labelled explicitly. Answers are durable decisions; correction
requires a new agent request. Transport failures reconcile the original frozen
command and key before editing can resume.

The version-1 cab form retains up to 32 questions, 100 options per question,
512-character IDs/labels, 16,000-character text fields, and independent 256 KiB
UTF-8 form/answer limits. Only the operator command JSON route allows the answer
limit plus its mechanically derived strict command envelope; other commands retain
their 64 KiB raw limit. Unsafe exact forms are withheld in full. Persisted answers
retain original requester/work/version attribution, and fresh responses reject
replaced, cancelled, completed-assignment or ambiguous identity. A successful
requesting terminal or ordinary continuation alone does not supersede an own-tool
question. Receipts replay before fresh eligibility checks. See the
[Inbox and questions evidence](evidence/ui05-inbox-questions.md) for validation and
retained limits.

Questions and approvals are durable and scoped. Approval includes the action,
target, requester and reviewed material; changed material invalidates approval.
Approval decisions retain and compare exact canonical material; legacy records
without retained material are deny-only. Answers do not grant unrelated permission.
Denial persists. Replayed requests or responses cannot duplicate effects. Controls
acknowledge persisted outcomes.

cab displays conversation history and accepts durable messages to the task-scoped lead conversation
for the next eligible turn. They cannot bypass pause, stop or other admission
controls. Live steering is deferred; stop is a separate control. Exact transcript
and message transport is part of Codex App Server qualification.
Stop is best effort; the UI must distinguish stopping from stopped and explain
uncertain execution. Recovery must not imply that Resume can clear unresolved
ownership or force a capacity release.

The durable attention inbox is the notification source of truth; suppress unchanged
alerts. Browser notifications are opt-in Web Push, turned on per browser in Settings →
Notifications; nothing is sent until then. While a browser is subscribed the service
reads the same Inbox every 15 seconds and sends one push per newly seen alert to each
active browser: a question or approval once per interaction, an intervention once per
task and problem, and a runtime whose restarts ran out once per exhaustion episode,
naming only the runtime. An alert already in the Inbox when the first browser subscribes
sends nothing (the first complete Inbox read, or the third partial read in a row, ends that
silent start), an unchanged alert is never sent again, and a request that resolves and
later returns is new. An alert is recorded before it is sent, so a crash can lose a push
but never repeats one. A push carries only a title ("Question in Relay: 2 waiting",
"Codex runtime unavailable") and an Inbox link, never question or approval text, a
reason, task content, error text or a credential; opening it shows that request after
sign-in, and it never answers, approves or changes anything. Pushes go over HTTPS only to
browser vendors' push services, encrypted with a key kept in an owner-only file beside
the operator auth file, with bounded concurrency, timeouts and retries; a push service
that reports a subscription gone revokes it. The operator can send a test, turn off this
browser, and revoke any other from Settings, and a revoked browser turns on again. Where
the platform allows, the page closes a notification once its request leaves the Inbox.
Delivery is qualified on the host's browser only; phone and other-device delivery is not
qualified. Subscribed ChatGPT events belong to the
deferred post-MVP integration and are not an MVP release gate. Credentials must not
appear in UI payloads or exposed transcripts. The operator login, session and
request boundary is defined in the [operator UI foundation](design/s04c-operator-ui.md).
Same-host private HTTPS access through a disposable Tailscale route has passed,
proving the private route and browser boundary from the fixture host only; access
from an independent device is not qualified.

## GitHub and completion

cab owns integration access independently of BB; reuse an explicitly configured
credential facility, keep secrets out of instructions and expose identity/access
failures. Initial discovery uses native issue search and Project-filter syntax,
validated with a preview. Poll and allow manual refresh; show last-success time.
Webhooks are deferred. Partial reads cannot imply task withdrawal or dependency
clearance. Recheck current remote state before consequential actions.

Imported content/status remain provider-authoritative. GitHub issue status and
Project fields retain distinct provenance. Permitted progress comments, labels
and field updates do not authorize granting readiness. Title/body edits require
separate approval. Issue closure is a separate project permission after completion
conditions; observed PR auto-closure is reconciled, not assumed to complete all work.
Writes record confirmed success, confirmed failure or uncertainty; local edits
cannot masquerade as confirmed remote updates.

The service implements operator-owned, versioned project delivery policy. Absent
action grants deny writes; imported identity and repository access supply no write
authority. Configured delivery credentials stay in service memory and are excluded
from the Codex spawn environment, including nonempty exact-value aliases. Adding a
credential already inherited by a running runtime holds activation until restart.
Host-permitted reads and the existing login boundary remain accepted limitations.

Each project chooses reviewable PR (default) or through-merge delivery. Reviewable-PR handback waits for settlement; feedback/CI failures wake the
task-scoped project lead, while merge remains operator-owned. Through-merge requires granted authority,
project instructions and actual GitHub requirements. No universal review count is
imposed. Non-code tasks record the requested outcome and evidence; no universal
human acceptance is required beyond configured instructions and permissions.
Assignment completion alone cannot merge, close an issue, complete its task or
remove a workspace.

Stable operation IDs retain exact material and bound caller revisions, including
denied outcomes. Intent commits before an effect. Successful write responses alone
do not establish success: provider readback must prove the exact target. Ambiguous
creates retain uncertainty across restart; a missing marker cannot authorize replay.
Only positively confirmed transient no-effect failures receive up to two retries,
each made by reconciliation once any provider rate-limit resume time has passed.

Review-thread replies (`pr.thread.reply`) and resolutions (`pr.thread.resolve`) are
separately grantable per repository in `allow` or `approval` mode and follow the same
delivery lifecycle. The lead names a thread from the bound PR's observed review
threads, which the retained observation lists with each thread's latest comment;
a thread not on the task's bound PR is denied. A reply may target a resolved thread.
Resolving names the latest comment the lead observed and re-reads the thread first,
refusing without a write when the thread is already resolved or has a newer comment.
Readback requires exactly one submitted marker reply by the credential user, or a
thread resolved by that user; a lost response stays uncertain and is not replayed.
Unresolving threads, editing or deleting comments and submitting reviews are not
supported, and the operator comment path is unchanged.

The operator publishes a local task through three more actions on the same lifecycle,
sent by the **operator publication caller** and never by an agent or the service
([ADR-1017](adr/1017-non-agent-readiness-writes.md)): `issue.create` (granted per repository),
`project.item.add` (per repository and Project, using `addProjectV2ItemById`, which adds nothing a
second time) and the existing `project.field` for the readiness fields. The confirmed publication
review is the approval in either grant mode, and each step must be exactly one the review froze,
on the repository it recorded and, after the create, only on the issue it created. The create posts
`{title, body + marker, labels}`; read-back pages the credential user's issues since the record
was made (not the search index), ignores pull requests and requires exactly one issue whose body
is the posted body, with the same title and every label (names match case-insensitively), by the credential user. An item add is read
back from the issue's Project items. Link reads the named issue and requires the marker, the
exact text and every label (names match case-insensitively). A Ready task's publication is the only non-service caller exempt from the readiness
refusals, and only for the label or option the rule names.

The operator can edit the bound issue's title and body through `issue.edit` on the same
lifecycle as an operator comment. `issue.edit.review` records the exact material: the
reviewed title and body and the title and body the draft started from. `issue.edit.confirm`
approves it, and `issue.edit.send`, keyed by the review's operation id, makes one PATCH.
The confirmed review is the approval and the repository's `issue.edit` grant is required in
either mode; agent callers cannot use this path, and `issue.edit` without a review keeps its
exact-material agent approval. A review is refused when the synced copy no longer shows the
text the draft started from, or when the operator could not be shown all of the text being
replaced because an exclusion would alter it. Before writing, the provider reads the issue
and refuses with `provider-issue-changed`, writing nothing and not retrying, if GitHub no
longer shows that text. GitHub has no conditional issue update, so a change between that
read and the PATCH is an accepted race. After that refusal the source is read again, so a
Redraft starts from what GitHub shows. Read-back requires both fields, an unknown outcome
stays uncertain and blocks further GitHub actions on the task until resolved, and nothing is
resent. The edit is irreversible from cab: the replaced text is kept only in the
review record and no restore action exists. Sending needs an open task, a current task
version and source revision, no unresolved action and an allowed credential activation, but
not task admission.

A project's **status mapping** reflects cab's work onto one GitHub Project's Status.
It is operator-owned and versioned, with one mapping per project, bound to one `project`
selection of the project's source and that Project's single-select field named `Status`
(`status-mapping.configure`; a source without a `project` selection reads the mapping as
unavailable and nothing is written). Four events each map to a Status option or to
nothing: the first turn started (not a draft turn), the PR handed back for operator review,
the task stopped, uncertain or blocked by a dependency, and the task Done. The service, not
an agent, writes it as a distinct caller through the same delivery lifecycle, labelled
"Status mapping" on the task; projects without a mapping and unmapped events create no
records ([ADR-1017](adr/1017-non-agent-readiness-writes.md)).

- **Authority.** Every mapped option must be covered by an `allow` `project.field` grant for
  the exact Project, field and option, and the grant's repository: it covers only that
  repository's issues, so an issue of another repository is denied at write time and shows on
  the task. A save naming an uncovered option, or one whose only
  grant needs approval, is refused, and the write checks the grant again; a grant revoked before the write is
  denied (`delivery-authority-denied`, or `delivery-authority-stale-or-held` once the write was
  prepared) and shows on the task. Agents and the operator keep the refusal of
  readiness labels and fields.
- **Readiness.** The service writes only for a task that is Ready when it writes, so the
  mapping never makes work Ready. The one exception is Done on closure: a done task whose issue
  is observed closed (provider closure, `issue.close`, a closing-keyword merge) is no longer
  Ready, but its mapped Done option is still written, because a closed issue cannot be Ready.
  It follows the conditional-write rule below against the last Status cab wrote, or read while
  the task was Ready, so a Status a human set since is never overwritten and the skip is recorded;
  the authority check refuses it unless the Status sent as expected is exactly that one.
  It is refused if that option is one the readiness rule accepts, a done task that is not Ready
  while its issue is open writes nothing until the issue closes, and a task first seen already
  done (for example a closed issue a Done-mode source imports, or a Ready task done before the
  mapping was saved) was not worked on under the mapping and writes nothing for Done. Clearing the mapping, rebinding it to another Project or Status field, or a pass while its Project is no longer a source selection forgets what it watched, so a task that finishes in between writes nothing when a mapping returns. An in-flight event may name only an option the
  readiness rule accepts, checked at save and again at write against the task's stored facts with only
  that value replaced. A terminal event may name an option that removes readiness, and the
  ordinary readiness-lost hold then applies on the next sync. A Project filter that excludes
  an in-flight Status drops the item from the selection on the next sync and the ordinary
  leave-selection hold applies: cab validates the readiness rule, not filter text.
- **Transitions.** The service derives each Ready imported task's current event from durable
  facts in the order Done, held, handed back, turn started. A write is due when the event
  changes to a mapped one, once per transition; leaving an event and re-entering it is a new
  transition. The operation id is stored before the write, so a restart resumes the same
  operation, once any older status write still in flight has settled. It runs after every GitHub refresh, when a turn binds and on scheduler wake. A
  reviewable PR stays handed back, open, merged or accepted, until the task is Done; a handback the
  operator settles as closed, or a PR that closes without merging, is sent back: the card stays
  handed back until a turn starts after the writer first sees it sent back (a turn that binds before
  that pass counts as already started), and then the event falls back to turn started. A
  reworked PR whose new head clears the settlement counts as handed back again, so a rework cycle can
  move the card back to the handed-back option before the lead hands it back. An unknown dependency read (a
  partial read) is not a block and keeps a held task held. A write needs the issue's current
  item in the mapped Project selection.
- **Conditional write.** Immediately before writing, the provider reads the item's Status. If
  it is not what cab last observed (its last confirmed write, unless a later read of that item
  replaced it, else the stored membership value; a read counts from when it began) it records `provider-project-field-changed`,
  writes nothing, does not retry, and the task shows "Skipped: Status changed on GitHub since
  cab last saw it". GitHub has no conditional update, so a move between that read and the
  mutation is an accepted race: readback then shows another option and the action stays
  uncertain.
- **No hold.** Status-mapping records are excluded from the task's action blockers. An unproved
  write shows on the task and never holds admission, completion, edits or agent actions. A status
  write still in flight serializes the next one for that task; an unproved one does not, because
  the next write re-reads the Status and is skipped when the card moved. Status writes run in
  their own queue with a time limit on each provider call, so a slow or hung GitHub call never
  delays the task's agent actions or completion checks. Once a newer status write has been sent,
  an older unproved one stays uncertain on the task but is not inspected again.
  A preflight that times out is a `confirmed-failure` that is not retried for that transition, and
  shutdown can wait up to the status-write limit (30 s) for a hung write.

Agents never push. Task commit publication is two grantable actions per repository,
`branch.push` (fast-forward) and `branch.force-push` (force-with-lease), each `allow` or
`approval` (approval binds the exact commit) and following the same delivery lifecycle
([ADR-1016](adr/1016-cab-owned-commit-publication.md)). cab assigns each task
one **task branch** per repository, `<project prefix><task id hex>-<title slug>`, on
first use; the operator sets the prefix per project (default `cab/`), agents cannot
choose a name, later renames never happen, and `pr.create` accepts only that branch as its
head. The agent names an exact commit. Before any network call cab proves offline
that it is the task worktree's `HEAD` or an ancestor of it and descends from the base the
workspace was provisioned at. Each ancestry is proved from the commit objects themselves,
every one read raw and rehashed, so a forged commit-graph, replace ref, graft or lying object
cannot manufacture it; a history too long to walk is unproved, not assumed, and the proof assumes SHA-1 object ids as GitHub repositories use (another format fails closed). Uncommitted entries
are reported and never pushed. A push needs the remote branch to be where cab last left
it: absent before the first push, or equal to the last pushed commit. Every update is leased
against that observed head (creation expects the branch to be absent), so a branch another writer
created or moved after the read rejects the push and is an outside change. `branch.push` also
refuses a commit that does not descend from the last pushed commit; `branch.force-push` needs a
recorded last push, which is its lease.

cab owns a commit on the task branch only if it pushed it or an attempt of that push may have
landed: one that ended unproved, was reported pushed by Git, was concluded not applied from a read,
or was never settled. A push that never started or was rejected owns nothing, and neither does one Git skipped because the remote already held the commit (another writer's push). An ambiguous attempt keeps its possible ownership even when a later read shows a different head, which is then recorded as an outside change. A remote that equals
the requested commit is therefore accepted only on a retry whose earlier attempt may have landed,
and a retry of an operation superseded by a newer push is refused. Git reporting a push done keeps
the outcome unproved until a read shows it (a first push whose branch is deleted before the read cannot be
told from read lag, so it stays unproved until an operator acts); a later third head then records the push and the outside
head separately. Any head cab does not own, seen at a push or on the task's PR, is an outside
change: the push is refused, the lead is woken and handback settlement is invalidated at once;
without a PR it is noticed at the next push, as cab does not poll branches. While any of the
task's branches, in any repository and with or without a PR, holds an outside head, or the bound
PR's head is not cab's last push, completion, accepted settlement and `issue.close` are held
(closing the outcome of a closed PR stays possible). A PR merged on GitHub counts as acceptance,
even at an outside head, and a closed PR's own branch never holds, because GitHub may delete it
and no operator action clears that. PR actions that name the task branch (`pr.create`, `pr.edit`,
`pr.ready`, `pr.merge`) need `expectedHeadSha` to equal cab's last push. A branch found absent is held the same way and stays held, even while the PR still shows its head commit, until a ref read
shows it back at that commit. The record clears when
the branch is read back at that commit or cab pushes again; a PR inspection that still shows the last push while
the PR head lags behind a later cab push also clears it until the PR catches up. A rewritten history means the next review
covers the whole new head. Success needs a read of the remote ref equal to the pushed commit; a
timeout, cancellation or unobserved exit is uncertain, is settled by reading the ref and is never
replayed blindly. cab does not delete branches or push tags or other remotes; merged branches
follow the repository's head-branch deletion setting. cab cannot prevent a push made with
ambient host credentials once a project's command network access is enabled; it detects the
result as an outside change. Plain pushes to a task branch whose head was changed outside stay
refused until the branch is recovered or the remote returns to the last pushed commit.

Recovery is requested by the lead after the outside-change wake and is always approved by the
operator, whatever the grants: it is never covered by an `allow` grant, and the service,
operator-delivery and publication callers cannot use it. Both paths name the task branch, the
outside head (git's all-zero id for a deleted branch) and the commit cab last pushed (null
before any push); the approval binds all of it, and the approval view shows these values with a
GitHub compare link from the last push to the outside head (the outside commit alone when nothing was
pushed; no link for a deleted branch). The values must still be the task branch's recorded outside
change when the approval is used and again immediately before the effect, so a record that moved
refuses it, and an approval is never reused after a refusal.

- **Overwrite** is `branch.force-push` carrying that material and the commit to push. It needs a
  `branch.force-push` grant for the repository in either mode, but naming an outside head always
  forces approval. The push leases against the approved outside head (expecting the branch absent
  after a deletion, which recreates it), so a remote that moved since approval rejects it. The
  new head is recorded as another outside change, the lead is woken again and the approval is
  spent. A remote back at the last push clears the record without pushing. Success follows the
  push lifecycle (intent before effect, readback, no blind replay) and records the commit as the
  last push.
- **Adopt** is `branch.adopt`, grantable per repository with `approval` only and not offered for a
  deleted branch. cab reads the remote ref, fetches exactly that one commit from the
  verified github.com repository over HTTPS in an isolated child (the credential reaches only
  that child's environment; ADR-1016), proves from rehashed objects that the commit descends from
  the task's provisioned base, imports the objects into the worktree's object store under an
  cab-owned ref (`refs/cab/adopted/<task branch>`), reads the remote ref again and
  records the commit as the last push. It does not require descent from the previous last push,
  so a maintainer's rebase can be adopted, and it never moves the worktree's `HEAD`, index, local
  commits or files: the agent integrates the outside commits offline, and the next `branch.push`
  must descend from the adopted head. A head that does not descend from the base is refused and
  overwrite stays available. Adoption's only remote act is a read, so an adoption interrupted by
  a restart runs again from its recorded intent and records once. A failed, refused or cancelled
  adoption leaves the outside change held with no unresolved action, and the lead can request it
  again with a new approval. The fetch is also bounded in size: cab watches the bytes the
  child writes to its scratch object store and stops it past 512 MiB (checked every 200 ms, so
  approximately). That adoption is refused as `branch-adopt-too-large`, imports nothing, removes
  the scratch repository, and keeps the outside change held with overwrite available.

After either recovery succeeds the outside change clears, completion and handback settlement
are re-evaluated against the new head (the PR is read again), and plain pushes resume. A PR that
still shows the head a recovery replaced or adopted is lagging, not another outside change. The
bounded live run of plain publication is in the
[branch publication evidence](evidence/2026-10-19-branch-publication.md); the bounded live run of both
recoveries is in the [branch recovery evidence](evidence/2026-10-28-branch-recovery.md).

The lead explicitly submits merge or issue closure with its current reviewed result
set. Shared completion checks run with the current action intent transition, excluding
only that lead's current work/turn, its result effect and that callback. Confirmed
merge does not mark Done. A new eligible lead work revision must request completion,
end successfully and pass all existing gates. Operator settlement and final
PR-dependent completion inspect GitHub freshly and revalidate local revisions after
the await. Changed heads invalidate settlement and wake the retained lead. New
comment/review/check identities also wake it; unchanged polls are deduplicated.

Only proven own closure permits the retained lead's completion continuation. The
service obtains a fresh closed-issue snapshot before open-only source reconciliation;
merge attribution requires the exact PR in GitHub's latest ClosedEvent, and explicit
issue closure requires a latest ClosedEvent with no closer. The proved ClosedEvent is
pinned to the closing operation; a fresh read showing the issue open, or closed by a
different ClosedEvent, proves a reopen and supersedes that own closure. When a
readiness rule exists, current label readiness must still hold, and
repository-selection proof must hold in every case. Field/search cases
without that proof, independent holds and changed source text remain held. Explicit
issue closure requires observed open before the effect; a concurrent independent
closure between that read and write remains an attribution limit, as does a reopen
and manual re-close with no closer that both happen before an explicit closure's
first proof.

On startup, after complete provider/source reconciliation and before scheduler
admission, a queued inbox request may receive one durable fresh generation when
only provider-derived task versions changed. The exact ready intent must never
have been admitted; captured source identity/digest, assignment/instruction/profile
revisions, immutable task-control command receipts and nonderived policy/repository snapshots must match. Independent
Stop/ownership, unfinished execution, effect or recovery evidence prevents this
supersession. The old captured request/context material remains immutable and historical, with an
explicit old-to-new receipt; retirement is not a successful terminal. Legacy
requests lacking the required anchor fail closed. Held or admitted work still
requires its existing recovery path.

Scoped delivery has deterministic service/provider/operator coverage. The bounded
real GitHub/Codex/browser handback and through-merge journeys and cleanup are
qualified in the [GitHub delivery evidence](evidence/s07a-github-delivery.md), with
its limits and failed checkpoints visible. The
[release-candidate inventory](evidence/s07b-release-candidate.md) records the
deterministic production-provider/UI integration; physical sleep/wake, final
operations and cutover are not qualified there.
