import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { createOperatorFixture } from "./operator-web.js";
import { seedReviewTask } from "./task-review.js";

export const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iY9sAAAAASUVORK5CYII=",
  "base64",
);

export async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for fixture state");
}

/** Git in a fixture worktree, with a commit identity. */
export const worktreeGit = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

/** A source repository with one empty commit, for a task workspace repository. */
export function fixtureRepository(): string {
  const path = mkdtempSync(join(tmpdir(), "cab-native-result-repo-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  worktreeGit(path, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  return path;
}

/**
 * Drives a real native `cab_report_result`. With `repository`, the task has one Git repository
 * (R1) and the files are written in its worktree; `beforeReport` runs there just before the call.
 */
export async function captureNativeResult(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  options: {
    withArtifact?: boolean;
    createArtifact?: boolean;
    repository?: boolean;
    beforeReport?: (worktree: string) => Promise<void> | void;
  } = {},
) {
  const seeded = await seedReviewTask(
    f,
    "Native result",
    "Report a native result",
    undefined,
    options.repository
      ? [{ repositoryId: "R1", path: fixtureRepository() }]
      : [],
  );
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    expectedVersion: Number(domain.project(seeded.projectId).version),
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(domain.task(seeded.taskId).version),
    ready: true,
  });
  await waitFor(() =>
    f.service.list().some((work) => work.state === "running"),
  );
  const work = f.service.list().find((entry) => entry.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const workspace = await f.service.taskWorkspace(seeded.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");
  const worktree = options.repository
    ? workspace.repositories[0]!.workspacePath
    : workspace.path;
  const relativePath = (name: string) =>
    relative(workspace.path, join(worktree, name));
  const textPath = join(worktree, "retained-proof.txt");
  const originalText = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("first\r\nsecond\r\nfinal-without-newline", "utf8"),
  ]);
  await writeFile(textPath, originalText);
  const artifactId = randomUUID();
  const artifactPath = join(worktree, "retained-proof.png");
  const withArtifact = options.withArtifact ?? false;
  if (withArtifact && options.createArtifact !== false)
    await writeFile(artifactPath, png);
  await options.beforeReport?.(worktree);
  const call = {
    threadId: work.threadId,
    turnId: work.turnId,
    callId: randomUUID(),
    tool: "cab_report_result",
    arguments: {
      summary: "Retain exact callback evidence",
      review: {
        sourceId: seeded.source.sourceId,
        changes: { files: [relativePath("retained-proof.txt")] },
        ...(withArtifact
          ? {
              artifacts: [
                {
                  artifactId,
                  label: "Retained screenshot",
                  role: "evidence" as const,
                  revision: 1,
                  availability: "available" as const,
                  file: {
                    relativePath: relativePath("retained-proof.png"),
                    sha256: digest(png),
                    mime: "image/png" as const,
                    size: png.byteLength,
                  },
                },
              ],
            }
          : {}),
      },
    },
  };
  const response = await f.runtime.callTool(call);
  assert.equal(response.success, true, response.text);
  const recorded = f.service
    .coordinationView()
    .readTask(seeded.taskId)
    .results.find((result) => result.workId === work.workId);
  assert.ok(recorded);
  f.runtime.complete(f.runtime.turns);
  await waitFor(
    () => !f.service.list().some((entry) => entry.state === "running"),
  );
  return {
    seeded,
    work,
    workspace,
    worktree,
    textPath,
    originalText,
    artifactId: withArtifact ? artifactId : undefined,
    artifactPath: withArtifact ? artifactPath : undefined,
    originalArtifact: withArtifact ? png : undefined,
    resultId: recorded.resultId,
    call,
  };
}
