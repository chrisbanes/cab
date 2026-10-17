import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  type RecoveryPath,
  recoveryCommandTypes,
  recoveryPaths,
  recoveryRequirements,
} from "../core/recovery-contracts.js";
import {
  type CommandReceipt,
  recoveryOptionsSchema,
} from "../operator/contracts.js";
import {
  type BrowseCommand,
  browseOutput,
  type CoverageGap,
  coverage,
  enumArg,
  uuidArg,
} from "./browse.js";
import { canonicalJson } from "./change-document.js";
import { exactCommand, positiveIntFlag, requireOut } from "./configure.js";
import { CliError } from "./connections.js";
import { receiptLines } from "./operation.js";
import {
  readEvidenceFile,
  readRecoveryDocument,
  RECOVERY_SCHEMA,
  writeRecoveryDocument,
} from "./recovery-document.js";
import { isoTime, keyValues, table } from "./render.js";
import { connectWrite, type Effect, writeOutput } from "./task-write.js";
import type { ServiceClient } from "./transport.js";
import {
  requestKey,
  type Session,
  sendCommand,
  type WriteCommand,
} from "./write.js";

type Options = z.infer<typeof recoveryOptionsSchema>["data"];
type RecordView = Options["records"][number];
const READ = ["cli.identity", "assignment.read", "recovery.read"] as const;
const IRREVERSIBLE =
  "Adoption, recovery and conversation replacement cannot be undone, and none of them resumes the task or dispatches work.";
const NOTHING_INFERRED =
  "Eligibility is advisory; the service re-checks identity, termination and replay. The CLI never infers review, termination, settled effects or workspace state, and there is no force unlock.";

const readOptions = (client: ServiceClient, assignmentId: string) =>
  client.get(
    `/api/operator/assignments/${encodeURIComponent(assignmentId)}/recovery-options`,
    recoveryOptionsSchema,
  );

const holdsText = (holds: Record<string, boolean>) =>
  Object.entries(holds)
    .filter(([, held]) => held)
    .map(([name]) => name)
    .join(", ") || "none";

/** The operator inputs each path needs, from the shared command schemas. */
function requirementText(path: RecoveryPath) {
  const r = recoveryRequirements[path];
  if (path === "conversation-replace")
    return "--expected-version, --expected-conversation-revision";
  return [
    ...(r.evidence.length ? [`evidence: ${r.evidence.join(", ")}`] : []),
    ...(r.attestations.length
      ? [`attestations (each true): ${r.attestations.join(", ")}`]
      : []),
    ...(r.receipt.length ? [`receipt: ${r.receipt.join(", ")}`] : []),
  ].join("; ");
}

function recordLines(r: RecordView): string[] {
  return [
    "",
    keyValues([
      ["Work", r.workId ?? "(withheld)"],
      [
        "Generation",
        `work revision ${r.generation.workRevision ?? "none"}, request ${r.generation.requestSequence}`,
      ],
      ["State", `intent ${r.intentState}; request ${r.requestState ?? "none"}`],
      ["Holds", holdsText(r.holds)],
      [
        "Process",
        r.process
          ? `${r.process.processId} started ${r.process.processStartedAt}, boot ${r.process.bootId}`
          : "(withheld or unavailable)",
      ],
      ["Reason", r.retainedReason ?? "(withheld or unavailable)"],
      [
        "Predecessor",
        r.predecessor
          ? `${r.predecessor.workId} thread ${r.predecessor.threadId}`
          : "none",
      ],
      [
        "Witnesses",
        [
          r.witnesses.preTurn
            ? `pre-turn ${r.witnesses.preTurn.id} (${r.witnesses.preTurn.source})`
            : null,
          r.witnesses.noTurn ? `no-turn ${r.witnesses.noTurn.id}` : null,
        ]
          .filter(Boolean)
          .join(", ") || "none",
      ],
      ["Observations", r.observations.join(", ") || "none"],
      [
        "Receipt",
        r.receiptRecorded ? `recorded; workspace ${r.workspace}` : "none",
      ],
    ]),
    table(
      ["PATH", "ELIGIBLE", "BLOCKED BY", "REQUIRES"],
      r.paths.map((p) => [
        p.path,
        p.eligible ? "yes" : "no",
        p.blockedBy.join(", ") || "-",
        requirementText(p.path),
      ]),
    ),
  ];
}

function optionGaps(d: Options): CoverageGap[] {
  return [
    ...d.gaps,
    ...(d.omittedCount > 0 ? (["item-omitted"] as const) : []),
    ...(d.evidenceAvailable ? [] : (["evidence-unavailable"] as const)),
  ];
}

const recoveryGet: BrowseCommand = {
  usage: "recovery get ASSIGNMENT_ID",
  positionals: 1,
  capabilities: READ,
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
    const read = await readOptions(await ctx.connect(), id);
    const d = read.data;
    const requirements = Object.fromEntries(
      recoveryPaths.map((p) => [p, recoveryRequirements[p]]),
    );
    return browseOutput(ctx, {
      data: { ...d, requirements },
      observedAt: read.observedAt,
      gaps: optionGaps(d),
      notes: [NOTHING_INFERRED],
      human: [
        keyValues([
          ["Assignment", d.assignmentId],
          ["Task", d.taskId],
          ["Project", d.projectId],
          ["Version", String(d.assignmentVersion)],
          ["Conversation", `revision ${d.conversationRevision}`],
          ["Held", d.held ? `yes: ${holdsText(d.holds)}` : "no"],
          [
            "Replacement",
            d.replacement.eligible
              ? `eligible at version ${d.replacement.expectedAssignmentVersion}, conversation revision ${d.replacement.expectedConversationRevision}`
              : `blocked by ${d.replacement.blockedBy.join(", ")}`,
          ],
        ]),
        ...(d.records.length
          ? d.records.flatMap(recordLines)
          : ["", "No recovery generations are recorded for this assignment."]),
        ...(d.omittedCount ? [`(${d.omittedCount} older omitted)`] : []),
        "",
        IRREVERSIBLE,
        "Prepare with: ensemble recovery prepare PATH ASSIGNMENT_ID --work WORK_ID --evidence-file FILE --out FILE",
      ].join("\n"),
    });
  },
};

export const recoveryBrowseCommands = new Map<string, BrowseCommand>([
  ["recovery get", recoveryGet],
]);

type GenerationPath = Exclude<RecoveryPath, "conversation-replace">;

/** The exact command for one generation path: observed identity plus the operator's evidence. */
function buildCommand(
  path: GenerationPath,
  assignmentId: string,
  record: RecordView,
  evidence: Record<string, unknown>,
) {
  const type = recoveryCommandTypes[path];
  const generation = {
    workId: record.workId,
    workRevision: record.generation.workRevision,
    requestSequence: record.generation.requestSequence,
    processIdentity: record.process,
  };
  if (path === "pre-turn-adopt")
    return {
      type,
      assignmentId,
      ...generation,
      predecessorWorkId: record.predecessor?.workId,
      predecessorThreadId: record.predecessor?.threadId,
      retainedReason: record.retainedReason,
      ...evidence,
    };
  if (path === "no-turn-adopt")
    return {
      type,
      assignmentId,
      kind: "historical-no-turn-submission",
      ...generation,
      conversationRevision: record.conversationRevision,
      writerSequence: record.writerSequence,
      retainedReason: record.retainedReason,
      ...evidence,
    };
  return {
    type,
    assignmentId,
    receipt: {
      kind:
        path === "pre-turn-recover"
          ? "pre-turn-rejection"
          : "no-turn-submission",
      witnessId:
        path === "pre-turn-recover"
          ? record.witnesses.preTurn?.id
          : record.witnesses.noTurn?.id,
      ...generation,
      threadId: null,
      turnId: null,
      ...(evidence.receipt as Record<string, unknown>),
    },
  };
}

function assertionLines(path: RecoveryPath, command: Record<string, unknown>) {
  const c = command as Record<string, Record<string, unknown>>;
  if (path === "conversation-replace")
    return [
      `Replaces the conversation of ${c.assignmentId} at assignment version ${c.expectedAssignmentVersion}, conversation revision ${c.expectedConversationRevision}.`,
    ];
  if (path.endsWith("adopt"))
    return [
      `Records an operator-adopted witness for ${c.workId} (process ${JSON.stringify(c.processIdentity)}).`,
      `You assert: ${Object.keys(c.attestation ?? {}).join(", ")}.`,
      `Evidence: ${JSON.stringify(c.evidence)}`,
    ];
  const r = c.receipt ?? {};
  return [
    `Reconciles ${r.workId} after verified termination of process ${JSON.stringify(r.processIdentity)}; capacity is released, the request stays held.`,
    `You assert: termination ${JSON.stringify(r.termination)}, effects ${String(r.effects)}, workspace ${String(r.workspace)}.`,
  ];
}

async function prepare(ctx: Parameters<WriteCommand["run"]>[0]) {
  const path = enumArg(
    ctx.positionals[2],
    recoveryPaths,
    "PATH",
  ) as RecoveryPath;
  const assignmentId = uuidArg(ctx.positionals[3] ?? "", "ASSIGNMENT_ID");
  const out = requireOut(ctx);
  let evidence: Record<string, unknown> = {};
  let expected: { version: number; revision: number } | undefined;
  if (path === "conversation-replace") {
    if (
      ctx.values.work !== undefined ||
      ctx.values["evidence-file"] !== undefined
    )
      throw new CliError(
        "usage",
        "conversation-replace takes no --work or --evidence-file.",
      );
    const version = positiveIntFlag(
      ctx.values["expected-version"],
      "expected-version",
    );
    const revision = positiveIntFlag(
      ctx.values["expected-conversation-revision"],
      "expected-conversation-revision",
    );
    if (version === undefined || revision === undefined)
      throw new CliError(
        "usage",
        "--expected-version N and --expected-conversation-revision N are required.",
      );
    expected = { version, revision };
  } else {
    if (ctx.values.work === undefined)
      throw new CliError("usage", "--work WORK_ID is required.");
    if (ctx.values["evidence-file"] === undefined)
      throw new CliError("usage", "--evidence-file FILE is required.");
    if (
      ctx.values["expected-version"] !== undefined ||
      ctx.values["expected-conversation-revision"] !== undefined
    )
      throw new CliError(
        "usage",
        "--expected-version and --expected-conversation-revision apply to conversation-replace only.",
      );
    evidence = await readEvidenceFile(
      ctx.values["evidence-file"],
      path as GenerationPath,
    );
  }
  const session = await ctx.connect(READ);
  const read = await readOptions(session.client, assignmentId);
  const d = read.data;
  let record: RecordView | undefined;
  let blockedBy: string[];
  if (path === "conversation-replace") {
    blockedBy = d.replacement.blockedBy;
    if (
      expected &&
      (expected.version !== d.assignmentVersion ||
        expected.revision !== d.conversationRevision)
    )
      throw new CliError(
        "conflict",
        `The assignment is at version ${d.assignmentVersion}, conversation revision ${d.conversationRevision}. Review 'ensemble recovery get ${assignmentId}' and prepare again. Nothing was written.`,
        {
          fix: `Run 'ensemble recovery get ${assignmentId}', then prepare again with the version and conversation revision it shows.`,
        },
      );
  } else {
    record = d.records.find((r) => r.workId === ctx.values.work);
    if (!record)
      throw new CliError(
        "invalid-input",
        `Work ${ctx.values.work} is not a listed recovery generation of ${assignmentId}. Nothing was written.`,
      );
    blockedBy = record.paths.find((p) => p.path === path)?.blockedBy ?? [
      "context-unavailable",
    ];
  }
  if (blockedBy.length)
    throw new CliError(
      "conflict",
      `${path} is not eligible now: blocked by ${blockedBy.join(", ")}. Nothing was written.`,
      {
        fix: `Run 'ensemble recovery get ${assignmentId}' to see what blocks it, then prepare again once it is clear.`,
      },
    );
  const exact = exactCommand(
    record
      ? buildCommand(path as GenerationPath, assignmentId, record, evidence)
      : {
          type: recoveryCommandTypes[path],
          assignmentId,
          expectedAssignmentVersion: d.assignmentVersion,
          expectedConversationRevision: d.conversationRevision,
        },
    randomUUID(),
  );
  const { key: _key, ...command } = exact;
  const preview = [...assertionLines(path, command), IRREVERSIBLE];
  const { path: file, document } = await writeRecoveryDocument(out, {
    schema: RECOVERY_SCHEMA,
    path,
    preparedAt: ctx.deps.now(),
    service: {
      installationId: session.identity.service.installationId,
      origin: session.identity.service.origin,
    },
    target: {
      scope: `assignment:${assignmentId}`,
      assignmentId,
      taskId: d.taskId,
      projectId: d.projectId,
      workId: record?.workId ?? null,
    },
    bound: {
      assignmentVersion: d.assignmentVersion,
      conversationRevision: d.conversationRevision,
      workRevision: record?.generation.workRevision ?? null,
      requestSequence: record?.generation.requestSequence ?? null,
      observedAt: read.observedAt,
    },
    command,
    preview: { lines: preview },
  });
  return {
    data: { file, document },
    coverage: coverage(ctx.deps.now(), optionGaps(d)),
    human: [
      `Prepared ${path} for assignment ${assignmentId} on ${session.name} (${document.service.origin}, installation ${document.service.installationId}).`,
      `Wrote ${file} (digest ${document.digest}). Nothing was sent.`,
      `Bound to observations at ${isoTime(read.observedAt)}; the service rechecks every value.`,
      "",
      ...preview,
      "",
      `Submit with: ensemble recovery submit --file ${file}`,
    ].join("\n"),
  };
}

/** What remains after each path; replacement is done once, then only a new message is needed. */
const NEXT_STEP: Record<RecoveryPath, string> = {
  "pre-turn-adopt":
    "Not resumed; nothing was dispatched. Next: recover the generation with 'ensemble recovery prepare pre-turn-recover'.",
  "no-turn-adopt":
    "Not resumed; nothing was dispatched. Next: recover the generation with 'ensemble recovery prepare no-turn-recover'.",
  "pre-turn-recover":
    "Not resumed; nothing was dispatched. Continuation needs conversation replacement ('ensemble recovery prepare conversation-replace') and then a new 'ensemble task message'.",
  "no-turn-recover":
    "Not resumed; nothing was dispatched. Continuation needs conversation replacement ('ensemble recovery prepare conversation-replace') and then a new 'ensemble task message'.",
  "conversation-replace":
    "Not resumed; nothing was dispatched. The conversation is replaced; do not replace it again. Continue with a new 'ensemble task message'.",
};

const EFFECT: Record<RecoveryPath, Effect> = {
  "pre-turn-adopt": "saved",
  "no-turn-adopt": "saved",
  "pre-turn-recover": "completed",
  "no-turn-recover": "completed",
  "conversation-replace": "saved",
};

function matches(
  receipt: CommandReceipt,
  path: RecoveryPath,
  assignmentId: string,
  workId: string | null,
) {
  if (receipt.kind === "conversation-replacement")
    return (
      path === "conversation-replace" && receipt.assignmentId === assignmentId
    );
  return (
    (receipt.kind === "recovery-adoption" ||
      receipt.kind === "recovery-resolution") &&
    receipt.path === path &&
    receipt.assignmentId === assignmentId &&
    receipt.workId === workId
  );
}

/** A best-effort post-read: blockers and the latest observations, never hiding the result. */
async function afterLines(
  session: Session,
  assignmentId: string,
  workId: string | null,
) {
  try {
    const d = (await readOptions(session.client, assignmentId)).data;
    const r = d.records.find((x) => x.workId === workId);
    return [
      `Held: ${d.held ? holdsText(d.holds) : "no"}`,
      ...(r
        ? [
            `Observations: ${r.observations.join(", ") || "none"}`,
            ...r.paths
              .filter((p) => p.blockedBy.length)
              .map((p) => `${p.path}: blocked by ${p.blockedBy.join(", ")}`),
          ]
        : []),
      `conversation-replace: ${d.replacement.eligible ? "eligible" : `blocked by ${d.replacement.blockedBy.join(", ")}`}`,
    ];
  } catch {
    return ["Current recovery state could not be read."];
  }
}

async function submit(ctx: Parameters<WriteCommand["run"]>[0]) {
  if (!ctx.values.file) throw new CliError("usage", "--file FILE is required.");
  const document = await readRecoveryDocument(ctx.values.file);
  const invalidDocument = () =>
    new CliError(
      "change-document-invalid",
      "Recovery document rejected: its command, path and target disagree.",
    );
  let exact: Record<string, unknown>;
  try {
    exact = exactCommand(document.command, randomUUID());
  } catch {
    throw invalidDocument();
  }
  const { key: _key, ...command } = exact;
  const receiptWork = (command.receipt as { workId?: unknown } | undefined)
    ?.workId;
  if (
    command.type !== recoveryCommandTypes[document.path] ||
    canonicalJson(command) !== canonicalJson(document.command) ||
    command.assignmentId !== document.target.assignmentId ||
    document.target.scope !== `assignment:${document.target.assignmentId}` ||
    (command.workId ?? receiptWork ?? null) !== document.target.workId
  )
    throw invalidDocument();
  const session = await connectWrite(ctx, [...READ, "recovery.write"]);
  if (
    session.identity.service.installationId !== document.service.installationId
  )
    throw new CliError(
      "wrong-service",
      `This recovery was prepared for installation ${document.service.installationId} (${document.service.origin}), not ${session.identity.service.installationId}. Nothing was sent.`,
    );
  const identity = {
    scope: document.target.scope,
    type: String(command.type),
  };
  const { key, digest, state, reached } = await requestKey(
    ctx,
    session,
    identity,
    [document.digest],
  );
  const { assignmentId, workId } = document.target;
  let sent: Awaited<ReturnType<typeof sendCommand>>;
  try {
    sent = await sendCommand(ctx, session, {
      ...identity,
      key,
      digest,
      resource: assignmentId,
      command: { ...command, key },
      match: (r) => matches(r, document.path, assignmentId, workId),
    });
  } catch (error) {
    if (error instanceof CliError && error.code === "conflict")
      throw new CliError(
        "conflict",
        [
          `The service refused ${document.path}; nothing was applied and request ${key} will not be reused.`,
          "Missing, expired or stale evidence is not a successful recovery; the task is not resumed.",
          ...(await afterLines(session, assignmentId, workId)),
        ].join("\n"),
        {
          ...error.extra,
          fix: `Run 'ensemble recovery get ${assignmentId}', then prepare a new document with 'ensemble recovery prepare'.`,
        },
      );
    throw error;
  }
  return writeOutput({
    request: sent.request,
    receipt: sent.receipt,
    reused: reached && state?.state !== "recorded",
    effect: EFFECT[document.path],
    summary: `Submitted ${document.path} for assignment ${assignmentId}`,
    lines: receiptLines(sent.receipt),
    notes: [
      NEXT_STEP[document.path],
      ...(await afterLines(session, assignmentId, workId)),
      IRREVERSIBLE,
    ],
    data: { file: ctx.values.file, digest: document.digest },
  });
}

export const recoveryWriteCommands = new Map<string, WriteCommand>([
  [
    "recovery prepare",
    {
      usage:
        "recovery prepare PATH ASSIGNMENT_ID --out FILE (--work WORK_ID --evidence-file FILE | --expected-version N --expected-conversation-revision N)",
      positionals: 2,
      flags: [
        "out",
        "work",
        "evidence-file",
        "expected-version",
        "expected-conversation-revision",
      ],
      run: prepare,
    },
  ],
  [
    "recovery submit",
    {
      usage: "recovery submit --file FILE [--request-id UUID]",
      positionals: 0,
      flags: ["file", "request-id"],
      run: submit,
    },
  ],
]);
