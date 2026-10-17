import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { signOutFromSidebar } from "../fixtures/operator-account.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { openTaskTab } from "../fixtures/task-tabs.js";
import {
  openSearchFromSidebar,
  searchDayEnd,
  searchDayStart,
  searchFieldLabel,
  searchRecords,
} from "../fixtures/shell-search.js";
const test = browserSuite("operator-search-browser");
const backName = "Back to originating workspace";

/** Steps browser history until the URL matches, within a bound so a wrong stack fails fast. */
async function historyUntil(
  page: Page,
  direction: "back" | "forward",
  matches: (url: URL) => boolean,
) {
  for (let step = 0; step < 12; step++) {
    if (direction === "back") await page.goBack();
    else await page.goForward();
    if (matches(new URL(page.url()))) return;
  }
  assert.fail(`History never reached the expected URL; at ${page.url()}`);
}
test("shared Search preserves exact historical target, dates, selected focus and both navigation origins across Back/Forward, failures and phone entry", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Alpha", "Shared command"),
    b = await seedReviewTask(f, "Beta", "Shared command");
  const r = a.result("Shared command R2 original", {
    sourceId: a.source.sourceId,
    decisions: [{ text: "Shared command decision", attribution: "Task lead" }],
  });
  a.result("Shared command R3 current", { sourceId: a.source.sourceId });
  b.result("Shared command Beta");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks?view=board&q=Shared`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  await openSearchFromSidebar(page);
  const now = new Date(),
    day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await searchRecords(page, "Shared command", {
    historical: true,
    type: "result",
    from: day,
    through: day,
  });
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  const searchURL = page.url();
  await page
    .getByText(/^Alpha · /)
    .first()
    .waitFor({ state: "attached" });
  await page
    .getByText(/^Beta · /)
    .first()
    .waitFor({ state: "attached" });
  const desktopBounds = await page
    .locator(
      '.search-workspace select, .search-workspace input[type="date"], .search-matches a',
    )
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    desktopBounds.every((h) => h >= 32),
    JSON.stringify(desktopBounds),
  );
  await captureBrowserEvidence(page, "1366-cross-project-search");
  await page.locator(`[data-search-record="${r.resultId}"] a`).click();
  await page.getByText("Shared command R2 original", { exact: true }).waitFor();
  assert.ok(page.url().includes(`result=${r.resultId}`));
  await page
    .getByRole("link", { name: "Back to originating view", exact: true })
    .click();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  assert.equal(page.url(), searchURL);
  assert.equal(
    await page.getByLabel("From date", { exact: true }).inputValue(),
    day,
  );
  assert.equal(
    await page.getByLabel("Through date", { exact: true }).inputValue(),
    day,
  );
  assert.equal(
    await page.getByLabel("Record type", { exact: true }).inputValue(),
    "result",
  );
  assert.equal(
    await page
      .locator(`[data-search-record="${r.resultId}"] a`)
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await captureBrowserEvidence(page, "1366-restored-selected-match");
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Absent record");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.getByText(/No permitted retained match/).waitFor();
  await page.goBack();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  assert.equal(
    await page
      .getByLabel("Search retained task, decision and result records")
      .inputValue(),
    "Shared command",
  );
  await page.goForward();
  await page.getByText(/No permitted retained match/).waitFor();
  assert.equal(
    await page
      .getByLabel("Search retained task, decision and result records")
      .inputValue(),
    "Absent record",
  );
  await page.goBack();
  await page.locator(`[data-search-record="${r.resultId}"]`).waitFor();
  await page.route("**/api/operator/search?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await page.getByText(/Refresh failed\. Showing the last matches/).waitFor();
  assert.equal(
    await page.locator(`[data-search-record="${r.resultId}"]`).count(),
    1,
  );
  await page.unroute("**/api/operator/search?*");
  // The board is not a task or an Inbox item, so there is no Back; browser Back still restores it.
  assert.equal(await page.getByRole("button", { name: backName }).count(), 0);
  await historyUntil(page, "back", (url) => url.pathname === "/app/tasks");
  assert.equal(page.url(), `${web.origin}/app/tasks?view=board&q=Shared`);
  await page.goto(`${web.origin}/app/projects/${b.projectId}`);
  await page.getByRole("heading", { name: "Beta", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Projects and navigation", exact: true })
    .click();
  await page.getByRole("link", { name: "Search", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Shared command");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator("[data-search-record]").first().waitFor();
  const phoneBounds = await page
    .locator(
      '.search-workspace select, .search-workspace input[type="date"], .search-matches a',
    )
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.ok(
    phoneBounds.every((h) => h >= 44),
    JSON.stringify(phoneBounds),
  );
  // Checklist requirements read as plain excerpts, not raw Markdown.
  const excerpts = await page.locator(".search-excerpt").allTextContents();
  assert.ok(
    excerpts.some((t) => t.includes("Restore focus · Retain drafts")) &&
      !excerpts.some((t) => t.includes("[ ]")),
    JSON.stringify(excerpts),
  );
  await captureBrowserEvidence(page, "390-shared-search");
  assert.equal(await page.getByRole("button", { name: backName }).count(), 0);
  await historyUntil(
    page,
    "back",
    (url) => url.pathname === `/app/projects/${b.projectId}`,
  );
  await page.setViewportSize({ width: 1366, height: 900 });
  await openSearchFromSidebar(page);
  await page
    .getByLabel("Search retained task, decision and result records")
    .fill("Shared command");
  await page
    .getByRole("button", { name: "Search records", exact: true })
    .click();
  await page.locator("[data-search-record]").first().waitFor();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    entry = new Promise<void>((r) => (entered = r));
  await page.route("**/api/operator/search?*", async (route) => {
    const response = await route.fetch();
    entered();
    await barrier;
    await route
      .fulfill({ response })
      .catch((error) =>
        assert.match(String(error), /already handled|Target.*closed/),
      );
  });
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await entry;
  await page.context().clearCookies();
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await page.getByLabel("Password").waitFor();
  assert.equal(new URL(page.url()).search, "");
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByLabel("Search retained task, decision and result records")
    .waitFor();
  release();
  await page.unroute("**/api/operator/search?*");
  assert.equal(
    await page
      .getByLabel("Search retained task, decision and result records")
      .inputValue(),
    "",
  );
  assert.equal(await page.locator("[data-search-record]").count(), 0);
  let documentReplacements = 0,
    lostEvaluationResponses = 0;
  const traversePrivateHistory = async (direction: "back" | "forward") => {
    // Observe the browser's actual traversal, including document replacement,
    // rather than depending on CDP history-command cancellation error strings.
    const previousDocument = await page.evaluate(() => performance.timeOrigin);
    const [navigation, evaluation] = await Promise.allSettled([
      page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: 5000,
      }),
      page.evaluate((next) => history[next](), direction),
    ]);
    if (navigation.status === "rejected") throw navigation.reason;
    if (evaluation.status === "rejected") {
      assert.ok(evaluation.reason instanceof Error);
      assert.equal(
        evaluation.reason.message,
        "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
      );
    }
    const pathname = new URL(page.url()).pathname;
    assert.ok(
      ["/app/search", "/app/tasks", `/app/projects/${b.projectId}`].includes(
        pathname,
      ),
      `Unexpected history destination: ${pathname}`,
    );
    if (pathname === "/app/search") {
      await page
        .getByLabel("Search retained task, decision and result records")
        .waitFor();
      assert.equal(new URL(page.url()).search, "");
      assert.equal(
        await page
          .getByLabel("Search retained task, decision and result records")
          .inputValue(),
        "",
      );
      assert.equal(await page.locator("[data-search-record]").count(), 0);
    } else {
      await page
        .getByRole("heading", {
          name: pathname === "/app/tasks" ? "All tasks" : "Beta",
          exact: true,
        })
        .waitFor();
    }
    const currentDocument = await page.evaluate(() => performance.timeOrigin);
    const replaced = currentDocument !== previousDocument;
    if (replaced) documentReplacements++;
    if (evaluation.status === "rejected") {
      assert.ok(
        replaced,
        "A lost evaluation response requires an observed replacement document",
      );
      lostEvaluationResponses++;
    }
    return pathname;
  };
  const privateHistory = [];
  for (let i = 0; i < 3; i++)
    privateHistory.push(await traversePrivateHistory("back"));
  const forwardDestination = await traversePrivateHistory("forward");
  assert.equal(forwardDestination, privateHistory[1]);
  assert.ok(
    documentReplacements > 0,
    "Private history journey must traverse an actual replacement document",
  );
  console.log(
    `private-history traversals=4 documentReplacements=${documentReplacements} lostEvaluationResponses=${lostEvaluationResponses}`,
  );
  for (const unknown of [false, true]) {
    await openSearchFromSidebar(page, { keepFocus: true });
    await page
      .getByLabel("Search retained task, decision and result records")
      .fill("Shared command");
    await page
      .getByRole("button", { name: "Search records", exact: true })
      .click();
    await page.locator("[data-search-record]").first().waitFor();
    let releaseLate!: () => void, enterLate!: () => void;
    const lateBarrier = new Promise<void>((r) => (releaseLate = r)),
      lateEntry = new Promise<void>((r) => (enterLate = r));
    await page.route("**/api/operator/search?*", async (route) => {
      const response = await route.fetch();
      enterLate();
      await lateBarrier;
      await route
        .fulfill({ response })
        .catch((error) =>
          assert.match(String(error), /already handled|Target.*closed/),
        );
    });
    await page
      .getByRole("button", { name: "Refresh results", exact: true })
      .click();
    await lateEntry;
    if (unknown)
      await page.route("**/api/operator/logout", async (route) => {
        await route.fetch();
        await route.abort("failed");
      });
    await signOutFromSidebar(page);
    await page.getByLabel("Password").waitFor();
    assert.equal(new URL(page.url()).search, "");
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByLabel("Search retained task, decision and result records")
      .waitFor();
    releaseLate();
    await page.unroute("**/api/operator/search?*");
    await page.unroute("**/api/operator/logout");
    assert.equal(
      await page
        .getByLabel("Search retained task, decision and result records")
        .inputValue(),
      "",
    );
    assert.equal(await page.locator("[data-search-record]").count(), 0);
    await page.goBack();
    if (new URL(page.url()).pathname === "/app/search") {
      await page
        .getByLabel("Search retained task, decision and result records")
        .waitFor();
      assert.equal(new URL(page.url()).search, "");
      assert.equal(
        await page
          .getByLabel("Search retained task, decision and result records")
          .inputValue(),
        "",
      );
    }
    await page
      .goForward({ waitUntil: "commit" })
      .catch((error) => assert.match(String(error), /ERR_ABORTED/));
    if (new URL(page.url()).pathname === "/app/search")
      assert.equal(new URL(page.url()).search, "");
  }
});

test("same-task historical Search entries preserve manual origin selections and shared replies while fresh task links use latest", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Entry ownership", "Entry task");
  const old = a.result("Entry ancient result", { sourceId: a.source.sourceId });
  const d = f.service.domain();
  d.execute({
    type: "task.configure",
    actor: "operator",
    key: crypto.randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    expectedVersion: Number(d.task(a.taskId).version),
    outcome: "- [ ] Entry newer source",
  });
  const source = f.service.taskReview().sources(a.taskId).at(-1)!;
  const manual = a.result("Entry manually selected result", {
    sourceId: source.sourceId,
  });
  const latest = a.result("Entry latest result", { sourceId: source.sourceId });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/tasks/${a.taskId}?result=${old.resultId}&source=${a.source.sourceId}&assignment=${a.assignmentId}`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  await page.getByLabel("Result revision").selectOption(manual.resultId);
  await page
    .getByLabel("Retained source revision")
    .selectOption(source.sourceId);
  await page
    .getByText("Entry manually selected result", { exact: true })
    .waitFor();
  await page.getByLabel("Editable reply").fill("Shared unfinished entry reply");
  const assignmentDisclosure = page.locator(
    `#history details[data-record-id="${a.assignmentId}"]`,
  );
  assert.equal(
    await assignmentDisclosure.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    ),
    true,
  );
  await openTaskTab(page, "History");
  await assignmentDisclosure.locator(":scope > summary").click();
  await openTaskTab(page, "Overview");

  const brief = page.locator(`#brief [data-record-id="${source.sourceId}"]`);
  await brief.locator("summary").click();
  await brief.evaluate((el) => el.scrollIntoView());
  await brief.locator("summary").focus();
  const y = await brief.evaluate((el) => el.getBoundingClientRect().top);
  await openSearchFromSidebar(page, { keepFocus: true });
  await searchRecords(page, "Entry ancient result", {
    historical: true,
    type: "result",
  });
  await page.locator(`[data-search-record="${old.resultId}"] a`).click();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
  await page.goBack();
  await page.locator(`[data-search-record="${old.resultId}"]`).waitFor();
  // Each applied filter is its own Search entry, so the empty Search entry sits further back.
  await historyUntil(
    page,
    "back",
    (url) => url.pathname === "/app/search" && !url.search,
  );
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  await page.goBack();
  await page
    .getByText("Entry manually selected result", { exact: true })
    .waitFor();
  await page.waitForFunction(
    ({ id, y }) => {
      const el = document.querySelector(`[data-record-id="${id}"]`);
      return (
        el instanceof HTMLDetailsElement &&
        el.open &&
        Math.abs(el.getBoundingClientRect().top - y) < 4 &&
        document.activeElement === el.querySelector("summary")
      );
    },
    { id: source.sourceId, y },
  );
  assert.equal(
    await page.getByLabel("Result revision").inputValue(),
    manual.resultId,
  );
  assert.equal(
    await page.getByLabel("Retained source revision").inputValue(),
    source.sourceId,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
  assert.equal(
    await assignmentDisclosure.evaluate(
      (el) => (el as HTMLDetailsElement).open,
    ),
    false,
  );
  await captureBrowserEvidence(page, "1366-restored-manual-task-entry");
  await page.goForward();
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  await historyUntil(
    page,
    "forward",
    (url) => url.searchParams.get("type") === "result",
  );
  await page.locator(`[data-search-record="${old.resultId}"]`).waitFor();
  await page.goForward();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  await page.getByRole("link", { name: "Entry task", exact: true }).click();
  await page.getByText("Entry latest result", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Result revision").inputValue(), "");
  assert.equal(
    await page.getByLabel("Retained source revision").inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
  assert.equal(
    latest.resultId,
    f.service.taskReview().read(a.taskId).results.at(-1)?.resultId,
  );
  await openSearchFromSidebar(page);
  await searchRecords(page, "Entry ancient result", {
    historical: true,
    type: "result",
  });
  await page.locator(`[data-search-record="${old.resultId}"] a`).click();
  await page.getByText("Entry ancient result", { exact: true }).waitFor();
  await page.goBack();
  await page.locator(`[data-search-record="${old.resultId}"]`).waitFor();
  // Each applied filter is its own Search entry, so the empty Search entry sits further back.
  await historyUntil(
    page,
    "back",
    (url) => url.pathname === "/app/search" && !url.search,
  );
  await page.getByRole("heading", { name: "Search", exact: true }).waitFor();
  await page.goBack();
  await page.getByText("Entry latest result", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Result revision").inputValue(), "");
  assert.equal(
    await page.getByLabel("Retained source revision").inputValue(),
    "",
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Shared unfinished entry reply",
  );
});

test("in-flight exact reply becomes original-key reconciliation across same-task entry disposal", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Reply entry", "Pending entry task");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage();
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Editable reply").fill("Exact in-flight reply");
  let release!: () => void, entered!: () => void, settled!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    arrival = new Promise<void>((r) => (entered = r)),
    done = new Promise<void>((r) => (settled = r));
  let originalKey = "";
  await page.route("**/api/operator/commands", async (route) => {
    const input = route.request().postDataJSON();
    if (input.type !== "message" || originalKey) {
      await route.continue();
      return;
    }
    originalKey = input.key;
    const response = await route.fetch();
    entered();
    await barrier;
    await route.fulfill({ response });
    settled();
  });
  try {
    await page
      .getByRole("button", { name: "Send to task lead", exact: true })
      .click();
    await arrival;
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await page
      .getByRole("heading", { name: "All tasks", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "Pending entry task", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Check whether it saved",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.getByLabel("Editable reply").inputValue(),
      "Exact in-flight reply",
    );
    assert.equal(await page.getByLabel("Editable reply").isDisabled(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Message task lead", exact: true })
        .isDisabled(),
      true,
    );
    release();
    await done;
    assert.equal(
      await page.getByLabel("Editable reply").inputValue(),
      "Exact in-flight reply",
    );
    await page
      .getByRole("button", {
        name: "Check whether it saved",
        exact: true,
      })
      .click();
    // The original request key stays reachable, but only inside Details.
    const sentOutcome = page.locator("[data-slot=action-outcome]");
    await sentOutcome.waitFor();
    assert.equal(await sentOutcome.count(), 1);
    assert.equal(
      await sentOutcome.innerText().then((t) => t.includes(originalKey)),
      false,
    );
    await sentOutcome.getByText("Details", { exact: true }).click();
    assert.equal(
      await sentOutcome
        .locator("dt", { hasText: "Request key" })
        .locator("xpath=following-sibling::dd")
        .innerText(),
      originalKey,
    );
    assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.text === "Exact in-flight reply").length,
      1,
    );
  } finally {
    release();
  }
});

test("Search shows Back only after arriving from a task or Inbox item", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const task = await seedReviewTask(
    f,
    "Back project",
    "Back origin task",
    "- [ ] Zebra anchor requirement",
  );
  const asked = await seedOwnQuestion(f, undefined, "Back origin question");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const back = page.getByRole("button", { name: backName, exact: true });
  const searchField = page.getByLabel(searchFieldLabel);
  const taskURL = `${web.origin}/app/tasks/${task.taskId}`;

  // Direct entry, with and without a query, and a reload: nothing to go back to.
  await page.goto(`${web.origin}/app/search`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await searchField.waitFor();
  assert.equal(await back.count(), 0);
  await page.goto(`${web.origin}/app/search?query=Zebra%20anchor`);
  await page.locator("#search-count").waitFor();
  assert.equal(await back.count(), 0);
  // A reload purges the private query and the origin along with it.
  await page.reload();
  await searchField.waitFor();
  assert.equal(new URL(page.url()).search, "");
  assert.equal(await back.count(), 0);

  // Overview, the board, a project page and the Inbox list are not items.
  for (const origin of [
    "/app",
    "/app/tasks?view=board",
    `/app/projects/${task.projectId}`,
    "/app/inbox",
  ]) {
    await page.goto(`${web.origin}${origin}`);
    if (origin === "/app/inbox")
      await page.locator(".inbox-row").first().waitFor();
    assert.equal(
      page.url(),
      `${web.origin}${origin}`,
      "the origin is the list, not an item",
    );
    await openSearchFromSidebar(page);
    assert.equal(await back.count(), 0, origin);
  }

  // A task detail: Back survives filter changes and a round trip through an opened match.
  await page.goto(taskURL);
  await page
    .getByRole("heading", { name: "Back origin task", exact: true })
    .waitFor();
  await openSearchFromSidebar(page);
  assert.equal(await back.count(), 1);
  await page.reload();
  await searchField.waitFor();
  assert.equal(await back.count(), 0);
  await page.goBack();
  await page
    .getByRole("heading", { name: "Back origin task", exact: true })
    .waitFor();
  await openSearchFromSidebar(page);
  assert.equal(await back.count(), 1);
  await searchRecords(page, "Zebra anchor", { type: "task" });
  assert.equal(await back.count(), 1);
  await page.locator("[data-search-record] a").first().click();
  await page
    .getByRole("heading", { name: "Back origin task", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "Back to originating view", exact: true })
    .click();
  await page.locator("#search-count").waitFor();
  assert.equal(await back.count(), 1);
  await back.click();
  await page
    .getByRole("heading", { name: "Back origin task", exact: true })
    .waitFor();
  assert.equal(page.url(), taskURL);
  assert.equal(await searchField.count(), 0);

  // An Inbox item returns to that exact item.
  await page.goto(`${web.origin}/app/inbox`);
  await page.locator(".inbox-row").first().click();
  const pressed = page.locator(".inbox-row[aria-pressed='true']");
  await pressed.waitFor();
  const itemURL = page.url();
  assert.match(new URL(itemURL).search, /^\?task=[^&]+&request=./);
  await openSearchFromSidebar(page);
  assert.equal(await back.count(), 1);
  await searchRecords(page, "Restore focus", { historical: true });
  assert.equal(await back.count(), 1);
  await back.click();
  await pressed.waitFor();
  assert.equal(page.url(), itemURL);
  assert.equal(await searchField.count(), 0);
  assert.ok(asked.taskId);

  // Signing out drops the origin: the next Search is not "from" anywhere.
  await page.goto(taskURL);
  await openSearchFromSidebar(page);
  assert.equal(await back.count(), 1);
  await signOutFromSidebar(page);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await searchField.waitFor();
  assert.equal(await back.count(), 0);
});

test("Search leads with the field and shows filters beside the result count once there is a query", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(
    f,
    "Lead alpha",
    "Leads alpha",
    "- [ ] Leads requirement alpha",
  );
  a.result("Leads result alpha", {
    sourceId: a.source.sourceId,
    decisions: [{ text: "Leads decision alpha", attribution: "Task lead" }],
  });
  const b = await seedReviewTask(
    f,
    "Lead beta",
    "Leads beta",
    "- [ ] Leads requirement beta",
  );
  b.result("Leads result beta");
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const searchReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/operator/search")
      searchReads.push(request.url());
  });
  const filters = {
    project: page.getByLabel("Project", { exact: true }),
    type: page.getByLabel("Record type", { exact: true }),
    from: page.getByLabel("From date", { exact: true }),
    through: page.getByLabel("Through date", { exact: true }),
    historical: page.getByLabel("Include historical records"),
  };
  const searchParam = (name: string) =>
    new URL(page.url()).searchParams.get(name);
  const recordTypes = () =>
    page
      .locator("[data-search-record] .search-match-head > :first-child")
      .allTextContents();
  /** Waits for the Search page that replaces the current one, after `action` changed the URL. */
  const replaced = async (action: () => Promise<unknown>) => {
    await page
      .locator(".search-workspace")
      .evaluate((el) => el.setAttribute("data-replaced", ""));
    await action();
    await page
      .locator(".search-workspace[data-replaced]")
      .waitFor({ state: "detached" });
  };
  const renderedFrame = () =>
    page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => done())),
    );

  // Before a query: the field and one coverage line, no filters.
  await page.goto(`${web.origin}/app/search`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel(searchFieldLabel).waitFor();
  for (const control of Object.values(filters))
    assert.equal(await control.count(), 0);
  assert.equal(
    await page
      .locator(".search-workspace")
      .locator("input, select, button")
      .first()
      .getAttribute("id"),
    "retained-query",
  );
  await page.getByText("Enter a phrase to search across projects.").waitFor();
  const coverage = page.locator(".search-coverage");
  assert.equal(
    await coverage.innerText(),
    "Searches saved excerpts, not full agent transcripts.",
  );
  assert.equal(
    await coverage.getAttribute("title"),
    "Covers permitted retained task, decision and result excerpts, up to 16,000 characters each. Long source coverage is partial. It does not generate summaries.",
  );
  const oneLine = () =>
    coverage.evaluate((el) => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      return el.getBoundingClientRect().height <= lineHeight * 1.5;
    });
  assert.equal(await oneLine(), true);

  // After a query: every filter, the count and Refresh share the results header.
  await searchRecords(page, "Leads");
  const header = page.locator("section.search-results .search-results-head");
  await page.locator("#search-count").waitFor();
  for (const control of Object.values(filters))
    assert.equal(await header.locator(control).count(), 1);
  assert.equal(await header.locator("#search-count").count(), 1);
  assert.equal(
    await header
      .getByRole("button", { name: "Refresh results", exact: true })
      .count(),
    1,
  );
  assert.equal(await page.locator("form").getByLabel("Record type").count(), 0);
  assert.ok((await recordTypes()).includes("Task"));
  assert.equal(await oneLine(), true);
  await captureBrowserEvidence(page, "1366-search-header-filters");

  // Type applies on change and every rendered match is of that type, whatever the order.
  await replaced(async () => {
    await filters.type.selectOption("result");
    await page.waitForURL((url) => url.searchParams.get("type") === "result");
  });
  await page.locator("[data-search-record]").first().waitFor();
  const results = await recordTypes();
  assert.ok(results.length > 0);
  assert.ok(
    results.every((type) => type === "Result"),
    JSON.stringify(results),
  );
  assert.equal(await filters.type.inputValue(), "result");

  // A new filter drops the cursor of the page it was read from.
  await page.route("**/api/operator/search?*", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    const body = await response.json();
    if (!url.searchParams.has("cursor"))
      body.data.nextCursor = body.data.matches.at(-1)?.recordId ?? null;
    await route
      .fulfill({ response, json: body })
      .catch((error) =>
        assert.match(String(error), /already handled|Target.*closed/),
      );
  });
  await replaced(async () => {
    await filters.type.selectOption("");
    await page.waitForURL((url) => !url.searchParams.has("type"));
  });
  await page
    .getByRole("button", { name: "Next retained matches", exact: true })
    .waitFor();
  await replaced(async () => {
    await page
      .getByRole("button", { name: "Next retained matches", exact: true })
      .click();
    await page.waitForURL((url) => url.searchParams.has("cursor"));
  });
  await page.locator("#search-count").waitFor();
  await replaced(async () => {
    await filters.type.selectOption("task");
    await page.waitForURL((url) => url.searchParams.get("type") === "task");
  });
  assert.equal(searchParam("cursor"), null);
  await page.unroute("**/api/operator/search?*");

  // Dates apply on blur or Enter, never on each keystroke, and only when changed.
  const now = new Date(),
    day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const before = searchReads.length;
  await filters.from.fill(day);
  await renderedFrame();
  assert.equal(searchParam("after"), null);
  assert.equal(searchReads.length, before);
  await replaced(async () => {
    await filters.from.blur();
    await page.waitForURL(
      (url) => url.searchParams.get("after") === searchDayStart(day),
    );
  });
  assert.equal(await filters.from.inputValue(), day);
  const entries = await page.evaluate(() => history.length),
    reads = searchReads.length;
  await filters.from.focus();
  await filters.from.blur();
  await renderedFrame();
  assert.equal(await page.evaluate(() => history.length), entries);
  assert.equal(searchReads.length, reads);
  await filters.through.fill(day);
  await renderedFrame();
  assert.equal(searchParam("before"), null);
  await replaced(async () => {
    await filters.through.press("Enter");
    await page.waitForURL(
      (url) => url.searchParams.get("before") === searchDayEnd(day),
    );
  });
  assert.equal(await filters.through.inputValue(), day);

  // Back and Forward restore the filter values of each entry.
  await replaced(async () => {
    await filters.historical.check();
    await page.waitForURL(
      (url) => url.searchParams.get("historical") === "true",
    );
  });
  await page.goBack();
  await filters.historical.waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLInputElement>(".search-history input")
        ?.checked,
  );
  assert.equal(searchParam("historical"), "false");
  assert.equal(await filters.through.inputValue(), day);
  await page.goBack();
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLInputElement>("#search-through-date")?.value,
  );
  assert.equal(searchParam("before"), null);
  assert.equal(await filters.type.inputValue(), "task");
  await page.goForward();
  await page.waitForFunction(
    (value) =>
      document.querySelector<HTMLInputElement>("#search-through-date")
        ?.value === value,
    day,
  );
  await page.goForward();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>(".search-history input")
        ?.checked === true,
  );
  assert.equal(searchParam("historical"), "true");

  // A failed first read keeps the filters, and changing one reads again.
  let failing = true;
  await page.route("**/api/operator/search?*", (route) =>
    failing
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "unavailable" } }),
        })
      : route.continue(),
  );
  await page.goto(`${web.origin}/app/search?query=Leads`);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator("#search-count").count(), 0);
  for (const control of Object.values(filters))
    assert.equal(await control.count(), 1);
  failing = false;
  await replaced(async () => {
    await filters.type.selectOption("result");
    await page.waitForURL((url) => url.searchParams.get("type") === "result");
  });
  await page.locator("[data-search-record]").first().waitFor();
  assert.ok((await recordTypes()).every((type) => type === "Result"));
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.unroute("**/api/operator/search?*");

  // A read held while a filter changes never renders over the newer one.
  let release!: () => void, entered!: () => void, delivered!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve)),
    entry = new Promise<void>((resolve) => (entered = resolve)),
    done = new Promise<void>((resolve) => (delivered = resolve));
  let held = false;
  await page.route("**/api/operator/search?*", async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    entered();
    await barrier;
    await route
      .fulfill({ response })
      .catch((error) =>
        assert.match(String(error), /already handled|Target.*closed/),
      )
      .finally(delivered);
  });
  await page.goto(`${web.origin}/app/search?query=Leads`);
  await entry;
  await replaced(async () => {
    await filters.type.selectOption("result");
    await page.waitForURL((url) => url.searchParams.get("type") === "result");
  });
  await page.locator("[data-search-record]").first().waitFor();
  release();
  await done;
  await renderedFrame();
  assert.equal(searchParam("type"), "result");
  assert.equal(await filters.type.inputValue(), "result");
  assert.ok((await recordTypes()).every((type) => type === "Result"));
  await page.unroute("**/api/operator/search?*");

  // Phone: the header controls stay 44px and the note stays one line.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web.origin}/app/search`);
  await searchRecords(page, "Leads");
  const heights = await page
    .locator(
      ".search-results-head select, .search-results-head input[type=date], .search-results-head .search-history, .search-results-head button",
    )
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  assert.equal(heights.length, 6);
  assert.ok(
    heights.every((h) => h >= 44),
    JSON.stringify(heights),
  );
  assert.equal(await oneLine(), true);
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
  );
  await captureBrowserEvidence(page, "390-search-header-filters");
});
