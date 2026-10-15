/** Placeholder for service text the service withheld. */
export const unavailable = (value: string | null | undefined): string =>
  value ?? "(unavailable)";

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function table(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...all.map((row) => (row[i] ?? "").length)),
  );
  return all
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function keyValues(pairs: [string, string][]): string {
  const width = Math.max(...pairs.map(([key]) => key.length + 1));
  return pairs
    .map(([key, value]) => `${`${key}:`.padEnd(width)} ${value}`)
    .join("\n");
}

export const isoTime = (ms: number): string => new Date(ms).toISOString();

/** One line, bounded, for table cells. */
export const oneLine = (text: string | null | undefined, max = 80): string => {
  const flat = unavailable(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Service text may hold terminal escape sequences; show only printable text and line breaks. */
export function terminalSafe(text: string): string {
  return text.replace(/[^\P{Cc}\n\t]/gu, "\uFFFD");
}

/** JSON.stringify leaves C1 controls (such as U+009B) raw; escape them for terminal display. */
export const jsonLine = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u0080-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
