import { runtimeSettingsSchema } from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import {
  applyFile,
  checkOut,
  type Change,
  positiveIntFlag,
  writePrepared,
} from "./configure.js";
import { CliError } from "./connections.js";
import type { WriteCommand } from "./write.js";

/** Repeated `ID=N|none` flags; `none` removes the override. */
function overrideFlags(entries: string[] | undefined, flag: string) {
  const limits = new Map<string, number | null>();
  for (const entry of entries ?? []) {
    const [key = "", value = ""] = entry.split("=");
    const id = uuidArg(key, `--${flag} ID`);
    if (limits.has(id))
      throw new CliError("invalid-input", `--${flag} ${id} is repeated.`);
    limits.set(
      id,
      value === "none" ? null : (positiveIntFlag(value, flag) ?? null),
    );
  }
  return limits;
}

const shown = (limit: number | null) =>
  limit === null ? "none" : String(limit);

export const capacityWriteCommands = new Map<string, WriteCommand>([
  [
    "capacity prepare",
    {
      usage:
        "capacity prepare [--out FILE] [--global-limit N] [--min-lead-slots N] [--agent-limit AGENT_ID=N|none]... [--project-limit PROJECT_ID=N|none]...",
      positionals: 0,
      flags: [
        "out",
        "global-limit",
        "min-lead-slots",
        "agent-limit",
        "project-limit",
      ],
      async run(ctx) {
        checkOut(ctx);
        const global = positiveIntFlag(
          ctx.values["global-limit"],
          "global-limit",
        );
        const leadFlag = ctx.values["min-lead-slots"];
        if (leadFlag !== undefined && !/^(0|[1-9][0-9]{0,8})$/.test(leadFlag))
          throw new CliError(
            "invalid-input",
            "--min-lead-slots must be a non-negative integer.",
          );
        const projectLimits = overrideFlags(
          ctx.values["project-limit"],
          "project-limit",
        );
        const agentLimits = overrideFlags(
          ctx.values["agent-limit"],
          "agent-limit",
        );
        const session = await ctx.connect(["cli.identity", "capacity.read"]);
        const read = await session.client.get(
          "/api/operator/runtime",
          runtimeSettingsSchema,
        );
        const r = read.data;
        const changes: Change[] = [];
        const notes: string[] = [];
        const overrides = (
          limits: Map<string, number | null>,
          rows: { id: string; override: number | null; usage: number }[],
          flag: string,
          field: string,
        ) => {
          const expected: Record<string, number | null> = {};
          const wanted: Record<string, number | null> = {};
          for (const [id, limit] of limits) {
            const row = rows.find((candidate) => candidate.id === id);
            if (!row)
              throw new CliError(
                "invalid-input",
                `--${flag} ${id} is not ${flag === "agent-limit" ? "an agent" : "a project"}.`,
              );
            expected[id] = row.override;
            wanted[id] = limit;
            if (limit !== row.override)
              changes.push({
                field: `${field} ${id}`,
                from: shown(row.override),
                to: shown(limit),
              });
            if (limit !== null && limit < row.usage)
              notes.push(
                `${id} is using ${row.usage}; its active turns keep running and new starts wait.`,
              );
          }
          return { expected, wanted };
        };
        const projects = overrides(
          projectLimits,
          r.projects.map((p) => ({
            id: p.project.id,
            override: p.override,
            usage: p.usage,
          })),
          "project-limit",
          "projectLimit",
        );
        const agents = overrides(
          agentLimits,
          r.agents.map((a) => ({
            id: a.agent.id,
            override: a.limit,
            usage: a.usage,
          })),
          "agent-limit",
          "agentLimit",
        );
        const globalLimit = global ?? r.globalLimit;
        if (globalLimit !== r.globalLimit)
          changes.push({
            field: "globalLimit",
            from: String(r.globalLimit),
            to: String(globalLimit),
          });
        const minimumLeadSlots =
          leadFlag === undefined ? r.minimumLeadSlots : Number(leadFlag);
        if (minimumLeadSlots !== r.minimumLeadSlots)
          changes.push({
            field: "minimumLeadSlots",
            from: String(r.minimumLeadSlots),
            to: String(minimumLeadSlots),
          });
        if (minimumLeadSlots >= globalLimit)
          throw new CliError(
            "invalid-input",
            `--min-lead-slots must be below the global limit (${globalLimit}).`,
          );
        if (globalLimit < r.globalUsage)
          notes.push(
            `Global usage is ${r.globalUsage}; active turns keep running and new starts wait.`,
          );
        return writePrepared(ctx, session, {
          kind: "capacity.configure",
          command: {
            type: "capacity.configure",
            globalLimit,
            minimumLeadSlots,
            projectOverrides: projects.wanted,
            agentOverrides: agents.wanted,
            expectedCurrent: {
              globalLimit: r.globalLimit,
              minimumLeadSlots: r.minimumLeadSlots,
              projectOverrides: projects.expected,
              agentOverrides: agents.expected,
            },
          },
          changes,
          diff: [],
          notes,
          gaps: [],
        });
      },
    },
  ],
  [
    "capacity apply",
    {
      usage: "capacity apply --file FILE [--dry-run | --request-id UUID]",
      positionals: 0,
      flags: ["file", "request-id", "dry-run"],
      run: (ctx) => applyFile(ctx, "capacity"),
    },
  ],
]);
