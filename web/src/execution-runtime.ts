import {
  executionHarnessLabels,
  type HarnessStatus,
} from "../../src/operator/contracts.js";

export const harnessStateLabel: Record<HarnessStatus["state"], string> = {
  available: "Available",
  "not-configured": "Not enabled",
  unavailable: "Unavailable",
};

/** Exact shell alert copy; Codex wording is retained byte-for-byte. */
export const unavailableAlert = (status: HarnessStatus) =>
  `${executionHarnessLabels[status.harness]} runtime unavailable — restart the service`;
