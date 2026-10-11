import { runtimeSettingsSchema } from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import {
  applyFile,
  type Change,
  versionFlag,
  writePrepared,
} from "./configure.js";
import { CliError } from "./connections.js";
import type { WriteCommand } from "./write.js";

export const capacityWriteCommands = new Map<string, WriteCommand>([
  [
    "capacity prepare",
    {
      usage:
        "capacity prepare --out FILE [--global-limit N] [--project-limit PROJECT_ID=N|default]...",
      positionals: 0,
      flags: ["out", "global-limit", "project-limit"],
      async run(ctx) {
        if (!ctx.values.out)
          throw new CliError("usage", "--out FILE is required.");
        const global = versionFlag(ctx.values["global-limit"], "global-limit");
        const limits = new Map<string, number | null>();
        for (const entry of ctx.values["project-limit"] ?? []) {
          const [project = "", value = ""] = entry.split("=");
          const id = uuidArg(project, "--project-limit PROJECT_ID");
          if (limits.has(id))
            throw new CliError(
              "invalid-input",
              `--project-limit ${id} is repeated.`,
            );
          limits.set(
            id,
            value === "default"
              ? null
              : (versionFlag(value, "project-limit") ?? null),
          );
        }
        const session = await ctx.connect(["cli.identity", "capacity.read"]);
        const read = await session.client.get(
          "/api/operator/runtime",
          runtimeSettingsSchema,
        );
        const r = read.data;
        const changes: Change[] = [];
        const notes: string[] = [];
        const expectedOverrides: Record<string, number | null> = {};
        const projectOverrides: Record<string, number | null> = {};
        for (const [id, limit] of limits) {
          const project = r.projects.find((p) => p.project.id === id);
          if (!project)
            throw new CliError(
              "invalid-input",
              `--project-limit ${id} is not a project.`,
            );
          expectedOverrides[id] = project.override;
          projectOverrides[id] = limit;
          if (limit !== project.override)
            changes.push({
              field: `projectLimit ${id}`,
              from:
                project.override === null
                  ? "default"
                  : String(project.override),
              to: limit === null ? "default" : String(limit),
            });
          if ((limit ?? r.defaultProjectLimit) < project.usage)
            notes.push(
              `${id} is using ${project.usage}; its active turns keep running and new starts wait.`,
            );
        }
        const globalLimit = global ?? r.globalLimit;
        if (globalLimit !== r.globalLimit)
          changes.push({
            field: "globalLimit",
            from: String(r.globalLimit),
            to: String(globalLimit),
          });
        if (globalLimit < r.globalUsage)
          notes.push(
            `Global usage is ${r.globalUsage}; active turns keep running and new starts wait.`,
          );
        return writePrepared(ctx, session, {
          kind: "capacity.configure",
          command: {
            type: "capacity.configure",
            globalLimit,
            projectOverrides,
            expectedCurrent: {
              globalLimit: r.globalLimit,
              projectOverrides: expectedOverrides,
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
      usage: "capacity apply --file FILE [--request-id UUID]",
      positionals: 0,
      flags: ["file", "request-id"],
      run: (ctx) => applyFile(ctx, "capacity"),
    },
  ],
]);
