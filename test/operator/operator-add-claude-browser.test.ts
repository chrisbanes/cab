import assert from "node:assert/strict";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  startSettings,
  noPageOverflow,
  phone,
} from "../fixtures/operator-settings.js";
const test = browserSuite("native-harness-setup");
test("old Claude setup links show native login guidance with no token form on desktop and phone", async (_t, journey) => {
  const { page } = await startSettings(journey, "/settings/runtime#add-claude");
  await page
    .getByRole("heading", { name: "Add Claude", exact: true })
    .waitFor();
  assert.match(
    await page.locator("#add-claude").innerText(),
    /native Claude Code login/,
  );
  assert.equal(
    await page.getByLabel("Claude token reference", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Copy commands", exact: true })
      .count(),
    0,
  );
  await noPageOverflow(page);
  await page.setViewportSize(phone);
  await noPageOverflow(page);
});
