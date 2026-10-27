import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { CoordinationStore } from "../../src/core/coordination.js";
import { ConversationHistoryStore } from "../../src/standalone/conversation-history.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { ExecutionState } from "../../src/standalone/state.js";
import {
  leadReceivesNotice,
  leadResumeNotice,
} from "../../web/src/lead-feedback.js";
import {
  markLeadStarted,
  seedReviewTask,
  setLinkedRepository,
} from "../fixtures/task-review.js";
import { openTaskTab } from "../fixtures/task-tabs.js";
import { openSearchFromSidebar } from "../fixtures/shell-search.js";
const test = browserSuite("operator-task-workspace-browser");
/** Service vocabulary, digits and codes that never appear in a message (see the Settings wording test). */
const serviceWords =
  /recorded|receipt|observation|admission|reconcile|submission|revision|\d|project\.|conflict|invalid/i;
test("production workspace retains literal history, pending request, focused reply and exact result through updates and failed reads on desktop and phone", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f),
    r = a.delegatedResult("Original source-faithful result"),
    questionId = randomUUID();
  markLeadStarted(f, a.assignmentId);
  // Delivery controls belong to a task whose project links a repository.
  setLinkedRepository(f, a.projectId, true);
  f.seedPersistedState((db) => {
    for (let i = 0; i < 250; i++)
      db.prepare(
        "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,1,1)",
      ).run(
        r.workId,
        a.taskId,
        r.assignmentId,
        r.workId,
        r.workId,
        `item-${i}`,
        `Literal update ${i} ` +
          "long supplied text ".repeat(i === 249 ? 500 : 1),
      );
    db.prepare(
      "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,revision) VALUES(?,?,?,?,1,1,1,'question','open','Which focus target?',1)",
    ).run(questionId, a.taskId, r.assignmentId, r.workId);
  });
  const responsibilityAssignmentId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    assignmentId: responsibilityAssignmentId,
    projectId: a.projectId,
    taskId: a.taskId,
    profileId: a.profileId,
    brief: "Review responsibility distinct from implementation",
    resultDestination: a.assignmentId,
    requesterAssignmentId: a.assignmentId,
  });
  const responsibilityResult = a.result(
    "Exact responsibility review result",
    undefined,
    responsibilityAssignmentId,
  );
  f.seedPersistedState((db) => {
    const capture = new ConversationHistoryStore(db);
    for (const result of [
      r,
      { ...responsibilityResult, assignmentId: responsibilityAssignmentId },
    ]) {
      const binding = {
        taskId: a.taskId,
        assignmentId: result.assignmentId,
        workId: result.workId,
        assignmentVersion: 1,
        instructionsRevision: 1,
        profileRevision: 1,
        conversationRevision: 1,
        workRevision: result === r ? 1 : 2,
        threadId: result.workId,
        turnId: result.workId,
      };
      capture.recordEarlyBufferLimit(binding);
      capture.recordEarlyBufferLimit(binding);
    }
  });
  const omissionApi = new OperatorApi(f.service, [f.directory]);
  const omissionOnly = await omissionApi.readAssignmentHistory(
    responsibilityAssignmentId,
  );
  assert.equal(omissionOnly.data.items.length, 0);
  assert.equal(omissionOnly.data.turnOmissions.length, 1);
  assert.equal(
    omissionOnly.data.turnOmissions[0]?.reason,
    "early-buffer-limit",
  );
  const mixed = await omissionApi.readAssignmentHistory(r.assignmentId);
  assert.equal(mixed.data.turnOmissions.length, 1);
  const earlierMixed = await omissionApi.readAssignmentHistory(
    r.assignmentId,
    mixed.data.items[0]!.sequence,
  );
  assert.equal(earlierMixed.data.turnOmissions.length, 1);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/app/tasks/${a.taskId}?result=${r.resultId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Latest result", exact: true })
    .waitFor();
  await page
    .locator("#history")
    .getByText("Review responsibility distinct from implementation", {
      exact: true,
    })
    .waitFor({ state: "attached" });
  assert.ok((await page.getByText(/Requester assignment:/).count()) >= 2);
  assert.equal(
    await page.getByText("Which focus target?", { exact: true }).count(),
    1,
  );
  await openTaskTab(page, "History");
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Load earlier retained history/ })
    .click();
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "attached" });
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  assert.equal(
    await page.locator('[data-record-id^="turn-omission:"]').count(),
    2,
  );
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  assert.equal(
    await page.locator('[data-record-id^="turn-omission:"]').count(),
    2,
  );
  await page
    .getByRole("button", { name: "Chronological view", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand all history", exact: true })
    .click();
  const omission = page.locator(
    `[data-record-id="turn-omission:${r.workId}:${r.workId}:${r.workId}"]`,
  );
  await omission
    .getByText(
      `Early buffer limit (early-buffer-limit). Work ${r.workId}; assignment ${r.assignmentId}; thread ${r.workId}; turn ${r.workId}. Captured turn content is unavailable.`,
      { exact: true },
    )
    .waitFor();
  await omission.scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "1366-retained-turn-omissions", {
    fullPage: false,
  });
  const reading = page.locator(`[data-record-id="${r.workId}:item-0"]`);
  await reading.scrollIntoViewIfNeeded();
  const readingY = await reading.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  // Advance the actual retained window after its earlier page was loaded.
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO conversation_history_items(workId,taskId,assignmentId,assignmentVersion,instructionsRevision,profileRevision,conversationRevision,workRevision,threadId,turnId,itemId,lifecycle,text,omissionReason,deltaBytes,createdAt,updatedAt) VALUES(?,?,?,1,1,1,1,1,?,?,?,'completed',?,NULL,0,1,1)",
      )
      .run(
        r.workId,
        a.taskId,
        r.assignmentId,
        r.workId,
        r.workId,
        "item-250",
        "Literal update 250 newer retained item",
      ),
  );
  await reading.locator("summary").focus();
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await reading.evaluate((el) => el.getBoundingClientRect().top)) -
        readingY,
    ) < 4,
    JSON.stringify({
      readingY,
      actualY: await reading.evaluate((el) => el.getBoundingClientRect().top),
      scroll: await page.evaluate(() => scrollY),
    }),
  );
  assert.equal(
    await reading
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  const retainedIds = await page
    .locator(`[data-record-id^="${r.workId}:item-"]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-record-id")));
  assert.equal(retainedIds.length, 251);
  assert.equal(new Set(retainedIds).size, 251);
  assert.equal(
    await page.locator('[data-record-id^="turn-omission:"]').count(),
    2,
  );
  for (let item = 0; item <= 250; item++)
    assert.ok(retainedIds.includes(`${r.workId}:item-${item}`));
  // Exercise the production 15-second polling callback without waiting wall-clock time.
  const timerHistory = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/assignments/${r.assignmentId}/history?beforeSequence=`),
  );
  await page.clock.runFor(15000);
  await timerHistory;
  await reading.waitFor({ state: "attached" });
  assert.equal(
    await reading
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  const explicitRefresh = page.getByRole("button", {
    name: "Refresh task",
    exact: true,
  });
  const explicitHistory = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/assignments/${r.assignmentId}/history?beforeSequence=`),
  );
  await explicitRefresh.click();
  await explicitHistory;
  await reading.waitFor({ state: "attached" });
  assert.equal(
    await explicitRefresh.evaluate((el) => el === document.activeElement),
    true,
  );
  await reading.locator("summary").focus();
  let releaseFocus!: () => void, enterFocus!: () => void;
  const focusBarrier = new Promise<void>((r) => (releaseFocus = r)),
    focusEntry = new Promise<void>((r) => (enterFocus = r));
  let focusHeld = false;
  const focusRoute = `**/api/operator/assignments/${r.assignmentId}/history*`;
  await page.route(focusRoute, async (route) => {
    const response = await route.fetch();
    if (!focusHeld) {
      focusHeld = true;
      enterFocus();
      await focusBarrier;
    }
    await route.fulfill({ response });
  });
  await explicitRefresh.evaluate((el) => (el as HTMLElement).click());
  await focusEntry;
  await reading.waitFor({ state: "detached" });
  // The operator moves to the reply on Overview while the history read is held.
  await openTaskTab(page, "Overview");
  await page.getByLabel("Editable reply").focus();
  releaseFocus();
  await reading.waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByLabel("Editable reply")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.unroute(focusRoute);
  await openTaskTab(page, "History");
  await reading.scrollIntoViewIfNeeded();
  await reading.locator("summary").focus();
  const navigationReadingY = await reading.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await openSearchFromSidebar(page, { keepFocus: true });
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await reading.evaluate((el) => el.getBoundingClientRect().top)) -
        navigationReadingY,
    ) < 4,
    JSON.stringify({
      readingY: navigationReadingY,
      actualY: await reading.evaluate((el) => el.getBoundingClientRect().top),
      scroll: await page.evaluate(() => scrollY),
    }),
  );
  assert.equal(
    await reading
      .locator("summary")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await openTaskTab(page, "Overview");
  await page
    .getByLabel("Editable reply")
    .fill("Navigation draft remains exact");
  await openTaskTab(page, "History");
  const exactLink = page.getByRole("link", {
    name: `Open exact assignment result ${responsibilityResult.resultId}`,
    exact: true,
  });
  await exactLink.scrollIntoViewIfNeeded();
  await exactLink.focus();
  const exactY = await exactLink.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await exactLink.click();
  const reviewHeading = page.getByRole("heading", {
    name: "Latest result",
    exact: true,
  });
  await page
    .getByText("Exact responsibility review result", { exact: true })
    .waitFor();
  const destination = await page.locator("#review").evaluate((el) => ({
    y: el.getBoundingClientRect().top,
    margin: parseFloat(getComputedStyle(el).scrollMarginTop),
  }));
  assert.ok(
    Math.abs(destination.y - destination.margin) < 4,
    JSON.stringify(destination),
  );
  assert.equal(
    await reviewHeading.evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByText("Exact responsibility review result", { exact: true })
    .waitFor();
  const returnedTask = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/operator/tasks/${a.taskId}` &&
      url.searchParams.get("resultId") === r.resultId
    );
  });
  const returnedHistory = page.waitForResponse((response) =>
    response
      .url()
      .includes(`/assignments/${r.assignmentId}/history?beforeSequence=`),
  );
  await page.goBack();
  await returnedTask;
  await returnedHistory;
  await reading.waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await exactLink.evaluate((el) => el.getBoundingClientRect().top)) -
        exactY,
    ) < 4,
    JSON.stringify({
      expected: exactY,
      actual: await exactLink.evaluate((el) => el.getBoundingClientRect().top),
      path: page.url(),
      focus: await page.evaluate(() => document.activeElement?.outerHTML),
    }),
  );
  assert.equal(
    await exactLink.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Navigation draft remains exact",
  );
  await page
    .getByRole("button", { name: "Collapse all history", exact: true })
    .click();
  // History hides Overview's request; the strip names it, and its button opens it.
  await page
    .locator("[data-task-strip]")
    .getByRole("button", { name: "Next: you · answer question" })
    .click();
  assert.ok(
    await page.getByText("Which focus target?", { exact: true }).isVisible(),
  );
  // The restored navigation draft has been checked; explicitly finish that intent.
  await page.getByLabel("Editable reply").fill("");
  await page
    .getByRole("button", { name: "Ask lead about result", exact: true })
    .click();
  await page.getByLabel("Editable reply").fill("Unfinished contextual reply");
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished contextual reply",
  );
  a.delegatedResult("Newer result must not replace selected historical result");
  await page.getByLabel("Editable reply").focus();
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => {
      if (el instanceof HTMLElement) el.click();
    });
  await page
    .getByText("Original source-faithful result", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished contextual reply",
  );
  assert.equal(
    await page
      .getByLabel("Editable reply")
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await page.getByLabel("Editable reply").focus();
  await page.route("**/api/operator/tasks/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .first()
    .waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Unfinished contextual reply",
  );
  assert.ok(
    await page
      .getByText("Original source-faithful result", { exact: true })
      .isVisible(),
  );
  await captureBrowserEvidence(page, "1366-task-failed-refresh");
  await page.unroute("**/api/operator/tasks/*");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Editable reply").scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-reply-with-anchor");
  await page.setViewportSize({ width: 390, height: 480 });
  await page.getByLabel("Editable reply").focus();
  assert.ok(
    await page
      .getByRole("button", { name: "Send to task lead", exact: true })
      .isEnabled(),
  );
  await captureBrowserEvidence(page, "390-keyboard-reply", { fullPage: false });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page
    .getByRole("button", { name: "Send to task lead", exact: true })
    .waitFor();
  let lost = true;
  const replyRequests: string[] = [];
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type === "message") {
      replyRequests.push(route.request().postData() ?? "");
      if (lost) {
        lost = false;
        await route.fetch();
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "command-outcome-unknown" } }),
        });
        return;
      }
    }
    await route.continue();
  });
  const taskBefore = f.service.domain().task(a.taskId).version;
  await page
    .getByRole("button", { name: "Send to task lead", exact: true })
    .click();
  // One warning, in plain words: the draft is kept, the code is only in Details, and the
  // single action is the exact-request check.
  const outcome = page.locator("[data-slot=action-outcome]");
  await outcome
    .getByText("We couldn't confirm it was sent. Your draft is kept.")
    .waitFor();
  assert.equal(await outcome.count(), 1);
  assert.equal(await outcome.getByRole("button").count(), 1);
  assert.doesNotMatch(await outcome.locator("p").innerText(), serviceWords);
  assert.equal(
    await page.getByRole("button", { name: "Send to task lead" }).count(),
    0,
  );
  assert.equal(await page.getByLabel("Editable reply").isDisabled(), true);
  await outcome.getByText("Details", { exact: true }).click();
  const fields = await outcome.locator("dl").innerText();
  assert.match(fields, /Command\s+message/);
  assert.match(fields, /Request key\s+[0-9a-f-]{36}/);
  assert.match(fields, /Code\s+command-outcome-unknown/);
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/operator/commands") &&
        (r.request().postData() ?? "").includes("review.view"),
    ),
    page
      .getByRole("button", { name: "Set viewing reference", exact: true })
      .click(),
  ]);
  // A different action's outcome never replaces an unknown reply outcome, or takes the focus.
  await outcome.waitFor();
  assert.equal(await outcome.count(), 1);
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Set viewing reference",
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .isEnabled(),
  );
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/operator/commands") &&
        (r.request().postData() ?? "").includes("delivery.refresh"),
    ),
    (async () => {
      await openTaskTab(page, "Changes");
      await page
        .getByRole("button", {
          name: "Refresh delivery status",
          exact: true,
        })
        .click();
    })(),
  ]);
  await outcome.waitFor({ state: "attached" });
  assert.equal(await outcome.count(), 1);
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Refresh delivery status",
  );
  await openTaskTab(page, "Overview");
  assert.ok(
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .isEnabled(),
  );
  await page.getByLabel("Editable reply").scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "390-uncertain-reply", {
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await page.getByText("Sent to Task lead.", { exact: true }).waitFor();
  assert.equal(await outcome.count(), 1);
  assert.doesNotMatch(await outcome.locator("p").innerText(), serviceWords);
  await outcome.getByText("Details", { exact: true }).click();
  assert.match(await outcome.locator("dl").innerText(), /Kind\s+coordination/);
  assert.equal(replyRequests.length, 2);
  assert.equal(replyRequests[0], replyRequests[1]);
  assert.equal(f.service.domain().task(a.taskId).version, taskBefore);
  assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
  const local = f.service
    .coordinationView()
    .readTask(a.taskId)
    .messages.filter((m) => m.text === "Unfinished contextual reply");
  assert.equal(local.length, 1);
  assert.equal(local[0]?.reference?.resultId, r.resultId);
  // Results and Changes writes whose response is lost stay one exact request: their control is
  // off, the check replays the same request, and nothing builds a new one from the selection.
  await page.setViewportSize({ width: 1366, height: 900 });
  for (const [type, control, done] of [
    ["review.view", "Set viewing reference", "Viewing reference set."],
    [
      "delivery.refresh",
      "Refresh delivery status",
      "Delivery status refreshed.",
    ],
  ] as const) {
    const bodies: string[] = [];
    let lost = true;
    // Viewing is set on Overview; delivery is observed on Changes.
    await openTaskTab(page, type === "review.view" ? "Overview" : "Changes");
    await page.route("**/api/operator/commands", async (route) => {
      const body = route.request().postDataJSON() as { type?: string };
      if (body.type !== type) return route.fallback();
      bodies.push(route.request().postData() ?? "");
      if (lost) {
        lost = false;
        await route.fetch();
        await route.abort("connectionreset");
      } else await route.continue();
    });
    await page.getByRole("button", { name: control, exact: true }).click();
    const lostOutcome = page
      .locator("[data-slot=action-outcome]")
      .filter({ hasText: "We couldn't confirm" });
    await lostOutcome.waitFor();
    assert.equal(await lostOutcome.count(), 1);
    assert.equal(await lostOutcome.getByRole("button").count(), 1);
    assert.equal(
      await page
        .getByRole("button", { name: control, exact: true })
        .isDisabled(),
      true,
    );
    await lostOutcome.getByText("Details", { exact: true }).click();
    assert.match(
      await lostOutcome.locator("dl").innerText(),
      /Request key\s+[0-9a-f-]{36}/,
    );
    if (type === "review.view") {
      // The exact request is kept with the task, not the page: leaving and coming back
      // finds the control still off and the check still there.
      await openSearchFromSidebar(page, { keepFocus: true });
      await page
        .getByRole("button", {
          name: "Back to originating workspace",
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: control, exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: control, exact: true })
          .isDisabled(),
        true,
      );
    }
    await lostOutcome
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .click();
    await page.getByText(done, { exact: true }).waitFor();
    // Focus returns to the control once its request is settled.
    await page.waitForFunction(
      (label) => document.activeElement?.textContent === label,
      control,
    );
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(
      await page
        .getByRole("button", { name: control, exact: true })
        .isEnabled(),
      true,
    );
    await page.unroute("**/api/operator/commands");
  }
  await openTaskTab(page, "Overview");
  // A running lead receives feedback on its next eligible turn (frame 03a).
  assert.equal(
    await page
      .getByText(leadReceivesNotice("Task lead"), { exact: true })
      .count(),
    1,
  );
  a.result("Terminal accountable lead result");
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  // A completed lead is resumed by feedback (#828): the line says so and Send stays enabled.
  await page
    .getByText(leadResumeNotice("Task lead"), { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByText(leadReceivesNotice("Task lead"), { exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Ask lead about result", exact: true })
    .click();
  assert.ok(await page.getByLabel("Editable reply").isEditable());
  assert.equal(
    await page
      .getByRole("button", { name: "Send to task lead", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(replyRequests.length, 2);
  let releaseHistory!: () => void,
    historyEntered!: () => void,
    historySettled!: () => void;
  const historyBarrier = new Promise<void>((r) => (releaseHistory = r)),
    historyEntry = new Promise<void>((r) => (historyEntered = r)),
    historyDone = new Promise<void>((r) => (historySettled = r));
  let delayedHistory = false;
  const batchRequests: string[] = [];
  const historyRoute = `**/api/operator/assignments/${r.assignmentId}/history*`;
  await page.route(historyRoute, async (route) => {
    batchRequests.push(route.request().url());
    const response = await route.fetch();
    if (!delayedHistory && !route.request().url().includes("beforeSequence")) {
      delayedHistory = true;
      historyEntered();
      await historyBarrier;
      await route.fulfill({ response });
      historySettled();
    } else await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await historyEntry;
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(f.service.domain().profile(a.profileId).version),
    instructions: "Literal update 0 long supplied text",
  });
  await page.getByRole("button", { name: "Refresh task", exact: true }).click();
  await page
    .getByText("Literal update 0 long supplied text ", { exact: true })
    .waitFor({ state: "detached" });
  await reading.getByText(/\[redacted\]/).waitFor({ state: "attached" });
  const replacementRequests = [...batchRequests];
  assert.equal(replacementRequests.length, 3);
  assert.equal(
    replacementRequests.filter((url) => url.includes("beforeSequence")).length,
    1,
  );
  releaseHistory();
  await historyDone;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  assert.equal(
    await page
      .getByText("Literal update 0 long supplied text ", { exact: true })
      .count(),
    0,
  );
  assert.deepEqual(
    batchRequests,
    replacementRequests,
    "Superseded recent-page response must not issue its next retained cursor",
  );
  assert.equal(
    await page.locator(`[data-record-id^="${r.workId}:item-"]`).count(),
    251,
  );
  await page.unroute(historyRoute);
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: a.profileId,
    expectedVersion: Number(f.service.domain().profile(a.profileId).version),
    instructions: "Literal update 1 long supplied text",
  });
  await page.route(historyRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page
    .getByRole("button", { name: "Refresh task", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page
    .getByText(/History refresh failed:/)
    .first()
    .waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByText("Literal update 1 long supplied text ", { exact: true })
      .count(),
    0,
  );
});

test("a replayed auxiliary request focuses its control after the page commits", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f),
    r = a.delegatedResult("Result to view");
  // Delivery controls belong to a task whose project links a repository.
  setLinkedRepository(f, a.projectId, true);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${web.origin}/app/tasks/${a.taskId}?result=${r.resultId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Latest result", exact: true })
    .waitFor();
  // Playwright's own clicks wait on page frames, so these are dispatched in the page.
  const click = (name: string) =>
    page
      .getByRole("button", { name, exact: true })
      .evaluate((el) => (el as HTMLElement).click());
  const frames = await page.evaluateHandle(() => window.requestAnimationFrame);
  try {
    for (const [type, control, done] of [
      ["review.view", "Set viewing reference", "Viewing reference set."],
      [
        "delivery.refresh",
        "Refresh delivery status",
        "Delivery status refreshed.",
      ],
    ] as const) {
      const bodies: string[] = [];
      let lost = true;
      await openTaskTab(page, type === "review.view" ? "Overview" : "Changes");
      await page.route("**/api/operator/commands", async (route) => {
        const body = route.request().postDataJSON() as { type?: string };
        if (body.type !== type) return route.fallback();
        bodies.push(route.request().postData() ?? "");
        if (lost) {
          lost = false;
          await route.fetch();
          await route.abort("connectionreset");
        } else await route.continue();
      });
      await click(control);
      const check = page
        .locator("[data-slot=action-outcome]")
        .getByRole("button", { name: "Check whether it saved", exact: true });
      await check.waitFor();
      // From the check on, frame callbacks run ahead of the page's own render.
      await page.evaluate(() => {
        window.requestAnimationFrame = (callback) => {
          queueMicrotask(() => callback(performance.now()));
          return 0;
        };
      });
      await click("Check whether it saved");
      await page.getByText(done, { exact: true }).waitFor();
      // Locator waits only: waitForFunction would poll with the replaced frame callbacks.
      await page
        .locator(`[data-unconfirmed-control="${type}"]:focus:enabled`)
        .waitFor();
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      await frames.evaluate((original) => {
        window.requestAnimationFrame = original;
      });
      await page.unroute("**/api/operator/commands");
    }

    // A replay answered after the page was left focuses nothing on the page that is open.
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    await page.route("**/api/operator/commands", async (route) => {
      const body = route.request().postDataJSON() as { type?: string };
      if (body.type !== "review.view") return route.fallback();
      sent++;
      if (sent === 1) {
        await route.fetch();
        return route.abort("connectionreset");
      }
      const response = await route.fetch();
      entered();
      await gate;
      await route.fulfill({ response });
    });
    await openTaskTab(page, "Overview");
    await click("Set viewing reference");
    await page
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .waitFor();
    await click("Check whether it saved");
    await reached;
    await openSearchFromSidebar(page, { keepFocus: true });
    release();
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.hasAttribute("data-unconfirmed-control"),
      ),
      false,
    );
    assert.deepEqual(pageErrors, []);
  } finally {
    await frames.evaluate((original) => {
      window.requestAnimationFrame = original;
    });
  }
});

test("mounted Inbox discovers new requests and holds through timer and header refresh while retaining known detail focus", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const a = await seedReviewTask(f, "Inbox questions", "Question task"),
    b = await seedReviewTask(f, "Inbox approvals", "Approval task"),
    routine = await seedReviewTask(f, "Routine result", "Routine task");
  routine.delegatedResult("Routine delivered result");
  const d = f.service.domain();
  for (const task of [a, b]) {
    d.execute({
      type: "project.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      expectedVersion: Number(d.project(task.projectId).version),
      paused: false,
    });
    d.execute({
      type: "task.configure",
      actor: "operator",
      key: randomUUID(),
      projectId: task.projectId,
      taskId: task.taskId,
      expectedVersion: Number(d.task(task.taskId).version),
      ready: true,
    });
  }
  for (
    let n = 0;
    n < 100 && f.service.list().filter((w) => w.state === "running").length < 2;
    n++
  )
    await new Promise((r) => setTimeout(r, 10));
  const work = (taskId: string) => {
    const request = f.service
        .turnRequests()
        .find((r) => r.taskId === taskId && r.state === "active"),
      w = f.service.list().find((w) => w.workId === request?.workId);
    assert.ok(w?.threadId && w.turnId);
    return w;
  };
  const wa = work(a.taskId),
    wb = work(b.taskId);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await page.clock.install();
  await page.goto(`${web.origin}/app/inbox`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByText("Nothing needs your attention.", { exact: true })
    .waitFor();
  const question = async (prompt: string) => {
    assert.equal(
      (
        await f.runtime.callTool({
          threadId: wa.threadId!,
          turnId: wa.turnId!,
          callId: randomUUID(),
          tool: "ensemble_ask_question",
          arguments: { question: prompt },
        })
      ).success,
      true,
    );
  };
  await question("New timer-discovered question");
  const catalogResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/operator/inbox" && r.ok(),
  );
  await page.clock.runFor(15000);
  await catalogResponse;
  const firstQuestion = f.service.coordinationView().readTask(a.taskId)
    .questions[0];
  assert.ok(firstQuestion);
  const firstLink = page.locator(
    `.inbox-row[data-record-id="${firstQuestion.interactionId}"]`,
  );
  await firstLink.waitFor();
  // The queue row leads with the question (a plain question's headline is its prompt).
  assert.equal(
    await firstLink.locator("strong").textContent(),
    "New timer-discovered question",
  );
  await firstLink.focus();
  await question("Second question on known Inbox task");
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .evaluate((el) => (el as HTMLElement).click());
  await page.waitForFunction(
    () => document.querySelectorAll(".inbox-row").length === 2,
  );
  assert.equal(
    await firstLink.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(
    (
      await f.runtime.callTool({
        threadId: wb.threadId!,
        turnId: wb.turnId!,
        callId: randomUUID(),
        tool: "ensemble_request_approval",
        arguments: {
          action: "Inspect retained material",
          material: { scope: "fixture" },
        },
      })
    ).success,
    true,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const approval = f.service.coordinationView().readTask(b.taskId).approvals[0];
  assert.ok(approval);
  const approvalLink = page.locator(
    `.inbox-row[data-record-id="${approval.interactionId}"]`,
  );
  await approvalLink.waitFor();
  await approvalLink.click();
  assert.equal(
    new URL(page.url()).searchParams.get("request"),
    approval.interactionId,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Review material & decide", exact: true })
      .getAttribute("href"),
    `/app/tasks/${b.taskId}?request=${approval.interactionId}`,
  );
  // A wide layout has no back control: the queue stays beside the detail.
  assert.equal(
    await page.getByRole("button", { name: "Back to queue" }).count(),
    0,
  );
  assert.equal(
    await page
      .locator(".inbox-row")
      .filter({ hasText: "Routine task" })
      .count(),
    0,
  );
  f.seedPersistedState((db) => {
    const c = new CoordinationStore(db, d);
    for (const q of c
      .interactions(a.taskId)
      .filter((q) => q.kind === "question" && q.status === "open"))
      c.answerQuestion({
        actor: "operator",
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: q.revision,
        answer: "Recorded answer",
      });
    for (const approval of c
      .interactions(b.taskId)
      .filter((q) => q.kind === "approval" && q.status === "open"))
      c.decideApproval({
        actor: "operator",
        key: randomUUID(),
        interactionId: approval.interactionId,
        expectedRevision: approval.revision,
        decision: "denied",
        action: "Inspect retained material",
        material: { scope: "fixture" },
      });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByText("Nothing needs your attention.", { exact: true })
    .waitFor();
  f.seedPersistedState((db) =>
    new ExecutionState(db).hold(wa.id, "Fixture ownership unknown"),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .locator(".inbox-row")
    .filter({ hasText: "Question task" })
    .waitFor();
  await captureBrowserEvidence(page, "1366-inbox-new-attention");
  await page.route("**/api/operator/inbox*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByText("Refresh failed. Showing the last fetched data.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page
      .locator(".inbox-row")
      .filter({ hasText: "Question task" })
      .count(),
    1,
  );
});
