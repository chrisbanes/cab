import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { TaskRead } from "../../src/operator/contracts.js";
import { ActionLink, Button } from "./components.js";
import {
  originLabel,
  stopConsequences,
  taskColumnOf,
  taskIdentity,
  taskNextActor,
  taskReadiness,
} from "./task-overview.js";
import { type TaskTab, taskTabs } from "./task-tabs.js";
import { stateIcons } from "./task-views.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";

/** Plain data the task page reports to the shell header; the shell renders it. */
export interface TaskHeaderReport {
  taskId: string;
  title: string;
  subtitle?: string | undefined;
  back: { href: string; label: string; ariaLabel: string; history: boolean };
  stop: { affected: string; held: boolean; open: boolean };
}

export function taskHeaderReport(
  data: TaskRead["data"],
  projectName: string | null,
  origin: string | undefined,
): TaskHeaderReport {
  const title = data.task.title ?? "Title unavailable";
  const project = projectName ?? "project";
  const { affected, held } = stopConsequences(data);
  return {
    taskId: data.task.id,
    title,
    // The recorded desired outcome; the strip carries state and readiness.
    subtitle: data.task.outcome || undefined,
    back: origin
      ? {
          href: origin,
          label: originLabel(origin) ?? "Back",
          ariaLabel: "Back to originating view",
          history: true,
        }
      : {
          href: `/app/projects/${data.task.projectId}`,
          label: project,
          ariaLabel: `Back to ${project}`,
          history: false,
        },
    stop: { affected, held, open: data.task.state === "open" },
  };
}

/** Execution and Stop… (frame 46a). Stop confirms first, then posts the retained Stop form. */
export function TaskHeaderActions({
  report,
  csrfToken,
}: {
  report: TaskHeaderReport;
  csrfToken: string;
}) {
  const [open, setOpen] = useState(false),
    [sent, setSent] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  // A page restored from the back-forward cache after the Stop post starts closed again.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setOpen(false);
        setSent(false);
      }
    };
    addEventListener("pageshow", restored);
    return () => removeEventListener("pageshow", restored);
  }, []);
  return (
    <div className="task-header-actions">
      <ActionLink variant="secondary" href={`/runtime/task/${report.taskId}`}>
        Execution
      </ActionLink>
      {report.stop.held ? (
        <Button variant="destructive" disabled>
          Stop requested
        </Button>
      ) : report.stop.open ? (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setSent(false);
          }}
        >
          <DialogTrigger asChild>
            <Button variant="destructive">Stop…</Button>
          </DialogTrigger>
          <DialogContent
            role="alertdialog"
            className="stop-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              keep.current?.focus();
            }}
          >
            <DialogTitle>Stop {report.title}?</DialogTitle>
            <DialogDescription className="body">
              {report.stop.affected}
            </DialogDescription>
            <p className="body">
              Stops new work and asks running turns to end; some effects may
              still finish, and files, history and results are kept.
            </p>
            {/* The retained Stop control; it answers with the Execution page. */}
            <form
              method="post"
              action="/runtime/control/stop"
              className="stop-dialog-actions"
              onSubmit={(event) => {
                if (sent) event.preventDefault();
                else setSent(true);
              }}
            >
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <input type="hidden" name="taskId" value={report.taskId} />
              <Button type="submit" variant="destructive" disabled={sent}>
                Stop task
              </Button>
              <DialogClose asChild>
                <Button ref={keep} type="button" variant="secondary">
                  Keep running
                </Button>
              </DialogClose>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * The identity and status strip under the shell header: ID and source chip, state,
 * readiness, who acts next and the lead, then the page's persistent tools.
 */
export function TaskStrip({
  data,
  onNext,
  children,
}: {
  data: TaskRead["data"];
  /** Shows the open request: selects Overview and focuses the decision card. */
  onNext: () => void;
  children: ReactNode;
}) {
  const identity = taskIdentity(data),
    column = taskColumnOf(data),
    Icon = stateIcons[column],
    next = taskNextActor(data);
  return (
    <div className="task-strip" data-task-strip>
      <div className="task-strip-facts">
        <span className="task-id">{identity.label}</span>
        {data.source &&
          (identity.url ? (
            <a className="task-source-chip" href={identity.url}>
              Imported · {identity.label} ↗
            </a>
          ) : (
            <span className="task-source-chip">
              Imported · {identity.label}
            </span>
          ))}
        <span className="task-state" data-column={column}>
          <Icon aria-hidden="true" />
          {column}
        </span>
        <span data-task-readiness>{taskReadiness(data)}</span>
        {next.operator ? (
          <button
            type="button"
            className="task-next"
            data-operator="true"
            onClick={onNext}
          >
            {next.text}
          </button>
        ) : (
          <span className="task-next">{next.text}</span>
        )}
        <span>Accountable lead · {data.lead?.name ?? "Unconfigured"}</span>
      </div>
      {children}
    </div>
  );
}

/** The WAI-ARIA tab list; switching sends nothing and adds no history entry. */
export function TaskTabs({
  tab,
  select,
  notes = {},
}: {
  tab: TaskTab;
  select: (tab: TaskTab) => void;
  /** What waits on a tab the operator is not looking at, such as a check to run. */
  notes?: Partial<Record<TaskTab, string>>;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = taskTabs.findIndex(([id]) => id === tab),
      last = taskTabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const id = taskTabs[next]![0];
    select(id);
    document.getElementById(`task-tab-${id}`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Task sections"
      className="task-tabs"
      onKeyDown={move}
    >
      {taskTabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`task-tab-${id}`}
          aria-selected={id === tab}
          aria-controls={`task-panel-${id}`}
          tabIndex={id === tab ? 0 : -1}
          aria-description={notes[id]}
          data-note={notes[id] ? true : undefined}
          onClick={() => select(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
