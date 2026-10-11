import { createHash, randomUUID } from "node:crypto";
import {
  type CliIdentity,
  type CommandReceipt,
  commandReceiptSchema,
  operationTypeSchema,
  questionCommandRawLimit,
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
const QUESTION_FORM_TYPES = ["question.form.answer", "question.native.answer"];
export function checkCommandSize(body: string, type?: string) {
  const limit = QUESTION_FORM_TYPES.includes(type ?? "")
    ? questionCommandRawLimit
    : MAX_COMMAND_BYTES;
  if (Buffer.byteLength(body) > limit)
    throw new CliError(
      "invalid-input",
      `The change is larger than the service accepts (${Math.floor(limit / 1024)} KiB).`,
    );
}

/** A stable version-4-shaped UUID, so a retry with the same key rebuilds the same command. */
export function derivedUuid(
  service: string,
  projectId: string,
  key: string,
  purpose: string,
): string {
  const b = createHash("sha256")
    .update([service, projectId, key, purpose].join("\n"))
    .digest()
    .subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const optionalRequestId = (values: Values) =>
  values["request-id"] === undefined
    ? undefined
    : uuidArg(values["request-id"], "--request-id");

/**
 * The key for a repeatable intent (Stop, a message, an answer): an explicit --request-id,
 * else a journal key whose outcome is still unresolved, else a new one. `reused` means an
 * earlier attempt with this key may have applied, so pre-read gates must not block it.
 */
export async function chooseKey(
  ctx: WriteContext,
  session: Session,
  identity: { scope: string; type: string },
  material: unknown,
) {
  const service = session.identity.service.installationId;
  const digest = createHash("sha256")
    .update(JSON.stringify([service, identity.scope, identity.type, material]))
    .digest("hex");
  const requested = optionalRequestId(ctx.values);
  const found =
    requested ??
    (await ctx.journal.find(service, digest, { unresolved: true }));
  const key = found ?? randomUUID();
  const reused =
    found !== undefined &&
    (requested === undefined ||
      (await ctx.journal.state({ service, ...identity, key }))?.reached ===
        true);
  return { key, digest, reused };
}

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
    /** Checks a 2xx receipt belongs to this request; defaults to the CLI3 matcher. */
    match?: (receipt: CommandReceipt) => boolean;
  },
): Promise<{ receipt: CommandReceipt; request: RequestIdentity }> {
  const request: RequestIdentity = {
    service: session.identity.service.installationId,
    scope: o.scope,
    type: o.type,
    key: o.key,
  };
  const body = JSON.stringify(o.command);
  checkCommandSize(body, o.type);
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
    if (
      !receipt.success ||
      receipt.data.key !== request.key ||
      !(o.match
        ? o.match(receipt.data)
        : matches(receipt.data, request, o.resource))
    )
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
    const retry = `retry the same command with --request-id ${request.key}`;
    throw new CliError(
      error.code,
      operationTypeSchema.safeParse(request.type).success
        ? `${error.message} Check with '${reconcileHint(request)}', or ${retry}.`
        : `${error.message} To settle it, ${retry}.`,
      { ...error.extra, request },
    );
  }
}
