import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { withoutChangeStream } from "../fixtures/background-refresh.js";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";
const test = browserSuite("task-change-stream-browser");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

async function open(j: BrowserJourney) {
  const f: Fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f),
    r = a.delegatedResult("Delegated result");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page: Page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(10_000);
  await page.clock.install();
  const taskPath = `/api/operator/tasks/${a.taskId}`;
  let taskReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === taskPath) taskReads++;
  });
  const connected = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${taskPath}/stream`) && response.ok(),
  );
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await connected;
  const conversation = page.locator("#conversation");
  await conversation
    .locator(`[data-record-id="delegation:${r.assignmentId}"]`)
    .getByRole("button")
    .first()
    .click();
  let item = 0;
  /** A completed assistant entry captured through the service's own store. */
  const capture = (text: string) =>
    f.service.conversationHistoryStore()?.record(
      {
        workId: r.workId,
        taskId: a.taskId,
        assignmentId: r.assignmentId,
        assignmentVersion: 1,
        instructionsRevision: 1,
        profileRevision: 1,
        conversationRevision: 1,
        workRevision: 1,
        threadId: r.workId,
        turnId: r.workId,
      },
      {
        kind: "completed",
        threadId: r.workId,
        turnId: r.workId,
        itemId: `stream-${++item}`,
        text,
      },
      [],
    );
  const rename = (title: string) => {
    const d = f.service.domain();
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: a.projectId,
      taskId: a.taskId,
      expectedVersion: Number(d.task(a.taskId).version),
      title,
    });
  };
  return {
    f,
    web,
    page,
    conversation,
    capture,
    rename,
    taskReads: () => taskReads,
  };
}

test("a task change appears without waiting for the poll", async (_t, j) => {
  const { page, conversation, capture, rename, taskReads } = await open(j);
  const before = taskReads();
  // The page clock never advances here: the 15-second poll cannot run.
  capture("Pushed assistant entry");
  await conversation
    .getByText("Pushed assistant entry", { exact: true })
    .waitFor();
  rename("Renamed through the stream");
  await page
    .getByRole("heading", { name: "Renamed through the stream" })
    .first()
    .waitFor();
  assert.ok(taskReads() > before);
});

test("a dropped stream falls back to polling and recovers", async (_t, j) => {
  const { web, page, conversation, capture, taskReads } = await open(j);
  // Healthy: the poll is suspended.
  let reads = taskReads();
  await page.clock.runFor(15_000);
  await page.waitForTimeout(500);
  assert.equal(taskReads(), reads, "no poll while the stream is healthy");

  // Dropped and refused: the poll returns.
  const refused = await withoutChangeStream(page);
  web.http.closeTaskStreams();
  await page.waitForTimeout(200);
  reads = taskReads();
  await page.clock.runFor(15_000);
  await page.waitForTimeout(500);
  assert.ok(taskReads() > reads, "the poll runs while the stream is down");
  capture("Polled assistant entry");
  await page.clock.runFor(15_000);
  await conversation
    .getByText("Polled assistant entry", { exact: true })
    .waitFor();

  // Reconnected: one refetch, then notices without the clock.
  await refused.stop();
  let atConnect = -1;
  page.on("response", (response) => {
    if (atConnect < 0 && response.url().endsWith("/stream") && response.ok())
      atConnect = taskReads();
  });
  await page.clock.runFor(40_000);
  for (let waited = 0; atConnect < 0; waited += 50) {
    assert.ok(waited < 10_000, "the stream reconnects");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1_500);
  assert.equal(taskReads() - atConnect, 1, "one refetch on reconnect");
  capture("Recovered assistant entry");
  await conversation
    .getByText("Recovered assistant entry", { exact: true })
    .waitFor();
});
