import { createHash, randomUUID } from "node:crypto";
import { assignmentDetailSchema } from "../operator/contracts.js";
import { uuidArg } from "./browse.js";
import { positiveIntFlag } from "./configure.js";
import { CliError } from "./connections.js";
import { receiptLines } from "./operation.js";
import { keyValues } from "./render.js";
import {
  optionalRequestId,
  sendCommand,
  type WriteCommand,
  withConflictRemedy,
} from "./write.js";

export const adoptCommands = new Map<string, WriteCommand>([
  [
    "assignment apply-current",
    {
      usage:
        "assignment apply-current ASSIGNMENT_ID --expected-version N [--request-id UUID]",
      positionals: 1,
      expects:
        "--expected-version: the assignment's version ('ensemble assignment get ASSIGNMENT_ID'); required.",
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
            read: `ensemble assignment get ${id}`,
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
]);
