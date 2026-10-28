import { Ellipsis } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Session, TaskRead } from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { CommandSendsContext } from "./command-send.js";
import { ActionLink, Button } from "./components.js";
import { outcomeLine } from "./presentation.js";
import { MarkdownPreview } from "./task-files.js";
import {
  originLabel,
  stopConsequences,
  taskColumnOf,
  taskIdentity,
  taskNextActor,
  taskReadiness,
} from "./task-overview.js";
import { type TaskTab, taskTabs } from "./task-tabs.js";
import { useMediaQuery } from "./use-media-query.js";
import { ResetTask, taskChangedEvent } from "./task-restart.js";
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
  /** The mono identity the phone header shows under the title: `repository#N` or "Local task". */
  identity: string;
  back: { href: string; label: string; ariaLabel: string; history: boolean };
  stop: { affected: string; held: boolean; open: boolean };
  /** Reset task: whether it is offered, the task version it is sent with and why not. */
  reset: {
    offer: NonNullable<TaskRead["data"]["reset"]>;
    version: number;
  } | null;
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
    // The outcome's first line; the strip discloses the rest and carries state and readiness.
    subtitle: outcomeLine(data.task.outcome).line || undefined,
    identity: taskIdentity(data).label,
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
    reset: data.reset
      ? { offer: data.reset, version: data.task.version }
      : null,
  };
}

/**
 * Execution and Stop… (frame 46a). From 760px they sit in the header; on a phone (frame 47)
 * the one "Task actions" disclosure holds them. It is one element at every width, forced open
 * from 760px, so a resize never remounts the Stop dialog. Stop confirms first, then posts the
 * retained Stop form.
 */
export function TaskHeaderActions({
  report,
  client,
  session,
}: {
  report: TaskHeaderReport;
  client: OperatorClient;
  session: Session;
}) {
  const csrfToken = session.csrfToken;
  const [open, setOpen] = useState(false),
    [sent, setSent] = useState(false),
    [resetOpen, setResetOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  // An unconfirmed reset keeps its control, so a lost reply can still be checked; otherwise the
  // control follows the task's current offer.
  const sends = useContext(CommandSendsContext),
    resetUncertain = useSyncExternalStore(
      (listener) => sends.subscribe(listener),
      () => sends.entry(`${report.taskId}:reset`).uncertain,
    );
  const phone = useMediaQuery("(max-width: 759px)");
  const keep = useRef<HTMLButtonElement>(null),
    overflow = useRef<HTMLDetailsElement>(null);
  // A tap outside closes the phone overflow; the Stop dialog's own layer is not outside.
  useEffect(() => {
    if (!phone || open || resetOpen) return;
    const away = (event: PointerEvent) => {
      const details = overflow.current;
      if (details?.open && !details.contains(event.target as Node)) {
        // Close the element itself: its own toggle event may still be queued behind this tap.
        details.open = false;
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [phone, open, resetOpen]);
  // A page restored from the back-forward cache (after Execution or the Stop post) starts
  // closed again: the dialog and the phone overflow are visit-long overlays, not state to keep.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setMenuOpen(false);
        setOpen(false);
        setSent(false);
      }
    };
    addEventListener("pageshow", restored);
    return () => removeEventListener("pageshow", restored);
  }, []);
  return (
    <details
      ref={overflow}
      className="task-header-overflow"
      open={!phone || menuOpen || open || resetOpen}
      onToggle={(event) => {
        if (phone) setMenuOpen(event.currentTarget.open);
      }}
      onKeyDown={(event) => {
        // The portalled dialog keeps its own Escape (its target is outside this element); the
        // next one closes the overflow and returns to its summary.
        if (
          event.key !== "Escape" ||
          !phone ||
          !event.currentTarget.open ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        event.preventDefault();
        event.currentTarget.open = false;
        setMenuOpen(false);
        event.currentTarget.querySelector("summary")?.focus();
      }}
    >
      <summary className="task-header-overflow-toggle">
        <Ellipsis aria-hidden="true" />
        <span className="sr-only">Task actions</span>
      </summary>
      <div className="task-header-actions">
        <ActionLink variant="secondary" href={`/runtime/task/${report.taskId}`}>
          Execution
        </ActionLink>
        {report.reset && (report.stop.open || resetOpen || resetUncertain) && (
          <ResetTask
            client={client}
            session={session}
            taskId={report.taskId}
            title={report.title}
            version={report.reset.version}
            offer={report.reset.offer}
            onOpenChange={(next) => {
              // The trigger lives in the overflow, which stays open behind the dialog.
              if (phone) setMenuOpen(true);
              setResetOpen(next);
            }}
            onChanged={() => window.dispatchEvent(new Event(taskChangedEvent))}
          />
        )}
        {report.stop.held ? (
          <Button variant="destructive" disabled>
            Stop requested
          </Button>
        ) : report.stop.open ? (
          <Dialog
            open={open}
            onOpenChange={(next) => {
              // On a phone the trigger lives in the overflow, which stays open behind the dialog
              // and after it, so focus returns to a visible Stop….
              if (phone) setMenuOpen(true);
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
    </details>
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
    next = taskNextActor(data),
    outcome = outcomeLine(data.task.outcome);
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
      {/* On a phone the header subtitle is the identity, so a one-line outcome is read here too. */}
      {(outcome.more || outcome.line) && data.task.outcome && (
        <details
          className="task-outcome"
          data-phone-only={outcome.more ? undefined : true}
        >
          <summary>Full desired outcome</summary>
          <MarkdownPreview text={data.task.outcome} />
        </details>
      )}
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
