import { stat } from "node:fs/promises";
import { z } from "zod";
import {
  nativeQuestionAnswers,
  type QuestionForm,
  validateQuestionAnswers,
} from "../core/question-forms.js";
import {
  inboxReadSchema,
  questionReadSchema,
  taskSchema,
} from "../operator/contracts.js";
import {
  type BrowseCommand,
  browseOutput,
  cursorQuery,
  decodeCursor,
  enumArg,
  optionalUuid,
  pageLimit,
  readWithCursor,
  uuidArg,
} from "./browse.js";
import { exactCommand, positiveIntFlag, readTextFile } from "./configure.js";
import { CliError } from "./connections.js";
import { taskHeldLabels } from "./remedy.js";
import { keyValues, oneLine, table, unavailable } from "./render.js";
import {
  connectWrite,
  readAfter,
  readTask,
  writeOutput,
} from "./task-write.js";
import {
  carryRetryFlags,
  chooseKey,
  requestKey,
  sendCommand,
  type WriteCommand,
} from "./write.js";

const ATTENTION_WRITE = ["cli.identity", "attention.read", "attention.write"];
const ids = (positionals: string[]) => ({
  taskId: uuidArg(positionals[2] ?? "", "TASK_ID"),
  interactionId: uuidArg(positionals[3] ?? "", "INTERACTION_ID"),
});
const questionPath = (taskId: string, interactionId: string) =>
  `/api/operator/tasks/${taskId}/questions/${interactionId}`;
const expectedRevision = (value: string | undefined) => {
  const revision = positiveIntFlag(value, "expected-revision");
  if (revision === undefined)
    throw new CliError("usage", "--expected-revision N is required.");
  return revision;
};

function formLines(form: QuestionForm): string[] {
  return form.questions.flatMap((q) => {
    const bounds = [
      q.required ? "required" : "optional",
      q.minLength !== undefined ? `min ${q.minLength} chars` : "",
      q.maxLength !== undefined ? `max ${q.maxLength} chars` : "",
      q.kind === "multiple-choice" && q.minSelections !== undefined
        ? `min ${q.minSelections} selections`
        : "",
      q.kind === "multiple-choice" && q.maxSelections !== undefined
        ? `max ${q.maxSelections} selections`
        : "",
      q.kind !== "free-text" && q.customAllowed ? "custom text allowed" : "",
    ].filter(Boolean);
    const options =
      q.kind === "free-text"
        ? []
        : q.options.map((o) => {
            const marks = [
              q.recommended?.includes(o.id) ? "recommended" : "",
              q.preselected?.includes(o.id) ? "preselected" : "",
            ].filter(Boolean);
            return `    - ${o.id}: ${o.label}${marks.length ? ` (${marks.join(", ")}; information only)` : ""}`;
          });
    return [
      `  ${q.id} [${q.kind}; ${bounds.join(", ")}]: ${q.label}`,
      ...(q.description ? [`    ${oneLine(q.description, 200)}`] : []),
      ...options,
    ];
  });
}

const inboxList: BrowseCommand = {
  usage:
    "inbox list [--kind question|approval|intervention|runtime] [--project ID] [--limit N] [--cursor TOKEN]",
  positionals: 0,
  capabilities: ["cli.identity", "attention.read"],
  async run(ctx) {
    const kind = enumArg(
      ctx.values.kind,
      ["question", "approval", "intervention", "runtime"],
      "--kind",
    );
    const project = optionalUuid(ctx.values.project, "--project");
    const limit = pageLimit(ctx.values, { serverMax: 100 });
    const q = cursorQuery({ kind, project });
    const cursor = decodeCursor(ctx.values.cursor, "inbox list", q);
    const client = await ctx.connect();
    const params = new URLSearchParams({ limit: String(limit.limit) });
    if (kind) params.set("kind", kind);
    if (project) params.set("project", project);
    if (cursor) params.set("cursor", cursor.c);
    const read = await readWithCursor(!!cursor, () =>
      client.get(`/api/operator/inbox?${params}`, inboxReadSchema),
    );
    const { items, nextCursor, unavailable: omitted } = read.data;
    return browseOutput(ctx, {
      data: { items, unavailable: omitted },
      observedAt: read.observedAt,
      gaps: omitted ? ["item-omitted"] : [],
      page: {
        kind: "inbox list",
        query: q,
        limit,
        returned: items.length,
        next: nextCursor,
      },
      human: items.length
        ? table(
            ["Kind", "Task", "Interaction", "Rev", "Requester", "Reason"],
            items.map((i) =>
              i.kind === "runtime"
                ? // The Task column names the runtime; its detail is `runtime list`.
                  [
                    i.kind,
                    i.harness,
                    "(ensemble runtime list)",
                    "-",
                    "-",
                    oneLine(i.reason, 60),
                  ]
                : [
                    i.kind,
                    i.taskId,
                    i.interactionId ?? `(ensemble task get ${i.taskId})`,
                    i.revision === null ? "-" : String(i.revision),
                    oneLine(i.requesterName, 30),
                    oneLine(i.reason, 60),
                  ],
            ),
          )
        : "Nothing needs attention.",
    });
  },
};

const questionGet: BrowseCommand = {
  usage: "question get TASK_ID INTERACTION_ID",
  positionals: 2,
  capabilities: ["cli.identity", "attention.read"],
  async run(ctx) {
    const { taskId, interactionId } = ids(ctx.positionals);
    const client = await ctx.connect();
    const read = await client.get(
      questionPath(taskId, interactionId),
      questionReadSchema,
    );
    const q = read.data;
    const template = q.form
      ? JSON.stringify(
          Object.fromEntries(
            q.form.questions.map((x) => [x.id, { optionIds: [], text: "" }]),
          ),
        )
      : null;
    return browseOutput(ctx, {
      data: q,
      observedAt: read.observedAt,
      gaps: q.form ? [] : ["content-unavailable"],
      human: [
        keyValues([
          ["Question", q.interactionId],
          ["Task", q.taskId],
          ["Source", q.source],
          ["Status", q.status],
          ["Revision", String(q.revision)],
          ["Reason", unavailable(q.reason)],
        ]),
        ...(q.form ? ["Questions:", ...formLines(q.form)] : []),
        ...(q.answers
          ? [`Recorded answers: ${JSON.stringify(q.answers)}`]
          : []),
        ...(q.status === "pending" && template
          ? [
              `Answer every question explicitly; recommended or preselected options are never an answer.`,
              `Answers file shape: ${template}`,
              `Then: ensemble question answer ${taskId} ${interactionId} --expected-revision ${q.revision} --answers-file FILE`,
            ]
          : []),
      ].join("\n"),
    });
  },
};

const approvalGet: BrowseCommand = {
  usage: "approval get TASK_ID INTERACTION_ID",
  positionals: 2,
  capabilities: ["cli.identity", "attention.read", "task.read"],
  async run(ctx) {
    const { taskId, interactionId } = ids(ctx.positionals);
    const client = await ctx.connect();
    const read = await client.get(`/api/operator/tasks/${taskId}`, taskSchema);
    const approval = read.data.approvals.find(
      (a) => a.interactionId === interactionId,
    );
    if (!approval)
      throw new CliError("not-found", "No such approval on this task.");
    const requester = read.data.assignments.find(
      (a) => a.assignmentId === approval.requestingAssignmentId,
    );
    const holds = taskHeldLabels(read.data);
    return browseOutput(ctx, {
      data: { approval, holds: read.data.execution.holds },
      observedAt: read.observedAt,
      gaps:
        approval.materialUnavailable || approval.action === null
          ? ["content-unavailable"]
          : [],
      human: [
        keyValues([
          ["Approval", approval.interactionId],
          ["Task", taskId],
          ["Status", approval.status],
          ["Revision", String(approval.revision)],
          [
            "Requester",
            `${unavailable(requester?.name)} (${approval.requestingAssignmentId})`,
          ],
          ["Action", unavailable(approval.action)],
          ["Target", unavailable(approval.target)],
          ["Material hash", approval.materialHash ?? "(none recorded)"],
          [
            "Material",
            approval.material === null
              ? "(unavailable)"
              : JSON.stringify(approval.material),
          ],
          ...(approval.compareUrl
            ? [["Compare", approval.compareUrl] as [string, string]]
            : []),
          ["Approvable", approval.approvable ? "yes" : "no (deny only)"],
          ["Task holds", holds.length ? holds.join(", ") : "none"],
        ]),
        "A decision does not clear Stop, pause or other holds, and cannot be changed once recorded.",
        ...(approval.status === "open"
          ? [
              `Decide: ensemble approval decide ${taskId} ${interactionId} --decision approved|denied --expected-revision ${approval.revision}${approval.materialHash ? ` --material-hash ${approval.materialHash}` : ""}`,
            ]
          : []),
      ].join("\n"),
    });
  },
};

export const attentionBrowseCommands: [string, BrowseCommand][] = [
  ["inbox list", inboxList],
  ["question get", questionGet],
  ["approval get", approvalGet],
];

const MAX_ANSWERS_BYTES = 256 * 1024;
async function readAnswers(path: string | undefined, form: QuestionForm) {
  if (path === undefined)
    throw new CliError("usage", "--answers-file FILE is required.");
  if (
    ((await stat(path).catch(() => undefined))?.size ?? 0) > MAX_ANSWERS_BYTES
  )
    throw new CliError("invalid-input", "--answers-file is over 256 KiB.");
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readTextFile(path, "answers-file")) ?? "");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("invalid-input", "--answers-file is not JSON.");
  }
  try {
    return validateQuestionAnswers(form, parsed);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new CliError(
      "invalid-input",
      `The answers are not valid: ${error.issues
        .map((i) => `${String(i.path[0] ?? "") || "(answers)"}: ${i.message}`)
        .join("; ")}.`,
    );
  }
}

export const attentionWriteCommands = new Map<string, WriteCommand>([
  [
    "question answer",
    {
      usage:
        "question answer TASK_ID INTERACTION_ID --expected-revision N --answers-file FILE [--request-id UUID]",
      positionals: 2,
      expects:
        "--expected-revision: the question's revision ('ensemble question get TASK_ID INTERACTION_ID'); required.",
      flags: ["expected-revision", "answers-file", "request-id"],
      async run(ctx) {
        const { taskId, interactionId } = ids(ctx.positionals);
        const revision = expectedRevision(ctx.values["expected-revision"]);
        const session = await connectWrite(ctx, ATTENTION_WRITE);
        const q = (
          await session.client.get(
            questionPath(taskId, interactionId),
            questionReadSchema,
          )
        ).data;
        if (!q.form)
          throw new CliError(
            "policy-denied",
            "The question form is withheld; it cannot be answered here.",
            {
              fix: `Run 'ensemble question get ${taskId} ${interactionId}' to see what is withheld.`,
            },
          );
        const answers = await readAnswers(ctx.values["answers-file"], q.form);
        // Exactly the React mapping per question source.
        const command =
          q.source === "native"
            ? {
                type: "question.native.answer",
                taskId,
                interactionId,
                expectedRevision: revision,
                answers: nativeQuestionAnswers(q.form, answers),
              }
            : q.source === "plain"
              ? {
                  type: "question.answer",
                  taskId,
                  interactionId,
                  expectedRevision: revision,
                  answer: answers.answer?.text ?? "",
                }
              : {
                  type: "question.form.answer",
                  taskId,
                  interactionId,
                  expectedRevision: revision,
                  answers,
                };
        const scope = `task:${taskId}`;
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope, type: command.type },
          command,
        );
        if (!reused && q.status !== "pending")
          throw new CliError(
            "conflict",
            `The question is ${q.status}; it cannot be answered.`,
            {
              fix: `Run 'ensemble question get ${taskId} ${interactionId}' to see its state.`,
            },
          );
        if (!reused && q.revision !== revision)
          throw new CliError(
            "conflict",
            `The question is at revision ${q.revision}, not ${revision}.`,
            {
              fix: `Retry with --expected-revision ${q.revision}; 'ensemble question get ${taskId} ${interactionId}' shows it.`,
            },
          );
        const { receipt, request } = await sendCommand(ctx, session, {
          scope,
          type: command.type,
          key,
          digest,
          resource: interactionId,
          command: exactCommand(command, key),
          match: (r) =>
            q.source === "native"
              ? r.kind === "native-question" &&
                r.interactionId === interactionId
              : r.kind === "coordination" && r.taskId === taskId,
        });
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "queued",
          summary: `Answered question ${interactionId}`,
          lines: [
            ["Task", taskId],
            ["Source", q.source],
          ],
          notes: [
            q.source === "native"
              ? "The answer is recorded; delivery to the runtime and any new work remain subject to holds and admission."
              : "The answer is recorded for the requester's next eligible turn; holds and admission still decide.",
            "A recorded answer cannot be changed.",
          ],
        });
      },
    },
  ],
  [
    "approval decide",
    {
      usage:
        "approval decide TASK_ID INTERACTION_ID --decision approved|denied --expected-revision N [--material-hash HASH] [--request-id UUID]",
      positionals: 2,
      expects:
        "--expected-revision: the approval's revision ('ensemble approval get TASK_ID INTERACTION_ID'); required.",
      flags: ["decision", "expected-revision", "material-hash", "request-id"],
      async run(ctx) {
        const { taskId, interactionId } = ids(ctx.positionals);
        const decision = enumArg(
          ctx.values.decision,
          ["approved", "denied"],
          "--decision",
        );
        if (!decision)
          throw new CliError(
            "usage",
            "--decision approved|denied is required.",
          );
        const revision = expectedRevision(ctx.values["expected-revision"]);
        const hash = ctx.values["material-hash"];
        if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))
          throw new CliError(
            "invalid-input",
            "--material-hash must be 64 hex characters.",
          );
        const session = await connectWrite(ctx, [
          ...ATTENTION_WRITE,
          "task.read",
        ]);
        const approval = (await readTask(session, taskId)).data.approvals.find(
          (a) => a.interactionId === interactionId,
        );
        if (!approval)
          throw new CliError("not-found", "No such approval on this task.");
        if (approval.materialHash && hash === undefined)
          throw new CliError(
            "usage",
            "--material-hash is required: this approval has recorded material.",
          );
        if (approval.action === null)
          throw new CliError(
            "policy-denied",
            "The approval action is withheld; it cannot be decided here.",
            {
              fix: `Run 'ensemble approval get ${taskId} ${interactionId}' to see what is withheld.`,
            },
          );
        // Send exactly what the service disclosed; a withheld material is filled
        // from the retained record for a denial only.
        const command = {
          type: "approval.decide",
          taskId,
          interactionId,
          expectedRevision: revision,
          decision,
          action: approval.action,
          ...(approval.target === null ? {} : { target: approval.target }),
          ...(approval.material === null
            ? {}
            : { material: approval.material }),
        };
        const scope = `task:${taskId}`;
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope, type: "approval.decide" },
          { ...command, materialHash: hash ?? null },
        );
        if (!reused) {
          if (approval.status !== "open")
            throw new CliError(
              "conflict",
              `The approval is already ${approval.status}.`,
              {
                fix: `Run 'ensemble approval get ${taskId} ${interactionId}' to see the decision.`,
              },
            );
          if (approval.revision !== revision)
            throw new CliError(
              "conflict",
              `The approval is at revision ${approval.revision}, not ${revision}.`,
              {
                fix: `Retry with --expected-revision ${approval.revision}; 'ensemble approval get ${taskId} ${interactionId}' shows it.`,
              },
            );
          if ((approval.materialHash ?? undefined) !== hash)
            throw new CliError(
              "conflict",
              "--material-hash does not match the approval's material.",
              {
                fix: `Copy the material hash from 'ensemble approval get ${taskId} ${interactionId}'.`,
              },
            );
          if (decision === "approved" && !approval.approvable)
            throw new CliError(
              "policy-denied",
              "This approval cannot be approved: its material or target is withheld or was never recorded. It can only be denied.",
              {
                fix: `Decide it with --decision denied; 'ensemble approval get ${taskId} ${interactionId}' shows the material.`,
              },
            );
        }
        const { receipt, request } = await sendCommand(ctx, session, {
          scope,
          type: "approval.decide",
          key,
          digest,
          resource: interactionId,
          command: exactCommand(command, key),
          match: (r) => r.kind === "coordination" && r.taskId === taskId,
        });
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "queued",
          summary: `Recorded ${decision} for approval ${interactionId}`,
          lines: [
            ["Task", taskId],
            ["Decision", decision],
          ],
          notes: [
            "The requester receives the decision on its next eligible turn; Stop, pause and other holds are unchanged.",
            "A decision cannot be changed; a changed request is a new approval.",
          ],
        });
      },
    },
  ],
  [
    "result deliver",
    {
      usage:
        "result deliver TASK_ID RESULT_ID [--expected-revision N] [--request-id UUID]",
      positionals: 2,
      expects:
        "--expected-revision: the undelivered result's revision ('ensemble task get TASK_ID --output json' lists data.unresolvedResults); omitted, the revision this command reads first.",
      flags: ["expected-revision", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const resultId = uuidArg(ctx.positionals[3] ?? "", "RESULT_ID");
        const pinned = positiveIntFlag(
          ctx.values["expected-revision"],
          "expected-revision",
        );
        const session = await connectWrite(ctx, [
          ...ATTENTION_WRITE,
          "task.read",
        ]);
        const read = (await readTask(session, taskId)).data;
        const item = read.unresolvedResults.find(
          (r) => r.resultId === resultId,
        );
        const row = read.results.find((r) => r.resultId === resultId);
        if (!row && !item)
          throw new CliError("not-found", `No such result on task ${taskId}.`, {
            fix: `Run 'ensemble result list ${taskId}' to see its results.`,
          });
        const nameOf = (id: string) =>
          read.assignments.find((a) => a.assignmentId === id)?.name ?? id;
        const delivered = (id: string | null | undefined) =>
          new CliError(
            "conflict",
            id
              ? `The result was already delivered to ${nameOf(id)}.`
              : "The result is not waiting for a destination.",
            {
              fix: `Run 'ensemble result get ${taskId} ${resultId}' to see where it went. If an earlier attempt's reply was lost, rerun it with its --request-id and --expected-revision.`,
            },
          );
        if (
          item &&
          (item.availability !== "available" || !item.permittedRecipient)
        )
          throw new CliError(
            "policy-denied",
            "No lead or requester on this task can receive it; the result stays undelivered. Nothing was sent.",
            {
              fix: `Run 'ensemble task get ${taskId}' to see the task's assignments.`,
            },
          );
        // A delivered result has left unresolvedResults, so a replay rebuilds its material from the record.
        const revision = pinned ?? item?.revision;
        const recipientId =
          item?.permittedRecipient?.assignmentId ?? row?.recipientAssignmentId;
        if (revision === undefined || !recipientId)
          throw delivered(row?.recipientAssignmentId);
        const scope = `task:${taskId}`;
        const { key, digest, reached } = await requestKey(
          ctx,
          session,
          { scope, type: "result.recipient" },
          [resultId, revision, recipientId],
        );
        if (!reached) {
          if (!item) throw delivered(recipientId);
          if (item.revision !== revision)
            throw new CliError(
              "conflict",
              `The result is at revision ${item.revision}, not ${revision}. Nothing was sent.`,
              {
                fix: `Retry with --expected-revision ${item.revision}, or omit it to use the current revision.`,
              },
            );
        }
        const { receipt, request } = await sendCommand(ctx, session, {
          scope,
          type: "result.recipient",
          key,
          digest,
          resource: resultId,
          command: exactCommand(
            {
              type: "result.recipient",
              taskId,
              resultId,
              expectedRevision: revision,
              recipientAssignmentId: recipientId,
            },
            key,
          ),
          match: (r) =>
            r.kind === "coordination" &&
            r.taskId === taskId &&
            r.recipientAssignmentId === recipientId,
        }).catch(async (error: unknown) => {
          if (error instanceof CliError && error.code === "conflict") {
            const now = await readAfter(session, taskId);
            const current = now?.unresolvedResults.find(
              (r) => r.resultId === resultId,
            );
            throw new CliError(
              "conflict",
              `Not delivered; nothing was recorded. ${
                current
                  ? `The result is now at revision ${current.revision}${current.permittedRecipient ? "" : " with no permitted recipient"}, and you sent revision ${revision}.`
                  : now
                    ? "The result is no longer waiting for a destination, or this request ID was used with other material."
                    : "Its destination changed since it was read, or this request ID was used with other material."
              }`,
              {
                ...error.extra,
                fix: `Run 'ensemble task get ${taskId}' to see the result's current state, then rerun (omit --expected-revision to use the current revision, and use a new --request-id if you reused one).`,
              },
            );
          }
          return carryRetryFlags(error, key, `--expected-revision ${revision}`);
        });
        return writeOutput({
          request,
          receipt,
          reused: reached,
          effect: "queued",
          summary: `Delivered result ${resultId}`,
          lines: [
            ["Task", taskId],
            ["Recipient", `${nameOf(recipientId)} (${recipientId})`],
            ["Revision", String(revision)],
          ],
          notes: [
            "It arrives on the recipient's next eligible turn; holds and admission still decide, and this does not complete the task.",
            "The destination cannot be redirected or undone.",
          ],
          data: { resultId, recipientAssignmentId: recipientId, revision },
        });
      },
    },
  ],
]);
