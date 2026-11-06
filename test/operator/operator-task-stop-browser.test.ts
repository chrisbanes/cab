import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const test = browserSuite("ui-task-stop");

test("the task header offers Stop… only on an open task and Resume… on a stopped one", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const open = await seedReviewTask(f, "Open project", "Open task");
  const done = await seedReviewTask(f, "Done project", "Done task");
  const cancelled = await seedReviewTask(
    f,
    "Cancelled project",
    "Cancelled task",
  );
  f.seedPersistedState((db) => {
    const finish = db.prepare(
      "UPDATE domain_tasks SET state = ?, version = version + 1 WHERE id = ?",
    );
    finish.run("done", done.taskId);
    finish.run("cancelled", cancelled.taskId);
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/tasks/${open.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();

  const actions = async (taskId: string, title: string) => {
    await page.goto(`${web.origin}/tasks/${taskId}`);
    await page.getByRole("heading", { name: title, level: 1 }).waitFor();
    const header = page.locator(".page-header .task-header-actions");
    await header.getByRole("link", { name: "Execution" }).waitFor();
    return header
      .locator("> *")
      .evaluateAll((els) =>
        els.map((e) => [
          e.tagName,
          e.textContent,
          (e as HTMLButtonElement).disabled,
        ]),
      );
  };

  assert.deepEqual(await actions(open.taskId, "Open task"), [
    ["A", "Execution", undefined],
    ["BUTTON", "Edit task…", false],
    ["BUTTON", "Reset task…", true],
    ["BUTTON", "Stop…", false],
  ]);
  // Editing a local task stays offered once it is finished, as on the retained page.
  assert.deepEqual(await actions(done.taskId, "Done task"), [
    ["A", "Execution", undefined],
    ["BUTTON", "Edit task…", false],
  ]);
  assert.deepEqual(await actions(cancelled.taskId, "Cancelled task"), [
    ["A", "Execution", undefined],
    ["BUTTON", "Edit task…", false],
  ]);

  // An existing Stop on a finished task offers Resume….
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
    ).run(done.taskId);
  });
  assert.deepEqual(await actions(done.taskId, "Done task"), [
    ["A", "Execution", undefined],
    ["BUTTON", "Edit task…", false],
    ["BUTTON", "Resume…", false],
  ]);
});
