import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
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
  unpairedBadges,
} from "../fixtures/operator-settings.js";
import { commandRequest } from "../fixtures/setup-browser.js";
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

/** A temp home folder whose name has a space and non-ASCII text; no test reads the runner's real home. */
function tempHome(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ensemble-add-claude-home-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "Home Folder ünï");
  mkdirSync(home);
  return home;
}

async function open(
  t: { after: (fn: () => void) => void },
  journey: Parameters<typeof startSettings>[0],
  viewport: { width: number; height: number },
  home = tempHome(t),
) {
  const started = await startSettings(
    journey,
    "/app/settings/runtime",
    viewport,
    undefined,
    {
      setup: { home },
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
  return { ...started, home, panel, row, readable, checks };
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
    t,
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
  assert.deepEqual(await unpairedBadges(readable), []);

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

test("Add Claude fails an unset env: reference without naming the variable, and fits a phone", async (t, journey) => {
  const { page, row, readable } = await open(t, journey, phone);
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

test("Token readable shows Checking while pending and never a stale result after a failed check", async (t, journey) => {
  const { page, readable, row } = await open(t, journey, phone);
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

const HOME_READ = "**/api/operator/setup/home";
const SUGGESTED = "/.ensemble/claude/claude-token";
const FIELD = "Claude token reference";
const SAVE = "Save reference";
const SET = { name: "Set", exact: true } as const;
const NOT_CONFIGURED = "Claude subscription token · not configured";
type Started = Awaited<ReturnType<typeof open>>;
/** The command posts the page sends. */
const commands = (page: Started["page"]) => {
  const sent: { credentialRef: unknown }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/operator/commands"))
      sent.push(r.postData() ? r.postDataJSON() : {});
  });
  return sent;
};
const activeLabel = (page: Started["page"]) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

/**
 * Opens the reference form with Set once the service home has been read. The read is shown
 * nowhere, so the page tells us it has landed only by prefilling: Set again until it does.
 * Each pass reads the page's own state, so no frame count or delay decides the outcome.
 */
async function setPrefilled(row: Started["row"]) {
  const input = row.getByLabel(FIELD);
  for (let attempt = 0; attempt < 100; attempt++) {
    await row.getByRole("button", SET).click();
    if ((await input.inputValue()) !== "") return input;
    await row.getByRole("button", { name: "Cancel" }).click();
  }
  throw new Error("The home read never prefilled the reference.");
}

/** Lets the page run what the answered request queued, so a "nothing changed" check is not early. */
const settled = (page: Started["page"]) =>
  page.evaluate(async () => {
    for (let hop = 0; hop < 3; hop++)
      await new Promise<void>((done) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => done();
        channel.port2.postMessage(0);
      });
  });

/**
 * Answers the home read only when `release` is called. Release is idempotent and runs again
 * in `finally`, so a failing test never leaves the handler waiting.
 */
async function heldHomeRead(page: Started["page"]) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(HOME_READ, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  return release;
}

test("Add Claude prefills the token reference when none is set and Set sends it exactly", async (t, journey) => {
  const { f, home, page, row, readable } = await open(t, journey, desktop);
  await row.getByText(NOT_CONFIGURED).waitFor();
  const expected = `file:${home}${SUGGESTED}`;
  const input = await setPrefilled(row);
  assert.equal(await input.inputValue(), expected);
  const request = commandRequest(page);
  await row.getByRole("button", { name: SAVE }).click();
  assert.equal((await request).postDataJSON().credentialRef, expected);
  await readable.getByText("Fail", { exact: true }).waitFor();
  await readable.getByText("Token file is missing").waitFor();
  assert.equal(f.service.domain().claudeTokenReference(), expected);
  const text = await page.locator("body").innerText();
  assert.equal(text.includes(home), false);
});

test("Add Claude never prefills over a configured reference", async (t, journey) => {
  const { f, page, row } = await open(t, journey, desktop);
  f.service.domain().execute({
    type: "claude-token.configure",
    actor: "operator",
    key: crypto.randomUUID(),
    credentialRef: "env:FIXTURE_CONFIGURED_REFERENCE_4417",
  });
  await page.reload();
  await row.getByText(/reference configured/).waitFor();
  await row.getByRole("button", { name: "Change", exact: true }).click();
  const input = row.getByLabel(FIELD);
  assert.equal(await input.inputValue(), "");
  assert.equal(
    (await page.locator("body").innerText()).includes(
      "FIXTURE_CONFIGURED_REFERENCE_4417",
    ),
    false,
  );
  await row.getByRole("button", { name: "Clear reference" }).click();
  await row.getByText(NOT_CONFIGURED).waitFor();
  assert.match(
    await (await setPrefilled(row)).inputValue(),
    /^file:.*\/\.ensemble\/claude\/claude-token$/,
  );
});

test("Add Claude keeps a typed reference over a late home read", async (t, journey) => {
  const { page, row } = await open(t, journey, desktop);
  const release = await heldHomeRead(page);
  try {
    await page.reload();
    await row.getByText(NOT_CONFIGURED).waitFor();
    await row.getByRole("button", SET).click();
    const input = row.getByLabel(FIELD);
    assert.equal(await input.inputValue(), "");
    await input.fill("file:/x/claude-token");
    await input.focus();
    const answered = page.waitForResponse((r) =>
      r.url().endsWith("/setup/home"),
    );
    release();
    await answered;
    await settled(page);
    assert.equal(await input.inputValue(), "file:/x/claude-token");
    assert.equal(await activeLabel(page), FIELD);
    const request = commandRequest(page);
    await row.getByRole("button", { name: SAVE }).click();
    assert.equal(
      (await request).postDataJSON().credentialRef,
      "file:/x/claude-token",
    );
  } finally {
    release();
  }
});

test("Add Claude leaves an open empty field empty when the home read lands late", async (t, journey) => {
  const { page, row } = await open(t, journey, desktop);
  const release = await heldHomeRead(page);
  try {
    await page.reload();
    await row.getByText(NOT_CONFIGURED).waitFor();
    await row.getByRole("button", SET).click();
    const input = row.getByLabel(FIELD);
    await input.focus();
    const answered = page.waitForResponse((r) =>
      r.url().endsWith("/setup/home"),
    );
    release();
    await answered;
    await settled(page);
    assert.equal(await input.inputValue(), "");
    assert.equal(await activeLabel(page), FIELD);
    // The next open, with the home known, is prefilled.
    await row.getByRole("button", { name: "Cancel" }).click();
    assert.match(
      await (await setPrefilled(row)).inputValue(),
      /^file:\/.*\.ensemble\/claude\/claude-token$/,
    );
  } finally {
    release();
  }
});

test("Add Claude refuses ~ and $HOME with the expanded form", async (t, journey) => {
  const { f, home, page, row } = await open(t, journey, desktop);
  const sent = commands(page);
  // The prefill shows the home has been read, which the message offering it needs.
  const input = await setPrefilled(row);
  for (const [typed, rest] of [
    [`~${SUGGESTED}`, SUGGESTED],
    [`file:~${SUGGESTED}`, SUGGESTED],
    [`$HOME${SUGGESTED}`, SUGGESTED],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text an operator types.
    ["file:${HOME}/t", "/t"],
  ] as const) {
    await input.fill(typed);
    await row.getByRole("button", { name: SAVE }).click();
    const message = `Use the full path: file:${home}${rest}. ~ and $HOME are not expanded.`;
    const alert = row.getByRole("alert").filter({ hasText: message });
    await alert.waitFor();
    await page.waitForFunction(
      (label) => document.activeElement?.getAttribute("aria-label") === label,
      FIELD,
    );
    // The message is tied to the field it refuses.
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    const described = await input.getAttribute("aria-describedby");
    assert.equal(
      await page.locator(`[id="${described}"]`).innerText(),
      message,
    );
    assert.equal(sent.length, 0, typed);
  }
  const offered = `file:${home}${SUGGESTED}`;
  await input.fill(offered);
  const request = commandRequest(page);
  await row.getByRole("button", { name: SAVE }).click();
  assert.equal((await request).postDataJSON().credentialRef, offered);
  // The request is only sent; the row confirms the save has been recorded.
  await row.getByText(/reference configured/).waitFor();
  assert.equal(f.service.domain().claudeTokenReference(), offered);
});

for (const [label, answer] of [
  [
    "missing",
    { status: 404, body: { error: { code: "not-found", message: "x" } } },
  ],
  [
    "unavailable",
    { status: 503, body: { error: { code: "unavailable", message: "x" } } },
  ],
  ["unreadable", { status: 200, body: { data: { home: 5 }, observedAt: 1 } }],
] as const)
  test(`Add Claude falls back to an empty field when the home read is ${label}`, async (t, journey) => {
    const { path } = tokenFile(t);
    const { f, page, row } = await open(t, journey, desktop);
    let answeredRead: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answeredRead = resolve;
    });
    await page.route(HOME_READ, async (route) => {
      await route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify(answer.body),
      });
      answeredRead();
    });
    await page.reload();
    await answered;
    await settled(page);
    const sent = commands(page);
    await row.getByText(NOT_CONFIGURED).waitFor();
    await row.getByRole("button", SET).click();
    const input = row.getByLabel(FIELD);
    assert.equal(await input.inputValue(), "");
    assert.equal(await row.getByRole("alert").count(), 0);
    await input.fill("~/x");
    await row.getByRole("button", { name: SAVE }).click();
    await row
      .getByText(
        "Use the full path: replace ~ or $HOME with your home folder's absolute path.",
      )
      .waitFor();
    assert.equal(sent.length, 0);
    await input.fill(`file:${path}`);
    const request = commandRequest(page);
    await row.getByRole("button", { name: SAVE }).click();
    assert.equal((await request).postDataJSON().credentialRef, `file:${path}`);
    await row.getByText(/reference configured/).waitFor();
    assert.equal(f.service.domain().claudeTokenReference(), `file:${path}`);
  });

test("Add Claude discards the prefill on Cancel and re-derives it on the next Set", async (t, journey) => {
  const { f, home, page, row } = await open(t, journey, desktop);
  const sent = commands(page);
  const input = await setPrefilled(row);
  assert.equal(await input.inputValue(), `file:${home}${SUGGESTED}`);
  await row.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await input.count(), 0);
  assert.equal(sent.length, 0);
  assert.equal(f.service.domain().claudeTokenReference(), null);
  await row.getByRole("button", SET).click();
  assert.equal(await input.inputValue(), `file:${home}${SUGGESTED}`);
  await input.fill("env:NAME");
  assert.equal(await input.inputValue(), "env:NAME");
  // Cancelling after an edit also leaves nothing behind.
  await row.getByRole("button", { name: "Cancel" }).click();
  await row.getByRole("button", SET).click();
  assert.equal(await input.inputValue(), `file:${home}${SUGGESTED}`);
});

test("the home path stays out of the URL, requests and browser storage", async (t, journey) => {
  const { home, page, row } = await open(t, journey, desktop);
  const urls: string[] = [];
  const posts: string[] = [];
  const bodies: string[] = [];
  page.on("request", (r) => {
    urls.push(r.url());
    if (!r.url().endsWith("/api/operator/commands") && r.postData())
      posts.push(r.postData() ?? "");
  });
  // Read each answer here, before the page receives it, so no body is left to read later.
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/operator/setup/home") return route.continue();
    try {
      const response = await route.fetch();
      bodies.push(`${path} ${await response.text()}`);
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  await page.reload();
  const input = await setPrefilled(row);
  assert.ok((await input.inputValue()).includes(home));
  await input.fill(`~${SUGGESTED}`);
  await row.getByRole("button", { name: SAVE }).click();
  await row
    .getByRole("alert")
    .filter({ hasText: "Use the full path" })
    .waitFor();
  const request = commandRequest(page);
  await input.fill(`file:${home}${SUGGESTED}`);
  await row.getByRole("button", { name: SAVE }).click();
  await request;
  await row.getByText(/reference configured/).waitFor();
  assert.ok(bodies.some((b) => b.startsWith("/api/operator/claude-token ")));
  const forms = [home, encodeURIComponent(home), encodeURI(home)];
  for (const form of forms) {
    assert.equal(page.url().includes(form), false);
    assert.deepEqual(
      urls.filter((u) => u.includes(form)),
      [],
    );
    assert.deepEqual(
      posts.filter((b) => b.includes(form)),
      [],
    );
    assert.deepEqual(
      bodies.filter((b) => b.includes(form)),
      [],
    );
  }
  const stored = await page.evaluate(() =>
    JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
    ]),
  );
  assert.equal(stored.includes(home), false);
});
