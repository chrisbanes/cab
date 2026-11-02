import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  startSettings,
  phone,
  noPageOverflow,
  savedOutcome,
} from "../fixtures/operator-settings.js";

const test = browserSuite("operator-delivery-config-browser");
const path = "/app/projects/:atlas/settings?tab=delivery";
const save = (page: Page) =>
  page.getByRole("button", { name: "Save delivery", exact: true });
const read = async (page: Page) => {
  const response = page.waitForResponse(
    (r) => r.request().method() === "GET" && /configuration$/.test(r.url()),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await response;
  await page.waitForFunction(
    () => !document.body.innerText.includes("Refreshing."),
  );
};
const body = (page: Page) =>
  page
    .waitForRequest(
      (r) =>
        r.method() === "POST" && r.url().endsWith("/api/operator/commands"),
    )
    .then((r) => r.postDataJSON() as Record<string, unknown>);
const grant = (page: Page, index = 1) =>
  page.getByRole("region", { name: `Grant ${index}`, exact: true });
const check = (page: Page, index = 1) =>
  page.getByRole("region", {
    name: `Additional check ${index} for acme/atlas`,
    exact: true,
  });
const addCheck = (page: Page) =>
  page.getByRole("button", {
    name: "Add additional check for acme/atlas",
    exact: true,
  });

test("Delivery edits exact scopes and checks with keyboard focus, discard, credential intents and readback", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path);
  await page.getByRole("heading", { name: "Delivery", exact: true }).waitFor();
  assert.equal(await save(page).isDisabled(), true);
  await page.getByLabel("Completion mode").selectOption("through-merge");
  await page.getByLabel("Branch prefix choice").selectOption("set");
  await page.getByLabel("Branch prefix", { exact: true }).fill("");
  await page.getByRole("button", { name: "Add grant", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await grant(page)
      .getByLabel("Action", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await grant(page)
      .getByLabel("Action", { exact: true })
      .locator("option")
      .count(),
    17,
  );
  await grant(page)
    .getByLabel("Repository or tracker container ID")
    .fill("acme/atlas");
  await grant(page)
    .getByLabel("Action", { exact: true })
    .selectOption("project.field");
  await grant(page)
    .getByLabel("Authority", { exact: true })
    .selectOption("allow");
  await grant(page).getByLabel("Project ID", { exact: true }).fill("PVT_atlas");
  await grant(page).getByLabel("Field ID", { exact: true }).fill("Status");
  await grant(page)
    .getByLabel("Option IDs (one per line)")
    .fill("Ready\nReady");
  await addCheck(page).click();
  assert.equal(
    await check(page)
      .getByLabel("Check name")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await check(page).getByLabel("Check name").fill("Build");
  await check(page).getByLabel("Include App ID").check();
  await check(page).getByLabel("App ID", { exact: true }).fill("42");
  await captureBrowserEvidence(page, "delivery-desktop");
  const command = body(page);
  await save(page).click();
  const sent = await command;
  assert.equal(Object.hasOwn(sent, "credentialRef"), false);
  assert.equal(sent.branchPrefix, "");
  assert.deepEqual(sent.grants, [
    {
      action: "project.field",
      repositoryId: "acme/atlas",
      mode: "allow",
      projectNodeId: "PVT_atlas",
      fieldNodeId: "Status",
      optionNodeIds: ["Ready", "Ready"],
    },
  ]);
  assert.deepEqual(sent.requiredChecks, []);
  assert.deepEqual(sent.repositories, [
    {
      repositoryId: "acme/atlas",
      requiredChecks: [{ name: "Build", appId: 42 }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(sent), /rowKey|grant-0|check-0/);
  await savedOutcome(page);
  assert.deepEqual(f.service.delivery().configuration(ids.atlas).repositories, [
    {
      repositoryId: "acme/atlas",
      requiredChecks: [{ name: "Build", appId: 42 }],
    },
  ]);
  await page.getByLabel("Credential reference change").selectOption("set");
  await page
    .getByLabel("New environment reference")
    .fill("env:NEW_DELIVERY_REFERENCE");
  assert.doesNotMatch(
    await page.getByRole("region", { name: "Changes to save" }).innerText(),
    /NEW_DELIVERY_REFERENCE/,
  );
  await save(page).click();
  await savedOutcome(page);
  assert.equal(await page.getByLabel("New environment reference").count(), 0);
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /NEW_DELIVERY_REFERENCE/,
  );
  await page.getByLabel("Credential reference change").selectOption("clear");
  await save(page).click();
  await savedOutcome(page);
  assert.equal(
    f.service.delivery().configuration(ids.atlas).credentialRef,
    null,
  );
  await page.getByRole("button", { name: "Remove additional check 1" }).click();
  assert.equal(
    await addCheck(page).evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "Remove grant 1" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await grant(page).waitFor();
  await check(page).waitFor();
  // Undo an exact app ID edit and refresh: equivalent reads retain stable row identity.
  await check(page).getByLabel("App ID", { exact: true }).fill("43");
  const fieldId = await check(page).getByLabel("Check name").getAttribute("id");
  await read(page);
  assert.equal(
    await check(page).getByLabel("App ID", { exact: true }).inputValue(),
    "43",
  );
  assert.equal(
    await check(page).getByLabel("Check name").getAttribute("id"),
    fieldId,
  );
  await page.getByRole("button", { name: "Discard changes" }).click();
  for (const viewport of [phone, { width: 390, height: 480 }]) {
    await page.setViewportSize(viewport);
    await noPageOverflow(page);
    await captureBrowserEvidence(
      page,
      `delivery-${viewport.width}x${viewport.height}`,
    );
  }
});

test("Delivery local errors focus the first field and branch adoption offers approval only", async (_t, journey) => {
  const { page } = await startSettings(journey, path, phone);
  await page.getByRole("button", { name: "Add grant", exact: true }).click();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/commands")) posts++;
  });
  await save(page).click();
  const invalid = grant(page).getByLabel("Repository or tracker container ID");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-invalid") === "true",
  );
  assert.equal(
    await invalid.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(posts, 0);
  await invalid.fill("acme/atlas");
  await grant(page)
    .getByLabel("Action", { exact: true })
    .selectOption("branch.adopt");
  assert.deepEqual(
    await grant(page)
      .getByLabel("Authority", { exact: true })
      .locator("option")
      .allTextContents(),
    ["Require approval"],
  );
  await save(page).click();
  await savedOutcome(page);
});

test("Delivery opaque rows and prefix are kept by default, removable and restored by Discard", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path, phone);
  const hidden = "HIDDEN_DELIVERY_TEXT";
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: `env:${hidden}`,
    branchPrefix: hidden,
    grants: [
      { action: "issue.comment", repositoryId: hidden, mode: "approval" },
      {
        action: "issue.labels",
        repositoryId: "acme/atlas",
        mode: "allow",
        optionNodeIds: [],
      },
    ],
    requiredChecks: [{ name: hidden }, { name: "Build" }],
  });
  await read(page);
  await grant(page)
    .getByText("Unavailable saved row · kept until removed")
    .waitFor();
  assert.equal(await levelControl(page).isDisabled(), true);
  assert.equal(
    await page.getByLabel("Branch prefix choice").inputValue(),
    "preserve",
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    new RegExp(hidden),
  );
  await page.getByLabel("Completion mode").selectOption("through-merge");
  const sent = body(page);
  await save(page).click();
  const command = await sent;
  assert.equal(command.preserveBranchPrefix, true);
  assert.doesNotMatch(JSON.stringify(command), new RegExp(hidden));
  assert.equal(Object.hasOwn(command, "branchPrefix"), false);
  await savedOutcome(page);
  assert.equal(
    f.service.delivery().configuration(ids.atlas).branchPrefix,
    hidden,
  );
  await page
    .getByRole("button", { name: "Remove grant 1", exact: true })
    .focus();
  await page.keyboard.press("Space");
  assert.equal(
    await grant(page)
      .getByLabel("Action")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page
    .getByRole("button", { name: "Remove additional check 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await grant(page)
    .getByText("Unavailable saved row · kept until removed")
    .waitFor();
  await page
    .getByRole("button", { name: "Remove grant 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove additional check 1", exact: true })
    .click();
  await save(page).click();
  await savedOutcome(page);
  assert.equal(f.service.delivery().configuration(ids.atlas).grants.length, 1);
  // The first save moved the legacy list, the withheld check included, into the repository's entry.
  assert.deepEqual(
    f.service.delivery().configuration(ids.atlas).requiredChecks,
    [],
  );
  assert.deepEqual(
    f.service.delivery().configuration(ids.atlas).repositories?.[0]
      ?.requiredChecks,
    [{ name: "Build" }],
  );
});

test("Delivery rejection and conflict retain edits until deliberate review or discard", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path);
  await page.getByLabel("Completion mode").selectOption("through-merge");
  await page.route("**/api/operator/commands", (r) =>
    r.fulfill({
      status: 400,
      json: {
        error: {
          code: "invalid-input",
          message: "Check delivery fields.",
          fieldPaths: ["mode"],
        },
      },
    }),
  );
  await save(page).click();
  // A rejected response keeps input regardless of the service's safe error wording.
  await page.getByRole("button", { name: "Discard changes" }).waitFor();
  assert.equal(
    await page.getByLabel("Completion mode").inputValue(),
    "through-merge",
  );
  await page.unroute("**/api/operator/commands");
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: null,
    branchPrefix: "elsewhere/",
    grants: [],
    requiredChecks: [],
  });
  await save(page).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(
    await page.getByLabel("Completion mode").inputValue(),
    "through-merge",
  );
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Completion mode").inputValue(),
    "through-merge",
  );
  assert.equal(
    await page.getByLabel("Branch prefix", { exact: true }).inputValue(),
    "elsewhere/",
  );
  await save(page).click();
  await savedOutcome(page);
});

test("Delivery lost response checks the original receipt before POST after a later credential change", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path);
  await page.getByLabel("Completion mode").selectOption("through-merge");
  let posts = 0,
    gets = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/commands")) posts++;
    if (r.url().includes("/operations?")) gets++;
  });
  await page.route("**/api/operator/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await save(page).click();
  await page.getByText("We couldn't confirm the save.").waitFor();
  assert.equal(await page.getByLabel("Completion mode").isDisabled(), true);
  await page.unroute("**/api/operator/commands");
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: "env:LATER_DELIVERY",
    grants: [],
    requiredChecks: [],
  });
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  await page
    .getByRole("button", { name: "Check whether it saved" })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'select[aria-label="Completion mode"]',
        ) as HTMLSelectElement | null
      )?.value === "reviewable-pr",
  );
  assert.equal(posts, 1);
  assert.equal(gets, 1);
  assert.equal(
    await page.getByLabel("Completion mode").inputValue(),
    "reviewable-pr",
  );
});

test("Delivery not-recorded Check deliberately retries identical frozen bytes; read failure stays unknown", async (_t, journey) => {
  const { page } = await startSettings(journey, path);
  await page.getByLabel("Completion mode").selectOption("through-merge");
  await page.route("**/api/operator/commands", (r) => r.abort());
  const original = body(page);
  await save(page).click();
  const frozen = await original;
  await page.getByText("We couldn't confirm the save.").waitFor();
  await page.route("**/api/operator/operations?*", (r) => r.abort());
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  await page.getByText("We couldn't confirm the save.").waitFor();
  assert.equal(await page.getByLabel("Completion mode").isDisabled(), true);
  await page.unroute("**/api/operator/commands");
  await page.unroute("**/api/operator/operations?*");
  const retry = body(page);
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  assert.deepEqual(await retry, frozen);
  await savedOutcome(page);
});

test("Delivery session expiry purges newly entered references and drafts", async (_t, journey) => {
  const { page, web, f } = await startSettings(journey, path, phone);
  await levelControl(page).selectOption("merge-when-ready");
  await acceptMerge(page).click();
  await page.getByLabel("Credential reference change").selectOption("set");
  await page
    .getByLabel("New environment reference")
    .fill("env:PRIVATE_DRAFT_REFERENCE");
  f.advanceClock(61_000);
  await save(page).click();
  await page.getByLabel("Password").waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /PRIVATE_DRAFT_REFERENCE/,
  );
  await page.unroute("**/api/operator/commands");
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Credential reference change").waitFor();
  assert.equal(
    await page.getByLabel("Credential reference change").inputValue(),
    "preserve",
  );
  assert.equal(await page.getByLabel("New environment reference").count(), 0);
  assert.equal(await levelControl(page).inputValue(), "");
  await levelControl(page).selectOption("merge-when-ready");
  await dialog(page).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("Delivery warns before reducing a public grant while its mapping view is withheld", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path, phone);
  const domain = f.service.domain();
  const hiddenSelection = "HIDDEN_MAPPING_SELECTION";
  domain.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: domain.githubConfiguration(ids.atlas).version,
    selections: [
      { id: hiddenSelection, kind: "project", projectNodeId: "P", filter: "" },
    ],
    readiness: null,
  });
  domain.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: `env:${hiddenSelection}`,
    grants: [
      {
        action: "project.field",
        repositoryId: "R",
        mode: "allow",
        projectNodeId: "P",
        fieldNodeId: "F",
        optionNodeIds: ["O"],
      },
    ],
    requiredChecks: [],
  });
  domain.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: domain.statusMapping(ids.atlas).version,
    mapping: {
      selectionId: hiddenSelection,
      projectNodeId: "P",
      fieldNodeId: "F",
      events: { turnStarted: null, handedBack: null, held: null, done: "O" },
    },
  });
  await read(page);
  await grant(page).getByLabel("Action", { exact: true }).waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    new RegExp(hiddenSelection),
  );
  let posts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/commands"))
      posts++;
  });
  await grant(page)
    .getByLabel("Authority", { exact: true })
    .selectOption("approval");
  await page.getByRole("alert").waitFor();
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "delivery-withheld-mapping-warning");
  assert.equal(posts, 0);
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Remove grant 1", exact: true })
    .click();
  await page.getByRole("alert").waitFor();
  assert.equal(posts, 0);
  await page.getByRole("button", { name: "Discard changes" }).click();
  await grant(page).waitFor();
  await page.getByRole("alert").waitFor({ state: "hidden" });
});

const levelControl = (page: Page) =>
  page.getByLabel("Shepherd level for acme/atlas", { exact: true });
const dialog = (page: Page) => page.getByRole("dialog");
const acceptMerge = (page: Page) =>
  page.getByRole("button", { name: "Allow Merge when ready", exact: true });

test("shepherd levels share the advanced draft and confirm upward changes with keyboard focus", async (_t, journey) => {
  const { page } = await startSettings(journey, path);
  await page
    .getByText("This linked repository has no code-host grants.", {
      exact: true,
    })
    .waitFor();
  const tabs = page.getByRole("navigation", {
    name: "Project configuration sections",
  });
  await tabs.getByRole("link", { name: "General", exact: true }).click();
  await tabs.getByRole("link", { name: "Delivery", exact: true }).click();
  await levelControl(page).selectOption("open-prs");
  await levelControl(page).selectOption("merge-when-ready");
  await dialog(page).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await levelControl(page).inputValue(), "open-prs");
  assert.equal(
    await levelControl(page).evaluate((el) => el === document.activeElement),
    true,
  );
  await levelControl(page).selectOption("merge-when-ready");
  await captureBrowserEvidence(page, "shepherd-confirmation", {
    fullPage: false,
  });
  await acceptMerge(page).click();
  assert.equal(await levelControl(page).inputValue(), "merge-when-ready");
  await captureBrowserEvidence(page, "shepherd-desktop");
  await page.setViewportSize(phone);
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "shepherd-phone");
  await page
    .getByRole("heading", { name: "Repository shepherd levels", exact: true })
    .scrollIntoViewIfNeeded();
  await captureBrowserEvidence(page, "shepherd-phone-controls", {
    fullPage: false,
  });
  const request = body(page);
  await save(page).click();
  await request;
  await savedOutcome(page);
  assert.equal(await dialog(page).count(), 0);
  await levelControl(page).selectOption("merge-with-approval");
  assert.equal(await dialog(page).count(), 0);
  await levelControl(page).selectOption("open-prs");
  assert.equal(await dialog(page).count(), 0);
  await grant(page)
    .getByLabel("Authority", { exact: true })
    .selectOption("approval");
  await page
    .getByRole("region", { name: "Repository acme/atlas", exact: true })
    .getByText("Custom", { exact: true })
    .waitFor();
  assert.equal(
    await grant(page).getByLabel("Authority", { exact: true }).inputValue(),
    "approval",
  );
  await levelControl(page).selectOption("open-prs");
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  assert.equal(await levelControl(page).inputValue(), "merge-when-ready");
  await page.getByLabel("Completion mode").selectOption("reviewable-pr");
  await page
    .getByText(
      "Completion mode is Reviewable PR, so the lead stops at a reviewable pull request.",
      { exact: true },
    )
    .waitFor();
});

test("advanced edits use the same upward warning and refresh invalidates a pending proposal", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path);
  await levelControl(page).selectOption("merge-with-approval");
  await grant(page, 8)
    .getByLabel("Authority", { exact: true })
    .selectOption("allow");
  await save(page).click();
  await dialog(page).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await levelControl(page).inputValue(), "merge-when-ready");
  await save(page).click();
  await acceptMerge(page).click();
  await savedOutcome(page);
  await levelControl(page).selectOption("open-prs");
  await levelControl(page).selectOption("merge-when-ready");
  await dialog(page).waitFor();
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: [],
    requiredChecks: [],
  });
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /configuration$/.test(response.url()),
  );
  await page
    .getByRole("button", { name: "Refresh", exact: true, includeHidden: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await refreshed;
  await dialog(page).waitFor({ state: "hidden" });
  await levelControl(page).selectOption("merge-when-ready");
  await dialog(page).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await levelControl(page).inputValue(), "open-prs");
});

test("bulk targets the complete saved link snapshot and cancels without editing", async (_t, journey) => {
  const { page } = await startSettings(journey, path, phone);
  let linkVersion = 0;
  await page.route("**/projects/*/configuration", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.repositories.version += linkVersion;
    json.data.repositories.links.push({
      repositoryId: "42",
      codeHost: "gitlab",
      host: "gitlab.example",
      ref: "main",
    });
    await route.fulfill({ response, json });
  });
  await read(page);
  await page
    .getByRole("region", { name: "Repository 42", exact: true })
    .getByText("Not set up", { exact: true })
    .waitFor();
  const bulk = page.getByRole("button", {
    name: "Apply to all linked repositories",
    exact: true,
  });
  assert.equal(await bulk.isDisabled(), true);
  await page
    .getByLabel("Level for all linked repositories", { exact: true })
    .selectOption("merge-when-ready");
  await bulk.click();
  await dialog(page).getByText("acme/atlas, 42", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await levelControl(page).inputValue(), "");
  await bulk.click();
  await dialog(page).waitFor();
  linkVersion++;
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /configuration$/.test(response.url()),
  );
  await page
    .getByRole("button", { name: "Refresh", exact: true, includeHidden: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await refreshed;
  await dialog(page).waitFor({ state: "hidden" });
  assert.equal(await levelControl(page).inputValue(), "");
  await bulk.click();
  await acceptMerge(page).click();
  assert.equal(
    await page
      .getByLabel("Shepherd level for 42", { exact: true })
      .inputValue(),
    "merge-when-ready",
  );
  assert.equal(await levelControl(page).inputValue(), "merge-when-ready");
  await noPageOverflow(page);
  const sent = body(page);
  await save(page).click();
  assert.equal((await sent).type, "delivery.configure");
  await savedOutcome(page);
});

test("preset unknown saves retain frozen bytes and reconcile without confirmation", async (_t, journey) => {
  const { page } = await startSettings(journey, path);
  await levelControl(page).selectOption("merge-when-ready");
  await acceptMerge(page).click();
  await page.route("**/api/operator/commands", (route) => route.abort());
  const original = body(page);
  await save(page).click();
  const frozen = await original;
  await page.getByText("We couldn't confirm the save.").waitFor();
  assert.equal(await levelControl(page).isDisabled(), true);
  assert.equal(await dialog(page).count(), 0);
  await page.unroute("**/api/operator/commands");
  const retry = body(page);
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  assert.deepEqual(await retry, frozen);
  await savedOutcome(page);
  assert.equal(await dialog(page).count(), 0);
});

test("bulk refuses overflow atomically and withheld links cannot be silently skipped", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path);
  f.service.domain().execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: Array.from({ length: 250 }, () => ({
      action: "issue.comment" as const,
      repositoryId: "tracker",
      mode: "allow" as const,
    })),
    requiredChecks: [],
  });
  await read(page);
  await page
    .getByLabel("Level for all linked repositories", { exact: true })
    .selectOption("open-prs");
  const bulk = page.getByRole("button", {
    name: "Apply to all linked repositories",
    exact: true,
  });
  await bulk.click();
  await page
    .getByText(
      "This level would exceed 256 grants. Remove grants or select fewer repositories.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await levelControl(page).inputValue(), "");
  assert.equal(await save(page).isDisabled(), true);
  await page.route("**/projects/*/configuration", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data.repositories.links[0] = {
      repositoryId: null,
      codeHost: "github",
      host: null,
      ref: null,
      savedRow: {
        projectId: ids.atlas,
        section: "repositories",
        version: json.data.repositories.version,
        index: 0,
      },
    };
    await route.fulfill({ response, json });
  });
  await read(page);
  await page.getByText("Unavailable repository", { exact: true }).waitFor();
  assert.equal(await bulk.isDisabled(), true);
  assert.equal(
    await page
      .getByLabel("Shepherd level for unavailable", { exact: true })
      .isDisabled(),
    true,
  );
});

test("the stacking switch states what it risks and saves without resetting the policy draft", async (_t, journey) => {
  const { page, f, ids } = await startSettings(journey, path);
  const stacking = page.getByRole("switch", {
    name: "Start dependents on their blocker's change request",
  });
  await stacking.waitFor();
  assert.equal(await stacking.isChecked(), false);
  const text = await page.locator("body").innerText();
  assert.match(
    text,
    /Stacking is off: dependents wait until their blockers are Done\./,
  );
  assert.match(
    text,
    /Dependents start on their blocker's unmerged work, and a merge cannot be undone\./,
  );
  assert.match(text, /Applies to dependents that have not started/);
  const saveStacking = page.getByRole("button", {
    name: "Save stacking",
    exact: true,
  });
  assert.equal(await saveStacking.isDisabled(), true);

  // An unsaved policy edit stays while the switch saves on its own.
  await page.getByLabel("Completion mode").selectOption("through-merge");
  await stacking.check();
  await captureBrowserEvidence(page, "delivery-stacking");
  const command = body(page);
  await saveStacking.click();
  const sent = await command;
  assert.deepEqual(Object.keys(sent).sort(), [
    "expectedVersion",
    "key",
    "projectId",
    "stacking",
    "type",
  ]);
  assert.equal(sent.type, "project.configure");
  assert.equal(sent.stacking, true);
  await savedOutcome(page);
  assert.equal(f.service.domain().stacking(ids.atlas), true);
  await page.getByText("Stacking is on:").waitFor();
  assert.equal(
    await page.getByLabel("Completion mode").inputValue(),
    "through-merge",
  );
  assert.equal(await save(page).isDisabled(), false);
});

test("each repository edits its merge method and additional checks, with suggestions and a no-checks warning", async (_t, journey) => {
  const { page, f, ids } = await startSettings(
    journey,
    path,
    undefined,
    undefined,
    {
      serviceOptions: {
        delivery: {
          providerFactories: {
            github: () =>
              ({
                repositoryRequirements: async () => ({
                  hostChecks: [],
                  allowedMethods: ["merge", "squash"],
                }),
              }) as never,
          },
        },
      },
    },
  );
  // A PR observation on the repository names a check cab doesn't require yet.
  const taskId = randomUUID();
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    taskId,
    title: "Observed",
    outcome: "O",
  });
  f.seedPersistedState((db) =>
    db.prepare("INSERT INTO delivery_observations VALUES (?, ?, ?, ?)").run(
      taskId,
      "d".repeat(64),
      JSON.stringify({
        repositoryId: "acme/atlas",
        checks: [{ name: "lint" }, { name: "build" }],
      }),
      1,
    ),
  );
  await read(page);
  const settings = page.getByRole("group", {
    name: "Merge settings for acme/atlas",
  });
  const warning = settings
    .getByRole("alert")
    .filter({ hasText: "No required checks" });
  await warning.waitFor();
  assert.match(
    await warning.innerText(),
    /^No required checks: neither GitHub nor cab/,
  );
  await settings
    .getByText("GitHub requires no checks before merging.", { exact: true })
    .waitFor();
  const method = page.getByLabel("Merge method for acme/atlas", {
    exact: true,
  });
  assert.deepEqual(await method.locator("option").allTextContents(), [
    "Not set",
    "Merge commit",
    "Squash",
    "Rebase",
  ]);
  await settings
    .getByText(
      "The default branch allows: merge commit, squash. Merges into other branches follow their own rules.",
      { exact: true },
    )
    .waitFor();
  await settings
    .getByText(
      "No merge method is set, so cab holds every merge for this repository.",
    )
    .waitFor();
  // A method the default branch doesn't allow is a warning, not a refusal: a PR may target another branch.
  await method.selectOption("rebase");
  await settings
    .getByRole("alert")
    .filter({ hasText: "The default branch doesn't allow rebase" })
    .waitFor();
  await page.getByRole("button", { name: "Add lint", exact: true }).click();
  assert.equal(await check(page).getByLabel("Check name").inputValue(), "lint");
  assert.equal(await warning.count(), 0);
  assert.equal(await page.getByRole("button", { name: "Add lint" }).count(), 0);
  const command = body(page);
  await save(page).click();
  const sent = await command;
  assert.deepEqual(sent.repositories, [
    {
      repositoryId: "acme/atlas",
      mergeMethod: "rebase",
      requiredChecks: [{ name: "lint" }],
    },
  ]);
  await savedOutcome(page);
  const saved = f.service.delivery().configuration(ids.atlas);
  assert.deepEqual(saved.requiredChecks, []);
  assert.deepEqual(saved.repositories, [
    {
      repositoryId: "acme/atlas",
      mergeMethod: "rebase",
      requiredChecks: [{ name: "lint" }],
    },
  ]);
  for (const other of [ids.relay, ids.fieldnotes])
    assert.deepEqual(
      f.service.delivery().configuration(other).repositories,
      [],
    );
  await page.evaluate(() => window.scrollTo(0, 0));
  await captureBrowserEvidence(page, "delivery-repository-checks");
});
