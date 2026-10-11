import {
  executionHarnessLabels,
  runtimeSummary,
  type HarnessStatus,
  type ProfileRuntime,
  type TaskRead,
} from "../../src/operator/contracts.js";
export { runtimeSummary };
import type { Values } from "./settings-changes.js";

export const harnessStateLabel: Record<HarnessStatus["state"], string> = {
  available: "Available",
  "not-configured": "Not enabled",
  unavailable: "Unavailable",
};

/** Exact shell alert copy; Codex wording is retained byte-for-byte. */
export const unavailableAlert = (status: HarnessStatus) =>
  `${executionHarnessLabels[status.harness]} runtime unavailable — restart the service`;

/** Draft values of the profile runtime fields. */
export const runtimeValues = (runtime: ProfileRuntime): Values => ({
  runtimeHarness: runtime.harness,
  runtimeModel: runtime.harness === "claude" ? (runtime.model ?? "") : "",
  runtimeEffort:
    runtime.harness === "claude" ? (runtime.reasoningEffort ?? "") : "",
});

export function runtimeCommand(v: Values): ProfileRuntime {
  if (v.runtimeHarness !== "claude") return { harness: "codex" };
  const value = (x: unknown) => String(x ?? "").trim() || null;
  return {
    harness: "claude",
    model: value(v.runtimeModel),
    reasoningEffort: value(v.runtimeEffort),
  };
}

const settingFields = [
  ["runtimeModel", "runtime.model", "Model"],
  ["runtimeEffort", "runtime.reasoningEffort", "Reasoning effort"],
] as const;

/** Specific messages keyed to the server's field paths; empty when valid. */
export function runtimeErrors(v: Values): Record<string, string> {
  const errors: Record<string, string> = {};
  if (v.runtimeHarness !== "claude") return errors;
  for (const [field, path, label] of settingFields) {
    const value = String(v[field] ?? "").trim();
    if (/\s/.test(value)) errors[path] = `${label} cannot contain spaces.`;
    else if (value.length > 128)
      errors[path] = `${label} must be at most 128 characters.`;
  }
  return errors;
}

/** The note beside the selector for a harness that cannot run work now. */
export function harnessNote(status: HarnessStatus | undefined) {
  if (!status || status.state === "available") return null;
  const label = executionHarnessLabels[status.harness];
  return status.state === "not-configured"
    ? `The ${label} runtime is not enabled on this service. Assignments using this profile wait until it is; they never fall back to another runtime.`
    : `The ${label} runtime is unavailable; restart the service. Assignments using this profile wait meanwhile and never fall back to another runtime.`;
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
      message: `The ${label} runtime is not enabled on this service. This work waits and never falls back to another runtime; Stop the task from its header to end it, or change the profile's runtime for new conversations.`,
      routes: [
        {
          label: "Edit profile",
          href: `/app/profiles/${a.profileId}/settings`,
        },
        runtimeStatusRoute,
      ],
    };
  if (reason === `${label} runtime unavailable; restart the service`)
    return {
      message: `The ${label} runtime is unavailable; restart the service. Queued work waits; running work is held, see Recovery.`,
      routes: [runtimeStatusRoute, recoveryRoute(a)],
    };
  if (reason.startsWith(`${label} runtime unavailable: `))
    return {
      message: `${reason}. This work waits and starts once the runtime is available; it never falls back to another runtime.`,
      routes: [runtimeStatusRoute],
    };
  return null;
}

/** A held Claude assignment whose latest turn failed; Codex presentation is unchanged. */
export function failureNotice(a: Assignment): ExecutionNoticeModel | null {
  const g = a.executionGeneration;
  if (g?.harness !== "claude" || !g.failure || a.state !== "held") return null;
  return {
    message: `Turn failed (${g.failure.classification} · ${g.failure.reasonCode}). Held without automatic retry.`,
    routes: [recoveryRoute(a)],
  };
}
