import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page, Route } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { fakeJira, jiraIssue, json } from "../fixtures/fake-jira.js";
import {
  outcomeMessages,
  savedOutcome,
} from "../fixtures/operator-settings.js";
import { commandRequest, setupJourney } from "../fixtures/setup-browser.js";

const test = browserSuite("operator-jira-source-browser");

/** The public form is usable before its session-only saved query read has hydrated it. */
const waitForQueries = (page: Page, expected: string) =>
  page.waitForFunction(
    (value) =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="JQL queries, one per line"]',
      )?.value === value,
    expected,
  );

const site = "example.atlassian.net";
const variables = {
  FIXTURE_JIRA_BROWSER_SITE: `https://${site}`,
  FIXTURE_JIRA_BROWSER_EMAIL: "chris@example.test",
  FIXTURE_JIRA_BROWSER_TOKEN: "jira-browser-token-canary-1318",
};

for (const schedule of [
  "deleted query",
  "untouched query",
  "private read pending",
  "two partial conflicts",
  "two complete conflicts",
] as const) {
  test(`Jira conflict review preserves query intent: ${schedule}`, async (_t, journey) => {
    for (const [name, value] of Object.entries(variables)) {
      const previous = process.env[name];
      journey.cleanup(async () => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }, `restore-${name}`);
      process.env[name] = value;
    }
    const jira = fakeJira((request) =>
      request.url.pathname.endsWith("/myself")
        ? json({ accountId: "acct-1", displayName: "Chris Example" })
        : json({ issues: [] }),
    );
    const { f, web, page } = await setupJourney(journey, {
      discovery: false,
      projects: true,
      jiraFetcher: jira.fetcher,
    });
    const domain = f.service.domain();
    const projectId = String(domain.projects()[0]?.id);
    domain.execute({
      type: "issue-tracker-credential.configure",
      actor: "operator",
      key: randomUUID(),
      issueTracker: "jira",
      instance: site,
      credential: {
        siteRef: "env:FIXTURE_JIRA_BROWSER_SITE",
        emailRef: "env:FIXTURE_JIRA_BROWSER_EMAIL",
        tokenRef: "env:FIXTURE_JIRA_BROWSER_TOKEN",
      },
    });
    const original = [
      { id: "S-1", kind: "jql" as const, jql: "project = FIRST" },
      { id: "S-2", kind: "jql" as const, jql: "project = SECOND" },
    ];
    domain.execute({
      type: "jira.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 1,
      instance: site,
      selections: original,
    });
    f.service.jiraJqlErrors = async () => [];
    await page.goto(
      `${web.origin}/app/projects/${projectId}/settings?tab=github&tracker=jira`,
    );
    await waitForQueries(page, original.map((row) => row.jql).join("\n"));
    if (schedule === "untouched query")
      await page.getByLabel("Closed Jira issues").selectOption("done");
    else
      await page
        .getByLabel("JQL queries, one per line")
        .fill(schedule === "two complete conflicts" ? "" : "project = EDITED");
    const latest = original.map((row, index) =>
      index === 0 ? { ...row, jql: "project = LATEST" } : row,
    );
    domain.execute({
      type: "jira.configure",
      actor: "operator",
      key: randomUUID(),
      projectId,
      expectedVersion: 2,
      instance: site,
      selections: latest,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    journey.cleanup(async () => release(), "release-private-queries");
    let received!: () => void;
    const privateRead = new Promise<void>((resolve) => {
      received = resolve;
    });
    let finished!: () => void;
    const fulfilled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let holding = false;
    const path = `**/api/operator/projects/${projectId}/private-values`;
    const hold = async (route: Route) => {
      if (holding) return route.continue();
      holding = true;
      try {
        const response = await route.fetch();
        received();
        if (schedule === "private read pending") await gate;
        await route.fulfill({ response });
      } finally {
        finished();
      }
    };
    await page.route(path, hold);
    try {
      const settled =
        schedule === "private read pending"
          ? undefined
          : page.waitForResponse((r) =>
              r.url().endsWith(`/projects/${projectId}/private-values`),
            );
      await page
        .getByRole("button", { name: "Save Jira source", exact: true })
        .click();
      await page
        .getByText("A newer version was saved elsewhere.", { exact: true })
        .waitFor();
      await privateRead;
      if (settled) await (await settled).finished();
      await page
        .getByRole("button", { name: "Review changes", exact: true })
        .click();
      const expected =
        schedule === "untouched query"
          ? "project = LATEST\nproject = SECOND"
          : schedule === "two complete conflicts"
            ? ""
            : "project = EDITED";
      await waitForQueries(page, expected);
      if (
        schedule === "two partial conflicts" ||
        schedule === "two complete conflicts"
      ) {
        domain.execute({
          type: "jira.configure",
          actor: "operator",
          key: randomUUID(),
          projectId,
          expectedVersion: 3,
          instance: site,
          selections: latest,
        });
        const nextRead = page.waitForResponse((r) =>
          r.url().endsWith(`/projects/${projectId}/private-values`),
        );
        const conflict = page.waitForResponse(
          (r) =>
            r.url().endsWith("/api/operator/commands") &&
            r.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Save Jira source", exact: true })
          .click();
        assert.equal((await conflict).status(), 409);
        await (await nextRead).finished();
        await page
          .getByRole("button", { name: "Review changes", exact: true })
          .click();
        await waitForQueries(page, expected);
      }
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/operator/commands") &&
          r.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Save Jira source", exact: true })
        .click();
      assert.equal((await saved).status(), 200);
      assert.deepEqual(
        domain.jiraConfiguration(projectId)!.selections,
        schedule === "untouched query"
          ? latest
          : schedule === "two complete conflicts"
            ? []
            : [{ ...original[0]!, jql: "project = EDITED" }],
      );
      assert.equal(
        domain.jiraConfiguration(projectId)!.closedIssues,
        schedule === "untouched query" ? "done" : "skip",
      );
    } finally {
      release();
      await fulfilled;
      await page.unroute(path, hold);
    }
  });
}

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
  const closedIssues = page.getByLabel("Closed Jira issues");
  assert.equal(await closedIssues.inputValue(), "skip");
  await closedIssues.focus();
  await closedIssues.press("t");
  assert.equal(await closedIssues.inputValue(), "done");
  assert.equal(
    await closedIssues.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Jira site").selectOption(site);
  await page.getByLabel("JQL queries, one per line").fill("BAD =");
  await page.getByRole("button", { name: "Save Jira source" }).click();
  await page
    .getByText("Error in the JQL Query: BAD.", { exact: false })
    .first()
    .waitFor();
  assert.equal(f.service.domain().jiraConfiguration(projectId), null);
  assert.equal(await closedIssues.inputValue(), "done");

  // Good JQL previews its matches, then saves, and a refresh shows the last sync.
  await page.getByLabel("JQL queries, one per line").fill("project = ABC");
  await page.getByRole("button", { name: "Preview matches" }).click();
  await page.getByText("ABC-1 · Issue 1 · To Do").waitFor();
  const saved = commandRequest(page);
  await page.getByRole("button", { name: "Save Jira source" }).click();
  const command = (await saved).postDataJSON();
  assert.equal(command.closedIssues, "done");
  assert.deepEqual(command.selections, [
    { id: "S-1", kind: "jql", jql: "project = ABC" },
  ]);
  await savedOutcome(page);
  // Reopening the editor loads the saved query through the private read.
  await page.reload();
  await waitForQueries(page, "project = ABC");
  assert.equal(
    await page.getByLabel("JQL queries, one per line").inputValue(),
    "project = ABC",
  );
  assert.equal(await closedIssues.inputValue(), "done");
  await page
    .getByLabel("JQL queries, one per line")
    .fill("project = ABC AND labels = ready");
  const edited = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/operator/commands") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save Jira source" }).click();
  assert.equal((await edited).status(), 200);
  await page.reload();
  await page.getByLabel("JQL queries, one per line").waitFor();
  assert.equal(await closedIssues.inputValue(), "done");
  // The ordinary Jira settings route mounts the same control as the setup route.
  await page.goto(
    `${web.origin}/app/projects/${projectId}/settings?tab=github`,
  );
  await page.getByLabel("JQL queries, one per line").waitFor();
  assert.equal(await closedIssues.inputValue(), "done");
  await closedIssues.selectOption("skip");
  const switched = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/operator/commands") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save Jira source" }).click();
  assert.equal((await switched).status(), 200);
  await page.reload();
  await page.getByLabel("JQL queries, one per line").waitFor();
  assert.equal(await closedIssues.inputValue(), "skip");
  await closedIssues.selectOption("done");
  const latest = f.service.domain().jiraConfiguration(projectId)!;
  f.service.domain().execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: latest.version,
    instance: site,
    selections: latest.selections,
  });
  await page.getByRole("button", { name: "Save Jira source" }).click();
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await closedIssues.inputValue(), "done");
  await page.reload();
  await page.getByLabel("JQL queries, one per line").waitFor();
  assert.equal(await closedIssues.inputValue(), "skip");
  // A query saved elsewhere across lines stays one selection in the editor.
  f.service.domain().execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion:
      f.service.domain().jiraConfiguration(projectId)?.version ?? 0,
    instance: site,
    selections: [
      { id: "S-1", kind: "jql", jql: "project = ABC\nAND status != Done" },
    ],
  });
  let releaseQueries!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseQueries = resolve;
  });
  let receivedQueries!: (value: { jql: { jql: string }[] }) => void;
  const received = new Promise<{ jql: { jql: string }[] }>((resolve) => {
    receivedQueries = resolve;
  });
  const privatePath = `**/api/operator/projects/${projectId}/private-values`;
  const holdQueries = async (route: Route) => {
    const response = await route.fetch();
    receivedQueries((await response.json()).data.source);
    await gate;
    await route.fulfill({ response });
  };
  await page.route(privatePath, holdQueries);
  try {
    await page.reload();
    const privateSource = await received;
    await page.getByLabel("JQL queries, one per line").waitFor();
    assert.equal(
      privateSource.jql[0]?.jql,
      "project = ABC\nAND status != Done",
    );
    assert.equal(
      await page.getByLabel("JQL queries, one per line").inputValue(),
      "",
    );
    await page
      .getByRole("button", { name: "Remove unavailable source 1", exact: true })
      .waitFor();
    releaseQueries();
    await waitForQueries(page, "project = ABC AND status != Done");
    assert.equal(
      await page.getByLabel("JQL queries, one per line").inputValue(),
      "project = ABC AND status != Done",
    );
  } finally {
    releaseQueries();
    await page.unroute(privatePath, holdQueries);
  }
  // A failed private read leaves the credentials, sync and refresh in place, and Retry loads it.
  let failed = false;
  await page.route("**/api/operator/projects/*/private-values", (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 503, body: "{}" });
  });
  await page.reload();
  await page
    .getByText("Saved queries unavailable; kept as unavailable rows.")
    .waitFor();
  await page.getByRole("region", { name: "Jira credentials" }).waitFor();
  await page.getByRole("button", { name: "Refresh now" }).waitFor();
  await page
    .getByRole("button", { name: "Retry saved queries", exact: true })
    .click();
  await waitForQueries(page, "project = ABC AND status != Done");
  assert.equal(
    await page.getByLabel("JQL queries, one per line").inputValue(),
    "project = ABC AND status != Done",
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

test("a Jira readiness rule is edited in settings, explains a Draft task, and a blocker links to Jira", async (_t, journey) => {
  for (const [name, value] of Object.entries(variables)) {
    const previous = process.env[name];
    journey.cleanup(async () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }, `restore-${name}`);
    process.env[name] = value;
  }
  const jira = fakeJira(() =>
    json({
      issues: [
        jiraIssue(1, {
          issuelinks: [
            {
              type: { inward: "is blocked by", outward: "blocks" },
              inwardIssue: {
                id: "10003",
                key: "ABC-3",
                fields: {
                  status: { statusCategory: { key: "indeterminate" } },
                },
              },
            },
          ],
        }),
        jiraIssue(2, { status: { id: "3", name: "In Progress" } }),
      ],
    }),
  );
  const { f, web, page } = await setupJourney(journey, {
    discovery: false,
    projects: true,
    jiraFetcher: jira.fetcher,
  });
  const domain = f.service.domain();
  const projectId = String(domain.projects()[0]?.id);
  domain.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    credential: {
      siteRef: "env:FIXTURE_JIRA_BROWSER_SITE",
      emailRef: "env:FIXTURE_JIRA_BROWSER_EMAIL",
      tokenRef: "env:FIXTURE_JIRA_BROWSER_TOKEN",
    },
  });
  domain.execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: domain.jiraConfiguration(projectId)?.version ?? 1,
    instance: site,
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
  });
  await page.goto(
    `${web.origin}/app/projects/${projectId}/settings?tab=github&tracker=jira`,
  );
  const conditions = page.getByLabel("Readiness conditions, one per line");
  await conditions.fill("status in 1, 7");
  const saved = commandRequest(page);
  await page.getByRole("button", { name: "Save Jira source" }).click();
  assert.deepEqual((await saved).postDataJSON().readiness, {
    mode: "all",
    conditions: [{ kind: "status", operator: "in", statusIds: ["1", "7"] }],
  });
  await page
    .getByText("Saved rule: Jira status is one of 1, 7.", { exact: false })
    .waitFor();
  await page.reload();
  await conditions.waitFor();
  assert.equal(await conditions.inputValue(), "status in 1, 7");
  // An unreadable line is refused where it is typed, and nothing is sent.
  await conditions.fill("status has 1");
  await page.getByRole("button", { name: "Save Jira source" }).click();
  await page
    .getByText("Cannot read “status has 1”.", { exact: false })
    .first()
    .waitFor();

  await page.getByRole("button", { name: "Refresh now" }).click();
  await page.getByText(/S-1 · last synced/).waitFor();
  const stores = f.service
    .githubSources()
    .forTracker({ provider: "jira", instance: site });
  const draft = String(stores.issue("10002")?.taskId);
  const blocked = String(stores.issue("10001")?.taskId);
  await page.goto(`${web.origin}/app/tasks?state=all&ready=any`);
  await page
    .locator(`.task-list [data-task-id="${draft}"]`)
    .getByText("Not Ready: needs Jira status is one of To Do, 7", {
      exact: true,
    })
    .waitFor();
  await page.goto(`${web.origin}/app/tasks/${blocked}`);
  const link = page.getByRole("link", { name: "ABC-3" }).first();
  assert.equal(await link.getAttribute("href"), `https://${site}/browse/ABC-3`);
});

test("a Jira status mapping is typed on the Jira tab with no grant, states what saving allows, and is refused or saved in the service's words", async (_t, journey) => {
  for (const [name, value] of Object.entries(variables)) {
    const previous = process.env[name];
    journey.cleanup(async () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }, `restore-${name}`);
    process.env[name] = value;
  }
  const jira = fakeJira(() => json({ issues: [jiraIssue(1)] }));
  const { f, web, page } = await setupJourney(journey, {
    discovery: false,
    projects: true,
    jiraFetcher: jira.fetcher,
  });
  const domain = f.service.domain();
  const projectId = String(domain.projects()[0]?.id);
  domain.execute({
    type: "issue-tracker-credential.configure",
    actor: "operator",
    key: randomUUID(),
    issueTracker: "jira",
    instance: site,
    credential: {
      siteRef: "env:FIXTURE_JIRA_BROWSER_SITE",
      emailRef: "env:FIXTURE_JIRA_BROWSER_EMAIL",
      tokenRef: "env:FIXTURE_JIRA_BROWSER_TOKEN",
    },
  });
  domain.execute({
    type: "jira.configure",
    actor: "operator",
    key: randomUUID(),
    projectId,
    expectedVersion: domain.jiraConfiguration(projectId)?.version ?? 1,
    instance: site,
    selections: [{ id: "S-1", kind: "jql", jql: "project = ABC" }],
    readiness: {
      mode: "all",
      conditions: [{ kind: "status", operator: "in", statusIds: ["1", "3"] }],
    },
  });
  await page.goto(
    `${web.origin}/app/projects/${projectId}/settings?tab=github&tracker=jira`,
  );
  const panel = page.locator("#status-mapping");
  await panel
    .getByRole("heading", { name: "Status mapping", exact: true })
    .waitFor();
  for (const label of [
    "First turn started",
    "PR handed back for review",
    "Stopped, uncertain or blocked",
    "Done",
  ])
    await panel.getByLabel(label, { exact: false }).first().waitFor();

  // Typing a status needs no grant, and the editor states what saving allows.
  await panel.getByLabel("First turn started", { exact: true }).fill("1");
  await panel.getByText("Saving allows cab to move issues to 1").waitFor();
  assert.equal(await panel.getByText("(no grant)").count(), 0);
  // A status the readiness rule does not accept is refused in the service's words, and the draft stays.
  await panel.getByLabel("First turn started", { exact: false }).fill("10005");
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  await outcomeMessages(panel)
    .filter({
      hasText: /First turn started → 10005: the readiness rule does not accept/,
    })
    .waitFor();
  assert.equal(domain.statusMapping(projectId).mapping, null);

  // An accepted status saves.
  await panel.getByLabel("First turn started", { exact: false }).fill("3");
  await panel.getByLabel("Done", { exact: false }).fill("10005");
  await panel
    .getByRole("region", { name: "Status mapping changes" })
    .getByText("Done: moves the issue to Jira status 10005.")
    .waitFor();
  await captureBrowserEvidence(page, "jira-status-mapping");
  const saved = commandRequest(page);
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  const mapping = {
    tracker: "jira",
    events: {
      turnStarted: "3",
      handedBack: null,
      held: null,
      done: "10005",
    },
  };
  assert.deepEqual((await saved).postDataJSON().mapping, mapping);
  await savedOutcome(panel);
  assert.deepEqual(domain.statusMapping(projectId).mapping, mapping);
  await page.reload();
  // The saved status loads into the editor once the configuration is read.
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>("#status-mapping input")
        ?.value === "3",
  );
});
