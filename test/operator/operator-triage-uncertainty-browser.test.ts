import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { taskSchema, type TaskRead } from "../../src/operator/contracts.js";
import { seedOwnIntervention } from "../fixtures/questions.js";
import { stubReadiness } from "../fixtures/setup-browser.js";

// The budget is the table under "Budget" in docs/user-flows/triage-uncertainty.md.
const test = browserSuite("triage-uncertainty-budget");
const uncertain = "Execution ownership is uncertain";

/** One task whose execution ownership is unknown, one Chromium page at `viewport`, signed in on `path`. */
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
  const seeded = await seedOwnIntervention(f);
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

/** Every target is wholly in the first viewport together; `scrolled` allows the page to have moved. */
async function assertInView(page: Page, targets: Locator[], scrolled = false) {
  for (const target of targets) await target.waitFor();
  await settle(page);
  for (const target of targets)
    assert.equal(
      await inFirstViewport(page, target),
      true,
      `in view ${JSON.stringify(await target.boundingBox())}`,
    );
  if (!scrolled)
    assert.equal(await page.evaluate(() => scrollY), 0, "nothing scrolled");
  await noPageOverflow(page);
}

/** The result is the assignment's recovery page, held, with no command sent. */
async function assertRecovery(s: Awaited<ReturnType<typeof start>>) {
  await s.page.waitForURL(`**/app/assignments/${s.assignmentId}/recovery`);
  await assertInView(
    s.page,
    [
      s.page.getByText("Execution held", { exact: true }),
      s.page.getByText("Execution may still be active.", { exact: false }),
    ],
    true,
  );
  assert.deepEqual(s.posts, [], "no command is sent");
}

const holdLink = (scope: Locator, name = "Recovery evidence") =>
  scope
    .getByRole("list", { name: "Also held", exact: true })
    .getByRole("link", { name, exact: true });

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`triage an uncertain execution budget: two interactions from the Home card (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/app");
    const card = s.page.locator(".overview-card[data-kind='intervention']");
    const inspect = card.getByRole("link", {
      name: "Inspect execution",
      exact: true,
    });
    await assertInView(s.page, [
      card.getByRole("heading", { name: uncertain, exact: true }),
      card.getByText("Ownership stays held", { exact: true }),
      inspect,
    ]);
    let interactions = 0;
    await inspect.click();
    interactions++;
    const link = holdLink(s.page.locator("section#decisions")).first();
    await assertInView(s.page, [link], true);
    await link.click();
    interactions++;
    await assertRecovery(s);
    assert.equal(interactions, 2);
  });

  test(`triage an uncertain execution budget: three interactions from the Inbox row (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/app/inbox");
    const row = s.page.locator(".inbox-row[data-kind='intervention']");
    await assertInView(s.page, [
      row,
      row.getByText(uncertain, { exact: true }),
    ]);
    let interactions = 0;
    await row.click();
    interactions++;
    const detail = s.page.getByRole("region", { name: "Selected request" });
    const inspect = detail.getByRole("link", {
      name: "Inspect execution",
      exact: true,
    });
    await assertInView(s.page, [
      detail.locator(".inbox-reason"),
      detail.getByText("Ownership stays held", { exact: true }),
      inspect,
    ]);
    await inspect.click();
    interactions++;
    const link = holdLink(s.page.locator("section#decisions")).first();
    await assertInView(s.page, [link], true);
    await link.click();
    interactions++;
    await assertRecovery(s);
    assert.equal(interactions, 3);
  });

  test(`triage an uncertain execution budget: one interaction from the task detail hold line (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      ({ taskId }) => `/app/tasks/${taskId}`,
    );
    const line = s.page
      .getByRole("list", { name: "Also held", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Uncertainty" });
    const link = line.getByRole("link", { name: "Recovery evidence" });
    await assertInView(s.page, [line, link]);
    let interactions = 0;
    await link.click();
    interactions++;
    await assertRecovery(s);
    assert.equal(interactions, 1);
  });
}

test("hold lines name each assignment's recovery page when the task has several", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  const taskUrl = `**/api/operator/tasks/${s.taskId}`;
  let served: TaskRead["data"]["assignments"] = [];
  await s.page.route(taskUrl, async (route) => {
    const response = await route.fetch(),
      body = (await response.json()) as TaskRead,
      first = body.data.assignments[0]!;
    body.data.assignments.push({
      ...first,
      assignmentId: randomUUID(),
      name: "Grace",
    });
    taskSchema.parse(body);
    served = body.data.assignments;
    await route.fulfill({ response, json: body });
  });
  await s.page.reload();
  const holds = s.page.getByRole("list", { name: "Also held", exact: true });
  await holds.waitFor();
  const [a, b] = served;
  assert.equal(served.length, 2);
  const lines = holds.getByRole("listitem");
  assert.ok((await lines.count()) > 0);
  for (let i = 0; i < (await lines.count()); i++) {
    const links = lines.nth(i).getByRole("link");
    assert.deepEqual(await links.allInnerTexts(), [
      `${a!.name}: recovery evidence`,
      "Grace: recovery evidence",
    ]);
    assert.deepEqual(
      await links.evaluateAll((l) => l.map((x) => x.getAttribute("href"))),
      [
        `/app/assignments/${a!.assignmentId}/recovery`,
        `/app/assignments/${b!.assignmentId}/recovery`,
      ],
    );
  }
  assert.equal(await holds.getByText("Execution details").count(), 0);
  assert.equal(await holds.getByRole("button").count(), 0);
});
