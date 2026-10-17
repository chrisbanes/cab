import { uuidArg } from "./browse.js";
import { exactCommand, positiveIntFlag } from "./configure.js";
import {
  connectWrite,
  type Effect,
  followLines,
  readAfter,
  TASK_WRITE,
  taskStatusLines,
  taskVersion,
  writeOutput,
} from "./task-write.js";
import {
  chooseKey,
  sendCommand,
  type WriteCommand,
  withConflictRemedy,
} from "./write.js";

const control = (verb: "stop" | "resume"): [string, WriteCommand] => [
  `task ${verb}`,
  {
    usage: `task ${verb} TASK_ID [--expected-version N] [--request-id UUID]`,
    positionals: 1,
    flags: ["expected-version", "request-id"],
    async run(ctx) {
      const taskId = uuidArg(ctx.positionals[2] ?? "", "TASK_ID");
      const expectedVersion = positiveIntFlag(
        ctx.values["expected-version"],
        "expected-version",
      );
      const type = `task.${verb}`;
      const command = {
        type,
        taskId,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      };
      // No pre-read: a failing read must never block a Stop.
      const session = await connectWrite(ctx, TASK_WRITE);
      const scope = `task:${taskId}`;
      const { key, digest, reused } = await chooseKey(
        ctx,
        session,
        { scope, type },
        command,
      );
      const { receipt, request } = await withConflictRemedy(
        () =>
          sendCommand(ctx, session, {
            scope,
            type,
            key,
            digest,
            resource: taskId,
            command: exactCommand(command, key),
            match: (r) =>
              r.kind === `task-${verb}` && "taskId" in r && r.taskId === taskId,
          }),
        taskVersion(session, taskId, expectedVersion),
      );
      const after = await readAfter(session, taskId);
      const stopInEffect = after ? after.execution.holds.stop : null;
      let effect: Effect = "saved";
      const notes: string[] = [];
      const lines: [string, string][] = [];
      if (receipt.kind === "task-stop") {
        lines.push([
          "Cancellation requested",
          String(receipt.cancellationRequested),
        ]);
        if (receipt.cancellationRequested > 0)
          effect = "cancellation-requested";
        notes.push(
          "Stop is best-effort cancellation: new turns are held, and effects may continue until termination is verified.",
          "Reverse with 'task resume'.",
        );
      } else if (receipt.kind === "task-resume") {
        lines.push(["Requeued", String(receipt.requeued)]);
        if (!receipt.stopCleared) effect = "none";
        else if (receipt.requeued > 0) effect = "queued";
        const remaining = after
          ? Object.entries(after.execution.holds)
              .filter(([name, held]) => held && name !== "stop")
              .map(([name]) => name)
          : [];
        notes.push(
          receipt.stopCleared
            ? "Resume cleared only the operator Stop."
            : "No operator Stop was in effect; nothing changed.",
          ...(remaining.length
            ? [`No work started: still held by ${remaining.join(", ")}.`]
            : []),
        );
      }
      // A reused key replays its old receipt; say so when that contradicts the request.
      if (stopInEffect === (verb === "resume"))
        notes.push(
          `This receipt does not match the current state: Stop is ${stopInEffect ? "" : "not "}in effect. It may replay an earlier request; run again with a new --request-id to ${verb} the task now.`,
        );
      if (verb === "resume") notes.push(...followLines(after, taskId));
      return writeOutput({
        request,
        receipt,
        reused,
        effect,
        summary: `${verb === "stop" ? "Stopped" : "Resumed"} task ${taskId}`,
        lines: [...lines, ...(after ? taskStatusLines(after) : [])],
        notes,
        data: { stopInEffect },
      });
    },
  },
];

export const taskControlCommands = new Map<string, WriteCommand>([
  control("stop"),
  control("resume"),
]);
