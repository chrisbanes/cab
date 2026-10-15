import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import type { Page } from "playwright";
import {
  noPageOverflow,
  outcomeMessages,
  phone,
  savedOutcome,
  startSettings,
  trail,
  unpairedBadges,
} from "../fixtures/operator-settings.js";
import { commandRequest } from "../fixtures/setup-browser.js";
import {
  ClaudeShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";

const test = browserSuite("operator-profile-config-browser");

test("Create profile saves with one message, a breadcrumb, boundary aside and Cancel", async (_t, journey) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings/profiles/new",
  );
  await page
    .getByRole("heading", { level: 1, name: "Create profile" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Profiles / Create profile");
  await page.getByRole("complementary", { name: "Profile boundary" }).waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Cancel", exact: true })
      .getAttribute("href"),
    "/app/settings",
  );
  await page.getByLabel("Profile name", { exact: true }).fill("Tester");
  await page.getByLabel("Summary", { exact: true }).fill("Testing");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("PRIVATE TESTER INSTRUCTIONS");
  await page.getByLabel("Capabilities", { exact: true }).fill("Runs tests");
  await captureBrowserEvidence(page, "1366-profile-create");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await savedOutcome(page);
  const created = f.service
    .domain()
    .profiles()
    .find((r) => r.name === "Tester");
  assert.equal(Number(created?.version), 1);
});

test("Reviewer profile edits in place, restores and revokes, and replaces private instructions", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  const d = f.service.domain();
  await page
    .getByRole("heading", {
      level: 1,
      name: "Reviewer · profile configuration",
    })
    .waitFor();
  await page.locator(".settings-status").getByText("Revoked").waitFor();
  assert.deepEqual(await unpairedBadges(page.locator(".settings-status")), []);
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Review",
  );
  assert.equal(
    await page.getByLabel("Capabilities", { exact: true }).inputValue(),
    "Reviewer capabilities",
  );
  await page
    .getByRole("complementary", { name: "Effect of revocation" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Open advanced profile editor" })
      .getAttribute("href"),
    `/profile/${reviewer}`,
  );
  const read = await page.request.get(
    `${web.origin}/api/operator/profiles/${reviewer}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  assert.equal((await page.content()).includes("PRIVATE"), false);
  const save = page.getByRole("button", { name: "Save profile", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page
    .getByLabel("Capabilities", { exact: true })
    .fill("Reviews diffs and screenshots");
  const changes = page.getByRole("region", { name: "Changes to save" });
  await changes.getByText("Capabilities edited").waitFor();
  assert.equal(await save.isEnabled(), true);
  await page.getByRole("button", { name: "Restore profile" }).click();
  await changes.getByText("Restore Reviewer").waitFor();
  await captureBrowserEvidence(page, "1366-profile-revoked");
  await save.click();
  await page.locator(".settings-status").getByText("Available").waitFor();
  assert.deepEqual(await unpairedBadges(page.locator(".settings-status")), []);
  assert.equal(d.profile(reviewer).revoked, 0);
  assert.equal(
    d.profile(reviewer).capabilities,
    "Reviews diffs and screenshots",
  );
  await page.getByRole("button", { name: "Revoke profile" }).waitFor();
  await savedOutcome(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save profile" && b.disabled,
    ),
  );
  await page.getByRole("button", { name: "Revoke profile" }).click();
  await save.click();
  await page.locator(".settings-status").getByText("Revoked").waitFor();
  assert.equal(d.profile(reviewer).revoked, 1);
  await page.getByLabel("Replace instructions", { exact: true }).check();
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE NEW REVIEWER INSTRUCTIONS");
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText("Instructions replaced", { exact: false })
    .waitFor();
  await save.click();
  await page.getByLabel("New instructions", { exact: true }).waitFor({
    state: "detached",
  });
  assert.equal(
    d.profile(reviewer).instructions,
    "PRIVATE NEW REVIEWER INSTRUCTIONS",
  );
  assert.equal(
    d.profile(reviewer).capabilities,
    "Reviews diffs and screenshots",
  );
  assert.equal((await page.content()).includes("PRIVATE"), false);
});

test("a profile conflict keeps typed input until the newer version is reviewed", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  await page.getByLabel("Summary", { exact: true }).waitFor();
  await page.getByLabel("Summary", { exact: true }).fill("Typed summary");
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(f.service.domain().profile(reviewer).version),
    capabilities: "Changed elsewhere",
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  // One warning holds the only way forward, and the typed input is kept.
  const warning = outcomeMessages(page);
  assert.equal(await warning.count(), 1);
  assert.equal(await warning.getAttribute("role"), "alert");
  assert.equal(await warning.getByRole("button").count(), 1);
  assert.equal(
    await page.getByRole("button", { name: "Review changes" }).count(),
    1,
  );
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Typed summary",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Current revision 3.").waitFor();
  await warning.getByRole("button", { name: "Review changes" }).click();
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Typed summary",
  );
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await savedOutcome(page);
  assert.equal(f.service.domain().profile(reviewer).summary, "Typed summary");
});

test("project settings highlight the project in the sidebar; phone profile pages use Back", async (_t, journey) => {
  const { ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  await page
    .getByRole("heading", { level: 1, name: "Atlas · project configuration" })
    .waitFor();
  assert.equal(
    await page
      .locator("aside.sidebar")
      .getByRole("link", { name: "Atlas" })
      .getAttribute("aria-current"),
    "true",
  );
  await page.setViewportSize(phone);
  await page.goto(`${web.origin}/app/profiles/${ids.profiles.Mira}/settings`);
  await page
    .getByRole("heading", { level: 1, name: "Mira · profile configuration" })
    .waitFor();
  await page.getByRole("link", { name: "Back to Settings" }).waitFor();
  assert.equal(
    await page.getByRole("navigation", { name: "Breadcrumb" }).isVisible(),
    false,
  );
  await captureBrowserEvidence(page, "390-profile");
});

const controlHeights = (page: Page, labels: string[]) =>
  Promise.all(
    labels.map(
      async (label) =>
        (await page.getByLabel(label, { exact: true }).boundingBox())?.height ??
        0,
    ),
  );

test("Create profile chooses Claude with model and effort, rejecting invalid values before sending", async (_t, journey) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings/profiles/new",
  );
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  await page.getByLabel("Profile name", { exact: true }).fill("Claude tester");
  await page.getByLabel("Instructions", { exact: true }).fill("Test");
  await page.getByLabel("Capabilities", { exact: true }).fill("Tests");
  assert.equal(
    await page.getByLabel("Runtime", { exact: true }).inputValue(),
    "codex",
  );
  assert.equal(await page.getByLabel("Model", { exact: true }).count(), 0);
  await page.getByLabel("Runtime", { exact: true }).selectOption("claude");
  await page
    .getByText("The Claude runtime is not enabled on this service.", {
      exact: false,
    })
    .waitFor();
  await page.getByLabel("Model", { exact: true }).fill("a b");
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await page.getByText("Model cannot contain spaces.").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Model",
  );
  assert.equal(sent, 0);
  await page.getByLabel("Model", { exact: true }).fill("sonnet");
  await page.getByLabel("Reasoning effort", { exact: true }).fill("high");
  const request = commandRequest(page);
  await page
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  assert.deepEqual((await request).postDataJSON().runtime, {
    harness: "claude",
    model: "sonnet",
    reasoningEffort: "high",
  });
  await savedOutcome(page);
  const created = f.service
    .domain()
    .profiles()
    .find((r) => r.name === "Claude tester");
  assert.deepEqual(f.service.domain().profileRuntime(String(created?.id)), {
    harness: "claude",
    model: "sonnet",
    reasoningEffort: "high",
  });
  await page.setViewportSize(phone);
  await page
    .getByRole("button", { name: "Create another profile", exact: true })
    .click();
  await page.getByLabel("Runtime", { exact: true }).selectOption("claude");
  for (const height of await controlHeights(page, [
    "Runtime",
    "Model",
    "Reasoning effort",
  ]))
    assert.ok(height >= 44, `control height ${height}`);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-profile-create-runtime");
});

test("Profile configuration switches Codex to Claude and back as new revisions", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(journey, "/app/settings");
  const builder = ids.profiles.Builder as string;
  const d = f.service.domain();
  await page.getByText("Runtime: Codex").first().waitFor();
  await page.goto(`${web.origin}/app/profiles/${builder}/settings`);
  await page
    .getByRole("complementary", { name: "Runtime change" })
    .getByText("affects new conversations only", { exact: false })
    .waitFor();
  await page.getByLabel("Runtime", { exact: true }).selectOption("claude");
  await page.getByLabel("Model", { exact: true }).fill("sonnet");
  await page.getByLabel("Reasoning effort", { exact: true }).fill("high");
  const changes = page.getByRole("region", { name: "Changes to save" });
  await changes.getByText("Runtime: Codex → Claude · sonnet · high").waitFor();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Current revision 2.").waitFor();
  await savedOutcome(page);
  assert.deepEqual(d.profileRuntime(builder), {
    harness: "claude",
    model: "sonnet",
    reasoningEffort: "high",
  });
  await captureBrowserEvidence(page, "1366-profile-runtime-claude");
  await page.getByLabel("Runtime", { exact: true }).selectOption("codex");
  await changes.getByText("Runtime: Claude · sonnet · high → Codex").waitFor();
  const request = commandRequest(page);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  assert.deepEqual((await request).postDataJSON().runtime, {
    harness: "codex",
  });
  await page.getByText("Current revision 3.").waitFor();
  assert.deepEqual(d.profileRuntime(builder), { harness: "codex" });
  assert.deepEqual(d.profileRuntime(builder, 2), {
    harness: "claude",
    model: "sonnet",
    reasoningEffort: "high",
  });
  await page.goto(`${web.origin}/app/settings`);
  await page
    .locator(".settings-row", { hasText: "Builder" })
    .getByText("Runtime: Codex")
    .waitFor();
});

test("New profile starts on the first enabled runtime: Claude when Codex is disabled", async (_t, journey) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings/profiles/new",
    undefined,
    undefined,
    {
      runtimeFactory: (_context, harness) =>
        harness === "claude"
          ? new ClaudeShapedFixtureRuntime()
          : new OperatorFixtureRuntime(),
      serviceOptions: { runtimeHarnesses: ["codex", "claude"] },
    },
  );
  await f.service.configureRuntime({
    key: randomUUID(),
    harness: "codex",
    enabled: false,
    confirmedBoundTasks: f.service
      .runtimeSettings()
      .find((r) => r.harness === "codex")?.boundTasks,
  });
  await page.reload();
  const runtime = page.getByLabel("Runtime", { exact: true });
  await runtime.waitFor();
  assert.equal(await runtime.inputValue(), "claude");
});
