import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedImportedCommentTask } from "../fixtures/task-review.js";

const test = browserSuite("ui-source-hold");

async function start(
  j: BrowserJourney,
  viewport: { width: number; height: number },
) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const imported = await seedImportedCommentTask(f, null);
  // The fixture's issue, re-read: closing holds the task and reopening leaves the hold for the operator.
  const sync = (state: "open" | "closed") =>
    f.service.githubSources().reconcileSelection(imported.projectId, "repo", {
      complete: true,
      reason: null,
      issues: [
        {
          providerInstance: "github.com",
          nodeId: "I-COMMENT",
          repositoryId: "R-COMMENT",
          repositoryName: "fixture/source",
          number: 7,
          title: "Imported comment task",
          body: "Supplied GitHub brief",
          state,
          labels: ["ready"],
          projectFields: [
            { projectNodeId: "P1", fieldNodeId: "F1", optionNodeId: "O1" },
          ],
        },
      ],
    });
  sync("closed");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (request.method() === "POST" && body.includes('"source.review"'))
      commands.push(JSON.parse(body));
  });
  return { f, imported, sync, web, page, commands };
}

async function signIn(
  page: Page,
  web: { origin: string; password: string },
  path: string,
) {
  await page.goto(`${web.origin}${path}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}

const resume = (page: Page) =>
  page.getByRole("button", { name: "Resume source hold", exact: true });

test("a source hold shows its reason and text with only Resume source hold, refuses until the source is open, then resumes", async (_t, j) => {
  const { f, imported, sync, web, page, commands } = await start(j, {
    width: 1366,
    height: 900,
  });
  await signIn(page, web, `/app/tasks/${imported.taskId}`);
  const card = page.locator("[data-source-hold]");
  await card.waitFor();
  // Reason, current source and task text, and the one decision.
  await card.getByText(/The issue was closed after import/).waitFor();
  assert.match(await card.innerText(), /Source title\s+Imported comment task/);
  assert.match(await card.innerText(), /Task title\s+Imported comment task/);
  await captureBrowserEvidence(page, "source-hold-desktop", {
    fullPage: false,
  });
  await card.getByText("Source and task text").click();
  await card.getByText("Supplied GitHub brief").first().waitFor();
  assert.deepEqual(await card.getByRole("button").allInnerTexts(), [
    "Resume source hold",
  ]);
  assert.match(await card.innerText(), /do not confirm runtime admission/);
  // The inspector states the same hold and the Project field values.
  const inspector = page.locator('aside[aria-label="Task context"]');
  await inspector.getByText(/Source hold · The issue was closed/).waitFor();
  await inspector.getByText("F1: O1").waitFor();

  // The service refuses while the issue is closed; the card says so and stays.
  await resume(page).click();
  await card.getByText(/Not resumed:/).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.decision, "resume-source-hold");
  assert.equal(await resume(page).count(), 1);
  assert.equal(f.service.githubSources().hold("I-COMMENT")?.active, 1);

  // Reopened, the hold waits for the operator; resuming clears it and nothing else.
  sync("open");
  assert.equal(f.service.githubSources().hold("I-COMMENT")?.active, 1);
  await page.reload();
  await card.waitFor();
  await resume(page).click();
  await card.getByText(/Source hold resumed/).waitFor();
  assert.equal(await resume(page).count(), 0);
  assert.equal(commands.length, 2);
  assert.equal(f.service.githubSources().hold("I-COMMENT")?.active, 0);
  await inspector.getByText(/Source hold ·/).waitFor({ state: "hidden" });
  await inspector
    .getByText(/Last source decision · Resumed source hold/)
    .waitFor();
  // A hold reactivated later, at the same task version, is a new decision with its own reason.
  const version = f.service.domain().task(imported.taskId).version;
  f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE source_holds SET active = 1, reason = 'closure-read-unavailable', generation = generation + 1 WHERE externalId = 'I-COMMENT'",
      )
      .run(),
  );
  assert.equal(f.service.domain().task(imported.taskId).version, version);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("cab-task-changed")),
  );
  await card
    .getByText(/could not read whether it closed the issue itself/)
    .waitFor();
  assert.equal(await resume(page).count(), 1);
  assert.equal(await card.getByText(/Source hold resumed/).count(), 0);
  const domain = f.service.domain().task(imported.taskId);
  assert.equal(domain.title, "Imported comment task");
  assert.equal(domain.outcome, "Supplied GitHub brief");
});

test("the decisions link opens on the card and Resume source hold is keyboard operable", async (_t, j) => {
  const { f, imported, sync, web, page, commands } = await start(j, {
    width: 390,
    height: 844,
  });
  sync("open");
  await signIn(page, web, `/app/tasks/${imported.taskId}?section=decisions`);
  const card = page.locator("section#decisions [data-source-hold]");
  await card.waitFor();
  const box = await card.boundingBox();
  assert.ok(box && box.y >= 0 && box.y < 844, JSON.stringify(box));
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await captureBrowserEvidence(page, "source-hold-phone", { fullPage: false });
  await resume(page).focus();
  await page.keyboard.press("Enter");
  await card.getByText(/Source hold resumed/).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(f.service.githubSources().hold("I-COMMENT")?.active, 0);
});
