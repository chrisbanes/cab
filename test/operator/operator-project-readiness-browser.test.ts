import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { DiscoveryFailure } from "../../src/standalone/github-discovery.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createFakeGh } from "../fixtures/fake-gh.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import { fakeDiscovery } from "../fixtures/setup-home.js";
import {
  captureSettingsEvidence as captureBrowserEvidence,
  noPageOverflow,
  outcomeMessages,
  phone,
  savedOutcome,
  startSettings,
} from "../fixtures/operator-settings.js";
import {
  commandBody,
  startDiscovery,
} from "../fixtures/project-config-browser.js";

const test = browserSuite("operator-project-readiness-browser");

test("GitHub source readiness errors focus the exact row without echo", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
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

test("GitHub source shows no readiness rule, saves an added rule, removes it, and never clears an unavailable rule", async (t, journey) => {
  const previous = process.env.FIXTURE_GITHUB;
  process.env.FIXTURE_GITHUB = "offline-readiness-rule-value";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_GITHUB;
    else process.env.FIXTURE_GITHUB = previous;
  });
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=github",
  );
  const d = f.service.domain();
  const noRule = page.getByText("No readiness rule:", { exact: false });
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await noRule.waitFor();
  assert.equal(await page.getByLabel("Ready label").count(), 0);
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page.getByLabel("Ready label").fill("ready-for-agent");
  await save.click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.relay).readiness, {
    mode: "all",
    conditions: [{ kind: "label", operator: "has", name: "ready-for-agent" }],
  });
  await page.getByRole("button", { name: "Remove condition 1" }).click();
  await noRule.waitFor();
  const removal = page.getByText("Readiness: no readiness rule", {
    exact: true,
  });
  await removal.waitFor();
  await save.click();
  await removal.waitFor({ state: "detached" });
  assert.equal(d.githubConfiguration(ids.relay).readiness, null);
  // A rule naming private text is withheld: shown as unknown, never as no rule.
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: d.githubConfiguration(ids.relay).version,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: [],
    readiness: {
      mode: "all",
      conditions: [
        {
          kind: "label",
          operator: "has",
          name: "offline-readiness-rule-value",
        },
      ],
    },
  });
  await page.reload();
  await page
    .getByText(
      "Saved readiness is unavailable and is kept when saving. Add a condition to replace it.",
    )
    .waitFor();
  assert.equal(await noRule.count(), 0);
  assert.equal(await save.isDisabled(), true);
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page.getByLabel("Ready label").fill("ready");
  await page
    .getByText("(replaces unavailable readiness)", { exact: false })
    .waitFor();
  assert.equal(await save.isDisabled(), false);
});
const addProjectFieldCondition = async (page: Page) => {
  await page.getByRole("button", { name: "Add readiness condition" }).click();
  await page
    .getByLabel("Condition kind")
    .last()
    .selectOption({ label: "Project field" });
};
const optionNames = (page: Page | Locator, label: string) =>
  page
    .getByLabel(label, { exact: true })
    .locator("option")
    .evaluateAll((o) => o.map((x) => x.textContent));

test("a readiness Project-field condition is picked by name and saves the same node IDs", async (_t, journey) => {
  const state: { calls: string[] } = { calls: [] };
  const { f, ids, page } = await startDiscovery(journey, state);
  const d = f.service.domain();
  const version = d.githubConfiguration(ids.atlas).version;
  await addProjectFieldCondition(page);
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Readiness Project node ID").count(), 0);
  // Only the Projects linked to the source's repository are listed, not the owner's others.
  await page
    .getByLabel("Readiness Project", { exact: true })
    .selectOption({ label: "Atlas roadmap" });
  assert.deepEqual(await optionNames(page, "Readiness Project"), [
    "Choose a Project",
    "Atlas roadmap",
  ]);
  await page
    .getByLabel("Readiness field", { exact: true })
    .selectOption({ label: "Status" });
  assert.deepEqual(await optionNames(page, "Readiness field"), [
    "Choose a field",
    "Status",
    "Priority",
  ]);
  assert.deepEqual(await optionNames(page, "Readiness operator"), [
    "is one of",
    "is not one of",
  ]);
  // One checkbox per option in board order, each reachable and toggled by keyboard.
  const options = page
    .getByRole("group", { name: "Readiness options" })
    .getByRole("checkbox");
  assert.deepEqual(
    await options.evaluateAll((o) =>
      o.map((x) => x.closest("label")?.textContent),
    ),
    ["Todo", "Ready"],
  );
  await page.getByRole("checkbox", { name: "Ready", exact: true }).check();
  await page.getByRole("checkbox", { name: "Todo", exact: true }).focus();
  await page.keyboard.press("Space");
  await captureBrowserEvidence(page, "readiness-picker");
  const body = commandBody(page);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const command = (await body) as { readiness: { conditions: unknown[] } };
  await savedOutcome(page);
  // Checked in any order, saved in the field's board order.
  const picked = {
    kind: "project-field",
    projectNodeId: "PVT_atlas",
    fieldNodeId: "PVTSSF_status",
    operator: "in",
    optionNodeIds: ["PVTSSO_todo", "PVTSSO_ready"],
  };
  assert.deepEqual(command.readiness.conditions.at(-1), picked);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).readiness?.conditions.at(-1),
    picked,
  );
  assert.equal(d.githubConfiguration(ids.atlas).version, version + 1);
  assert.deepEqual(
    d.githubConfiguration(ids.atlas).selections.map((s) => s.id),
    ["S-1", "S-2", "S-3"],
  );
  assert.deepEqual(
    ["repositories", "projects", "projectFields"].filter(
      (call) => !state.calls.includes(call),
    ),
    [],
  );
});

test("saving a Project-field condition with no option checked focuses its first option", async (_t, journey) => {
  const { page } = await startDiscovery(journey, { calls: [] });
  await addProjectFieldCondition(page);
  await page
    .getByLabel("Readiness Project", { exact: true })
    .selectOption({ label: "Atlas roadmap" });
  await page
    .getByLabel("Readiness field", { exact: true })
    .selectOption({ label: "Status" });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const first = page.getByRole("checkbox", { name: "Todo", exact: true });
  await first.waitFor();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-invalid") === "true" &&
      document.activeElement.getAttribute("aria-describedby") ===
        "source-conditions-error",
  );
  assert.equal(await first.evaluate((e) => e === document.activeElement), true);
});

test("a Project source lists each option's open items without add buttons, and a saved set reads by name with an unlisted option kept", async (t, journey) => {
  const previous = process.env.FIXTURE_GITHUB;
  process.env.FIXTURE_GITHUB = "offline-readiness-source-value";
  t.after(() => {
    if (previous === undefined) delete process.env.FIXTURE_GITHUB;
    else process.env.FIXTURE_GITHUB = previous;
  });
  const issue = (n: number, optionNodeId: string) => ({
    providerInstance: "github.com" as const,
    nodeId: `I_${n}`,
    repositoryId: "acme/atlas",
    repositoryName: "acme/atlas",
    number: n,
    title: `Issue ${n}`,
    body: "Scope",
    state: "open" as const,
    labels: [],
    projectFields: [
      {
        projectNodeId: "PVT_atlas",
        fieldNodeId: "PVTSSF_status",
        optionNodeId,
      },
    ],
  });
  const reader: GitHubReaderFactory = () => ({
    async readSelection(selection) {
      return selection.kind === "project"
        ? {
            complete: true as const,
            issues: [issue(1, "PVTSSO_todo"), issue(2, "PVTSSO_ready")],
            reason: null,
            projectFields: [
              {
                projectNodeId: "PVT_atlas",
                fieldNodeId: "PVTSSF_status",
                name: "Status",
                options: [
                  { optionNodeId: "PVTSSO_todo", name: "Todo" },
                  { optionNodeId: "PVTSSO_ready", name: "Ready" },
                ],
              },
            ],
          }
        : { complete: true as const, issues: [], reason: null };
    },
    async readBlockers() {
      return { complete: true, blockers: [], reason: null };
    },
    async readIssueStatus() {
      return { status: "open" as const };
    },
  });
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
    undefined,
    undefined,
    { readerFactory: reader, setup: { discovery: fakeDiscovery({}) } },
  );
  const api = new OperatorApi(f.service, [f.directory]);
  await api.execute({
    type: "discovery.configure",
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  const d = f.service.domain();
  d.execute({
    type: "github.activate",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    selectionId: "S-3",
    expectedVersion: d.githubConfiguration(ids.atlas).version,
  });
  await f.service.refreshGitHub();
  await page.reload();
  await page.getByText("Todo · 1", { exact: true }).waitFor();
  await page.getByText("Ready · 1", { exact: true }).waitFor();
  // The counts are read only: conditions are made in the condition editor.
  assert.equal(
    await page.getByRole("button", { name: /for Ready/ }).count(),
    0,
  );
  assert.equal(await page.getByLabel("Readiness field").count(), 0);
  const saved = {
    kind: "project-field" as const,
    projectNodeId: "PVT_atlas",
    fieldNodeId: "PVTSSF_status",
    operator: "not-in" as const,
    optionNodeIds: ["PVTSSO_ready", "PVTSSO_gone"],
  };
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    credentialRef: "env:FIXTURE_GITHUB",
    selections: d.githubConfiguration(ids.atlas).selections,
    readiness: { mode: "all", conditions: [saved] },
  });
  await page.reload();
  // The saved set shows by name; an option the read does not list stays checked by its node ID.
  await page.getByRole("checkbox", { name: "Ready", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Ready", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await page.getByRole("checkbox", { name: "Todo", exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "PVTSSO_gone", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await page
      .getByLabel("Readiness operator", { exact: true })
      .locator("option:checked")
      .textContent(),
    "is not one of",
  );
  await captureBrowserEvidence(page, "readiness-project-field-options");
  const observed = (await api.readSourceObservations()).data.projects.find(
    (p) => p.projectId === ids.atlas,
  );
  assert.equal(observed?.readiness.kind, "rule");
  assert.deepEqual(
    observed?.readiness.kind === "rule" && observed.readiness.conditions.at(-1),
    {
      ...saved,
      fieldName: "Status",
      optionNames: { PVTSSO_ready: "Ready" },
    },
  );
});

test("a readiness Project-field condition keeps typed node IDs when discovery fails or is truncated", async (_t, journey) => {
  for (const state of [
    { truncated: true },
    { failure: new DiscoveryFailure("unauthorized") },
  ]) {
    const { f, ids, page } = await startDiscovery(journey, state);
    await addProjectFieldCondition(page);
    await page
      .getByText("GitHub discovery is unavailable", { exact: false })
      .first()
      .waitFor();
    assert.equal(
      await page.getByLabel("Readiness Project", { exact: true }).count(),
      0,
    );
    await page.getByLabel("Readiness Project node ID").fill("PVT_typed");
    await page.getByLabel("Readiness field node ID").fill("PVTSSF_typed");
    // The list is comma or newline separated; the separator can be typed before the next ID.
    const typedOptions = page.getByLabel("Readiness option node IDs");
    await typedOptions.pressSequentially("PVTSSO_typed,");
    assert.equal(await typedOptions.inputValue(), "PVTSSO_typed,");
    await typedOptions.pressSequentially(" PVTSSO_second");
    await page
      .getByLabel("Readiness operator", { exact: true })
      .selectOption({ label: "is not one of" });
    await captureBrowserEvidence(page, "readiness-picker-typed");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await savedOutcome(page);
    assert.deepEqual(
      f.service
        .domain()
        .githubConfiguration(ids.atlas)
        .readiness?.conditions.at(-1),
      {
        kind: "project-field",
        projectNodeId: "PVT_typed",
        fieldNodeId: "PVTSSF_typed",
        operator: "not-in",
        optionNodeIds: ["PVTSSO_typed", "PVTSSO_second"],
      },
    );
  }
});

test("a saved readiness condition that discovery does not list stays typed, editable and savable", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, { calls: [] });
  const d = f.service.domain();
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
    readiness: {
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: "PVT_gone",
          fieldNodeId: "PVTSSF_gone",
          operator: "in",
          optionNodeIds: ["PVTSSO_gone"],
        },
      ],
    },
  });
  await page.reload();
  const project = page.getByLabel("Readiness Project node ID");
  await project.waitFor();
  await page
    .getByText("not in the discovered lists", { exact: false })
    .waitFor();
  assert.equal(await project.inputValue(), "PVT_gone");
  assert.equal(
    await page.getByLabel("Readiness option node IDs").inputValue(),
    "PVTSSO_gone",
  );
  await page.getByLabel("Readiness option node IDs").fill("PVTSSO_other");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).readiness?.conditions, [
    {
      kind: "project-field",
      projectNodeId: "PVT_gone",
      fieldNodeId: "PVTSSF_gone",
      operator: "in",
      optionNodeIds: ["PVTSSO_other"],
    },
  ]);
});

const addLabelCondition = (page: Page) =>
  page.getByRole("button", { name: "Add readiness condition" }).click();
/**
 * Atlas's GitHub tab with discovery unconfigured, a fake `gh` login and a saved Project-field
 * condition, so its Project and field are typed node IDs until a credential is set.
 */
async function startGhOffer(
  journey: Parameters<typeof startSettings>[0],
  signedIn = true,
) {
  const gh = createFakeGh(signedIn ? "signed-in" : "not-signed-in");
  journey.cleanup(async () => gh.close(), "fake-gh.close");
  const started = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
    undefined,
    undefined,
    {
      serviceOptions: { ghExecutable: gh.executable },
      setup: { discovery: fakeDiscovery({}), ghExecutable: gh.executable },
    },
  );
  const { f, ids, page } = started;
  const d = f.service.domain();
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
    readiness: {
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: "PVT_atlas",
          fieldNodeId: "PVTSSF_status",
          operator: "in",
          optionNodeIds: ["PVTSSO_ready"],
        },
      ],
    },
  });
  await page.reload();
  await page.getByLabel("Readiness Project node ID").waitFor();
  return started;
}
const ghOffer = (page: Page) =>
  page.getByRole("button", { name: "Use GitHub CLI login (@octo)" });

test("the readiness picker offers the signed-in GitHub CLI login and lists choices once it is set", async (_t, journey) => {
  const { f, page } = await startGhOffer(journey);
  const caveat = page.getByText("If agents can reach this Mac's keychain", {
    exact: false,
  });
  await ghOffer(page).waitFor();
  assert.equal(await ghOffer(page).count(), 1);
  await caveat.waitFor();
  await ghOffer(page).click();
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  await page
    .getByLabel("Readiness Project node ID")
    .waitFor({ state: "detached" });
  await ghOffer(page).waitFor({ state: "detached" });
  assert.equal(await caveat.count(), 0);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "source-readiness",
  );
});

test("the readiness picker offers no GitHub CLI login without a signed-in gh or with discovery set", async (_t, journey) => {
  const { page } = await startGhOffer(journey, false);
  await page.getByLabel("Readiness Project node ID").waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await ghOffer(page).count(), 0);
  const configured = await startDiscovery(journey, { calls: [] });
  await configured.page.getByLabel("Ready label").waitFor();
  await configured.page.waitForLoadState("networkidle");
  assert.equal(await ghOffer(configured.page).count(), 0);
});

test("the readiness picker offer is held by a Settings save that is not confirmed", async (_t, journey) => {
  const { f, page } = await startGhOffer(journey);
  const posts: { key: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON());
  });
  await ghOffer(page).waitFor();
  const check = page.getByRole("button", { name: "Check whether it saved" });
  // The request never reaches the service, so Settings still reads the credential as unset.
  await page.route("**/api/operator/commands", (route) => route.abort());
  try {
    await ghOffer(page).click();
    await check.waitFor();
    assert.equal(await ghOffer(page).count(), 0);
    // Settings, reached inside the app, holds its offer and controls until this is checked.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const row = page.getByRole("region", {
      name: "GitHub discovery credential",
    });
    const offer = row.getByRole("button", {
      name: "Use GitHub CLI login (@octo)",
    });
    await offer.waitFor();
    assert.equal(await offer.getAttribute("aria-disabled"), "true");
    assert.equal(
      await row.getByRole("button", { name: "Set", exact: true }).isDisabled(),
      true,
    );
    await row
      .getByText("A discovery credential save elsewhere isn't confirmed yet.")
      .waitFor();
    await offer.click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
    await page.goBack();
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await check.click();
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

test("the readiness picker offer is held by a Settings save that is not confirmed when the tab opens", async (_t, journey) => {
  const { f, page } = await startGhOffer(journey);
  const posts: { key: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      posts.push(r.postDataJSON());
  });
  const check = page
    .getByRole("region", { name: "GitHub discovery credential" })
    .getByRole("button", { name: "Check whether it saved" });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const offer = page
    .getByRole("region", { name: "GitHub discovery credential" })
    .getByRole("button", { name: "Use GitHub CLI login (@octo)" });
  // The request never reaches the service, so the tab still reads the credential as unset.
  await page.route("**/api/operator/commands", (route) => route.abort());
  try {
    await offer.click();
    await check.waitFor();
    await page.goBack();
    await ghOffer(page).waitFor();
    assert.equal(await ghOffer(page).getAttribute("aria-disabled"), "true");
    await page
      .getByText("A discovery credential save elsewhere isn't confirmed yet.")
      .waitFor();
    await ghOffer(page).click({ force: true });
    await page.waitForLoadState("networkidle");
    assert.equal(posts.length, 1);
  } finally {
    await page.unroute("**/api/operator/commands");
  }
  await page.goForward();
  await check.click();
  await page.goBack();
  await page.getByLabel("Readiness Project", { exact: true }).waitFor();
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal(
    f.service.domain().discoveryCredentialReference(),
    "gh:github.com",
  );
});

const labelCalls = (state: { calls: string[] }) =>
  state.calls.filter((c) => c === "labels").length;
const labelSelect = (page: Page, nth: number) =>
  page.locator(`select[id^="source-conditions-${nth}-name"]`);
const labelOptions = (page: Page, nth: number) =>
  labelSelect(page, nth)
    .locator("option")
    .evaluateAll((o) => o.map((x) => x.textContent));

test("a Ready label is chosen from the source's repository labels and read once per round, only while a label condition exists", async (_t, journey) => {
  const state: { calls: string[] } = { calls: [] };
  const { f, ids, page } = await startDiscovery(journey, state);
  // The initial saved label has its own discovery round. Finish it and leave before
  // reconfiguring, so none of that document's reads can enter the next round's count.
  await labelSelect(page, 0).waitFor();
  const url = page.url();
  await page.goto("about:blank");
  const d = f.service.domain();
  const projectField = {
    kind: "project-field",
    projectNodeId: "PVT_gone",
    fieldNodeId: "PVTSSF_gone",
    operator: "in",
    optionNodeIds: ["PVTSSO_gone"],
  } as const;
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
    readiness: { mode: "all", conditions: [projectField] },
  });
  state.calls = [];
  await page.goto(url);
  await page.getByLabel("Readiness Project node ID").waitFor();
  assert.equal(labelCalls(state), 0);
  await addLabelCondition(page);
  await labelSelect(page, 1).waitFor();
  const listed = ["Choose a label", "bug", "ready", "needs-review", "Other…"];
  assert.deepEqual(await labelOptions(page, 1), listed);
  await labelSelect(page, 1).selectOption("ready");
  await addLabelCondition(page);
  await labelSelect(page, 2).selectOption("bug");
  await page
    .getByLabel("Label operator", { exact: true })
    .last()
    .selectOption({ label: "does not have" });
  assert.deepEqual(await labelOptions(page, 2), listed);
  assert.equal(labelCalls(state), 1);
  await captureBrowserEvidence(page, "readiness-label-picker");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).readiness?.conditions, [
    projectField,
    { kind: "label", operator: "has", name: "ready" },
    { kind: "label", operator: "lacks", name: "bug" },
  ]);
});

test("a label-only source without a Project makes no Project discovery reads", async (_t, journey) => {
  const state: { calls: string[] } = { calls: [] };
  const { f, ids, page } = await startDiscovery(journey, state);
  const d = f.service.domain(),
    url = page.url();
  await labelSelect(page, 0).waitFor();
  // Leave the page so none of its reads land after the count is reset.
  await page.goto("about:blank");
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true },
      { id: "S-2", keep: true },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  });
  state.calls = [];
  await page.goto(url);
  await labelSelect(page, 0).waitFor();
  assert.equal(labelCalls(state), 1);
  assert.equal(state.calls.includes("projects"), false);
});

// Atlas's saved readiness already holds the label condition "ready".
test("a Ready label that is not on the repositories is named under Other", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, { calls: [] });
  const select = labelSelect(page, 0);
  await select.waitFor();
  assert.equal(await select.inputValue(), "ready");
  assert.equal(await page.getByLabel("Other label").count(), 0);
  await select.selectOption({ label: "Other…" });
  await page.getByLabel("Other label").fill("ship-it");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(
    f.service.domain().githubConfiguration(ids.atlas).readiness?.conditions,
    [{ kind: "label", operator: "has", name: "ship-it" }],
  );
});

test("a Ready label stays a typed field when discovery fails or is truncated", async (_t, journey) => {
  for (const state of [
    { truncated: true },
    { failure: new DiscoveryFailure("unauthorized") },
  ]) {
    const { f, ids, page } = await startDiscovery(journey, state);
    await page.getByText("Type the label.", { exact: false }).waitFor();
    const input = page.getByLabel("Ready label");
    assert.equal(await labelSelect(page, 0).count(), 0);
    await input.fill("ship-it");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await savedOutcome(page);
    assert.deepEqual(
      f.service.domain().githubConfiguration(ids.atlas).readiness?.conditions,
      [{ kind: "label", operator: "has", name: "ship-it" }],
    );
  }
});

test("a saved Ready label that discovery does not list stays selected and savable", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, { calls: [] });
  const d = f.service.domain();
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
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "gone" }],
    },
  });
  await page.reload();
  await labelSelect(page, 0).waitFor();
  await page
    .getByText("This label is not on the source's repositories", {
      exact: false,
    })
    .waitFor();
  // The saved label stays selected as an extra option, so opening the editor changes nothing.
  assert.equal(await labelSelect(page, 0).inputValue(), "gone");
  assert.deepEqual(await labelOptions(page, 0), [
    "Choose a label",
    "bug",
    "ready",
    "needs-review",
    "gone",
    "Other…",
  ]);
  await page
    .getByLabel("Closed GitHub issues", { exact: true })
    .selectOption("done");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await savedOutcome(page);
  assert.deepEqual(d.githubConfiguration(ids.atlas).readiness?.conditions, [
    { kind: "label", operator: "has", name: "gone" },
  ]);
});

const statusField = "PVTSSF_status";
const statusPanel = (page: Page) => page.locator("#status-mapping");

test("from an empty delivery policy, the operator saves a GitHub status mapping in the editor without typing an ID", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {});
  const d = f.service.domain();
  assert.deepEqual(f.service.delivery().configuration(ids.atlas).grants, []);
  await page.reload();
  const url = page.url();
  const panel = statusPanel(page);
  await panel
    .getByRole("heading", { name: "Status mapping", exact: true })
    .waitFor();
  const turn = panel.getByLabel("First turn started", { exact: true });
  await turn.selectOption({ label: "Ready" });
  assert.deepEqual(await optionNames(panel, "First turn started"), [
    "Nothing",
    "Todo",
    "Ready",
  ]);
  await panel
    .getByLabel("Stopped, uncertain or blocked", { exact: true })
    .selectOption({ label: "Ready" });
  await panel
    .getByText(
      "Saving allows cab to set Status to Ready on Project Atlas roadmap",
      { exact: true },
    )
    .waitFor();
  await panel
    .getByRole("region", { name: "Status mapping changes" })
    .getByText("First turn started: sets Status to Ready.")
    .waitFor();
  await captureBrowserEvidence(page, "status-mapping");
  const body = commandBody(page);
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  const command = (await body) as { mapping: unknown; expectedVersion: number };
  await savedOutcome(panel);
  const mapping = {
    selectionId: "S-3",
    projectNodeId: "PVT_atlas",
    fieldNodeId: statusField,
    events: {
      turnStarted: "PVTSSO_ready",
      handedBack: null,
      held: "PVTSSO_ready",
      done: null,
    },
  };
  assert.deepEqual(command.mapping, mapping);
  assert.deepEqual(d.statusMapping(ids.atlas).mapping, mapping);
  assert.equal(d.statusMapping(ids.atlas).version, 2);
  assert.equal(page.url(), url);
  assert.deepEqual(f.service.delivery().configuration(ids.atlas).grants, []);
});

test("an in-flight Status the readiness rule does not accept is refused naming the option, and the draft stays", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {});
  const d = f.service.domain();
  // Only Ready tasks are Ready: an in-flight write of Todo would remove readiness.
  d.execute({
    type: "github.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: ["S-1", "S-2", "S-3"].map((id) => ({
      id,
      keep: true as const,
    })),
    readiness: {
      mode: "all",
      conditions: [
        {
          kind: "project-field",
          projectNodeId: "PVT_atlas",
          fieldNodeId: statusField,
          operator: "in",
          optionNodeIds: ["PVTSSO_ready"],
        },
      ],
    },
  });
  await page.reload();
  const panel = statusPanel(page);
  await panel
    .getByLabel("First turn started", { exact: true })
    .selectOption({ label: "Todo" });
  await panel
    .getByLabel("Stopped, uncertain or blocked", { exact: true })
    .selectOption({ label: "Todo" });
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  // The save outcome says which event and option, and Go to field returns to the select.
  const refusal = outcomeMessages(panel).filter({
    hasText: "First turn started → Todo: the readiness rule does not accept",
  });
  await refusal.waitFor();
  await panel
    .getByLabel("Stopped, uncertain or blocked", { exact: true })
    .focus();
  await refusal
    .getByRole("button", { name: "Go to field", exact: true })
    .click();
  assert.equal(
    await panel
      .getByLabel("First turn started", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await panel
      .getByLabel("First turn started", { exact: true })
      .getAttribute("aria-invalid"),
    "true",
  );
  // The terminal event is not the one refused, and nothing was saved.
  assert.equal(
    await panel
      .getByLabel("Stopped, uncertain or blocked", { exact: true })
      .getAttribute("aria-invalid"),
    "false",
  );
  assert.equal(
    await panel.getByLabel("First turn started", { exact: true }).inputValue(),
    "PVTSSO_todo",
  );
  assert.equal(d.statusMapping(ids.atlas).mapping, null);
  // Choosing an accepted option and saving works from the same draft.
  await panel
    .getByLabel("First turn started", { exact: true })
    .selectOption({ label: "Ready" });
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .click();
  await savedOutcome(panel);
  assert.equal(
    d.statusMapping(ids.atlas).mapping?.events.turnStarted,
    "PVTSSO_ready",
  );
});

test("choosing another Project starts from Nothing, cannot be saved until its Status field is listed, and is never a clear", async (_t, journey) => {
  const { f, ids, page } = await startDiscovery(journey, {});
  const d = f.service.domain();
  d.execute({
    type: "status-mapping.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.statusMapping(ids.atlas).version,
    mapping: {
      selectionId: "S-3",
      projectNodeId: "PVT_atlas",
      fieldNodeId: statusField,
      events: {
        turnStarted: "PVTSSO_ready",
        handedBack: null,
        held: null,
        done: null,
      },
    },
  });
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "github.configure",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: d.githubConfiguration(ids.atlas).version,
    selections: [
      { id: "S-1", keep: true as const },
      { id: "S-2", keep: true as const },
      { id: "S-3", keep: true as const },
      { id: "S-4", kind: "project", projectNodeId: "PVT_other", filter: "" },
    ],
    readiness: {
      mode: "all",
      conditions: [{ kind: "label", operator: "has", name: "ready" }],
    },
  } as Parameters<OperatorApi["execute"]>[0]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/discovery/project-fields?project=PVT_other",
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  await page.reload();
  const panel = statusPanel(page);
  const turn = panel.getByLabel("First turn started", { exact: true });
  const save = panel.getByRole("button", {
    name: "Save status mapping",
    exact: true,
  });
  await turn
    .locator("option", { hasText: "Ready" })
    .waitFor({ state: "attached" });
  assert.equal(await turn.inputValue(), "PVTSSO_ready");
  await panel.getByLabel("Project source", { exact: true }).selectOption("S-4");
  // The other Project's field is loading: nothing carries over, nothing is cleared, nothing saves.
  await panel.getByText("Reading this Project's Status options").waitFor();
  assert.equal(await turn.inputValue(), "");
  assert.equal(await save.isDisabled(), true);
  assert.equal(await panel.getByText("Clears the status mapping").count(), 0);
  release();
  await panel
    .getByText("This Project has no single-select field named Status")
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await panel.getByText("Clears the status mapping").count(), 0);
  assert.notEqual(d.statusMapping(ids.atlas).mapping, null);
  // Back on the saved Project its mapping returns, unchanged; Nothing everywhere is the explicit clear.
  await panel.getByLabel("Project source", { exact: true }).selectOption("S-3");
  await turn
    .locator("option", { hasText: "Ready" })
    .waitFor({ state: "attached" });
  assert.equal(await turn.inputValue(), "PVTSSO_ready");
  assert.equal(await save.isDisabled(), true);
  await turn.selectOption({ label: "Nothing" });
  await panel.getByText("Clears the status mapping").waitFor();
  assert.equal(await save.isDisabled(), false);
});

test("a project without a Project source shows the mapping as unavailable", async (_t, journey) => {
  const { page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=github",
  );
  const panel = statusPanel(page);
  await panel
    .getByText("Status mapping needs a GitHub Project source")
    .waitFor();
  assert.equal(await panel.getByRole("combobox").count(), 0);
  assert.equal(await panel.getByRole("button").count(), 0);
});

test("Status mapping is keyboard operable at phone width", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:atlas/settings?tab=github",
    phone,
    undefined,
    { setup: { discovery: fakeDiscovery({}) } },
  );
  await new OperatorApi(f.service, [f.directory]).execute({
    type: "discovery.configure",
    key: randomUUID(),
    credentialRef: "env:FIXTURE_DISCOVERY",
  });
  await page.reload();
  const panel = statusPanel(page);
  const done = panel.getByLabel("Done", { exact: true });
  await done.locator("option", { hasText: "Ready" }).waitFor({
    state: "attached",
  });
  await done.focus();
  // Typing the option's first letter picks it, as it does on a focused select.
  await page.keyboard.type("R");
  assert.equal(await done.inputValue(), "PVTSSO_ready");
  await panel
    .getByRole("button", { name: "Save status mapping", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await savedOutcome(panel);
  assert.equal(
    f.service.domain().statusMapping(ids.atlas).mapping?.events.done,
    "PVTSSO_ready",
  );
  const box = await done.boundingBox();
  assert.ok((box?.height ?? 0) >= 32);
  await noPageOverflow(page);
});
