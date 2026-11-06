import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
const test = browserSuite("operator-foundation-browser");
import { chromium, type Browser } from "playwright";
import { createOperatorFixture } from "../fixtures/operator-web.js";

test("long approval material stays within the phone app viewport", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const domain = f.service.domain(),
    profileId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID(),
    assignmentId = randomUUID();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Foundation lead",
    instructions: "Fixture only",
    capabilities: "Coordinate",
  });
  domain.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Foundation project",
    leadProfileId: profileId,
  });
  domain.execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    title: "Foundation task",
    outcome: "Inspect retained controls",
    ready: false,
  });
  domain.execute({
    type: "assignment.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Inspect retained controls",
    resultDestination: "operator",
    requesterAssignmentId: null,
  });

  const approvalWorkId = randomUUID();
  const approvalInteractionId = randomUUID();
  const approvalMaterial = JSON.stringify({
    command: "Publish approved release notes",
    details: "approved material ".repeat(12),
  });
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'fixture','fixture','completed',NULL,'fixture-thread','fixture-turn','chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), approvalWorkId);
    db.prepare(
      "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,action,target,materialHash,materialJson,revision) VALUES (?,?,?, ?,1,1,1,'approval','open','Approve release notes','Publish approved release notes','release-42',?, ?,1)",
    ).run(
      approvalInteractionId,
      taskId,
      assignmentId,
      approvalWorkId,
      "a".repeat(64),
      approvalMaterial,
    );
  });

  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  journey.observe(phone);
  phone.setDefaultTimeout(5000);
  await phone.goto(`${web.origin}/`);
  await phone.getByLabel("Password", { exact: true }).fill(web.password);
  await phone.getByRole("button", { name: "Sign in", exact: true }).click();
  await phone.locator("main.page h1").waitFor();
  // The approval's long material stays inside a phone viewport on its in-app review.
  await phone.goto(
    `${web.origin}/tasks/${taskId}?request=${approvalInteractionId}`,
  );
  await phone
    .getByRole("button", { name: "Approve this exact material" })
    .waitFor();
  assert.ok(
    await phone.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await captureBrowserEvidence(phone, "390-long-approval-material");
});

test("Nova primitives keep 32px controls, the documented radii and tinted destructive tokens", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID();
  f.service.domain().execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Nova project",
    leadProfileId: null,
  });
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: randomUUID(),
    title: "Nova task",
    outcome: "Inspect primitives",
    ready: false,
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(`${web.origin}/tasks?view=board&ready=any`);
  await page.getByLabel("Password", { exact: true }).fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator('[data-slot="card"]').first().waitFor();
  // Measure the classes the primitives' own destructive variants declare; the rendered
  // Stop… tint is measured in operator-task-detail-browser.
  const destructiveClasses = (primitive: string) =>
    /destructive:\s*"([^"]+)"/.exec(
      readFileSync(
        new URL(`../../../web/src/ui/${primitive}.tsx`, import.meta.url),
        "utf8",
      ),
    )?.[1] ?? assert.fail(`${primitive} declares no destructive variant`);
  const variants = {
    button: destructiveClasses("button"),
    badge: destructiveClasses("badge"),
  };
  const geometry = await page.evaluate((variants) => {
    const measure = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return { height: style.height, radius: style.borderRadius };
    };
    const tinted = (className: string) => {
      const probe = document.createElement("span");
      probe.className = className;
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const result = { background: style.backgroundColor, color: style.color };
      probe.remove();
      return result;
    };
    const destructive = {
      button: tinted(variants.button),
      badge: tinted(variants.badge),
    };
    return {
      input: measure('[data-slot="input"]'),
      card: measure('[data-slot="card"]'),
      destructive,
    };
  }, variants);
  await captureBrowserEvidence(page, "1366-nova-primitives");
  // The board's column chips only render below the 1121px shell breakpoint.
  await page.setViewportSize({ width: 1120, height: 900 });
  const tabs = await page.evaluate(() => {
    const measure = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return { height: style.height, radius: style.borderRadius };
    };
    return {
      primary: measure('.column-tab[aria-pressed="true"]'),
      outline: measure('.column-tab[aria-pressed="false"]'),
    };
  });
  assert.deepEqual(tabs.primary, { height: "32px", radius: "6px" });
  assert.deepEqual(tabs.outline, { height: "32px", radius: "6px" });
  assert.deepEqual(geometry.input, { height: "32px", radius: "6px" });
  assert.equal(geometry.card?.radius, "8px");
  const alpha = (value: string) =>
    Number(/,\s*([\d.]+)\)$/.exec(value)?.[1] ?? "1");
  for (const [name, tint] of Object.entries(geometry.destructive)) {
    assert.ok(
      alpha(tint.background) > 0 && alpha(tint.background) < 1,
      `destructive ${name} background is tinted, not solid: ${tint.background}`,
    );
    assert.notEqual(tint.color, tint.background);
  }
});
