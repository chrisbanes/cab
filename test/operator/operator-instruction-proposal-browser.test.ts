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
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Accept and save" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Redraft" }).waitFor();
  assert.equal(commands("project.configure").length, 0);
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
