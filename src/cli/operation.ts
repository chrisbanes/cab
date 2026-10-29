import {
  type CommandReceipt,
  operationReadSchema,
  operationScopeSchema,
  operationTypeSchema,
} from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import { CliError } from "./connections.js";
import { keyValues } from "./render.js";
import type { WriteCommand } from "./write.js";

/** Human summary of a configuration, adoption or recovery receipt. */
export function receiptLines(receipt: CommandReceipt): [string, string][] {
  if (receipt.kind === "domain" && "profileRevision" in receipt.result)
    return [
      ["Assignment", receipt.result.id],
      ["Version", String(receipt.result.version)],
      ["Profile revision", String(receipt.result.profileRevision)],
      ["Instructions revision", String(receipt.result.instructionsRevision)],
    ];
  if (
    receipt.kind === "recovery-adoption" ||
    receipt.kind === "recovery-resolution" ||
    receipt.kind === "conversation-replacement"
  )
    return Object.entries(receipt)
      .filter(([k]) => !["kind", "key", "recorded"].includes(k))
      .map(([k, v]): [string, string] => [k, String(v)]);
  if (receipt.kind !== "configuration") return [];
  const r = receipt.result;
  return [
    ["Resource", r.resourceId],
    ...Object.entries(r)
      .filter(([k]) => k !== "commandType" && k !== "resourceId")
      .map(([k, v]): [string, string] => [
        k,
        typeof v === "object" && v !== null ? JSON.stringify(v) : String(v),
      ]),
  ];
}

export const operationCommands = new Map<string, WriteCommand>([
  [
    "operation get",
    {
      usage: "operation get REQUEST_ID --scope SCOPE --type TYPE",
      positionals: 1,
      flags: ["scope", "type"],
      async run(ctx) {
        const key = uuidArg(ctx.positionals[2] ?? "", "REQUEST_ID");
        const scope = operationScopeSchema.safeParse(ctx.values.scope);
        if (!scope.success)
          throw new CliError(
            "invalid-input",
            "--scope must be project:ID, profile:ID, assignment:ID, system:capacity or system:runtime:HARNESS.",
          );
        const type = operationTypeSchema.safeParse(ctx.values.type);
        if (!type.success)
          throw new CliError(
            "invalid-input",
            `--type must be ${operationTypeSchema.options.join(", ")}.`,
          );
        const session = await ctx.connect([
          "cli.identity",
          "operation.read",
          ...(type.data.startsWith("github.") ||
          type.data === "repositories.configure"
            ? ["source.write"]
            : []),
          ...(type.data.startsWith("recovery.") ? ["recovery.read"] : []),
        ]);
        const request = {
          service: session.identity.service.installationId,
          scope: scope.data,
          type: type.data,
          key,
        };
        const query = new URLSearchParams({
          scope: scope.data,
          type: type.data,
          key,
        });
        const read = await session.client.get(
          `/api/operator/operations?${query}`,
          operationReadSchema,
        );
        if (read.data.state === "recorded") {
          const local = await ctx.journal.state(request).catch(() => undefined);
          if (local && (local.state === "sending" || local.state === "unknown"))
            await ctx.journal
              .append(request, local.digest, "recorded")
              .catch(() => undefined);
        }
        return {
          request,
          data: read.data,
          human:
            read.data.state === "recorded"
              ? [
                  `Recorded: ${type.data} ${scope.data} (request ${key})`,
                  keyValues(receiptLines(read.data.receipt)),
                ].join("\n")
              : `Not recorded: no ${type.data} receipt for request ${key} in ${scope.data}.`,
        };
      },
    },
  ],
]);
