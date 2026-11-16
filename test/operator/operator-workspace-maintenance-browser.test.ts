import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { WorkspaceLifecycleStore } from "../../src/core/workspace-lifecycle.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { mixedForm } from "../fixtures/question-data.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { finishTask } from "../fixtures/workspace-removal.js";

const test = browserSuite("ui-workspace-maintenance");
const GB = 1_000_000_000;

test("the installation maintenance item lists blocking workspaces, links to their tasks and resolves on its own", async (_t, j) => {
  const sizes = new Map<string, number>();
  const clock = { offset: 0 };
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      undefined,
      j.fixtureOptions,
      undefined,
      {
        workspaceMaintenance: { idleHours: "off", diskCapGb: 1 },
        maintenancePass: {
          now: () => Date.now() + clock.offset,
          every: () => () => {},
          measure: async (roots) =>
            new Map(roots.map((r) => [r.key, sizes.get(r.key) ?? 0])),
        },
      },
    ),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const question = await seedOwnQuestion(f, mixedForm, "Unrelated question");
  const domain = f.service.domain();
  const projectId = randomUUID();
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Maintenance project",
    leadProfileId: null,
  });
  const task = async (title: string) => {
    const taskId = randomUUID();
    domain.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId,
      title,
      outcome: "O",
    });
    return { taskId, binding: await f.service.provisionTask(taskId, []) };
  };
  const large = await task("Large open task");
  const held = await task("Held done task");
  finishTask(f.service, held.taskId);
  f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO task_writer_holds (taskId, reason) VALUES (?, ?)")
      .run(held.taskId, "writer"),
  );
  new WorkspaceLifecycleStore(
    // biome-ignore lint/complexity/useLiteralKeys: the service's own database
    f.service["cache"]!,
  ).observe(large.binding, {
    kind: "turn-ended",
    eventId: `turn-ended:${randomUUID()}`,
    at: Date.now(),
    workId: randomUUID(),
    turnId: randomUUID(),
  });
  sizes.set(large.binding.workspaceId, 2 * GB);
  clock.offset = 25 * 3_600_000;
  await f.service.runWorkspaceMaintenance();

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commands.push(request.url());
  });
  await page.goto(`${web.origin}/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  const detail = page.getByRole("region", { name: "Selected request" }),
    kind = page.getByLabel("Request kind", { exact: true }),
    row = page.locator('.inbox-row[data-kind="workspace-maintenance"]'),
    optional = page
      .getByRole("region", { name: "Exact question response" })
      .getByRole("textbox", { name: "Your answer: Optional", exact: true }),
    draft = "Unrelated draft kept";
  // An unrelated question's draft, left before visiting the maintenance item.
  await page
    .locator(`.inbox-row[data-record-id="${question.interactionId}"]`)
    .click();
  await optional.fill(draft);

  await kind.selectOption("workspace-maintenance");
  await row.click();
  await page.waitForURL(
    (url) => url.searchParams.get("request") === "workspace-maintenance",
  );
  await detail
    .getByRole("heading", { name: "Workspace maintenance needs attention" })
    .waitFor();
  await detail
    .getByText(
      "Task workspaces use 2.0 GB, over the 1.0 GB disk limit; a workspace past its retention was not removed.",
    )
    .waitFor();
  const overLimit = detail.getByRole("region", { name: "Over the disk limit" }),
    pastRetention = detail.getByRole("region", {
      name: "Past retention, not removed",
    });
  await overLimit
    .getByText("The task is open, so its workspace can only be trimmed")
    .waitFor();
  await pastRetention
    .getByText("Task execution is not settled or the workspace is held")
    .waitFor();
  // Not dismissible while unresolved.
  assert.equal(
    await detail.getByRole("button", { name: "Dismiss", exact: true }).count(),
    0,
  );

  // The task link opens the task page only: no removal confirmation.
  await overLimit
    .getByRole("link", { name: "Large open task", exact: true })
    .click();
  await page.waitForURL(
    (url) => url.pathname === `/tasks/${large.taskId}` && url.search === "",
  );
  await page.locator("main.page h1").waitFor();
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  // Back returns to the same selection and filter.
  await page.goBack();
  await page.waitForURL(
    (url) => url.searchParams.get("request") === "workspace-maintenance",
  );
  await overLimit.waitFor();
  assert.equal(await kind.inputValue(), "workspace-maintenance");
  await kind.selectOption("");
  await page
    .locator(`.inbox-row[data-record-id="${question.interactionId}"]`)
    .click();
  assert.equal(await optional.inputValue(), draft);

  // The hold clears: the next pass removes that workspace and the item refreshes in place.
  f.seedPersistedState((db) =>
    db.prepare("DELETE FROM task_writer_holds WHERE taskId=?").run(held.taskId),
  );
  await f.service.runWorkspaceMaintenance();
  await row.click();
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await pastRetention.waitFor({ state: "detached" });
  await overLimit.waitFor();
  await detail
    .getByText("Task workspaces use 2.0 GB, over the 1.0 GB disk limit.", {
      exact: true,
    })
    .waitFor();
  // Usage falls under the limit: the item resolves and leaves the queue.
  sizes.set(large.binding.workspaceId, 0);
  await f.service.runWorkspaceMaintenance();
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await row.waitFor({ state: "detached" });
  await page
    .getByText("This request has left the current queue.", { exact: false })
    .waitFor();
  assert.deepEqual(commands, [], "nothing was sent from the maintenance item");
});
