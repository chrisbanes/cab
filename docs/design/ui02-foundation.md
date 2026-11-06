# UI02 foundation contract

The React operator is served at `/`; every legacy operator page/form route returns not-found without redirect or session creation, and old `/app/*` addresses permanently redirect to the same path at the root. A validated built web bundle is required before operator service startup. One production operator listener serves the built bundle and same-origin `/api/operator` boundary. The boundary delegates durable writes to existing domain and coordination commands. Receipts prove recorded outcomes only. `observedAt` means server capture, never successful provider sync.

## Control inventory

Each semicolon-separated control has an individual disposition. Project controls use the listed React destinations and JSON commands; the legacy project route and its exclusive form handlers are absent. Shared domain commands remain through JSON and CLI. Coordination task and assignment controls use their task-view destinations. JSON readiness says whether a curated JSON adapter exists. [UI06 configuration and recovery](ui06-configuration.md) records the individual control dispositions.

| Existing destination | Command/action | Controls/read destinations | React surface or supported destination | JSON readiness |
| --- | --- | --- | --- | --- |
| Project creation | project.create | create project; name; lead | Settings | yes |
| Agent creation | agent.create | create agent; name; instructions; capabilities | Settings | yes |
| Project Settings | project.configure | name; lead; instructions; pause | `/projects/:id/settings` | yes |
| Agent Settings | agent.configure | name; instructions; capabilities; revoke | Settings | yes |
| Project Settings | routing.configure | enable; guidance; candidates; set/clear credential reference | `/projects/:id/settings?tab=routing` | yes |
| Project Settings | github.configure | selections; readiness; closed-issue mode; set/clear credential reference | `/projects/:id/settings?tab=github` | yes |
| Project Settings | repositories.configure | repositories | `/projects/:id/settings?tab=repositories` | yes |
| Project Settings | github.preview | preview selections; activation via preview receipt | `/projects/:id/settings?tab=sync` | yes |
| Project Settings | github.refresh | refresh observation | `/projects/:id/settings?tab=sync` | guarded observation POST |
| Project Settings | github.place | conflicting placement | `/projects/:id/settings?tab=sync` | yes |
| Project Settings | delivery.configure | completion mode; branch prefix; scoped grants; required checks; set/clear credential reference | `/projects/:id/settings?tab=delivery` | yes |
| /tasks/:id | delivery.read | issue observation; Project field observations; PR identity/head/state; provider feedback; external action states; local task state; delivery holds | Task Changes tab | yes |
| /tasks/:id | delivery.settle | Accept handback; Settle as closed; task/delivery/policy revisions; head guard | Task Changes tab | yes |
| /tasks/:id | delivery.refresh | refresh delivery observations | Task Changes tab | yes |
| Task composer | task.create | draft; create and start; shared task creation capability | Task composer (`/tasks/new`) | yes |
| /tasks/:id | task.configure | local title; outcome; readiness | Task header Edit task… | yes |
| /tasks/:id | source.review | source identity; body; status; Project fields; native blockers; review history; Resume source hold | Task Overview decision card and inspector | yes |
| Runtime Settings | capacity.configure | global capacity; project override; remove override | Settings (Runtime) | yes |
| /tasks/:id | dependency.add | local dependency add | Task Execution tab | yes |
| /tasks/:id | dependency.remove | local dependency remove | Task Execution tab | yes |
| /tasks/:id | assignment.apply | apply project instructions and agent revisions | Task inspector stale started assignment row | yes |
| /tasks/:id | task.stop | stop request and observation | Task header Stop… | yes |
| /tasks/:id | task.resume | explicit resume | Task header Resume… | yes |
| /assignments/:id/recovery | read | generation; holds; advanced recovery evidence | Assignment recovery and task Execution; advanced CLI recovery options | read subset |
| /tasks/:id | task.comment.send | comment recipients; exact versions; durable comment | Task reply card (Comment on task); delegated assignment Reply | yes |
| /tasks/:id | message | message recipient; exact version; durable message | Task reply card (Message task lead, after "Ask lead about …") | yes |
| /tasks/:id | result.recipient | unresolved results; destination reconciliation | Task decision card | yes |
| /tasks/:id | read | retained captured history; omissions; results | Task conversation | yes |
| /tasks/:id | question.answer | plain question and exact revision answer | Inbox and task request view | yes |
| /tasks/:id | approval.decide | retained exact material; approve; deny | Task request view | yes |
| /login | /api/operator/login | password sign-in | Sign-in | yes |
| all authenticated views | /api/operator/logout | sign-out | Account menu | yes |
| all views | navigation | delivered overview/project List/Board/composer; agent/Runtime Settings destinations | App shell | curated reads |

The delivery rows describe the structured Delivery tab, with curated JSON reads, `delivery.configure` and minimal receipts. All 16 action kinds, optional scopes, required-check app bindings and absent versus empty prefixes retain their existing meanings. Unavailable saved rows and prefix are preserved without revealing them. The task delivery facts, guarded handback settlement (`delivery.settle`) and observation refresh (`delivery.refresh`) live in the task's Changes tab. Settlement records an operator decision; refresh requests provider observations. Neither action alone completes the local task.

Jira source definitions and readiness use the existing source Settings section, selected by the saved tracker or `?tab=github&tracker=jira`. Source and repository rows withheld by exclusions remain keep/remove placeholders bound to project, section, version and ordinal. An unsafe optional status-mapping view is omitted as a whole, leaving the persisted mapping unchanged. A missing view is not an editable empty mapping. The legacy project route, four links and eight exclusive form handlers are absent. Project Settings and the task composer provide the current controls; shared task creation and other domain commands remain through JSON and CLI.

Historical pre-turn and no-turn adoption use receipted JSON/CLI recovery commands;
bound-turn reconciliation is available in React Assignment Recovery. The operator
supplies reviewed exact evidence; model tools have no adoption authority. Session
commands preserve Origin/CSRF protections and bearer commands preserve their
explicit scope policy. Original keys/payloads recorded through removed form routes
still replay their original receipts through JSON without another effect. The
legacy cross-project admission summary is dropped deliberately; List/Board per-task
waiting reasons and project views replace it.

| Advanced route | Owner and disposition |
| --- | --- |
| `recovery.pre-turn.adopt` | historical pre-turn evidence adoption; exact held generation, operator attestation and immutable command receipt. Witness acknowledgement appears on the assignment recovery view. |
| `recovery.pre-turn.recover` | exact witness-bound recovery; independently verified termination and settled effects/workspace reconcile ownership without dispatch. Assignment recovery records the receipt and retained holds. |
| `recovery.no-turn.adopt` | distinct historical no-turn-submission evidence adoption; reviewed complete invocation ledger and exact known-null-predecessor generation. Assignment recovery acknowledges the witness while retaining possible idle-thread creation. |
| `recovery.no-turn.recover` | exact no-turn witness-bound recovery; verified process termination and settled effects/workspace reconcile ownership without dispatch. Separate conversation replacement and NEW message remain required; no model tool authority or new forms in the curated operator UI. |
| `recovery.bound-turn.recover` and original operation GET | React Assignment Recovery owns exact review/cancel/confirmation and frozen original-receipt GET readback; JSON and CLI preserve keyed recovery and independent holds. |
| `recovery.conversation.replace` | explicit recovery counterpart; assignment/conversation revision checks and immutable keyed result prevent duplicate increments. Fresh operator message remains separately required for continuation. |

Programmatic support (no new HTTP exposure):

| Command | Destination | Disposition |
| --- | --- | --- |
| `assignment.create` | Task composer; programmatic assignment creation | Optional initial assignment in atomic `task.create`; standalone assignment creation remains programmatic |
| `assignment.apply` | Task inspector stale assignment row | `/api/operator/commands` |
| `dependency.add` | Task Execution tab | `/api/operator/commands` |
| `dependency.remove` | Task Execution tab | `/api/operator/commands` |
| `imported-blockers.set` | Explicitly unsupported operator exposure | Existing programmatic case only; no HTTP or JSON endpoint |

`LocalOperatorUi.submit` cases that are not current HTTP controls: `assignment.create`, `assignment.apply`, `dependency.add`, `dependency.remove`, `imported-blockers.set`. The latter remains unexposed. `github.activate` is applied from the existing preview flow and has no arbitrary JSON adapter.

## Transport and safe projection

Foundation reads: `/api/operator/session`, `/workspace`, `/projects/:projectId`, `/tasks/:taskId`, `/assignments/:assignmentId/history`, `/tasks/:taskId/timeline` and `/tasks/:taskId/timeline/output/:sequence`. The task list, composer options, inbox, search, configuration, runtime settings, source observations and recovery reads follow the same rules ([UI03](ui03-tasks.md), [UI06](ui06-configuration.md)). Authenticated writes: `/commands`; auth writes: `/login`, `/logout`. Every DTO is strict and runtime validated; no actor, credentials, raw payload, diagnostic/recovery/process rows or workspace paths cross the boundary. JSON is bounded to 64 KiB; approval material to 8 KiB. Existing Host, exact Origin, sessions, cookie attributes, expiry and CSRF remain authoritative. There is no CORS or forwarded-header trust.

The task timeline read (`GET /tasks/:taskId/timeline?before=<key>&limit=<1..100>`) merges captured assistant history, coordination records, delegations and curated tool activity into one conversation, oldest first within a page, newest page first. Each entry has a millisecond `at`, a `precision` (`s` for records stored in whole seconds) and an opaque `key`; `olderCursor` is the next `before`, and a client following live updates re-reads the newest page and merges by `entryId`. Keys derive from creation times and a fixed kind order, so an entry keeps its place when its content changes and second-precision records order by kind within the second; the exception is a tool entry whose first retained diagnostic row retention removes, which moves it. Tool activity is a projection of diagnostic rows, not a transcript: a command's one-line summary and exit status, file changes with their repository-relative paths, other tools by name with one allowlisted target, a duration when the tool finished, and a bounded redacted output fetched on request by `outputSequence` (`/timeline/output/:sequence`, completed commands of the task only). Working directories, workspace paths, raw payloads and service, setting or severity rows never appear; cab's own coordination tool calls appear as the records they produce. Omitted history, unredactable or oversized values, expired or evicted diagnostics and executions that capture no tool activity are gap entries with their reason, never text. The read applies the visibility, redaction and omission rules of the assignment history read.

Active request selection crosses configured assignment revisions before falling back to the current version. Execution generation remains the selected actual request's work/version/instruction/agent snapshots; configured revisions describe the next turn. Unresolved results supply their own positive destination revision and permitted same-task recipient, with null when unavailable. Existing reconciliation policy validates writes again.

Unsafe approval material becomes unavailable and deny-only; altered/redacted material is never approvable. A denial may omit material: the adapter supplies only the immutable retained JSON for that same task and interaction, privately, while preserving the submitted revision, action and target. This reconstruction does not depend on current display redaction, so a matching saved-key replay remains stable after privacy context changes. Client-supplied material is never replaced; approvals still require exposed exact material, and unavailable action or target cannot be substituted. Legacy interactions without retained JSON keep material omitted. Existing policy checks remain authoritative.

Provider timestamps are stored observations; unavailable successful sync/history is explicit. Native structured input is unavailable until qualified; the operator interface does not enable it.

## Client

The React client supplies login, session lifecycle, project navigation and shared controls. [UI03](ui03-tasks.md) describes the attention overview, project and cross-project List/Board views and the local composer. Task cards open the task workspace at `/tasks/:id`, whose Execution tab (`?section=execution`) holds execution status, holds, recovery evidence and local dependencies, whose header offers Edit task… for a local task and whose Overview decision card offers Resume source hold for an active source hold. There is no server-rendered task page. First load, stale refresh, invalid responses, session expiry and command outcome unknown remain distinct. Lost write responses retain the exact key and payload for deliberate reconciliation. No credential/API persistence or automatic write replay.
