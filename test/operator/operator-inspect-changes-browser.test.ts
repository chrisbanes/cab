import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// The budget is the table under "Budget" in docs/user-flows/inspect-changes.md.
const test = browserSuite("inspect-changes-budget");

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

type Viewport = { width: number; height: number };

async function launch(
  journey: BrowserJourney,
  viewport: Viewport,
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  setBrowser: (browser: Browser) => void,
) {
  const web = await journey.start("fixture.web", () => f.startWeb());
  const browser = await journey.start("browser.launch", () =>
    chromium.launch(),
  );
  setBrowser(browser);
  const page = await browser.newPage({ viewport });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  // Home's getting-started rows follow this machine's runtime login.
  await stubReadiness(page);
  return { web, page };
}

/**
 * One task bound to a repository whose Branch comparison against `main` is two files:
 * guide.md (+2 -1) and notes.md (+1). Signed in on `path`.
 */
async function start(
  journey: BrowserJourney,
  viewport: Viewport,
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
  const source = join(f.directory, "src-alpha");
  mkdirSync(source, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", source]);
  git(source, "config", "user.name", "Inspect Changes Test");
  git(source, "config", "user.email", "inspect-changes@example.invalid");
  writeFileSync(join(source, "guide.md"), "one\ntwo\nthree\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "base");
  const task = await seedReviewTask(
    f,
    "Inspect project",
    "Inspect task",
    "Body",
    [{ repositoryId: "repo-alpha", path: source, ref: "main" }],
  );
  const binding = await f.service.taskWorkspace(task.taskId);
  const workspace = binding?.repositories[0]?.workspacePath;
  assert.ok(workspace);
  writeFileSync(join(workspace, "guide.md"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(workspace, "notes.md"), "new\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "--quiet", "-m", "change");
  task.result("Inspect result summary", {
    sourceId: task.source.sourceId,
    changes: {
      files: ["guide.md", "notes.md"],
      commits: [],
      findings: [],
      diff: "",
    },
  });
  const { web, page } = await launch(journey, viewport, f, (b) => {
    browser = b;
  });
  await signIn(page, web, path(task));
  return { f, page, ...task };
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

const entry = (page: Page, name: RegExp) =>
  page.locator(".changes-entry").filter({ hasText: name });

/** The diff is open on guide.md and the reply control sits below its first hunk, in the same reading area. */
async function assertDiffWithReply(page: Page) {
  const area = page.locator(".changes-reading-area");
  const heading = area.locator(".changes-file-heading h5");
  await heading.waitFor();
  assert.equal((await heading.innerText()).trim(), "guide.md");
  const hunk = page.getByLabel("Diff hunk 1").first();
  await hunk.waitFor();
  const reply = area
    .getByRole("button", { name: "Add review comment" })
    .first();
  await reply.waitFor();
  const hunkBox = await hunk.boundingBox();
  const replyBox = await reply.boundingBox();
  assert.ok(hunkBox && replyBox);
  assert.ok(replyBox.y > hunkBox.y, "the reply control follows the hunk");
  // The brief and retained evidence live in the hidden Overview panel.
  assert.equal(await page.locator("#brief").isVisible(), false);
  assert.equal(await page.locator("#result-evidence").isVisible(), false);
  await noPageOverflow(page);
}

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const) {
  test(`inspect changes budget: two interactions from the task header (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      ({ taskId }) => `/app/tasks/${taskId}`,
    );
    const tab = s.page
      .getByRole("tablist", { name: "Task sections" })
      .getByRole("tab", { name: "Changes" });
    await assertFirstScreen(s.page, [tab]);
    let interactions = 0;
    await tab.click();
    interactions++;
    const guide = entry(s.page, /guide\.md/);
    await guide.waitFor();
    await settle(s.page);
    const heading = s.page.locator(".changes-rail h5");
    assert.equal(
      (await heading.innerText()).replace(/\s+/g, " ").trim(),
      "Changes · 2 +3 −1",
    );
    assert.equal(await s.page.evaluate(() => scrollY), 0, "nothing scrolled");
    for (const target of [heading, guide])
      assert.equal(
        await inFirstViewport(s.page, target),
        true,
        `in the first view ${JSON.stringify(await target.boundingBox())}`,
      );
    await noPageOverflow(s.page);
    await guide.click();
    interactions++;
    await assertDiffWithReply(s.page);
    assert.equal(interactions, 2);
  });

  test(`inspect changes budget: two interactions from the latest result (${label})`, async (_t, journey) => {
    const s = await start(
      journey,
      viewport,
      ({ taskId }) => `/app/tasks/${taskId}`,
    );
    const link = s.page
      .locator("#review")
      .getByRole("link", { name: "Changes · 2 files", exact: true });
    await assertFirstScreen(s.page, [
      s.page.locator("#review").getByRole("heading", { name: "Latest result" }),
      s.page.getByText("Inspect result summary", { exact: true }),
      link,
    ]);
    let interactions = 0;
    // The link names the result it was shown for, so a newer result cannot rebind it.
    assert.match(
      (await link.getAttribute("href")) ?? "",
      /\?section=changes&result=[0-9a-f-]{36}$/,
    );
    await link.click();
    interactions++;
    await s.page.waitForURL(/section=changes&result=[0-9a-f-]{36}$/);
    const tab = s.page
      .getByRole("tablist", { name: "Task sections" })
      .getByRole("tab", { name: "Changes" });
    assert.equal(await tab.getAttribute("aria-selected"), "true");
    const guide = entry(s.page, /guide\.md/);
    await guide.waitFor();
    await guide.click();
    interactions++;
    await assertDiffWithReply(s.page);
    assert.equal(interactions, 2);
  });

  test(`inspect changes budget: one interaction from the Inbox evidence link (${label})`, async (_t, journey) => {
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const { taskId, interactionId } = await seedOwnQuestion(
      f,
      choiceForm,
      "Guide task",
      "Docs",
    );
    const { web, page } = await launch(journey, viewport, f, (b) => {
      browser = b;
    });
    await signIn(
      page,
      web,
      `/app/inbox?task=${taskId}&request=${interactionId}`,
    );
    const link = page.getByRole("link", { name: "Task evidence" });
    await link.waitFor();
    assert.equal(await link.count(), 1);
    let interactions = 0;
    await link.click();
    interactions++;
    await page.waitForURL(new RegExp(`/app/tasks/${taskId}#history$`));
    const history = page
      .getByRole("tablist", { name: "Task sections" })
      .getByRole("tab", { name: "History" });
    await history.waitFor();
    assert.equal(await history.getAttribute("aria-selected"), "true");
    await assertFirstScreen(page, [page.locator("#context h3").first()]);
    assert.equal(interactions, 1);
  });
}
