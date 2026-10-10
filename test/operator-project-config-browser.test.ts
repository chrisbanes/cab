import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { OperatorApi } from "../src/standalone/operator-api.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  createCheckout,
  noPageOverflow,
  phone,
  startSettings,
  trail,
} from "./fixtures/operator-settings.js";

const test = browserSuite("ui08-settings-project");
const changes = (page: Page) =>
  page.getByRole("region", { name: "Changes to save" });
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
  await status.getByText(/General version \d+/).waitFor();
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
  await status.getByText(/General saved \d\d:\d\d/).waitFor();
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
  await page.getByText("Configuration changed.", { exact: false }).waitFor();
  assert.equal(await name.inputValue(), "Atlas typed");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".settings-status").getByText("Paused").waitFor();
  await page
    .getByRole("button", { name: "Review latest project revision" })
    .click();
  assert.equal(await name.inputValue(), "Atlas typed");
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
  await page
    .getByText("Submission rejected. Your input is retained.")
    .waitFor();
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
    await page.getByText("Outcome unknown.", { exact: false }).waitFor();
    assert.equal(await name.isDisabled(), true);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandBody(page);
  await page
    .getByRole("button", { name: "Reconcile exact submission" })
    .click();
  assert.equal((await replay).key, key);
  await page
    .locator(".settings-status")
    .getByText(/General saved/)
    .waitFor();
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
    .getByText("Nothing needs attention here.")
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
  await page.getByText("Saved routing for Relay ·", { exact: false }).waitFor();
  assert.equal(Number(d.routing(ids.relay).version), version + 1);
  assert.equal(d.routing(ids.relay).guidance, "PRIVATE ROUTING GUIDANCE");
  const aside = page.getByRole("region", { name: "Saved routing" });
  await aside.getByText(/Saved · \d\d:\d\d/).waitFor();
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

test("Routing conflict keeps the checked candidates until the latest revision is adopted", async (_t, journey) => {
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
  await page.getByText("Configuration changed.", { exact: false }).waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .locator(".settings-status")
    .getByText("Routing version 3")
    .waitFor();
  await page
    .getByRole("button", { name: "Review latest routing revision" })
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
    await page
      .getByLabel("Credential reference change", { exact: true })
      .inputValue(),
    "preserve",
  );
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
    .getByText(/GitHub source saved \d\d:\d\d · credential configured/)
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
  await page.getByText("Saved GitHub source ·", { exact: false }).waitFor();
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
  await page.getByText("Saved GitHub source ·", { exact: false }).waitFor();
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

test("GitHub source conflict keeps rows and an unknown save reconciles once", async (_t, journey) => {
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
    ],
    readiness: { mode: "any", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Configuration changed.", { exact: false }).waitFor();
  await page.getByText("Will be removed").waitFor();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .locator(".settings-status")
    .getByText("GitHub source version 3", { exact: false })
    .waitFor();
  await page
    .getByRole("button", { name: "Review latest source revision" })
    .click();
  await page.getByText("Will be removed").waitFor();
  const version = d.githubConfiguration(ids.atlas).version;
  await page.route("**/api/operator/commands", (r) => r.abort());
  let first: Record<string, unknown> | undefined;
  try {
    const body = commandBody(page);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    first = await body;
    await page.getByText("Outcome unknown.", { exact: false }).waitFor();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  const replay = commandBody(page);
  await page
    .getByRole("button", { name: "Reconcile exact submission" })
    .click();
  assert.deepEqual(await replay, first);
  await page.getByText("Saved GitHub source ·", { exact: false }).waitFor();
  assert.equal(d.githubConfiguration(ids.atlas).version, version + 1);
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
