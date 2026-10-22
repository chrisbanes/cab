import assert from "node:assert/strict";
import { type Browser, chromium, type Page, webkit } from "playwright";
import {
  publicationReasonSentences,
  publicationTargetReasonSentences,
} from "../../src/operator/github-reasons.js";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import { desktop, phone } from "../fixtures/operator-settings.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import {
  FakeGitHub,
  type PublicationFixtureOptions,
  seedPublication,
} from "../fixtures/task-publication.js";

const test = browserSuite("ui-task-publish");

/** The sent commands, by type. */
function recordCommands(page: Page) {
  const sent: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/operator/commands"
    )
      sent.push(JSON.parse(request.postData() ?? "{}"));
  });
  return (type: string) => sent.filter((command) => command.type === type);
}

async function launch(
  j: BrowserJourney,
  viewport: { width: number; height: number },
  options: {
    engine?: "chromium" | "webkit";
    fixture?: PublicationFixtureOptions;
    ready?: boolean;
  } = {},
) {
  const gh = new FakeGitHub();
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      gh.readerFactory(),
      { providerFactory: () => gh.provider() },
      j.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  let seeded: Awaited<ReturnType<typeof seedPublication>> | undefined;
  j.cleanup(
    (primary) => {
      seeded?.release();
      return f.close(browser, primary);
    },
    "fixture.close",
    () => f.lifecycle.steps,
  );
  seeded = await seedPublication(
    () => f.service,
    gh,
    f.directory,
    options.fixture,
  );
  const taskId = seeded.task(
    options.ready ?? true,
    "Ship the toolbar",
    "Make the toolbar usable.",
  );
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () =>
    (options.engine === "webkit" ? webkit : chromium).launch(),
  );
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(8000);
  const commands = recordCommands(page);
  const open = async () => {
    await page.goto(`${web.origin}/app/tasks/${taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .locator(".task-tools")
      .getByRole("button", { name: "Publish to GitHub" })
      .waitFor();
  };
  return { f, gh, page, taskId, commands, open, seeded };
}

const panel = (page: Page) =>
  page.locator("section.task-publish", { hasText: "Publish to GitHub" });
const header = (page: Page) =>
  page
    .locator(".task-tools")
    .getByRole("button", { name: "Publish to GitHub" });
async function openPanel(page: Page) {
  if ((await header(page).getAttribute("aria-expanded")) !== "true")
    await header(page).click();
  await panel(page).waitFor();
}
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const viewports = [
  ["desktop", desktop],
  ["phone", phone],
] as const;

for (const [name, viewport] of viewports) {
  test(`${name}: disabled targets say why, the confirm step names the destination, and the task becomes the issue`, async (_t, j) => {
    const { page, gh, commands, open, taskId, f } = await launch(j, viewport, {
      fixture: {
        selections: ["repo", "project", "search", "filtered"],
        grants: ["create"],
      },
    });
    await open();
    await openPanel(page);
    // Targets that cannot take the task are listed disabled with the server's reason.
    const targets = panel(page).locator(".task-publish-target");
    assert.equal(await targets.count(), 4);
    const project = targets.filter({ hasText: "GitHub Project" }).first();
    assert.equal(await project.locator("input").isDisabled(), true);
    await project
      .getByText(publicationTargetReasonSentences["no-item-grant"])
      .waitFor();
    await targets
      .filter({
        hasText: publicationTargetReasonSentences["selection-unpredictable"],
      })
      .first()
      .waitFor();
    const repository = targets
      .filter({ hasText: "org/repo · Repository" })
      .first();
    assert.equal(await repository.locator("input").isChecked(), true);
    await repository.getByText(/the task stays Ready/).waitFor();
    assert.equal(await noOverflow(page), true);

    await panel(page).getByRole("button", { name: "Review" }).click();
    await panel(page).getByText("Review what will be created.").waitFor();
    // The confirm step names the repository, the text, the labels, the prediction and irreversibility.
    const facts = panel(page).locator(".task-publish-facts");
    await facts.getByText("org/repo", { exact: true }).waitFor();
    await facts.getByText("Ship the toolbar", { exact: true }).waitFor();
    await facts.getByText("Make the toolbar usable.").waitFor();
    await facts.getByText("ready", { exact: true }).waitFor();
    await facts.getByText(/Matches the selection: yes/).waitFor();
    await panel(page)
      .getByText(/public issue in org\/repo\. Ensemble can’t delete it/)
      .waitFor();
    assert.equal(gh.posts, 0, "nothing is created before Publish");
    assert.equal(await noOverflow(page), true);

    await panel(page)
      .getByRole("button", { name: "Publish to org/repo" })
      .click();
    await panel(page)
      .getByText("Published. The task is now the GitHub issue below.")
      .waitFor();
    assert.equal(commands("task.publish.review").length, 1);
    assert.equal(commands("task.publish.confirm").length, 1);
    assert.equal(commands("task.publish.send").length, 1);
    assert.equal(gh.posts, 1);
    // The task now is the issue: its identity and source link show and the task cannot be published again.
    await page
      .getByRole("link", { name: "Open GitHub to edit source" })
      .waitFor();
    assert.equal(await header(page).count(), 0);
    assert.equal(f.service.domain().importedTask(taskId) !== undefined, true);
    await panel(page).getByRole("button", { name: "Done" }).click();
    assert.equal(await panel(page).count(), 0);
  });
}

test("an unknown outcome stays held across a reload, offers Link, and Abandon warns first", async (_t, j) => {
  const ctx = await launch(j, desktop);
  const { page, gh, commands, open, taskId, f } = ctx;
  gh.createMode = "lost-unseen";
  await open();
  await openPanel(page);
  await panel(page).getByRole("button", { name: "Review" }).click();
  await panel(page)
    .getByRole("button", { name: "Publish to org/repo" })
    .click();
  await panel(page)
    .getByText(/didn’t confirm that the issue was created/)
    .waitFor();
  assert.equal(gh.posts, 1);
  // The pending publication survives a reload, with no way to publish again.
  await page.reload();
  await panel(page).getByText("Outcome unknown", { exact: true }).waitFor();
  assert.equal(
    await panel(page)
      .getByRole("button", { name: /^Publish to / })
      .count(),
    0,
  );
  assert.equal(
    await panel(page).getByRole("button", { name: "Review" }).count(),
    0,
  );
  assert.equal(gh.posts, 1);
  // Link refuses an issue that is not this request's.
  const stranger = gh.add("x", "no marker");
  await panel(page).getByLabel("Issue number").fill(String(stranger.number));
  await panel(page).getByRole("button", { name: "Link issue" }).click();
  await panel(page)
    .getByText(/Review again/)
    .waitFor();
  assert.equal(f.service.domain().importedTask(taskId), undefined);
  // Abandon asks first and says a duplicate may exist.
  await panel(page).getByRole("button", { name: "Abandon…" }).click();
  await panel(page)
    .getByText(/a duplicate|second, unrelated task/)
    .first()
    .waitFor();
  assert.equal(commands("task.publish.abandon").length, 0);
  await panel(page)
    .getByRole("button", { name: "Abandon and accept a possible duplicate" })
    .click();
  await panel(page)
    .getByText(/Abandoned\. The task is local again/)
    .waitFor();
  assert.equal(commands("task.publish.abandon").length, 1);
  assert.equal(gh.posts, 1);
  assert.equal(f.service.publicationAvailability(taskId).available, true);
});

test("a publication whose create is still being resolved links to the issue that carries its marker", async (_t, j) => {
  const ctx = await launch(j, desktop);
  const { page, gh, open, taskId, f } = ctx;
  gh.createMode = "lost-unseen";
  await open();
  await openPanel(page);
  await panel(page).getByRole("button", { name: "Review" }).click();
  await panel(page)
    .getByRole("button", { name: "Publish to org/repo" })
    .click();
  await panel(page).getByText("Outcome unknown", { exact: true }).waitFor();
  const publicationId =
    f.service.latestPublication(taskId)?.publication.review.publicationId ?? "";
  const real = gh.add(
    "Ship the toolbar",
    `Make the toolbar usable.\n\n<!-- ensemble-operation:${publicationId} -->`,
  );
  await panel(page).getByLabel("Issue number").fill(String(real.number));
  await panel(page).getByRole("button", { name: "Link issue" }).click();
  await panel(page)
    .getByText("Published. The task is now the GitHub issue below.")
    .waitFor();
  assert.equal(
    String(f.service.domain().importedTask(taskId)?.nodeId),
    real.nodeId,
  );
  assert.equal(gh.posts, 1);
});

test("the panel is operable from the keyboard", async (_t, j) => {
  const { page, open } = await launch(j, desktop, { ready: false });
  await open();
  await header(page).focus();
  await page.keyboard.press("Enter");
  await panel(page).waitFor();
  // Choose a target and review with the keyboard only.
  const first = panel(page).locator('input[name="publish-target"]').first();
  await first.focus();
  await page.keyboard.press("Space");
  assert.equal(await first.isChecked(), true);
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Review",
  );
  await page.keyboard.press("Enter");
  await panel(page).getByText("Review what will be created.").waitFor();
  await panel(page)
    .getByText(/The task stays Draft/)
    .waitFor();
  await panel(page).getByRole("button", { name: "Back" }).focus();
  await page.keyboard.press("Enter");
  await panel(page).getByRole("button", { name: "Review" }).waitFor();
});

test("a task with local dependencies says why it cannot be published", async (_t, j) => {
  const ctx = await launch(j, desktop);
  const { page, f, seeded, taskId, open } = ctx;
  const blocker = seeded.task(true, "Blocker", "First");
  f.service.domain().execute({
    type: "dependency.add",
    actor: "operator",
    key: crypto.randomUUID(),
    projectId: seeded.projectId,
    taskId,
    blockerTaskId: blocker,
    expectedVersion: seeded.version(taskId),
  });
  await open();
  await openPanel(page);
  await panel(page)
    .getByText(publicationReasonSentences["local-dependencies"])
    .waitFor();
  assert.equal(
    await panel(page).getByRole("button", { name: "Review" }).count(),
    0,
  );
});

test(
  "a task is published from a WebKit phone",
  { browserEngine: "webkit" },
  async (_t, j) => {
    const { page, gh, open } = await launch(j, phone, { engine: "webkit" });
    await open();
    await openPanel(page);
    await panel(page).getByRole("button", { name: "Review" }).click();
    await panel(page)
      .getByRole("button", { name: "Publish to org/repo" })
      .click();
    await panel(page)
      .getByText("Published. The task is now the GitHub issue below.")
      .waitFor();
    assert.equal(gh.posts, 1);
    assert.equal(await noOverflow(page), true);
  },
);
