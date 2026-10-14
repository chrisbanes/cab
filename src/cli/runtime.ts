import { executionHarnessSchema } from "../core/execution-runtime.js";
import {
  executionHarnessLabels,
  type HarnessStatus,
  runtimeSettingsSchema,
  workspaceSchema,
} from "../operator/contracts.js";
import { type BrowseCommand, browseOutput, enumArg } from "./browse.js";
import { exactCommand } from "./configure.js";
import { CliError } from "./connections.js";
import { table } from "./render.js";
import { connectWrite, writeOutput } from "./task-write.js";
import { chooseKey, sendCommand, type WriteCommand } from "./write.js";

const API = "/api/operator";

/** "Available", "Not enabled (Disabled in Settings)", "Unavailable" and so on. */
function stateLabel(status: HarnessStatus | undefined): string {
  if (!status) return "Unknown";
  if (status.state === "available") return "Available";
  if (status.state === "unavailable") return "Unavailable";
  return status.reason === "disabled"
    ? "Not enabled (Disabled in Settings)"
    : `Not enabled (\`${status.harness}\` not found on PATH)`;
}

const runtimeList: BrowseCommand = {
  usage: "runtime list",
  positionals: 0,
  capabilities: ["cli.identity", "workspace.read", "capacity.read"],
  async run(ctx) {
    const client = await ctx.connect();
    const [workspace, settings] = await Promise.all([
      client.get(`${API}/workspace`, workspaceSchema),
      client.get(`${API}/runtime`, runtimeSettingsSchema),
    ]);
    const runtimes = settings.data.runtimes.map((r) => {
      const status = workspace.data.harnesses.find(
        (h) => h.harness === r.harness,
      );
      return {
        harness: r.harness,
        enabled: r.enabled,
        state: status?.state ?? null,
        reason: status?.state === "not-configured" ? status.reason : null,
        boundTasks: r.boundTasks,
        label: stateLabel(status),
      };
    });
    return browseOutput(ctx, {
      data: {
        runtimes: runtimes.map(({ label: _label, ...runtime }) => runtime),
      },
      observedAt: Math.min(workspace.observedAt, settings.observedAt),
      human: table(
        ["RUNTIME", "SETTING", "STATE", "BOUND TASKS"],
        runtimes.map((r) => [
          r.harness,
          r.enabled ? "enabled" : "disabled",
          r.label,
          String(r.boundTasks),
        ]),
      ),
    });
  },
};

const toggle = (verb: "enable" | "disable"): [string, WriteCommand] => [
  `runtime ${verb}`,
  {
    usage: `runtime ${verb} codex|claude${verb === "disable" ? " [--yes]" : ""} [--request-id UUID]`,
    positionals: 1,
    flags: verb === "disable" ? ["yes", "request-id"] : ["request-id"],
    async run(ctx) {
      const harness = enumArg(
        ctx.positionals[2] ?? "",
        executionHarnessSchema.options,
        "RUNTIME",
      );
      if (!harness)
        throw new CliError("usage", "Name a runtime: codex or claude.");
      const enabled = verb === "enable";
      const session = await connectWrite(ctx, [
        "cli.identity",
        "configuration.write",
        "capacity.read",
      ]);
      // --yes confirms the bound-task count read now; the server refuses if it has grown.
      const confirmedBoundTasks =
        ctx.values.yes === true
          ? (
              await session.client.get(`${API}/runtime`, runtimeSettingsSchema)
            ).data.runtimes.find((r) => r.harness === harness)?.boundTasks
          : undefined;
      const command = {
        type: "runtime.configure",
        harness,
        enabled,
        ...(confirmedBoundTasks === undefined ? {} : { confirmedBoundTasks }),
      };
      const scope = `system:runtime:${harness}`;
      const type = "runtime.configure";
      const { key, digest, reused } = await chooseKey(
        ctx,
        session,
        { scope, type },
        command,
      );
      try {
        const { receipt, request } = await sendCommand(ctx, session, {
          scope,
          type,
          key,
          digest,
          resource: scope,
          command: exactCommand(command, key),
        });
        const label = executionHarnessLabels[harness];
        return writeOutput({
          request,
          receipt,
          reused,
          effect: "saved",
          summary: `${enabled ? "Enabled" : "Disabled"} ${label}`,
          notes: [
            enabled
              ? `Reverse with 'runtime disable ${harness}'. Check 'runtime list' for whether it started.`
              : `Running turns finish; work bound to ${label} waits until it is enabled again. Reverse with 'runtime enable ${harness}'.`,
          ],
        });
      } catch (error) {
        if (
          error instanceof CliError &&
          error.code === "runtime-confirmation-required"
        )
          throw new CliError(
            error.code,
            `${error.message} Re-run with --yes to disable it.`,
            error.extra,
          );
        throw error;
      }
    },
  },
];

export const runtimeBrowseCommands: [string, BrowseCommand][] = [
  ["runtime list", runtimeList],
];

export const runtimeWriteCommands = new Map<string, WriteCommand>([
  toggle("enable"),
  toggle("disable"),
]);
