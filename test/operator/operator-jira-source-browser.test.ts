import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { fakeJira, jiraIssue, json } from "../fixtures/fake-jira.js";
import { savedOutcome } from "../fixtures/operator-settings.js";
import { commandRequest, setupJourney } from "../fixtures/setup-browser.js";

const test = browserSuite("operator-jira-source-browser");

const site = "example.atlassian.net";
const variables = {
  FIXTURE_JIRA_BROWSER_SITE: `https://${site}`,
  FIXTURE_JIRA_BROWSER_EMAIL: "chris@example.test",
  FIXTURE_JIRA_BROWSER_TOKEN: "jira-browser-token-canary-1318",
};

test("a project is set up on Jira: credential, rejected and previewed JQL, sync, task detail and unavailable actions", async (_t, journey) => {
  for (const [name, value] of Object.entries(variables)) {
    const previous = process.env[name];
    journey.cleanup(async () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }, `restore-${name}`);
    process.env[name] = value;
  }
  const jira = fakeJira((request) => {
    if (request.url.pathname.endsWith("/myself"))
      return json({ accountId: "acct-1", displayName: "Chris Example" });
    const body = request.body as { jql?: string; queries?: string[] };
    if (request.url.pathname.endsWith("/jql/parse"))
      return json({
        queries: [
          body.queries?.[0]?.includes("BAD")
            ? { query: "x", errors: ["Error in the JQL Query: BAD."] }
            : { query: "ok" },
        ],
      });
    return json({ issues: [jiraIssue(1), jiraIssue(2)] });
  });
  const { f, web, page } = await setupJourney(journey, {
    discovery: false,
    projects: true,
    jiraFetcher: jira.fetcher,
  });
  const projectId = String(f.service.domain().projects()[0]?.id);
  await page.goto(
    `${web.origin}/app/projects/${projectId}/settings?tab=github&tracker=jira`,
  );
  const credentials = page.getByRole("region", { name: "Jira credentials" });
  await credentials
    .getByText("No Jira site credential is configured.")
    .waitFor();
  await credentials.getByRole("button", { name: "Add Jira site" }).click();
  await credentials
    .getByLabel("Site variable name")
    .fill("FIXTURE_JIRA_BROWSER_SITE");
  await credentials
    .getByLabel("Email variable name")
    .fill("FIXTURE_JIRA_BROWSER_EMAIL");
  await credentials
    .getByLabel("API token variable name")
    .fill("FIXTURE_JIRA_BROWSER_TOKEN");
  const configured = commandRequest(page);
  await credentials.getByRole("button", { name: "Save references" }).click();
  const sent = (await configured).postDataJSON();
  assert.equal(sent.type, "issue-tracker-credential.configure");
  assert.equal(sent.siteRef, "env:FIXTURE_JIRA_BROWSER_SITE");
  await credentials
    .getByText(`Jira ${site} · Chris Example · read-only use`)
    .waitFor();
  await savedOutcome(page);
  // The page never shows a variable name or value once saved.
  const text = await page.locator("body").innerText();
  for (const secret of [...Object.values(variables)])
    assert.equal(text.includes(secret), false, secret);

  // Bad JQL is refused by Jira with its own words and nothing is saved.
  const source = page.getByRole("region", { name: "Jira source" });
  await page.getByLabel("Jira site").selectOption(site);
  await page.getByLabel("JQL queries, one per line").fill("BAD =");
  await page.getByRole("button", { name: "Save Jira source" }).click();
  await page
    .getByText("Error in the JQL Query: BAD.", { exact: false })
    .first()
    .waitFor();
  assert.equal(f.service.domain().jiraConfiguration(projectId), null);

  // Good JQL previews its matches, then saves, and a refresh shows the last sync.
  await page.getByLabel("JQL queries, one per line").fill("project = ABC");
  await page.getByRole("button", { name: "Preview matches" }).click();
  await page.getByText("ABC-1 · Issue 1 · To Do").waitFor();
  const saved = commandRequest(page);
  await page.getByRole("button", { name: "Save Jira source" }).click();
  const command = (await saved).postDataJSON();
  assert.deepEqual(command.selections, [
    { id: "S-1", kind: "jql", jql: "project = ABC" },
  ]);
  await savedOutcome(page);
  // Reopening the editor loads the saved query through the private read.
  await page.reload();
  await page.getByLabel("JQL queries, one per line").waitFor();
  assert.equal(
    await page.getByLabel("JQL queries, one per line").inputValue(),
    "project = ABC",
  );
  await page.getByRole("button", { name: "Refresh now" }).click();
  await page.getByText(/S-1 · last synced/).waitFor();
  await captureBrowserEvidence(page, "1366-jira-source");
  void source;

  // An imported task reads from Jira: key, site, status and an edit link out.
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const taskId = String(stores.issue("10001")?.taskId);
  await page.goto(`${web.origin}/app/tasks/${taskId}`);
  const chip = page.locator(".task-source-chip");
  await chip.waitFor();
  assert.equal(await chip.getAttribute("href"), `https://${site}/browse/ABC-1`);
  assert.match(await chip.innerText(), /ABC-1/);
  const edit = page.getByRole("link", { name: "Edit in Jira" });
  assert.equal(await edit.getAttribute("href"), `https://${site}/browse/ABC-1`);
  await page
    .getByText(`${site} · Issue open (To Do)`, { exact: false })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Improve with lead" }).click();
  await page
    .getByText("Improve with lead isn’t available for Jira issues yet.")
    .waitFor();

  // A local task in the Jira project cannot be published to Jira.
  const localId = randomUUID();
  f.service.domain().execute({
    type: "task.create",
    actor: "operator",
    key: randomUUID(),
    projectId,
    taskId: localId,
    title: "Local note",
    outcome: "Do it",
    ready: false,
  });
  await page.goto(`${web.origin}/app/tasks/${localId}`);
  await page
    .getByRole("button", { name: /Publish/ })
    .first()
    .click();
  await page.getByText("cab can’t publish tasks to Jira yet.").waitFor();
});
