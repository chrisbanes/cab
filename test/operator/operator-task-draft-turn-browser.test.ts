import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Page } from "playwright";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { configure } from "../fixtures/completed-lead.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const test = browserSuite("ui-task-draft-turn");

const viewports = {
  desktop: { width: 1366, height: 900 },
  phone: { width: 390, height: 844 },
};

for (const [name, viewport] of Object.entries(viewports)) {
  test(`the Reply area starts a draft turn on an open Draft task and explains why it cannot (${name})`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const api = new OperatorApi(f.service, []);
    const domain = f.service.domain();
    const open = await seedReviewTask(f, "Open project", "Open task");
    const done = await seedReviewTask(f, "Done project", "Done task");
    const noLead = await seedReviewTask(f, "No lead project", "No lead task");
    const active = await seedReviewTask(f, "Active project", "Active task");
    const paused = await seedReviewTask(f, "Paused project", "Paused task");
    const ready = await seedReviewTask(f, "Ready project", "Ready task");
    const stale = await seedReviewTask(f, "Stale project", "Stale task");
    for (const task of [open, done, noLead, active, stale])
      configure(f, task.projectId, false);
    configure(f, paused.projectId, true);
    f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE domain_tasks SET state = 'done', version = version + 1 WHERE id = ?",
      ).run(done.taskId);
      db.prepare(
        "UPDATE domain_projects SET leadProfileId = NULL WHERE id = ?",
      ).run(noLead.projectId);
      db.prepare(
        "UPDATE domain_tasks SET ready = 1, version = version + 1 WHERE id = ?",
      ).run(ready.taskId);
    });
    configure(f, ready.projectId, true);
    const start = (taskId: string, message: string) =>
      api.execute({
        type: "task.draft-turn",
        key: randomUUID(),
        taskId,
        expectedVersion: Number(domain.task(taskId).version),
        message,
      });
    await start(active.taskId, "Already queued.");
    await start(paused.taskId, "Held by the pause.");

    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start("browser.launch", () => chromium.launch());
    const page: Page = await browser.newPage({ viewport });
    j.observe(page);
    page.setDefaultTimeout(5000);
    const commands: string[] = [];
    page.on("request", (request) => {
      const body = request.postData() ?? "";
      if (request.method() === "POST" && body.includes('"task.draft-turn"'))
        commands.push(body);
    });
    await page.goto(`${web.origin}/app/tasks/${open.taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("main.page h1").waitFor();

    const visit = async (taskId: string, title: string) => {
      await page.goto(`${web.origin}/app/tasks/${taskId}`);
      await page.getByRole("heading", { name: title, level: 1 }).waitFor();
    };
    const startButton = () =>
      page.getByRole("button", { name: "Start draft turn", exact: true });

    // Each unavailable reason shows its sentence, disables the button and sends nothing.
    for (const [task, title, sentence] of [
      [
        done,
        "Done task",
        /Draft turns need an open task\. This task is Done\./,
      ],
      [noLead, "No lead task", /Draft turns need a project lead\./],
      [active, "Active task", /already queued or running/],
    ] as const) {
      await visit(task.taskId, title);
      await page.getByText(sentence).waitFor();
      await startButton().waitFor();
      assert.equal(await startButton().isDisabled(), true, title);
    }
    // A Ready task keeps the ordinary reply.
    await visit(ready.taskId, "Ready task");
    await page.getByRole("button", { name: "Send to task lead" }).waitFor();
    assert.equal(await startButton().count(), 0);
    assert.deepEqual(commands, []);

    // A project pause holds the queued turn; the page still reads the task.
    await visit(paused.taskId, "Paused task");
    await page
      .getByText(/Project paused|project is paused/i)
      .first()
      .waitFor();

    // The available entry point posts exactly one command and shows the sent line.
    await visit(open.taskId, "Open task");
    await page.getByText(/Read-only: Task lead reads the task/).waitFor();
    assert.equal(await startButton().isDisabled(), true);
    await page.locator("#workspace-reply").fill("Why is the check flaky?");
    await startButton().click();
    await page.getByText("Draft turn queued for Task lead.").waitFor();
    assert.equal(commands.length, 1);
    assert.match(commands[0] ?? "", /Why is the check flaky\?/);
    assert.equal(await page.locator("#workspace-reply").inputValue(), "");

    // A confirmed refusal keeps the typed text: the turn started elsewhere meanwhile.
    await visit(stale.taskId, "Stale task");
    await page.locator("#workspace-reply").fill("My unsent question");
    await start(stale.taskId, "Started from the CLI.");
    await startButton().click();
    await page.getByText(/Your draft is kept\./).waitFor();
    assert.equal(
      await page.locator("#workspace-reply").inputValue(),
      "My unsent question",
    );
    assert.equal(commands.length, 2);
  });
}
