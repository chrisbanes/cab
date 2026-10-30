import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import type { Page } from "playwright";
import {
  captureSettingsEvidence as captureBrowserEvidence,
  noPageOverflow,
  outcomeMessages,
  phone,
  savedOutcome,
  startSettings,
  trail,
  unpairedBadges,
} from "../fixtures/operator-settings.js";
import { commandRequest } from "../fixtures/setup-browser.js";
import { writeSkillPlugin } from "../fixtures/skill-plugin.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeShapedFixtureRuntime,
  CodexShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";

const test = browserSuite("operator-profile-config-browser");
/** Whether `text` is anywhere the operator can read: page text or a field's value. */
const showsText = (page: Page, text: string) =>
  page.evaluate(
    (needle) =>
      document.body.innerText.includes(needle) ||
      [...document.querySelectorAll("textarea, input")].some((e) =>
        (e as HTMLTextAreaElement).value.includes(needle),
      ),
    text,
  );

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
    "/app/settings#profiles",
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

test("Reviewer profile edits in place, restores and revokes, and edits revealed instructions", async (_t, journey) => {
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
  assert.equal(await showsText(page, "PRIVATE"), false);
  const instructions = page.getByRole("group", {
    name: "Instructions",
    exact: true,
  });
  assert.match(await instructions.innerText(), /Kept\s*·\s*Reveal/);
  assert.equal(
    await page.getByRole("textbox", { name: "Instructions" }).count(),
    0,
  );
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
  await page.getByRole("button", { name: "Reveal instructions" }).click();
  const field = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await field.waitFor();
  assert.equal(await field.inputValue(), "PRIVATE REVIEWER INSTRUCTIONS");
  assert.equal(await field.evaluate((e) => e === document.activeElement), true);
  assert.equal(await save.isDisabled(), true, "revealing is not a change");
  const version = Number(d.profile(reviewer).version);
  await field.fill("PRIVATE NEW REVIEWER INSTRUCTIONS");
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  assert.equal(
    (
      await page.getByRole("region", { name: "Changes to save" }).innerText()
    ).includes("PRIVATE"),
    false,
  );
  const posted = commandRequest(page);
  await save.click();
  const body = (await posted).postDataJSON() as Record<string, unknown>;
  assert.equal(body.instructions, "PRIVATE NEW REVIEWER INSTRUCTIONS");
  assert.equal(body.expectedVersion, version);
  await page.getByRole("button", { name: "Reveal instructions" }).waitFor();
  assert.equal(await field.count(), 0);
  assert.equal(
    d.profile(reviewer).instructions,
    "PRIVATE NEW REVIEWER INSTRUCTIONS",
  );
  assert.equal(
    d.profile(reviewer).capabilities,
    "Reviews diffs and screenshots",
  );
  assert.equal((await page.content()).includes("PRIVATE"), false);
  assert.equal(await showsText(page, "PRIVATE"), false);
});

test("a profile form whose edits were reverted is clean and picks up a later read", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  const summary = page.getByLabel("Summary", { exact: true });
  const capabilities = page.getByLabel("Capabilities", { exact: true });
  const changes = page.getByRole("region", { name: "Changes to save" });
  await summary.waitFor();
  await page.getByRole("button", { name: "Reveal instructions" }).click();
  const field = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await field.fill("CHANGED");
  await field.fill("PRIVATE REVIEWER INSTRUCTIONS");
  await summary.fill("Typed");
  await summary.fill("Review");
  await changes.getByText("No changes yet.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Discard changes" }).count(),
    0,
  );
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(f.service.domain().profile(reviewer).version),
    capabilities: "Changed elsewhere",
  });
  const read = page.waitForResponse(
    (r) => r.request().method() === "GET" && /configuration$/.test(r.url()),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await read;
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'textarea[aria-label="Capabilities"]',
        ) as HTMLTextAreaElement | null
      )?.value === "Changed elsewhere",
  );
  assert.equal(await capabilities.inputValue(), "Changed elsewhere");
});

test("profile instructions reverted or edited keep their state after leaving the page", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  const save = page.getByRole("button", { name: "Save profile", exact: true });
  const changes = page.getByRole("region", { name: "Changes to save" });
  const field = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  const reveal = page.getByRole("button", { name: "Reveal instructions" });
  const leaveAndReturn = async () => {
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Reviewer", exact: false })
      .first()
      .click();
    await page.getByLabel("Summary", { exact: true }).waitFor();
  };
  await reveal.click();
  await field.fill("CHANGED");
  await field.fill("PRIVATE REVIEWER INSTRUCTIONS");
  assert.equal(await changes.getByRole("listitem").count(), 0);
  await leaveAndReturn();
  await reveal.waitFor();
  assert.equal(await save.isDisabled(), true);
  await reveal.click();
  await field.fill("EDITED INSTRUCTIONS");
  await leaveAndReturn();
  assert.equal(await field.inputValue(), "EDITED INSTRUCTIONS");
  await changes.getByText("Instructions edited", { exact: true }).waitFor();
  await field.fill("PRIVATE REVIEWER INSTRUCTIONS");
  assert.equal(await changes.getByRole("listitem").count(), 0);
  assert.equal(await save.isDisabled(), true);
  assert.equal(
    f.service.domain().profile(reviewer).instructions,
    "PRIVATE REVIEWER INSTRUCTIONS",
  );
});

test("a profile conflict keeps typed input until the newer version is reviewed", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  await page.getByLabel("Summary", { exact: true }).waitFor();
  await page.getByLabel("Summary", { exact: true }).fill("Typed summary");
  await page.getByRole("button", { name: "Reveal instructions" }).click();
  const instructions = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await instructions.fill("TYPED INSTRUCTIONS");
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
  assert.equal(await instructions.inputValue(), "TYPED INSTRUCTIONS");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Current revision 3.").waitFor();
  await warning.getByRole("button", { name: "Review changes" }).click();
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Typed summary",
  );
  // The edit after Reveal is kept and rides on the newer version.
  assert.equal(await instructions.inputValue(), "TYPED INSTRUCTIONS");
  const sent = commandRequest(page);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  assert.equal(body.expectedVersion, 3);
  assert.equal(body.instructions, "TYPED INSTRUCTIONS");
  await savedOutcome(page);
  assert.equal(f.service.domain().profile(reviewer).summary, "Typed summary");
  assert.equal(
    f.service.domain().profile(reviewer).instructions,
    "TYPED INSTRUCTIONS",
  );
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
  // Codex takes a model and effort too; blank leaves the runtime default.
  assert.equal(await page.getByLabel("Model", { exact: true }).count(), 1);
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

const codexSettingsOptions = {
  runtimeFactory: (
    _context: unknown,
    harness: string,
  ): OperatorFixtureRuntime =>
    harness === "codex"
      ? new CodexShapedFixtureRuntime()
      : new OperatorFixtureRuntime(),
};

test("Codex profile configuration sets, shows and clears model and effort", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/settings",
    undefined,
    undefined,
    codexSettingsOptions,
  );
  const builder = ids.profiles.Builder as string;
  const d = f.service.domain();
  await page.goto(`${web.origin}/app/profiles/${builder}/settings`);
  await page
    .getByText("Leave model or effort blank to use the Codex default.")
    .waitFor();
  const model = page.getByLabel("Model", { exact: true });
  const effort = page.getByLabel("Reasoning effort", { exact: true });
  assert.deepEqual(await model.locator("option").allTextContents(), [
    "Default",
    "m-default",
    "m-alt",
  ]);
  // The efforts follow the chosen model.
  assert.deepEqual(await effort.locator("option").allTextContents(), [
    "Default",
    "low",
    "high",
  ]);
  await model.selectOption("m-alt");
  assert.deepEqual(await effort.locator("option").allTextContents(), [
    "Default",
    "medium",
  ]);
  await effort.selectOption("medium");
  const changes = page.getByRole("region", { name: "Changes to save" });
  await changes.getByText("Runtime: Codex → Codex · m-alt · medium").waitFor();
  const saved = commandRequest(page);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  assert.deepEqual((await saved).postDataJSON().runtime, {
    harness: "codex",
    model: "m-alt",
    reasoningEffort: "medium",
  });
  await page.getByText("Current revision 2.").waitFor();
  assert.deepEqual(d.profileRuntime(builder), {
    harness: "codex",
    model: "m-alt",
    reasoningEffort: "medium",
  });
  await page.goto(`${web.origin}/app/settings`);
  await page
    .locator(".settings-row", { hasText: "Builder" })
    .getByText("Runtime: Codex · m-alt · medium")
    .waitFor();

  await page.goto(`${web.origin}/app/profiles/${builder}/settings`);
  await model.selectOption("");
  await effort.selectOption("");
  await changes.getByText("Runtime: Codex · m-alt · medium → Codex").waitFor();
  const cleared = commandRequest(page);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  assert.deepEqual((await cleared).postDataJSON().runtime, {
    harness: "codex",
  });
  await page.getByText("Current revision 3.").waitFor();
  assert.deepEqual(d.profileRuntime(builder), { harness: "codex" });
  // The earlier revision keeps its settings.
  assert.deepEqual(d.profileRuntime(builder, 2), {
    harness: "codex",
    model: "m-alt",
    reasoningEffort: "medium",
  });
});

test("Codex profile configuration rejects a stored effort the runtime no longer lists", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/settings",
    undefined,
    undefined,
    codexSettingsOptions,
  );
  const builder = ids.profiles.Builder as string;
  const d = f.service.domain();
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: builder,
    expectedVersion: Number(d.profile(builder).version),
    runtime: { harness: "codex", model: null, reasoningEffort: "gone" },
  } as never);
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  await page.goto(`${web.origin}/app/profiles/${builder}/settings`);
  await page
    .getByLabel("Reasoning effort", { exact: true })
    .locator("option", { hasText: "gone (not supported)" })
    .waitFor({ state: "attached" });
  await page.getByLabel("Model", { exact: true }).selectOption("m-alt");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Reasoning effort must be one of: medium.").waitFor();
  assert.equal(sent, 0);
});

test("Profile configuration sets two skills of a plugin, rejects a missing plugin and shows the skills on the profile", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(journey, "/app/settings");
  const builder = ids.profiles.Builder as string;
  const d = f.service.domain();
  const plugin = writeSkillPlugin(
    join(mkdtempSync(join(tmpdir(), "cab-skill-ui-")), "plugin"),
    ["review", "plan"],
  );
  await page.goto(`${web.origin}/app/profiles/${builder}/settings`);
  await page.getByLabel("Skill plugins", { exact: true }).waitFor();
  await page
    .getByRole("complementary", { name: "About skill plugins" })
    .getByText("not cab policy", { exact: false })
    .waitFor();
  const field = page.getByLabel("Skill plugins", { exact: true });
  await field.fill("not a plugin line");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page
    .getByText("One plugin per line", { exact: false })
    .first()
    .waitFor();
  assert.deepEqual(d.profileSkills(builder), { plugins: [] });

  await field.fill(`${plugin}-missing: review`);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("not a plugin directory on the service host").waitFor();
  assert.deepEqual(d.profileSkills(builder), { plugins: [] });

  await field.fill(`${plugin}: review, plan`);
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText("Skill plugins: none → 1 plugin, 2 skills")
    .waitFor();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Current revision 2.").waitFor();
  assert.deepEqual(d.profileSkills(builder), {
    plugins: [{ path: plugin, skills: ["review", "plan"] }],
  });
  assert.deepEqual(d.profileSkills(builder, 1), { plugins: [] });
  // The saved skills come back on reload.
  await page.reload();
  await page
    .getByLabel("Skill plugins", { exact: true })
    .evaluate(
      (e, want) => (e as HTMLTextAreaElement).value === want,
      `${plugin}: review, plan`,
    )
    .then((same) => assert.equal(same, true));
  // The skills stay with the profile across a runtime switch.
  await page.getByLabel("Runtime", { exact: true }).selectOption("claude");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Current revision 3.").waitFor();
  assert.deepEqual(d.profileSkills(builder), {
    plugins: [{ path: plugin, skills: ["review", "plan"] }],
  });
  await page.getByLabel("Skill plugins", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("Current revision 4.").waitFor();
  assert.deepEqual(d.profileSkills(builder), { plugins: [] });
});
