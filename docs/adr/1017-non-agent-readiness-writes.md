---
status: accepted
---

# Allow named non-agent callers to write readiness fields

An imported task is Ready by the project's readiness rule, which can name a Project
field such as Status. Agents and the operator are refused any write to a field or
label the rule names, so Ensemble's own work can never change what makes a task
Ready. Reflecting Ensemble's work onto a Project's Status needs a write to exactly such
a field, so one caller outside those two must be allowed. The glossary defines
**Status mapping**; delivery scope lives in
[#1194](https://github.com/chrisbanes/ensemble/issues/1194).

## Decision

A readiness field or label is written only by a caller named here. Each is a distinct
caller type, so a new one is a new decision that extends this record, not a flag.

- **Agents and the operator** keep the refusal of readiness labels and fields.
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
    Ready, because only a task that already is qualifies.
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
    edits or agent actions, and they serialize only among themselves.
- **The ticket that publishes tasks** ([#1167](https://github.com/chrisbanes/ensemble/issues/1167))
  extends this record with its caller if it writes a readiness field.

## Considered options

- Let agents write the mapped Status through their `project.field` grant, as before.
  Rejected: the board then reflects what an agent chose to do, which is the drift this
  removes, and it would need the readiness refusal lifted for agents.
- Lift the readiness refusal for any caller holding a grant. Rejected: a grant names
  options, not events, and would let any caller remove or add readiness.
- Exempt terminal and in-flight events alike. Rejected: an in-flight write that removed
  readiness would stop the work it reports.
- Hold the task while a status write is unresolved. Rejected: after a human moves the
  card the write stays uncertain indefinitely, and a board reflection is independent of
  the work.
