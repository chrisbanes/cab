/**
 * The ordering key of a task timeline entry: `(timeMs, rank, ordinal, id)`, compared
 * lexicographically. It derives only from immutable creation fields, so an entry keeps
 * its place when its content changes (a streaming item completes, a command finishes).
 */
export interface TimelineKey {
  timeMs: number;
  /** One per source; breaks same-millisecond ties in a fixed kind order. */
  rank: number;
  /** The source's own monotonic sequence, or 0. */
  ordinal: number;
  /** Letters, digits, `_` and `-` only, so the serialised key stays parseable. */
  id: string;
}

export const timelineRank = {
  delegation: 0,
  history: 1,
  turnOmission: 2,
  tool: 3,
  toolGap: 4,
  request: 5,
  result: 6,
  message: 7,
} as const;

export function serializeTimelineKey(key: TimelineKey): string {
  return `${key.timeMs}.${key.rank}.${key.ordinal}.${key.id}`;
}

const cursorPattern =
  /^([0-9]{1,16})\.([0-9]{1,2})\.([0-9]{1,16})\.([\w-]{1,96})$/;

/** Strict inverse of `serializeTimelineKey`; undefined for anything else. */
export function parseTimelineCursor(cursor: string): TimelineKey | undefined {
  const match = cursorPattern.exec(cursor);
  if (!match) return undefined;
  const [timeMs, rank, ordinal] = [match[1], match[2], match[3]].map(Number);
  const id = match[4];
  if (
    timeMs === undefined ||
    rank === undefined ||
    ordinal === undefined ||
    id === undefined ||
    ![timeMs, ordinal].every(Number.isSafeInteger)
  )
    return undefined;
  return { timeMs, rank, ordinal, id };
}

export function compareTimelineKeys(a: TimelineKey, b: TimelineKey): number {
  return (
    a.timeMs - b.timeMs ||
    a.rank - b.rank ||
    a.ordinal - b.ordinal ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * SQL for rows of one source (fixed `rank`, unique `ordinal` column) whose key is
 * strictly below `before`. With a unique ordinal the id never decides, so equal
 * `(timeMs, ordinal)` is the cursor row itself.
 */
export function keysetBelow(
  rank: number,
  before: TimelineKey | undefined,
  timeColumn: string,
  ordinalColumn: string,
): { sql: string; params: number[] } {
  if (!before) return { sql: "1 = 1", params: [] };
  if (rank < before.rank)
    return { sql: `${timeColumn} <= ?`, params: [before.timeMs] };
  if (rank > before.rank)
    return { sql: `${timeColumn} < ?`, params: [before.timeMs] };
  return {
    sql: `(${timeColumn} < ? OR (${timeColumn} = ? AND ${ordinalColumn} < ?))`,
    params: [before.timeMs, before.timeMs, before.ordinal],
  };
}
