import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import type { UnexpectedRequest } from "../../src/standalone/codex.js";
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
import {
  ClaudeShapedFixtureRuntime,
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";

const test = browserSuite("operator-neutral-copy-browser");
const reason = "Unexpected runtime request denied: claude/canUseTool:Bash";

/** A Claude fake that can raise an unexpected request through the service. */
class UnexpectedClaudeRuntime extends ClaudeShapedFixtureRuntime {
  private unexpected: ((request: UnexpectedRequest) => void) | undefined;
  override onUnexpectedRequest(
    listener?: (request: UnexpectedRequest) => void,
  ) {
    this.unexpected = listener;
  }
  deny(method: string) {
    this.unexpected?.({ method });
  }
}

async function until(predicate: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

for (const [name, viewport] of [
  ["1366", desktop],
  ["390", phone],
] as const)
  test(`a Claude unexpected request reads neutrally on task and runtime views at ${name}`, async (_t, journey) => {
    let claude: UnexpectedClaudeRuntime | undefined;
    const f = await journey.start("fixture.create", () =>
      createOperatorFixture(
        null,
        undefined,
        undefined,
        journey.fixtureOptions,
        (_context, harness) => {
          if (harness === "codex") return new OperatorFixtureRuntime();
          claude = new UnexpectedClaudeRuntime();
          return claude;
        },
        { runtimeHarnesses: ["codex", "claude"] },
      ),
    );
    let browser: Browser | undefined;
    journey.cleanup(
      (primary) => f.close(browser, primary),
      "fixture.close",
      () => f.lifecycle.steps,
    );
    const d = f.service.domain(),
      lead = randomUUID(),
      worker = randomUUID(),
      projectId = randomUUID(),
      taskId = randomUUID(),
      workerId = randomUUID();
    const run = (command: Record<string, unknown>) =>
      d.execute({ actor: "operator", key: randomUUID(), ...command } as never);
    await f.service.configureCapacity({ key: randomUUID(), globalLimit: 4 });
    run({
      type: "profile.create",
      profileId: lead,
      name: "Lead",
      instructions: "PRIVATE LEAD",
      capabilities: "lead",
    });
    run({
      type: "profile.create",
      profileId: worker,
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
      candidateProfileIds: [worker, lead],
    });
    run({
      type: "task.create",
      projectId,
      taskId,
      title: "Neutral copy task",
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
      assignmentId: workerId,
      profileId: worker,
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
    const workId = `assignment:${workerId}:initial`;
    const intent = () => f.service.list().find((w) => w.workId === workId);
    await until(() => intent()?.state === "running", "Claude work did not run");
    claude?.deny("claude/canUseTool:Bash");
    await until(() => intent()?.reason === reason, "Claude work was not held");

    const web = await journey.start("fixture.web", () => f.startWeb());
    browser = await journey.start("browser.launch", () => chromium.launch());
    const page = await browser.newPage({ viewport });
    journey.observe(page);
    page.setDefaultTimeout(5000);
    await signIn(page, web, `/app/tasks/${taskId}`);

    const row = page.locator(".assignment-row", { hasText: "Claude work" });
    await row.getByText(reason, { exact: false }).waitFor();
    await row.getByRole("button").first().click();
    const details = page.locator(
      `#history details[data-record-id="${workerId}"]`,
    );
    await details
      .getByText(`Recorded wait / execution reason: ${reason}.`)
      .waitFor();
    for (const text of [await row.innerText(), await details.innerText()])
      assert.doesNotMatch(text, /Codex|App Server|PRIVATE/);
    await noPageOverflow(page);
    await captureBrowserEvidence(page, `${name}-neutral-wait-reason`);

    await page.goto(`${web.origin}/runtime/assignment/${workerId}`);
    const retained = await page.locator("main").innerText();
    // The retained page shows a fixed recovery reason, never the raw hold text.
    assert.ok(retained.includes("Execution runtime: Claude"), retained);
    assert.doesNotMatch(retained, /Codex|App Server/);
    await captureBrowserEvidence(page, `${name}-neutral-runtime-assignment`);
  });
