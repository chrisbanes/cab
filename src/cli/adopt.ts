import { createHash, randomUUID } from "node:crypto";
import { assignmentDetailSchema } from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import { exactCommand, positiveIntFlag } from "./configure.js";
import { CliError } from "./connections.js";
import { receiptLines } from "./operation.js";
import { keyValues } from "./render.js";
import { connectWrite, TASK_WRITE, writeOutput } from "./task-write.js";
import {
  chooseKey,
  optionalRequestId,
  sendCommand,
  type WriteCommand,
  withConflictRemedy,
} from "./write.js";

export const withdrawFinalNote =
  "Withdrawal is final: the delegate produces no result and nothing restores it. To redo the work, the lead delegates again.";

export const adoptCommands = new Map<string, WriteCommand>([
  [
    "assignment apply-current",
    {
      usage:
        "assignment apply-current ASSIGNMENT_ID --expected-version N [--request-id UUID]",
      positionals: 1,
      expects:
        "--expected-version: the assignment's version ('cab assignment get ASSIGNMENT_ID'); required.",
      flags: ["expected-version", "request-id"],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
        const expected = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        );
        if (expected === undefined)
          throw new CliError("usage", "--expected-version N is required.");
        const requested = optionalRequestId(ctx.values);
        const session = await ctx.connect([
          "cli.identity",
          "assignment.read",
          "configuration.write",
        ]);
        const read = await session.client.get(
          `/api/operator/assignments/${id}`,
          assignmentDetailSchema,
        );
        const service = session.identity.service.installationId;
        // The material is the assignment and the version it was reviewed at.
        const digest = createHash("sha256")
          .update(`${service}\n${id}\n${expected}`)
          .digest("hex");
        const key =
          requested ??
          (await ctx.journal.find(service, digest)) ??
          randomUUID();
        const { receipt, request } = await withConflictRemedy(
          () =>
            sendCommand(ctx, session, {
              scope: `project:${read.data.projectId}`,
              type: "assignment.apply",
              key,
              digest,
              resource: id,
              command: {
                type: "assignment.apply",
                key,
                projectId: read.data.projectId,
                assignmentId: id,
                expectedVersion: expected,
              },
            }),
          {
            subject: `Assignment ${id}`,
            sent: expected,
            read: `cab assignment get ${id}`,
            current: () =>
              session.client
                .get(`/api/operator/assignments/${id}`, assignmentDetailSchema)
                .then((a) => ({
                  version: a.data.version,
                  state: a.data.state,
                })),
          },
        );
        return {
          request,
          data: { receipt },
          human: [
            `Adopted the current instructions for assignment ${id} (request ${key}).`,
            keyValues(receiptLines(receipt)),
            "The next turn uses these revisions; an active turn is not rewritten and nothing was dispatched.",
            "Adoption is one-way: to return to older text, restore it as a new revision and adopt again.",
          ].join("\n"),
        };
      },
    },
  ],
  [
    "assignment withdraw",
    {
      usage:
        "assignment withdraw ASSIGNMENT_ID --reason TEXT [--request-id UUID]",
      positionals: 1,
      flags: ["reason", "request-id"],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "ASSIGNMENT_ID");
        const reason = ctx.values.reason?.trim() ?? "";
        if (!reason || reason.length > 2000)
          throw new CliError(
            "usage",
            "--reason TEXT is required: why this delegate will not finish (at most 2000 characters).",
          );
        const session = await connectWrite(ctx, [
          ...TASK_WRITE,
          "assignment.read",
        ]);
        const read = (
          await session.client.get(
            `/api/operator/assignments/${id}`,
            assignmentDetailSchema,
          )
        ).data;
        const type = "assignment.withdraw";
        const scope = `task:${read.taskId}`;
        // The intent is this assignment and reason; the version read only fences the first send.
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope, type },
          { assignmentId: id, reason },
        );
        const withdrawal = read.withdrawal;
        if (!reused && withdrawal && !withdrawal.available)
          throw new CliError(
            "conflict",
            `Assignment ${id} cannot be withdrawn: ${withdrawal.refusal?.text ?? "the service refused it."}`,
            { fix: `Run 'cab assignment get ${id}' for its current state.` },
          );
        const command = {
          type,
          taskId: read.taskId,
          assignmentId: id,
          expectedVersion: read.version,
          reason,
        };
        const { receipt, request } = await withConflictRemedy(
          () =>
            sendCommand(ctx, session, {
              scope,
              type,
              key,
              digest,
              resource: id,
              command: exactCommand(command, key),
              match: (r) =>
                r.kind === "assignment-withdraw" && r.assignmentId === id,
            }),
          {
            subject: `Assignment ${id}`,
            sent: undefined,
            read: `cab assignment get ${id}`,
            current: () =>
              session.client
                .get(`/api/operator/assignments/${id}`, assignmentDetailSchema)
                .then((a) => ({
                  version: a.data.version,
                  state: a.data.state,
                })),
          },
        );
        const withdrawn =
          receipt.kind === "assignment-withdraw" ? receipt : undefined;
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "saved",
          summary: "Withdrew the delegate",
          lines: [
            ["Assignment", id],
            ["Lead", withdrawn?.leadAssignmentId ?? ""],
            ["Reason", reason],
          ],
          notes: [withdrawFinalNote],
        });
      },
    },
  ],
]);
