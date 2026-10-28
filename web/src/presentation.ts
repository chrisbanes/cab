// Shared wording rules for the operator UI.

import { clockLabel } from "../../src/operator/clock-label.js";
export { clockLabel };

/** "Updated 16:48", or "Updated 16:47–16:48" only when the first and last reads show different clock labels. */
export function updatedLabel(first: number, last: number) {
  const a = clockLabel(first);
  const b = clockLabel(last);
  return a === b ? `Updated ${a}` : `Updated ${a}–${b}`;
}

/**
 * A sentence-initial label placed mid-sentence: lowercase its first letter unless it starts with
 * a proper noun ("GitHub dependencies unconfirmed" keeps its capitals, "Project paused" does not).
 */
export const midSentence = (label: string) =>
  /^(GitHub|Claude|cab)\b/.test(label)
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);

/** A short identifier for mono metadata; the caller carries the full value on hover or in Details. */
export const shortId = (value: string, length = 8) => value.slice(0, length);

/** A reason or state code as a sentence; an unmapped code gets the fallback, never the raw code. */
export const codeSentence = (
  code: string,
  sentences: Readonly<Partial<Record<string, string>>>,
  fallback: string,
) => (Object.hasOwn(sentences, code) ? sentences[code] : undefined) ?? fallback;

/** A line's heading, list and checklist markers, including a bare "- [ ]" left empty. */
const lineMarkers =
  /^\s*(?:#{1,6}\s+|(?:[-*+]|\d+\.)\s+)?(?:\[[ xX]\](?:\s+|$))?/;

/**
 * A recorded outcome as one plain line: its first non-empty line with Markdown markers removed.
 * `more` is true when anything meaningful follows. A redacted (null) outcome has no line.
 */
export function outcomeLine(text: string | null): {
  line: string;
  more: boolean;
} {
  const lines = (text ?? "")
    .split("\n")
    .map((raw) => raw.trim().replace(lineMarkers, "").trim())
    .filter(Boolean);
  return { line: lines[0] ?? "", more: lines.length > 1 };
}
