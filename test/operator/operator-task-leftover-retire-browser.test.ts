import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const test = browserSuite("ui-task-leftover-retire");

const dialog = (page: Page) => page.getByRole("alertdialog");
const trigger = (page: Page) =>
  page
    .locator(".page-header .task-header-actions")
    .getByRole("button", { name: "Retire leftover execution…" });

test("Retire leftover execution lists a closed task's holds, keeps the reason through a changed listing and retires it", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const task = await seedReviewTask(f, "Leftover project", "Leftover task");
  const domain = f.service.domain();
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    taskId: task.taskId,
    expectedVersion: Number(domain.task(task.taskId).version),
    state: "done",
  } as never);
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Legacy writer hold')",
    ).run(task.taskId);
    db.prepare(
      "INSERT INTO task_archival_holds (taskId, reason) VALUES (?, 'Task archival in progress')",
    ).run(task.taskId);
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commands.push(request.postDataJSON());
  });
  await page.goto(`${web.origin}/tasks/${task.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  await page.getByText(/execution not settled/).first().waitFor();

  // The confirmation lists each hold and opens on its safe choice.
  await trigger(page).click();
  await dialog(page).locator("[data-leftover-items] li").first().waitFor();
  assert.deepEqual(
    await dialog(page).locator("[data-leftover-items] li").allInnerTexts(),
    [
      "Archival hold: Task archival in progress",
      "Writer hold: Legacy writer hold",
    ],
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Cancel",
  );
  const confirm = dialog(page).getByRole("button", {
    name: "Retire leftovers",
  });
  assert.equal(await confirm.isDisabled(), true, "a reason is required");
  await dialog(page).getByRole("textbox").fill("Closed before it settled");

  // A hold recorded after the listing: the service refuses, and the reason is kept.
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO task_writer_ambiguity_holds (taskId, reason) VALUES (?, 'Legacy work revision order is ambiguous')",
      )
      .run(task.taskId),
  );
  await confirm.click();
  await dialog(page)
    .getByText(/digest-changed/)
    .waitFor();
  assert.equal(
    await dialog(page).getByRole("textbox").inputValue(),
    "Closed before it settled",
  );
  await dialog(page).getByRole("button", { name: "List them again" }).click();
  await dialog(page)
    .getByText("Ambiguity hold: Legacy work revision order is ambiguous")
    .waitFor();
  await dialog(page).getByRole("button", { name: "Retire leftovers" }).click();
  await dialog(page).getByText("Leftover execution retired.").waitFor();
  assert.deepEqual(
    commands.map((c) => c.type),
    ["recovery.retire", "recovery.retire"],
  );
  assert.equal(commands[1]?.reason, "Closed before it settled");
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await trigger(page).waitFor({ state: "detached" });
  await page.getByText(/execution not settled/).first().waitFor({
    state: "detached",
  });
});
