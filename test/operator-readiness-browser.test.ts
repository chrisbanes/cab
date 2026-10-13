import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readinessSchema } from "../src/operator/readiness.js";
import {
  browserSuite,
  captureBrowserEvidence,
} from "./fixtures/browser-diagnostics.js";
import {
  desktop,
  noPageOverflow,
  phone,
  startSettings,
} from "./fixtures/operator-settings.js";
import { tmpdir } from "./temp.js";

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
      const row = panel.getByRole("article", { name: c.label });
      await row.getByText(LABEL[c.status], { exact: true }).waitFor();
      assert.equal(
        await row.locator(".identifier").count(),
        c.status === "fail" ? 1 : 0,
        c.label,
      );
      if (c.status === "fail")
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
