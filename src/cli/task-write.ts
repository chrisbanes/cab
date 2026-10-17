import {
  type CommandReceipt,
  type TaskRead,
  taskSchema,
} from "../operator/contracts.js";
import { cliFix, type Wait, waitLabels } from "../operator/wait-reasons.js";
import { uuidArg } from "./browse.js";
import {
  boolFlag,
  exactCommand,
  inlineText,
  positiveIntFlag,
  readTextFile,
} from "./configure.js";
import { CliError } from "./connections.js";
import { fixLine, nextLine } from "./remedy.js";
import { keyValues } from "./render.js";
import type { RequestIdentity } from "./types.js";
import {
  chooseKey,
  derivedUuid,
  type Session,
  sendCommand,
  type WriteCommand,
  type WriteContext,
  type WriteOutput,
  withConflictRemedy,
} from "./write.js";

export const TASK_WRITE = ["cli.identity", "task.read", "task.write"] as const;
/** What a write did: saved a record, queued work or a message, requested cancellation, completed a synchronous operation, or nothing. */
export type Effect =
  | "saved"
  | "queued"
  | "cancellation-requested"
  | "none"
  | "completed";
type TaskData = TaskRead["data"];

/** Connects for a write; a read-only credential is refused before any pre-read. */
export async function connectWrite(
  ctx: WriteContext,
  capabilities: readonly string[],
) {
  const session = await ctx.connect(capabilities);
  if (session.identity.credential.scope !== "read-write")
    throw new CliError(
      "insufficient-scope",
      "This connection's credential is read-only.",
    );
  return session;
}

export const readTask = (session: Session, taskId: string) =>
  session.client.get(`/api/operator/tasks/${taskId}`, taskSchema);
/** A best-effort read after a recorded write; a failed read never hides the receipt. */
export const readAfter = (session: Session, taskId: string) =>
  readTask(session, taskId).then(
    (r) => r.data,
    () => undefined,
  );

export function requiredVersion(ctx: WriteContext) {
  const version = positiveIntFlag(
    ctx.values["expected-version"],
    "expected-version",
  );
  if (version === undefined)
    throw new CliError("usage", "--expected-version N is required.");
  return version;
}

/** ` (closed on GitHub…)` for a task closed on its provider, shared by every task view. */
export function closureSuffix(
  closure: "held" | "completed" | "unattributed" | null | undefined,
) {
  return closure === "held"
    ? " (closed on GitHub; held)"
    : closure === "completed"
      ? " (closed on GitHub)"
      : closure === "unattributed"
        ? " (closed on GitHub; closure not attributed to Ensemble; held)"
        : "";
}

/** Task state, admission and the holds that still decide whether work runs. */
export function taskStatusLines(task: TaskData): [string, string][] {
  const holds = Object.entries(task.execution.holds)
    .filter(([, held]) => held)
    .map(([name]) => name);
  return [
    ["Task", task.task.id],
    [
      "State",
      `${task.task.state}${closureSuffix(task.source?.closure)}${task.task.ready ? " (ready)" : " (not ready)"}, version ${task.task.version}`,
    ],
    [
      "Waiting",
      task.waits.length
        ? task.waits
            .map((w) => waitLabels[w.code] + (w.detail ? ` (${w.detail})` : ""))
            .join(", ")
        : "none",
    ],
    ["Execution", task.execution.state],
    ["Holds", holds.length ? holds.join(", ") : "none"],
  ];
}

/** One `Waiting:` line per wait in the flow's order, then its detail, its Fix command or path, or what blocks it. */
export function waitLines(waits: readonly Wait[], taskId: string): string[] {
  return waits.flatMap((w) => [
    `Waiting: ${waitLabels[w.code]}`,
    ...(w.detail ? [`  ${w.detail}`] : []),
    ...(w.fix ? cliFix(w.fix).map((line) => `  ${fixLine(line)}`) : []),
    ...w.links.map((link) =>
      link.kind === "task"
        ? `  Blocked by task ${link.id} (${link.label})`
        : link.kind === "request"
          ? `  Review: ensemble approval get ${taskId} ${link.id}`
          : link.kind === "source"
            ? `  ${link.label}: ${link.url}`
            : link.kind === "recovery"
              ? `  Recovery: ensemble recovery get ${link.assignmentId}`
              : `  ${link.label}`,
    ),
  ]);
}

/**
 * What a write prints last about the task it touched: the task's own wait lines (as in
 * `task get`), else the command to run next. `suggestReady` names the configure command
 * for a task that is not ready yet. A failed post-read still names `task get`.
 */
export function followLines(
  after: TaskData | undefined,
  taskId: string,
  suggestReady = false,
): string[] {
  if (after?.waits.length) return waitLines(after.waits, taskId);
  if (after && suggestReady && !after.task.ready)
    return [
      nextLine(
        `ensemble task configure ${taskId} --expected-version ${after.task.version} --ready true`,
      ),
    ];
  return [nextLine(`ensemble task get ${taskId}`)];
}

/** `queued` only when the task is ready and admissible now; holds still decide. */
const admissionEffect = (task: TaskData | undefined): Effect =>
  task?.task.state === "open" && task.task.ready && task.admission.eligible
    ? "queued"
    : "saved";

export function writeOutput(o: {
  request: RequestIdentity;
  receipt: CommandReceipt;
  reused: boolean;
  effect: Effect;
  summary: string;
  lines?: [string, string][];
  notes?: string[];
  data?: Record<string, unknown>;
}): WriteOutput {
  return {
    request: o.request,
    data: {
      receipt: o.receipt,
      effect: o.effect,
      reusedRequest: o.reused,
      ...o.data,
    },
    human: [
      ...(o.reused ? [`Reused unresolved request ${o.request.key}.`] : []),
      `${o.summary} (request ${o.request.key}).`,
      keyValues([["Effect", o.effect], ...(o.lines ?? [])]),
      ...(o.notes ?? []),
    ].join("\n"),
  };
}

/** What `withConflictRemedy` needs for a task's `--expected-version`. */
export const taskVersion = (
  session: Session,
  taskId: string,
  sent: number | undefined,
) => ({
  subject: `Task ${taskId}`,
  sent,
  read: `ensemble task get ${taskId}`,
  current: () =>
    readAfter(session, taskId).then((t) => t && { version: t.task.version }),
});

const isTask = (receipt: CommandReceipt, taskId: string) =>
  receipt.kind === "domain" &&
  "state" in receipt.result &&
  receipt.result.id === taskId;

/** One domain task command: pre-read for the project, send, best-effort post-read. */
async function domainTaskWrite(
  ctx: WriteContext,
  taskId: string,
  type: string,
  fields: Record<string, unknown>,
  summary: string,
  notes: string[],
) {
  const session = await connectWrite(ctx, TASK_WRITE);
  const read = (await readTask(session, taskId)).data.task;
  const { projectId } = read;
  // An omitted --expected-version is the version this read saw.
  const filled = fields.expectedVersion === undefined;
  if (filled) fields = { ...fields, expectedVersion: read.version };
  const scope = `project:${projectId}`;
  const { key, digest, reused } = await chooseKey(
    ctx,
    session,
    { scope, type },
    { taskId, ...fields },
  );
  const { receipt, request } = await withConflictRemedy(
    () =>
      sendCommand(ctx, session, {
        scope,
        type,
        key,
        digest,
        resource: taskId,
        command: exactCommand({ type, projectId, taskId, ...fields }, key),
        match: (r) => isTask(r, taskId),
      }),
    taskVersion(session, taskId, fields.expectedVersion as number),
  ).catch((error: unknown) => {
    // The settling retry must carry the version this attempt sent, or its digest differs.
    if (
      filled &&
      error instanceof CliError &&
      error.code === "command-outcome-unknown" &&
      error.extra.request
    ) {
      const flags = `--request-id ${key} --expected-version ${read.version}`;
      throw new CliError(
        error.code,
        error.message.replace(`--request-id ${key}`, flags),
        {
          ...error.extra,
          fix: `Do not assume either outcome: repeat the same command with ${flags} to settle it.`,
        },
      );
    }
    throw error;
  });
  const after = await readAfter(session, taskId);
  return writeOutput({
    request,
    receipt,
    reused,
    effect: fields.ready === true ? admissionEffect(after) : "saved",
    summary,
    lines: after ? taskStatusLines(after) : [],
    notes,
    data: after ? { admission: after.admission } : {},
  });
}

async function messageText(ctx: WriteContext) {
  const text = await readTextFile(ctx.values["message-file"], "message-file");
  if (text === undefined)
    throw new CliError("usage", "--message-file FILE is required.");
  if (!text.trim() || text.trim().length > 16000)
    throw new CliError(
      "invalid-input",
      "The message must be 1 to 16000 characters.",
    );
  return text;
}

/** The service's only operator-message denial without a reference: the recipient is not in the task. */
const notAnAssignment = (
  taskId: string,
  recipient: string,
  extra: CliError["extra"] = {},
) =>
  new CliError(
    "policy-denied",
    `Assignment ${recipient} is not an assignment of task ${taskId}.`,
    {
      ...extra,
      fix: `Run 'ensemble task get ${taskId} --output json' and use an assignment ID from its assignments list.`,
    },
  );

async function sendMessage(
  ctx: WriteContext,
  session: Session,
  task: TaskData,
  recipient: string,
  expected: number,
  message: string,
  followUp: boolean,
  /** Pre-read refusal; skipped when the key may name an earlier attempt. */
  gate: () => void,
) {
  const taskId = task.task.id;
  const scope = `task:${taskId}`;
  const command = {
    type: "message",
    taskId,
    recipientAssignmentId: recipient,
    expectedAssignmentVersion: expected,
    message,
  };
  const { key, digest, reused } = await chooseKey(
    ctx,
    session,
    { scope, type: "message" },
    command,
  );
  if (!reused) gate();
  const { receipt, request } = await withConflictRemedy(
    () =>
      sendCommand(ctx, session, {
        scope,
        type: "message",
        key,
        digest,
        resource: taskId,
        command: exactCommand(command, key),
        match: (r) =>
          r.kind === "coordination" &&
          r.taskId === taskId &&
          r.recipientAssignmentId === recipient,
      }),
    {
      subject: `Assignment ${recipient}`,
      sent: expected,
      read: `ensemble assignment get ${recipient}`,
      current: () =>
        readAfter(session, taskId).then((t) => {
          const a = t?.assignments.find((x) => x.assignmentId === recipient);
          return a && { version: a.version, state: a.state };
        }),
    },
  ).catch((error: unknown) => {
    if (error instanceof CliError && error.code === "policy-denied")
      throw notAnAssignment(taskId, recipient, error.extra);
    throw error;
  });
  const name =
    task.assignments.find((a) => a.assignmentId === recipient)?.name ??
    "(unavailable)";
  const resumed = receipt.kind === "coordination" && receipt.resumedLead;
  return writeOutput({
    request,
    receipt,
    reused,
    effect: "queued",
    summary: followUp ? "Sent the follow-up" : "Sent the message",
    lines: [
      ["Recipient", `${name} (${recipient})`],
      ["Task", taskId],
    ],
    notes: [
      resumed
        ? "The completed project lead resumes, subject to admission, pause, Stop, dependency and capacity holds."
        : "Queued for the recipient's next eligible turn; no work is admitted by this message.",
      "A message cannot be retracted.",
    ],
    data: { recipientAssignmentId: recipient, resumedLead: Boolean(resumed) },
  });
}

export const taskWriteCommands = new Map<string, WriteCommand>([
  [
    "task create",
    {
      usage:
        "task create --project ID --title T (--outcome TEXT|- | --outcome-file FILE) [--ready true|false] [--blocker ID]... [--assignee PROFILE_ID] [--request-id UUID]",
      positionals: 0,
      flags: [
        "project",
        "title",
        "outcome",
        "outcome-file",
        "ready",
        "blocker",
        "assignee",
        "request-id",
      ],
      async run(ctx) {
        const v = ctx.values;
        const projectId = uuidArg(v.project ?? "", "--project");
        const ready = boolFlag(v.ready, "ready") ?? true;
        if (v.title === undefined)
          throw new CliError("usage", "--title T is required.");
        const blockers = (v.blocker ?? []).map((b) => uuidArg(b, "--blocker"));
        const profileId =
          v.assignee === undefined
            ? undefined
            : uuidArg(v.assignee, "--assignee");
        // Last, so every other usage error comes before a read of standard input.
        const outcome = await inlineText(ctx, "outcome");
        if (outcome === undefined)
          throw new CliError(
            "usage",
            "--outcome TEXT (or - for standard input) or --outcome-file FILE is required.",
          );
        if (!outcome.trim())
          throw new CliError("invalid-input", "The outcome must not be blank.");
        const content = {
          type: "task.create",
          projectId,
          title: v.title,
          outcome,
          ready,
          ...(blockers.length ? { blockerTaskIds: blockers } : {}),
        };
        const build = (key: string, ids: (purpose: string) => string) =>
          exactCommand(
            {
              ...content,
              taskId: ids("task"),
              ...(profileId
                ? {
                    initialAssignment: {
                      assignmentId: ids("assignment"),
                      profileId,
                    },
                  }
                : {}),
            },
            key,
          );
        // Validate before connecting, so invalid input sends nothing.
        const placeholder = "00000000-0000-4000-8000-000000000000";
        build(placeholder, () => placeholder);
        const session = await connectWrite(ctx, TASK_WRITE);
        const service = session.identity.service.installationId;
        const scope = `project:${projectId}`;
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope, type: "task.create" },
          { ...content, profileId },
        );
        // Derived ids make a retry with the same key rebuild the identical command.
        const ids = (purpose: string) =>
          derivedUuid(service, projectId, key, purpose);
        const taskId = ids("task");
        const { receipt, request } = await sendCommand(ctx, session, {
          scope,
          type: "task.create",
          key,
          digest,
          resource: taskId,
          command: build(key, ids),
          match: (r) => isTask(r, taskId),
        });
        const after = await readAfter(session, taskId);
        return writeOutput({
          request,
          receipt,
          reused,
          effect: admissionEffect(after),
          summary: `Created task ${taskId}`,
          lines: after ? taskStatusLines(after) : [["Task", taskId]],
          notes: [
            "Task creation cannot be undone: use 'task configure --ready false' or 'task stop' to hold it.",
            ...followLines(after, taskId, true),
          ],
          data: { taskId, ...(after ? { admission: after.admission } : {}) },
        });
      },
    },
  ],
  [
    "task configure",
    {
      usage:
        "task configure TASK_ID [--expected-version N] [--title T] [--outcome TEXT|- | --outcome-file FILE] [--ready true|false] [--request-id UUID]",
      positionals: 1,
      flags: [
        "expected-version",
        "title",
        "outcome",
        "outcome-file",
        "ready",
        "request-id",
      ],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        // Omitted, the version comes from the task read the write already makes.
        const expectedVersion = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        const ready = boolFlag(ctx.values.ready, "ready");
        if (
          ctx.values.title === undefined &&
          ctx.values.outcome === undefined &&
          ctx.values["outcome-file"] === undefined &&
          ready === undefined
        )
          throw new CliError(
            "usage",
            "Give at least one of --title, --outcome, --outcome-file or --ready.",
          );
        const outcome = await inlineText(ctx, "outcome");
        const fields = {
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          ...(ctx.values.title === undefined
            ? {}
            : { title: ctx.values.title }),
          ...(outcome === undefined ? {} : { outcome }),
          ...(ready === undefined ? {} : { ready }),
        };
        return domainTaskWrite(
          ctx,
          taskId,
          "task.configure",
          fields,
          `Configured task ${taskId}`,
          ready === undefined
            ? []
            : [`Reverse with 'task configure --ready ${!ready}'.`],
        );
      },
    },
  ],
  ...(["add", "remove"] as const).map((verb): [string, WriteCommand] => [
    `task ${verb}-dependency`,
    {
      usage: `task ${verb}-dependency TASK_ID --blocker ID --expected-version N [--request-id UUID]`,
      positionals: 1,
      flags: ["blocker", "expected-version", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const [blocker, ...extra] = ctx.values.blocker ?? [];
        if (blocker === undefined || extra.length)
          throw new CliError("usage", "Give exactly one --blocker ID.");
        return domainTaskWrite(
          ctx,
          taskId,
          `dependency.${verb}`,
          {
            blockerTaskId: uuidArg(blocker, "--blocker"),
            expectedVersion: requiredVersion(ctx),
          },
          `${verb === "add" ? "Added" : "Removed"} the dependency on ${blocker}`,
          [
            `Reverse with 'task ${verb === "add" ? "remove" : "add"}-dependency'.`,
          ],
        );
      },
    },
  ]),
  [
    "task message",
    {
      usage:
        "task message TASK_ID --to ASSIGNMENT_ID --expected-version N --message-file FILE [--request-id UUID]",
      positionals: 1,
      flags: ["to", "expected-version", "message-file", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const recipient = uuidArg(ctx.values.to ?? "", "--to");
        const expected = requiredVersion(ctx);
        const message = await messageText(ctx);
        const session = await connectWrite(ctx, TASK_WRITE);
        const task = (await readTask(session, taskId)).data;
        return sendMessage(
          ctx,
          session,
          task,
          recipient,
          expected,
          message,
          false,
          () => {
            const lead = task.assignments.find(
              (a) => a.assignmentId === recipient,
            );
            if (!lead) throw notAnAssignment(taskId, recipient);
            if (
              recipient === task.leadAssignmentId &&
              lead.state === "completed"
            )
              throw new CliError(
                "usage",
                `The project lead has completed; use 'ensemble task follow-up ${taskId}' to resume it.`,
                {
                  fix: `Run 'ensemble task follow-up ${taskId} --expected-version N --message-file FILE', with N from 'ensemble assignment get ${recipient}'.`,
                },
              );
          },
        );
      },
    },
  ],
  [
    "task follow-up",
    {
      usage:
        "task follow-up TASK_ID --expected-version N --message-file FILE [--request-id UUID]",
      positionals: 1,
      flags: ["expected-version", "message-file", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const expected = requiredVersion(ctx);
        const message = await messageText(ctx);
        const session = await connectWrite(ctx, TASK_WRITE);
        const task = (await readTask(session, taskId)).data;
        const lead = task.leadAssignmentId;
        const chooseLead = cliFix({
          kind: "choose-lead",
          projectId: task.task.projectId,
        });
        if (!lead)
          throw new CliError("conflict", "This task has no project lead.", {
            fix: `Choose a project lead with '${chooseLead[0]}', then '${chooseLead[1]}' ('ensemble profile list' shows profile IDs).`,
          });
        return sendMessage(
          ctx,
          session,
          task,
          lead,
          expected,
          message,
          true,
          () => {
            if (task.leadFeedback?.mode !== "resumes")
              throw new CliError(
                "conflict",
                task.leadFeedback?.mode === "receives"
                  ? `The lead has not completed; use 'ensemble task message ${taskId} --to ${lead}'.`
                  : "The lead cannot be resumed: the task is not open or the lead is unavailable.",
                {
                  fix:
                    task.leadFeedback?.mode === "receives"
                      ? `Run 'ensemble task message ${taskId} --to ${lead} --expected-version N --message-file FILE', with N from 'ensemble assignment get ${lead}'.`
                      : `Run 'ensemble task get ${taskId}' to see the task's state and lead.`,
                },
              );
          },
        );
      },
    },
  ],
]);
