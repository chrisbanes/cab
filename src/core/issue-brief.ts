/** The most UTF-8 bytes of issue brief a task keeps, markers included. */
export const issueBriefByteLimit = 32 * 1024;

/** A comment containing this heading line opens an issue brief. */
export const issueBriefHeading = /^##[ \t]+Agent Brief[ \t]*$/m;
export const issueBriefNoteSeparator = "\n\n--- Later note ---\n\n";
export const issueBriefTruncatedMarker = "[… issue brief truncated …]";
export const omittedNotesMarker = (count: number) =>
  `[… ${count} earlier ${count === 1 ? "note" : "notes"} omitted …]`;

/**
 * An issue's counted comments, oldest first: the provider reader has already dropped the
 * comments that don't count. An incomplete read never changes the stored issue brief.
 * `resumeAt` (epoch ms) marks a rate-limited read.
 */
export type IssueCommentsRead =
  | { complete: true; comments: string[]; reason: null }
  | { complete: false; comments: string[]; reason: string; resumeAt?: number };

export interface IssueBrief {
  text: string;
  truncated: boolean;
}

const bytes = (value: string) => Buffer.byteLength(value, "utf8");

/** The longest prefix of `value` within `limit` UTF-8 bytes that ends on a code point. */
function cutToBytes(value: string, limit: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limit) return value;
  let end = Math.max(0, limit);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

/**
 * The issue brief: the newest counted comment with an `## Agent Brief` heading and every
 * counted comment after it, or null without one. Over the byte limit, the oldest notes are
 * dropped first with a marker; the brief itself is cut only when it alone does not fit.
 */
export function composeIssueBrief(
  comments: readonly string[],
): IssueBrief | null {
  const parts = comments.map((comment) => comment.replace(/\r\n/g, "\n"));
  let start = -1;
  parts.forEach((part, index) => {
    if (issueBriefHeading.test(part)) start = index;
  });
  if (start < 0) return null;
  const brief = parts[start]!;
  const notes = parts.slice(start + 1);
  const noteBytes = notes.map((note) => bytes(issueBriefNoteSeparator + note));
  let rest = noteBytes.reduce((sum, size) => sum + size, 0);
  const briefBytes = bytes(brief);
  for (let dropped = 0; dropped <= notes.length; dropped++) {
    const marker = dropped ? `\n\n${omittedNotesMarker(dropped)}` : "";
    if (briefBytes + bytes(marker) + rest <= issueBriefByteLimit)
      return {
        text:
          brief +
          marker +
          notes
            .slice(dropped)
            .map((note) => issueBriefNoteSeparator + note)
            .join(""),
        truncated: dropped > 0,
      };
    rest -= noteBytes[dropped] ?? 0;
  }
  const suffix =
    `\n\n${issueBriefTruncatedMarker}` +
    (notes.length ? `\n\n${omittedNotesMarker(notes.length)}` : "");
  return {
    text: cutToBytes(brief, issueBriefByteLimit - bytes(suffix)) + suffix,
    truncated: true,
  };
}
