import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { chromium, webkit, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { orderWaits, type Wait } from "../../src/operator/wait-reasons.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { guideForm } from "../fixtures/question-data.js";
import { seedOwnApproval, seedOwnQuestion } from "../fixtures/questions.js";
import { seedCatalog } from "../fixtures/operator-work.js";
import {
  seedImportedCommentTask,
  seedReviewTask,
  setLinkedRepository,
} from "../fixtures/task-review.js";
import {
  leadReceivesNotice,
  leadResumeNotice,
  leadUnavailableNotice,
} from "../../web/src/lead-feedback.js";
import { openTaskTab } from "../fixtures/task-tabs.js";

const test = browserSuite("ui-task-detail");
const testForEngine = (
  name: string,
  browserEngine: "chromium" | "webkit",
  action: (t: TestContext, journey: BrowserJourney) => Promise<void>,
) => test(name, { browserEngine }, action);
const body =
  "## Context\n\nLet keyboard users **open** the command menu. [docs](https://example.com/x) ![shot](https://example.com/a.png) <b>raw</b>\n\n```\n" +
  "a-very-long-unbroken-code-line-".repeat(12) +
  "\n```\n\n- [ ] Restore focus\n- [ ] Retain drafts\n- [ ] Announce results";

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

const taskTab = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "Task sections" })
    .getByRole("tab", { name, exact: true });
const selectedTab = (page: Page) =>
  page
    .locator('[role="tablist"] [aria-selected="true"]')
    .evaluate((e) => e.textContent);
const visiblePanels = (page: Page) =>
  page
    .locator('.task-workspace [role="tabpanel"]')
    .evaluateAll((panels) =>
      panels.filter((p) => !(p as HTMLElement).hidden).map((p) => p.id),
    );
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

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
  // The subtitle is the recorded desired outcome; the strip carries state and the lead.
  assert.match(
    (await header.locator(".page-header-title p").textContent()) ?? "",
    /^## Context/,
  );
  const strip = page.locator("[data-task-strip]");
  assert.match(
    (await strip.textContent()) ?? "",
    /Accountable lead · Task lead/,
  );
  assert.ok(
    ((await strip.locator("[data-task-readiness]").textContent()) ?? "")
      .length > 0,
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
  // Five tabs without counts; Overview is selected.
  const tabs = page
    .getByRole("tablist", { name: "Task sections" })
    .getByRole("tab");
  assert.deepEqual(await tabs.allTextContents(), [
    "Overview",
    "Files",
    "Changes",
    "Review",
    "History",
  ]);
  assert.equal(await tabs.first().getAttribute("aria-selected"), "true");
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

  // Decision card, brief and result stacked in one main column beside the inspector; the
  // document is the only scroller.
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
  assert.ok(card.y + card.height <= brief.y);
  assert.ok(brief.y + brief.height <= review.y, "the result follows the brief");
  const inspector = await box('aside[aria-label="Task context"]');
  assert.ok(brief.x + brief.width <= inspector.x, "inspector is beside");
  assert.ok(inspector.width <= 320);
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
  // Supplied prose renders as inert Markdown; the markers stay only in the disclosure.
  const prose = page.locator("#brief .brief-prose");
  assert.equal(
    await prose.getByRole("heading", { name: "Context" }).count(),
    1,
  );
  assert.equal(await prose.locator("strong").textContent(), "open");
  assert.equal(await prose.locator("pre").count(), 1);
  const proseText = await prose.innerText();
  assert.ok(!/##|\*\*/.test(proseText), proseText);
  assert.equal(await prose.locator("a, img, b").count(), 0);
  assert.ok(proseText.includes("[Image omitted: shot]"), proseText);
  assert.ok(
    !/all criteria|\d+ of \d+ criteria/i.test(
      await page.locator("#review").innerText(),
    ),
  );
  await page.locator("#brief details > summary").first().click();
  const disclosure = await page.locator("#brief details").first().innerText();
  for (const literal of ["## Context", "**open**", "- [ ] Restore focus"])
    assert.ok(disclosure.includes(literal), literal);
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
    "Please review criterion 9 in source revision 1.",
  );
  await page.getByLabel("Editable reply").fill("");

  // Entries move focus in place without a history entry; retained links stay.
  const before = await page.evaluate(() => history.length);
  for (const [name, id] of [
    ["Files", "files"],
    ["Changes", "changes"],
    ["Review", "local-review"],
  ] as const) {
    await openTaskTab(page, "Overview");
    await page.getByRole("link", { name, exact: true }).click();
    await page.waitForFunction(
      (id) => document.activeElement?.closest("section")?.id === id,
      id,
    );
    assert.equal(
      await page
        .getByRole("tab", { name, exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
  }
  assert.equal(await page.evaluate(() => history.length), before);
  for (const name of ["Advanced task controls", "Requests and coordination"])
    assert.equal(
      await page.getByRole("link", { name, exact: true }).count(),
      0,
    );
  assert.equal(
    await page.locator(".assignment-row").count(),
    4,
    "lead and three delegated assignments",
  );
  // The legacy pages are one History link, not a header button.
  const forms = page.getByRole("link", {
    name: "Approval and delivery forms",
    exact: true,
  });
  await openTaskTab(page, "History");
  assert.equal(await forms.count(), 1);
  assert.equal(
    await forms.getAttribute("href"),
    `/coordination/task/${a.taskId}`,
  );
  await openTaskTab(page, "Overview");
  assert.equal(await forms.count(), 0, "History carries the link alone");
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
  await openTaskTab(page, "Overview");
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
  // Columns and rails now fit one 1366 screen; widen them so the board still scrolls.
  await page.addStyleTag({
    content: ".board-columns .board-column{min-width:600px !important}",
  });
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
  await page
    .locator("#assignments")
    .getByText("No assignments yet.", { exact: true })
    .waitFor();
  await page
    .locator("#brief")
    .getByText("None supplied", { exact: true })
    .waitFor();
  assert.match(
    (await page.locator("[data-task-strip]").textContent()) ?? "",
    /Accountable lead · Unconfigured/,
  );
  await page
    .locator('aside[aria-label="Task context"]')
    .getByText("No results yet.", { exact: true })
    .waitFor();
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
  assert.equal(await selectedTab(page), "Overview");
  // Its evidence link opens History in place, as a fresh load of that link would.
  await page
    .getByRole("link", { name: "Question evidence", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('[role="tablist"] [aria-selected="true"]')
      ?.textContent?.includes("History"),
  );
  assert.deepEqual(await visiblePanels(page), ["task-panel-history"]);
});

test("A rejected completion is a decision the strip and decision card both name", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const { web, page } = await fixture.launch();
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.completionRequests = [
        {
          requestId: randomUUID(),
          taskId: a.taskId,
          leadAssignmentId: a.assignmentId,
          leadWorkId: "work",
          leadWorkRevision: 1,
          taskVersion: json.data.task.version,
          reviewedResultIds: [],
          status: "rejected",
          rejectionReasons: ["completion-rejected"],
          revision: 1,
          createdAt: 1,
          finalizedAt: null,
        },
      ];
      json.data.attention.codes = ["completion-rejected"];
      json.data.attention.count = 1;
      await route.fulfill({ response, json });
    },
  );
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/${a.taskId}?section=files`,
  );
  const next = page
    .locator("[data-task-strip]")
    .getByRole("button", { name: "Next: you · review rejected completion" });
  await next.click();
  const card = page.locator("section#decisions");
  assert.equal(
    await card
      .getByRole("link", { name: "Review rejected completion" })
      .getAttribute("href"),
    `/coordination/task/${a.taskId}`,
  );
  assert.equal(await card.getByText("No operator decision needed.").count(), 0);
});

test("The strip and decision card follow the server's attention codes, not a client derivation", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const { web, page } = await fixture.launch();
  let codes = ["execution-uncertain"];
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      // An uncertain execution only the server sees: idle, with no uncertainty hold.
      json.data.execution.state = "idle";
      json.data.execution.holds.uncertainty = false;
      json.data.attention.codes = codes;
      json.data.attention.count = codes.length;
      await route.fulfill({ response, json });
    },
  );
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const strip = page.locator("[data-task-strip]");
  await strip
    .getByRole("button", { name: "Next: you · inspect execution" })
    .click();
  const card = page.locator("section#decisions");
  assert.equal(
    await card
      .getByRole("link", { name: "Inspect uncertain execution" })
      .getAttribute("href"),
    `/runtime/task/${a.taskId}`,
  );
  // Ensemble records a routing fallback itself: plain text, never an operator button.
  codes = ["lead-review"];
  await page.reload();
  await strip
    .getByText("Next: Ensemble · recording routing fallback", { exact: true })
    .waitFor();
  assert.equal(
    await strip
      .getByRole("button", { name: /recording routing fallback/ })
      .count(),
    0,
  );
  // The decision card offers the operator nothing to do for it.
  assert.equal(
    await card
      .getByRole("link", { name: "Inspect uncertain execution" })
      .count(),
    0,
  );
});

for (const engine of [
  { name: "chromium", type: chromium },
  { name: "webkit", type: webkit },
] as const)
  testForEngine(
    `Stop confirms first, Keep running sends nothing, Stop task posts the retained form (${engine.name})`,
    engine.name,
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
        .evaluateAll((els) =>
          els.map((e) => e.getBoundingClientRect().toJSON()),
        );
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
        (await page.locator("[data-task-readiness]").textContent()) ?? "",
        /^Stopping; effects may continue/,
      );
    },
  );

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
  // A paused Codex-led project whose delegate's profile has been revoked.
  const codexLead = randomUUID(),
    revokedWorker = randomUUID(),
    delegateProject = randomUUID(),
    delegateTask = randomUUID();
  for (const [profileId, name] of [
    [codexLead, "Grace"],
    [revokedWorker, "Linus"],
  ] as const)
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name,
      instructions: "Work carefully",
      capabilities: "code",
    });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: delegateProject,
    name: "delegate-app",
    leadProfileId: codexLead,
  });
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: delegateProject,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [revokedWorker],
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: delegateProject,
    taskId: delegateTask,
    title: "Delegated task",
    outcome: "Probe",
    ready: true,
  });
  await f.service.provisionTask(delegateTask);
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: delegateProject,
    taskId: delegateTask,
    assignmentId: randomUUID(),
    profileId: revokedWorker,
    brief: "Delegated work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: revokedWorker,
    expectedVersion: Number(d.profile(revokedWorker).version),
    revoked: true,
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

  // Confirm sends exactly one project.configure and nothing else. The task read that clears
  // the wait is held, so the stale wait must not offer the Fix again beside the outcome.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const taskRead = new RegExp(`/api/operator/tasks/${taskId}(\\?.*)?$`);
  await page.route(taskRead, async (route) => {
    await held;
    await route.continue();
  });
  await fix.click();
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await waits.getByText("Project resumed.", { exact: true }).waitFor();
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor();
  assert.equal(
    await waits.getByRole("button", { name: "Fix: Resume project" }).count(),
    0,
  );
  assert.equal(commands.length, 1);
  release();
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

  // A revoked delegate profile is listed by its label and name, and its Fix opens that profile.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${web.origin}/app/tasks/${delegateTask}`);
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor();
  assert.deepEqual(await list.locator("> span:first-child").allInnerTexts(), [
    "Assignment profile revoked",
    "Assignment profile changed",
  ]);
  const revoked = list.nth(0);
  assert.equal(
    await revoked
      .getByRole("link", { name: "Fix: Open profile" })
      .getAttribute("href"),
    `/app/profiles/${revokedWorker}/settings`,
  );
  assert.equal(await revoked.locator(".wait-detail").innerText(), "Linus");
});

test("Holds stay listed beneath Fix: Resume project with what clears them and Execution details", async (_t, j) => {
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
    taskId = randomUUID();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "fixture-app",
    leadProfileId: null,
  });
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Add a health-check endpoint",
    outcome: "Probe",
    ready: true,
  });
  await f.service.stopTask(taskId);
  f.seedPersistedState((db) =>
    db
      .prepare("INSERT INTO task_archival_holds (taskId, reason) VALUES (?, ?)")
      .run(taskId, "Archival is awaiting review"),
  );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: Record<string, unknown>[] = [];
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
  const primary = waits.locator(".wait-primary");
  await primary
    .getByText("Also held · Resume project doesn't clear these", {
      exact: true,
    })
    .waitFor();
  const held = waits.getByRole("list", { name: "Also held", exact: true });
  const expectedLines = [
    "Operator Stop Clears when the task's Stop is resumed. Execution details",
    "Task hold Archival is awaiting review. Recovery stays blocked while it remains. Execution details",
  ];
  const lines = async () =>
    (await held.locator("li").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    );
  assert.deepEqual(await lines(), expectedLines);
  const links = held.getByRole("link", {
    name: "Execution details",
    exact: true,
  });
  assert.equal(await links.count(), 2);
  for (const href of await links.evaluateAll((a) =>
    a.map((x) => x.getAttribute("href")),
  ))
    assert.equal(href, `/runtime/task/${taskId}`);
  // Holds are never a Fix: no buttons and no Fix text inside the list.
  assert.equal(await held.getByRole("button").count(), 0);
  assert.equal(await held.getByText(/^Fix:/).count(), 0);
  assert.equal(
    await page.getByText(/hold — use exact recovery controls/).count(),
    0,
  );

  // The confirmation names exactly the holds that stay; Cancel sends nothing.
  const fix = waits.getByRole("button", { name: "Fix: Resume project" });
  await fix.click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText("Holds and access are unchanged.").waitFor();
  await dialog
    .getByText("The Operator Stop and task hold stay.", { exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(commands.length, 0);

  // Resume sends one project.configure; the stale read keeps the holds listed and no second Fix.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    new RegExp(`/api/operator/tasks/${taskId}(\\?.*)?$`),
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  await fix.click();
  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await waits.getByText("Project resumed.", { exact: true }).waitFor();
  assert.equal(commands.length, 1);
  assert.deepEqual(
    {
      type: commands[0]?.type,
      projectId: commands[0]?.projectId,
      paused: commands[0]?.paused,
    },
    { type: "project.configure", projectId, paused: false },
  );
  assert.deepEqual(await lines(), expectedLines);
  assert.equal(
    await waits.getByRole("button", { name: "Fix: Resume project" }).count(),
    0,
  );
  release();

  // After the re-read the paused wait is gone: the holds stay listed, with no heading.
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor({
    state: "detached",
  });
  assert.deepEqual(await lines(), expectedLines);
  assert.equal(await waits.getByText(/^Also held ·/).count(), 0);
  assert.equal(await held.getByRole("button").count(), 0);
  assert.equal(commands.length, 1);
  assert.equal(d.project(projectId).paused, 0);
  assert.ok(await noHorizontalScroll(page));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await noHorizontalScroll(page));
});

test("Task detail explains a held assignment, revoked repository access and unresolved recovery without sending anything", async (_t, j) => {
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
  const lead = randomUUID(),
    worker = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  for (const [profileId, name] of [
    [lead, "Grace"],
    [worker, "Linus"],
  ] as const)
    d.execute({
      type: "profile.create",
      actor: "operator",
      key: randomUUID(),
      profileId,
      name,
      instructions: "Work carefully",
      capabilities: "code",
    });
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "held-app",
    leadProfileId: lead,
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
  d.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Held task",
    outcome: "Probe",
    ready: true,
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId: worker,
    brief: "Delegated work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  // A failed reporting repair holds the assignment after its last turn completed.
  f.seedPersistedState((db) => {
    db.prepare("UPDATE domain_assignments SET state='held' WHERE id=?").run(
      assignmentId,
    );
    db.prepare(
      `INSERT INTO turn_requests (requestKey, workId, kind, taskId, projectId, assignmentId,
        taskVersion, assignmentVersion, instructionsRevision, profileRevision, prompt, state)
        VALUES ('done-key', 'done-work', 'assignment', ?, ?, ?, ?, ?, 1, 1, 'probe', 'completed')`,
    ).run(
      taskId,
      projectId,
      assignmentId,
      Number(d.task(taskId).version),
      Number(d.assignment(assignmentId).version),
    );
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
  const list = waits.locator(".wait-list li");
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor();
  assert.deepEqual(await list.locator("> span:first-child").allInnerTexts(), [
    "Assignment held",
  ]);
  assert.equal(await list.nth(0).locator(".wait-detail").innerText(), "Linus");

  // The scheduler-only causes, added to this task's read as the service would report them.
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.waits = orderWaits([
        ...(json.data.waits as Wait[]),
        {
          code: "repository-access-revoked",
          fix: { kind: "open-repositories", projectId },
          links: [],
        },
        {
          code: "assignment-recovery-unresolved",
          fix: null,
          links: [{ kind: "recovery", assignmentId, label: "Open recovery" }],
          detail: "Linus",
        },
      ]);
      await route.fulfill({ response, json });
    },
  );
  await page.reload();
  await waits.getByText("Waiting · Project paused", { exact: true }).waitFor();
  await list.nth(2).waitFor();
  assert.deepEqual(await list.locator("> span:first-child").allInnerTexts(), [
    "Repository access revoked",
    "Assignment held",
    "Assignment recovery unresolved",
  ]);
  assert.equal(
    await list
      .nth(0)
      .getByRole("link", { name: "Fix: Open repositories" })
      .getAttribute("href"),
    `/app/projects/${projectId}/settings?tab=github`,
  );
  const recovery = list.nth(2);
  assert.equal(
    await recovery
      .getByRole("link", { name: "Open recovery" })
      .getAttribute("href"),
    `/app/assignments/${assignmentId}/recovery`,
  );
  assert.equal(await recovery.getByText(/^Fix:/).count(), 0);
  assert.equal(await recovery.locator(".wait-detail").innerText(), "Linus");
  assert.deepEqual(commands, []);
});

test("An approval request opens the approval review, not the question form", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedOwnApproval(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  // The card lists the approval as a request; the merged approval wait is not repeated.
  const review = page
    .locator("section#decisions .decision")
    .getByRole("link", { name: "Review material & decide" });
  assert.equal(
    await review.getAttribute("href"),
    `/coordination/task/${a.taskId}#${a.interactionId}`,
  );
  await review.click();
  await page.waitForURL(
    (url) => url.pathname === `/coordination/task/${a.taskId}`,
  );
  // The coordination view decides the exact approval material.
  await page
    .getByRole("button", { name: "Approve this exact material" })
    .waitFor();
});

/** A signed-in page on a fresh fixture, with every command POST recorded. */
async function openFixture(
  j: BrowserJourney,
  engine: "chromium" | "webkit" = "chromium",
) {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  return {
    f,
    async launch(viewport = { width: 1366, height: 900 }) {
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start(`browser.launch.${engine}`, () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const page = await browser.newPage({ viewport });
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
      return { web, page, commands };
    },
  };
}

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `Task tabs follow the tab pattern, show one panel and send nothing (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const a = await seed(fixture.f);
      const { web, page, commands } = await fixture.launch();
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      const tabs = page
        .getByRole("tablist", { name: "Task sections" })
        .getByRole("tab");
      await tabs.first().waitFor();
      const before = await page.evaluate(() => history.length);
      // Every tab controls an existing panel, and only the selected one shows.
      for (const id of await tabs.evaluateAll((els) =>
        els.map((e) => e.getAttribute("aria-controls")),
      ))
        assert.equal(await page.locator(`#${id}[role="tabpanel"]`).count(), 1);
      assert.deepEqual(await visiblePanels(page), ["task-panel-overview"]);
      await taskTab(page, "Overview").focus();
      for (const [key, name] of [
        ["ArrowRight", "Files"],
        ["ArrowRight", "Changes"],
        ["ArrowLeft", "Files"],
        ["End", "History"],
        ["ArrowRight", "Overview"],
        ["ArrowLeft", "History"],
        ["Home", "Overview"],
      ] as const) {
        await page.keyboard.press(key);
        assert.equal(await selectedTab(page), name, key);
        assert.equal(
          await page.evaluate(() => document.activeElement?.textContent),
          name,
        );
        // Roving focus: only the selected tab is in the tab order.
        assert.deepEqual(
          await tabs.evaluateAll(
            (els) =>
              els.filter((e) => e.getAttribute("tabindex") === "0").length,
          ),
          1,
        );
        assert.equal((await visiblePanels(page)).length, 1);
        assert.deepEqual(await visiblePanels(page), [
          `task-panel-${name.toLowerCase()}`,
        ]);
      }
      // Switching tabs reads nothing new into history and sends no command.
      assert.equal(await page.evaluate(() => history.length), before);
      assert.deepEqual(commands, []);
      // A local task shows "Local task" and no source chip; no raw UUID is shown.
      const strip = page.locator("[data-task-strip]");
      assert.equal(await strip.locator(".task-id").innerText(), "Local task");
      assert.equal(await strip.locator(".task-source-chip").count(), 0);
      assert.doesNotMatch(
        await strip.innerText(),
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    },
  );

test("Task deep links open their tab on the first paint", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const { web, page } = await fixture.launch();
  // The tab selected when the tab list first reaches the page, before any paint.
  await page.addInitScript(() => {
    const w = window as unknown as { firstTab?: string | null };
    new MutationObserver((_m, observer) => {
      const tab = document.querySelector(
        '[role="tablist"] [aria-selected="true"]',
      );
      if (!tab) return;
      w.firstTab = tab.textContent;
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await taskTab(page, "Overview").waitFor();
  const read = await page.evaluate(
    (id) => fetch(`/api/operator/tasks/${id}`).then((r) => r.json()),
    a.taskId,
  );
  const message = read.data.messages[0]?.eventId as string | undefined;
  const cases: [string, string][] = [
    ["?section=files", "Files"],
    ["?section=local-review", "Review"],
    [`?assignment=${a.assignmentId}#history`, "History"],
    ["?path=notes.md", "Files"],
    ["?target=branch", "Changes"],
    [`?result=${a.result.resultId}`, "Overview"],
    ["#changes", "Changes"],
  ];
  if (message) cases.push([`?record=${message}`, "History"]);
  for (const [query, name] of cases) {
    await page.goto(`${web.origin}/app/tasks/${a.taskId}${query}`);
    await page
      .getByRole("heading", {
        name: "Ship an accessible command menu",
        level: 1,
      })
      .waitFor();
    await settle(page);
    assert.equal(await selectedTab(page), name, query);
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { firstTab?: string }).firstTab,
      ),
      name,
      `${query} first paint`,
    );
  }
  assert.ok(message, "the seeded task records a message to link to");
  // An expanded assignment link shows that assignment's history.
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?assignment=${a.assignmentId}#history`,
  );
  await page.locator("#history details[open]").first().waitFor();
});

test("Tab switches, Refresh task and polls keep the reply, expansions and each tab's reading position", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const { web, page, commands } = await fixture.launch({
    width: 1366,
    height: 700,
  });
  await page.clock.install();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page
    .getByRole("heading", { name: "Latest result", exact: true })
    .waitFor();
  // Persistent tools stay on every tab; the inspector is Overview's alone.
  for (const name of ["Overview", "Files", "Changes", "Review", "History"]) {
    await openTaskTab(page, name as "Overview");
    for (const tool of ["Advanced task controls", "Requests and coordination"])
      assert.equal(
        await page.getByRole("link", { name: tool, exact: true }).count(),
        0,
      );
    assert.ok(
      await page
        .getByRole("button", { name: "Refresh task", exact: true })
        .isVisible(),
    );
    assert.equal(
      await page.locator('aside[aria-label="Task context"]').isVisible(),
      name === "Overview",
    );
  }
  await openTaskTab(page, "Overview");
  // An expanded assignment, an unsent reply and a reading anchor on Overview.
  await page
    .getByRole("button", { name: /^Task lead · Produce the scoped/ })
    .first()
    .click();
  await page.locator("#history details[open]").first().waitFor();
  assert.equal(await selectedTab(page), "History");
  await openTaskTab(page, "Overview");
  await page.getByLabel("Editable reply").fill("Unsent reply");
  const anchor = page.locator(`[data-record-id="${a.result.resultId}"]`);
  await anchor.evaluate((e) => e.scrollIntoView());
  await page.evaluate(() => scrollBy(0, -40));
  const top = () => anchor.evaluate((e) => e.getBoundingClientRect().top);
  const anchorTop = await top();
  // Switch in place: a Playwright click would first scroll the tab list into view.
  const switchTo = (name: string) => taskTab(page, name).dispatchEvent("click");
  const kept = async (label: string) => {
    await switchTo("Overview");
    await settle(page);
    const after = await top();
    assert.ok(
      Math.abs(after - anchorTop) <= 1,
      `${label}: ${anchorTop} -> ${after}`,
    );
    assert.equal(
      await page.getByLabel("Editable reply").inputValue(),
      "Unsent reply",
    );
    assert.equal(await page.locator("#history details[open]").count(), 1);
  };
  await switchTo("Files");
  await kept("tab switch");
  await switchTo("Files");
  const reread = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/operator/tasks/${a.taskId}`,
  );
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .dispatchEvent("click");
  await reread;
  await settle(page);
  await kept("Refresh task on Files");

  // Each tab keeps its own scroll.
  await switchTo("History");
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const historyY = await page.evaluate(() => scrollY);
  assert.ok(historyY > 0, "History scrolls");
  await switchTo("Overview");
  const overviewY = await page.evaluate(() => scrollY);
  assert.notEqual(overviewY, historyY);
  await switchTo("History");
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - historyY) <= 1);
  await switchTo("Overview");
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - overviewY) <= 1);

  // A timer poll while History is open keeps its position and expansion.
  await switchTo("History");
  const polled = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/operator/tasks/${a.taskId}`,
  );
  await page.clock.runFor(15000);
  await polled;
  await settle(page);
  assert.equal(await selectedTab(page), "History");
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - historyY) <= 1);
  assert.equal(await page.locator("#history details[open]").count(), 1);
  await captureBrowserEvidence(page, "1366-task-detail-history", {
    fullPage: false,
  });

  // Leaving for another view and coming Back restores the tab and its scroll.
  await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .click();
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await page.goBack();
  await page.locator("#history details[open]").first().waitFor();
  await settle(page);
  assert.equal(await selectedTab(page), "History");
  assert.ok(Math.abs((await page.evaluate(() => scrollY)) - historyY) <= 1);
  await openTaskTab(page, "Overview");
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unsent reply",
  );

  // The inspector's results open in place: the earlier result fills the result card.
  const results = await page.evaluate(
    (id) =>
      fetch(`/api/operator/tasks/${id}`)
        .then((r) => r.json())
        .then((r) =>
          r.data.results.map((x: { resultId: string }) => x.resultId),
        ),
    a.taskId,
  );
  const inspector = page.locator('aside[aria-label="Task context"]');
  const links = inspector.getByRole("link", { name: /^Result \d/ });
  assert.deepEqual(
    (await links.allTextContents()).map((t) => t.split(" · ")[0]),
    ["Result 2", "Result 1"],
  );
  const before = await page.evaluate(() => history.length);
  await links.last().click();
  await page.waitForFunction(
    () => document.activeElement?.closest("section")?.id === "review",
  );
  assert.equal(
    await page.locator("#retained-result-revision").inputValue(),
    results[0],
  );
  assert.equal(await page.evaluate(() => history.length), before);
  assert.deepEqual(commands, []);
});

test("An open approval leads Overview and stays reachable from every tab through the strip", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedOwnApproval(fixture.f);
  const { web, page, commands } = await fixture.launch();
  // The approval is hidden from the first reads, so it can arrive while Files is open.
  let hide = true;
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (hide) {
        json.data.approvals = [];
        json.data.attention.codes = json.data.attention.codes.filter(
          (code: string) => code !== "approval",
        );
      }
      // An independent hold the approval does not clear.
      else json.data.admission.reasons.push("task-unready");
      await route.fulfill({ response, json });
    },
  );
  await page.clock.install();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const strip = page.locator("[data-task-strip]");
  await strip.getByText("No operator decision", { exact: true }).waitFor();
  await openTaskTab(page, "Files");
  const files = taskTab(page, "Files");
  await files.focus();
  hide = false;
  const polled = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/operator/tasks/${a.taskId}`,
  );
  await page.clock.runFor(15000);
  await polled;
  const next = strip.getByRole("button", {
    name: "Next: you · review material & decide",
  });
  await next.waitFor();
  assert.equal(await next.getAttribute("data-operator"), "true");
  // The arriving request moves neither the tab nor the focus.
  assert.equal(await selectedTab(page), "Files");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Files",
  );
  // The strip's button opens Overview at the decision card.
  await next.click();
  await page.waitForFunction(
    () => document.activeElement?.closest("#decisions") !== null,
  );
  assert.equal(await selectedTab(page), "Overview");

  // The decision card leads with the approval and decides nothing itself.
  const card = page.locator("section#decisions");
  assert.equal(await card.getAttribute("data-attention"), "true");
  const decision = card.locator(".decision").first();
  assert.match(await decision.innerText(), /^Your decision · approval pending/);
  const text = await decision.innerText();
  for (const fact of [a.request.action, a.request.target, "revision"])
    assert.ok(text.includes(fact), `${fact} in ${text}`);
  assert.match(text, /Exact reviewed material: /);
  assert.equal(
    await decision
      .getByRole("link", { name: "Review material & decide" })
      .getAttribute("href"),
    `/coordination/task/${a.taskId}#${a.interactionId}`,
  );
  assert.equal(
    await card.getByRole("button", { name: /Approve|Deny/ }).count(),
    0,
  );
  // The hold the approval does not clear follows it once, inside the card.
  const holds = card.locator(".question-holds");
  assert.equal(await holds.count(), 1);
  assert.match(await holds.innerText(), /Approving does not clear it\./);
  // The approval is already the card's own row, so its merged hold is not listed again.
  assert.doesNotMatch(await holds.innerText(), /approval needs a decision/);
  assert.ok(
    await decision.evaluate(
      (d, h) =>
        Boolean(
          h && d.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await holds.elementHandle(),
    ),
  );
  // The state mark is a symbol and a word in the state's colour.
  const mark = strip.locator(".task-state");
  assert.ok(await mark.locator("svg").isVisible());
  assert.equal(await mark.innerText(), await mark.getAttribute("data-column"));

  // Overview stacks the cards in one column beside the inspector.
  const box = async (selector: string) => {
    const b = await page.locator(selector).boundingBox();
    assert.ok(b, selector);
    return b;
  };
  const order = [
    "section#decisions",
    "section#brief",
    "section#review",
    "section#assignments",
    "section#reply",
  ];
  const boxes = await Promise.all(order.map(box));
  for (let i = 1; i < boxes.length; i++)
    assert.ok(
      boxes[i - 1]!.y + boxes[i - 1]!.height <= boxes[i]!.y,
      String(order[i]),
    );
  const inspector = page.locator('aside[aria-label="Task context"]');
  const aside = await box('aside[aria-label="Task context"]');
  assert.ok(boxes[0]!.x + boxes[0]!.width <= aside.x);
  assert.ok(aside.width <= 320);
  assert.ok(await noHorizontalScroll(page));
  // Holds lists the pending approval; nothing the read lacks is invented.
  await inspector.getByText(/^Approval pending/).waitFor();
  assert.match(await inspector.innerText(), /Approval pending · Next: you/);
  const inspected = await inspector.innerText();
  for (const absent of [/Updated/, /Unblocks/, /Last turn/, /Workspace/])
    assert.doesNotMatch(inspected, absent);
  assert.match((await inspector.textContent()) ?? "", /Results & artifacts/);

  // The assignments table keeps a row per assignment and opens its history.
  const table = page.locator("section#assignments table");
  assert.deepEqual(await table.locator("th[scope=col]").allTextContents(), [
    "Assignment",
    "Requested by → result to",
    "Known state",
  ]);
  assert.equal(
    await table.locator(".assignment-row").count(),
    await page.evaluate(
      (id) =>
        fetch(`/api/operator/tasks/${id}`)
          .then((r) => r.json())
          .then((r) => r.data.assignments.length as number),
      a.taskId,
    ),
  );
  await page.evaluate(() => scrollTo(0, 0));
  await captureBrowserEvidence(page, "1366-task-detail", { fullPage: false });

  await page.setViewportSize({ width: 1024, height: 900 });
  const tablet = await box('aside[aria-label="Task context"]'),
    tabletMain = await box(".task-columns");
  assert.ok(tabletMain.x + tabletMain.width <= tablet.x, "beside at 1024");

  // Phone: one column, the inspector after the reply, 44px assignment buttons.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  const phoneReply = await box("section#reply"),
    phoneAside = await box('aside[aria-label="Task context"]'),
    phoneCard = await box("section#decisions"),
    phoneBrief = await box("section#brief");
  assert.ok(phoneCard.y + phoneCard.height <= phoneBrief.y);
  assert.ok(phoneReply.y + phoneReply.height <= phoneAside.y);
  for (const b of await table
    .locator(".assignment-row button")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height)))
    assert.ok(b >= 44, `assignment button ${b}`);
  assert.ok(await noHorizontalScroll(page));
  assert.ok(
    await page
      .getByRole("tablist", { name: "Task sections" })
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    "the tab list fits at 390",
  );
  await captureBrowserEvidence(page, "390-task-detail", { fullPage: false });
  assert.deepEqual(commands, []);
});

test("An imported task separates read-only GitHub source from Ensemble execution", async (_t, j) => {
  const fixture = await openFixture(j);
  const ids = await seedCatalog(fixture.f);
  fixture.f.service.githubSources().reconcileBlockers("I-UI03", {
    complete: true,
    blockers: [
      {
        providerInstance: "github.com",
        nodeId: "B-UI03",
        repositoryId: "R-OUT",
        repositoryName: "outside/repo",
        number: 7,
        title: "Outside blocker",
        body: "",
        state: "open",
        labels: [],
        projectFields: [],
      },
    ],
    reason: null,
  });
  const { web, page, commands } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${ids.importedId}`);
  const strip = page.locator("[data-task-strip]");
  await strip.locator(".task-source-chip").waitFor();
  const read = await page.evaluate(
    (id) => fetch(`/api/operator/tasks/${id}`).then((r) => r.json()),
    ids.importedId,
  );
  assert.equal(
    await strip.locator(".task-id").innerText(),
    "fixture/source#42",
  );
  const chip = strip.locator(".task-source-chip");
  assert.equal(await chip.innerText(), "Imported · fixture/source#42 ↗");
  assert.equal(await chip.getAttribute("href"), read.data.source.url);
  assert.doesNotMatch(
    await strip.innerText(),
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  );
  assert.match(
    await page.locator("#brief .task-provenance").innerText(),
    /Requirements · GitHub/i,
  );

  const inspector = page.locator('aside[aria-label="Task context"]');
  const github = inspector.locator(".inspector-group").first();
  assert.equal(
    await github.locator(".inspector-label").first().textContent(),
    "GitHub source · read-only",
  );
  const source = (await github.textContent()) ?? "";
  assert.match(source, /fixture\/source#42/);
  assert.match(source, /Issue open · (synced \S+|no successful sync)/);
  assert.match(
    source,
    /GitHub owns the issue\. Ensemble coordinates the work\./,
  );
  assert.match(source, /Dependencies · managed in GitHub/);
  assert.match(source, /outside\/repo#7\s*Open blocker/);
  assert.match(source, /GitHub commenting (permitted|unavailable)/);
  // Nothing in the GitHub group can write.
  assert.equal(
    await github.locator("button, form, input, textarea").count(),
    0,
  );
  assert.equal(
    await inspector.locator(".inspector-divider").textContent(),
    "Ensemble execution",
  );
  assert.match(
    await strip.locator("[data-task-readiness]").innerText(),
    /waiting on outside\/repo#7/,
  );
  await captureBrowserEvidence(page, "1366-task-detail-imported", {
    fullPage: false,
  });
  // A partial sync is named beside the last successful one.
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${ids.importedId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      for (const m of json.data.source.memberships)
        m.sync = { ...m.sync, complete: false, reasonCode: "partial-sync" };
      await route.fulfill({ response, json });
    },
  );
  await page.reload();
  await github.getByText(/· partial sync$/).waitFor();
  await page.unrouteAll({ behavior: "wait" });
  await page.reload();
  await github.getByText(/^Issue open/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  assert.ok(await noHorizontalScroll(page));
  await captureBrowserEvidence(page, "390-task-detail-imported", {
    fullPage: false,
  });

  // A local task shows neither the GitHub group nor its note.
  await page.goto(`${web.origin}/app/tasks/${ids.ready}`);
  await page.locator('aside[aria-label="Task context"]').waitFor();
  assert.equal(
    await page.getByText("GitHub owns the issue.", { exact: false }).count(),
    0,
  );
  assert.equal(await page.locator(".inspector-divider").count(), 0);
  assert.deepEqual(commands, []);
});

test("A question opened on the task page keeps the holds an answer does not clear", async (_t, j) => {
  const fixture = await openFixture(j);
  const q = await seedOwnQuestion(fixture.f, guideForm);
  const { web, page } = await fixture.launch();
  // An independent hold beside the open question; later also an open approval.
  let withApproval = false;
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${q.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.admission.reasons.push("task-unready");
      if (withApproval) {
        const interactionId = randomUUID();
        json.data.approvals.push({
          ...json.data.questions[0],
          interactionId,
          kind: "approval",
          status: "open",
        });
        json.data.waits.push({
          code: "approval",
          fix: null,
          links: [{ kind: "request", id: interactionId, label: "Review" }],
        });
      }
      await route.fulfill({ response, json });
    },
  );
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/${q.taskId}?request=${q.interactionId}`,
  );
  const form = page.getByRole("region", { name: "Exact question response" });
  await form.getByText("Recommended by Task lead", { exact: true }).waitFor();
  const holds = page.locator("section#decisions .question-holds");
  await holds.first().waitFor();
  // Once, in the decision card after the selected question, in the answer's wording.
  assert.equal(await holds.count(), 1);
  assert.ok(
    await form.evaluate(
      (f, h) =>
        Boolean(
          h && f.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await holds.elementHandle(),
    ),
  );
  assert.match(await holds.innerText(), /Answering does not clear it\./);
  // An approval open beside the selected question keeps the question's wording.
  withApproval = true;
  await page.reload();
  await page
    .locator("section#decisions .decision")
    .getByText("Your decision · approval pending")
    .waitFor();
  assert.equal(await holds.count(), 1);
  assert.match(await holds.innerText(), /Answering does not clear it\./);
  // The approval is a "Your decision" row and an inspector row already, so it is not also a hold.
  const aside = page.getByRole("complementary", { name: "Task context" });
  await aside.getByText("Approval pending").waitFor();
  assert.equal(await aside.getByText(/approval needs a decision/).count(), 0);
  assert.doesNotMatch(
    await holds.innerText(),
    /Approving|approval needs a decision/,
  );
});

/** Serves the task read with these open approvals, joined into the one `approval` wait as the server does. */
async function serveApprovals(page: Page, taskId: string, ids: string[]) {
  await page.unrouteAll();
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const [first] = json.data.approvals;
      json.data.approvals = ids.map((id) => ({
        ...first,
        interactionId: id,
        status: "open",
      }));
      json.data.waits = [
        ...json.data.waits.filter((w: Wait) => w.code !== "approval"),
        {
          code: "approval",
          fix: null,
          links: ids.map((id) => ({
            kind: "request",
            id,
            label: "Review material & decide",
          })),
        },
      ];
      await route.fulfill({ response, json });
    },
  );
}

const approvalHold = "Execution held (approval needs a decision)";

test("The decision card and inspector list only the other open approvals as holds", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedOwnApproval(fixture.f);
  const { web, page } = await fixture.launch();
  const other = randomUUID();
  await serveApprovals(page, a.taskId, [a.interactionId, other]);
  await signIn(
    page,
    web.origin,
    web.password,
    `/app/tasks/${a.taskId}?request=${a.interactionId}`,
  );
  const holds = page.locator("section#decisions .question-holds"),
    aside = page.getByRole("complementary", { name: "Task context" }),
    card = page.locator("section#decisions"),
    // The merged approval wait, which the card's rows and hold line already cover.
    waitLabel = /Approval needs a decision/;
  // Two open approvals, one in view: the other is the hold, once on each surface.
  await holds.getByText(approvalHold, { exact: true }).waitFor();
  assert.equal(await holds.getByText(approvalHold).count(), 1);
  // Two request rows, the paused project and the other approval.
  await aside.getByText("Holds · 4", { exact: true }).waitFor();
  assert.equal(await aside.getByText(approvalHold).count(), 1);
  assert.equal(await card.getByText(approvalHold).count(), 1);
  assert.equal(await card.getByText(waitLabel).count(), 0);

  // Only the approval in view: it is not a hold on itself.
  await serveApprovals(page, a.taskId, [a.interactionId]);
  await page.reload();
  await aside.getByText("Holds · 2", { exact: true }).waitFor();
  assert.equal(await page.getByText(approvalHold).count(), 0);
  assert.equal(await card.getByText(waitLabel).count(), 0);

  // Nothing selected: both approvals are rows already, so neither surface repeats them as a hold.
  await serveApprovals(page, a.taskId, [a.interactionId, other]);
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await aside.getByText("Holds · 3", { exact: true }).waitFor();
  assert.equal(await aside.getByText("Approval pending").count(), 2);
  assert.equal(await page.getByText(approvalHold).count(), 0);
  assert.equal(await card.getByText(waitLabel).count(), 0);
});

const refreshTask = async (page: Page, taskId: string) => {
  const reread = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/operator/tasks/${taskId}`,
  );
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await reread;
};
/** The text of every paragraph between the destination buttons and the reply label. */
const sentencesAboveReply = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector("#reply")!;
    const out: string[] = [];
    for (
      let node = card.querySelector(".task-actions")!.nextElementSibling;
      node && node.tagName !== "LABEL";
      node = node.nextElementSibling
    )
      out.push(`${node.tagName}:${node.textContent}`);
    return out;
  });

test("A local task without a repository shows no GitHub reply or delivery lines", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Fieldnotes",
    "Local task",
    "Write the guide.",
  );
  a.result("Guide drafted");
  const { web, page, commands } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page
    .getByRole("heading", { name: "Latest result", level: 3 })
    .waitFor();
  const inspector = page.locator('aside[aria-label="Task context"]');
  const delivery = inspector.locator("dt", { hasText: /^Delivery$/ });
  const github = page.getByRole("button", { name: "Post GitHub comment" });
  const refreshDelivery = page.getByRole("button", {
    name: "Refresh delivery status",
  });
  assert.equal(await github.count(), 0);
  assert.equal(await delivery.count(), 0);
  await openTaskTab(page, "Changes");
  assert.equal(await refreshDelivery.count(), 0);
  assert.equal(await page.locator("#changes h3").innerText(), "Changes");

  // The project gains a repository while the page is open: Refresh shows delivery, keeps the draft.
  await openTaskTab(page, "Overview");
  await page.getByLabel("Editable reply").fill("Keep this draft");
  setLinkedRepository(fixture.f, a.projectId, true);
  await refreshTask(page, a.taskId);
  await delivery.waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Keep this draft",
  );
  assert.equal(await github.count(), 0);
  await openTaskTab(page, "Changes");
  await refreshDelivery.waitFor();
  assert.equal(
    await page.locator("#changes h3").innerText(),
    "Changes and delivery",
  );

  // A local task's Send is a lead message, never a comment.
  await openTaskTab(page, "Overview");
  await page.getByRole("button", { name: "Send to task lead" }).click();
  await page.getByText("Sent.", { exact: false }).first().waitFor();
  assert.deepEqual(
    commands.map((c) => {
      const command = c as Record<string, unknown>;
      return [command.type, command.message, command.recipientAssignmentId];
    }),
    [["message", "Keep this draft", a.assignmentId]],
  );
});

test("The reply box has one sentence above it", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Fieldnotes",
    "Local task",
    "Write the guide.",
  );
  a.result("Guide drafted");
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page.getByLabel("Editable reply").waitFor();
  // The lead completed its assignment, so a message resumes it.
  const resumes = leadResumeNotice("Task lead");
  assert.deepEqual(await sentencesAboveReply(page), [`P:${resumes}`]);
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /Local Ensemble inbox|Sending does not bypass/,
  );

  // The immutable reference sits below the box; one sentence still sits above.
  await page.getByRole("button", { name: "Ask lead about result" }).click();
  const reference = page.getByText(/^Immutable reference:/);
  await reference.waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [`P:${resumes}`]);
  assert.equal(
    await page
      .getByLabel("Editable reply")
      .evaluate((box) =>
        Boolean(
          box.compareDocumentPosition(
            [...document.querySelectorAll("#reply p")].find((p) =>
              p.textContent?.startsWith("Immutable reference:"),
            )!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
    true,
  );

  // The server's other modes each replace that one sentence and keep the draft.
  await page.getByLabel("Editable reply").fill("Keep this draft");
  let mode: "receives" | "unavailable" = "receives";
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.leadFeedback = { mode, awaitingRecoveryMessage: false };
      await route.fulfill({ response, json });
    },
  );
  await refreshTask(page, a.taskId);
  await page
    .getByText(leadReceivesNotice("Task lead"), { exact: true })
    .waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [
    `P:${leadReceivesNotice("Task lead")}`,
  ]);
  mode = "unavailable";
  await refreshTask(page, a.taskId);
  await page
    .getByText(leadUnavailableNotice("Task lead"), { exact: true })
    .waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [
    `P:${leadUnavailableNotice("Task lead")}`,
  ]);
  assert.equal(
    await page.getByRole("button", { name: "Send to task lead" }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Keep this draft",
  );
  await page.unrouteAll({ behavior: "wait" });
});

test("A project without a lead says so above the reply box", async (_t, j) => {
  const fixture = await openFixture(j);
  const d = fixture.f.service.domain(),
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
    title: "Leadless task",
    outcome: "Write the field notes guide.",
    ready: false,
  });
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${taskId}`);
  await page.getByLabel("Editable reply").waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [
    "P:This project has no lead to message yet.",
  ]);
  assert.equal(
    await page.getByRole("button", { name: "Post GitHub comment" }).count(),
    0,
  );
});

test("The GitHub reply says what posting does in one sentence and keeps its draft when the policy changes", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedImportedCommentTask(fixture.f, "approval");
  const { web, page, commands } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page.getByRole("button", { name: "Post GitHub comment" }).click();
  await page.getByLabel("Editable reply").fill("Exact comment body");
  assert.deepEqual(await sentencesAboveReply(page), [
    "P:You review the exact comment before it posts to the GitHub issue.",
  ]);

  a.setGrant("allow");
  await refreshTask(page, a.taskId);
  await page
    .getByText("Posts a comment on the GitHub issue.", { exact: true })
    .waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [
    "P:Posts a comment on the GitHub issue.",
  ]);

  // The grant goes away after GitHub was selected: the reason replaces the sentence.
  a.setGrant(null);
  await refreshTask(page, a.taskId);
  await page
    .getByText("No project grant for issue comments.", { exact: true })
    .waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [
    "P:No project grant for issue comments.",
  ]);
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Post GitHub comment" })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact comment body",
  );
  assert.deepEqual(commands, []);
});
