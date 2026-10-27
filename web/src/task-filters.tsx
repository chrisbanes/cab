import { useEffect, useState } from "react";
import type { Workspace } from "../../src/operator/contracts.js";
import { workspaceLabels } from "../../src/operator/project-labels.js";
import { Button } from "./components.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { activeFilterCount, columns, type TaskFilters } from "./tasks.js";

/** One row: heading, List/Board switch, inline Project and State dropdowns, count, refresh. */
export function TaskToolbar({
  filters,
  update,
  workspace,
  projectId,
  overview,
  count,
  total,
  loaded,
  reset,
  refresh,
  pending,
  phone = false,
  columnsSlot,
}: {
  filters: TaskFilters;
  update: (patch: Partial<TaskFilters>) => void;
  workspace: Workspace | null;
  projectId: string | undefined;
  overview: boolean;
  count: number;
  /** Tasks in scope before any filter, so "no tasks" and "no matches" read differently. */
  total: number;
  /** The task list has been read, so a zero total is real. */
  loaded: boolean;
  reset: () => void;
  refresh: () => void;
  pending: boolean;
  /** ≤759px: the selects group up front, in the order they appear, and the Board can lend a chip slot. */
  phone?: boolean | undefined;
  /** Phone Board: receives the element the column chips are portalled into. */
  columnsSlot?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const labels = workspaceLabels(workspace);
  const hiddenActive = activeFilterCount({
    ...filters,
    project: "",
    state: "",
  });
  const hasMore = hiddenActive > 0;
  const [open, setOpen] = useState(hasMore);
  const switchView = (
    <div className="work-switch" role="toolbar" aria-label="Task presentation">
      {(["list", "board"] as const).map((view) => (
        <Button
          key={view}
          variant="secondary"
          aria-pressed={filters.view === view}
          onClick={() => update({ view })}
        >
          {view === "list" ? "List" : "Board"}
        </Button>
      ))}
    </div>
  );
  const selects = (
    <>
      {!projectId && (
        <span className="work-select">
          <NativeSelect
            aria-label="Project"
            value={filters.project}
            onChange={(e) => update({ project: e.target.value })}
          >
            <option value="">All projects</option>
            {workspace?.data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {labels.get(p.id)?.text}
              </option>
            ))}
          </NativeSelect>
        </span>
      )}
      <span className="work-select">
        <NativeSelect
          aria-label="State"
          value={filters.state}
          onChange={(e) => update({ state: e.target.value })}
        >
          <option value="">Active tasks</option>
          <option value="all">All tasks</option>
          {columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </NativeSelect>
      </span>
    </>
  );
  const countLine = !overview && (
    <p className="metadata muted work-count">
      {loaded && total === 0
        ? "No tasks"
        : loaded && count === 0
          ? "No tasks match these filters"
          : `${count} task${count === 1 ? "" : "s"}`}
    </p>
  );
  const resetButton = activeFilterCount(filters, projectId) > 0 && (
    <Button variant="secondary" className="work-reset" onClick={reset}>
      Reset filters
    </Button>
  );
  const refreshButton = (
    <Button
      variant="secondary"
      className="work-refresh"
      onClick={refresh}
      disabled={pending}
    >
      Refresh tasks
    </Button>
  );
  const slot = columnsSlot && (
    <div className="work-columns" ref={columnsSlot} />
  );
  // A filter set from the URL opens the disclosure; the component never closes it.
  useEffect(() => {
    if (hasMore) setOpen(true);
  }, [hasMore]);
  return (
    <div className="work-toolbar-block">
      <div
        className="work-toolbar"
        data-surface={overview ? "overview" : "tasks"}
        data-view={filters.view}
      >
        <h2 className="section-heading work-heading">
          {projectId ? "Project tasks" : "Across your projects"}
        </h2>
        {phone ? (
          <>
            <div className="work-filters">
              {selects}
              {slot}
            </div>
            {countLine}
            {switchView}
            {refreshButton}
          </>
        ) : (
          <>
            {switchView}
            {selects}
            {countLine}
            {refreshButton}
          </>
        )}
      </div>
      <div className="work-more-row">
        <details
          className="work-more"
          open={open}
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary className="metadata muted">
            More filters{hiddenActive > 0 && ` · ${hiddenActive} active`}
          </summary>
          <div className="work-more-fields">
            <label className="field body" htmlFor="task-search">
              Filter tasks
              <Input
                id="task-search"
                value={filters.q}
                maxLength={512}
                onChange={(e) => update({ q: e.target.value })}
              />
            </label>
            <label className="field body" htmlFor="task-source">
              Source
              <NativeSelect
                id="task-source"
                aria-label="Source"
                value={filters.source}
                onChange={(e) => update({ source: e.target.value })}
              >
                <option value="">All sources</option>
                <option value="local">Local</option>
                <option value="github">GitHub</option>
              </NativeSelect>
            </label>
            <label className="field body" htmlFor="task-ready">
              Readiness
              <NativeSelect
                id="task-ready"
                aria-label="Readiness"
                value={filters.ready}
                onChange={(e) =>
                  update({ ready: e.target.value as TaskFilters["ready"] })
                }
              >
                <option value="yes">Ready</option>
                <option value="no">Not Ready</option>
                <option value="any">Any readiness</option>
              </NativeSelect>
            </label>
          </div>
        </details>
        {resetButton}
      </div>
    </div>
  );
}
