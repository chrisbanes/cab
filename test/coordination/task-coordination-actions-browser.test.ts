import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { signIn } from "../fixtures/operator-settings.js";
import { seedReviewTask, seedTaskResult } from "../fixtures/task-review.js";

const test = browserSuite("task-coordination-actions");

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
  // The lead keeps its own reply card, and a completed delegate takes no message.
  for (const id of [a.assignmentId, delegateId])
    assert.equal(
      await page
        .locator(`details[data-record-id="${id}"] form.assignment-message`)
        .count(),
      0,
    );
});
