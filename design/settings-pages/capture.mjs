// Throwaway artboard checks, not production Settings acceptance tests.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const section of ["projects", "readiness", "notifications"]) {
    for (const [device, width, height] of [
      ["desktop", 1366, 900],
      ["phone", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(
        new URL(`artboard.html?page=${section}`, import.meta.url).href,
      );
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.locator("[aria-current=page]").count(), 2);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      if (device === "phone" && section === "readiness")
        await page.locator("summary").click();
      await page.screenshot({
        path: fileURLToPath(
          new URL(`${section}-${device}.png`, import.meta.url),
        ),
      });
    }
  }
  await page.locator("summary").click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .filter({ visible: true })
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  assert.equal(await page.locator("h1").textContent(), "Projects");
  assert.equal(await page.locator("details").getAttribute("open"), null);
  await page.goBack();
  assert.equal(await page.locator("h1").textContent(), "Notifications");
  for (const [width, height] of [
    [390, 480],
    [800, 768],
    [1024, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(
      new URL("artboard.html?page=readiness", import.meta.url).href,
    );
    if (width === 390) {
      await page.locator("summary").focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await page.locator("details").getAttribute("open"), null);
      const links = page.locator(".phone-sections a");
      assert.equal(await links.count(), 9);
      for (const link of await links.all())
        assert.ok((await link.boundingBox()).height >= 44);
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "Artboards: six captures; route selection, phone links, history, keyboard disclosure, touch sizes and light/short/tablet overflow checks passed.",
  );
} finally {
  await browser.close();
}
