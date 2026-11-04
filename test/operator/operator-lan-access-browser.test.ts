import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { testLanAddress } from "../fixtures/operator-network.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";

const test = browserSuite("operator-lan-access-browser");

test("direct LAN UI loads its sign-in screen", async (_t, journey) => {
  const f = await journey.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, journey.fixtureOptions),
  );
  let browser: Browser | undefined;
  journey.cleanup(
    (primary) => f.close(browser, primary),
    "fixture.close",
    () => f.lifecycle.steps,
  );
  const web = await journey.start("fixture.web", () =>
    f.startWeb(undefined, undefined, undefined, undefined, {
      address: testLanAddress(),
    }),
  );
  assert.ok(web.lanOrigin);
  browser = await journey.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage();
  journey.observe(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.lanOrigin}/app`);
  const observed = await page.evaluate(() => ({
    secure: window.isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    subtle: typeof crypto.subtle,
    randomValues: typeof crypto.getRandomValues,
    clipboard: typeof navigator.clipboard,
    body: document.body.innerText,
  }));
  process.stdout.write(
    `LAN calibration ${JSON.stringify({ ...observed, errors })}\n`,
  );
  assert.equal(observed.secure, false);
  await page.getByLabel("Password", { exact: true }).waitFor();
});

for (const engine of ["chromium", "webkit"] as const) {
  test(
    `LAN token reveal offers manual copy when clipboard is unavailable (${engine})`,
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
      const web = await journey.start("fixture.web", () =>
        f.startWeb(undefined, undefined, undefined, undefined, {
          address: testLanAddress(),
        }),
      );
      assert.ok(web.lanOrigin);
      const { webkit } = await import("playwright");
      browser = await journey.start(`browser.launch.${engine}`, () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      journey.observe(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${web.lanOrigin}/app/settings`);
      await page.getByLabel("Password", { exact: true }).fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const panel = page.locator("section.settings-panel").filter({
        has: page.getByRole("heading", { name: "CLI credentials" }),
      });
      await panel.getByLabel("Credential name").fill("LAN fixture");
      await panel.getByRole("button", { name: "Create credential" }).click();
      const dialog = page.getByRole("dialog", {
        name: "CLI token for LAN fixture",
      });
      await dialog.getByRole("button", { name: "Copy" }).click();
      try {
        await dialog
          .getByText("Copy failed. Select the token and copy it manually.")
          .waitFor();
      } finally {
        process.stdout.write(
          `LAN clipboard errors ${JSON.stringify(errors)}\n`,
        );
      }
      assert.deepEqual(errors, []);
    },
  );
}

for (const engine of ["chromium", "webkit"] as const) {
  test(
    `LAN and loopback sessions, comment and restart (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const { webkit } = await import("playwright");
      const { seedReviewTask, markTaskReady } = await import(
        "../fixtures/task-review.js"
      );
      const { signOutFromSidebar } = await import(
        "../fixtures/operator-account.js"
      );
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
      const task = await seedReviewTask(f, "LAN project", "LAN comment task");
      markTaskReady(f, task.taskId);
      const address = testLanAddress();
      const web = await journey.start("fixture.web", () =>
        f.startWeb(undefined, undefined, undefined, undefined, { address }),
      );
      assert.ok(web.lanOrigin);
      browser = await journey.start(`browser.launch.${engine}`, () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      process.stdout.write(
        `LAN journey ${JSON.stringify({ engine, browserVersion: browser.version(), lanOrigin: web.lanOrigin, loopbackOrigin: web.origin })}\n`,
      );
      const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
      });
      const lanPage = await context.newPage();
      const localPage = await context.newPage();
      for (const page of [lanPage, localPage]) {
        journey.observe(page);
        page.setDefaultTimeout(5000);
      }
      const login = async (
        page: typeof lanPage,
        origin: string,
        path = "/app",
      ) => {
        await page.goto(`${origin}${path}`);
        await page.getByLabel("Password", { exact: true }).fill(web.password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
      };
      await login(lanPage, web.lanOrigin, `/app/tasks/${task.taskId}`);
      assert.equal(await lanPage.evaluate(() => window.isSecureContext), false);
      const commands: Array<Record<string, unknown>> = [];
      lanPage.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith("/api/operator/commands")
        )
          commands.push(request.postDataJSON());
      });
      const box = lanPage.getByLabel("Editable reply");
      await box.waitFor();
      await lanPage.getByRole("button", { name: /^Remove @lead/ }).click();
      const add = lanPage.getByRole("button", { name: "Add recipient" });
      await add.focus();
      await lanPage.keyboard.press("Enter");
      await lanPage.getByRole("list", { name: "Assignments to add" }).waitFor();
      await lanPage.keyboard.press("Escape");
      assert.equal(
        await lanPage.getByRole("list", { name: "Assignments to add" }).count(),
        0,
      );
      await box.fill("LAN fixture comment é");
      await lanPage.getByRole("button", { name: "Send comment" }).click();
      await lanPage
        .getByText("Comment recorded. No assignment was woken.")
        .waitFor();
      assert.equal(commands.length, 1);
      assert.match(
        String(commands[0]?.key),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      await lanPage
        .getByRole("log", { name: "Task conversation" })
        .getByText("LAN fixture comment é")
        .waitFor();
      await lanPage.goto(`${web.lanOrigin}/app/settings#notifications`);
      const notifications = lanPage.locator("section.settings-panel").filter({
        has: lanPage.getByRole("heading", {
          name: "Notifications",
          level: 2,
        }),
      });
      await notifications.getByText("Not supported here").waitFor();
      assert.match(await notifications.innerText(), /secure address/);
      assert.equal(
        await notifications
          .getByRole("button", { name: "Turn on notifications" })
          .count(),
        0,
      );
      await login(localPage, web.origin);
      await localPage
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      await signOutFromSidebar(lanPage);
      await lanPage.getByLabel("Password", { exact: true }).waitFor();
      await localPage.reload();
      await localPage
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      await login(lanPage, web.lanOrigin);
      await lanPage
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      const port = Number(new URL(web.origin).port);
      await lanPage.close();
      await localPage.close();
      await web.close();
      await f.reopen();
      const restarted = await journey.start("fixture.web.restart", () =>
        f.startWeb(undefined, undefined, undefined, undefined, {
          address,
          port,
        }),
      );
      assert.equal(restarted.origin, web.origin);
      assert.equal(restarted.lanOrigin, web.lanOrigin);
      for (const origin of [web.origin, web.lanOrigin]) {
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        journey.observe(page);
        await page.goto(`${origin}/app`);
        await page.getByLabel("Password", { exact: true }).waitFor();
        await page.close();
      }
    },
  );
}

for (const engine of ["chromium", "webkit"] as const) {
  test(
    `loopback HTTP and HTTPS proxy keep separate cookies on one hostname (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const { webkit } = await import("playwright");
      const { createServer: createHttpsServer } = await import("node:https");
      const { request } = await import("node:http");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { signOutFromSidebar } = await import(
        "../fixtures/operator-account.js"
      );
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
      const key = join(f.directory, "proxy-key.pem");
      const cert = join(f.directory, "proxy-cert.pem");
      await promisify(execFile)(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { cwd: f.directory },
      );
      let target = 0;
      const proxy = createHttpsServer(
        { key: await readFile(key), cert: await readFile(cert) },
        (incoming, outgoing) => {
          const upstream = request(
            {
              host: "127.0.0.1",
              port: target,
              method: incoming.method,
              path: incoming.url,
              headers: incoming.headers,
            },
            (answer) => {
              outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
              answer.pipe(outgoing);
            },
          );
          upstream.on("error", () => {
            if (!outgoing.headersSent) outgoing.writeHead(502);
            outgoing.end();
          });
          incoming.pipe(upstream);
        },
      );
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      journey.cleanup(async () => {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
      }, "proxy.close");
      const proxyOrigin = `https://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      const web = await journey.start("fixture.web", () =>
        f.startWeb(undefined, undefined, undefined, undefined, {
          address: testLanAddress(),
          authOrigin: proxyOrigin,
        }),
      );
      target = Number(new URL(web.origin).port);
      browser = await journey.start(`browser.launch.${engine}`, () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const local = await context.newPage();
      const secure = await context.newPage();
      for (const page of [local, secure]) {
        page.setDefaultTimeout(5000);
        journey.observe(page);
      }
      const login = async (page: typeof local, origin: string) => {
        await page.goto(`${origin}/app`);
        await page.getByLabel("Password", { exact: true }).fill(web.password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Overview", exact: true })
          .waitFor();
      };
      await login(local, web.origin);
      await login(secure, proxyOrigin);
      assert.equal(await secure.evaluate(() => window.isSecureContext), true);
      const cookies = await context.cookies();
      const localCookie = cookies.find(
        (cookie) => cookie.name === "cab_operator_session_loopback",
      );
      const proxyCookie = cookies.find(
        (cookie) => cookie.name === "cab_operator_session_proxy",
      );
      assert.ok(localCookie && proxyCookie);
      assert.equal(localCookie.secure, false);
      assert.equal(proxyCookie.secure, true);
      await local.reload();
      await local
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      await secure.reload();
      await secure
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      await signOutFromSidebar(secure);
      await secure.getByLabel("Password", { exact: true }).waitFor();
      await local.reload();
      await local
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      await login(secure, proxyOrigin);
      await signOutFromSidebar(local);
      await local.getByLabel("Password", { exact: true }).waitFor();
      await secure.reload();
      await secure
        .getByRole("heading", { name: "Overview", exact: true })
        .waitFor();
      await context.close();
    },
  );
}
