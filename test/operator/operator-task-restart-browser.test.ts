import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { configure, until } from "../fixtures/completed-lead.js";
import { refusedTask } from "../fixtures/refused-task.js";
import { stubReadiness } from "../fixtures/setup-browser.js";

const test = browserSuite("ui-task-restart");

const viewports = {
  desktop: { width: 1366, height: 900 },
  phone: { width: 390, height: 844 },
};

for (const [name, viewport] of Object.entries(viewports)) {
  test(`Start again and Reset task are offered from the task page, the Inbox and Home (${name})`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const detail = await refusedTask(f);
    const inbox = await refusedTask(f);
    const home = await refusedTask(f);
    const held = await refusedTask(f);
    const reset = await refusedTask(f);
    f.seedPersistedState((db) =>
      db
        .prepare(
          "INSERT INTO task_writer_holds (taskId, reason) VALUES (?, 'Independent hold')",
        )
        .run(held.taskId),
    );
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page: Page = await browser.newPage({ viewport });
    j.observe(page);
    // Home shows its Needs you cards only once the getting-started rows pass.
    await stubReadiness(page);
    page.setDefaultTimeout(5000);
    const commands: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      const body = request.postData() ?? "";
      if (
        request.method() === "POST" &&
        /"task\.(start-again|reset)"/.test(body)
      )
        commands.push(JSON.parse(body));
    });
    await page.goto(`${web.origin}/app/tasks/${detail.taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("main.page h1").waitFor();

    const startAgain = () =>
      page.getByRole("button", { name: "Start again", exact: true });

    // Task detail: the state reads Not started, never Uncertain.
    await page.locator("[data-task-strip]").waitFor();
    await startAgain().waitFor();
    assert.equal(
      await page.locator("[data-task-strip] .task-state").innerText(),
      "Not started",
    );
    assert.equal(await page.getByText("Uncertain").count(), 0);
    assert.equal(commands.length, 0);
    await startAgain().click();
    await page.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.type, "task.start-again");
    assert.equal(commands[0]?.workId, detail.workId);
    assert.equal(
      commands[0]?.expectedVersion,
      Number(f.service.domain().task(detail.taskId).version),
    );

    // Home shows its board once a task has started a turn: let the restarted one run.
    configure(f, detail.projectId, false);
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 8 });
    await until(() => f.runtime.hasPending(1), "the restarted turn starts");

    // A hold that may be live shows its reason and the recovery, and sends nothing.
    await page.goto(`${web.origin}/app/tasks/${held.taskId}`);
    await page
      .getByText(/Start again isn't offered: an execution is unresolved/)
      .waitFor();
    assert.equal(
      await page
        .locator("[data-start-again]")
        .getByRole("link", { name: "Open recovery" })
        .getAttribute("href"),
      `/runtime/task/${held.taskId}`,
    );
    // Reset is disabled with its reason and recovery beside it.
    if (viewport.width < 760)
      await page.locator(".task-header-overflow-toggle").click();
    await page
      .getByText(/Reset isn't offered: the task or an assignment is held/)
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Reset task…" }).isDisabled(),
      true,
    );
    assert.equal(await startAgain().count(), 0);
    assert.equal(commands.length, 1);

    // The Inbox intervention offers the same action.
    await page.goto(
      `${web.origin}/app/inbox?task=${inbox.taskId}&request=${encodeURIComponent(`intervention:${inbox.taskId}`)}`,
    );
    await startAgain().waitFor();
    await startAgain().click();
    await page.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 2);
    assert.equal(commands[1]?.workId, inbox.workId);

    // Home's Needs you card offers it in place.
    await page.goto(`${web.origin}/app`);
    const card = page.locator(
      `.overview-card[data-request-id="intervention:${home.taskId}"]`,
    );
    await card
      .getByRole("button", { name: "Start again", exact: true })
      .click();
    await card.getByText(/Queued again\./).waitFor();
    assert.equal(commands.length, 3);
    assert.equal(commands[2]?.workId, home.workId);

    // Reset task confirms first, says it cannot be undone and sends once on confirm.
    await page.goto(`${web.origin}/app/tasks/${reset.taskId}`);
    await page.locator("[data-task-strip]").waitFor();
    if (viewport.width < 760)
      await page.locator(".task-header-overflow-toggle").click();
    await page.getByRole("button", { name: "Reset task…" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText(/cannot be undone/).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(commands.length, 3, "Cancel sends nothing");
    if (
      viewport.width < 760 &&
      !(await page
        .locator("details.task-header-overflow")
        .evaluate((d) => (d as HTMLDetailsElement).open))
    )
      await page.locator(".task-header-overflow-toggle").click();
    await page.getByRole("button", { name: "Reset task…" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Reset task", exact: true })
      .click();
    await page
      .getByText(/Reset\. The lead starts a fresh conversation/)
      .waitFor();
    assert.equal(commands.length, 4);
    assert.equal(commands[3]?.type, "task.reset");
    assert.equal(
      commands[3]?.expectedVersion,
      Number(f.service.domain().task(reset.taskId).version),
    );
  });
}
