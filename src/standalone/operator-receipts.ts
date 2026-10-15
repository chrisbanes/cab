import type { DomainCommandOutcome } from "../core/command-results.js";
import {
  type CommandReceipt,
  commandReceiptSchema,
} from "../operator/contracts.js";

/** A stored result that lacks a field the requested receipt type needs. */
export class ReceiptShapeError extends Error {
  constructor() {
    super("Stored result does not match the command type");
    this.name = "ReceiptShapeError";
  }
}

/**
 * Projects a validated domain result into its public receipt. Private text is never
 * copied into a receipt; each command variant names the fields it exposes.
 */
export function commandReceipt(
  outcome: DomainCommandOutcome,
  key: string,
  resourceId: string,
): CommandReceipt {
  const result = (() => {
    switch (outcome.type) {
      case "assignment.apply":
        return {
          kind: "domain" as const,
          key,
          recorded: true as const,
          result: {
            id: outcome.result.id,
            taskId: outcome.result.taskId,
            projectId: outcome.result.projectId,
            version: outcome.result.version,
            profileRevision: outcome.result.profileRevision,
            instructionsRevision: outcome.result.instructionsRevision,
          },
        };
      case "project.create":
      case "project.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId: outcome.result.id,
            version: outcome.result.version,
            paused: outcome.result.paused === 1,
            leadProfileId: outcome.result.leadProfileId,
            instructionsRevision: outcome.result.instructionsRevision,
          },
        };
      case "profile.create":
      case "profile.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId: outcome.result.id,
            version: outcome.result.version,
            revoked: outcome.result.revoked === 1,
          },
        };
      case "routing.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId,
            version: outcome.result.version,
            enabled: outcome.result.enabled === 1,
            credentialConfigured: outcome.result.credentialAvailable === 1,
          },
        };
      case "github.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId,
            version: outcome.result.version,
            credentialConfigured: outcome.result.credentialRef !== null,
            selectionCount: outcome.result.selections.length,
            repositoryCount: outcome.result.repositories.length,
          },
        };
      case "github.activate":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: "github.preview" as const,
            resourceId: outcome.result.projectId,
            selectionId: outcome.result.selectionId,
            configVersion: outcome.result.configVersion,
            active: outcome.result.active,
            ...(outcome.result.alreadyActive === undefined
              ? {}
              : { alreadyActive: outcome.result.alreadyActive }),
          },
        };
      case "capacity.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId: "system:capacity" as const,
            globalLimit: outcome.result.globalLimit,
            defaultProjectLimit: outcome.result.defaultProjectLimit,
            projectOverrides: outcome.result.projectOverrides,
          },
        };
      case "getting-started.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId: "system:getting-started" as const,
            dismissed: outcome.result.dismissed,
          },
        };
      case "runtime.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId: `system:runtime:${outcome.result.harness}` as const,
            harness: outcome.result.harness,
            enabled: outcome.result.enabled,
          },
        };
      case "discovery.configure":
      case "claude-token.configure":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId:
              outcome.type === "discovery.configure"
                ? ("system:discovery" as const)
                : ("system:claude-token" as const),
            configured: outcome.result.configured,
          },
        };
      case "github.place":
        return {
          kind: "configuration" as const,
          key,
          recorded: true as const,
          result: {
            commandType: outcome.type,
            resourceId: outcome.result.id,
            projectId: outcome.result.projectId,
            version: outcome.result.version,
          },
        };
      case "task.create":
      case "task.configure":
      case "source.review":
      case "dependency.add":
      case "dependency.remove":
      case "imported-blockers.set":
        return {
          kind: "domain" as const,
          key,
          recorded: true as const,
          result: {
            id: outcome.result.id,
            projectId: outcome.result.projectId,
            version: outcome.result.version,
            state: outcome.result.state,
            ready: outcome.result.ready === 1,
          },
        };
      case "delivery.configure":
      case "assignment.create":
        throw new ReceiptShapeError();
      default: {
        const exhaustive: never = outcome;
        throw exhaustive;
      }
    }
  })();
  switch (outcome.type) {
    case "project.create":
    case "profile.create":
      if (outcome.result.version !== 1) throw new ReceiptShapeError();
      break;
    case "project.configure":
    case "profile.configure":
    case "assignment.apply":
      if (outcome.result.version === 1) throw new ReceiptShapeError();
      break;
    default:
      break;
  }
  const parsed = commandReceiptSchema.safeParse(result);
  if (!parsed.success) throw new ReceiptShapeError();
  return parsed.data;
}
