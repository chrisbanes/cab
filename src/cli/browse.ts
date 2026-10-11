import { z } from "zod";
import { CliError } from "./connections.js";
import type { ServiceClient } from "./transport.js";
import type { Result, Values } from "./types.js";

/** Closed set of reasons a read is not a complete view. */
export const COVERAGE_GAPS = [
  "more-pages",
  "limit-capped",
  "catalog-changed",
  "older-history-omitted",
  "item-omitted",
  "content-redacted",
  "content-unavailable",
  "redaction-unavailable",
  "evidence-gap",
  "evidence-unavailable",
  "review-unavailable",
] as const;
export type CoverageGap = (typeof COVERAGE_GAPS)[number];

export type Coverage = {
  observedAt: number;
  complete: boolean;
  gaps: CoverageGap[];
  notes: string[];
  continuity?: "changed";
};
export type Pagination = {
  limit: number;
  maxLimit: number;
  returned: number;
  nextCursor: string | null;
};

export type BrowseContext = {
  /** All positionals, including the area and action. */
  positionals: string[];
  values: Values;
  /** Negotiates the command's capabilities, then returns the client. */
  connect(): Promise<ServiceClient>;
};
export type BrowseOutput = Pick<
  Result,
  "human" | "data" | "pagination" | "coverage"
>;
export type BrowseCommand = {
  usage: string;
  /** Arguments after the area and action. */
  positionals: number;
  capabilities: readonly string[];
  run(ctx: BrowseContext): Promise<BrowseOutput>;
};

export function coverage(
  observedAt: number,
  gaps: readonly CoverageGap[],
  notes: string[] = [],
  continuity?: "changed",
): Coverage {
  const unique = [...new Set(gaps)];
  return {
    observedAt,
    complete: unique.length === 0,
    gaps: unique,
    notes,
    ...(continuity ? { continuity } : {}),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidArg(value: string, label: string): string {
  if (!UUID.test(value))
    throw new CliError("invalid-input", `${label} must be a UUID.`);
  return value;
}

export const optionalUuid = (value: string | undefined, label: string) =>
  value === undefined ? undefined : uuidArg(value, label);

export function enumArg<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new CliError(
      "invalid-input",
      `${label} must be ${allowed.join(", ")}.`,
    );
  return value as T;
}

/** ISO-8601 date or timestamp, or epoch milliseconds. */
export function timeArg(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  const ms = /^[0-9]{1,15}$/.test(value)
    ? Number(value)
    : /^\d{4}-\d{2}-\d{2}/.test(value)
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0)
    throw new CliError(
      "invalid-input",
      `${label} must be an ISO-8601 time or epoch milliseconds.`,
    );
  return ms;
}

export type PageLimit = { limit: number; maxLimit: number; capped: boolean };
/** Validates --limit (1-200, default 50) and clamps it to the route's cap. */
export function pageLimit(
  values: Values,
  { serverMax }: { serverMax: number },
): PageLimit {
  const raw = values.limit;
  if (
    raw !== undefined &&
    !(/^[0-9]{1,3}$/.test(raw) && +raw >= 1 && +raw <= 200)
  )
    throw new CliError(
      "invalid-input",
      "--limit must be an integer from 1 to 200.",
    );
  const requested = raw === undefined ? 50 : Number(raw);
  return {
    limit: Math.min(requested, serverMax),
    maxLimit: serverMax,
    capped: requested > serverMax,
  };
}

const tokenSchema = z
  .object({
    v: z.literal(1),
    k: z.string(),
    q: z.string(),
    c: z.string().min(1).max(200),
    f: z.string().max(200).optional(),
  })
  .strict();

/** Canonical form of the filters a cursor is bound to. */
export const cursorQuery = (filters: Record<string, unknown>): string =>
  JSON.stringify(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== false)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

function encodeCursor(
  kind: string,
  query: string,
  cursor: string,
  fingerprint?: string,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: kind,
      q: query,
      c: cursor,
      ...(fingerprint ? { f: fingerprint } : {}),
    }),
  ).toString("base64url");
}

/** Rejects a token that is malformed, from another command or from other filters. */
export function decodeCursor(
  token: string | undefined,
  kind: string,
  query: string,
): { c: string; f?: string | undefined } | undefined {
  if (token === undefined) return undefined;
  const bad = () =>
    new CliError(
      "invalid-input",
      `--cursor is not a token from this command and these filters. Restart without --cursor.`,
    );
  let parsed: z.infer<typeof tokenSchema>;
  try {
    parsed = tokenSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    );
  } catch {
    throw bad();
  }
  if (parsed.k !== kind || parsed.q !== query) throw bad();
  return parsed;
}

/** A server 409 on a request that carried a cursor means the cursor went stale. */
export async function readWithCursor<T>(
  hasCursor: boolean,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (hasCursor && error instanceof CliError && error.extra.status === 409)
      throw new CliError(
        "cursor-stale",
        "The cursor is no longer valid. Restart without --cursor.",
        error.extra,
      );
    throw error;
  }
}

const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

function nextCommand(ctx: BrowseContext, token: string): string {
  const v = ctx.values;
  const flags: [string, string | boolean | undefined][] = [
    ["connection", v.connection],
    ["project", v.project],
    ["state", v.state],
    ["type", v.type],
    ["after", v.after],
    ["before", v.before],
    ["historical", v.historical],
    ["limit", v.limit],
    ["cursor", token],
  ];
  return [
    "ensemble",
    ...ctx.positionals.map(shellWord),
    ...flags.flatMap(([name, value]) =>
      value === undefined || value === false
        ? []
        : value === true
          ? [`--${name}`]
          : [`--${name}`, shellWord(value)],
    ),
  ].join(" ");
}

/** Adds the Gap/Note/More lines and the pagination and coverage fields. */
export function browseOutput(
  ctx: BrowseContext,
  o: {
    human: string;
    data: unknown;
    observedAt: number;
    gaps?: CoverageGap[];
    notes?: string[];
    continuity?: "changed";
    page?: {
      kind: string;
      query: string;
      limit: PageLimit;
      returned: number;
      next: string | null;
      fingerprint?: string | undefined;
    };
  },
): BrowseOutput {
  const gaps = [...(o.gaps ?? [])];
  const notes = o.notes ?? [];
  let pagination: Pagination | undefined;
  let more: string[] = [];
  if (o.page) {
    const { limit, next } = o.page;
    if (limit.capped) gaps.push("limit-capped");
    if (next) gaps.push("more-pages");
    const nextCursor = next
      ? encodeCursor(o.page.kind, o.page.query, next, o.page.fingerprint)
      : null;
    pagination = {
      limit: limit.limit,
      maxLimit: limit.maxLimit,
      returned: o.page.returned,
      nextCursor,
    };
    if (nextCursor) more = [`More: ${nextCommand(ctx, nextCursor)}`];
  }
  const cov = coverage(o.observedAt, gaps, notes, o.continuity);
  return {
    data: o.data,
    ...(pagination ? { pagination } : {}),
    coverage: cov,
    human: [
      o.human,
      ...cov.gaps.map((gap) => `Gap: ${gap}`),
      ...notes.map((note) => `Note: ${note}`),
      ...more,
    ].join("\n"),
  };
}

/** True when any value is `null`: the service withheld that text. */
export const anyNull = (...values: unknown[]): boolean =>
  values.some((value) => value === null);
