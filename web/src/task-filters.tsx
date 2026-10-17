import { useEffect, useState } from "react";
import type { Workspace } from "../../src/operator/contracts.js";
import { workspaceLabels } from "../../src/operator/project-labels.js";
import { Button } from "./components.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { columns, type TaskFilters } from "./tasks.js";

/** One row: heading, List/Board switch, inline Project and State dropdowns, count, refresh. */
export function TaskToolbar({
  filters,
  update,
  workspace,
  projectId,
  overview,
  count,
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
  refresh: () => void;
  pending: boolean;
  /** ≤759px: the selects group up front, in the order they appear, and the Board can lend a chip slot. */
  phone?: boolean | undefined;
  /** Phone Board: receives the element the column chips are portalled into. */
  columnsSlot?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const labels = workspaceLabels(workspace);
  const hasMore = Boolean(filters.q || filters.source || filters.ready);
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
      {count} task{count === 1 ? "" : "s"}
    </p>
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
      <details
        className="work-more"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary className="metadata muted">More filters</summary>
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
              onChange={(e) => update({ ready: e.target.value })}
            >
              <option value="">Any readiness</option>
              <option value="yes">Ready</option>
              <option value="no">Not Ready</option>
            </NativeSelect>
          </label>
        </div>
      </details>
    </div>
  );
}
