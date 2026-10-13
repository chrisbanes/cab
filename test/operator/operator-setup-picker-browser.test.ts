import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import type { Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { chooseRepository, setupJourney } from "../fixtures/setup-browser.js";
const test = browserSuite("operator-setup-picker-browser");

const rows = (page: Page) =>
  page
    .getByRole("dialog")
    .locator(".folder-picker-row")
    .evaluateAll((els) =>
      els.map((el) =>
        (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      ),
    );

test("Folder picker lists home folders, selects checkouts and keeps paths private", async (_t, journey) => {
  const { home, page } = await setupJourney(journey);
  const realHome = await realpath(home.home);
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/setup/folders"))
      bodies.push(r.postData() ?? "");
  });
  const responses: Promise<string>[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/operator/setup/")) responses.push(r.text());
  });
  await chooseRepository(page, "acme/atlas");
  await page.getByLabel("Local repository path").fill("~/src/x");
  const open = page.getByRole("button", { name: "Choose folder…" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Choose repository folder" });
  await dialog
    .getByText(
      "Pick the local checkout of acme/atlas. The service verifies its origin and that ref main is available.",
    )
    .waitFor();
  await dialog.getByText("Git checkout · origin acme/atlas · main").waitFor();
  assert.deepEqual(await rows(page), [
    "atlas Git checkout · origin acme/atlas · main Matches acme/atlas",
    "gitlab Git checkout · origin not on github.com",
    "leaky Git checkout · origin acme/leaky · main",
    "relay Git checkout · origin acme/relay · main",
    "archive Folder",
    "design-notes Folder",
  ]);
  await dialog
    .getByText(
      "Listed by the Ensemble service on this Mac: folder names and Git status only. Choosing a folder grants nothing until you create the project.",
    )
    .waitFor();
  await captureBrowserEvidence(page, "1366-picker");
  // A plain folder opens; Up returns.
  await dialog.getByRole("button", { name: /^archive/ }).click();
  await dialog.getByRole("button", { name: /^old/ }).waitFor();
  await dialog.getByRole("button", { name: "Up one folder" }).click();
  await dialog.getByRole("button", { name: /^atlas/ }).waitFor();
  // A checkout is selected, not opened.
  await dialog.getByRole("button", { name: /^relay/ }).click();
  assert.equal(
    await dialog.getByLabel("Or enter a path").inputValue(),
    "~/src/relay",
  );
  await dialog.getByRole("button", { name: /^atlas/ }).click();
  await dialog.getByRole("button", { name: "Use this folder" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page.getByLabel("Local repository path").inputValue(),
    "~/src/atlas",
  );
  await page
    .getByText(
      "Verified on this Mac: git checkout · origin acme/atlas · main available.",
    )
    .waitFor();
  // Choosing relay shows the mismatch on the field.
  await open.click();
  await dialog.getByRole("button", { name: /^relay/ }).click();
  await dialog.getByRole("button", { name: "Use this folder" }).click();
  await page
    .getByText(
      "This folder is a checkout of acme/relay, not acme/atlas. Choose another folder or change the repository.",
    )
    .waitFor();
  // Escape closes and returns focus; Tab stays inside.
  await open.click();
  await dialog.getByRole("button", { name: /^atlas/ }).waitFor();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Tab");
  assert.equal(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
    true,
  );
  // A symlink escape typed into the path box is refused and the dialog stays open.
  await dialog.getByLabel("Or enter a path").fill("~/src/escape");
  await dialog.getByLabel("Or enter a path").press("Enter");
  await dialog
    .getByText(
      "Hidden folders and folders outside your home folder can't be browsed. Type a path instead.",
    )
    .waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes("Choose folder"),
  );
  // A held listing shows its loading state.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/setup/folders", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await open.click();
    await dialog.getByText("Loading folders…").waitFor();
    assert.equal(
      await dialog
        .getByRole("list", { name: "Folders" })
        .getAttribute("aria-busy"),
      "true",
    );
    release();
    await dialog.getByRole("button", { name: /^atlas/ }).waitFor();
  } finally {
    release();
    await page.unroute("**/api/operator/setup/folders");
  }
  await page.keyboard.press("Escape");
  for (const body of bodies) {
    const parsed = JSON.parse(body) as Record<string, string>;
    assert.deepEqual(Object.keys(parsed), ["path"]);
    assert.match(parsed.path ?? "", /^~(\/|$)/);
  }
  const text = (await Promise.all(responses)).join("\n") + bodies.join("\n");
  for (const leak of [
    home.home,
    realHome,
    "PRIVATE FILE CONTENT",
    "SECRETPASS",
  ])
    assert.equal(text.includes(leak), false, leak);
  assert.equal(
    (await page.locator("body").innerText()).includes(realHome),
    false,
  );
});

test("Folder picker fits a phone", async (_t, journey) => {
  const { page } = await setupJourney(journey, {
    viewport: { width: 390, height: 844 },
  });
  await chooseRepository(page, "acme/atlas");
  await page.getByRole("button", { name: "Choose folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose repository folder" });
  // An empty path opens at home; plain folders open.
  await dialog.getByRole("button", { name: /^src/ }).click();
  await dialog.getByRole("button", { name: /^atlas/ }).waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.height <= 844);
  const small = await dialog
    .locator("button, input")
    .evaluateAll((els) =>
      els
        .map((el) => el.getBoundingClientRect().height)
        .filter((h) => h > 0 && h < 44),
    );
  assert.deepEqual(small, []);
  await captureBrowserEvidence(page, "390-picker");
});

test(
  "Folder picker opens in WebKit",
  { browserEngine: "webkit" },
  async (_t, journey) => {
    journey.restart();
    const { page } = await setupJourney(journey, { engine: "webkit" });
    await chooseRepository(page, "acme/atlas");
    await page.getByRole("button", { name: "Choose folder…" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Choose repository folder",
    });
    await dialog.getByRole("button", { name: /^src/ }).click();
    await dialog.getByRole("button", { name: /^atlas/ }).waitFor();
  },
);
