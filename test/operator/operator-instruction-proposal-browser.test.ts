import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Browser, chromium, type Page } from "playwright";
import {
  type BrowserJourney,
  browserSuite,
} from "../fixtures/browser-diagnostics.js";
import {
  answerInstructionDraft,
  draftingTurn,
  seedDraftingProject,
  seedOperatorFeedback,
} from "../fixtures/drafting.js";
import { desktop, phone } from "../fixtures/operator-settings.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { until } from "../fixtures/operator-work.js";

const test = browserSuite("ui-instruction-proposals");

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;

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
  const { projectId, leadId } = await seedDraftingProject(f);
  const seeded = seedOperatorFeedback(f.service, projectId, leadId);
  // Rae also leads another project, so editing Rae reaches both.
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Beta",
    leadProfileId: seeded.agentId,
  });
  const web = await j.start("fixture.web", () => f.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(8000);
  const commands = recordCommands(page);
  const url = `${web.origin}/projects/${projectId}/settings?tab=instruction-proposals`;
  const open = async () => {
    await page.goto(url);
    await page.getByLabel("Password").fill(web.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Request proposal" }).waitFor();
  };
  return { f, page, projectId, seeded, commands, open, url };
}

/** The newest drafting run, once its turn is running. */
async function runningRun(f: Fixture, known: Set<string>) {
  let runId = "";
  await until(
    () => {
      runId =
        f.service
          .list()
          .filter((item) => item.workId.startsWith("drafting:") && item.turnId)
          .map((item) => item.workId.slice("drafting:".length))
          .find((id) => !known.has(id)) ?? "";
      return Boolean(runId && draftingTurn(f.service, runId));
    },
    "a running drafting turn",
    8000,
  );
  known.add(runId);
  return runId;
}

async function answer(f: Fixture, runId: string, instructions: string) {
  const ids = (f.service.readDrafting(runId)?.feedback ?? []).map((i) => i.id);
  await answerInstructionDraft(f, runId, {
    summary: "Ask for keyboard evidence",
    instructions,
    rationale: "Two corrections asked for keyboard evidence.",
    generalisation: "Applies to every UI change, not just the dialog.",
    conflicts: "",
    insufficientEvidence: false,
    evidence: ids.map((feedbackId) => ({
      feedbackId,
      use: "supports",
      note: "Asks for keyboard evidence.",
    })),
  });
}

/** Selects with the keyboard: focus the box, press Space. */
async function select(page: Page, text: RegExp) {
  const box = page.getByRole("checkbox", { name: text });
  await box.focus();
  await page.keyboard.press("Space");
  assert.equal(await box.isChecked(), true);
}

const proposed = "Review interface changes.\nAttach keyboard evidence.";

for (const [name, viewport] of [
  ["desktop", desktop],
  ["phone", phone],
] as const) {
  test(`${name}: select, request, review, edit, reject, redraft and accept an agent's instructions`, async (_t, j) => {
    const { f, page, seeded, commands, open } = await launch(j, viewport);
    const known = new Set<string>();
    await open();
    await select(page, /keyboard navigation evidence/);
    await select(page, /keyboard evidence\./);
    await page.getByText("2 of 20 selected").waitFor();
    await page.getByLabel("Target").selectOption({ label: "Agent Rae" });
    await page.getByText(/shared by every project that uses it/).waitFor();
    await page.getByRole("button", { name: "Request proposal" }).click();
    await page
      .getByText("The lead is drafting from the selected feedback.")
      .waitFor();
    const first = await runningRun(f, known);
    await answer(f, first, proposed);
    // Review: provenance, exact current and proposed text, and who saving reaches.
    await page
      .getByRole("heading", { name: "Ask for keyboard evidence" })
      .waitFor();
    await page.getByText(/Message · Settings dialog · to Mira/).waitFor();
    await page.getByText(/Comment · Settings dialog · to Mira, Rae/).waitFor();
    await page
      .getByText("Review interface changes.", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#instruction-final").inputValue(),
      proposed,
    );
    await page
      .getByText(/used by 2 projects: Atlas \(permitted agent\), Beta \(lead\)/)
      .waitFor();
    await page
      .getByText(/keeps it until you choose Apply current instructions/)
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    // Edit, then Reject: nothing is saved.
    await page.locator("#instruction-final").fill(`${proposed}\nEdited.`);
    await page.getByText("Added: Edited.").waitFor();
    const version = Number(f.service.domain().profile(seeded.agentId).version);
    await page.getByRole("button", { name: "Reject" }).click();
    await page
      .getByText("Rejected the proposal. The instructions are unchanged.")
      .waitFor();
    assert.equal(f.service.readDrafting(first)?.state, "discarded");
    assert.equal(
      Number(f.service.domain().profile(seeded.agentId).version),
      version,
    );
    // Redraft from the same selection, then Accept the edited text.
    await page.getByRole("button", { name: "Redraft" }).click();
    const second = await runningRun(f, known);
    await answer(f, second, proposed);
    await page.locator("#instruction-final").waitFor();
    await page.locator("#instruction-final").fill(`${proposed}\nEdited.`);
    await page.getByRole("button", { name: "Accept and save" }).click();
    await page
      .getByText(`Saved as instructions revision ${version + 1}.`)
      .waitFor();
    const saves = commands("profile.configure");
    assert.equal(saves.length, 1);
    assert.equal(saves[0]?.instructions, `${proposed}\nEdited.`);
    assert.equal(
      String(f.service.domain().profile(seeded.agentId).instructions),
      `${proposed}\nEdited.`,
    );
    await until(
      () => f.service.readDrafting(second)?.state === "accepted",
      "the accepted run",
    );
    assert.equal(commands("instruction.draft.start").length, 2);
  });
}

test("instructions changed in another tab make Accept unavailable and send no configure", async (_t, j) => {
  const { f, page, projectId, commands, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard navigation evidence/);
  await page.getByRole("button", { name: "Request proposal" }).click();
  const runId = await runningRun(f, new Set());
  const domain = f.service.domain();
  await answer(
    f,
    runId,
    `${String(domain.project(projectId).instructions)}\nMore.`,
  );
  await page.locator("#instruction-final").waitFor();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.project(projectId).version),
    instructions: "Changed in another tab.",
  });
  // No reload: the open review reads the run again and shows the change.
  await page
    .getByText(/The instructions changed since this proposal was drafted/)
    // An open review re-reads the run every 10 s.
    .waitFor({ timeout: 15_000 });
  assert.equal(
    await page.getByRole("button", { name: "Accept and save" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Redraft" }).waitFor();
  assert.equal(commands("project.configure").length, 0);
  // Redraft reads the project afresh, so the changed version does not refuse it.
  await page.getByRole("button", { name: "Redraft" }).click();
  const redrafted = await runningRun(f, new Set([runId]));
  assert.notEqual(redrafted, runId);
  await page
    .getByText("The lead is drafting from the selected feedback.")
    .waitFor();
  assert.equal(commands("instruction.draft.start").length, 2);
});

test("a reload while drafting reattaches to the same run", async (_t, j) => {
  const { f, page, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard navigation evidence/);
  await page.getByRole("button", { name: "Request proposal" }).click();
  const runId = await runningRun(f, new Set());
  await page.reload();
  await page
    .getByText("The lead is drafting from the selected feedback.")
    .waitFor();
  await answer(f, runId, "Keep it simple.\nShow keyboard evidence.");
  await page.locator("#instruction-final").waitFor();
  assert.equal(
    await page.locator("#instruction-final").inputValue(),
    "Keep it simple.\nShow keyboard evidence.",
  );
});

test("edited text survives leaving the tab, and the editor is locked while a save is unresolved", async (_t, j) => {
  const { f, page, projectId, commands, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard navigation evidence/);
  await page.getByRole("button", { name: "Request proposal" }).click();
  const runId = await runningRun(f, new Set());
  const domain = f.service.domain();
  const current = String(domain.project(projectId).instructions);
  await answer(f, runId, `${current}\nProposed.`);
  const editor = page.locator("#instruction-final");
  await editor.fill(`${current}\nEdited.`);
  // Another settings tab and back: the edit is kept.
  await page
    .getByRole("navigation", { name: "Project configuration sections" })
    .getByRole("link", { name: "General" })
    .click();
  await page.getByRole("link", { name: "Instruction proposals" }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), `${current}\nEdited.`);
  // The save's response is lost: its outcome is unknown and the frozen body cannot be edited.
  await page.route("**/api/operator/commands", (route) =>
    route.request().postData()?.includes('"project.configure"')
      ? route.abort()
      : route.continue(),
  );
  await page.getByRole("button", { name: "Accept and save" }).click();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  assert.equal(await editor.isDisabled(), true);
  await page.unroute("**/api/operator/commands");
  await check.click();
  await page.getByText(/^Saved as instructions revision \d+\.$/).waitFor();
  // The check resent the same key and body: one save, of the edited text.
  const saves = commands("project.configure");
  assert.ok(saves.length >= 1);
  assert.equal(new Set(saves.map((c) => c.key)).size, 1);
  assert.equal(
    String(domain.project(projectId).instructions),
    `${current}\nEdited.`,
  );
});

test("an archived project's proposal is read-only: no Accept, Reject, Redraft or edit", async (_t, j) => {
  const { f, page, projectId, commands, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard navigation evidence/);
  await page.getByRole("button", { name: "Request proposal" }).click();
  const runId = await runningRun(f, new Set());
  const domain = f.service.domain();
  await answer(
    f,
    runId,
    `${String(domain.project(projectId).instructions)}\nProposed.`,
  );
  await page.locator("#instruction-final").waitFor();
  // As in operator-unstack.test.ts: archive directly, since the seeded task still has assignments to drain.
  (f.service as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare(
      "UPDATE domain_projects SET archived=1,version=version+1 WHERE id=?",
    )
    .run(projectId);
  await page.reload();
  await page
    .getByText("This project is archived, so its proposals are read-only.")
    .waitFor();
  assert.equal(await page.locator("#instruction-final").isDisabled(), true);
  for (const name of ["Accept and save", "Reject", "Redraft"])
    assert.equal(
      await page.getByRole("button", { name, exact: true }).isDisabled(),
      true,
      name,
    );
  assert.equal(commands("profile.configure").length, 0);
  assert.equal(commands("project.configure").length, 0);
});

test("a selection that becomes withheld or a target that is no longer permitted never blocks a request", async (_t, j) => {
  const { f, page, projectId, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard navigation evidence/);
  await page.getByLabel("Target").selectOption({ label: "Agent Rae" });
  const domain = f.service.domain();
  // Another project's instructions now appear in the selected message, so it is withheld.
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Gamma",
    leadProfileId: null,
    instructions: "keyboard navigation evidence",
  });
  // And Rae is no longer a permitted agent of this project.
  domain.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: Number(domain.routing(projectId).version),
    enabled: false,
    candidateProfileIds: [],
  });
  await page.reload();
  await page
    .getByText(
      "Selected feedback that is now withheld was removed from the selection.",
    )
    .waitFor();
  await page.getByText("0 of 20 selected").waitFor();
  await page
    .getByText(/no longer this project.s lead or a permitted agent/)
    .waitFor();
  // The remaining items still work once a valid target is chosen.
  await select(page, /keyboard evidence\./);
  const request = page.getByRole("button", { name: "Request proposal" });
  assert.equal(await request.isDisabled(), true);
  await page
    .getByLabel("Target")
    .selectOption({ label: "Project instructions" });
  assert.equal(await request.isDisabled(), false);
});

test("a proposal withheld on read can be rejected", async (_t, j) => {
  const { f, page, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard evidence\./);
  await page.getByRole("button", { name: "Request proposal" }).click();
  const runId = await runningRun(f, new Set());
  await answer(f, runId, "Keep it simple.\nWithheld line for review.");
  await page.locator("#instruction-final").waitFor();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId: randomUUID(),
    name: "Delta",
    leadProfileId: null,
    instructions: "Withheld line for review.",
  });
  await page.reload();
  await page
    .getByText(/This proposal holds text that cannot be shown/)
    .waitFor();
  await page.getByRole("button", { name: "Reject" }).click();
  await page
    .getByText("Rejected the proposal. The instructions are unchanged.")
    .waitFor();
  await until(
    () => f.service.readDrafting(runId)?.state === "discarded",
    "the discarded run",
  );
});

test("an unconfirmed start offers New selection, and a missing run in a read-only view is cleared, not polled", async (_t, j) => {
  const { f, page, projectId, open } = await launch(j, desktop);
  await open();
  await select(page, /keyboard evidence\./);
  // The start's response is lost, so its outcome is unknown and the run never exists.
  await page.route("**/api/operator/commands", (route) =>
    route.request().postData()?.includes('"instruction.draft.start"')
      ? route.abort()
      : route.continue(),
  );
  await page.getByRole("button", { name: "Request proposal" }).click();
  await page.getByText(/Couldn.t confirm the request/).waitFor();
  await page.getByRole("button", { name: "New selection" }).waitFor();
  // Archived before the page reads it again: it clears the run instead of resending.
  (f.service as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare(
      "UPDATE domain_projects SET archived=1,version=version+1 WHERE id=?",
    )
    .run(projectId);
  await page.reload();
  await page.getByText("The proposal is no longer available.").waitFor();
  await page.getByRole("button", { name: "Request proposal" }).waitFor();
  const starts: string[] = [];
  page.on("request", (request) => {
    if (request.postData()?.includes('"instruction.draft.start"'))
      starts.push(request.url());
  });
  await page.waitForTimeout(3000);
  assert.deepEqual(starts, []);
});
