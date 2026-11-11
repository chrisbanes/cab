import { Textarea } from "./ui/textarea.js";
import type { OperatorCommand } from "../../src/operator/contracts.js";
import { NativeSelect } from "./ui/native-select.js";
import { Card } from "./ui/card.js";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  inboxReadSchema,
  type InboxItem,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import type { OperatorClient } from "./api.js";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ActionLink, Button, ResourceStatus } from "./components.js";
import { Badge } from "./ui/badge.js";
import { useMediaQuery } from "./use-media-query.js";
import {
  ageLabel,
  filterCounts,
  type QueueAnchor,
  queueGroups,
  queueSteps,
  requestActionLabel,
  requestHeading,
  requestIdentity,
  requestKindLabel,
} from "./inbox-presentation.js";
import { clockLabel } from "./presentation.js";
import { inboxSummaryOf, requestKindIcons } from "./request-presentation.js";
import { useOperatorResource } from "./resource.js";
import {
  answerHolds,
  ApprovalDetail,
  InterventionDetail,
  RuntimeDetail,
  useInboxTask,
} from "./inbox-detail.js";
import { InboxContext } from "./inbox-context.js";
import { inboxSelectionHref } from "../../src/operator/attention.js";
import { closeResolvedNotifications } from "./notifications.js";
import { shortcutApplies } from "./focus-mode.js";
import { QuestionResponse } from "./question-response.js";
import type { QuestionResponseStates } from "./question-response-state.js";
import "./inbox.css";
export class InboxState {
  project = "";
  kind = "";
  scrollTop = 0;
  selected: InboxItem | null = null;
  /** The request a wide layout opened by itself; not navigation, so no history entry. */
  auto: InboxItem | null = null;
  /** Where the phone detail came from, so Back can focus it without selecting anything. */
  returnFocus: { id: string; index: number } | null = null;
  /** Where the selection last stood in the queue, so Previous/Next continue after it leaves. */
  anchor: QueueAnchor | null = null;
  clear() {
    this.project = "";
    this.kind = "";
    this.scrollTop = 0;
    this.selected = null;
    this.auto = null;
    this.returnFocus = null;
    this.anchor = null;
  }
}
/** What the Inbox asks the shell header to show; the shell only merges it into its props. */
export interface InboxHeader {
  subtitle?: string;
  /** Single-column layout with a request open: a Back link, the request title and one action. */
  detail?: {
    title: string;
    subtitle?: string;
    back: { href: string; label: string };
    /** Absent for a request with no task to open. */
    action?: ReactNode;
  };
}
export async function loadInbox(
  client: OperatorClient,
  signal: AbortSignal,
  status = "actionable",
) {
  // A notification that arrives while this read is in flight is newer than what it saw.
  const startedAt = Date.now();
  const items: InboxItem[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page: import("zod").infer<typeof inboxReadSchema> = await client.read(
      `/api/operator/inbox${status === "actionable" && !cursor ? "" : `?${new URLSearchParams({ ...(status === "actionable" ? {} : { status }), ...(cursor ? { cursor } : {}) })}`}`,
      inboxReadSchema,
      signal,
    );
    items.push(...page.data.items);
    if (!page.data.nextCursor) {
      // Both callers (the shell's summary and this route) pass through here, so a notification
      // whose request is no longer waiting closes after whichever read happens.
      if (status === "actionable")
        void closeResolvedNotifications(items, page.data.complete, startedAt);
      return {
        items,
        complete: page.data.complete,
        unavailable: page.data.unavailable,
        observedAt: page.observedAt,
      };
    }
    if (seen.has(page.data.nextCursor)) throw Error("unavailable");
    seen.add(page.data.nextCursor);
    cursor = page.data.nextCursor;
  }
}
export function Inbox({
  client,
  session,
  path,
  navigate,
  state,
  questions,
  observation,
  onSummary,
  onHeader,
  chrome,
  queueRefresh,
}: {
  client: OperatorClient;
  session: Session;
  path: string;
  navigate: (path: string) => void;
  state: InboxState;
  questions: QuestionResponseStates;
  /** The workspace read: its change refreshes the list and its projects name the filter. */
  observation: Workspace | null;
  /** Reports the unresolved total and project count (or null) so the shell matches this list. */
  onSummary?: (summary: ReturnType<typeof inboxSummaryOf>) => void;
  /** Reports the header content for this view (null on unmount). */
  onHeader?: (header: InboxHeader | null) => void;
  /** At the sidebar shell the queue header owns the page heading, summary and Refresh. */
  chrome?: { onRefresh: () => void; refreshing: boolean } | undefined;
  /** On a phone the header has no Refresh, so the filter row ends with it. */
  queueRefresh?: { onRefresh: () => void; refreshing: boolean } | undefined;
}) {
  const requestedStatus =
    new URLSearchParams(path.split("?")[1] ?? "").get("status") ?? "actionable";
  const status = ["actionable", "resolved", "dismissed"].includes(
    requestedStatus,
  )
    ? requestedStatus
    : "actionable";
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const actionable = await loadInbox(client, signal);
      const view =
        status === "actionable"
          ? actionable
          : await loadInbox(client, signal, status);
      return { ...view, actionable, viewStatus: status };
    },
    [client, status],
  );
  const resource = useOperatorResource(
      `${session.csrfToken}:action-inbox:${status}`,
      loader,
    ),
    poll = useRef(resource.poll);
  poll.current = resource.poll;
  useEffect(() => {
    const timer = setInterval(() => poll.current(), 15000);
    return () => clearInterval(timer);
  }, []);
  const actionableSummary = inboxSummaryOf({
    data: resource.state.data?.actionable ?? null,
    error: resource.state.error,
  });
  const count = actionableSummary?.count,
    projectCount = actionableSummary?.projects;
  useEffect(() => {
    onSummary?.(
      count === undefined || projectCount === undefined
        ? null
        : { count, projects: projectCount },
    );
    return () => onSummary?.(null);
  }, [count, projectCount, onSummary]);
  const seen = useRef(observation);
  useEffect(() => {
    if (seen.current !== observation) {
      seen.current = observation;
      if (observation) poll.current();
    }
  }, [observation]);
  const [startSentFor, setStartSentFor] = useState<string | null>(null);
  const [, render] = useState(0),
    queue = useRef<HTMLDivElement>(null),
    single = useMediaQuery("(max-width: 760px)"),
    // The task-context inspector has room from 1280px.
    inspector = useMediaQuery("(min-width: 1280px)") && !single;
  const params = new URLSearchParams(path.split("?")[1] ?? ""),
    urlId = params.get("request"),
    urlTask = params.get("task"),
    // A wide layout without a request in the URL shows the last chosen one, else the one it opened itself.
    implicit = !urlId && !single ? (state.selected ?? state.auto) : null,
    selectedId = urlId ?? implicit?.id ?? null,
    // A runtime item belongs to no task: its id alone selects it.
    runtimeId = Boolean(selectedId?.startsWith("runtime:")),
    taskId =
      urlTask ??
      (implicit?.kind === "runtime" ? null : implicit?.taskId) ??
      null;
  const sameRequest = (item: InboxItem) =>
    item.id === selectedId &&
    (item.kind === "runtime" || item.taskId === taskId);
  const items = resource.state.data?.items ?? [],
    current = items.find(sameRequest);
  if (current && urlId) state.selected = current;
  const selected = selectedId
    ? (current ??
      (urlId
        ? state.selected && sameRequest(state.selected)
          ? state.selected
          : null
        : implicit))
    : null;
  // The queue's display order (grouped) is the one order for position, Previous/Next and focus.
  const rows = queueGroups(
    items.filter(
      (item) =>
        (!state.project ||
          (item.kind !== "runtime" && item.projectId === state.project)) &&
        (!state.kind || item.kind === state.kind),
    ),
  ).flatMap((group) => group.items);
  // A sent start is kept only for the selection it was sent from; another selection drops the
  // pane (and its command), so the flag must not describe a later one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears exactly when the selection changes.
  useEffect(() => setStartSentFor(null), [selectedId]);
  // One read of the selected request's task serves its holds, approval facts and the inspector.
  const task = useInboxTask(
    client,
    session,
    // An intervention below the inspector width shows nothing from the task read, except the
    // Start again it offers in place.
    selectedId &&
      taskId &&
      !runtimeId &&
      (inspector ||
        selected?.kind !== "intervention" ||
        selected.attentionCode === "not-started" ||
        startSentFor === taskId)
      ? taskId
      : null,
    resource.state.fetchedAt,
    "request",
  );
  // Open the first request once per chosen status when its first fresh read arrives on a wide layout.
  // Keyed by status so a stale effect for the outgoing status cannot use up the next one's auto-open.
  const autoFor = useRef<string | null>(status);
  useEffect(() => {
    if (
      autoFor.current !== status ||
      resource.state.status !== "fresh" ||
      resource.state.data?.viewStatus !== status
    )
      return;
    autoFor.current = null;
    const first = rows[0];
    if (!single && !urlId && !state.selected && !state.auto && first) {
      state.auto = first;
      render((v) => v + 1);
    }
  });
  // Keep the queue's own scroll across detail visits (a hidden queue forgets its offset), and
  // again once a remount's first read has rows to scroll.
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    if (queue.current && hasRows && !(single && urlId))
      queue.current.scrollTop = state.scrollTop;
  }, [state, single, urlId, hasRows]);
  // Returning from the phone detail focuses the opened row, or the row now at its place.
  useLayoutEffect(() => {
    if (!single || urlId || !state.returnFocus || !queue.current) return;
    const { id, index } = state.returnFocus,
      list = [...queue.current.querySelectorAll<HTMLElement>(".inbox-row")],
      row =
        list.find((el) => el.dataset.recordId === id) ??
        list[Math.min(index, list.length - 1)];
    if (row || resource.state.status === "fresh") state.returnFocus = null;
    row?.focus({ preventScroll: true });
  }, [single, urlId, state, resource.state.status]);
  const position = selected ? rows.findIndex((r) => r.id === selected.id) : -1;
  if (selected && position >= 0)
    state.anchor = {
      id: selected.id,
      index: position,
      previousId: rows[position - 1]?.id,
      nextId: rows[position + 1]?.id,
    };
  const anchored = Boolean(selected && state.anchor?.id === selected.id),
    heading = selected
      ? `${requestKindLabel(selected.kind)}${position >= 0 ? ` · ${position + 1} of ${rows.length}` : ""}`
      : null,
    // Only a complete read shows a request has left: an incomplete one may simply omit it.
    leftQueue = Boolean(
      selected &&
        !current &&
        resource.state.status === "fresh" &&
        resource.state.data?.complete,
    ),
    recorded = Boolean(
      selected &&
        selected.kind !== "runtime" &&
        questions.recordedHere(selected.taskId, selected.id),
    );
  const subtitle =
    status !== "actionable"
      ? `${resource.state.data?.items.length ?? 0} ${status} · ${count ?? "—"} actionable`
      : count === undefined || projectCount === undefined
        ? undefined
        : leftQueue && recorded
          ? `${count} unresolved · confirmation retained`
          : count === 0
            ? "0 unresolved across your projects"
            : projectCount === 0
              ? `${count} unresolved`
              : `${count} unresolved across ${projectCount} project${projectCount === 1 ? "" : "s"}`;
  const detailTitle = single && selected ? heading : null,
    detailSubtitle =
      (selected?.kind === "runtime" ? null : selected?.projectName) ??
      undefined,
    detailTask = selected?.kind === "runtime" ? undefined : selected?.taskId,
    detailRuntime = selected?.kind === "runtime";
  useEffect(() => {
    onHeader?.(
      detailTitle && (detailTask || detailRuntime)
        ? {
            ...(subtitle ? { subtitle } : {}),
            detail: {
              title: detailTitle,
              ...(detailSubtitle ? { subtitle: detailSubtitle } : {}),
              back: { href: "/inbox", label: "Inbox" },
              ...(detailTask
                ? {
                    action: (
                      <ActionLink
                        variant="secondary"
                        href={`/tasks/${detailTask}`}
                      >
                        Open task
                      </ActionLink>
                    ),
                  }
                : {}),
            },
          }
        : subtitle
          ? { subtitle }
          : null,
    );
  }, [
    onHeader,
    detailTitle,
    detailSubtitle,
    detailTask,
    detailRuntime,
    subtitle,
  ]);
  useEffect(() => () => onHeader?.(null), [onHeader]);
  const labels = workspaceLabels(observation);
  const loaded = items,
    counts = filterCounts(loaded),
    projects = [
      ...new Map(
        loaded.flatMap((item) =>
          item.kind === "runtime"
            ? []
            : [[item.projectId, item.projectName] as const],
        ),
      ),
    ],
    filtered = Boolean(state.project || state.kind),
    complete = Boolean(resource.state.data?.complete),
    empty = complete && !loaded.length;
  const now = Date.now();
  const choose = (item: InboxItem) => {
    state.selected = item;
    state.returnFocus = {
      id: item.id,
      index: Math.max(
        0,
        rows.findIndex((r) => r.id === item.id),
      ),
    };
    navigate(
      inboxSelectionHref(item) +
        (status === "actionable" ? "" : `&status=${status}`),
    );
  };
  /** After a recorded answer: leave the confirmation without opening another request. */
  const back = () => {
    state.selected = null;
    state.auto = null;
    navigate("/inbox");
  };
  const clear = () => {
    state.project = "";
    state.kind = "";
    render((v) => v + 1);
  };
  const row = (item: InboxItem) => {
    const Icon = requestKindIcons[item.kind],
      heading = requestHeading(item);
    return (
      <button
        type="button"
        className="inbox-row"
        key={item.id}
        data-record-id={item.id}
        data-kind={item.kind}
        aria-pressed={selectedId === item.id}
        onClick={() => choose(item)}
      >
        <span className="inbox-row-label">
          <Icon aria-hidden="true" />
          {requestKindLabel(item.kind)}
        </span>
        <strong title={heading.title ?? undefined}>
          {heading.title ?? "Unavailable task"}
        </strong>
        {heading.subtitle && (
          <span className="inbox-row-subtitle">{heading.subtitle}</span>
        )}
        {heading.reason && (
          <span className="inbox-row-reason">{heading.reason}</span>
        )}
        <span className="inbox-row-action">{requestActionLabel(item)} →</span>
        {((item.kind !== "runtime" && item.requesterName) ||
          item.createdAt !== null) && (
          <span className="inbox-row-meta">
            {item.kind !== "runtime" && item.requesterName}
            {item.kind !== "runtime" &&
              item.requesterName &&
              item.createdAt !== null &&
              " · "}
            {item.createdAt !== null && (
              <time dateTime={new Date(item.createdAt).toISOString()}>
                {clockLabel(item.createdAt)} · {ageLabel(item.createdAt, now)}
              </time>
            )}
          </span>
        )}
      </button>
    );
  };
  const isQuestion =
      selected?.kind === "question" ||
      (!selected && !selectedId?.startsWith("intervention:") && !runtimeId),
    selectedHeading = selected ? requestHeading(selected) : null,
    KindIcon = selected ? requestKindIcons[selected.kind] : null,
    { previous, next } = queueSteps(rows, selected?.id ?? null, state.anchor),
    continuation = next ?? previous,
    continuationHeading = continuation ? requestHeading(continuation) : null;
  // J and K step like the wide layout's Previous/Next; the moved-to request's heading takes focus.
  const steps = useRef({ previous, next, choose });
  steps.current = { previous, next, choose };
  const focusHeading = useRef(false),
    detailHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (single) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null,
        { previous, next, choose } = steps.current;
      // A menu, such as the sidebar's account menu, keeps its own letters.
      if (target?.closest('[role="menu"], [role="menubar"], [role="listbox"]'))
        return;
      const item = shortcutApplies("j", event, target)
        ? next
        : shortcutApplies("k", event, target)
          ? previous
          : undefined;
      if (!item) return;
      event.preventDefault();
      focusHeading.current = true;
      choose(item);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [single]);
  useEffect(() => {
    if (!focusHeading.current || !detailHeading.current) return;
    focusHeading.current = false;
    detailHeading.current.focus();
    [...(queue.current?.querySelectorAll<HTMLElement>(".inbox-row") ?? [])]
      .find((el) => el.dataset.recordId === selectedId)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);
  const meta = selected && selected.kind !== "runtime" && (
    <div className="inbox-detail-meta">
      {requestIdentity(selected) && (
        <p className="inbox-identity">{requestIdentity(selected)}</p>
      )}
      {!inspector && (selected.evidence || selected.conversation) && (
        <div className="inbox-detail-links">
          {selected.evidence && (
            <ActionLink variant="secondary" href={selected.evidence}>
              Task evidence
            </ActionLink>
          )}
          {selected.conversation && (
            <ActionLink variant="secondary" href={selected.conversation}>
              Requesting conversation
            </ActionLink>
          )}
        </div>
      )}
    </div>
  );
  return (
    <section
      className={`action-inbox ${selectedId ? "inbox-selected" : ""} ${empty && !selectedId ? "inbox-empty" : ""}`}
      aria-label="Action Inbox"
    >
      <div className="inbox-queue">
        <div className="inbox-queue-head">
          {chrome && (
            <div className="inbox-title">
              <h1 className="inbox-heading">Inbox</h1>
              {subtitle && <p className="inbox-summary">{subtitle}</p>}
              <Button
                variant="secondary"
                onClick={chrome.onRefresh}
                disabled={chrome.refreshing}
              >
                Refresh
              </Button>
            </div>
          )}
          <div className="inbox-filters">
            <NativeSelect
              aria-label="Inbox status"
              value={status}
              onChange={(e) => {
                state.clear();
                autoFor.current = e.target.value;
                navigate(
                  `/inbox${e.target.value === "actionable" ? "" : `?status=${e.target.value}`}`,
                );
              }}
            >
              <option value="actionable">Actionable</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
            </NativeSelect>
            <NativeSelect
              aria-label="Project"
              value={state.project}
              onChange={(e) => {
                state.project = e.target.value;
                render((v) => v + 1);
              }}
            >
              <option value="">All projects · {counts.total}</option>
              {projects.map(([id, name]) => (
                <option key={id} value={id}>
                  {projectLabel(labels, id, name).text} ·{" "}
                  {counts.project[id] ?? 0}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Request kind"
              value={state.kind}
              onChange={(e) => {
                state.kind = e.target.value;
                render((v) => v + 1);
              }}
            >
              <option value="">All request types · {counts.total}</option>
              <option value="question">
                Questions · {counts.kind.question ?? 0}
              </option>
              <option value="approval">
                Approvals · {counts.kind.approval ?? 0}
              </option>
              <option value="intervention">
                Interventions · {counts.kind.intervention ?? 0}
              </option>
              <option value="runtime">
                Runtime · {counts.kind.runtime ?? 0}
              </option>
            </NativeSelect>
            {queueRefresh && (
              <Button
                variant="secondary"
                onClick={queueRefresh.onRefresh}
                disabled={queueRefresh.refreshing}
              >
                Refresh
              </Button>
            )}
          </div>
        </div>
        <ResourceStatus
          state={resource.state}
          retry={resource.refresh}
          label="Inbox"
        />
        {resource.state.data && !resource.state.data.complete && (
          <p role="alert">
            Queue coverage is incomplete. Unavailable requests may remain.
          </p>
        )}
        <div
          className="inbox-rows"
          ref={queue}
          onScroll={(e) => {
            state.scrollTop = e.currentTarget.scrollTop;
          }}
        >
          {queueGroups(rows).map((group) => (
            <Fragment key={group.id}>
              <h2 className="inbox-group">{group.heading}</h2>
              {group.items.map(row)}
            </Fragment>
          ))}
          {!rows.length && resource.state.status === "fresh" && (
            <Card className="inbox-empty-card">
              {!complete ? (
                <p>No requests visible in available coverage.</p>
              ) : filtered && loaded.length ? (
                <>
                  <h2 className="small-heading">No matching requests.</h2>
                  <p className="body muted">
                    Nothing matches these filters. There are still{" "}
                    {loaded.length} unresolved items across all projects.
                  </p>
                  <Button variant="secondary" onClick={clear}>
                    Clear filters
                  </Button>
                </>
              ) : (
                <>
                  <h2 className="small-heading">
                    Nothing needs your attention.
                  </h2>
                  <p className="body muted">
                    Questions, approvals and execution problems will appear
                    here. Routine progress and completed work stay in Overview.
                  </p>
                  <ActionLink variant="secondary" href="/">
                    Back to overview
                  </ActionLink>
                </>
              )}
            </Card>
          )}
        </div>
        <p className="inbox-caption">
          {status === "actionable"
            ? "Only items that need your decision or intervention. Routine progress stays in task views."
            : "Inbox history. Dismissed requests do not block completion; no answer, approval or execution release is implied."}
          {!single && " J and K move between requests."}
        </p>
      </div>
      <section className="inbox-detail" aria-label="Selected request">
        {selectedId && (taskId || runtimeId) ? (
          <>
            {heading && selected && KindIcon && (
              <header className="inbox-detail-header">
                <Badge
                  className="inbox-kind"
                  variant={
                    selected.kind === "intervention" ||
                    selected.kind === "runtime"
                      ? "destructive"
                      : "attention"
                  }
                >
                  <KindIcon aria-hidden="true" />
                  {requestKindLabel(selected.kind)}
                </Badge>
                {position >= 0 && (
                  <span className="inbox-position">
                    {position + 1} of {rows.length}
                  </span>
                )}
                {!single && (
                  <span className="inbox-detail-tools">
                    {selected.kind !== "runtime" && (
                      <a
                        className="inbox-open-task"
                        href={`/tasks/${selected.taskId}`}
                      >
                        Open task
                      </a>
                    )}
                    {anchored && (
                      <>
                        <Button
                          variant="secondary"
                          className="inbox-step"
                          aria-label="Previous request"
                          aria-keyshortcuts="K"
                          title="Previous request (K)"
                          disabled={!previous}
                          onClick={() => previous && choose(previous)}
                        >
                          <ChevronUp aria-hidden="true" />
                        </Button>
                        <Button
                          variant="secondary"
                          className="inbox-step"
                          aria-label="Next request"
                          aria-keyshortcuts="J"
                          title="Next request (J)"
                          disabled={!next}
                          onClick={() => next && choose(next)}
                        >
                          <ChevronDown aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </span>
                )}
              </header>
            )}
            <div className="inbox-detail-body">
              {selected && (
                <div className="inbox-detail-intro">
                  {selectedHeading?.subtitle && (
                    <p className="inbox-detail-project">
                      {selectedHeading.subtitle}
                    </p>
                  )}
                  <h2 ref={detailHeading} tabIndex={-1}>
                    {selectedHeading?.title ?? "Selected request"}
                  </h2>
                  {selectedHeading?.reason && selected.kind !== "runtime" && (
                    <p className="inbox-reason">{selectedHeading.reason}</p>
                  )}
                  {leftQueue && (
                    <p role="status">
                      This request has left the current queue. Its exact detail
                      remains selected.
                    </p>
                  )}
                  {leftQueue &&
                    (continuation && continuationHeading ? (
                      <button
                        type="button"
                        className="inbox-continue"
                        onClick={() => choose(continuation)}
                      >
                        <span className="inbox-continue-label">
                          Next request <span aria-hidden="true">→</span>
                        </span>
                        <strong>
                          {continuationHeading.title ?? "Unavailable task"}
                        </strong>
                        {continuationHeading.subtitle && (
                          <span className="inbox-row-subtitle">
                            {continuationHeading.subtitle}
                          </span>
                        )}
                      </button>
                    ) : filtered && loaded.length ? (
                      <p className="inbox-continue-end">
                        No more requests match these filters.{" "}
                        <Button variant="secondary" onClick={clear}>
                          Clear filters
                        </Button>
                      </p>
                    ) : (
                      <p className="inbox-continue-end">
                        {status === "actionable"
                          ? "No actionable requests remain."
                          : "No more requests in this view."}{" "}
                        <ActionLink variant="secondary" href="/">
                          Back to overview
                        </ActionLink>
                      </p>
                    ))}
                </div>
              )}
              {!isQuestion && meta}
              {selected && !isQuestion && (
                <InboxVisibility
                  key={`${selected.id}:${selected.lifecycle?.status}`}
                  item={selected}
                  client={client}
                  session={session}
                  onChanged={resource.refresh}
                />
              )}
              {selected?.lifecycle &&
              selected.lifecycle.status !== "actionable" ? (
                <p>
                  {selected.lifecycle.status === "resolved"
                    ? "This request is resolved and cannot be answered or restored."
                    : selected.kind === "question" ||
                        selected.kind === "approval"
                      ? "Dismissed. This request remains unanswered but is no longer required for completion."
                      : "Dismissed from Inbox. The underlying condition is unchanged."}
                </p>
              ) : isQuestion && taskId ? (
                <QuestionResponse
                  client={client}
                  session={session}
                  taskId={taskId}
                  interactionId={selectedId}
                  states={questions}
                  onRecorded={resource.refresh}
                  observedAt={resource.state.fetchedAt}
                  requesterName={selected?.requesterName}
                  compactContext={Boolean(selected)}
                  onBack={back}
                  holds={answerHolds(task.state)}
                />
              ) : selected?.kind === "approval" ? (
                <ApprovalDetail item={selected} resource={task} />
              ) : selected?.kind === "runtime" ? (
                <RuntimeDetail item={selected} />
              ) : selected ? (
                <InterventionDetail
                  item={selected}
                  leftQueue={leftQueue}
                  startKept={startSentFor === taskId}
                  start={
                    task.state.data
                      ? {
                          client,
                          session,
                          task: task.state.data.data,
                          onChanged: resource.refresh,
                          onStart: () => setStartSentFor(taskId),
                        }
                      : undefined
                  }
                />
              ) : (
                <p>Selected request is unavailable.</p>
              )}
              {selected && isQuestion && (
                <InboxVisibility
                  key={`${selected.id}:${selected.lifecycle?.status}`}
                  item={selected}
                  client={client}
                  session={session}
                  onChanged={resource.refresh}
                />
              )}
              {isQuestion && meta}
            </div>
          </>
        ) : (
          <p>Select a request to review its complete form or exact material.</p>
        )}
      </section>
      {inspector && selected && selected.kind !== "runtime" && (
        <InboxContext
          item={selected}
          task={task}
          open={!leftQueue && !recorded}
        />
      )}
    </section>
  );
}

function InboxVisibility({
  item,
  client,
  session,
  onChanged,
}: {
  item: InboxItem;
  client: OperatorClient;
  session: Session;
  onChanged: () => void;
}) {
  const [note, setNote] = useState(""),
    [pending, setPending] = useState<OperatorCommand | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [recorded, setRecorded] = useState(false),
    [revealed, setRevealed] = useState(false),
    refocus = useRef(false),
    focusNote = useRef(false),
    noteId = useId();
  const lifecycle = item.lifecycle;
  if (!lifecycle) return null;
  const action = lifecycle.status === "dismissed" ? "restore" : "dismiss";
  const run = async () => {
    const command = pending ?? {
      type: `inbox.${action}` as "inbox.dismiss" | "inbox.restore",
      key: crypto.randomUUID(),
      itemId: item.id,
      expectedRevision: lifecycle.revision,
      ...(action === "dismiss" && note ? { note } : {}),
    };
    setPending(command);
    setBusy(true);
    try {
      const result = await client.command(command, session.csrfToken);
      if (result.state === "recorded") {
        setRecorded(true);
        setPending(null);
        setMessage(
          action === "dismiss"
            ? item.kind === "question" || item.kind === "approval"
              ? "Dismissed. No answer or agent input was sent. This request is no longer required for completion."
              : "Dismissed. Only Inbox visibility changed; the underlying condition is unchanged."
            : item.kind === "question" || item.kind === "approval"
              ? "Restored. No work was started. A pending request is required for completion again."
              : "Restored. No work was started.",
        );
        onChanged();
      } else {
        setMessage(
          result.state === "unknown"
            ? "Reply unavailable. Retry to reconcile the same request."
            : "The item changed or this action is unavailable. Refresh Inbox.",
        );
        if (result.state !== "unknown") setPending(null);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-lifecycle">
      <p>
        {lifecycle.status === "resolved"
          ? lifecycle.resolution
          : lifecycle.status === "dismissed"
            ? `Dismissed ${lifecycle.dismissedAt === null ? "" : new Date(lifecycle.dismissedAt).toLocaleString()}`
            : null}
      </p>
      {lifecycle.note && <p>{lifecycle.note}</p>}
      {message && <p role="status">{message}</p>}
      {!recorded &&
        lifecycle.status !== "resolved" &&
        (action === "restore" || item.dismissible) &&
        (action === "restore" ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run()}
          >
            {pending ? "Retry visibility change" : "Restore"}
          </Button>
        ) : revealed || pending ? (
          <>
            <label htmlFor={noteId}>Dismissal note (optional)</label>
            <Textarea
              id={noteId}
              ref={(el) => {
                if (el && focusNote.current) {
                  focusNote.current = false;
                  el.focus();
                }
              }}
              maxLength={4096}
              value={note}
              disabled={busy || !!pending}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run()}
            >
              {pending ? "Retry visibility change" : "Dismiss request"}
            </Button>
            {!pending && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setRevealed(false);
                  setNote("");
                  refocus.current = true;
                }}
              >
                Cancel
              </Button>
            )}
          </>
        ) : (
          <Button
            ref={(el) => {
              if (el && refocus.current) {
                refocus.current = false;
                el.focus();
              }
            }}
            variant="secondary"
            onClick={() => {
              focusNote.current = true;
              setRevealed(true);
            }}
          >
            Dismiss
          </Button>
        ))}
    </div>
  );
}
