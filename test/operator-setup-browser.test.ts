import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  type ReadinessCheckId,
  readinessCheckIds,
  readinessSchema,
} from "../src/operator/readiness.js";
import { DiscoveryFailure } from "../src/standalone/github-discovery.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  chooseRepository,
  commandRequest,
  setupJourney,
} from "./fixtures/setup-browser.js";
import { git } from "./fixtures/setup-home.js";
import { outcomeMessages, savedOutcome } from "./fixtures/operator-settings.js";
const test = browserSuite("ui06-setup");

const fixFields =
  "Couldn't save: check the highlighted fields. Your changes are still here.";
const mismatch =
  "This folder is a checkout of acme/relay, not acme/atlas. Choose another folder or change the repository.";

test("Setup creates a paused project from discovered repositories and Projects", async (_t, journey) => {
  const { f, home, page } = await setupJourney(journey, { projects: true });
  await page.locator("main.page h1", { hasText: "Create project" }).waitFor();
  for (const heading of [
    "1 · Project and lead",
    "2 · Instructions",
    "3 · Repository and GitHub · optional",
  ])
    await page.getByRole("heading", { name: heading }).waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "What creation does" })
      .locator("li")
      .count(),
    5,
  );
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
  assert.deepEqual(
    await page
      .getByLabel("Repository", { exact: true })
      .locator("option")
      .allTextContents(),
    [
      "No repository · repository-free",
      "acme/atlas",
      "acme/relay",
      "acme/docs",
    ],
  );
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Mira" });
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("PRIVATE SETUP SENTINEL");
  await chooseRepository(page, "acme/atlas");
  assert.equal(
    await page.getByLabel("Ref", { exact: true }).inputValue(),
    "main",
  );
  assert.deepEqual(
    await page
      .getByLabel("Ref", { exact: true })
      .locator("option")
      .allTextContents(),
    ["main · default branch", "develop"],
  );
  await page.getByLabel("Local repository path").fill("~/src/atlas");
  await page.getByLabel("Local repository path").blur();
  await page
    .getByText(
      "Verified on this Mac: git checkout · origin acme/atlas · main available.",
    )
    .waitFor();
  await page
    .getByText(
      "Found automatically: 1 GitHub Project linked to acme/atlas. Linking adds an inactive discovery source; preview and readiness follow in project configuration.",
    )
    .waitFor();
  assert.equal(
    await page.getByLabel("GitHub Project", { exact: true }).inputValue(),
    "PVT_atlas",
  );
  // A Project choice belongs to its repository: another repository starts at None.
  await chooseRepository(page, "acme/relay");
  await page.getByText("0 GitHub Projects linked to acme/relay").waitFor();
  assert.equal(
    await page.getByLabel("GitHub Project", { exact: true }).inputValue(),
    "",
  );
  await chooseRepository(page, "acme/atlas");
  await page.getByText("Found automatically: 1 GitHub Project").waitFor();
  assert.equal(
    await page.getByLabel("GitHub Project", { exact: true }).inputValue(),
    "PVT_atlas",
  );
  await captureBrowserEvidence(page, "1366-setup-discovered");
  const sent = commandRequest(page);
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const body = (await sent).postDataJSON() as {
    type: string;
    projectId: string;
    repositories: unknown;
    githubProject: unknown;
  };
  assert.equal(body.type, "project.create");
  assert.deepEqual(body.repositories, [
    {
      repositoryId: "R_atlas",
      owner: "acme",
      name: "atlas",
      path: "~/src/atlas",
      ref: "main",
    },
  ]);
  assert.deepEqual(body.githubProject, { projectNodeId: "PVT_atlas" });
  await savedOutcome(page, /^Created Atlas\. It's paused\./);
  const d = f.service.domain();
  const project = d.project(body.projectId);
  assert.equal(project.paused, 1);
  assert.equal(project.instructions, "PRIVATE SETUP SENTINEL");
  const github = d.githubConfiguration(body.projectId);
  assert.deepEqual(
    github.repositories.map((r) => r.path),
    [await realpath(join(home.home, "src", "atlas"))],
  );
  assert.deepEqual(
    github.selections.map((s) => s.id),
    ["S-1"],
  );
  assert.equal(f.runtime.turns, 0);
  assert.equal(
    (await page.locator("body").innerText()).includes("PRIVATE SETUP SENTINEL"),
    false,
  );
  const ready = page.getByRole("region", { name: "Ready check" });
  for (const line of [
    "Instructions saved.",
    "Repository access: acme/atlas (main), checked on this Mac.",
    "GitHub Project linked as an inactive discovery source.",
  ])
    await ready.getByText(line, { exact: true }).waitFor();
  assert.equal(
    await ready
      .getByRole("link", { name: "Keep paused", exact: true })
      .getAttribute("href"),
    `/app/projects/${body.projectId}/settings`,
  );
  // The new project joins the sidebar once the workspace re-reads.
  await page
    .locator(`a[href="/app/projects/${body.projectId}"]`)
    .first()
    .waitFor();
  // Choosing New project again starts a clean form.
  await page.getByRole("link", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "",
  );
  // Repository-free: no repository and no Project.
  await page.getByLabel("Project name", { exact: true }).fill("Fieldnotes");
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Nora" });
  await captureBrowserEvidence(page, "1366-setup-repository-free");
  const second = commandRequest(page);
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const free = (await second).postDataJSON() as Record<string, unknown>;
  assert.notEqual(free.key, (body as unknown as { key: string }).key);
  assert.equal("repositories" in free, false);
  assert.equal("githubProject" in free, false);
  await savedOutcome(page, /^Created Fieldnotes\. It's paused\./);
});

test("Setup keeps every value on a checkout mismatch and rechecks on create", async (_t, journey) => {
  const { f, home, page } = await setupJourney(journey);
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Mira" });
  await page.getByLabel("Instructions", { exact: true }).fill("Keep me");
  await chooseRepository(page, "acme/atlas");
  const path = page.getByLabel("Local repository path");
  await path.fill("~/src/relay");
  await path.blur();
  await page.getByText(mismatch).waitFor();
  assert.equal(await path.getAttribute("aria-invalid"), "true");
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  await page.getByText(fixFields).waitFor();
  // One alert says the input is safe; the field error names the fix.
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(await page.getByRole("alert").count(), 1);
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-invalid") === "true" &&
      (document.activeElement as HTMLInputElement).value === "~/src/relay",
  );
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas",
  );
  assert.equal(
    await page.getByLabel("Instructions", { exact: true }).inputValue(),
    "Keep me",
  );
  assert.equal(
    await page.getByLabel("Repository", { exact: true }).inputValue(),
    "R_atlas",
  );
  await page.getByText(mismatch).waitFor();
  assert.equal(f.service.domain().projects().length, 0);
  await captureBrowserEvidence(page, "1366-setup-mismatch");
  // Verified when chosen, then the origin changes: the service rejects on create.
  await path.fill("~/src/atlas");
  await path.blur();
  await page
    .getByText(
      "Verified on this Mac: git checkout · origin acme/atlas · main available.",
    )
    .waitFor();
  await git(
    join(home.home, "src", "atlas"),
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/relay.git",
  );
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/operator/commands"),
  );
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const rejected = (await (await response).json()) as {
    error: { fieldPaths: string[] };
  };
  assert.deepEqual(rejected.error.fieldPaths, ["repositories.0.path"]);
  await page
    .getByText("This folder no longer matches. Choose it again.")
    .waitFor();
  assert.equal(f.service.domain().projects().length, 0);
});

test("Setup falls back to typed entry without discovery and on first run", async (_t, journey) => {
  const { f, page, discoveryState } = await setupJourney(journey, {
    profiles: false,
    discovery: false,
  });
  // The first-run title depends on the workspace read, which may land after the shell.
  await page
    .locator("main.page h1", { hasText: "Set up your first project" })
    .waitFor();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await crumbs.getByRole("link", { name: "Overview" }).waitFor();
  await crumbs.getByText("New project").waitFor();
  await page
    .getByText(
      "GitHub discovery is unavailable: no discovery credential is configured, so repositories, refs and GitHub Projects can't be listed. Type the repository and ref; the service still verifies the local checkout. Repository access is exactly what you add here.",
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Set discovery credential" })
      .getAttribute("href"),
    "/app/settings",
  );
  // With no profiles the lead is chosen by creating one in place, never by leaving setup.
  await page.getByRole("group", { name: "New lead profile" }).waitFor();
  assert.equal(
    await page.getByLabel("Lead profile", { exact: true }).count(),
    0,
  );
  const repo = page.getByLabel("Repository (owner/name)");
  await repo.fill("Acme/Atlas");
  await page.getByText("Typed · not listed from GitHub").waitFor();
  await page.getByText("Typed · checked in the local checkout").waitFor();
  assert.equal(
    await page.getByLabel("GitHub Project", { exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel("Ref", { exact: true }).fill("main");
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  const path = page.getByLabel("Local repository path");
  await path.fill("~/src/atlas");
  await path.blur();
  await page
    .getByText(
      "Verified on this Mac: git checkout · origin acme/atlas · main available.",
    )
    .waitFor();
  await captureBrowserEvidence(page, "1366-setup-unavailable");
  await captureBrowserEvidence(page, "1366-setup-first-run");
  const sent = commandRequest(page);
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const body = (await sent).postDataJSON() as {
    projectId: string;
    repositories: { repositoryId: string }[];
  };
  assert.equal(body.repositories[0]?.repositoryId, "github.com/acme/atlas");
  await savedOutcome(page, /^Created Atlas\. It's paused\./);
  assert.equal(
    f.service.domain().githubConfiguration(body.projectId).repositories[0]
      ?.repositoryId,
    "github.com/acme/atlas",
  );
  // A failed read shows its reason and recovers on Retry without losing typed values.
  f.service.domain().execute({
    type: "discovery.configure",
    actor: "operator",
    key: crypto.randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  discoveryState.failure = new DiscoveryFailure("unauthorized");
  await page.reload();
  await page.locator("main.page h1").waitFor();
  await page
    .getByText(
      "GitHub discovery is unavailable: GitHub rejected the credential.",
    )
    .waitFor();
  await page.getByLabel("Repository (owner/name)").fill("acme/relay");
  await page.getByLabel("Ref", { exact: true }).fill("main");
  delete discoveryState.failure;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page
    .getByText(
      "Discovered from GitHub · 3 repositories visible to the credential",
    )
    .waitFor();
  assert.equal(
    await page.getByLabel("Repository", { exact: true }).inputValue(),
    "R_relay",
  );
  assert.equal(
    await page.getByLabel("Ref", { exact: true }).inputValue(),
    "main",
  );
});

test("Setup checks an unknown create outcome by replaying the exact request", async (_t, journey) => {
  const { f, page } = await setupJourney(journey);
  await page.getByLabel("Project name", { exact: true }).fill("Unknown");
  let aborted = 0;
  await page.route("**/api/operator/commands", async (route) => {
    aborted++;
    await route.abort();
  });
  try {
    const sent = commandRequest(page);
    await page
      .getByRole("button", { name: "Create paused project", exact: true })
      .click();
    const first = (await sent).postDataJSON() as { key: string };
    await page
      .getByRole("button", { name: "Check whether it saved" })
      .waitFor();
    assert.equal(aborted, 1);
    assert.equal(await outcomeMessages(page).count(), 1);
    assert.equal(await outcomeMessages(page).getAttribute("role"), "alert");
    assert.equal(
      await page.getByLabel("Project name", { exact: true }).isDisabled(),
      true,
    );
    await page.unroute("**/api/operator/commands");
    const replay = commandRequest(page);
    await page.getByRole("button", { name: "Check whether it saved" }).click();
    assert.equal(
      ((await replay).postDataJSON() as { key: string }).key,
      first.key,
    );
    await savedOutcome(page, /^Created Unknown\. It's paused\./);
    assert.equal(f.service.domain().projects().length, 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
});

test("Setup stays usable on a phone", async (_t, journey) => {
  const { page } = await setupJourney(journey, {
    viewport: { width: 390, height: 844 },
  });
  await chooseRepository(page, "acme/atlas");
  await page.getByLabel("Local repository path").waitFor();
  await page.waitForFunction(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );
  const small = await page
    .locator(
      "main.page .setup-page :is(button, select, input, textarea, a[data-slot='button'])",
    )
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({
          name: el.getAttribute("aria-label") ?? el.textContent ?? el.tagName,
          height: el.getBoundingClientRect().height,
        }))
        .filter((e) => e.height < 44),
    );
  assert.deepEqual(small, []);
  await captureBrowserEvidence(page, "390-setup");
});

test("Setup creates a repository-free project in WebKit", async (_t, journey) => {
  journey.restart();
  const { f, page } = await setupJourney(journey, { engine: "webkit" });
  await page.getByLabel("Project name", { exact: true }).fill("WebKit");
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  await savedOutcome(page, /^Created WebKit\. It's paused\./);
  assert.equal(f.service.domain().projects().length, 1);
});

test("Setup resets a Project choice when its repository row changes", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  const repositories = page.getByLabel("Repository", { exact: true });
  const project = page.getByLabel("GitHub Project", { exact: true });
  await chooseRepository(page, "acme/relay");
  await page
    .getByRole("button", { name: "Add another repository", exact: true })
    .click();
  await repositories.nth(1).selectOption({ label: "acme/atlas" });
  // Row 1 becomes the Project repository once row 0 has none.
  await repositories
    .nth(0)
    .selectOption({ label: "No repository · repository-free" });
  await page.getByText("Found automatically: 1 GitHub Project").waitFor();
  assert.equal(await project.inputValue(), "PVT_atlas");
  await repositories.nth(1).selectOption({ label: "acme/docs" });
  await page.getByText("0 GitHub Projects linked to acme/docs").waitFor();
  assert.equal(await project.inputValue(), "");
});

test("Setup surfaces truncated discovery lists and allows typed entry", async (_t, journey) => {
  const { page } = await setupJourney(journey, { truncated: true });
  await page
    .getByText(
      'Discovered from GitHub · the first 3 repositories visible to the credential. Choose "Type a repository" for one not listed.',
    )
    .waitFor();
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption({ label: "acme/atlas" });
  // Past the branch cap the ref is typed, starting from the default branch.
  await page
    .getByText(
      "More branches than listed · type the ref; it is checked in the local checkout",
    )
    .waitFor();
  assert.equal(
    await page.getByLabel("Ref", { exact: true }).inputValue(),
    "main",
  );
  await page
    .getByText(
      "Only the first 100 Projects of a repository or owner are listed",
      { exact: false },
    )
    .waitFor();
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption({ label: "Type a repository not listed…" });
  await page.getByLabel("Repository (owner/name)").fill("acme/hidden");
  await page.getByText("Typed · not listed from GitHub").waitFor();
  assert.equal(
    await page.getByLabel("Repository (owner/name)").inputValue(),
    "acme/hidden",
  );
  // Typing a repository that is listed records its node ID, not the provisional identity.
  await page.getByLabel("Repository (owner/name)").fill("Acme/Atlas");
  await page.getByLabel("Repository (owner/name)").blur();
  await page.getByLabel("Repository", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Repository", { exact: true }).inputValue(),
    "R_atlas",
  );
  // The adopted row takes the listed default branch, which the Ref field shows.
  assert.equal(
    await page.getByLabel("Ref", { exact: true }).inputValue(),
    "main",
  );
});

test("Setup submitted with Enter records a typed listed repository by node ID", async (_t, journey) => {
  const { page } = await setupJourney(journey, { truncated: true });
  await page.getByLabel("Project name", { exact: true }).fill("Enter");
  await page
    .getByText("Discovered from GitHub · the first 3 repositories", {
      exact: false,
    })
    .waitFor();
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption({ label: "Type a repository not listed…" });
  await page.getByLabel("Local repository path").fill("~/src/atlas");
  const typed = page.getByLabel("Repository (owner/name)");
  await typed.fill("Acme/Atlas");
  // A blank Ref is shown as blank, so the command never invents one: nothing is sent.
  let sentCount = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sentCount++;
  });
  await typed.press("Enter");
  await page.getByText(fixFields).waitFor();
  assert.equal(sentCount, 0);
  // The rejection moves focus to the invalid Ref, so the typed field's blur adopts the
  // listed repository and visibly fills its default branch.
  await page.getByLabel("Repository", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      (document.activeElement as HTMLInputElement | null)?.getAttribute(
        "aria-label",
      ) === "Ref" &&
      (document.activeElement as HTMLInputElement).value === "main",
  );
  const sent = commandRequest(page);
  await page.getByLabel("Ref", { exact: true }).press("Enter");
  const body = (await sent).postDataJSON() as {
    repositories: { repositoryId: string; ref: string }[];
  };
  assert.equal(body.repositories[0]?.repositoryId, "R_atlas");
  assert.equal(body.repositories[0]?.ref, "main");
});

test("Setup clears a row's folder and ref when its repository is removed", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  await page.getByLabel("Project name", { exact: true }).fill("Cleared");
  await chooseRepository(page, "acme/atlas");
  await page.getByLabel("Local repository path").fill("~/src/atlas");
  // Changing the repository keeps the folder and checks it against the new repository.
  await chooseRepository(page, "acme/relay");
  assert.equal(
    await page.getByLabel("Local repository path").inputValue(),
    "~/src/atlas",
  );
  await page
    .getByText(
      "This folder is a checkout of acme/atlas, not acme/relay. Choose another folder or change the repository.",
    )
    .waitFor();
  // No repository clears the row: nothing hidden reaches the command.
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption({ label: "No repository · repository-free" });
  await page.getByLabel("Local repository path").waitFor({ state: "detached" });
  // Choosing a repository again starts from an empty folder.
  await chooseRepository(page, "acme/atlas");
  assert.equal(await page.getByLabel("Local repository path").inputValue(), "");
  await page
    .getByLabel("Repository", { exact: true })
    .selectOption({ label: "No repository · repository-free" });
  const sent = commandRequest(page);
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  assert.equal("repositories" in body, false);
  await savedOutcome(page, /^Created Cleared\. It's paused\./);
});

test("Setup lists GitHub Projects linked to every chosen repository once", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  const repositories = page.getByLabel("Repository", { exact: true });
  const project = page.getByLabel("GitHub Project", { exact: true });
  await chooseRepository(page, "acme/relay");
  await page
    .getByRole("button", { name: "Add another repository", exact: true })
    .click();
  await repositories.nth(1).selectOption({ label: "acme/atlas" });
  // atlas is the second row, yet its linked Project is found and preselected.
  await page
    .getByText("Found automatically: 1 GitHub Project linked to acme/atlas.", {
      exact: false,
    })
    .waitFor();
  assert.equal(await project.inputValue(), "PVT_atlas");
  const options = await project.locator("option").allTextContents();
  assert.equal(
    options.filter((o) => o.startsWith("Atlas roadmap")).length,
    1,
    JSON.stringify(options),
  );
  assert.ok(options.includes("Atlas roadmap · linked to acme/atlas"));
});

test("Setup keeps a revoked lead visible instead of sending a hidden one", async (_t, journey) => {
  const { f, page, profiles } = await setupJourney(journey);
  const lead = page.getByLabel("Lead profile", { exact: true });
  await lead.selectOption({ label: "Mira" });
  f.service.domain().execute({
    type: "profile.configure",
    actor: "operator",
    key: crypto.randomUUID(),
    profileId: profiles.Mira,
    expectedVersion: 1,
    revoked: true,
  } as never);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await lead
    .locator("option:checked", { hasText: "Lead profile unavailable" })
    .waitFor({ state: "attached" });
  assert.equal(await lead.inputValue(), profiles.Mira);
});

test("Setup keeps a folder chosen while discovery was unavailable visible after Retry", async (_t, journey) => {
  const { page, discoveryState } = await setupJourney(journey);
  discoveryState.failure = new DiscoveryFailure("rate-limited");
  await page.reload();
  await page
    .getByText(
      "GitHub discovery is unavailable: GitHub's rate limit was reached.",
    )
    .waitFor();
  // The folder is chosen before the repository is typed.
  await page.getByLabel("Local repository path").fill("~/src/atlas");
  delete discoveryState.failure;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  // Retry disappears once every discovery read has landed.
  await page
    .getByRole("button", { name: "Retry", exact: true })
    .waitFor({ state: "detached" });
  // The row stays in typed entry with its folder, never hidden behind the list.
  assert.equal(
    await page.getByLabel("Local repository path").inputValue(),
    "~/src/atlas",
  );
  await page.getByLabel("Repository (owner/name)").waitFor();
});

test("Setup validates a typed row holding only a ref instead of dropping it", async (_t, journey) => {
  const { f, page } = await setupJourney(journey, { discovery: false });
  await page.getByLabel("Project name", { exact: true }).fill("Ref only");
  await page.getByLabel("Ref", { exact: true }).fill("main");
  let sent = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/operator/commands")) sent++;
  });
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  await page.getByText(fixFields).waitFor();
  assert.equal(sent, 0);
  assert.equal(f.service.domain().projects().length, 0);
  assert.equal(
    await page.getByLabel("Ref", { exact: true }).inputValue(),
    "main",
  );
});

/** Every command the page sends from now on. */
const sentCommands = (page: Page) => {
  const sent: { type: string; [field: string]: unknown }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      sent.push(r.postDataJSON());
  });
  return sent;
};
const profileGroup = (page: Page) =>
  page.getByRole("group", { name: "New lead profile" });

test("Setup creates the lead profile inline and keeps every other setup value", async (_t, journey) => {
  const { f, page } = await setupJourney(journey, {
    profiles: false,
    discovery: false,
  });
  const inline = profileGroup(page);
  await inline.waitFor();
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Project instructions");
  await page.getByLabel("Repository (owner/name)").fill("acme/atlas");
  await page.getByLabel("Ref", { exact: true }).fill("main");
  await page.getByLabel("Local repository path").fill("~/src/atlas");
  for (const field of ["Profile name", "Summary", "Profile instructions"])
    await inline.getByLabel(field, { exact: true }).waitFor();
  assert.equal(await inline.getByLabel("Runtime").inputValue(), "codex");
  await captureBrowserEvidence(page, "1366-setup-inline-profile");
  const sent = sentCommands(page);
  // Enter with the name empty checks the profile only; it never submits the project.
  await inline.getByLabel("Profile name", { exact: true }).press("Enter");
  await page.getByText(fixFields).waitFor();
  assert.equal(
    await inline
      .getByLabel("Profile name", { exact: true })
      .getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(sent.length, 0);
  await inline.getByLabel("Profile name", { exact: true }).fill("Ada");
  await inline.getByLabel("Profile name", { exact: true }).press("Enter");
  await savedOutcome(page, /^Profile created\. Other setup values kept\./);
  assert.deepEqual(
    sent.map((c) => c.type),
    ["profile.create"],
  );
  const [created] = sent as unknown as {
    profileId: string;
    runtime: unknown;
    capabilities: string;
  }[];
  assert.deepEqual(created?.runtime, { harness: "codex" });
  assert.equal(created?.capabilities, "");
  const lead = page.getByLabel("Lead profile", { exact: true });
  await lead.waitFor();
  assert.equal(await lead.inputValue(), created?.profileId);
  await inline.waitFor({ state: "detached" });
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas",
  );
  assert.equal(
    await page.getByLabel("Instructions", { exact: true }).inputValue(),
    "Project instructions",
  );
  assert.equal(
    await page.getByLabel("Repository (owner/name)").inputValue(),
    "acme/atlas",
  );
  assert.equal(
    await page.getByLabel("Local repository path").inputValue(),
    "~/src/atlas",
  );
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  await savedOutcome(page, /^Created Atlas\./);
  assert.deepEqual(
    sent.map((c) => c.type),
    ["profile.create", "project.create"],
  );
  assert.equal(sent[1]?.leadProfileId, created?.profileId);
  assert.equal(f.service.domain().projects().length, 1);
  assert.equal(f.runtime.turns, 0);
});

test("Setup keeps its input when the inline profile is rejected", async (_t, journey) => {
  const { page } = await setupJourney(journey, { profiles: false });
  const inline = profileGroup(page);
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  const name = inline.getByLabel("Profile name", { exact: true });
  await name.fill("x".repeat(513));
  const sent = sentCommands(page);
  await inline.getByRole("button", { name: "Create profile" }).click();
  await page.getByText(fixFields).waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(await name.inputValue(), "x".repeat(513));
  assert.equal(await name.getAttribute("aria-invalid"), "true");
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Atlas",
  );
  assert.equal(sent.length, 0);
  // The project can still be created without a lead.
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  // The inline error does not linger beside the project's own outcome.
  await savedOutcome(page, /^Created Atlas\./);
  assert.equal(sent.at(-1)?.leadProfileId, null);
});

test("Setup warns before leaving only while it holds changed input", async (_t, journey) => {
  const { page } = await setupJourney(journey);
  const prompts = () =>
    page.evaluate(() => {
      const leaving = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    });
  const becomes = (expected: boolean) =>
    page.waitForFunction((want) => {
      const leaving = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented === want;
    }, expected);
  assert.equal(await prompts(), false);
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  await becomes(true);
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  await page.getByText(/^Created Atlas\./).waitFor();
  await becomes(false);
});

/** A schema-valid readiness read: everything passes except the named checks. */
const readinessBody = (
  failing: Partial<Record<ReadinessCheckId, "fail" | "not-configured">> = {},
) =>
  JSON.stringify(
    readinessSchema.parse({
      data: {
        checks: readinessCheckIds.map((id) => ({
          id,
          label: id,
          status: failing[id] ?? "pass",
          reason: failing[id] ? `${id} reason` : null,
          fix: failing[id] ? `${id} fix` : null,
        })),
      },
      observedAt: Date.now(),
    }),
  );
const stubReadiness = (
  page: Page,
  failing: Partial<Record<ReadinessCheckId, "fail" | "not-configured">> = {},
) =>
  page.route("**/api/operator/readiness", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: readinessBody(failing),
    }),
  );
const resumeLabel = "Resume and create first task";
/** Create a repository-free project and wait for its ready check. */
async function createProject(
  page: Page,
  sent: ReturnType<typeof sentCommands>,
  lead = "Mira",
) {
  await page.getByLabel("Project name", { exact: true }).fill("Atlas");
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: lead });
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const ready = page.getByRole("region", { name: "Ready check" });
  await ready.waitFor();
  const projectId = String(
    sent.find((c) => c.type === "project.create")?.projectId,
  );
  return {
    ready,
    projectId,
    resume: ready.getByRole("button", { name: resumeLabel, exact: true }),
    composer: (id = projectId) =>
      page.waitForURL(
        (url) =>
          url.pathname === "/app/tasks/new" &&
          url.searchParams.get("project") === id,
      ),
  };
}

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
  assert.equal(await addClaude.getAttribute("href"), "/app/settings/runtime");
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
  await check.waitFor({ state: "detached" });
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
  // Frame 147: Resume and Keep paused stack at the full width of the check.
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
  // The header Refresh re-reads the workspace; only then is the lead judged.
  await page.unroute("**/api/operator/workspace");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await ready.getByText("Checking readiness…").waitFor({ state: "detached" });
  assert.equal(await resume.isEnabled(), true);
});
