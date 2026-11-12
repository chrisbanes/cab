# Answer a question

**Status:** built for the three budgeted entry points. The Home card answers a
single pending single-choice question in place, the Inbox row opens the request in
the pane, and the task decision card shows the first question's label and opens the
form on the task page; each records the answer and shows "Answer recorded". The
budget below is asserted at 1366 × 900 and 390 × 844 by
`test/operator/operator-answer-question-browser.test.ts` ("answer a question
budget"), with Home's runtime readiness passing and one paused-project getting-started
row above the card; each further getting-started row that needs attention pushes the
Home card down. The browser notification and the operator CLI are outside it.
The Inbox review-session row, each further question after a recorded answer, is
asserted at 1366 × 900 by `test/operator/operator-inbox-browser.test.ts` ("work
through the Inbox").

## Goal

The operator sees what is being asked before opening anything, answers it where
they are, and gets one confirmation that the answer was recorded.

## Entry points

- Home "Needs you" card.
- Inbox queue row.
- Task detail decision card, reached through the strip's operator next-action link.
  An explicit request link opens that request; an untargeted task starts at the latest
  conversation entry with Reply in view.
- Browser notification (opt-in, Settings → Notifications): opens the exact Inbox
  selection after sign-in. It is outside the budget below, and it never answers.
- Operator CLI `question answer`.

## Steps

1. The list row or card shows the question itself (the first question's label), the
   task and project beneath it, the requester when known, and Answer question.
2. The form shows the questions in the request's order with their constraints and
   any recommended option marked as a draft, not an answer. A single-choice question
   on the Home card is answerable there.
3. Submit answer records the whole group once and shows "Answer recorded" with the
   request still in view. The Inbox does not move to the next request on its own:
   once a fresh complete read shows the request has left the queue, the pane offers
   Next request, naming that request and its project and task, or says no requests
   remain. On wide layouts Previous/Next request and the J and K keys also step
   through the queue. Filters, position and unfinished answers in other requests are
   kept.

## Budget

| Entry point | Interactions to a recorded answer | First screen must show |
| --- | --- | --- |
| Home card, single choice | 2 (choose, Submit) | the question text and its options |
| Inbox row | 3 (row, choose, Submit) | the question text in the row |
| Inbox, each further question after a recorded answer | 3 (Next request or J, choose, Submit) | the next request's question, project and task on the Next request control |
| Task decision card | 3 (Answer question, choose, Submit), once at the card | explicit request links show the named question; untargeted visits show the latest conversation |

The operator CLI is outside the budget: it has no screens.

## Recovery

- A failed submission keeps the input and names the cause; a stale or already
  answered request refuses a new answer and says so.
- Recording an answer never resumes a paused project or clears a hold; the
  confirmation states any remaining wait, with its Fix where the
  [specification](../SPEC.md#task-creation-and-project-setup) gives it one and
  otherwise with the link to what blocks it.
- An unsupported runtime request stays unresolved and is never converted to chat.
- In an archived project the Inbox shows the read-only notice and **Open question**,
  which leads to the task's read-only request view, instead of the answer form.
