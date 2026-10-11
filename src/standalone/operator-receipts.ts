import type { z } from "zod";
import {
  type CommandReceipt,
  commandReceiptSchema,
  type operationTypeSchema,
} from "../operator/contracts.js";

type ReceiptCommandType = z.infer<typeof operationTypeSchema>;

/** A stored result that lacks a field the requested receipt type needs. */
export class ReceiptShapeError extends Error {
  constructor() {
    super("Stored result does not match the command type");
    this.name = "ReceiptShapeError";
  }
}

/**
 * Projects a stored domain result into the receipt POST returned. Only IDs, numbers and
 * flags are read, so stored private text (instructions, guidance) never reaches a receipt.
 */
export function commandReceipt(
  type: ReceiptCommandType,
  key: string,
  resourceId: string,
  raw: unknown,
): CommandReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ReceiptShapeError();
  const r = raw as Record<string, unknown>;
  const field = (name: string) => {
    if (!(name in r) || r[name] === undefined) throw new ReceiptShapeError();
    return r[name];
  };
  const result =
    type === "assignment.apply"
      ? {
          id: String(field("id")),
          taskId: String(field("taskId")),
          projectId: String(field("projectId")),
          version: Number(field("version")),
          profileRevision: Number(field("profileRevision")),
          instructionsRevision: Number(field("instructionsRevision")),
        }
      : type === "project.create" || type === "project.configure"
        ? {
            commandType: type,
            resourceId: String(field("id")),
            version: Number(field("version")),
            paused: Boolean(field("paused")),
            leadProfileId:
              field("leadProfileId") === null ? null : String(r.leadProfileId),
            instructionsRevision: Number(field("instructionsRevision")),
          }
        : type === "profile.create" || type === "profile.configure"
          ? {
              commandType: type,
              resourceId: String(field("id")),
              version: Number(field("version")),
              revoked: Boolean(field("revoked")),
            }
          : type === "routing.configure"
            ? {
                commandType: type,
                resourceId,
                version: Number(field("version")),
                enabled: Boolean(field("enabled")),
                credentialConfigured: Boolean(field("credentialAvailable")),
              }
            : {
                commandType: type,
                resourceId: "system:capacity",
                globalLimit: field("globalLimit"),
                defaultProjectLimit: field("defaultProjectLimit"),
                projectOverrides: field("projectOverrides"),
              };
  const parsed = commandReceiptSchema.safeParse({
    kind: type === "assignment.apply" ? "domain" : "configuration",
    key,
    recorded: true,
    result,
  });
  if (!parsed.success) throw new ReceiptShapeError();
  return parsed.data;
}
