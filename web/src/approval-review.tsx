import {
  operatorCommandSchema,
  type JsonValue,
  type OperatorCommand,
  type Session,
  type TaskRead,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
import { ActionLink, Button, ShortId, StatusBadge } from "./components.js";
import { safePullRequestUrl } from "./delivery-presentation.js";
import { failureCause } from "./outcome-copy.js";

type Approval = TaskRead["data"]["approvals"][number];
type Decision = "approved" | "denied";

const copy = {
  approved:
    "Approved. The action is allowed but has not started; the requester receives the decision on its next eligible turn.",
  denied:
    "Denied. Nothing was approved; the requester receives the denial on its next eligible turn.",
  unknown:
    "We couldn't confirm the decision was recorded. Check whether it saved; the same decision is never recorded twice.",
  conflict:
    "This approval was already decided, changed or withdrawn. Nothing was recorded; review the current material.",
  failed: (code: string) =>
    `The decision was not recorded: ${failureCause(code)}. The approval is still pending.`,
};

/**
 * One approval's exact action, target, version and material, decided in place. The decision binds
 * the revision and material shown; a changed request is a new review.
 */
export function ApprovalReview({
  client,
  session,
  taskId,
  approval,
  requesterName,
  onChanged,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  approval: Approval;
  requesterName: string | null;
  /** Rereads the task after a recorded decision or a conflict. */
  onChanged: () => void;
}) {
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:approval:${approval.interactionId}`,
    (c, r) =>
      r.kind === "coordination" &&
      r.key === c.key &&
      r.taskId === taskId &&
      r.eventType === "approval-decision",
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  const open = approval.status === "open",
    // Deny never needs the disclosed fields: the server binds it to the retained originals.
    decidable =
      open && outcome?.kind !== "recorded" && outcome?.kind !== "conflict",
    decided = (c: OperatorCommand | null | undefined) =>
      c?.type === "approval.decide" ? c.decision : null;
  const decide = (decision: Decision) =>
    send(
      operatorCommandSchema.parse({
        type: "approval.decide",
        key: crypto.randomUUID(),
        taskId,
        interactionId: approval.interactionId,
        expectedRevision: approval.revision,
        decision,
        // An approval needs the disclosed fields; a denial's are replaced by the retained ones.
        action: approval.action ?? "withheld",
        ...(approval.target === null ? {} : { target: approval.target }),
        // JSON null is real material; only withheld material is left out.
        ...(approval.materialUnavailable
          ? {}
          : { material: approval.material }),
      }),
    );
  const outcomeDecision = decided(outcome?.command);
  const heading = `approval-${approval.interactionId}-heading`;
  return (
    <section
      className="approval-review"
      aria-labelledby={heading}
      data-record-id={approval.interactionId}
    >
      <div className="approval-review-head">
        <StatusBadge {...badges[approval.status]} />
        {requesterName && (
          <span className="metadata muted">Requested by {requesterName}</span>
        )}
        {open && (
          <a
            className="metadata approval-review-close"
            href={`/app/tasks/${taskId}`}
          >
            Leave pending
          </a>
        )}
      </div>
      <h3 id={heading} className="small-heading literal">
        {approval.prompt ?? "Approval requested"}
      </h3>
      {open && !approval.approvable ? (
        <p className="body">
          The exact action, material or target cannot be shown here, so you
          cannot review it. This approval can only be denied.
        </p>
      ) : null}
      <dl className="approval-review-facts">
        <dt>Exact action</dt>
        <dd className="literal">{approval.action ?? "Withheld"}</dd>
        <dt>Target</dt>
        <dd className="literal identifier">{approval.target ?? "None"}</dd>
        <dt>Version</dt>
        <dd>
          v{approval.revision}
          {approval.materialHash && (
            <>
              {" · material "}
              <ShortId value={approval.materialHash} />
            </>
          )}
        </dd>
      </dl>
      {safePullRequestUrl(approval.compareUrl) && (
        <p className="body">
          <a
            href={approval.compareUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Compare on GitHub
            <span className="sr-only"> (opens GitHub)</span>
          </a>
          {" · the outside change on the task branch"}
        </p>
      )}
      {!approval.materialUnavailable && <Material value={approval.material} />}
      <SendFeedback
        entry={entry}
        outcome={outcome}
        recorded={(c) => copy[decided(c) ?? "approved"]}
        conflict={copy.conflict}
        unknown={copy.unknown}
        failed={copy.failed}
        details={{
          resource: approval.interactionId,
          // The revision the decision was bound to, not a later one a reread brought in.
          version:
            outcome?.command.type === "approval.decide"
              ? outcome.command.expectedRevision
              : approval.revision,
        }}
        check={() => void send()}
        // The conflict already reread the task; this shows its current material.
        review={{ label: "Review current material", onClick: clear }}
      />
      {decidable && !uncertain && (
        <div className="approval-review-decision">
          <p className="metadata muted">
            Your decision covers this action, target and material version only,
            and cannot be changed. Changed material needs a new request.
          </p>
          <div className="question-actions">
            <Button
              variant="secondary"
              disabled={Boolean(sending)}
              onClick={() => void decide("denied")}
            >
              {decided(sending) === "denied" ? "Sending…" : "Deny"}
            </Button>
            {approval.approvable && (
              <Button
                disabled={Boolean(sending)}
                onClick={() => void decide("approved")}
              >
                {decided(sending) === "approved"
                  ? "Sending…"
                  : outcome?.kind === "failed" && outcomeDecision === "approved"
                    ? "Retry approval"
                    : "Approve this exact material"}
              </Button>
            )}
          </div>
        </div>
      )}
      {!open && (
        <ActionLink variant="secondary" href={`/app/tasks/${taskId}`}>
          Back to overview
        </ActionLink>
      )}
    </section>
  );
}

/** Top-level fields as a key/value list; nested values and the exact JSON stay literal. */
function Material({ value }: { value: JsonValue }) {
  const fields =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : null;
  return (
    <div className="approval-material">
      <h4 className="metadata muted">
        Material to approve
        {fields
          ? ` · ${fields.length} field${fields.length === 1 ? "" : "s"}`
          : ""}
      </h4>
      {fields && (
        <dl className="approval-material-fields">
          {fields.map(([key, field]) => (
            <div key={key}>
              <dt className="identifier">{key}</dt>
              <dd
                className={
                  typeof field === "string" ? "literal" : "literal identifier"
                }
              >
                {typeof field === "string"
                  ? field
                  : JSON.stringify(field, null, 2)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <details className="approval-material-json" open={!fields}>
        <summary>Exact JSON</summary>
        <pre className="literal-text">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

const badges = {
  open: { tone: "warning", children: "Approval pending" },
  approved: { tone: "success", children: "Approved" },
  denied: { tone: "idle", children: "Denied" },
  answered: { tone: "idle", children: "Answered" },
} as const;
