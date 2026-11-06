import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { signOutFromSidebar } from "../fixtures/operator-account.js";
import { signIn } from "../fixtures/operator-settings.js";
import { until } from "../fixtures/questions.js";
import { seedReviewTask, seedTaskResult } from "../fixtures/task-review.js";

const test = browserSuite("task-coordination-actions");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** A lead task with a delegate whose finished result has no destination and one pending delegate. */
async function seedCoordination(f: Fixture) {
  const a = await seedReviewTask(
    f,
    "Coordination project",
    "Coordinate a worker",
  );
  const delegateId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    assignmentId: delegateId,
    profileId: a.profileId,
    brief: "Check focus restoration",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  // The domain normally captures the lead as the destination; an unresolved one needs the operator.
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_assignments SET resultRecipientAssignmentId = NULL, resultRecipientDisposition = 'unresolved' WHERE id = ?",
    ).run(delegateId);
  });
  seedTaskResult(f, a.taskId, delegateId, "Focus check finished");
  // A second delegate has no result yet, so it is pending and can take a message.
  const pendingId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    assignmentId: pendingId,
    profileId: a.profileId,
    brief: "Cover toolbar launch",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  const [unresolved] = f.service
    .coordinationView()
    .readTask(a.taskId).unresolvedResults;
  assert.ok(unresolved);
  return { a, delegateId, pendingId, unresolved };
}

test("the task view delivers an undelivered result and messages a delegated assignment", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { a, delegateId, pendingId, unresolved } = await seedCoordination(f);

  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  await signIn(page, web, `/tasks/${a.taskId}`);

  // The decision card names the result and offers only the permitted recipient.
  const row = page.locator(
    `#decisions .decision[data-record-id="${unresolved.resultId}"]`,
  );
  await row.getByText("Focus check finished", { exact: true }).waitFor();
  await row.getByRole("button", { name: "Deliver to Task lead" }).click();
  await row.getByText(/^Delivered to Task lead\./).waitFor();
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).unresolvedResults.length,
    0,
  );

  // A pending delegated assignment is replied to from its sub-conversation header, through the
  // shared comment composer addressed to exactly that assignment.
  const assignment = page.locator(`[data-record-id="delegation:${pendingId}"]`);
  await assignment.getByRole("button").first().click();
  await assignment.getByRole("button", { name: /^Reply to / }).click();
  const box = page.getByLabel("Editable reply");
  const send = page.getByRole("button", { name: "Send comment" });
  assert.equal(await send.isDisabled(), true, "nothing to send yet");
  assert.equal(
    await page
      .locator(`.recipient-chip[data-assignment-id="${pendingId}"]`)
      .count(),
    1,
  );
  assert.equal(await page.locator(".recipient-chip").count(), 1);
  await box.fill("Also cover toolbar launch.");
  await send.click();
  await page.getByText(/^Comment sent to /).waitFor();
  const comments = () =>
    f.service
      .coordinationView()
      .readTask(a.taskId)
      .messages.filter(
        (m) =>
          m.recipientAssignmentId === pendingId &&
          m.eventType === "operator-message" &&
          m.sharedCommentId,
      );
  assert.equal(comments()[0]?.text, "Also cover toolbar launch.");
  assert.equal(await box.inputValue(), "");
  // A second comment is a new command, not blocked by the first's receipt. Reply selects it again.
  await assignment.getByRole("button", { name: /^Reply to / }).click();
  await box.fill("And the shortcut hint.");
  await send.click();
  await until(() => comments().length === 2);
  // The lead keeps its own composer, and no delegate holds the older direct form.
  for (const id of [a.assignmentId, delegateId, pendingId])
    assert.equal(
      await page
        .locator(`[data-record-id="delegation:${id}"] form.assignment-message`)
        .count(),
      0,
    );
});

/** Starts the fixture's web app and opens the signed-in task page. */
async function openTask(
  f: Fixture,
  j: BrowserJourney,
  taskId: string,
  hold: { browser?: Browser },
) {
  const web = await j.start("fixture.web", () => f.startWeb());
  hold.browser = await j.start("browser.launch", () => chromium.launch());
  const page = await hold.browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: Array<{ type: string; key: string; raw: string }> = [];
  page.on("request", (request) => {
    const raw = request.postData() ?? "";
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      commands.push({ ...JSON.parse(raw), raw });
  });
  await signIn(page, web, `/tasks/${taskId}`);
  return { page, web, commands };
}

const check = (scope: Page | Locator) =>
  scope.getByRole("button", { name: "Check whether it saved" });

test("an unconfirmed result delivery is still checkable after leaving the task and coming back", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  const hold: { browser?: Browser } = {};
  j.cleanup(
    (primary) => f.close(hold.browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { a, unresolved } = await seedCoordination(f);
  const { page, commands } = await openTask(f, j, a.taskId, hold);
  const row = page.locator(
    `#decisions .decision[data-record-id="${unresolved.resultId}"]`,
  );
  // The send never reaches the service, so the row is still there on return.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await row.getByRole("button", { name: "Deliver to Task lead" }).click();
  await check(row).waitFor();
  assert.equal(commands.length, 1);

  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForURL(/\/inbox/);
  await page.goBack();
  await check(row).waitFor();
  assert.equal(
    await row.getByRole("button", { name: "Deliver to Task lead" }).count(),
    0,
    "an unconfirmed send is checked, not sent again",
  );

  await page.unroute("**/api/operator/commands");
  await check(row).click();
  await row.getByText(/^Delivered to Task lead\./).waitFor();
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.raw, commands[0]?.raw, "same key and body");
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).unresolvedResults.length,
    0,
  );
});

test("a result delivery the service already recorded is still checkable after returning, though its row is gone", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  const hold: { browser?: Browser } = {};
  j.cleanup(
    (primary) => f.close(hold.browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { a, unresolved } = await seedCoordination(f);
  const { page, commands } = await openTask(f, j, a.taskId, hold);
  const row = page.locator(
    `#decisions .decision[data-record-id="${unresolved.resultId}"]`,
  );
  // The request reaches the service but its reply is lost.
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await row.getByRole("button", { name: "Deliver to Task lead" }).click();
  await check(row).waitFor();
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).unresolvedResults.length,
    0,
  );

  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForURL(/\/inbox/);
  await page.goBack();
  // The result is no longer listed as undelivered, yet its check is still on the task page.
  await check(page).waitFor();
  assert.equal(await row.count(), 0);
  await page.unroute("**/api/operator/commands");
  await check(page).click();
  await page.getByText(/^Delivered to Task lead\./).waitFor();
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.raw, commands[0]?.raw, "same key and body");
});

test("a retained check that the service refuses shows the refusal and can be dismissed", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  const hold: { browser?: Browser } = {};
  j.cleanup(
    (primary) => f.close(hold.browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { a, unresolved } = await seedCoordination(f);
  const { page, commands } = await openTask(f, j, a.taskId, hold);
  const row = page.locator(
    `#decisions .decision[data-record-id="${unresolved.resultId}"]`,
  );
  await page.route("**/api/operator/commands", (route) => route.abort());
  await row.getByRole("button", { name: "Deliver to Task lead" }).click();
  await check(row).waitFor();
  // Someone else settles the destination, so the result leaves the undelivered list.
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE coordination_unresolved_result_destinations SET status = 'resolved', revision = revision + 1 WHERE resultId = ?",
    ).run(unresolved.resultId);
  });
  await page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await page.waitForURL(/\/inbox/);
  await page.goBack();
  await check(page).waitFor();
  assert.equal(await row.count(), 0);

  await page.unroute("**/api/operator/commands");
  await check(page).click();
  await page
    .getByText(
      "Not delivered: this result's destination changed since it was read.",
    )
    .waitFor();
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.raw, commands[0]?.raw, "same key and body");
  assert.equal(await check(page).count(), 0);
  await page.getByRole("button", { name: "Review current state" }).click();
  await page
    .getByText(
      "Not delivered: this result's destination changed since it was read.",
    )
    .waitFor({ state: "detached" });
});

test("a check settles as refused only on a definite refusal, and a new session starts clean", async (_t, j) => {
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  const hold: { browser?: Browser } = {};
  j.cleanup(
    (primary) => f.close(hold.browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { a, pendingId } = await seedCoordination(f);
  const { page, web, commands } = await openTask(f, j, a.taskId, hold);
  const assignment = page.locator(`[data-record-id="delegation:${pendingId}"]`);
  await assignment.getByRole("button").first().click();
  await assignment.getByRole("button", { name: /^Reply to / }).click();
  const box = page.getByLabel("Editable reply");
  const comments = () =>
    f.service
      .coordinationView()
      .readTask(a.taskId)
      .messages.filter(
        (m) => m.recipientAssignmentId === pendingId && m.sharedCommentId,
      );
  await page.route("**/api/operator/commands", (route) => route.abort());
  await box.fill("Also cover toolbar launch.");
  await page.getByRole("button", { name: "Send comment" }).click();
  await check(page).waitFor();

  // Authentication, session and availability failures say nothing about the first send.
  for (const [status, code] of [
    [503, "unavailable"],
    [403, "forbidden"],
  ] as const) {
    await page.unroute("**/api/operator/commands");
    await page.route("**/api/operator/commands", (route) =>
      route.fulfill({
        status,
        contentType: "application/json",
        // A valid API error, so the outcome's Details carry this code rather than a parse failure's.
        body: JSON.stringify({ error: { code, message: code } }),
      }),
    );
    const before = commands.length;
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/operator/commands") && r.status() === status,
      ),
      check(page).click(),
    ]);
    assert.equal(
      commands.length,
      before + 1,
      `the ${status} check sent exactly one request`,
    );
    // The check stays and the draft stays frozen: the first send is still unknown.
    await check(page).waitFor();
    assert.equal(await box.isDisabled(), true);
    await page
      .locator("[data-slot=action-outcome] .action-outcome-fields dd")
      .filter({ hasText: new RegExp(`^${code}$`) })
      .waitFor({ state: "attached" });
  }
  assert.deepEqual(
    new Set(commands.map((c) => c.key)).size,
    1,
    "every check resends the original key",
  );

  // The assignment changed since it was read: the next check is a real conflict.
  f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE domain_assignments SET version = version + 1 WHERE id = ?",
    ).run(pendingId);
  });
  await page.unroute("**/api/operator/commands");
  await check(page).click();
  await page
    .getByText("This task changed since you opened it. Your draft is kept.")
    .waitFor();
  assert.equal(await box.inputValue(), "Also cover toolbar launch.");
  assert.equal(await box.isEditable(), true);
  assert.equal(comments().length, 0);
  assert.equal(await check(page).count(), 0);
  // The refusal keeps the selection too, and re-reads who can receive it now.
  assert.equal(
    await page
      .locator(`.recipient-chip[data-assignment-id="${pendingId}"]`)
      .count(),
    1,
  );

  // A fresh unconfirmed send does not outlive the session that made it.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await page.getByRole("button", { name: "Send comment" }).click();
  await check(page).waitFor();
  await signOutFromSidebar(page);
  await signIn(page, web, `/tasks/${a.taskId}`);
  assert.equal(await check(page).count(), 0);
  assert.equal(await box.inputValue(), "");
});
