import assert from "node:assert/strict";
import {
  browserSuite,
  type BrowserJourney,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  startSettings,
  unpairedBadges,
} from "../fixtures/operator-settings.js";
import { randomUUID } from "node:crypto";
import { webkit, type Browser, type Page } from "playwright";
import {
  ClaudeShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";
import { openSearchFromSidebar } from "../fixtures/shell-search.js";
import { clockLabel } from "../../src/operator/clock-label.js";
import { exhaustibleRuntime } from "../fixtures/runtime-exhaustion.js";
import { ManualRestartClock } from "../fixtures/restart-clock.js";
import { claudePolicyLimits } from "../../src/standalone/claude.js";
import { codexPolicyDisclosure } from "../../src/standalone/execution-policy.js";

const test = browserSuite("operator-harness-status-browser");

/**
 * Claude is enabled but fails to construct: unavailable since start, with its first automatic
 * restart pending 30 s later on a clock that never advances.
 */
const claudeUnavailable = () => {
  const clock = new ManualRestartClock();
  return {
    clock,
    options: {
      runtimeFactory: (_context: unknown, harness: string) => {
        if (harness === "claude") throw Error("Claude unavailable");
        return new OperatorFixtureRuntime();
      },
      serviceOptions: {
        runtimeHarnesses: ["codex", "claude"] as const,
        runtimeRestart: { clock, wallNow: clock.wallNow },
      },
    },
  };
};

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`an unavailable Claude runtime raises one shell alert and is listed on Runtime at ${name}`, async (_t, journey) => {
    const unavailable = claudeUnavailable();
    const { page } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      unavailable.options,
    );
    const pending = `Restarting · attempt 1 of 3 · next at ${clockLabel(unavailable.clock.wall + 30_000)}`;
    const alerts = page
      .getByRole("alert")
      .filter({ hasText: "runtime unavailable" });
    await alerts.first().waitFor();
    assert.deepEqual(await alerts.allInnerTexts(), [
      `Claude runtime unavailable — ${pending}`,
    ]);
    const runtimes = page.locator(".settings-panel", {
      has: page.getByRole("heading", { name: "Execution runtimes" }),
    });
    await runtimes.getByText("Unavailable", { exact: true }).waitFor();
    // The row's Fix says the same, in the same words.
    await runtimeRow(page, "Claude")
      .getByText(pending, { exact: true })
      .waitFor();
    assert.equal(
      await runtimes.getByRole("heading", { name: "Codex" }).count(),
      1,
    );
    await runtimes.getByText("Available", { exact: true }).waitFor();
    assert.equal(await runtimeLimits(page, "Claude").count(), 0);
    assert.equal(await runtimeLimits(page, "Codex").count(), 1);
    await runtimes
      .getByText(
        "Effective policy appears once the Claude runtime is available.",
      )
      .waitFor();
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
        "Command network access is disabled unless the project enables it. Approval policy is never.",
      )
      .waitFor();
    // The third Claude line sits in the closed limits disclosure.
    await runtimeRow(page, "Claude")
      .getByText("Limits and untested surfaces · 12")
      .click();
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
  assert.equal(await runtimeLimits(page, "Claude").count(), 0);
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

test("a runtime setting switched back leaves the profile form clean", async (_t, journey) => {
  const { f, page, web } = await startSettings(
    journey,
    "/app/settings",
    desktop,
    undefined,
    claudeEnabled,
  );
  const profileId = crypto.randomUUID();
  f.service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: crypto.randomUUID(),
    profileId,
    name: "Plain Codex",
    instructions: "x",
    capabilities: "x",
    runtime: { harness: "codex" },
  });
  await page.goto(`${web.origin}/app/profiles/${profileId}/settings`);
  const runtime = page.getByLabel("Runtime", { exact: true });
  await runtime.selectOption("claude");
  const model = page.getByLabel("Model", { exact: true });
  if ((await model.evaluate((e) => e.tagName)) === "INPUT")
    await model.fill("custom-model");
  else await model.selectOption({ index: 1 });
  await runtime.selectOption("codex");
  const region = page.getByRole("region", { name: "Changes to save" });
  await region.getByText("No changes yet.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Discard changes" }).count(),
    0,
  );
});

test("an override that was switched off again leaves the capacity form clean, and 04 equals 4", async (_t, journey) => {
  const { f, page } = await startSettings(journey, "/app/settings/runtime");
  const region = page.getByRole("region", { name: "Changes to save" });
  const cap = page.getByLabel("Global active-turn cap", { exact: true });
  await cap.waitFor();
  const saved = await cap.inputValue();
  await page.getByLabel("Set capacity override for Atlas").check();
  await page.getByLabel("Active-turn cap for Atlas", { exact: true }).fill("7");
  await page.getByLabel("Set capacity override for Atlas").uncheck();
  await cap.fill(`0${saved}`);
  await region.getByText("No changes yet.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Discard changes" }).count(),
    0,
  );
  // Another writer changes the cap; the clean form takes it on Refresh.
  const d = f.service.domain();
  d.execute({
    type: "capacity.configure",
    actor: "operator",
    key: randomUUID(),
    globalLimit: Number(saved) + 5,
    projectOverrides: {},
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(
    (value) =>
      (
        document.querySelector(
          'input[aria-label="Global active-turn cap"]',
        ) as HTMLInputElement | null
      )?.value === value,
    String(Number(saved) + 5),
  );
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
const runtimeLimits = (page: Page, name: string) =>
  runtimeRow(page, name).locator("details.runtime-limits");
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
    assert.deepEqual(await unpairedBadges(runtimesPanel(page)), []);
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
    // The receipt precedes the independent runtime read that updates the switch.
    await row.getByText("Available", { exact: true }).waitFor();
    assert.equal(await control.isChecked(), true);
    assert.equal(f.service.domain().runtimeEnabled("claude"), true);
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
      .getByRole("button", { name: "Cancel" })
      .evaluate((e) => e === document.activeElement),
    true,
    "Keep takes the focus",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await control.isChecked(), true);
  assert.equal(f.service.domain().runtimeEnabled("claude"), true);
  assert.deepEqual(posts, [], "Cancel sends nothing");

  await control.click();
  await dialog.getByText("1 task uses Claude.", { exact: false }).waitFor();
  // A task bound while the dialog is open: the confirmation no longer covers it.
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "INSERT INTO execution_intents (id, workId, prompt, workspace, state, accountType, sandbox, approval) VALUES (?, 'bound-probe-2', 'p', '/w', 'ready', 'chatgpt', 'workspaceWrite', 'never')",
    ).run(randomUUID());
    db.prepare(
      "INSERT INTO task_execution_bindings (workId, taskId, assignmentId, assignmentVersion, instructionsRevision, profileRevision, conversationRevision, harness) VALUES ('bound-probe-2', ?, ?, 1, 1, 1, 1, 'claude')",
    ).run(randomUUID(), randomUUID());
  });
  await dialog.getByRole("button", { name: "Turn off Claude" }).click();
  await dialog
    .getByText(
      "2 tasks use Claude. Running turns finish; their next turns wait until Claude is enabled again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(f.service.domain().runtimeEnabled("claude"), true);
  await dialog.getByRole("button", { name: "Turn off Claude" }).click();
  await runtimesPanel(page)
    .getByText("Claude turned off.", { exact: true })
    .waitFor();
  assert.equal(f.service.domain().runtimeEnabled("claude"), false);
  assert.deepEqual(
    posts.map((p) => JSON.parse(p).confirmedBoundTasks),
    [1, 2],
  );
  assert.equal(await control.isChecked(), false);
});

/** Frame callbacks run before the page's own render, the order a loaded machine sometimes produces. */
const framesBeforeCommit = (page: Page) =>
  page.evaluate(() => {
    window.requestAnimationFrame = (callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 0;
    };
  });

/** Loses the answer to the first runtime change after the service handled it. */
const loseFirstRuntimeAnswer = (page: Page) => {
  let lost = true;
  return page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "runtime.configure" || !lost) return route.fallback();
    lost = false;
    await route.fetch();
    await route.abort("connectionreset");
  });
};

const unknownToggleFocusesTheCheck = async (
  journey: BrowserJourney,
  launch?: () => Promise<Browser>,
) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    launch,
    switchable(),
  );
  const posts = commandPosts(page);
  const row = runtimeRow(page, "Claude");
  const control = row.getByRole("switch", { name: "Claude enabled" });
  await control.waitFor();
  await loseFirstRuntimeAnswer(page);
  await framesBeforeCommit(page);
  // Locator waits only: waitForFunction would poll with the replaced frame callbacks.
  await control.evaluate((element) => (element as HTMLElement).click());
  const check = row.getByRole("button", {
    name: "Check whether it saved",
    exact: true,
  });
  await check.and(page.locator(":focus")).waitFor();
  assert.equal(await control.isDisabled(), true);
  await check.evaluate((element) => (element as HTMLElement).click());
  await runtimesPanel(page)
    .getByText("Claude turned off.", { exact: true })
    .waitFor();
  await control.and(page.locator(":focus:enabled")).waitFor();
  // The check resent the exact command: one logical change.
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
  assert.equal(f.service.domain().runtimeEnabled("claude"), false);
};

test("an unknown runtime toggle outcome focuses 'Check whether it saved' and the check replays the same command", async (_t, journey) => {
  await unknownToggleFocusesTheCheck(journey);
});

test(
  "an unknown runtime toggle outcome focuses 'Check whether it saved' in WebKit",
  { browserEngine: "webkit" },
  async (_t, journey) => {
    await unknownToggleFocusesTheCheck(journey, () => webkit.launch());
  },
);

test("a refused runtime toggle returns focus to the enabled switch after frame callbacks that run before the commit", async (_t, journey) => {
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
  await framesBeforeCommit(page);
  await control.evaluate((element) => (element as HTMLElement).click());
  await row.getByText("Claude was not turned on", { exact: false }).waitFor();
  await control.and(page.locator(":focus:enabled")).waitFor();
  assert.equal(f.service.domain().runtimeEnabled("claude"), false);
});

test("a runtime toggle answered after its page was left focuses nothing", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    undefined,
    switchable(),
  );
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const row = runtimeRow(page, "Claude");
  const control = row.getByRole("switch", { name: "Claude enabled" });
  await control.waitFor();
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "runtime.configure") return route.fallback();
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
  });
  await control.click();
  await reached;
  await openSearchFromSidebar(page, { keepFocus: true });
  release();
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.getAttribute("role") === "switch",
    ),
    false,
  );
  assert.deepEqual(pageErrors, []);
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

const hiddenClaudeLine = "File-editing tools are confined to the same roots";
const hiddenLimits = [
  hiddenClaudeLine,
  ...claudePolicyLimits,
  ...codexPolicyDisclosure().limits,
];
const evidenceReferences = ["F6.3", "F6.4", "F5.5", "#827"];

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`runtime limits sit in a closed disclosure per runtime under the switch, status and two policy lines at ${name}`, async (_t, journey) => {
    const { page } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      claudeEnabled,
    );
    for (const [runtime, count] of [
      ["Codex", 3],
      ["Claude", 12],
    ] as const) {
      const row = runtimeRow(page, runtime),
        details = runtimeLimits(page, runtime),
        summary = details.locator("summary"),
        visible = `Limits and untested surfaces · ${count}`;
      await row.getByRole("switch", { name: `${runtime} enabled` }).waitFor();
      await row.getByText("Available", { exact: true }).waitFor();
      assert.equal(await details.count(), 1);
      assert.equal(
        await details.evaluate((e) => e.hasAttribute("open")),
        false,
      );
      assert.equal(await summary.innerText(), visible);
      const label = await summary.getAttribute("aria-label");
      assert.equal(label, `${runtime} limits and untested surfaces · ${count}`);
      // Label in name (WCAG 2.5.3) ignores case.
      assert.ok(
        label?.toLowerCase().includes(visible.toLowerCase()),
        "label contains the visible text",
      );
      if (name === "390")
        assert.ok(
          (await summary.evaluate((e) => e.getBoundingClientRect().height)) >=
            44,
          "phone target is 44px",
        );
    }
    for (const line of codexPolicyDisclosure().lines)
      await runtimeRow(page, "Codex")
        .getByText(line, { exact: true })
        .waitFor();
    for (const line of [
      "Commands run in Claude Code's sandbox",
      "Command network access is denied. There are no interactive approvals.",
    ])
      await runtimeRow(page, "Claude").getByText(line).first().waitFor();

    const rowsText = [
      await runtimeRow(page, "Codex").innerText(),
      await runtimeRow(page, "Claude").innerText(),
    ].join("\n");
    const pageText = await page.locator("main").innerText();
    for (const hidden of [...hiddenLimits, ...evidenceReferences]) {
      assert.equal(rowsText.includes(hidden), false, `row hides ${hidden}`);
      assert.equal(pageText.includes(hidden), false, `page hides ${hidden}`);
    }
    for (const [runtime, strings] of [
      ["Codex", codexPolicyDisclosure().limits],
      ["Claude", [hiddenClaudeLine, ...claudePolicyLimits]],
    ] as const) {
      const content = await runtimeLimits(page, runtime).evaluate(
        (e) => e.textContent ?? "",
      );
      for (const text of strings)
        assert.ok(content.includes(text), `${runtime} keeps ${text}`);
    }
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-limits-closed`);

    await runtimeLimits(page, "Claude").locator("summary").click();
    for (const text of [hiddenClaudeLine, ...claudePolicyLimits])
      await runtimeLimits(page, "Claude")
        .getByText(text, { exact: false })
        .first()
        .waitFor();
    assert.equal(
      await runtimeLimits(page, "Claude").evaluate((e) =>
        e.hasAttribute("open"),
      ),
      true,
    );
    assert.equal(
      await runtimeLimits(page, "Codex").evaluate((e) =>
        e.hasAttribute("open"),
      ),
      false,
      "opening Claude leaves Codex closed",
    );
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-limits-open`);
  });

test("an open runtime limits disclosure stays open across Refresh and starts closed after navigating back", async (_t, journey) => {
  const { page, web } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    undefined,
    claudeEnabled,
  );
  const claude = runtimeLimits(page, "Claude"),
    codex = runtimeLimits(page, "Codex"),
    isOpen = (locator: typeof claude) =>
      locator.evaluate((e) => e.hasAttribute("open"));
  await claude.locator("summary").click();
  assert.equal(await isOpen(claude), true);
  // An expando is lost if the element is replaced, which `open` alone would not show.
  await claude.evaluate((e) => {
    (e as HTMLElement & { probe?: boolean }).probe = true;
  });
  const reads = ["runtime", "workspace"].map((read) =>
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/operator/${read}`,
    ),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  for (const read of reads) await (await read).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(await isOpen(claude), true);
  assert.equal(await isOpen(codex), false);
  assert.equal(
    await claude.evaluate(
      (e) => (e as HTMLElement & { probe?: boolean }).probe === true,
    ),
    true,
    "the same element survives the refresh",
  );
  assert.equal(
    await page.evaluate(
      () =>
        localStorage.length + sessionStorage.length + location.search.length,
    ),
    0,
    "open state is stored nowhere",
  );

  // In-app route change and back: the page is not reloaded, so module state would survive.
  await page.locator('a[href="/app/inbox"]').first().click();
  await runtimesPanel(page).waitFor({ state: "detached" });
  await page.goBack();
  await runtimeRow(page, "Claude").getByRole("switch").waitFor();
  assert.equal(await isOpen(claude), false);
  assert.equal(await isOpen(codex), false);

  await claude.locator("summary").click();
  await page.goto(`${web.origin}/app/settings/runtime`);
  await runtimeRow(page, "Claude").getByRole("switch").waitFor();
  assert.equal(await isOpen(claude), false, "a reload starts closed");
});

test("the runtime limits disclosure toggles with Enter and Space and keeps focus on its summary", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/settings/runtime",
    desktop,
    undefined,
    claudeEnabled,
  );
  const row = runtimeRow(page, "Claude"),
    summary = runtimeLimits(page, "Claude").locator("summary"),
    summaryFocused = () =>
      summary.evaluate((e) => e === document.activeElement),
    open = () =>
      runtimeLimits(page, "Claude").evaluate((e) => e.hasAttribute("open"));
  await row.getByRole("switch", { name: "Claude enabled" }).focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await summaryFocused(),
    true,
    "Tab leaves the switch for the summary",
  );
  await page.keyboard.press("Enter");
  assert.equal(await open(), true);
  assert.equal(await summaryFocused(), true);
  await page.keyboard.press("Space");
  assert.equal(await open(), false);
  assert.equal(await summaryFocused(), true);
  // Shift+Tab returns to this row's switch: DOM order is the on-screen order.
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await row
      .getByRole("switch", { name: "Claude enabled" })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  assert.deepEqual(
    await row.evaluate((e) => [
      ...new Set(
        [...e.querySelectorAll("*")].map((el) => getComputedStyle(el).order),
      ),
    ]),
    ["0"],
    "no element in the row is reordered with CSS",
  );
});

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`the runtime page orders Add Claude, Execution runtimes, Capacity, then Task recovery destinations at ${name}`, async (_t, journey) => {
    const { page } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      claudeEnabled,
    );
    await runtimesPanel(page).waitFor();
    const headings = await page.locator(".settings-page h2").allInnerTexts();
    const at = (title: string) => headings.indexOf(title);
    assert.ok(at("Add Claude") >= 0, "Add Claude is listed");
    assert.ok(at("Add Claude") < at("Execution runtimes"));
    assert.ok(at("Execution runtimes") < at("Capacity"));
    assert.ok(at("Capacity") < at("Task recovery destinations"));
    const tops = await page.evaluate(() =>
      [
        "Add Claude",
        "Execution runtimes",
        "Capacity",
        "Task recovery destinations",
      ].map(
        (title) =>
          [...document.querySelectorAll(".settings-page h2")]
            .find((h) => h.textContent === title)
            ?.getBoundingClientRect().top ?? NaN,
      ),
    );
    // At 1366 the recovery destinations are a second column beside the first three.
    const stacked = name === "390" ? tops : tops.slice(0, 3);
    assert.ok(
      stacked.every((top, i) => i === 0 || stacked[i - 1]! < top),
      `visual order follows DOM order: ${tops.join(", ")}`,
    );
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-panel-order`);
  });

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`an exhausted runtime says Retries exhausted on Runtime and in the shell alert at ${name}`, async (_t, journey) => {
    const exhaustion = exhaustibleRuntime();
    const { page, f } = await startSettings(
      journey,
      "/app/settings/runtime",
      viewport,
      undefined,
      {
        runtimeFactory: exhaustion.factory,
        serviceOptions: exhaustion.serviceOptions,
      },
    );
    await exhaustion.exhaust(f.runtime);
    await page.reload();
    const alerts = page
      .getByRole("alert")
      .filter({ hasText: "runtime unavailable" });
    await alerts.first().waitFor();
    assert.deepEqual(await alerts.allInnerTexts(), [
      "Codex runtime unavailable — Retries exhausted; turn it off and on in Settings → Runtime, or restart the service",
    ]);
    await runtimeRow(page, "Codex")
      .getByText(
        "Retries exhausted · turn it off and on, or restart the service",
        { exact: true },
      )
      .waitFor();
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-runtime-exhausted`);
  });
