import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
  webkit,
} from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  inFirstViewport,
  noPageOverflow,
  phone,
  startSettings,
} from "../fixtures/operator-settings.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/operator-work.js";
import {
  ControllablePowerEvents,
  supervisedPower,
} from "../fixtures/power-events.js";

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

const savedOnDevice =
  "Unfinished input saved on this device · not yet an Ensemble draft";

const box = async (page: Page, label: string) =>
  (await page.getByLabel(label, { exact: true }).boundingBox())!;

test("Composer shows the inherited panel, one Optional settings panel and the sticky bar", async (_t, j) => {
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
    viewport: { width: 1366, height: 900 },
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
  assert.equal(await page.getByText(/Unfinished input saved/).count(), 0);

  // (a) Heading, subtitle and the panels to the right; no private instructions.
  assert.equal(await page.locator("main.page h1").innerText(), "Create a task");
  await page
    .getByText(
      "Describe the result you want. The project lead stays accountable.",
    )
    .waitFor();
  const aside = page.getByRole("complementary", { name: "Before you create" });
  const panel = aside.getByRole("region", { name: "Inherited from Atlas" });
  await panel.getByText("Mira", { exact: true }).waitFor();
  await panel.getByText(/^Capacity: \d+\/\d+ project/).waitFor();
  // The caveat is part of a Will wait verdict only.
  const verdictPanel = aside.getByRole("region", {
    name: "If you create it now",
  });
  await verdictPanel.getByText(/^(Will wait|Starts now)$/).waitFor();
  assert.equal(
    await verdictPanel.getByText(/^Created ≠ running\./).count(),
    await verdictPanel.getByText("Will wait", { exact: true }).count(),
  );
  assert.equal(await page.getByText(/16,000-character brief limit/).count(), 0);
  assert.equal(
    await panel
      .getByRole("link", { name: "View project instructions" })
      .getAttribute("href"),
    `/app/projects/${projectId}/settings`,
  );
  const asideBox = (await aside.boundingBox())!,
    outcomeBox = await box(page, "Desired outcome");
  assert.ok(
    asideBox.x >= outcomeBox.x + outcomeBox.width,
    "panels are to the right",
  );
  assert.equal(
    (await page.locator("body").innerText()).match(/attach/i),
    null,
    "no attachment hint",
  );
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
  const chips = page.locator("ul.composer-optional-chips li");
  await chips.first().waitFor();
  assert.deepEqual(await chips.allInnerTexts(), [
    "Context · final key bindings",
    "Reference · https://example.com/notes",
    "Assignee · Mira (permitted)",
    "Depends on · Command menu task",
  ]);
  assert.equal(await summary.textContent(), "Optional settings · 4 supplied");
  const actions = page.locator(".composer-actions");
  await actions.getByText(savedOnDevice, { exact: true }).waitFor();
  assert.deepEqual(await actions.getByRole("button").allInnerTexts(), [
    "Create and start",
    "Save draft",
  ]);
  await summary.click();
  await chips.first().waitFor({ state: "detached" }); // no chips while open
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
  await summary.click();
  await chips.first().waitFor();
  assert.deepEqual(
    await chips.evaluateAll((li) =>
      li.map((e) => e.getAttribute("data-invalid")),
    ),
    [null, "true", null, null],
  );
  await summary.click();
  await page.getByLabel("Reference links").fill("https://example.com/notes");
  await summary.click();
  await page.getByText("Optional settings · 4 supplied").waitFor();

  // (d) A long outcome keeps the actions in view, without covering the last field.
  await page.getByLabel("Desired outcome").fill("Long outcome. ".repeat(640));
  for (const y of [0, 1e6]) {
    await page.evaluate((y) => scrollTo(0, y), y);
    for (const name of ["Create and start", "Save draft"]) {
      const b = (await page
        .getByRole("button", { name, exact: true })
        .boundingBox())!;
      assert.ok(b.y >= 0 && b.y + b.height <= 900, `${name} at ${y}`);
    }
  }
  const last = (await page.locator(".composer-optional").boundingBox())!,
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
  assert.deepEqual(
    await actions.evaluate((e) => [
      getComputedStyle(e).position,
      getComputedStyle(e).paddingBottom.endsWith("px"),
    ]),
    ["sticky", true],
  );
  // Status, then the hint (never the verdict), then the stacked buttons.
  assert.deepEqual((await actions.innerText()).split(/\n+/).slice(0, 2), [
    savedOnDevice,
    "Save draft keeps it without starting.",
  ]);
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
  assert.equal(
    await chips.nth(1).getAttribute("data-invalid"),
    "true",
    "the Reference chip is marked",
  );
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
  assert.equal(await page.getByText(/Unfinished input saved/).count(), 0);
});

test("phone composer header is Back and a centred New task with no Refresh or wrapped subtitle", async (_t, j) => {
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
  const header = page.locator("header.page-header"),
    subtitle =
      "Describe the result you want. The project lead stays accountable.";
  const rect = (l: Locator) =>
    l.evaluate((e) => e.getBoundingClientRect().toJSON());
  const check = async (back: string, height: number) => {
    await page.setViewportSize({ width: 390, height });
    await page.evaluate(() => document.fonts.ready);
    const title = header.locator("h1");
    assert.equal(await title.innerText(), "New task");
    assert.equal(
      await header.getByRole("link", { name: back, exact: true }).count(),
      1,
    );
    const t = await rect(title);
    assert.ok(
      Math.abs((t.left + t.right) / 2 - 195) <= 8,
      `title centre ${(t.left + t.right) / 2}`,
    );
    assert.equal(
      await header.locator(".page-header-title p").isVisible(),
      false,
    );
    assert.equal(await page.getByText(subtitle).isVisible(), false);
    assert.equal(
      await page.getByRole("button", { name: "Refresh" }).count(),
      0,
    );
    assert.ok((await rect(header)).height <= 56);
    assert.ok(await noHorizontalScroll(page));
  };

  // (1) With ?project=, at the full phone and a short one.
  await check("Back to Atlas", 844);
  assert.ok(
    (await box(page, "Project")).y + (await box(page, "Project")).height <= 844,
  );
  await check("Back to Atlas", 480);

  // (2) Without ?project= Back names Tasks.
  await page.goto(`${web.origin}/app/tasks/new`);
  await page.locator("main.page h1").waitFor();
  await check("Back to Tasks", 844);
  assert.ok(
    (await box(page, "Project")).y + (await box(page, "Project")).height <= 844,
  );

  // (3) Tablet and desktop keep the full title and subtitle.
  for (const width of [760, 1024, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await header.locator("h1").innerText(), "Create a task");
    await page.getByText(subtitle).waitFor();
  }

  // (4) Other detail headers are unchanged.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web.origin}/app/settings/projects/new`);
  await header.locator("h1").waitFor();
  assert.equal(await header.getAttribute("data-compact-phone"), null);
  assert.equal(await header.locator(".page-header-title p").isVisible(), true);
  assert.equal(commands, 0);
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
  const hint = page.locator(".composer-actions-end > p");
  // The verdict is stated once, in the panel; the caveat goes with Will wait.
  const verdict = async (text: "Starts now" | "Will wait") => {
    await prediction.getByText(text, { exact: true }).waitFor();
    assert.equal(
      await prediction.getByText(/^Created ≠ running\./).count(),
      text === "Will wait" ? 1 : 0,
      `caveat after ${text}`,
    );
    assert.equal(
      await hint.innerText(),
      "Save draft keeps it without starting.",
    );
    const bar = await page.locator(".composer-actions").innerText();
    assert.ok(!/Starts now|Will wait/.test(bar), bar);
  };
  const reasons = prediction.locator("ol.wait-numbered > li");
  const labels = () => reasons.locator(".wait-label").allTextContents();
  await verdict("Starts now");

  // A not-done dependency makes it wait; removing it restores the start.
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Command menu task").check();
  await verdict("Will wait");
  assert.deepEqual(await labels(), ["Blocked by a task dependency"]);
  await reasons
    .first()
    .getByRole("link", { name: "Command menu task" })
    .waitFor();
  await page.getByLabel("Command menu task").uncheck();
  await verdict("Starts now");

  // An explicit assignee runs the turn, so its runtime waits replace the lead's.
  await page.getByLabel("Assignee").selectOption(claude);
  await verdict("Will wait");
  assert.equal((await labels())[0], "Claude token unavailable");
  await page.getByLabel("Assignee").selectOption("");
  await verdict("Starts now");

  // A paused project leads with its Fix; the dependency is numbered after it.
  configure(true);
  await page.reload();
  // The selections kept in this tab come back first.
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  await verdict("Will wait");
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Command menu task").check();
  await reasons.nth(1).waitFor();
  assert.deepEqual(await reasons.locator(".wait-index").allTextContents(), [
    "1",
    "2",
  ]);
  assert.deepEqual(await labels(), [
    "Project paused",
    "Blocked by a task dependency",
  ]);
  assert.equal(await reasons.first().getAttribute("data-primary"), "true");
  const fix = reasons
    .first()
    .getByRole("button", { name: "Fix: Resume project" });
  await reasons
    .nth(1)
    .getByRole("link", { name: "Command menu task" })
    .waitFor();
  // The bar's Create and start is the one primary action in view.
  const background = (l: Locator) =>
    l.evaluate((e) => getComputedStyle(e).backgroundColor);
  const create = page.getByRole("button", { name: "Create and start" });
  assert.equal(await background(create), "rgb(79, 70, 229)");
  assert.notEqual(
    await background(fix),
    "rgb(79, 70, 229)",
    "Fix is secondary",
  );
  assert.equal(commands, 0);
  // Clearing the last wait with its Fix leaves the numbered list mounted but drops the caveat.
  await page.getByLabel("Command menu task").uncheck();
  await verdict("Will wait");
  await fix.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await verdict("Starts now");
  assert.equal(await reasons.count(), 0);
  await page.getByLabel("Command menu task").check();
  await verdict("Will wait");
  await reasons.first().waitFor();
  assert.equal(
    await labels().then((l) => l[0]),
    "Blocked by a task dependency",
  );
  const afterFix = commands;
  // Save draft is unchanged by the prediction.
  await page.getByLabel("Task title").fill("Predicted draft");
  await page.getByLabel("Desired outcome").fill("Probe");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByText("Draft saved.", { exact: true }).waitFor();
  assert.equal(commands, afterFix + 1);
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
  // A permitted, healthy assignee: choosing it replaces only runtime waits.
  const worker = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: worker,
    name: "Healthy worker",
    instructions: "build",
    capabilities: "code",
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [worker],
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
  const held = async () => {
    await prediction.getByText("Will wait", { exact: true }).waitFor();
    assert.deepEqual(
      await prediction.locator(".wait-label").allTextContents(),
      ["Held by power supervision"],
    );
    await prediction.getByText(reason, { exact: true }).waitFor();
    assert.equal(await prediction.getByText("Starts now").count(), 0);
  };
  await held();
  assert.equal(await prediction.getByText(/^Fix:/).count(), 0);
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Assignee").selectOption(worker);
  await held();
  await page.getByLabel("Assignee").selectOption("");

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
    .getByText("Starts now", { exact: true })
    .waitFor();
  assert.equal(await page.getByText(reason).count(), 0);
});

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const)
  test(
    `Composer leads with Project and Title and stacks the panels on a ${engineName} phone`,
    { browserEngine: engineName },
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
      const { projectId } = seed(f);
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start("browser.launch", () => engine.launch());
      const page = await browser.newPage({
        viewport: { width: 1366, height: 900 },
      });
      j.observe(page);
      page.setDefaultTimeout(5000);
      await open(page, web.origin, web.password, projectId);
      const prediction = page.getByRole("region", {
        name: "If you create it now",
      });
      await prediction.waitFor();

      // Desktop: Project beside Title, and the panels level with that row.
      let project = await box(page, "Project"),
        title = await box(page, "Task title");
      assert.ok(title.x >= project.x + project.width, "title beside project");
      assert.ok(Math.abs(title.y - project.y) <= 4, "one row");
      const panel = (await prediction.boundingBox())!;
      assert.ok(panel.x >= title.x + title.width, "panel to the right");
      assert.ok(panel.y <= project.y, "panel top level with the row");

      // The disclosure still toggles by keyboard.
      const details = page.locator("details.composer-disclosure");
      await details.locator("summary").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector("details")?.open === true,
      );
      await page.keyboard.press("Space");
      await page.waitForFunction(
        () => document.querySelector("details")?.open === false,
      );

      // Phone: stacked fields, then the panels after Optional settings.
      await page.setViewportSize({ width: 390, height: 844 });
      project = await box(page, "Project");
      title = await box(page, "Task title");
      assert.ok(title.y >= project.y + project.height, "title below project");
      await prediction.scrollIntoViewIfNeeded();
      const stacked = (await prediction.boundingBox())!;
      assert.ok(stacked.y >= 0 && stacked.y < 844, "reachable by scrolling");
      assert.ok(
        await prediction.evaluate(
          (e) =>
            e.getBoundingClientRect().top >=
            document
              .querySelector(".composer-optional")!
              .getBoundingClientRect().bottom,
        ),
        "panels follow Optional settings",
      );
      assert.ok(
        stacked.x >= 0 && stacked.x + stacked.width <= 390,
        "not clipped",
      );
      assert.ok(await noHorizontalScroll(page));
    },
  );

test("Composer bar keeps drafts, refused creation and admission distinct", async (_t, j) => {
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
  if (!d.project(projectId).paused)
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: Number(d.project(projectId).version),
      paused: true,
    });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const sent: { type: string; ready?: boolean }[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === "/api/operator/commands"
    )
      sent.push(r.postDataJSON());
  });
  await open(page, web.origin, web.password, projectId);
  const fill = async (title: string) => {
    await page.getByLabel("Task title").fill(title);
    await page.getByLabel("Desired outcome").fill("Probe");
  };
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await fill("Refused");
  const prediction = page.locator(".composer-prediction");
  await prediction.getByText("Will wait", { exact: true }).waitFor();
  await prediction.getByText(/^Created ≠ running\./).waitFor();
  assert.equal(
    await page.locator(".composer-actions-end > p").innerText(),
    "Save draft keeps it without starting.",
  );

  // A refused create keeps the input and both actions, above the bar.
  await page.route("**/api/operator/commands", (route) =>
    route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "invalid-input", message: "Safe failure" },
      }),
    }),
  );
  await button("Create and start").click();
  const refused = page.getByText(/^Couldn't create the task/);
  await refused.waitFor();
  await page.unroute("**/api/operator/commands");
  assert.equal(await page.getByLabel("Task title").inputValue(), "Refused");
  assert.ok(await button("Create and start").isEnabled());
  assert.ok(await button("Save draft").isEnabled());
  assert.ok(
    await refused.evaluate(
      (e) =>
        (e.compareDocumentPosition(
          document.querySelector(".composer-actions")!,
        ) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    ),
    "the outcome sits above the bar",
  );

  // Save draft sends a draft; Create and start sends ready work.
  await button("Save draft").click();
  await page.getByText("Draft saved.", { exact: true }).waitFor();
  await page.goto(`${web.origin}/app/tasks/new?project=${projectId}`);
  await fill("Created");
  await button("Create and start").click();
  const created = page.getByText("Task created.", { exact: true });
  await created.waitFor();
  const waiting = page
    .locator(".wait-reasons")
    .getByText("It will wait: Project paused", { exact: true });
  await waiting.waitFor();
  assert.ok(
    !(await created.evaluate(
      (e, w) => e.contains(w),
      await waiting.elementHandle(),
    )),
    "creation and admission are separate lines",
  );
  assert.deepEqual(
    sent.map((c) => [c.type, c.ready]),
    [
      ["task.create", true],
      ["task.create", false],
      ["task.create", true],
    ],
  );
});

test("Composer keeps the caveat and bar honest across project switches and failed options", async (_t, j) => {
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
  const d = f.service.domain();
  const second = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId: second,
    name: "Borealis",
    leadProfileId: leadId,
  });
  const configure = (id: string, paused: boolean) =>
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: id,
      expectedVersion: Number(d.project(id).version),
      paused,
    });
  configure(projectId, true);
  configure(second, false);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await open(page, web.origin, web.password, projectId);
  const prediction = page.locator(".composer-prediction");
  const hint = page.locator(".composer-actions-end > p");
  const saveDraftHint = "Save draft keeps it without starting.";
  const caveat = page.getByText(/^Created ≠ running\./);
  await prediction.getByText("Will wait", { exact: true }).waitFor();
  assert.equal(await caveat.count(), 1);
  assert.equal(await hint.innerText(), saveDraftHint);

  // Switching project: while the new options load nothing of the old verdict remains.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/projects/${second}/composer-options`, async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByLabel("Project", { exact: true }).selectOption(second);
  await hint.waitFor();
  assert.equal(await hint.innerText(), saveDraftHint);
  assert.equal(await prediction.count(), 0);
  assert.equal(await caveat.count(), 0);
  assert.equal(await page.getByText("Will wait").count(), 0);
  release();
  await prediction.getByText("Starts now", { exact: true }).waitFor();
  assert.equal(await caveat.count(), 0);
  assert.equal(await hint.innerText(), saveDraftHint);

  // A failed options load leaves no verdict, caveat or fallback claim.
  await page.route(`**/projects/${projectId}/composer-options`, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal", message: "down" } }),
    }),
  );
  await page.getByLabel("Project", { exact: true }).selectOption(projectId);
  await page.getByText("Project options are unavailable. Try again.").waitFor();
  assert.equal(await prediction.count(), 0);
  assert.equal(await caveat.count(), 0);
  assert.equal(await hint.innerText(), saveDraftHint);
  await page.unroute(`**/projects/${projectId}/composer-options`);
});

test("Composer shows the brief-limit note only within 10% of the limit or over it", async (_t, j) => {
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
    viewport: { width: 1366, height: 900 },
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
  const note = page.getByText(/16,000-character brief limit/);
  const outcome = page.getByLabel("Desired outcome");
  assert.equal(await note.count(), 0);

  // Derived from the live outcome: below the threshold, at it, and back again.
  await outcome.fill("x".repeat(14399));
  assert.equal(await note.count(), 0);
  await outcome.fill("x".repeat(14400));
  await note.waitFor();
  await outcome.fill("Short outcome.");
  await note.waitFor({ state: "detached" });

  // Context counts while Optional settings is collapsed.
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Optional context").fill("c".repeat(400));
  await page.getByText(/^Optional settings/).click();
  assert.equal(
    await page
      .locator("details.composer-disclosure")
      .evaluate((e) => (e as HTMLDetailsElement).open),
    false,
  );
  await outcome.fill("x".repeat(14000));
  await note.waitFor();

  // Resume shows it on first render; Discard removes it.
  await page.getByLabel("Task title").fill("Long brief");
  await page.reload();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  await page.locator("main.page h1").waitFor();
  assert.equal(await note.count(), 1);
  await page.reload();
  await page
    .getByRole("button", { name: "Discard unfinished input", exact: true })
    .click();
  await page.locator("main.page h1").waitFor();
  assert.equal(await note.count(), 0);

  // Over the combined limit the note stays and nothing is posted.
  await page.getByLabel("Project", { exact: true }).selectOption(projectId);
  await page.getByLabel("Task title").fill("Too long");
  await outcome.fill("x".repeat(15000));
  await page.getByText(/^Optional settings/).click();
  await page.getByLabel("Optional context").fill("c".repeat(1001));
  await note.waitFor();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page
    .getByText(
      "Combined outcome, context and links must be at most 16,000 characters.",
    )
    .waitFor();
  assert.equal(await note.count(), 1);
  assert.equal(commands, 0);
});

// Getting started and Project setup open /app/tasks/new?project=<id>, the same shape as a
// project page; the top bar on a page without a project is the one entry that must pick it.
for (const [entry, path, scoped] of [
  ["a project page", "/app/projects/:atlas", true],
  ["the tasks overview", "/app", false],
] as const)
  for (const [label, viewport] of [
    ["1366 x 900", desktop],
    ["390 x 844", phone],
  ] as const)
    test(`create a task budget: three interactions from New task on ${entry} (${label})`, async (_t, journey) => {
      const { page, ids } = await startSettings(journey, path, viewport);
      let interactions = 0;
      await page
        .getByRole("link", { name: "New task", exact: true })
        .filter({ visible: true })
        .click();
      interactions++;
      const project = page.getByLabel("Project", { exact: true }),
        title = page.getByLabel("Task title", { exact: true }),
        outcome = page.getByLabel("Desired outcome", { exact: true }),
        verdict = page.getByRole("region", { name: "If you create it now" }),
        badge = verdict.getByText(/^(Will wait|Starts now)$/);
      await title.waitFor();
      // The form fill is one interaction, as in docs/user-flows/create-task.md, and
      // includes choosing the project when the entry point did not name one.
      if (!scoped) await project.selectOption(ids.atlas);
      assert.equal(await project.inputValue(), ids.atlas);
      await title.fill("Budget task");
      await outcome.fill("The budget task is created.");
      interactions++;
      await badge.waitFor();
      // Project, title, outcome and verdict together, once the fill and prediction settle.
      for (const target of [project, title, outcome, verdict, badge])
        assert.equal(
          await inFirstViewport(page, target),
          true,
          `the composer is in the first view ${JSON.stringify(await target.boundingBox())}`,
        );
      assert.equal(await page.evaluate(() => scrollY), 0, "nothing scrolled");
      await noPageOverflow(page);
      await page
        .getByRole("button", { name: "Create and start", exact: true })
        .click();
      interactions++;
      const created = page.getByRole("region", { name: "Task created" });
      await created.waitFor();
      const open = created.getByRole("link", { name: "Open task" });
      for (const target of [created, open])
        assert.equal(
          await inFirstViewport(page, target),
          true,
          `the result is in view ${JSON.stringify(await target.boundingBox())}`,
        );
      assert.equal(interactions, 3);
      await noPageOverflow(page);
    });
