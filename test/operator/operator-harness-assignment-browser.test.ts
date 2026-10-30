import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  signIn,
} from "../fixtures/operator-settings.js";
import { openOverviewCard } from "../fixtures/task-tabs.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

const test = browserSuite("operator-harness-assignment-browser");

/** A Codex lead running and a Claude worker waiting: production (Codex-only) state. */
async function seed(f: Awaited<ReturnType<typeof createOperatorFixture>>) {
  const d = f.service.domain(),
    lead = randomUUID(),
    claude = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    workerId = randomUUID();
  const run = (command: Record<string, unknown>) =>
    d.execute({ actor: "operator", key: randomUUID(), ...command } as never);
  run({
    type: "profile.create",
    profileId: lead,
    name: "Lead",
    instructions: "PRIVATE LEAD",
    capabilities: "lead",
  });
  run({
    type: "profile.create",
    profileId: claude,
    name: "Claude worker",
    instructions: "PRIVATE WORKER",
    capabilities: "code",
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: "high" },
  });
  run({
    type: "project.create",
    projectId,
    name: "Atlas",
    leadProfileId: lead,
  });
  run({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    paused: false,
  });
  run({
    type: "routing.configure",
    projectId,
    expectedVersion: 1,
    enabled: false,
    guidance: "",
    candidateProfileIds: [claude, lead],
  });
  run({
    type: "task.create",
    projectId,
    taskId,
    title: "Mixed harness task",
    outcome: "Work",
    ready: false,
  });
  await f.service.provisionTask(taskId);
  d.execute({
    type: "assignment.create",
    actor: "agent",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId: randomUUID(),
    profileId: lead,
    brief: "Codex work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  d.execute({
    type: "assignment.create",
    actor: "agent",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId: workerId,
    profileId: claude,
    brief: "Claude work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  run({
    type: "task.configure",
    projectId,
    taskId,
    expectedVersion: 1,
    ready: true,
  });
  const deadline = Date.now() + 5000;
  while (
    f.runtime.turns < 1 ||
    !f.service
      .list()
      .some((w) => w.reason === "Claude runtime is not configured")
  ) {
    if (Date.now() > deadline) throw Error("Claude work did not wait");
    await new Promise((r) => setTimeout(r, 20));
  }
  return { taskId, workerId, claude };
}

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`task and recovery views show each assignment's harness and the unconfigured wait at ${name}`, async (_t, journey) => {
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const ids = await seed(f);
    const web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({ viewport });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    await signIn(page, web, `/app/tasks/${ids.taskId}`);

    await openOverviewCard(page, "assignments");
    const worker = page.locator(".assignment-row", { hasText: "Claude work" });
    await worker
      .getByText("Claude · sonnet · high · Claude runtime is not configured", {
        exact: false,
      })
      .waitFor();
    await worker
      .getByText("The Claude runtime is not enabled on this service.", {
        exact: false,
      })
      .waitFor();
    assert.equal(
      await worker
        .getByRole("link", { name: "Edit profile" })
        .getAttribute("href"),
      `/app/profiles/${ids.claude}/settings`,
    );
    assert.equal(
      await worker
        .getByRole("link", { name: "Runtime status" })
        .getAttribute("href"),
      "/app/settings/runtime",
    );
    await page
      .locator(".assignment-row", { hasText: "Codex work" })
      .getByText("· Codex ·", { exact: false })
      .first()
      .waitFor();
    for (const box of await worker
      .getByRole("link")
      .evaluateAll((links) =>
        links.map((l) => l.getBoundingClientRect().height),
      ))
      assert.ok(box >= 44 || viewport === desktop, `link height ${box}`);

    const details = worker.locator("details.assignment-facts");
    await details.locator("> summary").click();
    await details
      .getByText(/^Execution: Claude · sonnet · high · work /)
      .waitFor();
    await details.getByText("Effective execution policy · Claude").click();
    await details
      .getByText(
        "Effective policy appears once the Claude runtime is available.",
      )
      .waitFor();
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-task-harness`);
    assert.equal((await page.content()).includes("PRIVATE"), false);

    // A held Claude failure is explained on the recovery page.
    f.seedPersistedState((db) => {
      const workId = f.service
        .list()
        .find((w) => w.reason === "Claude runtime is not configured")?.workId;
      // A failed Claude turn holds the execution intent, not the assignment.
      db.prepare(
        "UPDATE execution_intents SET state='held', reason='Bound turn failed or was interrupted' WHERE workId=?",
      ).run(String(workId));
      db.prepare(
        "INSERT INTO runtime_terminal_evidence (threadId,turnId,firstStatus,workId,firstRuntimeGeneration,lastRuntimeGeneration,firstObservedAt,lastObservedAt,failureEvidence,harness) VALUES ('t','u','failed',?,'g','g',1,1,?,'claude')",
      ).run(
        String(workId),
        JSON.stringify({
          classification: "permanent",
          reasonCode: "error_max_turns",
          source: "harness",
          harnessRetries: null,
        }),
      );
    });
    await page.goto(`${web.origin}/app/assignments/${ids.workerId}/recovery`);
    await page
      .getByText("Execution runtime: Claude · sonnet · high.")
      .waitFor();
    await page
      .getByText(
        "Turn failed (permanent · error_max_turns). Held without automatic retry.",
      )
      .waitFor();
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-recovery-harness`);
  });

test("Codex assignment facts state the command network access each turn was admitted with", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const ids = await seed(f);
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: desktop });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  const disclosure =
    "Network-enabled commands can reach whatever credentials and logins the host exposes.";
  const line = (text: string) =>
    page.locator("#assignments").getByText(text, { exact: true }).first();
  // The assignment facts stay collapsed, so the lines are attached rather than visible.
  const attached = { state: "attached" } as const;

  await signIn(page, web, `/app/tasks/${ids.taskId}`);
  await openOverviewCard(page, "assignments");
  await line("Admitted with command network access disabled.").waitFor(
    attached,
  );
  await line(disclosure).waitFor(attached);
  assert.equal(
    await page
      .locator("#assignments")
      .getByText("Admitted with command network access enabled.")
      .count(),
    0,
  );

  // A turn recorded as admitted with network access reads as enabled.
  f.seedPersistedState((db) =>
    db.exec(
      "INSERT OR REPLACE INTO execution_intent_network_access (intentId, enabled) SELECT id, 1 FROM execution_intents",
    ),
  );
  await page.reload();
  await openOverviewCard(page, "assignments");
  await line("Admitted with command network access enabled.").waitFor(attached);
  // Claude turns always deny it, so they carry no turn line of their own.
  const claude = page.locator("#assignments .assignment-row", {
    hasText: "Claude worker",
  });
  await claude.waitFor(attached);
  assert.equal(
    await claude.getByText(/Admitted with command network access/).count(),
    0,
  );
});
