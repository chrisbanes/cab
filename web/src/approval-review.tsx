import {
  operatorCommandSchema,
  type JsonValue,
  type OperatorCommand,
  type Session,
  type TaskRead,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import { useCommandSend } from "./command-send.js";
import { ActionLink, Button, ShortId, StatusBadge } from "./components.js";
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
  onRecorded,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  approval: Approval;
  requesterName: string | null;
  /** Rereads the task after a recorded decision or a conflict. */
  onRecorded: () => void;
}) {
  const { send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    (c, r) =>
      r.kind === "coordination" &&
      r.key === c.key &&
      r.taskId === taskId &&
      r.eventType === "approval-decision",
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onRecorded();
    },
  );
  const open = approval.status === "open",
    // Only the action is required to decide; a withheld material or target still allows Deny.
    decidable =
      open &&
      approval.action !== null &&
      outcome?.kind !== "recorded" &&
      outcome?.kind !== "conflict",
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
        action: approval.action,
        ...(approval.target === null ? {} : { target: approval.target }),
        // A withheld material is filled from the retained record, for a denial only.
        ...(approval.material === null ? {} : { material: approval.material }),
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
          {approval.action === null
            ? "The exact action is withheld here, so this approval cannot be decided here."
            : "The exact material or target cannot be shown here, so you cannot review it. This approval can only be denied."}
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
      {approval.material !== null && <Material value={approval.material} />}
      {outcome && (
        <ActionOutcome
          key={`${outcome.kind}:${outcome.command.key}`}
          tone={
            outcome.kind === "recorded"
              ? "success"
              : outcome.kind === "failed"
                ? "error"
                : "warning"
          }
          message={
            outcome.kind === "recorded"
              ? copy[outcomeDecision ?? "approved"]
              : outcome.kind === "failed"
                ? copy.failed(outcome.code ?? "command-outcome-unknown")
                : copy[outcome.kind]
          }
          focus
          action={
            outcome.kind === "unknown"
              ? {
                  label: "Check whether it saved",
                  onClick: () => send(),
                }
              : outcome.kind === "conflict"
                ? {
                    // The conflict already reread the task; this shows its current material.
                    label: "Review current material",
                    onClick: clear,
                  }
                : undefined
          }
          details={detailRows({
            command: outcome.command.type,
            resource: approval.interactionId,
            version: approval.revision,
            requestKey: outcome.command.key,
            ...(outcome.code ? { code: outcome.code } : {}),
          })}
        />
      )}
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
