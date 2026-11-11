import { uuidArg } from "./browse.js";
import { exactCommand } from "./configure.js";
import { connectWrite, TASK_WRITE, writeOutput } from "./task-write.js";
import { chooseKey, sendCommand, type WriteCommand } from "./write.js";

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
]);
