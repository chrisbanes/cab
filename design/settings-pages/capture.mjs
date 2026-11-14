// Throwaway artboard checks, not production Settings acceptance tests.
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const output = process.env.CAB_TEST_EVIDENCE_DIR;
const revision = fileURLToPath(
  new URL("../../.scratch/issue-1581-evidence/r1/", import.meta.url),
);
assert.ok(
  output && isAbsolute(output),
  "CAB_TEST_EVIDENCE_DIR must be absolute",
);
const inside = (root, path) => {
  const child = relative(root, path);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith("../") &&
    !isAbsolute(child)
  );
};
assert.ok(
  inside(resolve(revision), resolve(output)),
  "Capture output must be beneath active issue-1581 r1",
);
// Require an existing real destination: never create a directory through an escaped symlink.
assert.equal(
  await realpath(revision),
  resolve(revision),
  "Revision must not be a symlink",
);
assert.equal(
  await realpath(output),
  resolve(output),
  "Output must not be a symlink",
);
const captures = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async (query) => {
    await page.goto(new URL(`artboard.html?${query}`, import.meta.url).href);
    await page.evaluate(() => document.fonts.ready);
  };
  const capture = async (name) => {
    await page.screenshot({
      path: join(output, `${name}.png`),
      fullPage: true,
    });
    captures.push(name);
  };
  const noOverflow = async () =>
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  const trigger = page.locator("#sections-toggle");
  const nav = page.locator("#section-links");
  for (const section of ["projects", "readiness", "notifications"]) {
    for (const [device, width, height] of [
      ["desktop", 1366, 900],
      ["phone", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await open(`page=${section}&turnStarted=${section === "projects"}`);
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.locator("[aria-current=page]").count(), 1);
      assert.equal(
        await page.locator("#crumb").textContent(),
        await page.locator("h1").textContent(),
      );
      await noOverflow();
      if (device === "phone" && section === "readiness") await trigger.click();
      await capture(`${section}-${device}-dark`);
    }
  }
  await trigger.focus();
  await page.keyboard.press("Enter");
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("Tab");
  assert.equal(
    await nav
      .getByRole("link", { name: "Projects", exact: true })
      .evaluate((a) => a === document.activeElement),
    true,
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await trigger.evaluate((b) => b === document.activeElement),
    true,
  );
  await page.keyboard.press("Space");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Tab");
  assert.equal(
    await nav.evaluate((n) => n.contains(document.activeElement)),
    false,
  );
  await trigger.focus();
  await page.keyboard.press("Space");
  const projects = nav.getByRole("link", { name: "Projects", exact: true });
  await projects.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/page=projects/);
  assert.equal(await page.locator("h1").textContent(), "Projects");
  assert.equal(
    await page.locator("h1").evaluate((h) => h === document.activeElement),
    true,
  );
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.goBack();
  assert.equal(await page.locator("h1").textContent(), "Notifications");
  await page.locator("#settings-crumb").click();
  assert.equal(await page.locator("h1").textContent(), "Readiness");
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [width, height] of [
      [390, 480],
      [800, 768],
      [1024, 768],
      [759, 844],
      [760, 844],
      [1119, 900],
      [1120, 900],
      [1121, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await open("page=readiness&turnStarted=false");
      assert.equal(await trigger.isVisible(), width <= 759);
      assert.equal(await page.locator(".sidebar").isVisible(), width > 1120);
      assert.equal(
        await page
          .locator(".topbar")
          .evaluate((h) => h.getBoundingClientRect().height),
        48,
      );
      if (width <= 759) {
        await trigger.click();
        assert.equal(await nav.getByRole("link").count(), 9);
        for (const link of await nav.getByRole("link").all())
          assert.ok((await link.boundingBox()).height >= 44);
        assert.ok((await trigger.boundingBox()).height >= 44);
      }
      await noOverflow();
      await capture(`readiness-${width}x${height}-${scheme}`);
    }
  }
  // Resize while focus is in the disappearing primitive in both directions.
  await page.setViewportSize({ width: 759, height: 844 });
  await trigger.focus();
  await page.setViewportSize({ width: 760, height: 844 });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-current") === "page",
  );
  await page.setViewportSize({ width: 759, height: 844 });
  await page.waitForFunction(
    () => document.activeElement?.id === "sections-toggle",
  );
  for (const state of ["loading", "error", "delayed"]) {
    await open(
      `page=readiness&state=${state}&target=claude-executable&turnStarted=false`,
    );
    if (state === "delayed") {
      assert.equal(
        await page.locator("#content").textContent(),
        "Loading illustrative read… No successful values are shown.",
      );
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Claude executable",
      );
    } else assert.equal(await page.locator("#content .badge").count(), 0);
    await capture(`readiness-${state}`);
  }
  await open("page=readiness&state=error&turnStarted=false");
  await page.getByRole("link", { name: "Retry fixture" }).click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Claude executable",
  );
  await open("page=readiness&state=delayed&target=claude-executable");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.locator("#readiness-claude-executable").waitFor();
  assert.equal(
    await trigger.evaluate((b) => b === document.activeElement),
    true,
  );
  const touch = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await touch.goto(
    new URL("artboard.html?page=projects", import.meta.url).href,
  );
  await touch.locator("#sections-toggle").tap();
  await touch
    .locator("#section-links")
    .getByRole("link", { name: "Notifications", exact: true })
    .tap();
  assert.equal(await touch.locator("h1").textContent(), "Notifications");
  await touch.close();
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "capture-inventory.json"),
    JSON.stringify(
      {
        captures,
        pageErrors: errors,
        checks:
          "selection, crumb, history, heading/delayed focus, interaction cancellation, disclosure Enter/Space/Tab/Shift-Tab, resize focus, touch, targets, overflow, themes and boundaries; mockups only",
      },
      null,
      2,
    ),
  );
  console.log(
    `Artboards: ${captures.length} captures; mockup checks passed; zero page errors.`,
  );
} finally {
  await browser.close();
}
