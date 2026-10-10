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
  const reread = page.waitForResponse((r) =>
    r.url().includes(`/api/operator/tasks/${a.taskId}`),
  );
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await reread;
  await expanded.waitFor();
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
  await page.locator(`[data-task-id="${a.taskId}"] .task-title`).click();
  const back = page.getByRole("link", {
    name: "Back to originating view",
    exact: true,
  });
  await back.waitFor();
  assert.equal(await back.innerText(), "Board");
  const length = await page.evaluate(() => history.length);
  await back.click();
  await page.waitForURL(
    (u) => u.pathname === "/app/tasks" && u.search === "?view=board",
  );
  assert.equal(await page.evaluate(() => history.length), length);
  // Until a task read lands, the header reads "Task" rather than an earlier report.
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await page
    .getByRole("heading", { name: "Ship an accessible command menu", level: 1 })
    .waitFor();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/operator/tasks/${a.taskId}`, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.reload();
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
      "Holds queued and new turns for the lead and every delegated assignment.",
      "Requests cancellation of active turns. Effects may continue after the observation window.",
      "Stop, writer and capacity holds stay until termination is verified. Resume clears only Stop.",
      "Stop is not cancellation or completion. Files, history and results are kept.",
    ])
      assert.ok(text.includes(line), `${line} in ${text}`);
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
    await dialog.getByRole("button", { name: "Stop task" }).click();
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
