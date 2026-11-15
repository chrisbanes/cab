import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { configure, until } from "../fixtures/completed-lead.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { stubReadiness } from "../fixtures/setup-browser.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";

const test = browserSuite("ui-task-allowance");

test("the exhausted allowance opens from the Inbox, and a set total updates the section or keeps its draft on conflict", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const api = new OperatorApi(f.service, [f.directory]);
  const { projectId, taskId } = await seedReviewTask(f, "Allowance project");
  const setAllowance = (total: number | null) =>
    api.execute({
      type: "task.allowance.set",
      key: randomUUID(),
      taskId,
      expectedAllowanceVersion: f.service.taskAllowance(taskId).version,
      total,
    });
  // A zero total holds the lead's first turn.
  await setAllowance(0);
  configure(f, projectId, false);
  const d = f.service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    expectedVersion: Number(d.task(taskId).version),
    ready: true,
  });
  await until(
    () => f.service.taskAllowance(taskId).heldWorkIds.length === 1,
    "the first turn is held by the allowance",
  );
  const item = (await api.readInbox()).data.items.find(
    (i) =>
      i.kind === "intervention" &&
      i.taskId === taskId &&
      i.attentionCode === "allowance-exhausted",
  );
  assert.ok(item, "an exhausted allowance raises an intervention");

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  await stubReadiness(page);
  page.setDefaultTimeout(5000);
  const commands: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (request.method() === "POST" && body.includes('"task.allowance.set"'))
      commands.push(JSON.parse(body));
  });
  await page.goto(
    `${web.origin}/inbox?task=${taskId}&request=${encodeURIComponent(item.id)}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // The Inbox action opens the Execution tab at the allowance section.
  await page
    .getByRole("link", { name: "Set execution allowance", exact: true })
    .first()
    .click();
  await page.waitForURL(/section=execution-allowance/);
  const section = page.locator("#execution-allowance");
  await section.waitFor();
  assert.ok(await section.isVisible());
  const summary = section.locator("[data-allowance-summary]");
  assert.match(
    await summary.innerText(),
    /^0 of 0 charged, 0 remaining; new turns are held, admitted work may continue$/,
  );
  await section
    .getByText(/Direct work and project drafting runs are not charged/)
    .waitFor();

  // Entering a total and submitting sends the read allowance version and updates the section.
  const total = section.getByLabel("Total", { exact: true });
  await total.fill("2");
  await section.getByRole("button", { name: "Set total" }).click();
  await section.getByText("Allowance set.").waitFor();
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.total, 2);
  assert.equal(commands[0]?.expectedAllowanceVersion, 1);
  await page.waitForFunction(() =>
    document
      .querySelector("#execution-allowance [data-allowance-summary]")
      ?.textContent?.includes("of 2 charged"),
  );
  assert.equal(await total.inputValue(), "", "a recorded total clears");

  // Another change lands behind the page: the stale send conflicts, keeps the draft and
  // moves focus into the conflict message (its review action).
  await setAllowance(5);
  await total.fill("7");
  await section.getByRole("button", { name: "Set total" }).click();
  const conflict = section.getByText(
    "Not changed: the allowance changed since it was read.",
  );
  await conflict.waitFor();
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.expectedAllowanceVersion, 2);
  assert.equal(await total.inputValue(), "7", "the typed total is kept");
  assert.ok(
    await page.evaluate(() =>
      Boolean(
        document.activeElement
          ?.closest("#execution-allowance [role=alert]")
          ?.textContent?.includes("the allowance changed since it was read"),
      ),
    ),
    "focus moves to the conflict",
  );
  assert.equal(f.service.taskAllowance(taskId).total, 5, "nothing changed");
});
