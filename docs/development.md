# Development reference

For the product overview, see the [README](../README.md). For macOS service
operations and backup/restore, see the [operations procedure](operations/standalone-macos.md).

Use the Node version in [`.node-version`](../.node-version) and the npm version in
`packageManager` (`package.json`).
Node 26 compatibility jobs use the latest 26.x: `node26-service-*` covers PRs and
main pushes; `node26-full-compatibility` covers the complete build and browser suite
on nightly, manual and release-tag runs, as described below. Version 26.9.0 has
[local evidence](evidence/node-26-compatibility-2026-10-09.md) but is not the default
baseline. `engines.node` is `>=24` as permissive metadata; Node 25, 27 and later
majors are not qualified.

```sh
npm ci
npm run check
```

`check` runs strict type checking, lint, formatting, compilation and tests,
including deterministic scheduler, supervision, recovery, power and
service-integration fixtures, coordination, routing, inbox, interaction and
completion tests, and the operator auth, HTTP and browser tests. CI
builds once and runs eight test jobs on PRs and main pushes: six Node 24 Chromium
jobs and two Node 26 service jobs. Coordination, sources, delivery, operations and
infrastructure share one lane; workspaces has one lane; execution and operator
have two shards each. Logical suites remain separate directories even when they
share a CI lane. Runtime retention tests are split by terminal events, threads and
native input so the expensive workloads can run on different execution shards.

Shards use separate `all`, `chromium` and `service` weights in
`scripts/test-timings.json`. Weights measure complete file durations, including
startup and imports; new files use the selected profile's median fallback. The required
`check` context aggregates static checks and all applicable test jobs, including
their failure evidence uploads. Superseded PR runs are cancelled.

Daily CI at 05:00 UTC runs only when the commit differs from the previous scheduled
run on the same branch (or there is no previous run). An unchanged night skips the
build and tests; a history lookup failure fails CI. Manual workflow runs always
run the complete checks. Nightly, manual and release-tag runs include WebKit on
Node 24 and the complete suite and build on Node 26. These triggers become available when the
workflow reaches the default branch. Local `npm run check` continues to run all
tests and both browsers. For focused checks after building, use:

```sh
npm run test:built -- --suite=operator --profile=chromium --shard=1/2
npm run test:built -- --profile=service
```

`all` is the default profile; `chromium` excludes WebKit, and `service` excludes
browser-dependent cases while retaining service assertions in mixed test files.
Browser cases use `browserSuite` or `browserTest`; engine-specific cases declare
their engine. Missing compiled tests, unknown suites/options and empty shards
fail explicitly. Each normal test run writes `file-timings.ndjson` in its test evidence directory;
CI uploads these with the synthetic evidence. Refresh a profile from a successful
complete run, or all its shards, using:

```sh
node scripts/update-test-timings.mjs chromium 24 /path/to/evidence
```

Use `all 24` or `service 26` for the other profiles. Keep receipts from one run
separate from other runs. The updater rejects missing, duplicate, unsuccessful or
stale receipts and requires every current source test file. Its input digest
covers runtime, test, web and runner inputs; changing these requires new receipts.
Committed initial weights are measured locally; hosted CI receipts can refresh
them as runner performance changes.

Real App Server
qualification is separate and runs only when requested explicitly, for example
`npm run recovery:live` and `npm run routing:live`, which require their `--live` opt-in
(see the other `*:live` scripts in `package.json`). These checks do not prove
physical sleep/wake behavior, operational host-restart recovery or private remote
Tailscale access.

The production service runs the Claude runtime
([ADR-1008](adr/1008-claude-code-execution-harness.md)) beside Codex; profiles
select it explicitly. Its token is the operator's own subscription token from `claude setup-token`,
configured in Settings as a `file:/absolute/path` or `env:NAME` reference. The
installed LaunchAgent service uses an owner-only token file
([operations](operations/standalone-macos.md#claude-subscription-token)); a
replaced file applies from the next turn. An `env:NAME` variable must be in the
service process environment when the service starts, and a reference configured
while the service runs takes effect after a restart.
`npm run mixed-runtime:live -- --live --facet <scrub|stop|crash|claude-only|mixed>` runs one
bounded journey against disposable data and prints redacted evidence. It refuses
any other arguments, a missing `CLAUDE_CODE_OAUTH_TOKEN` (read from the
environment, then `~/.env`) or a missing ChatGPT.app Codex launcher before creating
anything, and enforces per-attempt and session turn caps through a ledger in the
temporary directory. It needs an explicit grant to run.

The command surface is `npm run service -- <serve|operator|run|list> ABSOLUTE_DATA_DIR`.
`run` also takes `workId`, `prompt`, an existing absolute workspace directory,
and optionally `previousWorkId` for a follow-up in a completed conversation.
`serve` initializes the database and App Server, then waits for SIGINT or SIGTERM.
Both `serve` and `operator` also stop with an unsuccessful exit status after an
unexpected service-owned background failure. Provider failures already recorded
as incomplete source observations or power-admission holds remain visible through
those existing states; they do not trigger this fatal exit. Normal signal-driven
shutdown remains successful.
Reusing a work ID never resubmits it. A held result requires independent
reconciliation; there is no force unlock. Automatic retry is limited to an exact
terminal `serverOverloaded` or `rateLimitExceeded` failure with known retry
telemetry, settled effects, ended callbacks, and no Stop or known survivor. Codex
and Ensemble retries share a two-retry limit; uncertain or other failures remain
held.
On first use, the directory must be empty or carry Ensemble's standalone marker.
Startup can also recover an interrupted first start when the only files are an
empty `.ensemble-owner.sqlite`, its SQLite journal if present, and an absent or
partial marker whose contents match the beginning of the expected marker.
Unrelated unmarked contents, including prototype data, remain refused.
The service database is `standalone.sqlite`; `.ensemble-owner.sqlite` provides
cross-process ownership of the marked directory.
Initialize a separate operator password with
`npm run operator-auth -- init ABSOLUTE_AUTH_FILE`, then set
`ENSEMBLE_OPERATOR_AUTH_FILE` and `ENSEMBLE_OPERATOR_ORIGIN` before starting the
`operator` command. Use the exact loopback origin (including port) for local
access or an HTTPS origin for a separately managed private transport. Use a
canonical origin without a trailing slash. The server still binds only to
`127.0.0.1`; it does not configure Tailscale Serve.
Sessions are in-memory and reset on restart. The [command boundary](design/s04a-command-boundary.md)
describes domain commands and admission records; the [operator UI design](design/s04c-operator-ui.md)
describes the authenticated web boundary and its UI limits.

`StandaloneService.provisionTask` durably binds a domain task to one retained
workspace, including repository-free and multiple-repository tasks.
`submitTask` resolves that binding and captured assignment revisions before
writer admission. Capacity-waiting turns own neither a writer nor a reservation.
A bound successful terminal report admits a successor only after registered
Ensemble callbacks finish and no hold or known survivor remains. `stopTask`
synchronously persists the Stop hold and returns a bounded observation; only
`resumeTask` clears the independent Stop hold. Startup reconciliation observes
exact execution identities and never replays an ambiguous generation. A validated
recovery receipt releases only the exact generation's writer and capacity holds.
`replaceConversation` keeps assignment snapshots while advancing its conversation
revision, and `recordTaskResult` rejects early or stale results. `archiveTask`
requires delivery and preservation evidence and refuses unresolved task work.
These service contracts do not provide physical process containment. An untracked
detached child may overlap a later writer after qualified normal success.

## Operator CLI

The packaged `ensemble` executable (`package.json` `bin`, built to
`dist/src/cli/main.js`) talks only to a running `operator` service. Install it from
a checkout with `npm run build && npm pack`, then `npm install -g ./ensemble-*.tgz`,
or run `node dist/src/cli/main.js` directly.

1. Sign in to the web UI and create a credential under **Settings → CLI
   credentials**. Choose read-only or read/write and a lifetime of 7–90 days. The
   token is shown once; rotate to issue a replacement, then revoke the old one.
   Revocation is irreversible.
2. `ensemble auth login --connection home --url ORIGIN` prompts for the token with
   masked input and stores it in the macOS Keychain (service `ensemble-cli`, account
   = connection name). For unattended callers, pass `--token-file PATH` instead: a
   regular, non-symlink file owned by you with mode `0600` or stricter, holding one
   token. The file is referenced, never copied. There is no literal-token flag and no
   plaintext fallback; without the Keychain or a token file, login fails with
   `credential-store-unavailable`.
3. `ensemble auth status`, `ensemble task get TASK_ID [--output json]`,
   `ensemble connection list|use NAME|remove NAME` and `ensemble auth logout`.
   Logout and removal delete only local state; the server credential stays active
   until revoked or expired.
4. Read-only browsing, with either credential scope:
   - `project list|get ID|instructions ID [--revision N]|revisions ID` and the same
     for `profile`;
   - `task list [--project ID] [--state open|done|cancelled]`,
     `task search QUERY [--project ID] [--type task|decision|result] [--after T]
     [--before T] [--historical]` (times are ISO-8601 or epoch milliseconds) and
     `task messages TASK_ID`;
   - `assignment get|history|instructions ASSIGNMENT_ID`;
   - `result list TASK_ID`, `result get TASK_ID RESULT_ID`,
     `result evidence TASK_ID RESULT_ID ITEM_ID [--out PATH]` and
     `artifact get TASK_ID ARTIFACT_ID --out PATH`.

   Lists take `--limit N` (default 50, at most 200; task list caps at 100 and search
   at 50, reported as `limit-capped`) and `--cursor TOKEN`. One invocation reads one
   page: human output ends with a `More:` line giving the next command, and
   `--output json` adds `pagination` and `coverage` (completeness, gap codes and the
   service observation time). A cursor tied to another command or other filters is
   rejected; one the service no longer recognises fails as `cursor-stale` (exit 4),
   so restart without `--cursor`. Instruction views are reconstructed from retained
   revision records, not the submitted prompt, and still redact credentials and
   private paths. `--out` creates a new file with mode `0600` only after the bytes
   match their digest; an existing path is refused (`output-exists`) and a mismatch
   (`integrity-mismatch`, exit 5) leaves no file.

5. Configuration changes, with a read/write credential to apply:
   - `profile prepare PROFILE_ID`, `profile prepare-create`, `project prepare
     PROJECT_ID`, `project prepare-create`, `project prepare-routing PROJECT_ID` and
     `capacity prepare` read the current state and write a change document to a new
     `--out` file (mode `0600`). Nothing is sent. A document holds one command, the
     service installation, the target and expected revision (capacity: the limits it
     was prepared against), a diff and a preparation-time affected-assignment list.
     That list is informational: assignments created later may also become stale,
     and bound leads without an assignment row are not listed.
   - `profile apply`, `project apply` (project and routing documents) and
     `capacity apply` take `--file FILE [--request-id UUID]`. Apply refuses a
     symlinked, group/other-readable, oversized, malformed or modified document
     (`change-document-invalid`) and a document for another installation
     (`wrong-service`), then sends exactly the stored command. It never prompts,
     rebases or overwrites: a stale revision or capacity value is `conflict` (exit
     4); prepare again.
   - `--restore-revision N` proposes revision N's exact instructions as a new
     revision, and refuses redacted or omitted text. `--revoked`, `--paused`,
     `--enabled`, `--candidates`, `--credential-ref env:NAME|none` and
     `--project-limit PROJECT_ID=N|default` are the reverse paths. Creation is not
     reversible: revoke a profile or pause a project instead. Routing guidance is
     replace-only. Runtime, model, repository and GitHub settings are not offered.
   - `assignment apply-current ASSIGNMENT_ID --expected-version N` rebinds the
     assignment to the current profile and project revisions for its next turn; an
     active turn is not rewritten. Adoption is one-way: restore older text as a new
     revision and adopt again. A completed lead stays resumable: a later
     `task follow-up` resumes it under the adopted revisions.
   - `capacity get` shows global and per-project limits and usage.
   - `operation get REQUEST_ID --scope project:ID|profile:ID|system:capacity --type
     TYPE` reads a recorded receipt; the same UUID in another scope or type never
     selects it.

   Before sending, a write appends its service installation, scope, type, key and
   document digest to `requests.jsonl` in the configuration directory (mode `0600`);
   it never holds request bodies, instructions or tokens. Re-running `apply` on the
   same document reuses that key, so the service replays the recorded receipt. A
   lost or ambiguous response exits 6 with the full identity, a ready-to-run
   `operation get` and the exact retry. Exit codes: 2 invalid input, 3
   authentication or scope, 4 conflict or policy denial (`policy-denied`), 5
   unavailable (including `journal-unavailable`, when nothing is sent), 6 unknown
   outcome, 7 unsupported service. Write commands reject flags they do not use.


6. Execution diagnostics, with either credential scope:
   - `execution list (--task ID | --assignment ID | --project ID)` lists task-bound
     executions newest first with their capture state (`captured`, `baseline` or
     `not-captured`). `execution get WORK_ID` shows the bound identities and
     revisions, observed settings with their source (`service-admitted`,
     `runtime-reported` or `unknown`), counts and capture health.
   - `execution inputs WORK_ID [--compare-current]` shows the captured submission
     of Ensemble-supplied inputs (request, role, review references, project and
     profile instructions) with the submitted byte count and SHA-256. It is not
     the runtime's effective prompt. It is the only diagnostic view that leaves the
     execution's own instruction text readable; credentials, patterns and private
     paths stay redacted, and `logs` shows instruction segments only as
     `[redacted]`. An execution without a captured submission shows a
     labelled reconstruction from retained revisions instead.
     `--compare-current` compares bound and current instruction revisions and
     profile runtime settings.
   - `logs --execution WORK_ID [--kind input|setting|runtime|tool|service]
     [--severity info|warn|error] [--after T] [--before T] [--limit N] [--cursor
     TOKEN]` reads one ascending page; `data.resumeCursor` always resumes after it.
     `--follow` polls every `--interval S` (1–30, default 2) for at most
     `--max-duration S` (default 900, maximum 86400), holding one page at a time.
     It ends when the execution has finished and is drained, at the duration bound
     or on Ctrl-C, and prints a `Resume:` command. Each poll is a fresh
     authenticated request, so revocation or expiry stops it with exit 3; three
     consecutive unavailable polls exit 5 with the resume cursor. `--output jsonl`
     (logs only) writes one `ensemble.cli/v1` record per line: `item`, `gap`, `end`
     or `error`.
   - `doctor` reads the service's readiness checks (the same read as Settings →
     Readiness) and reports each as Pass, Fail or Not configured with one fix line
     per problem. It needs `diagnostics.read`, changes nothing, never prints token
     values or paths, and exits 0 whenever the read succeeds, whatever the checks
     report. `--output json` returns the unmodified service `data`.

   Capture is on by default (`enhanced`) for task-bound executions; `project.configure`
   with `diagnosticCapture: "baseline"` (shown by `project get`) reduces later
   executions to an execution row and a `capture-baseline` gap, and `"enhanced"`
   restores it. Neither erases anything. Runtime events are Codex tool-like items
   (command executions with command, working directory, status, exit code and
   bounded output; other item types by type and status only) and turn status. No
   message text, deltas or reasoning is collected, tool observation is never
   claimed complete, and Claude executions report runtime events `unsupported`.
   Payloads are redacted before storage and again with current exclusions on every
   read; when exclusions are unavailable an item reads as
   `omitted/redaction-unavailable`. Capture, storage or pruning failures become
   gaps and never change admission, holds, recovery or a turn's outcome. Gaps map
   onto the coverage codes: omitted or size-limited items `item-omitted`, redacted
   text `content-redacted`, failed redaction `redaction-unavailable`, expired,
   evicted, failed, interrupted, late and limit gaps `evidence-gap`, and baseline or
   uncaptured executions `evidence-unavailable`.

   Retention: items older than `ENSEMBLE_DIAGNOSTIC_RETENTION_DAYS` (1–365,
   default 30) are deleted hourly; beyond `ENSEMBLE_DIAGNOSTIC_STORAGE_MIB`
   (16–1048576, default 1024) the oldest items are evicted. Invalid values fail
   service startup. Each execution keeps at most 16 MiB and 8192 items and each item
   at most 64 KiB (a 4 KiB command or 48 KiB text field over its cap is replaced
   whole, never cut). Pruning removes items only; executions and coalesced gap counts
   remain. The quota bounds stored payload text, not the database, WAL or backups,
   and older backups keep what they held.

7. Operating tasks and attention. `inbox list`, `question get` and `approval get`
   work with either scope; the rest need a read/write credential (a read-only one
   exits 3 before anything is sent):
   - `task create --project ID --title T --outcome-file FILE --ready true|false
     [--blocker ID]... [--assignee PROFILE_ID]`, `task configure TASK_ID
     --expected-version N [--title T] [--outcome-file FILE] [--ready true|false]`
     and `task add-dependency|remove-dependency TASK_ID --blocker ID
     --expected-version N`. Imported tasks keep provider-owned title and outcome
     (`policy-denied`) and readiness. The task and initial-assignment ids are derived
     from the request key, so a retry rebuilds the same command.
   - `task message TASK_ID --to ASSIGNMENT_ID --expected-version N --message-file
     FILE` addresses a pending or running assignment for its next eligible turn; it
     admits no work. A completed project lead is refused with a pointer to `task
     follow-up TASK_ID --expected-version N --message-file FILE` (N is the lead's
     assignment version), which resumes the lead of an open task subject to
     admission, pause, Stop, dependency and capacity holds. A done task is never
     reopened.
   - `inbox list [--kind question|approval|intervention] [--project ID] [--limit N]
     [--cursor TOKEN]` pages server-side (at most 100). Interventions name `task get`.
   - `question get TASK_ID INTERACTION_ID` prints the form, marks recommended and
     preselected options as information only and shows the answers-file shape:
     `{"QUESTION_ID": {"optionIds": [...], "text": "..."}}`. `question answer TASK_ID
     INTERACTION_ID --expected-revision N --answers-file FILE` (at most 256 KiB)
     needs an explicit entry for every question, validates it locally, and sends
     the same command as the web UI for plain, Ensemble-form and native questions.
   - `approval get TASK_ID INTERACTION_ID` shows the exact action, target, material,
     material hash, revision and task holds. `approval decide TASK_ID INTERACTION_ID
     --decision approved|denied --expected-revision N [--material-hash HASH]` sends
     exactly what the service disclosed; the hash is required whenever material was
     recorded. Withheld or legacy material can only be denied.
   - `task stop TASK_ID [--expected-version N]` is best-effort cancellation: new
     turns are held, and effects may continue until termination is verified. It
     reads nothing first. `task resume TASK_ID [--expected-version N]` clears only
     the operator Stop and lists the holds that remain. Both are receipted
     `task.stop`/`task.resume` commands; the web UI's Stop and the retained forms
     use the same hold.

   Output names the effect (`data.effect`): `saved`, `queued` (admission and holds
   still decide), `cancellation-requested` or `none`. These writes reuse a journal
   key only while its outcome is unresolved (`sending` or `unknown`): rerunning the
   same command after exit 6 replays it once (`Reused unresolved request KEY`,
   `data.reusedRequest`), while a recorded key is never reused, so a second Stop,
   message or task is a new request. `--request-id` is always used as given. If a
   replayed Stop or Resume contradicts the current state, `data.stopInEffect` and
   the output say so; use a new `--request-id`. The exit-6 message names only the
   retry: `operation get` does not read these types. Creation, messages,
   follow-ups, answers and decisions cannot be undone; Stop/Resume, dependency
   add/remove and `--ready` are each other's reverse.

8. GitHub sources and delivery. `project sources` and `delivery get` work with
   either scope; the rest need a read/write credential (a read-only one exits 3):
   - `project sources PROJECT_ID` lists the source version, whether a credential
     reference is configured, selections (id, kind, descriptor, active, observation
     state and times), readiness, linked repositories and refs, and placement
     conflicts. Queries, filters, paths and reference names are never shown. A
     partial observation is gap `evidence-gap`, an unavailable one
     `redaction-unavailable`, and an unreadable saved value `content-unavailable`.
   - `project prepare-source PROJECT_ID --out FILE --edit-file FILE
     [--expected-version N]` writes a `github.configure` change document; apply it
     with `project apply --file FILE`. The edit file (at most 64 KiB, not a symlink)
     is strict JSON with any of `addSelections` (selection definitions without
     `id`: `{"kind":"repository","repositoryId","owner","name"}`,
     `{"kind":"search","query"}` or `{"kind":"project","projectNodeId","filter"}`),
     `removeSelections` (ids), `readiness` (replaces), `linkRepositories`
     (`{"repositoryId","path","ref"}`), `unlinkRepositories` (ids), `setRefs`
     (`{"REPOSITORY_ID":"REF"}`), `credentialRef` (`"env:NAME"` or `null`) and
     `confirmUnlinkAll`. Saving makes every selection inactive until it is
     previewed again and marks observations incomplete until the next sync
     refresh. Removing a selection discards its saved definition; unlinking
     discards its path. A saved value the read cannot name exits 4.
   - `project preview-source PROJECT_ID --selection ID --expected-version N`
     activates one selection after a complete provider read (an incomplete read
     exits 4). It imports no tasks and proves no sync. There is no deactivate
     command: saving any source change deactivates every selection. A rerun after a
     later save replays the original receipt and reports that the selection is not
     currently active.
   - `project place-task TASK_ID --to PROJECT_ID --expected-version N` chooses
     among the projects whose source matched an imported task (N is the task
     version). It neither starts work nor grants repository access and is final
     once the task has an assignment.
   - `delivery refresh TASK_ID` runs the existing installation-wide refresh: it
     reconciles unfinished delivery actions (it may re-attempt prepared or
     retryable ones) and re-reads every registered PR, then reports `outcome:
     complete|partial` for the task. A failed provider read or an unsettled action
     is `partial` (exit 0, gap `evidence-gap`), never "refreshed".
   - `delivery review-comment TASK_ID --body-file FILE --expected-task-version N`
     records a pending review and posts nothing. `delivery confirm-comment TASK_ID
     --review-id R --expected-revision N --material-hash HASH --decision
     approved|denied` decides it; a decision is final and a pending review cannot
     be withdrawn, only denied. `delivery send-comment TASK_ID --body-file FILE
     --expected-task-version N [--review-id R]` posts a public comment Ensemble
     cannot edit or retract; with `--review-id` the request ID is the review ID and
     the CLI first checks the review is approved for exactly this body by replaying
     it. An ID that is not an existing review is recorded as a new pending review
     by that replay, and nothing is posted. In approval mode a send needs a review.

   Comment and refresh requests are scoped `task:TASK_ID`. An identical rerun
   reuses the journal key and replays the recorded outcome, so a comment is never
   posted twice by a rerun; a deliberate second comment needs a new
   `--request-id`. A `denied` send exits 4 `policy-denied` and a
   `confirmed-failure` exits 4 `conflict`, both with nothing posted; an
   `uncertain`, `attempting` or `prepared` send exits 6: do not resend with a new
   key, run `delivery refresh` and then `delivery get`. `operation get` reads
   `github.configure` and `github.preview` receipts; placements, refreshes and
   comments are settled by rerunning with the same key.

9. Evidence-bearing recovery. `recovery get ASSIGNMENT_ID` and `recovery prepare`
   work with either scope; `recovery submit` needs a read/write credential (a
   read-only one exits 3 before anything is sent):
   - `recovery get ASSIGNMENT_ID` shows the assignment version, conversation
     revision, holds and up to the 20 newest recovery generations: work ID,
     generation, intent and request state, process identity, held reason,
     predecessor, witnesses, observations and receipt, and for each path
     (`pre-turn-adopt`, `pre-turn-recover`, `no-turn-adopt`, `no-turn-recover`,
     plus `conversation-replace` for the assignment) whether it is eligible, what
     blocks it and the inputs it requires. Eligibility is advisory; the service
     re-checks everything. A string that redaction would change is withheld (gap
     `content-redacted` or `redaction-unavailable`) and blocks the paths that would
     send it; older generations are gap `item-omitted`, none at all
     `evidence-unavailable`. `assignment get` prints a `Recovery:` pointer while the
     assignment is held.
   - `recovery prepare PATH ASSIGNMENT_ID --out FILE --work WORK_ID
     --evidence-file FILE` (or, for `conversation-replace`, `--expected-version N
     --expected-conversation-revision N` and no evidence file) writes an owner-only
     `ensemble.cli.recovery/v1` document with the exact command, the observed
     versions and a digest, and sends nothing. The identity comes from the read; the
     evidence file supplies everything the service cannot observe. It is strict
     JSON of at most 64 KiB with `"schema": "ensemble.cli.recovery-evidence/v1"`
     and, per path, exactly: `pre-turn-adopt` — `rpcError` (the persisted
     `{code, message}`), `evidence` (`frozenSourceRevision`,
     `frozenHarnessSha256`, `evidenceSha256`, `approvedDecisionSha256`,
     `reviewReference`, `approvalReference`) and `attestation`
     (`beforeTurnRejected`, `noTurnSubmitted`, `independentlyReviewed`, each
     `true`); `no-turn-adopt` — `evidence` (the same plus `invocationLedgerSha256`)
     and `attestation` (`completeSynchronousWriteAheadLedger`,
     `noStartTurnInvocation`, `independentlyReviewed`, `idleThreadMayExist`);
     either recovery — `receipt` (`termination: {"kind":"process-exit"}`,
     `effects: "settled"`, `workspace: "preserved"|"reconciled"`). A missing,
     `false`, extra or malformed item exits 2 before any request; there is no
     `--yes`, `--confirm`, `--force` or attestation flag. An ineligible path exits 4
     naming its blockers; an unlisted work exits 2.
   - `recovery submit --file FILE [--request-id UUID]` revalidates the document
     (owner-only, digest, same installation) and sends it once. Adoption records an
     immutable witness (`saved`); recovery verifies termination of the stored
     process and reconciles ownership (`completed`); conversation replacement
     increments the revision (`saved`). None resumes the task or dispatches work:
     after replacement, continue with a new `task message`. A refusal (stale
     identity, unverified termination, an existing witness, a stale revision or a
     task hold) exits 4 with the current blockers and observations; missing,
     expired or stale evidence is never a successful recovery, and that key is not
     reused. An identical rerun replays the recorded receipt; a lost reply exits 6
     and is settled with `operation get KEY --scope assignment:ID --type TYPE` or
     the same command.

   Adoption, recovery and replacement cannot be undone, and adoption here records
   evidence: it is unrelated to `assignment apply-current`. The bound-turn
   receipt has no CLI or operator route.

`ORIGIN` is `http://127.0.0.1:PORT` for the service on this machine, or an
`https://` origin for a separately managed private transport. Other `http:` URLs are
rejected. Certificates are always verified; for a private CA set
`NODE_EXTRA_CA_CERTS`. Redirects are never followed, so a credential cannot reach
another origin. Connections live in `connections.json` under
`$ENSEMBLE_CLI_CONFIG_DIR` (default `~/.config/ensemble`, directory `0700`, file
`0600`). With several connections, pass `--connection`, set `ENSEMBLE_CONNECTION`, or set a
default with `connection use`.

Runtime children started by the service receive `ENSEMBLE_MANAGED_ASSIGNMENT=1` and
no `ENSEMBLE_CONNECTION` or `ENSEMBLE_CLI_*` variables, and the CLI refuses to
authenticate when the marker is set. This guards against accidental privilege
crossing only; it is not OS isolation from same-user processes. The CLI8 live run
observed the marker in Codex tool shells (one host, one Codex version).

Troubleshooting:

- `service-identity-changed` (exit 3): the URL now reaches another installation.
  Log in again only if that change is intended.
- `credential-store-unavailable`: no Keychain (or no interactive terminal for the
  masked prompt); use `--token-file`. The Keychain lookup uses `HOME`'s login
  keychain; with a `HOME` that has none, `auth login` waits on `security` instead of
  failing.
- `managed-assignment` (exit 3): the command runs inside an agent turn, which must
  not use operator credentials.
- For another machine, reach the service only through a private HTTPS route (for
  example a tailnet-only route to the loopback port), log in there with the `https://`
  origin and a token file, and trust a private CA with `NODE_EXTRA_CA_CERTS`.

`npm run check` covers the CLI with injected fakes and a packed offline install
against a real service over loopback and verified HTTPS. The Keychain test is
opt-in on macOS: `npm run build && ENSEMBLE_KEYCHAIN_LIVE=1 node --test
dist/test/operations/operator-cli-keychain.test.js`; it adds and deletes only a throwaway
`ensemble-cli-test-<uuid>` item.

`node test/operator/cli-journey-qualification/live-journey.mjs --fixture` (run by `npm run check`) drives the
installed binary through the assembled journey with a scripted runtime.
`npm run operator-cli:live` runs it once against Codex through the ChatGPT.app launcher with
at most two model turns, a Keychain login and verified cleanup; it prints sanitised
evidence JSON.

## Previous implementation

The previous Rust pipeline implementation is preserved on the
`cb/pipeline-implementation` branch, and the BB prototype's documents remain in git
history. The pipeline implementation's configuration and persisted runs are not
compatibility requirements, and the BB prototype receives no new feature
development. Finish or explicitly retire existing work before operational cutover;
retained records do not prove safe resumption on another runtime. Earlier ADRs
retain product policy except where superseded by
[ADR-1004](adr/1004-standalone-service.md).
