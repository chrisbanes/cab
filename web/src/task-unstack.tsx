import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandReceipt,
  OperatorCommand,
  Session,
} from "../../src/operator/contracts.js";
import {
  unstackPreviewSchema,
  unstackReadSchema,
  type UnstackRead,
} from "../../src/operator/unstack-contracts.js";
import {
  unstackConfirmation,
  unstackRecovery,
  unstackStatus,
  cancelStackedConfirmation,
} from "../../src/operator/unstack-copy.js";
import { useCommandSend } from "./command-send.js";
import type { OperatorClient } from "./api.js";
import { Button } from "./components.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.js";
import { taskChangedEvent } from "./task-restart.js";

/** Both entry points share this captured preview, dialog and GET-only recovery. No generic resend control. */
export function TaskUnstack({
  client,
  session,
  taskId,
  taskVersion,
  stacked,
  readOnly,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  taskVersion: number;
  stacked: boolean;
  readOnly: boolean;
}) {
  const [loaded, setView] = useState<UnstackRead["data"] | null>(null),
    [mode, setMode] = useState<"unstack" | "cancel" | null>(null),
    [note, setNote] = useState<string | null>(null),
    [checking, setChecking] = useState(false);
  const view = loaded?.taskId === taskId ? loaded : null;
  const writeReadOnly = readOnly || Boolean(view?.readOnly);
  const safe = useRef<HTMLButtonElement>(null),
    trigger = useRef<HTMLElement | null>(null);
  const currentTask = useRef(taskId),
    readSequence = useRef(0);
  currentTask.current = taskId;
  useEffect(() => {
    setView((prior) => (prior?.taskId === taskId ? prior : null));
    setMode(null);
    setNote(null);
    setChecking(false);
  }, [taskId]);
  const matches = (c: OperatorCommand, r: CommandReceipt) =>
    (c.type === "task.unstack" &&
      r.kind === "task-unstack" &&
      r.key === c.key &&
      r.taskId === c.taskId &&
      r.expectedVersion === c.expectedVersion &&
      r.materialHash === c.materialHash) ||
    (c.type === "task.cancel" &&
      r.kind === "task-cancel" &&
      r.key === c.key &&
      r.taskId === c.taskId);
  const unstack = useCommandSend(
    client,
    session,
    `${taskId}:unstack`,
    matches,
    undefined,
    writeReadOnly,
  );
  const cancel = useCommandSend(
    client,
    session,
    `${taskId}:stacked-cancel`,
    matches,
    undefined,
    writeReadOnly,
  );
  const active = mode === "cancel" ? cancel : unstack;
  const refresh = useCallback(async () => {
    const authentication = client.captureAuthenticationScope(),
      sequence = ++readSequence.current;
    try {
      const read = await client.read(
        `/api/operator/tasks/${taskId}/unstack`,
        unstackReadSchema,
      );
      if (
        authentication() &&
        currentTask.current === taskId &&
        sequence === readSequence.current
      )
        setView(read.data);
    } catch {
      if (
        authentication() &&
        currentTask.current === taskId &&
        sequence === readSequence.current
      ) {
        setView(null);
        setNote(
          "Unstack state is unavailable. Original drafts and operations are retained; nothing was sent again.",
        );
      }
    }
  }, [client, taskId]);
  useEffect(() => {
    if (taskVersion > 0) void refresh();
    const update = () => void refresh();
    addEventListener(taskChangedEvent, update);
    return () => removeEventListener(taskChangedEvent, update);
  }, [refresh, taskVersion]);
  // A captured, filtered preview survives navigation in the existing signed-in send entry.
  const parsed = (() => {
    try {
      return unstackPreviewSchema.safeParse(JSON.parse(unstack.entry.text));
    } catch {
      return null;
    }
  })();
  const captured =
    parsed?.success && parsed.data.taskId === taskId ? parsed.data : null;
  const frozen = active.entry.lifecycle.frozen;
  const discloseCapture =
    captured &&
    view &&
    (view.preview?.materialHash === captured.materialHash ||
      view.operation?.materialHash === captured.materialHash);
  const cancelVersion = Number(cancel.entry.text);
  const checkOriginal = async () => {
    const command = active.entry.lifecycle.frozen;
    const saved = mode === "cancel" ? view?.cancelOperation : view?.operation;
    if (
      (!command ||
        (command.type !== "task.unstack" && command.type !== "task.cancel")) &&
      !saved
    ) {
      await refresh();
      return;
    }
    const type =
      command?.type === "task.cancel" ||
      (!command && saved?.kind === "task-cancel")
        ? "task.cancel"
        : "task.unstack";
    const originalKey = command?.key ?? saved!.key;
    setChecking(true);
    setNote(null);
    const authentication = client.captureAuthenticationScope();
    try {
      const read = await client.operation({
        scope: `task:${taskId}`,
        type,
        key: originalKey,
      });
      if (!authentication() || currentTask.current !== taskId) return;
      if (
        read.data.state === "recorded" &&
        (command
          ? matches(command, read.data.receipt)
          : read.data.receipt.key === originalKey &&
            "taskId" in read.data.receipt &&
            read.data.receipt.taskId === taskId &&
            (type === "task.unstack"
              ? read.data.receipt.kind === "task-unstack" &&
                saved?.kind === "task-unstack" &&
                read.data.receipt.materialHash === saved.materialHash &&
                read.data.receipt.expectedVersion === saved.expectedVersion
              : read.data.receipt.kind === "task-cancel"))
      ) {
        if (command)
          active.entry.settle(
            command,
            { state: "recorded", receipt: read.data.receipt },
            matches,
          );
        window.dispatchEvent(new Event(taskChangedEvent));
        await refresh();
      } else
        setNote(
          "The original receipt is not available. Keep this operation key; do not send again or choose a new key.",
        );
    } catch {
      if (authentication() && currentTask.current === taskId)
        setNote("The original receipt could not be read. Nothing was resent.");
    } finally {
      if (authentication() && currentTask.current === taskId)
        setChecking(false);
    }
  };
  const open = (kind: "unstack" | "cancel", element: HTMLElement) => {
    trigger.current = element;
    setMode(kind);
    setNote(null);
    if (
      kind === "unstack" &&
      !unstack.uncertain &&
      !unstack.sending &&
      view?.preview
    )
      unstack.entry.edit(JSON.stringify(view.preview));
    if (kind === "cancel" && !cancel.uncertain && !cancel.sending)
      cancel.entry.edit(String(taskVersion));
  };
  const submit = async () => {
    if (!view || writeReadOnly || active.uncertain || active.sending) return;
    const command: OperatorCommand | null =
      mode === "cancel" && view.cancelAvailable && cancelVersion === taskVersion
        ? {
            type: "task.cancel",
            key: crypto.randomUUID(),
            taskId,
            expectedVersion: cancelVersion,
          }
        : mode === "unstack" &&
            view.available &&
            captured &&
            view.preview?.materialHash === captured.materialHash
          ? {
              type: "task.unstack",
              key: crypto.randomUUID(),
              taskId,
              expectedVersion: captured.expectedVersion,
              materialHash: captured.materialHash,
            }
          : null;
    if (!command) return;
    await active.send(command);
    window.dispatchEvent(new Event(taskChangedEvent));
    await refresh();
  };
  const receipt = active.entry.lifecycle.receipt;
  const operation =
    receipt?.kind === "task-unstack" ? receipt : view?.operation;
  const hasStatus = Boolean(operation || unstack.uncertain);
  const hasCancelStatus = Boolean(view?.cancelOperation || cancel.uncertain);
  if (
    !mode &&
    !stacked &&
    !view?.available &&
    !view?.failedBlocker &&
    !hasStatus &&
    !hasCancelStatus
  )
    return null;
  return (
    <section aria-label="Stack recovery">
      {!view?.available && !hasStatus && (
        <p>
          {view?.readOnly
            ? "Stack recovery is read-only while this project is archived."
            : "Unstack preview is unavailable or unproved."}
        </p>
      )}
      <Button
        variant="secondary"
        onClick={(e) => open("unstack", e.currentTarget)}
        disabled={!hasStatus && (!view?.available || writeReadOnly)}
      >
        {hasStatus ? "Unstack status…" : "Unstack…"}
      </Button>
      {(view?.failedBlocker || hasCancelStatus) && (
        <div role="alert" aria-label="Failed stacked blocker">
          {view?.failedBlocker && (
            <p>The blocker failed. Independent holds remain.</p>
          )}
          <Button
            variant="secondary"
            disabled={!hasStatus && (!view?.available || writeReadOnly)}
            onClick={(e) => open("unstack", e.currentTarget)}
          >
            Unstack failed dependency…
          </Button>
          <Button
            variant="destructive"
            disabled={
              !hasCancelStatus &&
              (!view?.cancelAvailable ||
                writeReadOnly ||
                Boolean(cancel.sending))
            }
            onClick={(e) => open("cancel", e.currentTarget)}
          >
            {hasCancelStatus ? "Cancel status…" : "Cancel task…"}
          </Button>
        </div>
      )}
      <Dialog
        open={mode !== null}
        onOpenChange={(next) => {
          if (!next) setMode(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            safe.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
        >
          <DialogTitle>
            {mode === "cancel" ? "Cancel this task?" : "Unstack provider stack"}
          </DialogTitle>
          <DialogDescription>
            {mode === "cancel"
              ? cancelStackedConfirmation
              : unstackConfirmation}
          </DialogDescription>
          {mode === "unstack" && (
            <>
              {discloseCapture && captured && (
                <p>
                  Captured stack #{captured.stackNumber} in{" "}
                  {captured.repository}:{" "}
                  {captured.members
                    .map((m) => `#${m.number} (${m.state})`)
                    .join(", ")}
                  . Retarget #{captured.selectedPr} to {captured.targetBase}.
                </p>
              )}
              <p>{unstackRecovery}</p>
              {captured && !discloseCapture && (
                <p>Retained preview details are currently withheld.</p>
              )}
              {operation && <p role="status">{unstackStatus(operation)}</p>}
            </>
          )}
          {mode === "cancel" &&
            (receipt?.kind === "task-cancel" || view?.cancelOperation) && (
              <p role="status">
                Task cancelled. Ownership, workspace and history remain.
              </p>
            )}
          {active.uncertain && (
            <p role="status">
              Outcome unknown. Keep the original operation {frozen?.key}.
              Nothing will be resent.
            </p>
          )}
          {note && <p role="status">{note}</p>}
          {active.outcome?.kind === "conflict" && (
            <p role="status">
              State changed. Close and review a fresh preview.
            </p>
          )}
          {writeReadOnly && (
            <p>
              {view?.readOnly
                ? "This project is archived. Reads and original receipt checks remain available."
                : "This project's current write authority is unavailable. Reads and original receipt checks remain available."}
            </p>
          )}
          {(active.uncertain ||
            (mode === "unstack" &&
              operation &&
              !["confirmed", "failed"].includes(operation.phase)) ||
            (mode === "cancel" && view?.cancelOperation)) && (
            <Button
              variant="secondary"
              disabled={checking}
              onClick={() => void checkOriginal()}
            >
              Check original operation
            </Button>
          )}
          {!active.uncertain &&
            !active.sending &&
            !writeReadOnly &&
            (mode !== "cancel" || receipt?.kind !== "task-cancel") &&
            (mode === "unstack"
              ? view?.available &&
                captured &&
                view.preview?.materialHash === captured.materialHash
              : view?.cancelAvailable && cancelVersion === taskVersion) && (
              <Button variant="destructive" onClick={() => void submit()}>
                {mode === "cancel" ? "Confirm Cancel task" : "Confirm Unstack"}
              </Button>
            )}
          <DialogClose asChild>
            <Button ref={safe} type="button" variant="secondary">
              {receipt ||
              frozen ||
              operation ||
              (mode === "cancel" && view?.cancelOperation)
                ? "Close"
                : "Keep task unchanged"}
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </section>
  );
}
