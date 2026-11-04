import { projectSchema, operationReadSchema } from "../operator/contracts.js";
import { projectDeletePreviewSchema } from "../operator/project-lifecycle-contracts.js";
import {
  archivedProjectNotice,
  projectDeletionWarning,
  projectExternalRetention,
  retainedProjectLine,
} from "../operator/project-lifecycle-copy.js";
import { uuidArg } from "./browse.js";
import { positiveIntFlag } from "./configure.js";
import { CliError } from "./connections.js";
import { connectWrite } from "./task-write.js";
import {
  chooseKey,
  sendCommand,
  carryRetryFlags,
  type WriteCommand,
  type Session,
} from "./write.js";
import type { CommandReceipt } from "../operator/contracts.js";
import type { RequestIdentity } from "./types.js";
const API = "/api/operator";
const capabilities = [
  "cli.identity",
  "project.lifecycle",
  "workspace.read",
  "configuration.write",
  "operation.read",
];
async function lookup(session: Session, id: string, type: string, key: string) {
  return session.client.get(
    `${API}/operations?${new URLSearchParams({ scope: `project:${id}`, type, key })}`,
    operationReadSchema,
  );
}
async function output(
  session: Session,
  id: string,
  receipt: CommandReceipt,
  request?: RequestIdentity,
) {
  const after = await session.client
    .get(`${API}/projects/${id}`, projectSchema)
    .catch(() => undefined);
  const result = receipt.kind === "configuration" ? receipt.result : undefined;
  const deleted = result?.commandType === "project.delete";
  const state = after?.data;
  return {
    ...(request ? { request } : {}),
    data: { receipt, ...(state ? { project: state } : {}) },
    human: [
      deleted
        ? "Project deleted. There is no undo."
        : result?.commandType === "project.archive"
          ? archivedProjectNotice
          : "Project restored and paused.",
      state?.state === "deleted"
        ? `Cleanup: ${state.tombstone.cleanup.state} (${state.tombstone.cleanup.pending} pending).`
        : deleted
          ? "Cleanup status unavailable; read the project again."
          : "",
      ...(state?.state === "deleted"
        ? [
            `Removed ${state.tombstone.counts.tasks} tasks, ${state.tombstone.counts.assignments} assignments and ${state.tombstone.counts.worktrees} worktrees.`,
            projectExternalRetention,
            ...state.tombstone.externalRemnants.map(retainedProjectLine),
          ]
        : []),
      `Request: ${receipt.key}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
const lifecycle = (verb: "archive" | "restore"): [string, WriteCommand] => [
  `project ${verb}`,
  {
    usage: `project ${verb} PROJECT_ID [--expected-version N] [--request-id UUID]`,
    positionals: 1,
    expects:
      "--expected-version checks the project version from cab project get; omitted only for a new request, never substituted on retry.",
    flags: ["expected-version", "request-id"],
    async run(ctx) {
      const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID"),
        provided = positiveIntFlag(
          ctx.values["expected-version"],
          "expected-version",
        ),
        type = `project.${verb}`;
      const session = await connectWrite(ctx, capabilities),
        scope = `project:${id}`;
      const { key, digest, reused } = await chooseKey(
        ctx,
        session,
        { scope, type },
        { projectId: id },
      );
      if (reused) {
        const read = await lookup(session, id, type, key);
        if (read.data.state === "recorded") {
          const receipt = read.data.receipt;
          const request = {
            service: session.identity.service.installationId,
            scope,
            type,
            key,
          };
          if (
            receipt.kind !== "configuration" ||
            receipt.key !== key ||
            receipt.result.commandType !== type ||
            receipt.result.resourceId !== id
          )
            throw new CliError(
              "command-outcome-unknown",
              "The original operation did not return the matching lifecycle receipt.",
              { request, retryable: true },
            );
          if (
            provided !== undefined &&
            (!("version" in receipt.result) ||
              receipt.result.version !== provided + 1)
          )
            throw new CliError(
              "conflict",
              "This request key belongs to another original version; nothing was sent.",
              { request },
            );
          return output(session, id, receipt, request);
        }
        if (provided === undefined)
          throw new CliError(
            "command-outcome-unknown",
            "Use the original --expected-version and --request-id to retry; do not substitute the current version.",
            {
              retryable: true,
              request: {
                service: session.identity.service.installationId,
                scope,
                type,
                key,
              },
            },
          );
      }
      let expectedVersion = provided;
      if (expectedVersion === undefined) {
        const read = await session.client.get(
          `${API}/projects/${id}`,
          projectSchema,
        );
        if (read.data.state === "deleted")
          throw new CliError("conflict", "This project is deleted.");
        expectedVersion = read.data.project.version;
      }
      try {
        const sent = await sendCommand(ctx, session, {
          scope,
          type,
          key,
          digest,
          resource: id,
          freezeBody: true,
          command: { type, key, projectId: id, expectedVersion },
        });
        return output(session, id, sent.receipt, sent.request);
      } catch (error) {
        return carryRetryFlags(
          error,
          key,
          `--expected-version ${expectedVersion}`,
        );
      }
    },
  },
];
export const projectLifecycleCommands = new Map<string, WriteCommand>([
  lifecycle("archive"),
  lifecycle("restore"),
  [
    "project delete",
    {
      usage:
        "project delete PROJECT_ID --preview | --confirm-name NAME --expected-version N --preview-digest DIGEST [--request-id UUID]",
      positionals: 1,
      expects:
        "--expected-version checks the archived project version from the inspected deletion preview; required with the exact name and digest.",
      flags: [
        "preview",
        "confirm-name",
        "expected-version",
        "preview-digest",
        "request-id",
      ],
      async run(ctx) {
        const id = uuidArg(ctx.positionals[2] ?? "", "PROJECT_ID");
        if (ctx.values.preview) {
          if (
            (
              [
                "confirm-name",
                "expected-version",
                "preview-digest",
                "request-id",
              ] as const
            ).some((name) => ctx.values[name] !== undefined)
          )
            throw new CliError(
              "usage",
              "--preview cannot be combined with confirmation or request flags.",
            );
          const session = await ctx.connect([
            "cli.identity",
            "workspace.read",
            "project.lifecycle",
          ]);
          const read = await session.client.get(
              `${API}/projects/${id}/delete-preview`,
              projectDeletePreviewSchema,
            ),
            p = read.data;
          return {
            data: p,
            human: [
              `Delete preview: ${p.name ?? "name unavailable"} (${p.projectId}), version ${p.version}`,
              `${p.counts.tasks} tasks, ${p.counts.assignments} assignments, ${p.counts.worktrees} worktrees.`,
              projectDeletionWarning,
              ...p.worktrees.map(
                (w) =>
                  `${w.kind} worktree: dirty ${w.dirty}, unpushed ${w.unpushed}, inspection ${w.inspection}.`,
              ),
              ...p.affectedProjects.map(
                (project) =>
                  `Selection released in ${project.name ?? project.projectId}.`,
              ),
              projectExternalRetention,
              ...p.externalRemnants.map(retainedProjectLine),
              `Preview digest: ${p.previewDigest}`,
            ].join("\n"),
          };
        }
        const confirmationName = ctx.values["confirm-name"],
          previewDigest = ctx.values["preview-digest"],
          expectedVersion = positiveIntFlag(
            ctx.values["expected-version"],
            "expected-version",
          );
        if (
          typeof confirmationName !== "string" ||
          !confirmationName.length ||
          confirmationName.length > 512 ||
          typeof previewDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(previewDigest) ||
          expectedVersion === undefined
        )
          throw new CliError(
            "usage",
            "Deletion requires --confirm-name, --expected-version and --preview-digest from the inspected preview.",
          );
        const session = await connectWrite(ctx, capabilities),
          type = "project.delete",
          scope = `project:${id}`,
          material = {
            type,
            projectId: id,
            confirmationName,
            expectedVersion,
            previewDigest,
          };
        const { key, digest } = await chooseKey(
          ctx,
          session,
          { scope, type },
          material,
        );
        const sent = await sendCommand(ctx, session, {
          scope,
          type,
          key,
          digest,
          resource: id,
          freezeBody: true,
          command: { ...material, key },
        });
        return output(session, id, sent.receipt, sent.request);
      },
    },
  ],
]);
