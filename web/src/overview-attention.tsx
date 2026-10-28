import { ArrowRight, CircleAlert } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import {
  questionReadSchema,
  type InboxItem,
  type RuntimeInboxItem,
  type TaskInboxItem,
  type Session,
  type TaskListSummary,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, ProjectName, ResourceStatus } from "./components.js";
import { ApprovalFacts, InboxQuestion, useInboxTask } from "./inbox-detail.js";
import { ageLabel, holdNotices } from "./inbox-presentation.js";
import { clockLabel } from "./presentation.js";
import {
  completedWork,
  furtherRequests,
  inlineAnswerable,
  interventionEvidence,
  orderAttention,
  overviewStats,
  projectRows,
} from "./overview-model.js";
import { QuestionHolds } from "./question-response.js";
import { StartAgainAction } from "./task-restart.js";
import type { QuestionResponseStates } from "./question-response-state.js";
import {
  inboxSummaryOf,
  requestActionLabel,
  requestHref,
  requestKindIcons,
} from "./request-presentation.js";
import { useOperatorResource } from "./resource.js";
import type { Requests } from "./task-attention.js";
import { taskDetailHref } from "./tasks.js";

/** What an Overview card needs to read a request and answer a question in place. */
export interface OverviewOperator {
  client: OperatorClient;
  session: Session;
  questions: QuestionResponseStates;
}

const shown = 3;
const dash = "—";

export function OverviewStats({
  tasks,
  requests,
}: {
  tasks: readonly TaskListSummary[] | undefined;
  requests: Requests;
}) {
  const s = overviewStats(tasks, requests);
  return (
    <dl className="overview-stats">
      <div data-tone="attn">
        <dt>Needs you</dt>
        <dd>{s.needsYou ?? dash}</dd>
      </div>
      <div data-tone="risk">
        <dt>Uncertain</dt>
        <dd>{s.uncertain ?? dash}</dd>
      </div>
      <div>
        <dt>Active tasks</dt>
        <dd>{s.active ?? dash}</dd>
      </div>
      <div>
        <dt>Running turns</dt>
        <dd>
          {s.running ? (
            <>
              {s.running.used}
              <span className="muted"> / {s.running.limit}</span>
            </>
          ) : (
            dash
          )}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Needs you: the first requests in Inbox order as cards, each with its evidence and one response.
 * A card answered here stays in place as its confirmation after the refreshed Inbox drops it.
 */
export function NeedsYou({
  requests,
  retry,
  tasks,
  operator,
}: {
  requests: Requests;
  retry: () => void;
  tasks: readonly TaskListSummary[] | undefined;
  operator: OverviewOperator | undefined;
}) {
  const [answered, setAnswered] = useState<
    { item: InboxItem; index: number }[]
  >([]);
  const data = requests.data,
    total = inboxSummaryOf(requests)?.count,
    ordered = data ? orderAttention(data.items, tasks) : [],
    cards = ordered.slice(0, shown);
  for (const kept of answered) {
    // A sent start keeps its card even while the request is still listed, moved or changed:
    // the card holds the check of a lost reply.
    const sent = kept.item.kind === "intervention";
    const live = sent ? cards.findIndex((i) => i.id === kept.item.id) : -1;
    if (live >= 0) cards.splice(live, 1);
    if (sent || !data?.items.some((i) => i.id === kept.item.id))
      cards.splice(Math.min(kept.index, cards.length), 0, kept.item);
  }
  // A kept card is already on screen, so the count leaves it out.
  const further = furtherRequests(
    ordered.filter((i) => !cards.some((c) => c.id === i.id)),
    0,
  );
  const byId = new Map(tasks?.map((t) => [t.id, t]));
  return (
    <section className="overview-needs" aria-label="Needs you">
      <div className="overview-needs-head">
        <h2 className="section-heading">Needs you</h2>
        <p className="metadata muted">
          Execution uncertainty first, then oldest
        </p>
        <a className="control work-link" href="/app/inbox">
          Open Inbox{total === undefined ? "" : ` · ${total}`}{" "}
          <ArrowRight aria-hidden="true" />
        </a>
      </div>
      {requests.status !== "fresh" && (
        <ResourceStatus state={requests} retry={retry} label="Requests" />
      )}
      {data && !data.complete && (
        <p role="alert" className="body">
          Queue coverage is incomplete. Unavailable requests may remain.
        </p>
      )}
      {cards.length > 0 && (
        <ul className="overview-cards">
          {cards.map((item, index) => (
            <RequestCard
              key={item.id}
              item={item}
              task={item.kind === "runtime" ? undefined : byId.get(item.taskId)}
              operator={operator}
              observedAt={requests.fetchedAt}
              onRecorded={() => {
                setAnswered((list) => [
                  ...list.filter((k) => k.item.id !== item.id),
                  { item, index },
                ]);
                retry();
              }}
            />
          ))}
        </ul>
      )}
      {further && (
        <a className="overview-overflow body" href="/app/inbox">
          <span>{further.count} more</span> · {further.names.join(", ")} · Inbox{" "}
          <ArrowRight aria-hidden="true" />
        </a>
      )}
      {data && !data.items.length && !answered.length && (
        <p className="body muted">
          {data.complete
            ? "Nothing needs your attention."
            : "No requests visible in available coverage."}
        </p>
      )}
    </section>
  );
}

/** A runtime whose restarts ran out: the one card with no task, linking to runtime settings. */
function RuntimeCard({ item }: { item: RuntimeInboxItem }) {
  const Icon = requestKindIcons.runtime,
    headline = `overview-${item.id}-headline`;
  return (
    <li
      className="overview-card"
      data-request-id={item.id}
      data-kind="runtime"
      data-tone="risk"
    >
      <div className="overview-card-top">
        <span className="overview-badge" data-tone="risk">
          <Icon aria-hidden="true" />
          Runtime
        </span>
        <span className="metadata muted identifier">
          {clockLabel(item.createdAt)} · {ageLabel(item.createdAt, Date.now())}
        </span>
      </div>
      <h3 className="small-heading" id={headline}>
        {item.headline}
      </h3>
      <p className="metadata muted">{item.reason}</p>
      <ActionLink
        variant="secondary"
        href={requestHref(item)}
        aria-describedby={headline}
        className="overview-respond"
      >
        {requestActionLabel(item)}
      </ActionLink>
    </li>
  );
}

function RequestCard({
  item,
  task,
  operator,
  observedAt,
  onRecorded,
}: {
  item: InboxItem;
  task: TaskListSummary | undefined;
  operator: OverviewOperator | undefined;
  observedAt: number | null;
  onRecorded: () => void;
}) {
  if (item.kind === "runtime") return <RuntimeCard item={item} />;
  const evidence = task && interventionEvidence(task),
    uncertain =
      item.kind === "intervention" && Boolean(evidence?.ownershipHeld),
    Icon = uncertain ? CircleAlert : requestKindIcons[item.kind],
    headline = `overview-${item.id}-headline`;
  const head = (title: string | null) => (
    <>
      <div className="overview-card-top">
        <span
          className="overview-badge"
          data-tone={item.kind === "intervention" ? "risk" : "attn"}
        >
          <Icon aria-hidden="true" />
          {uncertain
            ? "Execution uncertain"
            : item.kind === "question"
              ? "Question"
              : item.kind === "approval"
                ? "Approval"
                : "Intervention"}
        </span>
        {item.createdAt !== null && (
          <span className="metadata muted identifier">
            {clockLabel(item.createdAt)} ·{" "}
            {ageLabel(item.createdAt, Date.now())}
          </span>
        )}
      </div>
      <p className="metadata muted overview-card-place">
        {item.projectName ?? "Unavailable project"} /{" "}
        <span>{item.taskTitle ?? "Unavailable task"}</span>
      </p>
      <h3 className="small-heading" id={headline}>
        {title ?? item.reason ?? "Exact details unavailable"}
      </h3>
      {item.requesterName && (
        <p className="metadata muted">Requested by {item.requesterName}</p>
      )}
    </>
  );
  const respond = (
    <ActionLink
      variant="secondary"
      href={requestHref(item)}
      aria-describedby={headline}
      className="overview-respond"
    >
      {requestActionLabel(item)}
    </ActionLink>
  );
  return (
    <li
      className="overview-card"
      data-request-id={item.id}
      data-kind={item.kind}
      data-tone={item.kind === "intervention" ? "risk" : undefined}
    >
      {item.kind === "question" && operator ? (
        <QuestionCard
          item={item}
          operator={operator}
          observedAt={observedAt}
          onRecorded={onRecorded}
          head={head}
          respond={respond}
        />
      ) : item.kind === "approval" && operator ? (
        <ApprovalCard
          item={item}
          operator={operator}
          observedAt={observedAt}
          head={head}
          respond={respond}
        />
      ) : item.kind === "intervention" &&
        item.attentionCode === "not-started" &&
        operator ? (
        <StartAgainCard
          item={item}
          operator={operator}
          observedAt={observedAt}
          onRecorded={onRecorded}
          head={head}
          respond={respond}
        />
      ) : (
        <>
          {head(null)}
          {evidence && item.kind === "intervention" && (
            <div className="overview-evidence">
              <p className="metadata">{evidence.lead}</p>
              {evidence.reasons.map((r) => (
                <p key={r} className="metadata muted">
                  {r}
                </p>
              ))}
              {evidence.ownershipHeld && (
                <p className="metadata">
                  <strong>Ownership stays held</strong>
                </p>
              )}
            </div>
          )}
          {item.kind === "question" && item.evidence && (
            <a className="metadata" href={item.evidence}>
              Task evidence
            </a>
          )}
          {respond}
        </>
      )}
    </li>
  );
}

type CardParts = {
  item: TaskInboxItem;
  operator: OverviewOperator;
  observedAt: number | null;
  head: (title: string | null) => ReactNode;
  respond: ReactNode;
};

/**
 * A question answered in place when it is one pending single-choice question; any other form, a
 * failed read or a non-pending request links to the Inbox. Answering mounts the Inbox's own
 * InboxQuestion, so the command, validation, outcomes and draft are the Inbox's.
 */
function QuestionCard({
  item,
  operator: { client, session, questions },
  observedAt,
  onRecorded,
  head,
  respond,
}: CardParts & { onRecorded: () => void }) {
  const interactionId = item.interactionId ?? item.id;
  // shortcut: QuestionResponse repeats this GET once when mounted; pass it a preloaded read if it matters.
  const loader = useCallback(
      (signal: AbortSignal) =>
        client.read(
          `/api/operator/tasks/${item.taskId}/questions/${interactionId}`,
          questionReadSchema,
          signal,
        ),
      [client, item.taskId, interactionId],
    ),
    gate = useOperatorResource(
      `${session.csrfToken}:overview-question:${item.taskId}:${interactionId}`,
      loader,
    ).state,
    read = gate.data?.data;
  if (!read && !gate.error)
    return (
      <>
        {head(null)}
        <p className="metadata muted" role="status">
          Loading question…
        </p>
      </>
    );
  if (!read || !inlineAnswerable(read))
    return (
      <>
        {head(
          read?.source === "plain"
            ? null
            : (read?.form?.questions[0]?.label ?? null),
        )}
        {item.evidence && (
          <a className="metadata" href={item.evidence}>
            Task evidence
          </a>
        )}
        {respond}
      </>
    );
  return (
    <>
      {head(read.form?.questions[0]?.label ?? null)}
      <InboxQuestion
        client={client}
        session={session}
        taskId={item.taskId}
        interactionId={interactionId}
        states={questions}
        requesterName={item.requesterName}
        compactContext
        observedAt={observedAt}
        onRecorded={onRecorded}
      />
    </>
  );
}

/** A request refused before it ran: Start again in place once its task has been read. */
function StartAgainCard({
  item,
  operator: { client, session },
  observedAt,
  onRecorded,
  head,
  respond,
}: CardParts & { onRecorded: () => void }) {
  const resource = useInboxTask(
      client,
      session,
      item.taskId,
      observedAt,
      "request",
    ),
    task = resource.state.data?.data;
  return (
    <>
      {head(null)}
      {task ? (
        <StartAgainAction
          client={client}
          session={session}
          task={task}
          // Kept in place from the send on, as for an answered question, so a lost reply stays checkable.
          onStart={onRecorded}
          onChanged={() => {
            void resource.refresh();
            onRecorded();
          }}
        />
      ) : (
        respond
      )}
    </>
  );
}

/** An approval's exact facts and independent holds; deciding stays at the exact destination. */
function ApprovalCard({
  item,
  operator: { client, session },
  observedAt,
  head,
  respond,
}: CardParts) {
  const { state } = useInboxTask(
      client,
      session,
      item.taskId,
      observedAt,
      "approval",
    ),
    task = state.data?.data,
    approval = task?.approvals.find(
      (a) => a.interactionId === (item.interactionId ?? item.id),
    );
  return (
    <>
      {head(approval && !approval.materialUnavailable ? approval.action : null)}
      {state.error && !task && (
        <p role="alert" className="metadata">
          Independent holds could not be read; they remain in effect.
        </p>
      )}
      {task && (
        <div className="overview-evidence">
          <ApprovalFacts task={task} item={item} />
          <QuestionHolds
            holds={holdNotices(task, "approve", item.interactionId ?? item.id)}
          />
        </div>
      )}
      {respond}
    </>
  );
}

/** Each project's lead, active work and imported tasks; no requests and no sync time. */
export function ProjectsPanel({
  workspace,
  tasks,
}: {
  workspace: Workspace | null;
  tasks: readonly TaskListSummary[] | undefined;
}) {
  const rows = projectRows(workspace?.data, tasks);
  if (!rows.length) return null;
  return (
    <section className="overview-side-panel" aria-label="Projects">
      <h2 className="small-heading">Projects</h2>
      <ul className="overview-projects">
        {rows.map((row, index) => (
          <li key={row.id}>
            <a href={`/app/projects/${row.id}`} className="overview-project">
              <span
                className="overview-dot"
                data-slot={index % 3}
                aria-hidden="true"
              />
              <span className="body overview-project-name">
                <ProjectName label={row.label} id={row.id} />
              </span>
              <span className="metadata muted">
                {row.lead ? `Lead · ${row.lead}` : "No lead configured"}
              </span>
              <span className="metadata">
                {[
                  ...(row.paused ? ["Project paused"] : []),
                  ...(row.activity.length ? row.activity : ["No active tasks"]),
                ].join(" · ")}
              </span>
              <span className="metadata muted">
                {row.imported
                  ? `${row.imported} from GitHub`
                  : "No imported tasks"}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Done work stays out of Active tasks; this panel is the way back to it, separate from requests. */
export function CompletedPanel({
  tasks,
  project,
}: {
  tasks: readonly TaskListSummary[];
  project: string;
}) {
  const done = completedWork(tasks, project);
  if (!done.count) return null;
  return (
    <section className="overview-side-panel" aria-label="Completed work">
      <h2 className="small-heading">Completed work</h2>
      <p className="body">
        {done.count} completed task{done.count === 1 ? "" : "s"} · no decision
        needed
      </p>
      <ul className="overview-completed">
        {done.tasks.map((t) => (
          <li key={t.id}>
            <a className="body" href={taskDetailHref(t)}>
              {t.title ?? "Title unavailable"}
            </a>
          </li>
        ))}
      </ul>
      <a
        className="control work-link"
        href={`/app/tasks?state=Done&ready=any${project ? `&project=${project}` : ""}`}
      >
        View completed <ArrowRight aria-hidden="true" />
      </a>
    </section>
  );
}
