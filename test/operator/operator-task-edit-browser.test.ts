import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  seedImportedCommentTask,
  seedReviewTask,
} from "../fixtures/task-review.js";

const test = browserSuite("ui-task-edit");

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
  return {
    f,
    open: async () => {
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start("browser.launch", () => chromium.launch());
      const page = await browser.newPage({ viewport });
      j.observe(page);
      page.setDefaultTimeout(5000);
      return { web, page };
    },
  };
}

async function signIn(
  page: Page,
  web: { origin: string; password: string },
  taskId: string,
) {
  await page.goto(`${web.origin}/app/tasks/${taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}

const trigger = (page: Page) =>
  page.getByRole("button", { name: "Edit task…", exact: true });

test("a local task is edited from its header with version fencing and a conflict shows the latest values", async (_t, j) => {
  const { f, open } = await start(j, { width: 1366, height: 900 });
  const task = await seedReviewTask(
    f,
    "Edit project",
    "Local task",
    "Old outcome",
  );
  const { web, page } = await open();
  const d = f.service.domain();
  await signIn(page, web, task.taskId);
  const configures: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (request.method() === "POST" && body.includes('"task.configure"'))
      configures.push(JSON.parse(body));
  });

  await trigger(page).click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel("Title").inputValue(), "Local task");
  assert.equal(
    await dialog.getByLabel("Desired outcome").inputValue(),
    "Old outcome",
  );
  assert.equal(await dialog.getByLabel("Ready").isChecked(), false);
  await captureBrowserEvidence(page, "task-edit-desktop", { fullPage: false });

  // A conflict: the version moves while the dialog is open.
  const version = Number(d.task(task.taskId).version);
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: version,
    title: "Changed elsewhere",
    outcome: "Elsewhere outcome",
  });
  // A reread that lands while the dialog is open must not move the version the draft is saved at.
  const reread = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new RegExp(`/api/operator/tasks/${task.taskId}(\\?.*)?$`).test(r.url()),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("cab-task-changed")),
  );
  await reread;
  await page.waitForTimeout(300);
  await dialog.getByLabel("Title").fill("My title");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByText(/Not saved: the task changed/).waitFor();
  assert.equal(configures.at(-1)?.expectedVersion, version);
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          '[role="dialog"] input[type="text"], [role="dialog"] input:not([type])',
        ) as HTMLInputElement | null
      )?.value === "Changed elsewhere",
  );
  assert.equal(
    await dialog.getByLabel("Desired outcome").inputValue(),
    "Elsewhere outcome",
  );
  assert.equal(Number(d.task(task.taskId).version), version + 1);

  await dialog.getByLabel("Title").fill("Final title");
  await dialog.getByLabel("Desired outcome").fill("Final outcome");
  await dialog.getByLabel("Ready").check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByText("Saved.").waitFor();
  assert.equal(configures.at(-1)?.expectedVersion, version + 1);
  const saved = d.task(task.taskId);
  assert.equal(saved.title, "Final title");
  assert.equal(saved.outcome, "Final outcome");
  assert.equal(Number(saved.ready), 1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Final title", level: 1 }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Edit task…",
  );
});

test("Edit task… is keyboard operable and Escape closes it without saving", async (_t, j) => {
  const { f, open } = await start(j, { width: 1366, height: 900 });
  const task = await seedReviewTask(
    f,
    "Keyboard project",
    "Keyboard task",
    "Outcome",
  );
  const { web, page } = await open();
  await signIn(page, web, task.taskId);
  const version = Number(f.service.domain().task(task.taskId).version);

  await trigger(page).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  await dialog.waitFor();
  // A task keeps a title and an outcome: Save waits for both.
  await dialog.getByLabel("Desired outcome").fill("");
  assert.equal(
    await dialog
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
    true,
  );
  await dialog.getByLabel("Title").fill("Never saved");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.ok(await trigger(page).evaluate((e) => e === document.activeElement));
  const d = f.service.domain();
  assert.equal(d.task(task.taskId).title, "Keyboard task");
  assert.equal(Number(d.task(task.taskId).version), version);
  // Reopening starts from the saved values, not the abandoned draft.
  await page.keyboard.press("Enter");
  assert.equal(await dialog.getByLabel("Title").inputValue(), "Keyboard task");
});

test("an imported task has no Edit task… and a phone keeps it in Task actions", async (_t, j) => {
  const { f, open } = await start(j, { width: 390, height: 844 });
  const imported = await seedImportedCommentTask(f, null);
  const local = await seedReviewTask(
    f,
    "Phone project",
    "Phone task",
    "Outcome",
  );
  const { web, page } = await open();
  await signIn(page, web, imported.taskId);
  await page
    .locator(".task-header-actions a", { hasText: "Execution" })
    .waitFor({ state: "attached" });
  assert.equal(await trigger(page).count(), 0);

  await page.goto(`${web.origin}/app/tasks/${local.taskId}`);
  await page.locator("main.page h1").waitFor();
  const header = page.locator(".page-header");
  // Closed on a phone, the action is not reachable until the disclosure opens.
  assert.equal(await trigger(page).isVisible(), false);
  await header.locator(".task-header-overflow-toggle").click();
  await trigger(page).click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  assert.ok(
    box &&
      box.x >= 0 &&
      box.x + box.width <= 390 &&
      box.y >= 0 &&
      box.y + box.height <= 844,
  );
  await captureBrowserEvidence(page, "task-edit-phone", { fullPage: false });
  // Escape closes the dialog first; the overflow stays open with focus on the trigger.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await trigger(page).isVisible(), true);
  assert.ok(await trigger(page).evaluate((e) => e === document.activeElement));
  await page.keyboard.press("Escape");
  assert.equal(await trigger(page).isVisible(), false);
});

test("a title or outcome the read redacts is never offered for editing, and Ready alone sends only Ready", async (_t, j) => {
  const { f, open } = await start(j, { width: 1366, height: 900 });
  const redacted = await seedReviewTask(
    f,
    "Redacted project",
    "Rotate the Canary value",
    "Outcome",
  );
  const plain = await seedReviewTask(
    f,
    "Plain project",
    "Plain title",
    "Plain outcome",
  );
  const d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: redacted.projectId,
    expectedVersion: Number(d.project(redacted.projectId).version),
    instructions: "Canary value",
  });
  const { web, page } = await open();
  await signIn(page, web, redacted.taskId);
  await page.getByRole("link", { name: "Execution" }).waitFor();
  assert.equal(await trigger(page).count(), 0);

  const configures: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (request.method() === "POST" && body.includes('"task.configure"'))
      configures.push(JSON.parse(body));
  });
  await page.goto(`${web.origin}/app/tasks/${plain.taskId}`);
  await trigger(page).click();
  const dialog = page.getByRole("dialog", { name: "Edit task" });
  // Nothing changed yet: there is nothing to save.
  assert.equal(
    await dialog
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
    true,
  );
  await dialog.getByLabel("Ready").check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByText("Saved.").waitFor();
  assert.equal(configures.length, 1);
  assert.equal(configures[0]?.ready, true);
  assert.equal("title" in (configures[0] ?? {}), false);
  assert.equal("outcome" in (configures[0] ?? {}), false);
  assert.equal(d.task(plain.taskId).title, "Plain title");
});
