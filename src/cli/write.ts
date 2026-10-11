import {
  type CliIdentity,
  type CommandReceipt,
  commandReceiptSchema,
} from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import { CliError } from "./connections.js";
import type { RequestJournal } from "./request-journal.js";
import type { ServiceClient } from "./transport.js";
import type { CliDeps, RequestIdentity, Result, Values } from "./types.js";

export type Session = {
  name: string;
  client: ServiceClient;
  identity: CliIdentity;
  result: Pick<Result, "connection" | "service">;
};
export type WriteContext = {
  /** All positionals, including the area and action. */
  positionals: string[];
  values: Values;
  deps: CliDeps;
  journal: RequestJournal;
  /** Negotiates the given capabilities, then returns the session. */
  connect(capabilities: readonly string[]): Promise<Session>;
};
export type WriteOutput = Pick<
  Result,
  "human" | "data" | "coverage" | "request"
>;
/** A configuration, adoption or receipt command; flags outside `flags` are rejected. */
export type WriteCommand = {
  usage: string;
  /** Arguments after the area and action. */
  positionals: number;
  flags: readonly string[];
  run(ctx: WriteContext): Promise<WriteOutput>;
};

const ALWAYS_ALLOWED = ["connection", "output", "help"];
export function rejectUnusedFlags(values: Values, flags: readonly string[]) {
  for (const [name, value] of Object.entries(values))
    if (
      value !== undefined &&
      !ALWAYS_ALLOWED.includes(name) &&
      !flags.includes(name)
    )
      throw new CliError(
        "usage",
        `--${name} is not an option of this command.`,
      );
}

/** The service rejects non-question command bodies above 64 KiB. */
export const MAX_COMMAND_BYTES = 64 * 1024;
export function checkCommandSize(body: string) {
  if (Buffer.byteLength(body) > MAX_COMMAND_BYTES)
    throw new CliError(
      "invalid-input",
      "The change is larger than the service accepts (64 KiB).",
    );
}

export const optionalRequestId = (values: Values) =>
  values["request-id"] === undefined
    ? undefined
    : uuidArg(values["request-id"], "--request-id");

export function reconcileHint(identity: RequestIdentity): string {
  return `ensemble operation get ${identity.key} --scope ${identity.scope} --type ${identity.type}`;
}

function matches(
  receipt: CommandReceipt,
  identity: RequestIdentity,
  resource: string,
) {
  if (receipt.key !== identity.key) return false;
  if (receipt.kind === "configuration")
    return (
      receipt.result.commandType === identity.type &&
      receipt.result.resourceId === resource
    );
  return (
    receipt.kind === "domain" &&
    identity.type === "assignment.apply" &&
    "profileRevision" in receipt.result &&
    receipt.result.id === resource
  );
}

const withRequest = (error: CliError, request: RequestIdentity) =>
  new CliError(error.code, error.message, { ...error.extra, request });

/**
 * Journals the identity (fsynced) before sending one command, then settles it. A failure
 * that may have reached the service is `command-outcome-unknown` with the full identity.
 */
export async function sendCommand(
  ctx: WriteContext,
  session: Session,
  o: {
    scope: string;
    type: string;
    key: string;
    digest: string;
    resource: string;
    command: Record<string, unknown>;
  },
): Promise<{ receipt: CommandReceipt; request: RequestIdentity }> {
  const request: RequestIdentity = {
    service: session.identity.service.installationId,
    scope: o.scope,
    type: o.type,
    key: o.key,
  };
  const body = JSON.stringify(o.command);
  checkCommandSize(body);
  await ctx.journal.append(request, o.digest, "sending");
  // A settle failure leaves the `sending` line, which `operation get` reconciles.
  const settle = (state: "recorded" | "rejected" | "unknown") =>
    ctx.journal.append(request, o.digest, state).catch(() => undefined);
  try {
    const raw = await session.client.command(
      body,
      ctx.deps.commandTimeoutMs ?? 60_000,
    );
    const receipt = commandReceiptSchema.safeParse(raw);
    if (!receipt.success || !matches(receipt.data, request, o.resource))
      throw new CliError(
        "command-outcome-unknown",
        "The service response is not the expected receipt.",
        { retryable: true },
      );
    await settle("recorded");
    return { receipt: receipt.data, request };
  } catch (raw) {
    const error =
      raw instanceof CliError
        ? raw
        : new CliError("command-outcome-unknown", "Unexpected CLI failure.", {
            retryable: true,
          });
    const unknown = error.code === "command-outcome-unknown";
    await settle(unknown ? "unknown" : "rejected");
    if (!unknown) throw withRequest(error, request);
    throw new CliError(
      error.code,
      `${error.message} Check with '${reconcileHint(request)}', or retry the same command with --request-id ${request.key}.`,
      { ...error.extra, request },
    );
  }
}
