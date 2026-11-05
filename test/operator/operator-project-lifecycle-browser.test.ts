import { until } from "../fixtures/until.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserSuite, killBrowser } from "../fixtures/browser-diagnostics.js";
import { deletedCleanupFixture } from "../fixtures/deleted-project-cleanup.js";
import { signIn } from "../fixtures/operator-settings.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";

const test = browserSuite("operator-project-lifecycle-browser");

for (const engine of ["chromium", "webkit"] as const) {
  test(
    `archived history, exact-name danger zone and unknown deletion receipt survive navigation (${engine})`,
    { browserEngine: engine },
    async (t, journey) => {
      const f = await journey.start("fixture.create", () =>
        deletedCleanupFixture(t, { workspaces: true }),
      );
      const web = await journey.start("fixture.web", () =>
        f.fixture.startWeb(),
      );
      const { chromium, webkit } = await import("playwright");
      const browser = await journey.start("browser.launch", () =>
        (engine === "webkit" ? webkit : chromium).launch(),
      );
      journey.cleanup(() => killBrowser(browser), "browser.close");
      const page = await browser.newPage();
      journey.observe(page);
      page.setDefaultTimeout(5000);
      const settings = `${web.origin}/app/projects/${f.projectId}/settings`;
      await signIn(page, web, "/app/settings#projects");
      const projects = page.locator("section#projects");
      assert.equal(
        await projects
          .getByRole("heading", { name: /^Archive fixture(?:\s|$)/ })
          .count(),
        0,
      );
      await page.getByLabel("Show archived").check();
      await projects
        .getByRole("heading", { name: /^Archive fixture(?:\s|$)/ })
        .waitFor();
      await page.goto(`${web.origin}/app/tasks/${f.taskId}?section=execution`);
      await page
        .getByText(
          "This project is archived. Tasks and history are read-only.",
          { exact: false },
        )
        .waitFor();
      await page.getByRole("tab", { name: "Execution", exact: true }).click();
      await page
        .getByRole("link", { name: /recovery$/ })
        .first()
        .waitFor();
      await page.getByRole("tab", { name: "Review", exact: true }).click();
      await page
        .getByRole("heading", { name: "Local review", exact: true })
        .waitFor();
      await page.goto(settings);
      const panel = page.getByRole("region", { name: "Project lifecycle" });
      await panel
        .getByRole("button", { name: "Restore project", exact: true })
        .waitFor();
      // The danger zone ends the page; configuration comes first.
      assert.equal(
        await panel.evaluate((element) => {
          const general = [...document.querySelectorAll("main h2")].find(
            (h) => h.textContent?.trim() === "General",
          );
          return Boolean(
            general &&
              general.compareDocumentPosition(element) &
                Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
        true,
      );
      await panel
        .getByRole("button", { name: "Restore project", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "Archive project", exact: true })
        .waitFor();
      const restored = f.service.domain().project(f.projectId);
      assert.equal(restored.paused, 1);
      assert.equal(restored.archived, 0);
      const archive = panel.getByRole("button", {
        name: "Archive project",
        exact: true,
      });
      // Restore's callbacks can be queued after a drained check, so re-read until
      // the page itself allows archiving.
      await until(
        async () => {
          if (f.service.projectLifecycleStatus(f.projectId).length !== 0)
            return false;
          const read = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname ===
              `/api/operator/projects/${f.projectId}`,
          );
          await page
            .getByRole("button", { name: "Refresh", exact: true })
            .click();
          await read;
          return archive.isEnabled();
        },
        "archiving allowed after the restored project drained",
        15_000,
      );
      await archive.click();
      await panel
        .getByRole("button", { name: "Inspect deletion preview", exact: true })
        .waitFor();
      await panel
        .getByRole("button", { name: "Inspect deletion preview", exact: true })
        .click();
      await panel.getByText(/worktree: dirty yes/).waitFor();
      const input = panel.getByLabel(
        "Type the exact project name: Archive fixture",
        { exact: true },
      );
      const remove = panel.getByRole("button", {
        name: "Delete project permanently",
        exact: true,
      });
      const posts: Array<Record<string, unknown>> = [];
      let conflict = true;
      await page.route("**/api/operator/commands", async (route) => {
        const command = route.request().postDataJSON();
        if (command.type !== "project.delete") return route.continue();
        posts.push(command);
        if (conflict) {
          await route.fulfill({
            status: 409,
            json: { error: { code: "conflict", message: "Preview changed" } },
          });
        } else {
          await route.fetch();
          await route.abort("failed");
        }
      });
      assert.equal(await remove.isDisabled(), true);
      await input.fill("archive fixture");
      await input.press("Enter");
      assert.equal(await remove.isDisabled(), true);
      assert.equal(posts.length, 0);
      await input.fill("Archive fixture");
      await remove.click();
      await panel
        .getByText("A newer version was saved elsewhere.", { exact: true })
        .waitFor();
      assert.equal(await input.inputValue(), "Archive fixture");
      assert.equal(await remove.isDisabled(), true);
      conflict = false;
      await panel
        .getByRole("button", { name: "Refresh deletion preview", exact: true })
        .click();
      await remove.waitFor({ state: "visible" });
      await input.focus();
      assert.equal(
        await input.evaluate((e) => e === document.activeElement),
        true,
      );
      await remove.click();
      await panel
        .getByText("We couldn't confirm the save.", { exact: true })
        .waitFor();
      assert.equal(await input.inputValue(), "Archive fixture");
      assert.equal(await remove.isDisabled(), true);
      const original = JSON.stringify(posts.at(-1));
      await panel
        .getByRole("button", { name: "Check whether it saved", exact: true })
        .click();
      await page.getByRole("region", { name: "Deleted project" }).waitFor();
      assert.equal(JSON.stringify(posts.at(-1)), original);
      assert.equal(posts.length, 2, "receipt check is GET-only");
      const receipt = await new OperatorApi(f.service, [
        f.fixture.directory,
      ]).readOperation(
        new URLSearchParams({
          scope: `project:${f.projectId}`,
          type: "project.delete",
          key: String(posts.at(-1)!.key),
        }),
      );
      assert.equal(receipt.data.state, "recorded");
      await f.service.stop();
      await f.service.start();
      const deleted = (
        await new OperatorApi(f.service, [f.fixture.directory]).readProject(
          f.projectId,
        )
      ).data;
      assert.equal(deleted.state, "deleted");
      if (deleted.state !== "deleted") throw Error("missing tombstone");
      assert.equal(deleted.tombstone.cleanup.state, "complete");
      const replacement = randomUUID();
      f.service.domain().execute({
        type: "project.create",
        actor: "operator",
        key: randomUUID(),
        projectId: replacement,
        name: "Archive fixture",
        leadProfileId: null,
      });
      assert.notEqual(replacement, f.projectId);
      assert.equal(
        (
          await new OperatorApi(f.service, [f.fixture.directory]).readProject(
            f.projectId,
          )
        ).data.state,
        "deleted",
      );
      assert.equal(f.fixture.runtime.turns, 0);
    },
  );
}
