# Agent retirement and retained history

## Finding and scope

Recommend **revocation with hiding**, using the existing revoked state. This
addresses list clutter while preserving the records current readers require.
It reclaims no storage and supplies no privacy-erasure guarantee. The linked
[ADR-1036](../adr/1036-agent-retirement-and-retained-history.md) is **proposed**;
neither its merge nor investigation completion accepts policy or authorises
implementation.

Inspected committed base: `e52dc2a598ae347d83151c3858495ac65ebd33c7`.
All source links below pin that base. **Current** means source-inspected behaviour;
**coverage** means existing assertions read, not tests executed here;
**inference** identifies the consequence drawn from those dependencies;
**proposed** identifies unimplemented behaviour. No installed-data, runtime,
provider, model, browser, fixture or restore probe was run.

Authority: the complete [issue](https://github.com/chrisbanes/cab/issues/1522),
[exploration brief](https://github.com/chrisbanes/cab/issues/1522#issuecomment-6719085130)
and [r1 plan](https://github.com/chrisbanes/cab/issues/1522#issuecomment-6880075191).
The plan's earlier base remains compatible with this read-only investigation;
citations were refreshed for private capture/history, routing, inspector,
reasoning-summary reads and recovery changes. The Settings section-page design
at this base is a proposal, not current UI policy. The evidence filename uses
the actual authoring date. ADR 1036 was free at inspection.

## Current behaviour and rationale

`profile.create` inserts a current row, revision 1 and a keyed receipt;
`profile.configure` checks the current version, updates that row and appends a
revision. The command schema and CLI expose no profile delete. Creation's
“cannot be undone” warning describes that behaviour. Domain lists include
revoked agents, and the CLI and Settings use them. Setup counts all agents for
starter eligibility while selecting only available leads. [Identity][identity],
[commands][commands], [CLI list][cli-list], [create warning][warning],
[Settings][settings], [setup][setup]. The shared domain schema and operator
write adapter validate create/configure without a name-uniqueness check.
[Command schema][profile-schema], [operator writes][api-write].

**Documented intent:** reusable agent identities, immutable assignment revisions,
retained native-transition history and cross-project privacy exclusions are
accepted contracts. [SPEC agent contract][agent-contract], [revision contract][revision-contract],
[ADR-1021][native-contract], [privacy contract][privacy-contract]. Setup's retained
inline-created agents are a [setup promise][setup-retention], not a universal deletion prohibition.

**History finding:** bounded `git log` over domain/profile CLI/ADRs, a pickaxe
search for the creation warning, and ADR/design/SPEC retirement searches found
no explicit universal permanent-retention rationale. The warning appears in
[the profile CLI change][warning-history]; it is evidence of the warning's
introduction, not a maintainer rejection of deletion. Live profile-delete/retire
title searches and an open-PR search for 1522 found no alternative proposal
beyond this issue. These searches cannot establish what was discussed privately
or prove that omission was accidental.

**Inferred constraint:** removing an agent requires more than satisfying current
foreign keys. Several consumers need current rows, historical revision content
or serialized identity. The finite inventory below establishes those categories;
it is not a proof about every past database or an exhaustive runtime audit.

## Reference and retention inventory

`FK` below means an explicit SQLite reference in the inspected schema. A stored
revision integer is not a composite FK to `(profileId, revision)`. Service startup
enables foreign keys ([startup][startup-fk]); this investigation did not open a database. “Project-owned
removed” refers to the existing project deletion graph, not proposed agent deletion.

| Row | Stored relationship and enforcement | Writer and actual reader | Lifecycle and project deletion | Coverage and limit |
| --- | --- | --- | --- | --- |
| R1 | `profiles.id` is the PK; `name` has no UNIQUE/indexed reservation. `profile_revisions(profileId, revision)` has a profile FK and composite PK. Name, instructions, capabilities, revoked, runtime and skills are snapshotted; summary is current-only. | `DomainStore` create/configure → `snapshotProfile`; `profile`, `profiles`, `profileRevision`, `profileRuntime`, `profileSkills`; API configuration/instructions, CLI prepare/create/apply, shared web `profileCreateCommand` used by Settings/setup. [Identity][identity], [commands][commands], [revision access][revision-access], [snapshot writer][snapshot-writer], [web writer][web-writer]. | Both current and retained. Profiles/revisions and profile-scoped command receipts KEEP. | [Domain assertions][domain-coverage] retain old revisions, reject stale versions/changed payloads and deny revoked apply. Schema/handlers establish duplicate and case-variant names are allowed; no dedicated duplicate-name execution was performed. |
| R2 | `domain_assignments.profileId` and `task_lead_bindings.profileId` have FKs to profiles; each has `profileRevision` and `instructionsRevision` integers, without revision FKs. Lead binding also retains `assignmentId`. | Assignment creation/delegation and `ensureLeadBinding` capture identities; service `resolveFirstTurnRevisions` recaptures never-started work; `assignment.apply` changes later bindings explicitly. `assignmentAdmission` reads current revocation/version/permitted set. [Schema][identity], [binding][binding], [first admission][first-admission], [admission][admission]. | Pending, running, held, completed and withdrawn identities remain until their project is deleted. Project-owned removed; sharing an agent never expands project ownership. | [Instruction API assertions][instruction-coverage] distinguish first admission from explicit apply. Revocation refuses later admission; it does not demonstrate termination of a running turn or release of ownership. |
| R3 | `domain_projects.leadProfileId` is plain nullable TEXT. `project_routing.candidateProfileIds` is validated JSON of permitted IDs, without profile FKs. | Project create/configure checks active leads/candidates; routing configure checks candidates; project config and permitted-agent UI resolve current names. `instructionTargetImpact` joins project leads and `json_each` permitted IDs plus open assignments. [Project schema][project-schema], [routing write][routing-write], [impact][impact], [project picker][project-picker]. | Live configuration persists through pause/archive. Those project rows are removed on project deletion; agent rows remain. | [Instruction-proposal assertions][proposal-coverage] show one agent shared as lead/permitted across projects. Impact is a current view, not lifetime-use or complete retirement inventory. |
| R4 | `routing_operations.candidateRevisions` serializes ID/revision pairs; assignment ID and decision provenance are retained. `routing_attempt_operations.snapshotJson` holds candidate ID/name/capabilities/revision; `outcomeJson` can name the selected ID. No profile FK inside JSON. | `routingCandidates` resolves current available profiles; service captures/rechecks candidates and records decisions; `RoutingAttemptStore` reads snapshots for attempt/recovery. [Candidates][candidates], [routing schema][routing-schema], [snapshot][routing-snapshot], [service routing][service-routing]. | Both current selection and retained provenance; project/task-owned removed. | [Routing CLI assertions][routing-coverage] explicitly reject named revoked/missing candidates and describe dropping saved revoked candidates in a prepared routing edit. Not proof that historical snapshots can be reconstructed after profile deletion. |
| R5 | `scheduler_agent_capacity_limits(profileId, agentLimit)` has a profile ID PK without FK. `execution_capacity_reservations.agentId` is captured text, obtained through assignment binding or drafting executor. `capacity.configure` receipts serialize overrides under system scope. | Domain validates each referenced profile; scheduler fingerprints limits; `ExecutionState.capacityAgentSql`/`capacityWaitReason` resolve agent usage; API runtime projection retains revoked agents with overrides. [Capacity writes][capacity-write], [capacity identity][capacity-identity], [capacity read][capacity-read]. | Limits and system receipts KEEP; project-owned work reservations removed. Ordinary revocation does not remove caps or settle active reservations. | [CLI capacity assertions][capacity-coverage] check override payload/output/receipt. Archived-capacity browser tests cover project owners, not a general revoked-agent hiding guarantee. |
| R6 | `drafting_runs.profileId/profileRevision` identify executor; `targetKind='profile'`, `targetId`, observed version/instructions and `feedbackJson` identify an instruction target. No profile FKs. | Service starts runs with the lead's captured revision; `DraftingRunStore` persists/reads them; API uses bound executor name, current target, impact and target-version checks. Web targets filter available permitted agents but preserve a stale stored target option. [Draft schema][draft-schema], [draft reads][draft-read], [target picker][target-picker]. | Queued/live/stopping and retained proposals are project-owned and removed with that project. Executor and target are distinct dependencies, even without an ordinary assignment. | [Proposal assertions][proposal-coverage] verify shared impact and a version-fenced configure appending the target revision. No live drafting probe here. |
| R7 | `turn_requests`, `task_execution_bindings`, diagnostics, conversation items/omissions/plans and `conversation_reasoning_summaries` retain revision/work/conversation identities. Profile ID is often obtained indirectly through assignment or drafting run. Results/reviews bind assignment/result/work identities; task-review context JSON captures revision integers. These are not universal profile FKs. | Service prompt/runtime selection reads bound revisions; conversation capture validates bound identities; API task/assignment, captured-context and timeline reads resolve them. Coordination delivery queries join current profiles and bound revisions. [Execution binding][execution-binding], [history schema][history-schema], [summary schema][summary-schema], [result join][result-join], [review capture][review-capture]. | Both ongoing and completed/withdrawn history; project-owned removed, including summaries and review records. Native/external copies are separate (R10). | [Instruction assertions][instruction-coverage] cover bound/current/execution distinctions. Source shows timeline summaries use the current exclusion fence, including retained summary turns. [Summary reader][summary-reader]. No new reasoning-capture or history qualification. |
| R8 | Current and every retained `profile_revisions.instructions` participate in exclusion construction; revision runtime/skills and legacy selected-plugin/token evidence remain stored. `TaskReviewStore` also unions all instruction revisions. | API `exclusionBase` enumerates all revisions using the complete domain profile list; dedicated instruction views intentionally exempt the selected target's instructions while keeping other exclusions. Task review and service sanitisation consume exclusions. [Exclusions][exclusions], [instruction read][instruction-read], [review exclusions][review-exclusions]. | Agent revisions KEEP across project deletion. Native extensions are harness-owned; legacy rows do not control execution. | [Instruction privacy assertions][instruction-coverage] check disclosure, withholding and concurrent revisions. [ADR-1021][native-contract] requires legacy replay/readability. Filtering this input would risk disclosing surviving prose. |
| R9 | Project ownership traverses project/task/assignment/work/thread and serialized receipt parents, never “all records sharing profile”. `command_receipts.scope='profile:ID'` and system scopes KEEP. Private `deleted_project_redaction_values` stores exact nonempty strings, with no project/profile ID or revision mapping. | `captureDeletionOwnership`, child-first SQL and inventory classify removed/KEEP rows; deletion captures private values transactionally; `DeletedProjectRedactionStore.exclusions` and task review/service consume them only for sanitisation. Public tombstones expose deletion facts and cleanup progress, not the private values. [Ownership][ownership], [delete SQL][delete-sql], [KEEP inventory][keep], [caps KEEP][caps-keep], [private inputs][private-inputs], [ledger][ledger]. | Project records removed; shared profiles/revisions/caps and profile/system receipts survive. Private values persist independently of physical cleanup. | [Ownership assertions][deletion-coverage] exclude other-project work without changing the shared profile; [service deletion assertions][delete-service-coverage] remove the selected project and retain the other project's snapshot and redacted summary; [ledger assertions][ledger-coverage] retain exclusions across restart and restrict consumers. Lost project history means present absence cannot prove an agent was never used. |
| R10 | Startup pre-migration snapshots and operations backup copy the SQLite database with manifest/hash verification. Restore copies that snapshot into a separately reserved destination. Native conversations, archived rollouts, old harness homes and external branches/PRs are outside an agent-list operation. | `snapshotOwnedDirectory`, startup migration guard, `verifySnapshot`, `restoreSnapshot`; native archival follows attributable conversation ownership under ADR-1021. [Backup][backup], [restore][restore], [startup][startup], [native contract][native-contract]. | Earlier copies can retain instructions and lifecycle state. The redaction-only ledger is database retention, not backup erasure or public restoration. | [Startup assertions][startup-coverage] verify pre-migration snapshots retain private values. No restore was run; no assurance of erasure from backups, native stores or external systems. |

Profile receipt scopes are explicitly `profile:ID`; the transaction checks a
matching receipt before applying the current command and writes its result
atomically. Project deletion removes project-scoped domain receipts and retains
profile/system scopes. [Scope][receipt-scope], [transaction][receipt-transaction],
[receipt ownership][receipt-keep]. Routing attempt snapshots are independently
stored JSON, not merely the current candidate list. [Attempt store][routing-attempts].
The private ledger's allowed consumers are also asserted explicitly.
[Consumer assertion][ledger-consumers].

The broad identifier sweep also found transport/contract validators, command
result schemas, CLI formatters, comparison/recovery projections and web
presentation/draft helpers. These propagate R1–R8 identities rather than define
another profile owner. In particular task-review/comparison serialized material
belongs to R7, and wait-fix/settings links belong to R1/R3. Match counts are not
ownership proof; definitions, callers, deletion classifications and assertions
are the basis of the rows.

### Names and historical labels

Exact duplicates and case variants are allowed by the current profile schema
and both handlers. `projectNameKey` is used for project-name reservation, not
agent names. Renaming increments the profile revision while preserving ID;
creating an agent with the same spelling is a separate identity. Deletion would
not “free” a currently unique reserved agent name. [Identity][identity],
[commands][commands], [project-name check][project-names].

History labels are mixed. Task-lead display uses the bound revision's name when
a binding exists, otherwise the current project lead. Assignment detail and
delegation timeline labels use the current profile name; drafting executor and
dedicated revision views use bound revision names. Runtime/instructions remain
revision-addressed even where the label is current. Rename must not be sold as
rewriting or freezing all history. [Lead labels][lead-label],
[assignment labels][assignment-label], [timeline labels][timeline-label],
[draft reads][draft-read], [instruction read][instruction-read].

## Three-option comparison

These are design alternatives, not accepted behaviour. “Unused-only” below is
the brief's literal *never referenced* rule; weakening it is a maintainer choice.

| Dimension | Unused-only delete | Revoke and hide | Hard delete with tombstone |
| --- | --- | --- | --- |
| List cleanup and storage | Removes eligible mistakes and their content; does little for previously used clutter. Every create has a revision/receipt, requiring an explicit self-record exception. | Removes revoked agents from default collections; All/Revoked and direct links retain access. No storage reduction. | Removes broader profile content, subject to blockers and retention exceptions; savings depend on what revisions/receipts must remain. |
| Live, queued, held or uncertain work | Any reference refuses. “No FK” is insufficient. | Retain identity and work; future admission refuses revocation. Already admitted turns may continue. Holds/callbacks/reservations remain. | Refuse until every live/queued/held/uncertain dependency is settled or explicitly changed. A tombstone cannot settle execution. |
| Completed and withdrawn assignments | Prior use refuses even with no future work. | Keep readable by ID, with existing current/bound label distinctions. | Must retain full revision dependencies or change every reader to explicit unavailable history; minimal ID/name resolves identity only. |
| Paused/archived projects | Lead/permitted references still refuse. | Keep references; pause/archive and later restore retain their ordinary gates. | Their bindings must block or be explicitly removed under their own lifecycle rules; archive is not permission to rewrite them. |
| Routing, caps and drafting | Check JSON snapshots, receipts, overrides, executor and target dependencies, not only assignments. | Keep stored references, provenance and overrides; hide only eligible new choices. | Clear/rewrite current references only under a separately accepted operation; retained JSON and target/history reads still need a policy. |
| Revoke and restore | Revocation does not establish unused eligibility. Delete is irreversible. | Existing versioned revoked true/false; restores availability, no denied-action replay or implicit apply. | Revocation is insufficient proof of safe deletion. Restoration after delete would contradict hard deletion unless separately designed. |
| Identity, duplicate/case names and rename | Delete old ID permanently; existing duplicate/case semantics need no name release. | IDs stable; duplicates/case/rename unchanged, pickers must disambiguate by ID. | Tombstone old ID permanently; new same-name agent has a new ID. Case-folded reservation would be a new unrelated policy. |
| Instructions, runtime and legacy skills | Must define self-revision/receipt exception and erasure extent; native files unaffected. | Retain immutable revisions and legacy replay; native configuration stays native. | ID/name cannot replace bound instructions/runtime/legacy evidence. Keeping revision content limits erasure/storage value. |
| Redaction and deleted-project survivors | Current absence cannot prove lifetime non-use after project deletion. Deleting instructions must not weaken remaining exclusions. | All revisions remain exclusion inputs; project tombstones/private values unchanged. | Must preserve exact sanitisation values independently of public identity; existing ledger cannot reconstruct revisions or resolve profile IDs. |
| Backups and external/native copies | Does not erase earlier copies; cannot advertise universal erasure. | Copies unchanged; restoration can restore earlier availability state. | Does not erase earlier copies either; a backup restore can reintroduce removed records. |
| Cost and recovery | Less broad than used-agent deletion, but needs a defensible lifetime proof/exception and irreversible transaction/replay design. | Lowest change to lifecycle: reuse revoke/restore, add collection visibility and navigation checks. | Highest cost: live inventory, preview fencing, reader migrations, irreversible retention rules and interrupted-cleanup semantics. Project deletion supplies precedent, not a reusable guarantee. |

The smallest justified recommendation is revoke-and-hide (R1–R10). It gives
used and mistaken agents the same reversible list cleanup. It deliberately
does not solve storage pressure, exclusion-limit exhaustion or erasure requests.
If one of those becomes the actual goal, return a separate retention proposal;
do not extend a filter into silent deletion.

## Proposed operator contract

Everything in this section needs later acceptance. Reuse the existing revoked
bit and configure command; introduce no new retirement state or delete command.

| Surface | Proposed behaviour and boundary |
| --- | --- |
| CLI collections | `cab profile list` shows available agents; mutually exclusive `--all` and `--revoked` show all or only revoked. Human and JSON output identify the selected view, IDs and available/revoked totals. A duplicate name is always selectable by ID. `profile get`, instruction/execution reads and operation lookup remain ID-addressed and include revoked identities. R1/R7. |
| API collections | Add `GET /api/operator/profiles?state=available\|all\|revoked`, default available, with validated state, returned view and available/revoked totals. Keep `/api/operator/workspace` complete for existing configuration/reference consumers and installation counts. This additive read avoids changing the meaning of its existing `profiles` array. All direct `/profiles/:id/configuration`, instructions/private-session reads and operations retain their current authentication and redaction rules. `DomainStore.profiles()` and exclusion builders remain unfiltered. R1/R8. |
| Settings and setup | Settings defaults to available, offers All/Revoked, shows available and revoked counts and a clear route to restore. An all-revoked installation says so and offers restoration/ordinary creation. Setup's empty-installation/starter rule still counts every stored agent, including revoked; hiding never offers a second starter bundle. R1/R3. |
| New selections and saved references | Setup leads, new project leads, permitted agents, routing and instruction targets offer available eligible agents only. A currently selected revoked ID stays visible and marked unavailable, with its settings link; never silently substitute, clear it or treat its absence from a filtered list as deletion. Existing active-profile refusal rules still apply on save; require an explicit removal/replacement when needed. Capacity retains revoked agents with overrides and permits their explicit removal; filtering does not erase caps or serialized provenance. R2–R6. |
| Detail/history navigation | Direct settings, task/assignment conversations, results/reviews, captured context, revision instructions and existing deep links remain reachable after revocation and through All/Revoked views. Render the reader's existing current/bound label and ID, plus revoked status where actionable; do not remove history or use the list filter for identity resolution. Preserve drafts and selected unavailable targets on poll/navigation. R6–R8. |
| Revoke/restore confirmation | Existing CLI prepare/apply (`--revoked true\|false`) and web Changes to save remain the confirmation. Show exact agent ID, old/new availability, expected version and the existing current project/open-assignment impact, explicitly labelled non-exhaustive. Warn that references/history stay, active turns may continue, later work is held/refused, restore replays no denied action and started assignments may need explicit apply. No new exhaustive “unused” preview is promised. R1–R3/R7. |
| Refusals and concurrent changes | Keep operator authority, validation, current version, exact-key payload conflict and native-settings restrictions. Revocation is allowed while referenced; it does not claim drained work. Configure and admission must retain their transactional ordering: an already committed admission is not retroactively cancelled; later admission checks current revocation and ordinary revision/permitted rules. Concurrent project/reference changes do not turn the displayed impact into a locked inventory or authorise cleanup. R2/R3/R8. |
| Retry, interruption and restart | Preserve original key/body and operation scope `profile:ID`. Matching recorded commands return their original result before current-version/new-write checks; changed payload conflicts. A missing/failed read of an unknown outcome stays unknown: reconcile the same operation, never create a new key to infer success. SQLite commit records revision and receipt together; before commit there is no partial profile save, after commit the original receipt reconciles a lost response. Restart/filter changes neither enqueue work nor resolve holds. R1/R7/R9. |
| Reversal | `--revoked false`/Restore is a new version-fenced save on the same ID, not replay of an old revoke receipt. Distinguish restoring availability from CLI `--restore-revision`, which restores instruction text as a new configuration revision and refuses unavailable/redacted text. Existing started assignments remain stale until explicit apply. Ordinary queued work still faces every admission check. R1/R2/R8. |

**Inapplicable for this recommendation:** destructive delete preview, typed-name
delete confirmation, profile tombstone, name release, delete transaction,
physical cleanup/retry and delete undo. Revocation confirmation and receipt
reconciliation still apply. No deletion framework is proposed.

## Validation coverage and remaining decisions

Existing assertions were read in the pinned source; none were executed here.
The source links in R1–R10 separate those assertions from source-only conclusions.
In particular no existing test is claimed to prove new default filtering,
duplicate-label navigation, restored queued-work behaviour or deletion safety.
The archived-capacity tests protect project references; their presence does not
qualify proposed agent filtering.

| Material proposed guarantee | Focused validation after acceptance |
| --- | --- |
| Collection filters, totals and complete canonical identity/exclusions | Service/API: default/all/revoked plus invalid state; complete workspace and counts when every agent is revoked; a hidden old instruction still redacts another project's retained prose and summaries. Test server policy here once. |
| Reference preservation and admission ordering | Service/API: same agent in lead/permitted/routing/capacity/executor/target and paused/archived projects; revoke around admission, retain live/held/completed/withdrawn history, restore without synthetic replay/apply; include serialized receipts and deleted-project survivors. Assert the advertised boundary, not runtime termination. |
| Keyed save/recovery unchanged | Existing domain/API seam: stale version, exact original-key replay after a later restore, changed payload, pre-commit rollback and lost post-commit response/restart reconciliation; no duplicate revision or enqueue. |
| CLI contract | Argument parsing, incompatible flags, selected-view/totals/ID output and correct request only; reuse the existing single exit-code table. No duplicated service-policy tests. |
| Browser-only behaviour | All/Revoked navigation, restore returning to the visible collection, duplicate/case/renamed IDs, direct history/settings links, selected revoked options, focus and preserved drafts through poll/conflict/navigation. Pure wording stays in presentation tests. |

**Maintainer decisions:** accept/reject revoke-and-hide; accept the collection
defaults and additive API compatibility boundary; accept retained instructions,
privacy limits, mixed history labels and reference-preserving reversal. Choosing
deletion instead requires a new explicit retention/lifetime-proof/recovery
contract before implementation scope. These choices are investigation outputs,
not prerequisites to writing this recommendation.

**Evidence gaps:** no installed usage/storage measurements; no universal historical
intent; no lifetime-use ledger after project deletion; no runtime termination,
native-extension cleanup, backup erasure or newly proposed UI/API qualification.
The project deletion [PR #1503](https://github.com/chrisbanes/cab/pull/1503) and
[D50](https://github.com/chrisbanes/cab/issues/1472#issuecomment-6624100419)
retain their own limits: unknown destructive cleanup stays held/read-back-only,
including across restart. This proposal adds no cleanup operation and changes
neither that boundary nor the installed Haze prototype.

| Brief acceptance | Investigation result |
| --- | --- |
| AC1 | R1–R10 distinguish profile FKs, revision integers, application joins/JSON, read consumers and project-deletion survivors. |
| AC2 | Current warning/absence, accepted retention contracts and bounded historical-search limits are separated. No accidental-retention claim. |
| AC3 | Three-option matrix covers live/completed/withdrawn/held work, pause/archive, configuration, history/privacy, native legacy state and recovery. Recommendation is qualified. |
| AC4 | Duplicate/case/rename behaviour established from current schema/handlers; identity remains ID-based, without new uniqueness. |
| AC5 | Proposed CLI/API/web visibility, refusals, confirmation, concurrency, replay, interruption/restart and reversal stated; destructive items explicitly inapplicable. |
| AC6 | ADR-1036 has proposed frontmatter. No accepted contract or implementation file changes. |
| AC7 | Findings and limits prepared for controller publication; publication itself remains pending. No implementation issues or policy acceptance inferred; later acceptance owns conditional follow-up. |

## Static inspection provenance

The isolated checkout started clean on the inspected base, with 1,615 tracked
files including 104 PNGs. Before writes, the issue evidence directory was absent
(so there was no outside-r1 evidence to alter); a hash manifest captured every
tracked file. All new scratch evidence is additive under
`.scratch/issue-1522-evidence/r1`. No inherited artifact was removed.

Live refresh read the whole issue and both comments (brief and unique r1 plan),
authenticated claim, Project fields and native graph: OPEN, sole `chrisbanes`,
In progress/P3, no parent, blockers, blocking issues, subissues or closing PRs;
all graph pagination flags were false. Open-PR search returned none. No remote
write was performed. Root retains authority to refresh again before publication.

Static commands (checkout root; no dependency setup):

```sh
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
rg -n 'profileId|profileRevision|leadProfileId|candidateProfileIds|profile_revisions|profile:|agentOverrides' src/core src/standalone src/operator src/cli web/src test/fixtures
rg -n 'REFERENCES profiles|CREATE TABLE IF NOT EXISTS profiles|CREATE TABLE IF NOT EXISTS profile_revisions|projectNameKey|case "profile\.(create|configure)"' src/core/domain.ts
git log --oneline -- src/core/domain.ts src/cli/configure-profile.ts docs/adr
git log --all --oneline -S 'Creation cannot be undone' -- src/cli/configure-profile.ts
git show f0a433043 -- src/cli/configure-profile.ts
git merge-base --is-ancestor 74e45b02e09b94782fb729cb395b4b8773c2d705 HEAD
rg -n 'Creation cannot be undone|revoked|restore-revision' src/cli/configure-profile.ts
rg -n 'revoked|profiles\.length|starterOffered' web/src/profile-config.tsx web/src/project-setup.tsx
rg -n 'profile_revisions|profile/system|scheduler_agent_capacity_limits|KEEP' src/standalone/project-deletion-inventory.ts
rg -n '^status: proposed$|^#|1522|evidence/' docs/adr/1036-agent-retirement-and-retained-history.md
rg -n 'R[1-9]|R10|AC[1-7]' docs/evidence/2026-11-15-agent-profile-retirement.md
git diff --check
git diff --name-only
git ls-files --others --exclude-standard
```

Definitions/callers and the cited assertions were read with bounded `sed`/`rg`
extracts; local link/path/anchor, changed-path and preservation checks accompany
the frozen candidate in r1. These static checks establish document consistency,
not new runtime passes. Root-supplied green prior CI is baseline provenance only;
independent three-contract review and applicable final-head CI remain controller
delivery gates. A documentation-only CI selection may legitimately skip runtime
suites; that is not a new runtime pass.

<!-- Pinned source references; line ranges are checked against the inspected commit. -->

[identity]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L873-L924

[commands]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L3678-L3783

[cli-list]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/cli/browse-workspace.ts#L119-L155

[warning]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/cli/configure-profile.ts#L350-L370

[settings]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/web/src/settings-index.tsx#L374-L414

[setup]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/web/src/project-setup.tsx#L155-L180

[agent-contract]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/docs/SPEC.md#L1754-L1788

[revision-contract]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/docs/SPEC.md#L838-L854

[native-contract]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/docs/adr/1021-profile-skill-plugins-and-subagents.md#L5-L76

[privacy-contract]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/docs/SPEC.md#L1883-L1905

[revision-access]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L2154-L2191

[web-writer]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/web/src/profile-config.tsx#L80-L100

[domain-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/coordination/domain.test.ts#L181-L310

[binding]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L2082-L2117

[first-admission]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/service.ts#L9740-L9780

[admission]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L2210-L2268

[instruction-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/operator/operator-instructions.test.ts#L23-L360

[project-schema]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L853-L900

[routing-write]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L3784-L3810

[impact]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L2271-L2323

[project-picker]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/web/src/project-config.tsx#L567-L585

[proposal-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/operator/operator-instruction-proposal-api.test.ts#L395-L432

[candidates]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L2386-L2414

[routing-schema]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L979-L989

[routing-snapshot]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/routing.ts#L17-L49

[service-routing]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/service.ts#L8685-L8710

[routing-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/coordination/operator-cli-routing-capacity.test.ts#L177-L228

[capacity-write]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L4430-L4470

[capacity-identity]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/state.ts#L5614-L5703

[capacity-read]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L8091-L8112

[capacity-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/coordination/operator-cli-routing-capacity.test.ts#L279-L327

[draft-schema]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/drafting.ts#L171-L197

[draft-read]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L3400-L3535

[target-picker]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/web/src/instruction-proposal.tsx#L238-L258

[execution-binding]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/state.ts#L552-L577

[history-schema]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/conversation-history.ts#L298-L365

[summary-schema]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/reasoning-summary-storage.ts#L30-L58

[result-join]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/coordination.ts#L5980-L6007

[review-capture]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/task-review.ts#L535-L562

[summary-reader]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L5717-L5796

[exclusions]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L821-L901

[instruction-read]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L4787-L4859

[review-exclusions]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/task-review.ts#L217-L250

[ownership]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/project-deletion-ownership.ts#L100-L189

[delete-sql]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/project-deletion-sql.ts#L1-L55

[keep]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/project-deletion-inventory.ts#L1129-L1156

[caps-keep]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/project-deletion-inventory.ts#L1433-L1443

[private-inputs]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/project-deletion-private.ts#L145-L175

[ledger]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/deleted-project-redaction.ts#L10-L84

[deletion-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/coordination/project-deletion.test.ts#L188-L301

[ledger-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/operator/deleted-project-redaction.test.ts#L16-L108

[backup]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operations.ts#L398-L459

[restore]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operations.ts#L486-L535

[startup]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/startup-snapshot.ts#L280-L331

[startup-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/operations/startup-snapshot.test.ts#L234-L277

[project-names]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L1935-L1948

[lead-label]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L2857-L2884

[assignment-label]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L4457-L4501

[timeline-label]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L6028-L6054

[receipt-scope]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L621-L640

[receipt-transaction]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L1576-L1631

[receipt-keep]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/project-deletion-inventory.ts#L31-L38

[ledger-consumers]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/operator/deleted-project-redaction.test.ts#L262-L281

[startup-fk]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/service.ts#L1133-L1138

[profile-schema]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L294-L333

[api-write]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/operator-api.ts#L10700-L10767

[routing-attempts]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/standalone/routing.ts#L290-L325

[warning-history]: https://github.com/chrisbanes/cab/commit/f0a43304342796c5085d555903cd472498ebbd4d

[snapshot-writer]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/src/core/domain.ts#L4574-L4590

[setup-retention]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/docs/user-flows/project-setup.md#L133-L138

[delete-service-coverage]: https://github.com/chrisbanes/cab/blob/e52dc2a598ae347d83151c3858495ac65ebd33c7/test/coordination/project-deletion.test.ts#L325-L407
