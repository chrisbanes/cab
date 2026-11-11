import { requestRefusalText } from "../operator/task-restart-copy.js";
import type { z } from "zod";
import { recoveryCommandTypes } from "../core/recovery-contracts.js";
import { recoveryOptionsSchema } from "../operator/contracts.js";
import {
  type BrowseCommand,
  browseOutput,
  type CoverageGap,
  coverage,
  uuidArg,
} from "./browse.js";
import { exactCommand } from "./configure.js";
import { CliError } from "./connections.js";
import { receiptLines } from "./operation.js";
import { isoTime, keyValues, table } from "./render.js";
import {
  connectWrite,
  readTask,
  sendStartAgain,
  TASK_WRITE,
  writeOutput,
} from "./task-write.js";
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
  "Release cannot be undone and does not resume the task; Start again continues it.";
const NOTHING_INFERRED =
  "Eligibility is advisory; the service re-checks identity and replay. The service interrupts a held turn and releases it when the runtime reports its end, its process is verified to have exited, or 30 minutes pass with no event for it. There is no force unlock.";

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
      ["Thread", r.threadId ?? "(unavailable)"],
      ["Turn", r.turnId ?? "(unavailable)"],
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
      ["PATH", "ELIGIBLE", "BLOCKED BY"],
      r.paths.map((p) => [
        p.path,
        p.eligible ? "yes" : "no",
        p.blockedBy.join(", ") || "-",
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
    return browseOutput(ctx, {
      data: d,
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
          ["Start again", restartText(d.restart)],
        ]),
        ...(d.requestRefusal
          ? [
              "",
              requestRefusalText(d.requestRefusal),
              `Task: cab task get ${d.taskId}`,
            ]
          : []),
        ...(d.records.length
          ? d.records.flatMap(recordLines)
          : ["", "No recovery generations are recorded for this assignment."]),
        ...(d.omittedCount ? [`(${d.omittedCount} older omitted)`] : []),
        "",
        IRREVERSIBLE,
        `Start again with: cab recovery restart ${d.assignmentId} --yes`,
        `Release a generation that never sent a turn with: cab recovery release ${d.assignmentId} [--work WORK_ID] --yes`,
      ].join("\n"),
    });
  },
};

export const recoveryBrowseCommands = new Map<string, BrowseCommand>([
  ["recovery get", recoveryGet],
]);

const RELEASED =
  "Not resumed; nothing was dispatched. Writer and capacity are released; continue with 'cab recovery restart' or 'cab task start-again'.";

/** Whether Start again is offered, a held turn is still being released, or what blocks it. */
function restartText(r: Options["restart"]) {
  if (r.eligible) return "eligible";
  if (r.releasePending)
    return `pending: the service interrupted the held turn (${r.releasePending.interruptState}) and expects to release it by ${isoTime(r.releasePending.releasesBy)} unless activity continues`;
  return `blocked by ${r.blockedBy.join(", ")}`;
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
      `Start again: ${restartText(d.restart)}`,
    ];
  } catch {
    return ["Current recovery state could not be read."];
  }
}

/**
 * Reads the held generation's release eligibility and, with --yes, releases it bound to
 * that read. The service reruns every check and refuses when anything changed.
 */
async function release(ctx: Parameters<WriteCommand["run"]>[0]) {
  const assignmentId = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
  const readSession = ctx.values.yes
    ? await connectWrite(ctx, [...READ, "recovery.write"])
    : await ctx.connect(READ);
  const read = await readOptions(readSession.client, assignmentId);
  const d = read.data;
  const held = d.records.filter(
    (r) => r.workId !== null && r.intentState === "held",
  );
  const record =
    ctx.values.work === undefined
      ? held.length === 1
        ? held[0]
        : undefined
      : d.records.find((r) => r.workId === ctx.values.work);
  if (!record?.workId)
    throw new CliError(
      ctx.values.work === undefined ? "usage" : "invalid-input",
      ctx.values.work === undefined
        ? `${assignmentId} has ${held.length} held generations; name one with --work WORK_ID (see 'cab recovery get ${assignmentId}'). Nothing was written.`
        : `Work ${ctx.values.work} is not a listed recovery generation of ${assignmentId}. Nothing was written.`,
    );
  const blockedBy = record.paths.find((p) => p.path === "release")
    ?.blockedBy ?? ["context-unavailable"];
  const workRevision = record.generation.workRevision;
  const target = `generation ${record.workId} (work revision ${workRevision ?? "none"}, request ${record.generation.requestSequence})`;
  const explanation = [
    `Release refuses ${target} as never having sent a turn: no thread or turn was saved for it, and the thread is saved before a turn starts.`,
    "It frees the writer and capacity holds; the task then offers Start again. An unseen idle thread may exist.",
    `Held reason (evidence only): ${record.retainedReason ?? "(withheld or unavailable)"}`,
  ];
  // A generation without a work revision can't be bound; the read names the blocker.
  if (ctx.values.yes && workRevision === null)
    throw new CliError(
      "conflict",
      `release is not eligible now: blocked by ${blockedBy.join(", ") || "context-unavailable"}. Nothing was written.`,
      { fix: `Run 'cab recovery get ${assignmentId}' to see what blocks it.` },
    );
  // Otherwise --yes lets the service decide, so a recorded key still replays after the release.
  if (!ctx.values.yes || workRevision === null)
    return {
      data: {
        assignmentId,
        workId: record.workId,
        eligible: !blockedBy.length,
        blockedBy,
        observedAt: read.observedAt,
      },
      coverage: coverage(ctx.deps.now(), optionGaps(d)),
      human: [
        ...explanation,
        "",
        blockedBy.length
          ? `Not eligible: blocked by ${blockedBy.join(", ")}.`
          : `Eligible. Release with: cab recovery release ${assignmentId} --work ${record.workId} --yes`,
        "Nothing was written.",
        NOTHING_INFERRED,
      ].join("\n"),
    };
  const session = readSession as Session;
  const command = {
    type: recoveryCommandTypes.release,
    assignmentId,
    workId: record.workId,
    workRevision,
    requestSequence: record.generation.requestSequence,
  };
  const identity = { scope: `assignment:${assignmentId}`, type: command.type };
  const { key, digest, state, reached } = await requestKey(
    ctx,
    session,
    identity,
    [command],
  );
  const workId = record.workId;
  let sent: Awaited<ReturnType<typeof sendCommand>>;
  try {
    sent = await sendCommand(ctx, session, {
      ...identity,
      key,
      digest,
      resource: assignmentId,
      command: exactCommand(command, key),
      match: (r) =>
        r.kind === "recovery-release" &&
        r.assignmentId === assignmentId &&
        r.workId === workId,
    });
  } catch (error) {
    if (error instanceof CliError && error.code === "conflict")
      throw new CliError(
        "conflict",
        [
          `The service refused release; nothing was applied and request ${key} will not be reused.`,
          ...(await afterLines(session, assignmentId, workId)),
        ].join("\n"),
        {
          ...error.extra,
          fix: `Run 'cab recovery get ${assignmentId}', then release again once it is eligible.`,
        },
      );
    throw error;
  }
  return writeOutput({
    request: sent.request,
    receipt: sent.receipt,
    reused: reached && state?.state !== "recorded",
    effect: "completed",
    summary: `Released ${target} of assignment ${assignmentId}`,
    lines: receiptLines(sent.receipt),
    notes: [
      ...explanation,
      RELEASED,
      ...(await afterLines(session, assignmentId, workId)),
      IRREVERSIBLE,
    ],
    data: { workId },
  });
}

/**
 * Start again for the assignment, after one confirmation: the same `task.start-again` the
 * task page and `cab task start-again` send. Without --yes it previews and sends nothing.
 */
async function restart(ctx: Parameters<WriteCommand["run"]>[0]) {
  const assignmentId = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
  const session = ctx.values.yes
    ? await connectWrite(ctx, [...READ, ...TASK_WRITE])
    : await ctx.connect([...READ, "task.read"]);
  const d = (await readOptions(session.client, assignmentId)).data;
  const task = (await readTask(session, d.taskId)).data;
  // A named work lets the service decide, so a retry with its --request-id replays.
  const workId =
    ctx.values.work ??
    (d.restart.eligible && task.startAgain?.available
      ? task.startAgain.workId
      : undefined);
  if (!workId)
    throw new CliError(
      "conflict",
      `Start again is not available for ${assignmentId}: ${restartText(d.restart)}. Nothing was sent.`,
      {
        fix: d.restart.releasePending
          ? `Wait for the release, then run 'cab recovery restart ${assignmentId} --yes' again.`
          : `Run 'cab recovery get ${assignmentId}' and 'cab task get ${d.taskId}' to see what holds it.`,
      },
    );
  if (!ctx.values.yes)
    return {
      data: { assignmentId, taskId: d.taskId, workId },
      coverage: coverage(ctx.deps.now(), optionGaps(d)),
      human: [
        `Start again queues ${workId} of task ${d.taskId} afresh at the current revisions and continues the assignment's conversation.`,
        `Confirm with: cab recovery restart ${assignmentId} --yes`,
        "Nothing was sent.",
      ].join("\n"),
    };
  return sendStartAgain(
    ctx,
    session as Session,
    d.taskId,
    Number(task.task.version),
    workId,
  );
}

export const recoveryWriteCommands = new Map<string, WriteCommand>([
  [
    "recovery release",
    {
      usage:
        "recovery release ASSIGNMENT_ID [--work WORK_ID] [--yes] [--request-id UUID]",
      positionals: 1,
      flags: ["work", "yes", "request-id"],
      run: release,
    },
  ],
  [
    "recovery restart",
    {
      usage:
        "recovery restart ASSIGNMENT_ID [--yes] [--work WORK_ID] [--request-id UUID]",
      positionals: 1,
      flags: ["yes", "work", "request-id"],
      run: restart,
    },
  ],
]);
