import { randomUUID } from "node:crypto";
import { chromium, webkit, type Browser, type Page } from "playwright";
import {
  type ReadinessCheckId,
  readinessCheckIds,
  readinessSchema,
} from "../../src/operator/readiness.js";
import type { GitHubReaderFactory } from "../../src/standalone/github-sync.js";
import type { BrowserJourney } from "./browser-diagnostics.js";
import {
  ClaudeShapedFixtureRuntime,
  createOperatorFixture,
  OperatorFixtureRuntime,
} from "./operator-web.js";
import { createSetupHome, fakeDiscovery } from "./setup-home.js";

/** A signed-in setup journey over a temporary home and a fake discovery reader. */
export async function setupJourney(
  journey: BrowserJourney,
  options: {
    profiles?: boolean;
    projects?: boolean;
    discovery?: boolean;
    engine?: "chromium" | "webkit";
    viewport?: { width: number; height: number };
    path?: string;
    /** Every fake discovery list reports more than it returned. */
    truncated?: boolean;
    /** A fake `gh` executable; without one the service finds no gh. */
    ghExecutable?: string;
    /** The GitHub source reader, for a setup that imports from its linked Project. */
    readerFactory?: GitHubReaderFactory;
    /** Enable the Claude runtime beside Codex, with a Claude-shaped fake. */
    claude?: boolean;
  } = {},
) {
  const home = await createSetupHome();
  journey.cleanup(() => home.close(), "setup-home.close");
  // The service resolves source credentials with the same gh the setup reads use.
  const gh = options.ghExecutable ? { ghExecutable: options.ghExecutable } : {};
  const f = await journey.start("fixture.create", () =>
    options.claude
      ? createOperatorFixture(
          null,
          options.readerFactory,
          undefined,
          journey.fixtureOptions,
          (_context, harness) =>
            harness === "claude"
              ? new ClaudeShapedFixtureRuntime()
              : new OperatorFixtureRuntime(),
          { runtimeHarnesses: ["codex", "claude"], ...gh },
        )
      : createOperatorFixture(
          null,
          options.readerFactory,
          undefined,
          journey.fixtureOptions,
          undefined,
          gh,
        ),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const discoveryState: {
    failure?: Error;
    calls: string[];
    truncated?: boolean;
  } = {
    calls: [],
    ...(options.truncated ? { truncated: true } : {}),
  };
  const d = f.service.domain();
  const command = (body: Record<string, unknown>) =>
    d.execute({ actor: "operator", key: randomUUID(), ...body } as never);
  const profiles: Record<string, string> = {};
  if (options.profiles !== false)
    for (const name of ["Mira", "Nora"]) {
      profiles[name] = randomUUID();
      command({
        type: "profile.create",
        profileId: profiles[name],
        name,
        instructions: "Lead",
        capabilities: "Coordinate",
      });
    }
  if (options.projects)
    command({
      type: "project.create",
      projectId: randomUUID(),
      name: "Relay",
      leadProfileId: null,
    });
  if (options.discovery !== false)
    command({
      type: "discovery.configure",
      credentialRef: "env:FIXTURE_DISCOVERY",
    });
  const web = await journey.start("fixture.web", () =>
    f.startWeb([f.directory], {
      home: home.home,
      discovery: fakeDiscovery(discoveryState),
      ...gh,
    }),
  );
  browser = await journey.start("browser.launch", () =>
    (options.engine === "webkit" ? webkit : chromium).launch(),
  );
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1366, height: 900 },
  });
  journey.observe(page);
  page.setDefaultTimeout(5000);
  await page.goto(web.origin + (options.path ?? "/app/settings/projects/new"));
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("main.page h1").waitFor();
  return { f, web, home, page, discoveryState, profiles };
}

/** Four open issues per selection on acme/atlas, as a linked GitHub Project would read. */
export const atlasIssueReader: GitHubReaderFactory = () => ({
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

export const commandRequest = (page: Page) =>
  page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/api/operator/commands"),
  );

/** Choose a discovered repository and wait for its branches to load. */
export async function chooseRepository(page: Page, label: string) {
  await page
    .getByLabel("Repository", { exact: true })
    .first()
    .selectOption({ label });
  await page
    .getByLabel("Ref", { exact: true })
    .locator("option", { hasText: "develop" })
    .waitFor({ state: "attached" });
}

/**
 * Run `action`, then wait for the setup page's second GitHub CLI login read, the one it
 * makes once discovery is known to be unconfigured, and for the frame that applies it.
 * Until then a login offer that should exist has not rendered, so "no offer" would pass.
 */
export async function settleGhRead(page: Page, action: () => Promise<unknown>) {
  let reads = 0;
  const second = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/operator/discovery" && ++reads >= 2,
  );
  await action();
  await second;
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
}

/** A schema-valid readiness read: everything passes except the named checks. */
export const readinessBody = (
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
export const stubReadiness = (
  page: Page,
  failing: Partial<Record<ReadinessCheckId, "fail" | "not-configured">> = {},
) =>
  page.route("**/api/operator/readiness", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: readinessBody(failing),
    }),
  );
