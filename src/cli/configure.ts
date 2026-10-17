import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  configurationImpactSchema,
  operatorCommandSchema,
} from "../operator/contracts.js";
import { type CoverageGap, coverage, uuidArg } from "./browse.js";
import {
  CHANGE_SCHEMA,
  type ChangeDocument,
  type ChangeKind,
  canonicalJson,
  openFailure,
  readChangeDocument,
  writeChangeDocument,
} from "./change-document.js";
import { CliError } from "./connections.js";
import { boundLines } from "./diff.js";
import { receiptLines } from "./operation.js";
import { shellWord } from "./remedy.js";
import { isoTime, keyValues } from "./render.js";
import type { ServiceClient } from "./transport.js";
import {
  checkCommandSize,
  optionalRequestId,
  type Session,
  sendCommand,
  type WriteContext,
  type WriteOutput,
} from "./write.js";

export type Change = { field: string; from: string | null; to: string | null };
export type Prepared = {
  kind: ChangeKind;
  /** Command without its key; validated and normalized here with the service schema. */
  command: Record<string, unknown>;
  changes: Change[];
  diff: string[];
  impact?: unknown;
  impactLines?: string[];
  notes: string[];
  gaps: CoverageGap[];
};

const AREA: Record<ChangeKind, string> = {
  "profile.create": "profile",
  "profile.configure": "profile",
  "project.create": "project",
  "project.configure": "project",
  "routing.configure": "project",
  "capacity.configure": "capacity",
  "github.configure": "project",
};
export const isCreation = (kind: ChangeKind) => kind.endsWith(".create");

/** Receipt scope and resource the command addresses. */
export function targetOf(command: Record<string, unknown>) {
  if (command.type === "capacity.configure")
    return { scope: "system:capacity", id: "system:capacity" };
  if (typeof command.profileId === "string")
    return { scope: `profile:${command.profileId}`, id: command.profileId };
  return {
    scope: `project:${String(command.projectId)}`,
    id: String(command.projectId),
  };
}

function expectedOf(command: Record<string, unknown>): Record<string, unknown> {
  if (command.type === "capacity.configure")
    return command.expectedCurrent === undefined
      ? {}
      : { capacity: command.expectedCurrent };
  return command.expectedVersion === undefined
    ? {}
    : { version: command.expectedVersion };
}

/** Parses the exact command the service will receive, as the service does. */
export function exactCommand(command: Record<string, unknown>, key: string) {
  const parsed = operatorCommandSchema.safeParse({ ...command, key });
  if (!parsed.success)
    throw new CliError(
      "invalid-input",
      `The change is not valid: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || i.message))].join(", ")}.`,
    );
  return parsed.data as Record<string, unknown>;
}

export function boolFlag(value: string | undefined, flag: string) {
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false")
    throw new CliError("invalid-input", `--${flag} must be true or false.`);
  return value === "true";
}

export function positiveIntFlag(value: string | undefined, flag: string) {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,8}$/.test(value))
    throw new CliError(
      "invalid-input",
      `--${flag} must be a positive integer.`,
    );
  return Number(value);
}

export async function readTextFile(path: string | undefined, flag: string) {
  if (path === undefined) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const { why, fix } = openFailure(
      error,
      path,
      `Check the path given to --${flag}.`,
    );
    throw new CliError(
      "invalid-input",
      `Cannot read --${flag} ${path}: ${why}.`,
      {
        fix,
      },
    );
  }
}

export function requireOut(ctx: WriteContext): string {
  const out = ctx.values.out;
  if (!out) throw new CliError("usage", "--out FILE is required.");
  return out;
}

/** Reads until the target version is stable across the other reads, retrying once. */
export async function consistentRead<T>(
  read: () => Promise<T>,
  version: (value: T) => number,
  rest: (value: T) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await read();
    await rest(first);
    if (version(await read()) === version(first)) return first;
  }
  throw new CliError(
    "conflict",
    "The target kept changing while it was read. Prepare the change again.",
    {
      fix: "Prepare the change again once nothing else is editing the target.",
    },
  );
}

export function checkExpected(current: number, expected: number | undefined) {
  if (expected !== undefined && expected !== current)
    throw new CliError(
      "conflict",
      `The target is at version ${current}, not ${expected}. Review the current state and prepare again.`,
      {
        fix: `Review the target with its 'get' command, then prepare again with --expected-version ${current}.`,
      },
    );
}

/** Informational, preparation-time list of assignments the change may make stale. */
export async function readImpact(
  client: ServiceClient,
  kind: "project" | "profile",
  id: string,
  axis: "profile" | "instructions" | null,
) {
  const read = await client.get(
    `/api/operator/${kind}s/${id}/impact`,
    configurationImpactSchema,
  );
  const rows = read.data.assignments;
  const stale = (r: (typeof rows)[number]) =>
    r.stale.profile || r.stale.instructions;
  const impact = {
    label: "preparation-time, informational",
    observedAt: read.observedAt,
    total: read.data.total,
    listed: rows.length,
    wouldBecomeStale:
      axis === null
        ? 0
        : rows.filter((r) => r.state !== "completed" && !r.stale[axis]).length,
    alreadyStale: rows.filter(stale).length,
    held: rows.filter((r) => r.state === "held").length,
    completed: rows.filter((r) => r.state === "completed").length,
    assignmentIds: rows.slice(0, 20).map((r) => r.assignmentId),
    note: "Not an apply-time fence: assignments created after preparation may also become stale or held, and bound leads without an assignment row are not listed.",
  };
  return {
    impact,
    gaps: read.data.truncated ? (["item-omitted"] as CoverageGap[]) : [],
    lines: [
      `Affected assignments (${impact.label}, observed ${isoTime(impact.observedAt)}): ${impact.total} bound; ${impact.wouldBecomeStale} would become stale, ${impact.alreadyStale} already stale, ${impact.held} held, ${impact.completed} completed.`,
      ...(impact.assignmentIds.length
        ? [`  ${impact.assignmentIds.join("\n  ")}`]
        : []),
      `  ${impact.note}`,
    ],
  };
}

/** Validates, size-checks and writes the change document; nothing is sent. */
export async function writePrepared(
  ctx: WriteContext,
  session: Session,
  prepared: Prepared,
): Promise<WriteOutput> {
  if (prepared.changes.length === 0)
    throw new CliError(
      "invalid-input",
      "No change: nothing differs from the current state.",
    );
  const exact = exactCommand(prepared.command, randomUUID());
  checkCommandSize(JSON.stringify(exact));
  const { key: _key, ...command } = exact;
  const diff = boundLines(prepared.diff, 2000, 128 * 1024);
  const gaps = [
    ...prepared.gaps,
    ...(diff.truncated ? (["item-omitted"] as const) : []),
  ];
  const { path, document } = await writeChangeDocument(requireOut(ctx), {
    schema: CHANGE_SCHEMA,
    kind: prepared.kind,
    preparedAt: ctx.deps.now(),
    service: {
      installationId: session.identity.service.installationId,
      origin: session.identity.service.origin,
    },
    target: targetOf(command),
    expected: expectedOf(command),
    command,
    preview: {
      changes: prepared.changes,
      diff,
      impact: prepared.impact ?? null,
      notes: prepared.notes,
    },
  });
  const shown = boundLines(diff.lines, 200);
  return {
    data: { file: path, document },
    coverage: coverage(ctx.deps.now(), gaps, prepared.notes),
    human: [
      `Prepared ${document.kind} for ${document.target.scope} on ${session.name} (${document.service.origin}, installation ${document.service.installationId}).`,
      `Wrote ${path} (digest ${document.digest}). Nothing was sent.`,
      "",
      "Changes:",
      ...prepared.changes.map(
        (c) =>
          `  ${c.field}: ${c.from === "" ? "(empty)" : (c.from ?? (isCreation(prepared.kind) ? "(new)" : "(unavailable)"))} -> ${c.to ?? "(none)"}`,
      ),
      ...(shown.lines.length ? ["", ...shown.lines] : []),
      ...(shown.truncated || diff.truncated ? ["(diff truncated)"] : []),
      ...(prepared.impactLines ? ["", ...prepared.impactLines] : []),
      ...prepared.notes.map((n) => `Note: ${n}`),
      ...gaps.map((g) => `Gap: ${g}`),
      "",
      `Apply with: ensemble ${AREA[document.kind]} apply --file ${path}`,
    ].join("\n"),
  };
}

function effectNote(document: ChangeDocument): string[] {
  const c = document.command;
  const admits =
    c.revoked === false ||
    c.paused === false ||
    c.enabled === true ||
    c.type === "capacity.configure";
  if (c.type === "github.configure")
    return [
      "Source configuration saved; nothing was imported, dispatched or started.",
      "Every selection is now inactive until previewed again at the new version with 'ensemble project preview-source'; observations are incomplete until the next sync refresh.",
    ];
  return [
    "Configuration saved; nothing was dispatched, started, stopped or cancelled.",
    ...(c.type === "profile.configure" ||
    (c.type === "project.configure" && c.instructions !== undefined)
      ? [
          "Existing assignments keep their bound revisions and may now be stale; adopt with 'ensemble assignment apply-current'. An active turn is never rewritten.",
        ]
      : []),
    ...(admits
      ? ["The scheduler may now admit waiting work under existing rules."]
      : []),
    ...(c.type === "capacity.configure"
      ? ["Lowering a limit does not stop active turns; new starts wait."]
      : []),
    ...(isCreation(document.kind)
      ? [
          "Creation cannot be undone; revoke a profile or pause a project instead.",
        ]
      : []),
  ];
}

/** Revalidates a change document and sends exactly its command once. */
export async function applyFile(
  ctx: WriteContext,
  area: string,
): Promise<WriteOutput> {
  if (!ctx.values.file) throw new CliError("usage", "--file FILE is required.");
  const requested = optionalRequestId(ctx.values);
  const document = await readChangeDocument(ctx.values.file, area);
  if (AREA[document.kind] !== area)
    throw new CliError(
      "change-document-invalid",
      `This is a ${document.kind} change; apply it with 'ensemble ${AREA[document.kind]} apply'.`,
      {
        fix: `Run 'ensemble ${AREA[document.kind]} apply --file ${shellWord(ctx.values.file)}'.`,
      },
    );
  let exact: Record<string, unknown>;
  try {
    exact = exactCommand(document.command, randomUUID());
  } catch {
    throw new CliError(
      "change-document-invalid",
      "Change document rejected: its command is not valid.",
    );
  }
  const { key: _key, ...command } = exact;
  if (
    command.type !== document.kind ||
    canonicalJson(command) !== canonicalJson(document.command) ||
    canonicalJson(targetOf(command)) !== canonicalJson(document.target) ||
    canonicalJson(expectedOf(command)) !== canonicalJson(document.expected)
  )
    throw new CliError(
      "change-document-invalid",
      "Change document rejected: its command, target and expected revisions disagree.",
    );
  const creation = isCreation(document.kind);
  const session = await ctx.connect([
    "cli.identity",
    "configuration.write",
    ...(creation ? ["workspace.read"] : []),
    ...(document.kind === "github.configure" ? ["source.write"] : []),
  ]);
  if (
    session.identity.service.installationId !== document.service.installationId
  )
    throw new CliError(
      "wrong-service",
      `This change was prepared for installation ${document.service.installationId} (${document.service.origin}), not ${session.identity.service.installationId}. Nothing was sent.`,
    );
  const service = session.identity.service.installationId;
  const key =
    requested ??
    (await ctx.journal.find(service, document.digest)) ??
    randomUUID();
  const identity = {
    service,
    scope: document.target.scope,
    type: document.kind,
    key,
  };
  // Only an attempt that may have reached the service can make an existing ID ours.
  if (creation && !(await ctx.journal.state(identity))?.reached) {
    // A duplicate ID with a fresh key is not yet a typed service error.
    const path = `/api/operator/${AREA[document.kind]}s/${document.target.id}/configuration`;
    const exists = await session.client
      .getBytes(path)
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof CliError && error.extra.status === 404)
          return false;
        throw error;
      });
    if (exists)
      throw new CliError(
        "conflict",
        `${document.target.scope} already exists. Nothing was sent.`,
        {
          fix: `Prepare the creation again with a new ID, or change the existing one with 'ensemble ${area} prepare'.`,
        },
      );
  }
  const read =
    area === "capacity"
      ? "ensemble capacity get"
      : `ensemble ${area} get ${document.target.id}`;
  const { receipt, request } = await sendCommand(ctx, session, {
    scope: document.target.scope,
    type: document.kind,
    key,
    digest: document.digest,
    resource: document.target.id,
    command: { ...command, key },
  }).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "conflict")
      throw new CliError(
        "conflict",
        `${document.target.scope} changed since this document was prepared, or request ${key} was used with other material. Nothing was applied; review the current state and prepare again.`,
        {
          ...error.extra,
          fix: `Review ${document.target.scope} with '${read}', then run 'ensemble ${area} prepare' again.`,
        },
      );
    throw error;
  });
  return {
    request,
    data: { receipt, file: ctx.values.file, digest: document.digest },
    human: [
      `Applied ${document.kind} to ${document.target.scope} (request ${key}).`,
      keyValues(receiptLines(receipt)),
      ...effectNote(document),
    ].join("\n"),
  };
}

export const uuidOrNone = (value: string | undefined, flag: string) =>
  value === undefined
    ? undefined
    : value === "none"
      ? null
      : uuidArg(value, `--${flag}`);
