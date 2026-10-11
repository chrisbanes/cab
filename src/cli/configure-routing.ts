import { uuidArg } from "./browse.js";
import {
  boolFlag,
  type Change,
  checkExpected,
  readTextFile,
  requireOut,
  positiveIntFlag,
  writePrepared,
} from "./configure.js";
import { readProject } from "./configure-project.js";
import { CliError } from "./connections.js";
import type { WriteCommand } from "./write.js";

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const routingWriteCommands = new Map<string, WriteCommand>([
  [
    "project prepare-routing",
    {
      usage:
        "project prepare-routing PROJECT_ID --out FILE [--expected-version N] [--enabled true|false] [--candidates ID,ID|none] [--guidance-file PATH] [--credential-ref env:NAME|none]",
      positionals: 1,
      flags: [
        "out",
        "expected-version",
        "enabled",
        "candidates",
        "guidance-file",
        "credential-ref",
      ],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        requireOut(ctx);
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const enabled = boolFlag(ctx.values.enabled, "enabled");
        const raw = ctx.values.candidates;
        const requested =
          raw === undefined
            ? undefined
            : raw === "none"
              ? []
              : raw.split(",").map((c) => uuidArg(c.trim(), "--candidates"));
        const ref = ctx.values["credential-ref"];
        if (
          ref !== undefined &&
          ref !== "none" &&
          !/^env:[A-Z][A-Z0-9_]*$/.test(ref)
        )
          throw new CliError(
            "invalid-input",
            "--credential-ref must be env:NAME or none.",
          );
        const guidance = await readTextFile(
          ctx.values["guidance-file"],
          "guidance-file",
        );
        const session = await ctx.connect(["cli.identity", "workspace.read"]);
        const config = await readProject(session.client, id);
        const { routing, profiles } = config.data;
        checkExpected(routing.version, expected);
        const active = new Set(
          profiles.filter((p) => !p.revoked).map((p) => p.id),
        );
        for (const candidate of requested ?? [])
          if (!active.has(candidate))
            throw new CliError(
              "invalid-input",
              `--candidates ${candidate} is not an active (non-revoked) profile.`,
            );
        const dropped = routing.candidateProfileIds.filter(
          (c) => !active.has(c),
        );
        const saved = routing.candidateProfileIds.filter((c) => active.has(c));
        const candidates = requested ?? saved;
        const nextEnabled = enabled ?? routing.enabled;
        const changes: Change[] = [];
        const notes: string[] = [];
        if (nextEnabled !== routing.enabled)
          changes.push({
            field: "enabled",
            from: String(routing.enabled),
            to: String(nextEnabled),
          });
        if (!sameSet(candidates, routing.candidateProfileIds))
          changes.push({
            field: "candidateProfileIds",
            from: routing.candidateProfileIds.join(",") || "none",
            to: candidates.join(",") || "none",
          });
        if (dropped.length && requested === undefined)
          notes.push(
            `Revoked candidates dropped from the saved set: ${dropped.join(", ")}.`,
          );
        const command: Record<string, unknown> = {
          type: "routing.configure",
          projectId: id,
          expectedVersion: routing.version,
          enabled: nextEnabled,
          candidateProfileIds: candidates,
        };
        const diff: string[] = [];
        if (guidance !== undefined) {
          command.guidance = guidance;
          changes.push({
            field: "guidance",
            from: null,
            to: `${guidance.length} characters`,
          });
          notes.push(
            "Routing guidance is replace-only; the current guidance is not readable.",
          );
          diff.push(...guidance.split("\n").map((l) => `+ ${l}`));
        }
        if (ref !== undefined) {
          command.credentialRef = ref === "none" ? null : ref;
          changes.push({
            field: "credentialRef",
            from: routing.credentialConfigured ? "configured" : "none",
            to: ref,
          });
        }
        return writePrepared(ctx, session, {
          kind: "routing.configure",
          command,
          changes,
          diff,
          notes,
          gaps: [],
        });
      },
    },
  ],
]);
