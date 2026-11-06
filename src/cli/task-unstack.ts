import {
  unstackReadSchema,
  unstackReceiptSchema,
} from "../operator/unstack-contracts.js";
import {
  unstackConfirmation,
  unstackConfirmationFor,
  unstackRecovery,
  unstackStatus,
  cancelStackedConfirmation,
} from "../operator/unstack-copy.js";
import { operationReadSchema } from "../operator/contracts.js";
import { coverage, uuidArg, type BrowseCommand } from "./browse.js";
import { exactCommand, positiveIntFlag } from "./configure.js";
import { CliError } from "./connections.js";
import { connectWrite, TASK_WRITE, writeOutput } from "./task-write.js";
import { requestKey, sendCommand, type WriteCommand } from "./write.js";
export const unstackBrowseCommands = new Map<string, BrowseCommand>([
  [
    "task unstack-preview",
    {
      usage: "task unstack-preview TASK_ID",
      positionals: 1,
      capabilities: ["cli.identity", "task.read"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID"),
          client = await ctx.connect();
        const read = await client.get(
            `/api/operator/tasks/${taskId}/unstack`,
            unstackReadSchema,
          ),
          d = read.data,
          p = d.preview;
        return {
          data: d,
          coverage: coverage(
            read.observedAt,
            d.unavailable === "unproved" ? ["content-unavailable"] : [],
          ),
          human: [
            unstackConfirmationFor(p?.codeHost ?? "github"),
            unstackRecovery,
            d.operation
              ? unstackStatus(d.operation)
              : "No recorded Unstack operation.",
            p
              ? `${p.stackNumber === null ? "Stack" : `Stack #${p.stackNumber}`} in ${p.repository}: ${p.members.map((m) => `#${m.number} (${m.state})`).join(", ")}. Retarget #${p.selectedPr} to ${p.targetBase}.\nExpected version: ${p.expectedVersion}\nMaterial hash: ${p.materialHash}`
              : `Unavailable: ${d.unavailable ?? "unproved"}`,
          ].join("\n"),
        };
      },
    },
  ],
]);
export const unstackWriteCommands = new Map<string, WriteCommand>([
  [
    "task unstack",
    {
      usage:
        "task unstack TASK_ID --expected-version N --material-hash SHA256 --yes [--request-id UUID]",
      positionals: 1,
      flags: ["expected-version", "material-hash", "yes", "request-id"],
      expects:
        "--expected-version checks the task version captured by unstack-preview; --material-hash binds that exact full-stack preview.",
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID"),
          expectedVersion = positiveIntFlag(
            ctx.values["expected-version"],
            "expected-version",
          ),
          materialHash = ctx.values["material-hash"];
        if (
          !ctx.values.yes ||
          !expectedVersion ||
          !materialHash ||
          !/^[0-9a-f]{64}$/.test(materialHash)
        )
          throw new CliError(
            "usage",
            `Read 'task unstack-preview TASK_ID', then provide its exact version/hash and --yes. ${unstackConfirmation} ${unstackRecovery}`,
          );
        const command = {
            type: "task.unstack",
            taskId,
            expectedVersion,
            materialHash,
          },
          session = await connectWrite(ctx, TASK_WRITE),
          scope = `task:${taskId}`;
        const {
          key,
          digest,
          reached: reused,
        } = await requestKey(ctx, session, { scope, type: command.type }, [
          command,
        ]);
        // An uncertain journal entry is reconciled by GET only, never by another command POST.
        const request = {
          service: session.identity.service.installationId,
          scope,
          type: command.type,
          key,
        };
        const prior = await ctx.journal.state(request);
        if (prior && prior.digest !== digest)
          throw new CliError(
            "conflict",
            "Original command body differs for this key.",
          );
        if (prior?.reached) {
          const read = await session.client.get(
            `/api/operator/operations?${new URLSearchParams({ scope, type: command.type, key })}`,
            operationReadSchema,
          );
          if (read.data.state !== "recorded")
            throw new CliError(
              "command-outcome-unknown",
              "The original receipt is unavailable. Keep this key and check with operation get; do not send a new operation.",
              { retryable: true, request },
            );
          const r = unstackReceiptSchema.parse(read.data.receipt);
          if (
            r.key !== key ||
            r.taskId !== taskId ||
            r.expectedVersion !== expectedVersion ||
            r.materialHash !== materialHash
          )
            throw new CliError(
              "conflict",
              "Original Unstack material differs.",
            );
          await ctx.journal.append(
            {
              service: session.identity.service.installationId,
              scope,
              type: command.type,
              key,
            },
            digest,
            "recorded",
          );
          return writeOutput({
            request,
            receipt: r,
            reused: true,
            effect: r.phase === "confirmed" ? "queued" : "saved",
            summary: unstackStatus(r),
            lines: [
              ["Operation", key],
              ["Phase", r.phase],
            ],
            notes: [unstackRecovery],
            data: r,
          });
        }
        try {
          const { receipt } = await sendCommand(ctx, session, {
            scope,
            type: command.type,
            key,
            digest,
            resource: taskId,
            command: exactCommand(command, key),
            match: (r) =>
              r.kind === "task-unstack" &&
              r.taskId === taskId &&
              r.expectedVersion === expectedVersion &&
              r.materialHash === materialHash,
          });
          const r = unstackReceiptSchema.parse(receipt);
          return writeOutput({
            request,
            receipt,
            reused,
            effect: r.phase === "confirmed" ? "queued" : "saved",
            summary: unstackStatus(r),
            lines: [
              ["Operation", key],
              ["Phase", r.phase],
            ],
            notes: [unstackRecovery],
            data: r,
          });
        } catch (error) {
          if (
            error instanceof CliError &&
            error.code === "command-outcome-unknown"
          )
            throw new CliError(
              error.code,
              `Outcome unknown. Check the ORIGINAL operation with 'cab operation get ${key} --scope ${scope} --type task.unstack'. Do not send again or choose a new key.`,
              error.extra,
            );
          throw error;
        }
      },
    },
  ],
  [
    "task cancel",
    {
      usage:
        "task cancel TASK_ID --expected-version N --yes [--request-id UUID]",
      positionals: 1,
      flags: ["expected-version", "yes", "request-id"],
      expects:
        "--expected-version checks the task version before failed-blocker Cancel.",
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID"),
          expectedVersion = positiveIntFlag(
            ctx.values["expected-version"],
            "expected-version",
          );
        if (!ctx.values.yes || !expectedVersion)
          throw new CliError(
            "usage",
            `--expected-version and --yes are required. ${cancelStackedConfirmation}`,
          );
        const command = { type: "task.cancel", taskId, expectedVersion },
          session = await connectWrite(ctx, TASK_WRITE),
          scope = `task:${taskId}`;
        const {
          key,
          digest,
          reached: reused,
        } = await requestKey(ctx, session, { scope, type: command.type }, [
          command,
        ]);
        const request = {
          service: session.identity.service.installationId,
          scope,
          type: command.type,
          key,
        };
        const prior = await ctx.journal.state(request);
        if (prior && prior.digest !== digest)
          throw new CliError(
            "conflict",
            "Original Cancel body differs for this key.",
          );
        if (prior?.reached) {
          const read = await session.client.get(
            `/api/operator/operations?${new URLSearchParams({ scope, type: command.type, key })}`,
            operationReadSchema,
          );
          if (
            read.data.state !== "recorded" ||
            read.data.receipt.kind !== "task-cancel" ||
            read.data.receipt.taskId !== taskId ||
            read.data.receipt.key !== key
          )
            throw new CliError(
              "command-outcome-unknown",
              "Original Cancel receipt unavailable. Check the original key; do not send again.",
              { retryable: true, request },
            );
          await ctx.journal.append(request, digest, "recorded");
          return writeOutput({
            request,
            receipt: read.data.receipt,
            reused: true,
            effect: "saved",
            summary: "Original task Cancel recorded",
            lines: [],
            notes: [
              cancelStackedConfirmation,
              "Unresolved ownership remains held.",
            ],
            data: read.data.receipt,
          });
        }
        const { receipt } = await sendCommand(ctx, session, {
          scope,
          type: command.type,
          key,
          digest,
          resource: taskId,
          command: exactCommand(command, key),
          match: (r) => r.kind === "task-cancel" && r.taskId === taskId,
        }).catch((error: unknown) => {
          if (
            error instanceof CliError &&
            error.code === "command-outcome-unknown"
          )
            throw new CliError(
              error.code,
              `Cancel outcome unknown. Check 'cab operation get ${key} --scope ${scope} --type task.cancel'. Keep the original key; do not send again.`,
              error.extra,
            );
          throw error;
        });
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "cancellation-requested",
          summary: `Cancelled task ${taskId}`,
          lines: [],
          notes: [cancelStackedConfirmation],
          data: receipt,
        });
      },
    },
  ],
]);
