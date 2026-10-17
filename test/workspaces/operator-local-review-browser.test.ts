import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  browserSuite,
  type BrowserJourney,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  leadAwaitingRecoveryNotice,
  leadResumeNotice,
} from "../../web/src/lead-feedback.js";
import { seedReviewTask } from "../fixtures/task-review.js";
import { openTaskTab } from "../fixtures/task-tabs.js";
import { openSearchFromSidebar } from "../fixtures/shell-search.js";

const test = browserSuite("operator-local-review-browser");
/** Service vocabulary, digits and codes that never appear in a message (see the Settings wording test). */
const serviceWords =
  /recorded|receipt|observation|admission|reconcile|submission|revision|\d|project\.|conflict|invalid/i;

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function sourceRepository(root: string) {
  const path = join(root, "alpha");
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  git(path, "config", "user.name", "Local Review Test");
  git(path, "config", "user.email", "local-review@example.invalid");
  writeFileSync(join(path, "review.txt"), "first\nsecond\nthird\nfourth\n");
  writeFileSync(join(path, "diff.txt"), "keep\ndrop one\ndrop two\ntail\n");
  git(path, "add", "-A");
  git(path, "commit", "--quiet", "-m", "base");
  return path;
}

async function signIn(
  page: Page,
  origin: string,
  path: string,
  password: string,
) {
  await page.goto(origin + path);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

type Journey = BrowserJourney;

/** A seeded task with a bound repository, a signed-out browser page and web fixture. */
async function startReview(
  j: Journey,
  viewport = { width: 1366, height: 900 },
) {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const source = sourceRepository(join(fixture.directory, "review-sources"));
  const task = await seedReviewTask(
    fixture,
    "Local review",
    "Review exact lines",
    "Send one local review",
    [{ repositoryId: "repo-alpha", path: source }],
  );
  // Production binds repositories only from the project's linked repositories.
  const domain = fixture.service.domain();
  await domain.configureGitHub({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: task.projectId,
    expectedVersion: Number(domain.githubConfiguration(task.projectId).version),
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R_1",
        owner: "org",
        name: "repo",
      },
    ],
    repositories: [{ repositoryId: "repo-alpha", path: source, ref: "main" }],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
  });
  const binding = await fixture.service.taskWorkspace(task.taskId);
  const alpha = binding?.repositories[0]?.workspacePath;
  assert.ok(alpha);
  writeFileSync(join(alpha, "diff.txt"), "keep\ntail\n");
  const events = () => {
    let count = 0;
    fixture.seedPersistedState((db) => {
      count = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE taskId=? AND eventType='operator-message'",
            )
            .get(task.taskId) as { count: number | bigint }
        ).count,
      );
    });
    return count;
  };
  const followUps = () => {
    let count = 0;
    fixture.seedPersistedState((db) => {
      count = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM coordination_inbox_events WHERE taskId=? AND eventType='assignment-follow-up'",
            )
            .get(task.taskId) as { count: number | bigint }
        ).count,
      );
    });
    return count;
  };

  const web = await j.start("fixture.web", () => fixture.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport,
  });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    fixture,
    task,
    web,
    page,
    consoleErrors,
    pageErrors,
    events,
    followUps,
  };
}

test("production local review composes exact multi-origin anchors and sends one receipt", async (_t, j) => {
  const { fixture, task, web, page, consoleErrors, pageErrors, events } =
    await startReview(j);
  const taskPath = `/app/tasks/${task.taskId}?section=files`;
  await signIn(page, web.origin, taskPath, web.password);

  // Current file: select lines 2–3 and comment.
  const files = page.locator("#files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  await files
    .getByRole("button", { name: "Line 3: third" })
    .click({ modifiers: ["Shift"] });
  await files.getByText("Selected lines 2–3", { exact: true }).waitFor();
  const fileComment = files.getByRole("button", {
    name: "Add review comment",
    exact: true,
  });
  await fileComment.click();
  const fileComposer = files.getByRole("form", { name: "Review comment" });
  assert.match(
    await fileComposer.innerText(),
    /Comment on current file · repo-alpha\/review\.txt · lines 2–3/,
  );
  await page.keyboard.type("Current file comment");
  await fileComposer
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await fileComposer.waitFor({ state: "detached" });
  // Focus returns to the invoking line (lines 2–3; the current line is 3).
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Line 3: third",
  );

  // Escape cancels without saving and restores focus.
  await fileComment.click();
  await page.keyboard.type("discarded text");
  await page.keyboard.press("Escape");
  await fileComposer.waitFor({ state: "detached" });
  // Focus returns to the invoking line (lines 2–3; the current line is 3).
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") === "Line 3: third",
  );

  // Changes: Before deleted lines from an exact Uncommitted comparison.
  await openTaskTab(page, "Changes");
  const changes = page.locator("#changes");
  await changes.getByLabel("Comparison target").selectOption("uncommitted");
  await changes.getByRole("button", { name: /modified diff\.txt/ }).click();
  await changes
    .getByRole("button", { name: /^Before line 2, diff\.txt;/ })
    .first()
    .click();
  await changes
    .getByRole("button", { name: /^Before line 3, diff\.txt;/ })
    .first()
    .click({ modifiers: ["Shift"] });
  await changes.getByText(/Selected Before lines 2–3 · diff\.txt/).waitFor();
  await changes
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  const changesComposer = changes.getByRole("form", { name: "Review comment" });
  assert.match(
    await changesComposer.innerText(),
    /Comment on uncommitted comparison · repo-alpha\/diff\.txt · lines 2–3 · Before/,
  );
  await page.keyboard.type("Deleted lines comment");
  await changesComposer
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await changesComposer.waitFor({ state: "detached" });

  // The complete draft shows both comments with original context.
  await openTaskTab(page, "Review");
  const review = page.locator("#local-review");
  const comments = review.getByRole("list", { name: "Review comments" });
  await comments.locator(":scope > li").nth(1).waitFor();
  await comments.getByText(/diff\.txt · lines 2–3/).waitFor();
  await comments.getByText(/review\.txt · lines 2–3/).waitFor();
  const draftText = await comments.innerText();
  assert.match(draftText, /repo-alpha\/review\.txt · lines 2–3 · workspace/);
  assert.match(draftText, /second\nthird/);
  assert.match(
    draftText,
    /repo-alpha\/diff\.txt · lines 2–3 · uncommitted · Before/,
  );
  assert.match(draftText, /drop one\ndrop two/);
  assert.equal(
    (draftText.match(/Current at last comparison/g) ?? []).length,
    2,
  );
  assert.match(draftText, /(as of|captured) .*\d/);

  // Edit, add summary, reload: draft persists within the live session.
  await comments.getByRole("button", { name: "Edit" }).first().click();
  await review.getByLabel("Edit comment").fill("Edited file comment");
  await review.getByRole("button", { name: "Save edit" }).click();
  await review.getByText("Edited file comment").waitFor();
  await review.getByLabel("Summary (optional)").fill("Two exact notes");
  await review.getByRole("button", { name: "Save summary" }).click();
  await review.getByRole("button", { name: "Save summary" }).waitFor({
    state: "detached",
  });
  await page.reload();
  // The link opens Files again; the draft is on the Review tab.
  await openTaskTab(page, "Review");
  await review.getByText("Edited file comment").waitFor();
  assert.equal(
    await review.getByLabel("Summary (optional)").inputValue(),
    "Two exact notes",
  );
  assert.match(await review.innerText(), /Destination: .*project lead/);
  await captureBrowserEvidence(page, "1366-local-review-complete-draft");

  // A response lost after commit stays unknown and reconciles to one event.
  assert.equal(events(), 0);
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.send") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });
  await review
    .getByRole("button", { name: /^Send review \(2 comments\)/ })
    .click();
  const outcome = review.locator("[data-slot=action-outcome]");
  await outcome
    .getByText(
      "We couldn't confirm the review reached Task lead. Your draft is kept.",
      { exact: true },
    )
    .waitFor();
  // One warning with one action; the code is only in Details.
  assert.equal(await outcome.count(), 1);
  assert.equal(await outcome.getByRole("button").count(), 1);
  assert.doesNotMatch(await outcome.locator("p").innerText(), serviceWords);
  await outcome.getByText("Details", { exact: true }).click();
  const fields = await outcome.locator("dl").innerText();
  assert.match(fields, /Command\s+review\.send/);
  assert.match(fields, /Request key\s+[0-9a-f-]{36}/);
  assert.match(fields, /Code\s+command-outcome-unknown/);
  await page.unroute("**/api/operator/commands");
  assert.equal(events(), 1);
  await review.getByRole("button", { name: "Check whether it saved" }).click();
  await review.getByText("Review sent to Task lead.").waitFor();
  assert.equal(events(), 1, "reconciliation never sends a second event");
  // The confirmed send keeps its request key in Details but not the earlier unknown code.
  const confirmed = review.locator("[data-slot=action-outcome]");
  await confirmed.getByText("Details", { exact: true }).click();
  const confirmedFields = await confirmed.locator("dl").innerText();
  assert.match(confirmedFields, /Request key\s+[0-9a-f-]{36}/);
  assert.doesNotMatch(confirmedFields, /Code|command-outcome-unknown/);
  const sent = review.getByRole("region", { name: "Sent review", exact: true });
  await sent.getByText("Edited file comment").waitFor();
  await sent.getByText(/diff\.txt · lines 2–3/).waitFor();
  await sent.getByText(/review\.txt · lines 2–3/).waitFor();
  assert.match(await sent.innerText(), /Summary: Two exact notes/);
  assert.match(await sent.innerText(), /drop one\ndrop two/);
  assert.equal(fixture.service.taskHold(task.taskId), undefined);

  // A new review starts empty; submitted context stays inspectable server-side.
  await review.getByRole("button", { name: "Start a new review" }).click();
  await review.getByText("No review comments yet.").waitFor();

  // An unsent draft does not cross sign-out.
  await openTaskTab(page, "Files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 1: first" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type("Unsent private note");
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await openTaskTab(page, "Review");
  await review.getByText("Unsent private note").waitFor();
  // Desktop sign-out is in the sidebar account menu.
  await page
    .getByRole("button", { name: "Operator account", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=local-review`,
    web.password,
  );
  await review
    .getByText(
      /An unsent draft was removed when its session ended or its access changed/,
    )
    .waitFor();
  assert.equal(await page.getByText("Unsent private note").count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await review.scrollIntoViewIfNeeded();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone review has no horizontal page scroll",
  );
  await captureBrowserEvidence(page, "390-local-review-after-sign-in", {
    fullPage: false,
  });
  assert.deepEqual(
    // Only the deliberately reset send and the post-sign-out session probe may fail.
    consoleErrors.filter(
      (text) =>
        !/net::ERR_CONNECTION_RESET|status of 401 \(Unauthorized\)/.test(text),
    ),
    [],
  );
  assert.deepEqual(pageErrors, []);
});

/** Selects one current-file line of review.txt, opening the file first when it is not open. */
async function selectLine(page: Page, line: string) {
  await openTaskTab(page, "Files");
  const files = page.locator("#files");
  // Files opens at the repository root; the first call opens the file, later calls find it open.
  const file = files.getByRole("button", { name: /review\.txt/ });
  const target = files.getByRole("button", { name: line });
  await file.or(target).first().waitFor();
  if (!(await target.isVisible())) await file.click();
  await target.click();
}

/** Selects one current-file line of review.txt and saves a comment on it. */
async function commentOnLine(page: Page, line: string, text: string) {
  const files = page.locator("#files");
  await selectLine(page, line);
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type(text);
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  // The draft lists it on the Review tab; Files stays open where the comment began.
  await page
    .locator("#local-review")
    .getByText(text)
    .waitFor({ state: "attached" });
}

const activeAttribute = (page: Page, name: string) =>
  page.waitForFunction(
    (attribute) => document.activeElement?.hasAttribute(attribute),
    name,
  );

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * Holds the answer to each of the first `count` draft saves after the server has committed
 * it, so a page can go away while its write is still waiting. Every save body is recorded.
 */
async function holdSaves(page: Page, count = 1) {
  const saves: string[] = [];
  const holds = Array.from({ length: count }, () => ({
    entered: deferred(),
    gate: deferred(),
  }));
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.draft.save") return route.continue();
    const hold = holds[saves.length];
    saves.push(route.request().postData() ?? "");
    if (!hold) return route.continue();
    const response = await route.fetch();
    hold.entered.resolve();
    await hold.gate.promise;
    await route.fulfill({ response });
  });
  return {
    saves,
    entered: (index: number) => holds[index]?.entered.promise,
    /** Lets the held answer through and resolves once the page has been given it. */
    async release(index: number) {
      const answered = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/operator/commands") &&
          response.request().postData() === saves[index],
      );
      holds[index]?.gate.resolve();
      await answered;
    },
    releaseAll() {
      for (const hold of holds) hold.gate.resolve();
    },
  };
}

/** Leaves the task and opens it again through a new navigation entry. */
async function reopenTask(page: Page) {
  await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
  await page.getByRole("link", { name: "Review exact lines" }).first().click();
}

const warningSelector =
  '#local-review [data-slot="action-outcome"][data-tone="warning"]';
/** Whether the check of the Local review warning has the focus. */
const checkFocused = (selector: string) => {
  const element = document.activeElement;
  return (
    element?.tagName === "BUTTON" &&
    element.textContent === "Check whether it saved" &&
    element.closest(selector) !== null
  );
};

/** The draft version on the server, read outside the page's own state. */
const draftVersion = (page: Page, taskId: string) =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/operator/tasks/${id}/review-draft`);
    const body = (await response.json()) as { data: { version: number } };
    return body.data.version;
  }, taskId);

test("a refused comment save shows one plain alert, keeps the text and puts the code in Details", async (_t, j) => {
  const { web, task, page, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const files = page.locator("#files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type("Refused comment");
  await page.route("**/api/operator/commands", (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.draft.save") return route.continue();
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "forbidden", message: "Refused" },
      }),
    });
  });
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  const alert = files.locator("[data-slot=action-outcome]");
  await alert
    .getByText(
      "Couldn't save the comment: you don't have permission. Your comment is kept.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await alert.count(), 1);
  assert.equal(await alert.getAttribute("role"), "alert");
  assert.doesNotMatch(await alert.locator("p").innerText(), serviceWords);
  assert.equal(
    await files.getByLabel("Comment", { exact: true }).inputValue(),
    "Refused comment",
  );
  await alert.getByText("Details", { exact: true }).click();
  const fields = await alert.locator("dl").innerText();
  assert.match(fields, /Command\s+review\.draft\.save/);
  assert.match(fields, /Code\s+forbidden/);
  assert.deepEqual(
    pageErrors.filter((text) => !/status of 403/.test(text)),
    [],
  );
});

test("a comment save whose response is lost stays one exact request until it is checked", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const files = page.locator("#files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type("Lost response comment");
  const stages: string[] = [];
  const saves: string[] = [];
  let lost = true;
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type === "review.anchor.stage")
      stages.push(route.request().postData() ?? "");
    if (body.type !== "review.draft.save") return route.continue();
    saves.push(route.request().postData() ?? "");
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  // The check lives in the Local review panel, reachable from anywhere in the task.
  const review = page.locator("#local-review");
  const warning = review.locator("[data-slot=action-outcome]");
  await warning
    .getByText(
      "We couldn't confirm the comment was saved. Your comment is kept.",
      { exact: true },
    )
    .waitFor({ state: "attached" });
  assert.equal(await warning.count(), 1);
  assert.equal(await warning.getAttribute("data-tone"), "warning");
  assert.equal(
    await files.getByLabel("Comment", { exact: true }).inputValue(),
    "Lost response comment",
  );
  assert.equal(
    await files.getByLabel("Comment", { exact: true }).isDisabled(),
    true,
  );
  // The composer points to the check instead of repeating the warning.
  const pointer = files.getByRole("link", {
    name: "Check whether it saved in Local review.",
  });
  await pointer.waitFor();
  assert.equal(await files.locator("[data-slot=action-outcome]").count(), 0);
  assert.equal(await pointer.getAttribute("href"), "#local-review");
  // The warning appeared without taking the focus: the pointer is the route to it.
  assert.equal(await page.evaluate(checkFocused, warningSelector), false);
  // Following it opens the Review tab and focuses the check in the same task as the click,
  // and adds no history entry.
  assert.equal(
    await pointer.evaluate((link, selector) => {
      (link as HTMLElement).click();
      const element = document.activeElement;
      return (
        element?.tagName === "BUTTON" &&
        element.textContent === "Check whether it saved" &&
        element.closest(selector) !== null
      );
    }, warningSelector),
    true,
  );
  assert.equal(new URL(page.url()).hash, "");
  // One action, now that the Review tab shows it.
  assert.equal(await warning.getByRole("button").count(), 1);
  await warning.getByText("Details", { exact: true }).click();
  assert.match(
    await warning.locator("dl").innerText(),
    /Request key\s+[0-9a-f-]{36}/,
  );
  await warning
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await review.getByText("Lost response comment").first().waitFor();
  // The check replayed the same save and the same anchor: one comment, no second request.
  assert.equal(saves.length, 2);
  assert.equal(saves[0], saves[1]);
  assert.equal(stages.length, 1);
  assert.equal(await review.getByText("Lost response comment").count(), 1);
  await files
    .getByLabel("Comment", { exact: true })
    .waitFor({ state: "detached" });
});

test("an unconfirmed edit keeps its request and blocks new comments and edits until it is checked", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  const files = page.locator("#files");
  const review = page.locator("#local-review");
  const saves: string[] = [];
  let lost = true;
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.draft.save") return route.continue();
    saves.push(route.request().postData() ?? "");
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await openTaskTab(page, "Review");
  await review.getByRole("button", { name: "Edit" }).click();
  await review.getByLabel("Edit comment").fill("Edited note");
  await review.getByRole("button", { name: "Save edit" }).click();
  const warning = review.locator("[data-slot=action-outcome]");
  await warning
    .getByText("We couldn't confirm the change was saved. Your text is kept.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await warning.getByRole("button").count(), 1);
  // Save edit gave way to the check, so the check takes the focus.
  await page.waitForFunction(checkFocused, warningSelector);
  // Other edits stay blocked: the textarea is off and no new comment can start.
  assert.equal(await review.getByLabel("Edit comment").isDisabled(), true);
  await openTaskTab(page, "Files");
  await files.getByRole("button", { name: "Line 2: second" }).click();
  assert.equal(
    await files
      .getByRole("button", { name: "Add review comment", exact: true })
      .isDisabled(),
    true,
  );
  await openTaskTab(page, "Review");
  await warning
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await review.getByText("Edited note", { exact: true }).waitFor();
  assert.equal(saves.length, 2);
  assert.equal(saves[0], saves[1]);
  // The checked edit settles to one success line, with no check left to press.
  await warning.getByText("Comment updated.", { exact: true }).waitFor();
  assert.equal(await warning.count(), 1);
  assert.equal(await warning.getAttribute("data-tone"), "success");
  assert.equal(await warning.getByRole("button").count(), 0);
  await openTaskTab(page, "Files");
  await files
    .locator("button:not([disabled])", { hasText: "Add review comment" })
    .waitFor();
});

test("a draft write still waiting when its page goes away is kept as one exact check", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  const files = page.locator("#files");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  const held = await holdSaves(page);
  try {
    await review.getByRole("button", { name: "Edit" }).click();
    await review.getByLabel("Edit comment").fill("Edited note");
    await review.getByRole("button", { name: "Save edit" }).click();
    await held.entered(0);
    // A new entry opens on Overview; the check waits on the Review tab.
    await reopenTask(page);
    await openTaskTab(page, "Review");
    const outcome = review.locator("[data-slot=action-outcome]");
    await outcome
      .getByText(
        "We couldn't confirm the change was saved. Your text is kept.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await outcome.count(), 1);
    assert.equal(await outcome.getAttribute("data-tone"), "warning");
    assert.equal(await outcome.getByRole("button").count(), 1);
    const key = (JSON.parse(held.saves[0] ?? "{}") as { key: string }).key;
    const fields = (await outcome.locator("dl").textContent()) ?? "";
    assert.match(fields, new RegExp(`Request key\\s*${key}`));
    assert.match(fields, /Code\s*command-outcome-unknown/);
    // The unsaved edit stays open, and only the held write keeps every control off.
    const saveEdit = review.getByRole("button", { name: "Save edit" });
    await saveEdit.waitFor();
    assert.equal(await saveEdit.isDisabled(), true);
    assert.equal(await review.getByLabel("Edit comment").isDisabled(), true);
    assert.equal(
      await review
        .getByRole("button", { name: "Remove", exact: true })
        .isDisabled(),
      true,
    );
    await selectLine(page, "Line 2: second");
    assert.equal(
      await files
        .getByRole("button", { name: "Add review comment", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(held.saves.length, 1);
    // The server already committed the held save: the check replays it and changes nothing.
    const version = await draftVersion(page, task.taskId);
    await openTaskTab(page, "Review");
    await outcome
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .click();
    await outcome.getByText("Comment updated.", { exact: true }).waitFor();
    assert.equal(await outcome.count(), 1);
    assert.equal(await outcome.getAttribute("data-tone"), "success");
    assert.equal(await outcome.getByRole("button").count(), 0);
    await review
      .getByRole("button", { name: "Edit", exact: true })
      .and(page.locator(":enabled"))
      .waitFor();
    await openTaskTab(page, "Files");
    await files
      .locator("button:not([disabled])", { hasText: "Add review comment" })
      .waitFor();
    assert.equal(held.saves.length, 2);
    assert.equal(held.saves[0], held.saves[1]);
    assert.equal(await draftVersion(page, task.taskId), version);
    // The original answer arrives afterwards and changes nothing.
    await held.release(0);
    await page.waitForTimeout(250);
    assert.equal(await outcome.count(), 1);
    assert.equal(await outcome.getAttribute("data-tone"), "success");
    assert.equal(held.saves.length, 2);
    assert.equal(await draftVersion(page, task.taskId), version);
    assert.equal(
      await review.getByText("Edited note", { exact: true }).count(),
      1,
    );
  } finally {
    held.releaseAll();
  }
});

test("a draft write answered after its page went away keeps its check and replays the same request", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  const files = page.locator("#files");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  const held = await holdSaves(page);
  try {
    await review.getByRole("button", { name: "Edit" }).click();
    await review.getByLabel("Edit comment").fill("Edited note");
    await review.getByRole("button", { name: "Save edit" }).click();
    await held.entered(0);
    await reopenTask(page);
    await openTaskTab(page, "Review");
    await held.release(0);
    await page.waitForTimeout(250);
    // The late answer is not a second result: the check, its key and the held controls stay.
    const outcome = review.locator("[data-slot=action-outcome]");
    await outcome
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .waitFor();
    assert.equal(await outcome.count(), 1);
    assert.equal(await outcome.getAttribute("data-tone"), "warning");
    assert.equal(await outcome.getByRole("button").count(), 1);
    const key = (JSON.parse(held.saves[0] ?? "{}") as { key: string }).key;
    assert.match(
      (await outcome.locator("dl").textContent()) ?? "",
      new RegExp(`Request key\\s*${key}`),
    );
    // The unsaved edit stays open, with every control off.
    const saveEdit = review.getByRole("button", { name: "Save edit" });
    await saveEdit.waitFor();
    assert.equal(await saveEdit.isDisabled(), true);
    assert.equal(await review.getByLabel("Edit comment").isDisabled(), true);
    assert.equal(held.saves.length, 1, "the late answer made no request");
    const version = await draftVersion(page, task.taskId);
    await outcome
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .click();
    await outcome.getByText("Comment updated.", { exact: true }).waitFor();
    await review
      .getByRole("button", { name: "Edit", exact: true })
      .and(page.locator(":enabled"))
      .waitFor();
    await selectLine(page, "Line 2: second");
    await files
      .locator("button:not([disabled])", { hasText: "Add review comment" })
      .waitFor();
    assert.equal(held.saves.length, 2);
    assert.equal(held.saves[0], held.saves[1]);
    assert.equal(await draftVersion(page, task.taskId), version);
  } finally {
    held.releaseAll();
  }
});

test("every draft write reports one plain success line with its receipt, cleared when the operator types", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const review = page.locator("#local-review");
  const success = review.locator("[data-slot=action-outcome]");
  const expectSuccess = async (message: string) => {
    await success.getByText(message, { exact: true }).waitFor();
    assert.equal(await success.count(), 1);
    assert.equal(await success.getAttribute("data-tone"), "success");
    assert.doesNotMatch(await success.locator("p").innerText(), serviceWords);
    await success.getByText("Details", { exact: true }).click();
    const fields = await success.locator("dl").innerText();
    assert.match(fields, /Command\s+review\.draft\.save/);
    assert.match(fields, /Request key\s+[0-9a-f-]{36}/);
    assert.match(fields, /Kind\s+local-review-draft/);
  };
  await commentOnLine(page, "Line 1: first", "First note");
  await openTaskTab(page, "Review");
  await expectSuccess("Comment added.");
  await review.getByRole("button", { name: "Edit" }).click();
  await review.getByLabel("Edit comment").fill("Edited note");
  assert.equal(await success.count(), 0, "typing clears the success line");
  await review.getByRole("button", { name: "Save edit" }).click();
  await expectSuccess("Comment updated.");
  await review.getByLabel("Summary (optional)").fill("A summary");
  await review.getByRole("button", { name: "Save summary" }).click();
  await expectSuccess("Summary saved.");
  await review.getByRole("button", { name: "Remove", exact: true }).click();
  await expectSuccess("Comment removed.");
});

test("the review controls stay off until the refresh after a draft write has finished", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  await review.getByRole("button", { name: "Edit" }).click();
  await review.getByLabel("Edit comment").fill("Edited note");
  let entered!: () => void;
  let release!: () => void;
  const readEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/tasks/*/review-draft", async (route) => {
    entered();
    await gate;
    await route.continue();
  });
  await review.getByRole("button", { name: "Save edit" }).click();
  await readEntered;
  // The write is recorded and the draft read is still on its way: nothing may start.
  await page.waitForTimeout(200);
  assert.equal(
    await review.getByRole("button", { name: "Save edit" }).isDisabled(),
    true,
  );
  assert.equal(await review.getByLabel("Edit comment").isDisabled(), true);
  assert.equal(
    await review.getByRole("button", { name: "Cancel edit" }).isDisabled(),
    true,
  );
  assert.equal(
    await review.getByLabel("Summary (optional)").isDisabled(),
    true,
  );
  release();
  await review
    .locator("[data-slot=action-outcome]")
    .getByText("Comment updated.", { exact: true })
    .waitFor();
  await page.unroute("**/api/operator/tasks/*/review-draft");
  await review
    .getByRole("button", { name: "Edit" })
    .and(page.locator(":enabled"))
    .waitFor();
});

test("the review controls are off from the first request of a new comment until it has settled", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  const files = page.locator("#files");
  const review = page.locator("#local-review");
  await files.getByRole("button", { name: "Line 2: second" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type("Second note");
  let entered!: () => void;
  let release!: () => void;
  const stageEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.anchor.stage") return route.continue();
    entered();
    await gate;
    await route.continue();
  });
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await stageEntered;
  // The first request is in flight and nothing has been re-read yet: no other write may start.
  await page.waitForTimeout(200);
  // The draft is on the Review tab, which Files hides.
  assert.equal(
    await review
      .getByRole("button", { name: "Edit", includeHidden: true })
      .first()
      .isDisabled(),
    true,
  );
  assert.equal(
    await review
      .getByRole("button", { name: "Remove", exact: true, includeHidden: true })
      .first()
      .isDisabled(),
    true,
  );
  release();
  await openTaskTab(page, "Review");
  await review.getByText("Second note").waitFor();
  await page.unroute("**/api/operator/commands");
});

/** A new comment whose anchor request was committed but whose answer was lost. */
async function loseStageAnswer(
  page: Page,
  task: { taskId: string },
  web: { origin: string; password: string },
  replay: "continue" | "refuse" = "continue",
) {
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const files = page.locator("#files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.type("Settled after leaving");
  const stages: string[] = [];
  const saves: string[] = [];
  let lost = true;
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type === "review.draft.save")
      saves.push(route.request().postData() ?? "");
    if (body.type !== "review.anchor.stage") return route.continue();
    stages.push(route.request().postData() ?? "");
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort("connectionreset");
    } else if (replay === "refuse")
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "forbidden", message: "Refused" },
        }),
      });
    else await route.continue();
  });
  await files
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  const review = page.locator("#local-review");
  await review
    .locator("[data-slot=action-outcome]")
    .getByText(
      "We couldn't confirm the exact lines were captured. Your comment is kept.",
      { exact: true },
    )
    .waitFor({ state: "attached" });
  // The composer stays open in Files, so the warning waits on the marked Review tab.
  // The tab is marked in a later render than the outcome text.
  await page
    .getByRole("tab", { name: "Review", exact: true })
    .and(page.locator('[aria-description="A review write needs a check"]'))
    .waitFor();
  return { stages, saves, review };
}

test("an unconfirmed anchor stays checkable from a new navigation entry and finishes the comment once", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  const { stages, saves, review } = await loseStageAnswer(page, task, web);
  // Leave and reopen the task through a new entry: no composer is on screen any more.
  await reopenTask(page);
  await openTaskTab(page, "Review");
  const warning = review.locator("[data-slot=action-outcome]");
  await warning
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .waitFor();
  // A warning restored on a later visit does not take the focus.
  assert.equal(await page.evaluate(checkFocused, warningSelector), false);
  assert.equal(await page.getByLabel("Comment", { exact: true }).count(), 0);
  await warning
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await review.getByText("Settled after leaving").first().waitFor();
  assert.equal(stages.length, 2);
  assert.equal(stages[0], stages[1]);
  assert.equal(saves.length, 1);
  assert.equal(await review.getByText("Settled after leaving").count(), 1);
  await warning.getByText("Comment added.", { exact: true }).waitFor();
});

test("a stage replay stays held while no draft is loaded, then finishes the comment once", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  const { stages, saves, review } = await loseStageAnswer(page, task, web);
  const readGate = deferred();
  await page.route("**/api/operator/tasks/*/review-draft", async (route) => {
    await readGate.promise;
    // The refresh after the replay aborts the read that was in flight first.
    await route.continue().catch(() => {});
  });
  const stageAnswered = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/operator/commands") &&
        response.request().postData() === stages[0],
    );
  try {
    await reopenTask(page);
    await openTaskTab(page, "Review");
    const outcome = review.locator("[data-slot=action-outcome]");
    const check = outcome.getByRole("button", {
      name: "Check whether it saved",
      exact: true,
    });
    const replayed = stageAnswered();
    await check.click();
    await replayed;
    // The anchor is recorded again, but this page has no draft to save it into.
    assert.equal(stages.length, 2);
    assert.equal(stages[0], stages[1]);
    assert.equal(saves.length, 0);
    readGate.resolve();
    await outcome
      .getByText(
        "We couldn't confirm the exact lines were captured. Your comment is kept.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await outcome.count(), 1);
    // The check the operator pressed gave way to the held replay's, which takes the focus.
    await page.waitForFunction(checkFocused, warningSelector);
    assert.equal(saves.length, 0, "the held replay started no save");
    assert.equal(await review.getByText("Settled after leaving").count(), 0);
    const finished = stageAnswered();
    await check.click();
    await finished;
    await review.getByText("Settled after leaving").first().waitFor();
    await outcome.getByText("Comment added.", { exact: true }).waitFor();
    assert.equal(stages.length, 3);
    assert.equal(stages[1], stages[2]);
    assert.equal(saves.length, 1);
    assert.equal(await review.getByText("Settled after leaving").count(), 1);
  } finally {
    readGate.resolve();
  }
});

test("a late answer to a save chained after a stage does not unlock the controls while its check runs", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const files = page.locator("#files");
  const review = page.locator("#local-review");
  const held = await holdSaves(page, 2);
  try {
    await selectLine(page, "Line 1: first");
    await files
      .getByRole("button", { name: "Add review comment", exact: true })
      .click();
    await page.keyboard.type("Chained note");
    await files
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    // The stage is recorded; the save chained after it is the write that is waiting.
    await held.entered(0);
    await reopenTask(page);
    await openTaskTab(page, "Review");
    const outcome = review.locator("[data-slot=action-outcome]");
    await outcome
      .getByText(
        "We couldn't confirm the comment was saved. Your comment is kept.",
        {
          exact: true,
        },
      )
      .waitFor();
    await outcome
      .getByRole("button", { name: "Check whether it saved", exact: true })
      .click();
    await held.entered(1);
    // The first page's answer arrives while the check's replay is still in flight.
    await held.release(0);
    await page.waitForTimeout(250);
    const edit = review.getByRole("button", { name: "Edit", exact: true });
    await edit.waitFor();
    assert.equal(await edit.isDisabled(), true);
    held.releaseAll();
    await outcome.getByText("Comment added.", { exact: true }).waitFor();
    await edit.and(page.locator(":enabled")).waitFor();
    assert.equal(held.saves.length, 2);
    assert.equal(held.saves[0], held.saves[1]);
    assert.equal(await review.getByText("Chained note").count(), 1);
  } finally {
    held.releaseAll();
  }
});

test("a refused replay on a new entry is reported in the panel and does not block new comments", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  const { review } = await loseStageAnswer(page, task, web, "refuse");
  await reopenTask(page);
  await openTaskTab(page, "Review");
  const panel = review.locator("[data-slot=action-outcome]");
  await panel
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  // The composer's form is not on this page, so the refusal is said in the panel, once.
  await panel
    .getByText(
      "Couldn't capture the exact lines: you don't have permission. Your comment is kept.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await panel.count(), 1);
  // The leftover composer does not hold the Add button: a new comment can start here.
  await openTaskTab(page, "Files");
  const files = page.locator("#files");
  await files.getByRole("button", { name: /diff\.txt/ }).click();
  await files.getByRole("button", { name: "Line 1: keep" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await files.getByLabel("Comment", { exact: true }).waitFor();
});

test("a refusal shown in the panel moves into the composer when it is reopened and back when it leaves", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  const { review } = await loseStageAnswer(page, task, web, "refuse");
  const files = page.locator("#files");
  const refusal =
    "Couldn't capture the exact lines: you don't have permission. Your comment is kept.";
  const panel = review.locator("[data-slot=action-outcome]");
  await reopenTask(page);
  await openTaskTab(page, "Review");
  await panel
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await panel.getByText(refusal, { exact: true }).waitFor();
  assert.equal(await panel.count(), 1);
  // Opening the file brings the composer's form back: it carries the refusal, the panel does not.
  // Every committed DOM change is sampled, so a commit that shows both alerts counts even if
  // the next one removes the panel's.
  await page.evaluate((text) => {
    const samples: number[] = [];
    (window as unknown as { refusalSamples: number[] }).refusalSamples =
      samples;
    new MutationObserver(() =>
      samples.push(
        [...document.querySelectorAll('[data-slot="action-outcome"]')].filter(
          (alert) => alert.textContent?.includes(text),
        ).length,
      ),
    ).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, refusal);
  await openTaskTab(page, "Files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files
    .getByRole("form", { name: "Review comment" })
    .getByText(refusal, { exact: true })
    .waitFor();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.getByText(refusal, { exact: true }).count(), 1);
  assert.deepEqual(
    [
      ...new Set(
        await page.evaluate(
          () =>
            (window as unknown as { refusalSamples: number[] }).refusalSamples,
        ),
      ),
    ],
    [1],
    "the refusal is on screen once in every committed state",
  );
  // When the form leaves, the panel says it again, once.
  await reopenTask(page);
  await openTaskTab(page, "Review");
  await panel.getByText(refusal, { exact: true }).waitFor();
  assert.equal(await panel.count(), 1);
  assert.equal(await page.getByText(refusal, { exact: true }).count(), 1);
  // A comment started elsewhere replaces that composer, and its refusal goes with it.
  await openTaskTab(page, "Files");
  await files.getByRole("button", { name: /diff\.txt/ }).click();
  await files.getByRole("button", { name: "Line 1: keep" }).click();
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await files.getByLabel("Comment", { exact: true }).waitFor();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.getByText(refusal, { exact: true }).count(), 0);
});

test("a review send in flight when its page goes away is left for the next page to check", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  let entered!: () => void;
  let release!: () => void;
  const sendEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/commands", async (route) => {
    const body = route.request().postDataJSON() as { type?: string };
    if (body.type !== "review.send") return route.continue();
    entered();
    await gate;
    await route.continue();
  });
  const sendAnswered = page.waitForResponse(
    (response) =>
      response.url().includes("/api/operator/commands") &&
      (response.request().postData() ?? "").includes("review.send"),
  );
  await review
    .getByRole("button", { name: /^Send review \(1 comment\)/ })
    .click();
  await sendEntered;
  await openSearchFromSidebar(page, { keepFocus: true });
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  await openTaskTab(page, "Review");
  release();
  await sendAnswered;
  // The old page's answer is not applied to a page that is gone; the new page checks it.
  await review
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  await review.getByText("Review sent to Task lead.").waitFor();
  await review.getByRole("button", { name: "Start a new review" }).waitFor();
});

test("an unconfirmed anchor is settled by the page that checks it after a remount", async (_t, j) => {
  const { web, task, page } = await startReview(j);
  const { stages, saves, review } = await loseStageAnswer(page, task, web);
  await openSearchFromSidebar(page, { keepFocus: true });
  await page
    .getByRole("button", { name: "Back to originating workspace", exact: true })
    .click();
  await openTaskTab(page, "Review");
  const warning = review.locator("[data-slot=action-outcome]");
  await warning
    .getByRole("button", { name: "Check whether it saved", exact: true })
    .click();
  // The current page saves and reads the draft back: the comment shows without a reload.
  await review.getByText("Settled after leaving").first().waitFor();
  assert.equal(stages.length, 2);
  assert.equal(stages[0], stages[1]);
  assert.equal(saves.length, 1);
  await warning.getByText("Comment added.", { exact: true }).waitFor();
});

test("local review keeps focus on the selection, the next comment and the heading", async (_t, j) => {
  const { web, task, page, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  await commentOnLine(page, "Line 2: second", "Second note");
  await commentOnLine(page, "Line 3: third", "Third note");

  // Saving and Escape both return focus to the invoking line.
  const files = page.locator("#files");
  await page.waitForFunction(
    () =>
      document.activeElement?.hasAttribute("data-review-return") === true &&
      document.activeElement?.textContent?.includes("third") === true,
  );
  await files
    .getByRole("button", { name: "Add review comment", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await files.getByRole("form", { name: "Review comment" }).waitFor({
    state: "detached",
  });
  await page.waitForFunction(
    () =>
      document.activeElement?.hasAttribute("data-review-return") === true &&
      document.activeElement?.textContent?.includes("third") === true,
  );

  const review = page.locator("#local-review");
  const items = review
    .getByRole("list", { name: "Review comments" })
    .locator(":scope > li");
  await openTaskTab(page, "Review");
  await items.nth(2).waitFor();

  // Escape cancels an edit, keeps the saved text and returns to its Edit button.
  await items.first().getByRole("button", { name: "Edit" }).click();
  await review.getByLabel("Edit comment").fill("Unsaved edit");
  await page.keyboard.press("Escape");
  await review.getByLabel("Edit comment").waitFor({ state: "detached" });
  await activeAttribute(page, "data-review-edit");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Edit",
  );
  await review.getByText("First note", { exact: true }).waitFor();
  assert.equal(await review.getByText("Unsaved edit").count(), 0);

  // Removing moves focus to the next comment, the previous one when last, and
  // finally to the Local review heading.
  const commentFocused = (text: string) =>
    page.waitForFunction(
      (expected) =>
        document.activeElement?.hasAttribute("data-comment-id") &&
        document.activeElement.textContent?.includes(expected),
      text,
    );
  await items.first().getByRole("button", { name: "Remove" }).click();
  await commentFocused("Second note");
  await items.last().getByRole("button", { name: "Remove" }).click();
  await commentFocused("Second note");
  assert.equal(await items.count(), 1);
  await items.first().getByRole("button", { name: "Remove" }).click();
  await page.waitForFunction(
    () => document.activeElement?.id === "local-review-heading",
  );
  await review.getByText("No review comments yet.").waitFor();
  assert.deepEqual(pageErrors, []);
});

/** Frame callbacks run before the page's own render, the order a loaded machine sometimes produces. */
const framesBeforeCommit = (page: Page) =>
  page.evaluate(() => {
    window.requestAnimationFrame = (callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 0;
    };
  });
// Playwright's own clicks wait on page frames, so the click is dispatched in the page.
const domClick = (target: Locator) =>
  target.evaluate((element) => (element as HTMLElement).click());

test("local review focus survives frame callbacks that run before the page commits", async (_t, j) => {
  const { web, task, page, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  await commentOnLine(page, "Line 2: second", "Second note");
  await commentOnLine(page, "Line 3: third", "Third note");
  const files = page.locator("#files");
  const review = page.locator("#local-review");
  // The list is on the Review tab, hidden while Files is open.
  const items = review
    .getByRole("list", { name: "Review comments", includeHidden: true })
    .locator(":scope > li");
  await items.nth(2).waitFor({ state: "attached" });
  const frames = await page.evaluateHandle(() => window.requestAnimationFrame);
  try {
    await framesBeforeCommit(page);
    // Locator waits only: waitForFunction would poll with the replaced frame callbacks.
    const returned = page.locator("[data-review-return]:focus", {
      hasText: "third",
    });
    const addButton = files.getByRole("button", {
      name: "Add review comment",
      exact: true,
    });
    await domClick(addButton);
    await page.keyboard.press("Escape");
    await files.getByRole("form", { name: "Review comment" }).waitFor({
      state: "detached",
    });
    await returned.waitFor();
    // Saving returns to the line too.
    await domClick(addButton);
    await page.keyboard.type("Fourth note");
    await domClick(
      files.getByRole("button", { name: "Save comment", exact: true }),
    );
    await review.getByText("Fourth note").waitFor({ state: "attached" });
    await returned.waitFor();
    await domClick(page.getByRole("tab", { name: "Review", exact: true }));

    // Cancelling an edit returns to its Edit button; saving one to a re-enabled Edit.
    const edit = (index: number) =>
      items.nth(index).getByRole("button", { name: "Edit", exact: true });
    const editFocused = page.locator("[data-review-edit]:focus:enabled");
    await domClick(edit(0));
    await review.getByLabel("Edit comment").fill("Unsaved edit");
    await page.keyboard.press("Escape");
    await review.getByLabel("Edit comment").waitFor({ state: "detached" });
    await editFocused.waitFor();
    await domClick(edit(0));
    await review.getByLabel("Edit comment").fill("Edited note");
    await domClick(review.getByRole("button", { name: "Save edit" }));
    await review.getByText("Edited note", { exact: true }).waitFor();
    await editFocused.waitFor();

    // Removing moves focus to the next comment, the previous one when last, then the heading.
    const remove = (index: number) =>
      domClick(
        items.nth(index).getByRole("button", { name: "Remove", exact: true }),
      );
    const commentFocused = (text: string) =>
      page.locator("[data-comment-id]:focus", { hasText: text }).waitFor();
    await remove(0);
    await commentFocused("Second note");
    await remove(2);
    await commentFocused("Third note");
    await remove(1);
    await commentFocused("Second note");
    await remove(0);
    await page.locator("#local-review-heading:focus").waitFor();
    await review.getByText("No review comments yet.").waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await frames.evaluate((original) => {
      window.requestAnimationFrame = original;
    });
  }
});

test("a write answered after local review is left queues no focus", async (_t, j) => {
  const { web, task, page, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 1: first", "First note");
  await commentOnLine(page, "Line 2: second", "Second note");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  const held = await holdSaves(page);
  try {
    await review
      .getByRole("button", { name: "Remove", exact: true })
      .first()
      .click();
    await held.entered(0);
    await reopenTask(page);
    await held.release(0);
    await page.waitForTimeout(250);
    const focused = await page.evaluate(() =>
      Boolean(document.activeElement?.closest("#local-review")),
    );
    assert.equal(focused, false);
    assert.deepEqual(pageErrors, []);
  } finally {
    held.releaseAll();
  }
});

test("phone local review comments and sends to a receipt using the keyboard", async (_t, j) => {
  const { web, task, page, events, pageErrors } = await startReview(j, {
    width: 390,
    height: 844,
  });
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  const files = page.locator("#files");
  await files.getByRole("button", { name: /review\.txt/ }).click();
  await files.getByRole("button", { name: "Line 2: second" }).click();
  const add = files.getByRole("button", {
    name: "Add review comment",
    exact: true,
  });
  await add.focus();
  await page.keyboard.press("Enter");
  const composer = files.getByRole("form", { name: "Review comment" });
  await composer.waitFor();
  await page.keyboard.type("Phone keyboard comment");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Save comment",
  );
  await page.keyboard.press("Enter");
  await composer.waitFor({ state: "detached" });
  await page.waitForFunction(
    () =>
      document.activeElement?.closest("#files") !== null &&
      document.activeElement !== document.body,
  );

  // Move to the complete review with the tab list, then send.
  await page.getByRole("tab", { name: "Review", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator("#task-panel-review").waitFor();
  const review = page.locator("#local-review");
  await review.getByText("Phone keyboard comment").waitFor();
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone review has no horizontal page scroll",
  );
  await captureBrowserEvidence(page, "390-local-review-keyboard-draft", {
    fullPage: false,
  });
  const send = review.getByRole("button", {
    name: /^Send review \(1 comment\)/,
  });
  await send.focus();
  await page.keyboard.press("Enter");
  await review.getByText("Review sent to Task lead.").waitFor();
  assert.equal(events(), 1);
  const sent = review.getByRole("region", { name: "Sent review", exact: true });
  await sent.getByText("Phone keyboard comment").waitFor();
  await captureBrowserEvidence(page, "390-local-review-keyboard-receipt", {
    fullPage: false,
  });
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    "phone receipt has no horizontal page scroll",
  );
  assert.deepEqual(pageErrors, []);
});

const noHorizontalScroll = async (page: Page, label: string) =>
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 1,
    label,
  );

test("a completed lead is resumed by a review, with the status line before sending", async (_t, j) => {
  const { web, task, page, events, followUps, pageErrors } =
    await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Comment for a finished lead");
  const review = page.locator("#local-review");
  const send = review.getByRole("button", {
    name: /^Send review \(1 comment\)/,
  });
  const notice = review.getByText(leadResumeNotice("Task lead"), {
    exact: true,
  });
  assert.equal(await notice.count(), 0);

  // A terminal result completes the accountable lead's assignment.
  task.result("Terminal lead result");
  await page.reload();
  await openTaskTab(page, "Review");
  await review.getByText("Comment for a finished lead").waitFor();
  await notice.waitFor();
  assert.equal(await send.isEnabled(), true);
  await send.click();
  await review
    .getByText(
      "Review sent to Task lead. Task lead was resumed with this review as a follow-up.",
    )
    .waitFor();
  assert.equal(events(), 0);
  assert.equal(followUps(), 1);
  assert.deepEqual(pageErrors, []);
});

// Depends on the server resuming a lead that completed after the page loaded.
test("a lead that completes after the page loaded is resumed; a held lead is a definitive rejection", async (_t, j) => {
  const {
    fixture,
    web,
    task,
    page,
    events,
    followUps,
    consoleErrors,
    pageErrors,
  } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Comment for a stale lead");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  task.result("Terminal lead result");
  await review
    .getByRole("button", { name: /^Send review \(1 comment\)/ })
    .click();
  await review
    .getByText(/Task lead was resumed with this review as a follow-up/)
    .waitFor();
  assert.equal(followUps(), 1);

  // The resumed lead completes again and is then held: the next review is refused.
  await review.getByRole("button", { name: "Start a new review" }).click();
  await commentOnLine(page, "Line 3: third", "Comment for a held lead");
  await openTaskTab(page, "Review");
  task.result("Second terminal lead result");
  fixture.seedPersistedState((db) =>
    db
      .prepare("UPDATE domain_assignments SET state='held' WHERE id=?")
      .run(task.assignmentId),
  );
  await review
    .getByRole("button", { name: /^Send review \(1 comment\)/ })
    .click();
  await review
    .getByText(
      "The review wasn't sent: the lead can no longer receive a review. Your comments are kept.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await review.locator("[data-slot=action-outcome]").count(), 1);
  await review.getByRole("button", { name: "Return to draft" }).click();
  await review.getByText("Comment for a held lead").waitFor();
  assert.equal(
    await review.getByRole("button", { name: /^Send review/ }).count(),
    1,
  );
  assert.equal(events(), 0);
  assert.equal(followUps(), 1);
  assert.deepEqual(
    consoleErrors.filter((text) => !/status of 409/.test(text)),
    [],
  );
  assert.deepEqual(pageErrors, []);
});

test("phone keyboard review to a completed lead shows the status line and resumes it", async (_t, j) => {
  const { web, task, page, followUps, pageErrors } = await startReview(j, {
    width: 390,
    height: 844,
  });
  task.result("Terminal lead result");
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Phone follow-up comment");
  await page.getByRole("tab", { name: "Review", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.locator("#task-panel-review").waitFor();
  const review = page.locator("#local-review");
  await review
    .getByText(leadResumeNotice("Task lead"), { exact: true })
    .waitFor();
  await noHorizontalScroll(page, "phone status line has no horizontal scroll");
  const send = review.getByRole("button", {
    name: /^Send review \(1 comment\)/,
  });
  await send.focus();
  await page.keyboard.press("Enter");
  await review
    .getByText(/Task lead was resumed with this review as a follow-up/)
    .waitFor();
  assert.equal(followUps(), 1);
  await noHorizontalScroll(page, "phone receipt has no horizontal scroll");
  assert.deepEqual(pageErrors, []);
});

// The server's awaitingRecoveryMessage predicate is proved in recovery-continuation.test.ts;
// this checks the panel renders the flag it is given.
test("the recovery-continuation copy appears only while the lead awaits an operator message", async (_t, j) => {
  const { web, task, page, pageErrors } = await startReview(j);
  let awaiting = true;
  await page.route(
    (url) => url.pathname === `/api/operator/tasks/${task.taskId}`,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        data: { leadFeedback?: { awaitingRecoveryMessage: boolean } };
      };
      if (body.data.leadFeedback)
        body.data.leadFeedback.awaitingRecoveryMessage = awaiting;
      await route.fulfill({ response, json: body });
    },
  );
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Recovery comment");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  const copy = review.getByText(leadAwaitingRecoveryNotice("Task lead"), {
    exact: true,
  });
  await copy.waitFor();
  assert.equal(
    await review
      .getByRole("button", { name: /^Send review \(1 comment\)/ })
      .isEnabled(),
    true,
  );
  awaiting = false;
  await page.reload();
  await openTaskTab(page, "Review");
  await review.getByText("Recovery comment").waitFor();
  assert.equal(await copy.count(), 0);
  assert.deepEqual(pageErrors, []);
});

// Depends on the server's GET /api/operator/tasks/{id}/local-reviews route.
test("sent reviews stay inspectable after reload and Start a new review", async (_t, j) => {
  const { web, task, page, events, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Durable sent comment");
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  await review
    .getByRole("button", { name: /^Send review \(1 comment\)/ })
    .click();
  await review.getByText("Review sent to Task lead.").waitFor();
  assert.equal(events(), 1);

  await page.reload();
  await openTaskTab(page, "Review");
  await review.getByRole("button", { name: "Start a new review" }).click();
  await review.getByText("No review comments yet.").waitFor();
  const list = review.getByRole("region", {
    name: "Sent reviews",
    exact: true,
  });
  await list.waitFor();
  assert.equal(await list.getByRole("listitem").count(), 1);
  assert.match(await list.innerText(), /to .* · review [0-9a-f-]{36}/);
  await list.getByRole("button", { name: /^Inspect review/ }).click();
  const sent = review.getByRole("region", { name: "Sent review", exact: true });
  await sent.getByText("Durable sent comment").waitFor();
  assert.match(await sent.innerText(), /recorded /);
  assert.equal(events(), 1);
  assert.deepEqual(pageErrors, []);
});

test("a stored comment without line context can be removed so the review can be sent", async (_t, j) => {
  const { fixture, web, task, page, pageErrors } = await startReview(j);
  await signIn(
    page,
    web.origin,
    `/app/tasks/${task.taskId}?section=files`,
    web.password,
  );
  await commentOnLine(page, "Line 2: second", "Anchored comment");
  // Simulate a draft saved before every comment required an anchor.
  fixture.seedPersistedState((db) => {
    const row = db
      .prepare(
        "SELECT draftJson FROM coordination_local_review_drafts WHERE taskId=?",
      )
      .get(task.taskId) as { draftJson: string };
    const draft = JSON.parse(row.draftJson) as {
      summary: string;
      comments: unknown[];
    };
    draft.comments.push(
      { commentId: randomUUID(), body: "Legacy one", anchorGroupIds: [] },
      { commentId: randomUUID(), body: "Legacy two", anchorGroupIds: [] },
    );
    db.prepare(
      "UPDATE coordination_local_review_drafts SET draftJson=? WHERE taskId=?",
    ).run(JSON.stringify(draft), task.taskId);
  });
  await page.reload();
  const review = page.locator("#local-review");
  await openTaskTab(page, "Review");
  await review.getByText("Legacy two").waitFor();
  const send = review.getByRole("button", { name: /^Send review/ });
  assert.equal(await send.isDisabled(), true);

  // An edit that the save contract refuses settles instead of freezing the panel.
  await review.getByRole("button", { name: "Edit" }).first().click();
  await review.getByLabel("Edit comment").fill("Edited while legacy remains");
  await review.getByRole("button", { name: "Save edit" }).click();
  const refused = review.locator("[data-slot=action-outcome]");
  await refused
    .getByText(
      "Couldn't save the change: the service didn't accept it. Your text is kept.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await refused.count(), 1);
  assert.doesNotMatch(await refused.locator("p").innerText(), serviceWords);
  await refused.getByText("Details", { exact: true }).click();
  assert.match(await refused.locator("dl").innerText(), /Code\s+invalid-input/);
  await review.getByRole("button", { name: "Cancel edit" }).click();
  // Leave an editor open on a legacy comment; bulk removal must clear it.
  await review.getByRole("button", { name: "Edit" }).last().click();

  await review
    .getByRole("button", { name: "Remove comments without line context" })
    .click();
  await review.getByText("Legacy two").waitFor({ state: "detached" });
  assert.equal(await review.getByText("Legacy one").count(), 0);
  await review.getByText("Anchored comment").waitFor();
  assert.equal(await send.isEnabled(), true);
  assert.deepEqual(pageErrors, []);
});
