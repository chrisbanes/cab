// Shared wording rules for the operator UI: design/DESIGN.md -> Interaction notes -> Presentation.

/** The app's clock label, local HH:MM (DESIGN.md Presentation: times use the app's clock label). */
export function clockLabel(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A short identifier for mono metadata; the caller carries the full value on hover or in Details. */
export const shortId = (value: string, length = 8) => value.slice(0, length);

/** A reason or state code as a sentence; an unmapped code gets the fallback, never the raw code. */
export const codeSentence = (
  code: string,
  sentences: Readonly<Partial<Record<string, string>>>,
  fallback: string,
) => sentences[code] ?? fallback;

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
