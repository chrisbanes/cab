import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import {
  taskSchema,
  type InboxItem,
  type Session,
  type TaskRead,
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
export function useInboxTask(
  client: OperatorClient,
  session: Session,
  taskId: string | null,
  observedAt: number | null,
  scope: "approval" | "question" | "request",
) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        client.read(`/api/operator/tasks/${taskId}`, taskSchema, signal),
      [client, taskId],
    ),
    resource = useOperatorResource(
      taskId ? `${session.csrfToken}:inbox-${scope}:${taskId}` : null,
      loader,
    ),
    current = useRef(resource),
    seen = useRef(observedAt);
  current.current = resource;
  useEffect(() => {
    if (seen.current === observedAt) return;
    seen.current = observedAt;
    if (!taskId) return;
    // A slow hold read settles before the next poll replaces it; poll skips while one is in flight.
    void current.current.poll();
  }, [observedAt, taskId]);
  return resource;
}

type TaskResource = ReturnType<typeof useInboxTask>;

/** The holds answering does not clear; a read still loading or failed shows none and never gates answering. */
export const answerHolds = (state: TaskResource["state"]) =>
  state.data && !state.error ? holdNotices(state.data.data, "answer") : [];

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
  return <QuestionResponse {...props} holds={answerHolds(state)} />;
}

/** The exact action, target, revision and requester of an approval, or that it is unavailable. */
export function ApprovalFacts({
  task,
  item,
}: {
  task: TaskRead["data"];
  item: InboxItem;
}) {
  const approval = task.approvals.find(
    (a) => a.interactionId === (item.interactionId ?? item.id),
  );
  return approval && !approval.materialUnavailable ? (
    <dl className="inbox-approval-facts">
      <dt>Exact action</dt>
      <dd className="literal">{approval.action ?? "Unavailable"}</dd>
      <dt>Target</dt>
      <dd className="literal">{approval.target ?? "Unavailable"}</dd>
      <dt>Version</dt>
      <dd>version {approval.revision}</dd>
      <dt>Requester</dt>
      <dd>{item.requesterName ?? "Responsibility unknown"}</dd>
    </dl>
  ) : (
    <p role="status">Exact approval unavailable</p>
  );
}

/**
 * An approval in the Inbox: the exact action, target and revision, and the independent holds an
 * approval does not clear. Deciding stays at the exact retained destination, where the control lives.
 */
export function ApprovalDetail({
  item,
  resource,
}: {
  item: InboxItem;
  /** The Inbox's one read of this task; each poll or Refresh rereads the holds. */
  resource: TaskResource;
}) {
  const task = resource.state.data?.data,
    // Only this approval is not a hold on itself; other open approvals on the task still are.
    holds = task
      ? holdNotices(task, "approve", item.interactionId ?? item.id)
      : [];
  return (
    <div className="inbox-approval">
      <div className="inbox-approval-body">
        {task && <ApprovalFacts task={task} item={item} />}
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
      </div>
      <div className="inbox-decision">
        <p>
          Your decision is bound to the action, target and version in the exact
          approval. Changed material requires a new review.
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
        <p>Review the exact execution state before acting.</p>
      </div>
      <div className="inbox-decision">
        <ActionLink href={item.destination}>Inspect execution</ActionLink>
      </div>
    </div>
  );
}
