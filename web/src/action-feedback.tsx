import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./components.js";
import { Alert } from "./ui/alert.js";
import "./action-feedback.css";

export type OutcomeTone = "success" | "error" | "warning";
/** One Details row: a label and its value. */
export type OutcomeField = readonly [label: string, value: string];

/**
 * The one message an action leaves behind: a quiet success line, or one alert with at
 * most one action. The receipt fields sit in a collapsed Details disclosure, never in the
 * message text.
 */
export function ActionOutcome({
  tone,
  message,
  action,
  focusAction = false,
  details = [],
  children,
}: {
  tone: OutcomeTone;
  message: ReactNode;
  /** The single thing to do next. */
  action?: { label: string; onClick: () => void | Promise<void> } | undefined;
  /** Move focus to the action as it appears, when the control the operator used is gone. */
  focusAction?: boolean | undefined;
  details?: readonly OutcomeField[] | undefined;
  /** Extra content under the message, such as a follow-up link. */
  children?: ReactNode;
}) {
  const body = (
    <>
      <p className="body action-outcome-message">
        {tone === "success" && <Check aria-hidden="true" />}
        <span>{message}</span>
      </p>
      {children}
      {action && (
        <Button
          type="button"
          variant="secondary"
          onClick={action.onClick}
          autoFocus={focusAction}
        >
          {action.label}
        </Button>
      )}
      <OutcomeDetails fields={details} />
    </>
  );
  return tone === "success" ? (
    <div
      role="status"
      data-slot="action-outcome"
      data-tone={tone}
      className="action-outcome"
    >
      {body}
    </div>
  ) : (
    <Alert
      role="alert"
      variant={tone === "error" ? "destructive" : "warning"}
      data-slot="action-outcome"
      data-tone={tone}
      className="action-outcome"
    >
      {body}
    </Alert>
  );
}

/** A collapsed Details disclosure with a Geist Mono key/value list and Copy. */
export function OutcomeDetails({
  fields,
}: {
  fields: readonly OutcomeField[];
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  if (!fields.length) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        fields.map(([label, value]) => `${label}: ${value}`).join("\n"),
      );
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <details className="action-outcome-details">
      <summary className="metadata">Details</summary>
      <dl className="identifier action-outcome-fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Button type="button" variant="secondary" onClick={copy}>
        {copied === "copied"
          ? "Copied"
          : copied === "failed"
            ? "Copy unavailable"
            : "Copy"}
      </Button>
    </details>
  );
}
