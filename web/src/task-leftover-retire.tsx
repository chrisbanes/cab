import { randomUUID } from "./browser-crypto.js";
import { useId, useRef, useState } from "react";
import {
  type LeftoverExecution,
  leftoverExecutionSchema,
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
import { Textarea } from "./ui/textarea.js";

/** One leftover as the confirmation lists it. */
export function leftoverItemText(item: LeftoverExecution["items"][number]) {
  return item.kind === "request"
    ? `${item.status === "live" ? "Live" : "Unsettled"} ${item.profile} request ${item.workId}: ${item.reason}`
    : `${item.hold === "writer" ? "Writer" : item.hold === "ambiguity" ? "Ambiguity" : "Archival"} hold: ${item.reason}${item.workspaceEffects ? " (workspace effects unresolved)" : ""}`;
}

export const leftoverRetireCopy = {
  trigger: "Retire leftover execution…",
  title: (task: string) => `Retire the leftover execution of ${task}?`,
  irreversible:
    "Retiring cannot be undone. Each request is kept as history with its writer and capacity freed, and each hold is deleted. cab cannot prove a listed process has stopped.",
  reason: "Why these can be retired",
  confirm: "Retire leftovers",
  sending: "Retiring…",
  recorded: "Leftover execution retired.",
  conflict: "Not retired: the leftovers changed since they were listed.",
  unavailable: "The leftover execution could not be read.",
  refusals: {
    "task-not-closed":
      "Only a done or cancelled task's leftovers can be retired.",
    "live-turn":
      "Execution is still live; wait for it to end, then list again.",
    "nothing-to-retire": "Nothing is left to retire.",
  },
} as const;

/**
 * Retire leftover execution…: lists a done or cancelled task's leftovers once, then retires
 * exactly that listing. The service refuses if anything changed since it was read.
 */
export function RetireLeftovers({
  client,
  session,
  taskId,
  title,
  offered,
  onOpenChange,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  title: string;
  offered: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [shown, setShown] = useState<LeftoverExecution | null>(null),
    [failed, setFailed] = useState(false),
    [reason, setReason] = useState(""),
    [refusal, setRefusal] = useState<string | null>(null);
  const safe = useRef<HTMLButtonElement>(null),
    reasonId = useId();
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:recovery-retire`,
    (c, r) =>
      c.type === "recovery.retire" &&
      r.kind === "recovery-retire" &&
      r.key === c.key &&
      r.taskId === taskId &&
      r.digest === c.digest,
    (kind) => {
      if (kind === "recorded" || kind === "conflict")
        window.dispatchEvent(new Event(taskChangedEvent));
    },
  );
  const submit = async (command?: OperatorCommand) => {
    setRefusal(null);
    const settled = await send(command);
    if (settled?.result.state === "conflict" && settled.result.message)
      setRefusal(settled.result.message);
  };
  const load = async () => {
    setFailed(false);
    try {
      setShown(
        (
          await client.read(
            `/api/operator/tasks/${encodeURIComponent(taskId)}/leftover-execution`,
            leftoverExecutionSchema,
          )
        ).data,
      );
    } catch {
      setFailed(true);
    }
  };
  const close = () => {
    onOpenChange(false);
    setOpen(false);
    if (!uncertain) {
      clear();
      setRefusal(null);
      setShown(null);
    }
  };
  if (!offered && !open && !uncertain) return null;
  const retirable = shown !== null && shown.refusal === undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) return close();
        onOpenChange(true);
        setOpen(true);
        // An unconfirmed send keeps the listing it was sent for; a new confirmation reads again.
        if (!uncertain) void load();
      }}
    >
      <DialogTrigger asChild>
        <Button data-leftover-retire variant="destructive">
          {leftoverRetireCopy.trigger}
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
      >
        <DialogTitle>{leftoverRetireCopy.title(title)}</DialogTitle>
        <DialogDescription className="body">
          {leftoverRetireCopy.irreversible}
        </DialogDescription>
        {failed && <p className="body">{leftoverRetireCopy.unavailable}</p>}
        {shown?.refusal && (
          <p className="body" data-leftover-refusal>
            {leftoverRetireCopy.refusals[shown.refusal]}
          </p>
        )}
        {shown && (
          <ul className="body" data-leftover-items>
            {shown.items.map((item) => (
              <li
                key={
                  item.kind === "request"
                    ? item.workId
                    : `${item.hold}:${item.reason}`
                }
              >
                {leftoverItemText(item)}
              </li>
            ))}
          </ul>
        )}
        {outcome?.kind !== "recorded" && retirable && (
          <div className="body">
            <label htmlFor={reasonId}>{leftoverRetireCopy.reason}</label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        )}
        <SendFeedback
          entry={entry}
          outcome={outcome}
          recorded={leftoverRetireCopy.recorded}
          conflict={refusal ?? leftoverRetireCopy.conflict}
          check={() => void submit()}
          review={{
            label: "List them again",
            onClick: () => {
              clear();
              setRefusal(null);
              void load();
            },
          }}
        />
        <div className="stop-dialog-actions">
          {outcome?.kind !== "recorded" &&
            outcome?.kind !== "conflict" &&
            !uncertain &&
            retirable && (
              <Button
                variant="destructive"
                disabled={Boolean(sending) || reason.trim().length === 0}
                onClick={() =>
                  void submit(
                    operatorCommandSchema.parse({
                      type: "recovery.retire",
                      key: randomUUID(),
                      taskId,
                      digest: shown.digest,
                      reason: reason.trim(),
                    }),
                  )
                }
              >
                {sending
                  ? leftoverRetireCopy.sending
                  : leftoverRetireCopy.confirm}
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
