import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before } from "node:test";
import type { Page, Route } from "playwright";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  captureSettingsEvidence,
  desktop,
  inFirstViewport,
  noPageOverflow,
  outcomeMessages,
  phone,
  savedOutcome,
  startSettings,
} from "../fixtures/operator-settings.js";
import { fakeDiscovery } from "../fixtures/setup-home.js";

const test = browserSuite("operator-source-import-browser");

const sourceValue = process.env.FIXTURE_GITHUB;
before(() => {
  process.env.FIXTURE_GITHUB = "offline-import-source-value";
});
after(() => {
  if (sourceValue === undefined) delete process.env.FIXTURE_GITHUB;
  else process.env.FIXTURE_GITHUB = sourceValue;
});

const githubTab = "/app/projects/:atlas/settings?tab=github";
const syncTab = "/app/projects/:atlas/settings?tab=sync";

/** Four open issues per selection, two labelled ready: counts the status lines can show. */
const reader: GitHubReaderFactory = () => ({
  async readSelection(selection) {
    const id = String((selection as { id?: string }).id ?? "S");
    return {
      complete: true as const,
      reason: null,
      issues: [1, 2, 3, 4].map((n) => ({
        providerInstance: "github.com" as const,
        nodeId: `I_${id}_${n}`,
        repositoryId: "R_atlas",
        repositoryName: "acme/atlas",
        number: n,
        title: `Issue ${n} of ${id}`,
        body: "Body",
        state: "open" as const,
        labels: n <= 2 ? ["ready"] : [],
        projectFields: [],
      })),
    };
  },
  async readBlockers() {
    return { complete: true, blockers: [], reason: null };
  },
  async readIssueStatus() {
    return { status: "unknown" as const };
  },
});

const start = (
  journey: Parameters<typeof startSettings>[0],
  path = githubTab,
  viewport = desktop,
  options: Parameters<typeof startSettings>[4] = {},
) =>
  startSettings(journey, path, viewport, undefined, {
    readerFactory: reader,
    ...options,
  });
type Started = Awaited<ReturnType<typeof start>>;

/** Saves the source again as another writer; every kept source reads inactive afterwards. */
async function saveElsewhere(s: Started, extra: object[] = []) {
  const domain = s.f.service.domain();
  await new OperatorApi(s.f.service, [s.f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: s.ids.atlas,
    expectedVersion: domain.githubConfiguration(s.ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
      { id: "S-3", keep: true },
      ...extra,
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [{ repositoryId: "acme/atlas", ref: "main" }],
  } as never);
}

/** Preview commands and refreshes the page sends, in the order it sends them. */
function track(page: Page) {
  const previews: {
    key: string;
    selectionId: string;
    expectedVersion: number;
  }[] = [];
  const steps: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (r.url().endsWith("/api/operator/commands")) {
      const body = r.postDataJSON() as Record<string, never>;
      if (body.type === "github.preview") {
        previews.push(body as never);
        steps.push(`preview ${String(body.selectionId)}`);
      }
    } else if (r.url().endsWith("/api/operator/source-refresh"))
      steps.push("refresh");
  });
  return {
    previews,
    steps,
    refreshes: () => steps.filter((s) => s === "refresh").length,
  };
}

const importPanel = (page: Page) =>
  page.getByRole("region", { name: "Import issues" });
const importButton = (page: Page) =>
  page.getByRole("button", { name: "Preview and import now", exact: true });
const clock = (page: Page, iso: string) =>
  page.evaluate((at) => {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, iso);

/** Adds a repository source and saves; the Import issues panel takes the focus. */
async function addAndSave(page: Page) {
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await page.getByLabel("Repository ID", { exact: true }).fill("acme/extra");
  await page.getByLabel("Repository owner", { exact: true }).fill("acme");
  await page.getByLabel("Repository name", { exact: true }).fill("extra");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await importPanel(page).waitFor();
}

/** Answers the refresh with its own project's sources all in `state`. */
async function refreshAs(
  page: Page,
  state: "complete" | "partial" | "never" | "unavailable",
) {
  await page.route("**/api/operator/source-refresh", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const project of body.data.projects)
      for (const s of project.selections) {
        s.state = state;
        if (state !== "complete") s.lastSuccessfulAt = null;
        if (state === "never") s.lastAttemptAt = null;
      }
    await route.fulfill({ response, json: body });
  });
}

/** Holds a route until `release()`, so a test can look at the page while a step is under way. */
function hold() {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

const rowHeadings = (page: Page) =>
  page.locator("form .settings-row h3").allInnerTexts();
const row = (page: Page, text: string | RegExp) =>
  page.locator("form .settings-row", { hasText: text });

// ---- T2: the GitHub source tab ------------------------------------------------------------

test("GitHub source sections read 1, 2, 3 in DOM order", async (_t, journey) => {
  const { page } = await start(journey);
  await page.getByRole("heading", { name: "1 · Discovery sources" }).waitFor();
  const titles = await page
    .locator("form h2")
    .evaluateAll((es) => es.map((e) => e.textContent));
  assert.deepEqual(titles.slice(0, 4), [
    "1 · Discovery sources",
    "2 · Readiness matching",
    "3 · Repository access",
    "GitHub source credential",
  ]);
  // Reading order is source order: nothing is moved by CSS `order`.
  assert.deepEqual(
    await page
      .locator("form *")
      .evaluateAll((es) =>
        es
          .filter((e) => getComputedStyle(e).order !== "0")
          .map((e) => e.tagName),
      ),
    [],
  );
  await page
    .getByRole("button", { name: /^Remove / })
    .first()
    .focus();
  const visited: (string | null)[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    visited.push(
      await page.evaluate(
        () =>
          document.activeElement
            ?.closest("section.settings-panel")
            ?.querySelector("h2")?.textContent ?? null,
      ),
    );
  }
  const second = visited.indexOf("2 · Readiness matching"),
    third = visited.indexOf("3 · Repository access");
  assert.ok(second >= 0 && third > second, `tab order ${visited.join("|")}`);
});

test("sources are named by content with the S-n id in Details", async (_t, journey) => {
  const { page, f } = await start(journey, githubTab, desktop, {
    setup: { discovery: fakeDiscovery() },
  });
  await row(page, "acme/atlas").first().waitFor();
  const headings = await rowHeadings(page);
  assert.deepEqual(headings.slice(0, 3), [
    "acme/atlas · repository issues",
    "PRIVATE SAVED QUERY · search",
    // No discovery credential yet, so the Project has no title to show.
    "GitHub Project",
  ]);
  for (const heading of headings) assert.doesNotMatch(heading, /S-\d/);
  await row(page, "PRIVATE SAVED QUERY").locator("summary").click();
  await row(page, "PRIVATE SAVED QUERY")
    .getByText("S-2", { exact: true })
    .waitFor();
  // Once discovery lists the Project, its title names the source; the filter is never shown.
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "discovery.configure",
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  await page.reload();
  await row(page, "Atlas roadmap · GitHub Project").waitFor();
  assert.equal(
    await page.evaluate(() =>
      document.body.innerText.includes("PRIVATE FILTER"),
    ),
    false,
  );
});

test("two searches on the same repository keep distinct names", async (_t, journey) => {
  const s = await start(journey);
  await saveElsewhere(s, [
    { id: "S-4", kind: "search", query: "repo:acme/atlas label:bug" },
  ]);
  await s.page.reload();
  await row(s.page, "repo:acme/atlas label:bug").first().waitFor();
  const headings = await rowHeadings(s.page);
  assert.ok(headings.includes("repo:acme/atlas label:bug · search"));
  assert.ok(headings.includes("PRIVATE SAVED QUERY · search"));
  const removes = await s.page
    .getByRole("button", { name: /^Remove .*\(S-\d+\)$/ })
    .evaluateAll((es) => es.map((e) => e.getAttribute("aria-label")));
  assert.equal(removes.length, 4);
  assert.equal(new Set(removes).size, removes.length, removes.join(" | "));
  for (const id of ["S-2", "S-4"])
    assert.ok(
      removes.some((name) => name?.includes(`(${id})`)),
      id,
    );
});

test("a failed private read names searches neutrally", async (_t, journey) => {
  const s = await start(journey, "/app/settings");
  await saveElsewhere(s, [
    { id: "S-4", kind: "search", query: "repo:acme/atlas label:bug" },
  ]);
  await s.page.route("**/private-values", (route) =>
    route.fulfill({ status: 500, json: { error: "unavailable" } }),
  );
  await s.page.goto(
    `${s.web.origin}/app/projects/${s.ids.atlas}/settings?tab=github`,
  );
  await row(s.page, "Saved search").first().waitFor();
  const headings = (await rowHeadings(s.page)).filter((h) => /search/.test(h));
  assert.deepEqual(headings, [
    "Saved search · search",
    "Saved search · search",
  ]);
  const text = await s.page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /PRIVATE SAVED QUERY|label:bug/);
  // Both stay distinguishable by their ids in the accessible names.
  assert.equal(
    await s.page
      .getByRole("button", { name: "Remove Saved search (S-2)" })
      .count(),
    1,
  );
  assert.equal(
    await s.page
      .getByRole("button", { name: "Remove Saved search (S-4)" })
      .count(),
    1,
  );
  await s.page.unroute("**/private-values");
  await s.page
    .getByRole("button", {
      name: /^Try again to load the search query for S-2/,
    })
    .click();
  await row(s.page, "PRIVATE SAVED QUERY").first().waitFor();
});

test("row status lines are sentences with the clock label", async (_t, journey) => {
  const { page } = await start(journey);
  const at = "2026-10-16T10:31:00.000Z";
  await page.route("**/api/operator/source-observations", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const project of body.data.projects)
      for (const s of project.selections)
        if (s.selectionId === "S-1") {
          s.state = "complete";
          s.lastAttemptAt = at;
          s.lastSuccessfulAt = at;
          s.counts = {
            observed: 4,
            open: 4,
            closedSkipped: 0,
            matching: 2,
            complete: true,
          };
        }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const time = await clock(page, at);
  await row(page, "acme/atlas")
    .getByText(`Synced ${time} · 4 issues observed, 2 match the readiness rule`)
    .waitFor();
  await row(page, "PRIVATE SAVED QUERY").getByText("Not synced yet").waitFor();
  const rows = await page.locator("form .settings-row").allInnerTexts();
  assert.doesNotMatch(rows.join("\n"), /unavailable|\d{4}-\d{2}-\d{2}T/);
});

test("hedging moves under the primary action", async (_t, journey) => {
  const { page } = await start(journey);
  await page.getByRole("heading", { name: "1 · Discovery sources" }).waitFor();
  const intros = await page.locator(".settings-panel-header p").allInnerTexts();
  assert.ok(
    intros.includes(
      "Sources are named by what they read. Search queries and local paths show here for you to edit; GitHub Project filters stay hidden.",
    ),
  );
  for (const intro of intros)
    assert.doesNotMatch(intro, /doesn't import|doesn't mean/);
  await page
    .getByText(
      "Saving imports nothing. After saving, Preview and import now appears here.",
    )
    .waitFor();
  // The caveat is the line right after the panel's primary action.
  const after = await page
    .getByRole("button", { name: "Add source", exact: true })
    .evaluate((e) => e.parentElement?.nextElementSibling?.textContent);
  assert.equal(after, "New sources are added inactive.");
});

test("phone width wraps long source names", async (_t, journey) => {
  const s = await start(journey, githubTab, phone);
  const long = `repo:acme/${"atlas-".repeat(80)}`;
  await saveElsewhere(s, [{ id: "S-4", kind: "search", query: long }]);
  await s.page.reload();
  await row(s.page, "atlas-atlas-").first().waitFor();
  await noPageOverflow(s.page);
});

// ---- T3: Preview and import now -----------------------------------------------------------

test("saved source imports through Preview and import now", async (_t, journey) => {
  const { page, ids, web } = await start(journey);
  const seen = track(page);
  await addAndSave(page);
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.textContent === "Import issues",
    ),
    true,
    "the save moves focus to the panel",
  );
  const lead = await importPanel(page).locator("p").first().innerText();
  assert.match(lead, /^Saved\. .*acme\/extra.* imported yet\.$/);
  await importButton(page).click();
  const activation = outcomeMessages(page).filter({ hasText: /^Previewed/ });
  await activation.waitFor();
  assert.match(
    await activation.locator(".action-outcome-message").innerText(),
    /^Previewed \d\d:\d\d\. .* are active\.$/,
  );
  const read = outcomeMessages(page).filter({
    hasText: /Read .* completely at/,
  });
  await read.waitFor();
  assert.match(
    await read.locator(".action-outcome-message").innerText(),
    /^Read .* completely at \d\d:\d\d\.$/,
  );
  assert.deepEqual(seen.steps, [
    "preview S-1",
    "preview S-2",
    "preview S-3",
    "preview S-4",
    "refresh",
  ]);
  assert.equal(new Set(seen.previews.map((p) => p.key)).size, 4);
  assert.equal(
    await page
      .getByRole("link", { name: "View imported tasks" })
      .getAttribute("href"),
    `/app/projects/${ids.atlas}`,
  );
  // Details name each source by id, with its request key and source version.
  await activation.locator("summary").click();
  await activation.getByText("S-4", { exact: true }).waitFor();
  const config = await page.request.get(
    `${web.origin}/api/operator/projects/${ids.atlas}/configuration`,
  );
  const selections = (await config.json()).data.source.selections as {
    active: boolean;
  }[];
  assert.equal(selections.length, 4);
  assert.deepEqual(
    selections.map((s) => s.active),
    [true, true, true, true],
  );
  await captureSettingsEvidence(page, "import-issues-imported");
});

for (const state of ["complete", "partial", "never", "unavailable"] as const)
  test(`refresh observation states claim import only when complete: ${state}`, async (_t, journey) => {
    const { page } = await start(journey);
    await refreshAs(page, state);
    await importButton(page).click();
    const imported = page.getByRole("link", { name: "View imported tasks" });
    if (state === "complete") {
      await imported.waitFor();
      return;
    }
    await outcomeMessages(page)
      .filter({
        hasText:
          state === "partial" ? /only partly/ : /nothing was imported from/,
      })
      .waitFor();
    assert.equal(await imported.count(), 0);
    assert.doesNotMatch(
      await importPanel(page).innerText(),
      /were imported|are imported|completely/,
    );
  });

test("step 1 succeeds and step 2 fails", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  let fail = true;
  await page.route("**/api/operator/source-refresh", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "down" } })
      : route.continue(),
  );
  await importButton(page).click();
  await outcomeMessages(page)
    .filter({ hasText: /^Previewed/ })
    .waitFor();
  const warning = outcomeMessages(page).filter({
    hasText: "We couldn't confirm the refresh. The sources are active.",
  });
  await warning.waitFor();
  assert.equal(seen.previews.length, 3);
  assert.equal(seen.refreshes(), 1);
  fail = false;
  await warning.getByRole("button", { name: "Refresh again" }).click();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  assert.equal(seen.refreshes(), 2, "one refresh, no preview again");
  assert.equal(seen.previews.length, 3);
});

test("a preview that never reached the service is checked with the same key", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  let first = true;
  await page.route("**/api/operator/commands", async (route: Route) => {
    if (!first || route.request().postDataJSON().type !== "github.preview")
      return route.continue();
    first = false;
    await route.abort();
  });
  await importButton(page).click();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  await check.waitFor();
  assert.equal(
    seen.refreshes(),
    0,
    "no refresh before every preview is confirmed",
  );
  assert.deepEqual(seen.steps, ["preview S-1"]);
  assert.equal(await importButton(page).count(), 0, "the way out is the check");
  // Leaving the tab and coming back keeps the unknown preview and its way out.
  await page.getByRole("link", { name: "Sync & placement" }).click();
  await page.getByRole("heading", { name: "Preview and activation" }).waitFor();
  await page.getByRole("link", { name: "GitHub source" }).click();
  await check.waitFor();
  assert.equal(seen.previews.length, 1);
  await check.click();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  assert.equal(seen.previews[1]?.key, seen.previews[0]?.key);
  assert.deepEqual(seen.steps, [
    "preview S-1",
    "preview S-1",
    "preview S-2",
    "preview S-3",
    "refresh",
  ]);
  const activation = await outcomeMessages(page)
    .filter({ hasText: /^Previewed/ })
    .locator(".action-outcome-message")
    .innerText();
  assert.match(
    activation,
    /^Previewed \d\d:\d\d\. acme\/atlas.* are active\.$/,
  );
});

test("a preview whose reply was lost reads as active and is not sent again", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  let first = true;
  await page.route("**/api/operator/commands", async (route: Route) => {
    if (!first || route.request().postDataJSON().type !== "github.preview")
      return route.continue();
    first = false;
    await route.fetch();
    await route.abort();
  });
  await importButton(page).click();
  // The service recorded it, so the next read shows the source active and the press resumes.
  await row(page, "acme/atlas").getByText("Active", { exact: true }).waitFor();
  assert.equal(seen.refreshes(), 0);
  await importButton(page).click();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  assert.deepEqual(seen.steps, [
    "preview S-1",
    "preview S-2",
    "preview S-3",
    "refresh",
  ]);
  assert.equal(seen.previews.filter((p) => p.selectionId === "S-1").length, 1);
  await outcomeMessages(page)
    .filter({ hasText: /Read acme\/atlas.* completely/ })
    .waitFor();
});

test("a lost refresh reply that never reached the service is offered again after a remount", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  let drop = true;
  await page.route("**/api/operator/source-refresh", (route) =>
    drop ? route.abort() : route.continue(),
  );
  await importButton(page).click();
  await outcomeMessages(page)
    .filter({ hasText: "We couldn't confirm the refresh." })
    .waitFor();
  drop = false;
  await page.getByRole("link", { name: "Sync & placement" }).click();
  await page.getByRole("heading", { name: "Preview and activation" }).waitFor();
  await page.getByRole("link", { name: "GitHub source" }).click();
  await importPanel(page).waitFor();
  const before = seen.previews.length;
  await importButton(page).click();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  assert.equal(
    seen.previews.length,
    before,
    "the sources are active: no preview",
  );
  assert.equal(seen.refreshes(), 2);
});

test("a lost refresh reply that reached the service leaves nothing to import after a remount", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  let lose = true;
  await page.route("**/api/operator/source-refresh", async (route) => {
    if (!lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort();
  });
  await importButton(page).click();
  await outcomeMessages(page)
    .filter({ hasText: "We couldn't confirm the refresh." })
    .waitFor();
  await page.getByRole("link", { name: "Sync & placement" }).click();
  await page.getByRole("heading", { name: "Preview and activation" }).waitFor();
  await page.getByRole("link", { name: "GitHub source" }).click();
  await row(page, "acme/atlas")
    .getByText(/^Synced \d\d:\d\d/)
    .waitFor();
  assert.equal(await importPanel(page).count(), 0);
  assert.equal(seen.refreshes(), 1);
});

test("Refresh again reports on the sources of the press it continues", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  let lose = true;
  const gate = hold();
  await page.route("**/api/operator/source-refresh", async (route) => {
    if (!lose) {
      await gate.released;
      return route.continue();
    }
    lose = false;
    await route.fetch();
    await route.abort();
  });
  await importButton(page).click();
  const warning = outcomeMessages(page).filter({
    hasText: "We couldn't confirm the refresh.",
  });
  await warning.waitFor();
  // The reads now show every source synced; the retry still answers for this press.
  await row(page, "acme/atlas")
    .getByText(/^Synced \d\d:\d\d/)
    .waitFor();
  await warning.getByRole("button", { name: "Refresh again" }).click();
  // The retry's own progress is shown while it runs.
  await page.getByText("Refreshing from GitHub…").waitFor();
  gate.release();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  await outcomeMessages(page)
    .filter({ hasText: /^Previewed/ })
    .waitFor();
  await outcomeMessages(page)
    .filter({ hasText: /Read acme\/atlas.* completely/ })
    .waitFor();
  assert.equal(seen.previews.length, 3);
  assert.equal(seen.refreshes(), 2);
});

test("Refresh again still runs when the credential stopped being usable", async (_t, journey) => {
  try {
    const { page } = await start(journey);
    const seen = track(page);
    let drop = true;
    await page.route("**/api/operator/source-refresh", (route) => {
      if (!drop) return route.continue();
      drop = false;
      delete process.env.FIXTURE_GITHUB;
      return route.abort();
    });
    await importButton(page).click();
    const warning = outcomeMessages(page).filter({
      hasText: "We couldn't confirm the refresh.",
    });
    await warning.waitFor();
    // The re-read shows the credential unusable, and the retry is not a silent no-op.
    await page.locator("#source-credential-reason").waitFor();
    await warning.getByRole("button", { name: "Refresh again" }).click();
    await outcomeMessages(page)
      .filter({ hasText: /nothing was imported from/ })
      .waitFor();
    assert.equal(seen.refreshes(), 2);
  } finally {
    process.env.FIXTURE_GITHUB = "offline-import-source-value";
  }
});

test("double click sends each step once", async (_t, journey) => {
  const { page } = await start(journey);
  const seen = track(page);
  const gate = hold();
  await page.route("**/api/operator/source-refresh", async (route) => {
    await gate.released;
    await route.continue();
  });
  await importButton(page).dblclick();
  await outcomeMessages(page)
    .filter({ hasText: /^Previewed/ })
    .waitFor();
  const button = importPanel(page).getByRole("button", { name: "Importing…" });
  assert.equal(await button.getAttribute("aria-disabled"), "true");
  await button.focus();
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Importing…",
    "an unavailable action stays focusable",
  );
  await button.click({ force: true });
  gate.release();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  assert.equal(seen.previews.length, 3);
  assert.equal(seen.refreshes(), 1);
});

test("source edited between save and import", async (_t, journey) => {
  const s = await start(journey);
  const { page } = s;
  const seen = track(page);
  await addAndSave(page);
  // An unsaved edit takes the panel away; Discard brings it back.
  await page
    .getByLabel("Search query", { exact: true })
    .first()
    .fill("changed query");
  await importPanel(page).waitFor({ state: "detached" });
  await page
    .getByRole("region", { name: "Changes to save" })
    .getByText("Search query edited for S-2")
    .waitFor();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await importPanel(page).waitFor();
  // Another writer saves first: the preview is refused and nothing is refreshed.
  await saveElsewhere(s);
  await importButton(page).click();
  const warning = outcomeMessages(page).filter({
    hasText: "Nothing was refreshed.",
  });
  await warning.waitFor();
  assert.equal(seen.refreshes(), 0);
  const stale = seen.previews[0];
  await warning.getByRole("button", { name: "Review changes" }).click();
  await importButton(page).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.closest("section.settings-panel") !== null,
    ),
    true,
    "focus stays in the panel after the control that had it is gone",
  );
  await importButton(page).click();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  const fresh = seen.previews.at(-1);
  assert.equal(fresh?.expectedVersion, (stale?.expectedVersion ?? 0) + 1);
  assert.notEqual(fresh?.key, stale?.key);
});

test("an unusable credential keeps the action focusable with its reason", async (_t, journey) => {
  delete process.env.FIXTURE_GITHUB;
  try {
    const { page } = await start(journey);
    const seen = track(page);
    const button = importButton(page);
    await button.waitFor();
    assert.equal(await button.getAttribute("aria-disabled"), "true");
    const reason = await button.evaluate((e) => {
      const id = e.getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : null;
    });
    assert.match(reason ?? "", /credential/i);
    await button.focus();
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Preview and import now",
    );
    await button.click({ force: true });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done(null))),
    );
    assert.deepEqual(seen.steps, []);
  } finally {
    process.env.FIXTURE_GITHUB = "offline-import-source-value";
  }
});

test("private query never leaves the session view", async (_t, journey) => {
  const { page, web } = await start(journey);
  const query = "PRIVATE SAVED QUERY";
  const leaks: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes(query)) leaks.push(`console: ${m.text()}`);
  });
  page.on("request", (r) => {
    if (r.url().includes(encodeURIComponent(query)) || r.url().includes(query))
      leaks.push(`request: ${r.url()}`);
    if (r.method() === "POST" && (r.postData() ?? "").includes(query))
      leaks.push(`body: ${r.url()}`);
  });
  await row(page, query).first().waitFor();
  await importButton(page).click();
  await page.getByRole("link", { name: "View imported tasks" }).waitFor();
  assert.equal(page.url().includes("PRIVATE"), false);
  assert.deepEqual(leaks, []);
  // Every element that shows the query is marked, so evidence masks it.
  assert.equal(
    await page.evaluate(
      (needle) =>
        [...document.querySelectorAll("body *")].some(
          (e) =>
            e.children.length === 0 &&
            e.textContent?.includes(needle) &&
            !(e as HTMLElement).closest("[data-private]") &&
            !(e instanceof HTMLInputElement),
        ),
      query,
    ),
    false,
  );
  // No attribute (labels, descriptions, titles) and not document.title carries the query.
  assert.equal(
    await page.evaluate(
      (needle) =>
        document.title.includes(needle) ||
        [...document.querySelectorAll("body *")].some((e) =>
          [...e.attributes].some(
            (a) => a.name !== "value" && a.value.includes(needle),
          ),
        ),
      query,
    ),
    false,
  );
  await captureSettingsEvidence(page, "import-issues-private-name");
  await page.goto(`${web.origin}/app/settings`);
  await page.getByText("S-2 search").waitFor();
  assert.equal(
    await page.evaluate(
      (needle) => document.body.innerText.includes(needle),
      query,
    ),
    false,
  );
});

// ---- T4: Sync & placement -----------------------------------------------------------------

test("Sync & placement keeps later refreshes and placement", async (_t, journey) => {
  const { page } = await start(journey, syncTab);
  await page
    .getByLabel("Selection to preview")
    .selectOption({ label: "acme/atlas · repository issues · inactive" });
  await page
    .getByRole("button", { name: "Preview and activate selection" })
    .click();
  await savedOutcome(page, /^Activated acme\/atlas\. Tasks aren't imported/);
  await page.getByRole("button", { name: "Refresh sources" }).click();
  await row(page, "acme/atlas")
    .or(page.locator("article.settings-row", { hasText: "acme/atlas" }))
    .getByText(/^Synced \d\d:\d\d · 4 issues observed/)
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Refresh all sources" }).click();
  await page.getByText("Refresh finished.", { exact: false }).first().waitFor();
});

test("Sync rows print no raw values", async (_t, journey) => {
  const { page } = await start(journey, syncTab);
  await page.getByRole("button", { name: "Refresh all sources" }).click();
  await page.getByText("Refresh finished.", { exact: false }).first().waitFor();
  const sync = page.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Source sync", exact: true }),
  });
  await sync.locator("article.settings-row").first().waitFor();
  const text = await sync.innerText();
  assert.doesNotMatch(
    text,
    /Newest attempt: |unavailable|\d{4}-\d{2}-\d{2}T|S-\d:/,
  );
  assert.match(text, /acme\/atlas · repository issues/);
  assert.match(text, /An attempt isn't a successful sync\./);
});

// ---- T5: the budget -----------------------------------------------------------------------

for (const [label, viewport] of [
  ["1366 x 900", desktop],
  ["390 x 844", phone],
] as const)
  test(`import issues budget: two interactions from a saved source (${label})`, async (_t, journey) => {
    const { page } = await start(journey, githubTab, viewport);
    // Adding the source is the edit itself; interactions are counted after it.
    await page.getByRole("button", { name: "Add source", exact: true }).click();
    await page.getByLabel("Repository ID", { exact: true }).fill("acme/extra");
    await page.getByLabel("Repository owner", { exact: true }).fill("acme");
    await page.getByLabel("Repository name", { exact: true }).fill("extra");
    let interactions = 0;
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    interactions++;
    const panel = importPanel(page);
    await panel.waitFor();
    await importButton(page).waitFor();
    assert.equal(
      await inFirstViewport(page, panel),
      true,
      "Import issues is in the first view",
    );
    await importButton(page).click();
    interactions++;
    const activation = outcomeMessages(page).filter({ hasText: /^Previewed/ });
    const read = outcomeMessages(page).filter({
      hasText: /Read .* completely/,
    });
    const link = page.getByRole("link", { name: "View imported tasks" });
    await link.waitFor();
    for (const target of [activation, read, link])
      assert.equal(
        await inFirstViewport(page, target),
        true,
        `the outcome is in view ${JSON.stringify(await target.boundingBox())}`,
      );
    assert.equal(interactions, 2);
    await noPageOverflow(page);
  });
