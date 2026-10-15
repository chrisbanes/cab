import { ArrowUpRight } from "lucide-react";
import type { InboxItem } from "../../src/operator/contracts.js";
import { ResourceStatus } from "./components.js";
import type { useInboxTask } from "./inbox-detail.js";
import {
  assignmentChain,
  holdNotices,
  taskContext,
} from "./inbox-presentation.js";
import { requestTime } from "./request-presentation.js";

/**
 * The selected request's task context: task, lead, requester, assignment chain, holds and
 * evidence. Built from the Inbox's one task read; before it lands, or when it fails, the request's
 * own facts and evidence links still show.
 */
export function InboxContext({
  item,
  task: resource,
  open,
}: {
  item: InboxItem;
  task: ReturnType<typeof useInboxTask>;
  /** Still unresolved in the current queue; a recorded or resolved request has no next action. */
  open: boolean;
}) {
  const task = resource.state.data?.data,
    context = taskContext(task, item, open),
    chain = task ? assignmentChain(task, item.requestingAssignmentId) : [],
    holds = task
      ? holdNotices(
          task,
          item.kind === "question" ? "answer" : "approve",
          item.kind === "approval" ? (item.interactionId ?? item.id) : null,
        )
      : [];
  return (
    <aside className="inbox-context" aria-label="Task context">
      <section>
        <h2>Task</h2>
        <a className="inbox-context-task" href={`/app/tasks/${item.taskId}`}>
          {item.taskTitle ?? "Unavailable task"}{" "}
          <ArrowUpRight aria-hidden="true" size={12} />
        </a>
        <p className="muted">
          {[item.projectName ?? "Unavailable project", context.source]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {context.next && <p className="inbox-context-next">{context.next}</p>}
      </section>
      {resource.state.error && (
        <ResourceStatus
          state={resource.state}
          retry={resource.refresh}
          label="Task details"
        />
      )}
      <dl>
        <dt>Lead</dt>
        <dd>{context.lead}</dd>
        <dt>Requester</dt>
        <dd>{item.requesterName ?? "Responsibility unknown"}</dd>
        {chain.length > 0 && (
          <>
            <dt>Chain</dt>
            <dd className="inbox-context-chain">{chain.join(" → ")}</dd>
          </>
        )}
      </dl>
      {holds.length > 0 && (
        <section>
          <h3>Holds · {holds.length}</h3>
          {holds.map((hold) => (
            <p key={hold.id} className="inbox-context-hold">
              {hold.title}
              {hold.items.length > 0 && <span>{hold.items.join(", ")}</span>}
            </p>
          ))}
        </section>
      )}
      <section className="inbox-context-evidence">
        <h3>Evidence</h3>
        <a href={item.evidence}>Task evidence</a>
        {item.conversation && (
          <a href={item.conversation}>Requesting conversation</a>
        )}
        <p className="muted">
          Reported by {item.requesterName ?? "Responsibility unknown"} ·{" "}
          {requestTime(item.createdAt)}
        </p>
      </section>
    </aside>
  );
}
