import assert from "node:assert/strict";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  desktop,
  inFirstViewport,
  noPageOverflow,
  phone,
  signIn,
} from "../fixtures/operator-settings.js";
import { questionReadSchema } from "../../src/operator/contracts.js";
import { choiceForm } from "../fixtures/question-data.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { stubReadiness } from "../fixtures/setup-browser.js";

// The budget is the table under "Budget" in docs/user-flows/answer-question.md.
const test = browserSuite("answer-question-budget");
const question = "Choose the guide's audience";
const sent = "Answer sent. It reaches the requester on its next turn.";

/** One single-choice question, one Chromium page at `viewport`, signed in on `path`. */
async function start(
  journey: BrowserJourney,
  viewport: { width: number; height: number },
  path: (ids: { taskId: string }) => string,
) {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const seeded = await seedOwnQuestion(f, choiceForm, "Guide task", "Docs");
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const posts: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/operator/commands")
    )
      posts.push(request.postDataJSON());
  });
  // Home's getting-started rows follow this machine's runtime login; a failing row pushes the card down.
  await stubReadiness(page);
  await signIn(page, web, path(seeded));
  return { f, page, posts, ...seeded };
}

const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** Every target is wholly in the first viewport together, with nothing scrolled. */
async function assertFirstScreen(page: Page, targets: Locator[]) {
  for (const target of targets) await target.waitFor();
  await settle(page);
  for (const target of targets)
    assert.equal(
      await inFirstViewport(page, target),
      true,
      `in the first view ${JSON.stringify(await target.boundingBox())}`,
    );
  assert.equal(await page.evaluate(() => scrollY), 0, "nothing scrolled");
  await noPageOverflow(page);
}

/** The result is the recorded state in view and exactly one answer command. */
async function assertRecorded(
  s: Awaited<ReturnType<typeof start>>,
  scope: Locator,
) {
  const result = [
    scope.getByText("Answer recorded", { exact: true }),
    scope.getByText(sent, { exact: true }),
  ];
  for (const target of result) await target.waitFor();
  for (const target of result)
    assert.equal(
      await inFirstViewport(s.page, target),
      true,
      `the result is in view ${JSON.stringify(await target.boundingBox())}`,
    );
  const answers = s.posts.filter((p) => p.type === "question.form.answer");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.taskId, s.taskId);
  assert.equal(answers[0]!.interactionId, s.interactionId);
  assert.deepEqual(
    (answers[0]!.answers as { choice: { optionIds: string[] } }).choice
      .optionIds,
    ["owners"],
  );
  assert.notEqual(
    s.f.service.coordinationView().readTask(s.taskId).questions[0]!.status,
    "open",
  );
  await noPageOverflow(s.page);
}

const choose = (scope: Locator) =>
  scope.getByRole("radio", { name: /^Team owners/ });
const submit = (scope: Locator) =>
  scope.getByRole("button", { name: "Submit answer", exact: true });

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`answer a question budget: two interactions from the Home card (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/app");
    const card = s.page.locator(
      `.overview-card[data-request-id="${s.interactionId}"]`,
    );
    await assertFirstScreen(s.page, [
      card.getByRole("heading", { name: question, exact: true }),
      card.getByRole("radio", { name: /^Every new member/ }),
      choose(card),
    ]);
    let interactions = 0;
    await choose(card).click();
    interactions++;
    await submit(card).click();
    interactions++;
    await assertRecorded(s, card);
    assert.equal(interactions, 2);
  });

  test(`answer a question budget: three interactions from the Inbox row (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/app/inbox");
    const row = s.page.locator(".inbox-row").filter({ hasText: "Guide task" });
    await assertFirstScreen(s.page, [
      row,
      row.getByText(question, { exact: true }),
    ]);
    let interactions = 0;
    await row.click();
    interactions++;
    const detail = s.page.locator(".inbox-detail");
    await choose(detail).click();
    interactions++;
    await submit(detail).click();
    interactions++;
    await assertRecorded(s, detail);
    // The Inbox does not advance on its own.
    await detail
      .getByRole("heading", { name: question, exact: true })
      .waitFor();
    assert.equal(interactions, 3);
  });
  test(`answer a question budget: three interactions from the task decision card (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      ({ taskId }) => `/app/tasks/${taskId}`,
    );
    const decision = s.page.locator(
      `#decisions .decision[data-record-id="${s.interactionId}"]`,
    );
    const open = decision.getByRole("link", {
      name: "Answer question",
      exact: true,
    });
    await assertFirstScreen(s.page, [
      decision.getByText(question, { exact: true }),
      open,
    ]);
    assert.equal(await decision.getByText("Structured question").count(), 0);
    let interactions = 0;
    await open.click();
    interactions++;
    const response = s.page.getByRole("region", {
      name: "Exact question response",
    });
    await choose(response).click();
    interactions++;
    await submit(response).click();
    interactions++;
    await assertRecorded(s, response);
    assert.equal(interactions, 3);
  });
}

test("the task decision card withdraws the question text when a refresh withholds or fails the exact read", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  const decision = s.page.locator(
      `#decisions .decision[data-record-id="${s.interactionId}"]`,
    ),
    label = decision.getByText(question, { exact: true }),
    readUrl = `**/api/operator/tasks/${s.taskId}/questions/${s.interactionId}`,
    refresh = s.page.getByRole("button", { name: "Refresh task", exact: true });
  await label.waitFor();
  // The read now withholds the form, as it does once privacy coverage changes.
  await s.page.route(readUrl, async (route) => {
    const body = questionReadSchema.parse(await (await route.fetch()).json());
    body.data.status = "unavailable";
    body.data.form = null;
    await route.fulfill({ json: body });
  });
  await refresh.click();
  await label.waitFor({ state: "detached" });
  await decision.getByText("Structured question").waitFor();
  // A refresh that finds it available shows the label again, and a failed one withdraws it.
  await s.page.unroute(readUrl);
  await refresh.click();
  await label.waitFor();
  await s.page.route(readUrl, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await refresh.click();
  await label.waitFor({ state: "detached" });
  await decision.getByText("Structured question").waitFor();
});
