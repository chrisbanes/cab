import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  searchReadSchema,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import { CircleDot, History, Search as SearchIcon } from "lucide-react";
import { Button, ResourceStatus, StatusBadge } from "./components.js";
import { Badge } from "./ui/badge.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import "./search.css";
const typeLabel: Record<string, string> = {
  task: "Task",
  decision: "Decision",
  result: "Result",
};
const destination = {
  task: "matching requirement",
  decision: "matching decision",
  result: "matching result",
};
/** One line of plain text: list, checklist and heading markers dropped, lines joined with " · ". */
const plainExcerpt = (text: string) =>
  text
    .replace(/^\s*(?:#{1,6}\s+|(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)/gm, "")
    .trim()
    .replace(/\s*\n\s*/g, " · ")
    .replace(/\s+/g, " ");
/** Up to ~240 characters around the first literal match, elided at either end. */
const excerptAround = (text: string, query: string, span = 240) => {
  const plain = plainExcerpt(text);
  if (plain.length <= span) return `“${plain}”`;
  const at = Math.max(
    0,
    plain.toLowerCase().indexOf(query.trim().toLowerCase()),
  );
  const start = Math.max(0, Math.min(at - span / 3, plain.length - span));
  const end = start + span;
  return `“${start > 0 ? "…" : ""}${plain.slice(start, end).trim()}${end < plain.length ? "…" : ""}”`;
};
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (
    let at = text.toLowerCase().indexOf(q);
    at >= 0;
    at = text.toLowerCase().indexOf(q, from)
  ) {
    parts.push(
      text.slice(from, at),
      <mark key={at}>{text.slice(at, at + q.length)}</mark>,
    );
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return parts;
}
const localDay = (value: string | null) => {
  if (!value) return "";
  const d = new Date(Number(value));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Back is offered only from the places a match is opened from: a task detail or an Inbox item. */
const returnsToItem = (origin: unknown) => {
  if (typeof origin !== "string") return false;
  const url = new URL(origin, location.origin);
  return (
    (/^\/app\/tasks\/[^/]+$/.test(url.pathname) &&
      url.pathname !== "/app/tasks/new") ||
    (url.pathname === "/app/inbox" && Boolean(url.searchParams.get("request")))
  );
};
type Filters = {
  project: string;
  type: string;
  historical: boolean;
  after: string;
  before: string;
};
export class SearchState {
  dataPath = "";
  data: z.infer<typeof searchReadSchema> | null = null;
  selected: string | null = null;
  scrollY = 0;
}
export function Search({
  client,
  session,
  workspace,
  path,
  navigate,
  onRefresh,
  state,
}: {
  client: OperatorClient;
  session: Session;
  workspace: Workspace | null;
  path: string;
  navigate: (p: string) => void;
  /** Also re-reads the shell data (sidebar, runtime alert) that this page's own refresh replaced. */
  onRefresh?: () => void;
  state: SearchState;
}) {
  const params = new URLSearchParams(path.split("?")[1] ?? ""),
    query = params.get("query") ?? "",
    project = params.get("projectId") ?? "",
    type = params.get("type") ?? "",
    historical = params.get("historical") === "true";
  const [input, setInput] = useState(query),
    [projectInput, setProject] = useState(project),
    [typeInput, setType] = useState(type),
    [historyInput, setHistorical] = useState(historical),
    [after, setAfter] = useState(localDay(params.get("after"))),
    [before, setBefore] = useState(localDay(params.get("before")));
  const origin = (history.state as { workspaceOrigin?: string } | null)
    ?.workspaceOrigin;
  const backToItem = returnsToItem(origin);
  // The date values the URL already holds, so a blur or Enter that changes nothing pushes no entry.
  const applied = useRef({ after, before });
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/search?${path.split("?")[1] ?? ""}`,
        searchReadSchema,
        signal,
      ),
    [client, path],
  );
  const resource = useOperatorResource(
      query ? `${session.csrfToken}:${path}` : null,
      loader,
    ),
    data = resource.state.data ?? (state.dataPath === path ? state.data : null);
  useEffect(() => {
    if (resource.state.data) {
      state.data = resource.state.data;
      state.dataPath = path;
      requestAnimationFrame(() => {
        scrollTo(0, state.scrollY);
        if (state.selected)
          [...document.querySelectorAll<HTMLElement>("[data-search-record]")]
            .find((el) => el.dataset.searchRecord === state.selected)
            ?.querySelector<HTMLElement>("a")
            ?.focus({ preventScroll: true });
      });
    }
  }, [resource.state.data, state, path]);
  useEffect(
    () => () => {
      state.scrollY = scrollY;
    },
    [state],
  );
  /** Runs the search for the field's text (or the URL's, when blank) with the filters, `over` taking precedence. */
  function submit(over: Partial<Filters> = {}) {
    const f: Filters = {
      project: projectInput,
      type: typeInput,
      historical: historyInput,
      after,
      before,
      ...over,
    };
    applied.current = { after: f.after, before: f.before };
    state.data = null;
    state.scrollY = 0;
    const p = new URLSearchParams({
      query: input.trim() ? input : query,
      historical: String(f.historical),
    });
    if (f.project) p.set("projectId", f.project);
    if (f.type) p.set("type", f.type);
    if (f.after)
      p.set("after", String(new Date(`${f.after}T00:00:00`).getTime()));
    if (f.before)
      p.set("before", String(new Date(`${f.before}T23:59:59.999`).getTime()));
    navigate(`/app/search?${p}`);
  }
  const commitDates = () => {
    if (after !== applied.current.after || before !== applied.current.before)
      submit();
  };
  const dateEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitDates();
  };
  return (
    <section className="search-workspace" aria-label="Retained record search">
      {backToItem && (
        <div className="search-nav">
          <Button
            variant="secondary"
            onClick={() => {
              const delta =
                (history.state?.workspaceIndex ?? 0) -
                (history.state?.entryIndex ?? 0);
              if (delta < 0) history.go(delta);
              else if (origin) navigate(origin);
            }}
          >
            Back to originating workspace
          </Button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="search-query-row">
          <label className="search-work search-query" htmlFor="retained-query">
            <span className="sr-only">
              Search retained task, decision and result records
            </span>
            <SearchIcon aria-hidden="true" size={16} />
            <input
              id="retained-query"
              type="search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={256}
            />
          </label>
          <Button variant="secondary" disabled={!input.trim()}>
            Search records
          </Button>
        </div>
      </form>
      <p
        className="metadata search-coverage"
        title="Covers permitted retained task, decision and result excerpts, up to 16,000 characters each. Long source coverage is partial. It does not generate summaries."
      >
        Searches saved excerpts, not full agent transcripts.
      </p>
      {query && (
        <ResourceStatus state={resource.state} retry={resource.refresh} />
      )}
      {!query && <p>Enter a phrase to search across projects.</p>}
      {query && resource.state.error && data && (
        <p role="status">
          Refresh failed. Showing the last matches, from{" "}
          {new Date(data.observedAt).toLocaleString()}.
        </p>
      )}
      {query && (
        <section
          className="search-results"
          aria-labelledby={data ? "search-count" : undefined}
          aria-label={data ? undefined : "Search results"}
        >
          <div className="search-results-head">
            {data && (
              <h2 id="search-count" className="small-heading">
                {data.data.matches.length}{" "}
                {data.data.matches.length === 1 ? "match" : "matches"}{" "}
                <span className="metadata">
                  · retained records only · {data.data.omittedCount} omitted or
                  inaccessible
                </span>
              </h2>
            )}
            <div className="search-filters">
              <label htmlFor="search-project">
                Project
                <NativeSelect
                  id="search-project"
                  aria-label="Project"
                  value={projectInput}
                  onChange={(e) => {
                    setProject(e.target.value);
                    submit({ project: e.target.value });
                  }}
                >
                  <option value="">All permitted projects</option>
                  {workspace?.data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name ?? "Unavailable"}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label htmlFor="search-type">
                Type
                <NativeSelect
                  id="search-type"
                  aria-label="Record type"
                  value={typeInput}
                  onChange={(e) => {
                    setType(e.target.value);
                    submit({ type: e.target.value });
                  }}
                >
                  <option value="">All types</option>
                  {["task", "decision", "result"].map((t) => (
                    <option key={t} value={t}>
                      {typeLabel[t]}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label htmlFor="search-from-date">
                From
                <Input
                  id="search-from-date"
                  aria-label="From date"
                  className="control"
                  type="date"
                  value={after}
                  onChange={(e) => setAfter(e.target.value)}
                  onBlur={commitDates}
                  onKeyDown={dateEnter}
                />
              </label>
              <label htmlFor="search-through-date">
                Through
                <Input
                  id="search-through-date"
                  aria-label="Through date"
                  className="control"
                  type="date"
                  value={before}
                  onChange={(e) => setBefore(e.target.value)}
                  onBlur={commitDates}
                  onKeyDown={dateEnter}
                />
              </label>
              <label className="search-history">
                <input
                  type="checkbox"
                  checked={historyInput}
                  onChange={(e) => {
                    setHistorical(e.target.checked);
                    submit({ historical: e.target.checked });
                  }}
                />
                Include historical records
              </label>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                resource.refresh();
                onRefresh?.();
              }}
            >
              Refresh results
            </Button>
          </div>
          {data && (
            <>
              {!data.data.matches.length && (
                <p className="search-empty">
                  No permitted retained match. Other or omitted history is
                  outside this search.
                </p>
              )}
              <ul className="search-matches">
                {data.data.matches.map((m) => (
                  <li
                    key={m.recordId}
                    data-search-record={m.recordId}
                    aria-current={
                      state.selected === m.recordId ? "true" : undefined
                    }
                  >
                    <span className="search-match-head">
                      <Badge variant="outline" className="metadata">
                        {typeLabel[m.type]}
                      </Badge>
                      <span className="search-match-title">
                        {m.taskTitle ?? "Title unavailable"}
                      </span>
                      {state.selected === m.recordId && (
                        <StatusBadge tone="idle" icon={CircleDot}>
                          Selected
                        </StatusBadge>
                      )}
                      {m.historical && (
                        <StatusBadge tone="idle" icon={History}>
                          Historical
                        </StatusBadge>
                      )}
                    </span>
                    <p className="search-excerpt">
                      {m.excerpt === null ? (
                        "Excerpt unavailable"
                      ) : (
                        <Highlighted
                          text={excerptAround(m.excerpt, query)}
                          query={query}
                        />
                      )}
                    </p>
                    <p className="identifier search-provenance">
                      {m.projectName ?? "Project unavailable"} ·{" "}
                      {m.historical ? "historical" : "current"} ·{" "}
                      {new Date(m.createdAt).toLocaleString()}
                    </p>
                    <a
                      href={m.href}
                      onClick={() => {
                        state.selected = m.recordId;
                        state.scrollY = scrollY;
                      }}
                    >
                      Open task → {destination[m.type]}
                    </a>
                  </li>
                ))}
              </ul>
              {data.data.nextCursor && (
                <div className="search-more">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const p = new URLSearchParams(path.split("?")[1]);
                      if (!data.data.nextCursor) return;
                      p.set("cursor", data.data.nextCursor);
                      navigate(`/app/search?${p}`);
                    }}
                  >
                    Next retained matches
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
