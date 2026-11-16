import {
  type CommandReceipt,
  operationReadSchema,
  type TaskRead,
} from "../operator/contracts.js";
import {
  removalEvidenceText,
  removalRecordText,
  trimRecordText,
} from "../operator/workspace-maintenance-copy.js";
import { uuidArg } from "./browse.js";
import { CliError } from "./connections.js";
import { exactCommand } from "./configure.js";
import {
  connectWrite,
  readAfter,
  readTask,
  TASK_WRITE,
  writeOutput,
} from "./task-write.js";
import {
  chooseKey,
  optionalRequestId,
  sendCommand,
  type WriteCommand,
} from "./write.js";

const iso = (at: number) => new Date(at).toISOString();

/** The task read's latest trim and removal, with each repository's evidence, for `task get` and `task show`. */
export function workspaceRecordLines(data: TaskRead["data"]): string[] {
  const records = data.workspace;
  if (!records) return [];
  const names = new Map(
    (data.repositoryNames ?? []).map((r) => [r.repositoryId, r.name]),
  );
  return [
    ...(records.removal
      ? [
          `Workspace: ${removalRecordText(records.removal, iso(records.removal.at))}`,
          ...records.removal.repositories.map(
            (r) =>
              `  ${removalEvidenceText(r, names.get(r.repositoryId) ?? r.repositoryId)}`,
          ),
        ]
      : []),
    ...(records.trim
      ? [`Workspace: ${trimRecordText(records.trim, iso(records.trim.at))}`]
      : []),
  ];
}

export const taskWorkspaceCommands = new Map<string, WriteCommand>([
  [
    "task workspace-recheck",
    {
      usage: "task workspace-recheck TASK_ID [--request-id UUID]",
      positionals: 1,
      flags: ["request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const type = "task.workspace.recheck";
        const command = { type, taskId };
        // No pre-read: the service reruns the identity check and says what it found.
        const session = await connectWrite(ctx, TASK_WRITE);
        const scope = `task:${taskId}`;
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope, type },
          command,
        );
        const { receipt, request } = await sendCommand(ctx, session, {
          scope,
          type,
          key,
          digest,
          resource: taskId,
          command: exactCommand(command, key),
          match: (r) => r.kind === "workspace-recheck" && r.taskId === taskId,
        });
        const released =
          receipt.kind === "workspace-recheck" && receipt.released;
        return writeOutput({
          request,
          receipt,
          reused,
          effect: released ? "saved" : "none",
          summary: `Rechecked the workspace of task ${taskId}`,
          lines: [["Released", released ? "yes" : "no"]],
          notes: [
            released
              ? "Admission and other holds still decide when the queued turn starts."
              : "The workspace was not held; nothing changed.",
          ],
        });
      },
    },
  ],
  [
    "task workspace-remove",
    {
      usage: "task workspace-remove TASK_ID [--request-id UUID]",
      positionals: 1,
      flags: ["request-id"],
      async run(ctx) {
        const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
        const type = "task.workspace.remove";
        optionalRequestId(ctx.values);
        const session = await connectWrite(ctx, TASK_WRITE);
        // The read only names the workspace to remove; the service derives every safety check.
        const workspaceId = (await readTask(session, taskId)).data.workspace
          ?.workspaceId;
        if (!workspaceId)
          throw new CliError(
            "conflict",
            "This task has no workspace to remove; nothing was sent.",
          );
        const command = { type, taskId, workspaceId };
        const scope = `task:${taskId}`;
        // Keyed by task and workspace: an unresolved attempt for this workspace is reused, and a
        // new workspace generation gets a new key.
        const { key, digest, reused } = await chooseKey(
          ctx,
          session,
          { scope, type },
          command,
        );
        const isReceipt = (
          r: CommandReceipt,
        ): r is Extract<CommandReceipt, { kind: "workspace-remove" }> =>
          r.kind === "workspace-remove" &&
          r.key === key &&
          r.taskId === taskId &&
          r.workspaceId === workspaceId;
        // An attempt that may have applied is read back first; only an unrecorded one is resent,
        // and the service never repeats a deletion for it.
        const recorded = reused
          ? await session.client
              .get(
                `/api/operator/operations?${new URLSearchParams({ scope, type, key })}`,
                operationReadSchema,
              )
              .then((read) =>
                read.data.state === "recorded" && isReceipt(read.data.receipt)
                  ? read.data.receipt
                  : undefined,
              )
          : undefined;
        const identity = {
          service: session.identity.service.installationId,
          scope,
          type,
          key,
        };
        if (recorded)
          await ctx.journal
            .append(identity, digest, "recorded")
            .catch(() => undefined);
        const sent = recorded
          ? { receipt: recorded, request: identity }
          : await sendCommand(ctx, session, {
              scope,
              type,
              key,
              digest,
              resource: taskId,
              command: exactCommand(command, key),
              freezeBody: true,
              match: isReceipt,
            });
        const { request } = sent;
        // sendCommand accepted it only through `isReceipt`.
        const receipt = sent.receipt as Extract<
          CommandReceipt,
          { kind: "workspace-remove" }
        >;
        const after = await readAfter(session, taskId);
        // The task read names branches; without it, the receipt's commits in the same format.
        const evidence =
          after?.workspace?.removal?.workspaceId === workspaceId
            ? workspaceRecordLines(after).filter((line) =>
                line.startsWith("  "),
              )
            : receipt.repositories.map(
                (r) =>
                  `  ${removalEvidenceText({ ...r, branch: null }, r.repositoryId)}`,
              );
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "completed",
          summary: `Removed the workspace of task ${taskId}`,
          lines: [
            ["Workspace", workspaceId],
            ["Removed", iso(receipt.removedAt)],
            ["Operation", receipt.operationId],
          ],
          notes: [
            ...(evidence.length ? ["Evidence:", ...evidence] : []),
            "The task branch, change requests, results and conversations remain. A later turn gets a new workspace.",
          ],
        });
      },
    },
  ],
]);
