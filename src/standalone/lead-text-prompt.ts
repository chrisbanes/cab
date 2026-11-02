/** The task text a lead turn carries. */
export interface TaskText {
  title: string;
  outcome: string;
}

export const issueDiffLineLimit = 200;
export const issueDiffByteLimit = 8000;
export const issueDiffTruncated = "[… issue diff truncated …]";
/** Cells of the line-matching table; a larger changed middle falls back to remove-then-add. */
const middleBudget = 250_000;

/**
 * Deterministic `- `/`+ ` lines turning `before` into `after`. The common prefix and suffix
 * are dropped first; a middle within the budget is matched by longest common subsequence.
 */
function lineDiff(before: string[], after: string[]): string[] {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const a = before.slice(start, before.length - end),
    b = after.slice(start, after.length - end);
  if (a.length * b.length > middleBudget)
    return [...a.map((line) => `- ${line}`), ...b.map((line) => `+ ${line}`)];
  // lcs[i * (b.length + 1) + j]: common lines of a[i..] and b[j..].
  const width = b.length + 1,
    lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lcs[(i + 1) * width + j] ?? 0,
              lcs[i * width + j + 1] ?? 0,
            );
  const out: string[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length &&
        (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0))
    )
      out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  return out;
}

/**
 * The line diff from the text a lead last confirmed to the current text, by field, capped at
 * `issueDiffLineLimit` lines and `issueDiffByteLimit` UTF-8 bytes including the final
 * truncation marker. Empty when nothing changed.
 */
export function issueTextDiff(before: TaskText, after: TaskText): string[] {
  const lines: string[] = [];
  for (const [heading, a, b] of [
    ["Title:", before.title, after.title],
    ["Outcome:", before.outcome, after.outcome],
  ] as const) {
    if (a === b) continue;
    lines.push(heading, ...lineDiff(a.split("\n"), b.split("\n")));
  }
  const bytes = (line: string) => Buffer.byteLength(line, "utf8") + 1;
  let total = 0;
  for (const [index, line] of lines.entries()) {
    total += bytes(line);
    if (total > issueDiffByteLimit || index >= issueDiffLineLimit) {
      const kept = lines.slice(0, index);
      let size = kept.reduce((sum, item) => sum + bytes(item), 0);
      while (
        kept.length > 0 &&
        (kept.length + 1 > issueDiffLineLimit ||
          size + bytes(issueDiffTruncated) > issueDiffByteLimit)
      )
        size -= bytes(kept.pop() ?? "");
      return [...kept, issueDiffTruncated];
    }
  }
  return lines;
}

/**
 * A lead turn's task section: the full current title and outcome, then, when the text changed
 * since the lead's last confirmed turn, the capped diff against what that turn carried.
 */
export function leadTaskSection(
  current: TaskText,
  confirmed: TaskText | undefined,
): string {
  const task = `Task: ${current.title}\nOutcome: ${current.outcome}`;
  if (
    !confirmed ||
    (confirmed.title === current.title && confirmed.outcome === current.outcome)
  )
    return task;
  return `${task}\n\nThe task's issue text changed since your last turn. Changes (- before, + now):\n${issueTextDiff(confirmed, current).join("\n")}`;
}
