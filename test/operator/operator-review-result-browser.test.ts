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
import { openOverviewCard, overviewCard } from "../fixtures/task-tabs.js";

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

/** The conversation the link scrolled to is in view; the link lands on its newest entry, not the page top. */
async function settleOn(page: Page, target: Locator) {
  await settle(page);
  const box = await target.boundingBox();
  const height = await page.evaluate(() => innerHeight);
  assert.ok(
    box && box.y < height && box.y + box.height > 0,
    JSON.stringify(box),
  );
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

/** Opens Evidence by its summary and shows its records in the viewport. */
async function openEvidence(page: Page) {
  let interactions = 0;
  const card = overviewCard(page, "evidence");
  if ((await card.getAttribute("open")) === null) {
    await card.locator("> summary").click();
    interactions++;
  }
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
  return interactions;
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
      ({ taskId }) => `/tasks/${taskId}`,
    );
    await settleOn(
      s.page,
      s.page.getByRole("log", { name: "Task conversation" }),
    );
    await settleOn(
      s.page,
      s.page.getByRole("heading", { name: "Reply", exact: true }),
    );
    // Results stay beside the conversation, and follow it on phones.
    // Each row reads its recorded outcome, not a default.
    assert.deepEqual(
      await s.page
        .locator("#review .criterion-row > p:first-child")
        .allTextContents(),
      [
        "✓ C1 · Supported by recorded evidence",
        "× C2 · Failed recorded check",
        "– C3 · Unverified",
        "✓ C4 · Supported by recorded evidence",
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
        .getByRole("button", { name: "Ask lead", exact: true })
        .boundingBox())!;
      assert.ok(box.height >= 44, `Ask lead is a 44px target ${box.height}`);
    }
    const result = s.page.locator(`#review [data-record-id="${s.resultId}"]`);
    assert.equal(await result.getAttribute("aria-label"), "Result R1");
    const metadata = s.page.locator("#result-details p.metadata");
    assert.equal(
      await metadata.isVisible(),
      false,
      "result provenance starts in local closed Details",
    );
    assert.equal(
      await result
        .locator(":scope > p.metadata")
        .filter({ hasText: "work revision" })
        .count(),
      0,
    );
    const interactions = await openEvidence(s.page);
    assert.equal(interactions, 1);
    const fold = s.page.locator("details.inspector-fold");
    assert.equal(
      (await fold.getAttribute("open")) !== null,
      false,
      "opening Evidence does not change Task details",
    );
    assert.equal(await metadata.isVisible(), false);
    // Inspecting exact provenance is one separate keyboard disclosure interaction.
    const details = s.page.locator("#result-details > summary");
    await details.focus();
    await s.page.keyboard.press("Enter");
    assert.equal(await metadata.isVisible(), true);
    assert.match(await metadata.innerText(), new RegExp(s.resultId));
  });

  test(`review a result budget: two interactions from Home Completed work (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, seedFourCriteria, () => "/");
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
    await s.page.waitForURL(new RegExp(`/tasks/${s.taskId}`));
    await settleOn(
      s.page,
      s.page.getByRole("heading", { name: "Reply", exact: true }),
    );
    interactions += await openEvidence(s.page);
    assert.equal(interactions, 2);
    assert.equal(
      (await s.page.locator("details.inspector-fold").getAttribute("open")) !==
        null,
      false,
    );
  });

  test(`an explicit evidence link needs no extra disclosure click (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      seedFourCriteria,
      ({ taskId }) => `/tasks/${taskId}?section=result-evidence`,
    );
    assert.equal(await openEvidence(s.page), 0);
    assert.equal(
      await s.page.locator("#result-details p.metadata").isVisible(),
      false,
    );
    assert.equal(
      await openEvidence(s.page),
      0,
      "already-open disclosures stay open",
    );
    assert.equal(
      (await s.page.locator("details.inspector-fold").getAttribute("open")) !==
        null,
      false,
      "the Evidence link and helper leave phone Task details closed",
    );
  });

  test(`review a result budget: one interaction from the Inbox evidence link (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      (f) => seedOwnQuestion(f, choiceForm, "Guide task", "Docs"),
      ({ taskId, interactionId }) =>
        `/inbox?request=${interactionId}&task=${taskId}`,
      "delegated",
    );
    const link = s.page.getByRole("link", { name: "Task evidence" });
    await link.waitFor({ state: "attached" });
    assert.equal(await link.count(), 1);
    let interactions = 0;
    await link.click();
    interactions++;
    await s.page.waitForURL(new RegExp(`/tasks/${s.taskId}#conversation`));
    const overview = s.page.getByRole("tab", { name: "Overview", exact: true });
    assert.equal(await overview.getAttribute("aria-selected"), "true");
    // The link names the task's conversation, which shows the seeded result with its assignment.
    const named = s.page.locator("#conversation");
    await named.getByText(/Result: Keyboard support ready/).waitFor();
    await settleOn(s.page, named.getByRole("log"));
    await noPageOverflow(s.page);
    assert.equal(interactions, 1);
  });
}

test("review a result: criteria past the third open and close under N more", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    seedFourCriteria,
    ({ taskId }) => `/tasks/${taskId}`,
  );
  const fourth = s.page
    .locator("#review .criterion-row[data-record-id]")
    .nth(3);
  const more = s.page.locator("#review .criteria-more > summary");
  await more.waitFor();
  assert.equal(await fourth.isVisible(), false);
  await more.click();
  await fourth.waitFor();
  assert.equal(await fourth.locator("details > summary").isVisible(), true);
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
    ({ taskId }) => `/tasks/${taskId}`,
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
    ({ taskId }) => `/tasks/${taskId}`,
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
  assert.match((await outcome.textContent()) ?? "", /C1 · /);
  assert.equal(await outcome.isVisible(), true);
  await noPageOverflow(s.page);
});

test("review a result: an open N more, its scroll and the focus in it survive leaving and Back", async (_t, journey) => {
  // A short desktop window, so reaching the fourth criterion scrolls the page.
  const s = await start(
    journey,
    { ...desktop, height: 600 },
    seedFourCriteria,
    ({ taskId }) => `/tasks/${taskId}`,
  );
  const more = s.page.locator("#review .criteria-more");
  const fourth = more.locator(".criterion-row");
  await more.locator("> summary").click();
  await fourth.waitFor();
  const ask = fourth.locator("details > summary");
  await ask.scrollIntoViewIfNeeded();
  await ask.focus();
  const y = await s.page.evaluate(() => scrollY);
  assert.ok(y > 0, "the page is scrolled to the fourth criterion");
  // Leave in place, as the app's own links do, then come Back.
  await s.page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/tasks";
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

for (const viewport of [desktop, phone]) {
  test(`one Ask targets hidden criteria and resets stale selection (${viewport.width})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      seedFourCriteria,
      ({ taskId }) => `/tasks/${taskId}?section=review`,
    );
    const ask = s.page.getByRole("button", { name: "Ask lead", exact: true });
    const target = s.page.getByLabel("Ask lead about", { exact: true });
    await ask.waitFor();
    assert.equal(await ask.count(), 1);
    assert.equal(await s.page.getByLabel("Result revision").count(), 0);
    assert.equal(
      await s.page.getByLabel("Retained source revision").count(),
      0,
    );
    const criterionId = s.source.criteria[3]!.criterionId;
    assert.equal(
      await s.page.locator("#review .criteria-more").getAttribute("open"),
      null,
    );
    await target.selectOption(criterionId);
    await ask.click();
    await s.page.waitForFunction(
      () => document.activeElement?.id === "workspace-reply",
    );
    const reply = s.page.getByLabel("Editable reply");
    await reply.fill("Keep this exact criterion draft");
    const reference = s.page.getByText(/^Immutable reference:/);
    const original = await reference.textContent();
    assert.ok(original?.includes(criterionId));
    assert.ok(original?.includes(s.resultId));
    assert.ok(original?.includes(s.source.sourceId));
    s.result("Another result", { sourceId: s.source.sourceId, criteria: [] });
    await s.page.evaluate(() =>
      window.dispatchEvent(new Event("cab-task-changed")),
    );
    await s.page
      .locator("#review")
      .getByText("Another result", { exact: true })
      .waitFor();
    await s.page.getByLabel("Result revision").waitFor();
    // Incoming material resets the target, while the contextual draft keeps its original reference.
    assert.equal(await reply.inputValue(), "Keep this exact criterion draft");
    assert.equal(await reference.textContent(), original);
    await target.selectOption(criterionId);
    await s.page.getByLabel("Result revision").selectOption(s.resultId);
    await s.page
      .getByText(
        "The selected criterion is no longer current. Ask lead now targets this result.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await target.inputValue(), "");
    await ask.click();
    assert.equal(await reply.inputValue(), "Keep this exact criterion draft");
    assert.equal(await reference.textContent(), original);
    const nextSource = s.f.service
      .taskReview()
      .captureSource(s.taskId, "local", {
        title: "Updated requirements",
        body: "- [ ] Updated criterion",
      });
    assert.ok(nextSource);
    await s.page.evaluate(() =>
      window.dispatchEvent(new Event("cab-task-changed")),
    );
    await openOverviewCard(s.page, "brief");
    await s.page.getByLabel("Retained source revision").waitFor();
    await target.selectOption(criterionId);
    await s.page
      .getByLabel("Retained source revision")
      .selectOption(nextSource.sourceId);
    await s.page
      .getByText(
        "The selected criterion is no longer current. Ask lead now targets this result.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await target.inputValue(), "");
    assert.equal(await reply.inputValue(), "Keep this exact criterion draft");
    assert.equal(await reference.textContent(), original);
    await noPageOverflow(s.page);
  });
}

for (const viewport of [desktop, phone]) {
  test(`captured record and context links reveal only Execution and keep disclosures (${viewport.width})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      seedFourCriteria,
      ({ taskId }) => `/tasks/${taskId}`,
    );
    const capture = s.f.service.taskReview().read(s.taskId).contexts.at(-1)!;
    assert.ok(capture);
    for (const target of [
      "?section=context",
      "#context",
      `?record=${capture.captureId}`,
    ]) {
      await s.page.goto(
        new URL(`/tasks/${s.taskId}${target}`, s.page.url()).href,
      );
      await s.page
        .getByRole("tab", { name: "Execution", selected: true })
        .waitFor();
      await s.page.locator("#context > details[open]").waitFor();
      assert.equal(await s.page.locator(".task-inspector #context").count(), 0);
      assert.equal(await s.page.locator("#context").count(), 1);
      assert.match(
        await s.page.locator("#context").innerText(),
        /Availability is not proof/,
      );
      assert.ok(
        (await s.page.locator("#context").innerText()).includes(
          capture.assignmentId,
        ),
      );
    }
    const details = s.page.locator(
      `#context details[data-record-id="${capture.captureId}"]`,
    );
    await details.locator("> summary").focus();
    if ((await details.getAttribute("open")) === null)
      await s.page.keyboard.press("Enter");
    await s.page.getByRole("tab", { name: "Review", exact: true }).click();
    await s.page.getByRole("tab", { name: "Execution", exact: true }).click();
    assert.equal(await details.getAttribute("open"), "");
    await noPageOverflow(s.page);
  });
}
