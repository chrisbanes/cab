import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createFakeGlab } from "../fixtures/fake-glab.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import {
  captureSettingsEvidence as captureBrowserEvidence,
  createCheckout,
  outcomeMessages,
  phone,
  resolve,
  savedOutcome,
  startSettings,
  unpairedBadges,
} from "../fixtures/operator-settings.js";
import {
  changes,
  refresh,
  showsText,
  revealReads,
  settled,
  commandBody,
  leaveAndReturn,
  noChanges,
  holdReads,
  watchPosts,
  assertOnHold,
  assertOffHold,
  assertClean,
  startDiscovery,
} from "../fixtures/project-config-browser.js";

const test = browserSuite("operator-project-config-sources-browser");

test("GitHub source shows search queries plainly and edits them in place", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page.getByRole("heading", { name: "1 · Discovery sources" }).waitFor();
  await page
    .getByRole("heading", { name: "acme/atlas · repository issues" })
    .waitFor();
  await page.getByText("Filter kept · private").waitFor();
  const query = page.getByLabel("Search query", { exact: true });
  await query.waitFor();
  assert.equal(await query.inputValue(), "PRIVATE SAVED QUERY");
  assert.equal(await revealReads(page), 1, "loaded once with the tab");
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  // Project filters and credential values stay hidden.
  for (const secret of ["PRIVATE FILTER", "FIXTURE_GITHUB"])
    assert.equal(await showsText(page, secret), false, secret);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  const config = await read.text();
  for (const secret of ["PRIVATE", "atlas-checkout"])
    assert.equal(config.includes(secret), false, secret);
  assert.equal(
    await page.getByLabel("Source credential choice", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "Change source credential" })
    .waitFor();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true, "showing values is no change");
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
  await page.getByText("Will be removed").waitFor();
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Selection kind", { exact: true })
    .selectOption({ label: "Search" });
  await query.last().fill("PRIVATE NEW QUERY");
  await page.getByText("Not saved yet").waitFor();
  await query.first().fill("PRIVATE EDITED QUERY");
  const lines = await changes(page).getByRole("listitem").allInnerTexts();
  assert.deepEqual(lines, [
    "Search query edited for S-2",
    "− S-3 · GitHub Project PVT_atlas",
    "+ S-4 · Search · added inactive",
  ]);
  assert.equal(lines.join(" ").includes("PRIVATE"), false);
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", kind: "search", query: "PRIVATE EDITED QUERY" },
    { id: "S-4", kind: "search", query: "PRIVATE NEW QUERY" },
  ]);
  assert.equal("repositories" in sent, false);
  await page
    .locator(".settings-status")
    .getByText(/Saved \d\d:\d\d · Environment reference · unavailable/)
    .waitFor();
  const saved = d.githubConfiguration(ids.atlas);
  assert.deepEqual(
    saved.selections.map((s) => s.id),
    ["S-1", "S-2", "S-4"],
  );
  const search = saved.selections.find((s) => s.id === "S-2");
  assert.equal(
    search?.kind === "search" && search.query,
    "PRIVATE EDITED QUERY",
  );
  // The edited source reads inactive until it is previewed again, and the new values show.
  await page
    .getByRole("heading", { name: "PRIVATE NEW QUERY · search" })
    .waitFor();
  const row = page.locator(".settings-row", {
    hasText: "PRIVATE EDITED QUERY",
  });
  await row.getByText("Inactive", { exact: true }).waitFor();
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll("input")].some((e) => e.value === value),
    "PRIVATE EDITED QUERY",
  );
  assert.equal(await save.isDisabled(), true);
});

test("repositories show local paths plainly and edit them in place", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  const d = f.service.domain();
  await page.getByRole("heading", { name: "acme/atlas" }).waitFor();
  await page.getByText("GitHub · github.com").waitFor();
  const path = page.getByLabel("Local repository path", { exact: true });
  await path.waitFor();
  const stored = d.repositoryLinks(ids.atlas).links[0]?.path ?? "";
  assert.ok(stored.includes("atlas-checkout"));
  assert.equal(await path.inputValue(), stored);
  assert.equal(await revealReads(page), 1, "loaded once with the tab");
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  const read = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  const config = await read.text();
  assert.equal(config.includes("atlas-checkout"), false);
  assert.equal(
    JSON.parse(config).data.repositories.links[0].host,
    "github.com",
  );
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true, "showing values is no change");
  const checkout = await createCheckout(f.directory, "atlas-checkout-2");
  await path.fill(checkout);
  const lines = await changes(page).getByRole("listitem").allInnerTexts();
  assert.deepEqual(
    lines.filter((l) => !l.startsWith("Saving verifies")),
    ["Local path changed for acme/atlas"],
  );
  assert.equal(lines.join(" ").includes(checkout), false);
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.equal(sent.type, "repositories.configure");
  assert.deepEqual(sent.repositories, [
    {
      codeHost: "github",
      host: "github.com",
      repositoryId: "R_atlas",
      ref: "main",
      path: checkout,
    },
  ]);
  await savedOutcome(page);
  const saved = d.repositoryLinks(ids.atlas);
  assert.equal(
    await realpath(saved.links[0]?.path ?? ""),
    await realpath(checkout),
  );
  // The GitHub source version is untouched by a link change.
  assert.equal(d.githubConfiguration(ids.atlas).version, 2);
  await page.waitForFunction(
    (value) =>
      [...document.querySelectorAll("input")].some((e) => e.value === value),
    saved.links[0]?.path,
  );
  assert.equal(await save.isDisabled(), true);
  // A reverted edit leaves the form clean.
  const ref = page.getByLabel("Linked repository ref", { exact: true });
  await ref.fill("HEAD");
  await ref.fill("main");
  await path.fill("/changed");
  await path.fill(saved.links[0]?.path ?? "");
  await assertClean(page, "Save changes");
});

test("GitHub source private values unavailable keeps rows kept and saveable", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.reload();
  await page.getByText("Query unavailable", { exact: true }).waitFor();
  const retry = page.getByRole("button", { name: /^Try again to load the/ });
  assert.equal(await retry.count(), 1);
  assert.equal(await retry.first().isEnabled(), true);
  assert.equal(await showsText(page, "PRIVATE"), false);
  // Other edits are not blocked, and nothing is sent for the unread values.
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page
    .getByLabel("Closed GitHub issues", { exact: true })
    .selectOption({ label: "Treat closure as Done" });
  await changes(page)
    .getByText("Closed issues: Treat closure as Done")
    .waitFor();
  const body = commandBody(page);
  // The saved version moves, so the page reads the private values once more.
  const reread = page.waitForResponse((r) =>
    r.url().endsWith("/private-values"),
  );
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  assert.equal(sent.closedIssues, "done");
  await savedOutcome(page);
  const saved = f.service.domain().githubConfiguration(ids.atlas);
  assert.equal(saved.closedIssues, "done");
  assert.equal(
    saved.selections.some(
      (s) => s.kind === "search" && s.query === "PRIVATE SAVED QUERY",
    ),
    true,
  );
  // Reading again brings both values back. That read must have failed before the route goes,
  // or it would succeed on its own and replace the buttons this clicks.
  await reread;
  await page.unroute("**/private-values");
  await retry.first().click();
  await page.getByLabel("Search query", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Search query", { exact: true }).inputValue(),
    "PRIVATE SAVED QUERY",
  );
  assert.equal(await page.getByText("Query unavailable").count(), 0);
});

test("repository private values unavailable keeps rows kept and saveable", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    }),
  );
  await page.reload();
  await page.getByText("Local path unavailable", { exact: true }).waitFor();
  const retry = page.getByRole("button", { name: /^Try again to load the/ });
  assert.equal(await retry.count(), 1);
  assert.equal(await retry.first().isEnabled(), true);
  assert.equal(await showsText(page, "PRIVATE"), false);
  assert.equal(
    await page.getByLabel("Local repository path", { exact: true }).count(),
    0,
  );
  // Other edits are not blocked, and nothing is sent for the unread path.
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  assert.equal(await save.isDisabled(), true);
  await page.getByLabel("Linked repository ref", { exact: true }).fill("HEAD");
  await changes(page).getByText("Ref for acme/atlas: main → HEAD").waitFor();
  const body = commandBody(page);
  // The saved version moves, so the page reads the private values once more.
  const reread = page.waitForResponse((r) =>
    r.url().endsWith("/private-values"),
  );
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.repositories, [
    {
      codeHost: "github",
      host: "github.com",
      repositoryId: "R_atlas",
      ref: "HEAD",
    },
  ]);
  await savedOutcome(page);
  const saved = f.service.domain().repositoryLinks(ids.atlas);
  assert.equal(saved.links[0]?.ref, "HEAD");
  // That read must have failed before the route goes, or it would succeed on its own.
  await reread;
  await page.unroute("**/private-values");
  await retry.first().click();
  const path = page.getByLabel("Local repository path", { exact: true });
  await path.waitFor();
  assert.equal(await path.inputValue(), saved.links[0]?.path);
  assert.equal(await page.getByText("Local path unavailable").count(), 0);
});

test("removing all repository access needs confirmation and Discard restores the row", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
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
  await page.getByLabel("Local repository path", { exact: true }).waitFor();
  assert.equal(await confirm.count(), 0);
  await page
    .getByRole("button", { name: "Remove repository acme/atlas" })
    .click();
  await confirm.check();
  await save.click();
  await savedOutcome(page);
  assert.deepEqual(f.service.domain().repositoryLinks(ids.atlas).links, []);
});

test("repository errors name the exact row without echo", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  await page.getByRole("button", { name: "Add repository" }).click();
  await page
    .getByLabel("Linked repository ID", { exact: true })
    .fill("R_extra");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill("relative/PRIVATE-PATH");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .locator("#repository-error")
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
  // An owner/name typed as the ID is refused with the fix, and the row keeps its path.
  const id = page.getByLabel("Linked repository ID", { exact: true });
  await id.fill("acme/extra");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .locator("#repository-error")
    .getByText(/^Repository 2: a GitHub link needs the repository's node ID/)
    .waitFor();
  await id.fill("R_extra");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.equal(f.service.domain().repositoryLinks(ids.atlas).links.length, 2);
});

test("a new GitHub repository link is chosen from discovered repositories and a picked folder", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {}, "repositories");
  await page.getByRole("button", { name: "Add repository" }).click();
  const choice = page.getByLabel("Repository", { exact: true });
  await choice.selectOption({ label: "acme/relay" });
  assert.equal(
    await page.getByLabel("Linked repository ID", { exact: true }).count(),
    0,
  );
  // As in setup, the chosen repository's branches are listed with its default preselected.
  const ref = page.getByLabel("Ref", { exact: true });
  await ref
    .locator("option", { hasText: "develop" })
    .waitFor({ state: "attached" });
  assert.equal(await ref.inputValue(), "main");
  // The folder picker fills the new row's path.
  const checkout = await createCheckout(f.directory, "relay-checkout");
  await page.getByRole("button", { name: "Choose folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose repository folder" });
  await dialog.getByLabel("Or enter a path").fill(checkout);
  await dialog.getByRole("button", { name: "Use this folder" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page
      .getByLabel("New local repository path", { exact: true })
      .inputValue(),
    checkout,
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  const relay = f.service
    .domain()
    .repositoryLinks(ids.atlas)
    .links.find((l) => l.repositoryId === "R_relay");
  assert.equal(relay?.ref, "main");
});

test("a new GitLab repository link is chosen from configured hosts and their projects", async (_t, journey) => {
  const glab = createFakeGlab();
  journey.cleanup(async () => glab.close(), "fake-glab.close");
  const host = "gitlab.example.com";
  const { f, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
    undefined,
    undefined,
    {
      setup: {
        glabExecutable: glab.executable,
        gitlab: () => ({
          user: async () => ({ username: "fake-user" }),
          projects: async () => ({
            projects: [
              {
                repositoryId: "42",
                projectPath: "group/app",
                defaultBranch: "trunk",
              },
            ],
            truncated: false,
          }),
        }),
      },
    },
  );
  f.service.domain().execute({
    type: "code-host-credential.configure",
    key: randomUUID(),
    actor: "operator",
    codeHost: "gitlab",
    host,
    credentialRef: `glab:${host}`,
  });
  await page.reload();
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.getByLabel("Code host", { exact: true }).selectOption("gitlab");
  await page
    .getByRole("combobox", { name: "GitLab host", exact: true })
    .selectOption(host);
  const project = page.getByLabel("GitLab project", { exact: true });
  await project
    .locator("option", { hasText: "group/app" })
    .waitFor({ state: "attached" });
  await project.selectOption({ label: "group/app" });
  assert.equal(
    await page.getByLabel("GitLab project path", { exact: true }).count(),
    0,
  );
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill("~/gl/app");
  const body = commandBody(page);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  assert.deepEqual(((await body).repositories as unknown[]).at(-1), {
    codeHost: "gitlab",
    host,
    repositoryId: "42",
    ref: "trunk",
    projectPath: "group/app",
    path: "~/gl/app",
  });
});

test("new repository and GitHub Project sources are chosen from discovery", async (_t, journey) => {
  const { page } = await startDiscovery(journey, {});
  const kind = page.getByLabel("Selection kind", { exact: true });
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption({ label: "acme/relay" });
  assert.equal(
    await page.getByLabel("Repository owner", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await kind.last().selectOption({ label: "GitHub Project" });
  // Projects linked to the project's repositories, as the readiness picker lists them.
  await page
    .getByLabel("GitHub Project", { exact: true })
    .selectOption({ label: "Atlas roadmap" });
  await page.getByLabel("Project filter", { exact: true }).fill("is:open");
  const body = commandBody(page);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const added = (
    (await body).selections as { id: string; keep?: boolean }[]
  ).filter((s: { keep?: boolean }) => !s.keep);
  assert.deepEqual(
    added.map(({ id: _id, ...s }) => s),
    [
      {
        kind: "repository",
        repositoryId: "R_relay",
        owner: "acme",
        name: "relay",
      },
      { kind: "project", projectNodeId: "PVT_atlas", filter: "is:open" },
    ],
  );
});

test("GitHub source conflict keeps rows and an unknown save is checked once", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
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
    readiness: {
      mode: "any",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
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
  await page
    .getByRole("heading", { name: "PRIVATE ELSEWHERE · search" })
    .waitFor();
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

test("an edited query survives adopting a newer source version unless the row was removed elsewhere", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const writer = (selections: { id: string; keep: true }[]) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections,
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    } as Parameters<OperatorApi["execute"]>[0]);
  const query = page.getByLabel("Search query", { exact: true });
  await query.fill("EDITED QUERY");
  await writer([
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(await query.inputValue(), "EDITED QUERY");
  assert.deepEqual(await changes(page).getByRole("listitem").allInnerTexts(), [
    "Search query edited for S-2",
  ]);
  // The query row is removed elsewhere: its edit is discarded with a plain note.
  await writer([
    { id: "S-1", keep: true },
    { id: "S-3", keep: true },
  ]);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "Loaded the latest version. S-2 was removed or replaced elsewhere, so your edits to it were discarded.",
    )
    .waitFor();
  assert.equal(await query.count(), 0);
  await noChanges(page);
});

test("an edited path survives adopting newer repository links unless the link was removed elsewhere", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const writer = (
    repositories: { repositoryId: string; ref: string; path?: string }[],
  ) =>
    api.execute({
      type: "repositories.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.repositoryLinks(ids.atlas).version,
      repositories: repositories.map((r) => ({
        codeHost: "github" as const,
        host: "github.com" as const,
        ...r,
      })),
    });
  const path = page.getByLabel("Local repository path", { exact: true });
  const checkout = await createCheckout(f.directory, "adopted-checkout");
  await path.fill(checkout);
  await writer([{ repositoryId: "R_atlas", ref: "HEAD" }]);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(await path.inputValue(), checkout);
  assert.deepEqual(
    (await changes(page).getByRole("listitem").allInnerTexts()).filter(
      (l) => !l.startsWith("Saving verifies"),
    ),
    ["Local path changed for acme/atlas"],
  );
  // The link is removed elsewhere: its edit is discarded with a plain note.
  await writer([]);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "Loaded the latest version. R_atlas was removed or replaced elsewhere, so your edits to it were discarded.",
    )
    .waitFor();
  assert.equal(await path.count(), 0);
});

test("a reverted query is kept again, and an edit survives leaving the tab", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const closed = page.getByLabel("Closed GitHub issues", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await query.waitFor();
  // Edit and revert the value: nothing is listed, nothing can be sent.
  await query.fill("CHANGED QUERY");
  await changes(page).getByText("Search query edited for S-2").waitFor();
  await query.fill("PRIVATE SAVED QUERY");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  // An edit survives leaving the tab, and typing the saved text back afterwards reverts it.
  await query.fill("EDIT ONE");
  await leaveAndReturn(page, "GitHub source", "General");
  assert.equal(await query.inputValue(), "EDIT ONE");
  await changes(page).getByText("Search query edited for S-2").waitFor();
  await query.fill("PRIVATE SAVED QUERY");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  // Edited and reverted, then another writer changes the same query: nothing stale is kept.
  await query.fill("MINE");
  await query.fill("PRIVATE SAVED QUERY");
  await closed.selectOption({ label: "Treat closure as Done" });
  const writer = (text: string) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [
        { id: "S-1", keep: true },
        { id: "S-2", kind: "search", query: text },
        { id: "S-3", keep: true },
      ],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
      closedIssues: "skip",
    } as Parameters<OperatorApi["execute"]>[0]);
  await writer("THEIR QUERY");
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input")].some(
      (e) => e.value === "THEIR QUERY",
    ),
  );
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  await savedOutcome(page);
  const kept = d
    .githubConfiguration(ids.atlas)
    .selections.find((x) => x.id === "S-2");
  assert.equal(kept?.kind === "search" && kept.query, "THEIR QUERY");

  // A real edit against older text says so after the other writer's change is adopted.
  await query.fill("MY REAL EDIT");
  await closed.selectOption({ label: "Skip closed issues" });
  await writer("THEIR SECOND QUERY");
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  assert.equal(await query.inputValue(), "MY REAL EDIT");
  // Typing the older text back stays an edit; typing what is saved now is none.
  await query.fill("THEIR QUERY");
  await changes(page).getByText("Search query edited for S-2").waitFor();
  await query.fill("THEIR SECOND QUERY");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  await closed.selectOption({ label: "Treat closure as Done" });
  assert.deepEqual(await changes(page).getByRole("listitem").allInnerTexts(), [
    "Closed issues: Treat closure as Done",
  ]);
  const last = commandBody(page);
  await save.click();
  assert.deepEqual((await last).selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  await savedOutcome(page);
  const theirs = d
    .githubConfiguration(ids.atlas)
    .selections.find((x) => x.id === "S-2");
  assert.equal(theirs?.kind === "search" && theirs.query, "THEIR SECOND QUERY");
});

test("a path edit says so when another writer replaced the path, and typing the saved path is no edit", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const path = page.getByLabel("Local repository path", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await path.waitFor();
  const storedPath = await path.inputValue();
  // Edit and revert: nothing is listed, nothing can be sent.
  await path.fill("/changed/path");
  await changes(page).getByText("Local path changed for acme/atlas").waitFor();
  await path.fill(storedPath);
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  // An edit survives leaving the tab.
  await path.fill("/edit/one");
  await leaveAndReturn(page, "Repositories", "General");
  assert.equal(await path.inputValue(), "/edit/one");
  await path.fill(storedPath);
  await noChanges(page);

  // A local path another writer replaced while this one was edited.
  const mine = await createCheckout(f.directory, "mine-path-checkout");
  const theirsPath = await createCheckout(f.directory, "their-path-checkout");
  const current = await path.inputValue();
  await path.fill(mine);
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.repositoryLinks(ids.atlas).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_atlas",
        path: theirsPath,
        ref: "main",
      },
    ],
  });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  assert.equal(await path.inputValue(), mine);
  // The older path typed back is a deliberate replacement; the path saved now is no edit.
  await path.fill(current);
  await changes(page).getByText("Local path changed for acme/atlas").waitFor();
  await path.fill(d.repositoryLinks(ids.atlas).links[0]?.path ?? "");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  assert.equal(
    await realpath(d.repositoryLinks(ids.atlas).links[0]?.path ?? ""),
    await realpath(theirsPath),
  );
});

test("a query edit says so when the private read is older than the source version", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  await query.waitFor();
  const stale = await page.evaluate(async (id) => {
    const r = await fetch(`/api/operator/projects/${id}/private-values`);
    return r.text();
  }, ids.atlas);
  await query.fill("MY EDIT");
  await page.route("**/private-values", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: stale,
    }),
  );
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", kind: "search", query: "THEIR QUERY" },
      { id: "S-3", keep: true },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  } as Parameters<OperatorApi["execute"]>[0]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Couldn't check whether this changed elsewhere." })
    .waitFor();
  assert.equal(await query.inputValue(), "MY EDIT");
  assert.equal(await showsText(page, "THEIR QUERY"), false);
  await assertOnHold(page, "Save changes", watchPosts(page));
});

test("Save waits for saved queries and paths to be read again, and an edit never changes a row's kind", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await query.waitFor();
  const writer = (s2: object) =>
    api.execute({
      type: "github.configure",
      key: randomUUID(),
      projectId: ids.atlas,
      expectedVersion: d.githubConfiguration(ids.atlas).version,
      selections: [{ id: "S-1", keep: true }, s2, { id: "S-3", keep: true }],
      readiness: {
        mode: "all",
        conditions: [{ kind: "label", operator: "has", name: "ready" }],
      },
    } as Parameters<OperatorApi["execute"]>[0]);

  // Another writer changes the same query; while the comparison read is out, nothing is sent.
  await query.fill("MINE");
  await writer({ id: "S-2", kind: "search", query: "THEIR QUERY" });
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save changes", posts);
  // Enter in a field submits the form too, and sends nothing while Save is on hold.
  const before = posts.length;
  await query.press("Enter");
  await settled(page);
  assert.equal(posts.length, before);
  release();
  await assertOffHold(page, "Save changes");
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  const kept = d
    .githubConfiguration(ids.atlas)
    .selections.find((x) => x.id === "S-2");
  assert.equal(kept?.kind === "search" && kept.query, "THEIR QUERY");

  // Another writer replaces the search with a repository under the same id: the edit and a
  // pending removal are dropped, never carried onto the new source.
  await query.fill("MINE AGAIN");
  await writer({
    id: "S-2",
    kind: "repository",
    repositoryId: "acme/atlas",
    owner: "acme",
    name: "atlas",
  });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText(
      "Loaded the latest version. S-2 was removed or replaced elsewhere, so your edits to it were discarded.",
    )
    .waitFor();
  assert.equal(await query.count(), 0);
  await page
    .getByLabel("Closed GitHub issues", { exact: true })
    .selectOption({ label: "Treat closure as Done" });
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", keep: true },
    { id: "S-3", keep: true },
  ]);
  await savedOutcome(page);
  assert.equal(
    d.githubConfiguration(ids.atlas).selections.find((x) => x.id === "S-2")
      ?.kind,
    "repository",
  );
});

test("Save waits for a query to be read again, and a same-kind replacement drops a pending removal", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const query = page.getByLabel("Search query", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await query.waitFor();
  await query.fill("MY QUERY");
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", kind: "search", query: "THEIR QUERY" },
      // The same id, redefined as another GitHub Project: the pending removal no longer fits.
      { id: "S-3", kind: "project", projectNodeId: "PVT_other", filter: "" },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  } as Parameters<OperatorApi["execute"]>[0]);
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save changes", posts);
  release();
  await assertOffHold(page, "Save changes");
  await page
    .getByText("S-3 was removed or replaced elsewhere", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("Will be removed").count(), 0);
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.deepEqual(sent.selections, [
    { id: "S-1", keep: true },
    { id: "S-2", kind: "search", query: "MY QUERY" },
    { id: "S-3", keep: true },
  ]);
});

test("Save waits for a local path to be read again", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  const path = page.getByLabel("Local repository path", { exact: true });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await path.waitFor();
  const mine = await createCheckout(f.directory, "hold-mine");
  const theirs = await createCheckout(f.directory, "hold-theirs");
  await path.fill(mine);
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.repositoryLinks(ids.atlas).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_atlas",
        path: theirs,
        ref: "main",
      },
    ],
  });
  const posts = watchPosts(page);
  const release = await holdReads(page);
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await assertOnHold(page, "Save changes", posts);
  release();
  await assertOffHold(page, "Save changes");
  await page
    .getByText(
      "This was changed elsewhere since you started editing. Saving replaces it.",
    )
    .waitFor();
  const body = commandBody(page);
  await save.click();
  const sent = await body;
  assert.equal((sent.repositories as { path?: string }[])[0]?.path, mine);
});

test("a pending removal is dropped when the source was replaced under the same id", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  const api = new OperatorApi(f.service, [f.directory]);
  await page.getByRole("button", { name: "Remove Saved search (S-2)" }).click();
  await api.execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", kind: "project", projectNodeId: "PVT_new", filter: "" },
      { id: "S-3", keep: true },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  } as Parameters<OperatorApi["execute"]>[0]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page
    .getByText("S-2 was removed or replaced elsewhere", { exact: false })
    .waitFor();
  assert.equal(await page.getByText("Will be removed").count(), 0);
  await noChanges(page);
});

test("an unknown source save with rows removed elsewhere keeps its one action and message", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  await page
    .getByRole("button", { name: "Remove GitHub Project (S-3)" })
    .click();
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
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
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

test("Sync & placement shows the import offer, observations and the placement status line", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=sync",
  );
  await page.getByRole("heading", { name: "Source sync" }).waitFor();
  await page
    .locator(".settings-status")
    .getByText("No placement conflicts.")
    .waitFor();
  await page
    .getByRole("button", { name: "Preview and import now", exact: true })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Refresh all sources",
    })
    .waitFor();
  assert.deepEqual(await unpairedBadges(page.locator("main")), []);
  await captureBrowserEvidence(page, "1366-sync");
});

test("a repository link saved elsewhere under the same id needs an explicit choice", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=repositories",
  );
  const d = f.service.domain();
  const mine = await createCheckout(f.directory, "mine-checkout"),
    theirs = await createCheckout(f.directory, "theirs-checkout");
  await page.getByRole("button", { name: "Add repository" }).click();
  await page.getByLabel("Linked repository ID", { exact: true }).fill("R_new");
  await page
    .getByLabel("New local repository path", { exact: true })
    .fill(mine);
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.repositoryLinks(ids.atlas).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_atlas",
        ref: "main",
      },
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: "R_new",
        path: theirs,
        ref: "main",
      },
    ],
  });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.getByText("R_new is linked twice", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await page
    .getByRole("button", { name: "Remove new repository R_new" })
    .click();
  assert.equal(await save.isDisabled(), true, "nothing left to save");
  const saved = d.repositoryLinks(ids.atlas).links;
  assert.equal(
    saved.find((r) => r.repositoryId === "R_new")?.path,
    await realpath(theirs),
  );
  // The saved link shows the other writer's path plainly, and the removed new row left nothing.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input")].some((e) =>
      e.value.includes("theirs-checkout"),
    ),
  );
  assert.equal(await showsText(page, "mine-checkout"), false);
});

test("Sync and GitHub source show stored readiness counts and a zero-match warning that opens the Readiness panel", async (t, journey) => {
  const previous = process.env.FIXTURE_GITHUB;
  process.env.FIXTURE_GITHUB = "offline-readiness-source-value";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_GITHUB;
    else process.env.FIXTURE_GITHUB = previous;
  });
  let complete = true;
  const issue = (n: number) => ({
    providerInstance: "github.com" as const,
    nodeId: `I_${n}`,
    repositoryId: "acme/atlas",
    repositoryName: "acme/atlas",
    number: n,
    title: `Issue ${n}`,
    body: "Scope",
    state: "open" as const,
    labels: [],
    projectFields: [],
  });
  const reader: GitHubReaderFactory = () => ({
    async readSelection() {
      return complete
        ? {
            complete: true as const,
            issues: [1, 2, 3].map(issue),
            reason: null,
          }
        : { complete: false as const, issues: [], reason: "http-403" };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" as const };
    },
  });
  const { f, ids, page, web } = await startSettings(
    journey,
    "/projects/:atlas/settings",
    undefined,
    undefined,
    { readerFactory: reader },
  );
  const d = f.service.domain();
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    selectionId: "S-1",
    expectedVersion: d.githubConfiguration(ids.atlas).version,
  });
  await f.service.refreshGitHub();
  const counts = "3 observed · 3 open · 0 match label `ready`";
  const warning =
    "No open item matches the readiness rule (label `ready`); imported tasks stay Draft until one does.";
  await page.goto(
    web.origin + resolve("/projects/:atlas/settings?tab=sync", ids),
  );
  const row = page
    .locator("article.settings-row")
    .filter({ hasText: "acme/atlas" });
  // The counts sit in Details; the sentence and the warning stay visible.
  await row.getByText(/^Synced \d\d:\d\d · 3 issues observed/).waitFor();
  await row.locator("summary").first().click();
  await row.getByText(counts, { exact: true }).waitFor();
  await row.getByText(warning, { exact: false }).waitFor();
  await row.getByRole("link", { name: "Check readiness conditions" }).click();
  await page.waitForURL(/tab=github#source-readiness$/);
  await page.waitForFunction(
    () => document.activeElement?.id === "source-readiness",
  );
  await page.getByText(warning, { exact: false }).waitFor();

  complete = false;
  await f.service.refreshGitHub();
  await page.reload();
  await page
    .getByText(/^Partly synced \d\d:\d\d · 3 issues observed so far/)
    .first()
    .waitFor();
  assert.equal(await page.getByText(warning, { exact: false }).count(), 0);
});

test("source conflict review replaces an unsaved ID when a concurrent saved identity is withheld", async (_t, journey) => {
  const previous = process.env.HIDDEN_REVIEW_SOURCE;
  process.env.HIDDEN_REVIEW_SOURCE = "S-1";
  journey.cleanup(async () => {
    if (previous === undefined) delete process.env.HIDDEN_REVIEW_SOURCE;
    else process.env.HIDDEN_REVIEW_SOURCE = previous;
  }, "restore-review-source-exclusion");
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
  );
  const d = f.service.domain();
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [],
    readiness: null,
  });
  await refresh(page);
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Selection kind", { exact: true })
    .selectOption("search");
  await page
    .getByLabel("Search query", { exact: true })
    .fill("is:open unsaved query");
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: "env:HIDDEN_REVIEW_SOURCE",
    grants: [],
    requiredChecks: [],
  });
  const hidden = {
    id: "S-1",
    kind: "search" as const,
    query: "private concurrent query",
  };
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [hidden],
    readiness: null,
  });
  const read = page.waitForResponse((r) =>
    r.url().endsWith(`/projects/${ids.atlas}/configuration`),
  );
  const conflict = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/operator/commands") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const failed = await conflict;
  assert.equal(failed.request().postDataJSON().selections[0].id, "S-1");
  assert.equal(failed.status(), 409);
  assert.equal((await (await read).json()).data.source.selections[0].id, null);
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/operator/commands") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200);
  assert.equal(
    JSON.stringify(response.request().postDataJSON()).includes('"S-1"'),
    false,
  );
  await savedOutcome(page);
  const selections = d.githubConfiguration(ids.atlas).selections;
  assert.deepEqual(
    selections.find((row) => row.id === "S-1"),
    hidden,
  );
  const added = selections.find((row) => row.id !== "S-1")!;
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(added, {
    id: added.id,
    kind: "search",
    query: "is:open unsaved query",
  });
  assert.deepEqual(d.githubActiveSelectionIds(ids.atlas), []);
});

test("opaque saved rows support keyboard remove undo and discard while a visible source change keeps them", async (_t, journey) => {
  const previous = process.env.HIDDEN_UI_SOURCE;
  process.env.HIDDEN_UI_SOURCE = "S-1";
  journey.cleanup(async () => {
    if (previous === undefined) delete process.env.HIDDEN_UI_SOURCE;
    else process.env.HIDDEN_UI_SOURCE = previous;
  }, "restore-hidden-source-exclusion");
  const { f, ids, page, web } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
    phone,
  );
  const d = f.service.domain();
  const hidden = {
    id: "S-1",
    kind: "search" as const,
    query: "private saved query",
  };
  d.execute({
    type: "delivery.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: f.service.delivery().configuration(ids.atlas).version,
    mode: "reviewable-pr",
    credentialRef: "env:HIDDEN_UI_SOURCE",
    grants: [],
    requiredChecks: [],
  });
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [hidden],
    readiness: null,
    closedIssues: "skip",
  });
  await refresh(page);
  const remove = () =>
    page.getByRole("button", {
      name: "Remove unavailable source 1",
      exact: true,
    });
  await remove().focus();
  await page.keyboard.press("Space");
  const undo = page.getByRole("button", {
    name: "Undo remove unavailable source 1",
    exact: true,
  });
  await undo.waitFor();
  assert.equal(
    await undo.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Space");
  await remove().waitFor();
  await remove().click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await remove().waitFor();
  assert.equal(await showsText(page, hidden.id), false);
  await page
    .getByLabel("Closed GitHub issues", { exact: true })
    .selectOption("done");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).selections, [hidden]);
  assert.equal(d.githubConfiguration(ids.atlas).closedIssues, "done");
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page
    .getByLabel("Selection kind", { exact: true })
    .selectOption("search");
  await page
    .getByLabel("Search query", { exact: true })
    .fill("is:open added query");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  const savedSources = d.githubConfiguration(ids.atlas).selections;
  assert.deepEqual(savedSources[0], hidden);
  assert.match(savedSources[1]!.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(savedSources[1], {
    id: savedSources[1]!.id,
    kind: "search",
    query: "is:open added query",
  });
  assert.deepEqual(d.githubActiveSelectionIds(ids.atlas), []);
  const api = new OperatorApi(f.service, [f.directory]);
  await api.execute({
    type: "repositories.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.repositoryLinks(ids.atlas).version,
    repositories: [
      {
        codeHost: "github",
        host: "github.com",
        repositoryId: hidden.id,
        path: ids.checkout,
        ref: "main",
      },
    ],
  });
  await page.goto(
    `${web.origin}/projects/${ids.atlas}/settings?tab=repositories`,
  );
  const linkRemove = () =>
    page.getByRole("button", {
      name: "Remove repository Unavailable saved repository link 1",
      exact: true,
    });
  await linkRemove().focus();
  await page.keyboard.press("Space");
  await page
    .getByRole("button", {
      name: "Undo remove repository Unavailable saved repository link 1",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await linkRemove().waitFor();
  assert.equal(
    await page.getByLabel("Linked repository ref", { exact: true }).count(),
    0,
  );
  assert.equal(await showsText(page, hidden.id), false);
});
