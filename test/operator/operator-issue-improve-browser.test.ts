import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Page, webkit } from "playwright";
import type { ExternalAction } from "../../src/core/delivery.js";
import { issueEditReasonSentences } from "../../src/operator/github-reasons.js";
import { IssueChangedRefusal } from "../../src/standalone/github-delivery.js";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import {
  answerIssueDraft,
  draftingTurn,
  seedDraftingProject,
} from "../fixtures/drafting.js";
import { desktop, phone } from "../fixtures/operator-settings.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/operator-work.js";

const test = browserSuite("ui-issue-improve");

const original = {
  title: "command menu a11y",
  body: "Make the command menu work with a keyboard.",
};
const proposal = {
  title: "Make the command menu usable with a keyboard and screen reader",
  body: "The menu cannot be operated without a mouse.\n\nAcceptance criteria\n- Focus moves to the search field on open.",
};
const credentialName = "FIXTURE_ISSUE_IMPROVE_DELIVERY";
const sourceName = "FIXTURE_ISSUE_IMPROVE_SOURCE";

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
    grant?: boolean;
    engine?: "chromium" | "webkit";
    outcome?: "confirmed-success" | "uncertain";
  } = {},
) {
  process.env[sourceName] = "offline-issue-improve-source-value";
  let current = { ...original };
  const effects: ExternalAction[] = [];
  const hooks = { changed: false };
  const issue = () => ({
    providerInstance: "github.com" as const,
    nodeId: "I_1",
    repositoryId: "R_1",
    repositoryName: "acme/atlas",
    number: 1,
    ...current,
    state: "open" as const,
    labels: ["ready"],
    projectFields: [],
  });
  const f = await j.start("fixture.create", () =>
    createOperatorFixture(
      null,
      () => ({
        async readSelection() {
          return { complete: true as const, issues: [issue()], reason: null };
        },
        async readBlockers() {
          return { complete: true, blockers: [], reason: null };
        },
        async readIssueStatus() {
          return { status: "open" };
        },
      }),
      {
        providerFactory: () => ({
          async preflight() {
            if (hooks.changed) throw new IssueChangedRefusal();
            return { nodeId: "I_1" };
          },
          async performAction(record) {
            effects.push(record.request.action);
            if (options.outcome === "uncertain")
              return {
                state: "uncertain",
                reason: "response-lost",
                receipt: null,
              };
            if (record.request.action.kind === "issue.edit")
              current = {
                title: record.request.action.fields.title ?? current.title,
                body: record.request.action.fields.body ?? current.body,
              };
            return {
              state: "confirmed-success",
              reason: null,
              receipt: { nodeId: "C1" },
            };
          },
          async inspectAction() {
            return { state: "uncertain", reason: "unproved", receipt: null };
          },
          async inspectPr() {
            throw Error("No PR in fixture");
          },
        }),
      },
      j.fixtureOptions,
    ),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => {
      delete process.env[sourceName];
      delete process.env[credentialName];
      return f.close(browser, primary);
    },
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const { projectId } = await seedDraftingProject(f);
  const d = f.service.domain();
  const configured = d.githubConfiguration(projectId);
  await d.configureGitHub({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(configured.version),
    credentialRef: `env:${sourceName}`,
    selections: configured.selections as never,
    repositories: configured.repositories.map((r) => ({
      repositoryId: r.repositoryId,
      path: r.path,
      ref: r.ref,
    })),
    readiness: configured.readiness as never,
  });
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId,
    selectionId: "repo",
    expectedVersion: Number(d.githubConfiguration(projectId).version),
  });
  await f.service.refreshGitHub();
  const taskId = String(f.service.githubSources().issue("I_1")?.taskId);
  d.ensureLeadAssignment(taskId);
  // A unique non-empty credential, set after the runtime started so no snapshot holds it.
  process.env[credentialName] = `fixture-${randomUUID()}`;
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: `env:${credentialName}`,
    grants:
      options.grant === false
        ? []
        : [{ action: "issue.edit", repositoryId: "R_1", mode: "allow" }],
    requiredChecks: [],
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  const engine = options.engine === "webkit" ? webkit : chromium;
  browser = await j.start("browser.launch", () => engine.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(8000);
  const commands = recordCommands(page);
  const open = async () => {
    await page.goto(`${web.origin}/app/tasks/${taskId}`);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Improve with lead" }).waitFor();
  };
  return {
    f,
    page,
    taskId,
    commands,
    open,
    effects,
    hooks,
    set: (v: typeof original) => (current = { ...v }),
    web,
  };
}

const panel = (page: Page) =>
  page.locator("section.issue-improve", { hasText: "Improve with lead" });
const header = (page: Page) =>
  page
    .locator(".task-tools")
    .getByRole("button", { name: "Improve with lead" });
const startButton = (page: Page) =>
  panel(page).getByRole("button", { name: "Improve with lead", exact: true });

async function openPanel(page: Page) {
  await header(page).click();
  await panel(page).waitFor();
}

/** The drafting run the service holds, once it is running. */
async function runningRun(f: Awaited<ReturnType<typeof launch>>["f"], nth = 0) {
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

/** Starts a draft and answers it, leaving the proposal in the editor. */
async function draftAndLoad(
  ctx: Awaited<ReturnType<typeof launch>>,
  nth = 0,
  text = proposal,
) {
  await openPanelIfClosed(ctx.page);
  await startButton(ctx.page).click();
  await panel(ctx.page).getByText("Drafting", { exact: true }).waitFor();
  const runId = await runningRun(ctx.f, nth);
  await answerIssueDraft(ctx.f, runId, text);
  await ctx.page.locator("#issue-improve-title").waitFor();
  return runId;
}
async function openPanelIfClosed(page: Page) {
  if ((await header(page).getAttribute("aria-expanded")) !== "true")
    await openPanel(page);
}

const viewports = [
  ["desktop", desktop],
  ["phone", phone],
] as const;

for (const [name, viewport] of viewports) {
  test(`${name}: a draft is edited, reviewed against the current text and sent as one edit`, async (_t, j) => {
    const ctx = await launch(j, viewport);
    const { page, f, commands, effects, open } = ctx;
    await open();
    await openPanel(page);
    await panel(page)
      .getByLabel(/^Note for/)
      .fill("Mention the toolbar");
    await draftAndLoad(ctx);
    assert.equal(
      await page.locator("#issue-improve-title").inputValue(),
      proposal.title,
    );
    assert.equal(
      await page.locator("#issue-improve-body").inputValue(),
      proposal.body,
    );
    // The operator edits before reviewing.
    await page.locator("#issue-improve-title").fill("An edited title");
    await panel(page).getByRole("button", { name: "Review changes" }).click();
    await panel(page).getByText("Review the full replacement.").waitFor();
    // Current and proposed text are both shown, and the edit says it cannot be undone.
    await panel(page).getByText(original.title).first().waitFor();
    await panel(page).getByText("An edited title").first().waitFor();
    await panel(page)
      .getByText(/cannot undo it/)
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.equal(effects.length, 0, "nothing is sent before Send");
    await panel(page)
      .getByRole("button", { name: "Send edit to GitHub" })
      .click();
    await panel(page)
      .getByText(/^Sent\./)
      .waitFor();
    assert.equal(commands("issue.draft.start").length, 1);
    assert.equal(commands("issue.edit.review").length, 1);
    assert.equal(commands("issue.edit.confirm").length, 1);
    assert.equal(commands("issue.edit.send").length, 1);
    assert.equal(commands("task.create").length, 0);
    assert.equal(commands("comment.send").length, 0);
    assert.equal(commands("comment.review").length, 0);
    assert.equal(effects.length, 1);
    const effect = effects[0];
    assert.equal(effect?.kind, "issue.edit");
    if (effect?.kind === "issue.edit") {
      assert.deepEqual(effect.fields, {
        title: "An edited title",
        body: proposal.body,
      });
      assert.deepEqual(effect.expected, original);
    }
    // Ensemble keeps no copy: the next sync shows the edit like a hand edit.
    await f.service.refreshGitHub();
    assert.equal(
      f.service.githubSources().issue("I_1")?.observedTitle,
      "An edited title",
    );
  });
}

test("without an issue edit grant the panel says why and starts nothing", async (_t, j) => {
  const { page, commands, open } = await launch(j, desktop, { grant: false });
  await open();
  await openPanel(page);
  await panel(page)
    .getByText(issueEditReasonSentences["no-edit-grant"])
    .waitFor();
  assert.equal(await startButton(page).isDisabled(), true);
  assert.equal(commands("issue.draft.start").length, 0);
});

test("an issue that changed on GitHub is refused as stale, nothing is written, and Redraft starts again", async (_t, j) => {
  const ctx = await launch(j, desktop);
  const { page, effects, hooks, commands, open } = ctx;
  await open();
  await draftAndLoad(ctx);
  // GitHub changed after the draft started; the synced copy has not caught up yet.
  const changed = { title: "Retitled on GitHub", body: "Rewritten on GitHub" };
  ctx.set(changed);
  hooks.changed = true;
  await panel(page).getByRole("button", { name: "Review changes" }).click();
  await panel(page).getByText("Review the full replacement.").waitFor();
  await panel(page)
    .getByRole("button", { name: "Send edit to GitHub" })
    .click();
  await panel(page)
    .getByText(/changed on GitHub after this draft started/)
    .waitFor();
  assert.equal(effects.length, 0);
  // GitHub still shows the change: the redraft starts from it, not from the older copy.
  await panel(page).getByRole("button", { name: "Redraft" }).click();
  await panel(page).getByText("Drafting", { exact: true }).waitFor();
  assert.equal(commands("issue.draft.start").length, 2);
  const redraft = await runningRun(ctx.f, 1);
  const run = ctx.f.service.readDrafting(redraft);
  assert.equal(run?.observedTitle, changed.title);
  assert.equal(run?.observedBody, changed.body);
});

test("an unknown outcome stays held across a reload and offers no way to send again", async (_t, j) => {
  const ctx = await launch(j, desktop, { outcome: "uncertain" });
  const { page, effects, commands, open } = ctx;
  await open();
  await draftAndLoad(ctx);
  await panel(page).getByRole("button", { name: "Review changes" }).click();
  await panel(page)
    .getByRole("button", { name: "Send edit to GitHub" })
    .click();
  await panel(page)
    .getByText(/Held: we couldn.t confirm/)
    .waitFor();
  assert.equal(effects.length, 1);
  await page.reload();
  await panel(page)
    .getByText(/Held: we couldn.t confirm/)
    .waitFor();
  assert.equal(
    await panel(page)
      .getByRole("button", { name: "Send edit to GitHub" })
      .count(),
    0,
  );
  assert.equal(effects.length, 1);
  assert.equal(commands("issue.edit.send").length, 1);
});

test(
  "an edit on a WebKit phone is reviewed and sent",
  { browserEngine: "webkit" },
  async (_t, j) => {
    const ctx = await launch(j, phone, { engine: "webkit" });
    const { page, effects, open } = ctx;
    await open();
    await draftAndLoad(ctx);
    await panel(page).getByRole("button", { name: "Review changes" }).click();
    await panel(page)
      .getByRole("button", { name: "Send edit to GitHub" })
      .click();
    await panel(page)
      .getByText(/^Sent\./)
      .waitFor();
    assert.equal(effects.length, 1);
  },
);

test("a Redraft refused as out of date keeps the operator's text and works once retried", async (_t, j) => {
  const ctx = await launch(j, desktop);
  const { page, commands, open } = ctx;
  await open();
  await draftAndLoad(ctx);
  await page.locator("#issue-improve-title").fill("My own edit");
  const commandsUrl = "**/api/operator/commands";
  await page.route(commandsUrl, (route) => {
    if ((route.request().postData() ?? "").includes('"issue.draft.start"'))
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "conflict", message: "stale" } }),
      });
    return route.continue();
  });
  await panel(page).getByRole("button", { name: "Redraft" }).click();
  await panel(page).getByText("The task changed. Try again.").waitFor();
  assert.equal(
    await page.locator("#issue-improve-title").inputValue(),
    "My own edit",
  );
  // The kept text is still the draft being edited: it can be reviewed.
  await panel(page).getByRole("button", { name: "Review changes" }).click();
  await panel(page).getByText("Review the full replacement.").waitFor();
  await panel(page).getByRole("button", { name: "Back to editing" }).click();
  await page.unroute(commandsUrl);
  await panel(page).getByRole("button", { name: "Redraft" }).click();
  await panel(page).getByText("Drafting", { exact: true }).waitFor();
  assert.equal(commands("issue.draft.start").length, 3);
});

test("a review refused because the task moved reads the task again so Redraft starts from the current version", async (_t, j) => {
  const ctx = await launch(j, desktop);
  const { page, f, commands, open, set } = ctx;
  await open();
  await draftAndLoad(ctx);
  // GitHub changed and a sync moved the task before the operator reviews.
  set({ title: "Moved on GitHub", body: "Moved body" });
  await f.service.refreshGitHub();
  const reads = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname.startsWith("/api/operator/tasks/") &&
      r.status() === 200,
  );
  await panel(page).getByRole("button", { name: "Review changes" }).click();
  await panel(page)
    .getByText(/changed on GitHub after this draft started/)
    .waitFor();
  await reads;
  await panel(page).getByRole("button", { name: "Redraft" }).click();
  await panel(page).getByText("Drafting", { exact: true }).waitFor();
  assert.equal(commands("issue.draft.start").length, 2);
  const run = f.service.readDrafting(await runningRun(f, 1));
  assert.equal(run?.observedTitle, "Moved on GitHub");
});
