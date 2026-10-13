import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readinessSchema } from "../../src/operator/readiness.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  startSettings,
} from "../fixtures/operator-settings.js";
import {
  ClaudeShapedFixtureRuntime,
  OperatorFixtureRuntime,
} from "../fixtures/operator-web.js";
import { tmpdir } from "../fixtures/temp.js";

const test = browserSuite("readiness-panel");
const CANARY = "readiness-canary-token-6613";
const LABEL = {
  pass: "Pass",
  fail: "Fail",
  "not-configured": "Not configured",
} as const;

for (const [name, viewport] of [
  ["desktop", desktop],
  ["phone", phone],
] as const) {
  test(`Settings shows the service readiness checks with fix lines on ${name}`, async (t, journey) => {
    const { f, page } = await startSettings(journey, "/app/settings", viewport);
    const root = mkdtempSync(join(tmpdir(), "ensemble-ready-ui-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tokenPath = join(root, "claude-token");
    writeFileSync(tokenPath, `${CANARY}\n`);
    chmodSync(tokenPath, 0o644);
    f.service.domain().execute({
      type: "claude-token.configure",
      actor: "operator",
      key: randomUUID(),
      credentialRef: `file:${tokenPath}`,
    });

    const panel = page.locator(".settings-panel", {
      has: page.getByRole("heading", { name: "Readiness", exact: true }),
    });
    // First panel of the right column.
    assert.equal(
      await page
        .locator(".settings-column")
        .nth(1)
        .locator(".settings-panel")
        .first()
        .getByRole("heading", { name: "Readiness", exact: true })
        .count(),
      1,
    );

    const requests: string[] = [];
    page.on("request", (r) => {
      const url = new URL(r.url()).pathname;
      if (
        url.startsWith("/api/operator/readiness") ||
        url.endsWith("/commands")
      )
        requests.push(`${r.method()} ${url}`);
    });
    await panel.getByRole("button", { name: "Run again" }).click();
    await panel
      .getByRole("article", { name: "Claude token" })
      .getByText("Fail", { exact: true })
      .waitFor();
    assert.deepEqual(requests, ["GET /api/operator/readiness"]);

    const api = readinessSchema.parse(
      await page.evaluate(async () =>
        (await fetch("/api/operator/readiness")).json(),
      ),
    );
    assert.equal(api.data.checks.length, 7);
    for (const c of api.data.checks) {
      const row = panel.getByRole("article", {
        name: c.label,
        exact: true,
      });
      await row.getByText(LABEL[c.status], { exact: true }).waitFor();
      // Every non-pass row shows its fix line; a pass has none.
      assert.equal(
        await row.locator(".identifier").count(),
        c.fix ? 1 : 0,
        c.label,
      );
      if (c.fix)
        assert.equal(await row.locator(".identifier").innerText(), c.fix);
    }
    const claude = panel.getByRole("article", { name: "Claude token" });
    await claude
      .getByText("Token file permits group or other access")
      .waitFor();
    await panel
      .getByRole("article", { name: "GitHub discovery" })
      .getByText("Not configured", { exact: true })
      .waitFor();

    const text = await page.locator("body").innerText();
    for (const secret of [CANARY, tokenPath, root, f.directory])
      assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(
      requests.filter((r) => r.endsWith("/commands")),
      [],
      "Run again sends no command",
    );
    if (viewport === phone) await noPageOverflow(page);
    await captureBrowserEvidence(page, `${viewport.width}-settings-readiness`);
  });
}

const unavailable = (route: import("playwright").Route) =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
  });

for (const [name, viewport] of [
  ["desktop", desktop],
  ["phone", phone],
] as const) {
  test(`Run again announces the pending read, keeps focus and marks results stale after a failed read on ${name}`, async (_t, journey) => {
    const { page } = await startSettings(journey, "/app/settings", viewport);
    const panel = page.locator(".settings-panel", {
      has: page.getByRole("heading", { name: "Readiness", exact: true }),
    });
    await panel.getByRole("article").first().waitFor();
    const before = await panel.getByRole("article").allInnerTexts();
    const run = panel.getByRole("button", { name: "Run again" });
    const focused = () =>
      page.evaluate(() => document.activeElement?.textContent?.trim());

    // Pending: announced politely, the button keeps focus, and the rows are marked as earlier.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/operator/readiness", async (route) => {
      await held;
      await unavailable(route);
    });
    await run.focus();
    await run.click();
    await panel
      .getByRole("status")
      .filter({ hasText: "Refreshing. Showing the last fetched data." })
      .waitFor();
    assert.equal(await focused(), "Run again");

    // A failed read: one alert, the last results marked as the last fetched, focus kept.
    release();
    const alert = panel.getByRole("alert");
    await alert
      .getByText("Refresh failed. Showing the last fetched data.")
      .waitFor();
    await alert.getByText(/^Last fetched /).waitFor();
    assert.equal(await focused(), "Run again");
    assert.deepEqual(await panel.getByRole("article").allInnerTexts(), before);

    // A later successful read clears the warning.
    await page.unroute("**/api/operator/readiness");
    await run.click();
    await alert.waitFor({ state: "detached" });
    assert.equal(await focused(), "Run again");
    if (viewport === phone) await noPageOverflow(page);
  });
}

test("the panel never shows the name of a profile the runtime rejects", async (_t, journey) => {
  const { f, page } = await startSettings(
    journey,
    "/app/settings",
    desktop,
    undefined,
    {
      runtimeFactory: (_context, harness) =>
        harness === "claude"
          ? new ClaudeShapedFixtureRuntime()
          : new OperatorFixtureRuntime(),
      serviceOptions: { runtimeHarnesses: ["codex", "claude"] },
    },
  );
  const canaries = [
    "panel-name-canary-token-7781",
    "file:/Users/private-owner/claude-token",
    "env:PANEL_NAME_CANARY_VARIABLE",
  ];
  f.service.domain().execute({
    type: "profile.create",
    key: randomUUID(),
    actor: "operator",
    profileId: randomUUID(),
    name: canaries.join(" "),
    summary: "canary",
    instructions: "canary",
    capabilities: "canary",
    runtime: { harness: "claude", model: "not-a-model", reasoningEffort: null },
  });
  const panel = page.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Readiness", exact: true }),
  });
  await panel.getByRole("button", { name: "Run again" }).click();
  await panel
    .getByText(
      "1 profile uses a model or reasoning effort the runtime does not accept",
    )
    .waitFor();
  const text = await panel.innerText();
  for (const canary of canaries)
    assert.equal(text.includes(canary), false, canary);
});
