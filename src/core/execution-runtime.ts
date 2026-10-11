import { z } from "zod";

/** Closed so harness-specific mappings stay exhaustive. */
export const executionHarnessSchema = z.enum(["codex", "claude"]);
export type ExecutionHarness = z.infer<typeof executionHarnessSchema>;
export const defaultExecutionHarness: ExecutionHarness = "codex";

/** Shape only; the installed Claude integration narrows supported values (C3). */
const runtimeSetting = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^\S+$/)
  .nullable();

export const profileRuntimeSchema = z.discriminatedUnion("harness", [
  z.object({ harness: z.literal("codex") }).strict(),
  z
    .object({
      harness: z.literal("claude"),
      model: runtimeSetting,
      reasoningEffort: runtimeSetting,
    })
    .strict(),
]);
export type ProfileRuntime = z.infer<typeof profileRuntimeSchema>;
export const defaultProfileRuntime: ProfileRuntime = { harness: "codex" };

/** Operator-facing harness names, shared by waits, alerts and the UI. */
export const executionHarnessLabels: Record<ExecutionHarness, string> = {
  codex: "Codex",
  claude: "Claude",
};

/** "Codex", "Claude · sonnet · high" or "Claude · default model and effort". */
export function runtimeSummary(runtime: ProfileRuntime): string {
  const label = executionHarnessLabels[runtime.harness];
  if (runtime.harness === "codex") return label;
  if (runtime.model === null && runtime.reasoningEffort === null)
    return `${label} · default model and effort`;
  return [
    label,
    runtime.model ?? "default model",
    runtime.reasoningEffort ?? "default effort",
  ].join(" · ");
}
