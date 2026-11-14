# Review a result

**Status:** built. Task detail opens at the latest conversation entry. Latest result
sits beside the conversation on desktop and follows it on phones, with its summary and
the first three criterion outcomes; further criteria sit behind "N more". No
criterion-to-evidence relationship is recorded, so the evidence is the Evidence
card, one click away on desktop and phone. Evidence opens independently of Task details.
The Recent results strip on Home is not built; Home reaches
results through Completed work. The budget below is asserted by
`test/operator/operator-review-result-browser.test.ts`.

A lead that needs a decision about its result requests a review
([ADR-1035](../adr/1035-result-review-requests.md)). That result becomes one Inbox item,
and the Inbox, Home and the task's attention card open the same review panel. Its review
budget is asserted by `test/operator/operator-result-review-browser.test.ts`.

## Goal

When a lead reports a result, the operator reads the summary against the task's
criteria, opens the supplied evidence, and decides what
to say to the lead.

## Entry points

- Home Completed work.
- Task detail Overview (Latest result beside or after the conversation).
- Inbox request pane evidence links.
- Operator CLI `result` reads.
- For a requested review: the Inbox row, Home's Needs you card ("Review result") and the
  task's attention card ("Review result", or a `?request=` link). Latest result shows a
  requested review's state with "Open review".

## Steps

1. An untargeted task opens at the newest conversation entry with Reply in view.
   Read Latest result beside the conversation, or below it on a phone: summary, the first three supplied
   criteria with their recorded outcomes (the rest sit behind "N more"), and the
   recorded decisions attributed to who made them.
2. A criterion without a recorded outcome reads Unverified. Symbols and words distinguish
   supported, failed, unverified, duplicate/unknown and stale outcomes. Each row's Details
   retains exact attribution, scope and provenance, including duplicate records.
3. Use the single Ask lead action with This result or a labelled criterion, including
   criteria beyond N more. It opens an editable reply with the exact reference. A changed
   result or source resets an obsolete criterion target visibly; an unfinished reply keeps
   its text and reference.
4. Changes and Evidence are each one step away. Earlier results are listed beneath
   the latest, not above it.
5. Message lead sends feedback on the result; completion stays the lead's decision.

For a requested review, the panel reads in decision order. Only Details and criteria beyond the
first three ("N more") sit behind a disclosure:

1. The decision and the lead's recommendation, labelled as reported by the lead.
2. What changed and why (the result summary) with its Changes link, then the criteria; both
   are labelled as reported by the lead.
3. Evidence: validations, with each checked head compared with the head cab recorded for
   the result, and artifacts, with screenshots shown inline. A result with no recorded
   evidence says so.
4. Remaining uncertainty: "No remaining uncertainty recorded" when the lead recorded no list,
   and "The lead listed no remaining uncertainty" for an empty one.
5. The response: Mark reviewed, with an optional note, or Send feedback, with required
   text. A note or feedback reaches the lead as feedback on that result; Mark reviewed
   without a note sends nothing. Neither approves, merges or completes the task.

Details holds the result's R number, work revision, recorded time and recorded workspace,
labelled as recorded by cab. Open conversation stays in the panel's footer.

## Budget

| Entry point | Desktop interactions | Phone interactions | First screen must show |
| --- | --- | --- | --- |
| Fresh task detail | 1 (Evidence) | 1 (Evidence) | latest conversation and Reply; Latest result follows on a phone |
| Home Completed work | 2 (the task, Evidence) | 2 (the task, Evidence) | the task in Completed work (below the first screen on a phone); after the first interaction, the latest conversation on the task page |
| Review request, Home card | 2 (Review result, a response) | 2 (Review result, a response) | the decision on the card; after the first interaction, the review panel in the Inbox |
| Review request, Inbox row | 2 (the row, a response) | 2 (the row, a response) | the decision in the row |
| Review request, task attention card | 2 (Review result, a response) | 2 (Review result, a response) | the decision in the attention card |

Typing feedback is not an interaction. Each review row stays within answer-question's budget
for the same entry point.

Explicit result, source, record and section links keep their named target. Returning
to a task preserves reading position, expanded criteria and unfinished replies.
An explicit Evidence section link opens Evidence, so it needs no extra opening click;
already-open Evidence is left open. The phone's Task details stays closed.

Home's Completed work lists the task title only, so the summary is not on Home. On a
phone the panel sits below Home's first screen; scrolling is not an interaction.

An Inbox evidence link lands on the task's conversation in one interaction; it does not
name a single result.

Assignments and results use the redacted agent name with supplied responsibility,
summary or recorded time. Exact identities stay in local Details on the result, criterion
and brief; assignment identities stay in Assignment facts. Task details starts closed at
all widths. An explicit target or a retained disclosure choice wins.
The summary, criteria and Evidence remain outside that fold. Opening local Details to
inspect provenance is a separate interaction, outside the evidence-access budget.
Result and retained-source revision pickers appear only with two or more records;
an unavailable exact selection stays unavailable and never substitutes the latest.

Review holds the viewing comparison, Set viewing reference, its caveat and any checkable
unconfirmed or refused write. Viewing records availability only; it neither responds to
a requested review nor approves work or clears holds. Local review keeps its own drafts.
Execution holds Captured context, including direct context and captured-record links.
Legacy `#review` and `?section=review` still open Latest result on Overview;
`?section=viewing-reference` opens the viewing controls on Review.
The operator CLI is outside the budget: it has no screens.

## Recovery

- A result superseded by a newer revision is labelled as earlier, with the newer
  one above it.
- A result that recorded no workspace state says so; a linked file that neither
  the workspace nor the recorded commit holds unchanged is stated as unavailable,
  and other bytes are never shown in its place.
- A failed message keeps its draft; a sent one shows its receipt.
- A review that a newer lead result superseded reads "Superseded by a newer result", links
  that result and takes no response. A response sent from a page that had not refreshed is
  refused with "This review is no longer current"; nothing is recorded and the unsent draft
  stays visible. Feedback the lead cannot receive now is refused while the review stays
  pending; the draft stays in the form, and clearing the note then Mark reviewed still records it.
- A draft in the Inbox survives moving to another request and back; dismissing a review
  records no response, and Restore returns it.
- A draft left on a review that is no longer pending reads as unsendable with **Discard
  draft**, which removes it from both the Inbox and the task page and cannot be undone. A
  draft on a pending review is kept as before.
- In an archived project the Inbox, like the task page, shows the review read-only with
  "This project is archived. Tasks and history are read-only." and offers no response.
- A review the lead withdrew reads "Withdrawn by the lead" with its reason; one whose task
  closed reads "Closed with the task".
