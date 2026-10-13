import { z } from "zod";

/** Closed so harness-specific mappings stay exhaustive. */
export const executionHarnessSchema = z.enum(["codex", "claude"]);
export type ExecutionHarness = z.infer<typeof executionHarnessSchema>;
export const defaultExecutionHarness: ExecutionHarness = "codex";

/** Persisted execution-intent lifecycle; the operator contract adds "unknown". */
export const executionIntentStateSchema = z.enum([
  "ready",
  "capacity-waiting",
  "held",
  "submitting",
  "running",
  "completed",
  "reconciled",
  "resolved-failed",
]);
export type ExecutionIntentState = z.infer<typeof executionIntentStateSchema>;

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

/** Values the installed integration supports: each model with its reasoning efforts. */
export const supportedRuntimeSettingsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            model: z.string().regex(/^\S{1,128}$/),
            efforts: z.array(z.string().regex(/^\S{1,128}$/)).max(16),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type SupportedRuntimeSettings = z.infer<
  typeof supportedRuntimeSettingsSchema
>;

/** The field a Claude runtime fails against supported settings; `default` is the unset model. */
export function unsupportedRuntimeField(
  runtime: ProfileRuntime,
  supported: SupportedRuntimeSettings,
): "runtime.model" | "runtime.reasoningEffort" | null {
  if (runtime.harness !== "claude") return null;
  const entry = supported.models.find(
    (m) => m.model === (runtime.model ?? "default"),
  );
  if (!entry) return "runtime.model";
  return runtime.reasoningEffort !== null &&
    !entry.efforts.includes(runtime.reasoningEffort)
    ? "runtime.reasoningEffort"
    : null;
}
