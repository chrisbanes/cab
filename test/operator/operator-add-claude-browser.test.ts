import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
import { tmpdir } from "../fixtures/temp.js";

const test = browserSuite("add-claude");
const CANARY = "add-claude-canary-token-8821";
const ENV_NAME = "ADD_CLAUDE_UNSET_VARIABLE_8821";
/** The commands the panel copies; the operations guide must carry the same lines. */
const claudeTokenSetup = [
  'mkdir -m 700 -p "$HOME/.ensemble/claude"',
  'install -m 600 /dev/null "$HOME/.ensemble/claude/claude-token"',
].join("\n");
/** Typed after copying the token: reads the clipboard, so it is never copied. */
const claudeTokenWrite = [
  'pbpaste > "$HOME/.ensemble/claude/claude-token"',
  "stat -f '%Su %Lp' \"$HOME/.ensemble/claude/claude-token\"",
].join("\n");
const CHECK = "/api/operator/readiness/claude-token";

function tokenFile(t: { after: (fn: () => void) => void }, mode = 0o600) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-add-claude-")),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o700);
  const path = join(directory, "claude-token");
  writeFileSync(path, `${CANARY}\n`, { mode });
  chmodSync(path, mode);
  return { directory, path };
}

async function open(
  journey: Parameters<typeof startSettings>[0],
  viewport: { width: number; height: number },
) {
  const started = await startSettings(
    journey,
    "/app/settings/runtime",
    viewport,
    undefined,
    {
      serviceOptions: {
        runtimeHarnesses: ["codex", "claude"],
        resolveExecutable: async () => true,
      },
    },
  );
  const panel = started.page.locator(".settings-panel", {
    has: started.page.getByRole("heading", { name: "Add Claude", exact: true }),
  });
  const row = panel.getByRole("region", { name: "Claude subscription token" });
  const readable = panel.getByRole("region", { name: "Token readable" });
  const checks: string[] = [];
  started.page.on("request", (r) => {
    if (new URL(r.url()).pathname === CHECK) checks.push(r.method());
  });
  return { ...started, panel, row, readable, checks };
}

const save = async (
  row: Awaited<ReturnType<typeof open>>["row"],
  reference: string,
) => {
  await row.getByRole("button", { name: /^(Set|Change)$/ }).click();
  await row.getByLabel("Claude token reference").fill(reference);
  await row.getByRole("button", { name: "Save reference" }).click();
};

test("Add Claude copies the runbook commands and checks a saved file: reference live", async (t, journey) => {
  const { directory, path } = tokenFile(t);
  const { f, page, panel, row, readable, checks } = await open(
    journey,
    desktop,
  );
  // Add Claude is the first panel of the runtime page's left column.
  assert.equal(
    await page
      .locator(".settings-column")
      .first()
      .locator(".settings-panel")
      .first()
      .getByRole("heading", { name: "Add Claude", exact: true })
      .count(),
    1,
  );
  await readable.getByText("Not configured", { exact: true }).waitFor();

  // Copy puts exactly the runbook text on the clipboard and shows one outcome.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  assert.equal(
    await panel.locator("pre.token-commands:not(.token-write)").innerText(),
    claudeTokenSetup,
  );
  assert.equal(
    await panel.locator("pre.token-write").innerText(),
    claudeTokenWrite,
  );
  await panel.getByRole("button", { name: "Copy commands" }).click();
  await panel.getByRole("status").filter({ hasText: "Copied" }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, claudeTokenSetup);
  // The copied block never reads the clipboard, so the token copied next stays intact.
  assert.doesNotMatch(
    copied,
    /pbpaste|pbcopy|wl-paste|xclip|xsel|Get-Clipboard|clipboard/i,
  );
  for (const line of claudeTokenWrite.split("\n"))
    assert.equal(copied.includes(line), false, line);
  assert.equal(
    await panel.getByRole("status").filter({ hasText: "Copied" }).count(),
    1,
  );
  // The operations guide carries the same commands.
  const guide = readFileSync(
    join(import.meta.dirname, "../../../docs/operations/standalone-macos.md"),
    "utf8",
  );
  for (const line of [
    ...claudeTokenSetup.split("\n"),
    ...claudeTokenWrite.split("\n"),
  ])
    assert.ok(guide.includes(line), line);

  // Saving a safe file shows Pass without a reload and re-checks exactly once.
  const before = checks.length;
  await save(row, `file:${path}`);
  await readable.getByText("Pass", { exact: true }).waitFor();
  assert.equal(checks.length - before, 1);
  assert.equal(f.service.domain().claudeTokenReference(), `file:${path}`);

  // An unsafe file fails without naming the path or value.
  chmodSync(path, 0o644);
  await page.reload();
  const again = page.locator(".settings-panel", {
    has: page.getByRole("heading", { name: "Add Claude", exact: true }),
  });
  const failing = again.getByRole("region", { name: "Token readable" });
  await failing.getByText("Fail", { exact: true }).waitFor();
  await failing.getByText("Token file permits group or other access").waitFor();
  const text = await page.locator("body").innerText();
  for (const secret of [CANARY, path, directory])
    assert.equal(text.includes(secret), false, secret);

  // Clear is the existing row's: the reference goes and the check is Not configured.
  const clearRow = again.getByRole("region", {
    name: "Claude subscription token",
  });
  await clearRow.getByRole("button", { name: "Change", exact: true }).click();
  await clearRow.getByRole("button", { name: "Clear reference" }).click();
  await failing.getByText("Not configured", { exact: true }).waitFor();
  assert.equal(f.service.domain().claudeTokenReference(), null);
  await captureBrowserEvidence(page, "1366-settings-add-claude");
});

test("Add Claude fails an unset env: reference without naming the variable, and fits a phone", async (_t, journey) => {
  const { page, row, readable } = await open(journey, phone);
  delete process.env[ENV_NAME];
  await save(row, `env:${ENV_NAME}`);
  await readable.getByText("Fail", { exact: true }).waitFor();
  await readable.getByText("Token variable is unavailable").waitFor();
  assert.equal(
    (await page.locator("body").innerText()).includes(ENV_NAME),
    false,
  );
  await noPageOverflow(page);
  await captureBrowserEvidence(page, "390-settings-add-claude");
});

test("Token readable shows Checking while pending and never a stale result after a failed check", async (_t, journey) => {
  const { page, readable, row } = await open(journey, phone);
  await readable.getByText("Not configured", { exact: true }).waitFor();
  const badge = readable.getByText(/^(Pass|Fail|Not configured)$/);

  // Pending: the earlier badge is not presented as current.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/operator/readiness/claude-token", async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable", message: "x" } }),
    });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await readable.getByText("Checking…").waitFor();
  assert.equal(await badge.count(), 0);

  // A failed check says so and shows no badge.
  release();
  await readable.getByText("The check is unavailable.").waitFor();
  assert.equal(await badge.count(), 0);

  // The next successful check shows the result again, with its fix line when not a pass.
  await page.unroute("**/api/operator/readiness/claude-token");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await readable.getByText("Not configured", { exact: true }).waitFor();
  await readable
    .getByText("Add a Claude token in Settings → Add Claude")
    .waitFor();
  void row;
});
