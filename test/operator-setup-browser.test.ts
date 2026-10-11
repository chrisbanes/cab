import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
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
const test = browserSuite("ui06-setup");

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
  await page.getByText("Recorded Atlas as a paused project.").waitFor();
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
  assert.equal(
    await page
      .getByRole("link", { name: "Open project configuration" })
      .getAttribute("href"),
    `/app/projects/${body.projectId}/settings`,
  );
  // The new project joins the sidebar once the workspace re-reads.
  await page
    .locator(`a[href="/app/projects/${body.projectId}"]`)
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Create another project", exact: true })
    .click();
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
  await page.getByText("Recorded Fieldnotes as a paused project.").waitFor();
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
  await page
    .getByRole("alert")
    .filter({ hasText: "Project not created" })
    .waitFor();
  await page
    .getByText("Fix the highlighted field. Every other value is kept.")
    .waitFor();
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
  assert.equal(
    await page
      .getByRole("link", { name: "Create a lead profile" })
      .getAttribute("href"),
    "/app/settings/profiles/new",
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
  await page.getByText("Recorded Atlas as a paused project.").waitFor();
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
  await page
    .getByRole("button", { name: "Create another project", exact: true })
    .click();
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

test("Setup reconciles an unknown create outcome by replaying the exact submission", async (_t, journey) => {
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
      .getByRole("button", { name: "Reconcile exact submission" })
      .waitFor();
    assert.equal(aborted, 1);
    assert.equal(
      await page.getByLabel("Project name", { exact: true }).isDisabled(),
      true,
    );
    await page.unroute("**/api/operator/commands");
    const replay = commandRequest(page);
    await page
      .getByRole("button", { name: "Reconcile exact submission" })
      .click();
    assert.equal(
      ((await replay).postDataJSON() as { key: string }).key,
      first.key,
    );
    await page.getByText("Recorded Unknown as a paused project.").waitFor();
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
  await page.getByText("Recorded WebKit as a paused project.").waitFor();
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
  await page.getByText("Check the highlighted fields.").waitFor();
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
  await page.getByText("Recorded Cleared as a paused project.").waitFor();
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
