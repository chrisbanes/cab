# S04d operator integration

The runtime operator routes sit on top of the authenticated
local UI foundation in [S04c](s04c-operator-ui.md). The production `operator`
command registers the runtime route slot with the same `LocalOperatorHttp` instance;
they therefore inherit its login, exact-Origin, CSRF, input parsing, safe
redirect and response-header behavior. The adapters receive service/domain
interfaces, not raw HTTP request or response objects.

## Runtime operator view

The Runtime overview reports configured global/default/effective project
capacity and current reservations. Its forms configure the global and optional
project limit. Task and assignment views show selected, queued, admitted,
running, stopping, held and completed evidence, local task dependencies,
captured profile/instruction revisions and the explicit apply-for-next-turn
action. Task controls add/remove local dependency edges, request current
instructions for a later turn, request bounded best-effort Stop, and Resume.
Stop may be acknowledged without proving that effects ended; the view retains
writer/capacity/uncertainty holds and does not offer a force-unlock operation.

The page distinguishes configuration eligibility from runtime admission and
observed execution. It discloses the actual default policy (workspace writes,
broad host-permitted reads, command network disabled, approval policy never)
and states that strict isolation, exhaustive ambient access containment and
universal descendant containment have not been proved. Existing Codex login
and host/deployment controls remain the execution trust boundary; cab does
not claim an independent sandbox.
Runtime assignment status follows the latest persisted request
sequence for the current assignment revision, so an older completed turn cannot
mask a queued continuation.

## Coordination and approval evidence

The server-rendered Coordination pages are retired. The React task view
(`/app/tasks/:id`) presents task-scoped assignments, runtime history, durable
messages, questions, exact approval materials, results/destinations and
completion attention through the operator API. Its controls answer open
questions, decide an approval, queue a durable message for the next eligible
turn, reconcile an unresolved result only to an allowed same-task requester or
lead, and settle a reviewable PR's handback. No live steering is exposed.
Operator content remains task-scoped and does not display runtime prompts,
private instructions, workspace paths or credential references.

Approval callbacks retain canonical JSON material, bounded to 8 KiB, beside
its digest. A decision must match the exact stored material and revision before
it is recorded. The additive nullable SQLite column preserves legacy open
approvals; missing legacy material cannot be approved and may only be denied.
The task view renders the disclosed material and offers no approval for
material or a target it cannot show.

Project routing configuration shows that project's guidance and
configured candidates with their capabilities and current routing eligibility;
revoked configured profiles remain visible as unavailable. It distinguishes a
stored credential reference from an available routing client and gives only
bounded effective-availability reasons (disabled, missing client credentials,
or no eligible candidates). It exposes neither references nor environment names
or secret values and makes no provider request. Routing availability does not
describe capacity, busy state or execution admission; candidate selection still
does not authorize a runtime turn. The project configuration page calls this a
credential reference, not a configured credential.

## Verification boundary

Deterministic adapter tests use real SQLite and fake only the runtime boundary.
The HTTP integration test registers the production adapter routes on a real
loopback server and checks pre-login confidentiality, unauthenticated writes,
exact Origin and CSRF refusals, malformed and duplicate field rejection, safe
shared response headers, and idempotent capacity submission. Chromium exercises
the production route registry with dependency, instruction-apply and Stop/Resume
form submissions; coordination writes are covered through the operator API and
the task view's browser tests.

The opt-in [`test/operator/integration-qualification/live-operator.mjs`](../../test/operator/integration-qualification/live-operator.mjs)
uses a disposable service with the real Codex App Server, generated local
operator credentials, and Chromium. It observes a real task-scoped question,
requests Stop through the UI, checks the bounded Stop/known-writer hold, restarts
the service and App Server, and verifies retained question/history/holds and
process cleanup. It does not use TypeSafe, alter shared Codex configuration,
delete provider thread records, deploy, or authorize cutover. Evidence is
recorded in [`s04d-operator-2026-09-30.md`](../evidence/s04d-operator-2026-09-30.md).

The [`test/operations/private-access-qualification/private-access.mjs`](../../test/operations/private-access-qualification/private-access.mjs) proof
also checks the private Runtime and workspace API reads and a same-origin,
replayed capacity write, restoring the disposable project's original effective
limit afterward. It requires an explicitly provisioned disposable HTTPS/Tailscale
fixture and a passing run from the fixture host through its canonical Tailscale
HTTPS URL. This proves the private route and browser boundary from that host; it
does not establish reachability from a separate device. If the fixture or route
is absent, the proof is unproved. The test does not
create, replace or remove persistent Tailscale Serve configuration; neither this
proof nor the loopback proof authorizes deployment or cutover.
