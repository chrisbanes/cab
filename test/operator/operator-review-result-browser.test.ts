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
import { choiceForm } from "../fixtures/question-data.js";
import { seedOwnQuestion } from "../fixtures/questions.js";
import { stubReadiness } from "../fixtures/setup-browser.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { overviewCard } from "../fixtures/task-tabs.js";

// The budget is the table under "Budget" in docs/user-flows/review-result.md.
const test = browserSuite("review-result-budget");
const summary = "Keyboard support ready for review";
const outcomes = ["supported", "failed", "unverified", "supported"] as const;

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** Four criteria with a result and one validation record, for Chromium at `viewport`. */
async function start<A extends Awaited<ReturnType<typeof seedReviewTask>>>(
  journey: BrowserJourney,
  viewport: { width: number; height: number },
  seed: (f: Fixture) => Promise<A>,
  path: (seeded: A) => string,
  record: "lead" | "delegated" | "none" = "lead",
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
  const a = await seed(f);
  const result =
    record === "none"
      ? { resultId: "" }
      : (record === "lead" ? a.result : a.delegatedResult)(summary, {
          sourceId: a.source.sourceId,
          criteria: a.source.criteria.map((c, i) => ({
            criterionId: c.criterionId,
            outcome: outcomes[i]!,
            scope: `Criterion ${i + 1} scope`,
            provenance: `Check ${i + 1}`,
          })),
          validations: [
            {
              label: "Unit tests",
              outcome: "passed",
              scope: "Whole suite",
              provenance: "CI run",
            },
          ],
        });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  // Home's getting-started rows follow this machine's runtime login; a failing row pushes the card down.
  await stubReadiness(page);
  await signIn(page, web, path(a));
  return { f, page, ...a, resultId: result.resultId };
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

const seedFourCriteria = (f: Fixture) =>
  seedReviewTask(
    f,
    "Atlas",
    "Ship an accessible command menu",
    "- [ ] Restore focus\n- [ ] Retain drafts\n- [ ] Announce results\n- [ ] Keep tab order",
  );

const markDone = (s: { f: Fixture; taskId: string }) =>
  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_tasks SET state='done', version=version+1 WHERE id=?",
      )
      .run(s.taskId),
  );

/** The result summary and the first three criterion outcomes are the first screen. */
const resultScreen = (page: Page) => [
  page.locator(`#review .literal-text`).getByText(summary, { exact: true }),
  ...[0, 1, 2].map((i) =>
    page.locator("#review .criterion-row > p:first-child").nth(i),
  ),
];

/** Opens Evidence by its summary and shows its records in the viewport. */
async function openEvidence(page: Page) {
  const card = overviewCard(page, "evidence");
  await card.locator("> summary").click();
  await card.and(page.locator("[open]")).waitFor();
  const record = card.getByText("Unit tests").first();
  await record.waitFor();
  // The card opens beneath its summary, which can sit at the foot of the first screen.
  await record.evaluate((e) => e.scrollIntoView({ block: "center" }));
  assert.equal(
    await inFirstViewport(page, record),
    true,
    `the evidence is in view ${JSON.stringify(await record.boundingBox())}`,
  );
  await noPageOverflow(page);
}

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`review a result budget: one interaction from task detail (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      seedFourCriteria,
      ({ taskId }) => `/app/tasks/${taskId}`,
    );
    await assertFirstScreen(s.page, resultScreen(s.page));
    // Headroom for font metrics that differ between macOS and CI.
    const third = await resultScreen(s.page)[3]!.boundingBox();
    assert.ok(
      third!.y + third!.height <= viewport.height - 8,
      `the third outcome keeps 8px of headroom ${JSON.stringify(third)}`,
    );
    // Each row reads its recorded outcome, not a default.
    assert.deepEqual(
      await s.page
        .locator("#review .criterion-row > p:first-child")
        .allTextContents(),
      [
        "C1 · Supported by recorded evidence",
        "C2 · Failed recorded check",
        "C3 · Unverified",
        "C4 · Supported by recorded evidence",
      ],
    );
    const more = s.page.locator("#review .criteria-more > summary");
    assert.equal(await more.textContent(), "1 more");
    // "N more" directly follows the third row and is reachable; it may sit just below the
    // first screen (about 40px at desktop, one 44px row on the phone).
    assert.equal(
      await more.evaluate(
        (e) =>
          e.parentElement?.previousElementSibling?.getAttribute(
            "data-record-id",
          ) ===
          document
            .querySelectorAll("#review .criterion-row")[2]
            ?.getAttribute("data-record-id"),
      ),
      true,
      "N more directly follows the third row",
    );
    await more.scrollIntoViewIfNeeded();
    assert.equal(
      await s.page.locator("#review .criterion-row:visible").count(),
      3,
    );
    if (viewport === phone) {
      // Ask lead keeps its 44px target and its label wraps beside the outcome.
      const box = (await s.page
        .locator("#review .criterion-row")
        .first()
        .getByRole("button", { name: "Ask lead about criterion", exact: true })
        .boundingBox())!;
      assert.ok(box.height >= 44, `Ask lead is a 44px target ${box.height}`);
      assert.ok(box.width <= 120, `Ask lead stays narrow ${box.width}`);
    }
    let interactions = 0;
    await openEvidence(s.page);
    interactions++;
    assert.equal(interactions, 1);
  });

  test(`review a result budget: two interactions from Home Completed work (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, seedFourCriteria, () => "/app");
    markDone(s);
    await s.page.reload();
    const link = s.page
      .getByRole("region", { name: "Completed work" })
      .getByRole("link", { name: "Ship an accessible command menu" });
    // Home's Completed work lists only the task; the summary is on the task page. The task is
    // on Home's first screen at desktop; on the phone Home puts the panel below the fold
    // (scrolling is not an interaction, and Home's layout is outside this budget).
    await link.waitFor();
    if (viewport === desktop) await assertFirstScreen(s.page, [link]);
    else await noPageOverflow(s.page);
    let interactions = 0;
    await link.click();
    interactions++;
    await s.page.waitForURL(new RegExp(`/app/tasks/${s.taskId}`));
    await assertFirstScreen(s.page, [resultScreen(s.page)[0]!]);
    await openEvidence(s.page);
    interactions++;
    assert.equal(interactions, 2);
  });

  test(`review a result budget: one interaction from the Inbox evidence link (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      (f) => seedOwnQuestion(f, choiceForm, "Guide task", "Docs"),
      ({ taskId, interactionId }) =>
        `/app/inbox?request=${interactionId}&task=${taskId}`,
      "delegated",
    );
    const link = s.page.getByRole("link", { name: "Task evidence" });
    await link.waitFor({ state: "attached" });
    assert.equal(await link.count(), 1);
    let interactions = 0;
    await link.click();
    interactions++;
    await s.page.waitForURL(new RegExp(`/app/tasks/${s.taskId}#history`));
    const history = s.page.getByRole("tab", { name: "History", exact: true });
    assert.equal(await history.getAttribute("aria-selected"), "true");
    // The link names the task's History, which lists the seeded result's recorded capture.
    const named = s.page.locator("#task-panel-history");
    await named
      .getByText(/^assignment-result · /)
      .first()
      .waitFor();
    assert.equal(
      await inFirstViewport(
        s.page,
        named.getByRole("heading", {
          name: "Assignments and retained history",
        }),
      ),
      true,
      "the History panel is in view",
    );
    await noPageOverflow(s.page);
    assert.equal(interactions, 1);
  });
}

test("review a result: criteria past the third open and close under N more", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    seedFourCriteria,
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  const fourth = s.page
    .locator("#review .criterion-row[data-record-id]")
    .nth(3);
  const more = s.page.locator("#review .criteria-more > summary");
  await more.waitFor();
  assert.equal(await fourth.isVisible(), false);
  await more.click();
  await fourth.waitFor();
  assert.equal(
    await fourth
      .getByRole("button", { name: "Ask lead about criterion" })
      .isEnabled(),
    true,
  );
  await more.click();
  assert.equal(await fourth.isVisible(), false);
});

test("review a result: three criteria render no N more", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    (f) =>
      seedReviewTask(
        f,
        "Atlas",
        "Ship an accessible command menu",
        "- [ ] Restore focus\n- [ ] Retain drafts\n- [ ] Announce results",
      ),
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  await s.page.locator("#review .criterion-row").nth(2).waitFor();
  assert.equal(await s.page.locator("#review .criteria-more").count(), 0);
});

test("review a result: a long criterion is shown in full and keeps its outcome", async (_t, journey) => {
  const long =
    "Restore focus to the control that opened the menu after Escape, after choosing an action, and after the menu closes because its anchor was removed, including when the page was scrolled meanwhile";
  const s = await start(
    journey,
    phone,
    (f) =>
      seedReviewTask(
        f,
        "Atlas",
        "Ship an accessible command menu",
        `- [ ] ${long}`,
      ),
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  const row = s.page.locator("#review .criterion-row").first();
  await row.waitFor();
  const text = row.locator("> p").nth(1);
  // Not clamped: the whole text is in the page and its box shows every line.
  assert.equal((await text.textContent())?.trim(), long);
  assert.equal(
    await text.evaluate((e) => e.scrollHeight <= e.clientHeight + 1),
    true,
    "the criterion text is not clipped",
  );
  const outcome = row.locator("> p").first();
  assert.match((await outcome.textContent()) ?? "", /^C1 · /);
  assert.equal(await outcome.isVisible(), true);
  await noPageOverflow(s.page);
});

test("review a result: an open N more, its scroll and the focus in it survive leaving and Back", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    seedFourCriteria,
    ({ taskId }) => `/app/tasks/${taskId}`,
  );
  const more = s.page.locator("#review .criteria-more");
  const fourth = more.locator(".criterion-row");
  await more.locator("> summary").click();
  await fourth.waitFor();
  const ask = fourth.getByRole("button", {
    name: "Ask lead about criterion",
    exact: true,
  });
  await ask.scrollIntoViewIfNeeded();
  await ask.focus();
  const y = await s.page.evaluate(() => scrollY);
  assert.ok(y > 0, "the page is scrolled to the fourth criterion");
  // Leave in place, as the app's own links do, then come Back.
  await s.page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/app/tasks";
    document.body.append(a);
    a.click();
    a.remove();
  });
  await s.page
    .getByRole("heading", { name: "All tasks", exact: true })
    .waitFor();
  await s.page.goBack();
  await s.page.locator("#review .criteria-more[open]").waitFor();
  await s.page.waitForFunction(
    (id) =>
      document.activeElement
        ?.closest("[data-record-id]")
        ?.getAttribute("data-record-id") === id,
    await fourth.getAttribute("data-record-id"),
  );
  await settle(s.page);
  assert.equal(
    await inFirstViewport(s.page, ask),
    true,
    "criterion 4 is in view",
  );
  assert.ok(Math.abs((await s.page.evaluate(() => scrollY)) - y) <= 1);
});
