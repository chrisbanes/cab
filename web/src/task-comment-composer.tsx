import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "./components.js";
import {
  addRecipient,
  admissionText,
  noLeadText,
  chipLabel,
  pickableRecipients,
  previewLines,
  recipientLabel,
  recordOnlyText,
  removeRecipient,
  selectedRecipientIds,
  type CommentRecipientFact,
  type CommentSelection,
} from "./task-comment-model.js";

/**
 * The shared comment's recipients: removable chips for the selected assignments, a picker for
 * the task's others, and the preview of what Send does for each. Selection is by assignment
 * identity only; the comment's text is never read for names.
 */
export function CommentRecipients({
  facts,
  selection,
  disabled,
  onChange,
}: {
  facts: readonly CommentRecipientFact[];
  selection: CommentSelection;
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const ids = selectedRecipientIds(facts, selection);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A send in flight or unresolved freezes the recipients, so an open picker closes with it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const pickable = pickableRecipients(facts, selection);
  const lines = previewLines(facts, ids);
  const focusTrigger = () =>
    requestAnimationFrame(() => trigger.current?.focus());
  // Escape closes the open picker and returns to its trigger, whichever control has focus.
  const onEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="comment-recipients">
      <div className="recipient-row">
        <p id="comment-recipients-label" className="body">
          Recipients
        </p>
        <ul
          aria-labelledby="comment-recipients-label"
          className="recipient-chips"
        >
          {ids.map((id) => {
            const fact = facts.find((f) => f.assignmentId === id);
            const label = fact
              ? chipLabel(fact, facts)
              : `@Assignment ${id.slice(0, 8)}`;
            return (
              <li key={id} className="recipient-chip" data-assignment-id={id}>
                <span>{label}</span>
                <Button
                  variant="secondary"
                  aria-label={`Remove ${label}`}
                  disabled={disabled}
                  onClick={() => {
                    onChange(removeRecipient(facts, selection, id));
                    focusTrigger();
                  }}
                >
                  ×
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="recipient-picker">
          <Button
            ref={trigger}
            variant="secondary"
            aria-expanded={open}
            aria-controls="comment-recipient-options"
            disabled={disabled}
            onClick={() => setOpen(!open)}
            onKeyDown={onEscape}
          >
            Add recipient
          </Button>
          {open && !disabled && (
            <ul id="comment-recipient-options" aria-label="Assignments to add">
              {pickable.length === 0 && (
                <li className="muted">
                  Every assignment is already a recipient.
                </li>
              )}
              {pickable.map((fact) => (
                <li key={fact.assignmentId}>
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onKeyDown={onEscape}
                    onClick={() => {
                      onChange(
                        addRecipient(facts, selection, fact.assignmentId),
                      );
                      setOpen(false);
                      focusTrigger();
                    }}
                  >
                    {recipientLabel(fact, facts)} ·{" "}
                    {fact.role === "lead" ? "lead" : "delegate"} ·{" "}
                    {fact.mode === "unavailable"
                      ? "unavailable"
                      : fact.mode === "resume"
                        ? "resumes"
                        : "receives input"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <output className="comment-preview" aria-label="Before you send">
        {!facts.some((f) => f.role === "lead") && (
          <p className="metadata muted">{noLeadText}</p>
        )}
        {lines.length === 0 ? (
          <p className="metadata muted">{recordOnlyText}</p>
        ) : (
          <ul>
            {lines.map((line) => (
              <li
                key={line.assignmentId}
                data-blocked={line.blocked || undefined}
              >
                <strong>{line.label}</strong> {line.effect}
              </li>
            ))}
          </ul>
        )}
        {lines.some((line) => !line.blocked) && (
          <p className="metadata muted">{admissionText}</p>
        )}
      </output>
    </div>
  );
}
