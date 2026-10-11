import {
  executionHarnessLabels,
  type HarnessStatus,
  type ProfileRuntime,
} from "../../src/operator/contracts.js";
export { runtimeSummary } from "../../src/operator/contracts.js";
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
