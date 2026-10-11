/**
 * A bounded line diff: the common prefix and suffix are kept as up to three context
 * lines, and the differing middle is shown as removed then added lines.
 * ponytail: not a minimal (LCS) diff; interleaved edits show as one replaced block.
 */
export function lineDiff(from: string, to: string, context = 3): string[] {
  const a = from.split("\n"),
    b = to.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    ...(start > context ? [`@@ ${start - context} unchanged lines @@`] : []),
    ...a.slice(Math.max(0, start - context), start).map((l) => `  ${l}`),
    ...a.slice(start, a.length - end).map((l) => `- ${l}`),
    ...b.slice(start, b.length - end).map((l) => `+ ${l}`),
    ...a.slice(a.length - end, a.length - end + context).map((l) => `  ${l}`),
    ...(end > context ? [`@@ ${end - context} unchanged lines @@`] : []),
  ];
}

/** Caps diff lines by count and bytes; reports whether anything was dropped. */
export function boundLines(
  lines: string[],
  maxLines: number,
  maxBytes = Number.POSITIVE_INFINITY,
): { lines: string[]; truncated: boolean } {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 1;
    if (kept.length >= maxLines || bytes > maxBytes)
      return { lines: kept, truncated: true };
    kept.push(line);
  }
  return { lines: kept, truncated: false };
}
