import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { completedLead } from "../fixtures/completed-lead.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { openTaskDetails, openTaskTab } from "../fixtures/task-tabs.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const test = browserSuite("ui-task-workspace-remove");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

const finish = (f: Fixture, taskId: string) => {
  const domain = f.service.domain();
  const task = domain.task(taskId);
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: String(task.projectId),
    taskId,
    expectedVersion: Number(task.version),
    state: "done",
  } as never);
};

const goes = [
  "Each repository's worktree, with its ignored files such as dependencies and build output",
  "The scratch directory",
  "Other files at the workspace root",
  "The workspace's Claude temporary directory",
];
const stays = [
  "The task branch at its pushed commit in each repository",
  "Change requests",
  "Results, readable from their commits",
  "Conversations and task records",
];

const dialog = (page: Page) => page.getByRole("alertdialog");
const trigger = (page: Page) =>
  page
    .locator(".page-header .task-header-actions")
    .getByRole("button", { name: "Remove workspace…" });
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent ?? "");

test("Remove workspace confirms what goes and stays, survives a lost reply and never removes a newer workspace", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { task: main } = await completedLead(f, "Removal project");
  const mainWorkspace = (await f.service.taskWorkspace(main.taskId))!;
  finish(f, main.taskId);
  const stale = await seedReviewTask(f, "Stale project", "Stale task");
  finish(f, stale.taskId);
  const held = await seedReviewTask(f, "Held project", "Held task");
  finish(f, held.taskId);
  f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
      .run(held.taskId, "writer"),
  );
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
  await page.goto(`${web.origin}/tasks/${main.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();

  // Desktop: the action sits in the header; the confirmation opens on its safe choice.
  await trigger(page).click();
  await dialog(page)
    .getByRole("heading", {
      name: "Remove the workspace of Restore command focus?",
    })
    .waitFor();
  assert.equal(await focused(page), "Cancel");
  const text = await dialog(page).innerText();
  for (const line of [
    ...goes,
    ...stays,
    "Removal cannot be undone. cab checks again before deleting anything and refuses if work could be lost. A later turn gets a new workspace.",
  ])
    assert.ok(text.includes(line), line);
  assert.doesNotMatch(text, /archiv/i);
  // Tab stays in the dialog; Escape and Cancel both return focus to the action.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog(page).evaluate((d) => d.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Remove workspace…",
  );
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Remove workspace…",
  );
  assert.equal(commands.length, 0);

  // An unsent comment draft survives the removal and the reread it causes.
  const reply = page.getByLabel("Reply", { exact: true });
  await reply.fill("Keep this draft");
  // A reply lost after the removal: the dialog keeps the exact command, and the check replays it.
  let lose = true;
  await page.route("**/api/operator/commands", async (route) => {
    if (
      lose &&
      (route.request().postData() ?? "").includes("task.workspace.remove")
    ) {
      lose = false;
      await route.fetch();
      await route.abort();
    } else await route.fallback();
  });
  await trigger(page).click();
  await dialog(page).getByRole("button", { name: "Remove workspace" }).click();
  await dialog(page)
    .getByRole("button", { name: "Check whether it saved" })
    .click();
  await dialog(page)
    .getByText(
      "Workspace removed. The task branch, results and conversations remain.",
    )
    .waitFor();
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], {
    type: "task.workspace.remove",
    key: commands[0]?.key,
    taskId: main.taskId,
    workspaceId: mainWorkspace.workspaceId,
  });
  assert.deepEqual(commands[1], commands[0]);
  assert.equal(existsSync(mainWorkspace.path), false);
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await dialog(page).waitFor({ state: "detached" });
  // The action is gone with the workspace; focus lands on the header's remaining control.
  await trigger(page).waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Execution",
  );

  assert.equal(await reply.inputValue(), "Keep this draft");
  // The record shows in Task details; results and the conversation are still there.
  await openTaskDetails(page);
  await page
    .locator("[data-workspace-records]")
    .getByText(/^Workspace removed .+ \(manual\)$/)
    .waitFor();
  await openTaskTab(page, "Files");
  await page
    .getByText("The workspace was removed; file bytes are not available.")
    .first()
    .waitFor();
  // Results are read from their commits and the conversation from the store: both remain.
  await openTaskTab(page, "Overview");
  const overview = page.locator("#task-panel-overview");
  await overview
    .locator(".conv-text", { hasText: "Lead finished the first pass" })
    .first()
    .waitFor();
  const resultLink = page
    .locator(".task-inspector")
    .locator('a[href*="?result="]')
    .first();
  await resultLink.click();
  assert.equal(new URL(page.url()).pathname, `/tasks/${main.taskId}`);
  await overview.getByText("Lead finished the first pass").first().waitFor();

  // A confirmation left open while the task got a new workspace names the old one, and is refused.
  await page.goto(`${web.origin}/tasks/${stale.taskId}`);
  await trigger(page).click();
  const first = (await f.service.taskWorkspace(stale.taskId))!;
  assert.equal(
    (await f.service.removeTaskWorkspace(stale.taskId, "manual")).outcome,
    "cleaned",
  );
  const next = await f.service.provisionTask(stale.taskId, []);
  assert.notEqual(next.workspaceId, first.workspaceId);
  await dialog(page).getByRole("button", { name: "Remove workspace" }).click();
  await dialog(page)
    .getByText(
      "Workspace not removed: The task's workspace was replaced after this removal was confirmed.",
    )
    .waitFor();
  assert.equal(commands.at(-1)?.workspaceId, first.workspaceId);
  assert.equal(existsSync(next.path), true);
  assert.equal((await f.service.taskWorkspace(stale.taskId))?.state, "ready");

  // Phone: the action is in Task actions, and a live refusal keeps the dialog with its reason.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web.origin}/tasks/${held.taskId}`);
  const overflow = page.locator(".page-header details.task-header-overflow");
  await overflow.locator("summary").click();
  const phoneTrigger = overflow.getByRole("button", {
    name: "Remove workspace…",
  });
  await phoneTrigger.click();
  await dialog(page).getByText("The scratch directory").waitFor();
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Remove workspace…",
  );
  assert.equal(await phoneTrigger.isVisible(), true);
  await phoneTrigger.click();
  await dialog(page).getByRole("button", { name: "Remove workspace" }).click();
  await dialog(page)
    .getByText(
      "Workspace not removed: Task execution is not settled or its workspace is held.",
    )
    .waitFor();
  assert.equal(
    existsSync((await f.service.taskWorkspace(held.taskId))!.path),
    true,
  );
});
