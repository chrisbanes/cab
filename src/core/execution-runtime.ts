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

/** Shape only; the installed integration narrows supported values. */
const runtimeSetting = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^\S+$/)
  .nullable();

export const profileRuntimeSchema = z.discriminatedUnion("harness", [
  // Optional, with no default: a profile without settings stays `{ harness: "codex" }` in
  // stored rows and recorded commands.
  z
    .object({
      harness: z.literal("codex"),
      // `default` is the catalogue's name for "no model", which is stored as null.
      model: runtimeSetting
        .refine((model) => model !== "default", {
          message: "Use no model, not `default`",
        })
        .optional(),
      reasoningEffort: runtimeSetting.optional(),
    })
    .strict(),
  z
    .object({
      harness: z.literal("claude"),
      model: runtimeSetting,
      reasoningEffort: runtimeSetting,
    })
    .strict(),
]);
export type ProfileRuntime = z.infer<typeof profileRuntimeSchema>;
/** A new profile's runtime: the first enabled harness, else Codex, with default settings. */
export function defaultProfileRuntime(
  enabled: readonly ExecutionHarness[],
): ProfileRuntime {
  return enabled[0] === "claude"
    ? { harness: "claude", model: null, reasoningEffort: null }
    : { harness: "codex" };
}

/** Operator-facing harness names, shared by waits, alerts and the UI. */
export const executionHarnessLabels: Record<ExecutionHarness, string> = {
  codex: "Codex",
  claude: "Claude",
};

/** "Codex", "Codex · gpt-x · high", "Claude · sonnet · high" or "Claude · default model and effort". */
export function runtimeSummary(runtime: ProfileRuntime): string {
  const label = executionHarnessLabels[runtime.harness];
  const model = runtime.model ?? null;
  const effort = runtime.reasoningEffort ?? null;
  if (model === null && effort === null)
    return runtime.harness === "codex"
      ? label
      : `${label} · default model and effort`;
  return [label, model ?? "default model", effort ?? "default effort"].join(
    " · ",
  );
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

/** The field a runtime fails against supported settings; `default` is the unset model. */
export function unsupportedRuntimeField(
  runtime: ProfileRuntime,
  supported: SupportedRuntimeSettings,
): "runtime.model" | "runtime.reasoningEffort" | null {
  const model = runtime.model ?? null;
  const effort = runtime.reasoningEffort ?? null;
  if (runtime.harness === "codex" && model === null && effort === null)
    return null;
  const entry =
    runtime.harness === "codex" && model === "default"
      ? undefined
      : supported.models.find((m) => m.model === (model ?? "default"));
  if (!entry) return "runtime.model";
  return effort !== null && !entry.efforts.includes(effort)
    ? "runtime.reasoningEffort"
    : null;
}
