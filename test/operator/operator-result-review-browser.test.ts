import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Locator } from "playwright";
import { CoordinationStore } from "../../src/core/coordination.js";
import {
  browserSuite,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  desktop,
  noPageOverflow,
  phone,
  signIn,
} from "../fixtures/operator-settings.js";
import { stubReadiness } from "../fixtures/setup-browser.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { choiceForm } from "../fixtures/question-data.js";
import { seedOwnQuestion } from "../fixtures/questions.js";

// The budget is the review-request rows under "Budget" in docs/user-flows/review-result.md.
const test = browserSuite("result-review-request");
const decision = "Should the new toolbar ship behind the beta flag?";
const recommendation = "Ship it behind the flag; keyboard focus is restored.";
const uncertainty = "Safari was not checked";
// A 1×1 PNG, so the screenshot renders through the artifact route.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A lead result with a screenshot, a validation and a review request, at `path`. */
async function start(
  journey: BrowserJourney,
  viewport: { width: number; height: number },
  path: (ids: { taskId: string; reviewId: string }) => string,
  request = true,
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
  const a = await seedReviewTask(f, "Atlas", "Ship the new toolbar");
  const workspace = await f.service.taskWorkspace(a.taskId);
  assert.ok(workspace);
  await writeFile(join(workspace.path, "toolbar.png"), png);
  const seeded = a.result(
    "Moved the toolbar behind the beta flag because focus regressed.",
    {
      sourceId: a.source.sourceId,
      criteria: a.source.criteria.map((c) => ({
        criterionId: c.criterionId,
        outcome: "supported" as const,
        scope: "Toolbar",
        provenance: "Manual check",
      })),
      validations: [
        {
          label: "Unit tests",
          outcome: "passed",
          scope: "Whole suite",
          provenance: "CI run",
        },
      ],
      artifacts: [
        {
          artifactId: randomUUID(),
          label: "Toolbar screenshot",
          role: "evidence",
          revision: 1,
          availability: "available",
          file: {
            relativePath: "toolbar.png",
            sha256: createHash("sha256").update(png).digest("hex"),
            mime: "image/png",
            size: png.length,
          },
        },
      ],
    },
    undefined,
    request
      ? { decision, recommendation, uncertainties: [uncertainty] }
      : undefined,
  );
  const reviewId = request
    ? f.service.coordinationView().readTask(a.taskId).resultReviews[0]!.reviewId
    : "";
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const posts: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON());
  });
  await stubReadiness(page);
  await signIn(page, web, path({ taskId: a.taskId, reviewId }));
  return { f, page, posts, ...a, seeded, reviewId };
}

/** Everything the decision needs is in the panel, without opening the conversation. */
async function assertMaterial(panel: Locator) {
  for (const target of [
    panel.getByText(recommendation, { exact: true }),
    panel.getByText(
      "Moved the toolbar behind the beta flag because focus regressed.",
      { exact: true },
    ),
    panel.locator(".criterion-row").first(),
    panel.getByRole("img", { name: "evidence: Toolbar screenshot" }),
    panel.getByText(/^Unit tests: passed/),
    panel.getByText(uncertainty, { exact: true }),
  ])
    await target.waitFor();
  assert.equal(
    await panel
      .getByRole("img", { name: "evidence: Toolbar screenshot" })
      .evaluate((img: HTMLImageElement) => img.naturalWidth),
    1,
    "the screenshot rendered",
  );
}

const responses = (posts: Record<string, unknown>[]) =>
  posts.filter((p) => p.type === "result-review.respond");

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`review a requested result budget: two interactions from the Home card (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/");
    const card = s.page.locator(
      `.overview-card[data-request-id="${s.reviewId}"]`,
    );
    await card.getByRole("heading", { name: decision, exact: true }).waitFor();
    let interactions = 0;
    await card.getByRole("link", { name: "Review result" }).click();
    interactions++;
    const panel = s.page.getByRole("region", { name: "Result review" });
    await assertMaterial(panel);
    await panel
      .getByLabel("Note or feedback for the lead")
      .fill("Keep the old toolbar for keyboard users.");
    await panel.getByRole("button", { name: "Send feedback" }).click();
    interactions++;
    await panel.getByText("Feedback sent to the lead.").waitFor();
    assert.equal(interactions, 2);
    const [sent, ...others] = responses(s.posts);
    assert.equal(others.length, 0);
    assert.equal(sent?.response, "feedback");
    assert.equal(sent?.reviewId, s.reviewId);
    await panel.getByText("Feedback sent", { exact: true }).waitFor();
    assert.equal(
      await panel.getByRole("button", { name: "Send feedback" }).count(),
      0,
    );
    // It leaves the actionable queue.
    assert.equal(
      s.f.service
        .inboxLifecycle()
        .rows(s.taskId)
        .find((r) => r.id === s.reviewId)?.status,
      "resolved",
    );
    await noPageOverflow(s.page);
  });

  test(`review a requested result budget: two interactions from the Inbox row (${label})`, async (_t, journey) => {
    const s = await start(journey, viewport, () => "/inbox");
    const row = s.page
      .locator(".inbox-row")
      .filter({ hasText: decision })
      .first();
    let interactions = 0;
    await row.click();
    interactions++;
    const panel = s.page.getByRole("region", { name: "Result review" });
    await assertMaterial(panel);
    await panel.getByRole("button", { name: "Mark reviewed" }).click();
    interactions++;
    await panel
      .getByText("Marked reviewed. Nothing was sent to the lead.")
      .waitFor();
    assert.equal(interactions, 2);
    assert.equal(responses(s.posts).length, 1);
    assert.equal(responses(s.posts)[0]?.response, "reviewed");
    await noPageOverflow(s.page);
  });

  test(`review a requested result budget: two interactions from the task decision card (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      ({ taskId }) => `/tasks/${taskId}?section=decisions`,
    );
    const decisionRow = s.page.locator(
      `#decisions .decision[data-record-id="${s.reviewId}"]`,
    );
    await decisionRow.getByText(decision, { exact: true }).waitFor();
    let interactions = 0;
    await decisionRow.getByRole("link", { name: "Review result" }).click();
    interactions++;
    const panel = s.page.getByRole("region", { name: "Result review" });
    await assertMaterial(panel);
    await panel.getByRole("button", { name: "Mark reviewed" }).click();
    interactions++;
    await panel
      .getByText("Marked reviewed. Nothing was sent to the lead.")
      .waitFor();
    await panel.getByText("Reviewed", { exact: true }).waitFor();
    assert.equal(interactions, 2);
    assert.equal(responses(s.posts)[0]?.message, undefined);
    await noPageOverflow(s.page);
  });
}

test("a newer result supersedes an open review: a send refuses, keeps its draft and links the newer result", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  const panel = s.page.getByRole("region", { name: "Result review" });
  await assertMaterial(panel);
  const newer = s.result("Revised toolbar after a second pass.");
  const draft = "Please also check Safari.";
  await panel.getByLabel("Note or feedback for the lead").fill(draft);
  await panel.getByRole("button", { name: "Send feedback" }).click();
  await panel.getByText("This review is no longer current.").waitFor();
  await panel.getByText("Superseded by a newer result").waitFor();
  assert.equal(
    await panel.getByRole("button", { name: "Send feedback" }).count(),
    0,
  );
  await panel.getByText(draft, { exact: true }).waitFor();
  assert.equal(
    await panel
      .getByRole("link", { name: "Open the newer result" })
      .getAttribute("href"),
    `/tasks/${s.taskId}?result=${newer.resultId}`,
  );
  assert.equal(
    s.f.service.coordinationView().readTask(s.taskId).resultReviews[0]
      ?.response,
    null,
  );
});

test("a refresh after a newer result turns an open review read-only without a send", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  const panel = s.page.getByRole("region", { name: "Result review" });
  await assertMaterial(panel);
  s.result("Revised toolbar after a second pass.");
  await s.page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await panel.getByText("Superseded by a newer result").waitFor();
  assert.equal(
    await panel.getByRole("button", { name: "Mark reviewed" }).count(),
    0,
  );
  assert.equal(responses(s.posts).length, 0);
});

/** Archives directly: the seeded task still has assignments to drain. */
function archive(s: Awaited<ReturnType<typeof start>>) {
  s.f.seedPersistedState((db) =>
    db
      .prepare(
        "UPDATE domain_projects SET archived=1,version=version+1 WHERE id=?",
      )
      .run(s.projectId),
  );
}

test("an archived project's Inbox review reads with no response controls", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  const detail = s.page.locator(".inbox-detail"),
    panel = detail.getByRole("region", { name: "Result review" });
  await assertMaterial(panel);
  await panel.getByRole("button", { name: "Mark reviewed" }).waitFor();
  archive(s);
  await s.page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await detail
    .getByText("This project is archived. Tasks and history are read-only.")
    .waitFor();
  // The review stays readable; an archived project serves no artifact preview.
  for (const text of [recommendation, uncertainty])
    await panel.getByText(text, { exact: true }).waitFor();
  for (const name of ["Mark reviewed", "Send feedback"])
    assert.equal(await detail.getByRole("button", { name }).count(), 0);
  assert.equal(
    await detail.getByLabel("Note or feedback for the lead").count(),
    0,
  );
  assert.equal(
    await detail
      .getByRole("link", { name: "Open task", exact: true })
      .getAttribute("href"),
    `/tasks/${s.taskId}`,
  );
  assert.equal(responses(s.posts).length, 0);
});

test("a stale review draft can be discarded and stays gone on the task page and on reselection", async (_t, journey) => {
  const inboxPath = `/inbox?task=`;
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `${inboxPath}${taskId}&request=${reviewId}`,
  );
  const navigate = (path: string) =>
    s.page.evaluate((to) => {
      history.pushState(null, "", to);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
  const panel = s.page.getByRole("region", { name: "Result review" }),
    draft = "Stale feedback",
    discard = panel.getByRole("button", { name: "Discard draft" });
  await panel.getByLabel("Note or feedback for the lead").fill(draft);
  assert.equal(await discard.count(), 0, "a pending review offers no Discard");
  s.result("Revised toolbar after a second pass.");
  await s.page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await panel.getByText("Superseded by a newer result").waitFor();
  await panel.getByRole("heading", { name: "Your unsent draft" }).waitFor();
  await panel.getByText(draft, { exact: true }).waitFor();
  await discard.waitFor();
  // The task page shows the same draft: the store is shared.
  await navigate(`/tasks/${s.taskId}?request=${s.reviewId}`);
  await s.page.waitForURL(/\/tasks\//);
  await panel.getByText(draft, { exact: true }).waitFor();
  await discard.click();
  const done = panel.getByText("Draft discarded.");
  await done.waitFor();
  assert.ok(
    await done.evaluate((el) => Boolean(document.activeElement?.contains(el))),
    "the outcome takes focus",
  );
  assert.equal(await panel.getByText(draft, { exact: true }).count(), 0);
  for (const path of [
    `${inboxPath}${s.taskId}&request=${s.reviewId}`,
    "/inbox",
    `${inboxPath}${s.taskId}&request=${s.reviewId}`,
  ])
    await navigate(path);
  await panel.getByText("Superseded by a newer result").waitFor();
  assert.equal(
    await panel.getByRole("heading", { name: "Your unsent draft" }).count(),
    0,
  );
  assert.equal(await panel.getByText(draft, { exact: true }).count(), 0);
  assert.equal(responses(s.posts).length, 0);
});

test("a dismissed review stays pending with no response, and Restore returns it", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  const detail = s.page.locator(".inbox-detail");
  await detail.getByRole("region", { name: "Result review" }).waitFor();
  await detail.getByRole("button", { name: "Dismiss", exact: true }).click();
  await detail.getByRole("button", { name: "Dismiss request" }).click();
  await detail
    .getByText("Dismissed. No response was recorded; the review stays pending.")
    .waitFor();
  const [review] = s.f.service
    .coordinationView()
    .readTask(s.taskId).resultReviews;
  assert.equal(review?.status, "pending");
  assert.equal(review?.response, null);
  await s.page.goto(
    new URL(
      `/inbox?status=dismissed&task=${s.taskId}&request=${s.reviewId}`,
      s.page.url(),
    ).href,
  );
  await detail
    .getByText(
      "Dismissed. The review stays pending and no response was recorded.",
    )
    .waitFor();
  await detail.getByRole("button", { name: "Restore", exact: true }).click();
  await detail.getByText("Restored. No work was started.").waitFor();
  assert.equal(responses(s.posts).length, 0);
});

test("a review draft survives moving to another request with J and back with K", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  await seedOwnQuestion(s.f, choiceForm, "Guide task", "Docs");
  await s.page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await s.page
    .locator(".inbox-row")
    .filter({ hasText: "Guide task" })
    .waitFor();
  const panel = s.page.getByRole("region", { name: "Result review" }),
    note = panel.getByLabel("Note or feedback for the lead");
  await note.fill("Half-written feedback");
  const rows = s.page.locator(".inbox-row");
  const reviewFirst =
    (await rows.first().getAttribute("data-record-id")) === s.reviewId;
  // Leave the textarea so J and K move between requests.
  await s.page.locator(".inbox-detail h2").focus();
  await s.page.keyboard.press(reviewFirst ? "j" : "k");
  await panel.waitFor({ state: "detached" });
  await s.page.keyboard.press(reviewFirst ? "k" : "j");
  await panel.waitFor();
  assert.equal(await note.inputValue(), "Half-written feedback");
});

test("refused feedback to a lead that cannot receive it keeps the draft and the review pending", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  // A held lead receives no feedback; the review itself stays pending.
  s.f.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
      .run(s.assignmentId),
  );
  const panel = s.page.getByRole("region", { name: "Result review" });
  await assertMaterial(panel);
  await panel
    .getByLabel("Note or feedback for the lead")
    .fill("Please revisit");
  await panel.getByRole("button", { name: "Send feedback" }).click();
  await panel.getByText("The response was not recorded.").waitFor();
  assert.equal(
    await panel.getByLabel("Note or feedback for the lead").inputValue(),
    "Please revisit",
  );
  assert.equal(
    s.f.service.coordinationView().readTask(s.taskId).resultReviews[0]?.status,
    "pending",
  );
});

test("a task-page review draft survives following Changes and going Back", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/tasks/${taskId}?request=${reviewId}`,
  );
  const panel = s.page.getByRole("region", { name: "Result review" }),
    note = panel.getByLabel("Note or feedback for the lead");
  await assertMaterial(panel);
  await note.fill("Half-written task-page feedback");
  await panel.getByRole("link", { name: /^Changes/ }).click();
  await s.page.waitForURL(/section=changes/);
  await s.page.goBack();
  await panel.waitFor();
  assert.equal(await note.inputValue(), "Half-written task-page feedback");
  assert.equal(responses(s.posts).length, 0);
});

test("a lost reply stays retryable after a refresh shows the review answered, and the replay yields the receipt", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId, reviewId }) => `/inbox?task=${taskId}&request=${reviewId}`,
  );
  const panel = s.page.getByRole("region", { name: "Result review" });
  await assertMaterial(panel);
  // The service records the response; only its reply is lost.
  await s.page.route(
    "**/api/operator/commands",
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  await panel
    .getByLabel("Note or feedback for the lead")
    .fill("Keep the old toolbar.");
  await panel.getByRole("button", { name: "Send feedback" }).click();
  await panel.getByText("Reply unavailable.").waitFor();
  await s.page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await panel.getByText("Feedback sent", { exact: true }).waitFor();
  const retry = panel.getByRole("button", { name: "Retry Send feedback" });
  await retry.waitFor();
  await retry.click();
  await panel.getByText("Feedback sent to the lead.").waitFor();
  assert.equal(await panel.getByText("Reply unavailable.").count(), 0);
  assert.equal(await retry.count(), 0);
  const sent = responses(s.posts);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.key, sent[1]?.key, "the retry replays the same key");
  assert.equal(
    s.f.service
      .coordinationView()
      .readTask(s.taskId)
      .messages.filter((m) => m.eventType === "assignment-follow-up").length,
    1,
  );
});

test("a withdrawn review reads as withdrawn by the lead, with its reason", async (_t, journey) => {
  const s = await start(journey, desktop, () => "/");
  s.f.seedPersistedState((db) => {
    db.prepare(
      "UPDATE execution_intents SET state='running' WHERE workId=?",
    ).run(s.seeded.workId);
    db.prepare("UPDATE domain_assignments SET state='running' WHERE id=?").run(
      s.assignmentId,
    );
    const withdrawn = new CoordinationStore(db).withdrawResultReview({
      threadId: s.seeded.workId,
      turnId: s.seeded.workId,
      callId: randomUUID(),
      tool: "cab_withdraw_result_review",
      arguments: { resultId: s.seeded.resultId, reason: "Decided it myself" },
    });
    assert.equal(withdrawn.success, true, withdrawn.text);
  });
  await s.page.goto(
    new URL(`/tasks/${s.taskId}?request=${s.reviewId}`, s.page.url()).href,
  );
  const panel = s.page.getByRole("region", { name: "Result review" });
  await panel
    .getByText("Withdrawn by the lead: Decided it myself", { exact: true })
    .waitFor();
  assert.equal(
    await panel.getByRole("button", { name: "Mark reviewed" }).count(),
    0,
  );
});

test("a result without a review request keeps Latest result unchanged and raises no review", async (_t, journey) => {
  const s = await start(
    journey,
    desktop,
    ({ taskId }) => `/tasks/${taskId}`,
    false,
  );
  const latest = s.page.locator("section#review");
  await latest
    .getByText(
      "Moved the toolbar behind the beta flag because focus regressed.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await latest.getByText("Review requested").count(), 0);
  assert.equal(
    await s.page.getByRole("region", { name: "Result review" }).count(),
    0,
  );
  assert.equal(
    s.f.service
      .inboxLifecycle()
      .rows(s.taskId)
      .filter((r) => r.kind === "result-review").length,
    0,
  );
});
