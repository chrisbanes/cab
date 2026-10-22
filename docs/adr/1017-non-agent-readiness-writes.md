---
status: accepted
---

# Allow named non-agent callers to write readiness fields

An imported task is Ready by the project's readiness rule, which can name a Project
field such as Status or a label. Agents and the operator are refused any write to a field
or label the rule names, so Ensemble's own work can never change what makes a task
Ready. Two features need such a write from a caller that is neither: reflecting Ensemble's
work onto a Project's Status ([#1194](https://github.com/chrisbanes/ensemble/issues/1194)),
and publishing a Ready local task as an issue that the rule still accepts
([#1167](https://github.com/chrisbanes/ensemble/issues/1167)). The glossary defines
**Status mapping** and **Task publication**.

## Decision

A readiness field or label is written only by a caller named here. Each is a distinct
caller type, so a new one is a new decision that extends this record, not a flag.

- **Agents and the operator on a bound issue** keep the refusal of readiness labels and fields,
  in `issue.labels`, `issue.create` and `project.field` alike.
- **The service status-mapping caller** (`actor: service`, `purpose: status-mapping`)
  may submit a single action, `project.field`, on the Project, field and option its
  project's mapping names for one event, on the imported issue's own Project item. It
  goes through `DeliveryStore.authorize` and the delivery lifecycle (operation ids,
  intent before effect, readback, retained uncertainty, no blind replay) like every
  other caller. Its conditions:
  - The mapped option is covered by an operator-configured `allow` `project.field`
    grant for the exact Project, field and option. It never has an approval, so a grant
    in `approval` mode fails closed, at save and at write.
  - The task is Ready when the write is authorized. No write can make a non-Ready task
    Ready, because only a task that already is qualifies. The one exception is Done on
    closure: a done task whose issue is observed closed may have its mapped Done option
    written although it is no longer Ready, since a closed issue cannot be Ready; the write
    is refused if the option is one the readiness rule accepts, only against the Status Ensemble last wrote or read while the task was Ready (a Status a
    human set since is skipped), and only for a task the mapping saw before it was done, so closed issues a source imports already done are never written.
  - An in-flight event (first turn started, PR handed back) may write only an option
    that keeps the task Ready: the readiness rule is evaluated on the task's stored
    facts with only that field's value replaced by the target, at save against the
    rule's conditions and again at write. A terminal event (stopped, uncertain or
    blocked, Done) may write an option that removes readiness; the ordinary
    readiness-lost hold then applies on the next sync.
  - The write is conditional on the Status Ensemble last observed: the provider reads
    the item first and writes nothing when it differs. A move between that read and the
    mutation is an accepted race, detected on readback.
  - Its records do not hold the task. Unresolved status-mapping actions are excluded
    from the task's action blockers, so they never hold admission, completion, operator
    edits or agent actions, and they run in their own queue with a time limit on each
    provider call, so a hung call never delays the task's work. A write still in flight
    serializes only the next status write. An unproved write defers nothing, because that write re-reads the Status.
- **The operator publication caller** (`actor: operator`, `purpose: task-publication`) is a
  fourth caller type, distinct from the operator's bound-issue caller, which a local task cannot
  have (it names the publication, its selection and repository instead of an imported
  issue). It may submit only `issue.create` on its recorded repository and then, on the issue it
  created, `project.item.add` and `project.field`, each as a step its confirmed review froze;
  the confirmed review is its approval in either grant mode, and agents and the service can
  never use `issue.create` or `project.item.add`. It is exempt from the readiness refusals only
  when all of these hold at write time:
  - the task is Ready (`domain_tasks.ready = 1`), so a publication never makes a Draft task
    Ready; for a Draft task the same writes stay refused;
  - for `issue.create`, every label is one the readiness rule names; for `project.field`, the rule
    has a condition naming exactly that Project, field and option.
  The task's Ready flag is not recomputed on conversion: the next sync does that from GitHub, so
  a write that failed leaves the ordinary readiness-lost or withdrawn hold, not a silent
  Ready. The readiness refusal now also covers readiness labels carried by `issue.create`.

## Considered options

- Let agents write the mapped Status through their `project.field` grant, as before.
  Rejected: the board then reflects what an agent chose to do, which is the drift this
  removes, and it would need the readiness refusal lifted for agents.
- Lift the readiness refusal for any caller holding a grant. Rejected: a grant names
  options, not events, and would let any caller remove or add readiness.
- Exempt terminal and in-flight events alike. Rejected: an in-flight write that removed
  readiness would stop the work it reports.
- Widen the operator's bound-issue caller to publish. Rejected: it names an imported issue a
  local task does not have, and widening it would change the persisted material hash of every
  existing operator record.
- Let a publication write any granted option or label. Rejected: it could make a Draft task Ready
  or pick an option the rule does not name; the exemption is the rule's own label or option, for a
  task that is already Ready.
- Hold the task, or the task's mapping, while a status write is unproved. Rejected: after a
  human moves the card the write stays uncertain indefinitely, a board reflection is
  independent of the work, and the next write's re-read already refuses to overwrite a
  moved card.
