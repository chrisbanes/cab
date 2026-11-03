import { Ellipsis } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  operatorCommandSchema,
  type Session,
  type TaskRead,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend, useCommandSends } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
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
import { EditTask, type TaskEditOffer } from "./task-edit.js";
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
  /** Edit task…: a local task's editable values, null for an imported task (its text is the source's). */
  edit: TaskEditOffer | null;
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
    edit:
      data.source === null &&
      data.task.textExact &&
      data.task.title !== null &&
      data.task.outcome !== null
        ? {
            projectId: data.task.projectId,
            title: data.task.title,
            outcome: data.task.outcome,
            ready: data.task.ready,
            version: data.task.version,
          }
        : null,
  };
}

/**
 * Execution, Edit task…, Reset task…, Stop… and Resume…: from 760px they sit in the header; on a phone
 * the one "Task actions" disclosure holds them. It is one element at every width, forced open
 * from 760px, so a resize never remounts a dialog. Stop and Resume confirm first, then send
 * `task.stop` or `task.resume` through the command flow.
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
  const [open, setOpen] = useState(false),
    [resetOpen, setResetOpen] = useState(false),
    [editOpen, setEditOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  // An unconfirmed reset keeps its control, so a lost reply can still be checked; otherwise the
  // control follows the task's current offer.
  const sends = useCommandSends(),
    resetUncertain = useSyncExternalStore(
      sends.subscribe,
      () => sends.entry(`${report.taskId}:reset`).uncertain,
    );
  const phone = useMediaQuery("(max-width: 759px)");
  const overflow = useRef<HTMLDetailsElement>(null);
  // A tap outside closes the phone overflow; the Stop dialog's own layer is not outside.
  useEffect(() => {
    if (!phone || open || resetOpen || editOpen) return;
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
  }, [phone, open, resetOpen, editOpen]);
  // A page restored from the back-forward cache starts with the phone overflow closed: it is
  // a visit-long overlay, not state to keep.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setMenuOpen(false);
        setOpen(false);
        setEditOpen(false);
      }
    };
    addEventListener("pageshow", restored);
    return () => removeEventListener("pageshow", restored);
  }, []);
  return (
    <details
      ref={overflow}
      className="task-header-overflow"
      open={!phone || menuOpen || open || resetOpen || editOpen}
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
        <ActionLink
          variant="secondary"
          href={`/app/tasks/${report.taskId}?section=execution`}
        >
          Execution
        </ActionLink>
        {report.edit && (
          <EditTask
            client={client}
            session={session}
            taskId={report.taskId}
            edit={report.edit}
            onOpenChange={(next) => {
              if (phone) setMenuOpen(true);
              setEditOpen(next);
            }}
          />
        )}
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
        {(["stop", "resume"] as const).map((kind) => (
          <HoldCommand
            key={kind}
            kind={kind}
            client={client}
            session={session}
            report={report}
            onOpenChange={(next) => {
              // On a phone the trigger lives in the overflow, which stays open behind the dialog
              // and after it, so focus returns to a visible control.
              if (phone) setMenuOpen(true);
              setOpen(next);
            }}
          />
        ))}
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

const holdCopy = {
  stop: {
    trigger: "Stop…",
    title: (t: string) => `Stop ${t}?`,
    body: "Stops new work and asks running turns to end; some effects may still finish, and files, history and results are kept.",
    confirm: "Stop task",
    sending: "Stopping…",
    cancel: "Keep running",
    recorded:
      "Stop requested. New turns are held; running turns are asked to end, and some effects may still finish.",
    conflict: "Not stopped: the task changed since it was read.",
  },
  resume: {
    trigger: "Resume…",
    title: (t: string) => `Resume ${t}?`,
    body: "Clears only the operator Stop. Writer, capacity, uncertainty and task holds stay until recovery resolves them, and work stopped earlier may still have effects.",
    confirm: "Resume task",
    sending: "Resuming…",
    cancel: "Cancel",
    recorded:
      "Resumed. Only the Stop was cleared; any other hold remains until recovery resolves it.",
    conflict: "Not resumed: the task changed since it was read.",
  },
} as const;

/**
 * Stop… on an open task that is not stopped, Resume… on a stopped one. The dialog opens on its
 * safe choice; it stays open after a send to report the outcome, and an unconfirmed send keeps
 * its control so the same request can be checked after a reread drops the offer.
 */
function HoldCommand({
  kind,
  client,
  session,
  report,
  onOpenChange,
}: {
  kind: "stop" | "resume";
  client: OperatorClient;
  session: Session;
  report: TaskHeaderReport;
  onOpenChange: (open: boolean) => void;
}) {
  const taskId = report.taskId,
    copy = holdCopy[kind];
  const [open, setOpen] = useState(false);
  const safe = useRef<HTMLButtonElement>(null);
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:${kind}`,
    (c, r) =>
      kind === "stop"
        ? c.type === "task.stop" &&
          r.kind === "task-stop" &&
          r.key === c.key &&
          r.taskId === taskId
        : c.type === "task.resume" &&
          r.kind === "task-resume" &&
          r.key === c.key &&
          r.taskId === taskId,
    (settled) => {
      if (settled === "recorded" || settled === "conflict")
        window.dispatchEvent(new Event(taskChangedEvent));
    },
  );
  // A page restored from the back-forward cache starts closed: the dialog is a visit-long overlay.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setOpen(false);
    };
    addEventListener("pageshow", restored);
    return () => removeEventListener("pageshow", restored);
  }, []);
  const offered =
    kind === "stop" ? report.stop.open && !report.stop.held : report.stop.held;
  if (!offered && !open && !uncertain) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        setOpen(next);
        // An unconfirmed send keeps its feedback, so it can still be checked.
        if (!next && !uncertain) clear();
      }}
    >
      <DialogTrigger asChild>
        <Button
          data-hold-command
          variant={kind === "stop" ? "destructive" : "secondary"}
        >
          {copy.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent
        role="alertdialog"
        className="stop-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          safe.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // A recorded Stop or Resume swaps the trigger for the other control: focus whichever remains.
          event.preventDefault();
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>(
                ".task-header-actions [data-hold-command]",
              )
              ?.focus(),
          );
        }}
      >
        <DialogTitle>{copy.title(report.title)}</DialogTitle>
        <DialogDescription className="body">
          {kind === "stop" ? report.stop.affected : copy.body}
        </DialogDescription>
        {kind === "stop" && <p className="body">{copy.body}</p>}
        <SendFeedback
          entry={entry}
          outcome={outcome}
          recorded={copy.recorded}
          conflict={copy.conflict}
          check={() => void send()}
          review={{ label: "Review current state", onClick: clear }}
        />
        <div className="stop-dialog-actions">
          {outcome?.kind !== "recorded" && !uncertain && (
            <Button
              variant={kind === "stop" ? "destructive" : "primary"}
              disabled={Boolean(sending)}
              onClick={() =>
                void send(
                  operatorCommandSchema.parse({
                    type: kind === "stop" ? "task.stop" : "task.resume",
                    key: crypto.randomUUID(),
                    taskId,
                  }),
                )
              }
            >
              {sending ? copy.sending : copy.confirm}
            </Button>
          )}
          <DialogClose asChild>
            <Button ref={safe} type="button" variant="secondary">
              {outcome?.kind === "recorded" ? "Close" : copy.cancel}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
