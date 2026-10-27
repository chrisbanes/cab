import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  failResponses,
  holdResponse,
  observedDom,
  settleReads,
  watchDom,
} from "../fixtures/background-refresh.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
const test = browserSuite("inbox-background-refresh-browser");

test("Inbox and shell timer reads stay silent until they fail; header Refresh still shows progress", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  await seedOwnQuestion(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const rows = page.locator(".inbox-row");
  await rows.first().waitFor();
  await page.waitForLoadState("networkidle");
  const rowCount = await rows.count();
  const rowTop = () =>
    rows.first().evaluate((el) => el.getBoundingClientRect().top);
  const top = await rowTop();
  // Land just before a minute boundary so the poll also ticks the row's relative age.
  const created = Date.parse(
    (await rows.first().locator("time").getAttribute("datetime")) ?? "",
  );
  assert.ok(created > 0);
  await page.clock.setSystemTime(created + 50_000);
  await watchDom(page);

  const holds = await Promise.all(
    ["inbox", "task-list", "workspace"].map((name) =>
      holdResponse(page, `**/api/operator/${name}*`),
    ),
  );
  await page.clock.runFor(15000);
  await Promise.all(holds.map((hold) => hold.entered));
  assert.equal(await page.locator(".resource-status").count(), 0);
  assert.equal(await rows.count(), rowCount);
  assert.equal(await rowTop(), top);
  assert.deepEqual((await observedDom(page))?.changes, []);
  for (const hold of holds) hold.release();
  await settleReads(page);
  const quiet = await observedDom(page);
  assert.equal(quiet?.statusSeen, false);
  // The poll rendered, so the minute boundary really ticked the age.
  assert.match((await rows.first().locator("time").textContent()) ?? "", /1m$/);
  assert.deepEqual(quiet?.changes, []);
  for (const hold of holds) await hold.stop();

  const failing = await failResponses(page, "**/api/operator/inbox*");
  await page.clock.runFor(15000);
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await rows.count(), rowCount);
  await failing.stop();

  const workspace = await holdResponse(page, "**/api/operator/workspace*");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await workspace.entered;
  // The status waits out its short delay so fast refreshes do not flash it.
  await page.clock.runFor(1000);
  await page
    .getByText("Refreshing. Showing the last fetched data.", { exact: true })
    .first()
    .waitFor();
  assert.equal(await rows.count(), rowCount);
  workspace.release();
  await page.waitForFunction(
    () => document.querySelector(".resource-status") === null,
  );
});
