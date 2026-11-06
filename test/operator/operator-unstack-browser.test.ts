import assert from "node:assert/strict";
import type { UnstackReceipt } from "../../src/operator/unstack-contracts.js";
import { chromium, webkit, type Browser } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";
const test = browserSuite("ui-unstack-recovery");

for (const engine of ["chromium", "webkit"] as const) {
  for (const failed of [false, true]) {
    test(
      `${failed ? "failed hold" : "normal stack"} opens the same full-scope safe confirmation and preserves unknown original operation without a resend (${engine})`,
      { browserEngine: engine },
      async (_t, j) => {
        const f = await j.start("fixture.create", () =>
          createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
        );
        let browser: Browser | undefined;
        j.cleanup(
          (primary) => f.close(browser, primary),
          "fixture.close",
          () => f.lifecycle.steps,
        );
        const task = await seedReviewTask(f, "Stack project", "Stack task"),
          taskId = task.taskId;
        const web = await j.start("fixture.web", () => f.startWeb());
        browser = await j.start("browser.launch", () =>
          (engine === "webkit" ? webkit : chromium).launch(),
        );
        const page = await browser.newPage();
        await page.addInitScript(() => {
          Object.defineProperty(crypto, "randomUUID", { value: undefined });
        });
        j.observe(page);
        const preview = {
          taskId,
          expectedVersion: 1,
          materialHash: "a".repeat(64),
          repository: "fixture/private",
          selectedPr: 2,
          stackNumber: 1,
          targetBase: "main",
          members: [
            { number: 1, state: "OPEN" },
            { number: 2, state: "OPEN" },
          ],
        };
        const pending = { command: null as Record<string, unknown> | null };
        let posts = 0,
          lookups = 0,
          readOnly = false,
          hidden = false,
          forgedLookup = true,
          parentUnknown = false;
        const receipt = () => ({
          kind: "task-unstack",
          key: pending.command?.key,
          taskId,
          recorded: true,
          expectedVersion: 1,
          materialHash: preview.materialHash,
          phase: "unstack-attempting",
          revision: 2,
          reason: "readback-required",
        });
        await page.route(`**/api/operator/tasks/${taskId}`, async (route) => {
          const response = await route.fetch(),
            body = await response.json();
          if (parentUnknown) delete body.data.project;
          await route.fulfill({ response, json: body });
        });
        await page.route(`**/api/operator/tasks/${taskId}/unstack`, (route) =>
          route.fulfill({
            json: {
              data: {
                taskId,
                readOnly,
                failedBlocker: failed,
                cancelAvailable: failed && !readOnly,
                preview: pending.command || readOnly || hidden ? null : preview,
                operation: pending.command ? receipt() : null,
                cancelOperation: null,
                available: !pending.command && !readOnly && !hidden,
                unavailable: hidden
                  ? "unproved"
                  : readOnly
                    ? "archived"
                    : pending.command
                      ? "pending"
                      : null,
              },
              observedAt: 1,
            },
          }),
        );
        await page.route("**/api/operator/commands", async (route) => {
          const body = route.request().postDataJSON();
          if (body.type !== "task.unstack") return route.continue();
          posts++;
          pending.command = body;
          await route.abort("failed");
        });
        await page.route("**/api/operator/operations?**", (route) => {
          lookups++;
          return route.fulfill({
            json: {
              data: {
                state: "recorded",
                receipt: {
                  ...receipt(),
                  expectedVersion: forgedLookup ? 2 : 1,
                },
              },
              observedAt: 2,
            },
          });
        });
        await page.goto(`${web.origin}/tasks/${taskId}`);
        await page.getByLabel("Password").fill(web.password);
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        const trigger = page.getByRole("button", {
          name: failed ? "Unstack failed dependency…" : "Unstack…",
          exact: true,
        });
        await trigger.click();
        const dialog = page.getByRole("alertdialog");
        assert.equal(
          await page
            .getByRole("button", { name: "Keep task unchanged" })
            .evaluate((e) => e === document.activeElement),
          true,
        );
        assert.match(
          await dialog.innerText(),
          /all removable unmerged members/,
        );
        assert.match(await dialog.innerText(), /#1 \(OPEN\), #2 \(OPEN\)/);
        assert.match(
          await dialog.innerText(),
          /cannot undo merges or automatic adoption/,
        );
        parentUnknown = true;
        await page.evaluate(() => dispatchEvent(new Event("cab-task-changed")));
        await page
          .getByText(/current write authority is unavailable/)
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Confirm Unstack", exact: true })
            .count(),
          0,
        );
        assert.equal(posts, 0);
        parentUnknown = false;
        await page.evaluate(() => dispatchEvent(new Event("cab-task-changed")));
        await page
          .getByRole("button", { name: "Confirm Unstack", exact: true })
          .waitFor();
        hidden = true;
        await page.evaluate(() => dispatchEvent(new Event("cab-task-changed")));
        await page.waitForFunction(
          () =>
            !document
              .querySelector('[role="alertdialog"]')
              ?.textContent?.includes("fixture/private"),
        );
        assert.equal(posts, 0);
        hidden = false;
        await page.evaluate(() => dispatchEvent(new Event("cab-task-changed")));
        await page.getByText(/Captured stack #1 in fixture\/private/).waitFor();
        await page
          .getByRole("button", { name: "Confirm Unstack", exact: true })
          .click();
        await page.getByText(/Outcome unknown/).waitFor();
        const original = pending.command?.key;
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.reload();
        await page
          .getByRole("button", { name: "Unstack status…", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Check original operation" })
          .click();
        await page.getByText(/The original receipt is not available/).waitFor();
        assert.equal(posts, 1);
        forgedLookup = false;
        await page
          .getByRole("button", { name: "Check original operation" })
          .click();
        await page
          .getByText(/The original receipt is not available/)
          .waitFor({ state: "hidden" });
        await page.getByText(/Unstack unfinished/).waitFor();
        assert.equal(posts, 1);
        assert.equal(lookups, 2);
        assert.equal(pending.command?.key, original);
        readOnly = true;
        await page.evaluate(() => dispatchEvent(new Event("cab-task-changed")));
        await page.getByText(/This project is archived/).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Confirm Unstack", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Check original operation" })
            .isEnabled(),
          true,
        );
      },
    );
  }

  test(
    `a retained unfinished send follows the newer operation without another lookup or POST (${engine})`,
    { browserEngine: engine },
    async (_t, j) => {
      const f = await j.start("fixture.create", () =>
        createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
      );
      let browser: Browser | undefined;
      j.cleanup(
        (primary) => f.close(browser, primary),
        "fixture.close",
        () => f.lifecycle.steps,
      );
      const { taskId } = await seedReviewTask(
        f,
        "Stack project",
        "Stack status",
      );
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start("browser.launch", () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const page = await browser.newPage();
      j.observe(page);
      const pending = { operation: null as UnstackReceipt | null };
      let posts = 0,
        lookups = 0;
      const preview = {
        taskId,
        expectedVersion: 1,
        materialHash: "a".repeat(64),
        repository: "fixture/private",
        selectedPr: 2,
        stackNumber: 1,
        targetBase: "main",
        members: [
          { number: 1, state: "OPEN" },
          { number: 2, state: "OPEN" },
        ],
      };
      await page.route(`**/api/operator/tasks/${taskId}/unstack`, (r) =>
        r.fulfill({
          json: {
            data: {
              taskId,
              readOnly: false,
              failedBlocker: false,
              cancelAvailable: false,
              preview: pending.operation ? null : preview,
              operation: pending.operation,
              cancelOperation: null,
              available: !pending.operation,
              unavailable: pending.operation ? "pending" : null,
            },
            observedAt: 1,
          },
        }),
      );
      await page.route("**/api/operator/commands", async (r) => {
        const command = r.request().postDataJSON();
        if (command.type !== "task.unstack") return r.continue();
        posts++;
        pending.operation = {
          kind: "task-unstack",
          key: command.key,
          taskId,
          recorded: true,
          expectedVersion: 1,
          materialHash: preview.materialHash,
          phase: "unstack-attempting",
          revision: 2,
          reason: "readback-required",
        };
        await r.fulfill({ json: pending.operation });
      });
      await page.route("**/api/operator/operations?**", async (r) => {
        lookups++;
        await r.abort("failed");
      });
      await page.goto(`${web.origin}/tasks/${taskId}`);
      await page.getByLabel("Password").fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: "Unstack…", exact: true }).click();
      await page
        .getByRole("button", { name: "Confirm Unstack", exact: true })
        .click();
      await page.getByText(/Unstack unfinished/).waitFor();
      assert.equal(await page.getByText(/Outcome unknown/).count(), 0);
      assert.ok(pending.operation);
      const originalKey = pending.operation.key;
      pending.operation = {
        ...pending.operation,
        phase: "confirmed",
        revision: 3,
        reason: "confirmed",
      };
      await page.evaluate(() => dispatchEvent(new Event("cab-task-changed")));
      await page
        .getByText(/Unstack and retarget confirmed/)
        .waitFor({ timeout: 5000 });
      assert.equal(await page.getByText(/Unstack unfinished/).count(), 0);
      assert.equal(posts, 1);
      assert.equal(lookups, 0);
      assert.equal(pending.operation.key, originalKey);
    },
  );

  test(
    `Cancel is separate from Stop and retains an unknown original key for GET-only recovery (${engine})`,
    { browserEngine: engine },
    async (_t, j) => {
      const f = await j.start("fixture.create", () =>
        createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
      );
      let browser: Browser | undefined;
      j.cleanup(
        (primary) => f.close(browser, primary),
        "fixture.close",
        () => f.lifecycle.steps,
      );
      const { taskId } = await seedReviewTask(f, "Failed stack", "Cancel task");
      const web = await j.start("fixture.web", () => f.startWeb());
      browser = await j.start("browser.launch", () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      const page = await browser.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(crypto, "randomUUID", { value: undefined });
      });
      j.observe(page);
      const pending = { command: null as { key: string } | null };
      let posts = 0;
      await page.route(`**/api/operator/tasks/${taskId}/unstack`, (r) =>
        r.fulfill({
          json: {
            data: {
              taskId,
              readOnly: false,
              failedBlocker: true,
              cancelAvailable: !pending.command,
              cancelOperation: pending.command
                ? {
                    kind: "task-cancel",
                    key: pending.command.key,
                    taskId,
                    recorded: true,
                    cancellationRequested: 1,
                  }
                : null,
              preview: null,
              operation: null,
              available: false,
              unavailable: "unproved",
            },
            observedAt: 1,
          },
        }),
      );
      await page.route("**/api/operator/commands", async (r) => {
        if (r.request().postDataJSON().type !== "task.cancel")
          return r.continue();
        posts++;
        pending.command = r.request().postDataJSON();
        await r.abort("failed");
      });
      await page.route("**/api/operator/operations?**", (r) =>
        r.fulfill({
          json: {
            data: {
              state: "recorded",
              receipt: {
                kind: "task-cancel",
                key: pending.command?.key,
                recorded: true,
                taskId,
                cancellationRequested: 1,
              },
            },
            observedAt: 1,
          },
        }),
      );
      await page.goto(`${web.origin}/tasks/${taskId}`);
      await page.getByLabel("Password").fill(web.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("button", { name: "Cancel task…", exact: true })
        .click();
      assert.match(
        await page.getByRole("alertdialog").innerText(),
        /separate from Stop/,
      );
      await page
        .getByRole("button", { name: "Confirm Cancel task", exact: true })
        .click();
      await page.getByText(/Outcome unknown/).waitFor();
      await page.reload();
      await page
        .getByRole("button", { name: "Cancel status…", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Check original operation" })
        .click();
      await page.getByText(/Task cancelled. Ownership/).waitFor();
      assert.equal(posts, 1);
    },
  );
}
