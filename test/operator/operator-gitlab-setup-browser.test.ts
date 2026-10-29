import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createFakeGlab } from "../fixtures/fake-glab.js";
import { commandRequest, setupJourney } from "../fixtures/setup-browser.js";
import { checkout } from "../fixtures/setup-home.js";
const test = browserSuite("operator-gitlab-setup-browser");

const host = "gitlab.example.com";
const reader = () => ({
  user: async () => ({ username: "fake-user" }),
  projects: async () => ({
    projects: [
      { repositoryId: "42", projectPath: "group/app", defaultBranch: "main" },
      {
        repositoryId: "43",
        projectPath: "group/sub/lib",
        defaultBranch: "trunk",
      },
    ],
    truncated: false,
  }),
});

test("Setup lists GitLab projects and creates a GitLab link from a picked checkout", async (_t, journey) => {
  const glab = createFakeGlab();
  journey.cleanup(async () => glab.close(), "fake-glab.close");
  const { f, home, page } = await setupJourney(journey, {
    discovery: false,
    glabExecutable: glab.executable,
    gitlab: reader,
  });
  f.service.domain().execute({
    type: "code-host-credential.configure",
    key: randomUUID(),
    actor: "operator",
    codeHost: "gitlab",
    host,
    credentialRef: `glab:${host}`,
  });
  await checkout(join(home.home, "gl", "app"), `https://${host}/group/app.git`);
  await page.reload();
  await page.getByLabel("Project name", { exact: true }).fill("Forge");
  await page
    .getByLabel("Lead profile", { exact: true })
    .selectOption({ label: "Mira" });
  await page.getByRole("button", { name: "Add a repository" }).click();
  await page.getByRole("button", { name: "Add a GitLab repository" }).click();
  await page.getByText(`Discovered from ${host} · 2 projects`).waitFor();
  assert.deepEqual(
    await page.getByLabel("GitLab project").locator("option").allTextContents(),
    ["Choose a project", "group/app", "group/sub/lib"],
  );
  await page.getByLabel("GitLab project").selectOption({ label: "group/app" });
  assert.equal(await page.getByLabel("GitLab ref").inputValue(), "main");
  await page.getByRole("button", { name: "Choose GitLab folder…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^gl\b/ }).click();
  await dialog.getByRole("button", { name: /^app\b/ }).click();
  await dialog.getByRole("button", { name: "Use this folder" }).click();
  await page
    .getByText(
      `Verified on this Mac: git checkout · origin ${host}/group/app · main available.`,
    )
    .waitFor();
  const created = commandRequest(page);
  await page
    .getByRole("button", { name: "Create paused project", exact: true })
    .click();
  const body = (await created).postDataJSON();
  assert.deepEqual(body.repositories, [
    {
      codeHost: "gitlab",
      host,
      projectPath: "group/app",
      repositoryId: "42",
      path: "~/gl/app",
      ref: "main",
    },
  ]);
  // A GitLab-only project records no GitHub source credential.
  assert.equal("sourceCredentialRef" in body, false);
  await page.getByText(`Created Forge. It's paused.`).waitFor();
  await page.getByText(`${host}/group/app (main)`, { exact: false }).waitFor();
  const [project] = f.service.domain().projects();
  const links = f.service.domain().repositoryLinks(String(project?.id)).links;
  assert.deepEqual(
    links.map((l) => ({
      codeHost: l.codeHost,
      host: l.host,
      id: l.repositoryId,
    })),
    [{ codeHost: "gitlab", host, id: "42" }],
  );
});
