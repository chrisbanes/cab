import { clockLabel } from "./clock-label.js";
import {
  executionHarnessLabels,
  type HarnessStatus,
  type RuntimeRestart,
  type RuntimeRestartFailure,
} from "./contracts.js";

/**
 * The one wording for a runtime that is unavailable and its automatic restarts (SPEC runtime
 * enablement). Every surface that shows this state imports from here: the shell alert, the
 * Runtime page, Settings, the profile note, Readiness, task waits, the Inbox and the CLI.
 */

/** The fixed 30 s / 2 min / 10 min schedule, as prose. */
export const restartScheduleText = "30 s, 2 min and 10 min";
const toggleRemedy =
  "turn it off and on in Settings → Runtime, or restart the service";

type Harness = HarnessStatus["harness"];

export const retriesExhausted = "Retries exhausted";

/** "Restarting · attempt 2 of 3 · next at 14:32", or "Retries exhausted". */
export const restartLine = (restart: RuntimeRestart) =>
  restart.state === "pending"
    ? `Restarting · attempt ${restart.attempt} of 3 · next at ${clockLabel(restart.nextAt)}`
    : retriesExhausted;

const failureTexts: Record<RuntimeRestartFailure, string> = {
  exited: "The runtime process exited",
  "start-failed": "The runtime failed to start",
  "start-timed-out": "The runtime did not start in time",
  "spawn-failed": "The runtime could not be launched",
};
export const failureText = (code: RuntimeRestartFailure) => failureTexts[code];

/** Shell alert and server-rendered Runtime page. Without a schedule: today's text. */
export function unavailableAlert(status: {
  harness: Harness;
  restart?: RuntimeRestart | undefined;
}) {
  const head = `${executionHarnessLabels[status.harness]} runtime unavailable — `;
  if (status.restart?.state === "pending")
    return head + restartLine(status.restart);
  if (status.restart?.state === "exhausted")
    return `${head}${restartLine(status.restart)}; ${toggleRemedy}`;
  return head + toggleRemedy;
}

/** The Settings row's Fix text. */
export function settingsFix(restart: RuntimeRestart | undefined) {
  if (restart?.state === "pending") return restartLine(restart);
  if (restart?.state === "exhausted")
    return `${restartLine(restart)} · turn it off and on, or restart the service`;
  return "Turn it off and on, or restart the service";
}

/** Readiness's Fix text for an unavailable runtime. */
export function readinessFix(
  harness: Harness,
  restart: RuntimeRestart | undefined,
) {
  const label = executionHarnessLabels[harness];
  const remedy = `turn ${label} off and on in Settings → Runtime, or restart the service`;
  if (restart?.state === "pending")
    return `${restartLine(restart)}; if it stays unavailable, ${remedy}`;
  if (restart?.state === "exhausted")
    return `${restartLine(restart)}; ${remedy}`;
  return remedy.charAt(0).toUpperCase() + remedy.slice(1);
}

/**
 * Explains the state beside a profile's runtime and on a task that waits for it. It names the
 * schedule rather than its current attempt, so it holds whichever stored wait text was read.
 */
export const unavailableNote = (harness: Harness) =>
  `The ${executionHarnessLabels[harness]} runtime is unavailable. cab restarts it automatically after ${restartScheduleText}; if those retries run out, ${toggleRemedy}.`;

/** The Inbox item for a runtime whose retries ran out (SPEC attention inbox). */
export const runtimeInboxHeadline = (harness: Harness) =>
  `${executionHarnessLabels[harness]} runtime unavailable`;
export const runtimeInboxReason = "Restart retries exhausted";
export const runtimeSettingsPath = "/app/settings/runtime";
export const runtimeSettingsAction = "Open runtime settings";
