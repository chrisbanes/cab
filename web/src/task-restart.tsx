import { useState } from "react";
import {
  operatorCommandSchema,
  type ResetReason,
  type Session,
  type TaskRead,
} from "../../src/operator/contracts.js";
import {
  type RestartDestination,
  resetIrreversibleText,
  resetUnavailable,
  startAgainUnavailable,
} from "../../src/operator/task-restart-copy.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
import { ActionLink, Button } from "./components.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";

type Task = TaskRead["data"];

/** Sent by a control outside the task page after it changed the task, so the page rereads. */
export const taskChangedEvent = "ensemble-task-changed";

/** Where an unavailable action sends the operator, one link per destination. */
export function RestartDestinationLink({
  taskId,
  destination,
}: {
  taskId: string;
  destination: RestartDestination;
}) {
  if (destination === "none") return null;
  return (
    <ActionLink
      variant="secondary"
      href={
        destination === "recovery"
          ? `/runtime/task/${taskId}`
          : `/app/tasks/${taskId}?section=decisions`
      }
    >
      {destination === "recovery" ? "Open recovery" : "Review the source"}
    </ActionLink>
  );
}

/**
 * Start again for a request refused before it ran: one task-detail, Inbox and Home action.
 * When the service does not offer it, the reason and the recovery that applies are shown instead.
 */
export function StartAgainAction({
  client,
  session,
  task,
  onChanged,
  onStart,
}: {
  client: OperatorClient;
  session: Session;
  task: Task;
  /** Rereads the task after a recorded start or a conflict. */
  onChanged: () => void;
  /**
   * A start was sent. The container keeps this mounted from now on: a lost reply is checked here
   * after a later read has dropped the offer, so it must outlive the offer.
   */
  onStart?: () => void;
}) {
  const taskId = task.task.id,
    offer = task.startAgain;
  const { send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:start-again`,
    (c, r) =>
      c.type === "task.start-again" &&
      r.kind === "start-again" &&
      r.key === c.key &&
      r.taskId === taskId &&
      r.refusedWorkId === c.workId,
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  // A confirmation belongs to the request it was sent for: a restarted request refused again
  // is a new offer.
  const sentFor =
    outcome?.command.type === "task.start-again"
      ? outcome.command.workId
      : undefined;
  const sent =
    offer?.available && offer.workId !== sentFor && !uncertain ? null : outcome;
  const unavailable =
    offer && !offer.available && offer.reason
      ? startAgainUnavailable[offer.reason]
      : undefined;
  return (
    <div className="decision" data-start-again>
      <p className="small-heading">Your decision · not started</p>
      <p>
        This request was refused before it ran, so nothing ran. Start again
        queues it at the current task, profile and instructions revisions, in
        the same workspace. Nothing is sent to the lead.
      </p>
      {offer?.available && offer.workId
        ? sent?.kind !== "recorded" &&
          !uncertain && (
            <Button
              variant="secondary"
              disabled={Boolean(sending)}
              onClick={() => {
                onStart?.();
                void send(
                  operatorCommandSchema.parse({
                    type: "task.start-again",
                    key: crypto.randomUUID(),
                    taskId,
                    expectedVersion: task.task.version,
                    workId: offer.workId,
                  }),
                );
              }}
            >
              {sending ? "Starting…" : "Start again"}
            </Button>
          )
        : unavailable &&
          sent?.kind !== "recorded" &&
          !uncertain && (
            <>
              <p className="muted">
                Start again isn't offered: {unavailable.text}.
              </p>
              <RestartDestinationLink
                taskId={taskId}
                destination={unavailable.destination}
              />
            </>
          )}
      <SendFeedback
        outcome={sent}
        recorded="Queued again. It is admitted under the current checks."
        conflict="Not started again: the task changed since it was read."
        check={() => void send()}
        review={{ label: "Review current state", onClick: clear }}
      />
    </div>
  );
}

/**
 * Reset task, behind a confirmation that says it cannot be undone. When it is not offered the
 * control is disabled and its reason is its tooltip.
 */
export function ResetTask({
  client,
  session,
  taskId,
  title,
  version,
  offer,
  onChanged,
  onOpenChange,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  title: string;
  version: number;
  offer: { available: boolean; reason?: ResetReason | undefined } | undefined;
  onChanged: () => void;
  /** The dialog opened or closed, for a container that must stay open behind it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:reset`,
    (c, r) =>
      c.type === "task.reset" &&
      r.kind === "task-reset" &&
      r.key === c.key &&
      r.taskId === taskId,
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  if (!offer) return null;
  const unavailable = offer.reason ? resetUnavailable[offer.reason] : undefined;
  // An open dialog stays: a recorded reset makes the offer unavailable under its confirmation,
  // and so does an unconfirmed one, which must stay reachable to be checked.
  // Closed, the header only says why in a tooltip; the Execution link beside it leads to recovery.
  if (!offer.available && !open && !uncertain)
    return (
      <Button
        variant="secondary"
        disabled
        title={unavailable && `Not offered: ${unavailable.text}`}
      >
        Reset task…
      </Button>
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        setOpen(next);
        // An unconfirmed reset keeps its feedback, so it can still be checked.
        if (!next && !uncertain) clear();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">Reset task…</Button>
      </DialogTrigger>
      <DialogContent role="alertdialog" className="stop-dialog">
        <DialogTitle>Reset {title}?</DialogTitle>
        <DialogDescription className="body">
          {resetIrreversibleText}
        </DialogDescription>
        {!offer.available &&
          outcome?.kind !== "recorded" &&
          !uncertain &&
          unavailable && (
            <p className="muted">Reset isn't offered: {unavailable.text}.</p>
          )}
        <SendFeedback
          outcome={outcome}
          recorded="Reset. The lead starts a fresh conversation in the same workspace."
          conflict="Not reset: the task changed since it was read."
          check={() => void send()}
          review={{ label: "Review current state", onClick: clear }}
        />
        <div className="stop-dialog-actions">
          {outcome?.kind !== "recorded" && !uncertain && (
            <Button
              variant="destructive"
              disabled={Boolean(sending) || !offer.available}
              onClick={() => {
                void send(
                  operatorCommandSchema.parse({
                    type: "task.reset",
                    key: crypto.randomUUID(),
                    taskId,
                    expectedVersion: version,
                  }),
                );
              }}
            >
              {sending ? "Resetting…" : "Reset task"}
            </Button>
          )}
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              {outcome?.kind === "recorded" ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
