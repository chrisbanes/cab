import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  executionHarnessLabels,
  taskToolOutputSchema,
  taskTimelineSchema,
  type TaskRead,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { ActionLink, Button, ShortId, StatusBadge } from "./components.js";
import { clockLabel } from "./presentation.js";
import {
  changesLabel,
  commandsLabel,
  conversationTree,
  gapCopy,
  mergeTimeline,
  prependTimeline,
  type ConversationCache,
  type ConversationItem,
  type TimelineEntry,
  type TimelineWindow,
  type ToolEntry,
} from "./task-conversation-model.js";
import { MarkdownPreview } from "./task-files.js";
import type { TaskWorkspaceState } from "./task-workspace-state.js";

type Data = TaskRead["data"];
type Assignment = Data["assignments"][number];

export interface TaskTimeline {
  window: TimelineWindow | null;
  hasEarlier: boolean;
  /** A failed or invalid read; the last validated window stays shown. */
  error: string | null;
  loadingEarlier: boolean;
  /** Counts newest-page reads that changed what was shown, so the page can offer Jump to latest. */
  appended: number;
  loadEarlier: () => void;
  retry: () => void;
}

const pageLimit = 50;

/**
 * Reads the newest page whenever the task read changes (`observedAt`) and merges it into the
 * retained window by entry and the service's ordering key. `beforeApply` runs just before a
 * change is committed so the page can capture its reading position; `first` marks the opening
 * read, where the page stays where it is.
 */
export function useTaskTimeline({
  client,
  taskId,
  cache,
  setCache,
  observedAt,
  beforeApply,
}: {
  client: OperatorClient;
  taskId: string;
  cache: ConversationCache | null;
  setCache: (value: ConversationCache | null) => void;
  observedAt: number | null | undefined;
  beforeApply: (first: boolean) => void;
}): TaskTimeline {
  const [view, setView] = useState({
    cache,
    error: null as string | null,
    loadingEarlier: false,
    appended: 0,
  });
  const held = useRef(view);
  held.current = view;
  const apply = useRef(beforeApply);
  apply.current = beforeApply;
  const save = useRef(setCache);
  save.current = setCache;
  const read = useCallback(
    (query: string, signal?: AbortSignal) =>
      client.read(
        `/api/operator/tasks/${taskId}/timeline?limit=${pageLimit}${query}`,
        taskTimelineSchema,
        signal,
      ),
    [client, taskId],
  );
  const commit = (
    next: Partial<typeof view> & { cache?: ConversationCache | null },
  ) => {
    const value = { ...held.current, ...next };
    held.current = value;
    if ("cache" in next) save.current(next.cache ?? null);
    setView(value);
  };
  const fail = (error: unknown) =>
    commit({
      loadingEarlier: false,
      error: error instanceof Error ? error.message : "Unavailable",
    });
  // The newest page, merged into what is held.
  const refresh = (signal?: AbortSignal) =>
    read("", signal).then(
      ({ data: page }) => {
        if (signal?.aborted) return;
        const current = held.current.cache;
        const merged = mergeTimeline(current?.window ?? null, page);
        if (!merged.changed && held.current.error === null) return;
        apply.current(!current);
        commit({
          error: null,
          appended:
            current && merged.changed
              ? held.current.appended + 1
              : held.current.appended,
          cache: {
            window: merged.window,
            cursor:
              !current || merged.reset ? page.olderCursor : current.cursor,
          },
        });
      },
      // A read that was superseded or abandoned fails quietly; it is not a stale conversation.
      (error) => {
        if (!signal?.aborted) fail(error);
      },
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the task read's time is the trigger.
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [read, observedAt]);

  const loadEarlier = () => {
    const current = held.current.cache;
    if (!current?.cursor || held.current.loadingEarlier) return;
    commit({ loadingEarlier: true });
    read(`&before=${current.cursor}`).then(({ data: page }) => {
      const joined = prependTimeline(current.window, page);
      apply.current(false);
      commit({
        loadingEarlier: false,
        error: null,
        cache: joined ? { window: joined, cursor: page.olderCursor } : null,
      });
      // The visibility revision changed under the held pages: start again from the newest.
      if (!joined) void refresh();
    }, fail);
  };
  return {
    window: view.cache?.window ?? null,
    hasEarlier: Boolean(view.cache?.cursor),
    error: view.error,
    loadingEarlier: view.loadingEarlier,
    appended: view.appended,
    loadEarlier,
    retry: () => void refresh(),
  };
}

/** Where a request's single form is shown, and the task read's state of each request. */
export interface RequestPlaces {
  /** The request whose form is in the conversation, or null. */
  inline: string | null;
  /** The request whose form is in the attention card, or null. */
  card: string | null;
  status: (interactionId: string) => TimelineStatus | undefined;
  answerHere: (interactionId: string) => void;
  answerInCard: (interactionId: string) => void;
  form: (interactionId: string) => ReactNode;
}
type TimelineStatus = "open" | "answered" | "approved" | "denied";

const statusText: Record<TimelineStatus, string> = {
  open: "Waiting on you",
  answered: "Answered",
  approved: "Approved",
  denied: "Denied",
};

export function TaskConversation({
  client,
  taskId,
  data,
  state,
  changed,
  timeline,
  requests,
  following,
  openChanges,
}: {
  client: OperatorClient;
  taskId: string;
  data: Data;
  state: TaskWorkspaceState;
  changed: () => void;
  timeline: TaskTimeline;
  requests: RequestPlaces;
  /** True while the page is at the bottom, so the log announces what arrives. */
  following: boolean;
  openChanges: () => void;
}) {
  const expanded = (key: string) => state.expanded.has(key);
  const toggle = (key: string) => {
    if (!state.expanded.delete(key)) state.expanded.add(key);
    changed();
  };
  const names = new Map(data.assignments.map((a) => [a.assignmentId, a.name]));
  const lead = data.assignments.find(
    (a) => a.assignmentId === data.leadAssignmentId,
  );
  const items = timeline.window
    ? conversationTree(
        timeline.window.entries,
        data.assignments,
        data.leadAssignmentId ?? null,
      )
    : [];
  const ctx: Context = {
    client,
    taskId,
    data,
    names,
    expanded,
    toggle,
    requests,
    openChanges,
  };
  return (
    <section
      id="conversation"
      className="conversation"
      aria-labelledby="conversation-heading"
    >
      <h3 id="conversation-heading" className="section-heading">
        Conversation
      </h3>
      <p className="metadata muted">
        {lead ? `Led by ${lead.name} · ${lead.state}. ` : "No task lead yet. "}
        Captured text and curated tool activity, oldest first. It is not a
        complete transcript.
      </p>
      {timeline.error && (
        <p role="alert" className="conversation-status">
          {timeline.window
            ? "The conversation could not be refreshed, so this view may be out of date."
            : "The conversation could not be read."}{" "}
          <Button variant="secondary" onClick={timeline.retry}>
            Retry
          </Button>
        </p>
      )}
      {timeline.hasEarlier && (
        <Button
          variant="secondary"
          disabled={timeline.loadingEarlier}
          onClick={timeline.loadEarlier}
        >
          {timeline.loadingEarlier ? "Loading earlier…" : "Load earlier"}
        </Button>
      )}
      <div
        role="log"
        aria-label="Task conversation"
        aria-live={following ? "polite" : "off"}
        className="conversation-log"
      >
        {timeline.window === null && !timeline.error && (
          <p className="muted">Reading the conversation…</p>
        )}
        {timeline.window && items.length === 0 && (
          <p className="muted">Nothing has been captured for this task yet.</p>
        )}
        <Items items={items} ctx={ctx} />
      </div>
      <div id="conversation-end" data-conversation-end />
    </section>
  );
}

interface Context {
  client: OperatorClient;
  taskId: string;
  data: Data;
  names: Map<string, string | null>;
  expanded: (key: string) => boolean;
  toggle: (key: string) => void;
  requests: RequestPlaces;
  openChanges: () => void;
}

function Items({ items, ctx }: { items: ConversationItem[]; ctx: Context }) {
  return (
    <>
      {items.map((item) => (
        <Item key={`${item.type}:${item.id}`} item={item} ctx={ctx} />
      ))}
    </>
  );
}

function Item({ item, ctx }: { item: ConversationItem; ctx: Context }) {
  switch (item.type) {
    case "commands":
      return <CommandGroup item={item} ctx={ctx} />;
    case "changes":
      return (
        <div className="conv-tools" data-record-id={item.id}>
          <span>{changesLabel(item.entries.length)}</span>
          <Button variant="secondary" onClick={ctx.openChanges}>
            Open in Changes
          </Button>
        </div>
      );
    case "tool":
      return (
        <p className="conv-tools" data-record-id={item.id}>
          Tool · {item.entry.label ?? "Other tool"}
          {item.entry.status ? ` · ${item.entry.status}` : ""}
        </p>
      );
    case "delegation":
      return <Delegation item={item} ctx={ctx} />;
    case "entry":
      return <Entry entry={item.entry} ctx={ctx} />;
  }
}

const time = (entry: TimelineEntry) => (
  <time dateTime={new Date(entry.at).toISOString()}>
    {clockLabel(entry.at)}
  </time>
);

function Entry({
  entry,
  ctx,
}: {
  entry: Exclude<ConversationItem & { type: "entry" }, never>["entry"];
  ctx: Context;
}) {
  const who = ctx.names.get(entry.assignmentId) ?? "Agent";
  switch (entry.kind) {
    case "assistant": {
      const raw = ctx.expanded(`c:raw:${entry.entryId}`);
      return (
        <article
          className="conv-entry conv-agent"
          data-record-id={entry.entryId}
        >
          <header>
            <strong>{who}</strong> {time(entry)}
            {entry.lifecycle !== "completed" && (
              <span className="muted"> · writing…</span>
            )}
          </header>
          {entry.text === null ? (
            <p className="muted">No text captured for this item.</p>
          ) : raw ? (
            <pre className="conv-raw">{entry.text}</pre>
          ) : (
            <MarkdownPreview text={entry.text} />
          )}
          {entry.text !== null && (
            <Button
              variant="secondary"
              onClick={() => ctx.toggle(`c:raw:${entry.entryId}`)}
            >
              {raw ? "Formatted" : "Raw text"}
            </Button>
          )}
        </article>
      );
    }
    case "message": {
      const label =
        entry.messageKind === "operator-message"
          ? "You"
          : entry.messageKind === "follow-up"
            ? "Follow-up"
            : entry.messageKind === "answer"
              ? "Your answer"
              : `Your decision${entry.decision ? ` · ${entry.decision}` : ""}`;
      return (
        <article
          className="conv-entry conv-operator"
          data-record-id={entry.entryId}
        >
          <header>
            <strong>{label}</strong> {time(entry)}
            <span className="muted">
              {" "}
              · to {who}
              {entry.requester
                ? ` · requested by ${entry.requester === "assignment" ? "an agent" : "you"}`
                : ""}
            </span>
          </header>
          <p className="conv-text">{entry.text}</p>
          {entry.questionAnswers &&
            Object.entries(entry.questionAnswers).map(([id, answer]) => (
              <p key={id} className="conv-text">
                {answer.optionIds.join(", ")}
                {answer.text ? ` — ${answer.text}` : ""}
              </p>
            ))}
        </article>
      );
    }
    case "request":
      return <RequestEntry entry={entry} who={who} ctx={ctx} />;
    case "result":
      return (
        <article
          className="conv-entry conv-result"
          data-record-id={entry.entryId}
        >
          <header>
            <strong>Result</strong> from {who} {time(entry)}
          </header>
          <p className="conv-text">{entry.summary}</p>
          <p className="metadata muted">
            {entry.destinationDisposition === "delivered"
              ? "Delivered to its destination."
              : "Destination unresolved."}{" "}
            <ShortId value={entry.resultId} />
          </p>
          <ActionLink
            variant="secondary"
            href={`/app/tasks/${ctx.taskId}?section=review&result=${entry.resultId}`}
          >
            Open result
          </ActionLink>
        </article>
      );
    case "gap":
      return (
        <div className="conv-gap" role="note" data-record-id={entry.entryId}>
          <p>
            <strong>Not shown.</strong> {gapCopy(entry.reason)}
          </p>
          <Button
            variant="secondary"
            aria-expanded={ctx.expanded(`c:gap:${entry.entryId}`)}
            onClick={() => ctx.toggle(`c:gap:${entry.entryId}`)}
          >
            Details
          </Button>
          {ctx.expanded(`c:gap:${entry.entryId}`) && (
            <dl className="conv-gap-detail">
              <dt>Work</dt>
              <dd>{entry.detail.workId}</dd>
              <dt>Turn</dt>
              <dd>{entry.detail.turnId}</dd>
              <dt>Item</dt>
              <dd>{entry.detail.itemId}</dd>
            </dl>
          )}
        </div>
      );
  }
}

function RequestEntry({
  entry,
  who,
  ctx,
}: {
  entry: Extract<TimelineEntry, { kind: "request" }>;
  who: string;
  ctx: Context;
}) {
  const { requests } = ctx;
  const id = entry.interactionId;
  const status = requests.status(id) ?? entry.status;
  const label = entry.requestKind === "approval" ? "Approval" : "Question";
  return (
    <article
      className="conv-entry conv-request"
      data-record-id={entry.entryId}
      data-interaction-id={id}
      data-status={status}
    >
      <header>
        <strong>
          {label} from {who}
        </strong>{" "}
        {time(entry)}{" "}
        <StatusBadge tone={status === "open" ? "warning" : "success"}>
          {statusText[status]}
        </StatusBadge>
      </header>
      {requests.inline === id ? (
        requests.form(id)
      ) : (
        <>
          <p className="conv-text">{entry.prompt}</p>
          {entry.requestKind === "approval" && (
            <p className="metadata muted">
              Action: {entry.action} · Target: {entry.target}
            </p>
          )}
          {status === "open" &&
            (requests.card === id ? (
              <>
                <p role="status">Answering in the attention card.</p>
                <Button
                  variant="secondary"
                  onClick={() => requests.answerHere(id)}
                >
                  Answer here instead
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                onClick={() => requests.answerHere(id)}
              >
                {entry.requestKind === "approval"
                  ? "Review material & decide"
                  : "Answer question"}
              </Button>
            ))}
        </>
      )}
    </article>
  );
}

function CommandGroup({
  item,
  ctx,
}: {
  item: Extract<ConversationItem, { type: "commands" }>;
  ctx: Context;
}) {
  const key = `c:tools:${item.id}`;
  const open = ctx.expanded(key);
  return (
    <div
      className="conv-tools"
      data-record-id={item.id}
      data-failed={item.failed > 0 || undefined}
    >
      <Button
        variant="secondary"
        aria-expanded={open}
        onClick={() => ctx.toggle(key)}
      >
        {commandsLabel(item.entries.length, item.failed)}
      </Button>
      {open && (
        <ul className="conv-commands">
          {item.entries.map((entry) => (
            <CommandRow key={entry.entryId} entry={entry} ctx={ctx} />
          ))}
        </ul>
      )}
    </div>
  );
}

type Output =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "done"; omitted: string | null; text: string | null };

const omittedText = {
  "size-limit": "The output was too large to keep.",
  "redaction-unavailable":
    "Redaction was unavailable, so the output is withheld.",
  "not-captured": "The harness did not capture this output.",
} as const;

function CommandRow({ entry, ctx }: { entry: ToolEntry; ctx: Context }) {
  const key = `c:out:${entry.entryId}`;
  const open = ctx.expanded(key);
  const sequence = entry.outputSequence;
  const [output, setOutput] = useState<Output | null>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` retries a failed read.
  useEffect(() => {
    if (!open || sequence === null) return;
    const abort = new AbortController();
    setOutput({ state: "loading" });
    ctx.client
      .read(
        `/api/operator/tasks/${ctx.taskId}/timeline/output/${sequence}`,
        taskToolOutputSchema,
        abort.signal,
      )
      .then(
        ({ data }) =>
          setOutput({
            state: "done",
            omitted:
              data.state === "omitted"
                ? data.reason
                  ? omittedText[data.reason]
                  : "The output is not available."
                : null,
            text: data.text,
          }),
        () => {
          if (!abort.signal.aborted) setOutput({ state: "failed" });
        },
      );
    return () => abort.abort();
  }, [open, sequence, ctx.client, ctx.taskId, attempt]);
  const failed = entry.exitCode !== null && entry.exitCode !== 0;
  return (
    <li data-record-id={entry.entryId}>
      <code>
        {entry.command ?? "Command"}
        {entry.truncated ? "…" : ""}
      </code>{" "}
      <span className={failed ? "conv-failed" : "muted"}>
        {entry.exitCode === null
          ? (entry.status ?? "no exit status")
          : `exit ${entry.exitCode}`}
      </span>{" "}
      {sequence === null ? (
        <span className="muted">No output retained</span>
      ) : (
        <Button
          variant="secondary"
          aria-expanded={open}
          onClick={() => ctx.toggle(key)}
        >
          {open ? "Hide output" : "Show output"}
        </Button>
      )}
      {open && output?.state === "loading" && (
        <p className="muted" role="status">
          Reading output…
        </p>
      )}
      {open && output?.state === "failed" && (
        <p role="alert">
          Output could not be read.{" "}
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </p>
      )}
      {open &&
        output?.state === "done" &&
        (output.omitted ? (
          <p className="muted">{output.omitted}</p>
        ) : (
          <pre className="conv-raw">{output.text ?? ""}</pre>
        ))}
    </li>
  );
}

function Delegation({
  item,
  ctx,
}: {
  item: Extract<ConversationItem, { type: "delegation" }>;
  ctx: Context;
}) {
  const key = `c:delegation:${item.id}`;
  const open = ctx.expanded(key);
  const a: Assignment | undefined = item.assignment;
  const runtime = item.entry?.runtime ?? a?.runtime;
  const state = a?.state ?? item.entry?.state;
  const brief = a?.brief?.trim().split("\n")[0];
  const result = ctx.data.results
    .filter((r) => r.assignmentId === item.id)
    .at(-1);
  return (
    <section
      className="conv-delegation"
      data-record-id={`delegation:${item.id}`}
      aria-label={`Delegated assignment ${a?.name ?? item.entry?.name ?? ""}`}
    >
      <h4>
        <button
          type="button"
          className="conv-delegation-head"
          aria-expanded={open}
          onClick={() => ctx.toggle(key)}
        >
          <strong>{a?.name ?? item.entry?.name ?? "Assignment"}</strong>
          <span className="identifier-line">
            <ShortId value={item.id} focusable={false} />
            {runtime && ` · ${executionHarnessLabels[runtime.harness]}`}
            {item.entry === null && " · delegated earlier"}
          </span>
          {state && (
            <StatusBadge
              tone={
                state === "completed"
                  ? "success"
                  : state === "running"
                    ? "idle"
                    : "neutral"
              }
            >
              {state}
            </StatusBadge>
          )}
        </button>
      </h4>
      {!open && (brief || result) && (
        <p className="metadata muted conv-delegation-summary">
          {brief}
          {result && ` · Result: ${(result.summary ?? "").slice(0, 120)}`}
        </p>
      )}
      {open && (
        <div className="conv-delegation-body">
          {item.items.length === 0 ? (
            <p className="muted">Nothing captured for this assignment yet.</p>
          ) : (
            <Items items={item.items} ctx={ctx} />
          )}
        </div>
      )}
    </section>
  );
}
