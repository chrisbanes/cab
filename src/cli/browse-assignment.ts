import {
  commandNetworkDisclosure,
  turnCommandNetworkLine,
} from "../operator/command-network-copy.js";
import {
  assignmentDetailSchema,
  assignmentHistorySchema,
  assignmentInstructionsSchema,
  profileInstructionsSchema,
  projectInstructionsSchema,
} from "../operator/contracts.js";
import {
  anyNull,
  type BrowseCommand,
  type BrowseContext,
  browseOutput,
  type CoverageGap,
  cursorQuery,
  decodeCursor,
  pageLimit,
  uuidArg,
} from "./browse.js";
import { CliError } from "./connections.js";
import { isoTime, keyValues, oneLine, table, unavailable } from "./render.js";

const API = "/api/operator";
const RECONSTRUCTED =
  "Reconstructed from retained revision records; not the submitted prompt.";

type Body = {
  revision: number;
  state: "available" | "omitted";
  reason: string | null;
  text: string | null;
  redacted: boolean;
};
const bodyGaps = (...bodies: Body[]): CoverageGap[] => [
  ...(bodies.some((b) => b.redacted) ? (["content-redacted"] as const) : []),
  ...(bodies.some((b) => b.state === "omitted")
    ? (["redaction-unavailable"] as const)
    : []),
];
const bodyText = (b: Body) =>
  b.state === "omitted" ? `[omitted: ${b.reason}]` : (b.text ?? "");

function revisionArg(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(value))
    throw new CliError(
      "invalid-input",
      "--revision must be a positive integer.",
    );
  return value;
}

async function readInstructions(ctx: BrowseContext, area: string) {
  const id = uuidArg(ctx.positionals[2] ?? "", `${area.toUpperCase()}_ID`);
  const revision = revisionArg(ctx.values.revision);
  const client = await ctx.connect();
  const path = `${API}/${area}s/${encodeURIComponent(id)}/instructions${revision ? `?revision=${revision}` : ""}`;
  return area === "profile"
    ? client.get(path, profileInstructionsSchema)
    : client.get(path, projectInstructionsSchema);
}

const instructions = (area: "project" | "profile"): BrowseCommand => ({
  usage: `${area} instructions ${area.toUpperCase()}_ID [--revision N]`,
  positionals: 1,
  capabilities: ["cli.identity", "instructions.read"],
  async run(ctx) {
    const read = await readInstructions(ctx, area);
    const { summary, selected } = read.data;
    return browseOutput(ctx, {
      data: read.data,
      observedAt: read.observedAt,
      gaps: [
        ...bodyGaps(selected),
        ...(anyNull(summary.name) ? (["content-unavailable"] as const) : []),
      ],
      human: [
        RECONSTRUCTED,
        keyValues([
          [area === "profile" ? "Profile" : "Project", summary.id],
          ["Name", unavailable(summary.name)],
          [
            "Revision",
            `${selected.revision} of ${read.data.currentRevision}${selected.revision === read.data.currentRevision ? " (current)" : ""}`,
          ],
          ...("runtime" in selected
            ? ([["Runtime", selected.runtime.harness]] as [string, string][])
            : []),
        ]),
        "",
        bodyText(selected),
      ].join("\n"),
    });
  },
});

const revisions = (area: "project" | "profile"): BrowseCommand => ({
  usage: `${area} revisions ${area.toUpperCase()}_ID`,
  positionals: 1,
  capabilities: ["cli.identity", "instructions.read"],
  async run(ctx) {
    const read = await readInstructions(ctx, area);
    const { currentRevision, revisions } = read.data;
    return browseOutput(ctx, {
      data: { currentRevision, revisions },
      observedAt: read.observedAt,
      human: [
        RECONSTRUCTED,
        table(
          ["Revision", "Current", "Characters"],
          revisions.map((r) => [
            String(r.revision),
            r.current ? "yes" : "",
            String(r.instructionChars),
          ]),
        ),
      ].join("\n"),
    });
  },
});

const assignmentGet: BrowseCommand = {
  usage: "assignment get ASSIGNMENT_ID",
  positionals: 1,
  capabilities: ["cli.identity", "assignment.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/assignments/${encodeURIComponent(id)}`,
      assignmentDetailSchema,
    );
    const a = read.data;
    const g = a.executionGeneration;
    return browseOutput(ctx, {
      data: a,
      observedAt: read.observedAt,
      gaps: anyNull(a.name, a.brief ?? "", a.waitReason ?? "")
        ? ["content-unavailable"]
        : [],
      human: [
        keyValues([
          ["Assignment", a.assignmentId],
          ["Task", a.taskId],
          ["Project", a.projectId],
          ["Profile", `${a.profileId} (${unavailable(a.name)})`],
          ["Lead", a.lead ? "yes" : "no"],
          ["State", `${a.state}; task execution ${a.execution.state}`],
          ["Version", String(a.version)],
          [
            "Bound",
            `profile revision ${a.profileRevision}, project instructions revision ${a.instructionsRevision}`,
          ],
          [
            "Current",
            `profile revision ${a.currentProfileRevision}, project instructions revision ${a.currentInstructionsRevision}`,
          ],
          [
            "Execution",
            g
              ? `${g.workId} request ${g.requestSequence}, harness ${g.harness ?? "unknown"}`
              : "none",
          ],
        ]),
        ...((g?.harness ?? a.runtime.harness) === "codex" &&
        (!g || g.commandNetworkAccess !== undefined)
          ? [
              turnCommandNetworkLine(g?.commandNetworkAccess ?? null),
              commandNetworkDisclosure,
            ]
          : []),
        ...(a.brief ? ["", oneLine(a.brief, 400)] : []),
        ...(a.state === "held" || Object.values(a.execution.holds).some(Boolean)
          ? ["", `Recovery: ensemble recovery get ${a.assignmentId}`]
          : []),
      ].join("\n"),
    });
  },
};

const historyCursor = /^([0-9]+|-):([0-9]+|-)$/;
const assignmentHistory: BrowseCommand = {
  usage: "assignment history ASSIGNMENT_ID [--limit N] [--cursor TOKEN]",
  positionals: 1,
  capabilities: ["cli.identity", "assignment.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
    const limit = pageLimit(ctx.values, { serverMax: 200 });
    const q = cursorQuery({ assignment: id });
    const cursor = decodeCursor(ctx.values.cursor, "assignment history", q);
    const keys = cursor ? historyCursor.exec(cursor.c) : undefined;
    if (cursor && !keys)
      throw new CliError(
        "invalid-input",
        "--cursor is not a token from this command and these filters. Restart without --cursor.",
      );
    const params = new URLSearchParams({ limit: String(limit.limit) });
    if (keys?.[1] && keys[1] !== "-") params.set("beforeSequence", keys[1]);
    if (keys?.[2] && keys[2] !== "-")
      params.set("beforeOmissionSequence", keys[2]);
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/assignments/${encodeURIComponent(id)}/history?${params}`,
      assignmentHistorySchema,
    );
    const { visibilityRevision: _revision, ...page } = read.data;
    const older = page.omittedItemCount > 0 || page.omittedTurnCount > 0;
    // Keysets only move backwards, so a next page cannot go stale; pruning shows as fewer items.
    const next = older
      ? `${page.items[0]?.sequence ?? keys?.[1] ?? "-"}:${page.turnOmissions[0]?.sequence ?? keys?.[2] ?? "-"}`
      : null;
    return browseOutput(ctx, {
      data: page,
      observedAt: read.observedAt,
      notes: [
        "Bounded, sanitized assistant text; not a transcript or the submitted prompt.",
      ],
      gaps: [
        ...(older ? (["older-history-omitted"] as const) : []),
        ...(page.items.some((i) => i.lifecycle === "omitted") ||
        page.turnOmissions.length
          ? (["item-omitted"] as const)
          : []),
        ...(page.items.some((i) => i.omissionReason === "redaction-unavailable")
          ? (["redaction-unavailable"] as const)
          : []),
      ],
      page: {
        kind: "assignment history",
        query: q,
        limit,
        returned: page.items.length,
        next,
      },
      human: [
        page.items.length
          ? table(
              ["Sequence", "Updated", "Work", "Revisions", "State", "Text"],
              page.items.map((i) => [
                String(i.sequence),
                isoTime(i.updatedAt),
                i.workId,
                `p${i.profileRevision}/i${i.instructionsRevision}`,
                i.lifecycle,
                i.lifecycle === "omitted"
                  ? `[omitted: ${i.omissionReason ?? "unknown"}]`
                  : oneLine(i.text ?? ""),
              ]),
            )
          : "No history items.",
        ...page.turnOmissions.map(
          (o) =>
            `Turn ${o.turnId} (work ${o.workId}) omitted: ${o.reason} at ${isoTime(o.createdAt)}`,
        ),
      ].join("\n"),
    });
  },
};

const assignmentInstructions: BrowseCommand = {
  usage: "assignment instructions ASSIGNMENT_ID",
  positionals: 1,
  capabilities: ["cli.identity", "assignment.read", "instructions.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
    const client = await ctx.connect();
    const read = await client.get(
      `${API}/assignments/${encodeURIComponent(id)}/instructions`,
      assignmentInstructionsSchema,
    );
    const d = read.data;
    const compare = (kind: "profile" | "project") => {
      const c = d.comparison[kind];
      return `${kind} bound revision ${d.bound[kind].revision}, current ${d.current[kind].revision}: ${
        c.sameRevision
          ? "unchanged"
          : c.sameContent === null
            ? "changed revision, content not comparable"
            : c.sameContent
              ? "changed revision, same content"
              : "changed"
      }`;
    };
    const section = (label: string, b: Body) => [
      "",
      `--- ${label} (revision ${b.revision}) ---`,
      bodyText(b),
    ];
    return browseOutput(ctx, {
      data: d,
      observedAt: read.observedAt,
      gaps: bodyGaps(
        d.bound.profile,
        d.bound.project,
        d.current.profile,
        d.current.project,
      ),
      human: [
        RECONSTRUCTED,
        keyValues([
          ["Assignment", d.assignmentId],
          ["Task", d.taskId],
          ["Project", d.projectId],
          ["Profile", d.profileId],
          ["Binding", d.comparison.boundIsCurrent ? "current" : "stale"],
          [
            "Execution",
            d.execution
              ? `${d.execution.workId} request ${d.execution.requestSequence}: profile revision ${d.execution.profileRevision}, instructions revision ${d.execution.instructionsRevision} (${d.execution.matchesBound ? "matches" : "differs from"} binding)`
              : "none",
          ],
        ]),
        compare("profile"),
        compare("project"),
        ...section("Bound profile instructions", d.bound.profile),
        ...section("Bound project instructions", d.bound.project),
        ...(d.comparison.profile.sameRevision
          ? []
          : section("Current profile instructions", d.current.profile)),
        ...(d.comparison.project.sameRevision
          ? []
          : section("Current project instructions", d.current.project)),
      ].join("\n"),
    });
  },
};

export const assignmentCommands: [string, BrowseCommand][] = [
  ["project instructions", instructions("project")],
  ["profile instructions", instructions("profile")],
  ["project revisions", revisions("project")],
  ["profile revisions", revisions("profile")],
  ["assignment get", assignmentGet],
  ["assignment history", assignmentHistory],
  ["assignment instructions", assignmentInstructions],
];
