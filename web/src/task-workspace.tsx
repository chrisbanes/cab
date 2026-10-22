import { QuestionHolds, QuestionResponse } from "./question-response.js";
import {
  CommandNetworkLine,
  ExecutionNotices,
  PolicyDisclosure,
} from "./execution-notice.js";
import { executionSummary } from "./execution-runtime.js";
import type { QuestionResponseStates } from "./question-response-state.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review-contracts.js";
import {
  assignmentHistorySchema,
  executionHarnessLabels,
  type CommandReceipt,
  type OperatorCommand,
  operatorCommandSchema,
  questionReadSchema,
  type Session,
  type TaskRead,
  taskSchema,
  type Workspace,
} from "../../src/operator/contracts.js";
import { holdLines } from "../../src/operator/wait-reasons.js";
import type { OperatorClient } from "./api.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  ShortId,
  StatusBadge,
} from "./components.js";
import { useOperatorResource } from "./resource.js";
import type {
  OverviewCard,
  ReplyOutcome,
  TaskWorkspaceState,
} from "./task-workspace-state.js";
import {
  ActionOutcome,
  OutcomeDetails,
  type OutcomeField,
  detailRows,
} from "./action-feedback.js";
import {
  checkStatusWord,
  deliveryActionLine,
  deliveryBlockerSentence,
  pullRequestReference,
  pullRequestStateLabel,
  safePullRequestUrl,
} from "./delivery-presentation.js";
import { commentAvailability } from "../../src/operator/github-reasons.js";
import { clockLabel } from "./presentation.js";
import { failureCause } from "./outcome-copy.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import { MarkdownPreview, TaskFiles } from "./task-files.js";
import { TaskWorkspaceChanges } from "./inspection-changes.js";
import { RetainedResultEvidence } from "./retained-evidence.js";
import {
  hasImproveWork,
  ImproveWithLead,
  type ReleaseRun,
} from "./issue-improve.js";
import { PublishToGitHub } from "./task-publish.js";
import { hasPublishWork } from "./task-publish-model.js";
import {
  draftTurnAccessNotice,
  draftTurnHeading,
  draftTurnQueueNotice,
  draftTurnSentNotice,
  draftTurnStart,
  draftTurnUnavailableNotice,
  leadFeedbackMode,
  leadReceivesNotice,
  leadUnavailableNotice,
  leadResumeNotice,
} from "./lead-feedback.js";
import { LocalReviewPanel, LocalReviewProvider } from "./local-review.js";
import { AssignmentRows, openDisclosures, showSection } from "./task-detail.js";
import { TaskInspector } from "./task-inspector.js";
import { holdNoticesBesideRequests } from "./inbox-presentation.js";
import {
  type TaskHeaderReport,
  TaskStrip,
  TaskTabs,
  taskHeaderReport,
} from "./task-header.js";
import {
  type TaskTab,
  tabForLocation,
  tabForSection,
  tabIds,
} from "./task-tabs.js";
import {
  assignmentRow,
  briefParts,
  criterionRows,
  deliveryApplies,
  taskNextActor,
} from "./task-overview.js";
import type { ConfigurationDrafts } from "./settings-state.js";
import { WaitReasons } from "./wait-reasons.js";

type Reference = z.infer<typeof feedbackReferenceSchema>;
type History = z.infer<typeof assignmentHistorySchema>["data"];
const sectionIds = [
  "decisions",
  "brief",
  "files",
  "review",
  "result-evidence",
  "assignments",
  "context",
  "changes",
  "local-review",
  "history",
  "reply",
];
/** The section a tab opens at when a link names no section. */
const tabSections: Record<TaskTab, string> = {
  overview: "decisions",
  files: "files",
  changes: "changes",
  review: "local-review",
  history: "history",
};
const sourceGap =
  "Retained source body and checklist coverage are unavailable. Source fields are retained only up to 16,000 characters; private or missing material may also be unavailable. Consult the external source or ask the lead.";
/** The Overview card a `source`, `result` or `evidence` link names when it names no section. */
const linkedCard = (p: URLSearchParams) =>
  p.has("evidence")
    ? "result-evidence"
    : p.has("result")
      ? "review"
      : p.has("source")
        ? "brief"
        : null;
const overviewCards = ["brief", "result-evidence", "assignments"];
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** One tab's panel: always mounted, hidden unless its tab is open. */
function TabPanel({
  tab,
  active,
  children,
}: {
  tab: TaskTab;
  active: TaskTab;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`task-panel-${tab}`}
      aria-labelledby={`task-tab-${tab}`}
      data-tab={tab}
      className="task-panel"
      hidden={tab !== active}
    >
      {children}
    </div>
  );
}
function ChecklistCoverage({
  source,
}: {
  source:
    | NonNullable<TaskRead["data"]["review"]>["sources"][number]
    | undefined;
}) {
  if (!source || source.body === null) return <p>{sourceGap}</p>;
  if (source.criteriaOmittedCount === null)
    return (
      <p>
        Additional literal checklist coverage is unknown for this retained
        source.
      </p>
    );
  if (source.criteriaOmittedCount > 0)
    return (
      <p>
        Checklist coverage is partial: {source.criteria.length} literal
        checklist records retained; {source.criteriaOmittedCount} additional
        records omitted. Consult the full retained brief.
      </p>
    );
  return null;
}
function TurnOmission({
  omission,
  state,
  changed,
}: {
  omission: History["turnOmissions"][number];
  state: TaskWorkspaceState;
  changed: () => void;
}) {
  return (
    <Disclosure
      id={`turn-omission:${omission.workId}:${omission.threadId}:${omission.turnId}`}
      title={`${date(omission.createdAt)} · retained turn omission · ${omission.assignmentId} · ${omission.turnId}`}
      text={`Early buffer limit (early-buffer-limit). Work ${omission.workId}; assignment ${omission.assignmentId}; thread ${omission.threadId}; turn ${omission.turnId}. Captured turn content is unavailable.`}
      state={state}
      changed={changed}
    />
  );
}
const date = (n: number) => new Date(n < 1e12 ? n * 1000 : n).toLocaleString();
function Literal({ text }: { text: string | null | undefined }) {
  return (
    <pre className="literal-text">{text ?? "Unavailable or redacted"}</pre>
  );
}
/** A question's own text: the exact read's first label, or the request prompt when that read withholds it or fails. */
function RequestText({
  client,
  session,
  taskId,
  interactionId,
  prompt,
  observedAt,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  interactionId: string;
  prompt: string | null;
  /** The task read's last success: each change rereads, so a withheld label is withdrawn as `prompt` is. */
  observedAt: number | null | undefined;
}) {
  // shortcut: one extra GET per open question; QuestionResponse repeats it once opened, as on the Home card.
  const loader = useCallback(
      (signal: AbortSignal) =>
        client.read(
          `/api/operator/tasks/${taskId}/questions/${interactionId}`,
          questionReadSchema,
          signal,
        ),
      [client, taskId, interactionId],
    ),
    resource = useOperatorResource(
      `${session.csrfToken}:task-question:${taskId}:${interactionId}`,
      loader,
    ),
    read = resource.state.data?.data,
    // A failed reread keeps its last read, which may predate a privacy change.
    label =
      read?.source === "plain" || resource.state.error
        ? null
        : read?.form?.questions[0]?.label;
  const seen = useRef(observedAt),
    reread = useRef(resource.poll);
  reread.current = resource.poll;
  useEffect(() => {
    if (seen.current === observedAt) return;
    seen.current = observedAt;
    void reread.current();
  }, [observedAt]);
  return <Literal text={label ?? prompt} />;
}
function Disclosure({
  id,
  title,
  text,
  state,
  changed,
}: {
  id: string;
  title: string;
  text: string | null | undefined;
  state: TaskWorkspaceState;
  changed: () => void;
}) {
  return (
    <details
      data-record-id={id}
      open={state.expanded.has(id)}
      onToggle={(e) => {
        if (e.currentTarget.open) state.expanded.add(id);
        else state.expanded.delete(id);
        changed();
      }}
    >
      <summary>{title}</summary>
      <Literal text={text} />
    </details>
  );
}
/** What each task-side write is called in its failure and unknown messages. */
const writeCopy = (type: OperatorCommand["type"]) => {
  switch (type) {
    case "message":
      return { failed: "Couldn't send the reply", unknown: "it was sent" };
    case "task.draft-turn":
      return {
        failed: "Couldn't start the draft turn",
        unknown: "the draft turn was queued",
      };
    case "comment.send":
      return {
        failed: "Couldn't post the comment",
        unknown: "the comment was posted",
      };
    case "comment.review":
      return {
        failed: "Couldn't prepare the comment for review",
        unknown: "the review was saved",
      };
    case "comment.confirm":
      return {
        failed: "Couldn't save your decision",
        unknown: "your decision was saved",
      };
    case "review.view":
      return {
        failed: "Couldn't set the viewing reference",
        unknown: "the viewing reference was saved",
      };
    default:
      return {
        failed: "Couldn't refresh delivery status",
        unknown: "the refresh went through",
      };
  }
};
const unknownMessage = (type: OperatorCommand["type"]) =>
  `We couldn't confirm ${writeCopy(type).unknown}. Your draft is kept.`;
const rejectedMessage = (type: OperatorCommand["type"], code: string) =>
  `${writeCopy(type).failed}: ${failureCause(code)}. Your draft is kept.`;
/** A Results or Changes write whose response was lost: its exact request and the warning. */
const unconfirmedOf = (
  taskId: string,
  input: OperatorCommand,
  code?: string,
) => ({
  input: structuredClone(input),
  outcome: {
    tone: "warning" as const,
    message: unknownMessage(input.type),
    details: detailRows({
      command: input.type,
      resource: taskId,
      requestKey: input.key,
      ...(code ? { code } : {}),
    }),
  },
});
const changedMessage =
  "This task changed since you opened it. Your draft is kept.";
/** The reply tab's description when GitHub comments are unavailable. */
const githubReasonId = "github-comment-reason";

export function TaskWorkspace({
  client,
  session,
  taskId,
  path,
  state,
  questionStates,
  onRefresh,
  workspace,
  onHeader,
  drafts,
  releaseDraft,
}: {
  client: OperatorClient;
  session: Session;
  drafts: ConfigurationDrafts;
  taskId: string;
  path: string;
  /** Also re-reads the shell data (sidebar, runtime alert) that this page's own refresh replaced. */
  onRefresh?: () => void;
  state: TaskWorkspaceState;
  questionStates: QuestionResponseStates;
  workspace?: Workspace | null;
  /** Receives the shell header's data (title, status line, Back, Stop); null on unmount. */
  onHeader?: (report: TaskHeaderReport | null) => void;
  /** Hands an Improve with lead run on to the app's durable release. */
  releaseDraft: ReleaseRun;
}) {
  // Improve with lead opens on demand, and again after a reload while it has work to show.
  const [improveOpen, setImproveOpen] = useState<boolean | null>(null);
  const [publishOpen, setPublishOpen] = useState<boolean | null>(null);
  // A Results or Changes outcome, with the write it answers so it shows on that write's tab.
  const [aux, setAux] = useState<
    (ReplyOutcome & { from?: OperatorCommand["type"] }) | null
  >(null);
  // A Results or Changes write whose response was lost keeps its exact request in the
  // task's state, replayed by its check, so a later click never builds a different request
  // from the current selection, even after the page is left and reopened.
  const unconfirmed = state.unconfirmed;
  const auxInFlight = useRef<OperatorCommand | null>(null);

  const focusUnconfirmed = useRef(false);
  // The control whose replayed check just settled, focused once the commit enables it.
  const focusReplay = useRef<string | null>(null);
  // The message that follows a reply replaces the control the operator used, so it takes
  // focus: an unknown outcome, whose Send button gives way to the check, and the answer to
  // that check. Results and Changes actions never take it.
  const sent = useRef(false);
  const checking = useRef(false);
  const setSourceObservation = (value: "known" | "pending" | "unknown") => {
    state.sourceObservation = value;
    changed();
  };
  const [, render] = useState(0),
    changed = () => render((n) => n + 1);
  const [histories, setHistory] = useState<Record<string, History>>({}),
    [historyErrors, setHistoryErrors] = useState<Record<string, string>>({}),
    [pending, setPending] = useState(false),
    [updates, setUpdates] = useState(false);
  const historyRequests = useRef(new Map<string, number>());
  const invalidateHistory = (clear = true) => {
    for (const [id, revision] of historyRequests.current)
      historyRequests.current.set(id, revision + 1);
    if (clear) setHistory({});
  };
  const replyInFlight = useRef<string | null>(null);
  const scope = useRef(true),
    anchor = useRef<{ id: string; y: number } | null>(null),
    anchorElement = useRef<HTMLElement | null>(null),
    bottom = useRef(false),
    first = useRef(true),
    restoreReadingFocus = useRef(true),
    capturedFocus = useRef<HTMLElement | null>(null),
    capturedHistoryFocus = useRef(false),
    material = useRef<string | null>(null);
  const params = new URLSearchParams((path.split("?")[1] ?? "").split("#")[0]);
  const selectedPath = useRef<string | null>(null);
  if (selectedPath.current !== path) {
    selectedPath.current = path;
    if (!state.selectionInitialized) {
      state.selectionInitialized = true;
      // The first paint already shows the linked tab.
      state.tab = tabForLocation(path, location.hash) ?? "overview";
      state.selectedResult = params.get("result");
      const evidenceItem = params.get("evidence");
      if (state.selectedResult && evidenceItem)
        state.retained(state.selectedResult).selectedItemId = evidenceItem;
      state.selectedSource = params.get("source");
      // A link to a retained source or to evidence opens the card that shows it; a link that
      // names a result, record or section already has its target.
      if (
        state.selectedSource &&
        !state.selectedResult &&
        !params.has("record") &&
        !params.has("section")
      )
        state.overview.add("brief");
      if (state.selectedResult && evidenceItem) state.overview.add("evidence");
      // A section or fragment naming a card opens it once, here; a Back to this entry
      // remounts the page with the operator's own choice kept.
      const named =
        params.get("section") ?? (path.split("#")[1] || location.hash.slice(1));
      if (named === "brief" || named === "assignments")
        state.overview.add(named);
      if (named === "result-evidence") state.overview.add("evidence");
      if (params.has("assignment"))
        state.expanded.add(params.get("assignment") ?? "");
      // Exact inspection links; the service still enforces scope and exclusions.
      const rawPath = params.get("path");
      // An exact link is never normalized into a different path.
      const filePath = rawPath === null ? [] : rawPath.split("/");
      const repository = params.get("repository");
      if (rawPath !== null && filePath.some((segment) => segment === ""))
        state.files.linkNotice =
          "The linked file path is not valid, so no file was opened.";
      else if (filePath.length)
        state.files.openCurrentFile(
          repository
            ? { kind: "repository", repositoryId: repository }
            : { kind: "workspace" },
          filePath,
        );
      const target = params.get("target");
      if (
        target === "branch" ||
        target === "uncommitted" ||
        target === "last-turn"
      )
        state.changes.target = target;
      if (repository && !filePath.length)
        state.changes.repositoryId = repository;
      const base = params.get("base");
      if (repository && base)
        state.changes.baseBranchByRepository[repository] = base;
      if (params.has("review")) state.review.inspectKey = params.get("review");
    }
  }
  const selectionQuery = new URLSearchParams();
  if (state.selectedResult)
    selectionQuery.set("resultId", state.selectedResult);
  if (state.selectedSource)
    selectionQuery.set("sourceId", state.selectedSource);
  const selection = selectionQuery.toString();
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/tasks/${taskId}${selection ? `?${selection}` : ""}`,
        taskSchema,
        signal,
      ),
    [client, taskId, selection],
  );
  const resource = useOperatorResource(
      `${session.csrfToken}:${taskId}`,
      loader,
    ),
    data = resource.state.data?.data;
  const publishWork = data?.publication
    ? hasPublishWork(data.publication)
    : false;
  // Work found on load opens the panel and keeps it open, so how it ends is read there.
  useEffect(() => {
    if (publishWork) setPublishOpen((open) => open ?? true);
  }, [publishWork]);
  const headerReport =
    data &&
    JSON.stringify(
      taskHeaderReport(
        data,
        workspace?.data.projects.find((p) => p.id === data.task.projectId)
          ?.name ?? null,
        (window.history.state as { origin?: string } | null)?.origin,
      ),
    );
  useEffect(() => {
    if (headerReport) onHeader?.(JSON.parse(headerReport));
  }, [headerReport, onHeader]);
  useEffect(() => () => onHeader?.(null), [onHeader]);
  // The answer to a send or a check has had its turn at the focus.
  useEffect(() => {
    if (!pending) {
      sent.current = false;
      checking.current = false;
      focusUnconfirmed.current = false;
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new task never inherits the last one's focus request.
  useEffect(() => {
    focusReplay.current = null;
  }, [taskId]);
  useEffect(() => {
    if (pending || !focusReplay.current) return;
    document
      .querySelector<HTMLElement>(
        `[data-unconfirmed-control="${focusReplay.current}"]`,
      )
      ?.focus();
    focusReplay.current = null;
  });
  const completeSourceObservation =
    !data?.source ||
    (data.source.memberships.length > 0 &&
      data.source.memberships.every((m) => m.sync.complete === true));
  const sourceObservation =
    state.sourceObservation === "pending"
      ? "pending"
      : state.sourceRefreshFailed ||
          resource.state.status !== "fresh" ||
          resource.state.error ||
          !completeSourceObservation
        ? "unknown"
        : "known";
  const sourceRequest = useRef(0);
  const sourceRead = useRef<{
    request: number;
    previous: typeof resource.state.data;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a requested source refresh followed by current task read can settle its comparison.
  useEffect(() => {
    if (!sourceRead.current) return;
    if (sourceRead.current.request !== sourceRequest.current) {
      sourceRead.current = null;
      return;
    }
    if (resource.state.error) {
      state.sourceRefreshFailed = true;
      sourceRead.current = null;
      setSourceObservation("unknown");
    } else if (
      resource.state.status === "fresh" &&
      resource.state.data !== sourceRead.current.previous
    ) {
      sourceRead.current = null;
      state.sourceRefreshFailed = false;
      setSourceObservation(completeSourceObservation ? "known" : "unknown");
    }
  }, [resource.state.data, resource.state.error, resource.state.status]);

  const capture = () => {
    if (
      restoreReadingFocus.current &&
      state.focusRecord &&
      capturedHistoryFocus.current &&
      capturedFocus.current &&
      !capturedFocus.current.isConnected &&
      document.activeElement === document.body
    )
      return;
    bottom.current =
      innerHeight + scrollY >= document.documentElement.scrollHeight - 64;
    const visible = [
      ...document.querySelectorAll<HTMLElement>("[data-record-id]"),
    ].filter((e) => {
      const bounds = e.getBoundingClientRect();
      return bounds.bottom > 80 && bounds.top < innerHeight;
    });
    const el = visible.find(
      (e) => !visible.some((child) => child !== e && e.contains(child)),
    );
    anchorElement.current = el ?? null;
    anchor.current = el
      ? { id: el.dataset.recordId ?? "", y: el.getBoundingClientRect().top }
      : null;
    state.scrollY = scrollY;
    state.historyAnchor = anchor.current;
    capturedFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    capturedHistoryFocus.current = Boolean(
      capturedFocus.current?.closest("#history"),
    );
    state.focusHref =
      capturedFocus.current instanceof HTMLAnchorElement
        ? capturedFocus.current.getAttribute("href")
        : null;
    state.focusRecord =
      (capturedFocus.current?.closest("[data-record-id]") as HTMLElement | null)
        ?.dataset.recordId ?? null;
    restoreReadingFocus.current = Boolean(state.focusRecord);
    history.replaceState(
      {
        ...history.state,
        taskWorkspaceReading: {
          scrollY: state.scrollY,
          historyAnchor: state.historyAnchor,
          focusRecord: state.focusRecord,
          tab: state.tab,
        },
      },
      "",
    );
  };
  const refresh = () => {
    capture();
    invalidateHistory();
    resource.refresh();
  };
  /**
   * The only tab switch: keeps the leaving tab's scroll, drops the reading anchor (as a
   * section move does) and returns to the new tab's own scroll. Every panel stays mounted.
   */
  const selectTab = (tab: TaskTab, remember = true) => {
    if (tab === state.tab) return;
    state.tabScroll[state.tab] = scrollY;
    anchor.current = null;
    anchorElement.current = null;
    state.historyAnchor = null;
    bottom.current = false;
    state.tab = tab;
    // Show the panel now so a caller can scroll to or focus what it holds; the render agrees.
    for (const panel of document.querySelectorAll<HTMLElement>(
      ".task-workspace .task-panel",
    ))
      panel.hidden = panel.dataset.tab !== tab;
    scrollTo(0, state.tabScroll[tab] ?? 0);
    state.scrollY = scrollY;
    // Back and Forward return to this tab even without a later capture.
    // The left tab's anchor and focus do not belong to this one.
    if (remember)
      history.replaceState(
        {
          ...history.state,
          taskWorkspaceReading: {
            ...history.state?.taskWorkspaceReading,
            historyAnchor: null,
            focusRecord: null,
            tab,
            scrollY: state.scrollY,
          },
        },
        "",
      );
    changed();
  };
  /** Move to a section in place, on its tab. */
  const reveal = (id: string) => {
    selectTab(tabForSection(id));
    const target = document.getElementById(id);
    if (target) showSection(target);
  };
  // The timer read: nothing blanks or announces progress unless it fails.
  const poll = () => {
    capture();
    resource.poll();
  };
  // Manual re-reads also refresh the shell's workspace and Inbox count; the poll below does not.
  const refreshAll = () => {
    refresh();
    onRefresh?.();
  };
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const captureRef = useRef(capture);
  captureRef.current = capture;
  useEffect(() => {
    scope.current = true;
    // In-app links and the sidebar Search field both leave the task.
    const leave = (event: Event) => {
      if (
        (event.target as Element | null)?.closest(
          event.type === "submit" ? ".sidebar .search-work" : 'a[href^="/app"]',
        )
      )
        captureRef.current();
    };
    const intentionalFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target !== capturedFocus.current &&
        target !== document.body &&
        (target.closest("[data-record-id]") as HTMLElement | null)?.dataset
          .recordId !== state.focusRecord
      )
        restoreReadingFocus.current = false;
    };
    document.addEventListener("click", leave, true);
    document.addEventListener("submit", leave, true);
    document.addEventListener("focusin", intentionalFocus);
    const timer = setInterval(() => pollRef.current(), 15000);
    return () => {
      scope.current = false;
      if (
        replyInFlight.current &&
        state.frozen?.key === replyInFlight.current
      ) {
        state.uncertain = true;
        state.notice = {
          tone: "warning",
          message: unknownMessage(state.frozen.type),
          details: detailRows({
            command: state.frozen.type,
            resource: taskId,
            requestKey: state.frozen.key,
          }),
        };
      }
      if (auxInFlight.current)
        state.unconfirmed = unconfirmedOf(taskId, auxInFlight.current);
      sourceRequest.current++;
      sourceRead.current = null;
      if (state.sourceObservation === "pending") {
        state.sourceRefreshFailed = true;
        state.sourceObservation = "unknown";
      }
      clearInterval(timer);
      document.removeEventListener("click", leave, true);
      document.removeEventListener("submit", leave, true);
      document.removeEventListener("focusin", intentionalFocus);
    };
  }, [state, taskId]);
  const readingFocusTarget = () => {
    const record = state.focusRecord
      ? [...document.querySelectorAll<HTMLElement>("[data-record-id]")].find(
          (e) => e.dataset.recordId === state.focusRecord,
        )
      : null;
    return (
      (state.focusHref
        ? [
            ...(record?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []),
          ].find((e) => e.getAttribute("href") === state.focusHref)
        : null) ?? record?.querySelector<HTMLElement>("summary,button,a")
    );
  };
  const layoutPath = useRef(path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: history DOM insertion must restore the previously captured reading anchor.
  useLayoutEffect(() => {
    if (!data) return;
    if (layoutPath.current !== path) {
      layoutPath.current = path;
      const saved = history.state?.taskWorkspaceReading;
      if (saved) {
        // Restoring keeps the saved entry as it is.
        if (tabIds.includes(saved.tab)) selectTab(saved.tab, false);
        state.scrollY = saved.scrollY;
        state.historyAnchor = saved.historyAnchor;
        state.focusRecord = saved.focusRecord;
        anchor.current = saved.historyAnchor;
        restoreReadingFocus.current = true;
        scrollTo(0, saved.scrollY);
      } else {
        const p = new URLSearchParams((path.split("?")[1] ?? "").split("#")[0]);
        // The same tab a fresh load of this link opens, at its section.
        const tab = tabForLocation(path) ?? "overview";
        const id =
          p.get("section") ??
          (path.split("#")[1] ||
            (tab === "overview"
              ? (linkedCard(p) ?? tabSections.overview)
              : tabSections[tab]));
        selectTab(tab);
        const target = document.getElementById(id);
        if (target) {
          showSection(target);
          anchor.current = null;
          state.historyAnchor = null;
          bottom.current = false;
          state.scrollY = scrollY;
          restoreReadingFocus.current = false;
          return;
        }
      }
    }
    if (restoreReadingFocus.current && capturedFocus.current?.isConnected)
      restoreReadingFocus.current = false;
    if (restoreReadingFocus.current) {
      const target = readingFocusTarget();
      if (target) {
        target.focus({ preventScroll: true });
        restoreReadingFocus.current = false;
      } else if (!state.focusRecord) restoreReadingFocus.current = false;
    }
    const signature = JSON.stringify([
      data.task,
      data.results,
      data.messages,
      data.questions,
      data.approvals,
      data.review?.sources,
    ]);
    const newMaterial =
      material.current !== null && material.current !== signature;
    material.current = signature;
    if (first.current) {
      first.current = false;
      const p = new URLSearchParams((path.split("?")[1] ?? "").split("#")[0]),
        record = p.get("record") ?? p.get("request"),
        section = p.get("section");
      const fragment = path.split("#")[1] || location.hash.slice(1),
        linked =
          record || section
            ? null
            : (linkedCard(p) ??
              (overviewCards.includes(fragment) ? fragment : null)),
        target = record
          ? [
              ...document.querySelectorAll<HTMLElement>("[data-record-id]"),
            ].find((e) => e.dataset.recordId === record)
          : section && sectionIds.includes(section)
            ? document.getElementById(section)
            : linked
              ? document.getElementById(linked)
              : null;
      if (target && state.scrollY === 0) {
        // A Search record can sit in a closed card; only its first arrival opens it, so a
        // Back or Forward keeps the operator's choice.
        if (record && !state.recordRevealed) {
          state.recordRevealed = true;
          openDisclosures(target);
        }
        // A linked record or section opens on the tab whose panel holds it, unless the link
        // names its tab (`?request=…#history` is that request's History).
        const tab = target.closest<HTMLElement>(".task-panel")?.dataset.tab,
          named = Boolean(section || path.split("#")[1] || location.hash);
        if (tab && !(record && named)) selectTab(tab as TaskTab);
        if (section && !state.focusRecord && !state.historyAnchor)
          showSection(target);
        else target.scrollIntoView();
      } else scrollTo(0, state.scrollY);
      if (state.focusRecord)
        readingFocusTarget()?.focus({ preventScroll: true });
      return;
    }
    if (bottom.current) scrollTo(0, document.documentElement.scrollHeight);
    else {
      const a = anchor.current ?? state.historyAnchor,
        captured = anchorElement.current,
        // Review contexts nest a second element with the same record id, so the first match can be the wrong one.
        el = !a
          ? null
          : captured?.isConnected && captured.dataset.recordId === a.id
            ? captured
            : [
                ...document.querySelectorAll<HTMLElement>("[data-record-id]"),
              ].find((el) => el.dataset.recordId === a.id);
      if (a && el) scrollBy(0, el.getBoundingClientRect().top - a.y);
      if (newMaterial) setUpdates(true);
    }
  }, [data, histories, state, path]);
  const loadHistory = useCallback(
    async (
      id: string,
      before?: number,
      beforeOmission?: number,
      keepShown = false,
    ) => {
      const current = client.captureAuthenticationScope();
      const revision = (historyRequests.current.get(id) ?? 0) + 1;
      historyRequests.current.set(id, revision);
      const owned = () =>
        scope.current &&
        current() &&
        historyRequests.current.get(id) === revision;
      if (!keepShown)
        setHistory((old) => {
          const next = { ...old };
          delete next[id];
          return next;
        });
      try {
        const itemDepth =
          (state.historyPages[id]?.length ?? 0) + (before ? 1 : 0);
        const omissionDepth =
          (state.omissionHistoryPages[id]?.length ?? 0) +
          (beforeOmission ? 1 : 0);
        const pages: number[] = [],
          omissionPages: number[] = [],
          values: History[] = [],
          itemValues: History[] = [],
          omissionValues: History[] = [];
        let boundary: number | undefined, omissionBoundary: number | undefined;
        let itemActive = true,
          omissionActive = true;
        for (let page = 0; page <= Math.max(itemDepth, omissionDepth); page++) {
          if (!owned()) return;
          const query = new URLSearchParams();
          if (boundary !== undefined)
            query.set("beforeSequence", String(boundary));
          if (omissionBoundary !== undefined)
            query.set("beforeOmissionSequence", String(omissionBoundary));
          const value = (
            await client.read(
              `/api/operator/assignments/${id}/history${query.size ? `?${query}` : ""}`,
              assignmentHistorySchema,
            )
          ).data;
          if (!owned()) return;
          values.push(value);
          boundary = undefined;
          omissionBoundary = undefined;
          if (itemActive && page <= itemDepth) {
            itemValues.push(value);
            if (
              page < itemDepth &&
              value.omittedItemCount &&
              value.items.length
            ) {
              boundary = value.items[0]!.sequence;
              pages.push(boundary);
            } else itemActive = false;
          }
          if (omissionActive && page <= omissionDepth) {
            omissionValues.push(value);
            if (
              page < omissionDepth &&
              value.omittedTurnCount &&
              value.turnOmissions.length
            ) {
              omissionBoundary = value.turnOmissions[0]!.sequence;
              omissionPages.push(omissionBoundary);
            } else omissionActive = false;
          }
          if (!itemActive && !omissionActive) break;
        }
        if (!owned()) return;
        const recent = values[0];
        if (!recent) return;
        if (
          values.some(
            (value) => value.visibilityRevision !== recent.visibilityRevision,
          )
        ) {
          setHistory((old) => {
            if (!owned()) return old;
            const next = { ...old };
            delete next[id];
            return next;
          });
          throw Error(
            "History visibility changed while loading retained pages",
          );
        }
        const items = itemValues
          .flatMap((value) => value.items)
          .filter(
            (item, i, all) =>
              all.findIndex(
                (other) =>
                  other.workId === item.workId && other.itemId === item.itemId,
              ) === i,
          )
          .sort((a, b) => a.sequence - b.sequence);
        state.historyPages[id] = pages;
        state.omissionHistoryPages[id] = omissionPages;
        setHistory((old) =>
          owned()
            ? {
                ...old,
                [id]: {
                  ...recent,
                  items,
                  turnOmissions: omissionValues
                    .flatMap((value) => value.turnOmissions)
                    .filter(
                      (item, i, all) =>
                        all.findIndex(
                          (other) =>
                            other.workId === item.workId &&
                            other.threadId === item.threadId &&
                            other.turnId === item.turnId,
                        ) === i,
                    )
                    .sort(
                      (a, b) =>
                        a.createdAt - b.createdAt || a.sequence - b.sequence,
                    ),
                  omittedItemCount:
                    itemValues.at(-1)?.omittedItemCount ??
                    recent.omittedItemCount,
                  omittedTurnCount:
                    omissionValues.at(-1)?.omittedTurnCount ??
                    recent.omittedTurnCount,
                },
              }
            : old,
        );
        setHistoryErrors((old) => (owned() ? { ...old, [id]: "" } : old));
      } catch (e) {
        if (owned()) {
          setHistory((old) => {
            if (!owned()) return old;
            const next = { ...old };
            delete next[id];
            return next;
          });
          setHistoryErrors((old) =>
            owned()
              ? {
                  ...old,
                  [id]: e instanceof Error ? e.message : "Unavailable",
                }
              : old,
          );
        }
      }
    },
    [client, state],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: pending/error invalidates the current history ownership before any late batch can publish.
  useEffect(() => {
    // A timer poll never publishes pending, so only an explicit read clears what is shown.
    if (resource.state.pending || resource.state.error) {
      invalidateHistory(resource.state.pending);
      return;
    }
    for (const a of data?.assignments ?? [])
      void loadHistory(a.assignmentId, undefined, undefined, true);
  }, [data, loadHistory, resource.state.pending, resource.state.error]);
  async function command(input: OperatorCommand) {
    if (pending) return;
    if (
      unconfirmed &&
      (input.type === "review.view" || input.type === "delivery.refresh") &&
      input.key !== unconfirmed.input.key
    )
      return;
    const normalized = operatorCommandSchema.safeParse(input);
    if (!normalized.success) {
      if (state.frozen?.key === input.key) state.frozen = null;
      setAux(null);
      state.notice = {
        tone: "error",
        message: "That draft can't be sent as written. Your draft is kept.",
        details: detailRows({
          command: input.type,
          resource: taskId,
          requestKey: input.key,
          code: "invalid-input",
        }),
      };
      changed();
      return;
    }
    input = normalized.data;
    const rows = (
      receipt?: CommandReceipt,
      code?: string,
      more: OutcomeField[] = [],
    ) => [
      ...detailRows({
        command: input.type,
        resource: taskId,
        requestKey: input.key,
        ...(receipt ? { kind: receipt.kind } : {}),
        ...(code ? { code } : {}),
      }),
      ...more,
    ];
    setPending(true);
    const current = client.captureAuthenticationScope();
    const reviewIntent =
      input.type === "comment.review" || input.type === "comment.confirm";
    const reply =
      input.type === "message" ||
      input.type === "task.draft-turn" ||
      input.type === "comment.send" ||
      reviewIntent;
    if (reviewIntent) {
      if (state.frozen && state.frozen.key !== input.key) {
        setPending(false);
        return;
      }
      state.frozen = structuredClone(input);
    }
    if (reply) {
      replyInFlight.current = input.key;
      sent.current = true;
      setAux(null);
    } else auxInFlight.current = structuredClone(input);
    const replayed = unconfirmed?.input.key === input.key;
    const outcome = await client.command(input, session.csrfToken);
    if (!scope.current || !current()) return;
    setPending(false);
    auxInFlight.current = null;
    if (replyInFlight.current === input.key) replyInFlight.current = null;
    if (!reply) {
      if (outcome.state === "unknown") {
        setAux(null);
        // The control is off now, so the check takes the focus it held.
        focusUnconfirmed.current = true;
        state.unconfirmed = unconfirmedOf(taskId, input, outcome.code);
      } else {
        state.unconfirmed = null;
        if (replayed) focusReplay.current = input.type;
        if (outcome.state === "recorded") {
          if (outcome.receipt.kind === "comment-review")
            state.commentReview = outcome.receipt;
          setAux({
            tone: "success",
            message:
              input.type === "review.view"
                ? "Viewing reference set."
                : "Delivery status refreshed.",
            details: rows(outcome.receipt),
            from: input.type,
          });
          refresh();
        } else
          setAux({
            tone: "error",
            message:
              outcome.state === "conflict"
                ? changedMessage
                : rejectedMessage(input.type, outcome.code),
            details: rows(undefined, outcome.code),
            from: input.type,
          });
      }
      changed();
      return;
    }
    if (state.frozen?.key !== input.key) {
      setAux({
        tone: "warning",
        message:
          "A late answer to an earlier request was ignored. Your draft is kept.",
        details: rows(),
      });
      return;
    }
    if (reviewIntent) {
      if (outcome.state === "recorded") {
        const receipt = outcome.receipt;
        const matches =
          receipt.kind === "comment-review" &&
          receipt.key === input.key &&
          receipt.taskId === taskId &&
          (input.type === "comment.review"
            ? receipt.reviewId === input.key &&
              receipt.operationId === input.operationId &&
              receipt.body === input.body &&
              receipt.taskVersion === input.expectedTaskVersion
            : input.type === "comment.confirm" &&
              receipt.reviewId === input.reviewId &&
              receipt.materialHash === input.materialHash &&
              receipt.decision === input.decision &&
              receipt.revision === input.expectedRevision + 1);
        if (!matches) {
          state.uncertain = true;
          state.notice = {
            tone: "warning",
            message: unknownMessage(input.type),
            details: rows(receipt),
          };
        } else {
          state.commentReview = receipt;
          state.frozen = null;
          state.uncertain = false;
          state.notice = {
            tone: "success",
            message:
              input.type === "comment.review"
                ? "Comment ready for your approval."
                : receipt.decision === "approved"
                  ? "Comment approved. You can post it now."
                  : "Comment denied.",
            details: rows(receipt),
          };
          refresh();
        }
      } else {
        state.uncertain = outcome.state === "unknown";
        state.notice = {
          tone: state.uncertain ? "warning" : "error",
          message: state.uncertain
            ? unknownMessage(input.type)
            : outcome.state === "conflict"
              ? changedMessage
              : rejectedMessage(input.type, outcome.code),
          details: rows(undefined, outcome.code),
        };
        if (!state.uncertain) state.frozen = null;
      }
      changed();
      return;
    }
    if (
      outcome.state === "recorded" &&
      (outcome.receipt.key !== input.key ||
        !("taskId" in outcome.receipt) ||
        outcome.receipt.taskId !== taskId ||
        (input.type === "message"
          ? outcome.receipt.kind !== "coordination"
          : input.type === "task.draft-turn"
            ? outcome.receipt.kind !== "draft-turn"
            : outcome.receipt.kind !== "delivery" ||
              outcome.receipt.operationId !== input.key))
    ) {
      state.uncertain = true;
      state.notice = {
        tone: "warning",
        message: unknownMessage(input.type),
        details: rows(outcome.receipt),
      };
      changed();
      return;
    }
    if (outcome.state === "recorded") {
      const receipt = outcome.receipt;
      state.uncertain = false;
      const delivery = receipt.kind === "delivery" ? receipt : null;
      const open =
        delivery &&
        ["uncertain", "attempting", "prepared"].includes(delivery.state);
      const failed =
        delivery && ["confirmed-failure", "denied"].includes(delivery.state);
      state.notice = {
        tone: open ? "warning" : failed ? "error" : "success",
        message: open
          ? unknownMessage(input.type)
          : failed
            ? "The comment wasn't posted. Your draft is kept."
            : delivery
              ? "Comment posted."
              : receipt.kind === "draft-turn"
                ? draftTurnSentNotice(data?.lead?.name ?? "the lead")
                : receipt.kind === "coordination" && receipt.resumedLead
                  ? `Sent. ${data?.lead?.name ?? "The lead"} resumed with this feedback.`
                  : `Sent to ${data?.lead?.name ?? "the lead"}.`,
        details: rows(
          receipt,
          undefined,
          delivery
            ? [
                ["State", delivery.state],
                ...(delivery.reason
                  ? ([["Reason", delivery.reason]] as OutcomeField[])
                  : []),
              ]
            : [],
        ),
      };
      if (
        receipt.kind === "coordination" ||
        receipt.kind === "draft-turn" ||
        (delivery && delivery.state === "confirmed-success")
      ) {
        state.draft = "";
        if (input.type === "message") state.reference = undefined;
        state.commentReview = null;
      }
      if (open) {
        state.uncertain = true;
      } else state.frozen = null;
      refresh();
    } else {
      state.uncertain = outcome.state === "unknown";
      state.notice = {
        tone: state.uncertain ? "warning" : "error",
        message: state.uncertain
          ? unknownMessage(input.type)
          : outcome.state === "conflict"
            ? changedMessage
            : rejectedMessage(input.type, outcome.code),
        details: rows(undefined, outcome.code),
      };
      if (!state.uncertain) state.frozen = null;
    }
    changed();
  }
  const ask = (reference: Reference, label: string) => {
    if (state.uncertain || pending) return;
    state.destination = "lead";
    if (state.draft.length) {
      state.notice = {
        tone: "warning",
        message:
          "Existing lead draft and reference retained. Finish or clear it before starting a new contextual reply.",
        details: [],
      };
    } else {
      state.reference = reference;
      state.draft = `Please review ${label}.`;
      state.notice = null;
    }
    setAux(null);
    selectTab("overview");
    changed();
    requestAnimationFrame(() =>
      document.getElementById("workspace-reply")?.focus(),
    );
  };
  if (!data)
    return (
      <section>
        <ResourceStatus state={resource.state} retry={refreshAll} />
        <p>
          Task material is unavailable. Exact historical targets are not
          replaced with current records.
        </p>
        <ActionLink href="/app/tasks">All tasks</ActionLink>
      </section>
    );
  const review = data.review,
    sources = review?.sources ?? [],
    latestSource = sources.at(-1),
    source = state.selectedSource
      ? sources.find((s) => s.sourceId === state.selectedSource)
      : latestSource;
  const selected = state.selectedResult
      ? data.results.find((r) => r.resultId === state.selectedResult)
      : data.results.at(-1),
    meta = review?.results.find((r) => r.resultId === selected?.resultId);
  const leadId = data.leadAssignmentId,
    lead = data.assignments.find((a) => a.assignmentId === leadId),
    leadName = data.lead?.name ?? "Project lead",
    leadMode = leadFeedbackMode(data, lead?.state);
  const openRequests = [...data.questions, ...data.approvals].filter(
      (q) => q.status === "open",
    ),
    nextActor = taskNextActor(data),
    inView = openRequests.find(
      (q) => q.interactionId === params.get("request"),
    ),
    deciding = inView?.kind === "approval" ? inView.interactionId : null;
  const requesterOf = (interactionId: string | null) => {
    const request = [...data.questions, ...data.approvals].find(
      (q) => q.interactionId === interactionId,
    );
    return (
      data.assignments.find(
        (a) => a.assignmentId === request?.requestingAssignmentId,
      )?.name ?? null
    );
  };
  async function refreshSource() {
    if (!data) return;
    const request = ++sourceRequest.current;
    sourceRead.current = null;
    setSourceObservation("pending");
    const current = client.captureAuthenticationScope();
    const owned = () =>
      scope.current && current() && request === sourceRequest.current;
    try {
      const observation = await client.refreshSources(session.csrfToken);
      if (!owned()) return;
      const selections = observation.data.projects.find(
        (p) => p.projectId === data.task.projectId,
      )?.selections;
      if (
        !selections?.length ||
        selections.some((s) => s.state !== "complete")
      ) {
        state.sourceRefreshFailed = true;
        setSourceObservation("unknown");
      } else
        sourceRead.current = {
          request,
          previous: resource.state.data,
        };
      refresh();
    } catch {
      if (!owned()) return;
      state.sourceRefreshFailed = true;
      setSourceObservation("unknown");
      // An unconfirmed reply keeps its message and its one action; otherwise the failure
      // replaces an earlier Results or Changes outcome.
      if (!state.uncertain) {
        setAux(null);
        state.notice = {
          tone: "warning",
          message: "Source refresh failed. Last successful source retained.",
          details: [],
        };
      }
      changed();
    }
  }
  // A task without a GitHub source has no GitHub destination: the stored pointer moves to the
  // lead, so draft, notice, reference and approval all follow one destination. A reply that is
  // in flight or unresolved keeps its own until it is checked. The GitHub draft is kept.
  if (data && !data.source && state.destination === "github" && !state.frozen)
    state.destination = "lead";
  const destination = state.destination;
  // A Draft task's lead reply starts a read-only draft turn instead of queueing a message.
  // The ordinary reply stays for a lead that is missing or has started, which it already explains.
  const draftTurn =
    data &&
    !data.task.ready &&
    data.draftTurn?.reason !== "lead-unconfigured" &&
    data.draftTurn?.reason !== "lead-unavailable"
      ? data.draftTurn
      : undefined;
  async function send() {
    if (!state.draft.trim() || pending) return;
    if (state.frozen) {
      await command(state.frozen);
      return;
    }
    const key = crypto.randomUUID();
    let input: OperatorCommand;
    if (destination === "lead" && draftTurn) {
      if (!draftTurn.available) return;
      input = {
        type: "task.draft-turn",
        key,
        taskId,
        expectedVersion: data?.task.version ?? 0,
        message: state.draft,
      };
    } else if (destination === "lead") {
      if (!lead) return;
      input = {
        type: "message",
        key,
        taskId,
        recipientAssignmentId: lead.assignmentId,
        expectedAssignmentVersion: lead.version,
        message: state.draft,
        ...(state.reference ? { reference: state.reference } : {}),
      };
    } else {
      if (!data?.source) return;
      input = {
        type: "comment.send",
        key: state.commentReview?.operationId ?? key,
        taskId,
        expectedTaskVersion: data?.task.version ?? 0,
        body: state.draft,
        ...(state.commentReview
          ? { reviewId: state.commentReview.reviewId }
          : {}),
      };
    }
    state.frozen = structuredClone(input);
    await command(input);
  }
  const viewedIndexes =
    review?.viewed?.resultIds.map((id) =>
      data.results.findIndex((r) => r.resultId === id),
    ) ?? [];
  const newestViewed = Math.max(-1, ...viewedIndexes);
  const changes = review?.viewed
    ? `${newestViewed >= 0 ? `${data.results.length - newestViewed - 1} new result(s)` : "Newer results unknown; no retained viewed result ordering"}; ${sourceObservation === "pending" ? "source comparison pending" : sourceObservation === "unknown" ? "source comparison unknown; current source state unavailable" : review.viewed.sourceId !== latestSource?.sourceId ? "source requirements changed" : "source unchanged"}`
    : "No viewing baseline. Comparison with previously viewed material is unknown.";
  // Each collapsed Overview card keeps its content mounted; its toggle is the one writer of
  // `state.overview`, so a poll, a refresh or "Collapse all history" never opens or closes one.
  const overviewCard = (id: OverviewCard) => ({
    open: state.overview.has(id),
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      if (event.currentTarget.open === state.overview.has(id)) return;
      if (event.currentTarget.open) state.overview.add(id);
      else state.overview.delete(id);
      changed();
    },
  });
  const criteriaMore = (key: string) => ({
    open: state.criteriaOpen.has(key),
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      if (event.currentTarget.open === state.criteriaOpen.has(key)) return;
      if (event.currentTarget.open) state.criteriaOpen.add(key);
      else state.criteriaOpen.delete(key);
      changed();
    },
  });
  const briefSummary = `Requirements · ${source?.kind === "github" || data.source ? "GitHub" : "Local"} · ${(() => {
    if (!source) return "Retained source unavailable";
    const { criteria, known } = briefParts(source),
      n = criteria.length;
    return n
      ? `${n} supplied ${n === 1 ? "criterion" : "criteria"}`
      : known
        ? "None supplied"
        : "Coverage unknown";
  })()}`;
  const evidenceSummary = selected
    ? [
        `R${data.results.indexOf(selected) + 1}`,
        ...(meta
          ? [
              count(meta.metadata.validations.length, "validation record"),
              count(meta.metadata.artifacts.length, "artifact"),
            ]
          : []),
      ].join(" · ")
    : "";
  const assignmentsSummary = data.assignments.length
    ? data.assignments
        .map((a) => {
          const row = assignmentRow(a, data.assignments);
          return `${row.id} ${row.state}`;
        })
        .join(" · ")
    : "None yet";
  // An unknown reply outcome stays until it is checked; otherwise the latest message wins.
  // Delivery's outcome shows on Changes, beside its control; the rest stay with the reply.
  const deliveryOutcome = aux?.from === "delivery.refresh" ? aux : null;
  const outcome: ReplyOutcome | null = state.uncertain
    ? (state.notice ?? {
        tone: "warning",
        message: unknownMessage(state.frozen?.type ?? "message"),
        details: [],
      })
    : deliveryOutcome
      ? null
      : (aux ?? state.notice);
  // The check sits beside the control whose response was lost, which stays off meanwhile.
  const unconfirmedCheck = (type: "review.view" | "delivery.refresh") =>
    !pending &&
    unconfirmed?.input.type === type && (
      <ActionOutcome
        tone="warning"
        message={unconfirmed.outcome.message}
        details={unconfirmed.outcome.details}
        focus={focusUnconfirmed.current}
        action={{
          label: "Check whether it saved",
          onClick: () => command(unconfirmed.input),
        }}
      />
    );
  const comment = commentAvailability(data.commentPolicy);
  // Exactly one sentence sits above the box: what this destination does now.
  const replyNote =
    destination === "lead" && draftTurn
      ? draftTurn.available
        ? `${draftTurnAccessNotice(leadName)} ${draftTurnQueueNotice(leadName)}`
        : draftTurnUnavailableNotice(
            draftTurn.reason ?? "lead-unavailable",
            leadName,
            data.task.state,
          )
      : destination === "lead"
        ? !lead
          ? "This project has no lead to message yet."
          : leadMode === "resumes"
            ? leadResumeNotice(leadName)
            : leadMode === "receives"
              ? leadReceivesNotice(leadName)
              : leadUnavailableNotice(leadName)
        : (comment.sentence ??
          (data.commentPolicy?.mode === "approval"
            ? "You review the exact comment before it posts to the GitHub issue."
            : "Posts a comment on the GitHub issue."));
  const reply = (
    <section id="reply" className="reply-card">
      <h3 className="section-heading">Reply</h3>
      <div className="task-actions">
        <Button
          variant={destination === "lead" ? "primary" : "secondary"}
          disabled={pending || state.uncertain}
          onClick={() => {
            state.destination = "lead";
            changed();
          }}
        >
          {draftTurn ? draftTurnHeading(leadName) : "Message task lead"}
        </Button>
        {data.source && (
          <Button
            variant={destination === "github" ? "primary" : "secondary"}
            // Native `disabled` is out of the tab order; an unavailable tab stays focusable so
            // its reason is read.
            disabled={pending || state.uncertain}
            aria-disabled={!comment.postable || undefined}
            aria-describedby={comment.postable ? undefined : githubReasonId}
            title={comment.sentence ?? undefined}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (!comment.postable) return;
              state.destination = "github";
              changed();
            }}
          >
            Post GitHub comment
          </Button>
        )}
        {data.source && comment.sentence && (
          <span id={githubReasonId} className="sr-only">
            {comment.sentence}
          </span>
        )}
      </div>
      {destination === "lead" && lead && leadMode === "resumes" ? (
        <p role="status">{replyNote}</p>
      ) : (
        <p className="metadata muted">{replyNote}</p>
      )}
      <label htmlFor="workspace-reply">Editable reply</label>
      <Textarea
        id="workspace-reply"
        value={state.draft}
        disabled={pending || state.uncertain}
        onChange={(e) => {
          state.draft = e.target.value;
          if (state.notice?.tone === "success") state.notice = null;
          if (destination === "github") state.commentReview = null;
          changed();
        }}
        rows={5}
      />
      {destination === "lead" && state.reference && (
        <p>Immutable reference: {JSON.stringify(state.reference)}</p>
      )}
      {destination === "github" && data.commentPolicy?.mode === "approval" && (
        <>
          <Button
            disabled={
              pending ||
              state.uncertain ||
              !state.draft.trim() ||
              !comment.postable
            }
            onClick={() =>
              void command({
                type: "comment.review",
                key: crypto.randomUUID(),
                operationId: crypto.randomUUID(),
                taskId,
                expectedTaskVersion: data.task.version,
                body: state.draft,
              })
            }
          >
            Review exact GitHub comment
          </Button>
          {state.commentReview && (
            <CommentReview
              record={state.commentReview}
              disabled={pending || state.uncertain}
              confirm={(decision) => {
                const review = state.commentReview;
                if (!review) return;
                void command({
                  type: "comment.confirm",
                  key: crypto.randomUUID(),
                  taskId,
                  reviewId: review.reviewId,
                  expectedRevision: review.revision,
                  materialHash: review.materialHash,
                  decision,
                });
              }}
            />
          )}
        </>
      )}
      {(pending || !state.uncertain) && (
        <Button
          disabled={
            pending ||
            !state.draft.trim() ||
            (destination === "lead" &&
              (draftTurn
                ? !draftTurn.available
                : !lead || leadMode === "unavailable") &&
              !state.uncertain) ||
            (destination === "github" &&
              (!comment.postable ||
                (data.commentPolicy?.mode === "approval" &&
                  state.commentReview?.decision !== "approved")) &&
              !state.uncertain)
          }
          onClick={() => void send()}
        >
          {pending
            ? "Sending…"
            : destination === "lead"
              ? draftTurn
                ? draftTurnStart
                : "Send to task lead"
              : "Post comment"}
        </Button>
      )}
      {!pending && outcome && (
        <ActionOutcome
          // A new message starts with Details collapsed.
          key={`${outcome.tone}:${outcome.details.find(([label]) => label === "Request key")?.[1]}`}
          tone={outcome.tone}
          message={outcome.message}
          focus={(sent.current && state.uncertain) || checking.current}
          details={outcome.details}
          action={
            state.uncertain
              ? {
                  label: "Check whether it saved",
                  onClick: () => {
                    checking.current = true;
                    return send();
                  },
                }
              : undefined
          }
        />
      )}
    </section>
  );
  const publishPolicy = data.publication;
  const publishShown = publishPolicy ? (publishOpen ?? publishWork) : false;
  const improvePolicy = data.issueEdit;
  const improveShown = improvePolicy
    ? (improveOpen ?? hasImproveWork(taskId, improvePolicy))
    : false;
  return (
    <LocalReviewProvider
      client={client}
      session={session}
      taskId={taskId}
      state={state.review}
      changed={changed}
      reveal={() => selectTab("review")}
      lead={
        lead
          ? {
              assignmentId: lead.assignmentId,
              version: lead.version,
              name: leadName,
              state: lead.state,
              feedbackMode: leadMode,
              awaitingRecoveryMessage:
                data.leadFeedback?.awaitingRecoveryMessage ?? false,
            }
          : null
      }
    >
      <article className="task-workspace" aria-label="Task workspace">
        <ResourceStatus state={resource.state} retry={refreshAll} />
        <TaskStrip data={data} onNext={() => reveal("decisions")}>
          <div className="task-actions task-tools">
            {data.source && (
              <>
                <ActionLink variant="secondary" href={data.source.url ?? "#"}>
                  Open GitHub to edit source
                </ActionLink>
                {improvePolicy && (
                  <Button
                    variant="secondary"
                    aria-expanded={improveShown}
                    onClick={() => setImproveOpen(!improveShown)}
                  >
                    Improve with lead
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => void refreshSource()}
                >
                  Refresh source
                </Button>
              </>
            )}
            {!data.source && publishPolicy && (
              <Button
                variant="secondary"
                aria-expanded={publishShown}
                onClick={() => setPublishOpen(!publishShown)}
              >
                Publish to GitHub
              </Button>
            )}
            <Button variant="secondary" onClick={refreshAll}>
              Refresh task
            </Button>
          </div>
        </TaskStrip>
        {publishPolicy && publishShown && (
          <PublishToGitHub
            client={client}
            csrfToken={session.csrfToken}
            taskId={taskId}
            taskVersion={data.task.version}
            policy={publishPolicy}
            onChanged={refreshAll}
            onClose={() => setPublishOpen(false)}
          />
        )}
        {improvePolicy && improveShown && (
          <ImproveWithLead
            client={client}
            csrfToken={session.csrfToken}
            taskId={taskId}
            taskVersion={data.task.version}
            policy={improvePolicy}
            leadName={leadName}
            releaseDraft={releaseDraft}
            onChanged={refreshAll}
          />
        )}
        <TaskTabs
          tab={state.tab}
          select={selectTab}
          notes={
            state.review.unconfirmed
              ? { review: "A review write needs a check" }
              : {}
          }
        />
        {updates && (
          <Button
            onClick={() => {
              // The latest messages are at the end of History.
              selectTab("history");
              scrollTo(0, document.documentElement.scrollHeight);
              setUpdates(false);
            }}
          >
            New updates — jump to latest
          </Button>
        )}
        <TabPanel tab="overview" active={state.tab}>
          <div className="task-overview">
            <div className="task-columns">
              <section
                id="decisions"
                className="workspace-attention decision-card"
                data-attention={openRequests.length > 0 || undefined}
                aria-label="Pending requests and holds"
              >
                <h3 className="sr-only">Decisions and holds</h3>
                {params.get("request") && (
                  <QuestionResponse
                    client={client}
                    session={session}
                    taskId={taskId}
                    interactionId={params.get("request")!}
                    states={questionStates}
                    onRecorded={refreshAll}
                    observedAt={resource.state.fetchedAt}
                    requesterName={requesterOf(params.get("request"))}
                  />
                )}
                {openRequests
                  .filter((q) => q.interactionId !== params.get("request"))
                  .map((q) => (
                    <div
                      key={q.interactionId}
                      className="decision"
                      data-record-id={q.interactionId}
                    >
                      <p className="small-heading">
                        Your decision ·{" "}
                        {q.kind === "approval"
                          ? "approval pending"
                          : "question pending"}
                      </p>
                      {q.kind === "question" ? (
                        <RequestText
                          client={client}
                          session={session}
                          taskId={taskId}
                          interactionId={q.interactionId}
                          prompt={q.prompt}
                          observedAt={resource.state.fetchedAt}
                        />
                      ) : (
                        <Literal text={q.prompt} />
                      )}
                      {q.kind === "approval" && (
                        <p className="metadata muted">
                          Action: {q.action ?? "Unavailable"} · Target:{" "}
                          {q.target ?? "Unavailable"} · revision {q.revision} ·
                          Exact reviewed material:{" "}
                          {q.materialHash ?? "Unavailable"}
                        </p>
                      )}
                      <ActionLink
                        variant="secondary"
                        href={
                          q.kind === "question"
                            ? `/app/tasks/${taskId}?request=${q.interactionId}`
                            : `/coordination/task/${taskId}#${q.interactionId}`
                        }
                      >
                        {q.kind === "approval"
                          ? "Review material & decide"
                          : "Answer question"}
                      </ActionLink>
                    </div>
                  ))}
                {data.completionRequests
                  .filter((r) => r.status === "pending")
                  .map((r) => (
                    <ActionLink
                      key={r.requestId}
                      variant="secondary"
                      href={`/coordination/task/${taskId}`}
                    >
                      Pending completion review
                    </ActionLink>
                  ))}
                {data.unresolvedResults.length > 0 && (
                  <ActionLink
                    variant="secondary"
                    href={`/coordination/task/${taskId}`}
                  >
                    Unresolved result delivery
                  </ActionLink>
                )}
                {nextActor.code === "completion-rejected" && (
                  <ActionLink
                    variant="secondary"
                    href={`/coordination/task/${taskId}`}
                  >
                    Review rejected completion
                  </ActionLink>
                )}
                {nextActor.code === "execution-uncertain" &&
                  !data.execution.holds.uncertainty && (
                    <ActionLink
                      variant="secondary"
                      href={`/runtime/task/${taskId}`}
                    >
                      Inspect uncertain execution
                    </ActionLink>
                  )}
                {/* The holds the open requests, the selected one included, do not clear: once, in
                    the Inbox's wording. */}
                {openRequests.length > 0 && (
                  <QuestionHolds
                    holds={holdNoticesBesideRequests(
                      data,
                      // The selected request's action names the wording; otherwise any approval.
                      (inView?.kind ??
                        (openRequests.some((q) => q.kind === "approval")
                          ? "approval"
                          : "question")) === "approval"
                        ? "approve"
                        : "answer",
                      deciding,
                    )}
                  />
                )}
                {!nextActor.operator &&
                  !data.completionRequests.some(
                    (r) => r.status === "pending",
                  ) &&
                  !data.waits.length &&
                  !Object.values(data.execution.holds).some(Boolean) && (
                    <p className="muted">No operator decision needed.</p>
                  )}
                {/* The merged approval wait is left out: the open approvals are rows above, and the
                    hold line names the others when one is selected. */}
                <WaitReasons
                  waits={data.waits.filter((wait) => wait.code !== "approval")}
                  taskId={taskId}
                  projectId={data.task.projectId}
                  client={client}
                  session={session}
                  drafts={drafts}
                  workspace={workspace ?? null}
                  onChanged={refreshAll}
                  holds={holdLines(data.execution.holds, data.taskHold)}
                  executionHref={`/runtime/task/${taskId}`}
                />
              </section>
              <section id="review">
                <h3 className="section-heading">Latest result</h3>
                {state.selectedResult && !selected && (
                  <p role="alert">
                    Exact selected result is unavailable. A newer result is not
                    substituted.
                  </p>
                )}
                {selected ? (
                  <div data-record-id={selected.resultId}>
                    <p className="metadata muted">
                      R{data.results.indexOf(selected) + 1} ·{" "}
                      <ShortId value={selected.resultId} /> · assignment{" "}
                      <ShortId value={selected.assignmentId} /> · work revision{" "}
                      {selected.workRevision} · {date(selected.createdAt)}
                    </p>
                    <Literal text={selected.summary} />
                    <p className="metadata">
                      <ActionLink
                        variant="secondary"
                        href={`/app/tasks/${taskId}?section=changes&result=${selected.resultId}`}
                      >
                        {meta?.metadata.changes
                          ? `Changes · ${meta.metadata.changes.files.length} ${meta.metadata.changes.files.length === 1 ? "file" : "files"}`
                          : "Changes"}
                      </ActionLink>
                    </p>
                    {meta ? (
                      <CriteriaRows
                        data={data}
                        resultId={selected.resultId}
                        sourceId={meta.metadata.sourceId}
                        ask={ask}
                        more={criteriaMore(
                          `${selected.resultId}:${meta.metadata.sourceId}`,
                        )}
                      />
                    ) : (
                      <p>
                        No structured review evidence was supplied for this
                        result.
                      </p>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() =>
                        ask(
                          {
                            resultId: selected.resultId,
                            workId: selected.workId,
                            ...(meta?.metadata.sourceId
                              ? { sourceId: meta.metadata.sourceId }
                              : {}),
                          },
                          `result ${selected.resultId}`,
                        )
                      }
                    >
                      Ask lead about result
                    </Button>
                  </div>
                ) : (
                  !state.selectedResult && <p>No result recorded.</p>
                )}
                {/* A viewing reference needs a result to view; a lost response stays checkable. */}
                {data.results.length > 0 && (
                  <>
                    <p className="metadata muted">{changes}</p>
                    <Button
                      variant="secondary"
                      data-unconfirmed-control="review.view"
                      onClick={() =>
                        void command({
                          type: "review.view",
                          key: crypto.randomUUID(),
                          taskId,
                          sourceId: state.selectedSource
                            ? (source?.sourceId ?? null)
                            : selected
                              ? (meta?.metadata.sourceId ?? null)
                              : (source?.sourceId ?? null),
                          resultIds: selected ? [selected.resultId] : [],
                        })
                      }
                      disabled={
                        Boolean(state.selectedResult && !selected) ||
                        Boolean(state.selectedSource && !source) ||
                        Boolean(unconfirmed)
                      }
                    >
                      Set viewing reference
                    </Button>
                  </>
                )}
                {unconfirmedCheck("review.view")}
                {data.results.length > 0 && (
                  <p>
                    Viewing records availability only; it does not approve work
                    or clear holds. Retained records may be incomplete.
                  </p>
                )}
                <label htmlFor="retained-result-revision">
                  Result revision{" "}
                  <NativeSelect
                    id="retained-result-revision"
                    className="control"
                    value={state.selectedResult ?? ""}
                    onChange={(e) => {
                      state.selectedResult = e.target.value || null;
                      changed();
                    }}
                  >
                    <option value="">Latest result</option>
                    {data.results.map((r, i) => (
                      <option key={r.resultId} value={r.resultId}>
                        R{i + 1}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              </section>
              {reply}
              <section id="brief">
                <details
                  className="overview-disclosure"
                  {...overviewCard("brief")}
                >
                  <summary>
                    <h3 className="section-heading">Shared brief</h3>
                    <span className="metadata muted">{briefSummary}</span>
                  </summary>
                  {state.selectedSource && !source && (
                    <p role="alert">
                      Selected source revision is unavailable. Current
                      requirements are not substituted.
                    </p>
                  )}
                  {source &&
                    (() => {
                      const brief = briefParts(source);
                      return (
                        <>
                          {brief.prose && (
                            <div className="brief-prose">
                              <MarkdownPreview text={brief.prose} />
                            </div>
                          )}
                          <h4 className="small-heading">
                            Supplied acceptance criteria
                          </h4>
                          {brief.criteria.length ? (
                            <ol className="brief-criteria">
                              {brief.criteria.map((c) => (
                                <li key={c.criterionId}>
                                  <span className="criterion-label">
                                    {c.label}
                                  </span>
                                  <span>{c.text}</span>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            brief.known && <p>None supplied</p>
                          )}
                          <p className="metadata muted">
                            {source.kind === "github" ? "GitHub" : "Local"}{" "}
                            source · revision {source.revision} ·{" "}
                            <ShortId value={source.sourceId} />
                          </p>
                          <Disclosure
                            id={source.sourceId}
                            title={`${source.title ?? "Brief"} — read supplied text`}
                            text={source.body}
                            state={state}
                            changed={changed}
                          />
                          <ChecklistCoverage source={source} />
                          <Button
                            variant="secondary"
                            onClick={() =>
                              ask(
                                { sourceId: source.sourceId },
                                `source revision ${source.revision}`,
                              )
                            }
                          >
                            Ask lead about brief
                          </Button>
                        </>
                      );
                    })()}
                  {!source && <p>{sourceGap}</p>}
                  {!source && !state.selectedSource && (
                    <Literal text={data.task.outcome} />
                  )}
                  <label htmlFor="retained-source-revision">
                    Retained source revision{" "}
                    <NativeSelect
                      id="retained-source-revision"
                      className="control"
                      value={state.selectedSource ?? ""}
                      onChange={(e) => {
                        state.selectedSource = e.target.value || null;
                        changed();
                      }}
                    >
                      <option value="">Latest</option>
                      {sources.map((s) => (
                        <option key={s.sourceId} value={s.sourceId}>
                          Revision {s.revision}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                </details>
              </section>
              {selected && (
                <section id="result-evidence">
                  <details
                    className="overview-disclosure"
                    {...overviewCard("evidence")}
                  >
                    <summary>
                      <h3 className="section-heading">Evidence</h3>
                      <span className="metadata muted">{evidenceSummary}</span>
                    </summary>
                    <div>
                      {meta && (
                        <ReviewEvidence
                          data={data}
                          resultId={selected.resultId}
                          sourceId={meta.metadata.sourceId}
                          ask={ask}
                        />
                      )}
                      <RetainedResultEvidence
                        key={selected.resultId}
                        client={client}
                        session={session}
                        taskId={taskId}
                        resultId={selected.resultId}
                        state={state.retained(selected.resultId)}
                        changed={changed}
                        openCurrent={(scope, filePath) => {
                          state.files.openCurrentFile(scope, filePath);
                          changed();
                          requestAnimationFrame(() => reveal("files"));
                        }}
                      />
                    </div>
                  </details>
                </section>
              )}
              <section id="assignments">
                <details
                  className="overview-disclosure"
                  {...overviewCard("assignments")}
                >
                  <summary>
                    <h3 className="section-heading">
                      Assignments · {data.assignments.length}
                    </h3>
                    <span className="metadata muted">{assignmentsSummary}</span>
                  </summary>
                  <AssignmentRows
                    assignments={data.assignments}
                    reveal={reveal}
                    open={(id) => {
                      state.chronological = false;
                      state.expanded.add(id);
                      changed();
                    }}
                  />
                </details>
              </section>
              <p className="metadata muted task-pointer">
                Captured conversations, earlier results and delivery evidence
                are in History, Changes and Review.
              </p>
            </div>
            <TaskInspector
              data={data}
              deciding={deciding}
              selectResult={(resultId) => {
                state.selectedResult = resultId;
                changed();
                requestAnimationFrame(() => reveal("review"));
              }}
            />
          </div>
        </TabPanel>
        <TabPanel tab="files" active={state.tab}>
          <TaskFiles
            client={client}
            session={session}
            taskId={taskId}
            state={state.files}
            changes={state.changes}
          />
        </TabPanel>
        <TabPanel tab="changes" active={state.tab}>
          <Changes
            data={data}
            selected={meta}
            client={client}
            session={session}
            taskId={taskId}
            state={state}
            changed={changed}
            refresh={() =>
              void command({
                type: "delivery.refresh",
                key: crypto.randomUUID(),
                taskId,
              })
            }
            refreshDisabled={Boolean(unconfirmed)}
            unconfirmed={unconfirmedCheck("delivery.refresh")}
            outcome={
              !pending &&
              !state.uncertain &&
              deliveryOutcome && (
                <ActionOutcome
                  key={`${deliveryOutcome.tone}:${deliveryOutcome.message}`}
                  tone={deliveryOutcome.tone}
                  message={deliveryOutcome.message}
                  details={deliveryOutcome.details}
                />
              )
            }
          />
        </TabPanel>
        <TabPanel tab="review" active={state.tab}>
          <LocalReviewPanel />
        </TabPanel>
        <TabPanel tab="history" active={state.tab}>
          <p className="metadata">
            {/* Server-rendered page outside the app shell: a plain anchor loads it as a document. */}
            <a href={`/coordination/task/${encodeURIComponent(taskId)}`}>
              Approval and delivery forms
            </a>
          </p>
          <section id="context">
            <h3 className="section-heading">Captured context</h3>
            <p>
              Captured preparation records distinguish supplied material from
              current configuration. Availability is not proof that an agent
              read it.
            </p>
            {!!review?.contextsOmittedCount && (
              <p role="status">
                Partial captured context coverage: {review.contextsOmittedCount}{" "}
                retained preparation records are not shown.
              </p>
            )}
            {review?.contexts.length ? (
              review.contexts.map((c) => (
                <div key={c.captureId} data-record-id={c.captureId}>
                  <p>
                    Supplier {c.supplier} · assignment {c.assignmentId} revision{" "}
                    {c.assignmentVersion} · {c.workId ?? "assignment creation"}{" "}
                    · captured {date(c.createdAt)}
                  </p>
                  <p>
                    Profile revision {c.profileRevision}; instructions revision{" "}
                    {c.instructionsRevision}; source{" "}
                    {c.sourceId ?? "unavailable"}
                  </p>
                  <Disclosure
                    id={c.captureId}
                    title="Captured brief"
                    text={c.brief}
                    state={state}
                    changed={changed}
                  />
                </div>
              ))
            ) : (
              <p>
                No retained context capture for this legacy task. Current
                settings are not reconstructed as history.
              </p>
            )}
            {data.assignments.map((a) => (
              <p key={a.assignmentId}>
                Current assignment {a.assignmentId}: profile revision{" "}
                {a.currentProfileRevision}, instructions revision{" "}
                {a.currentInstructionsRevision}
              </p>
            ))}
          </section>
          <section id="history">
            <h3 className="section-heading">
              Assignments and retained history
            </h3>
            <div className="task-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  for (const a of data.assignments)
                    state.expanded.add(a.assignmentId);
                  for (const h of Object.values(histories)) {
                    for (const i of h.items)
                      state.expanded.add(`${i.workId}:${i.itemId}`);
                    for (const i of h.turnOmissions)
                      state.expanded.add(
                        `turn-omission:${i.workId}:${i.threadId}:${i.turnId}`,
                      );
                  }
                  changed();
                }}
              >
                Expand all history
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  state.expanded.clear();
                  changed();
                }}
              >
                Collapse all history
              </Button>
              <Button
                variant="secondary"
                aria-pressed={state.chronological}
                onClick={() => {
                  state.chronological = !state.chronological;
                  changed();
                }}
              >
                Chronological view
              </Button>
            </div>
            <p>
              Source-faithful captured text; no generated summaries or
              full-transcript promise. Redaction and retention can omit content.
            </p>
            {state.chronological ? (
              <div>
                {Object.values(histories)
                  .flatMap((h) => [...h.items, ...h.turnOmissions])
                  .sort((a, b) => {
                    const time = a.createdAt - b.createdAt;
                    if (time) return time;
                    const aOmission = "reason" in a,
                      bOmission = "reason" in b;
                    return aOmission === bOmission
                      ? a.sequence - b.sequence
                      : aOmission
                        ? 1
                        : -1;
                  })
                  .map((i) =>
                    "reason" in i ? (
                      <TurnOmission
                        key={`turn-omission:${i.workId}:${i.threadId}:${i.turnId}`}
                        omission={i}
                        state={state}
                        changed={changed}
                      />
                    ) : (
                      <Disclosure
                        key={`${i.workId}:${i.itemId}`}
                        id={`${i.workId}:${i.itemId}`}
                        title={`${date(i.createdAt)} · ${i.assignmentId} · ${i.lifecycle}`}
                        text={
                          i.text ??
                          `Omitted: ${i.omissionReason ?? "unavailable"}`
                        }
                        state={state}
                        changed={changed}
                      />
                    ),
                  )}
              </div>
            ) : (
              data.assignments.map((a) => {
                const execution = executionSummary(a);
                return (
                  <details
                    key={a.assignmentId}
                    data-record-id={a.assignmentId}
                    open={state.expanded.has(a.assignmentId)}
                    onToggle={(e) => {
                      if (e.currentTarget.open)
                        state.expanded.add(a.assignmentId);
                      else state.expanded.delete(a.assignmentId);
                      changed();
                    }}
                  >
                    <summary>
                      {a.name ?? "Assignment"} · {a.state} · version {a.version}
                    </summary>
                    <p>
                      Assignment {a.assignmentId} · profile revision{" "}
                      {a.profileRevision} · instructions revision{" "}
                      {a.instructionsRevision}
                    </p>
                    <p>Supplied responsibility / brief</p>
                    <Literal text={a.brief} />
                    <p>
                      {`Requester assignment: ${a.requesterAssignmentId ?? "Not recorded"}; result destination: ${a.resultDestination ?? "Unavailable"}; resolved recipient: ${a.resultRecipientAssignmentId ?? "Unavailable"} (${a.resultRecipientDisposition ?? "Unknown disposition"}).`}
                    </p>
                    <p>
                      Execution: {execution.line}
                      {a.executionGeneration
                        ? ` · work ${a.executionGeneration.workId} · request sequence ${a.executionGeneration.requestSequence} · assignment version ${a.executionGeneration.assignmentVersion} · profile revision ${a.executionGeneration.profileRevision} · instructions revision ${a.executionGeneration.instructionsRevision}`
                        : " · not yet admitted"}
                      .
                    </p>
                    {execution.note && (
                      <p className="metadata muted">{execution.note}</p>
                    )}
                    <p>
                      Recorded wait / execution reason:{" "}
                      {a.waitReason ?? "No recorded wait reason; unknown"}.
                    </p>
                    <ExecutionNotices assignment={a} />
                    <details>
                      <summary>
                        Effective execution policy ·{" "}
                        {executionHarnessLabels[execution.harness]}
                      </summary>
                      {execution.harness === "codex" && (
                        <CommandNetworkLine
                          generation={a.executionGeneration}
                        />
                      )}
                      <PolicyDisclosure
                        harness={execution.harness}
                        workspace={workspace}
                      />
                    </details>
                    {data.results
                      .filter((r) => r.assignmentId === a.assignmentId)
                      .map((r) => (
                        <p key={r.resultId}>
                          <ActionLink
                            href={`/app/tasks/${taskId}?section=review&assignment=${a.assignmentId}&result=${r.resultId}`}
                          >
                            Open exact assignment result {r.resultId}
                          </ActionLink>
                        </p>
                      ))}
                    <ActionLink
                      href={`/coordination/assignment/${a.assignmentId}`}
                    >
                      Advanced assignment and history controls
                    </ActionLink>
                    {historyErrors[a.assignmentId] && (
                      <p role="alert">
                        History refresh failed: {historyErrors[a.assignmentId]}.
                        Unvalidated history is hidden; retry to read current
                        material.
                      </p>
                    )}
                    <p className="literal-preview">
                      {histories[a.assignmentId]?.items
                        .at(-1)
                        ?.text?.slice(0, 500) ??
                        "Recent captured text unavailable"}
                    </p>
                    {histories[a.assignmentId]?.omittedItemCount ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          capture();
                          void loadHistory(
                            a.assignmentId,
                            histories[a.assignmentId]?.items[0]?.sequence,
                          );
                        }}
                      >
                        Load earlier retained history (
                        {histories[a.assignmentId]?.omittedItemCount})
                      </Button>
                    ) : null}
                    {histories[a.assignmentId]?.omittedTurnCount ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          capture();
                          void loadHistory(
                            a.assignmentId,
                            undefined,
                            histories[a.assignmentId]?.turnOmissions[0]
                              ?.sequence,
                          );
                        }}
                      >
                        Load earlier retained turn omissions (
                        {histories[a.assignmentId]?.omittedTurnCount})
                      </Button>
                    ) : null}
                    {histories[a.assignmentId]?.items.map((i) => (
                      <Disclosure
                        key={`${i.workId}:${i.itemId}`}
                        id={`${i.workId}:${i.itemId}`}
                        title={`${date(i.createdAt)} · ${i.lifecycle} · ${i.itemId}`}
                        text={
                          i.text ??
                          `Omitted: ${i.omissionReason ?? "unavailable"}`
                        }
                        state={state}
                        changed={changed}
                      />
                    ))}
                    {histories[a.assignmentId]?.turnOmissions.map((i) => (
                      <TurnOmission
                        key={`turn-omission:${i.workId}:${i.threadId}:${i.turnId}`}
                        omission={i}
                        state={state}
                        changed={changed}
                      />
                    ))}
                    <Button
                      variant="secondary"
                      onClick={() => void loadHistory(a.assignmentId)}
                    >
                      Refresh captured history
                    </Button>
                  </details>
                );
              })
            )}
            {data.messages.map((m) => (
              <div key={m.eventId} data-record-id={m.eventId}>
                <p>
                  {m.eventType}
                  {m.requester
                    ? ` · requested by ${m.requester === "assignment" ? "agent" : "operator"}`
                    : ""}{" "}
                  · {m.deliveryState} · {date(m.createdAt)}
                </p>
                <Literal text={m.text} />
                {m.questionAnswers &&
                  Object.entries(m.questionAnswers).map(([id, a]) => (
                    <div key={id}>
                      <p>
                        Question {id}: {a.optionIds.join(", ")}
                      </p>
                      <Literal text={a.text} />
                    </div>
                  ))}
                {m.reference && (
                  <p>Exact feedback reference: {JSON.stringify(m.reference)}</p>
                )}
              </div>
            ))}
          </section>
        </TabPanel>
      </article>
    </LocalReviewProvider>
  );
}
function CommentReview({
  record,
  confirm,
  disabled,
}: {
  record: Extract<CommandReceipt, { kind: "comment-review" }>;
  confirm: (d: "approved" | "denied") => void;
  disabled: boolean;
}) {
  return (
    <div className="workspace-attention">
      <h4>Exact operator comment review</h4>
      <Literal text={record.body} />
      <p>
        Issue {record.target.nodeId} #{record.target.number} · repository{" "}
        {record.target.repositoryId}
      </p>
      <p>
        Task revision {record.taskVersion}; source {record.sourceId} revision{" "}
        {record.sourceRevision}; policy {record.policyVersion}; operation{" "}
        {record.operationId}; review {record.revision} · {record.decision}
      </p>
      <p>Material {record.materialHash}</p>
      {record.decision === "pending" && (
        <>
          <Button disabled={disabled} onClick={() => confirm("approved")}>
            Confirm exact comment
          </Button>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => confirm("denied")}
          >
            Deny comment
          </Button>
          <p>Leave pending by continuing without confirming.</p>
        </>
      )}
    </div>
  );
}
/** Supplied criteria as C1/C2 rows with the result's recorded outcome; no overall pass. */
function CriteriaRows({
  data,
  resultId,
  sourceId,
  ask,
  more,
}: {
  data: TaskRead["data"];
  resultId: string;
  sourceId: string | undefined;
  ask: (r: Reference, label: string) => void;
  /** The "N more" disclosure's open state, kept on the history entry like the Overview cards. */
  more: {
    open: boolean;
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => void;
  };
}) {
  const s = data.review?.sources.find((s) => s.sourceId === sourceId),
    latest = data.review?.sources.at(-1),
    rows = criterionRows(data, resultId, sourceId);
  const criterionRow = (row: (typeof rows)[number]) => (
    <div
      key={row.criterionId}
      className="criterion-row"
      data-record-id={row.criterionId}
    >
      <p>
        {row.label} · {row.status}
        {row.stale ? " · stale source revision" : ""}
      </p>
      <p>{row.text}</p>
      <p className="metadata muted">
        {[
          `Source revision ${row.revision}`,
          row.record?.scope,
          row.record?.provenance,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {row.records.length > 1 && (
        <div>
          <p>Duplicate criterion identity; overall outcome unknown.</p>
          <Literal
            text={row.records
              .map((record) =>
                [record.outcome, record.scope, record.provenance]
                  .filter(Boolean)
                  .join(" · "),
              )
              .join("\n")}
          />
        </div>
      )}
      <Button
        variant="secondary"
        onClick={() =>
          ask(
            {
              resultId,
              sourceId: sourceId as string,
              criterionId: row.criterionId,
            },
            `criterion ${row.position + 1} in source revision ${row.revision}`,
          )
        }
      >
        Ask lead about criterion
      </Button>
    </div>
  );
  return (
    <div className="criteria-rows">
      <h4 className="small-heading">
        {!s || s.body === null
          ? "Supplied criteria — coverage unavailable"
          : "Supplied criteria"}
      </h4>
      <ChecklistCoverage source={s} />
      {s && s.body !== null && !s.criteria.length && (
        <p>
          No literal checklist records. Consult the supplied brief prose for
          requirements.
        </p>
      )}
      {rows.slice(0, 3).map(criterionRow)}
      {rows.length > 3 && (
        <details className="criteria-more" {...more}>
          <summary>{rows.length - 3} more</summary>
          {rows.slice(3).map(criterionRow)}
        </details>
      )}
      {latest && s && latest.sourceId !== s.sourceId && (
        <p>
          Newer source revision {latest.revision} has requirements not covered
          by this historical result.
        </p>
      )}
      {latest && s && latest.sourceId !== s.sourceId && (
        <div>
          <h4>
            Current supplied criteria not covered by this historical result
          </h4>
          {latest.criteria.map((c) => (
            <p key={c.criterionId}>
              {c.text} · unverified for source revision {latest.revision}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
function ReviewEvidence({
  data,
  resultId,
  sourceId,
  ask,
}: {
  data: TaskRead["data"];
  resultId: string;
  sourceId: string | undefined;
  ask: (r: Reference, label: string) => void;
}) {
  const metadata = data.review?.results.find(
    (r) => r.resultId === resultId,
  )?.metadata;
  if (!metadata) return null;
  return (
    <>
      {metadata.decisions
        .map((d, i) => ({ d, recordId: `${resultId}:decision:${i}` }))
        .map(({ d, recordId }) => (
          <div key={recordId} data-record-id={recordId}>
            <h4>Recorded decision</h4>
            <p>{d.attribution}</p>
            <Literal text={d.text} />
          </div>
        ))}
      <h4>Validation records</h4>
      {metadata.validations.length ? (
        metadata.validations.map((v) => {
          const head = data.delivery?.binding?.headSha,
            unknown =
              !v.checkedHead || !head || data.delivery?.binding?.readError;
          return (
            <p key={`${v.label}:${v.scope}:${v.provenance}`}>
              {v.label}: {v.outcome} · {v.scope} · {v.provenance} ·{" "}
              {v.checkedHead && (
                <>
                  checked head <ShortId value={v.checkedHead} /> ·{" "}
                </>
              )}
              {unknown
                ? "Head comparison unknown"
                : v.checkedHead === head
                  ? "Matches the current pull request head"
                  : "Checked an earlier head than the current pull request head"}
            </p>
          );
        })
      ) : (
        <p>No supplied validation record. No overall pass is inferred.</p>
      )}
      <h4>Recorded comparisons and evidence</h4>
      {!metadata.artifacts.length && <p>No artifact evidence supplied.</p>}
      {[
        ...new Set(
          metadata.artifacts.map((a) => a.pairId ?? `unpaired:${a.artifactId}`),
        ),
      ].map((pair) => {
        const group = metadata.artifacts.filter(
          (a) => (a.pairId ?? `unpaired:${a.artifactId}`) === pair,
        );
        return (
          <section key={pair} data-artifact-pair={pair}>
            <h5>
              {pair.startsWith("unpaired:")
                ? "Unpaired recorded evidence"
                : `Recorded pair ${pair}`}
            </h5>
            <div className="artifact-comparisons">
              {["before", "after", "evidence"].map((role) => (
                <div key={role} data-artifact-role={role}>
                  {group
                    .filter((a) => a.role === role)
                    .map((a) =>
                      metadata.artifacts.filter(
                        (v) => v.artifactId === a.artifactId,
                      ).length > 1 ? (
                        <p key={`${a.artifactId}:${role}:${a.label}`}>
                          Duplicate artifact identity {a.artifactId}; preview
                          and feedback unavailable.
                        </p>
                      ) : (
                        <Artifact
                          key={a.artifactId}
                          taskId={data.task.id}
                          artifact={a}
                          ask={() =>
                            ask(
                              {
                                resultId,
                                artifactId: a.artifactId,
                                ...(sourceId ? { sourceId } : {}),
                              },
                              `${a.role} artifact ${a.label}`,
                            )
                          }
                        />
                      ),
                    )}
                  {!pair.startsWith("unpaired:") &&
                    role !== "evidence" &&
                    !group.some((a) => a.role === role) && (
                      <p>{role}: recorded side missing.</p>
                    )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      <p>
        Before/after labels and pairing are producer records. Missing sides and
        preview failures are not replaced with another revision.
      </p>
      {metadata.artifacts
        .filter((a) => a.pairId)
        .map(
          (a) =>
            !metadata.artifacts.some(
              (b) => b.pairId === a.pairId && b.role !== a.role,
            ) && (
              <p key={a.artifactId}>
                Pair {a.pairId}: opposite side unavailable.
              </p>
            ),
        )}
    </>
  );
}
function Artifact({
  taskId,
  artifact,
  ask,
}: {
  taskId: string;
  artifact: NonNullable<
    TaskRead["data"]["review"]
  >["results"][number]["metadata"]["artifacts"][number];
  ask: () => void;
}) {
  const [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  return (
    <figure data-record-id={artifact.artifactId}>
      <figcaption>
        {artifact.role}: {artifact.label} · revision {artifact.revision} · pair{" "}
        {artifact.pairId ?? "none recorded"}
      </figcaption>
      {artifact.availability === "available" ? (
        <>
          <img
            key={retry}
            loading="lazy"
            src={`/api/operator/tasks/${taskId}/artifacts/${artifact.artifactId}`}
            alt={`${artifact.role}: ${artifact.label}`}
            onError={() => setFailed(true)}
            hidden={failed}
          />
          {failed && (
            <>
              <p>
                Preview unavailable or mismatched. Recorded identity retained.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setFailed(false);
                  setRetry((n) => n + 1);
                }}
              >
                Retry recorded preview
              </Button>
            </>
          )}
          {artifact.url && (
            <ActionLink href={artifact.url}>
              Open recorded artifact link
            </ActionLink>
          )}
        </>
      ) : (
        <p>{artifact.availability}</p>
      )}
      <Button variant="secondary" onClick={ask}>
        Ask lead about artifact
      </Button>
    </figure>
  );
}
function PullRequestLine({
  binding,
}: {
  binding: NonNullable<NonNullable<TaskRead["data"]["delivery"]>["binding"]>;
}) {
  const href = safePullRequestUrl(binding.url),
    tone = {
      MERGED: "success",
      CLOSED: "warning",
      OPEN: "idle",
    } as const;
  return (
    <p>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {pullRequestReference(binding)}
          <span className="sr-only"> (opens GitHub)</span>
        </a>
      ) : (
        <>{pullRequestReference(binding)}</>
      )}{" "}
      <StatusBadge tone={tone[binding.state]}>
        {pullRequestStateLabel(binding.state, binding.draft)}
      </StatusBadge>{" "}
      head <ShortId value={binding.headSha} />
      {!href && (
        <> No GitHub link: this PR's repository name was not observed.</>
      )}
    </p>
  );
}
function Changes({
  data,
  selected,
  client,
  session,
  taskId,
  state,
  changed,
  refresh,
  refreshDisabled,
  unconfirmed,
  outcome,
}: {
  data: TaskRead["data"];
  selected:
    | NonNullable<TaskRead["data"]["review"]>["results"][number]
    | undefined;
  client: OperatorClient;
  session: Session;
  taskId: string;
  state: TaskWorkspaceState;
  changed: () => void;
  refresh: () => void;
  refreshDisabled: boolean;
  /** The check for a refresh whose response was lost; it stays until resolved, even once delivery stops applying. */
  unconfirmed: ReactNode;
  /** The last settled refresh's outcome; it leaves with the delivery controls. */
  outcome: ReactNode;
}) {
  const changes = selected?.metadata.changes,
    d = data.delivery,
    delivers = deliveryApplies(data);
  return (
    <section id="changes">
      <h3 className="section-heading">
        {delivers ? "Changes and delivery" : "Changes"}
      </h3>
      <TaskWorkspaceChanges
        client={client}
        session={session}
        taskId={taskId}
        assignments={data.assignments}
        state={state.changes}
        changed={changed}
      />
      {changes && (
        <>
          <p>Recorded files: {changes.files.join(", ") || "not supplied"}</p>
          <p>
            Recorded commits: {changes.commits.join(", ") || "not supplied"}
          </p>
          <Literal text={changes.diff} />
          {changes.reference &&
          ["http:", "https:"].includes(new URL(changes.reference).protocol) ? (
            <ActionLink href={changes.reference}>
              Recorded change reference
            </ActionLink>
          ) : (
            <p>No available recorded change reference.</p>
          )}
          {changes.findings.map((f) => (
            <p key={`${f.finding}:${f.repairAssignmentId ?? "unknown"}`}>
              {f.finding} · repair assignment{" "}
              {f.repairAssignmentId ?? "ownership unknown"}
            </p>
          ))}
        </>
      )}
      {d?.branches.map((b) => (
        <p key={`${b.repositoryName}:${b.branch}`}>
          {b.repositoryName} · branch {b.branch ?? "withheld"} ·{" "}
          {b.lastPushedSha ? (
            <>
              pushed <ShortId value={b.lastPushedSha} />
            </>
          ) : (
            "not pushed yet"
          )}{" "}
          {b.outsideHeadSha && (
            <StatusBadge tone="warning">
              {/^0+$/.test(b.outsideHeadSha) ? (
                "Branch deleted"
              ) : (
                <>
                  Outside push <ShortId value={b.outsideHeadSha} />
                </>
              )}
            </StatusBadge>
          )}
        </p>
      ))}
      {d && d.branches.length > 0 && (
        <p>
          Ensemble assigns and pushes these. A head it did not push is flagged,
          and Ensemble will not push that branch again until it returns to
          Ensemble's last push.
        </p>
      )}
      {d?.binding && (
        <>
          <PullRequestLine binding={d.binding} />
          <p>
            {d.binding.readError ? (
              <>
                Last GitHub read failed; showing the read from{" "}
                {clockLabel(d.binding.observedAt)}.
              </>
            ) : (
              <>GitHub read {clockLabel(d.binding.observedAt)}</>
            )}
          </p>
          {d.binding.readError && (
            <OutcomeDetails fields={[["Read error", d.binding.readError]]} />
          )}
          {d.binding.omittedCheckCount > 0 && (
            <p>
              Provider check coverage is partial; {d.binding.omittedCheckCount}{" "}
              additional retained{" "}
              {d.binding.omittedCheckCount === 1 ? "check is" : "checks are"}{" "}
              omitted. Omitted checks may be pending or failed.
            </p>
          )}
          {d.binding.checks.map((c) => (
            <p key={`${c.name}:${c.sha}`}>
              {c.name}: {checkStatusWord(c.status)}
              {c.sha !== d.binding?.headSha && (
                <>
                  {" "}
                  · on an earlier head <ShortId value={c.sha} />
                </>
              )}
            </p>
          ))}
          {d.binding.checks.length === 0 &&
          d.binding.omittedCheckCount === 0 ? (
            <p>No checks or repair owner were observed on this head.</p>
          ) : (
            <p>No repair owner is recorded for this pull request.</p>
          )}
          {d.binding.omittedFeedbackCount > 0 && (
            <p>
              {d.binding.omittedFeedbackCount} retained provider feedback
              records omitted; feedback coverage is partial.
            </p>
          )}
          {d.binding.feedback.map((f) => (
            <div key={f.nodeId}>
              <p>
                {f.kind} · {f.author ?? "Author unavailable"} · {f.state} · head{" "}
                {f.commitSha ?? "unknown"}
              </p>
              <Literal text={f.body} />
              <p>Repair ownership is not inferred from provider feedback.</p>
            </div>
          ))}
          {d.binding.state === "MERGED" && (
            <p>
              PR merged; task completion still requires its recorded completion
              workflow.
            </p>
          )}
        </>
      )}
      {delivers && d && d.omittedBlockerCount > 0 && (
        <p>
          {d.omittedBlockerCount} retained delivery blockers omitted; blocker
          coverage is partial.
        </p>
      )}
      {delivers &&
        d?.blockers.map((b) => (
          <div key={b}>
            <p>{deliveryBlockerSentence(b)}</p>
            <OutcomeDetails fields={[["Code", b]]} />
          </div>
        ))}
      {delivers && (
        <Button
          variant="secondary"
          data-unconfirmed-control="delivery.refresh"
          onClick={refresh}
          disabled={refreshDisabled}
        >
          Refresh delivery status
        </Button>
      )}
      {unconfirmed || (delivers && outcome)}
      {delivers && (
        <p>
          Refresh reads provider state; it does not post, approve, merge or
          clear a hold.
        </p>
      )}
      {delivers && d && d.omittedActionCount > 0 && (
        <p>
          {d.omittedActionCount} earlier retained delivery actions omitted;
          action history is partial.
        </p>
      )}
      {delivers &&
        d?.actions.map((a) => (
          <p key={a.operationId}>{deliveryActionLine(a)}</p>
        ))}
    </section>
  );
}
