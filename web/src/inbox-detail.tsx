import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import {
  taskSchema,
  type InboxItem,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, Button } from "./components.js";
import { holdNotices } from "./inbox-presentation.js";
import { QuestionResponse } from "./question-response.js";
import { useOperatorResource } from "./resource.js";
import { Alert } from "./ui/alert.js";

/**
 * The task read behind an Inbox detail's independent holds. Each change of `observedAt` (the
 * Inbox's last successful read: a poll or Refresh) rereads it, unless a read is already pending.
 */
function useInboxTask(
  client: OperatorClient,
  session: Session,
  taskId: string,
  observedAt: number | null,
  scope: "approval" | "question",
) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        client.read(`/api/operator/tasks/${taskId}`, taskSchema, signal),
      [client, taskId],
    ),
    resource = useOperatorResource(
      `${session.csrfToken}:inbox-${scope}:${taskId}`,
      loader,
    ),
    current = useRef(resource),
    seen = useRef(observedAt);
  current.current = resource;
  useEffect(() => {
    if (seen.current === observedAt) return;
    seen.current = observedAt;
    // A slow hold read settles before the next poll replaces it.
    if (!current.current.state.pending) void current.current.refresh();
  }, [observedAt]);
  return resource;
}

/**
 * An Inbox question with the independent holds that answering does not clear. The read lives here,
 * above QuestionResponse, so the holds survive its switch to the recorded confirmation. The first
 * read still loading, or a failed read, shows no hold and never gates answering.
 */
export function InboxQuestion({
  observedAt,
  ...props
}: Omit<ComponentProps<typeof QuestionResponse>, "holds"> & {
  observedAt: number | null;
}) {
  const { state } = useInboxTask(
    props.client,
    props.session,
    props.taskId,
    observedAt,
    "question",
  );
  return (
    <QuestionResponse
      {...props}
      holds={
        state.data && !state.error ? holdNotices(state.data.data, "answer") : []
      }
    />
  );
}

/**
 * An approval in the Inbox: the exact action, target and revision, and the independent holds an
 * approval does not clear. Deciding stays at the exact retained destination, where the control lives.
 */
export function ApprovalDetail({
  client,
  session,
  item,
  observedAt,
}: {
  client: OperatorClient;
  session: Session;
  item: InboxItem;
  /** The Inbox's last successful read; each poll or Refresh rereads the holds. */
  observedAt: number | null;
}) {
  const resource = useInboxTask(
      client,
      session,
      item.taskId,
      observedAt,
      "approval",
    ),
    task = resource.state.data?.data,
    approval = task?.approvals.find(
      (a) => a.interactionId === (item.interactionId ?? item.id),
    ),
    holds = task ? holdNotices(task) : [],
    unavailable = Boolean(task && (!approval || approval.materialUnavailable));
  return (
    <div className="inbox-approval">
      <div className="inbox-approval-body">
        {approval && !unavailable ? (
          <dl className="inbox-approval-facts">
            <dt>Exact action</dt>
            <dd className="literal">{approval.action ?? "Unavailable"}</dd>
            <dt>Target</dt>
            <dd className="literal">{approval.target ?? "Unavailable"}</dd>
            <dt>Revision</dt>
            <dd>revision {approval.revision}</dd>
            <dt>Requester</dt>
            <dd>{item.requesterName ?? "Responsibility unknown"}</dd>
          </dl>
        ) : task ? (
          <p role="status">Exact approval unavailable</p>
        ) : null}
      </div>
      <div className="inbox-decision">
        {resource.state.error && (
          <Alert variant="destructive" role="alert">
            <p className="body">
              {task
                ? `Independent holds could not be refreshed; showing the last read from ${new Date(resource.state.fetchedAt ?? 0).toLocaleTimeString()}.`
                : "Independent holds could not be read; they remain in effect."}
            </p>
            <Button variant="secondary" onClick={resource.refresh}>
              Retry
            </Button>
          </Alert>
        )}
        {holds.map((hold) => (
          <Alert key={hold.id} role="status">
            <p className="body">
              <strong>{hold.title}</strong>
            </p>
            {hold.items.map((name) => (
              <p key={name} className="body">
                {name}
              </p>
            ))}
            <p className="body muted">{hold.detail}</p>
          </Alert>
        ))}
        <p className="metadata muted">
          Your decision is bound to the action, target and revisions in the
          exact approval. Changed material requires a new review.
        </p>
        <ActionLink href={item.destination}>
          Review material & decide
        </ActionLink>
      </div>
    </div>
  );
}

/** An intervention in the Inbox: the recorded reason and the way to inspect the execution. */
export function InterventionDetail({ item }: { item: InboxItem }) {
  return (
    <div className="inbox-approval">
      <div className="inbox-approval-body">
        <p>Review the exact recorded execution state before acting.</p>
      </div>
      <div className="inbox-decision">
        <ActionLink href={item.destination}>Inspect execution</ActionLink>
      </div>
    </div>
  );
}
