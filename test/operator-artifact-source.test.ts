import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startCliService } from "./fixtures/operator-cli.js";
import {
  captureNativeResult,
  digest,
  png,
} from "./fixtures/retained-evidence.js";
import { seedReviewTask } from "./fixtures/task-review.js";

test("artifact bytes name their evidence source and digest on both access paths", async (t) => {
  const s = await startCliService(t);
  const { token } = await s.issue("read");
  const both = async (path: string) => [
    await s.bearer(token, path),
    await s.sessionGet(path),
  ];

  // 1. Retained bytes from the manifest.
  const native = await captureNativeResult(s.f, { withArtifact: true });
  const retainedPath = `/api/operator/tasks/${native.seeded.taskId}/artifacts/${native.artifactId}`;
  for (const r of await both(retainedPath)) {
    assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(body, png);
    assert.equal(r.headers.get("x-ensemble-evidence-source"), "retained");
    assert.equal(r.headers.get("x-ensemble-sha256"), digest(body));
  }

  // 2. A pre-retention result served from its matching recorded workspace file.
  const seeded = await seedReviewTask(s.f, "Recorded", "Recorded artifact");
  const workspace = await s.f.service.taskWorkspace(seeded.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw Error("workspace");
  const bytes = png;
  const file = join(workspace.path, "recorded.png");
  await writeFile(file, bytes);
  const artifactId = randomUUID();
  seeded.result("Recorded result", {
    sourceId: seeded.source.sourceId,
    artifacts: [
      {
        artifactId,
        label: "Recorded file",
        role: "evidence",
        revision: 1,
        availability: "available",
        file: {
          relativePath: "recorded.png",
          sha256: digest(bytes),
          mime: "image/png",
          size: bytes.byteLength,
        },
      },
    ],
  });
  const recordedPath = `/api/operator/tasks/${seeded.taskId}/artifacts/${artifactId}`;
  for (const r of await both(recordedPath)) {
    assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(body, bytes);
    assert.equal(
      r.headers.get("x-ensemble-evidence-source"),
      "recorded-workspace",
    );
    assert.equal(r.headers.get("x-ensemble-sha256"), digest(bytes));
  }
  const changed = Buffer.from(png);
  changed.writeUInt8(
    changed.readUInt8(changed.length - 1) ^ 1,
    changed.length - 1,
  );
  await writeFile(file, changed);
  for (const r of await both(recordedPath)) {
    assert.equal(r.status, 409);
    assert.equal(r.headers.get("x-ensemble-sha256"), null);
  }

  // 4. Another task's artifact id is not found.
  for (const r of await both(
    `/api/operator/tasks/${seeded.taskId}/artifacts/${native.artifactId}`,
  ))
    assert.equal(r.status, 404);
});

test("a retained artifact gap is never served from the workspace over the bearer path", async (t) => {
  const s = await startCliService(t);
  const { token } = await s.issue("read");
  // 3. Retained gap with a matching live file present.
  const native = await captureNativeResult(s.f, {
    withArtifact: true,
    createArtifact: false,
  });
  assert.equal(native.artifactItem?.state, "gap");
  await writeFile(native.artifactPath!, png);
  const r = await s.bearer(
    token,
    `/api/operator/tasks/${native.seeded.taskId}/artifacts/${native.artifactId}`,
  );
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("x-ensemble-evidence-source"), null);
});
