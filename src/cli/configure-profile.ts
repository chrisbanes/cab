import { randomUUID } from "node:crypto";
import {
  profileConfigurationSchema,
  profileInstructionsSchema,
} from "../operator/contracts.js";
import { type CoverageGap, uuidArg } from "./browse.js";
import {
  applyFile,
  boolFlag,
  type Change,
  checkExpected,
  consistentRead,
  inlineText,
  readImpact,
  readTextFile,
  checkOut,
  positiveIntFlag,
  writePrepared,
} from "./configure.js";
import { CliError } from "./connections.js";
import { lineDiff } from "./diff.js";
import type { ServiceClient } from "./transport.js";
import type { Values } from "./types.js";
import type { WriteCommand, WriteContext } from "./write.js";

const API = "/api/operator";

type Body = {
  state: "available" | "omitted";
  text: string | null;
  redacted: boolean;
};

/** Current instruction text for a diff, and the gap that applies when it is not exact. */
export function currentText(body: Body): {
  text: string | null;
  gaps: CoverageGap[];
  note?: string;
} {
  if (body.state === "omitted" || body.text === null)
    return {
      text: null,
      gaps: ["redaction-unavailable"],
      note: "The current instructions are not readable; the diff shows only the proposed text.",
    };
  if (body.redacted)
    return {
      text: body.text,
      gaps: ["content-redacted"],
      note: "The current instructions are shown redacted; the diff is approximate.",
    };
  return { text: body.text, gaps: [] };
}

/** Exact text of a retained revision, refusing sanitized or withheld text. */
export function restorable(body: Body, revision: number): string {
  if (body.state === "omitted" || body.text === null || body.redacted)
    throw new CliError(
      "invalid-input",
      `Revision ${revision}'s instructions are ${body.redacted ? "redacted" : "not available"}, so they cannot be restored exactly. Nothing was written.`,
    );
  return body.text;
}

/** Proposed instruction text: a restored revision, else the text `givenInstructions` read. */
export async function proposedInstructions(
  values: Values,
  restore: (revision: number) => Promise<Body>,
  given: string | undefined,
) {
  const revision = positiveIntFlag(
    values["restore-revision"],
    "restore-revision",
  );
  if (revision !== undefined)
    return restorable(await restore(revision), revision);
  return given;
}

/** `--instructions TEXT|-` or `--instructions-file`, read once; neither combines with a restore. */
export function givenInstructions(ctx: WriteContext) {
  const v = ctx.values;
  if (
    (v.instructions !== undefined || v["instructions-file"] !== undefined) &&
    v["restore-revision"] !== undefined
  )
    throw new CliError(
      "usage",
      "Use either --instructions or --instructions-file, or --restore-revision, not both.",
    );
  return inlineText(ctx, "instructions");
}

export function instructionChange(
  current: Body,
  proposed: string | undefined,
  changes: Change[],
  diff: string[],
  gaps: CoverageGap[],
  notes: string[],
) {
  if (proposed === undefined) return;
  const now = currentText(current);
  if (now.gaps.length === 0 && now.text === proposed)
    throw new CliError(
      "invalid-input",
      "No change: the proposed instructions equal the current instructions.",
    );
  gaps.push(...now.gaps);
  if (now.note) notes.push(now.note);
  changes.push({
    field: "instructions",
    from: now.text === null ? null : `${now.text.length} characters`,
    to: `${proposed.length} characters`,
  });
  diff.push(
    ...(now.text === null
      ? proposed.split("\n").map((l) => `+ ${l}`)
      : lineDiff(now.text, proposed)),
  );
}

async function readProfile(client: ServiceClient, id: string) {
  return client.get(
    `${API}/profiles/${id}/configuration`,
    profileConfigurationSchema,
  );
}

const instructionsOf = (client: ServiceClient, id: string, revision?: number) =>
  client
    .get(
      `${API}/profiles/${id}/instructions${revision === undefined ? "" : `?revision=${revision}`}`,
      profileInstructionsSchema,
    )
    .then((r) => r.data.selected);

export const profileWriteCommands = new Map<string, WriteCommand>([
  [
    "profile prepare",
    {
      usage:
        "profile prepare PROFILE_ID [--out FILE] [--expected-version N] [--name S] [--summary S] [--instructions TEXT|- | --instructions-file PATH | --restore-revision N] [--capabilities-file PATH] [--revoked true|false]",
      positionals: 1,
      flags: [
        "out",
        "expected-version",
        "name",
        "summary",
        "instructions",
        "instructions-file",
        "restore-revision",
        "capabilities-file",
        "revoked",
      ],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROFILE_ID");
        checkOut(ctx);
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const revoked = boolFlag(ctx.values.revoked, "revoked");
        const capabilities = await readTextFile(
          ctx.values["capabilities-file"],
          "capabilities-file",
        );
        // Read once before connecting: standard input cannot be read again on a retried read.
        const given = await givenInstructions(ctx);
        const session = await ctx.connect([
          "cli.identity",
          "workspace.read",
          "instructions.read",
          "configuration.impact",
        ]);
        const client = session.client;
        let current!: Body;
        let impact!: Awaited<ReturnType<typeof readImpact>>;
        let proposed: string | undefined;
        const config = await consistentRead(
          () => readProfile(client, id),
          (r) => r.data.profile.version,
          async () => {
            current = await instructionsOf(client, id);
            proposed = await proposedInstructions(
              ctx.values,
              (r) => instructionsOf(client, id, r),
              given,
            );
            impact = await readImpact(client, "profile", id, "profile");
          },
        );
        const p = config.data;
        checkExpected(p.profile.version, expected);
        const changes: Change[] = [],
          diff: string[] = [],
          notes: string[] = [],
          gaps: CoverageGap[] = [...impact.gaps];
        const command: Record<string, unknown> = {
          type: "profile.configure",
          profileId: id,
          expectedVersion: p.profile.version,
        };
        const field = (
          name: string,
          now: string | null,
          next: string | undefined,
          show = (v: string | null) => v,
        ) => {
          if (next === undefined || next === now) return;
          if (now === null) gaps.push("content-unavailable");
          command[name] = next;
          changes.push({ field: name, from: show(now), to: show(next) });
        };
        field("name", p.profile.name, ctx.values.name?.trim());
        field("summary", p.profile.summary, ctx.values.summary?.trim());
        field("capabilities", p.capabilities, capabilities, (v) =>
          v === null ? null : `${v.length} characters`,
        );
        if (capabilities !== undefined && capabilities !== p.capabilities)
          diff.push(
            ...(p.capabilities === null
              ? capabilities.split("\n").map((l) => `+ ${l}`)
              : lineDiff(p.capabilities, capabilities)),
          );
        if (revoked !== undefined && revoked !== p.profile.revoked) {
          command.revoked = revoked;
          changes.push({
            field: "revoked",
            from: String(p.profile.revoked),
            to: String(revoked),
          });
        }
        instructionChange(current, proposed, changes, diff, gaps, notes);
        if (proposed !== undefined) command.instructions = proposed;
        if (ctx.values["restore-revision"] !== undefined)
          notes.push(
            `Restores revision ${ctx.values["restore-revision"]}'s instructions as a new revision; history is unchanged.`,
          );
        return writePrepared(ctx, session, {
          kind: "profile.configure",
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
    "profile prepare-create",
    {
      usage:
        "profile prepare-create [--out FILE] --name S (--instructions TEXT|- | --instructions-file PATH) [--summary S] [--capabilities-file PATH] [--id UUID]",
      positionals: 0,
      flags: [
        "out",
        "name",
        "summary",
        "instructions",
        "instructions-file",
        "capabilities-file",
        "id",
      ],
      async run(ctx) {
        checkOut(ctx);
        const usage = new CliError(
          "usage",
          "--name and --instructions TEXT (or - for standard input, or --instructions-file PATH) are required.",
        );
        if (ctx.values.name === undefined) throw usage;
        const id =
          ctx.values.id === undefined
            ? randomUUID()
            : uuidArg(ctx.values.id, "--id");
        const instructions = await inlineText(ctx, "instructions");
        if (instructions === undefined) throw usage;
        const capabilities =
          (await readTextFile(
            ctx.values["capabilities-file"],
            "capabilities-file",
          )) ?? "";
        const session = await ctx.connect(["cli.identity", "workspace.read"]);
        return writePrepared(ctx, session, {
          kind: "profile.create",
          command: {
            type: "profile.create",
            profileId: id,
            name: ctx.values.name?.trim(),
            ...(ctx.values.summary === undefined
              ? {}
              : { summary: ctx.values.summary?.trim() }),
            instructions,
            capabilities,
          },
          changes: [
            { field: "profile", from: null, to: id },
            { field: "name", from: null, to: ctx.values.name?.trim() },
            {
              field: "instructions",
              from: null,
              to: `${instructions.length} characters`,
            },
          ],
          diff: instructions.split("\n").map((l) => `+ ${l}`),
          notes: [
            "Creation cannot be undone; a profile can later be revoked. The service default runtime applies.",
          ],
          gaps: [],
        });
      },
    },
  ],
  [
    "profile apply",
    {
      usage: "profile apply --file FILE [--request-id UUID]",
      positionals: 0,
      flags: ["file", "request-id"],
      run: (ctx) => applyFile(ctx, "profile"),
    },
  ],
]);
