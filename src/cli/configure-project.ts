import { randomUUID } from "node:crypto";
import {
  projectConfigurationSchema,
  projectInstructionsSchema,
} from "../operator/contracts.js";
import { type CoverageGap, uuidArg } from "./browse.js";
import {
  applyFile,
  boolFlag,
  type Change,
  checkExpected,
  consistentRead,
  readImpact,
  readTextFile,
  requireOut,
  uuidOrNone,
  positiveIntFlag,
  writePrepared,
} from "./configure.js";
import {
  instructionChange,
  proposedInstructions,
} from "./configure-profile.js";
import { CliError } from "./connections.js";
import type { ServiceClient } from "./transport.js";
import type { WriteCommand } from "./write.js";

const API = "/api/operator";

export const readProject = (client: ServiceClient, id: string) =>
  client.get(`${API}/projects/${id}/configuration`, projectConfigurationSchema);

const instructionsOf = (client: ServiceClient, id: string, revision?: number) =>
  client
    .get(
      `${API}/projects/${id}/instructions${revision === undefined ? "" : `?revision=${revision}`}`,
      projectInstructionsSchema,
    )
    .then((r) => r.data.selected);

export const projectWriteCommands = new Map<string, WriteCommand>([
  [
    "project prepare",
    {
      usage:
        "project prepare PROJECT_ID --out FILE [--expected-version N] [--name S] [--paused true|false] [--lead-profile ID|none] [--instructions-file PATH | --restore-revision N]",
      positionals: 1,
      flags: [
        "out",
        "expected-version",
        "name",
        "paused",
        "lead-profile",
        "instructions-file",
        "restore-revision",
      ],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        requireOut(ctx);
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const paused = boolFlag(ctx.values.paused, "paused");
        const lead = uuidOrNone(ctx.values["lead-profile"], "lead-profile");
        const session = await ctx.connect([
          "cli.identity",
          "workspace.read",
          "instructions.read",
          "configuration.impact",
        ]);
        const client = session.client;
        let current!: Awaited<ReturnType<typeof instructionsOf>>;
        let impact!: Awaited<ReturnType<typeof readImpact>>;
        let proposed: string | undefined;
        const config = await consistentRead(
          () => readProject(client, id),
          (r) => r.data.project.version,
          async () => {
            current = await instructionsOf(client, id);
            proposed = await proposedInstructions(ctx.values, (r) =>
              instructionsOf(client, id, r),
            );
            impact = await readImpact(
              client,
              "project",
              id,
              proposed === undefined ? null : "instructions",
            );
          },
        );
        const p = config.data.project;
        checkExpected(p.version, expected);
        const changes: Change[] = [],
          diff: string[] = [],
          notes: string[] = [],
          gaps: CoverageGap[] = [...impact.gaps];
        const command: Record<string, unknown> = {
          type: "project.configure",
          projectId: id,
          expectedVersion: p.version,
        };
        // The contract trims names; compare what the service will store.
        const name = ctx.values.name?.trim();
        if (name !== undefined && name !== p.name) {
          if (p.name === null) gaps.push("content-unavailable");
          command.name = name;
          changes.push({ field: "name", from: p.name, to: name });
        }
        if (paused !== undefined && paused !== p.paused) {
          command.paused = paused;
          changes.push({
            field: "paused",
            from: String(p.paused),
            to: String(paused),
          });
        }
        if (lead !== undefined && lead !== p.leadProfileId) {
          command.leadProfileId = lead;
          changes.push({
            field: "leadProfileId",
            from: p.leadProfileId ?? "none",
            to: lead ?? "none",
          });
        }
        instructionChange(current, proposed, changes, diff, gaps, notes);
        if (proposed !== undefined) command.instructions = proposed;
        if (ctx.values["restore-revision"] !== undefined)
          notes.push(
            `Restores revision ${ctx.values["restore-revision"]}'s instructions as a new revision; history is unchanged.`,
          );
        return writePrepared(ctx, session, {
          kind: "project.configure",
          command,
          changes,
          diff,
          impact: impact.impact,
          impactLines: impact.lines,
          notes,
          gaps,
        });
      },
    },
  ],
  [
    "project prepare-create",
    {
      usage:
        "project prepare-create --out FILE --name S [--lead-profile ID|none] [--instructions-file PATH] [--id UUID]",
      positionals: 0,
      flags: ["out", "name", "lead-profile", "instructions-file", "id"],
      async run(ctx) {
        requireOut(ctx);
        if (ctx.values.name === undefined)
          throw new CliError("usage", "--name is required.");
        const id =
          ctx.values.id === undefined
            ? randomUUID()
            : uuidArg(ctx.values.id, "--id");
        const lead =
          uuidOrNone(ctx.values["lead-profile"], "lead-profile") ?? null;
        const instructions = await readTextFile(
          ctx.values["instructions-file"],
          "instructions-file",
        );
        const session = await ctx.connect(["cli.identity", "workspace.read"]);
        return writePrepared(ctx, session, {
          kind: "project.create",
          command: {
            type: "project.create",
            projectId: id,
            name: ctx.values.name?.trim(),
            leadProfileId: lead,
            ...(instructions === undefined ? {} : { instructions }),
          },
          changes: [
            { field: "project", from: null, to: id },
            { field: "name", from: null, to: ctx.values.name?.trim() },
            { field: "leadProfileId", from: null, to: lead ?? "none" },
            ...(instructions === undefined
              ? []
              : [
                  {
                    field: "instructions",
                    from: null,
                    to: `${instructions.length} characters`,
                  },
                ]),
          ],
          diff: instructions?.split("\n").map((l) => `+ ${l}`) ?? [],
          notes: [
            "The project is created paused. Creation cannot be undone; a project can later be paused. Repository and GitHub links are not set here.",
          ],
          gaps: [],
        });
      },
    },
  ],
  [
    "project apply",
    {
      usage: "project apply --file FILE [--request-id UUID]",
      positionals: 0,
      flags: ["file", "request-id"],
      run: (ctx) => applyFile(ctx, "project"),
    },
  ],
]);
