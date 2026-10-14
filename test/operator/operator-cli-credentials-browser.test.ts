import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { browserSuite } from "../fixtures/browser-diagnostics.js";
import { setupJourney } from "../fixtures/setup-browser.js";
const test = browserSuite("operator-cli-credentials");

const DAY = 24 * 60 * 60 * 1000;
/** Created and expiry instants of a row (its first two <time> elements). */
const span = async (row: Locator) => {
  const [created = 0, expires = 0] = await row
    .locator("time")
    .evaluateAll((els) =>
      els.map((e) => Date.parse(e.getAttribute("datetime") ?? "")),
    );
  return expires - created;
};

test("Settings issues, rotates and revokes CLI credentials without keeping the token", async (_t, journey) => {
  const { web, page } = await setupJourney(journey, { path: "/app/settings" });
  const bodies: string[] = [];
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/operator/credentials"))
      posts.push(r.url());
  });
  page.on("response", (r) => {
    if (
      r.url().includes("/api/operator/credentials") &&
      r.request().method() === "GET"
    )
      void r.text().then((t) => bodies.push(t));
  });
  const panel = page
    .locator("section.settings-panel")
    .filter({ has: page.getByRole("heading", { name: "CLI credentials" }) });
  const rows = panel.getByRole("listitem");
  const bearer = async (token: string) =>
    (
      await fetch(`${web.origin}/api/operator/cli`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status;
  const create = async (name: string, scope?: string, days?: string) => {
    await panel.getByLabel("Credential name").fill(name);
    if (scope) await panel.getByLabel("Scope").selectOption(scope);
    if (days) await panel.getByLabel("Lifetime").selectOption(days);
    await panel.getByRole("button", { name: "Create credential" }).click();
  };
  const reveal = async () => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Copy" }).waitFor();
    assert.match(await dialog.innerText(), /will not be shown again/);
    const token = (await dialog.locator(".settings-token").innerText()).trim();
    assert.match(token, /^ens_/);
    return { dialog, token };
  };

  // 6. Invalid names are a field error and send nothing.
  await create("");
  await panel.getByText("Name must be 1 to 64 characters").waitFor();
  assert.equal(
    await panel.getByLabel("Credential name").getAttribute("aria-invalid"),
    "true",
  );
  await create("x".repeat(65));
  await panel.getByText("Name must be 1 to 64 characters").waitFor();
  assert.deepEqual(posts, []);

  // 1. Create a read-only credential for 30 days.
  await create("laptop-ro", "read", "30");
  const first = await reveal();
  // 7. The reveal is a labelled dialog and focus is inside it.
  assert.ok(
    await page
      .getByRole("dialog", { name: "CLI token for laptop-ro" })
      .isVisible(),
  );
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest("[role=dialog]"),
    ),
    true,
  );
  await first.dialog.getByRole("button", { name: "Done" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });

  // 2. After a reload the token is gone and the row shows its metadata.
  await page.reload();
  const row = rows.filter({ hasText: "laptop-ro" });
  await row.waitFor();
  assert.equal((await page.content()).includes(first.token), false);
  assert.equal(
    (await page.locator("body").innerText()).includes(first.token),
    false,
  );
  const text = await row.innerText();
  assert.match(text, /Read-only/);
  assert.match(text, /Last used\s*never/i);
  assert.ok(Math.abs((await span(row)) - 30 * DAY) < 60_000);
  assert.ok(bodies.length > 0);
  for (const body of bodies) assert.equal(body.includes(first.token), false);

  // 3. The token authenticates the CLI endpoint and last used then updates.
  assert.equal(await bearer(first.token), 200);
  await page.reload();
  await row.waitFor();
  assert.doesNotMatch(await row.innerText(), /Last used\s*never/i);

  // 4. Create a read-write credential (default 90 days) and rotate it.
  await create("agent-rw", "read-write");
  const old = await reveal();
  await old.dialog.getByRole("button", { name: "Done" }).click();
  const named = rows.filter({ hasText: "agent-rw" });
  await named.nth(0).waitFor();
  assert.ok(Math.abs((await span(named.nth(0))) - 90 * DAY) < 60_000);
  await named.nth(0).getByRole("button", { name: "Rotate agent-rw" }).click();
  const next = await reveal();
  assert.notEqual(next.token, old.token);
  await next.dialog.getByRole("button", { name: "Done" }).click();
  // Rotate confirms with one line naming the credential and what happens to the old one.
  const outcomes = panel.locator("[data-slot=action-outcome]");
  await outcomes
    .getByText(
      "Rotated agent-rw. The old credential stays active until you revoke it.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await outcomes.count(), 1);
  await named.nth(1).waitFor();
  assert.equal(await named.count(), 2);
  assert.match(await named.nth(1).innerText(), /Replaces\s*agent-rw \(/);
  for (const i of [0, 1])
    assert.match(await named.nth(i).innerText(), /Active/);
  assert.equal(await bearer(old.token), 200);
  assert.equal(await bearer(next.token), 200);

  // 5. Revoke the old credential through the confirmation dialog.
  await named.nth(0).getByRole("button", { name: "Revoke agent-rw" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke agent-rw?" });
  await confirm.waitFor();
  assert.match(await confirm.innerText(), /irreversible/i);
  assert.equal(
    await page.evaluate(
      () => !!document.activeElement?.closest("[role=dialog]"),
    ),
    true,
  );
  await confirm.getByRole("button", { name: "Revoke credential" }).click();
  await confirm.waitFor({ state: "detached" });
  // Revoke closes its dialog and leaves one success line on the panel.
  await outcomes.getByText("Revoked agent-rw.", { exact: true }).waitFor();
  assert.equal(await outcomes.count(), 1);
  await named.nth(0).getByText("Revoked", { exact: true }).first().waitFor();
  assert.match(await named.nth(1).innerText(), /Active/);
  assert.equal(await bearer(old.token), 401);
  assert.equal(await bearer(next.token), 200);
  for (const body of bodies)
    for (const token of [first.token, old.token, next.token])
      assert.equal(body.includes(token), false);
  await assertNoStoredToken(page, [first.token, old.token, next.token]);

  // 8. A refused request names the cause; the code is in Details, never in the message.
  const writes = "**/api/operator/credentials**";
  const postsBefore = () => posts.length;
  await page.route(writes, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "forbidden", message: "Refused" },
          }),
        })
      : route.fallback(),
  );
  await create("denied");
  const refused = outcomes.filter({ hasText: "Couldn't create" });
  await refused
    .getByText(
      "Couldn't create the credential: you don't have permission. Your entries are still here; we're reloading the list below.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await outcomes.count(), 1);
  assert.doesNotMatch(await refused.innerText(), /forbidden/);
  await refused.getByText("Details", { exact: true }).click();
  await refused.getByText("forbidden", { exact: true }).waitFor();
  assert.equal(
    await panel.getByLabel("Credential name").inputValue(),
    "denied",
  );
  await page.unroute(writes);

  // 9. An unconfirmed create or rotate offers Check the list, which re-reads and never resends.
  await page.route(writes, (route) =>
    route.request().method() === "POST" ? route.abort() : route.fallback(),
  );
  for (const act of [
    () => create("maybe"),
    () => named.nth(1).getByRole("button", { name: "Rotate agent-rw" }).click(),
  ]) {
    await act();
    const unknown = outcomes.filter({ hasText: "We couldn't confirm" });
    await unknown.waitFor();
    assert.equal(await outcomes.count(), 1);
    assert.equal(await unknown.getAttribute("data-tone"), "warning");
    assert.equal(await unknown.getByRole("button").count(), 1);
    const sentBefore = postsBefore();
    const reread = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        r.url().endsWith("/api/operator/credentials"),
    );
    await unknown.getByRole("button", { name: "Check the list" }).click();
    await reread;
    assert.equal(postsBefore(), sentBefore);
  }
  await page.unroute(writes);

  // 10. A refused revoke stays inside its dialog.
  await page.route(writes, (route) =>
    route.request().method() === "POST" || route.request().method() === "DELETE"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "forbidden", message: "Refused" },
          }),
        })
      : route.fallback(),
  );
  await named.nth(1).getByRole("button", { name: "Revoke agent-rw" }).click();
  const again = page.getByRole("dialog", { name: "Revoke agent-rw?" });
  await again.getByRole("button", { name: "Revoke credential" }).click();
  await again
    .getByText(
      "Couldn't revoke agent-rw: you don't have permission. We're reloading the list below.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await again.locator("[data-slot=action-outcome]").count(), 1);
  await page.unroute(writes);
  await again.getByRole("button", { name: "Cancel" }).click();
});

/** The token must not reach web storage or the URL. */
async function assertNoStoredToken(page: Page, tokens: string[]) {
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]),
  );
  for (const token of tokens) assert.equal(stored.includes(token), false);
}
