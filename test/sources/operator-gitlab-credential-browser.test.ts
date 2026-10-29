import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { createFakeGlab, fakeGlabToken } from "../fixtures/fake-glab.js";
import { savedOutcome } from "../fixtures/operator-settings.js";
import { commandRequest, setupJourney } from "../fixtures/setup-browser.js";
const test = browserSuite("operator-gitlab-credential-browser");

const host = "gitlab.example.com";
const VARIABLE = "FIXTURE_GL_BROWSER";
const VALUE = "glpat-browser-env-canary-311";
const reader = () => ({
  user: async () => ({ username: "fake-user" }),
  projects: async () => ({ projects: [], truncated: false }),
});

test("Settings adds a glab credential, warns on an override, switches to a variable and clears", async (_t, journey) => {
  for (const name of [VARIABLE, "GITLAB_TOKEN"]) {
    const previous = process.env[name];
    journey.cleanup(async () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }, `restore-${name}`);
    delete process.env[name];
  }
  const glab = createFakeGlab();
  journey.cleanup(async () => glab.close(), "fake-glab.close");
  const { f, page } = await setupJourney(journey, {
    discovery: false,
    path: "/app/settings",
    glabExecutable: glab.executable,
    gitlab: reader,
  });
  const section = page.getByRole("region", { name: "GitLab credentials" });
  await section.getByText("GitLab credentials · not configured").waitFor();
  await section.getByRole("button", { name: "Add GitLab host" }).click();
  // An invalid host is a field error and sends nothing.
  await section.getByLabel("GitLab host").fill("github.com");
  await section.getByRole("button", { name: "Use this login" }).click();
  await section.getByText("Enter the GitLab host", { exact: false }).waitFor();
  // A mixed-case host is sent normalised, so the saved receipt matches.
  await section.getByLabel("GitLab host").fill("GitLab.Example.com");
  const added = commandRequest(page);
  await section.getByRole("button", { name: "Use this login" }).click();
  const { key: _key, ...sent } = (await added).postDataJSON();
  assert.deepEqual(sent, {
    type: "code-host-credential.configure",
    codeHost: "gitlab",
    host,
    credentialRef: `glab:${host}`,
  });
  await section
    .getByText(
      `GitLab ${host} · GitLab CLI · @fake-user · used for project lists and branch delivery`,
    )
    .waitFor();
  await savedOutcome(page);
  assert.equal(await section.getByText(/GITLAB_TOKEN/).count(), 0);
  await captureBrowserEvidence(page, "1366-settings-gitlab-glab");

  // The override warning appears once the service environment shadows the login.
  process.env.GITLAB_TOKEN = "glpat-shadow-browser-311";
  await page.reload();
  await section
    .getByText(/GITLAB_TOKEN, GITLAB_ACCESS_TOKEN or OAUTH_TOKEN/)
    .waitFor();
  delete process.env.GITLAB_TOKEN;

  // Switching to a variable shows its kind and never its name.
  process.env[VARIABLE] = VALUE;
  await page.reload();
  await section.getByRole("button", { name: `Change ${host}` }).click();
  await section.getByLabel("Environment variable · advanced").check();
  await section.getByLabel("Variable name").fill(VARIABLE);
  const switched = commandRequest(page);
  await section.getByRole("button", { name: "Save reference" }).click();
  assert.equal(
    (await switched).postDataJSON().credentialRef,
    `env:${VARIABLE}`,
  );
  await section
    .getByText(`GitLab ${host} · Environment variable · @fake-user`, {
      exact: false,
    })
    .waitFor();
  await savedOutcome(page);
  const text = await page.locator("body").innerText();
  for (const secret of [VARIABLE, VALUE, fakeGlabToken])
    assert.equal(text.includes(secret), false, secret);
  assert.equal(
    (
      await page.evaluate(async () =>
        (await fetch("/api/operator/code-host-credentials")).text(),
      )
    ).includes(VARIABLE),
    false,
  );

  // Clear removes the host.
  const cleared = commandRequest(page);
  await section.getByRole("button", { name: `Clear ${host}` }).click();
  assert.equal((await cleared).postDataJSON().credentialRef, null);
  await section.getByText("GitLab credentials · not configured").waitFor();
  assert.deepEqual(f.service.domain().codeHostCredentials(), []);
});
