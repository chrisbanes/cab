import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
const test = browserSuite("operator-task-browser");
import { chromium, type Browser, type Page } from "playwright";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  openMoreFilters,
  seedCatalog,
  until,
} from "../fixtures/operator-work.js";
async function screenshot(page: Page, name: string) {
  return captureBrowserEvidence(page, name);
}
// Optional composer sections start collapsed; their fields stay mounted.
async function expandComposer(page: Page) {
  const closed = page.locator(".composer-disclosure:not([open]) > summary");
  while ((await closed.count()) > 0) await closed.first().click();
}
async function signIn(
  page: Page,
  origin: string,
  password: string,
  // The seeded Draft, Done and Cancelled tasks are not Ready, so open with Any readiness.
  path = "/app/tasks?ready=any",
) {
  await page.goto(origin + path);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
}
test("List and Board preserve identical filtered task IDs and never submit commands", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Readable project",
    leadProfileId: null,
  });
  const ids = [randomUUID(), randomUUID()];
  for (const [i, taskId] of ids.entries())
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title: i ? "Other task" : "Literal <script>malicious()</script>",
      outcome: "Work",
      ready: false,
    });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password);
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts++;
  });
  await openMoreFilters(page);
  await page.getByLabel("Filter tasks").fill("Literal");
  const links = () =>
    page.locator("[data-task-id]").evaluateAll((els) =>
      els.map((e) => ({
        id: e.getAttribute("data-task-id"),
        href: e.querySelector("a")?.getAttribute("href"),
      })),
    );
  const list = await links();
  assert.deepEqual(list, [{ id: ids[0], href: `/app/tasks/${ids[0]}` }]);
  const rowGeometry = await page
    .locator(`[data-task-id="${ids[0]}"]`)
    .evaluate((el) => ({
      display: getComputedStyle(el).display,
      height: el.getBoundingClientRect().height,
    }));
  assert.equal(rowGeometry.display, "grid");
  assert.ok(
    rowGeometry.height <= 220,
    `desktop task row is ${rowGeometry.height}px`,
  );
  const taskTitleType = await page
    .locator(`[data-task-id="${ids[0]}"] .task-title`)
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        decoration: style.textDecorationLine,
      };
    });
  assert.deepEqual(taskTitleType, {
    fontSize: "14px",
    fontWeight: "500",
    decoration: "underline",
  });
  const beforeSwitch = await Promise.all(
    ["List", "Board"].map((name) =>
      page.getByRole("button", { name, exact: true }).evaluate((el) => ({
        pressed: el.getAttribute("aria-pressed"),
        background: getComputedStyle(el).backgroundColor,
      })),
    ),
  );
  assert.equal(beforeSwitch[0]?.pressed, "true");
  assert.equal(beforeSwitch[1]?.pressed, "false");
  assert.notEqual(beforeSwitch[0]?.background, beforeSwitch[1]?.background);
  // The column chips this journey drives exist only below the 1121px shell breakpoint.
  await page.setViewportSize({ width: 1120, height: 820 });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.deepEqual(await links(), list);
  assert.ok(page.url().includes("q=Literal"));
  await page.reload();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Filter tasks").inputValue(), "Literal");
  assert.deepEqual(await links(), list);
  await page.getByRole("button", { name: "Paused · 1", exact: true }).click();
  const boardScroll = await page
    .locator(".board-columns")
    .evaluate((el) => el.scrollLeft);
  await page.locator(`[data-task-id="${ids[0]}"] .task-title`).click();
  await page
    .getByRole("heading", { name: "Latest result", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Back to originating view", exact: true })
    .click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Paused · 1", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page.locator(".board-columns").evaluate((el) => el.scrollLeft),
    boardScroll,
  );
  assert.equal(
    await page
      .locator(`[data-task-id="${ids[0]}"] .task-title`)
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await screenshot(page, "1120-filtered-board");
  assert.equal(posts, 0);
});

test("a closure-held task reads Held and a project-paused task reads Paused, side by side", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain();
  f.service.githubSources(); // Creates the GitHub source tables the closure read needs.
  const project = (name: string, paused: boolean) => {
    const projectId = randomUUID(),
      taskId = randomUUID();
    d.execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      name,
      leadProfileId: null,
    });
    d.execute({
      type: "project.configure",
      key: randomUUID(),
      actor: "operator",
      projectId,
      expectedVersion: 1,
      paused,
    });
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId,
      title: `${name} task`,
      outcome: "Work",
      ready: false,
    });
    return { projectId, taskId };
  };
  const held = project("Held project", false),
    paused = project("Paused project", true);
  d.markImportedTask(held.taskId, "I_HELD", "R_HELD");
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO github_external_issues VALUES ('github.com','I_HELD',?,'R_HELD','owner/repo',7,'Closed upstream','Body','closed','[]')",
    ).run(held.taskId);
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password);
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  const facts = async (taskId: string) => ({
    state: await page
      .locator(`[data-task-id="${taskId}"] .task-state`)
      .innerText(),
    reasons: await page
      .locator(`[data-task-id="${taskId}"] .task-reason`)
      .allInnerTexts(),
  });
  // Both group in the Paused column; only the reason tells them apart.
  const closureHeld = await facts(held.taskId);
  assert.equal(closureHeld.state, "Paused");
  assert.equal(closureHeld.reasons[0], "Held · closed on GitHub");
  assert.ok(!closureHeld.reasons.includes("Project paused"));
  const projectPaused = await facts(paused.taskId);
  assert.equal(projectPaused.state, "Paused");
  assert.ok(projectPaused.reasons.includes("Project paused"));
  assert.ok(!projectPaused.reasons.some((r) => r.includes("Held")));
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.equal(
    await page
      .locator(`#column-Paused [data-task-id="${held.taskId}"] .task-reason`)
      .first()
      .innerText(),
    "Held · closed on GitHub",
  );
  assert.equal(
    await page
      .locator(`#column-Paused [data-task-id="${paused.taskId}"]`)
      .count(),
    1,
  );
  // The strip's readiness renders once the task read loads, so wait for it by text.
  const statusLine = async (taskId: string, text: RegExp) => {
    await page.goto(`${web.origin}/app/tasks/${taskId}`);
    const line = page
      .locator("[data-task-strip] [data-task-readiness]")
      .filter({ hasText: text });
    await line.waitFor();
    return line.innerText();
  };
  assert.equal(
    await statusLine(held.taskId, /^Held · closed on GitHub/),
    "Held · closed on GitHub",
  );
  assert.equal(
    await statusLine(paused.taskId, /^Draft · project paused/),
    "Draft · project paused",
  );
  assert.equal(await page.getByText("closed on GitHub").count(), 0);
});
test("Save draft and Create and start record real task outcomes without claiming running", async (_t, journey) => {
  let routeCalls = 0;
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      {
        async choose() {
          routeCalls++;
          throw Error("Explicit assignment must bypass routing");
        },
      },
      undefined,
      undefined,
      journey.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    workerId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Explicit lead",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Paused project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: workerId,
    name: "Permitted worker",
    instructions: "build",
    capabilities: "code",
  });
  d.execute({
    type: "routing.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    enabled: true,
    guidance: "choose",
    candidateProfileIds: [workerId],
    credentialRef: "env:FIXTURE_ROUTING_UNUSED",
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Open blocker",
    outcome: "Finish",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  await page.getByLabel("Task title").fill("Saved outcome");
  await page.getByLabel("Desired outcome").fill("Ship a useful result");
  await expandComposer(page);
  await page.getByLabel("Optional context").fill("Review supplied evidence");
  await page
    .getByLabel("Reference links")
    .fill("https://example.com/one\nhttps://example.com/two");
  await page.getByLabel("Assignee").selectOption(workerId);
  await page.getByLabel("Open blocker", { exact: true }).check();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByText("Draft saved.", { exact: true }).waitFor();
  // One quiet success line, with no receipt vocabulary anywhere on the page.
  assert.equal(await page.locator("[data-slot=action-outcome]").count(), 1);
  assert.doesNotMatch(
    await page.locator("main").innerText(),
    /receipt|submission|admission|observation/i,
  );
  const draft = d.tasks(projectId).find((t) => t.title === "Saved outcome");
  assert.ok(draft);
  assert.equal(draft.ready, 0);
  assert.equal(d.assignments(String(draft.id)).length, 1);
  assert.deepEqual(d.dependencies(String(draft.id)), [blocker]);
  assert.equal(f.runtime.turns, 0);
  assert.equal(
    draft.outcome,
    "Ship a useful result\n\nContext:\nReview supplied evidence\n\nReference links (passive context; no repository access):\nhttps://example.com/one\nhttps://example.com/two",
  );
  await screenshot(page, "1366-confirmed-draft");
  await page.goto(`${web.origin}/app/tasks/new?project=${projectId}`);
  await page.getByLabel("Task title").fill("Ready dependent");
  await page.getByLabel("Desired outcome").fill("Ship after blocker");
  await expandComposer(page);
  await page.getByLabel("Assignee").selectOption(workerId);
  await page.getByLabel("Open blocker", { exact: true }).check();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.getByText("Task created.", { exact: true }).waitFor();
  assert.equal(
    d.tasks(projectId).find((t) => t.title === "Ready dependent")?.ready,
    1,
  );
  assert.equal(f.runtime.turns, 0);
  await page
    .getByText("Blocked by a task dependency", { exact: true })
    .waitFor();
  await screenshot(page, "1366-confirmed-ready-held");
  const dependent = d
    .tasks(projectId)
    .find((t) => t.title === "Ready dependent");
  assert.ok(dependent);
  await f.service.provisionTask(String(dependent.id));
  d.execute({
    type: "project.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  assert.equal(f.runtime.turns, 0);
  d.execute({
    type: "task.configure",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    expectedVersion: 1,
    state: "done",
  });
  await until(() => f.runtime.turns === 1);
  const deadline = Date.now() + 5000;
  while (
    (
      await new OperatorApi(f.service, [f.directory]).readTask(
        String(dependent.id),
      )
    ).data.execution.state !== "running"
  ) {
    if (Date.now() > deadline)
      throw Error("Actual execution did not become running");
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(routeCalls, 0);
  assert.equal(d.assignments(String(dependent.id))[0]?.profileId, workerId);
  await page
    .getByRole("button", { name: "Refresh execution", exact: true })
    .click();
  await page.getByText("running", { exact: true }).waitFor();
  await screenshot(page, "1366-confirmed-ready-running");
});

test("composer disclosures keep supplied values and open the section of each validation error", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID(),
    leadId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: leadId,
    name: "Disclosure lead",
    instructions: "build",
    capabilities: "code",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Disclosure project",
    leadProfileId: leadId,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Disclosure blocker",
    outcome: "Finish",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  let commandWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      commandWrites++;
  });
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  const sections = page.locator(".composer-disclosure");
  const summaries = () =>
    sections.evaluateAll((all) =>
      all.map((section) => ({
        open: (section as HTMLDetailsElement).open,
        summary: section.querySelector("summary")?.textContent,
      })),
    );
  await page.getByLabel("Disclosure blocker").waitFor({ state: "attached" });
  assert.deepEqual(await summaries(), [
    { open: false, summary: "Optional settings · none supplied" },
  ]);
  await page.getByLabel("Task title").fill("Disclosed outcome");
  await page.getByLabel("Desired outcome").fill("Ship a useful result");
  await expandComposer(page);
  await page.getByLabel("Optional context").fill("Review supplied evidence");
  await page
    .getByLabel("Reference links")
    .fill("https://example.com/one\nhttps://example.com/two");
  await page.getByLabel("Assignee").selectOption(leadId);
  await page.getByLabel("Disclosure blocker", { exact: true }).check();
  const collapse = async () => {
    const open = page.locator(".composer-disclosure[open] > summary");
    while ((await open.count()) > 0) await open.first().click();
  };
  await collapse();
  const supplied = [{ open: false, summary: "Optional settings · 4 supplied" }];
  assert.deepEqual(await summaries(), supplied);
  assert.equal(
    await page.getByLabel("Optional context").inputValue(),
    "Review supplied evidence",
  );
  assert.equal(await page.getByLabel("Assignee").inputValue(), leadId);
  assert.equal(
    await page.getByLabel("Disclosure blocker", { exact: true }).isChecked(),
    true,
  );
  await screenshot(page, "390-composer-collapsed-summaries");

  // An invalid link opens its section and focuses the field without a command.
  await expandComposer(page);
  await page.getByLabel("Reference links").fill("not a link");
  await collapse();
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "composer-links",
  );
  assert.deepEqual(await summaries(), [
    { open: true, summary: "Optional settings · 1 error" },
  ]);
  assert.equal(commandWrites, 0);
  await screenshot(page, "390-composer-link-error-expanded");
  await page
    .getByLabel("Reference links")
    .fill("https://example.com/one\nhttps://example.com/two");
  await collapse();

  // A stored assignee that is no longer permitted fails before submission.
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: leadId,
    expectedVersion: 1,
    revoked: true,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  await page.getByLabel("Disclosure blocker").waitFor({ state: "attached" });
  await page
    .getByText("Optional settings · 1 error", { exact: true })
    .waitFor();
  // Fresh options reveal the problem before submission; both actions stay enabled.
  await page
    .getByText("Choose a currently permitted assignee.", { exact: true })
    .waitFor();
  assert.equal((await summaries())[0]?.open, true);
  for (const name of ["Create and start", "Save draft"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isEnabled(),
      true,
    );
  assert.equal(commandWrites, 0);
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "composer-profileId",
  );
  assert.equal((await summaries())[0]?.open, true);
  await page
    .getByText("Choose a currently permitted assignee.", { exact: true })
    .waitFor();
  assert.equal(commandWrites, 0);
  assert.equal(
    d.tasks(projectId).some((t) => t.title === "Disclosed outcome"),
    false,
  );
});

test("browser frozen storage failure sends zero commands and restores only last saved input", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Storage project",
    leadProfileId: null,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  await page.getByLabel("Task title", { exact: true }).fill("Last saved input");
  await page
    .getByLabel("Desired outcome", { exact: true })
    .fill("Finish the work");
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) posts++;
  });
  const saved = await page.evaluate(() =>
    sessionStorage.getItem("ensemble.ui03.composer.v1"),
  );
  assert.ok(saved);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "ensemble.ui03.composer.v1")
        throw new DOMException("Fixture quota", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Newer unsaved input");
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page.getByText(/nothing was sent/).waitFor();
  assert.equal(posts, 0);
  assert.equal(d.tasks(projectId).length, 0);
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Newer unsaved input",
  );
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("ensemble.ui03.composer.v1"),
    ),
    saved,
  );
  await screenshot(page, "390-storage-unavailable-current-input");
  await page.reload();
  await page
    .getByRole("button", { name: "Resume unfinished input", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Last saved input",
  );
  assert.equal(posts, 0);
  await screenshot(page, "390-restored-last-saved-input");
});
test("committed lost-response creation survives reload expiry and exact reconciliation; failed read retains receipt", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID(),
    profileId = randomUUID(),
    blocker = randomUUID();
  d.execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId,
    name: "Chosen agent",
    instructions: "private",
    capabilities: "coordinate",
  });
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Recovery project",
    leadProfileId: profileId,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId: blocker,
    title: "Recovery blocker",
    outcome: "First",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 820 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/new?project=${projectId}`,
  );
  await page
    .getByLabel("Task title", { exact: true })
    .fill("One uncertain creation");
  await page
    .getByLabel("Desired outcome", { exact: true })
    .fill("Finish exactly once");
  await expandComposer(page);
  await page.getByLabel("Assignee", { exact: true }).selectOption(profileId);
  await page.getByLabel("Recovery blocker", { exact: true }).check();
  const sent: string[] = [];
  let lost = true;
  await page.route("**/api/operator/commands", async (route) => {
    sent.push(route.request().postData() ?? "");
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .waitFor();
  assert.equal(sent.length, 1);
  assert.equal(d.tasks(projectId).length, 2);
  // An unknown outcome is one warning with one action; the request key is in Details.
  const unknown = page.locator("[data-slot=action-outcome]");
  assert.equal(await unknown.count(), 1);
  assert.equal(await unknown.getAttribute("data-tone"), "warning");
  assert.equal(
    await unknown.locator("> p").innerText(),
    "We couldn't confirm the task was created. Your input is kept until you check.",
  );
  const material = JSON.parse(sent[0] ?? "{}");
  await unknown.getByText("Details", { exact: true }).click();
  await unknown.getByText(material.key, { exact: true }).waitFor();
  await unknown.getByText("Details", { exact: true }).click();
  assert.equal(d.assignments(material.taskId).length, 1);
  await screenshot(page, "1366-unknown-submission");
  await page.reload();
  await page
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .waitFor();
  assert.equal(sent.length, 1);
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).isEnabled(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Create and start", exact: true })
      .count(),
    0,
  );
  await page.unroute("**/api/operator/commands");
  for (const [status, code] of [
    [400, "invalid-input"],
    [403, "forbidden"],
    [409, "conflict"],
  ] as const) {
    await page.route("**/api/operator/commands", async (route) => {
      sent.push(route.request().postData() ?? "");
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: { code, message: "Safe failure" } }),
      });
    });
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).isDisabled(),
      true,
    );
    await page.unroute("**/api/operator/commands");
  }
  await page.route("**/api/operator/commands", async (route) => {
    sent.push(route.request().postData() ?? "");
    await route.continue();
  });
  f.advanceClock(70000);
  await page
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await page.getByLabel("Password").waitFor();
  assert.equal(
    await page.getByText("One uncertain creation", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .waitFor();
  await page.route(`**/api/operator/tasks/${material.taskId}`, (route) =>
    route.abort("failed"),
  );
  await page
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await page.getByText("Task created.", { exact: true }).waitFor();
  await page
    .getByText("Execution updates are unavailable. Try again.", { exact: true })
    .waitFor();
  assert.equal(sent.length, 6);
  assert.ok(sent.every((bytes) => bytes === sent[0]));
  assert.equal(d.tasks(projectId).length, 2);
  assert.equal(d.assignments(material.taskId).length, 1);
  assert.equal(
    await page.evaluate(() =>
      sessionStorage.getItem("ensemble.ui03.composer.v1"),
    ),
    null,
  );
  await screenshot(page, "1366-recorded-receipt-read-failed");
});

import { OperatorApi } from "../../src/standalone/operator-api.js";
async function visibleControl(page: Page, name: string) {
  const control = page.getByRole("button", { name, exact: true });
  await control.scrollIntoViewIfNeeded();
  assert.ok(
    await control.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2;
      return (
        r.width > 0 &&
        r.height > 0 &&
        x >= 0 &&
        x < innerWidth &&
        y >= 0 &&
        y < innerHeight &&
        el.contains(document.elementFromPoint(x, y))
      );
    }),
    `${name} is visible and unobscured`,
  );
}
test("populated task List and Board keep the approved hierarchy at responsive widths", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seedCatalog(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password);
  let commandPosts = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/operator/commands") &&
      request.method() === "POST"
    )
      commandPosts++;
  });

  const widths = [390, 759, 760, 800, 1024, 1119, 1120, 1121, 1366];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    assert.ok(
      overflow.document <= overflow.viewport,
      `${width}px List has no horizontal page overflow`,
    );
    const listIds = await page
      .locator(".task-list [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      );
    assert.ok(listIds.includes(ids.importedId));
    assert.ok(listIds.includes(ids.question.id));

    const importedRow = page.locator(
      `.task-list [data-task-id="${ids.importedId}"]`,
    );
    const titleMetrics = await importedRow
      .getByRole("link", { name: ids.importedTitle, exact: true })
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          text: element.textContent?.trim(),
        };
      });
    assert.equal(titleMetrics.text, ids.importedTitle, `${width}px title text`);
    assert.ok(
      titleMetrics.width >= 200,
      `${width}px title has readable width (${titleMetrics.width}px)`,
    );
    assert.ok(
      titleMetrics.scrollWidth <= titleMetrics.clientWidth,
      `${width}px long title wraps inside its link`,
    );
    const importedMetadata = await importedRow
      .locator(".task-project-metadata")
      .innerText();
    assert.match(importedMetadata, /Service integration/);
    assert.match(importedMetadata, /fixture\/source#42/);
    assert.equal(
      await importedRow.locator(".task-lead").innerText(),
      "Accountable lead · lead",
    );
    assert.equal(await importedRow.locator(".task-source-state").count(), 0);
    const questionRow = page.locator(
      `.task-list [data-task-id="${ids.question.id}"]`,
    );
    assert.match(
      await questionRow.locator(".task-status").innerText(),
      /Running/,
    );
    await questionRow
      .getByText("Question needs an answer", { exact: true })
      .waitFor({ state: "visible" });
    await questionRow
      .getByText("Accountable lead · lead", { exact: true })
      .waitFor({ state: "visible" });
    const rowOverflow = await page
      .locator(".task-list .task-row")
      .evaluateAll((rows) =>
        rows
          .map((row) => ({
            title: row.querySelector<HTMLElement>(".task-title"),
            rowWidth: row.clientWidth,
            rowScrollWidth: row.scrollWidth,
          }))
          .filter(
            (item) =>
              !item.title ||
              item.rowScrollWidth > item.rowWidth ||
              item.title.scrollWidth > item.title.clientWidth,
          ),
      );
    assert.deepEqual(rowOverflow, [], `${width}px task rows do not clip`);
    if ([390, 760, 800, 1121, 1366].includes(width))
      await screenshot(page, `${width}-responsive-list`);

    await page.getByRole("button", { name: "Board", exact: true }).click();
    const boardIds = await page
      .locator(".board-columns [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      );
    assert.deepEqual(boardIds, listIds, `${width}px List and Board task IDs`);
    assert.equal(
      await page
        .locator(`.board-columns [data-task-id="${ids.question.id}"]`)
        .evaluate((element) =>
          element
            .closest<HTMLElement>(".board-column")
            ?.getAttribute("aria-label"),
        ),
      "Running tasks",
      `${width}px preserves state-derived Board grouping`,
    );
    assert.equal(
      await page
        .locator(
          `.board-columns [data-task-id="${ids.importedId}"] .task-title`,
        )
        .textContent(),
      ids.importedTitle,
      `${width}px Board keeps long source title`,
    );
    const boardOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    assert.equal(boardOverflow, false, `${width}px Board has no page overflow`);
    if ([390, 760, 800, 1121, 1366].includes(width))
      await screenshot(page, `${width}-responsive-board`);
    await page.getByRole("button", { name: "List", exact: true }).click();
  }

  await page.setViewportSize({ width: 800, height: 768 });
  await page.goto(`${web.origin}/app/tasks?state=all&ready=any`);
  await page
    .locator(`.task-list [data-task-id="${ids.paused}"]`)
    .waitFor({ state: "visible" });
  const crossProjectIds = await page
    .locator(".task-list [data-task-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-id")).sort(),
    );
  const expectedProjectIds = f.service
    .domain()
    .tasks(ids.projectId)
    .map((task) => task.id)
    .sort();
  assert.ok(crossProjectIds.includes(ids.paused));
  assert.ok(
    expectedProjectIds.length < crossProjectIds.length,
    `all-project List has ${crossProjectIds.length} rows; project filter has ${expectedProjectIds.length}`,
  );
  await page.getByLabel("Project", { exact: true }).selectOption(ids.projectId);
  await page.waitForURL(
    (url) => url.searchParams.get("project") === ids.projectId,
  );
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".task-list [data-task-id]").length === count,
    expectedProjectIds.length,
  );
  const filteredListIds = await page
    .locator(".task-list [data-task-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-id")).sort(),
    );
  assert.deepEqual(filteredListIds, expectedProjectIds);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  assert.deepEqual(
    await page
      .locator(".board-columns [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      ),
    expectedProjectIds,
    "project filter selects the same tasks in Board",
  );
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === null);
  await page
    .locator(`.task-list [data-task-id="${ids.importedId}"] .task-title`)
    .click();
  await page
    .getByRole("heading", { name: "Latest result", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Back to originating view", exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.get("project"), ids.projectId);
  assert.deepEqual(
    await page
      .locator(".task-list [data-task-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-task-id")).sort(),
      ),
    expectedProjectIds,
    "task return restores the selected project and task IDs",
  );
  assert.equal(commandPosts, 0);
});

for (const viewport of [
  { width: 1366, height: 820 },
  { width: 390, height: 844 },
  { width: 683, height: 410 },
])
  test(`critical journeys remain usable at laptop phone and scaled layout ${viewport.width}`, async (_t, journey) => {
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const context = await browser.newContext({
        viewport,
        deviceScaleFactor: viewport.width === 683 ? 2 : 1,
      }),
      page = await context.newPage();
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      external: string[] = [],
      violations: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (!r.url().startsWith(web.origin)) external.push(r.url());
    });
    page.on("console", (m) => {
      if (m.text().includes("Content Security Policy"))
        violations.push(m.text());
    });
    assert.equal(
      (
        await context.request.get(`${web.origin}/api/operator/task-list`)
      ).status(),
      401,
    );
    assert.equal(
      (
        await context.request.get(
          web.origin +
            `/api/operator/projects/${randomUUID()}/composer-options`,
        )
      ).status(),
      401,
    );
    await signIn(page, web.origin, web.password);
    // A fresh installation's Home is the getting-started checklist.
    const checklist = page.getByRole("region", {
      name: "Get Ensemble running",
    });
    const row = (name: string) =>
      checklist.getByRole("listitem", { name, exact: true });
    // The empty task list still points at getting started; Home is the card itself.
    await page
      .getByRole("link", { name: "See getting started", exact: true })
      .waitFor();
    await page.goto(`${web.origin}/app`);
    await checklist.waitFor();
    // Codex is not on every test host's PATH; the Runtime row reads the check as given.
    await page.route("**/api/operator/readiness", async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      for (const check of body.data.checks)
        if (check.id === "codex-executable" || check.id === "codex-login")
          Object.assign(check, { status: "pass", reason: null, fix: null });
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${web.origin}/app`);
    await row("Runtime").getByText("Done", { exact: true }).waitFor();
    await row("Project").getByText("Next", { exact: true }).waitFor();
    assert.equal(
      await row("Project")
        .getByRole("link", { name: "Create project" })
        .getAttribute("href"),
      "/app/settings/projects/new",
    );
    // Until a task starts a turn Home is only the card: no board, no empty-state line.
    assert.equal(
      await page.getByRole("region", { name: "Across your projects" }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("link", { name: "See getting started" }).count(),
      0,
    );
    await screenshot(page, `${viewport.width}-no-projects`);
    await page.unroute("**/api/operator/readiness");
    const ids = await seedCatalog(f);
    const emptyProject = randomUUID();
    f.service.domain().execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId: emptyProject,
      name: "Ready for first task",
      leadProfileId: null,
    });
    const emptyRead = page.waitForResponse(
      (response) =>
        response.url() === `${web.origin}/api/operator/task-list` &&
        response.request().method() === "GET",
    );
    await page.goto(`${web.origin}/app/projects/${emptyProject}`);
    assert.equal(
      (await emptyRead).status(),
      200,
      "exact task catalog read for empty-project route succeeds",
    );
    await page
      .getByText(
        "Ready for your first task. Create an outcome or save a draft.",
        { exact: true },
      )
      .waitFor();
    await screenshot(page, `${viewport.width}-empty-project`);
    await page.goto(`${web.origin}/app`);
    await page
      .getByRole("link", { name: "Normal Stop observation", exact: true })
      .waitFor();
    const attention = page.getByRole("region", {
        name: "Needs you",
        exact: true,
      }),
      work = page.getByRole("region", {
        name: "Across your projects",
        exact: true,
      });
    await attention.locator(".overview-card").first().waitFor();
    assert.equal(
      await attention
        .getByText("Normal Stop observation", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await work
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await attention
        .getByText("Stop with uncertain ownership", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await attention
        .getByText("Question requiring action", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await work
        .getByRole("link", { name: "Ready but dependent", exact: true })
        .count(),
      1,
    );
    // The occupied project limit is stated once for the whole view, on no card or row.
    assert.match(
      await work.locator(".work-capacity").innerText(),
      /^Capacity is full for .+; it rechecks as turns finish\.$/,
      "occupied project limit preserves eligible Ready work in its real capacity queue",
    );
    assert.equal(await page.getByText(/Capacity is full/).count(), 1);
    await screenshot(page, `${viewport.width}-overview-attention-work`);
    let commandPosts = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/operator/commands") && r.method() === "POST")
        commandPosts++;
    });
    await page.getByRole("link", { name: /^Open Inbox/ }).click();
    await page.goto(`${web.origin}/app/tasks`);
    await page
      .locator(`[data-task-id="${ids.question.id}"]`)
      .getByText("Question needs an answer", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator(`[data-task-id="${ids.uncertainStop.id}"]`)
        .getByText("Execution ownership is uncertain", { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator(`[data-task-id="${ids.normal.id}"]`)
        .getByText("Execution ownership is uncertain", { exact: true })
        .count(),
      0,
    );
    await screenshot(page, `${viewport.width}-list-interventions`);
    await page.goto(`${web.origin}/app/tasks?view=board&state=all&ready=any`);
    await page
      .getByRole("heading", { name: "All tasks", exact: true })
      .waitFor();
    const samples: Record<string, string> = {
      Stopping: "Normal Stop observation",
      Uncertain: "Uncertain execution",
      Running: "Work running normally",
      Done: "Completed result",
      Cancelled: "Cancelled work",
      Paused: "Paused work",
      Draft: "Literal <script>malicious()</script>",
      Waiting: "Ready but dependent",
      Ready: "Ready selected",
    };
    for (const [column, title] of Object.entries(samples)) {
      const reach = page
        .getByRole("region", { name: `${column} tasks`, exact: true })
        .getByRole("link", { name: title, exact: true });
      if (viewport.width < 1121) {
        const tab = page.getByRole("button", {
          name: new RegExp(`^${column} · `),
        });
        await tab.focus();
        await page.keyboard.press("Enter");
      } else {
        // From 1121px there are no column chips; focusing a card scrolls its column into view.
        assert.equal(
          await page.getByRole("toolbar", { name: "Board columns" }).count(),
          0,
        );
        await reach.focus();
      }
      await reach.waitFor({ state: "visible" });
      if (viewport.width >= 1121) {
        // The focused card starts inside the board; the browser may leave its far edge clipped.
        const focused = await reach.evaluate((link) => {
          const board = link.closest(".board-columns")!.getBoundingClientRect();
          const box = link.getBoundingClientRect();
          return (
            link === document.activeElement &&
            box.left >= board.left - 1 &&
            box.left < board.right
          );
        });
        assert.equal(focused, true, `${column} card is focused in the board`);
      }
      if (column === "Running")
        await page
          .locator(`[data-task-id="${ids.question.id}"]`)
          .getByText("Question needs an answer", { exact: true })
          .waitFor({ state: "visible" });
      if (column === "Stopping")
        assert.equal(
          await page
            .locator(`[data-task-id="${ids.uncertainStop.id}"]`)
            .getByText("Execution ownership is uncertain", { exact: true })
            .count(),
          1,
        );
      if (column === "Done" || column === "Cancelled") {
        const terminal = page.getByRole("region", {
          name: `${column} tasks`,
          exact: true,
        });
        assert.equal(
          await terminal.getByText("Draft: not Ready", { exact: true }).count(),
          0,
        );
        assert.equal(await terminal.getByText(/Capacity is full/).count(), 0);
      }
      await screenshot(page, `${viewport.width}-board-${column.toLowerCase()}`);
    }
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 1 },
    });
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    const notice = page.locator(".work-capacity"),
      stated = page.getByText(/Capacity is full/);
    await notice.waitFor({ state: "visible" });
    assert.equal(await stated.count(), 1);
    await screenshot(page, `${viewport.width}-board-actual-capacity-full`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page
      .locator(".task-list [data-task-id]")
      .first()
      .waitFor({ state: "visible" });
    assert.equal(await notice.count(), 1);
    assert.equal(await stated.count(), 1);
    await screenshot(page, `${viewport.width}-list-actual-capacity-full`);
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 10 },
    });
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await stated.first().waitFor({ state: "hidden" });
    assert.equal(await stated.count(), 0);
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 1 },
    });
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await notice.waitFor({ state: "visible" });
    assert.equal(await stated.count(), 1);
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 10 },
    });
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await stated.first().waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Board", exact: true }).click();
    if (viewport.width < 1121)
      await page.getByRole("button", { name: /^Waiting · / }).click();
    if (viewport.width < 760) {
      await visibleControl(page, "Previous column: Running");
      await page
        .getByRole("button", { name: "Previous column: Running", exact: true })
        .click();
      assert.equal(
        await page
          .getByRole("button", { name: /^Running · / })
          .getAttribute("aria-pressed"),
        "true",
      );
      await visibleControl(page, "Next column: Waiting");
      await page
        .getByRole("button", { name: "Next column: Waiting", exact: true })
        .click();
    }
    await page.getByLabel("State", { exact: true }).selectOption("Stopping");
    await page.getByRole("button", { name: "List", exact: true }).click();
    const stopIds = await page
      .locator("[data-task-id]")
      .evaluateAll((es) =>
        es.map((e) => e.getAttribute("data-task-id")).sort(),
      );
    assert.deepEqual(stopIds, [ids.normal.id, ids.uncertainStop.id].sort());
    await page.getByRole("button", { name: "Board", exact: true }).click();
    if (viewport.width < 760)
      await page
        .getByRole("region", { name: "Stopping tasks", exact: true })
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .waitFor({ state: "visible" });
    assert.deepEqual(
      await page
        .locator("[data-task-id]")
        .evaluateAll((es) =>
          es.map((e) => e.getAttribute("data-task-id")).sort(),
        ),
      stopIds,
    );
    await page.reload();
    await page.getByLabel("State", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("State", { exact: true }).inputValue(),
      "Stopping",
    );
    await page.goBack();
    await page.goForward();
    assert.ok(page.url().includes("state=Stopping"));
    assert.equal(commandPosts, 0);
    await page.goto(`${web.origin}/app/projects/${ids.projectId}?ready=any`);
    await page
      .locator(`[data-task-id="${ids.question.id}"]`)
      .getByText("Question needs an answer", { exact: true })
      .waitFor();
    await page.goto(
      `${web.origin}/app/projects/${ids.projectId}?source=github&ready=any`,
    );
    await page
      .getByRole("link", { name: ids.importedTitle, exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator(`a[href="/app/projects/${ids.projectId}"]`)
        .first()
        .getAttribute("aria-current"),
      "page",
    );
    await page
      .getByRole("link", { name: ids.importedTitle, exact: true })
      .click();
    assert.ok(page.url().endsWith(`/app/tasks/${ids.importedId}`));
    // Below 760px Execution sits in the closed Task actions disclosure, which role queries skip.
    const execution = page.locator(
      `.task-header-actions a[href="/runtime/task/${ids.importedId}"]`,
    );
    await execution.waitFor({ state: "attached" });
    assert.equal(
      await page
        .locator('input[name="title"],textarea[name="outcome"]')
        .count(),
      0,
    );
    assert.equal(await execution.count(), 1);
    for (const name of ["Advanced task controls", "Requests and coordination"])
      assert.equal(
        await page.getByRole("link", { name, exact: true }).count(),
        0,
      );
    await page.goBack();
    await page
      .getByRole("heading", { name: "Service integration", exact: true })
      .waitFor();
    assert.ok(page.url().includes("source=github"));
    // An unavailable retained source revision keeps the imported task's provenance.
    await page.goto(
      `${web.origin}/app/tasks/${ids.importedId}?source=${randomUUID()}`,
    );
    await page.getByText(/^Selected source revision is unavailable/).waitFor();
    assert.equal(
      await page.locator("#brief > details > summary .metadata").textContent(),
      "Requirements · GitHub · Retained source unavailable",
    );
    await page.goto(`${web.origin}/app/tasks?ready=any`);
    await page
      .getByRole("link", { name: "Normal Stop observation", exact: true })
      .waitFor();
    await page.route("**/api/operator/task-list", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "unavailable", message: "Tasks unavailable" },
        }),
      }),
    );
    await page
      .getByRole("button", { name: "Refresh tasks", exact: true })
      .click();
    await page
      .getByText("Refresh failed. Showing the last fetched data.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .count(),
      1,
    );
    await screenshot(page, `${viewport.width}-stale-tasks`);
    await page.reload();
    await page
      .getByText("Tasks are unavailable. Try again.", { exact: true })
      .waitFor();
    await screenshot(page, `${viewport.width}-error-tasks`);
    await page.unroute("**/api/operator/task-list");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page
      .getByRole("link", { name: "Normal Stop observation", exact: true })
      .waitFor();
    await openMoreFilters(page);
    await page
      .getByLabel("Filter tasks", { exact: true })
      .fill("No matching outcome");
    await page
      .getByText("No tasks match these filters", { exact: true })
      .waitFor();
    await screenshot(page, `${viewport.width}-no-match`);
    await page.goto(`${web.origin}/app/tasks/new?project=${ids.projectId}`);
    await page.getByText(/^Capacity: \d+\/10 project/).waitFor();
    f.service.domain().execute({
      type: "capacity.configure",
      key: randomUUID(),
      actor: "operator",
      globalLimit: 10,
      projectOverrides: { [ids.projectId]: 1 },
    });
    await page.reload();
    await page.getByText(/^Capacity: \d+\/1 project/).waitFor();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.waitForFunction(
      () => document.activeElement?.id === "composer-title",
    );
    await page
      .getByLabel("Task title", { exact: true })
      .fill("Long laptop and phone outcome");
    await page
      .getByLabel("Desired outcome", { exact: true })
      .fill("Detailed desired outcome.\n".repeat(180));
    await expandComposer(page);
    await page
      .getByLabel("Optional context", { exact: true })
      .fill("Supplied context remains readable.\n".repeat(90));
    await page
      .getByLabel("Reference links", { exact: true })
      .fill("https://example.com/passive-context");
    await page
      .getByLabel("Assignee", { exact: true })
      .selectOption(ids.profileId);
    await page.getByLabel("Open dependency", { exact: true }).check();
    await visibleControl(page, "Create and start");
    await visibleControl(page, "Save draft");
    await screenshot(page, `${viewport.width}-long-composer`);
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    if (viewport.width < 760) {
      // The composer is a nested screen: its phone header has Back, not the menu.
      assert.equal(
        await page
          .getByRole("button", { name: "Projects and navigation", exact: true })
          .count(),
        0,
      );
      assert.ok(
        (await page
          .getByRole("link", { name: /^Back to / })
          .first()
          .evaluate((el) => el.getBoundingClientRect().height)) >= 44,
      );
    }
    f.advanceClock(70000);
    // Choosing the project again reads its composer options, which finds the expired session.
    await page.getByLabel("Project", { exact: true }).selectOption("");
    await page
      .getByLabel("Project", { exact: true })
      .selectOption(ids.projectId);
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("link", { name: "Normal Stop observation", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(violations, []);
    console.log(
      `UI03 ${viewport.width} browser ${browser.version()} evidence: ${journey.directory}; fixture ${f.directory} awaits teardown`,
    );
  });

test("composer switches scoped options despite delayed prior response and preserves input after revoked assignee", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    a = randomUUID(),
    b = randomUUID(),
    leadA = randomUUID(),
    leadB = randomUUID();
  for (const [projectId, profileId, name] of [
    [a, leadA, "First"],
    [b, leadB, "Second"],
  ] as const) {
    d.execute({
      type: "profile.create",
      key: randomUUID(),
      actor: "operator",
      profileId,
      name: `${name} lead`,
      instructions: "private",
      capabilities: "coordinate",
    });
    d.execute({
      type: "project.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      name: `${name} project`,
      leadProfileId: profileId,
    });
    d.execute({
      type: "task.create",
      key: randomUUID(),
      actor: "operator",
      projectId,
      taskId: randomUUID(),
      title: `${name} dependency`,
      outcome: "Finish",
      ready: false,
    });
  }
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage();
  journey.observe(page);
  page.setDefaultTimeout(5000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted!: () => void;
  const entered = new Promise<void>((resolve) => {
    intercepted = resolve;
  });
  let first = true;
  await page.route(
    `**/api/operator/projects/${a}/composer-options`,
    async (route) => {
      if (first) {
        first = false;
        const response = await route.fetch();
        intercepted();
        await held;
        try {
          await route.fulfill({ response });
        } catch {
          /* aborted obsolete read */
        }
      } else await route.continue();
    },
  );
  journey.cleanup(async () => release(), "pending-request.release");
  await signIn(page, web.origin, web.password, `/app/tasks/new?project=${a}`);
  await entered;
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Preserved outcome");
  await page.getByLabel("Desired outcome", { exact: true }).fill("Do the work");
  await page.getByLabel("Project", { exact: true }).selectOption(b);
  await page
    .getByLabel("Second dependency", { exact: true })
    .waitFor({ state: "attached" });
  release();
  await expandComposer(page);
  await page.getByLabel("Assignee", { exact: true }).selectOption(leadB);
  assert.equal(
    await page.getByLabel("First dependency", { exact: true }).count(),
    0,
  );
  await page.getByLabel("Second dependency", { exact: true }).check();
  await page.getByLabel("Project", { exact: true }).selectOption(a);
  await page
    .getByLabel("First dependency", { exact: true })
    .waitFor({ state: "attached" });
  assert.equal(
    await page.getByLabel("Assignee", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("First dependency", { exact: true }).isChecked(),
    false,
  );
  await page
    .getByText(
      "Project changed. Assignee and dependency selections were cleared.",
      { exact: true },
    )
    .waitFor();
  await expandComposer(page);
  await page.getByLabel("Assignee", { exact: true }).selectOption(leadA);
  d.execute({
    type: "profile.configure",
    key: randomUUID(),
    actor: "operator",
    profileId: leadA,
    expectedVersion: 1,
    revoked: true,
  });
  await page
    .getByRole("button", { name: "Create and start", exact: true })
    .click();
  await page
    .getByText(
      "Couldn't create the task: you don't have permission. Your input is still here.",
      { exact: true },
    )
    .waitFor();
  // One alert; the code is in Details, not in the message.
  const refused = page.locator("[data-slot=action-outcome]");
  assert.equal(await refused.count(), 1);
  assert.equal(await refused.getAttribute("role"), "alert");
  assert.doesNotMatch(await refused.innerText(), /forbidden/);
  await refused.getByText("Details", { exact: true }).click();
  await refused.getByText("forbidden", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Task title", { exact: true }).inputValue(),
    "Preserved outcome",
  );
  assert.equal(
    await page.getByLabel("Desired outcome", { exact: true }).inputValue(),
    "Do the work",
  );
  assert.equal(d.tasks(a).length, 1);
  assert.equal(f.runtime.turns, 0);
});
test("replacement composer owns recovery before a detached committed receipt or old-session 401 arrives", async (_t, journey) => {
  for (const mode of ["receipt-navigation", "401-expiry"] as const) {
    journey.restart();
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const d = f.service.domain(),
      projectId = randomUUID(),
      profileId = randomUUID();
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name: "Delayed agent",
      instructions: "private",
      capabilities: "coordinate",
    });
    d.execute({
      type: "project.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      name: "Delayed recovery project",
      leadProfileId: profileId,
    });
    const web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({
      viewport:
        mode === "receipt-navigation"
          ? { width: 1366, height: 820 }
          : { width: 390, height: 844 },
    });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      sent: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(
      page,
      web.origin,
      web.password,
      `/app/tasks/new?project=${projectId}`,
    );
    await page
      .getByLabel("Task title", { exact: true })
      .fill("Delayed original creation");
    await page
      .getByLabel("Desired outcome", { exact: true })
      .fill("Finish exactly once");
    await expandComposer(page);
    await page.getByLabel("Assignee", { exact: true }).selectOption(profileId);
    let release!: () => void, committed!: () => void;
    const held = new Promise<void>((done) => {
      committed = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/operator/commands", async (route) => {
      sent.push(route.request().postData() ?? "");
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      committed();
      await gate;
      if (mode === "401-expiry")
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unauthenticated", message: "Sign in" },
          }),
        });
      else await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await held;
    // In progress is the button label alone: no status line, no outcome.
    await page.getByRole("button", { name: "Saving…", exact: true }).waitFor();
    assert.equal(await page.locator("[data-slot=action-outcome]").count(), 0);
    assert.equal(await page.getByRole("status").count(), 0);
    const recovery = await page.evaluate(() =>
      sessionStorage.getItem("ensemble.ui03.composer.v1"),
    );
    assert.ok(recovery);
    const command = JSON.parse(sent[0] ?? "null");
    assert.equal(d.tasks(projectId).length, 1);
    assert.equal(d.assignments(command.taskId).length, 1);
    if (mode === "receipt-navigation") {
      await page
        .getByRole("link", { name: "Tasks", exact: true })
        .first()
        .click();
      await page.getByRole("link", { name: "New task", exact: true }).click();
    } else {
      f.advanceClock(61_000);
      // The composer is locked while it saves, so leaving it finds the expired session.
      await page.getByRole("link", { name: /^Back to /, exact: false }).click();
      await page
        .getByRole("button", { name: "Refresh tasks", exact: true })
        .click();
      await page.getByLabel("Password", { exact: true }).fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("link", { name: "New task", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .waitFor();
    assert.equal(sent.length, 1);
    const delivered = page.waitForResponse((r) =>
      r.url().endsWith("/api/operator/commands"),
    );
    release();
    await delivered;
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).inputValue(),
      "Delayed original creation",
    );
    assert.equal(
      await page.getByLabel("Task title", { exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("ensemble.ui03.composer.v1"),
      ),
      recovery,
    );
    assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
    assert.equal(sent.length, 1);
    await screenshot(
      page,
      `${mode === "receipt-navigation" ? "1366" : "390"}-${mode}-replacement-unknown`,
    );
    await page.unroute("**/api/operator/commands");
    page.on("request", (r) => {
      if (r.url().endsWith("/api/operator/commands"))
        sent.push(r.postData() ?? "");
    });
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .click();
    await page.getByText("Draft saved.", { exact: true }).waitFor();
    assert.deepEqual(sent, [sent[0], sent[0]]);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("ensemble.ui03.composer.v1"),
      ),
      null,
    );
    assert.equal(d.tasks(projectId).length, 1);
    assert.equal(d.assignments(command.taskId).length, 1);
    assert.equal(f.runtime.turns, 0);
    assert.deepEqual(errors, []);
    await screenshot(
      page,
      `${mode === "receipt-navigation" ? "1366" : "390"}-${mode}-reconciled`,
    );
  }
});

test("List and Board name an imported Draft task's unmet readiness condition", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seedCatalog(f);
  const source = {
    providerInstance: "github.com" as const,
    repositoryId: "R-UI03",
    repositoryName: "fixture/source",
    body: "Source-owned imported outcome",
    state: "open" as const,
    projectFields: [],
  };
  f.service.githubSources().reconcileSelection(ids.projectId, "repo", {
    complete: true,
    reason: null,
    issues: [
      {
        ...source,
        nodeId: "I-UI03",
        number: 42,
        title: ids.importedTitle,
        labels: ["ready"],
      },
      {
        ...source,
        nodeId: "I-UI04",
        number: 43,
        title: "Unlabelled imported task",
        labels: [],
      },
    ],
  });
  const unready = String(f.service.githubSources().issue("I-UI04")?.taskId);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    "/app/tasks?state=all&ready=any",
  );
  for (const surface of [".task-list", ".board-columns"]) {
    if (surface === ".board-columns")
      await page.getByRole("button", { name: "Board", exact: true }).click();
    const card = page.locator(`${surface} [data-task-id="${unready}"]`);
    await card
      .getByText("Not Ready: missing label `ready`", { exact: true })
      .waitFor();
    assert.equal(
      await card.getByText("Draft: not Ready", { exact: true }).count(),
      0,
    );
    // Local Draft tasks keep the generic reason.
    await page
      .locator(`${surface} [data-task-id="${ids.draft}"]`)
      .getByText("Draft: not Ready", { exact: true })
      .waitFor();
  }
});
