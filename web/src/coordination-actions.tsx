import {
  operatorCommandSchema,
  textMaxLength,
  type Session,
  type TaskRead,
} from "../../src/operator/contracts.js";
import { useReducer } from "react";
import type { OperatorClient } from "./api.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import { useCommandSend, type SendOutcome } from "./command-send.js";
import { Button, ShortId } from "./components.js";
import { failureCause, type ReceiptDetails } from "./outcome-copy.js";
import { Textarea } from "./ui/textarea.js";

type Task = TaskRead["data"];

/** The one message a settled send leaves: recorded copy, or the shared unknown/conflict/failure wording. */
export function SendFeedback({
  outcome,
  recorded,
  conflict,
  unknown = "We couldn't confirm it was recorded. Check whether it saved; it is never recorded twice.",
  failed = (code) => `Not recorded: ${failureCause(code)}.`,
  details,
  check,
  review,
  focus = true,
}: {
  outcome: SendOutcome | null;
  recorded: string;
  conflict: string;
  unknown?: string;
  failed?: (code: string) => string;
  /** Receipt fields beyond the command and request key, shown in Details. */
  details?: ReceiptDetails;
  /** Resends the frozen command after an unknown outcome. */
  check: () => void;
  /** Clears a conflict once the reread shows current state. */
  review?: { label: string; onClick: () => void } | undefined;
  /** Whether the message takes focus when it appears; a message that replaces no control may not. */
  focus?: boolean;
}) {
  if (!outcome) return null;
  return (
    <ActionOutcome
      key={`${outcome.kind}:${outcome.command.key}`}
      tone={
        outcome.kind === "recorded"
          ? "success"
          : outcome.kind === "failed"
            ? "error"
            : "warning"
      }
      message={
        outcome.kind === "recorded"
          ? recorded
          : outcome.kind === "unknown"
            ? unknown
            : outcome.kind === "conflict"
              ? conflict
              : failed(outcome.code ?? "command-outcome-unknown")
      }
      focus={focus}
      action={
        outcome.kind === "unknown"
          ? { label: "Check whether it saved", onClick: check }
          : outcome.kind === "conflict"
            ? review
            : undefined
      }
      details={detailRows({
        command: outcome.command.type,
        ...details,
        requestKey: outcome.command.key,
        ...(outcome.code ? { code: outcome.code } : {}),
      })}
    />
  );
}

/**
 * A reviewable PR's handback, settled by the operator: Accept covers the shown head and policy
 * version only; Settle as closed sends the outcome back. Neither writes to GitHub.
 */
export function HandbackSettlement({
  client,
  session,
  task,
  onChanged,
}: {
  client: OperatorClient;
  session: Session;
  task: Task;
  /** Rereads the task after a recorded settlement or a conflict. */
  onChanged: () => void;
}) {
  const d = task.delivery,
    b = d?.binding;
  const { send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${task.task.id}:settlement`,
    (c, r) =>
      r.kind === "delivery-settlement" &&
      r.key === c.key &&
      r.taskId === task.task.id,
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  if (d?.mode !== "reviewable-pr" || !b || b.state === "MERGED") return null;
  // Current only while completion does not await a new one: head, task and policy versions all match.
  const current =
      b.settlement &&
      !d.blockers.includes("reviewable-pr-awaiting-current-settlement")
        ? b.settlement.decision
        : null,
    // The service's branch hold on the bound PR's own branch, not on any other task branch.
    outsidePush = d.blockers.includes("task-branch-outside-change"),
    settle = (decision: "accepted" | "closed") =>
      send(
        operatorCommandSchema.parse({
          type: "delivery.settle",
          key: crypto.randomUUID(),
          taskId: task.task.id,
          expectedTaskVersion: task.task.version,
          expectedDeliveryRevision: b.revision,
          expectedPolicyVersion: d.policyVersion,
          expectedHeadSha: b.headSha,
          decision,
        }),
      ),
    pending = (decision: string) =>
      sending?.type === "delivery.settle" && sending.decision === decision;
  return (
    <div
      className="handback-settlement"
      data-record-id={`settlement:${b.revision}`}
    >
      {current ? (
        <p role="status">
          {current === "accepted" ? (
            <>
              <strong>Handback accepted</strong> for head{" "}
              <ShortId value={b.headSha} />. Completion still needs its recorded
              workflow.
            </>
          ) : (
            <>
              <strong>Settled as closed.</strong> The outcome is sent back;
              nothing was accepted.
            </>
          )}
        </p>
      ) : (
        <>
          <p>
            <strong>Reviewable PR handed back.</strong> The task completes only
            after you settle head <ShortId value={b.headSha} />. Settling does
            not merge, close or comment on GitHub.
          </p>
          {b.readError ? (
            <p className="muted">
              The last GitHub read failed. Refresh delivery status before
              settling.
            </p>
          ) : (
            !uncertain && (
              <div className="question-actions">
                {b.state === "OPEN" && !b.draft && !outsidePush && (
                  <Button
                    disabled={Boolean(sending)}
                    onClick={() => void settle("accepted")}
                  >
                    {pending("accepted") ? "Sending…" : "Accept handback"}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={Boolean(sending)}
                  onClick={() => void settle("closed")}
                >
                  {pending("closed") ? "Sending…" : "Settle as closed"}
                </Button>
              </div>
            )
          )}
          <p className="metadata muted">
            Accept covers this head and policy version only. A new push needs a
            new settlement.
          </p>
        </>
      )}
      {/* A recorded settlement is the status line above, once the reread shows it. */}
      <SendFeedback
        outcome={outcome?.kind === "recorded" ? null : outcome}
        recorded="Handback settled."
        conflict="Not settled: the PR, branch or policy changed since it was read. Refresh delivery status and review the current head."
        check={() => void send()}
        review={{ label: "Review current state", onClick: clear }}
      />
    </div>
  );
}

/** A result with no recorded destination, delivered to the one recipient the service permits. */
export function ResultDestination({
  client,
  session,
  task,
  item,
  onConflict,
}: {
  client: OperatorClient;
  session: Session;
  task: Task;
  item: Task["unresolvedResults"][number];
  /** Rereads the task after a conflict. */
  onConflict: () => void;
}) {
  const recipient = item.permittedRecipient,
    result = task.results.find((r) => r.resultId === item.resultId),
    source = task.assignments.find((a) => a.assignmentId === item.assignmentId);
  const { send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${task.task.id}:result:${item.resultId}`,
    (c, r) =>
      c.type === "result.recipient" &&
      r.kind === "coordination" &&
      r.key === c.key &&
      r.taskId === task.task.id &&
      r.recipientAssignmentId === c.recipientAssignmentId,
    // A recorded delivery keeps its row and confirmation; the next poll removes the resolved row.
    (kind) => {
      if (kind === "conflict") onConflict();
    },
  );
  const name = recipient?.name ?? "the permitted recipient";
  return (
    <div className="decision" data-record-id={item.resultId}>
      <p className="small-heading">Your decision · result undelivered</p>
      <p>
        <strong>{result?.summary ?? "A result"}</strong> from{" "}
        {source?.name ?? "an assignment"} has no recorded destination.
      </p>
      {recipient && item.availability === "available" ? (
        outcome?.kind !== "recorded" &&
        !uncertain && (
          <Button
            variant="secondary"
            disabled={Boolean(sending)}
            onClick={() =>
              void send(
                operatorCommandSchema.parse({
                  type: "result.recipient",
                  key: crypto.randomUUID(),
                  taskId: task.task.id,
                  resultId: item.resultId,
                  expectedRevision: item.revision,
                  recipientAssignmentId: recipient.assignmentId,
                }),
              )
            }
          >
            {sending ? "Sending…" : `Deliver to ${name}`}
          </Button>
        )
      ) : (
        <p className="muted">
          No lead or requester on this task can receive it; the result stays
          undelivered.
        </p>
      )}
      <SendFeedback
        outcome={outcome}
        recorded={`Delivered to ${name}. It arrives on the next eligible turn.`}
        conflict="Not delivered: this result's destination changed since it was read."
        check={() => void send()}
        review={{ label: "Review current state", onClick: clear }}
      />
    </div>
  );
}

/** A durable message to one pending or running assignment, delivered on its next eligible turn. */
export function AssignmentMessage({
  client,
  session,
  taskId,
  assignment,
  onChanged,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  assignment: Task["assignments"][number];
  /** Rereads the task after a recorded message or a conflict. */
  onChanged: () => void;
}) {
  const [, draftEdited] = useReducer((n: number) => n + 1, 0);
  const { entry, send, sending, outcome, uncertain } = useCommandSend(
    client,
    session,
    `${taskId}:message:${assignment.assignmentId}`,
    (c, r) =>
      c.type === "message" &&
      r.kind === "coordination" &&
      r.key === c.key &&
      r.taskId === taskId &&
      r.recipientAssignmentId === c.recipientAssignmentId &&
      r.eventType === "operator-message",
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  const name = assignment.name ?? "this assignment",
    id = `assignment-message-${assignment.assignmentId}`;
  return (
    <form
      className="assignment-message"
      onSubmit={(e) => {
        e.preventDefault();
        if (!entry.text.trim()) return;
        void send(
          operatorCommandSchema.parse({
            type: "message",
            key: crypto.randomUUID(),
            taskId,
            recipientAssignmentId: assignment.assignmentId,
            expectedAssignmentVersion: assignment.version,
            message: entry.text,
          }),
        );
      }}
    >
      <label htmlFor={id} className="body">
        Message {name}
      </label>
      <Textarea
        id={id}
        autoGrow
        maxLength={textMaxLength}
        value={entry.text}
        disabled={Boolean(sending) || uncertain}
        onChange={(e) => {
          entry.edit(e.target.value);
          draftEdited();
        }}
      />
      <div className="assignment-message-bar">
        <p className="metadata muted">
          Delivered on {name}'s next eligible turn; pause and Stop still apply.
        </p>
        {!uncertain && (
          <Button
            type="submit"
            variant="secondary"
            disabled={Boolean(sending) || !entry.text.trim()}
          >
            {sending ? "Sending…" : `Send to ${name}`}
          </Button>
        )}
      </div>
      <SendFeedback
        outcome={outcome}
        recorded={`Sent to ${name}.`}
        conflict={`Not sent: ${name} changed since it was read. Your message is still here.`}
        check={() => void send()}
      />
    </form>
  );
}
