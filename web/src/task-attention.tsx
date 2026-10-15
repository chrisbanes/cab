import { ArrowRight, TriangleAlert } from "lucide-react";
import type { TaskListSummary } from "../../src/operator/contracts.js";
import { ActionLink } from "./components.js";
import type { loadInbox } from "./inbox.js";
import {
  inboxSummaryOf,
  interventionRequester,
} from "./request-presentation.js";
import type { ResourceState } from "./resource.js";
import { attentionCandidate, isUncertain, taskDetailHref } from "./tasks.js";

export type InboxRead = Awaited<ReturnType<typeof loadInbox>>;
export type Requests = ResourceState<InboxRead>;
/** Persistent summary above List and Board: the one task that most needs a look, plus the Inbox. */
export function AttentionBar({
  tasks,
  requests,
}: {
  tasks: readonly TaskListSummary[];
  requests: Requests;
}) {
  const task = attentionCandidate(tasks);
  if (!task) return null;
  const uncertain = isUncertain(task),
    // The same requester the Overview and the Inbox name; never the task lead.
    requester = interventionRequester(requests.data?.items ?? [], task.id),
    title = task.title ?? "Title unavailable",
    count = inboxSummaryOf(requests)?.count;
  return (
    <section className="work-bar" aria-label="Attention summary">
      <TriangleAlert aria-hidden="true" className="work-bar-icon" />
      <div className="work-bar-text">
        <p className="body">
          {uncertain ? "Inspect execution" : "Stopping"} · {title}
        </p>
        <p className="metadata muted">
          {uncertain
            ? `${requester ?? "Responsibility unknown"} · execution may still be active; ownership stays held.`
            : "Next: runtime · confirm execution ended. No operator request recorded."}
        </p>
      </div>
      <ActionLink variant="secondary" href={taskDetailHref(task)}>
        {uncertain ? "Inspect execution" : "Open task"}
      </ActionLink>
      <a className="control work-link" href="/app/inbox">
        Inbox{count === undefined ? "" : ` · ${count}`}{" "}
        <ArrowRight aria-hidden="true" />
      </a>
    </section>
  );
}
