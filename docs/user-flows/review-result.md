# Review a result

**Status:** planned. The result, criteria and evidence sections exist on task
detail; the first-viewport layout and the budget below are not yet implemented or
asserted.

## Goal

When a lead reports a result, the operator reads the summary against the task's
criteria, opens the evidence behind any criterion in one step, and decides what
to say to the lead.

## Entry points

- Home recent results.
- Task detail Overview (latest result first when one exists).
- Inbox request pane evidence links.
- Operator CLI `result` reads.

## Steps

1. The task opens on the latest result: summary, each supplied criterion with its
   recorded outcome, and the recorded decisions attributed to who made them.
2. A criterion with evidence links to it; a criterion without evidence says so in a
   sentence and offers Ask lead about criterion. No verified outcome is inferred.
3. Changes and retained evidence are one step away; earlier results are listed
   beneath the latest, not above it.
4. Message lead sends feedback on the result; completion stays the lead's decision.

## Budget

| Entry point | Interactions to the evidence for a criterion | First screen must show |
| --- | --- | --- |
| Task detail | 1 (the criterion's link) | the result summary and every criterion with its outcome |
| Home recent results | 2 (the result, the criterion's link) | the result summary |

An Inbox evidence link lands on the evidence it names (1).

Identifiers (result, assignment, revision) appear as short metadata, never in a
sentence.
The operator CLI is outside the budget: it has no screens.

Frames: see [Daily flow frames](../../design/DESIGN.md#daily-flow-frames).

## Recovery

- A result superseded by a newer revision is labelled as earlier, with the newer
  one above it.
- Unavailable or unretained evidence is stated in a sentence; current files are
  never shown in its place.
- A failed message keeps its draft; a sent one shows its receipt.
