import { randomUUID } from "./browser-crypto.js";
import { useRef, useState } from "react";
import {
  type OperatorCommand,
  operatorCommandSchema,
  type Session,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
import { Button } from "./components.js";
import { taskChangedEvent } from "./task-restart.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { workspaceRemovalCopy as copy } from "./workspace-removal-presentation.js";

/**
 * Remove workspace…: one confirmation of what goes and what stays. The dialog keeps the workspace
 * it was opened for, so a confirmation left open never names a later workspace; the service
 * refuses one that no longer matches and derives every safety check itself.
 */
export function RemoveWorkspace({
  client,
  session,
  taskId,
  title,
  workspaceId,
  offered,
  onOpenChange,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  title: string;
  /** The task's current workspace generation from the latest read. */
  workspaceId: string | null;
  offered: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [confirmed, setConfirmed] = useState<string | null>(null),
    [reason, setReason] = useState<string | null>(null);
  const safe = useRef<HTMLButtonElement>(null);
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:workspace-remove`,
    (c, r) =>
      c.type === "task.workspace.remove" &&
      r.kind === "workspace-remove" &&
      r.key === c.key &&
      r.taskId === taskId &&
      r.workspaceId === c.workspaceId,
    (kind) => {
      if (kind === "recorded" || kind === "conflict")
        window.dispatchEvent(new Event(taskChangedEvent));
    },
  );
  // The service's refusal reason, kept for this confirmation; a check of a lost reply reports it too.
  const submit = async (command?: OperatorCommand) => {
    setReason(null);
    const settled = await send(command);
    if (settled?.result.state === "conflict" && settled.result.message)
      setReason(settled.result.message);
  };
  const close = () => {
    onOpenChange(false);
    setOpen(false);
    if (!uncertain) {
      clear();
      setReason(null);
    }
  };
  if (!offered && !open && !uncertain) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) return close();
        onOpenChange(true);
        setOpen(true);
        // An unconfirmed send keeps its exact command; a new confirmation names the current workspace.
        if (!uncertain) setConfirmed(workspaceId);
      }}
    >
      <DialogTrigger asChild>
        <Button data-workspace-remove variant="destructive">
          {copy.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent
        role="alertdialog"
        className="stop-dialog"
        onOpenAutoFocus={(event) => {
          // A destructive confirmation opens on its safe choice.
          event.preventDefault();
          safe.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // A removed workspace takes its trigger away: focus the header's remaining control.
          event.preventDefault();
          requestAnimationFrame(() =>
            (
              document.querySelector<HTMLElement>(
                ".task-header-actions [data-workspace-remove]",
              ) ?? document.querySelector<HTMLElement>(".task-header-actions a")
            )?.focus(),
          );
        }}
      >
        <DialogTitle>{copy.title(title)}</DialogTitle>
        <DialogDescription className="body">
          {copy.irreversible}
        </DialogDescription>
        <h3 className="inspector-label">What goes</h3>
        <ul className="body">
          {copy.goes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <h3 className="inspector-label">What stays</h3>
        <ul className="body">
          {copy.stays.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <SendFeedback
          entry={entry}
          outcome={outcome}
          recorded={copy.recorded}
          conflict={reason ?? copy.conflict}
          check={() => void submit()}
          // A refused confirmation is finished: reviewing closes it, so a new one names the current workspace.
          review={{ label: "Review current state", onClick: close }}
        />
        <div className="stop-dialog-actions">
          {outcome?.kind !== "recorded" &&
            outcome?.kind !== "conflict" &&
            !uncertain &&
            confirmed && (
              <Button
                variant="destructive"
                disabled={Boolean(sending)}
                onClick={() =>
                  void submit(
                    operatorCommandSchema.parse({
                      type: "task.workspace.remove",
                      key: randomUUID(),
                      taskId,
                      workspaceId: confirmed,
                    }),
                  )
                }
              >
                {sending ? copy.sending : copy.confirm}
              </Button>
            )}
          <DialogClose asChild>
            <Button ref={safe} type="button" variant="secondary">
              {outcome?.kind === "recorded" ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
