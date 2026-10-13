import { randomUUID } from "node:crypto";
import { chromium, webkit, type Browser, type Page } from "playwright";
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
    /** Enable the Claude runtime beside Codex, with a Claude-shaped fake. */
    claude?: boolean;
  } = {},
) {
  const home = await createSetupHome();
  journey.cleanup(() => home.close(), "setup-home.close");
  const f = await journey.start("fixture.create", () =>
    options.claude
      ? createOperatorFixture(
          null,
          undefined,
          undefined,
          journey.fixtureOptions,
          (_context, harness) =>
            harness === "claude"
              ? new ClaudeShapedFixtureRuntime()
              : new OperatorFixtureRuntime(),
          { runtimeHarnesses: ["codex", "claude"] },
        )
      : createOperatorFixture(
          null,
          undefined,
          undefined,
          journey.fixtureOptions,
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
      ...(options.ghExecutable ? { ghExecutable: options.ghExecutable } : {}),
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
