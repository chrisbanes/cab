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
import {
  ClaudeShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "./fixtures/operator-web.js";

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

const claudeEnabled = {
  runtimeFactory: (_context: unknown, harness: string) =>
    harness === "claude"
      ? new ClaudeShapedFixtureRuntime()
      : new OperatorFixtureRuntime(),
  serviceOptions: { runtimeHarnesses: ["codex", "claude"] as const },
};

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`execution policies and supported Claude settings appear on Runtime and profile pages at ${name}`, async (_t, journey) => {
    const { page, web } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      claudeEnabled,
    );
    const runtimes = page.locator(".settings-panel", {
      has: page.getByRole("heading", { name: "Execution runtimes" }),
    });
    await runtimes
      .getByText(
        "Command network access is disabled. Approval policy is never.",
      )
      .waitFor();
    await runtimes
      .getByText("confined to the same roots by Ensemble's hook", {
        exact: false,
      })
      .waitFor();
    assert.equal(
      (await runtimes.innerText()).includes("/tmp/ens-"),
      false,
      "no private root path",
    );
    assert.equal(await page.getByRole("alert").count(), 0);
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-policies`);

    await page.goto(`${web.origin}/app/settings/profiles/new`);
    const aside = page.getByRole("complementary", { name: "Execution policy" });
    await aside.getByText("Execution policy · Codex").waitFor();
    await page.getByLabel("Runtime", { exact: true }).selectOption("claude");
    await aside.getByText("Execution policy · Claude").waitFor();
    await aside
      .getByText("Ensemble's hook, not by the operating system", {
        exact: false,
      })
      .waitFor();
    const model = page.getByLabel("Model", { exact: true });
    assert.deepEqual(await model.locator("option").allInnerTexts(), [
      "Default",
      "sonnet",
    ]);
    await model.selectOption("sonnet");
    assert.deepEqual(
      await page
        .getByLabel("Reasoning effort", { exact: true })
        .locator("option")
        .allInnerTexts(),
      ["Default", "high"],
    );
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-profile-claude-settings`);
  });

test("Claude not enabled: policy appears once available and settings stay free text", async (_t, journey) => {
  const { page, web } = await startSettings(journey, "/app/settings/runtime");
  await page
    .getByText("Effective policy appears once the Claude runtime is available.")
    .waitFor();
  await page.goto(`${web.origin}/app/settings/profiles/new`);
  await page.getByLabel("Runtime", { exact: true }).selectOption("claude");
  assert.equal(
    await page.getByLabel("Model", { exact: true }).evaluate((e) => e.tagName),
    "INPUT",
  );
});

test("a name-only save keeps a stored Claude model the runtime no longer supports", async (_t, journey) => {
  const { f, page, web } = await startSettings(
    journey,
    "/app/settings",
    desktop,
    undefined,
    claudeEnabled,
  );
  const profileId = crypto.randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: crypto.randomUUID(),
    profileId,
    name: "Legacy Claude",
    instructions: "x",
    capabilities: "x",
    runtime: { harness: "claude", model: "opus", reasoningEffort: null },
  });
  await page.goto(`${web.origin}/app/profiles/${profileId}/settings`);
  await page
    .getByLabel("Model", { exact: true })
    .locator("option", { hasText: "opus (not supported)" })
    .waitFor({ state: "attached" });
  await page.getByLabel("Summary", { exact: true }).fill("Renamed summary");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Current revision 2.").waitFor();
  assert.deepEqual(d.profileRuntime(profileId), {
    harness: "claude",
    model: "opus",
    reasoningEffort: null,
  });
  assert.equal(d.profile(profileId).summary, "Renamed summary");
});
