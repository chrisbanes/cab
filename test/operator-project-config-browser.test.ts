import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Page } from "playwright";
import { OperatorApi } from "../src/standalone/operator-api.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  createCheckout,
  noPageOverflow,
  outcomeMessages,
  phone,
  savedOutcome,
  startSettings,
  trail,
} from "./fixtures/operator-settings.js";

const test = browserSuite("ui08-settings-project");
const changes = (page: Page) =>
  page.getByRole("region", { name: "Changes to save" });
/** Press the header Refresh and wait until the re-read has rendered. */
const refresh = async (page: Page) => {
  const read = page.waitForResponse(
    (r) => r.request().method() === "GET" && /configuration$/.test(r.url()),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await read;
  await page.getByText("Refreshing.", { exact: false }).waitFor({
    state: "hidden",
  });
};
const commandBody = (page: Page) =>
  page
    .waitForRequest(
      (r) =>
        r.method() === "POST" && r.url().endsWith("/api/operator/commands"),
    )
    .then((r) => r.postDataJSON() as Record<string, unknown>);

test("General tab edits in place with a change list, saved line and tabs that keep drafts", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const d = f.service.domain();
  await page
    .getByRole("heading", { level: 1, name: "Atlas · project configuration" })
    .waitFor();
  assert.equal(await trail(page), "Settings / Projects / Atlas");
  const status = page.locator(".settings-status");
  await status.getByText("Enabled").waitFor();
  await status.getByText("Existing admission rules still apply.").waitFor();
  assert.doesNotMatch(await status.innerText(), /version|\d\d:\d\d/);
  const tabs = page.getByRole("navigation", {
    name: "Project configuration sections",
  });
  assert.equal(await tabs.getByRole("link").count(), 4);
  assert.equal(
    await tabs
      .getByRole("link", { name: "General" })
      .getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas",
  );
  await page.getByRole("switch", { name: "Pause project" }).waitFor();
  assert.equal(
    await page.getByLabel("Replace instructions", { exact: true }).isChecked(),
    false,
  );
  await page
    .getByText("Current private instructions are never loaded into this form", {
      exact: false,
    })
    .waitFor();
  const save = page.getByRole("button", { name: "Save project", exact: true });
  assert.equal(await save.isDisabled(), true);
  const references = page.locator(".settings-panel", {
    hasText: "Credential and environment references",
  });
  assert.equal(
    await references
      .getByRole("link", { name: "Change in Routing" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}/settings?tab=routing`,
  );
  assert.equal(
    await references
      .getByRole("link", { name: "Change in GitHub source" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}/settings?tab=github`,
  );
  assert.equal(
    await references
      .getByRole("link", { name: "Open advanced editor" })
      .getAttribute("href"),
    `/project/${ids.atlas}`,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "Project tasks" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}`,
  );
  await captureBrowserEvidence(page, "1366-project-general");
  await page.getByLabel("Project name", { exact: true }).fill("Atlas II");
  await changes(page).getByText("Project name: Atlas → Atlas II").waitFor();
  await tabs.getByRole("link", { name: "Routing" }).click();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  await tabs.getByRole("link", { name: "General" }).click();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas II",
  );
  await changes(page).getByText("Project name: Atlas → Atlas II").waitFor();
  const version = Number(d.project(ids.atlas).version);
  await save.click();
  await status.getByText(/Saved \d\d:\d\d/).waitFor();
  await savedOutcome(page);
  assert.equal((await status.innerText()).match(/Saved \d\d:\d\d/g)?.length, 1);
  assert.equal(Number(d.project(ids.atlas).version), version + 1);
  assert.equal(d.project(ids.atlas).name, "Atlas II");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save project" && b.disabled,
    ),
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas II",
  );
  await page.getByLabel("Replace instructions", { exact: true }).check();
  await page
    .getByLabel("New instructions", { exact: true })
    .fill("PRIVATE REPLACED PROJECT");
  await save.click();
  await page
    .getByLabel("New instructions", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(d.project(ids.atlas).instructions, "PRIVATE REPLACED PROJECT");
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  assert.equal((await page.content()).includes("PRIVATE"), false);
});

test("General tab validation, conflict and revoked-lead failures keep input", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const name = page.getByLabel("Project name", { exact: true });
  await name.waitFor();
  await name.fill("");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("Check this field.").first().waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Project name",
  );
  await name.fill("Atlas typed");
  f.service.domain().execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(f.service.domain().project(ids.atlas).version),
    paused: true,
  });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(await name.inputValue(), "Atlas typed");
  await refresh(page);
  await page.locator(".settings-status").getByText("Paused").waitFor();
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(await name.inputValue(), "Atlas typed");
  // The untouched pause takes the newer revision instead of undoing it.
  assert.equal(
    await page.getByRole("switch", { name: "Pause project" }).isChecked(),
    true,
  );
  assert.equal(
    (await changes(page).innerText()).includes("Unpause project"),
    false,
  );
  const d = f.service.domain();
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profiles.Jonas as string,
    expectedVersion: Number(d.profile(ids.profiles.Jonas as string).version),
    revoked: true,
  });
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Jonas" });
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByText("Couldn't save. Your changes are still here.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(await name.inputValue(), "Atlas typed");
});

test("an unknown save freezes the form until the exact submission is reconciled", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
  );
  const name = page.getByLabel("Project name", { exact: true });
  await name.waitFor();
  await name.fill("Atlas unknown");
  await page.route("**/api/operator/commands", (r) => r.abort());
  let key: unknown;
  try {
    const body = commandBody(page);
    await page
      .getByRole("button", { name: "Save project", exact: true })
      .click();
    key = (await body).key;
    await page.getByText("We couldn't confirm the save.").waitFor();
    assert.equal(await outcomeMessages(page).count(), 1);
    assert.equal(await name.isDisabled(), true);
    // The Save button is gone, so focus moves to the one action instead of the page body.
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Check whether it saved",
    );
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandBody(page);
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  assert.equal((await replay).key, key);
  await page
    .locator(".settings-status")
    .getByText(/Saved \d\d:\d\d/)
    .waitFor();
  await savedOutcome(page);
  assert.equal(f.service.domain().project(ids.atlas).name, "Atlas unknown");
});

test("phone project settings lead with state and next step and keep the form usable", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings",
    phone,
  );
  await page.getByRole("link", { name: "Back to Settings" }).waitFor();
  const state = page.getByRole("region", { name: "Current state" });
  await state.getByText("Lead: Mira · repository access: acme/atlas").waitFor();
  await state.getByText("GitHub S-1 inactive", { exact: false }).waitFor();
  await page
    .getByRole("region", { name: "Next step" })
    .getByText(
      "Set or change the credential in GitHub source settings, then preview this source version.",
    )
    .waitFor();
  await page.getByLabel("Project name", { exact: true }).fill("Atlas phone");
  await changes(page).getByText("Project name: Atlas → Atlas phone").waitFor();
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-project");
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.waitForFunction(
    () => !document.querySelector(".settings-phone-cards")?.checkVisibility(),
  );
});

test("Routing saves candidates in place without sending guidance, and replaces guidance only on request", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  await page.getByRole("switch", { name: "Enable routing" }).waitFor();
  assert.equal(await trail(page), "Settings / Projects / Relay / Routing");
  await page
    .locator(".settings-status")
    .getByText("Routing changes do not resume Relay.", { exact: false })
    .waitFor();
  const candidate = (name: string) =>
    page.getByRole("checkbox", { name: new RegExp(`^${name} ·`) });
  for (const name of ["Eli", "Builder", "Worker"])
    assert.equal(await candidate(name).isChecked(), true, name);
  for (const name of ["Mira", "Jonas", "Nora"])
    assert.equal(await candidate(name).isChecked(), false, name);
  assert.equal(await candidate("Reviewer").isDisabled(), true);
  await page.getByText("Reviewer · Review (revoked)").waitFor();
  assert.equal(
    await page.getByLabel("Replace routing guidance").isChecked(),
    false,
  );
  assert.equal((await page.content()).includes("PRIVATE"), false);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.relay}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  const save = page.getByRole("button", { name: "Save routing", exact: true });
  assert.equal(await save.isDisabled(), true);
  await candidate("Mira").check();
  await changes(page).getByText("Candidate added: Mira").waitFor();
  await captureBrowserEvidence(page, "1366-routing");
  const version = Number(d.routing(ids.relay).version);
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.equal("guidance" in sent, false);
  assert.equal((sent.candidateProfileIds as string[]).length, 4);
  const saved = await savedOutcome(page);
  await saved
    .getByText(
      /^Saved\. Routing now uses (?=.*Mira)(?=.*Eli)(?=.*Builder)(?=.*Worker)/,
    )
    .waitFor();
  assert.equal(
    (
      (await page.locator(".settings-status").innerText()).match(
        /Saved \d\d:\d\d/g,
      ) ?? []
    ).length,
    1,
  );
  assert.equal(Number(d.routing(ids.relay).version), version + 1);
  assert.equal(d.routing(ids.relay).guidance, "PRIVATE ROUTING GUIDANCE");
  const aside = page.getByRole("region", { name: "Saved routing" });
  await aside.getByRole("heading", { name: "Saved routing" }).waitFor();
  assert.doesNotMatch(await aside.innerText(), /\d\d:\d\d|version/);
  await aside
    .getByText(/^Candidates: (?=.*Mira)(?=.*Eli)(?=.*Builder)(?=.*Worker)/)
    .waitFor();
  await aside
    .getByText("Guidance: private · not loaded into this form")
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save routing" && b.disabled,
    ),
  );
  await captureBrowserEvidence(page, "1366-routing-saved");
  await page.getByLabel("Replace routing guidance").check();
  await page
    .getByLabel("New routing guidance", { exact: true })
    .fill("NEW PRIVATE GUIDANCE");
  const replaced = commandBody(page);
  await save.click();
  assert.equal((await replaced).guidance, "NEW PRIVATE GUIDANCE");
  await page
    .getByLabel("New routing guidance", { exact: true })
    .waitFor({ state: "detached" });
  assert.equal(d.routing(ids.relay).guidance, "NEW PRIVATE GUIDANCE");
  await page.getByRole("switch", { name: "Enable routing" }).uncheck();
  await changes(page).getByText("Routing disabled").waitFor();
  await page
    .getByLabel("Credential reference change", { exact: true })
    .selectOption({ label: "Set new environment reference" });
  await page
    .getByLabel("New environment reference", { exact: true })
    .fill("env:FIXTURE_X");
  await changes(page)
    .getByText("Credential reference: set new environment reference")
    .waitFor();
  await page.route("**/api/operator/commands", () => {});
  try {
    await save.click();
    await page.getByRole("button", { name: "Saving…" }).waitFor();
    assert.equal(
      await page.getByRole("switch", { name: "Enable routing" }).isDisabled(),
      true,
    );
  } finally {
    await page.unroute("**/api/operator/commands");
  }
});

test("Routing conflict keeps the checked candidates until the newer version is reviewed", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  const d = f.service.domain();
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
});

test("GitHub source keeps saved rows private and sends keep markers for in-place edits", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page.getByRole("heading", { name: "1 · Discovery sources" }).waitFor();
  await page.getByText("S-1 · Repository").waitFor();
  await page.getByText("Private query kept").waitFor();
  await page.getByText("PVT_atlas · Filter kept · private").waitFor();
  await page.getByText("Local path: Kept · private").waitFor();
  const html = await page.content();
  for (const secret of ["PRIVATE", "atlas-checkout", "FIXTURE_GITHUB"])
    assert.equal(html.includes(secret), false, secret);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  assert.equal((await read.text()).includes("PRIVATE"), false);
  assert.equal(
    await page.getByLabel("Source credential choice", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.getByRole("button", { name: "Remove S-3" }).click();
  await page.getByText("Will be removed").waitFor();
  await changes(page).getByText("− S-3 · GitHub Project PVT_atlas").waitFor();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Selection kind", { exact: true })
    .selectOption({ label: "Search" });
  await page
    .getByLabel("Search query", { exact: true })
    .fill("PRIVATE NEW QUERY");
  await page.getByText("New · inactive").waitFor();
  await changes(page)
    .getByText("+ S-4 · Search (query private) · added inactive")
    .waitFor();
  assert.equal((await changes(page).innerText()).includes("PRIVATE"), false);
  await captureBrowserEvidence(page, "1366-source");
  const pathBefore = d.githubConfiguration(ids.atlas).repositories[0]?.path;
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-4", kind: "search", query: "PRIVATE NEW QUERY" },
  ]);
  assert.deepEqual(sent.repositories, [
    { repositoryId: "acme/atlas", ref: "main" },
  ]);
  await page
    .locator(".settings-status")
    .getByText(/Saved \d\d:\d\d · Environment reference · unavailable/)
    .waitFor();
  const saved = d.githubConfiguration(ids.atlas);
  assert.deepEqual(
    saved.selections.map((s) => s.id),
    ["S-1", "S-2", "S-4"],
  );
  assert.equal(
    saved.selections.find((s) => s.id === "S-2" && s.kind === "search")?.kind,
    "search",
  );
  assert.equal(saved.repositories[0]?.path, pathBefore);
  await page.getByText("S-4 · Search").waitFor();
});

test("removing all repository access needs confirmation and Discard restores the row", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await page
    .getByRole("button", { name: "Remove repository acme/atlas" })
    .click();
  const confirm = page.getByLabel("Remove all repository access");
  await confirm.waitFor();
  assert.equal(await confirm.isChecked(), false);
  assert.equal(await save.isDisabled(), true);
  // The checkbox is the only confirmation: the consequence is a change-list line, never an alert.
  await changes(page)
    .getByText("Removes every repository from Atlas.", { exact: true })
    .waitFor();
  assert.equal(await changes(page).getByRole("alert").count(), 0);
  assert.equal(await outcomeMessages(page).count(), 0);
  await confirm.check();
  assert.equal(await save.isEnabled(), true);
  await captureBrowserEvidence(page, "1366-source-remove-all");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByText("Local path: Kept · private").waitFor();
  assert.equal(await confirm.count(), 0);
  await page
    .getByRole("button", { name: "Remove repository acme/atlas" })
    .click();
  await confirm.check();
  await save.click();
  await savedOutcome(page);
  assert.deepEqual(
    f.service.domain().githubConfiguration(ids.atlas).repositories,
    [],
  );
});

test("GitHub source repository and readiness errors focus the exact row without echo", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  await page.getByRole("button", { name: "Add repository" }).click();
  await page
    .getByLabel("Linked repository ID", { exact: true })
    .fill("acme/extra");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill("relative/PRIVATE-PATH");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .locator("#source-repositories-error")
    .getByText("Check linked repository IDs, paths and refs.")
    .waitFor();
  assert.equal(
    await page
      .getByLabel("New local repository path", { exact: true })
      .inputValue(),
    "relative/PRIVATE-PATH",
  );
  assert.equal(
    (await page.locator(".settings-page [role=alert]").allInnerTexts())
      .join(" ")
      .includes("PRIVATE"),
    false,
  );
  const checkout = await createCheckout(f.directory, "extra-checkout");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill(checkout);
  await page
    .getByLabel("Linked repository ref", { exact: true })
    .last()
    .fill("HEAD");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.equal(
    f.service.domain().githubConfiguration(ids.atlas).repositories.length,
    2,
  );
  await page
    .getByLabel("Readiness matching", { exact: true })
    .selectOption({ label: "Any condition" });
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.activeElement?.id === "source-conditions-1-name" &&
      document.activeElement.getAttribute("aria-describedby") ===
        "source-conditions-error",
  );
  await page
    .locator("#source-conditions-error")
    .getByText("Check readiness mode and complete conditions.")
    .waitFor();
});

test("GitHub source conflict keeps rows and an unknown save is checked once", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page.getByRole("button", { name: "Remove S-3" }).click();
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
      { id: "S-5", kind: "search", query: "PRIVATE ELSEWHERE" },
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  await page.getByText("Will be removed").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.getByText("Will be removed").waitFor();
  // The source saved elsewhere joins the form as a kept row instead of being dropped.
  await page.getByText("S-5 · Search").waitFor();
  assert.equal((await changes(page).innerText()).includes("S-5"), false);
  const version = d.githubConfiguration(ids.atlas).version;
  await page.route("**/api/operator/commands", (r) => r.abort());
  let first: Record<string, unknown> | undefined;
  try {
    const body = commandBody(page);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    first = await body;
    await page.getByText("We couldn't confirm the save.").waitFor();
    assert.equal(await outcomeMessages(page).count(), 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandBody(page);
  await page.getByRole("button", { name: "Check whether it saved" }).click();
  assert.deepEqual(await replay, first);
  await savedOutcome(page);
  assert.equal(d.githubConfiguration(ids.atlas).version, version + 1);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).selections.map((s) => s.id),
    ["S-1", "S-2", "S-5"],
  );
});

test("an unknown source save with rows removed elsewhere keeps its one action and message", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  await page.getByRole("button", { name: "Remove S-3" }).click();
  await page.route("**/api/operator/commands", (r) => r.abort());
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("We couldn't confirm the save.").waitFor();
  // S-2 is removed elsewhere while the save is unsettled; the form keeps its kept row.
  const d = f.service.domain();
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await refresh(page);
  await page.getByText("S-2 is no longer saved", { exact: false }).waitFor();
  // Exactly one action: the unknown outcome's check, never a second way to review.
  assert.equal(
    await page.getByRole("button", { name: "Review changes" }).count(),
    0,
  );
  const unknown = outcomeMessages(page);
  assert.equal(await unknown.count(), 1);
  assert.equal(await unknown.getByRole("button").count(), 1);
  await unknown
    .getByRole("button", { name: "Check whether it saved" })
    .waitFor();
  assert.equal(
    (await unknown.locator("p").innerText()).trim(),
    "We couldn't confirm the save.",
  );
});

test("a re-read of another writer's routing retires the saved line", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  const saved = await savedOutcome(page);
  await saved.getByText(/^Saved\. Routing now uses .*Nora/).waitFor();
  // A plain re-read of the same version keeps the confirmation.
  await refresh(page);
  await savedOutcome(page, /^Saved\. Routing now uses .*Nora/);
  // Another writer saves routing, and the next re-read must not describe it as this save.
  const d = f.service.domain();
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  await refresh(page);
  await page
    .getByRole("region", { name: "Saved routing" })
    .getByText("Candidates: Eli", { exact: true })
    .waitFor();
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.doesNotMatch(
    await page.locator(".settings-status").innerText(),
    /Saved \d\d:\d\d/,
  );
});

test("another writer committing between a routing save and its re-read is not described as saved", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  // Hold the re-read that follows the save until another writer has committed.
  let held!: () => void, release!: () => void;
  const reread = new Promise<void>((resolve) => (held = resolve));
  const writer = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/api/operator/projects/*/configuration",
    async (route) => {
      held();
      await writer;
      await route.continue();
    },
  );
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await reread;
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  release();
  await page
    .getByRole("region", { name: "Saved routing" })
    .getByText("Candidates: Eli", { exact: true })
    .waitFor();
  // The form shows the other writer's version, so nothing claims it was this save.
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.doesNotMatch(
    await page.locator(".settings-status").innerText(),
    /Saved \d\d:\d\d/,
  );
  await page
    .getByRole("button", { name: "Save routing", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    false,
  );
});

test("Sync & placement shows preview, observations and the placement status line", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=sync",
  );
  await page.getByRole("heading", { name: "Preview and activation" }).waitFor();
  await page
    .locator(".settings-status")
    .getByText("No placement conflicts.")
    .waitFor();
  await page.getByLabel("Selection to preview", { exact: true }).waitFor();
  await page
    .getByRole("button", {
      name: "Request installation-wide source observations",
    })
    .waitFor();
  await captureBrowserEvidence(page, "1366-sync");
});

test("a repository link saved elsewhere under the same id needs an explicit choice", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/app/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const mine = await createCheckout(f.directory, "mine-checkout"),
    theirs = await createCheckout(f.directory, "theirs-checkout");
  await page.getByRole("button", { name: "Add repository" }).click();
  await page
    .getByLabel("Linked repository ID", { exact: true })
    .fill("acme/new");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill(mine);
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [
      { repositoryId: "acme/atlas", ref: "main" },
      { repositoryId: "acme/new", path: theirs, ref: "main" },
    ],
  });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.getByText("acme/new is linked twice", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await page
    .getByRole("button", { name: "Remove new repository acme/new" })
    .click();
  assert.equal(await save.isDisabled(), true, "nothing left to save");
  const saved = d.githubConfiguration(ids.atlas).repositories;
  assert.equal(
    saved.find((r) => r.repositoryId === "acme/new")?.path,
    await realpath(theirs),
  );
  assert.equal((await page.content()).includes("theirs-checkout"), false);
});
