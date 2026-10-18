import {
  executionHarnessLabels,
  runtimeSummary,
  type HarnessStatus,
  type ProfileRuntime,
  type SupportedRuntimeSettings,
  type TaskRead,
  unsupportedRuntimeField,
} from "../../src/operator/contracts.js";
import {
  settingsFix,
  unavailableAlert as unavailableAlertText,
  unavailableNote,
} from "../../src/operator/runtime-restart-copy.js";
export { runtimeSummary };
import type { Values } from "./settings-changes.js";
import { settingsSectionHref } from "./settings-sections.js";

export const harnessStateLabel: Record<HarnessStatus["state"], string> = {
  available: "Available",
  "not-configured": "Not enabled",
  unavailable: "Unavailable",
};

/** Why a runtime is in its state and what to do about it; null when it is available. */
export function harnessReason(status: HarnessStatus) {
  if (status.state === "unavailable") return settingsFix(status.restart);
  if (status.state === "available") return null;
  return status.reason === "disabled"
    ? "Disabled in Settings"
    : `\`${status.harness}\` not found on PATH`;
}

/** Message for an enable the service refused because the executable is missing. */
export const executableMissingMessage = (harness: HarnessStatus["harness"]) =>
  `${executionHarnessLabels[harness]} was not turned on: \`${harness}\` not found on the service PATH.`;

/** Recovery for a runtime whose executable is not on the service PATH: install it, then restart the runtime. */
const installAdvice = (harness: HarnessStatus["harness"]) =>
  `Install \`${harness}\` on the service PATH, then turn it off and on in Settings → Runtime.`;

/** A wait reason does not say which cause: the runtime is off, or on but its executable is missing. */
const notEnabledAdvice = (harness: HarnessStatus["harness"]) =>
  `If it is off, turn it on in Settings → Runtime; if that is refused, install \`${harness}\` on the service PATH first. If it is already on, install \`${harness}\` on the service PATH, then turn it off and on there.`;

/** The confirmation body for disabling a runtime that tasks use. */
export const disableConfirmation = (
  harness: HarnessStatus["harness"],
  tasks: number,
) => {
  const label = executionHarnessLabels[harness];
  return `${tasks === 1 ? "1 task uses" : `${tasks} tasks use`} ${label}. Running turns finish; their next turns wait until ${label} is enabled again.`;
};

/** Shell alert copy; the server-rendered Runtime page repeats it. */
export const unavailableAlert = unavailableAlertText;

/** Draft values of the profile runtime fields. */
export const runtimeValues = (runtime: ProfileRuntime): Values => ({
  runtimeHarness: runtime.harness,
  runtimeModel: runtime.model ?? "",
  runtimeEffort: runtime.reasoningEffort ?? "",
});

export function runtimeCommand(v: Values): ProfileRuntime {
  const value = (x: unknown) => String(x ?? "").trim() || null;
  const model = value(v.runtimeModel),
    reasoningEffort = value(v.runtimeEffort);
  if (v.runtimeHarness === "claude")
    return { harness: "claude", model, reasoningEffort };
  // A Codex profile without settings keeps the bare stored form.
  return model === null && reasoningEffort === null
    ? { harness: "codex" }
    : { harness: "codex", model, reasoningEffort };
}

const settingFields = [
  ["runtimeModel", "runtime.model", "Model"],
  ["runtimeEffort", "runtime.reasoningEffort", "Reasoning effort"],
] as const;

/** Specific messages keyed to the server's field paths; empty when valid. */
export function runtimeErrors(
  v: Values,
  supported?: SupportedRuntimeSettings | null,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [field, path, label] of settingFields) {
    const value = String(v[field] ?? "").trim();
    if (/\s/.test(value)) errors[path] = `${label} cannot contain spaces.`;
    else if (value.length > 128)
      errors[path] = `${label} must be at most 128 characters.`;
  }
  if (Object.keys(errors).length || !supported) return errors;
  const runtime = runtimeCommand(v);
  const field = unsupportedRuntimeField(runtime, supported);
  if (field === "runtime.model")
    errors[field] =
      `Model must be one of: ${supportedModels(supported).join(", ")}.`;
  else if (field === "runtime.reasoningEffort")
    errors[field] =
      `Reasoning effort must be one of: ${supportedEfforts(supported, v).join(", ")}.`;
  return errors;
}

/** Selectable model names; `default` is the blank Default option. */
export const supportedModels = (supported: SupportedRuntimeSettings) =>
  supported.models.map((m) => m.model).filter((m) => m !== "default");

/** Efforts supported for the draft's model (or the default model). */
export const supportedEfforts = (
  supported: SupportedRuntimeSettings,
  v: Values,
) =>
  supported.models.find(
    (m) => m.model === (String(v.runtimeModel ?? "").trim() || "default"),
  )?.efforts ?? [];

/** The note beside the selector for a harness that cannot run work now. */
export function harnessNote(status: HarnessStatus | undefined) {
  if (!status || status.state === "available") return null;
  const label = executionHarnessLabels[status.harness];
  return status.state === "not-configured"
    ? `The ${label} runtime is not enabled on this service. ${status.reason === "disabled" ? "Turn it on in Settings → Runtime." : installAdvice(status.harness)} Assignments using this profile wait until it is; they never fall back to another runtime.`
    : `${unavailableNote(status.harness)} Assignments using this profile wait meanwhile and never fall back to another runtime.`;
}

type Assignment = TaskRead["data"]["assignments"][number];

/** The harness an assignment runs on: its persisted binding, else its captured revision's. */
export function executionSummary(a: Assignment) {
  const harness = a.executionGeneration?.harness ?? a.runtime.harness,
    label = executionHarnessLabels[harness];
  return {
    harness,
    line: harness === a.runtime.harness ? runtimeSummary(a.runtime) : label,
    note:
      harness === a.runtime.harness
        ? null
        : `This conversation stays on ${label}; the captured profile revision selects ${executionHarnessLabels[a.runtime.harness]} for new conversations.`,
  };
}

export interface ExecutionRoute {
  label: string;
  href: string;
}
export interface ExecutionNoticeModel {
  message: string;
  routes: ExecutionRoute[];
}

const runtimeStatusRoute = {
  label: "Runtime status",
  href: "/app/settings/runtime",
};
// The Claude token reference is set in the Runtime and recovery section.
const settingsRoute = {
  label: "Settings",
  href: settingsSectionHref("runtime"),
};
const recoveryRoute = (a: Assignment) => ({
  label: "Recovery",
  href: `/app/assignments/${a.assignmentId}/recovery`,
});

/**
 * Explains a service-created runtime wait (`<Label> runtime ...`) and its recovery routes.
 * The reason itself is never rewritten; unknown wording returns null.
 */
export function waitRoute(a: Assignment): ExecutionNoticeModel | null {
  const reason = a.waitReason ?? "";
  const harness = (
    Object.keys(executionHarnessLabels) as Array<
      keyof typeof executionHarnessLabels
    >
  ).find((h) => reason.startsWith(`${executionHarnessLabels[h]} runtime `));
  if (!harness) return null;
  const label = executionHarnessLabels[harness];
  if (reason === `${label} runtime is not configured`)
    return {
      message: `The ${label} runtime is not enabled on this service. ${notEnabledAdvice(harness)} This work waits and never falls back to another runtime; Stop the task from its header to end it, or change the profile's runtime for new conversations.`,
      routes: [
        {
          label: "Edit profile",
          href: `/app/profiles/${a.profileId}/settings`,
        },
        runtimeStatusRoute,
      ],
    };
  // The legacy text may still be stored on rows persisted before the off/on recovery.
  if (
    reason === `${label} runtime unavailable; restart the service` ||
    reason ===
      `${label} runtime unavailable; turn it off and on in Settings → Runtime, or restart the service`
  )
    return {
      message: `${unavailableNote(harness)} Queued work waits; running work is held, see Recovery.`,
      routes: [runtimeStatusRoute, recoveryRoute(a)],
    };
  if (reason.startsWith(`${label} runtime unavailable: `))
    return {
      message: `${reason}. This work waits and starts once the runtime is available; it never falls back to another runtime.`,
      // The Claude token reference is set in Settings.
      routes:
        harness === "claude"
          ? [runtimeStatusRoute, settingsRoute]
          : [runtimeStatusRoute],
    };
  return null;
}

/** A held Claude execution whose latest turn failed (the read reports only those). */
export function failureNotice(a: Assignment): ExecutionNoticeModel | null {
  const g = a.executionGeneration;
  if (g?.harness !== "claude" || !g.failure) return null;
  if (g.failure.reasonCode === "unauthorized")
    return {
      message:
        "Claude rejected the configured token. Replace the token value in the service environment, restart the service, then recover the held execution.",
      routes: [settingsRoute, recoveryRoute(a)],
    };
  return {
    message: `Turn failed (${g.failure.classification} · ${g.failure.reasonCode}). Held without automatic retry.`,
    routes: [recoveryRoute(a)],
  };
}
