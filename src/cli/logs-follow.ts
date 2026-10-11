import { executionEventsSchema } from "../operator/contracts.js";
import {
  type BrowseCommand,
  type BrowseContext,
  browseOutput,
  cursorQuery,
  decodeCursor,
  encodeCursor,
  enumArg,
  nextCommand,
  pageLimit,
  readWithCursor,
  timeArg,
} from "./browse.js";
import {
  CAPTURE_GAP_COVERAGE,
  CAPTURE_NOTES,
  captureCoverage,
  workIdArg,
} from "./browse-execution.js";
import { CliError } from "./connections.js";
import { isoTime, oneLine, table } from "./render.js";

const KINDS = ["input", "setting", "runtime", "tool", "service"] as const;
const SEVERITIES = ["info", "warn", "error"] as const;
const SCHEMA = "ensemble.cli/v1";
/** Consecutive unavailable polls before following stops. */
const MAX_FAILURES = 3;

function secondsArg(
  value: string | undefined,
  label: string,
  max: number,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (!/^[0-9]{1,5}$/.test(value) || +value < 1 || +value > max)
    throw new CliError(
      "invalid-input",
      `${label} must be an integer from 1 to ${max} seconds.`,
    );
  return Number(value);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

type Page = Awaited<ReturnType<typeof readPage>>;
type Query = {
  workId: string;
  kind: string | undefined;
  severity: string | undefined;
  since: number | undefined;
  until: number | undefined;
  limit: number;
};
async function readPage(
  client: Awaited<ReturnType<BrowseContext["connect"]>>,
  q: Query,
  after: number,
) {
  const params = new URLSearchParams({
    after: String(after),
    limit: String(q.limit),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.severity ? { severity: q.severity } : {}),
    ...(q.since === undefined ? {} : { since: String(q.since) }),
    ...(q.until === undefined ? {} : { until: String(q.until) }),
  });
  return readWithCursor(after > 0, () =>
    client.get(
      `/api/operator/executions/${encodeURIComponent(q.workId)}/events?${params}`,
      executionEventsSchema,
    ),
  );
}

const itemLine = (i: Page["data"]["items"][number]) =>
  `${i.sequence}  ${isoTime(i.createdAt)}  ${i.severity}  ${i.kind}  ${i.name}  ${
    i.state === "omitted"
      ? `[omitted: ${i.reason}]`
      : oneLine(JSON.stringify(i.payload), 400)
  }`;

export const logsCommand: BrowseCommand = {
  usage:
    "logs --execution WORK_ID [--kind input|setting|runtime|tool|service] [--severity info|warn|error] [--after T] [--before T] [--limit N] [--cursor TOKEN] [--follow [--interval S] [--max-duration S]] [--output jsonl]",
  positionals: 0,
  capabilities: ["cli.identity", "execution.read", "diagnostics.read"],
  async run(ctx) {
    const v = ctx.values;
    const limit = pageLimit(v, { serverMax: 200 });
    if (v.follow && v.output === "json")
      throw new CliError(
        "invalid-input",
        "--follow streams; use --output jsonl or human output.",
      );
    const query: Query = {
      workId: workIdArg(v.execution, "--execution"),
      kind: enumArg(v.kind, KINDS, "--kind"),
      severity: enumArg(v.severity, SEVERITIES, "--severity"),
      since: timeArg(v.after, "--after"),
      until: timeArg(v.before, "--before"),
      limit: limit.limit,
    };
    const interval = secondsArg(v.interval, "--interval", 30, 2);
    const maxDuration = secondsArg(
      v["max-duration"],
      "--max-duration",
      86400,
      900,
    );
    const jsonl = v.output === "jsonl";
    const q = cursorQuery({
      execution: query.workId,
      kind: query.kind,
      severity: query.severity,
      since: query.since,
      until: query.until,
    });
    const cursor = decodeCursor(v.cursor, "logs", q);
    if (cursor && !/^[0-9]{1,16}$/.test(cursor.c))
      throw new CliError(
        "invalid-input",
        "--cursor is not a token from this command and these filters. Restart without --cursor.",
      );
    const resume = (after: number) => encodeCursor("logs", q, String(after));
    const client = await ctx.connect();
    let after = cursor ? Number(cursor.c) : 0;

    if (!v.follow && !jsonl) {
      const read = await readPage(client, query, after);
      const d = read.data;
      return browseOutput(ctx, {
        data: { ...d, resumeCursor: resume(d.resumeAfter) },
        observedAt: read.observedAt,
        notes: CAPTURE_NOTES,
        gaps: captureCoverage(d.capture, d.gaps, d.items, d.health.eventSource),
        page: {
          kind: "logs",
          query: q,
          limit,
          returned: d.items.length,
          next: d.more ? String(d.resumeAfter) : null,
        },
        human: [
          d.items.length
            ? table(
                ["Sequence", "Time", "Severity", "Kind", "Name", "Detail"],
                d.items.map((i) => [
                  String(i.sequence),
                  isoTime(i.createdAt),
                  i.severity,
                  i.kind,
                  i.name,
                  i.state === "omitted"
                    ? `[omitted: ${i.reason}]`
                    : oneLine(JSON.stringify(i.payload), 120),
                ]),
              )
            : "No diagnostic items.",
          ...d.gaps.map(
            (g) => `Capture gap: ${g.code} x${g.count} (${g.bytes} bytes)`,
          ),
        ].join("\n"),
      });
    }

    // Streaming: one page buffered per poll; each poll re-authenticates.
    const out = (line: string) => ctx.deps.stdout.write(`${line}\n`);
    const emit = (type: string, body: Record<string, unknown>) =>
      out(JSON.stringify({ schema: SCHEMA, type, ...body }));
    const sleep = ctx.deps.sleep ?? defaultSleep;
    const signal = ctx.deps.signal;
    const deadline = ctx.deps.now() + maxDuration * 1000;
    const shown = new Map<string, number>();
    let failures = 0;
    let reason: string;
    for (;;) {
      if (signal?.aborted) {
        reason = "interrupted";
        break;
      }
      let page: Page;
      try {
        page = await readPage(client, query, after);
        failures = 0;
      } catch (error) {
        if (
          v.follow &&
          error instanceof CliError &&
          error.code === "unavailable" &&
          ++failures < MAX_FAILURES
        ) {
          await sleep(interval * 1000, signal);
          continue;
        }
        if (error instanceof CliError)
          throw new CliError(
            error.code,
            `${error.message} Resume with --cursor ${resume(after)}`,
            error.extra,
          );
        throw error;
      }
      const d = page.data;
      for (const item of d.items)
        if (jsonl) emit("item", { workId: d.workId, item });
        else out(itemLine(item));
      for (const gap of d.gaps) {
        const key = `${gap.code}:${gap.maxPrunedSequence}`;
        if (shown.get(key) === gap.count) continue;
        shown.set(key, gap.count);
        const coverage = CAPTURE_GAP_COVERAGE[gap.code] ?? "evidence-gap";
        if (jsonl) emit("gap", { workId: d.workId, gap, coverage });
        else out(`Gap: ${gap.code} x${gap.count} (${coverage})`);
      }
      after = d.resumeAfter;
      if (!v.follow) {
        reason = d.more ? "page-limit" : "drained";
        break;
      }
      if (d.more) continue;
      if (d.finished) {
        reason = "execution-finished";
        break;
      }
      if (ctx.deps.now() + interval * 1000 > deadline) {
        reason = "max-duration";
        break;
      }
      await sleep(interval * 1000, signal);
    }
    const resumeCursor = resume(after);
    if (jsonl) emit("end", { reason, resumeCursor });
    else
      out(
        [
          `End: ${reason}`,
          ...CAPTURE_NOTES.map((n) => `Note: ${n}`),
          `Resume: ${nextCommand(ctx, resumeCursor)}`,
        ].join("\n"),
      );
    return {
      data: { workId: query.workId, reason, resumeCursor },
      human: "",
      streamed: true,
    };
  },
};
