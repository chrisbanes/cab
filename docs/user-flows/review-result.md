# Review a result

**Status:** built. Task detail opens on the latest result with its summary and
the first three criterion outcomes; further criteria sit behind "N more". No
criterion-to-evidence relationship is recorded, so the evidence is the Evidence
card, one step away. The Recent results strip on Home is not built; Home reaches
results through Completed work. The budget below is asserted by
`test/operator/operator-review-result-browser.test.ts`.

## Goal

When a lead reports a result, the operator reads the summary against the task's
criteria, opens the evidence behind any criterion in one step, and decides what
to say to the lead.

## Entry points

- Home Completed work.
- Task detail Overview (latest result first when one exists).
- Inbox request pane evidence links.
- Operator CLI `result` reads.

## Steps

1. The task opens on the latest result: summary, the first three supplied
   criteria with their recorded outcomes (the rest sit behind "N more"), and the
   recorded decisions attributed to who made them.
2. A criterion without a recorded outcome reads Unverified. Every criterion offers
   Ask lead about criterion. No verified outcome is inferred.
3. Changes and retained evidence are one step away; earlier results are listed
   beneath the latest, not above it.
4. Message lead sends feedback on the result; completion stays the lead's decision.

## Budget

| Entry point | Interactions to the evidence | First screen must show |
| --- | --- | --- |
| Task detail | 1 (Evidence) | the result summary and at most three criterion outcomes, with "N more" for the rest |
| Home Completed work | 2 (the task, Evidence) | the task in Completed work; after the first interaction, the result summary on the task page |

The first-screen promise holds for criterion text up to about one line each. A longer
or multiline criterion is shown in full, never clamped, and can push later outcomes
below the first screen.

The "N more" disclosure follows the third outcome. The first screen promises the
summary and up to three outcomes, so "N more" may sit just below it (about 40px at
a 1366 × 900 desktop, one row on a phone); reaching it is a scroll, not an interaction.

Home's Completed work lists the task title only, so the summary is not on Home. On a
phone the panel sits below Home's first screen; scrolling is not an interaction.

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
