import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { until } from "./fixtures/operator-work.js";
import {
  ControllablePowerEvents,
  supervisedPower,
} from "./fixtures/power-events.js";

const test = browserSuite("ui-composer-layout");

/** A project whose lead has private instructions, plus two dependency candidates. */
function seed(f: Awaited<ReturnType<typeof createOperatorFixture>>) {
  const d = f.service.domain(),
    projectId = randomUUID(),
    leadId = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: leadId,
    name: "Mira",
    instructions: "PRIVATE COMPOSER INSTRUCTIONS",
    capabilities: "code",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Atlas",
    leadProfileId: leadId,
  });
  for (const title of ["Command menu task", "Release note task"])
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId: randomUUID(),
      title,
      outcome: "Finish",
      ready: false,
    });
  return { projectId, leadId };
}

async function open(
  page: Page,
  origin: string,
  password: string,
  projectId: string,
) {
  await page.goto(`${origin}/app/tasks/new?project=${projectId}`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  await page.getByLabel("Command menu task").waitFor({ state: "attached" });
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("Composer shows the inherited panel, one Optional settings row and fixed actions", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { projectId, leadId } = seed(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  let commands = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === "/api/operator/commands"
    )
      commands++;
  });
  await open(page, web.origin, web.password, projectId);

  // (a) Heading, subtitle and the inherited panel to the right; no private instructions.
  assert.equal(
    await page.locator("main.page h1").textContent(),
    "Create a task",
  );
  await page
    .getByText(
      "Describe the result you want. The project lead stays accountable.",
    )
    .waitFor();
  const panel = page.getByRole("complementary", {
    name: "Inherited from Atlas",
  });
  await panel.getByText("Mira", { exact: true }).waitFor();
  await panel.getByText(/^Capacity: \d+\/\d+ project/).waitFor();
  await panel.getByText("Created ≠ running").waitFor();
  assert.equal(
    await panel
      .getByRole("link", { name: "View project instructions" })
      .getAttribute("href"),
    `/app/projects/${projectId}/settings`,
  );
  const panelBox = (await panel.boundingBox())!,
    titleBox = (await page.getByLabel("Task title").boundingBox())!;
  assert.ok(panelBox.x >= titleBox.x + titleBox.width, "panel is to the right");
  assert.ok(
    !(await page.locator("body").innerText()).includes(
      "PRIVATE COMPOSER INSTRUCTIONS",
    ),
  );

  // (b) One closed Optional settings row; supplied values summarise and are retained.
  const details = page.locator("details.composer-disclosure");
  assert.equal(await details.count(), 1);
  const summary = details.locator("summary");
  assert.equal(
    await summary.textContent(),
    "Optional settings · none supplied",
  );
  assert.equal(
    await details.evaluate((d) => (d as HTMLDetailsElement).open),
    false,
  );
  await page.getByLabel("Task title").fill("Publish a keyboard guide");
  await page.getByLabel("Desired outcome").fill("Publish the guide.");
  await summary.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Optional context").fill("final key bindings");
  await page.getByLabel("Reference links").fill("https://example.com/notes");
  await page.getByLabel("Assignee").selectOption(leadId);
  await page.getByLabel("Command menu task", { exact: true }).check();
  await summary.focus();
  await page.keyboard.press("Space");
  await page.getByText("Optional settings · 4 supplied").waitFor();
  await page
    .getByText("Assignee: Mira (permitted) · Depends on: Command menu task")
    .waitFor();
  await page.getByText(/^Unfinished input saved on this device$/).waitFor();
  await summary.click();
  assert.equal(
    await page.getByLabel("Optional context").inputValue(),
    "final key bindings",
  );
  assert.ok(
    await page.getByLabel("Command menu task", { exact: true }).isChecked(),
  );

  // (c) An invalid link: no command, the error count, the section opens on the field.
  await page.getByLabel("Reference links").fill("not a link");
  await summary.click();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "composer-links",
  );
  assert.equal(await summary.textContent(), "Optional settings · 1 error");
  assert.equal(commands, 0);
  await page.getByLabel("Reference links").fill("https://example.com/notes");
  await summary.click();
  await page.getByText("Optional settings · 4 supplied").waitFor();

  // (d) A long outcome keeps the actions in view, without covering the last field.
  await page.getByLabel("Desired outcome").fill("Long outcome. ".repeat(640));
  const actions = page.locator(".composer-actions");
  for (const y of [0, 1e6]) {
    await page.evaluate((y) => scrollTo(0, y), y);
    for (const name of ["Create and start", "Save draft"]) {
      const b = (await page
        .getByRole("button", { name, exact: true })
        .boundingBox())!;
      assert.ok(b.y >= 0 && b.y + b.height <= 820, `${name} at ${y}`);
    }
  }
  const last = (await page.locator(".composer-optional-values").boundingBox())!,
    bar = (await actions.boundingBox())!;
  assert.ok(last.y + last.height <= bar.y, "actions do not cover the summary");
  await page.getByLabel("Desired outcome").fill("Publish the guide.");
  await page.evaluate(() => scrollTo(0, 0));
  await captureBrowserEvidence(page, "composer-desktop", { fullPage: false });

  // (f) Phone: collapsed with values (34), collapsed with an error (35b), expanded (35).
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await noHorizontalScroll(page));
  for (const name of ["Create and start", "Save draft"]) {
    const b = (await page
      .getByRole("button", { name, exact: true })
      .boundingBox())!;
    assert.ok(b.height >= 44 && b.width >= 390 - 40 - 1, `${name} ${b.width}`);
  }
  assert.ok(
    await actions.evaluate((e) =>
      getComputedStyle(e).paddingBottom.includes("px"),
    ),
  );
  await captureBrowserEvidence(page, "composer-phone-34");
  await summary.click();
  await page.getByLabel("Reference links").fill("not a link");
  await summary.click();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "composer-links",
  );
  await summary.click();
  await page.getByText("Open settings to fix the link.").waitFor();
  await page
    .getByText(
      "Check the optional settings to continue. Your input is still here.",
    )
    .waitFor();
  assert.ok(await noHorizontalScroll(page));
  await captureBrowserEvidence(page, "composer-phone-35b");
  await summary.click();
  await page.locator("#composer-links").waitFor();
  assert.ok(await noHorizontalScroll(page));
  await captureBrowserEvidence(page, "composer-phone-35");
  assert.equal(commands, 0);

  // (e) Discarding removes the on-device claim.
  await page.reload();
  await page
    .getByRole("button", { name: "Discard unfinished input", exact: true })
    .click();
  await page.locator("main.page h1").waitFor();
  assert.equal(
    await page.getByText("Unfinished input saved on this device").count(),
    0,
  );
});

test("Composer never claims on-device saving when storage fails", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { projectId } = seed(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "ensemble.ui03.composer.v1") throw Error("quota");
      setItem.call(this, key, value);
    };
  });
  await open(page, web.origin, web.password, projectId);
  await page.getByLabel("Task title").fill("Unsaved");
  await page.getByText(/^Couldn't keep your edits on this device/).waitFor();
  assert.equal(
    await page.getByText("Unfinished input saved on this device").count(),
    0,
  );
});

test("Composer predicts start or wait before submission from the same waits", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { projectId } = seed(f);
  const d = f.service.domain();
  const configure = (paused: boolean) =>
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      paused,
    });
  configure(false);
  // A permitted Claude assignee whose runtime the service can't use.
  const claude = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: claude,
    name: "Claude worker",
    instructions: "build",
    capabilities: "code",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [claude],
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  let commands = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === "/api/operator/commands"
    )
      commands++;
  });
  await open(page, web.origin, web.password, projectId);
  const prediction = page.locator(".composer-prediction");
  await prediction.getByText("Starts now.", { exact: true }).waitFor();

  // A not-done dependency makes it wait; removing it restores the start.
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Command menu task").check();
  await prediction
    .getByText("It will wait: Blocked by a task dependency", { exact: true })
    .waitFor();
  await prediction.getByRole("link", { name: "Command menu task" }).waitFor();
  await page.getByLabel("Command menu task").uncheck();
  await prediction.getByText("Starts now.", { exact: true }).waitFor();

  // An explicit assignee runs the turn, so its runtime waits replace the lead's.
  await page.getByLabel("Assignee").selectOption(claude);
  await prediction
    .getByText("It will wait: Claude token unavailable", { exact: true })
    .waitFor();
  await page.getByLabel("Assignee").selectOption("");
  await prediction.getByText("Starts now.", { exact: true }).waitFor();

  // A paused project leads with its Fix; the dependency is listed beneath it.
  configure(true);
  await page.reload();
  // The selections kept in this tab come back first.
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  await prediction
    .getByText("It will wait: Project paused", { exact: true })
    .waitFor();
  await prediction
    .getByRole("button", { name: "Fix: Resume project" })
    .waitFor();
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Command menu task").check();
  assert.deepEqual(
    await prediction
      .locator(".wait-list li > span:first-child")
      .allInnerTexts(),
    ["Blocked by a task dependency"],
  );
  assert.equal(commands, 0);
  // Save draft is unchanged by the prediction.
  await page.getByLabel("Task title").fill("Predicted draft");
  await page.getByLabel("Desired outcome").fill("Probe");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByText("Draft saved.", { exact: true }).waitFor();
  assert.equal(commands, 1);
});

test("Composer, post-create line and task detail show a power-supervision hold", async (_t, j) => {
  const events = new ControllablePowerEvents();
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      undefined,
      j.fixtureOptions,
      undefined,
      { power: supervisedPower(events) },
    ),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { projectId } = seed(f);
  const d = f.service.domain();
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(d.project(projectId).version),
    paused: false,
  });
  await until(() => f.service.powerStatus()?.admissionHeld === true);
  const reason = "Power-event history is incomplete or ambiguous";
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await open(page, web.origin, web.password, projectId);

  // The healthy project does not start now: the hold and its reason, with no Fix.
  const prediction = page.locator(".composer-prediction");
  await prediction
    .getByText("It will wait: Held by power supervision", { exact: true })
    .waitFor();
  await prediction.getByText(reason, { exact: true }).waitFor();
  assert.equal(await prediction.getByText("Starts now.").count(), 0);
  assert.equal(await prediction.getByText(/^Fix:/).count(), 0);

  // The post-create line shows the same hold.
  await page.getByLabel("Task title").fill("Held by power");
  await page.getByLabel("Desired outcome").fill("Probe");
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.getByText("Task created.", { exact: true }).waitFor();
  const created = page.locator(".wait-reasons");
  await created
    .getByText("It will wait: Held by power supervision", { exact: true })
    .waitFor();
  await created.getByText(reason, { exact: true }).waitFor();

  // Task detail lists it as the primary wait, again with no Fix.
  await page.getByRole("link", { name: "Open task", exact: true }).click();
  const waits = page.locator(".wait-reasons");
  await waits
    .getByText("Waiting · Held by power supervision", { exact: true })
    .waitFor();
  await waits.getByText(reason, { exact: true }).waitFor();
  assert.equal(await waits.getByText(/^Fix:/).count(), 0);

  // Once the hold releases the composer predicts a start again.
  events.complete = true;
  await until(() => f.service.powerStatus()?.admissionHeld === false);
  await page.goto(`${web.origin}/app/tasks/new?project=${projectId}`);
  await page
    .locator(".composer-prediction")
    .getByText("Starts now.", { exact: true })
    .waitFor();
  assert.equal(await page.getByText(reason).count(), 0);
});
