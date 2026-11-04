import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Page, webkit } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  createOperatorFixture,
  seedOperatorRecovery,
} from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const test = browserSuite("ui-task-execution");

async function signIn(
  page: Page,
  origin: string,
  password: string,
  path: string,
) {
  await page.goto(origin + path);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const engine of [
  { name: "chromium", type: chromium },
  { name: "webkit", type: webkit },
] as const) {
  test(
    `the Execution tab adds and removes a dependency and Apply updates a stale assignment (${engine.name})`,
    { browserEngine: engine.name },
    async (_t, j) => {
      const f = await j.start("fixture.create", () =>
        createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
      );
      let browser: Browser | undefined;
      j.cleanup(
        (primary) => f.close(browser, primary),
        "fixture.close",
        () => f.lifecycle.steps,
      );
      const a = await seedReviewTask(f, "Execution project", "Execution task");
      const d = f.service.domain(),
        blockerId = randomUUID();
      d.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        taskId: blockerId,
        title: "Blocker task",
        outcome: "Done",
        ready: false,
      });
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start(`browser.launch.${engine.name}`, () =>
        engine.type.launch(),
      );
      const page = await browser.newPage({
        viewport: { width: 1366, height: 900 },
      });
      j.observe(page);
      page.setDefaultTimeout(5000);
      const commands: Record<string, unknown>[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
          commands.push(r.postDataJSON());
      });

      // The header's Execution opens the tab in place.
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await page
        .locator(".task-header-actions")
        .getByRole("link", { name: "Execution", exact: true })
        .click();
      await page
        .getByRole("tab", { name: "Execution", selected: true })
        .waitFor();
      assert.match(page.url(), /\?section=execution$/);
      const execution = page.locator("section#execution");
      await execution.getByText("Task admission blocked:").waitFor();
      assert.ok(
        await execution
          .getByRole("link", { name: "Task-scoped lead execution" })
          .getAttribute("href")
          .then(
            (h) => h === `/app/tasks/${a.taskId}?assignment=${a.assignmentId}`,
          ),
      );
      await execution
        .getByText("No recovery records are recorded for this task.", {
          exact: false,
        })
        .waitFor();

      // Add: choose, review, Cancel sends nothing; confirm records one fenced command.
      const add = execution.getByRole("button", { name: "Add dependency…" });
      assert.equal(await add.isDisabled(), true);
      await execution.getByLabel("Local blocker").selectOption(blockerId);
      await add.click();
      const dialog = page.getByRole("alertdialog", {
        name: "Wait for Blocker task?",
      });
      // The confirmation opens on the choice that sends nothing.
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Cancel",
      );
      await captureBrowserEvidence(page, `dependency-confirm-${engine.name}`, {
        fullPage: false,
      });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Add dependency…",
      );
      assert.equal(commands.length, 0);
      await add.click();
      await dialog.getByRole("button", { name: "Add dependency" }).click();
      await execution.getByText("Dependency added.").waitFor();
      assert.deepEqual(d.dependencies(a.taskId), [blockerId]);
      assert.equal(commands[0]?.type, "dependency.add");
      assert.equal(commands[0]?.expectedVersion, 1);
      await execution
        .getByRole("link", { name: "Blocker task", exact: true })
        .waitFor();
      await execution
        .getByText("No other task in this project can be added.")
        .waitFor();

      // Remove is the counterpart; a lost reply is checked with the same key, never resent anew.
      let armed = true;
      await page.route("**/api/operator/commands", async (route) => {
        if (
          armed &&
          route.request().postData()?.includes('"dependency.remove"')
        ) {
          armed = false;
          await route.fetch();
          await route.abort();
        } else await route.fallback();
      });
      await execution.getByRole("button", { name: "Remove" }).click();
      await page
        .getByRole("alertdialog", { name: "Remove Blocker task as a blocker?" })
        .getByRole("button", { name: "Remove dependency" })
        .click();
      const check = execution.getByRole("button", {
        name: "Check whether it saved",
      });
      await check.waitFor();
      assert.deepEqual(d.dependencies(a.taskId), []);
      await check.click();
      await execution.getByText("Dependency removed.").waitFor();
      const removes = commands.filter((c) => c.type === "dependency.remove");
      assert.equal(removes.length, 2);
      assert.equal(removes[0]?.key, removes[1]?.key);
      await page.unroute("**/api/operator/commands");
      await execution.getByText("No local task blockers.").waitFor();
      await execution.getByLabel("Local blocker").selectOption(blockerId);
      await execution.getByRole("button", { name: "Add dependency…" }).click();
      await dialog.getByRole("button", { name: "Add dependency" }).click();
      await execution
        .getByRole("link", { name: "Blocker task", exact: true })
        .waitFor();
      assert.deepEqual(d.dependencies(a.taskId), [blockerId]);
      await captureBrowserEvidence(
        page,
        `task-execution-desktop-${engine.name}`,
      );

      // Apply: a stale row offers it in its expanded facts; a current row does not.
      const project = d.project(a.projectId);
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        expectedVersion: Number(project.version),
        instructions: "Updated instructions",
      });
      await page.getByRole("button", { name: "Refresh task" }).click();
      await page.getByRole("tab", { name: "Overview" }).click();
      const fold = page.locator("details.inspector-fold");
      if ((await fold.getAttribute("open")) === null)
        await fold.locator("> summary").click();
      const card = page.locator("#assignments > details.overview-disclosure");
      if ((await card.getAttribute("open")) === null)
        await card.locator("> summary").click();
      const facts = page.locator("details.assignment-facts").first();
      await facts.locator("> summary").click();
      // A never-started assignment's first turn takes the current revisions: nothing to apply.
      await facts
        .getByText(/^Assignment /)
        .first()
        .waitFor();
      assert.equal(
        await facts.getByText(/Captured revisions are behind/).count(),
        0,
      );
      f.seedPersistedState((db) => {
        db.prepare(
          "INSERT INTO execution_intents (id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,'started-work','p','/w','completed',NULL,'thread','turn','chatgpt','workspaceWrite','never')",
        ).run(randomUUID());
        db.prepare(
          "INSERT INTO task_execution_bindings (workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision) VALUES ('started-work',?,?,1,1,1,1)",
        ).run(a.taskId, a.assignmentId);
      });
      await page.getByRole("button", { name: "Refresh task" }).click();
      await facts.getByText(/Captured revisions are behind/).waitFor();
      await facts
        .getByRole("button", {
          name: "Apply current instructions for the next turn…",
        })
        .click();
      await page
        .getByRole("alertdialog", {
          name: "Apply current instructions for the next turn?",
        })
        .getByRole("button", { name: "Apply", exact: true })
        .click();
      await facts.getByText(/^Applied\./).waitFor();
      const applied = commands.find((c) => c.type === "assignment.apply");
      assert.equal(applied?.assignmentId, a.assignmentId);
      assert.equal(
        Number(d.assignment(a.assignmentId).instructionsRevision),
        Number(d.project(a.projectId).instructionsRevision),
      );
      await facts.getByText(/Captured revisions are behind/).waitFor({
        state: "detached",
      });

      // A Stop whose reply is lost is checked with the same key, never sent anew.
      let lose = true;
      await page.route("**/api/operator/commands", async (route) => {
        if (lose && route.request().postData()?.includes('"task.stop"')) {
          lose = false;
          await route.fetch();
          await route.abort();
        } else await route.fallback();
      });
      await page.getByRole("button", { name: "Stop…", exact: true }).click();
      const stop = page.getByRole("alertdialog", {
        name: "Stop Execution task?",
      });
      await stop.getByRole("button", { name: "Stop task" }).click();
      await stop
        .getByRole("button", { name: "Check whether it saved" })
        .click();
      await stop.getByText(/^Stop requested\./).waitFor();
      const stops = commands.filter((c) => c.type === "task.stop");
      assert.equal(stops.length, 2);
      assert.equal(stops[0]?.key, stops[1]?.key);
      assert.equal(f.service.isTaskStopped(a.taskId), true);
      await page.unroute("**/api/operator/commands");
      await stop.getByRole("button", { name: "Close" }).click();
      await page
        .getByRole("button", { name: "Resume…", exact: true })
        .waitFor();

      // Narrow: the tab fits the phone without sideways scrolling.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("tab", { name: "Execution" }).click();
      await execution
        .getByText("Local dependencies", { exact: true })
        .waitFor();
      assert.ok(await noHorizontalScroll(page));
      await captureBrowserEvidence(page, `task-execution-phone-${engine.name}`);
    },
  );

  test(
    `the Execution tab keeps an older record's holds in view after Resume (${engine.name})`,
    { browserEngine: engine.name },
    async (_t, j) => {
      const f = await j.start("fixture.create", () =>
        createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
      );
      let browser: Browser | undefined;
      j.cleanup(
        (primary) => f.close(browser, primary),
        "fixture.close",
        () => f.lifecycle.steps,
      );
      const a = await seedReviewTask(f, "Held project", "Held task");
      seedOperatorRecovery(f, {
        projectId: a.projectId,
        taskId: a.taskId,
        assignmentId: a.assignmentId,
      });
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start(`browser.launch.${engine.name}`, () =>
        engine.type.launch(),
      );
      const page = await browser.newPage({
        viewport: { width: 1366, height: 900 },
      });
      j.observe(page);
      page.setDefaultTimeout(5000);
      await signIn(
        page,
        web.origin,
        web.password,
        `/app/tasks/${a.taskId}?section=execution`,
      );
      const execution = page.locator("section#execution");
      await execution.getByText("Stopping; effects may continue").waitFor();
      await execution
        .getByText(
          "Showing the newest 20 of 21 recorded recovery records; 1 older record is omitted.",
        )
        .waitFor();
      await captureBrowserEvidence(
        page,
        `task-execution-stopping-${engine.name}`,
      );

      // Resume from the header clears only the Stop.
      await page.getByRole("button", { name: "Resume…", exact: true }).click();
      await page.getByRole("button", { name: "Resume task" }).click();
      await page.getByRole("button", { name: "Close" }).click();
      await page.getByRole("button", { name: "Stop…", exact: true }).waitFor();
      for (const hold of ["Writer ownership", "Capacity", "Uncertainty"])
        await execution.getByText(hold, { exact: true }).waitFor();
      await execution
        .getByText(/holds are still recorded; recovery is required/)
        .waitFor();
      assert.equal(
        await execution.getByText("Operator Stop", { exact: true }).count(),
        0,
      );
      await captureBrowserEvidence(
        page,
        `task-execution-held-after-resume-${engine.name}`,
      );
    },
  );

  test(
    `recovery links to the exact assignment facts and task execution (${engine.name})`,
    { browserEngine: engine.name },
    async (_t, j) => {
      const f = await j.start("fixture.create", () =>
        createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
      );
      let browser: Browser | undefined;
      j.cleanup(
        (primary) => f.close(browser, primary),
        "fixture.close",
        () => f.lifecycle.steps,
      );
      const a = await seedReviewTask(f, "Recovery link project", "Link task");
      const d = f.service.domain(),
        sibling = randomUUID(),
        foreignTask = randomUUID(),
        foreignAssignment = randomUUID();
      d.execute({
        type: "assignment.create",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        taskId: a.taskId,
        assignmentId: sibling,
        profileId: a.profileId,
        brief: "Sibling",
        resultDestination: "lead",
        requesterAssignmentId: null,
      });
      seedOperatorRecovery(f, {
        projectId: a.projectId,
        taskId: a.taskId,
        assignmentId: a.assignmentId,
      });
      d.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        taskId: foreignTask,
        title: "Other task",
        outcome: "Done",
        ready: false,
      });
      d.execute({
        type: "assignment.create",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        taskId: foreignTask,
        assignmentId: foreignAssignment,
        profileId: a.profileId,
        brief: "Other task work",
        resultDestination: "lead",
        requesterAssignmentId: null,
      });
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: a.projectId,
        expectedVersion: Number(d.project(a.projectId).version),
        instructions: "Updated instructions",
      });
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start(`browser.launch.${engine.name}`, () =>
        engine.type.launch(),
      );
      const page = await browser.newPage({
        viewport: { width: 1366, height: 900 },
      });
      j.observe(page);
      page.setDefaultTimeout(5000);
      const commands: unknown[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
          commands.push(r.postDataJSON());
      });
      const recovery = `/app/assignments/${a.assignmentId}/recovery`;
      await signIn(page, web.origin, web.password, recovery);
      const inspect = page.getByRole("link", {
        name: "Inspect assignment to apply current instructions",
      });
      await inspect.waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: /Apply current instructions/ })
          .count(),
        0,
      );
      await inspect.focus();
      await page.keyboard.press("Enter");
      const target = page.locator(
        `[data-record-id="assignment:${a.assignmentId}"]`,
      );
      const facts = target.locator("details.assignment-facts");
      await facts
        .getByRole("button", { name: /Apply current instructions/ })
        .waitFor();
      assert.ok((await facts.boundingBox())!.width >= 200);
      assert.equal(await facts.getAttribute("open"), "");
      assert.equal(
        await page
          .locator(
            `[data-record-id="assignment:${sibling}"] details.assignment-facts`,
          )
          .getAttribute("open"),
        null,
      );
      await facts.locator(":scope > summary").focus();
      for (let n = 0; n < 20; n++) {
        if (
          await facts
            .getByRole("button", { name: /Apply current instructions/ })
            .evaluate((element) => element === document.activeElement)
        )
          break;
        await page.keyboard.press(engine.name === "webkit" ? "Alt+Tab" : "Tab");
      }
      assert.equal(
        await facts
          .getByRole("button", { name: /Apply current instructions/ })
          .evaluate((element) => element === document.activeElement),
        true,
      );
      assert.deepEqual(commands, []);
      await Promise.all([
        facts.evaluate(
          (element) =>
            new Promise<void>((resolve) =>
              element.addEventListener("toggle", () => resolve(), {
                once: true,
              }),
            ),
        ),
        facts.locator(":scope > summary").click(),
      ]);
      await page.goBack();
      await inspect.waitFor();
      await page.goForward();
      await page.locator("#assignments").waitFor();
      assert.equal(await facts.getAttribute("open"), null);
      assert.deepEqual(commands, []);

      await page.goto(
        `${web.origin}/app/tasks/${a.taskId}?section=assignments`,
      );
      await page.locator("#assignments").waitFor();
      assert.equal(
        await page
          .getByText("The linked assignment is unavailable in this task.")
          .count(),
        0,
      );
      assert.equal(
        await page.locator("details.assignment-facts[open]").count(),
        0,
      );
      for (const id of ["", foreignAssignment]) {
        await page.goto(
          `${web.origin}/app/tasks/${a.taskId}?section=assignments&inspectAssignment=${id}`,
        );
        await page
          .getByText("The linked assignment is unavailable in this task.")
          .waitFor();
        assert.equal(
          await page.locator("details.assignment-facts[open]").count(),
          0,
        );
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(web.origin + recovery);
      await inspect.click();
      await facts
        .getByRole("button", { name: /Apply current instructions/ })
        .waitFor();
      assert.equal(
        await page.locator("details.inspector-fold").getAttribute("open"),
        "",
      );
      assert.ok(await noHorizontalScroll(page));
      await page.goto(web.origin + recovery);
      await page
        .getByRole("link", { name: "View task-wide execution evidence" })
        .click();
      await page
        .getByRole("tab", { name: "Execution", selected: true })
        .waitFor();
      assert.deepEqual(commands, []);
    },
  );
}
