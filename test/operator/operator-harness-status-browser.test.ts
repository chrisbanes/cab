import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  startSettings,
} from "../fixtures/operator-settings.js";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  ClaudeShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";

const test = browserSuite("operator-harness-status-browser");

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

/** Both runtimes enabled; `claude` resolves on PATH only while `onPath.claude` is true. */
const switchable = (onPath = { claude: true }) => ({
  ...claudeEnabled,
  serviceOptions: {
    runtimeHarnesses: ["codex", "claude"] as const,
    resolveExecutable: async (harness: string) =>
      harness !== "claude" || onPath.claude,
  },
});

const runtimesPanel = (page: Page) =>
  page.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Execution runtimes" }),
  });
const runtimeRow = (page: Page, name: string) =>
  runtimesPanel(page).locator(".settings-row", {
    has: page.getByRole("heading", { name, exact: true }),
  });
const commandPosts = (page: Page) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postData() ?? "");
  });
  return posts;
};

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`turning an execution runtime off and on needs no confirmation without bound work at ${name}`, async (_t, journey) => {
    const { f, page } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      switchable(),
    );
    const posts = commandPosts(page);
    const row = runtimeRow(page, "Claude");
    const control = row.getByRole("switch", { name: "Claude enabled" });
    await control.waitFor();
    assert.equal(await control.isChecked(), true);
    await control.click();
    await runtimesPanel(page)
      .getByText("Claude turned off.", { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("alertdialog").count(), 0);
    await row.getByText("Not enabled", { exact: true }).waitFor();
    await row.getByText("Disabled in Settings", { exact: true }).waitFor();
    assert.equal(await control.isChecked(), false);
    assert.equal(f.service.domain().runtimeEnabled("claude"), false);
    // A disabled runtime is not an unavailable one: no shell alert, no restart advice.
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(
      (await page.locator("body").innerText()).includes("restart the service"),
      false,
    );
    // The receipt fields sit only in the collapsed Details.
    const outcome = runtimesPanel(page).locator('[data-slot="action-outcome"]');
    assert.equal(
      (await outcome.locator("p").innerText()).includes("runtime."),
      false,
    );
    await outcome.getByText("Details").click();
    await outcome.getByText("system:runtime:claude").waitFor();
    assert.equal(posts.length, 1);
    const { key, ...sent } = JSON.parse(posts[0] ?? "{}");
    assert.equal(typeof key, "string");
    assert.deepEqual(sent, {
      type: "runtime.configure",
      harness: "claude",
      enabled: false,
    });
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-turned-off`);

    await control.click();
    await runtimesPanel(page)
      .getByText("Claude turned on.", { exact: true })
      .waitFor();
    assert.equal(await control.isChecked(), true);
    assert.equal(f.service.domain().runtimeEnabled("claude"), true);
    await row.getByText("Available", { exact: true }).waitFor();
  });

test("turning off a runtime that tasks use confirms first; Keep leaves it on and Turn off saves", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    undefined,
    switchable(),
  );
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, accountType, sandbox, approval) VALUES (?, 'bound-probe', 'p', '/w', 'ready', 'chatgpt', 'workspaceWrite', 'never')",
    ).run(randomUUID());
    db.prepare(
      "INSERT INTO task_execution_bindings (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision, harness) VALUES ('bound-probe', ?, ?, 1, 1, 1, 1, 'claude')",
    ).run(ids.taskId, randomUUID());
  });
  const posts = commandPosts(page);
  const control = runtimeRow(page, "Claude").getByRole("switch", {
    name: "Claude enabled",
  });
  await control.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText("Turn off Claude?").waitFor();
  await dialog
    .getByText(
      "1 task uses Claude. Running turns finish; their next turns wait until Claude is enabled again.",
      { exact: true },
    )
    .waitFor();
  await captureBrowserEvidence(page, "1366-runtime-turn-off-confirm");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Keep Claude on" })
      .evaluate((e) => e === document.activeElement),
    true,
    "Keep takes the focus",
  );
  await dialog.getByRole("button", { name: "Keep Claude on" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await control.isChecked(), true);
  assert.equal(f.service.domain().runtimeEnabled("claude"), true);
  assert.deepEqual(posts, [], "Cancel sends nothing");

  await control.click();
  await dialog.getByRole("button", { name: "Turn off Claude" }).click();
  await runtimesPanel(page)
    .getByText("Claude turned off.", { exact: true })
    .waitFor();
  assert.equal(f.service.domain().runtimeEnabled("claude"), false);
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0] ?? "{}").confirmed, true);
  assert.equal(await control.isChecked(), false);
});

test("turning on a runtime whose executable is missing says so inline and stays off", async (_t, journey) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    undefined,
    {
      ...claudeEnabled,
      serviceOptions: {
        runtimeHarnesses: ["codex", "claude"] as const,
        resolveExecutable: async (harness: string) => harness !== "claude",
      },
    },
  );
  await f.service.configureRuntime({
    key: randomUUID(),
    harness: "claude",
    enabled: false,
  });
  await page.reload();
  const row = runtimeRow(page, "Claude");
  const control = row.getByRole("switch", { name: "Claude enabled" });
  await row.getByText("Disabled in Settings").waitFor();
  assert.equal(await control.isChecked(), false);
  await control.click();
  await row
    .getByText(
      "Claude was not turned on: `claude` not found on the service PATH.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await control.isChecked(), false);
  assert.equal(f.service.domain().runtimeEnabled("claude"), false);
  await captureBrowserEvidence(page, "1366-runtime-executable-missing");
});

test("with both runtimes off, Readiness fails with its fix and points at Runtime settings", async (_t, journey) => {
  const { page, web } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    undefined,
    switchable(),
  );
  await runtimeRow(page, "Claude")
    .getByRole("switch", { name: "Claude enabled" })
    .click();
  await runtimeRow(page, "Claude").getByText("Disabled in Settings").waitFor();
  // The settings world has a Codex-bound task, so Codex confirms first.
  await runtimeRow(page, "Codex")
    .getByRole("switch", { name: "Codex enabled" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Turn off Codex" })
    .click();
  await runtimeRow(page, "Codex").getByText("Disabled in Settings").waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.goto(`${web.origin}/app/settings`);
  const check = page
    .locator(".settings-panel", {
      has: page.getByRole("heading", { name: "Readiness", exact: true }),
    })
    .getByRole("article", { name: "An execution runtime is enabled" });
  await check.getByText("Fail", { exact: true }).waitFor();
  await check.getByText("No execution runtime is enabled").waitFor();
  await check.getByText("Enable a runtime in Settings → Runtime").waitFor();
  await captureBrowserEvidence(page, "1366-readiness-no-runtime");
});
