import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserSuite,
  captureBrowserEvidence,
  type BrowserJourney,
} from "../fixtures/browser-diagnostics.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { openTaskTab } from "../fixtures/task-tabs.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const test = browserSuite("operator-files-browser");

function pdf(pageCount: number, pageWidth: number, pageHeight: number) {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from(
      { length: pageCount },
      (_, index) => `${3 + index} 0 R`,
    ).join(" ")}] /Count ${pageCount} >>`,
  ];
  const contentIds = Array.from(
    { length: pageCount },
    (_, index) => 3 + pageCount + index,
  );
  for (let page = 0; page < pageCount; page++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << >> /Contents ${contentIds[page]} 0 R >>`,
    );
  for (let page = 0; page < pageCount; page++) {
    const content =
      page === 0 ? `${"0 0 1 1 re f\n".repeat(60_000)}\n` : `0 0 1 1 re f\n`;
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }

  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const crossReferenceOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF`;
  return Buffer.from(source);
}

function pngImage(width = 1, height = 1) {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name, "ascii");
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    type.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const offset = row + 1 + x * 4;
      rows[offset] = (x + y) % 256;
      rows[offset + 1] = (x * 3 + y) % 256;
      rows[offset + 2] = (x + y * 5) % 256;
      rows[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sourceRepository(
  root: string,
  name: string,
  files: Record<string, string>,
) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.name",
    "Files Browser Test",
  ]);
  execFileSync("git", [
    "-C",
    path,
    "config",
    "user.email",
    "files-browser@example.invalid",
  ]);
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(path, relativePath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-C", path, "add", ".gitignore", ...Object.keys(files)]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "Files fixture"]);
  return path;
}

/** The Workspace crumb of whichever location trail is on screen: the explorer's, or the open file's on a phone. */
const workspaceRoot = (page: Page) =>
  page
    .getByRole("tabpanel", { name: "Files" })
    .getByRole("button", { name: "Workspace", exact: true })
    .first();

const focusedEntry = (page: Page) =>
  page.evaluate(() => document.activeElement?.classList.contains("file-entry"));

function guideMarkdown(version: string) {
  const longBody = Array.from(
    { length: 72 },
    (_, index) => `Generated detail ${index + 1}: ${version}.`,
  ).join("\n\n");
  return `# Alpha Guide\n\n## Current ${version}\n\nA **bold** and \`inline-code\` example.\n\n- alpha\n  - nested item\n- beta\n\n| Name | Value |\n| --- | --- |\n| mode | ${version} |\n\n[external link](https://example.invalid/private)\n\n![remote image](https://example.invalid/remote.png)\n\n<script>window.filePreviewInjected = true</script>\n\n<img src="https://example.invalid/raw.png" onerror="window.filePreviewInjected = true">\n\n[unsafe link](javascript:window.filePreviewInjected = true)\n\n${longBody}\n`;
}

test("production Files reads service PDF bytes and bounds page, canvas and cancellation behavior on phone", async (_t, j) => {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const task = await seedReviewTask(fixture, "Files preview test");
  const binding = await fixture.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  const bytes = pdf(12, 1000, 60_000);
  const rasterBytes = pngImage();
  writeFileSync(join(binding.path, "oversized-12-pages.pdf"), bytes);
  writeFileSync(join(binding.path, "sample.png"), rasterBytes);
  writeFileSync(
    join(binding.path, "literal.txt"),
    "<script>window.filePreviewInjected = true</script>",
  );
  const web = await j.start("fixture.web", () => fixture.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  await page.clock.install();

  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const workerUrls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== web.origin)
      externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("worker", (worker) => workerUrls.push(worker.url()));

  const appResponse = await page.goto(
    `${web.origin}/app/tasks/${task.taskId}?section=files`,
  );
  const policy = appResponse?.headers()["content-security-policy"] ?? "";
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /img-src 'self' data:/);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();

  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/operator/tasks/${task.taskId}/preview?`),
  );
  const pdfButton = page.getByRole("button", {
    name: /oversized-12-pages\.pdf/,
  });
  await pdfButton.focus();
  await page.keyboard.press("Enter");
  const serviceResponse = await responsePromise;
  assert.equal(serviceResponse.status(), 200);
  const payload = (await serviceResponse.json()) as {
    data: {
      state: string;
      preview: {
        mime: string;
        data: string;
        size: number;
        sha256: string;
        maxDisplayedPages: number;
        maxCanvasPixels: number;
      };
    };
  };
  assert.equal(payload.data.state, "ready");
  assert.equal(payload.data.preview.mime, "application/pdf");
  assert.equal(payload.data.preview.data, bytes.toString("base64"));
  assert.equal(payload.data.preview.size, bytes.byteLength);
  assert.equal(
    payload.data.preview.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(payload.data.preview.maxDisplayedPages, 10);
  assert.equal(payload.data.preview.maxCanvasPixels, 16_000_000);

  const pageOneCanvas = page.locator('canvas[aria-label="PDF page 1"]');
  await pageOneCanvas.waitFor();
  assert.equal(
    await pageOneCanvas.getAttribute("data-render-state"),
    "pending",
  );
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.locator('canvas[aria-label="PDF page 2"]').waitFor();
  await page
    .locator('canvas[aria-label="PDF page 2"][data-render-state="ready"]')
    .waitFor();
  assert.equal(await page.locator("canvas").count(), 1);

  await page
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  for (let zoom = 0; zoom < 4; zoom++)
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page
    .locator('canvas[aria-label="PDF page 1"][data-render-state="ready"]')
    .waitFor();
  const dimensions = await page.locator("canvas").evaluateAll((canvases) =>
    canvases.map((element) => {
      const canvas = element as HTMLCanvasElement;
      return {
        pixels: canvas.width * canvas.height,
        max: Number(canvas.dataset.maxCanvasPixels),
        page: Number(canvas.dataset.pageNumber),
      };
    }),
  );
  assert.equal(dimensions.length, 1);
  assert.equal(dimensions[0]?.page, 1);
  assert.ok(dimensions[0]!.pixels <= dimensions[0]!.max);
  assert.ok(dimensions[0]!.max <= payload.data.preview.maxCanvasPixels);
  // The scaled-render notice replaces "Rendering page…" once the canvas settles.
  await page
    .locator(".pdf-preview")
    .getByText(/scaled down to stay within the 16,000,000-pixel preview cap/)
    .waitFor();

  await page.getByRole("button", { name: "Next page", exact: true }).click();
  for (let pageNumber = 3; pageNumber <= 10; pageNumber++)
    await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page
    .locator('canvas[aria-label="PDF page 10"][data-render-state="ready"]')
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Next page", exact: true })
      .isDisabled(),
    true,
  );
  await captureBrowserEvidence(page, "390-bounded-pdf-preview", {
    fullPage: false,
  });

  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  // Back restores focus in a later animation frame; wait for it so it cannot
  // steal focus from the entry opened next.
  await page
    .getByRole("button", { name: /oversized-12-pages\.pdf/ })
    .and(page.locator(":focus"))
    .waitFor();
  await page.getByRole("button", { name: /literal\.txt/ }).focus();
  await page.keyboard.press("Space");
  await page
    .getByText("<script>window.filePreviewInjected = true</script>", {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(await page.locator(".file-line-text").allTextContents(), [
    "<script>window.filePreviewInjected = true</script>",
  ]);
  assert.equal(await page.locator("canvas").count(), 0);
  assert.equal(
    await page.evaluate(
      () =>
        (window as Window & { filePreviewInjected?: boolean })
          .filePreviewInjected,
    ),
    undefined,
  );
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  await page
    .getByRole("button", { name: /literal\.txt/ })
    .and(page.locator(":focus"))
    .waitFor();
  const imageButton = page.getByRole("button", { name: /sample\.png/ });
  await imageButton.focus();
  await page.keyboard.press("Enter");
  const image = page.locator(".file-image-preview");
  await image.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>(".file-image-preview")
        ?.naturalWidth === 1,
  );
  assert.equal(
    await image.evaluate(
      (element) => (element as HTMLImageElement).naturalHeight,
    ),
    1,
  );
  assert.equal(
    await page.locator("a[download], object, embed, iframe").count(),
    0,
  );
  assert.ok(workerUrls.some((url) => url.includes("pdf.worker")));
  assert.ok(workerUrls.every((url) => new URL(url).origin === web.origin));
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(consoleErrors, []);
});

test("production Files keeps scoped previews stable, inert and navigable across repositories on phone and desktop", async (_t, j) => {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );

  const longName =
    "this-is-a-very-long-generated-guide-name-that-must-stay-on-one-line-and-disclose-its-full-path.md";
  const alphaSource = sourceRepository(
    join(fixture.directory, "sources"),
    "alpha",
    {
      "guide.md": guideMarkdown("stable"),
      "gone.txt": "This file will be removed after its first preview.\n",
      "docs/child.txt": "Arrow key folder child.\n",
      "example.ts": 'export const answer = 42;\nconsole.log("source only");\n',
      "unsafe.svg":
        "<svg><script>window.filePreviewInjected = true</script></svg>\n",
      [longName]: "long filename fixture\n",
    },
  );
  const betaSource = sourceRepository(
    join(fixture.directory, "sources"),
    "beta",
    {
      "beta.txt": "BETA_ONLY repository content\n",
    },
  );
  const task = await seedReviewTask(
    fixture,
    "Files repository scopes",
    "Inspect repository previews",
    "Verify exact scoped read-only content",
    [
      { repositoryId: "alpha", path: alphaSource },
      { repositoryId: "beta", path: betaSource },
    ],
  );
  const binding = await fixture.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  const alpha = binding.repositories.find(
    (repository) => repository.repositoryId === "alpha",
  );
  const beta = binding.repositories.find(
    (repository) => repository.repositoryId === "beta",
  );
  assert.ok(alpha);
  assert.ok(beta);
  const alphaGuide = join(alpha.workspacePath, "guide.md");
  const controlFile = join(alpha.workspacePath, "credentials.txt");
  writeFileSync(
    join(alpha.workspacePath, "hidden.log"),
    "VISIBLE_IGNORED_FIXTURE\n",
  );
  writeFileSync(controlFile, "DUMMY_CONTROL_PATH_VALUE\n");
  writeFileSync(
    join(alpha.workspacePath, "overview.png"),
    pngImage(1600, 1000),
  );

  const web = await j.start("fixture.web", () =>
    fixture.startWeb([fixture.directory, controlFile]),
  );
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  j.observe(page);
  page.setDefaultTimeout(15_000);

  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const expected503ConsoleErrors: Array<{
    text: string;
    url: string;
    observedAt: number;
  }> = [];
  const previewPaths: string[] = [];
  let expected503Window = false;
  let controlledFailureUrl: string | null = null;
  let expected503WindowStartedAt = 0;
  let expected503WindowEndedAt = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== web.origin) externalRequests.push(request.url());
    if (url.pathname.endsWith("/preview"))
      previewPaths.push(url.searchParams.get("path") ?? "");
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    if (expected503Window && /\b503\b/.test(message.text()))
      expected503ConsoleErrors.push({
        text: message.text(),
        url: location.url,
        observedAt: Date.now(),
      });
    else consoleErrors.push(message.text());
  });

  const appResponse = await page.goto(
    `${web.origin}/app/tasks/${task.taskId}?section=files`,
  );
  assert.match(
    appResponse?.headers()["content-security-policy"] ?? "",
    /img-src 'self' data:/,
  );
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();

  // With no link or open tab, the explorer opens at a repository root without a click
  // and without moving focus; the workspace row is one navigation away.
  const openedList = page.getByRole("list", { name: /^Files in Repository / });
  await openedList.waitFor();
  assert.match(
    (await openedList.getAttribute("aria-label")) ?? "",
    /^Files in Repository (alpha|beta)$/,
  );
  assert.equal(
    await page
      .getByRole("button", { name: /, repository, full path / })
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.classList.contains("file-entry"),
    ),
    false,
  );
  await workspaceRoot(page).click();
  const alphaRootButton = page.getByRole("button", {
    name: /alpha, repository, full path Repository alpha/,
  });
  await alphaRootButton.waitFor();
  assert.equal(await alphaRootButton.count(), 1);
  assert.equal(
    await alphaRootButton.evaluate((element) =>
      Math.round(element.getBoundingClientRect().height),
    ),
    44,
  );
  await alphaRootButton.focus();
  await page.keyboard.press("ArrowRight");
  const guideButton = page.getByRole("button", { name: /guide\.md/ });
  await guideButton.waitFor();
  // The navigation moves focus to the first entry a frame after the listing renders.
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("file-entry"),
  );
  const explorerLabels = await page
    .locator(".file-entry")
    .evaluateAll((entries) =>
      entries.map((entry) => entry.getAttribute("aria-label")),
    );
  const guideIndex = explorerLabels.findIndex((label) =>
    label?.includes("guide.md"),
  );
  assert.ok(guideIndex >= 0 && guideIndex + 1 < explorerLabels.length);
  await guideButton.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    (expected) =>
      document.activeElement?.getAttribute("aria-label") === expected,
    explorerLabels[guideIndex + 1],
  );
  const docsButton = page.getByRole("button", { name: /docs, directory/ });
  await docsButton.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: /child\.txt/ }).waitFor();
  // Focus moves into the folder a frame later; ArrowLeft before that is lost.
  await page.waitForFunction(() =>
    document.activeElement?.getAttribute("aria-label")?.includes("child.txt"),
  );
  await page.keyboard.press("ArrowLeft");
  await docsButton.waitFor();
  await page.waitForFunction(() =>
    document.activeElement
      ?.getAttribute("aria-label")
      ?.includes("docs, directory"),
  );
  await page.keyboard.press("ArrowLeft");
  await alphaRootButton.waitFor();
  await page.waitForFunction(() =>
    document.activeElement
      ?.getAttribute("aria-label")
      ?.includes("full path Repository alpha"),
  );
  await page.keyboard.press("ArrowRight");
  await guideButton.waitFor();
  assert.equal(
    await page.getByRole("button", { name: /hidden\.log/ }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: /credentials\.txt/ }).count(),
    0,
  );
  const longEntry = page.getByRole("button", { name: new RegExp(longName) });
  assert.equal(
    await longEntry.getAttribute("title"),
    `Repository alpha/${longName}`,
  );
  const longNameStyle = await longEntry
    .locator(".file-entry-name")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow };
    });
  assert.deepEqual(longNameStyle, {
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  });

  const stableGuide = guideMarkdown("stable");
  const stableHash = createHash("sha256").update(stableGuide).digest("hex");
  const firstGuideResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "guide.md"
    );
  });
  await guideButton.click();
  const firstGuidePayload = (await (await firstGuideResponse).json()) as {
    data: {
      state: string;
      preview?: { kind: string; text?: string; sha256?: string };
    };
  };
  assert.equal(firstGuidePayload.data.state, "ready");
  assert.equal(firstGuidePayload.data.preview?.kind, "text");
  assert.equal(firstGuidePayload.data.preview?.text, stableGuide);
  assert.equal(firstGuidePayload.data.preview?.sha256, stableHash);
  await page
    .getByRole("heading", { name: "Alpha Guide", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Current stable", exact: true })
    .waitFor();
  assert.equal(await page.locator(".file-markdown strong").innerText(), "bold");
  assert.equal(
    await page.locator(".file-markdown code").innerText(),
    "inline-code",
  );
  assert.equal(await page.locator(".file-markdown ul ul").count(), 1);
  assert.equal(await page.locator(".file-markdown table tbody tr").count(), 1);
  assert.equal(
    await page
      .locator(".file-markdown a, .file-markdown img, .file-markdown script")
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(
      () =>
        (window as Window & { filePreviewInjected?: boolean })
          .filePreviewInjected,
    ),
    undefined,
  );
  assert.equal(
    await page.getByRole("link", { name: /external link|unsafe link/ }).count(),
    0,
  );
  // One header line; hash and read times wait in a collapsed disclosure.
  const header = page.locator(".file-header");
  assert.match(
    await header.locator(".file-header-line").innerText(),
    /^guide\.md · text\/markdown · [\d,]+ bytes · \d{2}:\d{2}$/,
  );
  const provenance = header.locator("details.file-provenance");
  assert.equal(await provenance.getAttribute("open"), null);
  await provenance
    .locator("summary")
    .getByText("Provenance & limits", { exact: true })
    .click();
  assert.deepEqual(await provenance.locator("dt").allTextContents(), [
    "Location",
    "Listing observed",
    "File read",
    "SHA-256",
  ]);
  assert.equal(
    await provenance.locator("dd").first().innerText(),
    "Repository alpha/guide.md",
  );
  assert.equal(await provenance.locator("dd").last().innerText(), stableHash);
  assert.equal(await page.getByText("Source view").count(), 0);
  assert.equal(await page.getByText("Full path", { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Source", exact: true }).click();
  const wrapButton = page.getByRole("button", { name: "Wrap", exact: true });
  assert.equal(await wrapButton.getAttribute("aria-pressed"), "false");
  await wrapButton.click();
  assert.equal(await wrapButton.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".file-source-scroll.is-wrapped").count(), 1);
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    stableGuide.replace(/\n$/, "").split("\n"),
  );
  const stableLine = page.getByRole("button", {
    name: "Line 3: ## Current stable",
  });
  await stableLine.click();
  assert.equal(await stableLine.getAttribute("aria-pressed"), "true");

  // Phone range selection without Shift: labelled 44px Start/End controls.
  const setStart = page.getByRole("button", { name: "Set start", exact: true });
  const setEnd = page.getByRole("button", { name: "Set end", exact: true });
  for (const control of [setStart, setEnd])
    assert.ok(
      (await control.evaluate(
        (element) => element.getBoundingClientRect().height,
      )) >= 44,
    );
  await setStart.click();
  await page.getByText("Edge fixed at line 3.", { exact: false }).waitFor();
  assert.equal(await setStart.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: /^Line 5: A \*\*bold\*\*/ }).click();
  await setEnd.click();
  await page.getByText("Selected lines 3–5", { exact: true }).waitFor();
  for (const [name, pressed] of [
    [/^Line 2 \(blank\)/, "false"],
    [/^Line 3:/, "true"],
    [/^Line 4 \(blank\)/, "true"],
    [/^Line 5:/, "true"],
    [/^Line 6 \(blank\)/, "false"],
  ] as const)
    assert.equal(
      await page.getByRole("button", { name }).getAttribute("aria-pressed"),
      pressed,
    );
  // The composer returns focus to the selected line of this origin only.
  const returnTargets = await page
    .locator('[data-review-return^="files:"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")),
    );
  assert.equal(returnTargets.length, 1);
  assert.match(returnTargets[0] ?? "", /^Line 5: A \*\*bold\*\*/);
  // Ending the range returns to ordinary selection: a plain tap replaces it.
  await page.getByRole("button", { name: /^Line 5:/ }).click();
  await page.getByText("Selected lines 5–5", { exact: true }).waitFor();
  await stableLine.click();
  await page.getByText("Selected lines 3–3", { exact: true }).waitFor();
  await captureBrowserEvidence(page, "390-files-range-controls-phone", {
    fullPage: false,
  });
  const previewScroll = page.locator(".file-preview-scroll");
  await previewScroll.evaluate((element) => element.scrollTo(0, 500));
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-preview-scroll")?.scrollTop ?? 0) >= 450,
  );
  await captureBrowserEvidence(page, "390-files-markdown-source-phone", {
    fullPage: false,
  });
  assert.equal(await page.locator(".file-rail").isVisible(), false);
  assert.equal(await page.locator(".file-reading-area").isVisible(), true);
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  assert.equal(await page.locator(".file-rail").isVisible(), true);
  assert.equal(await page.locator(".file-reading-area").isVisible(), false);
  await page.getByRole("button", { name: /guide\.md/ }).click();
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-preview-scroll")?.scrollTop ?? 0) >= 450,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current stable" })
      .getAttribute("aria-pressed"),
    "true",
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(
    Math.round((await page.locator(".file-rail").boundingBox())?.width ?? 0),
    238,
  );
  await page.getByRole("toolbar", { name: "Open file tabs" }).waitFor();
  await page.getByRole("navigation", { name: "File path" }).waitFor();
  await captureBrowserEvidence(page, "1280-files-workbench-desktop", {
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  const refreshedGuide = guideMarkdown("refreshed");
  const refreshedHash = createHash("sha256")
    .update(refreshedGuide)
    .digest("hex");
  const firstGuideReads = previewPaths.filter(
    (path) => path === "guide.md",
  ).length;
  writeFileSync(alphaGuide, refreshedGuide);
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current stable" })
      .count(),
    1,
  );
  assert.equal(
    previewPaths.filter((path) => path === "guide.md").length,
    firstGuideReads,
  );
  assert.equal(
    await page.locator(".file-provenance dd").last().textContent(),
    stableHash,
  );
  const refreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "guide.md"
    );
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const refreshedPayload = (await (await refreshResponse).json()) as {
    data: { state: string; preview?: { text?: string; sha256?: string } };
  };
  assert.equal(refreshedPayload.data.state, "ready");
  assert.equal(refreshedPayload.data.preview?.text, refreshedGuide);
  assert.equal(refreshedPayload.data.preview?.sha256, refreshedHash);
  await page
    .getByRole("button", { name: "Line 3: ## Current refreshed" })
    .waitFor();
  assert.equal(
    await page.locator(".file-change-notice").innerText(),
    "Changed since you last looked. Earlier comments stay on the version they selected.",
  );
  // The hashes moved into the notice's Details instead of the message.
  // Read without opening it: expanding would scroll the reading position under test.
  const changeDetails = page
    .getByRole("tabpanel", { name: "Files" })
    .locator(".action-outcome-details");
  assert.equal(await changeDetails.locator("summary").innerText(), "Details");
  assert.deepEqual(await changeDetails.locator("dd").allTextContents(), [
    stableHash,
    refreshedHash,
  ]);

  const latestGuide = guideMarkdown("latest-unobserved");
  writeFileSync(alphaGuide, latestGuide);
  let signalFailureRequest!: () => void;
  const failureRequestSeen = new Promise<void>((resolve) => {
    signalFailureRequest = resolve;
  });
  let releaseFailureResponse!: () => void;
  const failureResponseGate = new Promise<void>((resolve) => {
    releaseFailureResponse = resolve;
  });
  await page.route(
    /\/api\/operator\/tasks\/[^/]+\/preview\?.*path=guide\.md/,
    async (route) => {
      controlledFailureUrl = route.request().url();
      signalFailureRequest();
      await failureResponseGate;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "temporarily unavailable",
      });
    },
  );
  const failedRefreshResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "guide.md" &&
      response.status() === 503
    );
  });
  const inspectReadingArea = () =>
    page.locator(".file-preview-scroll").evaluate((element) => {
      const viewport = element as HTMLElement;
      const bounds = viewport.getBoundingClientRect();
      const visibleLine = Array.from(
        viewport.querySelectorAll<HTMLElement>(".file-source-line"),
      )
        .map((line) => ({
          label: line.getAttribute("aria-label"),
          top: line.getBoundingClientRect().top - bounds.top,
          bottom: line.getBoundingClientRect().bottom - bounds.top,
        }))
        .find((line) => line.bottom > 0 && line.top < bounds.height);
      return {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        top: Math.round(bounds.top),
        height: Math.round(bounds.height),
        summary: viewport.innerText.slice(0, 320),
        sourceLineCount: viewport.querySelectorAll(".file-line-text").length,
        notice: viewport.querySelector('[role="alert"]')?.textContent ?? null,
        visibleLine: visibleLine
          ? { label: visibleLine.label, top: visibleLine.top }
          : null,
      };
    });
  // Read deep in the file, as before, when the old file-level Refresh sat under the text.
  await previewScroll.evaluate((element) =>
    element.scrollTo(0, element.scrollHeight),
  );
  await page.waitForFunction(() => {
    const element = document.querySelector(".file-preview-scroll");
    return (
      element !== null &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1
    );
  });
  const beforeFailedRefresh = await inspectReadingArea();
  const scrollBeforeFailedRefresh = beforeFailedRefresh.scrollTop;
  expected503Window = true;
  expected503WindowStartedAt = Date.now();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await failureRequestSeen;
  const afterClickBeforeResponse = await inspectReadingArea();
  _t.diagnostic(
    `reading area before failed refresh: ${JSON.stringify(beforeFailedRefresh)}; after click while exact refresh request is held: ${JSON.stringify(afterClickBeforeResponse)}`,
  );
  releaseFailureResponse();
  assert.equal(afterClickBeforeResponse.scrollTop, scrollBeforeFailedRefresh);
  const failedResponse = await failedRefreshResponse;
  assert.equal(failedResponse.status(), 503);
  assert.equal(failedResponse.url(), controlledFailureUrl);
  await page
    .getByRole("alert")
    .getByText(/last successful preview is retained/)
    .waitFor();
  expected503WindowEndedAt = Date.now();
  expected503Window = false;
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current refreshed" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current latest-unobserved" })
      .count(),
    0,
  );
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    refreshedGuide.replace(/\n$/, "").split("\n"),
  );
  await page
    .locator(".file-provenance dd", { hasText: refreshedHash })
    .waitFor({ state: "attached" });
  const afterFailedRefresh = await inspectReadingArea();
  _t.diagnostic(
    `reading area after confirmed 503 and retained-preview notice: ${JSON.stringify(afterFailedRefresh)}`,
  );
  assert.equal(
    afterFailedRefresh.visibleLine?.label,
    beforeFailedRefresh.visibleLine?.label,
  );
  assert.ok(beforeFailedRefresh.visibleLine);
  assert.ok(afterFailedRefresh.visibleLine);
  assert.ok(
    Math.abs(
      afterFailedRefresh.visibleLine.top - beforeFailedRefresh.visibleLine.top,
    ) <= 1,
  );
  assert.ok(expected503ConsoleErrors.length <= 1);
  for (const consoleError of expected503ConsoleErrors) {
    assert.equal(consoleError.url, controlledFailureUrl);
    assert.match(consoleError.text, /\b503\b/);
    assert.ok(consoleError.observedAt >= expected503WindowStartedAt);
    assert.ok(consoleError.observedAt <= expected503WindowEndedAt);
  }
  _t.diagnostic(
    `controlled guide.md refresh returned 503 at ${controlledFailureUrl}; retained SHA-256 ${refreshedHash}; exact in-window Chromium error events ${JSON.stringify(expected503ConsoleErrors)}`,
  );
  await page.unroute(
    /\/api\/operator\/tasks\/[^/]+\/preview\?.*path=guide\.md/,
  );

  const betaHash = createHash("sha256")
    .update("BETA_ONLY repository content\n")
    .digest("hex");
  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /beta, repository, full path Repository beta/,
    })
    .click();
  const betaRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "beta.txt"
    );
  });
  await page.getByRole("button", { name: /beta\.txt/ }).click();
  const betaPayload = (await (await betaRead).json()) as {
    data: { preview?: { text?: string; sha256?: string } };
  };
  assert.equal(
    betaPayload.data.preview?.text,
    "BETA_ONLY repository content\n",
  );
  assert.equal(betaPayload.data.preview?.sha256, betaHash);
  await page
    .locator(".file-provenance dd", { hasText: betaHash })
    .waitFor({ state: "attached" });
  const betaReads = previewPaths.filter((path) => path === "beta.txt").length;

  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("button", { name: /guide\.md/ }).click();
  await page
    .locator(".file-provenance dd", { hasText: refreshedHash })
    .waitFor({ state: "attached" });
  const afterCachedReturn = await inspectReadingArea();
  _t.diagnostic(
    `reading area after cached A→B→A return cleared the refresh notice: ${JSON.stringify(afterCachedReturn)}`,
  );
  assert.equal(afterCachedReturn.notice, null);
  assert.equal(
    afterCachedReturn.visibleLine?.label,
    beforeFailedRefresh.visibleLine?.label,
  );
  assert.ok(afterCachedReturn.visibleLine);
  assert.ok(beforeFailedRefresh.visibleLine);
  assert.ok(
    Math.abs(
      afterCachedReturn.visibleLine.top - beforeFailedRefresh.visibleLine.top,
    ) <= 1,
  );
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    refreshedGuide.replace(/\n$/, "").split("\n"),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current refreshed" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Line 3: ## Current refreshed" })
      .count(),
    1,
  );
  assert.equal(
    previewPaths.filter((path) => path === "guide.md").length,
    firstGuideReads + 2,
  );
  assert.equal(
    previewPaths.filter((path) => path === "beta.txt").length,
    betaReads,
  );

  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  const codeText = 'export const answer = 42;\nconsole.log("source only");\n';
  const codeRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "example.ts"
    );
  });
  await page.getByRole("button", { name: /example\.ts/ }).click();
  const codePayload = (await (await codeRead).json()) as {
    data: {
      state: string;
      preview?: { kind?: string; text?: string; sha256?: string };
    };
  };
  const codeHash = createHash("sha256").update(codeText).digest("hex");
  assert.equal(codePayload.data.state, "ready");
  assert.equal(codePayload.data.preview?.kind, "text");
  assert.equal(codePayload.data.preview?.text, codeText);
  assert.equal(codePayload.data.preview?.sha256, codeHash);
  await page
    .locator(".file-provenance dd", { hasText: codeHash })
    .waitFor({ state: "attached" });
  assert.deepEqual(
    await page.locator(".file-source-lines .file-line-text").allTextContents(),
    codeText.replace(/\n$/, "").split("\n"),
  );
  assert.equal(
    await page
      .locator(".file-workbench pre code, .file-workbench .file-markdown")
      .count(),
    0,
  );

  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  const unsupportedRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/preview") &&
      url.searchParams.get("path") === "unsafe.svg"
    );
  });
  await page.getByRole("button", { name: /unsafe\.svg/ }).click();
  const unsupportedPayload = (await (await unsupportedRead).json()) as {
    data: {
      state: string;
      metadata?: { reason?: string };
      preview?: unknown;
    };
  };
  assert.equal(unsupportedPayload.data.state, "metadata-only");
  assert.equal(unsupportedPayload.data.metadata?.reason, "unsupported-format");
  assert.equal(unsupportedPayload.data.preview, undefined);
  await page
    .getByRole("status")
    .getByText(/Preview is metadata-only \(unsupported-format\)/)
    .waitFor();
  assert.equal(
    await page
      .locator(
        ".file-preview-scroll svg, .file-preview-scroll script, .file-preview-scroll img",
      )
      .count(),
    0,
  );
  assert.equal(
    (await page.locator(".file-preview-scroll").innerText()).includes(
      "window.filePreviewInjected",
    ),
    false,
  );

  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("button", { name: /gone\.txt/ }).click();
  await page
    .getByText("This file will be removed after its first preview.")
    .waitFor();
  unlinkSync(join(alpha.workspacePath, "gone.txt"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("status")
    .getByText(/Preview is missing/)
    .waitFor();
  await page
    .locator(".file-change-notice")
    .getByText("No longer readable since you last looked.", { exact: true })
    .waitFor();
  assert.ok(
    (
      await page
        .getByRole("tabpanel", { name: "Files" })
        .locator(".action-outcome-details dd")
        .allTextContents()
    ).includes("missing"),
  );

  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("checkbox", { name: "Show ignored files" }).check();
  const ignoredButton = page.getByRole("button", { name: /hidden\.log/ });
  await ignoredButton.waitFor();
  await ignoredButton.click();
  await page.getByText("VISIBLE_IGNORED_FIXTURE", { exact: true }).waitFor();
  const excludedResponse = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, `${web.origin}/api/operator/tasks/${task.taskId}/preview?scope=repository&repositoryId=alpha&path=credentials.txt&showIgnored=true`);
  assert.equal(excludedResponse.status, 200);
  assert.match(excludedResponse.body, /"state":"excluded"/);
  assert.equal(
    excludedResponse.body.includes("DUMMY_CONTROL_PATH_VALUE"),
    false,
  );
  assert.equal(excludedResponse.body.includes(alphaSource), false);

  await workspaceRoot(page).click();
  await page
    .getByRole("button", {
      name: /alpha, repository, full path Repository alpha/,
    })
    .click();
  await page.getByRole("button", { name: /overview\.png/ }).click();
  const image = page.locator(".file-image-preview");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>(".file-image-preview")
        ?.naturalWidth === 1600,
  );
  assert.equal(
    await image.evaluate(
      (element) => (element as HTMLImageElement).naturalHeight,
    ),
    1000,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Fit", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Fit", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  const imageScroll = page.locator(".file-image-scroll");
  const imageBounds = await imageScroll.evaluate((element) => {
    const viewport = element as HTMLElement;
    return {
      scrollWidth: viewport.scrollWidth,
      clientWidth: viewport.clientWidth,
    };
  });
  assert.ok(imageBounds.scrollWidth > imageBounds.clientWidth);
  await imageScroll.evaluate((element) => element.scrollTo(120, 0));
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-image-scroll")?.scrollLeft ?? 0) >= 100,
  );
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  await page.getByRole("button", { name: /guide\.md/ }).click();
  await page
    .getByRole("button", { name: "Back to file list", exact: true })
    .click();
  await page.getByRole("button", { name: /overview\.png/ }).click();
  await page.getByText("150%", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      (document.querySelector(".file-image-scroll")?.scrollLeft ?? 0) >= 100,
  );
  await captureBrowserEvidence(page, "390-files-raster-pan-phone", {
    fullPage: false,
  });

  assert.equal(
    await page.locator("a[download], object, embed, iframe").count(),
    0,
  );
  // A nested file opens with literal slash separators (the service rejects
  // %2F), and a final newline does not add a phantom line.
  const nestedRead = page.waitForResponse(
    (response) =>
      response.url().includes("/preview?") &&
      response.url().includes("&path=docs/child.txt"),
  );
  await page.goto(
    `${web.origin}/app/tasks/${task.taskId}?section=files&repository=alpha&path=docs/child.txt`,
  );
  assert.equal((await nestedRead).status(), 200);
  await page
    .getByRole("button", { name: "Line 1: Arrow key folder child." })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: /^Line 2/ }).count(), 0);

  assert.deepEqual(externalRequests, []);
  assert.deepEqual(consoleErrors, []);
  assert.equal(
    (await page.locator("body").innerText()).includes(alphaSource),
    false,
  );
  assert.equal(
    (await page.locator("body").innerText()).includes(betaSource),
    false,
  );
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

/** A repository on `main` with an older `old` base, a disconnected `unrelated` branch and files to change. */
function markedRepository(root: string, name: string) {
  const path = sourceRepository(root, name, {
    "README.md": `# ${name}\n`,
    "keep.txt": "unchanged\n",
    "gone.txt": "to be deleted\n",
    "src/app/menu.ts": "export const menu = 1;\n",
  });
  git(path, "branch", "old");
  writeFileSync(join(path, "extra.txt"), "added after old\n");
  git(path, "add", "extra.txt");
  git(path, "commit", "--quiet", "-m", "extra");
  const disconnected = git(
    path,
    "commit-tree",
    git(path, "write-tree"),
    "-m",
    "disconnected",
  );
  git(path, "branch", "unrelated", disconnected);
  return path;
}

/** One commit on the task branch: a modified, an added and a deleted file. */
function commitWorkspaceChanges(workspace: string) {
  writeFileSync(join(workspace, "src/app/menu.ts"), "export const menu = 2;\n");
  writeFileSync(join(workspace, "added.md"), "added\n");
  git(workspace, "rm", "--quiet", "gone.txt");
  git(workspace, "add", "-A");
  git(workspace, "commit", "--quiet", "-m", "files change");
}

async function startMarkedFiles(
  j: BrowserJourney,
  {
    repositories,
    viewport = { width: 1280, height: 900 },
    path = "?section=files",
    prepare,
  }: {
    repositories: Array<{ id: string; ref?: string }>;
    viewport?: { width: number; height: number };
    path?: string;
    /** Adds files to the task workspaces before the page opens. */
    prepare?: (workspaces: Record<string, string>) => void;
  },
) {
  const fixture = await j.start("fixture.create", () =>
    createOperatorFixture(null, undefined, undefined, j.fixtureOptions),
  );
  let browser: Browser | undefined;
  j.cleanup(
    (primary) => fixture.close(browser, primary),
    "fixture.close",
    () => fixture.lifecycle.steps,
  );
  const task = await seedReviewTask(
    fixture,
    "Files markers",
    "Mark changed files",
    "Mark files from the Branch comparison",
    repositories.map(({ id, ref }) => ({
      repositoryId: id,
      path: markedRepository(join(fixture.directory, "sources"), id),
      ...(ref ? { ref } : {}),
    })),
  );
  const binding = await fixture.service.taskWorkspace(task.taskId);
  assert.ok(binding);
  const workspaces = Object.fromEntries(
    binding.repositories.map((repository) => [
      repository.repositoryId,
      repository.workspacePath,
    ]),
  );
  if (workspaces.alpha) commitWorkspaceChanges(workspaces.alpha);
  prepare?.(workspaces);
  const web = await j.start("fixture.web", () => fixture.startWeb());
  browser = await j.start("browser.launch", () => chromium.launch());
  const page = await browser.newPage({ viewport });
  j.observe(page);
  page.setDefaultTimeout(15_000);
  const comparisonRequests: string[] = [];
  const directoryRequests: string[] = [];
  const previewRequests: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/comparisons"))
      comparisonRequests.push(request.url());
    if (url.pathname.endsWith("/files")) directoryRequests.push(request.url());
    if (url.pathname.endsWith("/preview")) previewRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`${web.origin}/app/tasks/${task.taskId}${path}`);
  await page.getByLabel("Password").fill(web.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  const files = page.getByRole("tabpanel", { name: "Files" });
  return {
    web,
    task,
    page,
    files,
    workspaces,
    comparisonRequests,
    directoryRequests,
    previewRequests,
    consoleErrors,
    /** The explorer list for a location, matched by its label prefix. */
    list: (location: string) =>
      files.getByRole("list", { name: new RegExp(`^Files in ${location}`) }),
    entry: (name: RegExp) =>
      files.locator(".file-entry").filter({ hasText: name }),
  };
}

test("Files opens at the repository root with changed files marked from the Branch comparison", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "alpha", ref: "main" }],
  });
  const { page, files } = s;
  const list = s.list("Repository alpha");
  await list.waitFor();
  // No workspace row is shown and nothing was clicked.
  assert.equal(
    await files
      .getByRole("button", { name: /, repository, full path / })
      .count(),
    0,
  );
  const added = list.getByRole("button", {
    name: /^added\.md, .*, added in Branch comparison$/,
  });
  await added.waitFor();
  assert.equal(await added.locator(".file-entry-marker").innerText(), "A");
  const gone = list.locator("li.file-entry-deleted", { hasText: "gone.txt" });
  await gone.waitFor();
  assert.equal(await gone.locator(".file-entry-marker").innerText(), "D");
  assert.equal(await gone.getByRole("button").count(), 0);
  assert.equal(
    await list.getByRole("button", { name: /^gone\.txt/ }).count(),
    0,
  );
  const src = list.getByRole("button", {
    name: /^src, directory, .*, contains changed files$/,
  });
  assert.equal(await src.locator(".file-entry-marker").innerText(), "•");
  assert.equal(
    await list
      .getByRole("button", { name: /^keep\.txt/ })
      .locator(".file-entry-marker")
      .innerText(),
    "",
  );
  await files
    .getByText(
      /Changes marked from the Branch comparison against main read at \d{2}:\d{2}\./,
    )
    .waitFor();
  // The jump never moves focus.
  assert.equal(await focusedEntry(page), false);

  // Markers continue inside folders, and reading them starts no comparison read.
  const reads = s.comparisonRequests.length;
  await src.focus();
  await page.keyboard.press("ArrowRight");
  const app = files.getByRole("button", {
    name: /^app, directory, .*, contains changed files$/,
  });
  await app.waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.getAttribute("aria-label")?.startsWith("app, "),
  );
  await page.keyboard.press("ArrowRight");
  const menu = files.getByRole("button", {
    name: /^menu\.ts, .*, modified in Branch comparison$/,
  });
  await menu.waitFor();
  assert.equal(await menu.locator(".file-entry-marker").innerText(), "M");
  assert.equal(s.comparisonRequests.length, reads);
  assert.ok(
    s.comparisonRequests.every(
      (url) => new URL(url).searchParams.get("target") === "branch",
    ),
  );
  assert.deepEqual(s.consoleErrors, []);
});

test("Files first-open location yields to a link and does not repeat", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "beta" }, { id: "alpha", ref: "main" }],
    path: "?section=files&repository=alpha&path=README.md",
  });
  const { page, files } = s;
  // The link opens its file and keeps alpha, although beta is listed first.
  const openTab = files.locator(".file-tab-open[aria-current='page']");
  await openTab.waitFor();
  assert.equal(await openTab.innerText(), "README.md");
  await s.list("Repository alpha").waitFor();

  // Going back to the workspace root stays there across tab switches and a remount.
  await workspaceRoot(page).click();
  await s.list("Workspace").waitFor();
  await openTaskTab(page, "Changes");
  await openTaskTab(page, "Files");
  await s.list("Workspace").waitFor();
  await page
    .getByRole("link", { name: "Overview", exact: true })
    .first()
    .click();
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await page.goBack();
  await openTaskTab(page, "Files");
  await s.list("Workspace").waitFor();
  assert.equal(
    await files.getByRole("button", { name: /^beta, repository,/ }).count(),
    1,
  );
  assert.equal(await focusedEntry(page), false);
});

test("Files markers follow the Changes tab's repository, base branch and refresh, never another repository", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "beta" }, { id: "alpha", ref: "main" }],
  });
  const { page, files } = s;
  const unmarked =
    "Changed files aren't marked: the Changes tab has no complete Branch comparison for this repository.";
  const changes = page.getByRole("tabpanel", { name: "Changes" });
  const marker = (name: RegExp) =>
    s.entry(name).locator(".file-entry-marker").innerText();

  // beta is listed first and keeps the HEAD ref: it has no complete comparison to mark from.
  await s.list("Repository beta").waitFor();
  await files.getByText(unmarked).waitFor();
  assert.equal(await files.getByText(/Changes marked from/).count(), 0);
  assert.equal(await marker(/^README\.md/), "");

  // alpha has not been read by the Changes tab yet: no marker and no claim about it.
  await workspaceRoot(page).click();
  await files.getByRole("button", { name: /^alpha, repository,/ }).click();
  await s.list("Repository alpha").waitFor();
  await s.entry(/^added\.md/).waitFor();
  assert.equal(await marker(/^added\.md/), "");
  assert.equal(await files.getByText(unmarked).count(), 0);
  assert.equal(await files.getByText(/Changes marked from/).count(), 0);

  // Reading alpha in Changes marks it in Files, without a Files reload.
  await openTaskTab(page, "Changes");
  await page.getByLabel("Repository", { exact: true }).selectOption("alpha");
  await changes
    .getByLabel("Workspace comparison files")
    .getByRole("button", { name: /added\.md/ })
    .waitFor();
  await openTaskTab(page, "Files");
  await s
    .entry(/^added\.md/)
    .locator(".file-entry-marker", { hasText: "A" })
    .waitFor();
  assert.equal(await marker(/^▸ src/), "•");

  // beta never borrows alpha's markers.
  await workspaceRoot(page).click();
  await files.getByRole("button", { name: /^beta, repository,/ }).click();
  await s.list("Repository beta").waitFor();
  await files.getByText(unmarked).waitFor();
  assert.equal(await marker(/^README\.md/), "");
  await workspaceRoot(page).click();
  await files.getByRole("button", { name: /^alpha, repository,/ }).click();
  await s
    .entry(/^added\.md/)
    .locator(".file-entry-marker", { hasText: "A" })
    .waitFor();

  // A later commit reaches Files only through the Changes tab's Refresh comparison.
  const workspace = s.workspaces.alpha as string;
  writeFileSync(join(workspace, "keep.txt"), "changed later\n");
  writeFileSync(join(workspace, "late.md"), "late\n");
  git(workspace, "add", "-A");
  git(workspace, "commit", "--quiet", "-m", "later change");
  assert.equal(await marker(/^keep\.txt/), "");
  await openTaskTab(page, "Changes");
  await changes
    .getByRole("button", { name: "Refresh comparison", exact: true })
    .click();
  await openTaskTab(page, "Files");
  await s
    .entry(/^keep\.txt/)
    .locator(".file-entry-marker", { hasText: "M" })
    .waitFor();
  // The listing predates late.md, so it has no row until Files re-reads its listing.
  assert.equal(await s.entry(/^late\.md/).count(), 0);
  await files.getByRole("button", { name: "Refresh", exact: true }).click();
  await s
    .entry(/^late\.md/)
    .locator(".file-entry-marker", { hasText: "A" })
    .waitFor();

  // Another base branch swaps the markers; one with no merge base clears them with a sentence.
  await openTaskTab(page, "Changes");
  await changes.getByLabel("Local base branch").selectOption("old");
  await openTaskTab(page, "Files");
  await s
    .entry(/^extra\.txt/)
    .locator(".file-entry-marker", { hasText: "A" })
    .waitFor();
  await openTaskTab(page, "Changes");
  await changes.getByLabel("Local base branch").selectOption("unrelated");
  await openTaskTab(page, "Files");
  await files.getByText(unmarked).waitFor();
  assert.equal(await marker(/^added\.md/), "");
  assert.equal(await marker(/^extra\.txt/), "");
  assert.equal(await files.getByText(/Changes marked from/).count(), 0);
  assert.deepEqual(s.consoleErrors, []);
});

test("Files stays at the workspace root when the task has no repositories", async (_t, j) => {
  const s = await startMarkedFiles(j, { repositories: [] });
  const { page, files } = s;
  await s.list("Workspace").waitFor();
  await openTaskTab(page, "Changes");
  await openTaskTab(page, "Files");
  await s.list("Workspace").waitFor();
  assert.equal(await files.getByRole("alert").count(), 0);
  assert.equal(
    await files.getByText(/Changes marked from|aren't marked/).count(),
    0,
  );
  assert.deepEqual(s.consoleErrors, []);
});

test("Files first open on a phone shows the repository list view", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "alpha", ref: "main" }],
    viewport: { width: 390, height: 844 },
  });
  const { page } = s;
  await s.list("Repository alpha").waitFor();
  await s
    .entry(/^added\.md/)
    .locator(".file-entry-marker", { hasText: "A" })
    .waitFor();
  assert.equal(
    await page.locator(".file-workbench").getAttribute("data-mobile-view"),
    "list",
  );
  assert.equal(await page.locator(".file-reading-area").isVisible(), false);
  assert.equal(await focusedEntry(page), false);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
});

const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

test("Files shows a one-line file header with hash and read times under Provenance & limits", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "alpha", ref: "main" }],
    prepare: (workspaces) => {
      writeFileSync(
        join(workspaces.alpha as string, "pixel.png"),
        pngImage(3, 2),
      );
      writeFileSync(
        join(workspaces.alpha as string, "paper.pdf"),
        pdf(1, 200, 200),
      );
    },
  });
  const { page, files } = s;
  const header = files.locator(".file-header");
  const line = header.locator(".file-header-line");
  const disclosure = header.locator("details.file-provenance");
  const open = (name: RegExp) => files.getByRole("button", { name }).click();
  const previewRead = (name: string) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/preview") &&
        url.searchParams.get("path") === name
      );
    });
  const values = async () => ({
    labels: await disclosure.locator("dt").allTextContents(),
    hash: await disclosure.locator("dd").last().textContent(),
  });

  // A text file: one line, no charset or hash in it, and a collapsed disclosure.
  await s.list("Repository alpha").waitFor();
  const keepRead = previewRead("keep.txt");
  await open(/^keep\.txt,/);
  const keepObservedAt = (
    (await (await keepRead).json()) as { observedAt: number }
  ).observedAt;
  await line.waitFor();
  assert.equal(
    await line.innerText(),
    `keep.txt · text/plain · 10 bytes · ${clock(keepObservedAt)}`,
  );
  assert.doesNotMatch(await header.innerText(), /charset|as of/);
  assert.equal(await files.getByText("Full path", { exact: true }).count(), 0);
  assert.equal(await files.getByText(/Source view/).count(), 0);
  assert.equal(await disclosure.getAttribute("open"), null);
  assert.equal(await header.getByText(/[0-9a-f]{64}/).isVisible(), false);
  await disclosure.locator("summary").click();
  const keepHash = createHash("sha256").update("unchanged\n").digest("hex");
  assert.deepEqual(await values(), {
    labels: ["Location", "Listing observed", "File read", "SHA-256"],
    hash: keepHash,
  });
  assert.equal(
    await disclosure.locator("dd").first().innerText(),
    "Repository alpha/keep.txt",
  );

  // A second tab starts collapsed and carries its own hash.
  const readmeRead = previewRead("README.md");
  await open(/^README\.md,/);
  await readmeRead;
  await files
    .locator(".file-tab-open[aria-current='page']", { hasText: "README.md" })
    .waitFor();
  assert.equal(await disclosure.getAttribute("open"), null);
  await disclosure.locator("summary").click();
  assert.equal(
    (await values()).hash,
    createHash("sha256").update("# alpha\n").digest("hex"),
  );

  // Refresh brings the new hash and time, and the change notice still appears.
  await files.locator(".file-tab-open", { hasText: "keep.txt" }).click();
  await header.getByText(/^keep\.txt · /).waitFor();
  writeFileSync(
    join(s.workspaces.alpha as string, "keep.txt"),
    "changed on disk\n",
  );
  const refreshRead = previewRead("keep.txt");
  await files.getByRole("button", { name: "Refresh", exact: true }).click();
  const refreshedAt = (
    (await (await refreshRead).json()) as { observedAt: number }
  ).observedAt;
  await files.locator(".file-change-notice").waitFor();
  assert.equal(
    await line.innerText(),
    `keep.txt · text/plain · 16 bytes · ${clock(refreshedAt)}`,
  );
  await disclosure.locator("summary").click();
  assert.equal(
    (await values()).hash,
    createHash("sha256").update("changed on disk\n").digest("hex"),
  );

  // Raster and PDF headers carry their type and size; only the raster adds its pixels.
  await open(/^pixel\.png,/);
  await line
    .getByText(
      /^pixel\.png · image\/png · [\d,]+ bytes · 3 × 2 px · \d{2}:\d{2}$/,
    )
    .waitFor();
  await open(/^paper\.pdf,/);
  await line
    .getByText(/^paper\.pdf · application\/pdf · [\d,]+ bytes · \d{2}:\d{2}$/)
    .waitFor();
  assert.deepEqual(s.consoleErrors, []);
});

test("Files keeps one toolbar Refresh, a reversible Show ignored checkbox and a primary Add review comment", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "alpha", ref: "main" }],
    prepare: (workspaces) =>
      writeFileSync(
        join(workspaces.alpha as string, "hidden.log"),
        "ignored\n",
      ),
  });
  const { page, files } = s;
  await s.list("Repository alpha").waitFor();

  // The toolbar holds one Refresh; the old location buttons and ignore badge are gone.
  const refreshButtons = files.getByRole("button", { name: /^Refresh/ });
  assert.equal(await refreshButtons.count(), 1);
  assert.equal(await refreshButtons.first().innerText(), "Refresh");
  for (const gone of [
    "Refresh files",
    "Refresh selected file",
    "Workspace root",
    "Repository root",
  ])
    assert.equal(await files.getByRole("button", { name: gone }).count(), 0);
  assert.equal(await files.getByText(/ignore status/i).count(), 0);

  // The explorer location is a trail: Workspace › Repository alpha.
  const trail = files.getByRole("navigation", { name: "Explorer location" });
  assert.deepEqual(await trail.getByRole("button").allInnerTexts(), [
    "Workspace",
  ]);
  assert.equal(
    await trail.locator("[aria-current='location']").innerText(),
    "Repository alpha",
  );
  await files.getByRole("button", { name: /^▸ src,|^src,/ }).click();
  await s.list("Repository alpha/src").waitFor();
  assert.deepEqual(await trail.getByRole("button").allInnerTexts(), [
    "Workspace",
    "Repository alpha",
  ]);
  await trail
    .getByRole("button", { name: "Repository alpha", exact: true })
    .click();
  await s.list("Repository alpha").waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("file-entry"),
  );
  await workspaceRoot(page).click();
  await s.list("Workspace").waitFor();
  await files.getByRole("button", { name: /^alpha, repository,/ }).click();
  await s.list("Repository alpha").waitFor();

  // Show ignored files is a footer checkbox: off at first, reversible, exclusions stay.
  const showIgnored = files.getByRole("checkbox", {
    name: "Show ignored files",
  });
  assert.equal(await showIgnored.isChecked(), false);
  await files.getByText("Sensitive exclusions still apply.").waitFor();
  assert.equal(await s.entry(/^hidden\.log/).count(), 0);
  await showIgnored.check();
  await s.entry(/^hidden\.log/).waitFor();
  await showIgnored.uncheck();
  await s.entry(/^hidden\.log/).waitFor({ state: "detached" });

  // Add review comment is secondary and off until a line is chosen, then primary and apart.
  await files.getByRole("button", { name: /^keep\.txt,/ }).click();
  const add = files.getByRole("button", {
    name: "Add review comment",
    exact: true,
  });
  await add.waitFor();
  // The button's variant is its class: primary uses the primary fill, secondary does not.
  const isPrimary = () =>
    add.evaluate((element) => element.classList.contains("bg-primary"));
  assert.equal(await add.isDisabled(), true);
  assert.equal(await isPrimary(), false);
  await files.getByRole("button", { name: "Line 1: unchanged" }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("button")).some(
      (button) =>
        button.textContent === "Add review comment" && !button.disabled,
    ),
  );
  assert.equal(await isPrimary(), true);
  const boxes = await files
    .locator(".file-preview")
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return {
          name: button.textContent,
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
      }),
    );
  const own = boxes.find((box) => box.name === "Add review comment");
  assert.ok(own);
  for (const other of boxes.filter((box) => box !== own))
    assert.ok(
      other.right <= own.left ||
        other.left >= own.right ||
        other.bottom <= own.top ||
        other.top >= own.bottom,
      `Add review comment overlaps ${other.name}`,
    );
  assert.deepEqual(s.consoleErrors, []);
});

test("Files one toolbar Refresh re-reads the listing and the open file, and keeps both when a read fails", async (_t, j) => {
  const s = await startMarkedFiles(j, {
    repositories: [{ id: "alpha", ref: "main" }],
  });
  const { page, files } = s;
  const filesUrl = /\/api\/operator\/tasks\/[^/]+\/files\?/;
  const previewUrl = /\/api\/operator\/tasks\/[^/]+\/preview\?/;
  const refresh = files.getByRole("button", { name: "Refresh", exact: true });
  const settled = (request: "files" | "preview") =>
    page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/${request}`),
    );
  /** Holds every matching read until the returned function opens the gate. */
  const hold = async (url: RegExp) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(url, async (route) => {
      await gate;
      await route.continue();
    });
    return release;
  };
  await s.list("Repository alpha").waitFor();

  // With no file open, Refresh re-reads only the listing.
  let directories = s.directoryRequests.length;
  let previews = s.previewRequests.length;
  let read = settled("files");
  await refresh.click();
  await read;
  assert.equal(s.directoryRequests.length, directories + 1);
  assert.equal(s.previewRequests.length, previews);

  // With a file open, it re-reads both.
  await files.getByRole("button", { name: /^keep\.txt,/ }).click();
  await files
    .locator(".file-header-line", { hasText: /^keep\.txt · / })
    .waitFor();
  directories = s.directoryRequests.length;
  previews = s.previewRequests.length;
  const both = Promise.all([settled("files"), settled("preview")]);
  await refresh.click();
  await both;
  assert.equal(s.directoryRequests.length, directories + 1);
  assert.equal(s.previewRequests.length, previews + 1);

  // It is off while either read is pending, and back when they have settled.
  for (const url of [previewUrl, filesUrl]) {
    const release = await hold(url);
    await refresh.click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "Refresh" && button.disabled,
      ),
    );
    assert.equal(await refresh.isDisabled(), true);
    release();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent === "Refresh" && !button.disabled,
      ),
    );
    await page.unroute(url);
  }

  // A failed preview read keeps the last preview and says so.
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  await page.route(previewUrl, (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "down" }),
  );
  await refresh.click();
  await files
    .getByRole("alert")
    .getByText(
      /File preview refresh failed. The last successful preview is retained/,
    )
    .waitFor();
  await files.getByRole("button", { name: "Line 1: unchanged" }).waitFor();
  await files
    .locator(".file-header-line", { hasText: /^keep\.txt · / })
    .waitFor();
  await page.unroute(previewUrl);

  // A failed listing read keeps the last listing and says so.
  await page.route(filesUrl, (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "down" }),
  );
  await refresh.click();
  await files
    .getByRole("alert")
    .getByText(
      /File listing refresh failed. The last successful listing is retained/,
    )
    .waitFor();
  await s.entry(/^keep\.txt/).waitFor();
  await page.unroute(filesUrl);
  await refresh.click();
  await files.getByRole("alert").waitFor({ state: "detached" });

  // After the last tab closes, Refresh still re-reads the listing.
  await files.getByRole("button", { name: "Close keep.txt tab" }).click();
  await files.getByText("Select a file to open its preview.").waitFor();
  directories = s.directoryRequests.length;
  previews = s.previewRequests.length;
  read = settled("files");
  await refresh.click();
  await read;
  assert.equal(s.directoryRequests.length, directories + 1);
  assert.equal(s.previewRequests.length, previews);
  assert.ok(failures.every((text) => /503/.test(text)));
  assert.deepEqual(
    s.consoleErrors.filter((text) => !/503/.test(text)),
    [],
  );
});
