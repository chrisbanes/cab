import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  CircleX,
  Clock,
  FilePen,
  LoaderCircle,
  Pause,
  Square,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useState, useRef, useLayoutEffect } from "react";
import type {
  InboxItem,
  Workspace,
  TaskListSummary,
} from "../../src/operator/contracts.js";
import { ResourceStatus, StatusBadge } from "./components.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import type { ResourceState } from "./resource.js";
import { requestActionLabel, requestHref } from "./request-presentation.js";
import {
  CompletedPanel,
  NeedsYou,
  OverviewStats,
  ProjectsPanel,
  type OverviewOperator,
} from "./overview-attention.js";
import { AttentionBar, type Requests } from "./task-attention.js";
import { TaskToolbar } from "./task-filters.js";
import {
  columns as allColumns,
  columnCounts,
  filterTasks,
  parseTaskFilters,
  taskColumn,
  taskDetailHref,
  taskFiltersUrl,
  isUncertain,
  operatorNext,
  readyButBlocked,
  taskNext,
  taskReasons,
  visibleColumns,
  type TaskAggregate,
  type TaskColumn,
  type TaskFilters,
} from "./tasks.js";
import "./work.css";

const stateIcons: Record<TaskColumn, LucideIcon> = {
  Ready: CircleDot,
  Running: LoaderCircle,
  Waiting: Clock,
  Paused: Pause,
  Stopping: Square,
  Uncertain: CircleQuestionMark,
  Draft: FilePen,
  Done: CircleCheck,
  Cancelled: CircleX,
};
/** A state's symbol and word in its colour; colour never carries the state alone. */
function ColumnMark({
  column,
  className = "task-state",
}: {
  column: TaskColumn;
  className?: string;
}) {
  const Icon = stateIcons[column];
  return (
    <span className={className} data-column={column}>
      <Icon aria-hidden="true" />
      {column}
    </span>
  );
}
const TaskStateMark = ({ task }: { task: TaskListSummary }) => (
  <ColumnMark column={taskColumn(task)} />
);
const identity = (task: TaskListSummary) =>
  task.source
    ? `${task.source.repositoryName ?? "repository unavailable"}#${task.source.number ?? "?"}`
    : "Local task";
const leadName = (task: TaskListSummary) =>
  task.lead?.name ?? (task.lead ? "Name unavailable" : null);
function TaskFacts({ task }: { task: TaskListSummary }) {
  return (
    <>
      {taskReasons(task).map((reason) => (
        <p key={reason} className="body muted task-reason">
          {reason}
        </p>
      ))}
      <p
        className="body task-next"
        data-operator={operatorNext(task) ? "true" : undefined}
      >
        {taskNext(task)}
      </p>
    </>
  );
}
export function TaskRow({ task }: { task: TaskListSummary }) {
  return (
    <article className="task-row" data-task-id={task.id}>
      <a className="small-heading task-title" href={taskDetailHref(task)}>
        {task.title ?? "Title unavailable"}
      </a>
      <p className="metadata muted task-project-metadata">
        {task.project.name ?? "Project name unavailable"} · {identity(task)}
      </p>
      <p className="body task-status">
        <TaskStateMark task={task} />
      </p>
      <div className="task-detail">
        <TaskFacts task={task} />
        {task.source && task.source.state !== "open" && (
          <p className="metadata muted task-source-state">
            GitHub source: {task.source.state ?? "state unavailable"}
          </p>
        )}
      </div>
      <p className="metadata muted task-lead">
        {leadName(task) ? `${leadName(task)} · lead` : "No lead configured"}
      </p>
      <ChevronRight aria-hidden="true" className="task-chevron" />
    </article>
  );
}
export function TaskCard({
  task,
  request,
}: {
  task: TaskListSummary;
  request?: InboxItem | undefined;
}) {
  const url = task.source?.url,
    lead = leadName(task),
    column = taskColumn(task);
  return (
    <article data-task-id={task.id}>
      <Card
        className="task-card"
        data-tone={
          isUncertain(task)
            ? "risk"
            : operatorNext(task)
              ? "attention"
              : undefined
        }
      >
        <div className="task-card-head">
          <a className="task-title" href={taskDetailHref(task)}>
            {task.title ?? "Title unavailable"}
          </a>
          {/* The column names the state; a chip marks only what the column does not. */}
          {readyButBlocked(task) && <ColumnMark column="Ready" />}
          {column === "Uncertain" && (
            <ColumnMark column="Uncertain" className="task-state phone-only" />
          )}
        </div>
        <p className="metadata muted task-project-metadata">
          {task.project.name ?? "Project name unavailable"} ·{" "}
          {url ? (
            <a
              className="task-identity"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {identity(task)}
              <ArrowUpRight aria-hidden="true" />
              <span className="sr-only"> (opens GitHub)</span>
            </a>
          ) : (
            <span className={task.source ? "task-identity" : undefined}>
              {identity(task)}
            </span>
          )}
        </p>
        <TaskFacts task={task} />
        {task.source && task.source.state !== "open" && (
          <p className="metadata muted task-source-state">
            GitHub source: {task.source.state ?? "state unavailable"}
          </p>
        )}
        <div className="metadata task-card-footer">
          <span className="task-lead">
            {lead ? `${lead} · accountable lead` : "No lead configured"}
          </span>
          {request && (
            <a className="task-request" href={requestHref(request)}>
              {requestActionLabel(request.kind)} →
            </a>
          )}
        </div>
      </Card>
    </article>
  );
}
export function TaskBoard({
  tasks,
  columns,
  initial,
  requests,
}: {
  tasks: TaskListSummary[];
  columns: readonly TaskColumn[];
  /** The column a State filter names, shown first unless the operator already chose one. */
  initial: TaskColumn | undefined;
  requests: Requests;
}) {
  const [stored, updateSelected] = useState<number>(
      () =>
        history.state?.board?.selected ??
        (initial ? Math.max(0, columns.indexOf(initial)) : 0),
    ),
    // The visible columns change with the State filter, so a saved index may point past the end.
    selected = Math.min(stored, columns.length - 1);
  const board = useRef<HTMLDivElement>(null);
  const counts = columnCounts(tasks);
  const firstRequest = new Map<string, InboxItem>();
  for (const item of requests.data?.items ?? [])
    if (!firstRequest.has(item.taskId)) firstRequest.set(item.taskId, item);
  const setSelected = (next: number) => {
    updateSelected(next);
    history.replaceState(
      { ...history.state, board: { ...history.state?.board, selected: next } },
      "",
    );
  };
  useLayoutEffect(() => {
    if (board.current)
      board.current.scrollLeft = history.state?.board?.scrollLeft ?? 0;
  }, []);
  // A State filter has no saved scroll position: bring its column into view once tasks
  // have been laid out. Only the board scrolls, never the page.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const area = board.current,
      column = area?.querySelector<HTMLElement>(
        `[id="column-${columns[selected]}"]`,
      );
    if (
      placed.current ||
      !area ||
      !column ||
      !initial ||
      !tasks.length ||
      history.state?.board?.scrollLeft !== undefined
    )
      return;
    placed.current = true;
    const a = area.getBoundingClientRect(),
      c = column.getBoundingClientRect();
    if (c.right > a.right)
      area.scrollLeft += Math.min(c.right - a.right, c.left - a.left);
    else if (c.left < a.left) area.scrollLeft -= a.left - c.left;
  }, [tasks.length, initial, columns, selected]);
  const before = columns[selected - 1],
    after = columns[selected + 1];
  return (
    <div className="task-board">
      <div
        className="column-navigation"
        role="toolbar"
        aria-label="Board columns"
      >
        {columns.map((column, index) => {
          const risky = column === "Uncertain" && counts[column] > 0;
          return (
            <Button
              key={column}
              type="button"
              variant="ghost"
              className="column-tab"
              aria-pressed={selected === index}
              data-attention={risky ? "true" : undefined}
              onClick={() => {
                setSelected(index);
                document
                  .getElementById(`column-${column}`)
                  ?.scrollIntoView({ block: "nearest", inline: "start" });
              }}
            >
              {risky && <CircleQuestionMark aria-hidden="true" />}
              {column} · {counts[column]}
            </Button>
          );
        })}
      </div>
      <div
        className="board-columns"
        ref={board}
        onScroll={(e) =>
          history.replaceState(
            {
              ...history.state,
              board: { selected, scrollLeft: e.currentTarget.scrollLeft },
            },
            "",
          )
        }
      >
        {columns.map((column, index) => (
          <section
            key={column}
            id={`column-${column}`}
            className={`board-column ${selected === index ? "selected-column" : ""}`}
            data-empty={counts[column] ? undefined : "true"}
            aria-label={`${column} tasks`}
          >
            <h2 className="board-column-heading">
              <ColumnMark column={column} className="board-column-name" />
              <span className="board-column-count">{counts[column]}</span>
            </h2>
            {tasks
              .filter((t) => taskColumn(t) === column)
              .map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  request={firstRequest.get(t.id)}
                />
              ))}
            {!counts[column] && (
              <p className="metadata muted">
                {column === "Ready"
                  ? "None ready. Held Ready work is in Waiting."
                  : "No tasks"}
              </p>
            )}
          </section>
        ))}
      </div>
      <div className="phone-column-controls">
        <Button
          variant="outline"
          disabled={!before}
          aria-label={
            before
              ? `Previous column: ${before}`
              : `Previous column: none, column 1 of ${columns.length}`
          }
          onClick={() => setSelected(selected - 1)}
        >
          {before ? `← ${before}` : `1 of ${columns.length}`}
        </Button>
        <Button
          variant="outline"
          disabled={!after}
          aria-label={
            after
              ? `Next column: ${after}`
              : `Next column: none, column ${columns.length} of ${columns.length}`
          }
          onClick={() => setSelected(selected + 1)}
        >
          {after ? `${after} →` : `${columns.length} of ${columns.length}`}
        </Button>
      </div>
      <p className="metadata muted board-footer">
        Columns describe Ensemble work, not GitHub issue state. Cards open the
        task; nothing here changes state, and there is no drag and drop.
      </p>
    </div>
  );
}
export function TaskViews({
  state,
  requests,
  refresh,
  workspace,
  path,
  navigate,
  projectId,
  overview = false,
  operator,
}: {
  state: ResourceState<TaskAggregate>;
  requests: Requests;
  refresh: () => void;
  workspace: Workspace | null;
  path: string;
  navigate: (path: string) => void;
  projectId?: string;
  overview?: boolean;
  /** Overview only: what its request cards read and answer with. */
  operator?: OverviewOperator | undefined;
}) {
  const base = path.split("?")[0] ?? "/app/tasks",
    filters = parseTaskFilters(
      path.includes("?") ? path.slice(path.indexOf("?")) : "",
    );
  const update = (patch: Partial<TaskFilters>) =>
    navigate(taskFiltersUrl(base, { ...filters, ...patch }));
  const all = state.data?.tasks ?? [],
    tasks = filterTasks(all, filters, projectId);
  const project = workspace?.data.projects.find((p) => p.id === projectId),
    scope = projectId || filters.project;
  const work = (
    <section
      aria-label={projectId ? "Project tasks" : "Across your projects"}
      className={overview ? "overview-panel" : undefined}
    >
      <TaskToolbar
        filters={filters}
        update={update}
        workspace={workspace}
        projectId={projectId}
        overview={overview}
        count={tasks.length}
        refresh={refresh}
        pending={state.pending}
      />
      {/* Home with no project shows the getting-started checklist instead. */}
      {state.data &&
        !tasks.length &&
        !(overview && !workspace?.data.projects.length) && (
          <p className="body empty-state">
            {all.some((t) => !projectId || t.projectId === projectId) ? (
              "No tasks match these filters."
            ) : workspace?.data.projects.length ? (
              "Ready for your first task. Create an outcome or save a draft."
            ) : (
              <>
                No projects yet.{" "}
                <a href="/app/getting-started">See getting started</a>
              </>
            )}
          </p>
        )}
      {filters.view === "board" ? (
        <TaskBoard
          // A new State filter picks its column again; other filters keep the operator's tab.
          key={filters.state}
          tasks={tasks}
          columns={visibleColumns(filters.state)}
          initial={allColumns.find((c) => c === filters.state)}
          requests={requests}
        />
      ) : (
        <>
          {overview && tasks.length > 0 && (
            <div className="overview-columns metadata muted" aria-hidden="true">
              <span>Task</span>
              <span>State</span>
              <span>Next</span>
              <span>Lead</span>
            </div>
          )}
          <div
            className="task-list"
            data-density={overview ? "compact" : undefined}
          >
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        </>
      )}
      {state.data && (
        <p className="metadata muted">
          Task states read{" "}
          {new Date(state.data.firstObservedAt).toLocaleTimeString()}–
          {new Date(state.data.lastObservedAt).toLocaleTimeString()}.
        </p>
      )}
    </section>
  );
  return (
    <>
      {overview && (
        <OverviewStats tasks={state.data?.tasks} requests={requests} />
      )}
      {project?.paused && (
        <p className="body">
          <StatusBadge tone="warning">Project paused</StatusBadge> New turns are
          held.
        </p>
      )}
      {projectId && (
        <p className="metadata muted work-project-links">
          <a href={`/app/projects/${projectId}/settings`}>Project settings</a>
          <a href={`/project/${projectId}`}>Open existing project controls</a>
        </p>
      )}
      {state.status !== "fresh" && (
        <ResourceStatus state={state} retry={refresh} label="Tasks" />
      )}
      {overview ? (
        <NeedsYou
          requests={requests}
          retry={refresh}
          tasks={state.data?.tasks}
          operator={operator}
        />
      ) : (
        <AttentionBar
          tasks={all.filter((t) => !scope || t.projectId === scope)}
          requests={requests}
        />
      )}
      {overview ? (
        <div className="overview-work">
          {work}
          <div className="overview-side">
            <ProjectsPanel workspace={workspace} tasks={state.data?.tasks} />
            <CompletedPanel tasks={all} project={filters.project} />
          </div>
        </div>
      ) : (
        work
      )}
    </>
  );
}
