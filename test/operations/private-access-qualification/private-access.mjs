import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { readHiddenPassword } from "../../../dist/src/standalone/operator-hidden-password.js";
import { postWithoutFollowingRedirects } from "../../../dist/test/operations/private-access-qualification/private-access-requests.js";

function readConfiguration() {
  const origin = process.env.CAB_TEST_HTTPS_ORIGIN ?? "";
  const projectId = process.env.CAB_TEST_PROJECT_ID ?? "";
  const privateMarker = process.env.CAB_TEST_PRIVATE_MARKER ?? "";
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("invalid origin");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(projectId) ||
    !privateMarker ||
    privateMarker.length > 256
  ) {
    throw new Error("invalid configuration");
  }
  return { origin, projectId, privateMarker };
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--live") {
  process.stderr.write(
    "Usage: node test/operations/private-access-qualification/private-access.mjs --live (requires explicit HTTPS fixture environment)\n",
  );
  process.exitCode = 2;
} else {
  let config;
  try {
    config = readConfiguration();
  } catch {
    process.stderr.write(
      "Private-access proof needs an explicit HTTPS fixture\n",
    );
    process.exitCode = 2;
  }

  if (config) {
    let phase = "fixture password prompt",
      password = "",
      browser,
      context,
      page;
    let signedIn = false,
      failed = false,
      capacityRestore,
      capacityRestored = false;
    const session = async () => {
      const response = await context.request.get(
        `${config.origin}/api/operator/session`,
      );
      assert.equal(response.status(), 200);
      return response.json();
    };
    const command = async (body, headers) => {
      const current = await session();
      return postWithoutFollowingRedirects(
        context.request,
        `${config.origin}/api/operator/commands`,
        {
          headers: headers ?? {
            origin: config.origin,
            "x-csrf-token": current.csrfToken,
          },
          data: body,
        },
      );
    };
    const capacity = async () => {
      const response = await context.request.get(
        `${config.origin}/api/operator/runtime`,
      );
      assert.equal(response.status(), 200);
      return (await response.json()).data;
    };
    try {
      password = await readHiddenPassword(
        process.stdin,
        process.stdout,
        "cab fixture password: ",
      );
      assert.ok(password.length > 0);
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext();
      page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(15_000);
      phase = "unauthenticated private read";
      const privatePath = `/app/projects/${encodeURIComponent(config.projectId)}/settings`;
      assert.equal(
        (await page.goto(config.origin + privatePath))?.status(),
        200,
      );
      await page
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor();
      assert.equal(
        (await page.locator("body").innerText()).includes(config.privateMarker),
        false,
      );
      const anonymousCookie = (await context.cookies()).find(
        (c) => c.name === "cab_operator_session",
      );
      assert.ok(anonymousCookie);
      phase = "unauthenticated runtime and workspace reads";
      await page.goto(`${config.origin}/app/settings/runtime`);
      await page
        .getByRole("button", { name: "Sign in", exact: true })
        .waitFor();
      assert.equal(
        (await page.locator("body").innerText()).includes(config.privateMarker),
        false,
      );
      const anonymous = await browser.newContext();
      try {
        for (const path of [
          "/api/operator/workspace",
          "/api/operator/runtime",
        ]) {
          const response = await anonymous.request.get(config.origin + path);
          assert.equal(response.status(), 401);
          assert.equal(
            (await response.text()).includes(config.privateMarker),
            false,
          );
        }
        phase = "unauthenticated private write";
        const response = await anonymous.request.post(
          `${config.origin}/api/operator/commands`,
          {
            headers: { origin: config.origin },
            data: {
              type: "project.create",
              key: randomUUID(),
              projectId: randomUUID(),
              name: "Unauthenticated proof",
            },
          },
        );
        assert.equal(response.status(), 401);
      } finally {
        await anonymous.close();
      }
      phase = "independent login";
      await page.getByLabel("Password", { exact: true }).fill(password);
      const loginResponse = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/operator/login" &&
          r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      assert.equal((await loginResponse).status(), 200);
      signedIn = true;
      password = "";
      const authenticatedCookie = (await context.cookies()).find(
        (c) => c.name === "cab_operator_session",
      );
      assert.ok(authenticatedCookie);
      assert.notEqual(authenticatedCookie.value, anonymousCookie.value);
      assert.equal(authenticatedCookie.httpOnly, true);
      assert.equal(authenticatedCookie.sameSite, "Strict");
      assert.equal(authenticatedCookie.secure, true);
      phase = "authenticated private read";
      await page.goto(config.origin + privatePath);
      await page
        .getByRole("navigation", { name: "Project configuration sections" })
        .waitFor();
      const privateValues = await context.request.get(
        `${config.origin}/api/operator/projects/${encodeURIComponent(config.projectId)}/private-values`,
      );
      const configuration = await context.request.get(
        `${config.origin}/api/operator/projects/${encodeURIComponent(config.projectId)}/configuration`,
      );
      assert.equal(privateValues.status(), 200);
      assert.equal(configuration.status(), 200);
      assert.equal(
        ((await privateValues.text()) + (await configuration.text())).includes(
          config.privateMarker,
        ),
        true,
      );
      const runtime = await capacity();
      const project = runtime.projects.find(
        (r) => r.project.id === config.projectId,
      );
      assert.ok(project);
      assert.equal(
        JSON.stringify(runtime).includes(config.privateMarker),
        true,
      );
      const workspace = await context.request.get(
        `${config.origin}/api/operator/workspace`,
      );
      assert.equal(workspace.status(), 200);
      assert.equal(
        (await workspace.text()).includes(config.privateMarker),
        true,
      );
      phase = "origin and CSRF refusals";
      const current = await session();
      const deniedName = `Rejected proof ${randomUUID()}`;
      for (const headers of [
        { origin: config.origin },
        { "x-csrf-token": current.csrfToken },
        { origin: "null", "x-csrf-token": current.csrfToken },
        {
          origin: "https://elsewhere.example",
          "x-csrf-token": current.csrfToken,
        },
      ]) {
        for (const body of [
          {
            type: "project.create",
            key: randomUUID(),
            projectId: randomUUID(),
            name: deniedName,
          },
          {
            type: "capacity.configure",
            key: randomUUID(),
            globalLimit: runtime.globalLimit,
            projectOverrides: { [config.projectId]: project.limit },
          },
        ])
          assert.equal((await command(body, headers)).status(), 403);
      }
      const deniedWorkspace = await context.request.get(
        `${config.origin}/api/operator/workspace`,
      );
      assert.equal((await deniedWorkspace.text()).includes(deniedName), false);
      phase = "same-origin capacity write and replay";
      capacityRestore = {
        type: "capacity.configure",
        key: randomUUID(),
        globalLimit: runtime.globalLimit,
        projectOverrides: { [config.projectId]: project.override },
      };
      const changed = project.limit === 1 ? 2 : project.limit - 1;
      const change = {
        type: "capacity.configure",
        key: randomUUID(),
        globalLimit: runtime.globalLimit,
        projectOverrides: { [config.projectId]: changed },
      };
      let receipt;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await command(change);
        assert.equal(response.status(), 200);
        const value = await response.json();
        if (receipt) assert.deepEqual(value, receipt);
        receipt = value;
      }
      assert.equal(
        (await capacity()).projects.find(
          (r) => r.project.id === config.projectId,
        ).limit,
        changed,
      );
      assert.equal((await command(capacityRestore)).status(), 200);
      assert.equal(
        (await capacity()).projects.find(
          (r) => r.project.id === config.projectId,
        ).override,
        project.override,
      );
      capacityRestored = true;
      phase = "same-origin configuration write";
      const createdName = `S04c private proof ${randomUUID()}`;
      assert.equal(
        (
          await command({
            type: "project.create",
            key: randomUUID(),
            projectId: randomUUID(),
            name: createdName,
          })
        ).status(),
        200,
      );
      const createdWorkspace = await context.request.get(
        `${config.origin}/api/operator/workspace`,
      );
      assert.equal((await createdWorkspace.text()).includes(createdName), true);
    } catch {
      failed = true;
      process.stderr.write(
        `Private-access proof failed during ${phase}; response data and credentials were suppressed\n`,
      );
    } finally {
      password = "";
      if (capacityRestore && !capacityRestored && context) {
        try {
          assert.equal((await command(capacityRestore)).status(), 200);
          capacityRestored = true;
        } catch {
          failed = true;
          process.stderr.write(
            "Private-access capacity restoration was not confirmed; restore the disposable fixture before release\n",
          );
        }
      }
      if (signedIn && context) {
        try {
          const current = await session();
          const response = await context.request.post(
            `${config.origin}/api/operator/logout`,
            {
              headers: {
                origin: config.origin,
                "x-csrf-token": current.csrfToken,
              },
              data: {},
            },
          );
          assert.equal(response.status(), 200);
        } catch {
          failed = true;
          process.stderr.write(
            "Private-access browser logout was not confirmed; stop the disposable fixture before release\n",
          );
        }
      }
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
    if (failed) process.exitCode = 1;
    else
      process.stdout.write(
        "Private-access assertions and browser logout passed\n",
      );
  }
}
