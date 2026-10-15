import { useEffect, useRef, useState } from "react";
import type { TaskRead } from "../../src/operator/contracts.js";
import { ActionLink, Button } from "./components.js";
import {
  originLabel,
  stopConsequences,
  taskStatusLine,
} from "./task-overview.js";
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
  subtitle: string;
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
    subtitle: taskStatusLine(data),
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
