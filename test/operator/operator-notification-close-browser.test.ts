import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedOwnQuestion } from "../fixtures/questions.js";

const test = browserSuite("notification-close");

/**
 * Stands in for the service worker registration only: headless Chromium refuses showNotification,
 * so the registration reports notifications the test chose and records which ones the page closed.
 * The page, its Inbox read and `loadInbox` are real.
 */
const registrationStub = (tags: {
  open: string;
  resolved: string;
  other: string[];
}) => {
  const closed: string[] = [];
  (window as unknown as { closedTags: string[] }).closedTags = closed;
  const note = (tag: string, timestamp: number) => ({
    tag,
    timestamp,
    close: () => void closed.push(tag),
  });
  const registration = {
    getNotifications: async () => [
      note(tags.open, 0),
      note(tags.resolved, 0),
      ...tags.other.map((tag) => note(tag, 0)),
      // Created after any read could have started: it may be about an alert that read never saw.
      note("newer-than-the-read", Date.now() + 3_600_000),
    ],
  };
  navigator.serviceWorker.getRegistration = async () => registration as never;
};

test("Inbox read closes notifications for resolved requests by tag and nothing else", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const q = await seedOwnQuestion(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const context = await browser.newContext();
  await context.addInitScript(registrationStub, {
    open: q.interactionId,
    resolved: "question-answered-elsewhere",
    other: ["test:notification", ""],
  });
  const page = await context.newPage();
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".inbox-row").first().waitFor();
  await page.waitForFunction(
    () => (window as unknown as { closedTags: string[] }).closedTags.length > 0,
  );
  // Let any further Inbox reads (the shell summary, polling) finish before reading the record.
  await page.waitForLoadState("networkidle");
  // The shell summary and the route each read the Inbox, and the stub keeps reporting what it
  // was given, so the same tag may be closed once per read.
  assert.deepEqual(
    await page.evaluate(() => [
      ...new Set((window as unknown as { closedTags: string[] }).closedTags),
    ]),
    ["question-answered-elsewhere"],
    "the still-waiting request, the test notification, the untagged one and the newer one stay",
  );
});
