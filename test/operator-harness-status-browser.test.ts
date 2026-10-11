import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  startSettings,
} from "./fixtures/operator-settings.js";
import { OperatorFixtureRuntime } from "./fixtures/operator-web.js";

const test = browserSuite("ui826-harness-status");

/** Claude is enabled but fails to construct: unavailable since start. */
const claudeUnavailable = {
  runtimeFactory: (_context: unknown, harness: string) => {
    if (harness === "claude") throw Error("Claude unavailable");
    return new OperatorFixtureRuntime();
  },
  serviceOptions: { runtimeHarnesses: ["codex", "claude"] as const },
};

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`an unavailable Claude runtime raises one shell alert and is listed on Runtime at ${name}`, async (_t, journey) => {
    const { page } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      claudeUnavailable,
    );
    const alerts = page
      .getByRole("alert")
      .filter({ hasText: "runtime unavailable" });
    await alerts.first().waitFor();
    assert.deepEqual(await alerts.allInnerTexts(), [
      "Claude runtime unavailable — restart the service",
    ]);
    const runtimes = page.locator(".settings-panel", {
      has: page.getByRole("heading", { name: "Execution runtimes" }),
    });
    await runtimes.getByText("Unavailable", { exact: true }).waitFor();
    assert.equal(
      await runtimes.getByRole("heading", { name: "Codex" }).count(),
      1,
    );
    await runtimes.getByText("Available", { exact: true }).waitFor();
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-harnesses`);
  });
