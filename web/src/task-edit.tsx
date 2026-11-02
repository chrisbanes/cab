import { useEffect, useId, useState } from "react";
import {
  operatorCommandSchema,
  type Session,
  textMaxLength,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
import { Button, TextField } from "./components.js";
import { taskChangedEvent } from "./task-restart.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Textarea } from "./ui/textarea.js";

/** The local task's editable values and the version they were read at. */
export interface TaskEditOffer {
  projectId: string;
  title: string;
  outcome: string;
  ready: boolean;
  version: number;
}

/** A draft filled from a read, remembering the values it started from. */
const fresh = (edit: TaskEditOffer) => ({ ...edit, base: edit });

/**
 * Edit task… for a local task: title, desired outcome and Ready, sent as `task.configure` at the
 * version read. After a conflict the fields adopt the newest read, so the next save is deliberate.
 */
export function EditTask({
  client,
  session,
  taskId,
  edit,
  onOpenChange,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  edit: TaskEditOffer;
  /** The dialog opened or closed, for a container that must stay open behind it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(fresh(edit)),
    id = useId();
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:edit`,
    (c, r) =>
      c.type === "task.configure" &&
      r.kind === "domain" &&
      r.key === c.key &&
      r.result.id === taskId,
    (kind) => {
      if (kind === "recorded" || kind === "conflict")
        window.dispatchEvent(new Event(taskChangedEvent));
    },
  );
  const { version } = edit;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new read after a conflict replaces the draft.
  useEffect(() => {
    if (
      outcome?.kind === "conflict" &&
      outcome.command.type === "task.configure" &&
      outcome.command.expectedVersion !== version
    )
      setDraft(fresh(edit));
  }, [outcome, version]);
  // As the retained page and the composer: a task keeps a title and a desired outcome.
  const changed = {
    ...(draft.title !== draft.base.title && { title: draft.title }),
    ...(draft.outcome !== draft.base.outcome && { outcome: draft.outcome }),
    ...(draft.ready !== draft.base.ready && { ready: draft.ready }),
  };
  const valid =
    draft.title.trim() !== "" &&
    draft.outcome.trim() !== "" &&
    Object.keys(changed).length > 0;
  // Opening starts from the latest read, not from an earlier abandoned draft.
  const reset = () => setDraft(fresh(edit));
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next);
        setOpen(next);
        if (next) reset();
        // An unconfirmed save keeps its feedback, so it can still be checked.
        else if (!uncertain) clear();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">Edit task…</Button>
      </DialogTrigger>
      <DialogContent className="stop-dialog">
        <DialogTitle>Edit task</DialogTitle>
        <DialogDescription className="body">
          Changes the title, desired outcome and Ready for this local task.
          Ready makes it eligible for future admission; it does not start work.
        </DialogDescription>
        <form
          className="task-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (uncertain || !valid) return;
            void send(
              operatorCommandSchema.parse({
                type: "task.configure",
                key: crypto.randomUUID(),
                projectId: edit.projectId,
                taskId,
                // The version the draft was filled from, not a later read that arrived while editing.
                expectedVersion: draft.version,
                // Only what the operator changed: an untouched field is never sent back.
                ...changed,
              }),
            );
          }}
        >
          <TextField
            id={`${id}-title`}
            label="Title"
            value={draft.title}
            maxLength={512}
            required
            disabled={Boolean(sending) || uncertain}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <label className="field body" htmlFor={`${id}-outcome`}>
            Desired outcome
            <Textarea
              id={`${id}-outcome`}
              autoGrow
              maxLength={textMaxLength}
              value={draft.outcome}
              disabled={Boolean(sending) || uncertain}
              onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
            />
          </label>
          <label className="body check-field" htmlFor={`${id}-ready`}>
            <Input
              id={`${id}-ready`}
              data-slot="checkbox-input"
              type="checkbox"
              className="native-check size-5 shrink-0 p-0 accent-foreground"
              checked={draft.ready}
              disabled={Boolean(sending) || uncertain}
              onChange={(e) => setDraft({ ...draft, ready: e.target.checked })}
            />
            Ready
          </label>
          <SendFeedback
            entry={entry}
            outcome={outcome}
            recorded="Saved."
            conflict="Not saved: the task changed, or cannot be edited right now. The latest values are shown."
            check={() => void send()}
            review={{ label: "Dismiss", onClick: clear }}
          />
          <div className="stop-dialog-actions">
            {outcome?.kind !== "recorded" && !uncertain && (
              <Button type="submit" disabled={Boolean(sending) || !valid}>
                {sending ? "Saving…" : "Save"}
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {outcome?.kind === "recorded" ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
