import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  signIn,
} from "./fixtures/operator-settings.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";

const test = browserSuite("ui826-harness-assignment");

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

    await worker.getByRole("button").first().click();
    const details = page.locator(
      `#history details[data-record-id="${ids.workerId}"]`,
    );
    await details
      .getByText(/^Execution: Claude · sonnet · high · work /)
      .waitFor();
    assert.equal(
      await details.getByRole("link", { name: "Edit profile" }).count(),
      1,
    );
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-task-harness`);
    assert.equal((await page.content()).includes("PRIVATE"), false);

    // A held Claude failure is explained on the recovery page.
    f.seedPersistedState((db) => {
      const workId = f.service
        .list()
        .find((w) => w.reason === "Claude runtime is not configured")?.workId;
      db.prepare("UPDATE domain_assignments SET state='held' WHERE id=?").run(
        ids.workerId,
      );
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
