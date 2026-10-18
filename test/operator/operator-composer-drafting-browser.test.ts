import assert from "node:assert/strict";
import { type Browser, chromium, type Page, webkit } from "playwright";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import {
  answerDraft,
  draftingTurn,
  seedDraftingProject,
} from "../fixtures/drafting.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/operator-work.js";
import { desktop, phone } from "../fixtures/operator-settings.js";

const test = browserSuite("ui-composer-drafting");

const proposal = {
  title: "Publish a keyboard guide",
  outcome: "Publish the guide.\nDone: reviewed and checked examples.",
};
const idea = "Document the keyboard shortcuts for the command menu";

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

/** The sent commands, by type; a drafting run must never send a task creation. */
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
  options: { lead?: boolean; engine?: "chromium" | "webkit" } = {},
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
  const { projectId } = await seedDraftingProject(f, {
    lead: options.lead !== false,
    name: options.lead === false ? "Orphan" : "Atlas",
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  const engine = options.engine === "webkit" ? webkit : chromium;
  browser = await j.start("browser.launch", () => engine.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(8000);
  const commands = recordCommands(page);
  const open = async () => {
    await page.goto(`${web.origin}/app/tasks/new?project=${projectId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("main.page h1").waitFor();
  };
  return { f, page, projectId, commands, open, web };
}

const panel = (page: Page) => page.locator("section.composer-draft");
/** The panel is closed while idle so the fields stay in the first view. */
async function openPanel(page: Page) {
  const toggle = page.getByRole("button", { name: /^Draft with lead/ }).first();
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
const draftButton = (page: Page) =>
  panel(page).getByRole("button", { name: "Draft with lead", exact: true });

/** The one drafting run the service holds, once it is running. */
async function runningRun(f: Fixture, nth = 0) {
  let runId = "";
  await until(() => {
    const ids = f.service
      .list()
      .filter((item) => item.workId.startsWith("drafting:") && item.turnId)
      .map((item) => item.workId.slice("drafting:".length));
    runId = ids[nth] ?? "";
    return Boolean(runId && draftingTurn(f.service, runId));
  }, 8000);
  return runId;
}

const viewports = [
  ["desktop", desktop],
  ["phone", phone],
] as const;

for (const [name, viewport] of viewports) {
  test(`${name}: a draft fills an empty composer and creates no task`, async (_t, j) => {
    const { f, page, projectId, commands, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    await panel(page).getByText("Drafting", { exact: true }).waitFor();
    const runId = await runningRun(f);
    await answerDraft(f, runId, proposal);
    await page.waitForFunction(
      (title) =>
        (document.getElementById("composer-title") as HTMLInputElement | null)
          ?.value === title,
      proposal.title,
    );
    assert.equal(
      await page.getByLabel("Desired outcome").inputValue(),
      proposal.outcome,
    );
    await until(() => f.service.readDrafting(runId)?.state === "accepted");
    assert.equal(commands("task.create").length, 0);
    assert.equal(f.service.domain().tasks(projectId).length, 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );

    // Save draft after the fill sends exactly one creation, not ready.
    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByText("Draft saved.").waitFor();
    const created = commands("task.create");
    assert.equal(created.length, 1);
    assert.equal(created[0]?.ready, false);
    assert.equal(created[0]?.title, proposal.title);
    assert.equal(f.service.domain().tasks(projectId).length, 1);
  });

  test(`${name}: text the operator typed keeps its place until Replace or Keep`, async (_t, j) => {
    const { f, page, commands, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await page.getByLabel("Task title").fill("My own title");
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const first = await runningRun(f);
    await answerDraft(f, first, proposal);
    const choice = page.getByRole("group", { name: "Proposed title" });
    await choice.getByText(proposal.title).waitFor();
    // The empty outcome was filled; the typed title is untouched until a choice.
    await page.waitForFunction(
      (outcome) =>
        (
          document.getElementById(
            "composer-outcome",
          ) as HTMLTextAreaElement | null
        )?.value === outcome,
      proposal.outcome,
    );
    assert.equal(
      await page.getByLabel("Task title").inputValue(),
      "My own title",
    );
    assert.equal(f.service.readDrafting(first)?.state, "proposed");
    await choice.getByRole("button", { name: "Keep mine" }).click();
    await until(() => f.service.readDrafting(first)?.state === "accepted");
    assert.equal(
      await page.getByLabel("Task title").inputValue(),
      "My own title",
    );

    // A second draft meets text in both fields: Replace swaps one, Keep retains the other.
    const second = {
      title: "A different title",
      outcome: "A different outcome.",
    };
    await draftButton(page).click();
    const next = await runningRun(f, 1);
    await answerDraft(f, next, second);
    await page
      .getByRole("group", { name: "Proposed title" })
      .getByRole("button", { name: "Replace title" })
      .click();
    await page
      .getByRole("group", { name: "Proposed outcome" })
      .getByRole("button", { name: "Keep mine" })
      .click();
    assert.equal(
      await page.getByLabel("Task title").inputValue(),
      second.title,
    );
    assert.equal(
      await page.getByLabel("Desired outcome").inputValue(),
      proposal.outcome,
    );
    await until(() => f.service.readDrafting(next)?.state === "accepted");
    assert.equal(commands("task.create").length, 0);
  });

  test(`${name}: reloading mid-run reattaches by the stored run id and then fills`, async (_t, j) => {
    const { f, page, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    await page.reload();
    await page.getByRole("button", { name: "Resume unfinished input" }).click();
    await panel(page).getByText("Drafting", { exact: true }).waitFor();
    assert.equal(await panel(page).getByLabel("Rough idea").inputValue(), idea);
    await answerDraft(f, runId, proposal);
    await page.waitForFunction(
      (title) =>
        (document.getElementById("composer-title") as HTMLInputElement | null)
          ?.value === title,
      proposal.title,
    );
    await until(() => f.service.readDrafting(runId)?.state === "accepted");
  });

  test(`${name}: Stop ends the draft as interrupted with the operator's text intact, and Retry starts a new run`, async (_t, j) => {
    const { f, page, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await page.getByLabel("Task title").fill("Typed title");
    await page.getByLabel("Desired outcome").fill("Typed outcome");
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    await panel(page)
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await panel(page).getByText("Stopping", { exact: true }).waitFor();
    // The runtime is seen to end only now.
    assert.equal(f.service.readDrafting(runId)?.state, "stopping");
    f.runtime.fail(Number(draftingTurn(f.service, runId)?.turnId.slice(-1)));
    await panel(page).getByText("Draft interrupted", { exact: true }).waitFor();
    await panel(page)
      .getByText("You stopped the draft", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Task title").inputValue(),
      "Typed title",
    );
    assert.equal(
      await page.getByLabel("Desired outcome").inputValue(),
      "Typed outcome",
    );
    assert.equal(await panel(page).getByLabel("Rough idea").inputValue(), idea);

    await panel(page).getByRole("button", { name: "Retry" }).click();
    const retried = await runningRun(f, 1);
    assert.notEqual(retried, runId);
    await panel(page).getByText("Drafting", { exact: true }).waitFor();
    await answerDraft(f, retried, proposal);
    await page.getByRole("group", { name: "Proposed title" }).waitFor();
  });

  test(`${name}: changing the project stops the old project's draft and drops its proposal`, async (_t, j) => {
    const { f, page, commands, open } = await launch(j, viewport);
    const other = await seedDraftingProject(f, { name: "Relay" });
    await open();
    await openPanel(page);
    await page.getByLabel("Task title").fill("Typed title");
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    await page
      .getByLabel("Project", { exact: true })
      .selectOption(other.projectId);
    await page
      .getByText(/the draft for the previous project was ended/)
      .waitFor();
    await until(() => commands("drafting.stop").length === 1);
    assert.equal(f.service.readDrafting(runId)?.state, "stopping");
    // The old run ends, and nothing of it reaches the new project's composer.
    f.runtime.fail(Number(draftingTurn(f.service, runId)?.turnId.slice(-1)));
    await until(() => f.service.readDrafting(runId)?.state === "interrupted");
    await page.waitForTimeout(2500);
    assert.equal(
      await page.getByLabel("Task title").inputValue(),
      "Typed title",
    );
    assert.equal(await page.getByLabel("Desired outcome").inputValue(), "");
    assert.equal(
      await page.getByRole("group", { name: /^Proposed/ }).count(),
      0,
    );
    assert.equal(commands("drafting.settle").length >= 1, true);
  });

  test(`${name}: discarding recovered input releases the draft it was waiting on`, async (_t, j) => {
    const { f, page, commands, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    await page.reload();
    await page
      .getByRole("button", { name: "Discard unfinished input" })
      .click();
    await until(() => commands("drafting.stop").length === 1);
    assert.equal(f.service.readDrafting(runId)?.state, "stopping");
    f.runtime.fail(Number(draftingTurn(f.service, runId)?.turnId.slice(-1)));
    await until(() => f.service.readDrafting(runId)?.state === "interrupted");
  });

  test(`${name}: a draft in progress stays visible and stoppable after the lead is removed`, async (_t, j) => {
    const { f, page, projectId, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    const domain = f.service.domain();
    domain.execute({
      type: "project.configure",
      actor: "operator",
      key: crypto.randomUUID(),
      projectId,
      expectedVersion: Number(domain.project(projectId).version),
      leadProfileId: null,
    });
    await page.reload();
    await page.getByRole("button", { name: "Resume unfinished input" }).click();
    // No lead means no new draft, but the run in progress shows its own state.
    await panel(page).getByText("Drafting", { exact: true }).waitFor();
    const stop = panel(page).getByRole("button", { name: "Stop", exact: true });
    await stop.waitFor();
    await stop.click();
    await until(() => f.service.readDrafting(runId)?.state === "stopping");
    f.runtime.fail(Number(draftingTurn(f.service, runId)?.turnId.slice(-1)));
    await panel(page).getByText("Draft interrupted", { exact: true }).waitFor();
    // With the lead gone, Retry cannot start another.
    assert.equal(
      await panel(page).getByRole("button", { name: "Retry" }).isDisabled(),
      true,
    );
  });

  test(`${name}: a proposal the service withholds is never filled or accepted`, async (_t, j) => {
    const { f, page, open } = await launch(j, viewport);
    await open();
    await openPanel(page);
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    await answerDraft(f, runId, {
      title: "Withheld draft",
      // The lead's private instructions are redacted on every read.
      outcome: "Follow: Prefer small, reviewable tasks.",
    });
    await panel(page)
      .getByText(/holds text that cannot be shown/)
      .waitFor();
    assert.equal(await page.getByLabel("Task title").inputValue(), "");
    assert.equal(await page.getByLabel("Desired outcome").inputValue(), "");
    assert.equal(f.service.readDrafting(runId)?.state, "proposed");
    await panel(page).getByRole("button", { name: "Discard draft" }).click();
    await until(() => f.service.readDrafting(runId)?.state === "discarded");
  });

  test(`${name}: a project without a lead shows why and never starts a run`, async (_t, j) => {
    const { f, page, commands, open } = await launch(j, viewport, {
      lead: false,
    });
    await open();
    await openPanel(page);
    await panel(page)
      .getByText(/has no project lead, so nobody can draft/)
      .waitFor();
    assert.equal(await draftButton(page).isDisabled(), true);
    assert.equal(commands("drafting.start").length, 0);
    assert.deepEqual(
      f.service.list().filter((item) => item.workId.startsWith("drafting:")),
      [],
    );
  });
}

test(
  "a draft on a WebKit phone fills the composer",
  { browserEngine: "webkit" },
  async (_t, j) => {
    const { f, page, open } = await launch(j, phone, { engine: "webkit" });
    await open();
    await openPanel(page);
    await panel(page).getByLabel("Rough idea").fill(idea);
    await draftButton(page).click();
    const runId = await runningRun(f);
    await answerDraft(f, runId, proposal);
    await page.waitForFunction(
      (title) =>
        (document.getElementById("composer-title") as HTMLInputElement | null)
          ?.value === title,
      proposal.title,
    );
  },
);
