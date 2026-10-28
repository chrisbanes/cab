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
  await signIn(page, web, `/app/tasks/${a.taskId}`);

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

  // A pending delegated assignment takes a durable message from its History row.
  await page.goto(`${web.origin}/app/tasks/${a.taskId}?section=history`);
  const assignment = page.locator(`details[data-record-id="${pendingId}"]`);
  await assignment.locator("> summary").click();
  const send = assignment.getByRole("button", { name: /^Send to / });
  assert.equal(await send.isDisabled(), true, "nothing to send yet");
  await assignment
    .getByRole("textbox", { name: /^Message / })
    .fill("Also cover toolbar launch.");
  await send.click();
  await assignment.getByText(/^Sent to /).waitFor();
  const message = f.service
    .coordinationView()
    .readTask(a.taskId)
    .messages.find(
      (m) =>
        m.recipientAssignmentId === pendingId &&
        m.eventType === "operator-message",
    );
  assert.equal(message?.text, "Also cover toolbar launch.");
  assert.equal(
    await assignment.getByRole("textbox", { name: /^Message / }).inputValue(),
    "",
  );
  // A second message is a new command, not blocked by the first's receipt.
  await assignment
    .getByRole("textbox", { name: /^Message / })
    .fill("And the shortcut hint.");
  await send.click();
  await until(
    () =>
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter(
          (m) =>
            m.recipientAssignmentId === pendingId &&
            m.eventType === "operator-message",
        ).length === 2,
  );
  // The lead keeps its own reply card, and a completed delegate takes no message.
  for (const id of [a.assignmentId, delegateId])
    assert.equal(
      await page
        .locator(`details[data-record-id="${id}"] form.assignment-message`)
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
  await signIn(page, web, `/app/tasks/${taskId}`);
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
  await page.waitForURL(/\/app\/inbox/);
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
  await page.waitForURL(/\/app\/inbox/);
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
  await page.goto(`${web.origin}/app/tasks/${a.taskId}?section=history`);
  const assignment = page.locator(`details[data-record-id="${pendingId}"]`);
  await assignment.locator("> summary").click();
  const box = assignment.getByRole("textbox", { name: /^Message / });
  const messages = () =>
    f.service
      .coordinationView()
      .readTask(a.taskId)
      .messages.filter((m) => m.recipientAssignmentId === pendingId);
  await page.route("**/api/operator/commands", (route) => route.abort());
  await box.fill("Also cover toolbar launch.");
  await assignment.getByRole("button", { name: /^Send to / }).click();
  await check(assignment).waitFor();

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
        body: JSON.stringify({ error: { code } }),
      }),
    );
    await check(assignment).click();
    await page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/operator/commands") && r.status() === status,
    );
    await check(assignment).waitFor();
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
  await check(assignment).click();
  await assignment
    .getByText(
      /^Not sent: .* changed since it was read\. Your message is still here\./,
    )
    .waitFor();
  assert.equal(await box.inputValue(), "Also cover toolbar launch.");
  assert.equal(await box.isEditable(), true);
  assert.equal(messages().length, 0);
  assert.equal(await check(assignment).count(), 0);

  // A fresh unconfirmed send does not outlive the session that made it.
  await page.route("**/api/operator/commands", (route) => route.abort());
  await assignment.getByRole("button", { name: /^Send to / }).click();
  await check(assignment).waitFor();
  await signOutFromSidebar(page);
  await signIn(page, web, `/app/tasks/${a.taskId}?section=history`);
  await assignment.locator("> summary").click();
  assert.equal(await check(page).count(), 0);
  assert.equal(await box.inputValue(), "");
});
