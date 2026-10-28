import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { DiscoveryFailure } from "../../src/standalone/github-discovery.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createFakeGh } from "../fixtures/fake-gh.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import { fakeDiscovery } from "../fixtures/setup-home.js";
import {
  captureSettingsEvidence as captureBrowserEvidence,
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
  // The shell and the page each show their own "Refreshing." notice while their read is
  // in flight, so wait for none rather than for one locator to hide.
  await page.waitForFunction(
    () => !document.body.innerText.includes("Refreshing."),
  );
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
  const consoleText: string[] = [];
  page.on("console", (m) => consoleText.push(m.text()));
  page.on("pageerror", (e) => consoleText.push(e.message));
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
  assert.equal(consoleText.filter((t) => t.includes("PRIVATE")).length, 0);
  assert.equal(requests.filter((r) => r.includes("/private-values")).length, 1);
});

const projectTabs = (page: Page) =>
  page.getByRole("navigation", { name: "Project configuration sections" });
/** Leave the open tab for another and come back, remounting its form. */
const leaveAndReturn = async (page: Page, tab: string, other: string) => {
  await projectTabs(page).getByRole("link", { name: other }).click();
  await projectTabs(page).getByRole("link", { name: other }).waitFor();
  await page.waitForFunction(
    (name) =>
      document
        .querySelector(
          '[aria-label="Project configuration sections"] a[aria-current="page"]',
        )
        ?.textContent?.trim() === name,
    other,
  );
  await projectTabs(page).getByRole("link", { name: tab }).click();
  await page.waitForFunction(
    (name) =>
      document
        .querySelector(
          '[aria-label="Project configuration sections"] a[aria-current="page"]',
        )
        ?.textContent?.trim() === name,
    tab,
  );
};
const noChanges = async (page: Page) =>
  assert.equal(await changes(page).getByRole("listitem").count(), 0);

/** Hold every private-values read until `release` is called. */
const holdReads = async (page: Page) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/private-values", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  return release;
};
/** Command posts the page sends from now on. */
const watchPosts = (page: Page) => {
  const posts: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON() as Record<string, unknown>);
  });
  return posts;
};
/** Save waits for the comparison read: focusable, announced with its reason, and sends nothing. */
const assertOnHold = async (
  page: Page,
  save: string,
  posts: Record<string, unknown>[],
) => {
  const button = page.getByRole("button", { name: save, exact: true });
  await page
    .getByRole("status")
    .filter({ hasText: "Save is on hold" })
    .waitFor();
  assert.equal(await button.getAttribute("aria-disabled"), "true");
  assert.ok(await button.getAttribute("aria-describedby"));
  const before = posts.length;
  await button.evaluate((e) => (e as HTMLElement).click());
  await settled(page);
  assert.equal(posts.length, before, "Save on hold sends nothing");
};
const assertOffHold = async (page: Page, save: string) => {
  await page
    .getByRole("status")
    .filter({ hasText: "Save is on hold" })
    .waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByRole("button", { name: save, exact: true })
      .getAttribute("aria-disabled"),
    null,
  );
};

/** The form is clean: nothing listed, no Discard, and Save is off. */
const assertClean = async (page: Page, save: string) => {
  await changes(page).getByText("No changes yet.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Discard changes" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: save, exact: true }).isDisabled(),
    true,
  );
};

test("a form whose edits were all reverted is clean and picks up a later read", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const name = page.getByLabel("Project name", { exact: true });
  const pause = page.getByRole("switch", { name: "Pause project" });
  await name.waitFor();
  const discard = page.getByRole("button", { name: "Discard changes" });

  // A private edit that is reverted leaves the form clean.
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("CHANGED");
  await discard.waitFor();
  await instructionsField(page).fill(SENTINEL);
  await assertClean(page, "Save project");
  bumpProject(f, ids.atlas, "Atlas external one");
  await refresh(page);
  assert.equal(await name.inputValue(), "Atlas external one");
  await assertClean(page, "Save project");

  // The same for an ordinary field and for a switch.
  await name.fill("Typed");
  await name.fill("Atlas external one");
  await pause.click();
  await pause.click();
  await assertClean(page, "Save project");
  bumpProject(f, ids.atlas, "Atlas external two");
  await refresh(page);
  assert.equal(await name.inputValue(), "Atlas external two");

  // Another edit keeps the form dirty: a read does not overwrite it, and Discard is offered.
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("CHANGED");
  await instructionsField(page).fill(SENTINEL);
  await name.fill("Typed again");
  bumpProject(f, ids.atlas, "Atlas external three");
  await refresh(page);
  assert.equal(await name.inputValue(), "Typed again");
  await discard.waitFor();
  // The edit survives leaving the tab; Discard then reloads the newer values and leaves it clean.
  await leaveAndReturn(page, "General", "Routing");
  assert.equal(await name.inputValue(), "Typed again");
  await discard.click();
  assert.equal(await name.inputValue(), "Atlas external three");
  await assertClean(page, "Save project");
  bumpProject(f, ids.atlas, "Atlas external four");
  await refresh(page);
  assert.equal(await name.inputValue(), "Atlas external four");
});

test("a read that arrived during an edit is applied when the edit is undone, and a stale outcome goes with it", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const name = page.getByLabel("Project name", { exact: true });
  await name.waitFor();
  // The read is ignored while the form has an edit, and taken as soon as the edit is undone.
  await name.fill("Typed");
  bumpProject(f, ids.atlas, "Ext");
  await refresh(page);
  assert.equal(await name.inputValue(), "Typed");
  await name.fill("Atlas");
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Project name"]',
        ) as HTMLInputElement | null
      )?.value === "Ext",
  );
  await assertClean(page, "Save project");

  // A refused save: undoing the edit takes the latest read and drops the refusal.
  await name.fill("x".repeat(600));
  await saveProject(page).click();
  await page
    .getByText("Keep the name to 512 characters or fewer. It has 600.")
    .waitFor();
  await name.fill("Ext");
  bumpProject(f, ids.atlas, "Ext two");
  await refresh(page);
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Project name"]',
        ) as HTMLInputElement | null
      )?.value === "Ext two",
  );
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.equal(await name.getAttribute("aria-invalid"), "false");
  await assertClean(page, "Save project");

  // A conflict: undoing the edit takes the latest read and drops the conflict.
  await name.fill("Typed two");
  bumpProject(f, ids.atlas, "Ext three");
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await name.fill("Ext two");
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Project name"]',
        ) as HTMLInputElement | null
      )?.value === "Ext three",
  );
  assert.equal(await outcomeMessages(page).count(), 0);
  await assertClean(page, "Save project");
});

test("an edit that parses to the same JSON as the saved text is still an edit and survives a read", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
  );
  const reviewer = ids.profiles.Reviewer as string;
  const d = f.service.domain();
  const saved = '{"languages":["kotlin"],"review":true}';
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(d.profile(reviewer).version),
    capabilities: saved,
  });
  await page.reload();
  const capabilities = page.getByLabel("Capabilities", { exact: true });
  await capabilities.waitFor();
  const reformatted = '{"review": true, "languages": ["kotlin"]}';
  await capabilities.fill(reformatted);
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText("Capabilities edited")
    .waitFor();
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(d.profile(reviewer).version),
    summary: "Changed elsewhere",
  });
  const read = page.waitForResponse(
    (r) => r.request().method() === "GET" && /configuration$/.test(r.url()),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await read;
  assert.equal(await capabilities.inputValue(), reformatted);
  await page.getByRole("button", { name: "Discard changes" }).waitFor();
});

test("readiness matching with no condition is no edit, and the adopted note goes when the input is undone", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  const matching = page.getByLabel("Readiness matching", { exact: true });
  await matching.waitFor();
  await page.getByRole("button", { name: "Remove condition 1" }).click();
  await save.click();
  await savedOutcome(page);
  await matching.selectOption({ label: "Any condition" });
  await matching.selectOption({ label: "All conditions" });
  await assertClean(page, "Save changes");
  await matching.selectOption({ label: "Any condition" });
  await assertClean(page, "Save changes");
  // After Review changes, typing the adopted value back clears the note that it was loaded.
  const ref = page.getByLabel("Linked repository ref", { exact: true });
  await ref.fill("HEAD");
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
    ],
    readiness: null,
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  } as Parameters<OperatorApi["execute"]>[0]);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText("Loaded the latest version.", { exact: false })
    .waitFor();
  await ref.fill("main");
  await page.waitForFunction(
    () => !document.body.innerText.includes("Loaded the latest version."),
  );
  await assertClean(page, "Save changes");
});

/**
 * Serve private-values reads from a script. `plan` decides, per request number (from 1), to
 * hold until released, answer with a captured older body, fail, or pass through.
 */
const scriptReads = async (
  page: Page,
  plan: (n: number) => "hold-stale" | "hold-fail" | "stale" | "fail" | "real",
  stale: string,
) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = { count: 0 };
  await page.route("**/private-values", async (route) => {
    const n = ++reads.count;
    const how = plan(n);
    if (how === "hold-stale" || how === "hold-fail") await gate;
    if (how === "hold-stale" || how === "stale")
      await route
        .fulfill({ status: 200, contentType: "application/json", body: stale })
        .catch(() => {});
    else if (how === "fail" || how === "hold-fail")
      await route
        .fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "unavailable" } }),
        })
        .catch(() => {});
    else await route.continue().catch(() => {});
  });
  return { reads, release };
};
const privateBody = (page: Page, path: string) =>
  page.evaluate(async (p) => (await fetch(p)).text(), path);

test("the source tab reads again by itself when the first read settles older than the version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const stale = await privateBody(
    page,
    `/api/operator/projects/${ids.atlas}/private-values`,
  );
  const external = (text: string) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [
        { id: "S-1", keep: true },
        { id: "S-2", kind: "search", query: text },
        { id: "S-3", keep: true },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
    } as Parameters<OperatorApi["execute"]>[0]);
  const { reads, release } = await scriptReads(
    page,
    (n) => (n === 1 ? "hold-stale" : "real"),
    stale,
  );
  // The first read is out when a refresh advances the loaded version; it settles older.
  await projectTabs(page).getByRole("link", { name: "GitHub source" }).click();
  await page.getByText("Loading search query", { exact: false }).waitFor();
  await external("NEWER QUERY");
  await refresh(page);
  release();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Search query"]',
        ) as HTMLInputElement | null
      )?.value === "NEWER QUERY",
  );
  assert.equal(reads.count, 2, "one automatic re-read, no manual Try again");
  assert.equal(await page.getByText("Query unavailable").count(), 0);
  await settled(page);
  assert.equal(reads.count, 2, "no loop");
});

test("a read that fails after a refresh advanced the version is read again once", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const { reads, release } = await scriptReads(
    page,
    (n) => (n === 1 ? "hold-fail" : "real"),
    "",
  );
  // The request starts at version N and is held; a refresh moves the form to N+1; then it fails.
  await projectTabs(page).getByRole("link", { name: "GitHub source" }).click();
  await page.getByText("Loading search query", { exact: false }).waitFor();
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", kind: "search", query: "AFTER THE REFRESH" },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  } as Parameters<OperatorApi["execute"]>[0]);
  await refresh(page);
  release();
  // The failure belongs to version N, so one automatic read at N+1 follows, with no Try again.
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Search query"]',
        ) as HTMLInputElement | null
      )?.value === "AFTER THE REFRESH",
  );
  assert.equal(reads.count, 2);
  await settled(page);
  assert.equal(reads.count, 2, "no loop");
});

test("an older read is retried at most twice per version, and a failure waits for a new version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const stale = await privateBody(
    page,
    `/api/operator/projects/${ids.atlas}/private-values`,
  );
  const external = (text: string) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [
        { id: "S-1", keep: true },
        { id: "S-2", kind: "search", query: text },
        { id: "S-3", keep: true },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
    } as Parameters<OperatorApi["execute"]>[0]);
  await external("MOVED ON");
  await refresh(page);
  // Every read is older than the loaded version: the first plus two retries, then it stops.
  const older = await scriptReads(page, () => "stale", stale);
  await projectTabs(page).getByRole("link", { name: "GitHub source" }).click();
  const retry = page.getByRole("button", {
    name: /^Try again to load the search query/,
  });
  await retry.waitFor();
  await settled(page);
  assert.equal(older.reads.count, 3);
  // Try again is the operator's, and asks once more.
  await retry.click();
  await retry.waitFor();
  assert.equal(older.reads.count, 4);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A failed read waits for the version to move before it is read again by itself.
  await projectTabs(page).getByRole("link", { name: "General" }).click();
  await page.getByLabel("Project name", { exact: true }).waitFor();
  const failing = await scriptReads(
    page,
    (n) => (n === 1 ? "fail" : "real"),
    stale,
  );
  await projectTabs(page).getByRole("link", { name: "GitHub source" }).click();
  await page.getByText("Query unavailable", { exact: true }).waitFor();
  await settled(page);
  assert.equal(
    failing.reads.count,
    1,
    "a failure is not retried at the same version",
  );
  await external("AFTER THE FAILURE");
  await refresh(page);
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Search query"]',
        ) as HTMLInputElement | null
      )?.value === "AFTER THE FAILURE",
  );
  assert.equal(failing.reads.count, 2);
});

test("a Reveal that settles older than the form is read again by itself, and leaving cancels it", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const stale = await privateBody(
    page,
    `/api/operator/projects/${ids.atlas}/private-values`,
  );
  const { reads, release } = await scriptReads(
    page,
    (n) => (n === 1 ? "hold-stale" : "real"),
    stale,
  );
  await revealButton(page, "instructions").click();
  await page.getByLabel("Project name", { exact: true }).waitFor();
  bumpProject(f, ids.atlas, "Atlas moved on");
  await refresh(page);
  release();
  // The read settled older than the loaded version; the form reads again and opens the field.
  await instructionsField(page).waitFor();
  assert.equal(await instructionsField(page).inputValue(), SENTINEL);
  assert.equal(reads.count, 2);
  await settled(page);
  assert.equal(reads.count, 2, "no loop");

  // Leaving the page mid-read cancels the retry.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto(page.url());
  await page.getByLabel("Project name", { exact: true }).waitFor();
  const second = await scriptReads(
    page,
    (n) => (n === 1 ? "hold-stale" : "real"),
    stale,
  );
  await revealButton(page, "instructions").click();
  await projectTabs(page).getByRole("link", { name: "Routing" }).click();
  second.release();
  await settled(page);
  assert.equal(second.reads.count, 1);
});

test("a failed Reveal is not remembered: a later save leaves the field kept", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const stale = await privateBody(
    page,
    `/api/operator/projects/${ids.atlas}/private-values`,
  );
  const { reads } = await scriptReads(
    page,
    (n) => (n === 1 ? "fail" : "real"),
    stale,
  );
  await revealButton(page, "instructions").click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Couldn't load the instructions." })
    .waitFor();
  // The operator moves on and saves something else; the text is not read and shown unasked.
  const name = page.getByLabel("Project name", { exact: true });
  await name.fill("Renamed");
  await saveProject(page).click();
  await savedOutcome(page);
  await settled(page);
  assert.equal(reads.count, 1);
  assert.equal(await instructionsField(page).count(), 0);
  assert.equal(await showsText(page, SENTINEL), false);
  assert.equal(f.service.domain().project(ids.atlas).name, "Renamed");
});

test("routing and profile Reveal wait for a current read, and a newer read reloads the profile", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  const stale = await privateBody(
    page,
    `/api/operator/projects/${ids.relay}/private-values`,
  );
  const { reads, release } = await scriptReads(
    page,
    (n) => (n === 1 ? "hold-stale" : "real"),
    stale,
  );
  await revealButton(page, "routing guidance").click();
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
  release();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await field.waitFor();
  assert.equal(await field.inputValue(), "PRIVATE ROUTING GUIDANCE");
  assert.equal(reads.count, 2);

  // The profile page: a read newer than the loaded form reloads the configuration, then opens.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const reviewer = ids.profiles.Reviewer as string;
  await page.goto(`${web.origin}/app/profiles/${reviewer}/settings`);
  await page.getByLabel("Summary", { exact: true }).waitFor();
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(d.profile(reviewer).version),
    summary: "Changed elsewhere",
  });
  await page.getByRole("button", { name: "Reveal instructions" }).click();
  const instructions = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await instructions.waitFor();
  assert.equal(
    await instructions.inputValue(),
    "PRIVATE REVIEWER INSTRUCTIONS",
  );
  assert.equal(
    await page.getByLabel("Summary", { exact: true }).inputValue(),
    "Changed elsewhere",
  );
});

test("an edit that another writer saved identically is dropped, and later reads apply", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const save = async (instructions: string) =>
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: Number(d.project(ids.atlas).version),
      instructions,
    });
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("SAME TEXT");
  await changes(page)
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  await save("SAME TEXT");
  await refresh(page);
  // The saved text caught up with the draft: no edit, no Discard, Save not held, nothing sent.
  await assertClean(page, "Save project");
  await assertOffHold(page, "Save project");
  // A later change elsewhere shows the new saved text, never the obsolete local value.
  await save("NEXT TEXT");
  await refresh(page);
  await assertClean(page, "Save project");
  await revealButton(page, "instructions").waitFor();
  await revealButton(page, "instructions").click();
  assert.equal(await instructionsField(page).inputValue(), "NEXT TEXT");
  await noChanges(page);
});

test("a query or path that another writer saved identically is dropped, and later reads apply", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const path = page.getByLabel("Local repository path", { exact: true });
  await query.waitFor();
  const checkout = await realpath(
    await createCheckout(f.directory, "identical-checkout"),
  );
  await query.fill("SAME QUERY");
  await path.fill(checkout);
  const writer = (text: string, repositoryPath?: string) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [
        { id: "S-1", keep: true },
        { id: "S-2", kind: "search", query: text },
        { id: "S-3", keep: true },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [
        repositoryPath
          ? { repositoryId: "acme/atlas", path: repositoryPath, ref: "main" }
          : { repositoryId: "acme/atlas", ref: "main" },
      ],
    } as Parameters<OperatorApi["execute"]>[0]);
  await writer("SAME QUERY", checkout);
  await refresh(page);
  await assertClean(page, "Save changes");
  await assertOffHold(page, "Save changes");
  // Later changes elsewhere are shown, not the obsolete local values.
  await writer("NEXT QUERY");
  await refresh(page);
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'input[aria-label="Search query"]',
        ) as HTMLInputElement | null
      )?.value === "NEXT QUERY",
  );
  await assertClean(page, "Save changes");
  assert.equal(await path.inputValue(), checkout);
});

test("Save waits for the saved text to be read again after Review changes", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("MY EDIT");
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "THEIR TEXT",
  });
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  // The newer version is adopted, but the comparison read has not come back: nothing is sent.
  await assertOnHold(page, "Save project", posts);
  assert.equal(posts.length, 1);
  assert.equal(d.project(ids.atlas).instructions, "THEIR TEXT");
  release();
  await assertOffHold(page, "Save project");
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  await saveProject(page).click();
  await savedOutcome(page);
  assert.equal(posts.length, 2);
  assert.equal(posts[1]?.instructions, "MY EDIT");
  assert.equal(d.project(ids.atlas).instructions, "MY EDIT");
});

test("Save stays on hold with a way out when the comparison read fails", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("MY EDIT");
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "THEIR TEXT",
  });
  const posts = watchPosts(page);
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Couldn't check whether this changed elsewhere." })
    .waitFor();
  await assertOnHold(page, "Save project", posts);
  // Discard is the way out of a read that never comes back; Try again is the other.
  await page.getByRole("button", { name: "Discard changes" }).waitFor();
  await page.unroute("**/private-values");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await assertOffHold(page, "Save project");
  assert.equal(posts.length, 1);
  await page.getByRole("button", { name: "Discard changes" }).click();
  await assertClean(page, "Save project");
  assert.equal(d.project(ids.atlas).instructions, "THEIR TEXT");
});

test("routing and profile saves wait for the comparison read after Review changes", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await revealButton(page, "routing guidance").click();
  await field.fill("MY GUIDANCE");
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    guidance: "THEIR GUIDANCE",
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save routing", posts);
  assert.equal(d.routing(ids.relay).guidance, "THEIR GUIDANCE");
  release();
  await assertOffHold(page, "Save routing");
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();

  // The same on the profile page.
  const reviewer = ids.profiles.Reviewer as string;
  await page.goto(`${web.origin}/app/profiles/${reviewer}/settings`);
  await page.getByRole("button", { name: "Reveal instructions" }).click();
  const instructions = page.getByRole("textbox", {
    name: "Instructions",
    exact: true,
  });
  await instructions.fill("MY INSTRUCTIONS");
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: reviewer,
    expectedVersion: Number(d.profile(reviewer).version),
    instructions: "THEIR INSTRUCTIONS",
  });
  const profilePosts = watchPosts(page);
  const releaseProfile = await holdReads(page);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save profile", profilePosts);
  assert.equal(d.profile(reviewer).instructions, "THEIR INSTRUCTIONS");
  releaseProfile();
  await assertOffHold(page, "Save profile");
});

test("a reverted routing edit leaves the form clean and picks up a later read", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  const candidate = (n: string) =>
    page.getByRole("checkbox", { name: new RegExp(`^${n} ·`) });
  await candidate("Eli").waitFor();
  await candidate("Mira").check();
  await candidate("Mira").uncheck();
  // Unchecking and checking the saved candidates in another order changes the list order, not
  // its contents; one of these two orders differs from the saved one.
  for (const order of [
    ["Worker", "Builder", "Eli"],
    ["Eli", "Builder", "Worker"],
  ]) {
    for (const n of order) await candidate(n).uncheck();
    for (const n of order) await candidate(n).check();
    await changes(page)
      .getByText("No changes yet.", { exact: false })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Discard changes" }).count(),
      0,
    );
  }
  // Hidden input behind a choice that is switched off is not an edit either.
  const mode = page.getByLabel("Credential reference change", { exact: true });
  await mode.selectOption({ label: "Set new environment reference" });
  await page
    .getByLabel("New environment reference", { exact: true })
    .fill("env:HIDDEN_REFERENCE");
  await mode.selectOption({ label: "Preserve current reference" });
  await revealButton(page, "routing guidance").click();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await field.fill("CHANGED");
  await field.fill("PRIVATE ROUTING GUIDANCE");
  await assertClean(page, "Save routing");
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Mira as string],
  });
  await refresh(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input[type=checkbox]")].some(
      (e) =>
        (e as HTMLInputElement).checked &&
        e.closest("label")?.textContent?.startsWith("Mira"),
    ),
  );
  assert.equal(await candidate("Eli").isChecked(), false);
  await assertClean(page, "Save routing");
});

test("a reverted source edit leaves the form clean and picks up a later read", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const path = page.getByLabel("Local repository path", { exact: true });
  const ref = page.getByLabel("Linked repository ref", { exact: true });
  await query.waitFor();
  const storedPath = await path.inputValue();
  await query.fill("CHANGED");
  await query.fill("PRIVATE SAVED QUERY");
  await path.fill("/changed");
  await path.fill(storedPath);
  await ref.fill("HEAD");
  await ref.fill("main");
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
  await page
    .getByRole("button", { name: "Undo remove GitHub Project (S-3)" })
    .click();
  await assertClean(page, "Save changes");
  const external = (mode: "all" | "any") =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [
        { id: "S-1", keep: true },
        { id: "S-2", keep: true },
        { id: "S-3", keep: true },
      ],
      readiness: { mode, conditions: [{ kind: "label", name: "ready" }] },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
    } as Parameters<OperatorApi["execute"]>[0]);
  await external("any");
  await refresh(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("select")].some(
      (e) =>
        (e as HTMLSelectElement).selectedOptions[0]?.textContent ===
        "Any condition",
    ),
  );
  await assertClean(page, "Save changes");
  // An edit that stays keeps the form dirty and a later read does not overwrite it.
  await query.fill("KEPT EDIT");
  await external("all");
  await refresh(page);
  assert.equal(await query.inputValue(), "KEPT EDIT");
  await page.getByRole("button", { name: "Discard changes" }).waitFor();
});

test("a reverted private edit is no edit after leaving the page or adopting a newer version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const name = page.getByLabel("Project name", { exact: true });
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("CHANGED");
  await changes(page)
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  await instructionsField(page).fill(SENTINEL);
  await noChanges(page);
  assert.equal(await saveProject(page).isDisabled(), true);
  // Leaving and returning keeps no edit: the field is kept again and nothing can be sent.
  await leaveAndReturn(page, "General", "Routing");
  await revealButton(page, "instructions").waitFor();
  await noChanges(page);
  assert.equal(await saveProject(page).isDisabled(), true);

  // Reveal, edit and revert, then another writer changes the same text and a name edit conflicts.
  await name.fill("Atlas II");
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("CHANGED AGAIN");
  await instructionsField(page).fill(SENTINEL);
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "THEIR NEWER TEXT",
  });
  const revision = Number(d.project(ids.atlas).instructionsRevision);
  const first = commandBody(page);
  await saveProject(page).click();
  assert.equal("instructions" in (await first), false);
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await revealButton(page, "instructions").waitFor();
  const second = commandBody(page);
  await saveProject(page).click();
  const sent = await second;
  assert.equal("instructions" in sent, false, "unchanged text is not resent");
  assert.equal(sent.name, "Atlas II");
  await savedOutcome(page);
  assert.equal(d.project(ids.atlas).instructions, "THEIR NEWER TEXT");
  assert.equal(Number(d.project(ids.atlas).instructionsRevision), revision);
});

test("an edited private text stays edited after leaving the page and can still be reverted", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("EDIT ONE");
  await leaveAndReturn(page, "General", "Routing");
  // Still dirty after the remount: the edit shows, Save is on, and the line names the field.
  assert.equal(await instructionsField(page).inputValue(), "EDIT ONE");
  await changes(page)
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  // Save waits while the saved text is read again to compare it with the edit.
  await assertOffHold(page, "Save project");
  assert.equal(await saveProject(page).isEnabled(), true);
  // The baseline travelled with the edit, so typing the saved text back is no edit.
  await instructionsField(page).fill(SENTINEL);
  await noChanges(page);
  assert.equal(await saveProject(page).isDisabled(), true);
  await instructionsField(page).fill("EDIT TWO");
  const body = commandBody(page);
  await saveProject(page).click();
  const sent = await body;
  assert.equal(sent.instructions, "EDIT TWO");
  assert.equal("name" in sent, false, "only the edited field is sent");
  await savedOutcome(page);
  assert.equal(d.project(ids.atlas).instructions, "EDIT TWO");
});

test("an edit made against older text says it was changed elsewhere before it replaces it", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("MY EDIT");
  assert.equal(
    await page.getByText("changed elsewhere", { exact: false }).count(),
    0,
  );
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "THEIR TEXT",
  });
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  // The edit stays, the saved text is read again, and the difference is stated, not hidden.
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  assert.equal(await instructionsField(page).inputValue(), "MY EDIT");
  assert.equal(await showsText(page, "THEIR TEXT"), false);
  // Typing the older text back is a deliberate replacement and stays an edit, with the note.
  await instructionsField(page).fill(SENTINEL);
  assert.equal(await instructionsField(page).inputValue(), SENTINEL);
  await changes(page)
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  // Typing the text that is saved now is no edit.
  await instructionsField(page).fill("THEIR TEXT");
  await noChanges(page);
  await assertClean(page, "Save project");
  assert.equal(d.project(ids.atlas).instructions, "THEIR TEXT");
});

test("an edit says so when it cannot check whether the text changed elsewhere", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await revealButton(page, "instructions").click();
  await instructionsField(page).fill("MY EDIT");
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "THEIR TEXT",
  });
  let reads = 0;
  await page.route("**/private-values", (route) => {
    reads++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    });
  });
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  // The edit is kept, and the form says it could not compare it with the saved text.
  const alert = page.getByRole("alert").filter({
    hasText: "Couldn't check whether this changed elsewhere.",
  });
  await alert.waitFor();
  assert.equal(await instructionsField(page).inputValue(), "MY EDIT");
  assert.equal(await showsText(page, "THEIR TEXT"), false);
  // One read after the conflict; a failure at the same version is the operator's to retry.
  await page.waitForFunction(() =>
    document.body.innerText.includes("Try again"),
  );
  await settled(page);
  assert.equal(reads, 1);
  await page.unroute("**/private-values");
  await alert.getByRole("button", { name: "Try again" }).click();
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  assert.equal(await alert.count(), 0);
});

test("a private read older than the loaded version is flagged on an edit", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  // Serve the first read again for every later one, so it is always older than the form.
  let stale = "";
  const first = page.waitForResponse((r) =>
    r.url().endsWith("/private-values"),
  );
  await revealButton(page, "instructions").click();
  stale = await (await first).text();
  await instructionsField(page).fill("MY EDIT");
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: stale,
    }),
  );
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "THEIR TEXT",
  });
  await saveProject(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Couldn't check whether this changed elsewhere." })
    .waitFor();
  assert.equal(await instructionsField(page).inputValue(), "MY EDIT");
  assert.equal(await showsText(page, "THEIR TEXT"), false);
  await assertOnHold(page, "Save project", watchPosts(page));
});

test("line breaks saved as CRLF do not turn typing and deleting a character into an edit", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    instructions: "LINE ONE\r\nLINE TWO",
  });
  await page.reload();
  await revealButton(page, "instructions").click();
  const field = instructionsField(page);
  await field.waitFor();
  await field.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("X");
  await changes(page)
    .getByText("Instructions edited", { exact: true })
    .waitFor();
  await page.keyboard.press("Backspace");
  await noChanges(page);
  assert.equal(await saveProject(page).isDisabled(), true);
});

test("revealing after another writer saved opens the newer version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  await page.getByLabel("Project name", { exact: true }).waitFor();
  bumpProject(f, ids.atlas, "Atlas elsewhere");
  await revealButton(page, "instructions").click();
  // The read is newer than the loaded form, so the form re-reads and then opens the field.
  await instructionsField(page).waitFor();
  assert.equal(await instructionsField(page).inputValue(), SENTINEL);
  assert.equal(
    await instructionsField(page).evaluate((e) => e === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas elsewhere",
  );
  assert.equal(await saveProject(page).isDisabled(), true);
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

    // Another writer moves the project on after this edit, so the save conflicts.
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
  // Reveal works at phone width: a tappable control, the field in view, no overflow.
  const reveal = revealButton(page, "instructions");
  assert.ok(((await reveal.boundingBox())?.height ?? 0) >= 32);
  await reveal.click();
  const field = instructionsField(page);
  await field.waitFor();
  assert.equal(await field.inputValue(), SENTINEL);
  assert.equal(await field.evaluate((e) => e === document.activeElement), true);
  await noPageOverflow(page);
  await page.reload();
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

test("routing guidance reverted or edited keeps its state after leaving the tab", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save routing", exact: true });
  await revealButton(page, "routing guidance").click();
  await field.fill("CHANGED");
  await field.fill("PRIVATE ROUTING GUIDANCE");
  await noChanges(page);
  await leaveAndReturn(page, "Routing", "General");
  await revealButton(page, "routing guidance").waitFor();
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  await revealButton(page, "routing guidance").click();
  await field.fill("EDITED GUIDANCE");
  await leaveAndReturn(page, "Routing", "General");
  assert.equal(await field.inputValue(), "EDITED GUIDANCE");
  await changes(page)
    .getByText("Routing guidance edited", { exact: true })
    .waitFor();
  await field.fill("PRIVATE ROUTING GUIDANCE");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  assert.equal(d.routing(ids.relay).guidance, "PRIVATE ROUTING GUIDANCE");
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

test("GitHub source shows local paths and search queries plainly and edits them in place", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page.getByRole("heading", { name: "1 · Discovery sources" }).waitFor();
  await page
    .getByRole("heading", { name: "acme/atlas · repository issues" })
    .waitFor();
  await page.getByText("Filter kept · private").waitFor();
  const path = page.getByLabel("Local repository path", { exact: true });
  const query = page.getByLabel("Search query", { exact: true });
  await query.waitFor();
  const stored = d.githubConfiguration(ids.atlas).repositories[0]?.path ?? "";
  assert.ok(stored.includes("atlas-checkout"));
  assert.equal(await path.inputValue(), stored);
  assert.equal(await query.inputValue(), "PRIVATE SAVED QUERY");
  assert.equal(await revealReads(page), 1, "loaded once with the tab");
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  // Project filters and credential values stay hidden.
  for (const secret of ["PRIVATE FILTER", "FIXTURE_GITHUB"])
    assert.equal(await showsText(page, secret), false, secret);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  const config = await read.text();
  for (const secret of ["PRIVATE", "atlas-checkout"])
    assert.equal(config.includes(secret), false, secret);
  assert.equal(
    await page.getByLabel("Source credential choice", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true, "showing values is no change");
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
  await page.getByText("Will be removed").waitFor();
  await changes(page).getByText("− S-3 · GitHub Project PVT_atlas").waitFor();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Selection kind", { exact: true })
    .selectOption({ label: "Search" });
  await query.last().fill("PRIVATE NEW QUERY");
  await page.getByText("Not saved yet").waitFor();
  await changes(page).getByText("+ S-4 · Search · added inactive").waitFor();
  const checkout = await createCheckout(f.directory, "atlas-checkout-2");
  await query.first().fill("PRIVATE EDITED QUERY");
  await path.fill(checkout);
  const lines = await changes(page).getByRole("listitem").allInnerTexts();
  assert.deepEqual(lines, [
    "Search query edited for S-2",
    "− S-3 · GitHub Project PVT_atlas",
    "+ S-4 · Search · added inactive",
    "Local path changed for acme/atlas",
  ]);
  assert.equal(lines.join(" ").includes("PRIVATE"), false);
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", kind: "search", query: "PRIVATE EDITED QUERY" },
    { id: "S-4", kind: "search", query: "PRIVATE NEW QUERY" },
  ]);
  assert.deepEqual(sent.repositories, [
    { repositoryId: "acme/atlas", ref: "main", path: checkout },
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
  const search = saved.selections.find((s) => s.id === "S-2");
  assert.equal(
    search?.kind === "search" && search.query,
    "PRIVATE EDITED QUERY",
  );
  assert.equal(
    await realpath(saved.repositories[0]?.path ?? ""),
    await realpath(checkout),
  );
  // The edited source reads inactive until it is previewed again, and the new values show.
  await page
    .getByRole("heading", { name: "PRIVATE NEW QUERY · search" })
    .waitFor();
  const row = page.locator(".settings-row", {
    hasText: "PRIVATE EDITED QUERY",
  });
  await row.getByText("Inactive", { exact: true }).waitFor();
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll("input")].some((e) => e.value === value),
    "PRIVATE EDITED QUERY",
  );
  assert.equal(
    await path.inputValue(),
    saved.repositories[0]?.path,
    "the saved path is read again at the new version",
  );
  assert.equal(await save.isDisabled(), true);
});

test("GitHub source private values unavailable keeps rows kept and saveable", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.reload();
  await page.getByText("Local path unavailable", { exact: true }).waitFor();
  await page.getByText("Query unavailable", { exact: true }).waitFor();
  const retry = page.getByRole("button", { name: /^Try again to load the/ });
  assert.equal(await retry.count(), 2);
  assert.equal(await retry.first().isEnabled(), true);
  assert.equal(await showsText(page, "PRIVATE"), false);
  assert.equal(
    await page.getByLabel("Local repository path", { exact: true }).count(),
    0,
  );
  // Other edits are not blocked, and nothing is sent for the unread values.
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.getByLabel("Linked repository ref", { exact: true }).fill("HEAD");
  await changes(page).getByText("Ref for acme/atlas: main → HEAD").waitFor();
  const body = commandBody(page);
  // The saved version moves, so the page reads the private values once more.
  const reread = page.waitForResponse((r) =>
    r.url().endsWith("/private-values"),
  );
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  assert.deepEqual(sent.repositories, [
    { repositoryId: "acme/atlas", ref: "HEAD" },
  ]);
  await savedOutcome(page);
  const saved = f.service.domain().githubConfiguration(ids.atlas);
  assert.equal(saved.repositories[0]?.ref, "HEAD");
  assert.equal(
    saved.selections.some(
      (s) => s.kind === "search" && s.query === "PRIVATE SAVED QUERY",
    ),
    true,
  );
  // Reading again brings both values back. That read must have failed before the route goes,
  // or it would succeed on its own and replace the buttons this clicks.
  await reread;
  await page.unroute("**/private-values");
  await retry.first().click();
  await page.getByLabel("Search query", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Search query", { exact: true }).inputValue(),
    "PRIVATE SAVED QUERY",
  );
  assert.equal(await page.getByText("Query unavailable").count(), 0);
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
  await page.getByLabel("Local repository path", { exact: true }).waitFor();
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
const optionNames = (page: Page | Locator, label: string) =>
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

test("a Project source lists each option's open items, and choosing one adds it as a readiness condition read by name", async (t, journey) => {
  const previous = process.env.FIXTURE_GITHUB;
  process.env.FIXTURE_GITHUB = "offline-readiness-source-value";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_GITHUB;
    else process.env.FIXTURE_GITHUB = previous;
  });
  const issue = (n: number, optionNodeId: string) => ({
    providerInstance: "github.com" as const,
    nodeId: `I_${n}`,
    repositoryId: "acme/atlas",
    repositoryName: "acme/atlas",
    number: n,
    title: `Issue ${n}`,
    body: "Scope",
    state: "open" as const,
    labels: [],
    projectFields: [
      {
        projectNodeId: "PVT_atlas",
        fieldNodeId: "PVTSSF_status",
        optionNodeId,
      },
    ],
  });
  const reader: GitHubReaderFactory = () => ({
    async readSelection(selection) {
      return selection.kind === "project"
        ? {
            complete: true as const,
            issues: [issue(1, "PVTSSO_todo"), issue(2, "PVTSSO_ready")],
            reason: null,
            projectFields: [
              {
                projectNodeId: "PVT_atlas",
                fieldNodeId: "PVTSSF_status",
                name: "Status",
                options: [
                  { optionNodeId: "PVTSSO_todo", name: "Todo" },
                  { optionNodeId: "PVTSSO_ready", name: "Ready" },
                ],
              },
            ],
          }
        : { complete: true as const, issues: [], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" as const };
    },
  });
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
    undefined,
    undefined,
    { readerFactory: reader, setup: { discovery: fakeDiscovery({}) } },
  );
  const api = new OperatorApi(f.service, [f.directory]);
  await api.execute({
    type: "discovery.configure",
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  const d = f.service.domain();
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    selectionId: "S-3",
    expectedVersion: d.githubConfiguration(ids.atlas).version,
  });
  await f.service.refreshGitHub();
  await page.reload();
  await page
    .getByRole("button", { name: "Require Status = Todo for Ready (1 open)" })
    .waitFor();
  await page
    .getByRole("button", { name: "Require Status = Ready for Ready (1 open)" })
    .click();
  const added = page.getByRole("button", {
    name: "Status = Ready is a readiness condition",
  });
  assert.equal(await added.isDisabled(), true);
  // The added condition reads by name in the same selects the picker offers.
  await page
    .getByLabel("Readiness option", { exact: true })
    .last()
    .locator("option:checked", { hasText: "Ready" })
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByLabel("Readiness field", { exact: true })
      .last()
      .locator("option:checked")
      .textContent(),
    "Status",
  );
  await captureBrowserEvidence(page, "readiness-project-field-options");
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
  // Names are only read: the command and the stored rule carry node IDs alone.
  assert.deepEqual(command.readiness.conditions.at(-1), picked);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).readiness?.conditions.at(-1),
    picked,
  );
  const observed = (await api.readSourceObservations()).data.projects.find(
    (p) => p.projectId === ids.atlas,
  );
  assert.equal(observed?.readiness.kind, "rule");
  assert.deepEqual(
    observed?.readiness.kind === "rule" && observed.readiness.conditions.at(-1),
    { ...picked, fieldName: "Status", optionName: "Ready" },
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
      .first()
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

const addLabelCondition = (page: Page) =>
  page.getByRole("button", { name: "Add readiness condition" }).click();
/**
 * Atlas's GitHub tab with discovery unconfigured, a fake `gh` login and a saved Project-field
 * condition, so its Project and field are typed node IDs until a credential is set.
 */
async function startGhOffer(
  journey: Parameters<typeof startSettings>[0],
  signedIn = true,
) {
  const gh = createFakeGh(signedIn ? "signed-in" : "not-signed-in");
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const started = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
    undefined,
    undefined,
    {
      serviceOptions: { ghExecutable: gh.executable },
      setup: { discovery: fakeDiscovery({}), ghExecutable: gh.executable },
    },
  );
  const { f, ids, page } = started;
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
          projectNodeId: "PVT_atlas",
          fieldNodeId: "PVTSSF_status",
          optionNodeId: "PVTSSO_ready",
        },
      ],
    },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await page.reload();
  await page.getByLabel("Readiness Project node ID").waitFor();
  return started;
}
const ghOffer = (page: Page) =>
  page.getByRole("button", { name: "Use GitHub CLI login (@octo)" });

test("the readiness picker offers the signed-in GitHub CLI login and lists choices once it is set", async (_t, journey) => {
  const { f, page } = await startGhOffer(journey);
  const caveat = page.getByText("If agents can reach this Mac's keychain", {
    exact: false,
  });
  await ghOffer(page).waitFor();
  assert.equal(await ghOffer(page).count(), 1);
  await caveat.waitFor();
  await ghOffer(page).click();
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  await page
    .getByLabel("Readiness Project node ID")
    .waitFor({ state: "detached" });
  await ghOffer(page).waitFor({ state: "detached" });
  assert.equal(await caveat.count(), 0);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "source-readiness",
  );
});

test("the readiness picker offers no GitHub CLI login without a signed-in gh or with discovery set", async (_t, journey) => {
  const { page } = await startGhOffer(journey, false);
  await page.getByLabel("Readiness Project node ID").waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await ghOffer(page).count(), 0);
  const configured = await startDiscovery(journey, { calls: [] });
  await configured.page.getByLabel("Ready label").waitFor();
  await configured.page.waitForLoadState("networkidle");
  assert.equal(await ghOffer(configured.page).count(), 0);
});

test("the readiness picker offer is held by a Settings save that is not confirmed", async (_t, journey) => {
  const { f, page } = await startGhOffer(journey);
  const posts: { key: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON());
  });
  await ghOffer(page).waitFor();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  // The request never reaches the service, so Settings still reads the credential as unset.
  await page.route("**/api/operator/commands", (route) => route.abort());
  try {
    await ghOffer(page).click();
    await check.waitFor();
    assert.equal(await ghOffer(page).count(), 0);
    // Settings, reached inside the app, holds its offer and controls until this is checked.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const row = page.getByRole("region", {
      name: "GitHub discovery credential",
    });
    const offer = row.getByRole("button", {
      name: "Use GitHub CLI login (@octo)",
    });
    await offer.waitFor();
    assert.equal(await offer.getAttribute("aria-disabled"), "true");
    assert.equal(
      await row.getByRole("button", { name: "Set", exact: true }).isDisabled(),
      true,
    );
    await row
      .getByText("A discovery credential save elsewhere isn't confirmed yet.")
      .waitFor();
    await offer.click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
    await page.goBack();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await check.click();
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("the readiness picker offer is held by a Settings save that is not confirmed when the tab opens", async (_t, journey) => {
  const { f, page } = await startGhOffer(journey);
  const posts: { key: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON());
  });
  const check = page
    .getByRole("region", { name: "GitHub discovery credential" })
    .getByRole("button", { name: "Check whether it saved" });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const offer = page
    .getByRole("region", { name: "GitHub discovery credential" })
    .getByRole("button", { name: "Use GitHub CLI login (@octo)" });
  // The request never reaches the service, so the tab still reads the credential as unset.
  await page.route("**/api/operator/commands", (route) => route.abort());
  try {
    await offer.click();
    await check.waitFor();
    await page.goBack();
    await ghOffer(page).waitFor();
    assert.equal(await ghOffer(page).getAttribute("aria-disabled"), "true");
    await page
      .getByText("A discovery credential save elsewhere isn't confirmed yet.")
      .waitFor();
    await ghOffer(page).click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await page.goForward();
  await check.click();
  await page.goBack();
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

const labelCalls = (state: { calls: string[] }) =>
  state.calls.filter((c) => c === "labels").length;
const suggestedLabels = (page: Page, nth: number) =>
  page
    .locator(`datalist#source-conditions-${nth}-labels option`)
    .evaluateAll((o) => o.map((x) => x.getAttribute("value")));

test("a Ready label is suggested from the source's repository labels and read once per round, only while a label condition exists", async (_t, journey) => {
  const state: { calls: string[] } = { calls: [] };
  const { f, ids, page } = await startDiscovery(journey, state);
  // The initial saved label has its own discovery round. Finish it and leave before
  // reconfiguring, so none of that document's reads can enter the next round's count.
  await page.locator("input#source-conditions-0-name[list]").waitFor();
  const url = page.url();
  await page.goto("about:blank");
  const d = f.service.domain();
  const projectField = {
    kind: "project-field",
    projectNodeId: "PVT_gone",
    fieldNodeId: "PVTSSF_gone",
    optionNodeId: "PVTSSO_gone",
  } as const;
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
    readiness: { mode: "all", conditions: [projectField] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  state.calls = [];
  await page.goto(url);
  await page.getByLabel("Readiness Project node ID").waitFor();
  assert.equal(labelCalls(state), 0);
  await addLabelCondition(page);
  const ready = page.getByLabel("Ready label");
  await page.locator("input#source-conditions-1-name[list]").waitFor();
  assert.equal(await ready.getAttribute("list"), "source-conditions-1-labels");
  assert.deepEqual(await suggestedLabels(page, 1), [
    "bug",
    "ready",
    "needs-review",
  ]);
  await ready.fill("ready");
  await addLabelCondition(page);
  await page.getByLabel("Ready label").last().fill("bug");
  assert.deepEqual(await suggestedLabels(page, 2), [
    "bug",
    "ready",
    "needs-review",
  ]);
  assert.equal(labelCalls(state), 1);
  await captureBrowserEvidence(page, "readiness-label-picker");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).readiness?.conditions, [
    projectField,
    { kind: "label", name: "ready" },
    { kind: "label", name: "bug" },
  ]);
});

test("a label-only source without a Project makes no Project discovery reads", async (_t, journey) => {
  const state: { calls: string[] } = { calls: [] };
  const { f, ids, page } = await startDiscovery(journey, state);
  const d = f.service.domain(),
    url = page.url();
  await page.locator("input#source-conditions-0-name[list]").waitFor();
  // Leave the page so none of its reads land after the count is reset.
  await page.goto("about:blank");
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  state.calls = [];
  await page.goto(url);
  await page.locator("input#source-conditions-0-name[list]").waitFor();
  assert.equal(labelCalls(state), 1);
  assert.equal(state.calls.includes("projects"), false);
});

// Atlas's saved readiness already holds the label condition "ready".
test("a Ready label that is not on the repositories can still be typed", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, { calls: [] });
  const input = page.getByLabel("Ready label");
  await page.locator("input#source-conditions-0-name[list]").waitFor();
  const note = page.getByText(
    "This label is not on the source's repositories",
    {
      exact: false,
    },
  );
  assert.equal(await input.inputValue(), "ready");
  assert.equal(await note.count(), 0);
  await input.fill("ship-it");
  await note.waitFor();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(
    f.service.domain().githubConfiguration(ids.atlas).readiness?.conditions,
    [{ kind: "label", name: "ship-it" }],
  );
});

test("a Ready label stays a typed field when discovery fails or is truncated", async (_t, journey) => {
  for (const state of [
    { truncated: true },
    { failure: new DiscoveryFailure("unauthorized") },
  ]) {
    const { f, ids, page } = await startDiscovery(journey, state);
    await page.getByText("Type the label.", { exact: false }).waitFor();
    const input = page.getByLabel("Ready label");
    assert.equal(await input.getAttribute("list"), null);
    await input.fill("ship-it");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await savedOutcome(page);
    assert.deepEqual(
      f.service.domain().githubConfiguration(ids.atlas).readiness?.conditions,
      [{ kind: "label", name: "ship-it" }],
    );
  }
});

test("a saved Ready label that discovery does not list stays shown and savable", async (_t, journey) => {
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
    readiness: { mode: "all", conditions: [{ kind: "label", name: "gone" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await page.reload();
  const input = page.getByLabel("Ready label");
  await page.locator("input#source-conditions-0-name[list]").waitFor();
  await page
    .getByText("This label is not on the source's repositories", {
      exact: false,
    })
    .waitFor();
  assert.equal(await input.inputValue(), "gone");
  assert.deepEqual(await suggestedLabels(page, 0), [
    "bug",
    "ready",
    "needs-review",
  ]);
  await page
    .getByLabel("Closed GitHub issues", { exact: true })
    .selectOption("done");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).readiness?.conditions, [
    { kind: "label", name: "gone" },
  ]);
});

test("GitHub source conflict keeps rows and an unknown save is checked once", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
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
  await page
    .getByRole("heading", { name: "PRIVATE ELSEWHERE · search" })
    .waitFor();
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

test("an edited query and local path survive adopting a newer source version unless the row was removed elsewhere", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const writer = (selections: { id: string; keep: true }[]) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections,
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
    } as Parameters<OperatorApi["execute"]>[0]);
  const query = page.getByLabel("Search query", { exact: true });
  const path = page.getByLabel("Local repository path", { exact: true });
  const checkout = await createCheckout(f.directory, "adopted-checkout");
  await query.fill("EDITED QUERY");
  await path.fill(checkout);
  await writer([
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(await query.inputValue(), "EDITED QUERY");
  assert.equal(await path.inputValue(), checkout);
  assert.deepEqual(await changes(page).getByRole("listitem").allInnerTexts(), [
    "Search query edited for S-2",
    "Local path changed for acme/atlas",
  ]);
  // The query row is removed elsewhere: its edit is discarded with a plain note.
  await writer([
    { id: "S-1", keep: true },
    { id: "S-3", keep: true },
  ]);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "Loaded the latest version. S-2 was removed or replaced elsewhere, so your edits to it were discarded.",
    )
    .waitFor();
  assert.equal(await query.count(), 0);
  assert.equal(await path.inputValue(), checkout, "the path edit stays");
  assert.deepEqual(await changes(page).getByRole("listitem").allInnerTexts(), [
    "Local path changed for acme/atlas",
  ]);
});

test("a reverted query or local path is kept again, and an edit survives leaving the tab", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const path = page.getByLabel("Local repository path", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await query.waitFor();
  const storedPath = await path.inputValue();
  // Edit and revert both values: nothing is listed, nothing can be sent.
  await query.fill("CHANGED QUERY");
  await path.fill("/changed/path");
  await changes(page).getByText("Search query edited for S-2").waitFor();
  await query.fill("PRIVATE SAVED QUERY");
  await path.fill(storedPath);
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  // An edit survives leaving the tab, and typing the saved text back afterwards reverts it.
  await query.fill("EDIT ONE");
  await leaveAndReturn(page, "GitHub source", "General");
  assert.equal(await query.inputValue(), "EDIT ONE");
  await changes(page).getByText("Search query edited for S-2").waitFor();
  await query.fill("PRIVATE SAVED QUERY");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  // Edited and reverted, then another writer changes the same query: nothing stale is kept.
  await query.fill("MINE");
  await query.fill("PRIVATE SAVED QUERY");
  await page.getByLabel("Linked repository ref", { exact: true }).fill("HEAD");
  const writer = (text: string) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [
        { id: "S-1", keep: true },
        { id: "S-2", kind: "search", query: text },
        { id: "S-3", keep: true },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
    } as Parameters<OperatorApi["execute"]>[0]);
  await writer("THEIR QUERY");
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input")].some(
      (e) => e.value === "THEIR QUERY",
    ),
  );
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  await savedOutcome(page);
  const kept = d
    .githubConfiguration(ids.atlas)
    .selections.find((x) => x.id === "S-2");
  assert.equal(kept?.kind === "search" && kept.query, "THEIR QUERY");
  assert.equal(
    await realpath(
      d.githubConfiguration(ids.atlas).repositories[0]?.path ?? "",
    ),
    await realpath(storedPath),
  );

  // A real edit against older text says so after the other writer's change is adopted.
  await query.fill("MY REAL EDIT");
  await page.getByLabel("Linked repository ref", { exact: true }).fill("main");
  await writer("THEIR SECOND QUERY");
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  assert.equal(await query.inputValue(), "MY REAL EDIT");
  // Typing the older text back stays an edit; typing what is saved now is none.
  await query.fill("THEIR QUERY");
  await changes(page).getByText("Search query edited for S-2").waitFor();
  await query.fill("THEIR SECOND QUERY");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  await page.getByLabel("Linked repository ref", { exact: true }).fill("HEAD");
  assert.deepEqual(await changes(page).getByRole("listitem").allInnerTexts(), [
    "Ref for acme/atlas: main → HEAD",
  ]);
  const last = commandBody(page);
  await save.click();
  assert.deepEqual((await last).selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  await savedOutcome(page);
  const theirs = d
    .githubConfiguration(ids.atlas)
    .selections.find((x) => x.id === "S-2");
  assert.equal(theirs?.kind === "search" && theirs.query, "THEIR SECOND QUERY");

  // The same for a local path another writer replaced while this one was edited.
  const mine = await createCheckout(f.directory, "mine-path-checkout");
  const theirsPath = await createCheckout(f.directory, "their-path-checkout");
  const current = await path.inputValue();
  await path.fill(mine);
  await api.execute({
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
      { repositoryId: "acme/atlas", path: theirsPath, ref: "main" },
    ],
  } as Parameters<OperatorApi["execute"]>[0]);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  assert.equal(await path.inputValue(), mine);
  // The older path typed back is a deliberate replacement; the path saved now is no edit.
  await path.fill(current);
  await changes(page).getByText("Local path changed for acme/atlas").waitFor();
  await path.fill(d.githubConfiguration(ids.atlas).repositories[0]?.path ?? "");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  assert.equal(
    await realpath(
      d.githubConfiguration(ids.atlas).repositories[0]?.path ?? "",
    ),
    await realpath(theirsPath),
  );
});

test("a query edit says so when the private read is older than the source version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  await query.waitFor();
  const stale = await page.evaluate(async (id) => {
    const r = await fetch(`/api/operator/projects/${id}/private-values`);
    return r.text();
  }, ids.atlas);
  await query.fill("MY EDIT");
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: stale,
    }),
  );
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", kind: "search", query: "THEIR QUERY" },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  } as Parameters<OperatorApi["execute"]>[0]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Couldn't check whether this changed elsewhere." })
    .waitFor();
  assert.equal(await query.inputValue(), "MY EDIT");
  assert.equal(await showsText(page, "THEIR QUERY"), false);
  await assertOnHold(page, "Save changes", watchPosts(page));
});

test("Save waits for saved queries and paths to be read again, and an edit never changes a row's kind", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await query.waitFor();
  const writer = (s2: object) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [{ id: "S-1", keep: true }, s2, { id: "S-3", keep: true }],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", name: "ready" }],
      },
      repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
    } as Parameters<OperatorApi["execute"]>[0]);

  // Another writer changes the same query; while the comparison read is out, nothing is sent.
  await query.fill("MINE");
  await writer({ id: "S-2", kind: "search", query: "THEIR QUERY" });
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save changes", posts);
  // Enter in a field submits the form too, and sends nothing while Save is on hold.
  const before = posts.length;
  await query.press("Enter");
  await settled(page);
  assert.equal(posts.length, before);
  release();
  await assertOffHold(page, "Save changes");
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  const kept = d
    .githubConfiguration(ids.atlas)
    .selections.find((x) => x.id === "S-2");
  assert.equal(kept?.kind === "search" && kept.query, "THEIR QUERY");

  // Another writer replaces the search with a repository under the same id: the edit and a
  // pending removal are dropped, never carried onto the new source.
  await query.fill("MINE AGAIN");
  await writer({
    id: "S-2",
    kind: "repository",
    repositoryId: "acme/atlas",
    owner: "acme",
    name: "atlas",
  });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "Loaded the latest version. S-2 was removed or replaced elsewhere, so your edits to it were discarded.",
    )
    .waitFor();
  assert.equal(await query.count(), 0);
  await page.getByLabel("Linked repository ref", { exact: true }).fill("HEAD");
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  await savedOutcome(page);
  assert.equal(
    d.githubConfiguration(ids.atlas).selections.find((x) => x.id === "S-2")
      ?.kind,
    "repository",
  );
});

test("Save waits for a local path to be read again, and a same-kind replacement drops a pending removal", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const path = page.getByLabel("Local repository path", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await path.waitFor();
  const mine = await createCheckout(f.directory, "hold-mine");
  const theirs = await createCheckout(f.directory, "hold-theirs");
  await path.fill(mine);
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      // The same id, redefined as another GitHub Project: the pending removal no longer fits.
      { id: "S-3", kind: "project", projectNodeId: "PVT_other", filter: "" },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", path: theirs, ref: "main" }],
  } as Parameters<OperatorApi["execute"]>[0]);
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save changes", posts);
  release();
  await assertOffHold(page, "Save changes");
  await page
    .getByText("S-3 was removed or replaced elsewhere", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("Will be removed").count(), 0);
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  assert.equal((sent.repositories as { path?: string }[])[0]?.path, mine);
});

test("a pending removal is dropped when the source was replaced under the same id", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  await page.getByRole("button", { name: "Remove Saved search (S-2)" }).click();
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", kind: "project", projectNodeId: "PVT_new", filter: "" },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  } as Parameters<OperatorApi["execute"]>[0]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText("S-2 was removed or replaced elsewhere", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("Will be removed").count(), 0);
  await noChanges(page);
});

test("an unknown source save with rows removed elsewhere keeps its one action and message", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
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

test("Sync & placement shows the import offer, observations and the placement status line", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=sync",
  );
  await page.getByRole("heading", { name: "Source sync" }).waitFor();
  await page
    .locator(".settings-status")
    .getByText("No placement conflicts.")
    .waitFor();
  await page
    .getByRole("button", { name: "Preview and import now", exact: true })
    .waitFor();
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
  // The saved link shows the other writer's path plainly, and the removed new row left nothing.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input")].some((e) =>
      e.value.includes("theirs-checkout"),
    ),
  );
  assert.equal(await showsText(page, "mine-checkout"), false);
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
  const row = page
    .locator("article.settings-row")
    .filter({ hasText: "acme/atlas" });
  // The counts sit in Details; the sentence and the warning stay visible.
  await row.getByText(/^Synced \d\d:\d\d · 3 issues observed/).waitFor();
  await row.locator("summary").first().click();
  await row.getByText(counts, { exact: true }).waitFor();
  await row.getByText(warning, { exact: false }).waitFor();
  await row.getByRole("link", { name: "Check readiness conditions" }).click();
  await page.waitForURL(/tab=github#source-readiness$/);
  await page.waitForFunction(
    () => document.activeElement?.id === "source-readiness",
  );
  await page.getByText(warning, { exact: false }).waitFor();

  complete = false;
  await f.service.refreshGitHub();
  await page.reload();
  await page
    .getByText(/^Partly synced \d\d:\d\d · 3 issues observed so far/)
    .first()
    .waitFor();
  await page.locator(".settings-row summary").first().click();
  await page
    .getByText(`${counts} · partial read; counts may be incomplete`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByText(warning, { exact: false }).count(), 0);
});

test("renaming a project into another project's name shows the service's message and keeps the form; its own name saves", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const name = page.getByLabel("Project name", { exact: true });
  const save = page.getByRole("button", { name: "Save project", exact: true });
  await name.fill("relay");
  await save.click();
  await name.and(page.locator('[aria-invalid="true"]:focus')).waitFor();
  assert.equal(
    await name.evaluate((input) => {
      const id = input.getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : null;
    }),
    "Another project is named Relay. Choose a different name.",
  );
  assert.equal(await name.inputValue(), "relay");
  assert.equal(d.project(ids.atlas).name, "Atlas");
  // A case-only change of its own name is not a collision.
  await name.fill("ATLAS");
  await save.click();
  await savedOutcome(page, /^Saved\./);
  assert.equal(d.project(ids.atlas).name, "ATLAS");
  // Next to a duplicate that predates the rule, other fields still save.
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_projects SET name = 'ATLAS' WHERE id = ?")
      .run(ids.fieldnotes),
  );
  await refresh(page);
  await page.getByRole("switch", { name: "Pause project" }).click();
  await save.click();
  await savedOutcome(page, /^Saved\./);
  assert.equal(d.project(ids.atlas).paused, 1);
});

test("command network access is a switch with its disclosure that saves as a versioned change", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  const network = page.getByRole("switch", { name: "Command network access" });
  await network.waitFor();
  assert.equal(await network.isChecked(), false);
  await page
    .getByText("Command network access is disabled for this project.")
    .waitFor();
  await page
    .getByText(
      "Network-enabled commands can reach whatever credentials and logins the host exposes.",
    )
    .waitFor();
  await page
    .getByText("running turns keep their policy", { exact: false })
    .waitFor();
  const save = page.getByRole("button", { name: "Save project", exact: true });
  assert.equal(await save.isDisabled(), true);

  await network.click();
  await changes(page).getByText("Command network access enabled").waitFor();
  const version = Number(d.project(ids.atlas).version);
  const sent = commandBody(page);
  await save.click();
  const body = await sent;
  assert.equal(body.type, "project.configure");
  assert.equal(body.commandNetworkAccess, true);
  assert.equal(body.expectedVersion, version);
  assert.equal("paused" in body, false);
  await savedOutcome(page);
  assert.equal(d.commandNetworkAccess(ids.atlas), true);
  await page
    .getByText(
      "Command network access is enabled for this project's Codex turns; Claude Code turns keep it denied.",
    )
    .waitFor();
  assert.equal(await network.isChecked(), true);

  await network.click();
  await changes(page).getByText("Command network access disabled").waitFor();
  const back = commandBody(page);
  await save.click();
  assert.equal((await back).commandNetworkAccess, false);
  await savedOutcome(page);
  assert.equal(d.commandNetworkAccess(ids.atlas), false);
});

type SettingsFixture = Awaited<ReturnType<typeof startDiscovery>>["f"];
const statusField = "PVTSSF_status";
/** An `allow` project field grant for Atlas's Project Status, covering the named options. */
const grantStatusOptions = (
  f: SettingsFixture,
  projectId: string,
  options: string[],
) =>
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: f.service.delivery().configuration(projectId).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [
      {
        action: "project.field",
        repositoryId: "acme/atlas",
        mode: "allow",
        projectNodeId: "PVT_atlas",
        fieldNodeId: statusField,
        optionNodeIds: options,
      },
    ],
    requiredChecks: [],
  });
const statusPanel = (page: Page) => page.locator("#status-mapping");

test("Status mapping saves each event's Status option, naming options and marking ungranted ones", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {});
  const d = f.service.domain();
  grantStatusOptions(f, ids.atlas, ["PVTSSO_ready"]);
  await page.reload();
  const panel = statusPanel(page);
  await panel
    .getByRole("heading", { name: "Status mapping", exact: true })
    .waitFor();
  const turn = panel.getByLabel("First turn started", { exact: true });
  await turn.selectOption({ label: "Ready" });
  assert.deepEqual(await optionNames(panel, "First turn started"), [
    "Nothing",
    "Todo (no grant)",
    "Ready",
  ]);
  await panel
    .getByLabel("Stopped, uncertain or blocked", { exact: true })
    .selectOption({ label: "Ready" });
  await panel
    .getByRole("region", { name: "Status mapping changes" })
    .getByText("First turn started: sets Status to Ready.")
    .waitFor();
  await captureBrowserEvidence(page, "status-mapping");
  const body = commandBody(page);
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  const command = (await body) as { mapping: unknown; expectedVersion: number };
  await savedOutcome(panel);
  const mapping = {
    selectionId: "S-3",
    projectNodeId: "PVT_atlas",
    fieldNodeId: statusField,
    events: {
      turnStarted: "PVTSSO_ready",
      handedBack: null,
      held: "PVTSSO_ready",
      done: null,
    },
  };
  assert.deepEqual(command.mapping, mapping);
  assert.deepEqual(d.statusMapping(ids.atlas).mapping, mapping);
  assert.equal(d.statusMapping(ids.atlas).version, 2);
});

test("an in-flight Status the readiness rule does not accept is refused naming the option, and the draft stays", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {});
  const d = f.service.domain();
  grantStatusOptions(f, ids.atlas, ["PVTSSO_todo", "PVTSSO_ready"]);
  // Only Ready tasks are Ready: an in-flight write of Todo would remove readiness.
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: ["S-1", "S-2", "S-3"].map((id) => ({
      id,
      keep: true as const,
    })),
    readiness: {
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: "PVT_atlas",
          fieldNodeId: statusField,
          optionNodeId: "PVTSSO_ready",
        },
      ],
    },
    repositories: [],
  });
  await page.reload();
  const panel = statusPanel(page);
  await panel
    .getByLabel("First turn started", { exact: true })
    .selectOption({ label: "Todo" });
  await panel
    .getByLabel("Stopped, uncertain or blocked", { exact: true })
    .selectOption({ label: "Todo" });
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  const refusal = panel.getByRole("alert").filter({
    hasText: "First turn started → Todo: the readiness rule does not accept",
  });
  await refusal.waitFor();
  assert.equal(
    await panel
      .getByLabel("First turn started", { exact: true })
      .getAttribute("aria-invalid"),
    "true",
  );
  // The terminal event is not the one refused, and nothing was saved.
  assert.equal(
    await panel
      .getByLabel("Stopped, uncertain or blocked", { exact: true })
      .getAttribute("aria-invalid"),
    "false",
  );
  assert.equal(
    await panel.getByLabel("First turn started", { exact: true }).inputValue(),
    "PVTSSO_todo",
  );
  assert.equal(d.statusMapping(ids.atlas).mapping, null);
  // Choosing an accepted option and saving works from the same draft.
  await panel
    .getByLabel("First turn started", { exact: true })
    .selectOption({ label: "Ready" });
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  await savedOutcome(panel);
  assert.equal(
    d.statusMapping(ids.atlas).mapping?.events.turnStarted,
    "PVTSSO_ready",
  );
});

test("choosing another Project starts from Nothing, cannot be saved until its Status field is listed, and is never a clear", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {});
  const d = f.service.domain();
  grantStatusOptions(f, ids.atlas, ["PVTSSO_ready"]);
  d.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.statusMapping(ids.atlas).version,
    mapping: {
      selectionId: "S-3",
      projectNodeId: "PVT_atlas",
      fieldNodeId: statusField,
      events: {
        turnStarted: "PVTSSO_ready",
        handedBack: null,
        held: null,
        done: null,
      },
    },
  });
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true as const },
      { id: "S-2", keep: true as const },
      { id: "S-3", keep: true as const },
      { id: "S-4", kind: "project", projectNodeId: "PVT_other", filter: "" },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  } as Parameters<OperatorApi["execute"]>[0]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/discovery/project-fields?project=PVT_other",
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  await page.reload();
  const panel = statusPanel(page);
  const turn = panel.getByLabel("First turn started", { exact: true });
  const save = panel.getByRole("button", {
    name: "Save status mapping",
    exact: true,
  });
  await turn
    .locator("option", { hasText: "Ready" })
    .waitFor({ state: "attached" });
  assert.equal(await turn.inputValue(), "PVTSSO_ready");
  await panel.getByLabel("Project source", { exact: true }).selectOption("S-4");
  // The other Project's field is loading: nothing carries over, nothing is cleared, nothing saves.
  await panel.getByText("Reading this Project's Status options").waitFor();
  assert.equal(await turn.inputValue(), "");
  assert.equal(await save.isDisabled(), true);
  assert.equal(await panel.getByText("Clears the status mapping").count(), 0);
  release();
  await panel
    .getByText("This Project has no single-select field named Status")
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await panel.getByText("Clears the status mapping").count(), 0);
  assert.notEqual(d.statusMapping(ids.atlas).mapping, null);
  // Back on the saved Project its mapping returns, unchanged; Nothing everywhere is the explicit clear.
  await panel.getByLabel("Project source", { exact: true }).selectOption("S-3");
  await turn
    .locator("option", { hasText: "Ready" })
    .waitFor({ state: "attached" });
  assert.equal(await turn.inputValue(), "PVTSSO_ready");
  assert.equal(await save.isDisabled(), true);
  await turn.selectOption({ label: "Nothing" });
  await panel.getByText("Clears the status mapping").waitFor();
  assert.equal(await save.isDisabled(), false);
});

test("a project without a Project source shows the mapping as unavailable", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=github",
  );
  const panel = statusPanel(page);
  await panel
    .getByText("Status mapping needs a GitHub Project source")
    .waitFor();
  assert.equal(await panel.getByRole("combobox").count(), 0);
  assert.equal(await panel.getByRole("button").count(), 0);
});

test("Status mapping is keyboard operable at phone width", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
    phone,
    undefined,
    { setup: { discovery: fakeDiscovery({}) } },
  );
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "discovery.configure",
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  grantStatusOptions(f, ids.atlas, ["PVTSSO_todo", "PVTSSO_ready"]);
  await page.reload();
  const panel = statusPanel(page);
  const done = panel.getByLabel("Done", { exact: true });
  await done.locator("option", { hasText: "Ready" }).waitFor({
    state: "attached",
  });
  await done.focus();
  // Typing the option's first letter picks it, as it does on a focused select.
  await page.keyboard.type("R");
  assert.equal(await done.inputValue(), "PVTSSO_ready");
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await savedOutcome(panel);
  assert.equal(
    f.service.domain().statusMapping(ids.atlas).mapping?.events.done,
    "PVTSSO_ready",
  );
  const box = await done.boundingBox();
  assert.ok((box?.height ?? 0) >= 32);
  await noPageOverflow(page);
});
