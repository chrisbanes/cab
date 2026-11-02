# UI02 foundation contract

The React operator is served at `/app`; `/` and the retained operator forms remain available (the coordination pages are retired). One production operator listener serves the built bundle and same-origin `/api/operator` boundary. The boundary delegates durable writes to existing domain and coordination commands. Receipts prove recorded outcomes only. `observedAt` means server capture, never successful provider sync.

## Retained-control inventory

Each semicolon-separated control has an individual disposition. Project controls use the listed React destinations and JSON commands; the legacy project route and its exclusive form handlers are absent. Shared form capabilities remain. Coordination task and assignment controls use their task-view destinations. JSON readiness says whether a curated JSON adapter exists. [UI06 configuration and recovery](ui06-configuration.md) records the individual control dispositions.

| Existing destination | Command/action | Controls/read destinations | React surface or retained destination | JSON readiness |
| --- | --- | --- | --- | --- |
| / | project.create | create project; name; lead | Settings | no |
| / | profile.create | create profile; name; instructions; capabilities | Settings | no |
| Project Settings | project.configure | name; lead; instructions; pause | `/app/projects/:id/settings` | yes |
| /profile/:id | profile.configure | name; instructions; capabilities; revoke | Settings | no |
| Project Settings | routing.configure | enable; guidance; candidates; set/clear credential reference | `/app/projects/:id/settings?tab=routing` | yes |
| Project Settings | github.configure | selections; readiness; closed-issue mode; set/clear credential reference | `/app/projects/:id/settings?tab=github` | yes |
| Project Settings | repositories.configure | repositories | `/app/projects/:id/settings?tab=repositories` | yes |
| Project Settings | github.preview | preview selections; activation via preview receipt | `/app/projects/:id/settings?tab=sync` | yes |
| Project Settings | github.refresh | refresh observation | `/app/projects/:id/settings?tab=sync` | guarded observation POST |
| Project Settings | github.place | conflicting placement | `/app/projects/:id/settings?tab=sync` | yes |
| Project Settings | delivery.configure | completion mode; branch prefix; scoped grants; required checks; set/clear credential reference | `/app/projects/:id/settings?tab=delivery` | yes |
| /app/tasks/:id | delivery.read | issue observation; Project field observations; PR identity/head/state; provider feedback; external action states; local task state; delivery holds | Task Changes tab | yes |
| /app/tasks/:id | delivery.settle | Accept handback; Settle as closed; task/delivery/policy revisions; head guard | Task Changes tab | yes |
| /app/tasks/:id | delivery.refresh | refresh delivery observations | Task Changes tab | yes |
| Task composer | task.create | draft; create and start; shared task creation capability | Task composer (`/app/tasks/new`) | yes |
| /task/:id | task.configure | local title; outcome; readiness | Retained task page | yes |
| /task/:id | source.review | source identity; body; status; Project fields; native blockers; review history; Resume source hold | Retained task page | no |
| /runtime | /runtime/control/capacity | global capacity; project override; remove override | Settings (Runtime) | no |
| /runtime/task/:id | /runtime/control/dependency/add | local dependency add | Task Execution tab (`dependency.add`); retained Runtime task page pending parity approval | yes |
| /runtime/task/:id | /runtime/control/dependency/remove | local dependency remove | Task Execution tab (`dependency.remove`); retained Runtime task page pending parity approval | yes |
| /runtime/task/:id | /runtime/control/instruction-apply | apply project instructions and profile revisions | Task inspector stale assignment row (`assignment.apply`); retained Runtime task and assignment pages | yes |
| /runtime/task/:id | /runtime/control/stop | stop request and observation | Task header Stop… (`task.stop`); retained Runtime task page pending parity approval | yes |
| /runtime/task/:id | /runtime/control/resume | explicit resume | Task header Resume… (`task.resume`); retained Runtime task page pending parity approval | yes |
| /runtime/assignment/:id | read | generation; holds; advanced recovery evidence | Assignment recovery | read subset |
| /app/tasks/:id | message | message recipient; exact version; durable message | Task reply card; delegated assignment sub-conversation header | yes |
| /app/tasks/:id | result.recipient | unresolved results; destination reconciliation | Task decision card | yes |
| /app/tasks/:id | read | retained captured history; omissions; results | Task conversation | yes |
| /app/tasks/:id | question.answer | plain question and exact revision answer | Inbox and task request view | yes |
| /app/tasks/:id | approval.decide | retained exact material; approve; deny | Task request view | yes |
| /login | /login | password sign-in | Sign-in | yes |
| all authenticated views | /logout | sign-out | Account menu | yes |
| all views | navigation | delivered overview/project List/Board/composer; retained task/profile/assignment/Runtime destinations | App shell and retained destinations | curated reads |
| /assignment/:id | read | captured instructions/profile revision and result destination | Retained assignment page | curated subset |

The delivery rows describe the structured Delivery tab, with curated JSON reads, `delivery.configure` and minimal receipts. All 17 action kinds, optional scopes, required-check app bindings and absent versus empty prefixes retain their existing meanings. Unavailable saved rows and prefix are preserved without revealing them. The task delivery facts, guarded handback settlement (`delivery.settle`) and observation refresh (`delivery.refresh`) live in the task's Changes tab. Settlement records an operator decision; refresh requests provider observations. Neither action alone completes the local task.

Jira source definitions and readiness use the existing source Settings section, selected by the saved tracker or `?tab=github&tracker=jira`. Source and repository rows withheld by exclusions remain keep/remove placeholders bound to project, section, version and ordinal. An unsafe optional status-mapping view is omitted as a whole, leaving the persisted mapping unchanged. Delivery reductions still warn conservatively when mapping details are unavailable. A missing view is not an editable empty mapping. The legacy project route, four links and eight exclusive form handlers are absent. Project Settings and the task composer provide the current controls; shared task creation and other retained form capabilities remain.

Advanced authenticated recovery routes have no rendered form or React control. The host operator supplies the reviewed evidence and exact command material under the existing Origin, session and CSRF checks; model tools have no adoption authority. The operator CLI reaches the same service methods through receipted `recovery.*` commands on `/api/operator/commands`; a command key recorded through either entry point replays through the other, and these session routes stay closed to bearer credentials.

| Advanced route | Owner and disposition |
| --- | --- |
| `/runtime/control/pre-turn/adopt` | historical pre-turn evidence adoption; exact held generation, operator attestation and immutable command receipt. Witness acknowledgement appears on the shared task/assignment runtime history and assignment recovery view. |
| `/runtime/control/pre-turn/recover` | exact witness-bound recovery; independently verified termination and settled effects/workspace reconcile ownership without dispatch. Existing runtime history records the receipt and retained holds. |
| `/runtime/control/no-turn/adopt` | distinct historical no-turn-submission evidence adoption; reviewed complete invocation ledger and exact known-null-predecessor generation. Shared task/assignment runtime history and assignment recovery view acknowledge the witness while retaining possible idle-thread creation. |
| `/runtime/control/no-turn/recover` | exact no-turn witness-bound recovery; verified process termination and settled effects/workspace reconcile ownership without dispatch. Separate conversation replacement and NEW message remain required; no model tool authority or new forms in the curated operator UI. |
| `/runtime/control/conversation-replace` | explicit recovery counterpart; assignment/conversation revision checks and immutable keyed result prevent duplicate increments. Fresh operator message remains separately required for continuation. |

Programmatic support (no new HTTP exposure):

| Command | Destination | Disposition |
| --- | --- | --- |
| `assignment.create` | Task composer; retained assignment page | Optional initial assignment in atomic `task.create`; standalone assignment creation remains programmatic |
| `assignment.apply` | Task inspector stale assignment row; retained assignment page | `/api/operator/commands` and retained `/runtime/control/instruction-apply` |
| `dependency.add` | Task Execution tab; retained Runtime task page | `/api/operator/commands` and retained `/runtime/control/dependency/add` |
| `dependency.remove` | Task Execution tab; retained Runtime task page | `/api/operator/commands` and retained `/runtime/control/dependency/remove` |
| `imported-blockers.set` | Explicitly unsupported operator exposure | Existing programmatic case only; no HTTP or JSON endpoint |

`LocalOperatorUi.submit` cases that are not current HTTP controls: `assignment.create`, `assignment.apply`, `dependency.add`, `dependency.remove`, `imported-blockers.set`. The latter remains unexposed. `github.activate` is applied from the existing preview flow and has no arbitrary JSON adapter.

## Transport and safe projection

Foundation reads: `/api/operator/session`, `/workspace`, `/projects/:projectId`, `/tasks/:taskId`, `/assignments/:assignmentId/history`, `/tasks/:taskId/timeline` and `/tasks/:taskId/timeline/output/:sequence`. The task list, composer options, inbox, search, configuration, runtime settings, source observations and recovery reads follow the same rules ([UI03](ui03-tasks.md), [UI06](ui06-configuration.md)). Authenticated writes: `/commands`; auth writes: `/login`, `/logout`. Every DTO is strict and runtime validated; no actor, credentials, raw payload, diagnostic/recovery/process rows or workspace paths cross the boundary. JSON is bounded to 64 KiB; approval material to 8 KiB. Existing Host, exact Origin, sessions, cookie attributes, expiry and CSRF remain authoritative. There is no CORS or forwarded-header trust.

The task timeline read (`GET /tasks/:taskId/timeline?before=<key>&limit=<1..100>`) merges captured assistant history, coordination records, delegations and curated tool activity into one conversation, oldest first within a page, newest page first. Each entry has a millisecond `at`, a `precision` (`s` for records stored in whole seconds) and an opaque `key`; `olderCursor` is the next `before`, and a client following live updates re-reads the newest page and merges by `entryId`. Keys derive from creation times and a fixed kind order, so an entry keeps its place when its content changes and second-precision records order by kind within the second; the exception is a tool entry whose first retained diagnostic row retention removes, which moves it. Tool activity is a projection of diagnostic rows, not a transcript: a command's one-line summary and exit status, file changes without paths, other tools by name, and a bounded redacted output fetched on request by `outputSequence` (`/timeline/output/:sequence`, completed commands of the task only). Working directories, workspace paths, raw payloads and service, setting or severity rows never appear; cab's own coordination tool calls appear as the records they produce. Omitted history, unredactable or oversized values, expired or evicted diagnostics and executions that capture no tool activity are gap entries with their reason, never text. The read applies the visibility, redaction and omission rules of the assignment history read.

Active request selection crosses configured assignment revisions before falling back to the current version. Execution generation remains the selected actual request's work/version/instruction/profile snapshots; configured revisions describe the next turn. Unresolved results supply their own positive destination revision and permitted same-task recipient, with null when unavailable. Existing reconciliation policy validates writes again.

Unsafe approval material becomes unavailable and deny-only; altered/redacted material is never approvable. A denial may omit material: the adapter supplies only the immutable retained JSON for that same task and interaction, privately, while preserving the submitted revision, action and target. This reconstruction does not depend on current display redaction, so a matching saved-key replay remains stable after privacy context changes. Client-supplied material is never replaced; approvals still require exposed exact material, and unavailable action or target cannot be substituted. Legacy interactions without retained JSON keep material omitted. Existing policy checks remain authoritative.

Provider timestamps are stored observations; unavailable successful sync/history is explicit. Native structured input is unavailable until qualified; the operator interface does not enable it.

## Client

The React client supplies login, session lifecycle, project navigation and shared controls. [UI03](ui03-tasks.md) describes the attention overview, project and cross-project List/Board views and the local composer. Task cards open the task workspace at `/app/tasks/:id`, whose Execution tab (`?section=execution`) holds execution status, holds, recovery evidence and local dependencies, and which links, from its inspector, the retained task page (`/task/:id`, Edit task and review source). First load, stale refresh, invalid responses, session expiry and command outcome unknown remain distinct. Lost write responses retain the exact key and payload for deliberate reconciliation. No credential/API persistence or automatic write replay.
