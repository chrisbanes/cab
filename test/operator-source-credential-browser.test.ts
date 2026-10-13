import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { createFakeGh, fakeGhToken } from "./fixtures/fake-gh.js";

const test = browserSuite("ui06-source-credential");

test("Source settings choose gh explicitly, cancel, retain an unknown Clear and reconcile exact bytes", async (_t, journey) => {
  const gh = createFakeGh();
  gh.setAccounts({
    stored: { login: "stored-account", token: "stored-browser-token" },
    tokens: {
      "browser-gh-first": "offered-account",
      "browser-github-second": "other-account",
    },
  });
  const oldGh = process.env.GH_TOKEN,
    oldGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = "browser-gh-first";
  process.env.GITHUB_TOKEN = "browser-github-second";
  journey.cleanup(async () => {
    if (oldGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldGh;
    if (oldGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldGithub;
  }, "candidate-environment.restore");

  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      undefined,
      journey.fixtureOptions,
      undefined,
      { ghExecutable: gh.executable },
    ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID();
  const d = f.service.domain();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Source choice",
    leadProfileId: null,
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [
      {
        id: "S-1",
        kind: "repository",
        repositoryId: "R_1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/projects/${projectId}/settings?tab=github`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "GitHub source credential", exact: true })
    .waitFor();
  assert.equal(d.githubConfiguration(projectId).credentialRef, null);
  await page
    .getByLabel("Readiness matching", { exact: true })
    .selectOption("any");
  await page.getByRole("button", { name: "Set source credential" }).click();
  await page
    .getByText("Signed in to github.com as @offered-account", { exact: false })
    .waitFor();
  await page.getByRole("button", { name: "Cancel credential change" }).click();
  assert.equal(d.githubConfiguration(projectId).credentialRef, null);
  assert.equal(
    await page.getByLabel("Readiness matching", { exact: true }).inputValue(),
    "any",
  );
  await page
    .getByText("Readiness: any of 1 condition", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Source credential choice").count(), 0);
  assert.equal(
    await page
      .getByText("Credential reference: use GitHub CLI login", { exact: true })
      .count(),
    0,
  );
  assert.equal(d.githubConfiguration(projectId).readiness.mode, "all");
  await page.getByRole("button", { name: "Set source credential" }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();
  assert.equal(d.githubConfiguration(projectId).credentialRef, "gh:github.com");
  assert.equal(d.discoveryCredentialReference(), null);
  assert.ok(!(await page.locator("body").innerText()).includes(fakeGhToken));
  await captureBrowserEvidence(page, "1366-source-configured-gh");
  await page
    .getByRole("link", { name: "Sync & placement", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview and activate selection" })
    .waitFor();
  gh.set("not-signed-in");
  await page
    .getByRole("button", { name: "Preview and activate selection" })
    .click();
  await page
    .getByText("GitHub CLI is not signed in.", { exact: false })
    .first()
    .waitFor();
  await page
    .getByRole("link", { name: "Set or change source credential" })
    .first()
    .click();
  gh.set("unreadable");
  await page.reload();
  await page
    .getByText("The service cannot read the GitHub CLI login.", {
      exact: false,
    })
    .waitFor();
  await captureBrowserEvidence(page, "1366-source-gh-unreadable");
  gh.set("signed-in");
  await page.reload();
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();

  const bodies: string[] = [];
  let first = true;
  await page.route("**/api/operator/commands", async (route) => {
    bodies.push(route.request().postData() ?? "");
    if (first) {
      first = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Clear source credential" }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Check whether it saved" }).waitFor();
  assert.equal(d.githubConfiguration(projectId).credentialRef, null);
  assert.equal(
    await page.getByLabel("Source credential choice").isDisabled(),
    true,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Cancel credential change" })
      .isDisabled(),
    true,
  );
  await captureBrowserEvidence(page, "1366-source-unknown-clear");
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  await page.getByRole("button", { name: "Set source credential" }).waitFor();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  await page.unroute("**/api/operator/commands");
  gh.set("not-signed-in");
  await page.reload();
  await page.getByRole("button", { name: "Set source credential" }).click();
  await page.getByText("gh not signed in", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("Source credential choice").selectOption("set");
  await page
    .getByLabel("New environment reference")
    .fill("env:FIXTURE_SOURCE_PRIVATE_NAME");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();
  assert.equal(
    d.githubConfiguration(projectId).credentialRef,
    "env:FIXTURE_SOURCE_PRIVATE_NAME",
  );
  await page.getByRole("button", { name: "Change source credential" }).click();
  await page.getByLabel("Source credential choice").selectOption("set");
  await page.getByLabel("New environment reference").fill("env:lower");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByText(
      "Couldn't save: check the highlighted fields. Your changes are still here.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByLabel("New environment reference").inputValue(),
    "env:lower",
  );
  await page.getByRole("button", { name: "Cancel credential change" }).click();
  const text = await page.locator("body").innerText();
  assert.ok(!text.includes("FIXTURE_SOURCE_PRIVATE_NAME"));
  assert.ok(!text.includes(fakeGhToken));
  await page
    .getByRole("link", { name: "Sync & placement", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Set or change source credential" })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Preview and activate selection" })
      .isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Next step" })
    .getByText("Set or change the credential in GitHub source settings", {
      exact: false,
    })
    .waitFor();
  await captureBrowserEvidence(page, "390-source-missing-credential");
  assert.equal(f.runtime.turns, 0);
});

test("Source and sync recover from an explicitly missing GitHub CLI executable", async (_t, journey) => {
  const gh = createFakeGh();
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(
      null,
      undefined,
      undefined,
      journey.fixtureOptions,
      undefined,
      { ghExecutable: gh.missing },
    ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const projectId = randomUUID(),
    d = f.service.domain();
  d.execute({
    type: "project.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    name: "Missing source CLI",
    leadProfileId: null,
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: 1,
    credentialRef: "gh:github.com",
    selections: [
      {
        id: "S-1",
        kind: "repository",
        repositoryId: "R_1",
        owner: "org",
        name: "repo",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  const web = await journey.start("fixture.web", () => f.startWeb());
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({
    viewport: { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(
    `${web.origin}/app/projects/${projectId}/settings?tab=github`,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByText("GitHub CLI is not installed on the service host.", {
      exact: false,
    })
    .waitFor();
  await page.getByRole("button", { name: "Change source credential" }).click();
  await page.getByText("gh not installed", { exact: false }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Cancel credential change" }).click();
  await captureBrowserEvidence(page, "1366-source-gh-not-installed");
  await page
    .getByRole("link", { name: "Sync & placement", exact: true })
    .click();
  await page
    .getByText("GitHub CLI is not installed on the service host.", {
      exact: false,
    })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Preview and activate selection" })
      .isDisabled(),
    true,
  );
  const recovery = page
    .getByRole("link", { name: "Set or change source credential" })
    .first();
  assert.equal(
    await recovery.getAttribute("href"),
    `/app/projects/${projectId}/settings?tab=github`,
  );
  await recovery.click();
  await page
    .getByRole("heading", { name: "GitHub source credential", exact: true })
    .waitFor();
  assert.equal(d.githubConfiguration(projectId).credentialRef, "gh:github.com");
  assert.equal(
    gh.environments().length,
    0,
    "explicit missing path never runs the available fake or host gh",
  );
  assert.equal(f.runtime.turns, 0);
});
