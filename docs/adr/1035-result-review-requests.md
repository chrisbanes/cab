---
status: accepted
---

# Result review requests

A lead hands back a result that needs an operator decision, such as whether a UI change is right or
which of two follow-ups to take. Today the operator reconstructs that decision from the
conversation, and nothing in the Inbox says a result is waiting for them. Questions and approvals
do not fit: a question asks before the work is finished, and an approval authorizes one exact
external action and blocks the task until it is decided.

## Decision

A **result review request** is its own record, `coordination_result_reviews`, outside
`coordination_interactions`.

- **Request.** Only the task's accountable lead makes one, with an optional `operatorReview`
  argument on `cab_report_result`: a `decision` headline under the question rules, a
  `recommendation` and optional `uncertainties`. It is recorded in the same transaction and
  replay receipt as the result, so a result never exists without the review its report asked for,
  and a replayed report creates no second review. Each review is bound to one `resultId`, its
  `workId` and `workRevision`. A delegate cannot request one, and there is no request for an
  earlier result.
- **Lifecycle.** `pending` ends once: `responded` when the operator answers, `superseded` when the
  lead records a newer result on the task, `withdrawn` when the lead calls
  `cab_withdraw_result_review` with a reason, and `closed` when the task is Done or Cancelled.
  Every change increments the review's revision in the transaction that causes it.
- **Response.** `result-review.respond` names the review and its expected revision and chooses
  `reviewed` or `feedback`. It is refused unless the review is pending at that revision, so a
  response read against one result never applies to a newer one. Feedback, or a note with
  `reviewed`, is delivered through the existing operator-feedback path anchored to the result,
  which resumes a completed lead; `reviewed` without a note sends nothing, because waking a
  finished lead to acknowledge it would spend a turn for no work.
- **Attention.** A pending review is one `result-review` Inbox item, at the urgency of questions,
  and the `result-review` attention code on its task. Dismissal hides it as it hides other items
  and records no response.
- **Not authority.** A review is never an interaction, so `authorizationFor` cannot match it and
  it adds no `open-interaction` completion blocker. Neither response grants permission, merges,
  completes the task or changes assignment or delivery state. Approval and completion keep their
  existing rules.
- **Review surface.** The Inbox, Home and the task's attention card open one decision-focused
  panel for the review: the decision, the recommendation, what changed and why, criteria,
  evidence, remaining uncertainty and the response. The conversation stays one link away.

## Considered options

- **A question with `reviewed` and `feedback` options.** Rejected. A question waits on the
  requesting assignment and keeps its work open, and an answer is routed to the turn that asked,
  not to a completed lead's next follow-up.
- **An approval of the result.** Rejected. Approval binds exact action material and gates an
  effect; a reviewed result authorizes nothing, so sharing the record would risk an old review
  satisfying an authorization check.
- **A separate request tool.** Rejected. Requesting review after reporting leaves a window where
  the result exists without its request, and needs its own replay identity.
- **Supersede on any new result.** Rejected. A delegate's result is input to the lead, not a newer
  handback.

## Consequences

- Routine completions raise nothing; leads are told to request review only when a decision or
  intervention is needed.
- A response cannot reach a newer result than the one the operator saw.
- Results recorded before this change have no review request and read as before.
- The project-deletion inventory, its receipt scope `result-review-response` and the store
  migration level include the new table.
