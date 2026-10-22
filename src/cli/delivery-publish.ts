import type { CommandReceipt, TaskRead } from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import { exactCommand, positiveIntFlag } from "./configure.js";
import { CliError } from "./connections.js";
import { keyValues } from "./render.js";
import {
  connectWrite,
  readTask,
  TASK_WRITE,
  taskVersion,
  writeOutput,
} from "./task-write.js";
import {
  chooseKey,
  requestKey,
  sendCommand,
  type WriteCommand,
  type WriteContext,
  withConflictRemedy,
} from "./write.js";

type Review = Extract<CommandReceipt, { kind: "publication-review" }>;
type Publication = Extract<CommandReceipt, { kind: "publication" }>;
const scope = (taskId: string) => `task:${taskId}`;

const IRREVERSIBLE =
  "Publishing creates a public GitHub issue that Ensemble cannot delete or take back; closing the issue on GitHub is the only recovery.";

function expectedTaskVersion(ctx: WriteContext) {
  const v = positiveIntFlag(
    ctx.values["expected-task-version"],
    "expected-task-version",
  );
  if (v === undefined)
    throw new CliError("usage", "--expected-task-version N is required.");
  return v;
}

const targetLines = (policy: NonNullable<TaskRead["data"]["publication"]>) =>
  policy.targets
    .map(
      (t) =>
        `  ${t.id}  ${t.repository ?? "(hidden)"} (${t.selectionKind})${t.enabled ? "" : ` - unavailable: ${t.reason ?? t.reasonCode}`}`,
    )
    .join("\n");

function reviewLines(r: Review) {
  return keyValues([
    ["Review", r.reviewId],
    ["Revision", String(r.revision)],
    ["Decision", r.decision],
    ["Material hash", r.materialHash],
    ["Repository", r.repository ?? "(hidden)"],
    ["Title", r.title],
    [
      "Labels",
      r.labels.length
        ? r.labels.map((l) => l ?? "(hidden)").join(", ")
        : "none",
    ],
    [
      "Project fields",
      r.projectFields.length
        ? r.projectFields
            .map((f) => `${f.fieldNodeId}=${f.optionNodeId}`)
            .join(", ")
        : "none",
    ],
    ["Added to a GitHub Project", r.addsToProject ? "yes" : "no"],
    [
      "Predicted",
      `matches the selection: ${r.predictedSelected ? "yes" : "no"}; Ready: ${r.predictedReady ? "yes" : "no"}`,
    ],
    [
      "Bound to",
      `task version ${r.taskVersion}, policy version ${r.policyVersion}`,
    ],
  ]);
}

function publicationLines(p: Publication) {
  return keyValues([
    ["Publication", p.publicationId],
    ["State", p.state],
    ["Issue", p.issueNumber === null ? "not created" : `#${p.issueNumber}`],
    [
      "Steps",
      p.steps.length
        ? p.steps
            .map(
              (s) => `${s.kind}: ${s.state}${s.reason ? ` (${s.reason})` : ""}`,
            )
            .join("; ")
        : "none",
    ],
  ]);
}

/** What a publication still being sent means, from its create step rather than from "sending" alone. */
function sendingNote(taskId: string, p: Publication) {
  const create = p.steps.find((s) => s.kind === "issue.create")?.state;
  if (create === "confirmed-success")
    return `Issue #${p.issueNumber} was created. A later step is waiting for GitHub or a retry. Nothing is sent again; run 'ensemble delivery refresh ${taskId}' to continue, and the task converts when the steps are recorded. Link and Abandon do not apply.`;
  if (create !== "uncertain")
    return `The create is still in progress or waiting for a retry. Nothing is sent again; run 'ensemble delivery refresh ${taskId}' to continue.`;
  return `The create's outcome is not known. Nothing is sent again. Run 'ensemble delivery refresh ${taskId}' to read GitHub again; if the issue exists, run 'ensemble delivery publish-link ${taskId} --publication-id ${p.publicationId} --issue N'. 'ensemble delivery publish-abandon ${taskId} --publication-id ${p.publicationId}' gives up and may leave a duplicate issue.`;
}

const stateNote = (taskId: string, p: Publication) =>
  p.state === "sending"
    ? sendingNote(taskId, p)
    : p.state === "converted"
      ? `The task is now GitHub issue #${p.issueNumber}; its title and description are owned by GitHub from here, and the next sync matches it.`
      : p.state === "abandoned"
        ? "Abandoned: the task is local again. GitHub may still hold an issue created by the attempt, and the next sync would import it as a separate task."
        : p.state === "failed"
          ? "GitHub did not create the issue. The task is unchanged and can be published again."
          : "";

async function sendPublication(
  ctx: WriteContext,
  taskId: string,
  type: string,
  material: unknown[],
  command: Record<string, unknown>,
  publicationId: string,
  expected?: number,
) {
  const session = await connectWrite(ctx, TASK_WRITE);
  const { key, digest, reached } = await requestKey(
    ctx,
    session,
    { scope: scope(taskId), type },
    material,
  );
  const run = () =>
    sendCommand(ctx, session, {
      scope: scope(taskId),
      type,
      key,
      digest,
      resource: taskId,
      command: exactCommand({ type, taskId, ...command }, key),
      match: (r) =>
        r.kind === "publication" &&
        r.taskId === taskId &&
        r.publicationId === publicationId,
    });
  const { receipt, request } =
    expected === undefined
      ? await run()
      : await withConflictRemedy(run, taskVersion(session, taskId, expected));
  return { receipt: receipt as Publication, request, reused: reached };
}

export const deliveryPublishCommands = new Map<string, WriteCommand>([
  [
    "delivery publish-review",
    {
      usage:
        "delivery publish-review TASK_ID --target ID --expected-task-version N [--request-id UUID]",
      positionals: 1,
      expects:
        "--expected-task-version: the task's version ('ensemble task get TASK_ID'); required. --target is an ID from its Publication section.",
      flags: ["target", "expected-task-version", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const expected = expectedTaskVersion(ctx);
        const targetId = ctx.values.target;
        const session = await connectWrite(ctx, TASK_WRITE);
        const type = "task.publish.review";
        const { key, digest, reached } = await requestKey(
          ctx,
          session,
          { scope: scope(taskId), type },
          [expected, targetId ?? ""],
        );
        if (!reached) {
          const policy = (await readTask(session, taskId)).data.publication;
          if (!policy?.available)
            throw new CliError(
              "policy-denied",
              `This task cannot be published: ${policy?.reason ?? "not reported"} Nothing was sent.`,
              {
                fix: `Run 'ensemble task get ${taskId}' to see the task.`,
              },
            );
          const target = policy.targets.find((t) => t.id === targetId);
          if (!target)
            throw new CliError(
              "usage",
              `Name the target with --target ID:\n${targetLines(policy)}`,
            );
          if (!target.enabled)
            throw new CliError(
              "policy-denied",
              `That target cannot take this task: ${target.reason ?? target.reasonCode} Nothing was sent.`,
              {
                fix: `Choose another target:\n${targetLines(policy)}`,
              },
            );
        }
        const { receipt, request } = await withConflictRemedy(
          () =>
            sendCommand(ctx, session, {
              scope: scope(taskId),
              type,
              key,
              digest,
              resource: taskId,
              command: exactCommand(
                {
                  type,
                  taskId,
                  targetId,
                  expectedTaskVersion: expected,
                },
                key,
              ),
              match: (r) =>
                r.kind === "publication-review" &&
                r.taskId === taskId &&
                r.reviewId === key,
            }),
          taskVersion(session, taskId, expected),
        );
        const r = receipt as Review;
        return {
          request,
          data: { receipt },
          human: [
            `Review recorded for task ${taskId} (request ${key}). Nothing was created on GitHub.`,
            reviewLines(r),
            "",
            r.body,
            "",
            IRREVERSIBLE,
            r.decision === "pending"
              ? `Approve or deny with: ensemble delivery publish-confirm ${taskId} --review-id ${r.reviewId} --expected-revision ${r.revision} --material-hash ${r.materialHash} --decision approved|denied`
              : `This review is already ${r.decision}.`,
          ].join("\n"),
        };
      },
    },
  ],
  [
    "delivery publish-confirm",
    {
      usage:
        "delivery publish-confirm TASK_ID --review-id UUID --expected-revision N --material-hash HASH --decision approved|denied [--request-id UUID]",
      positionals: 1,
      expects:
        "--expected-revision and --material-hash: printed by 'ensemble delivery publish-review'; required.",
      flags: [
        "review-id",
        "expected-revision",
        "material-hash",
        "decision",
        "request-id",
      ],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const reviewId = uuidArg(ctx.values["review-id"] ?? "", "--review-id");
        const revision = positiveIntFlag(
          ctx.values["expected-revision"],
          "expected-revision",
        );
        const materialHash = ctx.values["material-hash"] ?? "";
        const decision = ctx.values.decision;
        if (revision === undefined)
          throw new CliError("usage", "--expected-revision N is required.");
        if (!/^[a-f0-9]{64}$/.test(materialHash))
          throw new CliError(
            "invalid-input",
            "--material-hash must be the 64-character hash the review printed.",
          );
        if (decision !== "approved" && decision !== "denied")
          throw new CliError(
            "invalid-input",
            "--decision must be approved or denied.",
          );
        const session = await connectWrite(ctx, TASK_WRITE);
        const type = "task.publish.confirm";
        const { key, digest } = await requestKey(
          ctx,
          session,
          { scope: scope(taskId), type },
          [reviewId, revision, materialHash, decision],
        );
        const { receipt, request } = await sendCommand(ctx, session, {
          scope: scope(taskId),
          type,
          key,
          digest,
          resource: taskId,
          command: exactCommand(
            {
              type,
              taskId,
              reviewId,
              expectedRevision: revision,
              materialHash,
              decision,
            },
            key,
          ),
          match: (r) =>
            r.kind === "publication-review" &&
            r.taskId === taskId &&
            r.reviewId === reviewId,
        }).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "conflict")
            throw new CliError(
              "conflict",
              "Not confirmed: the review's revision or material hash does not match, it is already decided, or the task, grants or target changed since the review. The decision is unchanged.",
              {
                ...error.extra,
                fix: `Run 'ensemble task get ${taskId}' and review again with 'ensemble delivery publish-review'.`,
              },
            );
          throw error;
        });
        const r = receipt as Review;
        return {
          request,
          data: { receipt },
          human: [
            `Review ${reviewId} is ${r.decision} (request ${key}). Nothing was created on GitHub.`,
            reviewLines(r),
            r.decision === "approved"
              ? `Create the issue with: ensemble delivery publish-send ${taskId} --review-id ${reviewId} --expected-task-version ${r.taskVersion}`
              : "A denied review is final; a changed request needs a new review.",
          ].join("\n"),
        };
      },
    },
  ],
  [
    "delivery publish-send",
    {
      usage:
        "delivery publish-send TASK_ID --review-id UUID --expected-task-version N [--request-id UUID]",
      positionals: 1,
      expects:
        "--expected-task-version: the version the review printed; required.",
      flags: ["review-id", "expected-task-version", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const reviewId = uuidArg(ctx.values["review-id"] ?? "", "--review-id");
        const expected = expectedTaskVersion(ctx);
        const { receipt, request, reused } = await sendPublication(
          ctx,
          taskId,
          "task.publish.send",
          [reviewId, expected],
          { reviewId, expectedTaskVersion: expected },
          reviewId,
          expected,
        );
        return writeOutput({
          request,
          receipt,
          reused,
          effect: receipt.state === "converted" ? "completed" : "queued",
          summary: "Publication sent",
          lines: [["Task", taskId]],
          notes: [
            publicationLines(receipt),
            stateNote(taskId, receipt),
            IRREVERSIBLE,
          ].filter(Boolean),
          data: { state: receipt.state, issueNumber: receipt.issueNumber },
        });
      },
    },
  ],
  [
    "delivery publish-link",
    {
      usage:
        "delivery publish-link TASK_ID --publication-id UUID --issue N [--request-id UUID]",
      positionals: 1,
      flags: ["publication-id", "issue", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const publicationId = uuidArg(
          ctx.values["publication-id"] ?? "",
          "--publication-id",
        );
        const issueNumber = positiveIntFlag(ctx.values.issue, "issue");
        if (issueNumber === undefined)
          throw new CliError("usage", "--issue N is required.");
        const { receipt, request, reused } = await sendPublication(
          ctx,
          taskId,
          "task.publish.link",
          [publicationId, issueNumber],
          { reviewId: publicationId, issueNumber },
          publicationId,
        ).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "conflict")
            throw new CliError(
              "conflict",
              "Not linked: that issue does not carry this publication's marker, or the publication's create does not have an unknown outcome. Nothing changed.",
              {
                ...error.extra,
                fix: `Run 'ensemble task get ${taskId}' to see the publication.`,
              },
            );
          throw error;
        });
        return writeOutput({
          request,
          receipt,
          reused,
          effect: receipt.state === "converted" ? "completed" : "queued",
          summary: `Linked issue #${issueNumber}`,
          lines: [["Task", taskId]],
          notes: [publicationLines(receipt), stateNote(taskId, receipt)].filter(
            Boolean,
          ),
          data: { state: receipt.state, issueNumber: receipt.issueNumber },
        });
      },
    },
  ],
  [
    "delivery publish-abandon",
    {
      usage:
        "delivery publish-abandon TASK_ID --publication-id UUID [--request-id UUID]",
      positionals: 1,
      flags: ["publication-id", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const publicationId = uuidArg(
          ctx.values["publication-id"] ?? "",
          "--publication-id",
        );
        const session = await connectWrite(ctx, TASK_WRITE);
        const type = "task.publish.abandon";
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope: scope(taskId), type },
          { taskId, publicationId },
        );
        const { receipt, request } = await sendCommand(ctx, session, {
          scope: scope(taskId),
          type,
          key,
          digest,
          resource: taskId,
          command: exactCommand({ type, taskId, reviewId: publicationId }, key),
          match: (r) =>
            r.kind === "publication" && r.publicationId === publicationId,
        });
        const p = receipt as Publication;
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "completed",
          summary: "Publication abandoned",
          lines: [["Task", taskId]],
          notes: [
            publicationLines(p),
            "WARNING: GitHub may still have created the issue. If it did, the next sync imports it as a second, unrelated task. This cannot be undone.",
          ],
          data: { state: p.state },
        });
      },
    },
  ],
]);
