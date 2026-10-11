import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cliCapabilities } from "../src/operator/contracts.js";
import { fakeServer, harness } from "./fixtures/cli-harness.js";
import { databaseDigest } from "./fixtures/database-digest.js";
import { startCliService } from "./fixtures/operator-cli.js";
import {
  captureNativeResult,
  digest,
  png,
} from "./fixtures/retained-evidence.js";
import {
  seedRetainedReviewWindow,
  seedReviewTask,
} from "./fixtures/task-review.js";

type After = { after(fn: () => unknown): void };
// biome-ignore lint/suspicious/noExplicitAny: parsed CLI envelopes are asserted structurally
type Json = Record<string, any>;

async function setup(t: After) {
  const s = await startCliService(t);
  const h = harness(t);
  const read = await s.issue("read", "evidence-ro");
  const login = await h.run([
    "auth",
    "login",
    "--connection",
    "home",
    "--url",
    s.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(login.code, 0, login.err);
  const ok = async (args: string[]) => {
    const r = await h.run([...args, "--output", "json"]);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}${r.out}`);
    return r.json() as Json;
  };
  return { s, h, read, ok };
}

test("results, retained evidence and artifacts are discovered and retrieved with integrity", async (t) => {
  const { s, h, read, ok } = await setup(t);
  const native = await captureNativeResult(s.f, { withArtifact: true });
  const seeded = await seedReviewTask(s.f, "Pages", "Many results");
  for (let i = 0; i < 119; i++) seeded.result(`Result ${i}`);
  const workspace = await s.f.service.taskWorkspace(seeded.taskId);
  if (workspace?.state !== "ready") throw Error("workspace");
  const recordedFile = join(workspace.path, "recorded.png");
  await writeFile(recordedFile, png);
  const recordedArtifact = randomUUID();
  const recorded = seeded.result("Recorded artifact", {
    sourceId: seeded.source.sourceId,
    artifacts: [
      {
        artifactId: recordedArtifact,
        label: "Recorded",
        role: "evidence",
        revision: 1,
        availability: "available",
        file: {
          relativePath: "recorded.png",
          sha256: digest(png),
          mime: "image/png",
          size: png.byteLength,
        },
      },
    ],
  });
  const before = databaseDigest(s.f);
  const out = (name: string) => join(h.dir, name);

  // 1. Paged result discovery and a combined result view.
  const pages: Json[] = [];
  let token: string | undefined;
  do {
    const page = await ok([
      "result",
      "list",
      seeded.taskId,
      ...(token ? ["--cursor", token] : []),
    ]);
    pages.push(page);
    token = page.pagination.nextCursor ?? undefined;
  } while (token);
  assert.deepEqual(
    pages.map((p) => p.data.results.length),
    [50, 50, 20],
  );
  assert.equal(pages[0]?.data.total, 120);
  assert.deepEqual(pages[0]?.coverage.gaps, ["more-pages"]);
  assert.equal(pages[2]?.coverage.complete, true);
  let r = await h.run(["result", "list", seeded.taskId, "--cursor", "bogus"]);
  assert.equal(r.code, 2);
  const view = await ok(["result", "get", seeded.taskId, recorded.resultId]);
  assert.equal(view.data.result.resultId, recorded.resultId);
  assert.equal(
    view.data.review.metadata.artifacts[0].artifactId,
    recordedArtifact,
  );
  assert.equal(view.data.evidence.state, "unavailable");
  assert.ok(view.coverage.gaps.includes("evidence-unavailable"));
  r = await h.run(["result", "get", seeded.taskId, recorded.resultId]);
  assert.match(
    r.out,
    new RegExp(`Artifact ${recordedArtifact}: Recorded \\[available\\]`),
  );
  assert.match(r.out, /Evidence: unavailable \(not-retained\)/);
  const plain = await ok([
    "result",
    "get",
    seeded.taskId,
    pages[0]?.data.results[0].resultId,
  ]);
  assert.equal(plain.data.review, null);
  assert.equal(plain.data.evidence, null);
  assert.deepEqual(plain.coverage.gaps, [
    "review-unavailable",
    "evidence-unavailable",
  ]);

  // 2. Exact retained bytes and the retained artifact.
  const nativeView = await ok([
    "result",
    "get",
    native.seeded.taskId,
    native.resultId,
  ]);
  assert.ok(
    nativeView.data.evidence.items.some(
      (i: Json) => i.itemId === native.textItem.itemId,
    ),
  );
  const textOut = out("proof.txt");
  const item = await ok([
    "result",
    "evidence",
    native.seeded.taskId,
    native.resultId,
    native.textItem.itemId,
    "--out",
    textOut,
  ]);
  assert.deepEqual(readFileSync(textOut), native.originalText);
  assert.equal(statSync(textOut).mode & 0o777, 0o600);
  assert.equal(item.data.item.sha256, digest(native.originalText));
  r = await h.run([
    "result",
    "evidence",
    native.seeded.taskId,
    native.resultId,
    native.textItem.itemId,
  ]);
  // Human output neutralises control characters such as CR.
  assert.match(r.out, /first\uFFFD\nsecond/u);
  const pngOut = out("proof.png");
  const artifact = await ok([
    "artifact",
    "get",
    native.seeded.taskId,
    native.artifactId!,
    "--out",
    pngOut,
  ]);
  assert.deepEqual(readFileSync(pngOut), png);
  assert.equal(artifact.data.source, "retained");
  assert.equal(artifact.data.sha256, digest(png));
  const recordedOut = out("recorded.png");
  const workspaceArtifact = await ok([
    "artifact",
    "get",
    seeded.taskId,
    recordedArtifact,
    "--out",
    recordedOut,
  ]);
  assert.equal(workspaceArtifact.data.source, "recorded-workspace");

  // 5. --out rules.
  r = await h.run(["artifact", "get", seeded.taskId, recordedArtifact]);
  assert.equal(r.code, 2);
  writeFileSync(out("taken.png"), "keep");
  r = await h.run([
    "artifact",
    "get",
    seeded.taskId,
    recordedArtifact,
    "--out",
    out("taken.png"),
    "--output",
    "json",
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "output-exists");
  assert.equal(readFileSync(out("taken.png"), "utf8"), "keep");
  r = await h.run([
    "artifact",
    "get",
    seeded.taskId,
    recordedArtifact,
    "--out",
    join(h.dir, "missing-dir", "x.png"),
    "--output",
    "json",
  ]);
  assert.equal(r.code, 2);
  assert.equal(r.json().error.code, "output-failed");

  // 4. Mismatch and missing.
  r = await h.run([
    "artifact",
    "get",
    seeded.taskId,
    native.artifactId!,
    "--out",
    out("foreign.png"),
  ]);
  assert.equal(r.code, 2);
  assert.ok(!existsSync(out("foreign.png")));
  const changed = Buffer.from(png);
  changed.writeUInt8(changed.readUInt8(0) ^ 1, 0);
  await writeFile(recordedFile, changed);
  r = await h.run([
    "artifact",
    "get",
    seeded.taskId,
    recordedArtifact,
    "--out",
    out("changed.png"),
  ]);
  assert.equal(r.code, 4);
  assert.ok(!existsSync(out("changed.png")));

  // 6. Read-only token, nothing persisted, no token in output.
  assert.equal(databaseDigest(s.f), before);
  for (const text of h.outputs) assert.ok(!text.includes(read.token));
});

test("retained gaps stay gaps and a digest mismatch keeps no file", async (t) => {
  const { s, h, ok } = await setup(t);
  // 3. A retained artifact gap is not served from a matching live file.
  const native = await captureNativeResult(s.f, {
    withArtifact: true,
    createArtifact: false,
  });
  await writeFile(native.artifactPath!, png);
  let r = await h.run([
    "artifact",
    "get",
    native.seeded.taskId,
    native.artifactId!,
    "--out",
    join(h.dir, "gap.png"),
  ]);
  assert.equal(r.code, 5);
  assert.ok(!existsSync(join(h.dir, "gap.png")));
  const gapItem = native.artifactItem!.itemId;
  const shown = await ok([
    "result",
    "evidence",
    native.seeded.taskId,
    native.resultId,
    gapItem,
  ]);
  assert.equal(shown.data.state, "gap");
  assert.deepEqual(shown.coverage.gaps, ["evidence-gap"]);
  r = await h.run([
    "result",
    "evidence",
    native.seeded.taskId,
    native.resultId,
    gapItem,
    "--out",
    join(h.dir, "gap-item"),
  ]);
  assert.equal(r.code, 5);
  assert.ok(!existsSync(join(h.dir, "gap-item")));
  const view = await ok([
    "result",
    "get",
    native.seeded.taskId,
    native.resultId,
  ]);
  assert.ok(view.coverage.gaps.includes("evidence-gap"));

  // An older result beyond the review window is still found by its id.
  const window = await seedRetainedReviewWindow(s.f);
  const old = await ok(["result", "get", window.taskId, window.old.resultId]);
  assert.equal(old.data.review.resultId, window.old.resultId);

  // 4. A digest that does not match the bytes leaves no file.
  const installationId = randomUUID();
  const fake = await fakeServer(t, (request, response) => {
    if (request.url === "/api/operator/cli")
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          apiVersion: 1,
          capabilities: cliCapabilities,
          service: { installationId, origin: "https://ensemble.example" },
          credential: {
            id: randomUUID(),
            name: "fake",
            scope: "read",
            createdAt: 1,
            expiresAt: Date.now() + 86_400_000,
          },
        }),
      );
    else
      response
        .writeHead(200, {
          "content-type": "image/png",
          "x-ensemble-sha256": digest("other"),
          "x-ensemble-evidence-source": "retained",
        })
        .end(png);
  });
  const read = await s.issue("read", "fake");
  r = await h.run([
    "auth",
    "login",
    "--connection",
    "fake",
    "--url",
    fake.origin,
    "--token-file",
    h.tokenFile(read.token),
  ]);
  assert.equal(r.code, 0, r.err);
  r = await h.run([
    "artifact",
    "get",
    randomUUID(),
    randomUUID(),
    "--out",
    join(h.dir, "mismatch.png"),
    "--connection",
    "fake",
    "--output",
    "json",
  ]);
  assert.equal(r.code, 5);
  assert.equal(r.json().error.code, "integrity-mismatch");
  assert.equal(r.json().error.retryable, true);
  assert.ok(!existsSync(join(h.dir, "mismatch.png")));
});
