---
status: accepted
---

# The status mapping is its own write authority

Saving a status mapping asked the operator to state one intent twice: map the option, then
allow it again as a `project.field` grant (GitHub) or an `issue.status` grant (Jira). A grant
also has a scope the mapping does not share. A `project.field` grant covers one repository's
issues, while a GitHub Project spans repositories. An `issue.status` grant covers one Jira
project, while a Jira mapping covers the whole source, whose JQL can span several. The
glossary defines **Status mapping**. This decision supersedes the grant condition of
[ADR-1017](1017-non-agent-readiness-writes.md) and keeps its other limits.

## Decision

The saved status mapping is the operator's authority for the service status-mapping caller
(`actor: service`, `purpose: status-mapping`) to write exactly the mapped options or statuses.
`DeliveryStore.authorize` consults no delivery grant for that caller, and
`status-mapping.configure` refuses a save only for `no-selection` and `readiness`.

Every other limit of ADR-1017 holds, at save and at write:

- The write names the exact option or status mapped for the event, under the mapping version
  it was prepared with. Clearing or changing the mapping is the reverse path: a write prepared
  under an older version is refused when it is attempted, with
  `delivery-authority-stale-or-held`, and shows on the task.
- The target is the imported issue's own Project item, or the issue's current Jira selection
  membership.
- The task is Ready, except Done on closure, and an in-flight event must keep it Ready.
- The write is conditional on the Status cab last wrote or read.
- The service never has an approval. Agents and the operator keep the readiness refusal.
- The delivery policy version still gates an attempt, so a write prepared before a
  `delivery.configure` is refused and the next transition writes under the new policy.

Settled consequences:

- **No repository-link limit.** The source's selection already chose which issues are in scope,
  and the write is bound to the task's own imported issue.
- **`issue.status` grants are retired.** Only the status mapping could ever use them.
  `issue.status` stays an external action kind, which the service uses, and `delivery.configure`
  refuses it as a grant. A store migration deletes stored `issue.status` grants from every
  delivery policy. It is data only: every other grant and field stays and the policy version
  does not change. It runs before anything parses a policy. The deletion is not reversible in
  the application; the pre-migration startup snapshot is the recovery path.
- **`project.field` grants are left as they are**, because agents and task publication still
  use them. The status mapping no longer reads them.
- **The authority is shown, read-only.** Delivery settings and the CLI `delivery` read state
  what the saved mapping lets cab write, so one place still lists everything cab may write.
  The editor states what saving allows.

## Considered options

- **The mapping save also writes the grants, atomically.** Rejected: it needs a record of where
  each grant came from, one grant per repository for a Project that spans repositories, and a
  check against both the mapping and the policy version.
- **A two-step save that maps, then offers the grants.** Rejected: it is not atomic and still
  states the intent twice.
- **Keep the grant and drop only the save refusal.** Rejected: a write would still fail at
  attempt for an option the operator mapped, and the scope mismatch would remain.
