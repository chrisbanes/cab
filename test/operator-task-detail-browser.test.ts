import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, webkit, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { guideForm } from "./fixtures/question-data.js";
import { seedOwnQuestion } from "./fixtures/questions.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const test = browserSuite("ui-task-detail");
const body =
  "Let keyboard users open the command menu.\n\n- [ ] Restore focus\n- [ ] Retain drafts\n- [ ] Announce results";

/** A task with a lead, two delegated assignments (one completed) and a recorded result. */
async function seed(f: Awaited<ReturnType<typeof createOperatorFixture>>) {
  const a = await seedReviewTask(
    f,
    "Atlas",
    "Ship an accessible command menu",
    body,
  );
  const done = a.delegatedResult("Earlier finished work");
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='completed' WHERE id=?")
      .run(done.assignmentId),
  );
  const [c1, c2] = a.source.criteria;
  const result = a.delegatedResult("Keyboard support ready for review", {
    sourceId: a.source.sourceId,
    criteria: [
      {
        criterionId: c1!.criterionId,
        outcome: "supported",
        scope: "Keyboard opening",
        provenance: "Focus check",
      },
      {
        criterionId: c2!.criterionId,
        outcome: "failed",
        scope: "Draft retention",
        provenance: "Draft check",
      },
    ],
  });
  // An unfinished delegated assignment, which a Stop affects.
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    assignmentId: randomUUID(),
    profileId: a.profileId,
    brief: "Independent focus review",
    resultDestination: "lead",
    requesterAssignmentId: a.assignmentId,
  });
  return { ...a, result };
}

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

test("Task detail shows the designed header, two columns and C1/C2 criteria", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seed(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const h1 = page.locator("main.page h1");
  await page
    .getByRole("heading", { name: "Ship an accessible command menu", level: 1 })
    .waitFor();
  const header = page.locator(".page-header");
  assert.match(
    (await header.locator(".page-header-title p").textContent()) ?? "",
    /Accountable project lead: Task lead$/,
  );
  // Exactly two header actions, and the direct-load Back names the project.
  assert.deepEqual(
    await header
      .locator(".task-header-actions > *")
      .evaluateAll((els) => els.map((e) => [e.tagName, e.textContent])),
    [
      ["A", "Execution"],
      ["BUTTON", "Stop…"],
    ],
  );
  assert.equal(
    await header.getByRole("link", { name: "Execution" }).getAttribute("href"),
    `/runtime/task/${a.taskId}`,
  );
  const back = header.getByRole("link", { name: "Back to Atlas", exact: true });
  assert.equal(await back.getAttribute("href"), `/app/projects/${a.projectId}`);
  assert.ok(await back.isVisible());
  assert.equal(
    await page
      .getByRole("link", { name: "Back to project", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.locator('nav[aria-label="Task sections"]').count(),
    0,
  );
  // Stop… uses the tinted destructive button.
  const tint = await header
    .getByRole("button", { name: "Stop…" })
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, fg: s.color };
    });
  const alpha = Number(tint.bg.match(/[\d.]+(?=\)$)/)?.[0] ?? 1);
  assert.ok(alpha > 0 && alpha < 1, `Stop background ${tint.bg}`);
  assert.notEqual(tint.bg, tint.fg);

  // Decision card above two side-by-side columns; the document is the only scroller.
  await page
    .getByRole("heading", { name: "Latest result", exact: true })
    .waitFor();
  const box = async (selector: string) => {
    const b = await page.locator(selector).boundingBox();
    assert.ok(b, selector);
    return b;
  };
  const card = await box('section[aria-label="Pending requests and holds"]'),
    brief = await box("section#brief"),
    review = await box("section#review");
  assert.ok(
    card.y + card.height <= brief.y && card.y + card.height <= review.y,
  );
  assert.ok(brief.x + brief.width <= review.x, "brief is left of the result");
  assert.ok(Math.abs(brief.y - review.y) <= 24);
  assert.ok(
    await page
      .getByRole("heading", { name: "Shared brief", exact: true })
      .isVisible(),
  );
  assert.ok(await noHorizontalScroll(page));
  assert.ok(
    await page
      .locator(".task-columns, .task-columns > section")
      .evaluateAll((els) =>
        els.every((e) => e.scrollHeight <= e.clientHeight + 1),
      ),
  );

  // Criteria: C1/C2/C3 with recorded words, no aggregate, raw checklist only in the disclosure.
  const rows = page.locator("#review .criterion-row > p:first-child");
  assert.deepEqual(await rows.allTextContents(), [
    "C1 · Supported by recorded evidence",
    "C2 · Failed recorded check",
    "C3 · Unverified",
  ]);
  assert.deepEqual(
    await page.locator("#brief .brief-criteria li").allTextContents(),
    ["C1Restore focus", "C2Retain drafts", "C3Announce results"],
  );
  const visibleBrief = await page.locator("#brief").innerText();
  assert.ok(!visibleBrief.includes("- [ ]"), visibleBrief);
  assert.ok(
    !/all criteria|\d+ of \d+ criteria/i.test(
      await page.locator("#review").innerText(),
    ),
  );
  await page.locator("#brief details > summary").first().click();
  assert.ok(
    (await page.locator("#brief details").first().innerText()).includes(
      "- [ ] Restore focus",
    ),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Ask lead about criterion" })
      .count(),
    3,
  );
  await page
    .getByRole("button", { name: "Ask lead about criterion" })
    .first()
    .click();
  await page.waitForFunction(
    () => document.activeElement?.id === "workspace-reply",
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Please review criterion 3 in source revision 1.",
  );
  await page.getByLabel("Editable reply").fill("");

  // Entries move focus in place without a history entry; retained links stay.
  const before = await page.evaluate(() => history.length);
  for (const [name, id] of [
    ["Files", "files"],
    ["Changes", "changes"],
    ["Review", "local-review"],
  ] as const) {
    await page.getByRole("link", { name, exact: true }).click();
    await page.waitForFunction(
      (id) => document.activeElement?.closest("section")?.id === id,
      id,
    );
  }
  assert.equal(await page.evaluate(() => history.length), before);
  for (const name of ["Advanced task controls", "Requests and coordination"])
    assert.ok(await page.getByRole("link", { name, exact: true }).isVisible());
  assert.equal(
    await page.locator(".assignment-row").count(),
    4,
    "lead and three delegated assignments",
  );
  await page.evaluate(() => scrollTo(0, 0));
  await captureBrowserEvidence(page, "task-detail-desktop", {
    fullPage: false,
  });

  // Expanded history and an unsent reply survive a refresh.
  await page
    .getByRole("button", { name: /^Task lead · Produce the scoped/ })
    .first()
    .click();
  const expanded = page.locator("#history details[open]").first();
  await expanded.waitFor();
  await page.getByLabel("Editable reply").fill("Unsent reply");
  // Read the anchor with the result in view; the grid must not disturb restoration.
  const anchor = page.locator(`[data-record-id="${a.result.resultId}"]`);
  await anchor.evaluate((e) => e.scrollIntoView());
  await page.evaluate(() => scrollBy(0, -40));
  const top = () => anchor.evaluate((e) => e.getBoundingClientRect().top);
  const anchorTop = await top();
  const reread = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/operator/tasks/${a.taskId}`,
  );
  // Dispatch without scrolling the button into view, as a timed re-read would.
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .dispatchEvent("click");
  await reread;
  // Settled: two frames after the read, the layout effect has restored the anchor.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const after = await top();
  assert.ok(
    Math.abs(after - anchorTop) <= 1,
    `anchor ${anchorTop} -> ${after}`,
  );
  assert.equal(await page.locator("#history details[open]").count(), 1);
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unsent reply",
  );

  // Phone: Back, Execution and Stop… stay in the first viewport at 44px; one column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  for (const name of ["Execution", "Stop…", "Back to Atlas"]) {
    const control = header.getByRole(name === "Stop…" ? "button" : "link", {
      name,
      exact: true,
    });
    const b = await control.boundingBox();
    assert.ok(
      b && b.height >= 44 && b.y + b.height <= 844,
      `${name} ${JSON.stringify(b)}`,
    );
  }
  const phoneBrief = await box("section#brief"),
    phoneReview = await box("section#review");
  assert.ok(phoneBrief.y + phoneBrief.height <= phoneReview.y);
  assert.ok(await noHorizontalScroll(page));
  await captureBrowserEvidence(page, "task-detail-phone", { fullPage: false });
  await page.getByRole("link", { name: "Message lead", exact: true }).click();
  await page.waitForFunction(
    () => document.activeElement?.closest("section")?.id === "reply",
  );
  await h1.waitFor();
});

test("Task detail Back returns to the originating Board entry", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seed(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, "/app/tasks?view=board");
  const card = page.locator(`[data-task-id="${a.taskId}"] .task-title`);
  await card.waitFor();
  const board = page.locator(".board-columns");
  await board.evaluate((e) => {
    e.scrollLeft = e.scrollWidth;
  });
  const boardScroll = await board.evaluate((e) => e.scrollLeft);
  assert.ok(boardScroll > 0, "the board scrolls horizontally");
  await card.click();
  const back = page.getByRole("link", {
    name: "Back to originating view",
    exact: true,
  });
  await back.waitFor();
  assert.equal(await back.innerText(), "Board");
  // A modified click keeps the browser's own behaviour: a new tab at the origin.
  const taskUrl = page.url();
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    back.click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await tab.waitForLoadState("domcontentloaded");
  assert.equal(new URL(tab.url()).search, "?view=board");
  await tab.close();
  assert.equal(page.url(), taskUrl);
  const length = await page.evaluate(() => history.length);
  await back.click();
  await page.waitForURL(
    (u) => u.pathname === "/app/tasks" && u.search === "?view=board",
  );
  assert.equal(await page.evaluate(() => history.length), length);
  await card.waitFor();
  assert.equal(await board.evaluate((e) => e.scrollLeft), boardScroll);
  // After sign-out and sign-in the header reads "Task" until the new read lands.
  await card.click();
  await page
    .getByRole("heading", { name: "Ship an accessible command menu", level: 1 })
    .waitFor();
  await page.getByRole("button", { name: "Operator account" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Sign out", exact: true })
    .click();
  await page.getByLabel("Password").waitFor();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/operator/tasks/${a.taskId}`, async (route) => {
    await held;
    await route.continue();
  });
  try {
    // Sign in again in the same document, at the address sign-out kept.
    assert.equal(new URL(page.url()).pathname, `/app/tasks/${a.taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Task", exact: true, level: 1 })
      .waitFor();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await page
    .getByRole("heading", { name: "Ship an accessible command menu", level: 1 })
    .waitFor();
});

test("An empty local task says so honestly", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain(),
    projectId = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    name: "Fieldnotes",
    leadProfileId: null,
  });
  d.execute({
    type: "task.create",
    key: randomUUID(),
    actor: "operator",
    projectId,
    taskId,
    title: "Empty task",
    outcome: "Write the field notes guide.",
    ready: false,
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, `/app/tasks/${taskId}`);
  await page.getByRole("heading", { name: "Empty task", level: 1 }).waitFor();
  const review = page.locator("#review");
  await review.getByText("No result recorded.", { exact: true }).waitFor();
  await review.getByText("No assignments yet.", { exact: true }).waitFor();
  await page
    .locator("#brief")
    .getByText("None supplied", { exact: true })
    .waitFor();
  assert.match(
    (await page.locator(".page-header-title p").textContent()) ?? "",
    /Accountable project lead: Unconfigured$/,
  );
  assert.ok(await noHorizontalScroll(page));
  await captureBrowserEvidence(page, "task-detail-empty-phone", {
    fullPage: false,
  });
});

test("A question opened on the task page names its requester", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const q = await seedOwnQuestion(f, guideForm);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/${q.taskId}?request=${q.interactionId}`,
  );
  await page
    .getByRole("region", { name: "Exact question response" })
    .getByText("Recommended by Task lead", { exact: true })
    .waitFor();
});

for (const engine of [
  { name: "chromium", type: chromium },
  { name: "webkit", type: webkit },
] as const)
  test(`Stop confirms first, Keep running sends nothing, Stop task posts the retained form (${engine.name})`, async (_t, j) => {
    const f = await j.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
    );
    let browser: Browser | undefined;
    j.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const a = await seed(f);
    const web = await j.start("fixture.web", () => f.startWeb());
    browser = await j.start(`browser.launch.${engine.name}`, () =>
      engine.type.launch(),
    );
    const page = await browser.newPage({
      viewport: { width: 1366, height: 900 },
    });
    j.observe(page);
    page.setDefaultTimeout(5000);
    const stops: { body: string | null; origin: string | undefined }[] = [];
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        new URL(r.url()).pathname === "/runtime/control/stop"
      )
        stops.push({ body: r.postData(), origin: r.headers().origin });
    });
    await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
    const stop = page.getByRole("button", { name: "Stop…", exact: true });
    await stop.waitFor();
    await stop.click();
    const dialog = page.getByRole("alertdialog", {
      name: "Stop Ship an accessible command menu?",
    });
    await dialog.waitFor();
    const text = (await dialog.textContent()) ?? "";
    for (const line of [
      "Task lead (lead) and 1 delegated assignment is affected.",
      "Stops new work and asks running turns to end; some effects may still finish, and files, history and results are kept.",
    ])
      assert.ok(text.includes(line), `${line} in ${text}`);
    // The description plus body stay at two sentences in plain words.
    const sentences = (
      await dialog
        .locator("p")
        .evaluateAll((els) => els.map((e) => e.textContent ?? ""))
    )
      .join(" ")
      .match(/[^.]+\./g);
    assert.equal(sentences?.length, 2, text);
    assert.doesNotMatch(text, /observation|cancellation|termination/i);
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Keep running",
    );
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Stop…",
    );
    await stop.click();
    await dialog.getByRole("button", { name: "Keep running" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Stop…",
    );
    assert.equal(stops.length, 0);

    // Phone: stacked 44px dialog buttons.
    await page.setViewportSize({ width: 390, height: 844 });
    await stop.click();
    const buttons = await dialog
      .getByRole("button")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every((b) => b.height >= 44));
    assert.ok(buttons[1]!.top >= buttons[0]!.bottom, "buttons stack");
    await captureBrowserEvidence(page, `stop-dialog-phone-${engine.name}`, {
      fullPage: false,
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await captureBrowserEvidence(page, `stop-dialog-${engine.name}`, {
      fullPage: false,
    });

    const session = await page.evaluate(() =>
      fetch("/api/operator/session").then((r) => r.json()),
    );
    await dialog.getByRole("button", { name: "Stop task" }).dblclick();
    await page.waitForURL((u) => u.pathname === `/runtime/task/${a.taskId}`);
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.origin, web.origin);
    assert.equal(
      stops[0]?.body,
      new URLSearchParams({
        csrfToken: session.csrfToken,
        taskId: a.taskId,
      }).toString(),
    );
    await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
    await page.locator("main.page h1").waitFor();
    const read = await page.evaluate(
      (id) => fetch(`/api/operator/tasks/${id}`).then((r) => r.json()),
      a.taskId,
    );
    assert.equal(read.data.execution.holds.stop, true);
    const requested = page.getByRole("button", {
      name: "Stop requested",
      exact: true,
    });
    await requested.waitFor();
    assert.ok(await requested.isDisabled());
    assert.ok(
      await page
        .getByRole("link", { name: "Execution", exact: true })
        .isVisible(),
    );
    assert.match(
      (await page.locator(".page-header-title p").textContent()) ?? "",
      /^Stopping; effects may continue/,
    );
  });

test("Task detail lists waits in order: Resume project confirms and sends one command, holds only link", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const d = f.service.domain();
  const projectId = randomUUID(),
    blocker = randomUUID(),
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "fixture-app",
    leadProfileId: null,
  });
  for (const [id, title, ready] of [
    [blocker, "Set up the deploy check", false],
    [taskId, "Add a health-check endpoint", true],
  ] as const)
    d.execute({
      type: "task.create",
      actor: "operator",
      key: randomUUID(),
      projectId,
      taskId: id,
      title,
      outcome: "Probe",
      ready,
    });
  d.execute({
    type: "dependency.add",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    blockerTaskId: blocker,
    expectedVersion: Number(d.task(taskId).version),
  });
  // A Claude lead with no token reference, in a second paused project.
  const claudeLead = randomUUID(),
    claudeProject = randomUUID(),
    claudeTask = randomUUID();
  d.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: claudeLead,
    name: "Ada",
    instructions: "Lead",
    capabilities: "coordination",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: claudeProject,
    name: "claude-app",
    leadProfileId: claudeLead,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: claudeProject,
    taskId: claudeTask,
    title: "Claude task",
    outcome: "Probe",
    ready: true,
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commands.push(request.postDataJSON());
  });
  await signIn(page, web.origin, web.password, `/app/tasks/${taskId}`);
  const waits = page.locator(".wait-reasons");
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor();
  const list = waits.locator(".wait-list li");
  assert.deepEqual(await list.locator("> span:first-child").allInnerTexts(), [
    "Project has no lead",
    "Blocked by a task dependency",
  ]);
  assert.equal(
    await list
      .nth(0)
      .getByRole("link", { name: "Fix: Choose a lead" })
      .getAttribute("href"),
    `/app/projects/${projectId}/settings`,
  );
  // A dependency links to the blocking task and has no Fix.
  const dependency = list.nth(1);
  assert.equal(
    await dependency
      .getByRole("link", { name: "Set up the deploy check" })
      .getAttribute("href"),
    `/app/tasks/${blocker}`,
  );
  assert.equal(await dependency.getByText(/^Fix:/).count(), 0);
  assert.equal(await dependency.getByRole("button").count(), 0);

  // Cancel sends nothing.
  const fix = waits.getByRole("button", { name: "Fix: Resume project" });
  await fix.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText("Resume fixture-app?").waitFor();
  await dialog.getByText("Holds and access are unchanged.").waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(commands, []);

  // Confirm sends exactly one project.configure and nothing else.
  await fix.click();
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await waits.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(commands.length, 1);
  const sent = commands[0] as unknown as Record<string, unknown>;
  assert.deepEqual(
    { type: sent.type, projectId: sent.projectId, paused: sent.paused },
    { type: "project.configure", projectId, paused: false },
  );
  assert.deepEqual(Object.keys(sent).sort(), [
    "expectedVersion",
    "key",
    "paused",
    "projectId",
    "type",
  ]);
  await waits
    .getByText("Waiting · Project has no lead", { exact: true })
    .waitFor();
  assert.equal(await waits.getByText("Project paused").count(), 0);
  // The dependency hold remains: Resume clears only the pause.
  assert.deepEqual(await list.locator("> span:first-child").allInnerTexts(), [
    "Blocked by a task dependency",
  ]);
  assert.deepEqual(d.dependencies(taskId), [blocker]);
  assert.equal(d.project(projectId).paused, 0);

  // Claude token unavailable opens Add Claude.
  await page.goto(`${web.origin}/app/tasks/${claudeTask}`);
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor();
  assert.equal(
    await waits
      .getByRole("link", { name: "Fix: Add Claude" })
      .getAttribute("href"),
    "/app/settings/runtime",
  );
  assert.equal(
    await waits
      .getByRole("link", { name: "Fix: Open profile" })
      .getAttribute("href"),
    `/app/profiles/${claudeLead}/settings`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await waits.getByRole("button", { name: "Fix: Resume project" }).waitFor();
  assert.ok(await noHorizontalScroll(page));
  assert.equal(commands.length, 1);

  // A lost reply is an unknown outcome: the Fix leaves, and Check resends it exactly.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await waits.getByRole("button", { name: "Fix: Resume project" }).click();
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  const check = waits.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  assert.equal(await waits.getByRole("button", { name: /Resum/ }).count(), 0);
  await page.unroute("**/api/operator/commands");
  await check.click();
  await waits.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[2], commands[1]);
  assert.equal(d.project(claudeProject).paused, 0);
});
