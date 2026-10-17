import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Page } from "playwright";
import { DiscoveryFailure } from "../../src/standalone/github-discovery.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import { fakeDiscovery } from "../fixtures/setup-home.js";
import {
  createCheckout,
  noPageOverflow,
  outcomeMessages,
  phone,
  resolve,
  savedOutcome,
  signIn,
  startSettings,
  trail,
  unpairedBadges,
} from "../fixtures/operator-settings.js";

const test = browserSuite("operator-project-config-browser");
const changes = (page: Page) =>
  page.getByRole("region", { name: "Changes to save" });
/** Press the header Refresh and wait until the re-read has rendered. */
const refresh = async (page: Page) => {
  const read = page.waitForResponse(
    (r) => r.request().method() === "GET" && /configuration$/.test(r.url()),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await read;
  await page.getByText("Refreshing.", { exact: false }).waitFor({
    state: "hidden",
  });
};
/** The "Reveal …" button of a private text field. */
const revealButton = (page: Page, noun: string) =>
  page.getByRole("button", { name: `Reveal ${noun}`, exact: true });
/** Whether a private sentinel is anywhere the operator can read: page text or a field's value. */
const showsText = (page: Page, text: string) =>
  page.evaluate(
    (needle) =>
      document.body.innerText.includes(needle) ||
      [...document.querySelectorAll("textarea, input")].some((e) =>
        (e as HTMLTextAreaElement).value.includes(needle),
      ),
    text,
  );
/** Private-values reads this document has made so far. */
const revealReads = (page: Page) =>
  page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("/private-values")).length,
  );
/** Wait until the page has painted twice, so a late render would have appeared. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
const commandBody = (page: Page) =>
  page
    .waitForRequest(
      (r) =>
        r.method() === "POST" && r.url().endsWith("/api/operator/commands"),
    )
    .then((r) => r.postDataJSON() as Record<string, unknown>);

test("General tab edits in place with Kept · Reveal instructions, a change list, a saved line and tabs that keep drafts", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await page
    .getByRole("heading", { level: 1, name: "Atlas · project configuration" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Projects / Atlas");
  const status = page.locator(".settings-status");
  await status.getByText("Enabled").waitFor();
  await status.getByText("Existing start rules still apply.").waitFor();
  assert.doesNotMatch(await status.innerText(), /version|\d\d:\d\d/);
  const tabs = page.getByRole("navigation", {
    name: "Project configuration sections",
  });
  assert.equal(await tabs.getByRole("link").count(), 4);
  assert.equal(
    await tabs
      .getByRole("link", { name: "General" })
      .getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas",
  );
  await page.getByRole("switch", { name: "Pause project" }).waitFor();
  // Instructions open kept: no field, no text on the page and no read until Reveal.
  const instructions = page.getByRole("group", {
    name: "Instructions",
    exact: true,
  });
  assert.match(await instructions.innerText(), /Kept\s*·\s*Reveal/);
  assert.equal(
    await page.getByRole("textbox", { name: "Instructions" }).count(),
    0,
  );
  assert.equal(await showsText(page, "PRIVATE"), false);
  assert.equal(await revealReads(page), 0);
  const save = page.getByRole("button", { name: "Save project", exact: true });
  assert.equal(await save.isDisabled(), true);
  await revealButton(page, "instructions").click();
  const field = page.getByRole("textbox", { name: "Instructions" });
  await field.waitFor();
  assert.equal(await field.inputValue(), "PRIVATE ATLAS INSTRUCTIONS");
  assert.equal(
    await field.evaluate((e) => e === document.activeElement),
    true,
    "focus moves to the revealed field",
  );
  assert.equal(await revealReads(page), 1);
  assert.equal(await save.isDisabled(), true, "revealing is not a change");
  assert.equal(await changes(page).getByRole("listitem").count(), 0);
  await page.reload();
  await page.getByLabel("Project name", { exact: true }).waitFor();
  await page.getByRole("switch", { name: "Pause project" }).waitFor();
  const references = page.locator(".settings-panel", {
    hasText: "Credential and environment references",
  });
  assert.equal(
    await references
      .getByRole("link", { name: "Change in Routing" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}/settings?tab=routing`,
  );
  assert.equal(
    await references
      .getByRole("link", { name: "Change in GitHub source" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}/settings?tab=github`,
  );
  assert.equal(
    await references
      .getByRole("link", { name: "Open advanced editor" })
      .getAttribute("href"),
    `/project/${ids.atlas}`,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Project tasks" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}`,
  );
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  await captureBrowserEvidence(page, "1366-project-general");
  await page.getByLabel("Project name", { exact: true }).fill("Atlas II");
  await changes(page).getByText("Project name: Atlas → Atlas II").waitFor();
  await tabs.getByRole("link", { name: "Routing" }).click();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  await tabs.getByRole("link", { name: "General" }).click();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas II",
  );
  await changes(page).getByText("Project name: Atlas → Atlas II").waitFor();
  const version = Number(d.project(ids.atlas).version);
  await save.click();
  await status.getByText(/Saved \d\d:\d\d/).waitFor();
  await savedOutcome(page);
  assert.equal((await status.innerText()).match(/Saved \d\d:\d\d/g)?.length, 1);
  assert.equal(Number(d.project(ids.atlas).version), version + 1);
  assert.equal(d.project(ids.atlas).name, "Atlas II");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save project" && b.disabled,
    ),
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas II",
  );
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  assert.equal(await showsText(page, "PRIVATE"), false);
});

const SENTINEL = "PRIVATE ATLAS INSTRUCTIONS";
const instructionsField = (page: Page) =>
  page.getByRole("textbox", { name: "Instructions", exact: true });
const saveProject = (page: Page) =>
  page.getByRole("button", { name: "Save project", exact: true });
/** Bump the project elsewhere (another writer) and return the version it now holds. */
const bumpProject = (
  f: Awaited<ReturnType<typeof startSettings>>["f"],
  projectId: string,
  name: string,
) => {
  const d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    name,
  });
  return Number(d.project(projectId).version);
};

test("revealed instructions edit in place and save as a versioned change", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  const field = instructionsField(page);
  await field.waitFor();
  assert.equal(await field.inputValue(), SENTINEL);
  const version = Number(d.project(ids.atlas).version),
    revision = Number(d.project(ids.atlas).instructionsRevision);
  const edited = `${SENTINEL}. Ask Mira before changing the release checklist.`;
  await field.fill(edited);
  await changes(page)
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  assert.equal((await changes(page).innerText()).includes("PRIVATE"), false);
  const posted = commandBody(page);
  await saveProject(page).click();
  const body = await posted;
  assert.equal(body.instructions, edited);
  assert.equal(body.expectedVersion, version);
  assert.equal(body.type, "project.configure");
  await savedOutcome(page);
  assert.equal(d.project(ids.atlas).instructions, edited);
  assert.equal(Number(d.project(ids.atlas).instructionsRevision), revision + 1);
  // After the re-read the field is kept again; the saved line carries no text.
  await revealButton(page, "instructions").waitFor();
  assert.equal(await instructionsField(page).count(), 0);
  assert.equal(await showsText(page, "PRIVATE"), false);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  // Revealing again reads the saved text at the new version.
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  assert.equal(await instructionsField(page).inputValue(), edited);
});

test("a stale reveal conflicts and an unedited reveal resets on the newer version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("EDITED BEFORE A CONFLICT");
  bumpProject(f, ids.atlas, "Atlas elsewhere");
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  // The edit is kept and now rides on the newer version.
  assert.equal(
    await instructionsField(page).inputValue(),
    "EDITED BEFORE A CONFLICT",
  );
  const newer = Number(d.project(ids.atlas).version);
  const resent = commandBody(page);
  await saveProject(page).click();
  const body = await resent;
  assert.equal(body.expectedVersion, newer);
  assert.equal(body.instructions, "EDITED BEFORE A CONFLICT");
  await savedOutcome(page);
  assert.equal(d.project(ids.atlas).instructions, "EDITED BEFORE A CONFLICT");

  // An unedited reveal with another field edited: a newer version resets it to kept.
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  await page.getByLabel("Project name", { exact: true }).fill("Atlas typed");
  bumpProject(f, ids.atlas, "Atlas elsewhere again");
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await revealButton(page, "instructions").waitFor();
  assert.equal(await instructionsField(page).count(), 0);
  assert.equal(await showsText(page, "EDITED BEFORE A CONFLICT"), false);
  const second = commandBody(page);
  await saveProject(page).click();
  const sent = await second;
  assert.equal(
    "instructions" in sent,
    false,
    "an unedited reveal is never sent",
  );
  assert.equal(sent.name, "Atlas typed");
  await savedOutcome(page);
  assert.equal(d.project(ids.atlas).instructions, "EDITED BEFORE A CONFLICT");
});

test("revealed instructions clear on navigation, sign-out and project switch", async (_t, journey) => {
  const { ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const tabs = page.getByRole("navigation", {
    name: "Project configuration sections",
  });
  const gate = { release: () => {} };
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // Unedited reveal: another tab and back, then another project and back.
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  await tabs.getByRole("link", { name: "Routing" }).click();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  assert.equal(await showsText(page, SENTINEL), false);
  await tabs.getByRole("link", { name: "General" }).click();
  await revealButton(page, "instructions").waitFor();
  assert.equal(await showsText(page, SENTINEL), false);
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  await page.getByRole("button", { name: "Operator account" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .getByRole("link", { name: "Configure Relay", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Relay · project configuration" })
    .waitFor();
  assert.equal(await showsText(page, SENTINEL), false);
  await page.goto(`${web.origin}/app/projects/${ids.atlas}/settings`);
  await revealButton(page, "instructions").waitFor();

  // An edit stays, like any unsaved input, across in-app navigation.
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("UNSAVED EDIT");
  await tabs.getByRole("link", { name: "Routing" }).click();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  await tabs.getByRole("link", { name: "General" }).click();
  assert.equal(await instructionsField(page).inputValue(), "UNSAVED EDIT");

  // Navigating away before the read resolves never renders the text.
  await page.goto(`${web.origin}/app/projects/${ids.atlas}/settings`);
  await revealButton(page, "instructions").waitFor();
  await page.route("**/private-values", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const requested = page.waitForRequest((r) =>
    r.url().endsWith("/private-values"),
  );
  await revealButton(page, "instructions").click();
  await requested;
  await tabs.getByRole("link", { name: "Routing" }).click();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  gate.release();
  await settled(page);
  assert.equal(await showsText(page, SENTINEL), false);
  await tabs.getByRole("link", { name: "General" }).click();
  await revealButton(page, "instructions").waitFor();
  await page.unroute("**/private-values");

  // Signing out clears the text; signing back in starts kept.
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  await page.getByRole("button", { name: "Operator account" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  assert.equal(await showsText(page, SENTINEL), false);
  await signIn(page, web, `/app/projects/${ids.atlas}/settings`);
  await revealButton(page, "instructions").waitFor();
  assert.equal(await showsText(page, SENTINEL), false);

  // Signing out before the read resolves: the same outcome.
  const second = { release: () => {} };
  const heldAgain = new Promise<void>((resolve) => {
    second.release = resolve;
  });
  await page.route("**/private-values", async (route) => {
    await heldAgain;
    await route.continue().catch(() => {});
  });
  await revealButton(page, "instructions").click();
  await page.getByRole("button", { name: "Operator account" }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password").waitFor();
  second.release();
  await settled(page);
  assert.equal(await showsText(page, SENTINEL), false);
  await page.unroute("**/private-values");
  assert.deepEqual(
    consoleErrors.filter(
      (m) => !/private-values|net::ERR|Failed to load resource/.test(m),
    ),
    [],
  );
});

test("a reveal leaves no trace in the URL, history or storage", async (_t, journey) => {
  const { ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const url = page.url();
  const historyLength = await page.evaluate(() => window.history.length);
  const bodies: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/operator/"))
      void r
        .text()
        .then((text) => {
          if (text.includes("PRIVATE")) bodies.push(new URL(r.url()).pathname);
        })
        .catch(() => {});
  });
  const requests: string[] = [];
  page.on("request", (r) => {
    requests.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  const read = page.waitForResponse((r) => r.url().endsWith("/private-values"));
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  await (await read).finished();
  await settled(page);
  assert.equal(page.url(), url);
  assert.equal(await page.evaluate(() => window.history.length), historyLength);
  assert.equal(
    await page
      .evaluate(() => JSON.stringify(history.state ?? null))
      .then((s) => s.includes("PRIVATE")),
    false,
  );
  const storage = await page.evaluate(() =>
    JSON.stringify([
      ...Object.entries(localStorage),
      ...Object.entries(sessionStorage),
    ]),
  );
  assert.equal(storage.includes("PRIVATE"), false);
  assert.equal(
    (await page.context().cookies()).some((c) => c.value.includes("PRIVATE")),
    false,
  );
  assert.deepEqual(bodies, [
    `/api/operator/projects/${ids.atlas}/private-values`,
  ]);
  assert.equal(requests.filter((r) => r.includes("PRIVATE")).length, 0);
  assert.equal(requests.filter((r) => r.includes("/private-values")).length, 1);
});

test("a failed reveal keeps focus and explains without the text", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  const reveal = revealButton(page, "instructions");
  await reveal.click();
  const failed = page.getByRole("alert").filter({
    hasText: "Couldn't load the instructions.",
  });
  await failed.waitFor();
  assert.equal(await showsText(page, "PRIVATE"), false);
  assert.equal(await instructionsField(page).count(), 0);
  const retry = page.getByRole("button", {
    name: "Try again to reveal instructions",
    exact: true,
  });
  assert.equal(await retry.innerText(), "Try again");
  assert.equal(
    await retry.evaluate((e) => e === document.activeElement),
    true,
    "focus stays on the control that was used",
  );
  assert.equal(await saveProject(page).isDisabled(), true);
  await page.unroute("**/private-values");
  await retry.click();
  await instructionsField(page).waitFor();
  assert.equal(await instructionsField(page).inputValue(), SENTINEL);
  assert.equal(await failed.count(), 0);
  assert.equal(
    await instructionsField(page).evaluate((e) => e === document.activeElement),
    true,
  );
});

test("two tabs: a reveal never sends unedited text and a stale edit conflicts", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  // A second signed-in browser context is the other tab.
  const context = await page.context().browser()?.newContext();
  assert.ok(context);
  const other = await context.newPage();
  other.setDefaultTimeout(5000);
  try {
    await signIn(other, web, `/app/projects/${ids.atlas}/settings`);
    await revealButton(page, "instructions").click();
    await instructionsField(page).waitFor();
    await revealButton(other, "instructions").click();
    await instructionsField(other).fill("EDITED IN THE OTHER TAB");
    await saveProject(other).click();
    await savedOutcome(other);
    assert.equal(d.project(ids.atlas).instructions, "EDITED IN THE OTHER TAB");

    // This tab still shows the old text; a name-only save sends no instructions and conflicts.
    await page
      .getByLabel("Project name", { exact: true })
      .fill("Atlas tab one");
    const nameOnly = commandBody(page);
    await saveProject(page).click();
    assert.equal("instructions" in (await nameOnly), false);
    await page.getByText("A newer version was saved elsewhere.").waitFor();
    assert.equal(d.project(ids.atlas).name, "Atlas");
    await outcomeMessages(page)
      .getByRole("button", { name: "Review changes" })
      .click();
    // The unedited reveal went stale with the newer version.
    await revealButton(page, "instructions").waitFor();
    assert.equal(await showsText(page, SENTINEL), false);

    // Editing the older reveal is a stale edit: the other tab saves first, so this one conflicts.
    await revealButton(page, "instructions").click();
    await instructionsField(page).fill("EDITED IN TAB ONE");
    bumpProject(f, ids.atlas, "Atlas moved on");
    await saveProject(page).click();
    await page.getByText("A newer version was saved elsewhere.").waitFor();
    assert.equal(d.project(ids.atlas).instructions, "EDITED IN THE OTHER TAB");
    assert.equal(
      await instructionsField(page).inputValue(),
      "EDITED IN TAB ONE",
    );
  } finally {
    await context.close();
  }
});

test("empty and very large instructions reveal and save exactly", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:fieldnotes/settings",
  );
  const d = f.service.domain();
  const set = (instructions: string) =>
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: ids.fieldnotes,
      expectedVersion: Number(d.project(ids.fieldnotes).version),
      instructions,
    });
  set("");
  await page.reload();
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  assert.equal(await instructionsField(page).inputValue(), "");
  assert.equal(await instructionsField(page).isEditable(), true);
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.equal(await saveProject(page).isDisabled(), true);

  const large = "日本é".repeat(5333) + "x";
  assert.equal(large.length, 16000);
  set(large);
  await page.reload();
  await revealButton(page, "instructions").click();
  await instructionsField(page).waitFor();
  assert.equal(await instructionsField(page).inputValue(), large);
  assert.equal(await saveProject(page).isDisabled(), true);
  await instructionsField(page).fill(`${large}y`);
  await saveProject(page).click();
  const error = page.getByText(
    "Keep the instructions to 16000 characters or fewer. It has 16001.",
    { exact: true },
  );
  await error.waitFor();
  assert.equal(d.project(ids.fieldnotes).instructions, large);
  assert.equal((await error.innerText()).includes("日本"), false);
  assert.equal(await instructionsField(page).inputValue(), `${large}y`);
  // Back to the exact limit: the value saves unchanged-length and byte for byte.
  await instructionsField(page).fill(`${large.slice(0, -1)}z`);
  await saveProject(page).click();
  await savedOutcome(page);
  assert.equal(
    d.project(ids.fieldnotes).instructions,
    `${large.slice(0, -1)}z`,
  );
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.fieldnotes}/configuration`,
  );
  assert.equal((await read.text()).includes("日本"), false);
});

test("General tab validation, conflict and revoked-lead failures keep input", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const name = page.getByLabel("Project name", { exact: true });
  await name.waitFor();
  await name.fill("");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("Enter a project name.", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Project name",
  );
  await name.fill("Atlas typed");
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(f.service.domain().project(ids.atlas).version),
    paused: true,
  });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(await name.inputValue(), "Atlas typed");
  // The conflict re-reads on its own; no manual Refresh is needed before Review.
  await page.locator(".settings-status").getByText("Paused").waitFor();
  assert.deepEqual(await unpairedBadges(page.locator(".settings-status")), []);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(await name.inputValue(), "Atlas typed");
  // The untouched pause takes the newer revision instead of undoing it.
  assert.equal(
    await page.getByRole("switch", { name: "Pause project" }).isChecked(),
    true,
  );
  assert.equal(
    (await changes(page).innerText()).includes("Unpause project"),
    false,
  );
  const d = f.service.domain();
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profiles.Jonas as string,
    expectedVersion: Number(d.profile(ids.profiles.Jonas as string).version),
    revoked: true,
  });
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Jonas" });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("Couldn't save. Your changes are still here.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(await name.inputValue(), "Atlas typed");
});

test("an unknown save freezes the form until the exact submission is reconciled", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const name = page.getByLabel("Project name", { exact: true });
  await name.waitFor();
  await name.fill("Atlas unknown");
  await page.route("**/api/operator/commands", (r) => r.abort());
  let key: unknown;
  try {
    const body = commandBody(page);
    await page
      .getByRole("button", { name: "Save project", exact: true })
      .click();
    key = (await body).key;
    await page.getByText("We couldn't confirm the save.").waitFor();
    assert.equal(await outcomeMessages(page).count(), 1);
    assert.equal(await name.isDisabled(), true);
    // The Save button is gone, so focus moves to the one action instead of the page body.
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Check whether it saved",
    );
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandBody(page);
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  assert.equal((await replay).key, key);
  await page
    .locator(".settings-status")
    .getByText(/Saved \d\d:\d\d/)
    .waitFor();
  await savedOutcome(page);
  assert.equal(f.service.domain().project(ids.atlas).name, "Atlas unknown");
});

test("phone project settings lead with state and next step and keep the form usable", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
    phone,
  );
  await page.getByRole("link", { name: "Back to Settings" }).waitFor();
  const state = page.getByRole("region", { name: "Current state" });
  await state.getByText("Lead: Mira · repository access: acme/atlas").waitFor();
  await state.getByText("GitHub S-1 inactive", { exact: false }).waitFor();
  await page
    .getByRole("region", { name: "Next step" })
    .getByText(
      "Set or change the credential in GitHub source settings, then preview this source version.",
    )
    .waitFor();
  await page.getByLabel("Project name", { exact: true }).fill("Atlas phone");
  await changes(page).getByText("Project name: Atlas → Atlas phone").waitFor();
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-project");
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForFunction(
    () => !document.querySelector(".settings-phone-cards")?.checkVisibility(),
  );
});

test("Routing saves candidates in place without sending guidance, and edits revealed guidance in place", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  assert.equal(await trail(page), "Settings / Projects / Relay / Routing");
  await page
    .locator(".settings-status")
    .getByText("Routing changes do not resume Relay.", { exact: false })
    .waitFor();
  const candidate = (name: string) =>
    page.getByRole("checkbox", { name: new RegExp(`^${name} ·`) });
  for (const name of ["Eli", "Builder", "Worker"])
    assert.equal(await candidate(name).isChecked(), true, name);
  for (const name of ["Mira", "Jonas", "Nora"])
    assert.equal(await candidate(name).isChecked(), false, name);
  assert.equal(await candidate("Reviewer").isDisabled(), true);
  await page.getByText("Reviewer · Review (revoked)").waitFor();
  const guidance = page.getByRole("group", {
    name: "Routing guidance",
    exact: true,
  });
  assert.match(await guidance.innerText(), /Kept\s*·\s*Reveal/);
  assert.equal(await showsText(page, "PRIVATE"), false);
  assert.equal(await revealReads(page), 0);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.relay}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  const save = page.getByRole("button", { name: "Save routing", exact: true });
  assert.equal(await save.isDisabled(), true);
  await candidate("Mira").check();
  await changes(page).getByText("Candidate added: Mira").waitFor();
  await captureBrowserEvidence(page, "1366-routing");
  const version = Number(d.routing(ids.relay).version);
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.equal("guidance" in sent, false);
  assert.equal((sent.candidateProfileIds as string[]).length, 4);
  const saved = await savedOutcome(page);
  await saved
    .getByText(
      /^Saved\. Routing now uses (?=.*Mira)(?=.*Eli)(?=.*Builder)(?=.*Worker)/,
    )
    .waitFor();
  assert.equal(
    (
      (await page.locator(".settings-status").innerText()).match(
        /Saved \d\d:\d\d/g,
      ) ?? []
    ).length,
    1,
  );
  assert.equal(Number(d.routing(ids.relay).version), version + 1);
  assert.equal(d.routing(ids.relay).guidance, "PRIVATE ROUTING GUIDANCE");
  const aside = page.getByRole("region", { name: "Saved routing" });
  await aside.getByRole("heading", { name: "Saved routing" }).waitFor();
  assert.doesNotMatch(await aside.innerText(), /\d\d:\d\d|version/);
  await aside
    .getByText(/^Candidates: (?=.*Mira)(?=.*Eli)(?=.*Builder)(?=.*Worker)/)
    .waitFor();
  await aside.getByText("Guidance: kept", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save routing" && b.disabled,
    ),
  );
  await captureBrowserEvidence(page, "1366-routing-saved");
  await revealButton(page, "routing guidance").click();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await field.waitFor();
  assert.equal(await field.inputValue(), "PRIVATE ROUTING GUIDANCE");
  assert.equal(await field.evaluate((e) => e === document.activeElement), true);
  assert.equal(await save.isDisabled(), true, "revealing is not a change");
  const loaded = Number(d.routing(ids.relay).version);
  await field.fill("NEW PRIVATE GUIDANCE");
  await changes(page)
    .getByText("Routing guidance edited", { exact: true })
    .waitFor();
  assert.equal((await changes(page).innerText()).includes("PRIVATE"), false);
  const replaced = commandBody(page);
  await save.click();
  const edit = await replaced;
  assert.equal(edit.guidance, "NEW PRIVATE GUIDANCE");
  assert.equal(edit.expectedVersion, loaded);
  await savedOutcome(page, /^Saved\./);
  await revealButton(page, "routing guidance").waitFor();
  assert.equal(await field.count(), 0);
  assert.equal(d.routing(ids.relay).guidance, "NEW PRIVATE GUIDANCE");
  // Clearing the guidance is an explicit edit to empty.
  await revealButton(page, "routing guidance").click();
  await field.fill("");
  await changes(page)
    .getByText("Routing guidance cleared", { exact: true })
    .waitFor();
  const cleared = commandBody(page);
  await save.click();
  assert.equal((await cleared).guidance, "");
  await savedOutcome(page, /^Saved\./);
  assert.equal(d.routing(ids.relay).guidance, "");
  await page.getByRole("switch", { name: "Enable routing" }).uncheck();
  await changes(page).getByText("Routing disabled").waitFor();
  await page
    .getByLabel("Credential reference change", { exact: true })
    .selectOption({ label: "Set new environment reference" });
  await page
    .getByLabel("New environment reference", { exact: true })
    .fill("env:FIXTURE_X");
  await changes(page)
    .getByText("Credential reference: set new environment reference")
    .waitFor();
  await page.route("**/api/operator/commands", () => {});
  try {
    await save.click();
    await page.getByRole("button", { name: "Saving…" }).waitFor();
    assert.equal(
      await page.getByRole("switch", { name: "Enable routing" }).isDisabled(),
      true,
    );
  } finally {
    await page.unroute("**/api/operator/commands");
  }
});

test("Routing names TypeSafe availability in words and who allocates when it can't choose", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  // The fixture service has no TypeSafe client, so Relay's configured reference can't be used.
  await page
    .getByText("Enabled · TypeSafe unavailable · credential configured", {
      exact: true,
    })
    .waitFor();
  const notice = page.locator('[data-slot="alert"]', {
    hasText: "TypeSafe isn't available for Relay.",
  });
  assert.equal(
    (await notice.innerText()).trim(),
    "TypeSafe isn't available for Relay.\nRouting can't use its credential reference, so it can't choose assignees. New tasks without an assignee go to Jonas to allocate.",
  );
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    credentialRef: null,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  await page.reload();
  await page
    .getByText("Enabled · TypeSafe unavailable · no credential reference", {
      exact: true,
    })
    .waitFor();
  await page
    .getByText(
      "Routing has no credential reference, so it can't choose assignees. New tasks without an assignee go to Jonas to allocate.",
      { exact: false },
    )
    .waitFor();
  // The form stays editable so the reference can be set.
  assert.equal(
    await page
      .getByLabel("Credential reference change", { exact: true })
      .isDisabled(),
    false,
  );
  // A revoked lead can't allocate either, so unassigned tasks wait.
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profiles.Jonas as string,
    expectedVersion: Number(d.profile(ids.profiles.Jonas as string).version),
    revoked: true,
  });
  await page.reload();
  await page
    .getByText(
      "New tasks without an assignee wait until the project has an available lead.",
      { exact: false },
    )
    .waitFor();
  await page.goto(page.url().replace(ids.relay, ids.atlas));
  await page
    .getByText("Routing off · no credential reference", { exact: true })
    .waitFor();
  await page
    .getByText(
      "Routing is off. Every new task needs an assignee or goes to Mira.",
      { exact: true },
    )
    .waitFor();
  // Without a lead, unassigned tasks wait rather than being allocated.
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    leadProfileId: null,
  });
  await page.reload();
  await page
    .getByText(
      "Routing is off. Every new task needs an assignee or waits until the project has an available lead.",
      { exact: true },
    )
    .waitFor();
});

test("Routing conflict keeps the checked candidates and a revealed guidance edit until the newer version is reviewed", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  await revealButton(page, "routing guidance").click();
  const guidance = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await guidance.fill("EDITED BEFORE A CONFLICT");
  const d = f.service.domain();
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
  assert.equal(await guidance.inputValue(), "EDITED BEFORE A CONFLICT");
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
  // The edit is kept and now rides on the newer version.
  assert.equal(await guidance.inputValue(), "EDITED BEFORE A CONFLICT");
  const newer = Number(d.routing(ids.relay).version);
  const sent = commandBody(page);
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  const body = await sent;
  assert.equal(body.expectedVersion, newer);
  assert.equal(body.guidance, "EDITED BEFORE A CONFLICT");
  await savedOutcome(page, /^Saved\./);
  assert.equal(d.routing(ids.relay).guidance, "EDITED BEFORE A CONFLICT");
});

test("GitHub source keeps saved rows private and sends keep markers for in-place edits", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page.getByRole("heading", { name: "1 · Discovery sources" }).waitFor();
  await page.getByText("S-1 · Repository").waitFor();
  await page.getByText("Private query kept").waitFor();
  await page.getByText("PVT_atlas · Filter kept · private").waitFor();
  await page.getByText("Local path: Kept · private").waitFor();
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  const html = await page.content();
  for (const secret of ["PRIVATE", "atlas-checkout", "FIXTURE_GITHUB"])
    assert.equal(html.includes(secret), false, secret);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  assert.equal(
    await page.getByLabel("Source credential choice", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.getByRole("button", { name: "Remove S-3" }).click();
  await page.getByText("Will be removed").waitFor();
  await changes(page).getByText("− S-3 · GitHub Project PVT_atlas").waitFor();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Selection kind", { exact: true })
    .selectOption({ label: "Search" });
  await page
    .getByLabel("Search query", { exact: true })
    .fill("PRIVATE NEW QUERY");
  await page.getByText("New · inactive").waitFor();
  await changes(page)
    .getByText("+ S-4 · Search (query private) · added inactive")
    .waitFor();
  assert.equal((await changes(page).innerText()).includes("PRIVATE"), false);
  await captureBrowserEvidence(page, "1366-source");
  const pathBefore = d.githubConfiguration(ids.atlas).repositories[0]?.path;
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-4", kind: "search", query: "PRIVATE NEW QUERY" },
  ]);
  assert.deepEqual(sent.repositories, [
    { repositoryId: "acme/atlas", ref: "main" },
  ]);
  await page
    .locator(".settings-status")
    .getByText(/Saved \d\d:\d\d · Environment reference · unavailable/)
    .waitFor();
  const saved = d.githubConfiguration(ids.atlas);
  assert.deepEqual(
    saved.selections.map((s) => s.id),
    ["S-1", "S-2", "S-4"],
  );
  assert.equal(
    saved.selections.find((s) => s.id === "S-2" && s.kind === "search")?.kind,
    "search",
  );
  assert.equal(saved.repositories[0]?.path, pathBefore);
  await page.getByText("S-4 · Search").waitFor();
});

test("removing all repository access needs confirmation and Discard restores the row", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await page
    .getByRole("button", { name: "Remove repository acme/atlas" })
    .click();
  const confirm = page.getByLabel("Remove all repository access");
  await confirm.waitFor();
  assert.equal(await confirm.isChecked(), false);
  assert.equal(await save.isDisabled(), true);
  // The checkbox is the only confirmation: the consequence is a change-list line, never an alert.
  await changes(page)
    .getByText("Removes every repository from Atlas.", { exact: true })
    .waitFor();
  assert.equal(await changes(page).getByRole("alert").count(), 0);
  assert.equal(await outcomeMessages(page).count(), 0);
  await confirm.check();
  assert.equal(await save.isEnabled(), true);
  await captureBrowserEvidence(page, "1366-source-remove-all");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByText("Local path: Kept · private").waitFor();
  assert.equal(await confirm.count(), 0);
  await page
    .getByRole("button", { name: "Remove repository acme/atlas" })
    .click();
  await confirm.check();
  await save.click();
  await savedOutcome(page);
  assert.deepEqual(
    f.service.domain().githubConfiguration(ids.atlas).repositories,
    [],
  );
});

test("GitHub source repository and readiness errors focus the exact row without echo", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  await page.getByRole("button", { name: "Add repository" }).click();
  await page
    .getByLabel("Linked repository ID", { exact: true })
    .fill("acme/extra");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill("relative/PRIVATE-PATH");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .locator("#source-repositories-error")
    .getByText("Check linked repository IDs, paths and refs.")
    .waitFor();
  assert.equal(
    await page
      .getByLabel("New local repository path", { exact: true })
      .inputValue(),
    "relative/PRIVATE-PATH",
  );
  assert.equal(
    (await page.locator(".settings-page [role=alert]").allInnerTexts())
      .join(" ")
      .includes("PRIVATE"),
    false,
  );
  const checkout = await createCheckout(f.directory, "extra-checkout");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill(checkout);
  await page
    .getByLabel("Linked repository ref", { exact: true })
    .last()
    .fill("HEAD");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.equal(
    f.service.domain().githubConfiguration(ids.atlas).repositories.length,
    2,
  );
  await page
    .getByLabel("Readiness matching", { exact: true })
    .selectOption({ label: "Any condition" });
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.activeElement?.id === "source-conditions-1-name" &&
      document.activeElement.getAttribute("aria-describedby") ===
        "source-conditions-error",
  );
  await page
    .locator("#source-conditions-error")
    .getByText("Check readiness mode and complete conditions.")
    .waitFor();
});

test("GitHub source shows no readiness rule, saves an added rule, removes it, and never clears an unavailable rule", async (t, journey) => {
  const previous = process.env.FIXTURE_GITHUB;
  process.env.FIXTURE_GITHUB = "offline-readiness-rule-value";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_GITHUB;
    else process.env.FIXTURE_GITHUB = previous;
  });
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=github",
  );
  const d = f.service.domain();
  const noRule = page.getByText("No readiness rule:", { exact: false });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await noRule.waitFor();
  assert.equal(await page.getByLabel("Ready label").count(), 0);
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page.getByLabel("Ready label").fill("ready-for-agent");
  await save.click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.relay).readiness, {
    mode: "all",
    conditions: [{ kind: "label", name: "ready-for-agent" }],
  });
  await page.getByRole("button", { name: "Remove condition 1" }).click();
  await noRule.waitFor();
  const removal = page.getByText("Readiness: no readiness rule", {
    exact: true,
  });
  await removal.waitFor();
  await save.click();
  await removal.waitFor({ state: "detached" });
  assert.equal(d.githubConfiguration(ids.relay).readiness, null);
  // A rule naming private text is withheld: shown as unknown, never as no rule.
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: d.githubConfiguration(ids.relay).version,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: [],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", name: "offline-readiness-rule-value" }],
    },
    repositories: [],
  });
  await page.reload();
  await page
    .getByText("Saved readiness is unavailable; add a condition to replace it.")
    .waitFor();
  assert.equal(await noRule.count(), 0);
  assert.equal(await save.isDisabled(), true);
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page.getByLabel("Ready label").fill("ready");
  await page
    .getByText("(replaces unavailable readiness)", { exact: false })
    .waitFor();
  assert.equal(await save.isDisabled(), false);
});

/** Settings on Atlas's GitHub tab with fake GitHub discovery configured. */
async function startDiscovery(
  journey: Parameters<typeof startSettings>[0],
  state: { failure?: Error; calls?: string[]; truncated?: boolean },
) {
  const started = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
    undefined,
    undefined,
    { setup: { discovery: fakeDiscovery(state) } },
  );
  await new OperatorApi(started.f.service, [started.f.directory]).execute({
    type: "discovery.configure",
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  await started.page.reload();
  return started;
}
const addProjectFieldCondition = async (page: Page) => {
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page
    .getByLabel("Condition kind")
    .last()
    .selectOption({ label: "Project field" });
};
const optionNames = (page: Page, label: string) =>
  page
    .getByLabel(label, { exact: true })
    .locator("option")
    .evaluateAll((o) => o.map((x) => x.textContent));

test("a readiness Project-field condition is picked by name and saves the same node IDs", async (_t, journey) => {
  const state: { calls: string[] } = { calls: [] };
  const { f, ids, page } = await startDiscovery(journey, state);
  const d = f.service.domain();
  const version = d.githubConfiguration(ids.atlas).version;
  await addProjectFieldCondition(page);
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Readiness Project node ID").count(), 0);
  // Only the Projects linked to the source's repository are listed, not the owner's others.
  await page
    .getByLabel("Readiness Project", { exact: true })
    .selectOption({ label: "Atlas roadmap" });
  assert.deepEqual(await optionNames(page, "Readiness Project"), [
    "Choose a Project",
    "Atlas roadmap",
  ]);
  await page
    .getByLabel("Readiness field", { exact: true })
    .selectOption({ label: "Status" });
  assert.deepEqual(await optionNames(page, "Readiness field"), [
    "Choose a field",
    "Status",
    "Priority",
  ]);
  assert.deepEqual(await optionNames(page, "Readiness option"), [
    "Choose an option",
    "Todo",
    "Ready",
  ]);
  await page
    .getByLabel("Readiness option", { exact: true })
    .selectOption({ label: "Ready" });
  await captureBrowserEvidence(page, "readiness-picker");
  const body = commandBody(page);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const command = (await body) as { readiness: { conditions: unknown[] } };
  await savedOutcome(page);
  const picked = {
    kind: "project-field",
    projectNodeId: "PVT_atlas",
    fieldNodeId: "PVTSSF_status",
    optionNodeId: "PVTSSO_ready",
  };
  assert.deepEqual(command.readiness.conditions.at(-1), picked);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).readiness?.conditions.at(-1),
    picked,
  );
  assert.equal(d.githubConfiguration(ids.atlas).version, version + 1);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).selections.map((s) => s.id),
    ["S-1", "S-2", "S-3"],
  );
  assert.deepEqual(
    ["repositories", "projects", "projectFields"].filter(
      (call) => !state.calls.includes(call),
    ),
    [],
  );
});

test("a readiness Project-field condition keeps typed node IDs when discovery fails or is truncated", async (_t, journey) => {
  for (const state of [
    { truncated: true },
    { failure: new DiscoveryFailure("unauthorized") },
  ]) {
    const { f, ids, page } = await startDiscovery(journey, state);
    await addProjectFieldCondition(page);
    await page
      .getByText("GitHub discovery is unavailable", { exact: false })
      .waitFor();
    assert.equal(
      await page.getByLabel("Readiness Project", { exact: true }).count(),
      0,
    );
    await page.getByLabel("Readiness Project node ID").fill("PVT_typed");
    await page.getByLabel("Readiness field node ID").fill("PVTSSF_typed");
    await page.getByLabel("Readiness option node ID").fill("PVTSSO_typed");
    await captureBrowserEvidence(page, "readiness-picker-typed");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await savedOutcome(page);
    assert.deepEqual(
      f.service
        .domain()
        .githubConfiguration(ids.atlas)
        .readiness?.conditions.at(-1),
      {
        kind: "project-field",
        projectNodeId: "PVT_typed",
        fieldNodeId: "PVTSSF_typed",
        optionNodeId: "PVTSSO_typed",
      },
    );
  }
});

test("a saved readiness condition that discovery does not list stays typed, editable and savable", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, { calls: [] });
  const d = f.service.domain();
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
    ],
    readiness: {
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: "PVT_gone",
          fieldNodeId: "PVTSSF_gone",
          optionNodeId: "PVTSSO_gone",
        },
      ],
    },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await page.reload();
  const project = page.getByLabel("Readiness Project node ID");
  await project.waitFor();
  await page
    .getByText("not in the discovered lists", { exact: false })
    .waitFor();
  assert.equal(await project.inputValue(), "PVT_gone");
  assert.equal(
    await page.getByLabel("Readiness option node ID").inputValue(),
    "PVTSSO_gone",
  );
  await page.getByLabel("Readiness option node ID").fill("PVTSSO_other");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).readiness?.conditions, [
    {
      kind: "project-field",
      projectNodeId: "PVT_gone",
      fieldNodeId: "PVTSSF_gone",
      optionNodeId: "PVTSSO_other",
    },
  ]);
});

test("GitHub source conflict keeps rows and an unknown save is checked once", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page.getByRole("button", { name: "Remove S-3" }).click();
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
      { id: "S-5", kind: "search", query: "PRIVATE ELSEWHERE" },
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  await page.getByText("Will be removed").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.getByText("Will be removed").waitFor();
  // The source saved elsewhere joins the form as a kept row instead of being dropped.
  await page.getByText("S-5 · Search").waitFor();
  assert.equal((await changes(page).innerText()).includes("S-5"), false);
  const version = d.githubConfiguration(ids.atlas).version;
  await page.route("**/api/operator/commands", (r) => r.abort());
  let first: Record<string, unknown> | undefined;
  try {
    const body = commandBody(page);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    first = await body;
    await page.getByText("We couldn't confirm the save.").waitFor();
    assert.equal(await outcomeMessages(page).count(), 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandBody(page);
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  assert.deepEqual(await replay, first);
  await savedOutcome(page);
  assert.equal(d.githubConfiguration(ids.atlas).version, version + 1);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).selections.map((s) => s.id),
    ["S-1", "S-2", "S-5"],
  );
});

test("an unknown source save with rows removed elsewhere keeps its one action and message", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  await page.getByRole("button", { name: "Remove S-3" }).click();
  await page.route("**/api/operator/commands", (r) => r.abort());
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("We couldn't confirm the save.").waitFor();
  // S-2 is removed elsewhere while the save is unsettled; the form keeps its kept row.
  const d = f.service.domain();
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await refresh(page);
  await page.getByText("S-2 is no longer saved", { exact: false }).waitFor();
  // Exactly one action: the unknown outcome's check, never a second way to review.
  assert.equal(
    await page.getByRole("button", { name: "Review changes" }).count(),
    0,
  );
  const unknown = outcomeMessages(page);
  assert.equal(await unknown.count(), 1);
  assert.equal(await unknown.getByRole("button").count(), 1);
  await unknown
    .getByRole("button", { name: "Check whether it saved" })
    .waitFor();
  assert.equal(
    (await unknown.locator("p").innerText()).trim(),
    "We couldn't confirm the save.",
  );
});

test("a re-read of another writer's routing retires the saved line", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  const saved = await savedOutcome(page);
  await saved.getByText(/^Saved\. Routing now uses .*Nora/).waitFor();
  // A plain re-read of the same version keeps the confirmation.
  await refresh(page);
  await savedOutcome(page, /^Saved\. Routing now uses .*Nora/);
  // Another writer saves routing, and the next re-read must not describe it as this save.
  // An unedited reveal belongs to the version it was read at, so it goes back to kept.
  await revealButton(page, "routing guidance").click();
  await page
    .getByRole("textbox", { name: "Routing guidance", exact: true })
    .waitFor();
  const d = f.service.domain();
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  await refresh(page);
  await page
    .getByRole("region", { name: "Saved routing" })
    .getByText("Candidates: Eli", { exact: true })
    .waitFor();
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.doesNotMatch(
    await page.locator(".settings-status").innerText(),
    /Saved \d\d:\d\d/,
  );
  await revealButton(page, "routing guidance").waitFor();
  assert.equal(await showsText(page, "PRIVATE"), false);
});

test("another writer committing between a routing save and its re-read is not described as saved", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  // Hold the re-read that follows the save until another writer has committed.
  let held!: () => void, release!: () => void;
  const reread = new Promise<void>((resolve) => (held = resolve));
  const writer = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/api/operator/projects/*/configuration",
    async (route) => {
      held();
      await writer;
      await route.continue();
    },
  );
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await reread;
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  release();
  await page
    .getByRole("region", { name: "Saved routing" })
    .getByText("Candidates: Eli", { exact: true })
    .waitFor();
  // The form shows the other writer's version, so nothing claims it was this save.
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.doesNotMatch(
    await page.locator(".settings-status").innerText(),
    /Saved \d\d:\d\d/,
  );
  await page
    .getByRole("button", { name: "Save routing", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    false,
  );
});

test("Sync & placement shows preview, observations and the placement status line", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=sync",
  );
  await page.getByRole("heading", { name: "Preview and activation" }).waitFor();
  await page
    .locator(".settings-status")
    .getByText("No placement conflicts.")
    .waitFor();
  await page.getByLabel("Selection to preview", { exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: "Refresh all sources",
    })
    .waitFor();
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  await captureBrowserEvidence(page, "1366-sync");
});

test("a repository link saved elsewhere under the same id needs an explicit choice", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const mine = await createCheckout(f.directory, "mine-checkout"),
    theirs = await createCheckout(f.directory, "theirs-checkout");
  await page.getByRole("button", { name: "Add repository" }).click();
  await page
    .getByLabel("Linked repository ID", { exact: true })
    .fill("acme/new");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill(mine);
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [
      { repositoryId: "acme/atlas", ref: "main" },
      { repositoryId: "acme/new", path: theirs, ref: "main" },
    ],
  });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.getByText("acme/new is linked twice", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await page
    .getByRole("button", { name: "Remove new repository acme/new" })
    .click();
  assert.equal(await save.isDisabled(), true, "nothing left to save");
  const saved = d.githubConfiguration(ids.atlas).repositories;
  assert.equal(
    saved.find((r) => r.repositoryId === "acme/new")?.path,
    await realpath(theirs),
  );
  assert.equal((await page.content()).includes("theirs-checkout"), false);
});

test("Sync and GitHub source show stored readiness counts and a zero-match warning that opens the Readiness panel", async (t, journey) => {
  const previous = process.env.FIXTURE_GITHUB;
  process.env.FIXTURE_GITHUB = "offline-readiness-source-value";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_GITHUB;
    else process.env.FIXTURE_GITHUB = previous;
  });
  let complete = true;
  const issue = (n: number) => ({
    providerInstance: "github.com" as const,
    nodeId: `I_${n}`,
    repositoryId: "acme/atlas",
    repositoryName: "acme/atlas",
    number: n,
    title: `Issue ${n}`,
    body: "Scope",
    state: "open" as const,
    labels: [],
    projectFields: [],
  });
  const reader: GitHubReaderFactory = () => ({
    async readSelection() {
      return complete
        ? {
            complete: true as const,
            issues: [1, 2, 3].map(issue),
            reason: null,
          }
        : { complete: false as const, issues: [], reason: "http-403" };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" as const };
    },
  });
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
    undefined,
    undefined,
    { readerFactory: reader },
  );
  const d = f.service.domain();
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    selectionId: "S-1",
    expectedVersion: d.githubConfiguration(ids.atlas).version,
  });
  await f.service.refreshGitHub();
  const counts = "3 observed · 3 open · 0 match label `ready`";
  const warning =
    "No open item matches the readiness rule (label `ready`); imported tasks stay Draft until one does.";
  await page.goto(
    web.origin + resolve("/app/projects/:atlas/settings?tab=sync", ids),
  );
  const row = page.locator("article.settings-row").filter({ hasText: counts });
  await row.getByText(counts, { exact: true }).waitFor();
  await row.getByText(warning, { exact: false }).waitFor();
  await row.getByRole("link", { name: "Check readiness conditions" }).click();
  await page.waitForURL(/tab=github#source-readiness$/);
  await page.waitForFunction(
    () => document.activeElement?.id === "source-readiness",
  );
  await page.getByText(`S-1: ${counts}`, { exact: true }).waitFor();
  await page.getByText(warning, { exact: false }).waitFor();

  complete = false;
  await f.service.refreshGitHub();
  await page.reload();
  await page
    .getByText(`S-1: ${counts} · partial read; counts may be incomplete`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByText(warning, { exact: false }).count(), 0);
});
