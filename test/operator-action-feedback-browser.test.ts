import { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { GitHubReaderFactory } from "../src/standalone/github-sync.js";
import {
  browserSuite,
  type BrowserJourney,
} from "./fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  outcomeMessages,
  phone,
  savedOutcome,
  startSettings,
  resolve,
} from "./fixtures/operator-settings.js";
import { commandRequest } from "./fixtures/setup-browser.js";

const test = browserSuite("ui08-action-feedback");

const sourceValue = process.env.FIXTURE_GITHUB;
before(() => {
  process.env.FIXTURE_GITHUB = "offline-feedback-source-value";
});
after(() => {
  if (sourceValue === undefined) delete process.env.FIXTURE_GITHUB;
  else process.env.FIXTURE_GITHUB = sourceValue;
});

/** Message text never carries service vocabulary, version numbers or identifiers. */
const serviceWords =
  /recorded|receipt|observation|admission|reconcile|submission|revision|version|\w+\.(?:create|configure|preview|place)\b|system:|[0-9a-f]{8}-[0-9a-f]{4}-/i;

const reader: GitHubReaderFactory = () => ({
  async readSelection() {
    return { complete: true as const, issues: [], reason: null };
  },
  async readBlockers() {
    return { complete: true, blockers: [], reason: null };
  },
  async readIssueStatus() {
    return { status: "unknown" as const };
  },
});

type Fixture = Awaited<ReturnType<typeof startSettings>>;

interface Surface {
  name: string;
  path: string;
  save: string;
  command: string;
  edit: (page: Page) => Promise<unknown>;
  /** A second, different edit after a save. */
  editAgain: (page: Page) => Promise<unknown>;
  /** Input the command schema rejects before anything is sent. */
  invalid: (page: Page) => Promise<unknown>;
  /** Saves the same resource elsewhere, so the open form is out of date. */
  elsewhere: (d: Fixture) => void;
  /** A field that stays locked while the outcome is unknown. */
  locked: (page: Page) => ReturnType<Page["getByLabel"]>;
}

const surfaces: Surface[] = [
  {
    name: "General",
    path: "/app/projects/:atlas/settings",
    save: "Save project",
    command: "project.configure",
    edit: (page) =>
      page.getByLabel("Project name", { exact: true }).fill("Atlas renamed"),
    editAgain: (page) =>
      page.getByLabel("Project name", { exact: true }).fill("Atlas again"),
    invalid: (page) =>
      page.getByLabel("Project name", { exact: true }).fill(""),
    elsewhere: ({ f, ids }) => {
      const d = f.service.domain();
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: ids.atlas,
        expectedVersion: Number(d.project(ids.atlas).version),
        paused: true,
      });
    },
    locked: (page) => page.getByLabel("Project name", { exact: true }),
  },
  {
    name: "Routing",
    path: "/app/projects/:relay/settings?tab=routing",
    save: "Save routing",
    command: "routing.configure",
    edit: (page) => page.getByRole("checkbox", { name: /^Nora ·/ }).check(),
    editAgain: (page) =>
      page.getByRole("checkbox", { name: /^Mira ·/ }).check(),
    invalid: async (page) => {
      await page
        .getByLabel("Credential reference change", { exact: true })
        .selectOption({ label: "Set new environment reference" });
      await page
        .getByLabel("New environment reference", { exact: true })
        .fill("env:lower");
    },
    elsewhere: ({ f, ids }) => {
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
    },
    locked: (page) => page.getByRole("switch", { name: "Enable routing" }),
  },
];

const commandBody = (page: Page) =>
  commandRequest(page).then((r) => r.postDataJSON() as { key: string });

const open = async (
  journey: BrowserJourney,
  surface: Surface,
  viewport: typeof desktop,
) => {
  const fixture = await startSettings(journey, surface.path, viewport);
  await fixture.page.getByRole("button", { name: surface.save }).waitFor();
  return fixture;
};

for (const [device, viewport] of [
  ["desktop", desktop],
  ["phone", phone],
] as const)
  for (const surface of surfaces) {
    const where = `${surface.name} on ${device}`;

    test(`${where}: a save leaves one quiet saved line and Details`, async (_t, journey) => {
      const { page, ids } = await open(journey, surface, viewport);
      await surface.edit(page);
      await page.getByRole("button", { name: surface.save }).click();
      const saved = await savedOutcome(page);
      assert.equal(await saved.getAttribute("role"), "status");
      assert.doesNotMatch(await saved.innerText(), serviceWords);
      assert.equal(await saved.getByRole("button").count(), 0);
      // The receipt is in the collapsed disclosure, never in the line.
      await saved.getByText("Details", { exact: true }).click();
      for (const label of ["Command", "Resource", "Version", "Request key"])
        await saved.getByText(label, { exact: true }).waitFor();
      assert.equal(await saved.getByText("Code", { exact: true }).count(), 0);
      const fields = await saved.locator("dl").innerText();
      assert.match(fields, new RegExp(`Command\\s+${surface.command}`));
      assert.match(fields, /Version\s+[2-9]/);
      assert.match(
        fields,
        new RegExp(
          `Resource\\s+${surface.name === "General" ? ids.atlas : ids.relay}`,
        ),
      );
      if (device === "phone") await noPageOverflow(page);
      // The next edit retires the confirmation.
      await surface.editAgain(page);
      await outcomeMessages(page).waitFor({ state: "detached" });
    });

    test(`${where}: rejected input shows one alert and keeps the input`, async (_t, journey) => {
      const { page } = await open(journey, surface, viewport);
      await surface.invalid(page);
      await page.getByRole("button", { name: surface.save }).click();
      const alert = outcomeMessages(page);
      await alert.waitFor();
      assert.equal(await alert.count(), 1);
      assert.equal(await alert.getAttribute("role"), "alert");
      assert.equal(
        (await alert.locator("p").innerText()).trim(),
        "Couldn't save: check the highlighted fields. Your changes are still here.",
      );
      assert.equal(await alert.getByRole("button").count(), 0);
      assert.doesNotMatch(await alert.locator("p").innerText(), serviceWords);
      // Nothing was saved and the form is still editable.
      assert.equal(
        await page.getByRole("button", { name: surface.save }).isEnabled(),
        true,
      );
      if (device === "phone") await noPageOverflow(page);
    });

    test(`${where}: a save elsewhere shows one warning with one action`, async (_t, journey) => {
      const fixture = await open(journey, surface, viewport);
      const { page } = fixture;
      await surface.edit(page);
      surface.elsewhere(fixture);
      await page.getByRole("button", { name: surface.save }).click();
      const warning = outcomeMessages(page);
      await warning.waitFor();
      assert.equal(await warning.count(), 1);
      assert.equal(await warning.getAttribute("role"), "alert");
      assert.equal(
        (await warning.locator("p").innerText()).trim(),
        "A newer version was saved elsewhere.",
      );
      assert.equal(await warning.getByRole("button").count(), 1);
      await warning.getByRole("button", { name: "Review changes" }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Review changes" }).count(),
        1,
      );
      if (device === "phone") await noPageOverflow(page);
    });

    test(`${where}: an unknown outcome shows one warning, locks the form and checks the exact request`, async (_t, journey) => {
      const { page, web } = await open(journey, surface, viewport);
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: web.origin,
        });
      await surface.edit(page);
      await page.route("**/api/operator/commands", (r) => r.abort());
      const attempt = commandBody(page);
      await page.getByRole("button", { name: surface.save }).click();
      const warning = outcomeMessages(page);
      await warning.waitFor();
      const first = await attempt;
      assert.equal(await warning.count(), 1);
      assert.equal(await warning.getAttribute("role"), "alert");
      assert.equal(
        (await warning.locator("p").innerText()).trim(),
        "We couldn't confirm the save.",
      );
      assert.equal(await warning.getByRole("button").count(), 1);
      await warning
        .getByRole("button", { name: "Check whether it saved" })
        .waitFor();
      assert.equal(await surface.locked(page).isDisabled(), true);
      // Focus moves to the one action when the Save button is replaced by it.
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        "Check whether it saved",
      );
      // Details hold the receipt fields and copy as plain key: value lines.
      await warning.getByText("Details", { exact: true }).click();
      for (const label of ["Command", "Resource", "Request key", "Code"])
        await warning.getByText(label, { exact: true }).waitFor();
      assert.equal(
        await warning.getByText("Version", { exact: true }).count(),
        0,
      );
      await warning.getByRole("button", { name: "Copy" }).click();
      await warning.getByRole("button", { name: "Copied" }).waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(copied, new RegExp(`^Command: ${surface.command}$`, "m"));
      assert.match(copied, new RegExp(`^Request key: ${first.key}$`, "m"));
      assert.match(copied, /^Code: command-outcome-unknown$/m);
      assert.match(copied, /^Resource: [0-9a-f-]{36}$/m);
      if (device === "phone") await noPageOverflow(page);
      // Checking resends the same request, so it never duplicates the effect.
      await page.unroute("**/api/operator/commands");
      const replay = commandBody(page);
      await warning
        .getByRole("button", { name: "Check whether it saved" })
        .click();
      assert.equal((await replay).key, first.key);
      await savedOutcome(page);
    });
  }

test("Profile edit, capacity, source preview, Claude token and discovery saves each leave one message", async (_t, journey) => {
  const { page, ids, web } = await startSettings(
    journey,
    "/app/profiles/:reviewer/settings",
    desktop,
    undefined,
    { readerFactory: reader },
  );
  const go = async (path: string) => {
    await page.goto(web.origin + resolve(path, ids));
    await page.locator("main.page h1").waitFor();
  };

  await page.getByLabel("Summary", { exact: true }).fill("Edited summary");
  await page.getByRole("button", { name: "Save profile" }).click();
  await savedOutcome(page);

  await go("/app/settings/runtime");
  await page.getByLabel("Global active-turn cap", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Save capacity" }).click();
  await savedOutcome(page);

  // A recorded preview re-opens the form, so another selection can follow.
  await go("/app/projects/:atlas/settings?tab=sync");
  const preview = page.getByRole("button", {
    name: "Preview and activate selection",
  });
  await preview.click();
  await savedOutcome(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Preview and activate selection" && !b.disabled,
    ),
  );

  // Each credential row keeps the confirmation of its own save.
  await go("/app/settings");
  const claude = page.getByRole("region", {
    name: "Claude subscription token",
  });
  await claude.getByRole("button", { name: "Set", exact: true }).click();
  await claude
    .getByLabel("Claude token reference")
    .fill("env:FIXTURE_FEEDBACK_TOKEN");
  await claude.getByRole("button", { name: "Save reference" }).click();
  await savedOutcome(claude);
  await claude.getByRole("button", { name: "Change", exact: true }).click();
  await claude.getByRole("button", { name: "Clear reference" }).click();
  await savedOutcome(claude);

  const discovery = page.getByRole("region", {
    name: "GitHub discovery credential",
  });
  await discovery.getByRole("button", { name: "Set", exact: true }).click();
  await discovery.getByLabel("Environment variable · advanced").check();
  await discovery
    .getByLabel("Variable name")
    .fill("FIXTURE_FEEDBACK_DISCOVERY");
  await discovery.getByRole("button", { name: "Save reference" }).click();
  await savedOutcome(discovery);
  assert.equal(await outcomeMessages(page).count(), 2);
});
