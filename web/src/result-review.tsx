import { useId, useState } from "react";
import type {
  OperatorCommand,
  Session,
  TaskRead,
} from "../../src/operator/contracts.js";
import { resultWorkspaceLines } from "../../src/operator/task-presentation.js";
import { ActionOutcome, type OutcomeField } from "./action-feedback.js";
import type { OperatorClient } from "./api.js";
import { randomUUID } from "./browser-crypto.js";
import { ActionLink, Button } from "./components.js";
import { CriteriaRows, Literal, ReviewEvidence } from "./result-evidence.js";
import {
  missingEvidence,
  recordedByCab,
  reportedByLead,
  resultHeadComparison,
  resultIdentity,
  reviewStatus,
  uncertaintyLines,
} from "./result-review-presentation.js";
import { Textarea } from "./ui/textarea.js";
import "./result-review.css";

type Respond = Extract<OperatorCommand, { type: "result-review.respond" }>;
type Outcome =
  | {
      kind: "recorded" | "unknown";
      message: string;
      details?: OutcomeField[];
    }
  /** Refused: worded once the refreshed review shows why. */
  | { kind: "refused" };

/**
 * The decision-focused review of one result: the decision and the lead's recommendation, what
 * changed, criteria, evidence and remaining uncertainty, then the response. Key it by review so a
 * draft never moves to another one; a draft survives a refused send, and `drafts` keeps it while
 * the operator moves between reviews.
 */
export function ResultReviewPanel({
  client,
  session,
  task,
  reviewId,
  onChanged,
  showDecision = true,
  readOnly = false,
  drafts,
}: {
  client: OperatorClient;
  session: Session;
  task: TaskRead["data"];
  reviewId: string;
  onChanged: () => void;
  /** Off where the surrounding pane already names the decision. */
  showDecision?: boolean;
  readOnly?: boolean;
  /** Unsent drafts by review, kept across selections by the owning view. */
  drafts?: Map<string, string>;
}) {
  const [draft, setDraftState] = useState(() => drafts?.get(reviewId) ?? ""),
    [pending, setPending] = useState<Respond | null>(null),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [criteriaOpen, setCriteriaOpen] = useState(false),
    noteId = useId(),
    helpId = useId();
  const setDraft = (value: string) => {
    setDraftState(value);
    if (!drafts) return;
    if (value) drafts.set(reviewId, value);
    else drafts.delete(reviewId);
  };
  const review = task.resultReviews?.find((r) => r.reviewId === reviewId);
  if (!review) return <p>This review request is unavailable.</p>;
  const taskId = task.task.id,
    result = task.results.find((r) => r.resultId === review.resultId),
    meta = task.review?.results.find((r) => r.resultId === review.resultId),
    status = reviewStatus(review),
    uncertainty = uncertaintyLines(review.uncertainties),
    text = draft.trim();
  const send = async (response: Respond["response"]) => {
    const command: Respond = pending ?? {
      type: "result-review.respond",
      key: randomUUID(),
      taskId,
      reviewId,
      expectedRevision: review.revision,
      response,
      ...(text ? { message: text } : {}),
    };
    setPending(command);
    setBusy(true);
    try {
      const result = await client.command(command, session.csrfToken);
      if (result.state === "recorded") {
        const receipt = result.receipt;
        setPending(null);
        setDraft("");
        setOutcome({
          kind: "recorded",
          message:
            command.response === "feedback"
              ? "Feedback sent to the lead."
              : command.message
                ? "Marked reviewed; your note was sent to the lead."
                : "Marked reviewed. Nothing was sent to the lead.",
          details: [
            ["Request key", command.key],
            ...(receipt.kind === "result-review"
              ? ([["Review revision", String(receipt.revision)]] as const)
              : []),
          ],
        });
        onChanged();
      } else if (result.state === "unknown") {
        setOutcome({
          kind: "unknown",
          message: "Retry to check whether the same response was recorded.",
        });
      } else {
        setPending(null);
        setOutcome({ kind: "refused" });
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  };
  const retrying = (response: Respond["response"]) =>
    pending?.response === response;
  return (
    <section
      className="result-review"
      aria-label="Result review"
      data-record-id={review.reviewId}
    >
      {status && (
        <p className="result-review-status" role="status">
          <strong>{status}</strong>
          {review.status === "superseded" && review.supersededByResultId && (
            <>
              {" "}
              <ActionLink
                variant="secondary"
                href={`/tasks/${taskId}?result=${review.supersededByResultId}`}
              >
                Open the newer result
              </ActionLink>
            </>
          )}
        </p>
      )}
      {showDecision && (
        <h3 className="small-heading">
          {review.decision ?? "Decision unavailable or redacted"}
        </h3>
      )}
      <div>
        <h4 className="small-heading">Lead's recommendation</h4>
        <p className="metadata muted">{reportedByLead}</p>
        <Literal text={review.recommendation} />
      </div>
      <div>
        <h4 className="small-heading">What changed and why</h4>
        <p className="metadata muted">{reportedByLead}</p>
        <Literal text={result?.summary} />
        <ActionLink
          variant="secondary"
          href={`/tasks/${taskId}?section=changes&result=${review.resultId}`}
        >
          {meta?.metadata.changes
            ? `Changes · ${meta.metadata.changes.files.length} ${meta.metadata.changes.files.length === 1 ? "file" : "files"}`
            : "Changes"}
        </ActionLink>
      </div>
      {meta && (
        <div>
          <p className="metadata muted">Criterion outcomes: {reportedByLead}</p>
          <CriteriaRows
            data={task}
            resultId={review.resultId}
            sourceId={meta.metadata.sourceId}
            more={{
              open: criteriaOpen,
              onToggle: (event) => setCriteriaOpen(event.currentTarget.open),
            }}
          />
        </div>
      )}
      <div>
        <h4 className="small-heading">Evidence</h4>
        <p className="metadata muted">
          {reportedByLead}; head comparisons are cab's
        </p>
        {missingEvidence(task, review.resultId) ?? (
          <ReviewEvidence
            data={task}
            resultId={review.resultId}
            sourceId={meta?.metadata.sourceId}
            headComparison={(head) =>
              resultHeadComparison(head, result?.workspace ?? [])
            }
          />
        )}
      </div>
      <div>
        <h4 className="small-heading">Remaining uncertainty</h4>
        {uncertainty.empty ? (
          <p>{uncertainty.empty}</p>
        ) : (
          <ul>
            {uncertainty.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lead's list may repeat an item.
              <li key={i}>{item}</li>
            ))}
          </ul>
        )}
      </div>
      <details className="result-review-details">
        <summary>Details</summary>
        <p className="metadata muted">{recordedByCab}</p>
        <p className="metadata">{resultIdentity(task, review.resultId)}</p>
        {resultWorkspaceLines(result?.workspace ?? []).map((line) => (
          <p key={line} className="metadata">
            {line}
          </p>
        ))}
      </details>
      {review.status === "pending" && !readOnly && (
        <fieldset className="result-review-response" disabled={busy}>
          <legend className="small-heading">Your response</legend>
          <label htmlFor={noteId}>Note or feedback for the lead</label>
          <Textarea
            id={noteId}
            aria-describedby={helpId}
            maxLength={16000}
            value={draft}
            disabled={Boolean(pending)}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p id={helpId} className="metadata muted">
            A note is optional when marking reviewed. Neither response approves,
            merges or completes the task.
          </p>
          <div className="result-review-actions">
            <Button
              variant="secondary"
              onClick={() => void send("reviewed")}
              disabled={Boolean(pending) && !retrying("reviewed")}
            >
              {retrying("reviewed") ? "Retry Mark reviewed" : "Mark reviewed"}
            </Button>
            <Button
              onClick={() => void send("feedback")}
              disabled={!text || (Boolean(pending) && !retrying("feedback"))}
            >
              {retrying("feedback") ? "Retry Send feedback" : "Send feedback"}
            </Button>
          </div>
        </fieldset>
      )}
      {review.status !== "pending" && text && !pending && (
        <div>
          <h4 className="small-heading">Your unsent draft</h4>
          <Literal text={draft} />
        </div>
      )}
      {outcome?.kind === "recorded" && (
        <ActionOutcome
          tone="success"
          message={outcome.message}
          details={outcome.details}
          focus
        />
      )}
      {outcome?.kind === "unknown" && (
        <ActionOutcome
          tone="warning"
          title="Reply unavailable."
          message={outcome.message}
          focus
        />
      )}
      {outcome?.kind === "refused" && (
        <ActionOutcome
          tone="error"
          focus
          {...(review.status === "pending"
            ? {
                title: "The response was not recorded.",
                message:
                  "The lead cannot receive a note or feedback now, or this view is out of date. Your draft is kept; Mark reviewed without a note records the review without sending anything.",
              }
            : {
                title: "This review is no longer current.",
                message:
                  "Nothing was recorded. Your draft is kept below; check the review's state before responding.",
              })}
        />
      )}
      <p className="metadata">
        <ActionLink
          variant="secondary"
          href={`/tasks/${taskId}?assignment=${review.requestingAssignmentId}`}
        >
          Open conversation
        </ActionLink>
      </p>
    </section>
  );
}
