import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  chromium,
  webkit,
  type Browser,
  type Locator,
  type Page,
} from "playwright";
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
import {
  openOverviewCard,
  openTaskTab,
  overviewCard,
} from "../fixtures/task-tabs.js";
import { clockLabel } from "../../web/src/presentation.js";

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
  // The subtitle is the outcome's first line; the strip carries state and the lead.
  assert.equal(
    await header.locator(".page-header-title p.introduction").textContent(),
    "Context",
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
  // Exactly three header actions (Execution, Reset task, Stop), and the direct-load Back names the project.
  assert.deepEqual(
    await header
      .locator(".task-header-actions > *")
      .evaluateAll((els) => els.map((e) => [e.tagName, e.textContent])),
    [
      ["A", "Execution"],
      ["BUTTON", "Reset task…"],
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
    review = await box("section#review"),
    reply = await box("section#reply"),
    brief = await box("section#brief");
  assert.ok(card.y + card.height <= review.y);
  assert.ok(
    review.y + review.height <= reply.y,
    "the reply follows the result",
  );
  assert.ok(reply.y + reply.height <= brief.y, "the brief follows the reply");
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

  // The brief starts closed; its summary carries the label and the supplied-criteria count.
  assert.equal(await overviewCard(page, "brief").getAttribute("open"), null);
  assert.match(
    (await overviewCard(page, "brief").locator("> summary").textContent()) ??
      "",
    /Shared brief.*Requirements · Local · 3 supplied criteria/,
  );
  await openOverviewCard(page, "brief");
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
  await page.locator("#brief details[data-record-id] > summary").click();
  const disclosure = await page
    .locator("#brief details[data-record-id]")
    .innerText();
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

  // Overview repeats none of the other tabs: no in-page entries to them.
  assert.equal(
    await page.locator('nav[aria-label="Task material"]').count(),
    0,
  );
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
  // The retained task editor is one History link, not a header button; the coordination pages are gone.
  const forms = page.getByRole("link", {
    name: "Edit task and review source",
    exact: true,
  });
  await openTaskTab(page, "History");
  assert.equal(await forms.count(), 1);
  assert.equal(await forms.getAttribute("href"), `/task/${a.taskId}`);
  assert.equal(await page.locator('a[href^="/coordination/"]').count(), 0);
  await openTaskTab(page, "Overview");
  assert.equal(await forms.count(), 0, "History carries the link alone");
  await page.evaluate(() => scrollTo(0, 0));
  await captureBrowserEvidence(page, "task-detail-desktop", {
    fullPage: false,
  });

  // Expanded history and an unsent reply survive a refresh.
  await openOverviewCard(page, "assignments");
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

  // Phone: Back stays in the first viewport at 44px; Execution and Stop… are in the one
  // Task actions disclosure, also at 44px; one column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await header.locator(".task-header-overflow-toggle").click();
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
  const phoneReview = await box("section#review"),
    phoneBrief = await box("section#brief");
  assert.ok(phoneReview.y + phoneReview.height <= phoneBrief.y);
  assert.ok(await noHorizontalScroll(page));
  await captureBrowserEvidence(page, "task-detail-phone", { fullPage: false });
  await page.getByLabel("Editable reply").waitFor();
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
  await signIn(
    page,
    web.origin,
    web.password,
    "/app/tasks?view=board&ready=any",
  );
  const card = page.locator(`[data-task-id="${a.taskId}"] .task-title`);
  await card.waitFor();
  // Columns and rails now fit one 1366 screen; widen them so the board still scrolls.
  await page.addStyleTag({
    content: ".board-columns .board-column{min-width:600px !important}",
  });
  const board = page.locator(".board-columns");
  // The card sits in the first column, off screen at this scroll. A pointer click would first
  // scroll the board to it. Leave in the same turn as the scroll, before its event can save it.
  const boardScroll = await card.evaluate((el) => {
    const area = el.closest<HTMLElement>(".board-columns")!;
    area.scrollLeft = area.scrollWidth;
    const offset = area.scrollLeft;
    (el as HTMLElement).focus({ preventScroll: true });
    (el as HTMLElement).click();
    return offset;
  });
  assert.ok(boardScroll > 0, "the board scrolls horizontally");
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
  // A new tab reads about:blank until its navigation commits.
  await tab.waitForURL((u) => u.protocol === "http:");
  assert.equal(new URL(tab.url()).search, "?view=board&ready=any");
  await tab.close();
  assert.equal(page.url(), taskUrl);
  const length = await page.evaluate(() => history.length);
  await back.click();
  await page.waitForURL(
    (u) => u.pathname === "/app/tasks" && u.search === "?view=board&ready=any",
  );
  assert.equal(await page.evaluate(() => history.length), length);
  await card.waitFor();
  assert.equal(await board.evaluate((e) => e.scrollLeft), boardScroll);
  // Sidebar search submits through the shell's navigation callback, not its link handler.
  const searchScroll = await board.evaluate((e) => {
    e.scrollLeft = 150;
    const offset = e.scrollLeft;
    document
      .querySelector<HTMLFormElement>(".sidebar .search-work")!
      .requestSubmit();
    return offset;
  });
  await page.waitForURL((u) => u.pathname === "/app/search");
  assert.equal(await page.evaluate(() => history.state?.board), undefined);
  await page.goBack();
  await card.waitFor();
  assert.equal(await board.evaluate((e) => e.scrollLeft), searchScroll);
  // With the sidebar hidden, Search work's shortcut navigates directly to Search.
  await page.setViewportSize({ width: 1024, height: 900 });
  const shortcutScroll = await board.evaluate((e) => {
    e.scrollLeft = 300;
    const offset = e.scrollLeft;
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    return offset;
  });
  assert.ok(shortcutScroll > 0 && shortcutScroll !== searchScroll);
  await page.waitForURL((u) => u.pathname === "/app/search");
  assert.equal(await page.evaluate(() => history.state?.board), undefined);
  await page.goBack();
  await card.waitFor();
  assert.equal(await board.evaluate((e) => e.scrollLeft), shortcutScroll);
  await page.setViewportSize({ width: 1366, height: 900 });
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
  // A one-line outcome is the whole recorded subtitle. On a phone the header carries the
  // identity instead, so the strip's disclosure is where the outcome is read.
  assert.equal(
    await page.locator(".page-header-title p.introduction").textContent(),
    "Write the field notes guide.",
  );
  assert.equal(
    await page.locator(".page-header-title p.introduction").isVisible(),
    false,
  );
  assert.equal(
    await page.locator(".page-subtitle-short").textContent(),
    "Local task",
  );
  const phoneOutcome = page.locator("details.task-outcome[data-phone-only]");
  await phoneOutcome.locator("summary").click();
  await phoneOutcome.getByText("Write the field notes guide.").waitFor();
  await openOverviewCard(page, "assignments");
  await page
    .locator("#assignments")
    .getByText("No assignments yet.", { exact: true })
    .waitFor();
  await openOverviewCard(page, "brief");
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
  await card.getByText(/completion request was rejected/).waitFor();
  assert.equal(
    await card
      .getByRole("link", { name: "Message the lead" })
      .getAttribute("href"),
    `/app/tasks/${a.taskId}?section=reply`,
  );
  assert.equal(await page.locator('a[href^="/coordination/"]').count(), 0);
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
      await page.locator(".task-header-overflow-toggle").click();
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
    "/app/settings/runtime#add-claude",
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
    `/app/tasks/${a.taskId}?request=${a.interactionId}`,
  );
  await review.click();
  // The task's request view shows the exact material and decides it in place.
  const panel = page.locator(
    `.approval-review[data-record-id="${a.interactionId}"]`,
  );
  await panel
    .getByRole("button", { name: "Approve this exact material" })
    .waitFor();
  assert.equal(await page.locator(".question-response").count(), 0);
  assert.deepEqual(
    await panel.locator(".approval-material-fields dt").allInnerTexts(),
    ["scope"],
  );
  // Deny records once, then the panel reads back the decision with no controls left.
  await panel.getByRole("button", { name: "Deny", exact: true }).click();
  await panel.getByText(/^Denied\. Nothing was approved/).waitFor();
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).approvals[0]!.status,
    "denied",
  );
  await panel.getByText("Denied", { exact: true }).waitFor();
  assert.equal(
    await panel.getByRole("button", { name: /Approve|Deny/ }).count(),
    0,
  );
});

test("A recovery approval shows its exact material and a GitHub compare link, and never a foreign link", async (_t, j) => {
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
  const compare = `https://github.com/acme/app/compare/${"a".repeat(40)}...${"b".repeat(40)}`;
  const material = {
    kind: "branch.adopt",
    target: { repositoryId: "R1" },
    branch: "ensemble/aaaa1111-ship-it",
    outsideHeadSha: "b".repeat(40),
    lastPushedSha: "a".repeat(40),
  };
  let link: string | undefined = compare;
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.approvals[0].material = material;
      if (link) json.data.approvals[0].compareUrl = link;
      await route.fulfill({ response, json });
    },
  );
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?request=${a.interactionId}`,
  );
  const panel = page.locator(
    `.approval-review[data-record-id="${a.interactionId}"]`,
  );
  const anchor = panel.getByRole("link", { name: /Compare on GitHub/ });
  await anchor.waitFor();
  assert.equal(await anchor.getAttribute("href"), compare);
  assert.equal(await anchor.getAttribute("rel"), "noopener noreferrer");
  assert.deepEqual(
    await panel.locator(".approval-material-fields dt").allInnerTexts(),
    ["kind", "target", "branch", "outsideHeadSha", "lastPushedSha"],
  );
  // No link without server-verified repository naming.
  link = undefined;
  await page.reload();
  await panel
    .getByRole("button", { name: "Approve this exact material" })
    .waitFor();
  assert.equal(
    await panel.getByRole("link", { name: /Compare on GitHub/ }).count(),
    0,
  );
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
  await openOverviewCard(page, "assignments");
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
  const links = inspector.getByRole("link", { name: /^R\d/ });
  assert.deepEqual(
    (await links.allTextContents()).map((t) => t.split(" · ")[0]),
    ["R2", "R1"],
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
    `/app/tasks/${a.taskId}?request=${a.interactionId}`,
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
    "section#review",
    "section#reply",
    "section#brief",
    "section#assignments",
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
  await openOverviewCard(page, "assignments");
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
    (await overviewCard(page, "brief").locator("> summary").innerText()) ?? "",
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
  // The sync time reads as the app's clock label, computed in the page's own timezone.
  const syncedAt = read.data.source.memberships
    .map(
      (m: { sync: { lastSuccessfulAt: string | null } }) =>
        m.sync.lastSuccessfulAt,
    )
    .filter((t: string | null): t is string => t !== null)
    .sort()
    .at(-1);
  assert.ok(syncedAt, "the fixture records a successful sync");
  const clock = await page.evaluate((iso) => {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }, syncedAt);
  assert.match(source, new RegExp(`Issue open · synced ${clock}(?!\\d|:)`));
  assert.doesNotMatch(source, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.match(
    source,
    /GitHub owns the issue\. Ensemble coordinates the work\./,
  );
  assert.match(source, /Dependencies · managed in GitHub/);
  assert.match(source, /outside\/repo#7\s*Open blocker/);
  assert.match(source, /GitHub commenting (permitted|unavailable)/);
  // One Dependencies block, the GitHub-managed one: Ensemble's own group is for local tasks.
  assert.deepEqual(
    await inspector
      .locator(".inspector-label")
      .evaluateAll((els) =>
        els
          .map((e) => e.textContent ?? "")
          .filter((t) => t.startsWith("Dependencies")),
      ),
    ["Dependencies · managed in GitHub"],
  );
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
  // No successful sync reads as words, never a blank time.
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${ids.importedId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      for (const m of json.data.source.memberships)
        m.sync = { ...m.sync, lastSuccessfulAt: null };
      await route.fulfill({ response, json });
    },
  );
  await page.reload();
  await github.getByText(/^Issue open · no successful sync/).waitFor();
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
  assert.equal(await inspector.getByText(/GitHub commenting/).count(), 0);
  // A local task owns Ensemble's one Dependencies block, never a GitHub-managed one.
  assert.deepEqual(
    await inspector
      .locator(".inspector-label")
      .evaluateAll((els) =>
        els
          .map((e) => e.textContent ?? "")
          .filter((t) => t.startsWith("Dependencies")),
      ),
    ["Dependencies"],
  );
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
  _t.after(a.restoreCredential);
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
  const noGrant = "This project doesn't permit GitHub issue comments.";
  a.setGrant(null);
  await refreshTask(page, a.taskId);
  await page.getByText(noGrant, { exact: true }).first().waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [`P:${noGrant}`]);
  const tab = page.getByRole("button", { name: "Post GitHub comment" });
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(await tab.getAttribute("aria-disabled"), "true");
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact comment body",
  );
  assert.deepEqual(commands, []);

  // The grant returns: the tab works again, still on GitHub, with the draft kept.
  a.setGrant("allow");
  await refreshTask(page, a.taskId);
  await page
    .getByText("Posts a comment on the GitHub issue.", { exact: true })
    .waitFor();
  assert.equal(await tab.getAttribute("aria-disabled"), null);
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact comment body",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isEnabled(),
    true,
  );

  // No delivery credential: `available` stays true on the server but the web offers no send,
  // even in allow mode with GitHub selected.
  const noCredential = "This project has no GitHub delivery credential set.";
  a.setGrant("allow", false);
  await refreshTask(page, a.taskId);
  await page.getByText(noCredential, { exact: true }).first().waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Exact comment body",
  );
  a.setGrant("approval", false);
  await refreshTask(page, a.taskId);
  await page.getByText(noCredential, { exact: true }).first().waitFor();
  assert.deepEqual(await sentencesAboveReply(page), [`P:${noCredential}`]);
  assert.equal(
    await page
      .getByRole("button", { name: "Post comment", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Review exact GitHub comment" })
      .isDisabled(),
    true,
  );
  assert.deepEqual(commands, []);
});

/** The inspector's GitHub group text and the tab's accessible reason, for one sentence. */
const unavailableComment = async (page: Page, sentence: string) => {
  const inspector = page.locator('aside[aria-label="Task context"]');
  await inspector.getByText(sentence, { exact: true }).waitFor();
  assert.match(
    (await inspector.innerText()).replace(/\s+/g, " "),
    /GitHub commenting unavailable/,
  );
  const tab = page.getByRole("button", { name: "Post GitHub comment" });
  assert.equal(await tab.getAttribute("aria-disabled"), "true");
  assert.equal(await tab.getAttribute("title"), sentence);
  const described = await tab.getAttribute("aria-describedby");
  assert.ok(described);
  assert.equal(
    await page.locator(`[id="${described}"]`).textContent(),
    sentence,
  );
  return tab;
};

test("An unavailable GitHub comment gives its reason in the inspector and on a focusable tab that does nothing", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedImportedCommentTask(fixture.f, "allow");
  _t.after(a.restoreCredential);
  const { web, page, commands } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const lead = page.getByRole("button", { name: "Message task lead" });
  await lead.waitFor();
  const inspector = page.locator('aside[aria-label="Task context"]');
  await inspector.getByText("GitHub commenting permitted").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Post GitHub comment" })
      .getAttribute("aria-disabled"),
    null,
  );
  assert.equal(await page.locator("#github-comment-reason").count(), 0);

  const cases: [string, () => void][] = [
    [
      "This project doesn't permit GitHub issue comments.",
      () => a.setGrant(null),
    ],
    [
      "This project has no GitHub delivery credential set.",
      () => a.setGrant("allow", false),
    ],
    [
      "Comments wait while the task's admission or delivery is held.",
      () => {
        a.setGrant("allow");
        const d = fixture.f.service.domain();
        d.execute({
          type: "project.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: a.projectId,
          expectedVersion: Number(d.project(a.projectId).version),
          paused: true,
        });
      },
    ],
  ];
  for (const [sentence, arrange] of cases) {
    arrange();
    await refreshTask(page, a.taskId);
    const tab = await unavailableComment(page, sentence);
    // Tab from the sibling destination reaches it, so the reason is readable by keyboard.
    await lead.focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Post GitHub comment",
    );
    // Neither Enter, Space nor a click selects it: the lead's sentence stays above the box.
    const before = await sentencesAboveReply(page);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await tab.click({ force: true });
    assert.deepEqual(await sentencesAboveReply(page), before);
    assert.equal(
      await page
        .getByRole("button", { name: "Post comment", exact: true })
        .count(),
      0,
    );
  }
  assert.deepEqual(commands, []);
});

test("An older task read without a reason code falls back to its reason text", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedImportedCommentTask(fixture.f, null);
  _t.after(a.restoreCredential);
  let reason: string | null = "No project grant for issue comments";
  const { web, page } = await fixture.launch();
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      delete json.data.commentPolicy.reasonCode;
      json.data.commentPolicy.reason = reason;
      await route.fulfill({ response, json });
    },
  );
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await unavailableComment(page, "No project grant for issue comments.");
  // Neither a reason nor a code: one generic sentence, never a blank.
  reason = null;
  await refreshTask(page, a.taskId);
  await unavailableComment(
    page,
    "GitHub comments aren't available for this task.",
  );
});

test("The viewing reference appears only once a result exists", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Fieldnotes",
    "Local task",
    "Write the guide.",
  );
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const review = page.locator("#review");
  await review.getByText("No result recorded.", { exact: true }).waitFor();
  const view = review.getByRole("button", { name: "Set viewing reference" });
  assert.equal(await view.count(), 0);
  assert.equal(await review.getByText(/No viewing baseline/).count(), 0);
  assert.equal(
    await review.getByText(/Viewing records availability/).count(),
    0,
  );

  // The first result arrives while the page is open: the block appears with the draft kept.
  await page.getByLabel("Editable reply").fill("Keep this draft");
  a.result("Guide drafted");
  await refreshTask(page, a.taskId);
  await view.waitFor();
  await review
    .getByText(
      "No viewing baseline. Comparison with previously viewed material is unknown.",
      { exact: true },
    )
    .waitFor();
  await review.getByText(/Viewing records availability only/).waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Keep this draft",
  );
});

test("A viewing reference the service refuses while the task page is away says so on return", async (_t, j) => {
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
  const review = page.locator("#review");
  const view = review.getByRole("button", { name: "Set viewing reference" });
  await view.waitFor();
  // The reply is held until the task page has been left, then refuses the request.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    await held;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "conflict" } }),
    });
  });
  const sent = page.waitForRequest((r) =>
    (r.postData() ?? "").includes("review.view"),
  );
  await view.click();
  await sent;
  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForURL(/\/app\/inbox/);
  release();
  await page.waitForTimeout(300);
  await page.goBack();
  await review
    .getByText("This task changed since you opened it. Your draft is kept.")
    .waitFor();
  await review.getByRole("button", { name: "Review current state" }).click();
  await review
    .getByText("This task changed since you opened it. Your draft is kept.")
    .waitFor({ state: "detached" });
  await view.waitFor();
  assert.equal(await view.isEnabled(), true);
});

test("The outcome shows its first line and a closed disclosure with rendered Markdown", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const subtitle = page.locator(".page-header-title p.introduction");
  await subtitle.waitFor();
  assert.equal(await subtitle.textContent(), "Context");
  const disclosure = page.locator("[data-task-strip] details.task-outcome");
  const summary = disclosure.locator("summary");
  assert.equal(await summary.textContent(), "Full desired outcome");
  assert.equal(
    await disclosure.evaluate((e: HTMLDetailsElement) => e.open),
    false,
  );

  // The keyboard opens it, and it renders the whole outcome as Markdown.
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await disclosure.evaluate((e: HTMLDetailsElement) => e.open),
    true,
  );
  assert.equal(await disclosure.locator("li").count(), 3);
  // The preview draws each task item's inert checkbox as "[ ]".
  const items = await disclosure.locator("li").allInnerTexts();
  assert.deepEqual(
    items.map((item) => item.replace(/^\[ \] /, "")),
    ["Restore focus", "Retain drafts", "Announce results"],
  );
  assert.doesNotMatch(await disclosure.innerText(), /- \[ \]|##/);

  // A refresh keeps it open.
  await refreshTask(page, a.taskId);
  await settle(page);
  assert.equal(
    await disclosure.evaluate((e: HTMLDetailsElement) => e.open),
    true,
  );
});

test("A redacted outcome shows no subtitle and no disclosure", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const { web, page } = await fixture.launch();
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.task.outcome = null;
      json.data.contentUnavailable = true;
      await route.fulfill({ response, json });
    },
  );
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page
    .getByRole("heading", { name: "Ship an accessible command menu", level: 1 })
    .waitFor();
  await page.locator("[data-task-strip]").waitFor();
  assert.equal(
    await page.locator(".page-header-title p.introduction").count(),
    0,
  );
  assert.equal(await page.locator("details.task-outcome").count(), 0);
  await page.unrouteAll({ behavior: "wait" });
});

test("Task detail identifiers are short mono metadata and tokens read as sentences", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Atlas",
    "Ship an accessible command menu",
    body,
  );
  a.delegatedResult("Earlier finished work");
  const [c1] = a.source.criteria;
  const head = "a".repeat(40);
  const r2 = a.delegatedResult("Keyboard support ready for review", {
    sourceId: a.source.sourceId,
    criteria: [
      {
        criterionId: c1!.criterionId,
        outcome: "supported",
        scope: "Keyboard opening",
        provenance: "Focus check",
      },
    ],
    validations: [
      {
        label: "Unit tests",
        outcome: "passed",
        scope: "Whole suite",
        provenance: "CI run",
        checkedHead: head,
      },
      {
        label: "Lint",
        outcome: "unverified",
        scope: "Repository",
        provenance: "Local run",
      },
    ],
  });
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const result = page.locator(`#review [data-record-id="${r2.resultId}"]`);
  await result.waitFor();
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-/;

  // Metadata shows 8 mono characters; the full value is the title; no full id is visible.
  await openOverviewCard(page, "brief");
  const brief = page.locator("#brief .metadata").filter({ hasText: "source" });
  assert.match(
    await brief.innerText(),
    /^Local source · revision 1 · [0-9a-f]{8}$/,
  );
  const meta = result.locator("p.metadata").first();
  assert.match(
    await meta.innerText(),
    /^R2 · [0-9a-f]{8} · assignment [0-9a-f]{8} · work revision \d+ · /,
  );
  const inspector = page.locator('aside[aria-label="Task context"]');
  const results = inspector.locator(".inspector-group", {
    has: page.getByRole("heading", { name: "Results & artifacts" }),
  });
  for (const region of [brief, meta, results])
    assert.doesNotMatch(await region.innerText(), uuid);
  assert.deepEqual(
    await page.evaluate(
      ([selectors]) =>
        selectors!.flatMap((selector) =>
          [
            ...document.querySelectorAll<HTMLElement>(
              `${selector} abbr.identifier`,
            ),
          ].map((el) => [el.title, el.textContent, el.tabIndex]),
        ),
      [
        [
          "#brief .metadata",
          `#review [data-record-id="${r2.resultId}"] p.metadata`,
        ],
      ],
    ),
    [
      [a.source.sourceId, a.source.sourceId.slice(0, 8), 0],
      [r2.resultId, r2.resultId.slice(0, 8), 0],
      [r2.assignmentId, r2.assignmentId.slice(0, 8), 0],
    ],
  );
  const links = inspector.getByRole("link", { name: /^R\d/ });
  assert.deepEqual(await links.allInnerTexts(), [
    `R2 · ${r2.resultId.slice(0, 8)}`,
    `R1 · ${(await links.nth(1).locator("abbr").getAttribute("title"))!.slice(0, 8)}`,
  ]);
  assert.equal(
    await links.first().locator("abbr").getAttribute("title"),
    r2.resultId,
  );
  assert.equal(
    await links.first().locator("abbr").getAttribute("tabindex"),
    null,
  );
  assert.deepEqual(
    await page.locator("#retained-result-revision option").allInnerTexts(),
    ["Latest result", "R1", "R2"],
  );

  // A criterion with no record says only what is known.
  const rows = page.locator(".criterion-row");
  const metadata = await rows.locator("p.metadata").allInnerTexts();
  assert.deepEqual(metadata, [
    "Source revision 1 · Keyboard opening · Focus check",
    "Source revision 1",
    "Source revision 1",
  ]);
  const review = page.locator("#review");
  for (const word of [
    "No supporting scope supplied",
    "provenance",
    "Unavailable",
    "not supplied",
  ])
    assert.equal(await review.getByText(word).count(), 0, word);

  // Validation rows: short head, and a comparison that never invents a head.
  await openOverviewCard(page, "evidence");
  const validation = (label: string) =>
    page
      .locator("#result-evidence")
      .locator("p", { hasText: new RegExp(`^${label}:`) });
  assert.equal(
    await validation("Unit tests").innerText(),
    "Unit tests: passed · Whole suite · CI run · checked head aaaaaaaa · Head comparison unknown",
  );
  assert.equal(
    await validation("Unit tests").locator("abbr").getAttribute("title"),
    head,
  );
  assert.equal(
    await validation("Lint").innerText(),
    "Lint: unverified · Repository · Local run · Head comparison unknown",
  );
  let bound = head;
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data.delivery = {
        mode: "reviewable-pr",
        policyVersion: 1,
        blockers: [],
        omittedBlockerCount: 0,
        omittedActionCount: 0,
        binding: {
          revision: 1,
          number: 12,
          repositoryName: "acme/app",
          headSha: bound,
          state: "OPEN",
          observedAt: Date.now(),
          readError: null,
          omittedCheckCount: 0,
          omittedFeedbackCount: 0,
          checks: [],
          feedback: [],
        },
        actions: [],
      };
      await route.fulfill({ response, json });
    },
  );
  await refreshTask(page, a.taskId);
  await validation("Unit tests")
    .getByText("Matches the current pull request head")
    .waitFor();
  bound = "b".repeat(40);
  await refreshTask(page, a.taskId);
  await validation("Unit tests")
    .getByText("Checked an earlier head than the current pull request head")
    .waitFor();
  await page.unrouteAll({ behavior: "wait" });

  // Each retained-evidence reason reads as its sentence; the code is only in Details.
  const evidence = page.locator(".retained-evidence");
  await evidence
    .getByText(
      "Evidence was not retained for this result. Current files are not used instead.",
      { exact: true },
    )
    .waitFor();
  const code = evidence.getByText("not-retained", { exact: true });
  assert.equal(await code.isVisible(), false);
  await evidence.getByText("Details", { exact: true }).click();
  assert.equal(await code.isVisible(), true);
  let reason = "excluded";
  await page.route(
    (url) =>
      url.pathname ===
      `/api/operator/tasks/${a.taskId}/results/${r2.resultId}/evidence`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.data = { ...json.data, state: "unavailable", reason };
      await route.fulfill({ response, json });
    },
  );
  for (const [code, sentence] of [
    ["excluded", "Evidence for this result is excluded from view."],
    [
      "unavailable",
      "Retained evidence for this result can't be shown right now.",
    ],
  ] as const) {
    reason = code;
    await page.reload();
    await openOverviewCard(page, "evidence");
    await page
      .locator(".retained-evidence")
      .getByText(`${sentence} Current files are not used instead.`, {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .locator(".retained-evidence details")
        .evaluate((el: HTMLDetailsElement) => el.open),
      false,
    );
  }
  await page.unrouteAll({ behavior: "wait" });
});

test("The delivery block links the PR, says its state and blockers in words, and says when checks were not observed", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Fieldnotes",
    "PR task",
    "Ship it.",
  );
  a.result("Guide drafted");
  const other = await seedReviewTask(
    fixture.f,
    "Elsewhere",
    "Other task",
    "No PR here.",
  );
  other.result("Nothing bound");
  setLinkedRepository(fixture.f, a.projectId, true);
  setLinkedRepository(fixture.f, other.projectId, true);
  const { web, page } = await fixture.launch();
  const head = "1".repeat(40),
    earlier = "c".repeat(40),
    observedAt = new Date(2026, 9, 16, 9, 7, 30).getTime(),
    url = "https://github.com/acme/app/pull/12";
  const read = (
    binding: Record<string, unknown> | null,
    blockers: string[] = [],
  ) => ({
    mode: "reviewable-pr",
    policyVersion: 1,
    blockers,
    omittedBlockerCount: 0,
    omittedActionCount: 0,
    binding: binding && {
      revision: 1,
      number: 12,
      repositoryName: "acme/app",
      url,
      headSha: head,
      state: "OPEN",
      observedAt,
      readError: null,
      omittedCheckCount: 0,
      omittedFeedbackCount: 0,
      checks: [],
      feedback: [],
      ...binding,
    },
    actions: [],
  });
  const reads = new Map<string, unknown>();
  await page.route(
    (u) => u.pathname.startsWith("/api/operator/tasks/"),
    async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
      if (!reads.has(id)) return route.fallback();
      const response = await route.fetch();
      const json = await response.json();
      json.data.delivery = reads.get(id);
      await route.fulfill({ response, json });
    },
  );
  const open = async (path: string) => {
    await page.evaluate((target) => {
      history.pushState({}, "", target);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.locator("main.page h1").waitFor();
    await openTaskTab(page, "Changes");
  };
  reads.set(
    a.taskId,
    read({}, [
      "reviewable-pr-awaiting-current-settlement",
      "delivery-new-unknown-code",
    ]),
  );
  reads.set(other.taskId, read(null));
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await openTaskTab(page, "Changes");
  const changes = page.locator("#changes");
  const prLink = changes.getByRole("link", { name: "acme/app#12" });
  const line = changes.locator("p", {
    has: page.getByRole("link", { name: "acme/app#12" }),
  });
  const flat = async (l: Locator) =>
    (await l.innerText()).replace(/\s+/g, " ").trim();
  const settle = "Waiting for the current PR head to be settled.";
  const fallback =
    "Delivery is waiting on a condition this version can't describe.";

  // Open, no checks observed, two blockers (one unknown): words first, codes only in Details.
  await refreshTask(page, a.taskId);
  await prLink.waitFor();
  assert.equal(await prLink.getAttribute("href"), url);
  assert.match((await prLink.getAttribute("rel")) ?? "", /noopener/);
  assert.equal(await prLink.getAttribute("target"), "_blank");
  assert.equal(
    await flat(line),
    "acme/app#12 (opens GitHub) Open head 11111111",
  );
  assert.equal(await line.locator("abbr").getAttribute("title"), head);
  await changes
    .getByText("No checks or repair owner were observed on this head.", {
      exact: true,
    })
    .waitFor();
  await changes.getByText(`GitHub read ${clockLabel(observedAt)}`).waitFor();
  await changes.getByText(settle, { exact: true }).waitFor();
  await changes.getByText(fallback, { exact: true }).waitFor();
  assert.equal(
    await changes.getByText("No repair owner is recorded").count(),
    0,
  );
  const text = () => changes.evaluate((el) => (el as HTMLElement).innerText);
  for (const code of [
    "reviewable-pr-awaiting-current-settlement",
    "delivery-new-unknown-code",
  ])
    assert.equal((await text()).includes(code), false, code);
  const settleRow = changes.locator("div", { hasText: settle }).last();
  await settleRow.getByText("Details", { exact: true }).click();
  await settleRow
    .getByText("reviewable-pr-awaiting-current-settlement", { exact: true })
    .waitFor();
  assert.equal((await text()).includes("delivery-new-unknown-code"), false);

  // Each state reads in words.
  for (const [binding, badge] of [
    [{ draft: true }, "Draft"],
    [{ state: "CLOSED" }, "Closed"],
    [{ state: "MERGED" }, "Merged"],
  ] as const) {
    reads.set(a.taskId, read(binding));
    await refreshTask(page, a.taskId);
    await line.getByText(badge, { exact: true }).waitFor();
    assert.equal(
      await flat(line),
      `acme/app#12 (opens GitHub) ${badge} head 11111111`,
    );
  }
  await changes
    .getByText("PR merged; task completion still requires", { exact: false })
    .waitFor();

  // The assigned task branch reads with its last push and, when set, an outside push.
  const branch = {
    repositoryName: "acme/app",
    branch: "ensemble/aaaa1111-ship-it",
    lastPushedSha: head,
    outsideHeadSha: null as string | null,
  };
  reads.set(a.taskId, { ...read({}), branches: [branch] });
  await refreshTask(page, a.taskId);
  const branchLine = changes.locator("p", { hasText: /· branch / });
  await branchLine.waitFor();
  assert.equal(
    await flat(branchLine),
    "acme/app · branch ensemble/aaaa1111-ship-it · pushed 11111111",
  );
  reads.set(a.taskId, {
    ...read({}),
    branches: [{ ...branch, outsideHeadSha: earlier }],
  });
  await refreshTask(page, a.taskId);
  await branchLine.getByText("Outside push cccccccc").waitFor();
  await changes
    .getByText(
      "Ensemble assigns and pushes these. A head it did not push is flagged, and Ensemble will not push that branch again until it returns to Ensemble's last push, or the lead adopts that head or overwrites it with your approval.",
      { exact: true },
    )
    .waitFor();
  reads.set(a.taskId, {
    ...read({}),
    branches: [{ ...branch, outsideHeadSha: "0".repeat(40) }],
  });
  await refreshTask(page, a.taskId);
  await branchLine.getByText("Branch deleted", { exact: true }).waitFor();
  reads.set(a.taskId, {
    ...read({}),
    branches: [{ ...branch, branch: null, lastPushedSha: null }],
  });
  await refreshTask(page, a.taskId);
  await changes
    .getByText("acme/app · branch withheld · not pushed yet", { exact: true })
    .waitFor();

  // Checks read in words; one on an earlier head says so; the repair owner is never invented.
  reads.set(
    a.taskId,
    read({
      checks: [
        { name: "build", sha: head, status: "failure" },
        { name: "lint", sha: earlier, status: "success" },
        { name: "e2e", sha: head, status: "pending" },
      ],
    }),
  );
  await refreshTask(page, a.taskId);
  await changes.getByText("build: Failed", { exact: true }).waitFor();
  await changes.getByText("e2e: Pending", { exact: true }).waitFor();
  const lint = changes.locator("p", { hasText: /^lint:/ });
  assert.equal(await flat(lint), "lint: Passed · on an earlier head cccccccc");
  assert.equal(await lint.locator("abbr").getAttribute("title"), earlier);
  await changes
    .getByText("No repair owner is recorded for this pull request.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await changes.getByText("were observed on this head").count(),
    0,
  );

  // A failed provider read says the checks are the earlier read's; the code is only in Details.
  reads.set(
    a.taskId,
    read({ readError: "provider-read-unavailable" }, [
      "delivery-provider-read-unavailable",
    ]),
  );
  await refreshTask(page, a.taskId);
  await changes
    .getByText(
      `Last GitHub read failed; showing the read from ${clockLabel(observedAt)}.`,
      { exact: true },
    )
    .waitFor();
  await changes
    .getByText(
      "The last GitHub read failed, so delivery state may be out of date.",
      { exact: true },
    )
    .waitFor();
  assert.equal((await text()).includes("provider-read-unavailable"), false);
  assert.equal(
    (await text()).includes("delivery-provider-read-unavailable"),
    false,
  );

  const readError = changes.getByText("provider-read-unavailable", {
    exact: true,
  });
  assert.equal(await readError.isVisible(), false);
  await changes
    .locator("details", { hasText: "Read error" })
    .getByText("Details", { exact: true })
    .click();
  await readError.waitFor();

  // Checks omitted from the read are not "no checks observed".
  reads.set(a.taskId, read({ omittedCheckCount: 1 }));
  await refreshTask(page, a.taskId);
  await changes
    .getByText("No repair owner is recorded for this pull request.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await changes.getByText("were observed on this head").count(),
    0,
  );

  // Without a verified link the line is plain text and never shows a repository id.
  reads.set(a.taskId, read({ url: undefined, repositoryName: "R_kgDOabc" }));
  await refreshTask(page, a.taskId);
  await changes
    .getByText("No GitHub link: this PR's repository name was not observed.", {
      exact: false,
    })
    .waitFor();
  assert.equal(await changes.getByRole("link", { name: /#12/ }).count(), 0);
  assert.equal(await changes.locator('a[href*="/pull/"]').count(), 0);
  assert.equal((await text()).includes("R_kgDOabc"), false);
  assert.match(
    await flat(changes.locator("p", { hasText: /^PR #12/ })),
    /^PR #12 Open head 11111111/,
  );

  // Navigating to a task without a PR and back leaves nothing of the other read behind.
  reads.set(
    a.taskId,
    read({ checks: [{ name: "build", sha: head, status: "success" }] }),
  );
  await open(`/app/tasks/${other.taskId}`);
  await changes
    .getByRole("button", { name: "Refresh delivery status" })
    .waitFor();
  assert.equal(await changes.getByText(/#12|PR #|build:/).count(), 0);
  await open(`/app/tasks/${a.taskId}`);
  await prLink.waitFor();
  await changes.getByText("build: Passed", { exact: true }).waitFor();
  assert.equal(await changes.getByText("No GitHub link").count(), 0);

  // An unsafe link fails the task read closed: no link is rendered from it.
  reads.set(a.taskId, read({ url: "javascript:alert(1)" }));
  await page.reload();
  await page.locator("main.page h1").waitFor();
  await page.locator(".resource-status-error").first().waitFor();
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.getByText("acme/app#12").count(), 0);
  await page.unrouteAll({ behavior: "wait" });
});

test("Delivery feedback leaves with the delivery controls and returns with them", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Fieldnotes",
    "Local task",
    "Write the guide.",
  );
  a.result("Guide drafted");
  setLinkedRepository(fixture.f, a.projectId, true);
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page.getByLabel("Editable reply").fill("Keep this draft");
  await openTaskTab(page, "Changes");
  const changes = page.locator("#changes");
  const refresh = changes.getByRole("button", {
    name: "Refresh delivery status",
  });
  await refresh.click();
  await changes
    .getByText("Delivery status refreshed.", { exact: true })
    .waitFor();

  // The last repository goes away: the settled feedback leaves with the control.
  setLinkedRepository(fixture.f, a.projectId, false);
  await refreshTask(page, a.taskId);
  await refresh.waitFor({ state: "detached" });
  assert.equal(await changes.getByText(/Delivery status refreshed/).count(), 0);
  assert.equal(await changes.locator("h3").first().innerText(), "Changes");

  // It comes back with the repository, and the draft was never touched.
  setLinkedRepository(fixture.f, a.projectId, true);
  await refreshTask(page, a.taskId);
  await refresh.waitFor();
  await openTaskTab(page, "Overview");
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Keep this draft",
  );
});

test("An unconfirmed delivery refresh stays checkable after delivery stops applying", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedReviewTask(
    fixture.f,
    "Fieldnotes",
    "Local task",
    "Write the guide.",
  );
  a.result("Guide drafted");
  setLinkedRepository(fixture.f, a.projectId, true);
  const { web, page } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await openTaskTab(page, "Changes");
  const bodies: { key?: string; type?: string }[] = [];
  let lost = true;
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as {
      key?: string;
      type?: string;
    };
    if (body.type !== "delivery.refresh") return route.fallback();
    bodies.push(body);
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  const changes = page.locator("#changes");
  await changes
    .getByRole("button", { name: "Refresh delivery status" })
    .click();
  const check = changes.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  // The refresh control is off now, so the check takes the focus it held.
  assert.equal(
    await check.evaluate((el) => el === document.activeElement),
    true,
  );

  // Delivery stops applying while the outcome is unknown: the check stays, the control goes.
  setLinkedRepository(fixture.f, a.projectId, false);
  await refreshTask(page, a.taskId);
  await changes
    .getByRole("button", { name: "Refresh delivery status" })
    .waitFor({ state: "detached" });
  await check.waitFor();
  await changes.getByText(/We couldn't confirm/).waitFor();

  // Checking replays the same request; once settled, no delivery feedback remains.
  await check.click();
  await check.waitFor({ state: "detached" });
  assert.equal(await changes.getByText(/We couldn't confirm/).count(), 0);
  assert.equal(await changes.getByText(/Delivery status refreshed/).count(), 0);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]!.key, bodies[1]!.key);
});

test("A task that loses its GitHub source mid-edit moves to the lead with the lead's own draft and keeps its GitHub approval apart", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seedImportedCommentTask(fixture.f, "approval");
  _t.after(a.restoreCredential);
  const sourceId = fixture.f.service
    .taskReview()
    .sources(a.taskId)
    .at(-1)!.sourceId;
  const { web, page, commands } = await fixture.launch();
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  const box = page.getByLabel("Editable reply");
  const post = page.getByRole("button", { name: "Post comment", exact: true });
  // A contextual lead draft with its immutable reference, then an approved GitHub comment.
  await openOverviewCard(page, "brief");
  await page.getByRole("button", { name: "Ask lead about brief" }).click();
  const leadText = await box.inputValue();
  assert.notEqual(leadText, "");
  await page.getByRole("button", { name: "Post GitHub comment" }).click();
  await box.fill("Original body");
  await page
    .getByRole("button", { name: "Review exact GitHub comment" })
    .click();
  await page.getByRole("button", { name: "Confirm exact comment" }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Post comment" && !b.disabled,
    ),
  );

  // The source disappears from the read: one destination, the lead, with the lead's draft.
  let hasSource = false;
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${a.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      if (!hasSource) json.data.source = null;
      await route.fulfill({ response, json });
    },
  );
  await refreshTask(page, a.taskId);
  await page.getByRole("button", { name: "Send to task lead" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Post GitHub comment" }).count(),
    0,
  );
  assert.equal(await box.inputValue(), leadText);
  assert.deepEqual(await sentencesAboveReply(page), [
    `P:${leadReceivesNotice("Task lead")}`,
  ]);
  // Choosing the destination that is already selected changes nothing.
  await page.getByRole("button", { name: "Message task lead" }).click();
  assert.equal(await box.inputValue(), leadText);

  // The source returns: the GitHub draft is as it was, and editing it withdraws its approval.
  hasSource = true;
  await refreshTask(page, a.taskId);
  await page.getByRole("button", { name: "Post GitHub comment" }).click();
  assert.equal(await box.inputValue(), "Original body");
  assert.equal(await post.isEnabled(), true);
  await box.fill("Original body, edited");
  assert.equal(await post.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Confirm exact comment" }).count(),
    0,
  );

  // Lost again: Send posts the lead message with the lead text and its own reference.
  hasSource = false;
  await refreshTask(page, a.taskId);
  await page.getByRole("button", { name: "Send to task lead" }).click();
  await page.getByText(/^Sent/).first().waitFor();
  const sent = commands as {
    type: string;
    message?: string;
    reference?: unknown;
  }[];
  assert.deepEqual(
    sent
      .filter((c) => c.type === "message" || c.type === "comment.send")
      .map((c) => [c.type, c.message, c.reference]),
    [["message", leadText, { sourceId }]],
  );
  await page.unrouteAll({ behavior: "wait" });
});

/** Selectors in the order Overview must show them: document order and top-to-bottom. */
async function expectOverviewOrder(page: Page, selectors: string[]) {
  const found = await page.evaluate((selectors) => {
    const els = selectors.map((s) => document.querySelector(s));
    return els.map((e, i) => {
      const previous = els[i - 1];
      const box = e?.getBoundingClientRect();
      return {
        missing: !e,
        follows:
          i === 0 ||
          Boolean(
            e &&
              previous &&
              previous.compareDocumentPosition(e) &
                Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        top: box?.top ?? Number.NaN,
        bottom: box?.bottom ?? Number.NaN,
      };
    });
  }, selectors);
  found.forEach((f, i) => {
    assert.ok(!f.missing, `${selectors[i]} is on Overview`);
    assert.ok(
      f.follows,
      `${selectors[i]} follows ${selectors[i - 1]} in the DOM`,
    );
    if (i)
      assert.ok(
        found[i - 1]!.bottom <= f.top + 0.5,
        `${selectors[i]} sits below ${selectors[i - 1]}`,
      );
  });
}

const overviewOrder = [
  "section#decisions",
  "section#review",
  "section#reply",
  "section#brief",
  "section#result-evidence",
  "section#assignments",
  "p.task-pointer",
];

/** Follows an in-app link as the app's own links do: in place, with no page load. */
const followInApp = (page: Page, href: string) =>
  page.evaluate((href) => {
    const a = document.createElement("a");
    a.href = href;
    document.body.append(a);
    a.click();
    a.remove();
  }, href);

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `Overview reads decisions, result and reply before the collapsed brief, evidence and assignments (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const a = await seedOwnApproval(fixture.f);
      a.delegatedResult("Keyboard support ready for review", {
        sourceId: a.source.sourceId,
      });
      const { web, page } = await fixture.launch();
      await serveApprovals(page, a.taskId, [a.interactionId, randomUUID()]);
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await page.locator("section#decisions .decision").nth(1).waitFor();
      await expectOverviewOrder(page, overviewOrder);

      // The three cards start closed; each summary carries its label and count.
      const read = await page.evaluate(
        (id) => fetch(`/api/operator/tasks/${id}`).then((r) => r.json()),
        a.taskId,
      );
      const criteria = a.source.criteria.length;
      const metadata = read.data.review.results[0].metadata;
      const plural = (n: number, noun: string) =>
        `${n} ${noun}${n === 1 ? "" : "s"}`;
      for (const [name, heading, detail] of [
        [
          "brief",
          "Shared brief",
          `Requirements · Local · ${criteria} supplied ${criteria === 1 ? "criterion" : "criteria"}`,
        ],
        [
          "evidence",
          "Evidence",
          `R1 · ${plural(metadata.validations.length, "validation record")} · ${plural(metadata.artifacts.length, "artifact")}`,
        ],
        [
          "assignments",
          `Assignments · ${read.data.assignments.length}`,
          /^[0-9a-f]{8} [A-Z][a-z]+( · [0-9a-f]{8} [A-Z][a-z]+)*$/,
        ],
      ] as const) {
        const card = overviewCard(page, name);
        assert.equal(
          await card.getAttribute("open"),
          null,
          `${name} starts closed`,
        );
        assert.equal(
          await card.locator("> summary h3").textContent(),
          heading,
          name,
        );
        const text =
          (await card.locator("> summary .metadata").textContent()) ?? "";
        if (typeof detail === "string") assert.equal(text, detail, name);
        else assert.match(text, detail, name);
      }
      assert.equal(
        (await page.locator("section#decisions .decision").count()) >= 2,
        true,
      );

      // Overview repeats none of the other tabs.
      assert.equal(
        await page.locator('nav[aria-label="Task material"]').count(),
        0,
      );
      assert.deepEqual(
        await page.locator("#task-panel-overview").evaluate((panel) =>
          [...panel.querySelectorAll<HTMLAnchorElement>("a[href]")]
            .filter((link) => !link.closest("aside"))
            .map((link) => link.getAttribute("href") ?? "")
            .filter((href) =>
              /#(files|changes|local-review|context|history)$/.test(href),
            ),
        ),
        [],
      );

      // Tab order is the visual order: the decision card, the result, the reply, then the
      // summaries, each reached once.
      await page.evaluate(() => {
        const controls = document.querySelectorAll<HTMLElement>(
          "section#decisions a[href], section#decisions button:not([disabled])",
        );
        controls[controls.length - 1]?.focus();
      });
      const visited: string[] = [];
      for (let i = 0; i < 80 && !visited.includes("assignments"); i++) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate(() => {
          const el = document.activeElement;
          return {
            section: el?.closest("section[id]")?.id ?? "outside",
            summary: el?.tagName === "SUMMARY",
          };
        });
        if (stop.section !== visited.at(-1)) visited.push(stop.section);
        if (["brief", "result-evidence", "assignments"].includes(stop.section))
          assert.ok(
            stop.summary,
            `${stop.section} is reached through its summary`,
          );
      }
      assert.deepEqual(visited, [
        "review",
        "reply",
        "brief",
        "result-evidence",
        "assignments",
      ]);
    },
  );

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `Overview keeps its order with no decision, with holds, for an imported task and when the task is finished (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const f = fixture.f;
      const open = await seed(f);
      const ids = await seedCatalog(f);
      const d = f.service.domain();
      const heldProject = randomUUID(),
        held = randomUUID();
      d.execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId: heldProject,
        name: "held-app",
        leadProfileId: null,
      });
      d.execute({
        type: "task.create",
        actor: "operator",
        key: randomUUID(),
        projectId: heldProject,
        taskId: held,
        title: "Stopped with a hold",
        outcome: "Probe",
        ready: true,
      });
      await f.service.stopTask(held);
      f.seedPersistedState((db) =>
        db
          .prepare(
            "INSERT INTO task_archival_holds (taskId, reason) VALUES (?, ?)",
          )
          .run(held, "Archival is awaiting review"),
      );
      const { web, page } = await fixture.launch();
      const open1 = `/app/tasks/${open.taskId}`;
      await signIn(page, web.origin, web.password, open1);
      const present = (selectors: string[]) =>
        Promise.all(selectors.map((s) => page.locator(s).count())).then(
          (counts) => selectors.filter((_, i) => counts[i]),
        );
      const required = [
        "section#decisions",
        "section#review",
        "section#reply",
        "section#brief",
        "section#assignments",
        "p.task-pointer",
      ];

      // No decision: the card has no request and still leads the result.
      await page.locator("section#review").waitFor();
      const card = page.locator("section#decisions");
      assert.equal(await card.getAttribute("data-attention"), null);
      assert.equal(await card.locator(".decision").count(), 0);
      await expectOverviewOrder(page, await present(overviewOrder));
      assert.ok(
        (await present(overviewOrder)).includes("section#result-evidence"),
      );

      // A finished task keeps the same order.
      await page.route(
        (url) => url.pathname === `/api/operator/tasks/${open.taskId}`,
        async (route) => {
          const response = await route.fetch();
          const json = await response.json();
          json.data.task.state = "done";
          await route.fulfill({ response, json });
        },
      );
      await page.reload();
      await page.locator("[data-task-strip] .task-state").waitFor();
      assert.equal(
        await page
          .locator("[data-task-strip] .task-state")
          .getAttribute("data-column"),
        "Done",
      );
      await expectOverviewOrder(page, await present(overviewOrder));
      await page.unrouteAll({ behavior: "wait" });

      // Holds are lines inside the decision card, above the result.
      await page.goto(`${web.origin}/app/tasks/${held}`);
      await page.locator("section#decisions .wait-reasons").waitFor();
      assert.ok(
        (
          await page.locator("section#decisions .wait-reasons").innerText()
        ).includes("Archival is awaiting review"),
      );
      await expectOverviewOrder(page, await present(overviewOrder));
      assert.equal(
        (await present(overviewOrder)).filter((s) => required.includes(s))
          .length,
        required.length,
      );

      // An imported task keeps the order and the source chip.
      await page.goto(`${web.origin}/app/tasks/${ids.importedId}`);
      await page.locator("[data-task-strip] .task-source-chip").waitFor();
      await expectOverviewOrder(page, await present(overviewOrder));
      assert.equal(
        (await present(overviewOrder)).filter((s) => required.includes(s))
          .length,
        required.length,
      );
    },
  );

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `Deep links open collapsed Overview sections and focus them (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const a = await seedOwnQuestion(fixture.f, guideForm);
      const older = a.delegatedResult("Linked older result", {
        sourceId: a.source.sourceId,
        decisions: [
          { text: "Linked decision alpha", attribution: "Task lead" },
        ],
      });
      a.delegatedResult("Linked newer result", { sourceId: a.source.sourceId });
      const { web, page } = await fixture.launch();
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await taskTab(page, "Overview").waitFor();
      const hits = await page.evaluate(
        (query) =>
          fetch(`/api/operator/search?query=${query}&historical=true&limit=50`)
            .then((r) => r.json())
            .then((r) =>
              (
                r.data.matches as {
                  type: string;
                  recordId: string;
                  href: string;
                }[]
              ).map((m) => ({ type: m.type, href: m.href })),
            ),
        "Linked",
      );
      const decisionHit = hits.find((h) => h.type === "decision"),
        briefHit = (
          await page.evaluate(
            (query) =>
              fetch(
                `/api/operator/search?query=${query}&historical=true&limit=50`,
              )
                .then((r) => r.json())
                .then((r) =>
                  (r.data.matches as { type: string; href: string }[]).filter(
                    (m) => m.type === "task",
                  ),
                ),
            "Restore",
          )
        )[0];
      assert.ok(decisionHit, "Search finds the recorded decision");
      assert.ok(briefHit, "Search finds the brief");
      const decisionId = `${older.resultId}:decision:0`;
      type Card = "brief" | "evidence" | "assignments";
      const cases: {
        link: string;
        tab: string;
        open: Card[];
        target: string;
        focus?: string;
      }[] = [
        {
          link: "?section=brief",
          tab: "Overview",
          open: ["brief"],
          target: "#brief",
          focus: "#brief > details > summary",
        },
        { link: "#brief", tab: "Overview", open: ["brief"], target: "#brief" },
        {
          link: `?source=${a.source.sourceId}`,
          tab: "Overview",
          open: ["brief"],
          target: "#brief",
        },
        {
          link: briefHit.href.slice(briefHit.href.indexOf("?")),
          tab: "Overview",
          open: ["brief"],
          target: "#brief",
        },
        {
          link: decisionHit.href.slice(decisionHit.href.indexOf("?")),
          tab: "Overview",
          open: ["evidence"],
          target: `[data-record-id="${decisionId}"]`,
        },
        {
          link: "?section=assignments",
          tab: "Overview",
          open: ["assignments"],
          target: "#assignments",
          focus: "#assignments > details > summary",
        },
        {
          link: "?section=review",
          tab: "Overview",
          open: [],
          target: "#review",
          focus: "#review h3",
        },
        {
          link: `?result=${older.resultId}`,
          tab: "Overview",
          open: [],
          target: "#review",
        },
        {
          link: "?section=reply",
          tab: "Overview",
          open: [],
          target: "#reply",
          focus: "#reply h3",
        },
        {
          link: "?section=decisions",
          tab: "Overview",
          open: [],
          target: "#decisions",
          focus: "#decisions h3",
        },
        {
          link: `?request=${a.interactionId}`,
          tab: "Overview",
          open: [],
          target: "#decisions",
        },
        {
          link: `?request=${a.interactionId}#history`,
          tab: "History",
          open: [],
          target: "#task-panel-history",
        },
        {
          link: `?assignment=${a.assignmentId}#history`,
          tab: "History",
          open: [],
          target: "#task-panel-history",
        },
        {
          link: "?section=context",
          tab: "History",
          open: [],
          target: "#context",
        },
      ];
      const inViewport = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((el) => {
            const box = el.getBoundingClientRect();
            return box.bottom > 0 && box.top < innerHeight;
          });
      const openCards = () =>
        Promise.all(
          (["brief", "evidence", "assignments"] as const).map(async (name) =>
            (await overviewCard(page, name).getAttribute("open")) === null
              ? null
              : name,
          ),
        ).then((cards) => cards.filter((c) => c !== null));
      for (const c of cases) {
        // A hash-only change would stay in the loaded page; every link opens as a fresh load.
        await page.goto("about:blank");
        await page.goto(`${web.origin}/app/tasks/${a.taskId}${c.link}`);
        await page
          .getByRole("heading", { name: "Choose full form", level: 1 })
          .waitFor();
        await settle(page);
        assert.equal(await selectedTab(page), c.tab, c.link);
        assert.deepEqual(await openCards(), c.open, `${c.link}: open cards`);
        await page
          .waitForFunction((selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const box = el.getBoundingClientRect();
            return box.bottom > 0 && box.top < innerHeight;
          }, c.target)
          .catch(async () =>
            assert.fail(
              `${c.link}: ${c.target} never came into view (${await page.evaluate(
                (selector) =>
                  JSON.stringify([
                    scrollY,
                    document.querySelector(selector)?.getBoundingClientRect(),
                    document.documentElement.scrollHeight,
                  ]),
                c.target,
              )})`,
            ),
          );
        assert.ok(await inViewport(c.target), `${c.link}: target in view`);
        if (c.focus)
          assert.ok(
            await page
              .locator(c.focus)
              .first()
              .evaluate((el) => el === document.activeElement),
            `${c.link}: focus on ${c.focus}`,
          );
      }
      // ?source= also selects that retained revision; ?result= selects that result.
      await page.goto(
        `${web.origin}/app/tasks/${a.taskId}?source=${a.source.sourceId}`,
      );
      await page.locator("#retained-source-revision").waitFor();
      assert.equal(
        await page.locator("#retained-source-revision").inputValue(),
        a.source.sourceId,
      );
      await page.goto(
        `${web.origin}/app/tasks/${a.taskId}?result=${older.resultId}`,
      );
      await page.locator("#retained-result-revision").waitFor();
      assert.equal(
        await page.locator("#retained-result-revision").inputValue(),
        older.resultId,
      );

      // A link followed in place reopens a card the operator closed, then focuses it.
      await page.goto(`${web.origin}/app/tasks/${a.taskId}?section=brief`);
      await overviewCard(page, "brief").locator("> summary").click();
      assert.equal(
        await overviewCard(page, "brief").getAttribute("open"),
        null,
      );
      await followInApp(page, `/app/tasks/${a.taskId}?section=brief`);
      await page.locator("#brief > details[open]").waitFor();
      await page.waitForFunction(
        () =>
          document.activeElement?.closest("#brief > details > summary") !==
          null,
      );
      // The inspector's result link opens that result in place and keeps the cards as they are.
      await overviewCard(page, "brief").locator("> summary").click();
      await page
        .locator('aside[aria-label="Task context"]')
        .getByRole("link", { name: /^R1/ })
        .click();
      await page.waitForFunction(
        () => document.activeElement?.closest("section")?.id === "review",
      );
      assert.equal(
        await page.locator("#retained-result-revision").inputValue(),
        older.resultId,
      );
      assert.deepEqual(await openCards(), []);
    },
  );

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `Overview disclosures survive polls, refresh, Collapse all history and leaving the task, and never take focus (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const a = await seedOwnApproval(fixture.f);
      const result = a.delegatedResult("Keyboard support ready for review", {
        sourceId: a.source.sourceId,
      });
      const other = await seed(fixture.f);
      const { web, page } = await fixture.launch();
      // The approval arrives after the first read, as in "An open approval leads Overview…".
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
          await route.fulfill({ response, json });
        },
      );
      await page.clock.install();
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await page.locator("section#review").waitFor();
      await openOverviewCard(page, "brief");
      await openOverviewCard(page, "evidence");
      const evidence = overviewCard(page, "evidence");
      const summary = await evidence.locator("> summary").elementHandle();
      assert.ok(summary);
      await summary.evaluate((el) => (el as HTMLElement).focus());
      const states = async () => ({
        brief:
          (await overviewCard(page, "brief").getAttribute("open")) !== null,
        evidence: (await evidence.getAttribute("open")) !== null,
        assignments:
          (await overviewCard(page, "assignments").getAttribute("open")) !==
          null,
      });
      const expected = { brief: true, evidence: true, assignments: false };
      const unchanged = async (label: string) => {
        await settle(page);
        assert.deepEqual(await states(), expected, label);
        assert.ok(
          await summary.evaluate((el) => el === document.activeElement),
          `${label}: focus stays on the Evidence summary`,
        );
        assert.equal(await selectedTab(page), "Overview", label);
      };
      const taskRead = () =>
        page.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === `/api/operator/tasks/${a.taskId}`,
        );

      // A timer poll.
      let polled = taskRead();
      await page.clock.runFor(15000);
      await polled;
      await unchanged("poll");

      // Refresh task, dispatched so the button does not take the focus.
      const reread = taskRead();
      await page
        .getByRole("button", { name: "Refresh task", exact: true })
        .dispatchEvent("click");
      await reread;
      await unchanged("Refresh task");

      // An arriving approval updates the strip and the card, and moves nothing.
      hide = false;
      polled = taskRead();
      await page.clock.runFor(15000);
      await polled;
      await page
        .locator("[data-task-strip]")
        .getByRole("button", { name: "Next: you · review material & decide" })
        .waitFor();
      await unchanged("arriving approval");

      // Collapse all history closes History's disclosures, not Overview's.
      await openTaskTab(page, "History");
      await page
        .getByRole("button", { name: "Collapse all history", exact: true })
        .click();
      await openTaskTab(page, "Overview");
      assert.deepEqual(await states(), expected, "Collapse all history");

      // Leave for another view and press Back: same cards, same reading position.
      const anchor = page.locator(`[data-record-id="${result.resultId}"]`);
      await anchor.evaluate((e) => e.scrollIntoView());
      await page.evaluate(() => scrollBy(0, -40));
      const top = () => anchor.evaluate((e) => e.getBoundingClientRect().top);
      const anchorTop = await top();
      await page
        .getByRole("link", { name: "Overview", exact: true })
        .first()
        .click();
      await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
      await page.goBack();
      await page.locator("#brief > details[open]").waitFor();
      await settle(page);
      assert.deepEqual(await states(), expected, "after Back");
      assert.ok(
        Math.abs((await top()) - anchorTop) <= 1,
        `reading anchor ${anchorTop} -> ${await top()}`,
      );

      // Another task starts with all three cards closed.
      await followInApp(page, `/app/tasks/${other.taskId}`);
      await page
        .getByRole("heading", {
          name: "Ship an accessible command menu",
          level: 1,
        })
        .waitFor();
      for (const name of ["brief", "evidence", "assignments"] as const)
        assert.equal(
          await overviewCard(page, name).getAttribute("open"),
          null,
          `${name} on the second task`,
        );
    },
  );

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `Returning from evidence, Files or Changes restores Overview disclosures, scroll and focus (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const a = await seed(fixture.f);
      const artifactId = randomUUID();
      a.delegatedResult("Result with recorded evidence", {
        sourceId: a.source.sourceId,
        artifacts: [
          {
            artifactId,
            label: "Recorded capture",
            role: "evidence",
            revision: 1,
            availability: "unavailable",
          },
        ],
      });
      const { web, page } = await fixture.launch({ width: 1366, height: 700 });
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await page.locator("section#review").waitFor();
      await openOverviewCard(page, "evidence");
      const control = page.locator(
        `#result-evidence [data-record-id="${artifactId}"] button`,
      );
      await control.scrollIntoViewIfNeeded();
      await control.focus();
      await page.evaluate(() => scrollBy(0, 40));
      const y = await page.evaluate(() => scrollY);
      assert.ok(y > 0, "Overview is scrolled to the evidence");
      const onControl = () =>
        page.evaluate(
          (id) =>
            document.activeElement
              ?.closest("[data-record-id]")
              ?.getAttribute("data-record-id") === id &&
            document.activeElement?.tagName === "BUTTON",
          artifactId,
        );

      // Leaving the task and pressing Back restores the card, the scroll and the focus.
      await followInApp(page, "/app/tasks");
      await page
        .getByRole("heading", { name: "All tasks", exact: true })
        .waitFor();
      await page.goBack();
      await page.locator("#result-evidence > details[open]").waitFor();
      await page.waitForFunction(
        (id) =>
          document.activeElement
            ?.closest("[data-record-id]")
            ?.getAttribute("data-record-id") === id,
        artifactId,
      );
      await settle(page);
      assert.ok(await onControl(), "focus is back on the evidence control");
      assert.ok(
        Math.abs((await page.evaluate(() => scrollY)) - y) <= 1,
        "reading position",
      );

      // Visiting Files and Changes and returning to Overview keeps the card and the scroll.
      for (const tab of ["Files", "Changes"] as const) {
        await taskTab(page, tab).dispatchEvent("click");
        await page.locator(`#task-panel-${tab.toLowerCase()}`).waitFor();
        await taskTab(page, "Overview").dispatchEvent("click");
        await settle(page);
        assert.notEqual(
          await overviewCard(page, "evidence").getAttribute("open"),
          null,
          `Evidence stays open after ${tab}`,
        );
        assert.ok(
          Math.abs((await page.evaluate(() => scrollY)) - y) <= 1,
          `scroll after ${tab}`,
        );
      }
    },
  );

// WebKit does not Tab onto links by default, so this keyboard journey runs in Chromium; the
// responsive matrix covers the phone header in WebKit.
test("Phone task header is Back, title, identity subtitle and one Task actions control reachable by keyboard", async (_t, j) => {
  const fixture = await openFixture(j);
  const a = await seed(fixture.f);
  const ids = await seedCatalog(fixture.f);
  const finished = await seedReviewTask(
    fixture.f,
    "Finished project",
    "Finished task",
    "One line outcome.",
  );
  const stopped = await seedReviewTask(
    fixture.f,
    "Stopped project",
    "Stopped task",
    "One line outcome.",
  );
  fixture.f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_tasks SET state = 'done', version = version + 1 WHERE id = ?",
    ).run(finished.taskId);
    db.prepare(
      "INSERT INTO task_writer_holds (taskId, reason, holdKind) VALUES (?, 'Task stopped', 'operator-stop')",
    ).run(stopped.taskId);
  });
  const { web, page } = await fixture.launch({ width: 390, height: 844 });
  const stops: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      new URL(r.url()).pathname === "/runtime/control/stop"
    )
      stops.push(r.url());
  });
  await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
  await page
    .getByRole("heading", {
      name: "Ship an accessible command menu",
      level: 1,
    })
    .waitFor();
  const header = page.locator(".page-header");
  const toggle = header.locator(".task-header-overflow-toggle");
  const overflow = header.locator("details.task-header-overflow");
  const stopButton = header
    .locator(".task-header-actions button")
    .filter({ hasText: "Stop…" });
  const activeIs = (text: string) =>
    page.waitForFunction(
      (text) => document.activeElement?.textContent === text,
      text,
    );

  // Back, the title on one line over the mono identity, and exactly one other control.
  const back = header.getByRole("link", {
    name: "Back to Atlas",
    exact: true,
  });
  const backBox = await back.boundingBox();
  assert.ok(
    backBox && backBox.width >= 44 && backBox.height >= 44,
    "Back is 44px",
  );
  const h1 = header.locator("h1");
  assert.deepEqual(
    await h1.evaluate((e) => {
      const style = getComputedStyle(e);
      return [
        style.whiteSpace,
        style.textOverflow,
        e.scrollHeight <= e.clientHeight + 1,
      ];
    }),
    ["nowrap", "ellipsis", true],
  );
  const identity = header.locator(".page-subtitle-short");
  assert.equal(await identity.textContent(), "Local task");
  assert.ok(await identity.isVisible());
  assert.match(
    await identity.evaluate((e) => getComputedStyle(e).fontFamily),
    /mono/i,
  );
  assert.equal(await header.locator(".introduction").isVisible(), false);
  assert.deepEqual(
    await header
      .locator("a, button, summary")
      .evaluateAll((els) =>
        els
          .filter((e) => e.checkVisibility())
          .map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim()),
      ),
    ["Back to Atlas", "Task actions"],
  );
  const toggleBox = await toggle.boundingBox();
  assert.ok(toggleBox && toggleBox.width >= 44 && toggleBox.height >= 44);
  assert.equal(
    await header.getByRole("link", { name: "Execution" }).isVisible(),
    false,
  );
  assert.equal(
    await header.getByRole("button", { name: "Stop…" }).isVisible(),
    false,
  );

  // The keyboard opens it; Execution then Stop… follow in order; Stop… asks before it posts.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await overflow.and(page.locator("[open]")).waitFor();
  await page.keyboard.press("Tab");
  await activeIs("Execution");
  await page.keyboard.press("Tab");
  await activeIs("Stop…");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog", {
    name: "Stop Ship an accessible command menu?",
  });
  await dialog.waitFor();
  await activeIs("Keep running");
  // Escape closes the dialog first and returns to Stop…, then closes the overflow.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await activeIs("Stop…");
  assert.notEqual(await overflow.getAttribute("open"), null);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("task-header-overflow-toggle"),
  );
  assert.equal(await overflow.getAttribute("open"), null);
  assert.deepEqual(stops, []);

  // Resizing to desktop with the dialog open keeps the same dialog: nothing remounts.
  await page.keyboard.press("Enter");
  await overflow.and(page.locator("[open]")).waitFor();
  await header.getByRole("button", { name: "Stop…" }).click();
  await dialog.waitFor();
  const keep = await dialog
    .getByRole("button", { name: "Keep running" })
    .elementHandle();
  assert.ok(keep);
  await page.setViewportSize({ width: 1366, height: 900 });
  await settle(page);
  assert.ok(
    await keep.evaluate((e) => e.isConnected),
    "Keep running is the same element",
  );
  assert.ok(await dialog.isVisible());
  // The open modal hides the page from role queries, so these are located by class.
  assert.ok(await header.locator(".task-header-actions a").isVisible());
  assert.ok(await stopButton.isVisible());
  assert.equal(await toggle.isVisible(), false);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // A dialog opened on desktop keeps the actions it came from when the window narrows:
  // closing it returns to Stop… rather than to the page.
  await stopButton.click();
  await dialog.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await activeIs("Stop…");
  await page.setViewportSize({ width: 1366, height: 900 });
  await settle(page);
  // The desktop header shows the actions without the disclosure's summary.
  assert.notEqual(await overflow.getAttribute("open"), null);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);

  // An imported task's identity is its repository and number.
  await page.goto(`${web.origin}/app/tasks/${ids.importedId}`);
  await header.locator(".page-subtitle-short").waitFor();
  assert.equal(
    await header.locator(".page-subtitle-short").textContent(),
    "fixture/source#42",
  );

  // A finished task offers Execution and no Stop….
  await page.goto(`${web.origin}/app/tasks/${finished.taskId}`);
  await toggle.click();
  assert.deepEqual(
    await header
      .locator(".task-header-actions > *")
      .evaluateAll((els) => els.map((e) => [e.tagName, e.textContent])),
    [["A", "Execution"]],
  );

  // A recorded Stop stays a disabled "Stop requested".
  await page.goto(`${web.origin}/app/tasks/${stopped.taskId}`);
  await toggle.click();
  const requested = header.getByRole("button", {
    name: "Stop requested",
    exact: true,
  });
  await requested.waitFor();
  assert.ok(await requested.isDisabled());
  assert.ok(
    await header
      .getByRole("link", { name: "Execution", exact: true })
      .isVisible(),
  );

  // A tap outside the open overflow closes it.
  await page.mouse.click(4, 700);
  await page.waitForFunction(
    () =>
      !document.querySelector(".task-header-overflow")?.hasAttribute("open"),
  );

  // A one-line outcome is read through the strip's disclosure on a phone, and only there.
  const outcome = page.locator(
    "[data-task-strip] details.task-outcome[data-phone-only]",
  );
  assert.equal(
    await outcome.locator("summary").textContent(),
    "Full desired outcome",
  );
  await outcome.locator("summary").click();
  await outcome.getByText("One line outcome.").waitFor();
  await page.setViewportSize({ width: 1366, height: 900 });
  await settle(page);
  assert.equal(await outcome.isVisible(), false);
  // From 760px the header keeps the recorded outcome and carries no phone identity line.
  assert.equal(await header.locator(".page-subtitle-short").isVisible(), false);
  assert.ok(await header.locator(".introduction").isVisible());
  assert.deepEqual(stops, []);
});

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `A card the operator closed stays closed when Back returns to its deep link (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const sectionOf = (card: string) =>
        card === "evidence" ? "result-evidence" : card;
      const a = await seed(fixture.f);
      a.delegatedResult("Recorded decision result", {
        sourceId: a.source.sourceId,
        decisions: [{ text: "Closed card decision", attribution: "Task lead" }],
      });
      const { web, page } = await fixture.launch();
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await taskTab(page, "Overview").waitFor();
      const hrefs = await page.evaluate(() =>
        Promise.all(
          ["Restore", "Closed"].map((query) =>
            fetch(
              `/api/operator/search?query=${query}&historical=true&limit=50`,
            )
              .then((r) => r.json())
              .then((r) => r.data.matches as { type: string; href: string }[]),
          ),
        ),
      );
      const briefHit = hrefs[0]!.find((m) => m.type === "task"),
        decisionHit = hrefs[1]!.find((m) => m.type === "decision");
      assert.ok(
        briefHit && decisionHit,
        "Search finds the brief and the decision",
      );
      // Search record links, entered from the task list and left and returned to by the
      // browser's own Back and Forward: no in-app link on the task page captures its state.
      for (const [hit, card] of [
        [briefHit, "brief"],
        [decisionHit, "evidence"],
      ] as const) {
        await page.goto("about:blank");
        await page.goto(`${web.origin}/app/tasks`);
        await page
          .getByRole("heading", { name: "All tasks", exact: true })
          .waitFor();
        await followInApp(page, hit.href);
        await page.locator(`#${sectionOf(card)} > details[open]`).waitFor();
        await overviewCard(page, card).locator("> summary").click();
        await page
          .locator(`#${sectionOf(card)} > details:not([open])`)
          .waitFor();
        // The browser queues a details' toggle event for its next frame; let it reach the page.
        await settle(page);
        await page.goBack();
        await page
          .getByRole("heading", { name: "All tasks", exact: true })
          .waitFor();
        await page.goForward();
        await taskTab(page, "Overview").waitFor();
        await page.locator(`#${sectionOf(card)} > details`).waitFor();
        await settle(page);
        assert.equal(
          await overviewCard(page, card).getAttribute("open"),
          null,
          `${hit.href}: ${card} stays closed after Back and Forward`,
        );
      }
      for (const [link, card] of [
        ["?section=brief", "brief"],
        ["#brief", "brief"],
        ["?section=assignments", "assignments"],
        ["?section=result-evidence", "evidence"],
        [`?source=${a.source.sourceId}`, "brief"],
      ] as const) {
        await page.goto("about:blank");
        await page.goto(`${web.origin}/app/tasks/${a.taskId}${link}`);
        await page.locator(`#${sectionOf(card)} > details[open]`).waitFor();
        // Close it through its summary, leave the task and come Back.
        await overviewCard(page, card).locator("> summary").click();
        await page
          .locator(`#${sectionOf(card)} > details:not([open])`)
          .waitFor();
        await page.evaluate(() => scrollTo(0, 0));
        await followInApp(page, "/app/tasks");
        await page
          .getByRole("heading", { name: "All tasks", exact: true })
          .waitFor();
        await page.goBack();
        await taskTab(page, "Overview").waitFor();
        await page.locator(`#${sectionOf(card)} > details`).waitFor();
        await settle(page);
        assert.equal(
          await overviewCard(page, card).getAttribute("open"),
          null,
          `${link}: ${card} stays closed after Back`,
        );
      }
    },
  );

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `A page restored from the back-forward cache starts with Task actions and Stop closed and keeps the cards (${engine})`,
    engine,
    async (_t, j) => {
      const fixture = await openFixture(j, engine);
      const a = await seed(fixture.f);
      const { web, page } = await fixture.launch({ width: 390, height: 844 });
      await signIn(page, web.origin, web.password, `/app/tasks/${a.taskId}`);
      await taskTab(page, "Overview").waitFor();
      const overflow = page.locator(
        ".page-header details.task-header-overflow",
      );
      const toggle = page.locator(".page-header .task-header-overflow-toggle");
      await openOverviewCard(page, "brief");
      // A restored page: the overlays the operator had open are closed, the cards are as left.
      // A frame first, so the browser's queued toggle event has reached the page as it would
      // by the time a real restore happens.
      const restore = async () => {
        await settle(page);
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          ),
        );
      };
      await toggle.click();
      await overflow.and(page.locator("[open]")).waitFor();
      await restore();
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".task-header-overflow")
            ?.hasAttribute("open"),
      );
      // The same with the Stop confirmation open behind it.
      await toggle.click();
      await page
        .locator(".task-header-actions button")
        .filter({ hasText: "Stop…" })
        .click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await restore();
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(
        () =>
          !document
            .querySelector(".task-header-overflow")
            ?.hasAttribute("open"),
      );
      assert.notEqual(
        await overviewCard(page, "brief").getAttribute("open"),
        null,
      );

      // Leaving by Execution and coming Back finds the overflow closed too.
      await toggle.click();
      await overflow.and(page.locator("[open]")).waitFor();
      await page
        .locator(`.task-header-actions a[href="/runtime/task/${a.taskId}"]`)
        .click();
      await page.waitForURL(
        (url) => url.pathname === `/runtime/task/${a.taskId}`,
      );
      await page.goBack();
      await taskTab(page, "Overview").waitFor();
      assert.equal(await overflow.getAttribute("open"), null);
    },
  );
