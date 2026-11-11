import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startCliService } from "../fixtures/operator-cli.js";
import {
  captureNativeResult,
  digest,
  linkRepositories,
  png,
  worktreeGit,
} from "../fixtures/native-result.js";
import { seedReviewTask } from "../fixtures/task-review.js";

const allEvidence = {
  deliveryConfirmed: true,
  writerOwnershipResolved: true,
  handoffsPreserved: true,
  reconciliationEvidencePreserved: true,
  workspaceContentsPreserved: true,
};

const flipped = () => {
  const changed = Buffer.from(png);
  changed.writeUInt8(
    changed.readUInt8(changed.length - 1) ^ 1,
    changed.length - 1,
  );
  return changed;
};

test("artifact bytes name their evidence source and digest on both access paths", async (t) => {
  const s = await startCliService(t);
  const { token } = await s.issue("read");
  const both = async (path: string) => [
    await s.bearer(token, path),
    await s.sessionGet(path),
  ];

  // 1. A result without recorded workspace state is served from its matching workspace file.
  const seeded = await seedReviewTask(s.f, "Recorded", "Recorded artifact");
  const workspace = await s.f.service.taskWorkspace(seeded.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw Error("workspace");
  const file = join(workspace.path, "recorded.png");
  await writeFile(file, png);
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
          sha256: digest(png),
          mime: "image/png",
          size: png.byteLength,
        },
      },
    ],
  });
  const recordedPath = `/api/operator/tasks/${seeded.taskId}/artifacts/${artifactId}`;
  for (const r of await both(recordedPath)) {
    assert.equal(r.status, 200);
    const body = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(body, png);
    assert.equal(r.headers.get("x-cab-evidence-source"), "recorded-workspace");
    assert.equal(r.headers.get("x-cab-sha256"), digest(png));
  }
  // 2. Changed, with no recorded commit to fall back to: a conflict, no bytes.
  await writeFile(file, flipped());
  for (const r of await both(recordedPath)) {
    assert.equal(r.status, 409);
    assert.equal(r.headers.get("x-cab-sha256"), null);
  }

  // 3. Another task's artifact id is not found.
  for (const r of await both(
    `/api/operator/tasks/${randomUUID()}/artifacts/${artifactId}`,
  ))
    assert.equal(r.status, 404);
});

test("a committed artifact is served from the recorded commit once the workspace moves on or is cleaned", async (t) => {
  const s = await startCliService(t);
  const { token } = await s.issue("read");
  const native = await captureNativeResult(s.f, {
    withArtifact: true,
    repository: true,
    beforeReport: (worktree) => {
      worktreeGit(worktree, "add", "-A");
      worktreeGit(worktree, "commit", "--quiet", "-m", "artifact");
    },
  });
  const path = `/api/operator/tasks/${native.seeded.taskId}/artifacts/${native.artifactId}`;
  let r = await s.bearer(token, path);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-cab-evidence-source"), "recorded-workspace");

  // The agent overwrites the file afterwards: the recorded commit still has the original.
  await writeFile(native.artifactPath!, flipped());
  r = await s.bearer(token, path);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal(r.headers.get("x-cab-evidence-source"), "recorded-commit");
  assert.equal(r.headers.get("x-cab-sha256"), digest(png));

  // Removed from the worktree, the file is still at the recorded commit.
  await rm(native.artifactPath!);
  r = await s.bearer(token, path);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal(r.headers.get("x-cab-evidence-source"), "recorded-commit");

  // After cleanup the worktree is gone; the repository still holds the commit.
  worktreeGit(native.worktree, "checkout", "--quiet", "--", ".");
  const cleaned = await s.f.service.archiveTask(
    native.seeded.taskId,
    allEvidence,
  );
  assert.equal(cleaned.outcome, "cleaned");
  r = await s.bearer(token, path);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal(r.headers.get("x-cab-evidence-source"), "recorded-commit");
});

test("an artifact that was never committed is not served once it changes", async (t) => {
  const s = await startCliService(t);
  const { token } = await s.issue("read");
  const native = await captureNativeResult(s.f, {
    withArtifact: true,
    repository: true,
  });
  await writeFile(native.artifactPath!, flipped());
  const r = await s.bearer(
    token,
    `/api/operator/tasks/${native.seeded.taskId}/artifacts/${native.artifactId}`,
  );
  assert.equal(r.status, 409);
  assert.equal(r.headers.get("x-cab-evidence-source"), null);
  assert.equal(r.headers.get("x-cab-sha256"), null);
});

test("artifact reads apply current repository links and path exclusions on the workspace and recorded-commit reads", async (t) => {
  const s = await startCliService(t);
  const { token } = await s.issue("read");
  const statuses = async (path: string) => {
    const responses = [await s.bearer(token, path), await s.sessionGet(path)];
    for (const r of responses)
      if (r.status !== 200) assert.equal(r.headers.get("x-cab-sha256"), null);
    return responses.map((r) => [
      r.status,
      r.headers.get("x-cab-evidence-source"),
    ]);
  };
  const commit = (worktree: string) => {
    worktreeGit(worktree, "add", "-A");
    worktreeGit(worktree, "commit", "--quiet", "-m", "artifact");
  };

  // An unlinked repository withholds both reads; relinking restores them.
  const linked = await captureNativeResult(s.f, {
    withArtifact: true,
    repository: true,
    beforeReport: commit,
  });
  const path = `/api/operator/tasks/${linked.seeded.taskId}/artifacts/${linked.artifactId}`;
  const both = (status: number, source: string | null) => [
    [status, source],
    [status, source],
  ];
  assert.deepEqual(await statuses(path), both(200, "recorded-workspace"));
  linkRepositories(s.f, linked.seeded.projectId, []);
  assert.deepEqual(await statuses(path), both(503, null));
  await writeFile(linked.artifactPath!, flipped());
  assert.deepEqual(await statuses(path), both(503, null));
  linkRepositories(s.f, linked.seeded.projectId, ["R1"]);
  assert.deepEqual(await statuses(path), both(200, "recorded-commit"));

  // A path the current policy excludes is withheld from both reads.
  const excluded = await captureNativeResult(s.f, {
    withArtifact: true,
    repository: true,
    artifactName: ".env.shots/shot.png",
    beforeReport: commit,
  });
  const excludedPath = `/api/operator/tasks/${excluded.seeded.taskId}/artifacts/${excluded.artifactId}`;
  assert.deepEqual(await statuses(excludedPath), both(503, null));
  await writeFile(excluded.artifactPath!, flipped());
  assert.deepEqual(await statuses(excludedPath), both(503, null));
});
