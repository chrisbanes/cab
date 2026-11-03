/** Helpers shared by the project configuration browser tests. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { fakeDiscovery } from "./setup-home.js";
import { startSettings } from "./operator-settings.js";

export const changes = (page: Page) =>
  page.getByRole("region", { name: "Changes to save" });
/** Press the header Refresh and wait until the re-read has rendered. */
export const refresh = async (page: Page) => {
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
export const revealButton = (page: Page, noun: string) =>
  page.getByRole("button", { name: `Reveal ${noun}`, exact: true });
/** Whether a private sentinel is anywhere the operator can read: page text or a field's value. */
export const showsText = (page: Page, text: string) =>
  page.evaluate(
    (needle) =>
      document.body.innerText.includes(needle) ||
      [...document.querySelectorAll("textarea, input")].some((e) =>
        (e as HTMLTextAreaElement).value.includes(needle),
      ),
    text,
  );
/** Private-values reads this document has made so far. */
export const revealReads = (page: Page) =>
  page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("/private-values")).length,
  );
/** Wait until the page has painted twice, so a late render would have appeared. */
export const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
export const commandBody = (page: Page) =>
  page
    .waitForRequest(
      (r) =>
        r.method() === "POST" && r.url().endsWith("/api/operator/commands"),
    )
    .then((r) => r.postDataJSON() as Record<string, unknown>);

export const projectTabs = (page: Page) =>
  page.getByRole("navigation", { name: "Project configuration sections" });
/** Leave the open tab for another and come back, remounting its form. */
export const leaveAndReturn = async (
  page: Page,
  tab: string,
  other: string,
) => {
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
export const noChanges = async (page: Page) =>
  assert.equal(await changes(page).getByRole("listitem").count(), 0);

/** Hold every private-values read until `release` is called. */
export const holdReads = async (page: Page) => {
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
export const watchPosts = (page: Page) => {
  const posts: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON() as Record<string, unknown>);
  });
  return posts;
};
/** Save waits for the comparison read: focusable, announced with its reason, and sends nothing. */
export const assertOnHold = async (
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
export const assertOffHold = async (page: Page, save: string) => {
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
export const assertClean = async (page: Page, save: string) => {
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

/** Settings on an Atlas tab (GitHub by default) with fake GitHub discovery configured. */
export async function startDiscovery(
  journey: Parameters<typeof startSettings>[0],
  state: { failure?: Error; calls?: string[]; truncated?: boolean },
  tab = "github",
) {
  const started = await startSettings(
    journey,
    `/app/projects/:atlas/settings?tab=${tab}`,
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
