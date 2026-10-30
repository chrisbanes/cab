import {
  executionDetailSchema,
  executionInputsSchema,
  executionListSchema,
  workIdSchema,
} from "../operator/contracts.js";
import {
  type BrowseCommand,
  browseOutput,
  type CoverageGap,
  cursorQuery,
  decodeCursor,
  optionalUuid,
  pageLimit,
  readWithCursor,
} from "./browse.js";
import { CliError } from "./connections.js";
import { isoTime, keyValues, oneLine, table } from "./render.js";

const API = "/api/operator";
const SUPPLIED =
  "Captured submission of cab-supplied inputs; not the runtime's effective prompt.";
const ABSENT = "No captured submission for this execution.";
export const CAPTURE_NOTES = [
  "Tool observation is incomplete.",
  "Reasoning is not collected.",
];

/** Capture gap codes mapped onto the closed CLI coverage set; no new codes. */
export const CAPTURE_GAP_COVERAGE: Record<string, CoverageGap> = {
  "capture-baseline": "evidence-unavailable",
  "capture-failed": "evidence-gap",
  "capture-interrupted": "evidence-gap",
  "input-failed": "evidence-gap",
  "size-limit": "item-omitted",
  "redaction-unavailable": "redaction-unavailable",
  "execution-limit": "evidence-gap",
  "item-limit": "evidence-gap",
  expired: "evidence-gap",
  evicted: "evidence-gap",
  "late-event": "evidence-gap",
  "early-buffer-limit": "evidence-gap",
  "unsupported-event": "evidence-gap",
};

type Health = {
  mode: string | null;
  eventSource: string | null;
  gaps: { code: string; count: number }[];
};
type Item = {
  state: "available" | "omitted";
  reason: string | null;
  redacted: boolean;
};

/** Coverage for a capture state, its gaps and the items or segments shown. */
export function captureCoverage(
  capture: string,
  gaps: readonly { code: string }[],
  items: readonly Item[] = [],
  eventSource?: string | null,
): CoverageGap[] {
  return [
    ...(capture !== "captured" ? (["evidence-unavailable"] as const) : []),
    ...(eventSource === "unsupported"
      ? (["evidence-unavailable"] as const)
      : []),
    ...gaps.flatMap((g) => {
      const mapped = CAPTURE_GAP_COVERAGE[g.code];
      return mapped ? [mapped] : [];
    }),
    ...(items.some((i) => i.redacted) ? (["content-redacted"] as const) : []),
    ...(items.some((i) => i.state === "omitted")
      ? (["item-omitted"] as const)
      : []),
    ...(items.some((i) => i.reason === "redaction-unavailable")
      ? (["redaction-unavailable"] as const)
      : []),
  ];
}

export function workIdArg(value: string | undefined, label = "WORK_ID") {
  if (!workIdSchema.safeParse(value).success)
    throw new CliError("invalid-input", `${label} is not an execution id.`);
  return value as string;
}

const healthLine = (h: Health) =>
  `${h.mode ?? "not captured"}; runtime events ${h.eventSource ?? "unknown"}; ${
    h.gaps.length
      ? h.gaps.map((g) => `${g.code} x${g.count}`).join(", ")
      : "no gaps"
  }`;

const executionList: BrowseCommand = {
  usage:
    "execution list (--task ID | --assignment ID | --project ID) [--limit N] [--cursor TOKEN] [--verbose]",
  positionals: 0,
  capabilities: ["cli.identity", "execution.read"],
  async run(ctx) {
    const scopes = {
      task: optionalUuid(ctx.values.task, "--task"),
      assignment: optionalUuid(ctx.values.assignment, "--assignment"),
      project: optionalUuid(ctx.values.project, "--project"),
    };
    const set = Object.entries(scopes).filter(([, v]) => v !== undefined);
    if (set.length !== 1)
      throw new CliError(
        "invalid-input",
        "Pass exactly one of --task, --assignment or --project.",
      );
    const limit = pageLimit(ctx.values, { serverMax: 200 });
    const q = cursorQuery(scopes);
    const cursor = decodeCursor(ctx.values.cursor, "execution list", q);
    if (cursor && !/^[1-9][0-9]{0,15}$/.test(cursor.c))
      throw new CliError(
        "invalid-input",
        "--cursor is not a token from this command and these filters. Restart without --cursor.",
      );
    const params = new URLSearchParams({
      [set[0]?.[0] ?? ""]: String(set[0]?.[1]),
      limit: String(limit.limit),
      ...(cursor ? { before: cursor.c } : {}),
    });
    const client = await ctx.connect();
    const read = await readWithCursor(Boolean(cursor), () =>
      client.get(`${API}/executions?${params}`, executionListSchema),
    );
    const { executions, nextBefore } = read.data;
    return browseOutput(ctx, {
      data: read.data,
      observedAt: read.observedAt,
      notes: CAPTURE_NOTES,
      verboseNotes: true,
      gaps: executions.some((e) => e.capture !== "captured")
        ? ["evidence-unavailable"]
        : [],
      page: {
        kind: "execution list",
        query: q,
        limit,
        returned: executions.length,
        next: nextBefore === null ? null : String(nextBefore),
      },
      human: executions.length
        ? table(
            ["Work", "Request", "State", "Capture", "Started", "Reason"],
            executions.map((e) => [
              e.workId,
              String(e.requestSequence),
              e.state,
              e.capture,
              e.startedAt === null ? "-" : isoTime(e.startedAt),
              oneLine(e.reason ?? "-", 60),
            ]),
          )
        : "No executions.",
    });
  },
};

const executionGet: BrowseCommand = {
  usage: "execution get WORK_ID [--verbose]",
  positionals: 1,
  capabilities: ["cli.identity", "execution.read"],
  async run(ctx) {
    const workId = workIdArg(ctx.positionals[2]);
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/executions/${encodeURIComponent(workId)}`,
      executionDetailSchema,
    );
    const d = read.data;
    const e = d.execution;
    return browseOutput(ctx, {
      data: d,
      observedAt: read.observedAt,
      notes: CAPTURE_NOTES,
      verboseNotes: true,
      gaps: [
        ...captureCoverage(e.capture, d.health.gaps, [], d.health.eventSource),
        ...(e.reason === null && e.state === "held"
          ? (["content-unavailable"] as const)
          : []),
      ],
      human: [
        keyValues([
          ["Execution", e.workId],
          ["Task", e.taskId],
          ["Project", e.projectId],
          ["Assignment", e.assignmentId],
          [
            "State",
            `${e.state}${e.reason ? `: ${oneLine(e.reason, 200)}` : ""}`,
          ],
          ["Thread", e.threadId ?? "-"],
          ["Turn", e.turnId ?? "-"],
          [
            "Bound",
            d.identity
              ? `assignment version ${d.identity.assignmentVersion}, profile revision ${d.identity.profileRevision}, instructions revision ${d.identity.instructionsRevision}, conversation revision ${d.identity.conversationRevision}, harness ${d.identity.harness}`
              : "not captured",
          ],
          ["Capture", healthLine(d.health)],
          [
            "Captured",
            `${d.counts.items} items, ${d.counts.payloadBytes} bytes`,
          ],
        ]),
        "",
        d.settings
          ? table(
              ["Setting", "Value", "Source"],
              d.settings.map((s) => [s.name, s.value ?? "-", s.source]),
            )
          : "Settings: not captured.",
        ...(d.skillPlugins.length > 0
          ? [
              "",
              table(
                ["Skill plugin", "Skills", "Digest"],
                d.skillPlugins.map((p) => [
                  p.name,
                  p.skills.join(", "),
                  p.digest,
                ]),
              ),
            ]
          : []),
      ].join("\n"),
    });
  },
};

const executionInputs: BrowseCommand = {
  usage: "execution inputs WORK_ID [--compare-current]",
  positionals: 1,
  capabilities: ["cli.identity", "execution.read"],
  async run(ctx) {
    const workId = workIdArg(ctx.positionals[2]);
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/executions/${encodeURIComponent(workId)}/inputs${ctx.values["compare-current"] ? "?compare=current" : ""}`,
      executionInputsSchema,
    );
    const d = read.data;
    const captured = d.provenance.source === "captured-submission";
    const reconstructed = d.reconstructed;
    return browseOutput(ctx, {
      data: d,
      observedAt: read.observedAt,
      gaps: [
        ...captureCoverage(d.capture, [], d.segments),
        ...(captured ? [] : (["evidence-unavailable"] as const)),
        ...(reconstructed
          ? captureCoverage(
              "captured",
              [],
              [reconstructed.profile, reconstructed.project],
            )
          : []),
      ],
      human: [
        captured ? SUPPLIED : ABSENT,
        ...(d.submitted
          ? [
              `Submitted: ${d.submitted.bytes} bytes, sha256 ${d.submitted.sha256}`,
            ]
          : []),
        ...d.segments.flatMap((s) => [
          "",
          `--- ${s.name}${s.revision === null ? "" : ` (revision ${s.revision})`} ---`,
          !s.sent
            ? "[not sent: the thread already has this revision]"
            : s.state === "omitted"
              ? `[omitted: ${s.reason}]`
              : (s.text ?? ""),
        ]),
        ...(reconstructed
          ? [
              "",
              "Reconstructed from retained revision records; not a captured submission.",
              `--- profile instructions (revision ${reconstructed.profile.revision}) ---`,
              reconstructed.profile.text ??
                `[omitted: ${reconstructed.profile.reason}]`,
              `--- project instructions (revision ${reconstructed.project.revision}) ---`,
              reconstructed.project.text ??
                `[omitted: ${reconstructed.project.reason}]`,
            ]
          : []),
        ...(d.comparison
          ? [
              "",
              ...d.comparison.instructions.map(
                (c) =>
                  `${c.name}: bound revision ${c.boundRevision}, current ${c.currentRevision}: ${
                    c.sameRevision
                      ? "unchanged"
                      : c.sameContent === null
                        ? "changed revision, content not comparable"
                        : c.sameContent
                          ? "changed revision, same content"
                          : "changed"
                  }`,
              ),
              ...d.comparison.settings.map(
                (s) =>
                  `setting ${s.name}: captured ${s.captured ?? "-"}, current ${s.current ?? "-"}${s.same === null ? "" : s.same ? " (same)" : " (changed)"}`,
              ),
            ]
          : []),
      ].join("\n"),
    });
  },
};

export const executionCommands: [string, BrowseCommand][] = [
  ["execution list", executionList],
  ["execution get", executionGet],
  ["execution inputs", executionInputs],
];
