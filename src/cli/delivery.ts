import { createHash } from "node:crypto";
import {
  type CommandReceipt,
  commandReceiptSchema,
  taskSchema,
} from "../operator/contracts.js";
import {
  type BrowseCommand,
  browseOutput,
  type CoverageGap,
  uuidArg,
} from "./browse.js";
import { exactCommand, positiveIntFlag, readTextFile } from "./configure.js";
import { CliError } from "./connections.js";
import { keyValues, table, unavailable } from "./render.js";
import type { ServiceClient } from "./transport.js";
import type { RequestIdentity } from "./types.js";
import {
  optionalRequestId,
  requestKey,
  type Session,
  sendCommand,
  type WriteCommand,
  type WriteContext,
} from "./write.js";

type TaskRead = Awaited<ReturnType<typeof readTask>>;
type Delivery = NonNullable<TaskRead["data"]["delivery"]>;
type Action = Delivery["actions"][number];

const readTask = (client: ServiceClient, taskId: string) =>
  client.get(`/api/operator/tasks/${encodeURIComponent(taskId)}`, taskSchema);

/** Actions whose provider outcome is not settled yet. */
const UNSETTLED = ["prepared", "attempting", "uncertain"];

function deliveryView(read: TaskRead) {
  const { task, delivery, commentPolicy, source } = read.data;
  return {
    taskId: task.id,
    projectId: task.projectId,
    taskVersion: task.version,
    delivery: delivery ?? null,
    // The CLI contract is the three policy fields; `reasonCode` is for the web.
    commentPolicy: commentPolicy
      ? {
          available: commentPolicy.available,
          mode: commentPolicy.mode,
          reason: commentPolicy.reason,
        }
      : null,
    issue: source
      ? {
          repositoryName: source.repositoryName,
          number: source.number,
          url: source.url,
          state: source.state,
        }
      : null,
  };
}

function deliveryGaps(read: TaskRead): CoverageGap[] {
  const d = read.data.delivery;
  return [
    ...(read.data.contentUnavailable ? (["content-unavailable"] as const) : []),
    ...(d &&
    (d.omittedBlockerCount ||
      d.omittedActionCount ||
      d.binding?.omittedCheckCount ||
      d.binding?.omittedFeedbackCount)
      ? (["item-omitted"] as const)
      : []),
    ...(d?.binding?.readError ? (["evidence-gap"] as const) : []),
  ];
}

const actionRows = (actions: Action[]) =>
  table(
    ["Operation", "Kind", "State", "Reason"],
    actions.map((a) => [a.operationId, a.kind, a.state, a.reason ?? "-"]),
  );

function deliveryLines(view: ReturnType<typeof deliveryView>): string[] {
  const d = view.delivery,
    p = view.commentPolicy,
    b = d?.binding;
  return [
    keyValues([
      ["Task", `${view.taskId} (version ${view.taskVersion})`],
      [
        "Issue",
        view.issue
          ? `${unavailable(view.issue.repositoryName)}#${view.issue.number ?? "?"} (${view.issue.state ?? "unknown"})`
          : "none (local task)",
      ],
      [
        "Comments",
        p
          ? p.available
            ? `available (${p.mode})`
            : `unavailable: ${p.reason ?? "not permitted"}`
          : "not reported",
      ],
      [
        "Delivery",
        d ? `${d.mode}, policy version ${d.policyVersion}` : "not reported",
      ],
      [
        "Pull request",
        b
          ? `${b.repositoryName}#${b.number} ${b.state} head ${b.headSha.slice(0, 12)}, observed ${b.observedAt}${b.readError ? `, last read failed: ${b.readError}` : ""}`
          : "none registered",
      ],
    ]),
    ...(b?.checks.length
      ? [
          "",
          table(
            ["Check", "Status"],
            b.checks.map((c) => [unavailable(c.name), c.status]),
          ),
        ]
      : []),
    ...(b ? [`Feedback items: ${b.feedback.length}`] : []),
    ...(d?.blockers.length
      ? ["", "Blockers:", ...d.blockers.map((x) => `  ${x}`)]
      : []),
    ...(d?.actions.length ? ["", actionRows(d.actions)] : []),
  ];
}

const getCommand: BrowseCommand = {
  usage: "delivery get TASK_ID",
  positionals: 1,
  capabilities: ["cli.identity", "task.read"],
  async run(ctx) {
    const id = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
    const read = await readTask(await ctx.connect(), id);
    const view = deliveryView(read);
    return browseOutput(ctx, {
      data: view,
      observedAt: read.observedAt,
      gaps: deliveryGaps(read),
      human: deliveryLines(view).join("\n"),
    });
  },
};

const scope = (taskId: string) => `task:${taskId}`;

const keyFor = (
  ctx: WriteContext,
  session: Session,
  type: string,
  taskId: string,
  material: unknown[],
  options: Parameters<typeof requestKey>[4] = {},
) =>
  requestKey(ctx, session, { scope: scope(taskId), type }, material, options);

const expectedTaskVersion = (ctx: WriteContext) => {
  const v = positiveIntFlag(
    ctx.values["expected-task-version"],
    "expected-task-version",
  );
  if (v === undefined)
    throw new CliError("usage", "--expected-task-version N is required.");
  return v;
};

async function readBody(ctx: WriteContext) {
  if (!ctx.values["body-file"])
    throw new CliError("usage", "--body-file FILE is required.");
  return (await readTextFile(ctx.values["body-file"], "body-file")) ?? "";
}

/** Advisory checks before a comment request; the service checks the same rules. */
function commentGates(read: TaskRead, expected: number) {
  const policy = read.data.commentPolicy;
  if (!policy?.available)
    throw new CliError(
      "policy-denied",
      `Comments are not available for this task: ${policy?.reason ?? "not reported"}. Nothing was sent.`,
      {
        fix: `Run 'ensemble delivery get ${read.data.task.id}' to see the comment policy.`,
      },
    );
  if (read.data.task.version !== expected)
    throw new CliError(
      "conflict",
      `The task is at version ${read.data.task.version}, not ${expected}. Nothing was sent.`,
      {
        fix: `Retry with --expected-task-version ${read.data.task.version}; 'ensemble delivery get ${read.data.task.id}' shows the task.`,
      },
    );
  return policy;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

type ReviewReceipt = Extract<CommandReceipt, { kind: "comment-review" }>;
const reviewMatch =
  (taskId: string, reviewId: string) =>
  (r: CommandReceipt): boolean =>
    r.kind === "comment-review" &&
    r.taskId === taskId &&
    r.reviewId === reviewId;

function reviewLines(r: ReviewReceipt) {
  return keyValues([
    ["Review", r.reviewId],
    ["Revision", String(r.revision)],
    ["Decision", r.decision],
    ["Material hash", r.materialHash],
    ["Target", `issue #${r.target.number} (${r.target.repositoryId})`],
    [
      "Bound to",
      `task version ${r.taskVersion}, source revision ${r.sourceRevision}, policy version ${r.policyVersion}`,
    ],
  ]);
}

const UNKNOWN_GUIDANCE = (taskId: string, key: string) =>
  `Do not resend with a new --request-id. Run 'ensemble delivery refresh ${taskId}', then 'ensemble delivery get ${taskId}' (operation ${key}); rerunning this exact command replays the recorded outcome.`;

export const deliveryBrowseCommands: [string, BrowseCommand][] = [
  ["delivery get", getCommand],
];

export const deliveryWriteCommands = new Map<string, WriteCommand>([
  [
    "delivery refresh",
    {
      usage: "delivery refresh TASK_ID [--request-id UUID]",
      positionals: 1,
      flags: ["request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const session = await ctx.connect([
          "cli.identity",
          "task.read",
          "delivery.write",
        ]);
        const before = await readTask(session.client, taskId).catch(
          () => undefined,
        );
        // Refresh is repeatable: reuse only a key whose outcome is still unknown.
        const { key, digest } = await keyFor(
          ctx,
          session,
          "delivery.refresh",
          taskId,
          [taskId],
          { repeatable: true },
        );
        const { receipt, request } = await sendCommand(ctx, session, {
          scope: scope(taskId),
          type: "delivery.refresh",
          key,
          digest,
          resource: taskId,
          command: { type: "delivery.refresh", key, taskId },
          match: (r) =>
            r.kind === "review" &&
            r.operation === "delivery.refresh" &&
            r.taskId === taskId,
        });
        const after = await readTask(session.client, taskId);
        const prior = new Map(
          before?.data.delivery?.actions.map((a) => [a.operationId, a.state]),
        );
        const actions = after.data.delivery?.actions ?? [];
        const changed = actions.filter(
          (a) => prior.get(a.operationId) !== a.state,
        );
        const unsettled = actions.filter((a) => UNSETTLED.includes(a.state));
        const binding = after.data.delivery?.binding ?? null;
        const partial = Boolean(binding?.readError) || unsettled.length > 0;
        const view = deliveryView(after);
        return {
          request,
          data: {
            receipt,
            outcome: partial ? "partial" : "complete",
            observedAt: {
              before: before?.data.delivery?.binding?.observedAt ?? null,
              after: binding?.observedAt ?? null,
            },
            readError: binding?.readError ?? null,
            changed,
            unsettled,
            ...view,
          },
          coverage: {
            observedAt: after.observedAt,
            complete: !partial && deliveryGaps(after).length === 0,
            gaps: [
              ...new Set([
                ...deliveryGaps(after),
                ...(partial ? (["evidence-gap"] as const) : []),
              ]),
            ],
            notes: [],
          },
          human: [
            partial
              ? `Refresh recorded (request ${key}) but its outcome is PARTIAL: ${binding?.readError ? `the provider read failed (${binding.readError}); the previous observation is kept` : ""}${binding?.readError && unsettled.length ? "; " : ""}${unsettled.length ? `${unsettled.length} action(s) are still unsettled` : ""}.`
              : `Refreshed delivery (request ${key}).`,
            "Delivery refresh is installation-wide: it reconciles unfinished delivery actions (it may re-attempt prepared or retryable ones and reads back uncertain ones) and re-reads every registered pull request. TASK_ID selects the task reported here.",
            ...(changed.length
              ? ["", "Changed actions:", actionRows(changed)]
              : []),
            "",
            ...deliveryLines(view),
          ].join("\n"),
        };
      },
    },
  ],
  [
    "delivery review-comment",
    {
      usage:
        "delivery review-comment TASK_ID --body-file FILE --expected-task-version N [--request-id UUID]",
      positionals: 1,
      flags: ["body-file", "expected-task-version", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const expected = expectedTaskVersion(ctx);
        const text = await readBody(ctx);
        const session = await ctx.connect([
          "cli.identity",
          "task.read",
          "delivery.write",
        ]);
        const { key, digest, reached } = await keyFor(
          ctx,
          session,
          "comment.review",
          taskId,
          [expected, hash(text)],
        );
        const command = exactCommand(
          {
            type: "comment.review",
            taskId,
            operationId: key,
            expectedTaskVersion: expected,
            body: text,
          },
          key,
        );
        if (!reached)
          commentGates(await readTask(session.client, taskId), expected);
        const { receipt, request } = await sendCommand(ctx, session, {
          scope: scope(taskId),
          type: "comment.review",
          key,
          digest,
          resource: taskId,
          command,
          match: reviewMatch(taskId, key),
        });
        const r = receipt as ReviewReceipt;
        return {
          request,
          data: { receipt },
          human: [
            `Review recorded for task ${taskId} (request ${key}). Nothing was posted.`,
            reviewLines(r),
            "",
            r.body ?? "(body not shown)",
            "",
            r.decision === "pending"
              ? `Approve or deny with: ensemble delivery confirm-comment ${taskId} --review-id ${r.reviewId} --expected-revision ${r.revision} --material-hash ${r.materialHash} --decision approved|denied`
              : `This review is already ${r.decision}; a decision is final.`,
            "A pending review cannot be withdrawn; deny it instead. Changing the body needs a new review.",
          ].join("\n"),
        };
      },
    },
  ],
  [
    "delivery confirm-comment",
    {
      usage:
        "delivery confirm-comment TASK_ID --review-id UUID --expected-revision N --material-hash HASH --decision approved|denied [--request-id UUID]",
      positionals: 1,
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
        const session = await ctx.connect([
          "cli.identity",
          "task.read",
          "delivery.write",
        ]);
        const { key, digest } = await keyFor(
          ctx,
          session,
          "comment.confirm",
          taskId,
          [reviewId, revision, materialHash, decision],
        );
        const { receipt, request } = await sendCommand(ctx, session, {
          scope: scope(taskId),
          type: "comment.confirm",
          key,
          digest,
          resource: taskId,
          command: exactCommand(
            {
              type: "comment.confirm",
              taskId,
              reviewId,
              expectedRevision: revision,
              materialHash,
              decision,
            },
            key,
          ),
          match: reviewMatch(taskId, reviewId),
        }).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "conflict")
            throw new CliError(
              "conflict",
              "Not confirmed: the review's revision or material hash does not match, it is already decided, or the task, source or policy changed since the review. The decision is unchanged.",
              {
                ...error.extra,
                fix: `Run 'ensemble delivery get ${taskId}' for the review's current revision and material hash, then decide again.`,
              },
            );
          if (error instanceof CliError && error.code === "policy-denied")
            throw new CliError(
              "policy-denied",
              "Not approved: the project policy does not grant issue comments for this repository. The decision is unchanged; a denial can still be recorded.",
              {
                ...error.extra,
                fix: `Record a denial instead (--decision denied), or ask the project owner to grant issue comments; 'ensemble delivery get ${taskId}' shows the policy.`,
              },
            );
          throw error;
        });
        const r = receipt as ReviewReceipt;
        return {
          request,
          data: { receipt },
          human: [
            `Review ${reviewId} is ${r.decision} (request ${key}). Nothing was posted.`,
            reviewLines(r),
            r.decision === "approved"
              ? `Post it with: ensemble delivery send-comment ${taskId} --body-file FILE --expected-task-version ${r.taskVersion} --review-id ${reviewId}`
              : "A denied review is final; a changed request needs a new review.",
          ].join("\n"),
        };
      },
    },
  ],
  [
    "delivery send-comment",
    {
      usage:
        "delivery send-comment TASK_ID --body-file FILE --expected-task-version N [--review-id UUID] [--request-id UUID]",
      positionals: 1,
      flags: ["body-file", "expected-task-version", "review-id", "request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const expected = expectedTaskVersion(ctx);
        const reviewId =
          ctx.values["review-id"] === undefined
            ? undefined
            : uuidArg(ctx.values["review-id"], "--review-id");
        const requested = optionalRequestId(ctx.values);
        if (reviewId && requested && requested !== reviewId)
          throw new CliError(
            "usage",
            "With --review-id the request ID is the review ID, which the approval binds; omit --request-id.",
          );
        const text = await readBody(ctx);
        const session = await ctx.connect([
          "cli.identity",
          "task.read",
          "delivery.write",
        ]);
        const service = session.identity.service.installationId;
        // The approval binds the review ID as the operation ID, so it is the send key.
        const { key, digest, state, reached } = await keyFor(
          ctx,
          session,
          "comment.send",
          taskId,
          [expected, hash(text), ...(reviewId ? [reviewId] : [])],
          reviewId ? { fixed: reviewId } : {},
        );
        const command = exactCommand(
          {
            type: "comment.send",
            taskId,
            expectedTaskVersion: expected,
            body: text,
            ...(reviewId ? { reviewId } : {}),
          },
          key,
        );
        if (!reached) {
          const policy = commentGates(
            await readTask(session.client, taskId),
            expected,
          );
          if (policy.mode === "approval" && !reviewId)
            throw new CliError(
              "policy-denied",
              "This project requires an approved review before posting: run 'delivery review-comment', then 'delivery confirm-comment', then send with --review-id. Nothing was sent.",
              {
                fix: `Run 'ensemble delivery review-comment ${taskId}' first.`,
              },
            );
        }
        if (reviewId) {
          // Replaying the exact review returns its current decision; a different body conflicts.
          const raw = await session.client
            .command(
              JSON.stringify(
                exactCommand(
                  {
                    type: "comment.review",
                    taskId,
                    operationId: reviewId,
                    expectedTaskVersion: expected,
                    body: text,
                  },
                  reviewId,
                ),
              ),
              ctx.deps.commandTimeoutMs ?? 60_000,
            )
            .catch((error: unknown) => {
              if (error instanceof CliError && error.code === "conflict")
                throw new CliError(
                  "conflict",
                  `The body or task version differs from review ${reviewId}, or the task changed. Nothing was sent; a changed comment needs a new review.`,
                  {
                    ...error.extra,
                    fix: `Run 'ensemble delivery review-comment ${taskId}' for a changed comment; 'ensemble delivery get ${taskId}' shows the task.`,
                  },
                );
              throw error;
            });
          const review = commandReceiptSchema.safeParse(raw);
          if (!review.success || !reviewMatch(taskId, reviewId)(review.data))
            throw new CliError(
              "unavailable",
              `Review ${reviewId} could not be read back. Nothing was sent.`,
              {
                fix: `Run 'ensemble delivery get ${taskId}' to check the review, then send again.`,
              },
            );
          if ((review.data as ReviewReceipt).decision !== "approved")
            throw new CliError(
              "policy-denied",
              `Review ${reviewId} is ${(review.data as ReviewReceipt).decision}, not approved. Nothing was sent.`,
              {
                fix: `Run 'ensemble delivery get ${taskId}' to see the review, or create a new one with 'ensemble delivery review-comment ${taskId}'.`,
              },
            );
        }
        const request: RequestIdentity = {
          service,
          scope: scope(taskId),
          type: "comment.send",
          key,
        };
        // A key this CLI may have sent with other material can name another operation.
        const ours = !state?.reached || state.digest === digest;
        const sent = await sendCommand(ctx, session, {
          scope: request.scope,
          type: request.type,
          key,
          digest,
          resource: taskId,
          command,
          match: (r) =>
            r.kind === "delivery" &&
            r.taskId === taskId &&
            r.operationId === key,
        }).catch(async (error: unknown) => {
          // Only a service refusal (4xx) may hide a recorded operation.
          const status = error instanceof CliError ? error.extra.status : 0;
          if (
            !(error instanceof CliError) ||
            !status ||
            status < 400 ||
            status >= 500
          )
            throw error;
          // A receipt the service refused after recording the operation is not "nothing posted".
          const recorded = await readTask(session.client, taskId)
            .then((r) =>
              r.data.delivery?.actions.find((a) => a.operationId === key),
            )
            .catch(() => undefined);
          if (recorded && ours) {
            await ctx.journal.append(request, digest, "unknown").catch(() => {
              throw new CliError(
                "journal-unavailable",
                `The service recorded operation ${key} (${recorded.state}) without returning its receipt, and the local journal cannot record it. Rerun with --request-id ${key}; do not use a new key.`,
                {
                  retryable: true,
                  request,
                  fix: `Make the CLI state directory writable, then rerun with --request-id ${key}; do not use a new key.`,
                },
              );
            });
            throw new CliError(
              "command-outcome-unknown",
              `The service recorded operation ${key} (${recorded.state}) but did not return its receipt. ${UNKNOWN_GUIDANCE(taskId, key)}`,
              { ...error.extra, retryable: true, request },
            );
          }
          if (error.code !== "conflict" && error.code !== "policy-denied")
            throw error;
          throw new CliError(
            error.code,
            `Not sent: ${error.code === "conflict" ? "the task, its source or the delivery policy changed, or this request ID was used with other material" : "the project policy denies this comment"}. Nothing was posted.`,
            {
              ...error.extra,
              fix: `Run 'ensemble delivery get ${taskId}' to see the task and policy, then rerun with a new --request-id.`,
            },
          );
        });
        const r = sent.receipt as Extract<CommandReceipt, { kind: "delivery" }>;
        const retry = reviewId
          ? "Create and confirm a new review to try again."
          : "After fixing the cause, rerun with a new --request-id.";
        if (r.state === "denied")
          throw new CliError(
            "policy-denied",
            `Denied: ${r.reason ?? "delivery authority denied"}. Nothing was posted; operation ${key} stays denied. ${retry}`,
            {
              request,
              fix: `Run 'ensemble delivery get ${taskId}' to see why the policy denied it.`,
            },
          );
        if (r.state === "confirmed-failure")
          throw new CliError(
            "conflict",
            `Failed: ${r.reason ?? "the provider refused it"}. Nothing was posted; operation ${key} stays failed. ${retry}`,
            {
              request,
              fix: `Run 'ensemble delivery get ${taskId}' to see the failure, fix its cause, then send again with a new --request-id.`,
            },
          );
        if (r.state !== "confirmed-success")
          throw new CliError(
            "command-outcome-unknown",
            `The comment's outcome is ${r.state}: it may or may not have been posted. ${UNKNOWN_GUIDANCE(taskId, key)}`,
            { retryable: true, request },
          );
        return {
          request: sent.request,
          data: { receipt: r, effect: "completed" },
          human: [
            reached
              ? `This request was sent before; the service returned its recorded outcome: the comment is posted (operation ${key}). Nothing new was posted.`
              : `Posted the comment on the task's GitHub issue (operation ${key}).`,
            "The comment is public and Ensemble cannot edit or retract it. Rerunning this exact command replays this receipt; a deliberate second comment needs a new --request-id.",
          ].join("\n"),
        };
      },
    },
  ],
]);
