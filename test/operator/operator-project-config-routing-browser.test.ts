import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  captureSettingsEvidence as captureBrowserEvidence,
  outcomeMessages,
  savedOutcome,
  startSettings,
  trail,
} from "../fixtures/operator-settings.js";
import {
  changes,
  refresh,
  revealButton,
  showsText,
  revealReads,
  commandBody,
  leaveAndReturn,
  noChanges,
} from "../fixtures/project-config-browser.js";

const test = browserSuite("operator-project-config-routing-browser");

test("Routing saves candidates in place without sending guidance, and edits revealed guidance in place", async (_t, journey) => {
  const { f, ids, page, web } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=routing",
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
  const guidance = page.getByRole("group", {
    name: "Routing guidance",
    exact: true,
  });
  assert.match(await guidance.innerText(), /Kept\s*·\s*Reveal/);
  assert.equal(await showsText(page, "PRIVATE"), false);
  assert.equal(await revealReads(page), 0);
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
  const saved = await savedOutcome(page);
  await saved
    .getByText(
      /^Saved\. Routing now uses (?=.*Mira)(?=.*Eli)(?=.*Builder)(?=.*Worker)/,
    )
    .waitFor();
  assert.equal(
    (
      (await page.locator(".settings-status").innerText()).match(
        /Saved \d\d:\d\d/g,
      ) ?? []
    ).length,
    1,
  );
  assert.equal(Number(d.routing(ids.relay).version), version + 1);
  assert.equal(d.routing(ids.relay).guidance, "PRIVATE ROUTING GUIDANCE");
  const aside = page.getByRole("region", { name: "Saved routing" });
  await aside.getByRole("heading", { name: "Saved routing" }).waitFor();
  assert.doesNotMatch(await aside.innerText(), /\d\d:\d\d|version/);
  await aside
    .getByText(/^Candidates: (?=.*Mira)(?=.*Eli)(?=.*Builder)(?=.*Worker)/)
    .waitFor();
  await aside.getByText("Guidance: kept", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Save routing" && b.disabled,
    ),
  );
  await captureBrowserEvidence(page, "1366-routing-saved");
  await revealButton(page, "routing guidance").click();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await field.waitFor();
  assert.equal(await field.inputValue(), "PRIVATE ROUTING GUIDANCE");
  assert.equal(await field.evaluate((e) => e === document.activeElement), true);
  assert.equal(await save.isDisabled(), true, "revealing is not a change");
  const loaded = Number(d.routing(ids.relay).version);
  await field.fill("NEW PRIVATE GUIDANCE");
  await changes(page)
    .getByText("Routing guidance edited", { exact: true })
    .waitFor();
  assert.equal((await changes(page).innerText()).includes("PRIVATE"), false);
  const replaced = commandBody(page);
  await save.click();
  const edit = await replaced;
  assert.equal(edit.guidance, "NEW PRIVATE GUIDANCE");
  assert.equal(edit.expectedVersion, loaded);
  await savedOutcome(page, /^Saved\./);
  await revealButton(page, "routing guidance").waitFor();
  assert.equal(await field.count(), 0);
  assert.equal(d.routing(ids.relay).guidance, "NEW PRIVATE GUIDANCE");
  // Clearing the guidance is an explicit edit to empty.
  await revealButton(page, "routing guidance").click();
  await field.fill("");
  const cleared = commandBody(page);
  await save.click();
  assert.equal((await cleared).guidance, "");
  await savedOutcome(page, /^Saved\./);
  assert.equal(d.routing(ids.relay).guidance, "");
  await page.getByRole("switch", { name: "Enable routing" }).uncheck();
  await page
    .getByLabel("Credential reference change", { exact: true })
    .selectOption({ label: "Set new environment reference" });
  await page
    .getByLabel("New environment reference", { exact: true })
    .fill("env:FIXTURE_X");
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

test("routing guidance reverted or edited keeps its state after leaving the tab", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  const field = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save routing", exact: true });
  await revealButton(page, "routing guidance").click();
  await field.fill("CHANGED");
  await field.fill("PRIVATE ROUTING GUIDANCE");
  await noChanges(page);
  await leaveAndReturn(page, "Routing", "General");
  await revealButton(page, "routing guidance").waitFor();
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  await revealButton(page, "routing guidance").click();
  await field.fill("EDITED GUIDANCE");
  await leaveAndReturn(page, "Routing", "General");
  assert.equal(await field.inputValue(), "EDITED GUIDANCE");
  await changes(page)
    .getByText("Routing guidance edited", { exact: true })
    .waitFor();
  await field.fill("PRIVATE ROUTING GUIDANCE");
  await noChanges(page);
  assert.equal(await save.isDisabled(), true);
  assert.equal(d.routing(ids.relay).guidance, "PRIVATE ROUTING GUIDANCE");
});

test("Routing names TypeSafe availability in words and who allocates when it can't choose", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  // The fixture service has no TypeSafe client, so Relay's configured reference can't be used.
  await page
    .getByText("Enabled · TypeSafe unavailable · credential configured", {
      exact: true,
    })
    .waitFor();
  const notice = page.locator('[data-slot="alert"]', {
    hasText: "TypeSafe isn't available for Relay.",
  });
  assert.equal(
    (await notice.innerText()).trim(),
    "TypeSafe isn't available for Relay.\nRouting can't use its credential reference, so it can't choose assignees. New tasks without an assignee go to Jonas to allocate.",
  );
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    credentialRef: null,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  await page.reload();
  await page
    .getByText("Enabled · TypeSafe unavailable · no credential reference", {
      exact: true,
    })
    .waitFor();
  await page
    .getByText(
      "Routing has no credential reference, so it can't choose assignees. New tasks without an assignee go to Jonas to allocate.",
      { exact: false },
    )
    .waitFor();
  // The form stays editable so the reference can be set.
  assert.equal(
    await page
      .getByLabel("Credential reference change", { exact: true })
      .isDisabled(),
    false,
  );
  // A revoked lead can't allocate either, so unassigned tasks wait.
  d.execute({
    type: "profile.configure",
    actor: "operator",
    key: randomUUID(),
    profileId: ids.profiles.Jonas as string,
    expectedVersion: Number(d.profile(ids.profiles.Jonas as string).version),
    revoked: true,
  });
  await page.reload();
  await page
    .getByText(
      "New tasks without an assignee wait until the project has an available lead.",
      { exact: false },
    )
    .waitFor();
  await page.goto(page.url().replace(ids.relay, ids.atlas));
  await page
    .getByText("Routing off · no credential reference", { exact: true })
    .waitFor();
  await page
    .getByText(
      "Routing is off. Every new task needs an assignee or goes to Mira.",
      { exact: true },
    )
    .waitFor();
  // Without a lead, unassigned tasks wait rather than being allocated.
  d.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.atlas,
    expectedVersion: Number(d.project(ids.atlas).version),
    leadProfileId: null,
  });
  await page.reload();
  await page
    .getByText(
      "Routing is off. Every new task needs an assignee or waits until the project has an available lead.",
      { exact: true },
    )
    .waitFor();
});

test("Routing conflict keeps the checked candidates and a revealed guidance edit until the newer version is reviewed", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=routing",
  );
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  await revealButton(page, "routing guidance").click();
  const guidance = page.getByRole("textbox", {
    name: "Routing guidance",
    exact: true,
  });
  await guidance.fill("EDITED BEFORE A CONFLICT");
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
  await page.getByText("A newer version was saved elsewhere.").waitFor();
  assert.equal(await outcomeMessages(page).count(), 1);
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
  assert.equal(await guidance.inputValue(), "EDITED BEFORE A CONFLICT");
  await refresh(page);
  await outcomeMessages(page)
    .getByRole("button", { name: "Review changes" })
    .click();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    true,
  );
  // The edit is kept and now rides on the newer version.
  assert.equal(await guidance.inputValue(), "EDITED BEFORE A CONFLICT");
  const newer = Number(d.routing(ids.relay).version);
  const sent = commandBody(page);
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  const body = await sent;
  assert.equal(body.expectedVersion, newer);
  assert.equal(body.guidance, "EDITED BEFORE A CONFLICT");
  await savedOutcome(page, /^Saved\./);
  assert.equal(d.routing(ids.relay).guidance, "EDITED BEFORE A CONFLICT");
});

test("a re-read of another writer's routing retires the saved line", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=routing",
  );
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  const saved = await savedOutcome(page);
  await saved.getByText(/^Saved\. Routing now uses .*Nora/).waitFor();
  // A plain re-read of the same version keeps the confirmation.
  await refresh(page);
  await savedOutcome(page, /^Saved\. Routing now uses .*Nora/);
  // Another writer saves routing, and the next re-read must not describe it as this save.
  // An unedited reveal belongs to the version it was read at, so it goes back to kept.
  await revealButton(page, "routing guidance").click();
  await page
    .getByRole("textbox", { name: "Routing guidance", exact: true })
    .waitFor();
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
  await refresh(page);
  await page
    .getByRole("region", { name: "Saved routing" })
    .getByText("Candidates: Eli", { exact: true })
    .waitFor();
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.doesNotMatch(
    await page.locator(".settings-status").innerText(),
    /Saved \d\d:\d\d/,
  );
  await revealButton(page, "routing guidance").waitFor();
  assert.equal(await showsText(page, "PRIVATE"), false);
});

test("another writer committing between a routing save and its re-read is not described as saved", async (_t, journey) => {
  const { f, ids, page } = await startSettings(
    journey,
    "/projects/:relay/settings?tab=routing",
  );
  const d = f.service.domain();
  await page.getByRole("checkbox", { name: /^Nora ·/ }).check();
  // Hold the re-read that follows the save until another writer has committed.
  let held!: () => void, release!: () => void;
  const reread = new Promise<void>((resolve) => (held = resolve));
  const writer = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/api/operator/projects/*/configuration",
    async (route) => {
      held();
      await writer;
      await route.continue();
    },
  );
  await page.getByRole("button", { name: "Save routing", exact: true }).click();
  await reread;
  d.execute({
    type: "routing.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: ids.relay,
    expectedVersion: Number(d.routing(ids.relay).version),
    enabled: true,
    candidateProfileIds: [ids.profiles.Eli as string],
  });
  release();
  await page
    .getByRole("region", { name: "Saved routing" })
    .getByText("Candidates: Eli", { exact: true })
    .waitFor();
  // The form shows the other writer's version, so nothing claims it was this save.
  assert.equal(await outcomeMessages(page).count(), 0);
  assert.doesNotMatch(
    await page.locator(".settings-status").innerText(),
    /Saved \d\d:\d\d/,
  );
  await page
    .getByRole("button", { name: "Save routing", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("checkbox", { name: /^Nora ·/ }).isChecked(),
    false,
  );
});
