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
const test = browserSuite("task-background-refresh-browser");

test("a task workspace timer poll keeps the conversation, position and status quiet; explicit Refresh still shows progress", async (_t, j) => {
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
  const conversation = page.locator("#conversation");
  const marker = (n: number | string) =>
    conversation.getByText(`Retained marker ${n}`, { exact: true });
  // The worker's entries sit in its delegation, opened to read them.
  await conversation
    .locator(`[data-record-id="delegation:${r.assignmentId}"]`)
    .getByRole("button")
    .first()
    .click();
  await marker(2).first().waitFor();
  await page.waitForLoadState("networkidle");
  const status = page.locator(".resource-status");
  const openCount = () => conversation.locator(".conv-entry").count();
  const refresh = page.getByRole("button", {
    name: "Refresh task",
    exact: true,
  });
  const top = () => refresh.evaluate((el) => el.getBoundingClientRect().top);
  const opened = await openCount(),
    shown = await marker(2).count();
  assert.ok(shown > 0);
  assert.ok(opened >= 3);
  // Reading position inside the conversation, where record ids nest.
  await page
    .locator("#conversation h3")
    .evaluate((el) =>
      scrollTo(0, el.getBoundingClientRect().top + scrollY - 90),
    );
  const scrolled = await page.evaluate(() => scrollY);
  assert.ok(scrolled > 0);
  const refreshTop = await top();

  // 1. An unchanged poll changes nothing visible, even while its conversation revalidates.
  await watchDom(page);
  const taskRead = await holdResponse(
    page,
    `**/api/operator/tasks/${a.taskId}*`,
  );
  const timelineRead = await holdResponse(
    page,
    `**/api/operator/tasks/${a.taskId}/timeline*`,
  );
  await page.clock.runFor(15000);
  await taskRead.entered;
  assert.equal(await status.count(), 0);
  assert.equal(await marker(2).count(), shown);
  assert.equal(await openCount(), opened);
  assert.equal(await top(), refreshTop);
  assert.deepEqual((await observedDom(page))?.changes, []);
  taskRead.release();
  await timelineRead.entered;
  assert.equal(await marker(2).count(), shown);
  assert.equal(await openCount(), opened);
  timelineRead.release();
  await settleReads(page);
  const quiet = await observedDom(page);
  assert.equal(quiet?.statusSeen, false);
  assert.deepEqual(quiet?.changes, []);
  assert.equal(await top(), refreshTop);
  assert.equal(await page.evaluate(() => scrollY), scrolled);
  await taskRead.stop();
  await timelineRead.stop();

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
  assert.equal(
    await page
      .getByRole("heading", { name: "Latest result", exact: true })
      .count(),
    1,
  );
  explicit.release();
  await page.waitForLoadState("networkidle");
  await explicit.stop();
  await page.waitForFunction(
    () => document.querySelector(".resource-status") === null,
  );

  // 4. A late conversation answer cannot replace a newer one.
  const late = await holdResponse(
    page,
    `**/api/operator/tasks/${a.taskId}/timeline*`,
  );
  await refresh.click();
  await late.entered;
  addHistory("NEW");
  await refresh.click();
  await marker("NEW").first().waitFor();
  late.release();
  await page.waitForLoadState("networkidle");
  assert.ok((await marker("NEW").count()) > 0);

  // 5. A conversation that a poll cannot revalidate keeps its last validated entries, says
  // they may be out of date, and Retry reads it again.
  const unreadable = await failResponses(
    page,
    `**/api/operator/tasks/${a.taskId}/timeline*`,
  );
  await page.clock.runFor(15000);
  await page.getByText(/^The conversation could not be refreshed/).waitFor();
  assert.ok((await marker(2).count()) > 0);
  await unreadable.stop();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page
    .getByText(/^The conversation could not be refreshed/)
    .waitFor({ state: "detached" });
});
