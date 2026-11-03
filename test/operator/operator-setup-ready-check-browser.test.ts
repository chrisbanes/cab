import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page, Route } from "playwright";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  addRepository,
  atlasIssueReader,
  createProject,
  readinessBody,
  sentCommands,
  setupJourney,
  stubReadiness,
} from "../fixtures/setup-browser.js";
import { refreshed } from "../fixtures/browser-waits.js";
import { createFakeGh } from "../fixtures/fake-gh.js";
import { until } from "../fixtures/until.js";
import {
  outcomeMessages,
  savedOutcome,
} from "../fixtures/operator-settings.js";

const test = browserSuite("operator-setup-ready-check-browser");

test("Setup resumes the new project through its command and opens the composer with it", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  await stubReadiness(page);
  const sent = sentCommands(page);
  const { ready, projectId, resume, composer } = await createProject(
    page,
    sent,
  );
  await ready.getByText("Nothing has run.", { exact: true }).waitFor();
  await ready.getByText("No instructions yet.").waitFor();
  await ready.getByText("Repository access: none · repository-free.").waitFor();
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  await captureBrowserEvidence(page, "1366-setup-ready-check");
  const domain = f.service.domain();
  assert.equal(domain.project(projectId).paused, 1);
  // Nothing resumes until the click.
  assert.deepEqual(
    sent.map((c) => c.type),
    ["project.create"],
  );
  await resume.click();
  await composer();
  assert.deepEqual(
    sent.slice(1).map(({ type, paused, expectedVersion }) => ({
      type,
      paused,
      expectedVersion,
    })),
    [{ type: "project.configure", paused: false, expectedVersion: 1 }],
  );
  await page.waitForFunction(
    (id) =>
      document.querySelector<HTMLSelectElement>('select[aria-label="Project"]')
        ?.value === id,
    projectId,
  );
  assert.equal(domain.project(projectId).paused, 0);
  assert.equal(f.runtime.turns, 0);
});

test("Setup disables Resume with the reason and Add Claude for a Claude lead without a token", async (_t, journey) => {
  const { f, page } = await setupJourney(journey, {
    profiles: false,
    claude: true,
  });
  f.service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Claude lead",
    instructions: "Lead",
    capabilities: "Coordinate",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  } as never);
  await stubReadiness(page, { "claude-token": "not-configured" });
  await page.reload();
  await page.getByLabel("Lead profile", { exact: true }).waitFor();
  const sent = sentCommands(page);
  const { ready, projectId, resume } = await createProject(
    page,
    sent,
    "Claude lead",
  );
  await ready.getByText("claude-token reason").waitFor();
  await ready.getByText("claude-token fix").waitFor();
  assert.equal(await resume.isDisabled(), true);
  await captureBrowserEvidence(page, "1366-setup-ready-check-blocked");
  // The reason sits beneath the primary and describes it.
  assert.equal(
    await resume.getAttribute("aria-describedby"),
    await ready.locator(".setup-waits").getAttribute("id"),
  );
  const addClaude = ready.getByRole("link", {
    name: "Add Claude",
    exact: true,
  });
  assert.equal(
    await addClaude.getAttribute("href"),
    "/app/settings/runtime#add-claude",
  );
  // The fix opens in a new tab, so this ready check is still here afterwards.
  assert.equal(await addClaude.getAttribute("target"), "_blank");
  const tab = page.context().waitForEvent("page");
  await addClaude.click();
  const fix = await tab;
  await fix.getByRole("heading", { name: "Add Claude", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/app/settings/projects/new");
  assert.equal(await ready.count(), 1);
  assert.equal(await resume.isDisabled(), true);
  assert.equal(
    sent.some((c) => c.type === "project.configure"),
    false,
  );
  assert.equal(f.service.domain().project(projectId).paused, 1);
});

test("Setup shows a missing claude's fix for a Claude lead, without an Add Claude link", async (_t, journey) => {
  const { f, page } = await setupJourney(journey, {
    profiles: false,
    claude: true,
  });
  f.service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: randomUUID(),
    name: "Claude lead",
    instructions: "Lead",
    capabilities: "Coordinate",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  } as never);
  await stubReadiness(page, { "claude-executable": "fail" });
  await page.reload();
  await page.getByLabel("Lead profile", { exact: true }).waitFor();
  const { ready, resume } = await createProject(
    page,
    sentCommands(page),
    "Claude lead",
  );
  await ready.getByText("claude-executable reason").waitFor();
  await ready.getByText("claude-executable fix").waitFor();
  assert.equal(await resume.isDisabled(), true);
  assert.equal(
    await ready.getByRole("link", { name: "Add Claude" }).count(),
    0,
  );
});

test("Setup lets the operator check again after fixing a failed item", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  let failing: Parameters<typeof readinessBody>[0] = { "codex-login": "fail" };
  await page.route("**/api/operator/readiness", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: readinessBody(failing),
    }),
  );
  const sent = sentCommands(page);
  const { ready, projectId, resume, composer } = await createProject(
    page,
    sent,
  );
  await ready.getByText("codex-login fix").waitFor();
  assert.equal(await resume.isDisabled(), true);
  // The operator fixes it outside this page; nothing here re-reads on its own.
  failing = {};
  const check = ready.getByRole("button", { name: "Check again", exact: true });
  await check.click();
  await ready.getByText("codex-login fix").waitFor({ state: "detached" });
  // A repository-free project has no source credential to check again.
  assert.equal(await check.count(), 0);
  await resume.click();
  await composer();
  assert.equal(f.service.domain().project(projectId).paused, 0);
});

test("Setup blocks Resume for a Claude lead whose model or effort the runtime rejects", async (_t, journey) => {
  const { f, page } = await setupJourney(journey, {
    profiles: false,
    claude: true,
  });
  const profileId = randomUUID();
  f.service.domain().execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId,
    name: "Claude lead",
    instructions: "Lead",
    capabilities: "Coordinate",
    // The fixture runtime accepts `high` for sonnet, not `low`.
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: "low" },
  } as never);
  // The token is readable, so only the lead's own settings can block.
  await stubReadiness(page);
  await page.reload();
  await page.getByLabel("Lead profile", { exact: true }).waitFor();
  const sent = sentCommands(page);
  const { ready, resume } = await createProject(page, sent, "Claude lead");
  await ready
    .getByText(
      "Claude runtime doesn't accept the lead profile's model or reasoning effort.",
    )
    .waitFor();
  assert.equal(await resume.isDisabled(), true);
  assert.equal(
    await ready
      .getByRole("link", { name: "Edit profile", exact: true })
      .getAttribute("href"),
    `/app/profiles/${profileId}/settings`,
  );
  assert.equal(
    sent.some((c) => c.type === "project.configure"),
    false,
  );
  // Fixing the profile elsewhere clears the item only through the workspace re-read.
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId,
    expectedVersion: 1,
    runtime: { harness: "claude", model: "sonnet", reasoningEffort: "high" },
  } as never);
  await ready.getByRole("button", { name: "Check again", exact: true }).click();
  await ready
    .getByRole("link", { name: "Edit profile", exact: true })
    .waitFor({ state: "detached" });
  await resume.click({ trial: true });
});

test("Setup keeps the project paused when the operator chooses Keep paused", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  await stubReadiness(page);
  const sent = sentCommands(page);
  const { ready, projectId } = await createProject(page, sent);
  const keep = ready.getByRole("link", { name: "Keep paused", exact: true });
  assert.equal(
    await keep.getAttribute("href"),
    `/app/projects/${projectId}/settings`,
  );
  await keep.click();
  await page
    .locator(".settings-status")
    .getByText("Paused", { exact: true })
    .waitFor();
  assert.deepEqual(
    sent.map((c) => c.type),
    ["project.create"],
  );
  assert.equal(f.service.domain().project(projectId).paused, 1);
});

test("Setup reports full capacity without disabling Resume", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  await stubReadiness(page);
  await page.route("**/composer-options", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.capacity.projectUsage = body.data.capacity.projectLimit;
    await route.fulfill({ response, json: body });
  });
  const { ready, resume } = await createProject(page, sentCommands(page));
  await ready
    .getByText(
      "Capacity is full now, so the first task will wait for capacity.",
    )
    .waitFor();
  assert.equal(await resume.isEnabled(), true);
});

test("Setup blocks a second Resume until an unknown outcome is checked", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  await stubReadiness(page);
  const sent = sentCommands(page);
  const { ready, projectId, resume, composer } = await createProject(
    page,
    sent,
  );
  await resume.waitFor();
  await page.route("**/api/operator/commands", (route) =>
    route.request().postDataJSON().type === "project.configure"
      ? route.abort()
      : route.continue(),
  );
  try {
    await resume.click();
    await ready
      .getByRole("button", { name: "Check whether it saved" })
      .waitFor();
    assert.equal(await page.getByRole("alert").count(), 1);
    assert.equal(await resume.count(), 0);
    assert.equal(f.service.domain().project(projectId).paused, 1);
    await page.unroute("**/api/operator/commands");
    await ready.getByRole("button", { name: "Check whether it saved" }).click();
    await composer();
    const resumes = sent.filter((c) => c.type === "project.configure");
    assert.equal(resumes.length, 2);
    assert.equal(resumes[1]?.key, resumes[0]?.key);
    assert.equal(f.service.domain().project(projectId).paused, 0);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
});

test("Setup reviews a project changed elsewhere before Resume is sent again", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  await stubReadiness(page);
  const sent = sentCommands(page);
  const { ready, projectId, resume, composer } = await createProject(
    page,
    sent,
  );
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    name: "Renamed",
  } as never);
  await resume.click();
  await ready.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await resume.isDisabled(), true);
  await ready.getByRole("button", { name: "Review changes" }).click();
  // Resume is available again once the latest version is loaded.
  await resume.click();
  await composer();
  const resumes = sent.filter((c) => c.type === "project.configure");
  assert.deepEqual(
    resumes.map((c) => c.expectedVersion),
    [1, 2],
  );
  assert.equal(f.service.domain().project(projectId).paused, 0);
});

test("Setup's ready check stays usable on a phone", async (_t, journey) => {
  const { page } = await setupJourney(journey, {
    viewport: { width: 390, height: 844 },
  });
  await stubReadiness(page, { "codex-login": "fail" });
  const { ready } = await createProject(page, sentCommands(page));
  await ready.getByText("codex-login fix").waitFor();
  await page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  const small = await ready
    .locator(":is(button, a[data-slot='button'])")
    .evaluateAll((els) =>
      els
        .map((el) => ({
          name: el.textContent,
          height: el.getBoundingClientRect().height,
        }))
        .filter((e) => e.height < 44),
    );
  assert.deepEqual(small, []);
  // Resume and Keep paused stack at the full width of the check.
  const width = (await ready.boundingBox())?.width ?? 0;
  const actions = await ready
    .locator(".setup-inline-actions > *")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  assert.equal(actions.length, 2);
  assert.ok(
    actions.every((w) => w >= width - 1),
    JSON.stringify({ width, actions }),
  );
  await captureBrowserEvidence(page, "390-setup-ready-check");
});

test("Setup fails closed when readiness cannot be read and recovers on Check again", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  let readable = false;
  await page.route("**/api/operator/readiness", (route) =>
    readable
      ? route.fulfill({
          contentType: "application/json",
          body: readinessBody(),
        })
      : route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "unavailable", message: "x" },
          }),
        }),
  );
  const { ready, resume } = await createProject(page, sentCommands(page));
  await ready.getByText("Readiness couldn't be checked.").waitFor();
  assert.equal(await resume.isDisabled(), true);
  readable = true;
  await ready.getByRole("button", { name: "Check again", exact: true }).click();
  await ready
    .getByText("Readiness couldn't be checked.")
    .waitFor({ state: "detached" });
  await resume.click({ trial: true });
  // The button leaves while the read starts again, so the focus moves to the result.
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("setup-waits"),
  );
});

test("Setup blocks Resume for a project created without a lead", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  await stubReadiness(page);
  const sent = sentCommands(page);
  const { ready, resume } = await createProject(page, sent, "Unconfigured");
  await ready
    .getByText("No lead profile. Tasks wait for a lead before starting.")
    .waitFor();
  assert.equal(await resume.isDisabled(), true);
  assert.equal(
    sent.some((c) => c.type === "project.configure"),
    false,
  );
});

test("Setup shows the ready check once and a later visit starts clean without reading", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  await stubReadiness(page);
  const { ready } = await createProject(page, sentCommands(page));
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  await ready.getByRole("link", { name: "Keep paused", exact: true }).click();
  await page
    .locator(".settings-status")
    .getByText("Paused", { exact: true })
    .waitFor();
  const reads: string[] = [];
  page.on("request", (r) => {
    const { pathname } = new URL(r.url());
    if (/\/(readiness|composer-options)$/.test(pathname)) reads.push(pathname);
  });
  await page.getByRole("link", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByRole("region", { name: "Ready check" }).count(),
    0,
  );
  // Reads start in effects; give a stale ready check the chance to have started them.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
  assert.deepEqual(reads, []);
});

test("Setup keeps an unsettled Resume apart from the project's General tab", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  await stubReadiness(page);
  const sent = sentCommands(page);
  const { ready, projectId, resume } = await createProject(page, sent);
  await page.route("**/api/operator/commands", (route) =>
    route.request().postDataJSON().type === "project.configure"
      ? route.abort()
      : route.continue(),
  );
  try {
    await resume.click();
    await ready
      .getByRole("button", { name: "Check whether it saved" })
      .waitFor();
    await page.unroute("**/api/operator/commands");
    await ready.getByRole("link", { name: "Keep paused", exact: true }).click();
    const pause = page.getByRole("switch", { name: "Pause project" });
    await pause.waitFor();
    assert.equal(await pause.isChecked(), true);
    assert.equal(await pause.isEnabled(), true);
    assert.equal(await outcomeMessages(page).count(), 0);
    await pause.click();
    await page.getByRole("button", { name: "Save project" }).click();
    await savedOutcome(page);
    const configure = sent.filter((c) => c.type === "project.configure");
    assert.equal(configure.length, 2);
    // The Settings save is its own request, never a replay of the unsettled Resume.
    assert.notEqual(configure[1]?.key, configure[0]?.key);
    assert.equal(f.service.domain().project(projectId).paused, 0);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
});

/**
 * Create a project with Mira as lead, then let another tab change its lead (still paused)
 * so Resume conflicts. Reviewing the conflict is left to the caller; `gate` holds readiness
 * responses while it is set.
 */
async function leadChangedElsewhere(
  journey: Parameters<typeof setupJourney>[0],
  change: (ids: { claude: string; nora: string }) => string | null,
) {
  const { f, page, profiles } = await setupJourney(journey, { claude: true });
  const claude = randomUUID();
  const domain = f.service.domain();
  domain.execute({
    type: "profile.create",
    actor: "operator",
    key: randomUUID(),
    profileId: claude,
    name: "Claude lead",
    instructions: "Lead",
    capabilities: "Coordinate",
    runtime: { harness: "claude", model: null, reasoningEffort: null },
  } as never);
  // Mira (Codex) is ready; the Claude token is not.
  const gate: { hold: Promise<void> | null } = { hold: null };
  await page.route("**/api/operator/readiness", async (route) => {
    await gate.hold;
    await route.fulfill({
      contentType: "application/json",
      body: readinessBody({ "claude-token": "not-configured" }),
    });
  });
  await page.reload();
  await page.getByLabel("Lead profile", { exact: true }).waitFor();
  const sent = sentCommands(page);
  const created = await createProject(page, sent);
  await created.ready
    .getByText("Checking readiness…")
    .waitFor({ state: "detached" });
  assert.equal(await created.resume.isEnabled(), true);
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: created.projectId,
    expectedVersion: 1,
    leadProfileId: change({ claude, nora: String(profiles.Nora) }),
  } as never);
  await created.resume.click();
  await created.ready
    .getByText("A newer version was saved elsewhere.")
    .waitFor();
  return {
    ...created,
    page,
    sent,
    domain,
    gate,
    review: () =>
      created.ready.getByRole("button", { name: "Review changes" }).click(),
  };
}

test("Setup judges the project's current lead after a conflict review, not the original one", async (_t, journey) => {
  const { ready, resume, sent, domain, projectId, review } =
    await leadChangedElsewhere(journey, ({ claude }) => claude);
  await review();
  // The new lead is a Claude profile without a readable token.
  await ready.getByText("claude-token reason").waitFor();
  assert.equal(await resume.isDisabled(), true);
  assert.deepEqual(
    sent
      .filter((c) => c.type === "project.configure")
      .map((c) => c.expectedVersion),
    [1],
  );
  assert.equal(domain.project(projectId).paused, 1);
});

test("Setup blocks Resume after a conflict review finds the lead removed", async (_t, journey) => {
  const { ready, resume, domain, projectId, review } =
    await leadChangedElsewhere(journey, () => null);
  await review();
  await ready
    .getByText("No lead profile. Tasks wait for a lead before starting.")
    .waitFor();
  assert.equal(await resume.isDisabled(), true);
  assert.equal(domain.project(projectId).paused, 1);
});

test("Setup keeps Resume locked until reads made after the review land, then sends it again", async (_t, journey) => {
  const { ready, resume, sent, domain, projectId, gate, review, composer } =
    await leadChangedElsewhere(journey, ({ nora }) => nora);
  let release: () => void = () => {};
  gate.hold = new Promise<void>((done) => {
    release = done;
  });
  await review();
  // The old readiness still shows, but it predates the review: nothing is judged yet.
  await ready.getByText("Checking readiness…").waitFor();
  assert.equal(await resume.isDisabled(), true);
  release();
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  assert.equal(await resume.isEnabled(), true);
  await resume.click();
  await composer();
  assert.deepEqual(
    sent
      .filter((c) => c.type === "project.configure")
      .map((c) => c.expectedVersion),
    [1, 2],
  );
  assert.equal(domain.project(projectId).paused, 0);
});

test("Setup does not unlock Resume on a workspace that was not re-read after the review", async (_t, journey) => {
  const { ready, resume, page, review } = await leadChangedElsewhere(
    journey,
    ({ nora }) => nora,
  );
  await page.route("**/api/operator/workspace", (route) => route.abort());
  await review();
  await ready.getByText("Checking readiness…").waitFor();
  assert.equal(await resume.isDisabled(), true);
  // The failed workspace read offers Try again; only a completed read lets the lead be judged.
  await page.unroute("**/api/operator/workspace");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  assert.equal(await resume.isEnabled(), true);
});

test("Setup records the signed-in GitHub CLI login as the source credential and shows it", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    ghExecutable: gh.executable,
  });
  await stubReadiness(page);
  const sent = sentCommands(page);
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  // The line sits in step 3 and appears with the first repository.
  const line = page.getByText(
    /^GitHub source credential: GitHub CLI · @octo\. /,
  );
  assert.equal(await line.count(), 0);
  await addRepository(page);
  await line.waitFor();
  const { ready, projectId, resume } = await createProject(page, sent);
  assert.equal(
    sent.find((c) => c.type === "project.create")?.sourceCredentialRef,
    "gh:github.com",
  );
  await ready
    .getByText("GitHub source credential: GitHub CLI · @octo", { exact: true })
    .waitFor();
  const source = f.service.domain().githubConfiguration(projectId);
  assert.equal(source.credentialRef, "gh:github.com");
  assert.equal(source.version, 1);
  await resume.waitFor();
  assert.equal(await resume.isEnabled(), true);
});

test("Setup states and records the Open PRs delivery default with the signed-in GitHub CLI login", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    ghExecutable: gh.executable,
  });
  await stubReadiness(page);
  const sent = sentCommands(page);
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  const line = page.getByText(
    /^Delivery: Open PRs on each repository\. .*can't merge.*Delivery credential: GitHub CLI · @octo\. /,
  );
  assert.equal(await line.count(), 0);
  await addRepository(page);
  await line.waitFor();
  const { ready, projectId, resume } = await createProject(page, sent);
  assert.deepEqual(
    sent.find((c) => c.type === "project.create")?.deliveryDefault,
    { credentialRef: "gh:github.com" },
  );
  const policy = f.service.delivery().configuration(projectId);
  assert.equal(policy.version, 1);
  assert.equal(policy.credentialRef, "gh:github.com");
  assert.equal(policy.mode, "reviewable-pr");
  assert.equal(policy.grants.length, 7);
  await ready
    .getByText("Delivery: granted · GitHub CLI · @octo", { exact: true })
    .waitFor();
  await resume.waitFor();
  assert.equal(await resume.isEnabled(), true);
});

test("Setup records no source credential without a signed-in GitHub CLI login", async (_t, journey) => {
  const gh = createFakeGh("not-signed-in");
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { f, page } = await setupJourney(journey, {
    ghExecutable: gh.executable,
  });
  await stubReadiness(page);
  const sent = sentCommands(page);
  await addRepository(page);
  await page.getByText(/^GitHub source credential: none\. /).waitFor();
  await page
    .getByText(
      /^Delivery: Open PRs on each repository\. .*Delivery credential: none\. No usable GitHub CLI login was detected/,
    )
    .waitFor();
  const { ready, projectId, resume } = await createProject(page, sent);
  const create = sent.find((c) => c.type === "project.create");
  assert.equal(create && "sourceCredentialRef" in create, false);
  assert.deepEqual(create?.deliveryDefault, {});
  // Open PRs is granted, but nothing can reach GitHub: the ready check says so and links to the tab.
  const missing = ready.getByText(
    "Delivery: No GitHub delivery credential is set.",
  );
  await missing.waitFor();
  assert.equal(
    await ready
      .getByRole("link", { name: "Delivery settings" })
      .getAttribute("href"),
    `/app/projects/${projectId}/settings?tab=delivery`,
  );
  assert.equal(
    f.service.delivery().configuration(projectId).credentialRef,
    null,
  );
  const line = ready.getByText(
    "GitHub source credential: not set. The source won't sync until one is set.",
  );
  await line.waitFor();
  assert.equal(
    await ready
      .getByRole("link", { name: "GitHub source settings" })
      .getAttribute("href"),
    `/app/projects/${projectId}/settings?tab=github`,
  );
  assert.equal(
    f.service.domain().githubConfiguration(projectId).credentialRef,
    null,
  );
  await resume.waitFor();
  assert.equal(await resume.isEnabled(), true);
  // Fixed in another tab: Check again re-reads the credential, as it does readiness.
  gh.set("signed-in");
  const d = f.service.domain();
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "gh:github.com",
    selections: [],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  await ready.getByRole("button", { name: "Check again" }).click();
  await ready
    .getByText("GitHub source credential: GitHub CLI · @octo", { exact: true })
    .waitFor();
  await line.waitFor({ state: "detached" });
  // The delivery credential is still missing, so there is still something to check again.
  await missing.waitFor();
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: "gh:github.com",
    grants: f.service.delivery().configuration(projectId).grants,
    requiredChecks: [],
  });
  await ready.getByRole("button", { name: "Check again" }).click();
  await ready
    .getByText("Delivery: granted · GitHub CLI · @octo", { exact: true })
    .waitFor();
  await missing.waitFor({ state: "detached" });
  assert.equal(
    await ready.getByRole("button", { name: "Check again" }).count(),
    0,
  );
  assert.equal(await resume.isEnabled(), true);
});

/** The ready check of a project that links acme/atlas's GitHub Project, over a signed-in gh. */
async function linkedReadyCheck(
  journey: Parameters<typeof setupJourney>[0],
  options: {
    viewport?: { width: number; height: number };
    prepare?: (page: Page) => Promise<void>;
    /** Readiness checks that fail, which also offers Check again. */
    failing?: Parameters<typeof stubReadiness>[1];
  } = {},
) {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const s = await setupJourney(journey, {
    ghExecutable: gh.executable,
    readerFactory: atlasIssueReader,
    ...(options.viewport ? { viewport: options.viewport } : {}),
  });
  await options.prepare?.(s.page);
  await stubReadiness(s.page, options.failing);
  const sent = sentCommands(s.page);
  const steps: string[] = [];
  s.page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      r.url().endsWith("/api/operator/source-refresh")
    )
      steps.push("refresh");
    else if (
      r.method() === "POST" &&
      r.url().endsWith("/api/operator/commands")
    ) {
      const body = r.postDataJSON() as { type: string };
      if (body.type === "github.preview") steps.push("preview");
    }
  });
  // Import issues reads the private values once it shows; a read that lands after a save
  // elsewhere re-reads the configuration, which drops an outcome of the older version.
  const privateReads: string[] = [];
  s.page.on("response", (r) => {
    if (r.url().endsWith("/private-values"))
      privateReads.push(new URL(r.url()).pathname);
  });
  await addRepository(s.page);
  // Create records the gh credential only once step 3 has read the login.
  await s.page
    .getByText(/^GitHub source credential: GitHub CLI · @octo\. /)
    .waitFor();
  const created = await createProject(s.page, sent);
  return {
    ...s,
    ...created,
    gh,
    sent,
    steps,
    privateReads,
    previews: () => sent.filter((c) => c.type === "github.preview"),
    panel: created.ready.getByRole("region", { name: "Import issues" }),
    importButton: created.ready.getByRole("button", {
      name: "Preview and import now",
      exact: true,
    }),
  };
}

test("Setup's ready check imports the linked GitHub Project before Resume, then resumes", async (_t, journey) => {
  const t = await linkedReadyCheck(journey);
  await t.importButton.waitFor();
  // Importing stays an explicit press: nothing has previewed or refreshed yet.
  assert.deepEqual(t.steps, []);
  assert.equal(
    await t.importButton.evaluate(
      (el, resume) =>
        Boolean(
          el.compareDocumentPosition(resume) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await t.resume.elementHandle(),
    ),
    true,
    "Preview and import now comes before Resume",
  );
  await t.importButton.click();
  const activation = outcomeMessages(t.ready).filter({ hasText: /^Previewed/ });
  await activation.waitFor();
  assert.match(
    await activation.locator(".action-outcome-message").innerText(),
    /^Previewed \d\d:\d\d\. .* is active\.$/,
  );
  const read = outcomeMessages(t.ready).filter({
    hasText: /Read .* completely at/,
  });
  await read.waitFor(refreshed);
  const view = t.ready.getByRole("link", { name: "View imported tasks" });
  assert.equal(
    await view.getAttribute("href"),
    `/app/projects/${t.projectId}?ready=any`,
  );
  assert.equal(await view.getAttribute("target"), "_blank");
  assert.deepEqual(t.steps, ["preview", "refresh"]);
  assert.deepEqual(
    t.previews().map(({ selectionId, expectedVersion }) => ({
      selectionId,
      expectedVersion,
    })),
    [{ selectionId: "S-1", expectedVersion: 1 }],
  );
  const d = t.f.service.domain();
  const imported = d.tasks(t.projectId).length;
  assert.ok(imported > 0, "the refresh imported the project's issues");
  // Resume is unaffected: it still sends its recorded version and opens the composer.
  assert.equal(await t.resume.isEnabled(), true);
  assert.equal(d.project(t.projectId).paused, 1);
  await t.resume.click();
  await t.composer();
  const resumed = t.sent.filter((c) => c.type === "project.configure");
  assert.deepEqual(
    resumed.map(({ paused, expectedVersion }) => ({ paused, expectedVersion })),
    [{ paused: false, expectedVersion: 1 }],
  );
  assert.equal(d.project(t.projectId).paused, 0);
  assert.equal(d.tasks(t.projectId).length, imported);
});

for (const state of ["partial", "never"] as const)
  test(`Setup's ready check claims no import when the read is ${state}`, async (_t, journey) => {
    const t = await linkedReadyCheck(journey);
    await t.page.route("**/api/operator/source-refresh", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const project of body.data.projects)
        for (const s of project.selections) {
          s.state = state;
          s.lastSuccessfulAt = null;
          if (state === "never") s.lastAttemptAt = null;
        }
      await route.fulfill({ response, json: body });
    });
    await t.importButton.click();
    await outcomeMessages(t.ready)
      .filter({
        hasText:
          state === "partial" ? /only partly/ : /nothing was imported from/,
      })
      .waitFor();
    assert.equal(
      await t.ready.getByRole("link", { name: "View imported tasks" }).count(),
      0,
    );
  });

test("Setup's ready check resends an unknown preview with the same key, then refreshes once", async (_t, journey) => {
  const t = await linkedReadyCheck(journey);
  let first = true;
  await t.page.route("**/api/operator/commands", async (route: Route) => {
    if (!first || route.request().postDataJSON().type !== "github.preview")
      return route.continue();
    first = false;
    await route.abort();
  });
  await t.importButton.click();
  const check = t.ready.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  assert.deepEqual(t.steps, ["preview"], "no refresh before it is confirmed");
  await check.click();
  await t.ready
    .getByRole("link", { name: "View imported tasks" })
    .waitFor(refreshed);
  const [one, two] = t.previews();
  assert.equal(t.previews().length, 2);
  assert.equal(one?.key, two?.key);
  assert.deepEqual(t.steps, ["preview", "preview", "refresh"]);
});

test("Setup's ready check offers Refresh again for an unconfirmed refresh without previewing again", async (_t, journey) => {
  const t = await linkedReadyCheck(journey);
  let fail = true;
  await t.page.route("**/api/operator/source-refresh", (route) =>
    fail ? route.abort() : route.continue(),
  );
  await t.importButton.click();
  const warning = outcomeMessages(t.ready).filter({
    hasText: "We couldn't confirm the refresh. The sources are active.",
  });
  await warning.waitFor();
  fail = false;
  await warning.getByRole("button", { name: "Refresh again" }).click();
  await t.ready
    .getByRole("link", { name: "View imported tasks" })
    .waitFor(refreshed);
  assert.deepEqual(t.steps, ["preview", "refresh", "refresh"]);
});

function responseGate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, resolve: release };
}

/** #1388's ordering guard: a completed server snapshot must precede the external save. */
const waitForImportPrivateRead = (
  t: Awaited<ReturnType<typeof linkedReadyCheck>>,
) =>
  until(
    () =>
      t.privateReads.includes(
        `/api/operator/projects/${t.projectId}/private-values`,
      ),
    "the Import issues private read",
  );

for (const guarded of [false, true])
  test(`Setup's ready check reviews a source saved elsewhere before importing again: ${guarded ? "private-read guard" : "historical no-wait ordering"}`, async (_t, journey) => {
    const release = responseGate();
    const requested = responseGate();
    journey.cleanup(async () => release.resolve(), "release-private-read");
    const chronology: Array<Record<string, unknown>> = [];
    let snapshot: unknown;
    let equivalent = false;
    const t = await linkedReadyCheck(journey, {
      failing: { "codex-login": "fail" },
      prepare: async (page) => {
        await page.route(
          "**/api/operator/projects/*/private-values",
          async (route) => {
            chronology.push({ event: "private-start" });
            requested.resolve();
            await release.promise;
            const response = await route.fetch();
            const body = await response.json();
            chronology.push({
              event: "private-response",
              version: body.data.source.version,
              observedAt: body.observedAt,
            });
            await route.fulfill({ response });
          },
        );
        await page.route(
          "**/api/operator/projects/*/configuration",
          async (route) => {
            const response = await route.fetch();
            const current = await response.json();
            snapshot ??= current;
            const body = equivalent ? (snapshot as typeof current) : current;
            chronology.push({
              event: "configuration-response",
              version: body.data.source.version,
              observedAt: body.observedAt,
            });
            await route.fulfill({ response, json: body });
          },
        );
      },
    });
    try {
      await t.importButton.waitFor();
      await requested.promise;
      const saveElsewhere = async () => {
        chronology.push({ event: "external-save-start" });
        await new OperatorApi(t.f.service, [t.f.directory]).execute({
          type: "github.configure",
          key: randomUUID(),
          projectId: t.projectId,
          expectedVersion: 1,
          selections: [{ id: "S-1", keep: true }],
          readiness: {
            mode: "all",
            conditions: [{ kind: "label", operator: "has", name: "ready" }],
          },
        } as never);
        chronology.push({ event: "external-save", version: 2 });
      };
      if (guarded) {
        const save = waitForImportPrivateRead(t).then(saveElsewhere);
        // Give the waiting journey a render opportunity while its private response is held.
        await t.page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        assert.equal(
          chronology.some((e) => e.event === "external-save-start"),
          false,
        );
        release.resolve();
        await save;
        assert.equal(
          chronology.find((e) => e.event === "private-response")?.version,
          1,
        );
      } else await saveElsewhere();
      await t.importButton.click();
      const warning = outcomeMessages(t.ready).filter({
        hasText: "Nothing was refreshed.",
      });
      await warning.waitFor();
      const panel = await t.panel.elementHandle();
      const outcome = await warning.elementHandle();
      const button = await warning
        .getByRole("button", { name: "Review changes" })
        .elementHandle();
      assert.ok(panel && outcome && button);
      chronology.push({
        event: "conflict",
        previews: t
          .previews()
          .map(({ key, expectedVersion }) => ({ key, expectedVersion })),
        connected: await button.evaluate((el) => el.isConnected),
      });
      if (guarded) {
        equivalent = true;
        for (let i = 0; i < 2; i++) {
          const reread = t.page.waitForResponse((r) =>
            r
              .url()
              .endsWith(`/api/operator/projects/${t.projectId}/configuration`),
          );
          await t.ready.getByRole("button", { name: "Check again" }).click();
          await reread;
          await t.page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              ),
          );
          chronology.push({
            event: "equivalent-read",
            version: 1,
            connected: await button.evaluate((el) => el.isConnected),
          });
          assert.equal(await outcome.evaluate((el) => el.isConnected), true);
          assert.equal(await button.evaluate((el) => el.isConnected), true);
        }
        equivalent = false;
        const reread = t.page.waitForResponse((r) =>
          r
            .url()
            .endsWith(`/api/operator/projects/${t.projectId}/configuration`),
        );
        await warning.getByRole("button", { name: "Review changes" }).click();
        await reread;
        await warning.waitFor({ state: "detached" });
      } else {
        release.resolve();
        await warning.waitFor({ state: "detached" });
        chronology.push({
          event: "version-transition",
          connected: await button.evaluate((el) => el.isConnected),
          panelConnected: await panel.evaluate((el) => el.isConnected),
        });
        assert.equal(
          chronology.find((e) => e.event === "private-response")?.version,
          2,
        );
        assert.equal(await button.evaluate((el) => el.isConnected), false);
        assert.equal(await panel.evaluate((el) => el.isConnected), true);
      }
      assert.deepEqual(t.steps, ["preview"]);
      assert.equal(t.f.service.domain().project(t.projectId).paused, 1);
      assert.equal(t.f.service.domain().tasks(t.projectId).length, 0);
      assert.deepEqual(
        t.f.service.domain().githubActiveSelectionIds(t.projectId),
        [],
      );
      await t.page.unrouteAll({ behavior: "wait" });
    } finally {
      release.resolve();
      _t.diagnostic(JSON.stringify({ guarded, chronology }));
    }
  });

test("Setup's ready check reviews a source saved elsewhere before importing again", async (_t, journey) => {
  const t = await linkedReadyCheck(journey);
  await t.importButton.waitFor();
  // Save elsewhere only after the panel's own read, so only Review changes re-reads.
  await waitForImportPrivateRead(t);
  await new OperatorApi(t.f.service, [t.f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: t.projectId,
    expectedVersion: 1,
    selections: [{ id: "S-1", keep: true }],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  } as never);
  await t.importButton.click();
  const warning = outcomeMessages(t.ready).filter({
    hasText: "Nothing was refreshed.",
  });
  await warning.waitFor();
  assert.deepEqual(t.steps, ["preview"]);
  // The action is offered again at once; the press that follows needs the re-read version.
  const reread = t.page.waitForResponse((r) =>
    r.url().endsWith(`/api/operator/projects/${t.projectId}/configuration`),
  );
  await warning.getByRole("button", { name: "Review changes" }).click();
  await reread;
  await t.importButton.waitFor();
  await t.importButton.click();
  await t.ready
    .getByRole("link", { name: "View imported tasks" })
    .waitFor(refreshed);
  const [stale, fresh] = t.previews();
  assert.equal(fresh?.expectedVersion, 2);
  assert.notEqual(fresh?.key, stale?.key);
});

test("Setup's ready check keeps Preview and import now focusable with the unusable credential's reason", async (_t, journey) => {
  // A failing readiness item is what offers Check again here.
  const t = await linkedReadyCheck(journey, {
    failing: { "codex-login": "fail" },
  });
  await t.importButton.waitFor();
  t.gh.set("not-signed-in");
  await t.ready.getByRole("button", { name: "Check again" }).click();
  await t.ready.getByRole("link", { name: "GitHub source settings" }).waitFor();
  assert.equal(await t.importButton.getAttribute("aria-disabled"), "true");
  const reason = await t.importButton.evaluate((el) => {
    const id = el.getAttribute("aria-describedby");
    const line = id ? document.getElementById(id) : null;
    return {
      id,
      text: line?.textContent ?? "",
      link: line?.querySelector("a")?.textContent ?? "",
    };
  });
  assert.equal(reason.id, "source-credential-reason");
  assert.match(reason.text, /^GitHub source credential: GitHub CLI\./);
  assert.equal(reason.link, "GitHub source settings");
  await t.importButton.click({ force: true });
  await t.page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => done(null))),
  );
  assert.deepEqual(t.steps, []);
});

test("Setup's ready check offers no import without a linked GitHub Project", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const { page } = await setupJourney(journey, {
    ghExecutable: gh.executable,
    readerFactory: atlasIssueReader,
  });
  await stubReadiness(page);
  const sent = sentCommands(page);
  await addRepository(page);
  await page.getByLabel("GitHub Project", { exact: true }).selectOption("");
  const { ready, resume } = await createProject(page, sent);
  assert.equal(
    "githubProject" in (sent.find((c) => c.type === "project.create") ?? {}),
    false,
  );
  await resume.waitFor();
  assert.equal(
    await ready.getByRole("region", { name: "Import issues" }).count(),
    0,
  );
  assert.equal(
    await ready.getByRole("button", { name: "Preview and import now" }).count(),
    0,
  );
});
