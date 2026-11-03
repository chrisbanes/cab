import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { chromium, webkit, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { markTaskReady, seedReviewTask } from "../fixtures/task-review.js";
import {
  commentNote,
  recordOnlyText,
} from "../../web/src/task-comment-model.js";

const test = browserSuite("ui-task-comment");
const testForEngine = (
  name: string,
  browserEngine: "chromium" | "webkit",
  action: (t: TestContext, journey: BrowserJourney) => Promise<void>,
) => test(name, { browserEngine }, action);

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/**
 * A ready task whose lead is pending, with two delegates of the lead's profile (so all three
 * share a name): one pending, one completed with a resumable result.
 */
async function seed(f: Fixture) {
  const a = await seedReviewTask(f, "Atlas", "Share a conversation");
  markTaskReady(f, a.taskId);
  const done = a.delegatedResult("Earlier finished work");
  const pendingId = randomUUID();
  f.service.domain().execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId: a.projectId,
    taskId: a.taskId,
    assignmentId: pendingId,
    profileId: a.profileId,
    brief: "Independent focus review",
    resultDestination: "lead",
    requesterAssignmentId: a.assignmentId,
  });
  return { ...a, doneId: done.assignmentId, pendingId };
}

async function open(
  j: BrowserJourney,
  engine: "chromium" | "webkit",
  viewport = { width: 1366, height: 900 },
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
  const a = await seed(f);
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start(`browser.launch.${engine}`, () =>
    (engine === "webkit" ? webkit : chromium).launch(),
  );
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(5000);
  const commands: Array<Record<string, unknown>> = [];
  const operations: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      commands.push(request.postDataJSON());
    if (request.url().includes("/api/operator/operations?"))
      operations.push(request.url());
  });
  await page.goto(`${web.origin}/app/tasks/${a.taskId}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Editable reply").waitFor();
  return { f, a, web, page, commands, operations };
}

const operationsRead = (url: URL) =>
  url.pathname === "/api/operator/operations";
const chips = (page: Page) => page.locator(".recipient-chip");
const sendButton = (page: Page) =>
  page.getByRole("button", { name: "Send comment" });
const focusedText = (page: Page) =>
  page.evaluate(() => document.activeElement?.textContent ?? "");
const messagesOf = (f: Fixture, taskId: string) =>
  f.service.coordinationView().readTask(taskId).messages;

for (const engine of ["chromium", "webkit"] as const)
  testForEngine(
    `a shared comment starts with the lead, previews each effect, and posts record-only or to chosen assignments (${engine})`,
    engine,
    async (_t, j) => {
      const { f, a, page, commands } = await open(j, engine);
      const box = page.getByLabel("Editable reply");

      // The lead is a visible, removable recipient and the one sentence above the box says what the box does.
      const first = await chips(page).allInnerTexts();
      assert.equal(first.length, 1);
      assert.match(first[0] ?? "", /^@lead Task lead · [0-9a-f]{8}/);
      assert.equal(
        await page.locator("#reply p").first().innerText(),
        commentNote,
      );
      await page
        .getByText(/receives this as input on its next eligible turn/)
        .waitFor();
      assert.equal(await sendButton(page).isDisabled(), true, "no text yet");

      // Removing it leaves an explicit empty set, which a refresh does not restore.
      await page.getByRole("button", { name: /^Remove @lead/ }).click();
      await page.getByText(recordOnlyText).waitFor();
      assert.equal(await chips(page).count(), 0);
      // Focus moves to a control that still exists.
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Add recipient",
      );
      await page
        .getByRole("button", { name: "Refresh task", exact: true })
        .click();
      await page.getByText(recordOnlyText).waitFor();
      assert.equal(await chips(page).count(), 0);

      // Record-only: one comment, no recipients, nobody woken.
      const events = messagesOf(f, a.taskId).length;
      await box.fill("@lead please look. Just noting this.");
      await sendButton(page).click();
      await page
        .getByText("Comment recorded. No assignment was woken.")
        .waitFor();
      assert.equal(commands.length, 1);
      assert.deepEqual(commands[0]?.recipients, []);
      assert.equal(await box.inputValue(), "");
      assert.equal(messagesOf(f, a.taskId).length, events);
      const log = page.getByRole("log", { name: "Task conversation" });
      await log.getByText("@lead please look. Just noting this.").waitFor();
      assert.equal(
        await log.getByText("@lead please look. Just noting this.").count(),
        1,
      );
      assert.match(
        await log.locator("[data-comment-id] header").first().innerText(),
        /recorded for the task only/,
      );

      // The picker by keyboard: open, Escape back to the trigger, open again and choose.
      const add = page.getByRole("button", { name: "Add recipient" });
      // After a send the composer starts from its default again: the lead is back.
      await chips(page).first().waitFor();
      assert.equal(await chips(page).count(), 1);
      await add.focus();
      await page.keyboard.press("Enter");
      const options = page.getByRole("list", { name: "Assignments to add" });
      await options.waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await options.count(), 0);
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Add recipient",
      );
      await page.keyboard.press("Enter");
      await options.waitFor();
      // WebKit on macOS does not Tab to buttons, so only Chromium walks the options by key.
      if (engine === "chromium") {
        await page.keyboard.press("Tab");
        assert.match(await focusedText(page), /delegate/);
        await page.keyboard.press("Enter");
      } else await options.getByRole("button").first().click();
      assert.equal(await chips(page).count(), 2);
      await page.waitForFunction(
        () => document.activeElement?.textContent === "Add recipient",
      );

      // Same-named assignments are told apart by short identity, never by name.
      const texts = await chips(page).allInnerTexts();
      assert.equal(new Set(texts).size, 2);
      assert.ok(
        texts.every((t) => /Task lead · [0-9a-f]{8}/.test(t)),
        texts.join(),
      );
      await add.click();
      await options
        .getByRole("button", { name: new RegExp(a.pendingId.slice(0, 8)) })
        .click();

      // The mixed preview names input for a running or pending assignment and a resume for a completed one.
      await page.getByText(/resumes the same assignment/).waitFor();
      await page
        .getByText(/receives this as input/)
        .first()
        .waitFor();
      await page
        .getByText(/Pause, Stop, capacity, readiness and permissions/)
        .waitFor();
      await captureBrowserEvidence(
        page,
        `${engine}-1366-mixed-recipient-preview`,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await captureBrowserEvidence(
        page,
        `${engine}-390-mixed-recipient-preview`,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no horizontal scroll at 390px",
      );
      await page.setViewportSize({ width: 1366, height: 900 });

      // Send: exactly the chosen identities, and the text is only text.
      const chosen = await chips(page).evaluateAll((els) =>
        els.map((e) => (e as HTMLElement).dataset.assignmentId),
      );
      assert.equal(chosen.length, 3);
      await box.fill("Please sync, @Task lead and everyone.");
      await sendButton(page).click();
      await page.getByText(/^Comment sent to /).waitFor();
      assert.equal(commands.length, 2);
      const sent = commands[1] as {
        type: string;
        body: string;
        recipients: {
          assignmentId: string;
          expectedAssignmentVersion: number;
        }[];
      };
      assert.equal(sent.type, "task.comment.send");
      assert.deepEqual(
        sent.recipients.map((r) => r.assignmentId).sort(),
        [...chosen].sort(),
      );
      const view = f.service.coordinationView().readTask(a.taskId);
      assert.equal(view.comments.length, 2);
      assert.equal(view.comments[1]?.deliveries.length, 3);
      assert.deepEqual(
        view.comments[1]?.deliveries.map((d) => d.effect).sort(),
        ["input", "input", "resume"],
      );
      await log.getByText("Please sync, @Task lead and everyone.").waitFor();
      assert.equal(
        await log.getByText("Please sync, @Task lead and everyone.").count(),
        1,
      );
    },
  );

test("a lost response is checked against the stored receipt first, and a mismatched receipt stays frozen", async (_t, j) => {
  const { f, a, page, commands, operations } = await open(j, "chromium");
  const box = page.getByLabel("Editable reply");
  let lose = true;
  await page.route("**/api/operator/commands", async (route) => {
    if (lose && route.request().postDataJSON().type === "task.comment.send") {
      lose = false;
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "command-outcome-unknown" } }),
      });
      return;
    }
    await route.continue();
  });
  await box.fill("Does this land?");
  await sendButton(page).click();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  assert.equal(await box.isDisabled(), true);
  assert.equal(await sendButton(page).count(), 0);
  assert.equal(
    await check.evaluate((e) => e === document.activeElement),
    true,
    "the check takes the focus the Send button held",
  );
  assert.equal(commands.length, 1);
  assert.equal(operations.length, 0);

  // The page can be left and reopened; the frozen command and draft survive.
  await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
  await page.getByRole("heading", { name: "All tasks", exact: true }).waitFor();
  await page
    .getByRole("link", { name: "Share a conversation" })
    .first()
    .click();
  await check.waitFor();
  assert.equal(
    await page.getByLabel("Editable reply").inputValue(),
    "Does this land?",
  );

  // A receipt that does not match the frozen command settles nothing.
  await page.route(operationsRead, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.data.state === "recorded")
      json.data.receipt.payloadHash = "0".repeat(64);
    await route.fulfill({ response, json });
  });
  await check.click();
  await page
    .getByText("We couldn't confirm the comment was sent. Your draft is kept.")
    .waitFor();
  assert.equal(operations.length, 1);
  assert.equal(
    commands.length,
    1,
    "a mismatched receipt never triggers a retry",
  );
  await check.waitFor();
  assert.equal(await page.getByLabel("Editable reply").isDisabled(), true);

  // The honest receipt settles it, without a second POST or a second wake.
  await page.unroute(operationsRead);
  await check.click();
  await page.getByText(/^Comment sent to /).waitFor();
  assert.equal(operations.length, 2);
  assert.equal(commands.length, 1, "a recorded receipt is not resent");
  assert.equal(await page.getByLabel("Editable reply").inputValue(), "");
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).comments.length,
    1,
  );
  assert.equal(
    messagesOf(f, a.taskId).filter((m) => m.sharedCommentId).length,
    1,
  );
});

test("a not-recorded check retries the identical frozen command with its original key", async (_t, j) => {
  const { f, a, page, commands, operations } = await open(j, "chromium");
  const box = page.getByLabel("Editable reply");
  await page.route("**/api/operator/commands", (route) => route.abort());
  await box.fill("Never arrived.");
  await sendButton(page).click();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  await page.unroute("**/api/operator/commands");
  await check.click();
  await page.getByText(/^Comment sent to /).waitFor();
  assert.equal(operations.length, 1, "the receipt is read first");
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.key, commands[0]?.key);
  assert.deepEqual(commands[1], commands[0]);
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).comments.length,
    1,
  );
});

test("a refused send keeps the whole draft and selection and says who cannot receive it", async (_t, j) => {
  const { f, a, page, commands } = await open(j, "chromium");
  const box = page.getByLabel("Editable reply");
  const add = page.getByRole("button", { name: "Add recipient" });
  await add.click();
  await page
    .getByRole("list", { name: "Assignments to add" })
    .getByRole("button", { name: new RegExp(a.pendingId.slice(0, 8)) })
    .click();
  assert.equal(await chips(page).count(), 2);
  await box.fill("Two of you, please.");

  // The delegate is held before Send: the service refuses the whole comment at commit.
  f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
      .run(a.pendingId),
  );
  await sendButton(page).click();
  await page
    .getByText("This task changed since you opened it. Your draft is kept.")
    .waitFor();
  assert.equal(commands.length, 1);
  assert.equal(await box.inputValue(), "Two of you, please.");
  assert.equal(await box.isEditable(), true);
  assert.equal(await chips(page).count(), 2, "nothing is silently pruned");
  // The re-read previews name the recipient that cannot receive it, and Send is held.
  await page.getByText(/can't receive this comment: it is held/).waitFor();
  assert.equal(await sendButton(page).isDisabled(), true);
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).comments.length,
    0,
    "no comment, delivery or event was recorded",
  );
  assert.equal(
    messagesOf(f, a.taskId).filter((m) => m.sharedCommentId).length,
    0,
  );

  // Removing the unavailable recipient is the operator's choice, and the same draft then sends.
  await page
    .getByRole("button", {
      name: new RegExp(`^Remove @.*${a.pendingId.slice(0, 8)}`),
    })
    .click();
  await sendButton(page).click();
  await page.getByText(/^Comment sent to /).waitFor();
  assert.equal(commands.length, 2);
});

test("contextual feedback and the draft turn stay their own destinations, and assignment Reply targets one assignment", async (_t, j) => {
  const { f, a, page, commands } = await open(j, "chromium");
  // "Ask lead about …" is lead-only feedback with its exact reference, sent through `message`.
  await page
    .getByRole("button", { name: "Message task lead" })
    .waitFor({ state: "detached" });
  const ask = page.getByRole("button", { name: /^Ask lead about / }).first();
  await ask.waitFor();
  await ask.click();
  await page.getByText(/^Immutable reference:/).waitFor();
  assert.equal(await page.locator(".recipient-chip").count(), 0);
  await page.getByRole("button", { name: "Send to task lead" }).click();
  await page.getByText(/^Sent to /).waitFor();
  const direct = commands.at(-1) as { type: string; reference?: unknown };
  assert.equal(direct.type, "message");
  assert.ok(direct.reference);

  // Assignment Reply selects exactly that assignment in the shared composer.
  const log = page.getByRole("log", { name: "Task conversation" });
  const delegation = log.locator(
    `[data-record-id="delegation:${a.pendingId}"]`,
  );
  await delegation.getByRole("button").first().click();
  await delegation.getByRole("button", { name: /^Reply to / }).click();
  assert.equal(await page.locator(".recipient-chip").count(), 1);
  assert.equal(
    await page
      .locator(`.recipient-chip[data-assignment-id="${a.pendingId}"]`)
      .count(),
    1,
  );
  await page.waitForFunction(
    () => document.activeElement?.id === "workspace-reply",
  );
  assert.equal(
    f.service.coordinationView().readTask(a.taskId).comments.length,
    0,
  );
});

test("the recipient picker closes and stays closed while a send is unresolved, so the preview matches the frozen command", async (_t, j) => {
  const { page, commands } = await open(j, "chromium");
  const box = page.getByLabel("Editable reply");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    await held;
    await route.continue();
  });
  await box.fill("Held while the picker was open.");
  await page.getByRole("button", { name: "Add recipient" }).click();
  const options = page.getByRole("list", { name: "Assignments to add" });
  await options.waitFor();
  const preview = page.getByRole("status", { name: "Before you send" });
  const before = await preview.innerText();
  await sendButton(page).click();
  // The request is held: the picker closes, its trigger is off and the recipients cannot change.
  await options.waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("button", { name: "Add recipient" }).isDisabled(),
    true,
  );
  assert.equal(await preview.innerText(), before);
  assert.equal(await chips(page).count(), 1);
  release();
  await page.getByText(/^Comment sent to /).waitFor();
  assert.equal(commands.length, 1);
  assert.equal((commands[0] as { recipients: unknown[] }).recipients.length, 1);
});
