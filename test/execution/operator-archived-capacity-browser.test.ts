import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import {
  savedOutcome,
  seedImportedConflict,
  startSettings,
} from "../fixtures/operator-settings.js";
import {
  operatorCommandSchema,
  runtimeSettingsSchema,
  type OperatorCommand,
} from "../../src/operator/contracts.js";

const test = browserSuite("operator-archived-capacity-browser");
const rendered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

for (const engine of ["chromium", "webkit"] as const) {
  const launch = async () => {
    const { chromium, webkit } = await import("playwright");
    return (engine === "webkit" ? webkit : chromium).launch();
  };
  test(
    `capacity edits omit archived owners while preserving their override and history (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const { f, ids, page, web } = await startSettings(
        journey,
        "/settings/runtime",
        { width: 1366, height: 900 },
        launch,
      );
      const d = f.service.domain();
      seedImportedConflict(f, randomUUID(), [ids.atlas, ids.fieldnotes]);
      d.execute({
        type: "capacity.configure",
        actor: "operator",
        key: randomUUID(),
        globalLimit: d.capacityLimits().globalLimit,
        projectOverrides: { [ids.fieldnotes]: 7 },
      });
      d.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: ids.fieldnotes,
        expectedVersion: Number(d.project(ids.fieldnotes).version),
        paused: true,
      });
      d.execute({
        type: "project.archive",
        actor: "operator",
        key: randomUUID(),
        projectId: ids.fieldnotes,
        expectedVersion: Number(d.project(ids.fieldnotes).version),
      });
      await page.reload();
      const archived = page.getByLabel("Set capacity override for Fieldnotes", {
        exact: true,
      });
      await archived.waitFor();
      assert.equal(await archived.isDisabled(), true);
      assert.equal(
        await page
          .getByLabel("Active-turn cap for Fieldnotes", { exact: true })
          .inputValue(),
        "7",
      );
      assert.equal(
        await page
          .getByLabel("Active-turn cap for Fieldnotes", { exact: true })
          .isDisabled(),
        true,
      );
      const posts: Array<
        Extract<OperatorCommand, { type: "capacity.configure" }>
      > = [];
      await page.route("**/api/operator/commands", async (route) => {
        const command = operatorCommandSchema.parse(
          route.request().postDataJSON(),
        );
        if (command.type === "capacity.configure") posts.push(command);
        await route.continue();
      });
      const global = page.getByLabel("Global active-turn cap", { exact: true });
      const limit = d.capacityLimits().globalLimit + 1;
      await global.fill(String(limit));
      await page
        .getByLabel("Set capacity override for Atlas", { exact: true })
        .check();
      await page
        .getByLabel("Active-turn cap for Atlas", { exact: true })
        .fill("5");
      await page
        .getByRole("button", { name: "Save capacity", exact: true })
        .click();
      await savedOutcome(page);
      assert.equal(posts.length, 1);
      assert.equal(
        Object.hasOwn(posts[0]!.projectOverrides, ids.fieldnotes),
        false,
      );
      assert.equal(posts[0]!.projectOverrides[ids.atlas], 5);
      assert.equal(d.capacityLimits().globalLimit, limit);
      assert.equal(d.capacityLimits().projectOverrides[ids.fieldnotes], 7);
      await page.goto(`${web.origin}/projects/${ids.atlas}/settings?tab=sync`);
      const placement = page.getByLabel("Placement project", { exact: true });
      await placement.waitFor();
      assert.equal(
        await placement.locator(`option[value="${ids.fieldnotes}"]`).count(),
        0,
      );
      assert.equal(
        await placement.locator(`option[value="${ids.atlas}"]`).count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Record placement", exact: true })
          .isDisabled(),
        true,
      );
      d.execute({
        type: "project.restore",
        actor: "operator",
        key: randomUUID(),
        projectId: ids.fieldnotes,
        expectedVersion: Number(d.project(ids.fieldnotes).version),
      });
      assert.equal(d.project(ids.fieldnotes).paused, 1);
      await page.goto(`${web.origin}/settings/runtime`);
      const restored = page.getByLabel("Active-turn cap for Fieldnotes", {
        exact: true,
      });
      await restored.waitFor();
      assert.equal(await restored.inputValue(), "7");
      assert.equal(await restored.isEnabled(), true);
      assert.equal(f.runtime.turns, 0);
    },
  );

  test(
    `frozen capacity receipts stay GET-only with archived, missing or unproved owners (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const { page, ids } = await startSettings(
        journey,
        "/settings/runtime",
        { width: 1366, height: 900 },
        launch,
      );
      let mode: "active" | "archived" | "missing" | "unavailable" = "active";
      let recorded = false;
      const posts: Array<
        Extract<OperatorCommand, { type: "capacity.configure" }>
      > = [];
      const lookups: URLSearchParams[] = [];
      await page.route("**/api/operator/runtime", async (route) => {
        if (mode === "unavailable")
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: "unavailable",
                message: "Runtime ownership unavailable",
              },
            },
          });
        const body = runtimeSettingsSchema.parse(
          await (await route.fetch()).json(),
        );
        if (mode === "missing")
          body.data.projects = body.data.projects.filter(
            (row) => row.project.id !== ids.atlas,
          );
        else if (mode === "archived")
          body.data.projects.find(
            (row) => row.project.id === ids.atlas,
          )!.project.archived = true;
        if (recorded) body.data.globalLimit = posts[0]!.globalLimit;
        await route.fulfill({ json: body });
      });
      await page.route("**/api/operator/commands", async (route) => {
        const command = operatorCommandSchema.parse(
          route.request().postDataJSON(),
        );
        if (command.type !== "capacity.configure") return route.continue();
        posts.push(command);
        await route.abort("failed");
      });
      await page.route("**/api/operator/operations?**", async (route) => {
        const query = new URL(route.request().url()).searchParams;
        lookups.push(query);
        const original = posts[0]!;
        assert.equal(query.get("scope"), "system:capacity");
        assert.equal(query.get("type"), "capacity.configure");
        assert.equal(query.get("key"), original.key);
        await route.fulfill({
          json: {
            observedAt: Date.now(),
            data: recorded
              ? {
                  state: "recorded",
                  receipt: {
                    kind: "configuration",
                    recorded: true,
                    key: original.key,
                    result: {
                      commandType: "capacity.configure",
                      resourceId: "system:capacity",
                      globalLimit: original.globalLimit,
                      defaultProjectLimit: 2,
                      projectOverrides: Object.fromEntries(
                        Object.entries(original.projectOverrides).filter(
                          ([, limit]) => limit !== null,
                        ),
                      ),
                    },
                  },
                }
              : { state: "not-recorded" },
          },
        });
      });
      await page.reload();
      const global = page.getByLabel("Global active-turn cap", { exact: true });
      await global.waitFor();
      const desired = Number(await global.inputValue()) + 1;
      await global.fill(String(desired));
      await page
        .getByLabel("Set capacity override for Atlas", { exact: true })
        .check();
      await page
        .getByLabel("Active-turn cap for Atlas", { exact: true })
        .fill("5");
      await page
        .getByRole("button", { name: "Save capacity", exact: true })
        .click();
      const check = page.getByRole("button", {
        name: "Check whether it saved",
        exact: true,
      });
      await check.waitFor();
      assert.equal(posts.length, 1);
      const original = JSON.stringify(posts[0]);
      for (const next of ["unavailable", "archived", "missing"] as const) {
        mode = next;
        const response = page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/operator/runtime",
        );
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await response;
        await rendered(page);
        assert.equal(await global.inputValue(), String(desired));
        const receipt = page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/operator/operations",
        );
        await check.click();
        await receipt;
        await rendered(page);
        assert.equal(posts.length, 1, next);
        assert.equal(JSON.stringify(posts[0]), original);
        assert.equal(await global.inputValue(), String(desired));
        if (next === "archived")
          assert.equal(
            await page
              .getByLabel("Active-turn cap for Atlas", { exact: true })
              .inputValue(),
            "5",
          );
      }
      recorded = true;
      await check.click();
      await savedOutcome(page);
      assert.equal(lookups.length, 4);
      assert.equal(posts.length, 1);
      assert.equal(JSON.stringify(posts[0]), original);
    },
  );
}
