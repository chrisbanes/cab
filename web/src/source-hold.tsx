import {
  operatorCommandSchema,
  type Session,
  type TaskRead,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
import { Button } from "./components.js";
import {
  sourceHoldReasonText,
  sourceHoldResumeCaveat,
} from "./task-overview.js";

type Task = TaskRead["data"];

const unavailable = "Unavailable or redacted";

/**
 * The one source decision: Resume source hold, with the hold's reason and the source's current
 * text beside the task's. Resume clears only that hold; the service refuses it until the source
 * is open and ready, and that refusal is shown here rather than guessed from the read.
 */
export function SourceHoldCard({
  client,
  session,
  task,
  onChanged,
  onSend,
}: {
  client: OperatorClient;
  session: Session;
  task: Task;
  /** Rereads the task after a recorded resume or a conflict. */
  onChanged: () => void;
  /** A resume was sent. The container keeps this mounted so its answer outlives the hold. */
  onSend?: () => void;
}) {
  const taskId = task.task.id,
    source = task.source,
    hold = source?.hold;
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:source-review`,
    (c, r) =>
      c.type === "source.review" &&
      r.kind === "domain" &&
      r.key === c.key &&
      r.result.id === taskId,
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  const resolve = outcome?.kind === "recorded" || !hold?.active;
  // Nothing left to decide and nothing to report.
  if (resolve && !outcome) return null;
  return (
    <div className="decision" data-source-hold>
      <p className="small-heading">
        {resolve ? "Source hold" : "Your decision · source hold"}
      </p>
      {!resolve && source && (
        <>
          <p>{sourceHoldReasonText(hold?.reason ?? null)}</p>
          <dl className="inspector-facts">
            <dt>Source title</dt>
            <dd>{source.title ?? unavailable}</dd>
            <dt>Task title</dt>
            <dd>{task.task.title ?? unavailable}</dd>
          </dl>
          <p className="muted">{sourceHoldResumeCaveat}</p>
          {!uncertain && (
            <Button
              variant="secondary"
              disabled={Boolean(sending)}
              onClick={() => {
                onSend?.();
                void send(
                  operatorCommandSchema.parse({
                    type: "source.review",
                    key: crypto.randomUUID(),
                    projectId: task.task.projectId,
                    taskId,
                    expectedVersion: task.task.version,
                    decision: "resume-source-hold",
                  }),
                );
              }}
            >
              {sending ? "Resuming…" : "Resume source hold"}
            </Button>
          )}
        </>
      )}
      <SendFeedback
        entry={entry}
        outcome={outcome}
        recorded="Source hold resumed. Only that hold was cleared; other holds remain."
        conflict="Not resumed: the task or its source changed, or the source is not open and ready yet."
        check={() => void send()}
        review={{ label: "Review current state", onClick: clear }}
      />
      {!resolve && source && (
        <details>
          <summary>Source and task text</summary>
          <p className="small-heading">Source body</p>
          <pre className="literal-text">{source.body ?? unavailable}</pre>
          <p className="small-heading">Task outcome</p>
          <pre className="literal-text">{task.task.outcome ?? unavailable}</pre>
        </details>
      )}
    </div>
  );
}
