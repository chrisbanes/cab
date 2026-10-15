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
import { seedReviewTask } from "../fixtures/task-review.js";
import { openTaskTab } from "../fixtures/task-tabs.js";
const test = browserSuite("task-background-refresh-browser");

test("a task workspace timer poll keeps history, position and status quiet; explicit Refresh still shows progress", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f),
    r = a.delegatedResult("Original source-faithful result");
  const addHistory = (n: number | string) =>
    f.seedPersistedState((db) => {
      db.prepare(
        "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,1,1)",
      ).run(
        r.workId,
        a.taskId,
        r.assignmentId,
        r.workId,
        r.workId,
        `item-${n}`,
        `Retained marker ${n}`,
      );
    });
  for (const n of [0, 1, 2]) addHistory(n);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/app/tasks/${a.taskId}?result=${r.resultId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const history = page.locator("#history");
  const marker = (n: number | string) =>
    history.getByText(`Retained marker ${n}`, { exact: true });
  await marker(2).first().waitFor({ state: "attached" });
  // The polls below run while History is the open tab.
  await openTaskTab(page, "History");
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  await page.waitForLoadState("networkidle");
  const status = page.locator(".resource-status");
  const openCount = () => page.locator("#history details[open]").count();
  const refresh = page.getByRole("button", {
    name: "Refresh task",
    exact: true,
  });
  const top = () => refresh.evaluate((el) => el.getBoundingClientRect().top);
  const opened = await openCount(),
    shown = await marker(2).count();
  assert.ok(shown > 0);
  const unavailable = page.getByText("Recent captured text unavailable"),
    unavailableCount = await unavailable.count();
  assert.ok(opened >= 3);
  // Reading position inside the captured-context section, where record ids nest.
  await page
    .locator("#context")
    .evaluate((el) =>
      scrollTo(0, el.getBoundingClientRect().top + scrollY - 90),
    );
  const scrolled = await page.evaluate(() => scrollY);
  assert.ok(scrolled > 0);
  const refreshTop = await top();

  // 1. An unchanged poll changes nothing visible, even while its history revalidates.
  await watchDom(page);
  const taskRead = await holdResponse(
    page,
    `**/api/operator/tasks/${a.taskId}*`,
  );
  const historyRead = await holdResponse(
    page,
    `**/api/operator/assignments/${r.assignmentId}/history*`,
  );
  await page.clock.runFor(15000);
  await taskRead.entered;
  assert.equal(await status.count(), 0);
  assert.equal(await marker(2).count(), shown);
  assert.equal(await openCount(), opened);
  assert.equal(await top(), refreshTop);
  assert.deepEqual((await observedDom(page))?.changes, []);
  taskRead.release();
  await historyRead.entered;
  assert.equal(await marker(2).count(), shown);
  assert.equal(await openCount(), opened);
  historyRead.release();
  await settleReads(page);
  const quiet = await observedDom(page);
  assert.equal(quiet?.statusSeen, false);
  assert.deepEqual(quiet?.changes, []);
  assert.equal(await unavailable.count(), unavailableCount);
  assert.equal(await top(), refreshTop);
  assert.equal(await page.evaluate(() => scrollY), scrolled);
  await taskRead.stop();
  await historyRead.stop();

  // 2. A failed poll discloses itself and keeps the last good content.
  const failing = await failResponses(
    page,
    `**/api/operator/tasks/${a.taskId}*`,
  );
  await page.clock.runFor(15000);
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.equal(await marker(2).count(), shown);
  await failing.stop();

  // 3. Explicit Refresh keeps its progress status over the last good content.
  const explicit = await holdResponse(
    page,
    `**/api/operator/tasks/${a.taskId}*`,
  );
  await refresh.click();
  await explicit.entered;
  await page
    .getByText("Refreshing. Showing the last fetched data.", { exact: true })
    .first()
    .waitFor();
  // The result stays mounted on Overview, behind the History tab.
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Latest result",
        exact: true,
        includeHidden: true,
      })
      .count(),
    1,
  );
  explicit.release();
  await page.waitForLoadState("networkidle");
  await explicit.stop();
  await page.waitForFunction(
    () => document.querySelector(".resource-status") === null,
  );

  // 4. A late history answer cannot replace a newer one.
  const late = await holdResponse(
    page,
    `**/api/operator/assignments/${r.assignmentId}/history*`,
  );
  await refresh.click();
  await late.entered;
  addHistory("NEW");
  await refresh.click();
  await marker("NEW").first().waitFor({ state: "attached" });
  late.release();
  await page.waitForLoadState("networkidle");
  assert.ok((await marker("NEW").count()) > 0);

  // 5. History that a poll cannot revalidate is hidden rather than kept.
  const unreadable = await failResponses(
    page,
    `**/api/operator/assignments/${r.assignmentId}/history*`,
  );
  await page.clock.runFor(15000);
  await marker(2).first().waitFor({ state: "detached" });
  await unreadable.stop();
});
