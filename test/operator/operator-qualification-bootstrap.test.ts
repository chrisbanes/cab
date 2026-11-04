import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

const helpers = (await import(
  pathToFileURL(resolve("test/fixtures/operator-session.mjs")).href
)) as {
  sessionCommand(
    page: Page,
    origin: string,
    command: unknown,
  ): Promise<unknown>;
  signOutOperator(page: Page, origin: string): Promise<void>;
  waitForOperatorSignIn(page: Page): Promise<void>;
};
const test = browserSuite("qualification-bootstrap");
for (const engine of ["chromium", "webkit"] as const) {
  test(
    `qualification waits for delayed session bootstrap, then uses keyed commands and logout (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const f = await journey.start("fixture.create", () =>
        createOperatorFixture(
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
      const web = await journey.start("fixture.web", () => f.startWeb());
      browser = await journey.start("browser.launch", () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const page = await browser.newPage();
      journey.observe(page);
      page.setDefaultTimeout(5000);
      const expectAnonymousSignIn = async (path: string) => {
        let releaseSession!: () => void;
        const sessionBarrier = new Promise<void>((resolve) => {
          releaseSession = resolve;
        });
        await page.route(
          `${web.origin}/api/operator/session`,
          async (route) => {
            await sessionBarrier;
            await route.continue();
          },
          { times: 1 },
        );
        const sessionRequest = page.waitForRequest(
          `${web.origin}/api/operator/session`,
        );
        try {
          await page.goto(`${web.origin}${path}`);
          await sessionRequest;
          let ready = false;
          const observed = helpers.waitForOperatorSignIn(page).then(() => {
            ready = true;
          });
          void observed.catch(() => {});
          await page.getByText("Loading sign-in…", { exact: true }).waitFor();
          assert.equal(
            ready,
            false,
            "the helper must not accept the pending bootstrap",
          );
          releaseSession();
          await observed;
          assert.equal(
            await page
              .getByRole("heading", { name: "Sign in", exact: true })
              .innerText(),
            "Sign in",
          );
        } finally {
          releaseSession();
        }
      };
      await expectAnonymousSignIn("/login");
      await page.getByLabel("Password", { exact: true }).fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.locator("main.page h1").waitFor();
      const profileId = randomUUID();
      const command = {
        type: "profile.create",
        key: randomUUID(),
        profileId,
        name: "Bootstrap fixture",
        instructions: "",
        capabilities: "",
      };
      const receipt = await helpers.sessionCommand(page, web.origin, command);
      assert.deepEqual(
        await helpers.sessionCommand(page, web.origin, command),
        receipt,
      );
      assert.equal(
        f.service
          .domain()
          .profiles()
          .filter((p) => p.id === profileId).length,
        1,
      );
      await helpers.sessionCommand(page, web.origin, {
        type: "capacity.configure",
        key: randomUUID(),
        globalLimit: 3,
        projectOverrides: {},
      });
      assert.equal(f.service.capacityLimits().globalLimit, 3);
      await helpers.signOutOperator(page, web.origin);
      await page.getByLabel("Password", { exact: true }).waitFor();
      await expectAnonymousSignIn("/app/settings/runtime");
      assert.equal(
        (
          await page.request.get(`${web.origin}/api/operator/workspace`)
        ).status(),
        401,
      );
    },
  );
}
