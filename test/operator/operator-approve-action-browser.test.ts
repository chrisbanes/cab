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
import { seedOwnApproval } from "../fixtures/questions.js";
import { stubReadiness } from "../fixtures/setup-browser.js";

// The budget is the table under "Budget" in docs/user-flows/approve-action.md.
const test = browserSuite("approve-action-budget");
const task = "Approve exact action";
const action = "Create a pull request. No merge or deployment.";
const review = "Review material & decide";

/** One open approval, one Chromium page at `viewport`, signed in on `path`. */
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
  const seeded = await seedOwnApproval(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const posts: Array<{
    type: string;
    decision?: string;
    interactionId?: string;
  }> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
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

/** The task's request view opens on the approval, with Approve in view. */
async function arriveAtApproval(s: Awaited<ReturnType<typeof start>>) {
  await s.page.waitForURL(
    (url) =>
      url.pathname === `/app/tasks/${s.taskId}` &&
      url.searchParams.get("request") === s.interactionId,
  );
  const item = s.page.locator(
    `.approval-review[data-record-id="${s.interactionId}"]`,
  );
  const approve = item.getByRole("button", {
    name: "Approve this exact material",
    exact: true,
  });
  await approve.waitFor();
  await settle(s.page);
  for (const target of [
    item.getByRole("heading", { name: `Approval requested for ${action}` }),
    approve,
  ])
    assert.equal(
      await inFirstViewport(s.page, target),
      true,
      `the approval is in view ${JSON.stringify(await target.boundingBox())}`,
    );
  await noPageOverflow(s.page);
  return { item, approve };
}

/** Approve once; the recorded decision shows in view at the same anchor. */
async function approveOnce(
  s: Awaited<ReturnType<typeof start>>,
  item: Locator,
  approve: Locator,
) {
  await approve.click();
  const decided = item.getByText(/^Approved\. The action is allowed/);
  await decided.waitFor();
  await settle(s.page);
  assert.equal(
    await inFirstViewport(s.page, decided),
    true,
    `the decision is in view ${JSON.stringify(await decided.boundingBox())}`,
  );
  assert.equal(
    new URL(s.page.url()).searchParams.get("request"),
    s.interactionId,
  );
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0]!.type, "approval.decide");
  assert.equal(s.posts[0]!.decision, "approved");
  assert.equal(s.posts[0]!.interactionId, s.interactionId);
  assert.equal(
    s.f.service.coordinationView().readTask(s.taskId).approvals[0]!.status,
    "approved",
  );
  await noPageOverflow(s.page);
}

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`approve an exact action budget: two interactions from the Home card (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/app");
    const card = s.page.locator(
      `.overview-card[data-request-id="${s.interactionId}"]`,
    );
    const open = card.getByRole("link", { name: review, exact: true });
    await assertFirstScreen(s.page, [
      card.getByRole("heading", { name: action, exact: true }),
      card.locator(".overview-card-place").filter({ hasText: task }),
      open,
    ]);
    let interactions = 0;
    await open.click();
    interactions++;
    const { item, approve } = await arriveAtApproval(s);
    await approveOnce(s, item, approve);
    interactions++;
    assert.equal(interactions, 2);
  });

  test(`approve an exact action budget: three interactions from the Inbox row (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/app/inbox");
    const row = s.page.locator(".inbox-row").filter({ hasText: task });
    await assertFirstScreen(s.page, [row, row.getByText(action)]);
    let interactions = 0;
    await row.click();
    interactions++;
    await s.page
      .locator(".inbox-detail")
      .getByRole("link", { name: review, exact: true })
      .click();
    interactions++;
    const { item, approve } = await arriveAtApproval(s);
    await approveOnce(s, item, approve);
    interactions++;
    assert.equal(interactions, 3);
  });

  test(`approve an exact action budget: two interactions from the task decision card (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      ({ taskId }) => `/app/tasks/${taskId}`,
    );
    const decision = s.page.locator(
      `#decisions .decision[data-record-id="${s.interactionId}"]`,
    );
    const open = decision.getByRole("link", { name: review, exact: true });
    await assertFirstScreen(s.page, [
      decision.getByText(
        /Action: Create a pull request\. No merge or deployment\. · Target: acme\/atlas · main ← command-menu · revision 1 · Exact reviewed material: [0-9a-f]{64}/,
      ),
      open,
    ]);
    let interactions = 0;
    await open.click();
    interactions++;
    const { item, approve } = await arriveAtApproval(s);
    await approveOnce(s, item, approve);
    interactions++;
    assert.equal(interactions, 2);
  });
}

const denied = /^Denied\. Nothing was approved/;
const taskPath = (s: Awaited<ReturnType<typeof start>>) =>
  `/app/tasks/${s.taskId}`;
/** Leaves the task through the Inbox link, then reopens it by its plain address. */
async function leaveAndReopen(s: Awaited<ReturnType<typeof start>>) {
  await s.page
    .getByRole("link", { name: /^Inbox/ })
    .first()
    .click();
  await s.page.waitForURL(/\/app\/inbox/);
  return async () => {
    await s.page.evaluate((path) => {
      history.pushState(null, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, taskPath(s));
    await s.page.locator("main.page h1").waitFor();
  };
}

test("a denial sent before leaving the task reads as a denial when its response lands while away", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  const open = s.page
    .locator(`#decisions .decision[data-record-id="${s.interactionId}"]`)
    .getByRole("link", { name: review, exact: true });
  await open.click();
  const { item } = await arriveAtApproval(s);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await s.page.route("**/api/operator/commands", async (route) => {
    await held;
    await route.continue();
  });
  await item.getByRole("button", { name: "Deny", exact: true }).click();
  const reopen = await leaveAndReopen(s);
  release();
  await s.page.waitForTimeout(500);
  await reopen();
  await s.page.getByText(denied).waitFor();
  assert.equal(await s.page.getByText(/^Approved\./).count(), 0);
  assert.equal(
    s.f.service.coordinationView().readTask(s.taskId).approvals[0]!.status,
    "denied",
  );
});

test("a denial whose response was lost reads as a denial when checked after returning", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  await s.page
    .locator(`#decisions .decision[data-record-id="${s.interactionId}"]`)
    .getByRole("link", { name: review, exact: true })
    .click();
  const { item } = await arriveAtApproval(s);
  await s.page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await item.getByRole("button", { name: "Deny", exact: true }).click();
  await item
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .waitFor();
  const reopen = await leaveAndReopen(s);
  await reopen();
  const check = s.page.getByRole("button", {
    name: "Check whether it saved",
    exact: true,
  });
  await check.waitFor();
  await s.page.unroute("**/api/operator/commands");
  await check.click();
  await s.page.getByText(denied).waitFor();
  assert.equal(await s.page.getByText(/^Approved\./).count(), 0);
  assert.equal(s.posts.length, 2);
  assert.equal(s.posts[1]!.decision, "denied");
});
