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

/**
 * Skill plugins a profile enables, each with the names of its skills the profile enables:
 * an absolute local directory on the service host (`path`), or a plugin the operator
 * installed and enabled in Claude Code or Codex (`plugin`, `claude:<plugin>@<marketplace>`
 * or `codex:<plugin>@<marketplace>`). Shared by both harnesses, so it is not part of the
 * runtime JSON. A plugin contributes skills, instructions and scripts only.
 */
export const skillNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** Each id part is one path segment: no separator, no `.`/`..`, never empty. */
const installedIdPart = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
export const installedPluginRefSchema = z
  .string()
  .regex(new RegExp(`^(claude|codex):${installedIdPart}@${installedIdPart}$`));
export type InstalledPluginRef = z.infer<typeof installedPluginRefSchema>;
const enabledSkillsSchema = z
  .array(skillNameSchema)
  .min(1)
  .max(32)
  .refine((names) => new Set(names).size === names.length, {
    message: "Duplicate skill",
  });
/** A profile plugin entry's identity: its directory, or its tool-qualified id. */
export const profilePluginKey = (
  plugin: { path: string } | { plugin: string },
): string => ("path" in plugin ? plugin.path : plugin.plugin);
export const profileSkillsSchema = z
  .object({
    plugins: z
      .array(
        z.union([
          z
            .object({
              path: z
                .string()
                .max(1024)
                .regex(/^\/[^\0]*[^/\0]$/)
                // One spelling per directory: duplicates and digests compare it.
                .refine((path) => !/\/\/|\/\.{1,2}(\/|$)/.test(path), {
                  message: "Path must be normalised",
                }),
              skills: enabledSkillsSchema,
            })
            .strict(),
          z
            .object({
              plugin: installedPluginRefSchema,
              skills: enabledSkillsSchema,
            })
            .strict(),
        ]),
      )
      .max(16)
      .refine(
        (plugins) =>
          new Set(plugins.map(profilePluginKey)).size === plugins.length,
        { message: "Duplicate plugin" },
      ),
  })
  .strict();
export type ProfileSkills = z.infer<typeof profileSkillsSchema>;
export type ProfilePlugin = ProfileSkills["plugins"][number];
export const noProfileSkills: ProfileSkills = { plugins: [] };
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

/** The tools an installed skill plugin comes from, by their own names. */
export const pluginToolLabels: Record<ExecutionHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
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
