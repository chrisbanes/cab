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
