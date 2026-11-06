import { Check } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./components.js";
import type { ReceiptDetails } from "./outcome-copy.js";
import { Alert } from "./ui/alert.js";
import "./action-feedback.css";

export type OutcomeTone = "success" | "error" | "warning";
/** One Details row: a label and its value. */
export type OutcomeField = readonly [label: string, value: string];

/** The receipt fields that are present, as labeled Details rows. */
export const detailRows = (d: ReceiptDetails): OutcomeField[] =>
  (
    [
      ["Command", d.command],
      ["Resource", d.resource],
      ["Version", d.version],
      ["Request key", d.requestKey],
      ["Kind", d.kind],
      ["Code", d.code],
    ] as const
  ).flatMap(([label, value]) =>
    value === undefined ? [] : [[label, String(value)] as const],
  );

/**
 * The one message an action leaves behind: a quiet success line, or one alert with at
 * most one action. The receipt fields sit in a collapsed Details disclosure, never in the
 * message text.
 */
export function ActionOutcome({
  tone,
  title,
  message,
  action,
  focus = false,
  details = [],
  children,
}: {
  tone: OutcomeTone;
  /** A short first line above the message, such as "Couldn't save." */
  title?: string | undefined;
  message: ReactNode;
  /** The single thing to do next. */
  action?:
    | {
        label: string;
        onClick: (event: MouseEvent<HTMLButtonElement>) => void | Promise<void>;
      }
    | undefined;
  /**
   * Take focus as the message appears, when the control the operator used is gone: the
   * action if there is one, otherwise the message itself.
   */
  focus?: boolean | undefined;
  details?: readonly OutcomeField[] | undefined;
  /** Extra content under the message, such as a follow-up link. */
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const hasAction = Boolean(action);
  useEffect(() => {
    if (focus && !hasAction) root.current?.focus();
  }, [focus, hasAction]);
  const body = (
    <>
      <p className="body action-outcome-message">
        {tone === "success" && <Check aria-hidden="true" />}
        <span>
          {title && <strong className="action-outcome-title">{title}</strong>}
          {message}
        </span>
      </p>
      {children}
      {action && (
        <Button
          type="button"
          variant="secondary"
          onClick={action.onClick}
          autoFocus={focus}
        >
          {action.label}
        </Button>
      )}
      <OutcomeDetails fields={details} />
    </>
  );
  return tone === "success" ? (
    <div
      ref={root}
      tabIndex={-1}
      role="status"
      data-slot="action-outcome"
      data-tone={tone}
      className="action-outcome"
    >
      {body}
    </div>
  ) : (
    <Alert
      ref={root}
      tabIndex={-1}
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

/**
 * Copies `text` to the clipboard and says so: Copy, Copied, or Copy unavailable. With `of`
 * (what is copied) the accessible name carries it and a visually hidden status announces the
 * result; `resetMs` returns the button to Copy after that long.
 */
export function CopyButton({
  text,
  of,
  resetMs,
}: {
  text: string;
  of?: string;
  resetMs?: number;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle" || resetMs === undefined) return;
    const timer = setTimeout(() => setState("idle"), resetMs);
    return () => clearTimeout(timer);
  }, [state, resetMs]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  const label =
    state === "copied"
      ? "Copied"
      : state === "failed"
        ? "Copy unavailable"
        : "Copy";
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={copy}
        {...(of ? { "aria-label": `${label} ${of}` } : {})}
      >
        {label}
      </Button>
      {of && state !== "idle" && (
        <span role="status" className="sr-only">
          {label}
        </span>
      )}
    </>
  );
}

/** A collapsed Details disclosure with a Geist Mono key/value list and Copy. */
export function OutcomeDetails({
  fields,
}: {
  fields: readonly OutcomeField[];
}) {
  if (!fields.length) return null;
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
      <CopyButton
        text={fields.map(([label, value]) => `${label}: ${value}`).join("\n")}
      />
    </details>
  );
}
