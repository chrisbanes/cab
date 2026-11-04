import assert from "node:assert/strict";
import {
  browserSuite,
  captureBrowserEvidence,
} from "../fixtures/browser-diagnostics.js";
import { startSettings } from "../fixtures/operator-settings.js";

const test = browserSuite("operator-archived-recovery-browser");

for (const engine of ["chromium", "webkit"] as const) {
  test(
    `archived Recovery preserves original bound proof and GET receipt checks without retry sends (${engine})`,
    { browserEngine: engine },
    async (_t, journey) => {
      const { chromium, webkit } = await import("playwright");
      const { page, ids } = await startSettings(
        journey,
        "/app/assignments/:assignment/recovery",
        { width: 1366, height: 900 },
        () => (engine === "webkit" ? webkit : chromium).launch(),
      );
      let archived = false;
      let lookup: "absent" | "recorded" = "absent";
      const posts: Array<Record<string, unknown>> = [];
      const reads: Array<URLSearchParams> = [];
      // Only presentation is under test: server archive/drain/write rules have service coverage.
      await page.route(
        "**/api/operator/assignments/*/recovery",
        async (route) => {
          const body = await (await route.fetch()).json();
          body.data.project.archived = archived;
          body.data.assignment.readOnly = archived;
          await route.fulfill({ json: body });
        },
      );
      await page.route("**/recovery-options", async (route) => {
        const body = await (await route.fetch()).json();
        const record = body.data.records[0];
        record.workId = "archived-bound-work";
        record.threadId = "captured-thread";
        record.turnId = "captured-turn";
        record.generation.workRevision = 1;
        record.process = {
          processId: "12345",
          processStartedAt: "captured-birth",
          bootId: "captured-boot",
        };
        record.paths = [
          { path: "bound-turn-recover", eligible: true, blockedBy: [] },
        ];
        body.data.records = [record];
        body.data.gaps = [];
        await route.fulfill({ json: body });
      });
      await page.route("**/api/operator/commands", async (route) => {
        posts.push(route.request().postDataJSON());
        await route.abort("failed");
      });
      await page.route("**/api/operator/operations?**", async (route) => {
        reads.push(new URL(route.request().url()).searchParams);
        const original = posts[0]!;
        await route.fulfill({
          json: {
            observedAt: Date.now(),
            data:
              lookup === "absent"
                ? { state: "not-recorded" }
                : {
                    state: "recorded",
                    receipt: {
                      kind: "recovery-resolution",
                      key: original.key,
                      recorded: true,
                      path: "bound-turn-recover",
                      assignmentId: ids.assignmentId,
                      workId: "archived-bound-work",
                      receiptId: "14f1b0e1-3597-4469-9489-c3685e36684b",
                      state: "reconciled",
                    },
                  },
          },
        });
      });
      await page.reload();
      const panel = page.locator(".settings-panel").filter({
        has: page.getByRole("heading", {
          name: "Reconcile a bound turn",
          exact: true,
        }),
      });
      await panel.getByText(/Eligible for review/).waitFor();
      await panel
        .getByLabel("I independently confirmed this exact process exited")
        .check();
      await panel.getByLabel("All effects and callbacks are settled").check();
      await panel.getByLabel("Workspace disposition").selectOption("preserved");
      await panel
        .getByRole("button", { name: "Review reconciliation", exact: true })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Confirm reconciliation" })
        .click();
      await panel
        .getByRole("button", { name: "Check original receipt" })
        .waitFor();
      assert.equal(posts.length, 1);
      const original = JSON.stringify(posts[0]);
      archived = true;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page
        .getByText(
          "This project is archived. Recovery evidence and original receipt checks remain available; new recovery and retry sends are disabled.",
          { exact: true },
        )
        .waitFor();
      await panel
        .getByText("Original recovery evidence and request key", {
          exact: true,
        })
        .click();
      assert.equal(
        await panel.locator("details pre").textContent(),
        JSON.stringify(posts[0], null, 2),
      );
      assert.equal(
        await panel
          .getByLabel("All effects and callbacks are settled")
          .isChecked(),
        true,
      );
      assert.equal(
        await panel.getByLabel("Workspace disposition").inputValue(),
        "preserved",
      );
      assert.equal(
        await panel.getByLabel("Workspace disposition").isDisabled(),
        true,
      );
      await panel
        .getByRole("button", { name: "Check original receipt" })
        .click();
      await panel
        .getByText(/This project is archived; retry is disabled/)
        .waitFor();
      assert.equal(
        await panel
          .getByRole("button", { name: "Retry exact recovery" })
          .isDisabled(),
        true,
      );
      assert.equal(posts.length, 1);
      assert.equal(JSON.stringify(posts[0]), original);
      assert.equal(reads[0]?.get("scope"), `assignment:${ids.assignmentId}`);
      assert.equal(reads[0]?.get("key"), posts[0]?.key);
      assert.equal(reads[0]?.get("type"), "recovery.bound-turn.recover");
      await captureBrowserEvidence(
        page,
        `1366-archived-original-absent-${engine}`,
      );
      // History and inspector destinations are still keyboard reachable on an archived direct read.
      const inspector = page.getByRole("link", {
        name: "Inspect execution",
        exact: true,
      });
      await inspector.focus();
      assert.equal(
        await inspector.evaluate((e) => e === document.activeElement),
        true,
      );
      assert.equal(
        await inspector.getAttribute("href"),
        `/app/tasks/${ids.taskId}?assignment=${ids.assignmentId}`,
      );
      lookup = "recorded";
      await panel
        .getByRole("button", { name: "Check original receipt" })
        .click();
      await panel
        .getByText("Receipt 14f1b0e1-3597-4469-9489-c3685e36684b", {
          exact: true,
        })
        .waitFor();
      assert.equal(posts.length, 1);
      await captureBrowserEvidence(
        page,
        `1366-archived-original-recorded-${engine}`,
      );
    },
  );
}
