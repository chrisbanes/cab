import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { WorkspaceManager } from "../../src/standalone/workspaces.js";
import {
  captureNativeResult,
  waitFor,
  worktreeGit,
} from "../fixtures/native-result.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { startCliService } from "../fixtures/operator-cli.js";

const allEvidence = {
  deliveryConfirmed: true,
  writerOwnershipResolved: true,
  handoffsPreserved: true,
  reconciliationEvidencePreserved: true,
  workspaceContentsPreserved: true,
};

type Fixture = Awaited<ReturnType<typeof createOperatorFixture>>;
const recorded = (f: Fixture, taskId: string, resultId: string) =>
  f.service.resultWorkspaces(taskId).get(resultId) ?? [];

test("a native result records each repository's HEAD, branch and dirty flag", async (t) => {
  const s = await startCliService(t);
  const f = s.f;
  const { token } = await s.issue("read");

  // A clean, detached worktree.
  const clean = await captureNativeResult(f, {
    repository: true,
    beforeReport: (worktree) => {
      worktreeGit(worktree, "add", "-A");
      worktreeGit(worktree, "commit", "--quiet", "-m", "report");
    },
  });
  const [cleanRow] = recorded(f, clean.seeded.taskId, clean.resultId);
  assert.deepEqual(
    { ...cleanRow, observedAt: 0 },
    {
      repositoryId: "R1",
      headCommit: worktreeGit(clean.worktree, "rev-parse", "HEAD"),
      branch: null,
      dirty: false,
      observedAt: 0,
      discardedAt: null,
    },
  );

  // An untracked file makes the result dirty; replaying the callback records nothing new.
  const dirty = await captureNativeResult(f, { repository: true });
  await f.runtime.callTool(dirty.call).catch(() => undefined);
  assert.equal(recorded(f, dirty.seeded.taskId, dirty.resultId).length, 1);
  assert.equal(
    recorded(f, dirty.seeded.taskId, dirty.resultId)[0]?.dirty,
    true,
  );

  // A named branch is recorded.
  const topic = await captureNativeResult(f, {
    repository: true,
    beforeReport: (worktree) => {
      worktreeGit(worktree, "switch", "--quiet", "-c", "topic");
    },
  });
  assert.equal(
    recorded(f, topic.seeded.taskId, topic.resultId)[0]?.branch,
    "topic",
  );

  // The task read and the result page carry the same workspace array.
  const task = (await (
    await s.bearer(token, `/api/operator/tasks/${topic.seeded.taskId}`)
  ).json()) as {
    data: { results: Array<{ resultId: string; workspace: unknown }> };
  };
  const page = (await (
    await s.bearer(
      token,
      `/api/operator/tasks/${topic.seeded.taskId}/results?resultId=${topic.resultId}`,
    )
  ).json()) as { data: { results: Array<{ workspace: unknown }> } };
  const expected = [
    {
      repositoryId: "R1",
      headCommit: worktreeGit(topic.worktree, "rev-parse", "HEAD"),
      branch: "topic",
      dirty: true,
    },
  ];
  assert.deepEqual(
    task.data.results.find((r) => r.resultId === topic.resultId)?.workspace,
    expected,
  );
  assert.deepEqual(page.data.results[0]?.workspace, expected);
});

test("a failed workspace observation still records the result, with no workspace state", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  t.mock.method(
    WorkspaceManager.prototype,
    "observeResultWorkspaces",
    async () => {
      throw new Error("observation failed");
    },
  );
  const native = await captureNativeResult(f, { repository: true });
  assert.ok(native.resultId);
  assert.deepEqual(recorded(f, native.seeded.taskId, native.resultId), []);
});

test("cleanup refuses an unsettled dirty result and allows it once committed, delivered or reset", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const dirtyThenCleaned = async () => {
    const native = await captureNativeResult(f, { repository: true });
    await rm(native.textPath);
    return native;
  };
  const refusal = (resultId: string) =>
    `Result ${resultId} recorded uncommitted changes in R1 that are neither committed nor delivered; commit or deliver them, or reset the task to discard them`;

  // (a) The files are gone but the reported work was never committed.
  const lost = await dirtyThenCleaned();
  const refused = await f.service.archiveTask(lost.seeded.taskId, allEvidence);
  assert.equal(refused.outcome, "retained");
  assert.equal(
    refused.outcome === "retained" && refused.reason,
    refusal(lost.resultId),
  );
  assert.equal(refused.binding.state, "ready");
  assert.ok(existsSync(lost.worktree));

  // (b) Committed: a new commit descends from the recorded HEAD.
  const committed = await captureNativeResult(f, { repository: true });
  worktreeGit(committed.worktree, "add", "-A");
  worktreeGit(committed.worktree, "commit", "--quiet", "-m", "keep");
  assert.equal(
    (await f.service.archiveTask(committed.seeded.taskId, allEvidence)).outcome,
    "cleaned",
  );

  // (c) Delivered: the last push descends from the recorded HEAD.
  const delivered = await dirtyThenCleaned();
  const pushed = worktreeGit(
    delivered.worktree,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "pushed",
  );
  f.seedPersistedState((db) =>
    db
      .prepare(
        "INSERT INTO delivery_task_branches (taskId,repositoryId,branch,lastPushedSha,outsideHeadSha,assignedAt) VALUES (?,?,?,?,NULL,1)",
      )
      .run(delivered.seeded.taskId, "R1", `cb/${randomUUID()}`, pushed),
  );
  assert.equal(
    (await f.service.archiveTask(delivered.seeded.taskId, allEvidence)).outcome,
    "cleaned",
  );

  // (e) A HEAD moved to an ancestor is not a commit of the reported work.
  const rewound = await captureNativeResult(f, {
    repository: true,
    beforeReport: (worktree) =>
      void worktreeGit(
        worktree,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "x",
      ),
  });
  await rm(rewound.textPath);
  worktreeGit(rewound.worktree, "reset", "--quiet", "--hard", "HEAD~1");
  const rewoundResult = await f.service.archiveTask(
    rewound.seeded.taskId,
    allEvidence,
  );
  assert.equal(
    rewoundResult.outcome === "retained" && rewoundResult.reason,
    refusal(rewound.resultId),
  );

  // (f) Files that remain keep the existing dirty-tree refusal.
  const remaining = await captureNativeResult(f, { repository: true });
  const kept = await f.service.archiveTask(
    remaining.seeded.taskId,
    allEvidence,
  );
  assert.equal(
    kept.outcome === "retained" && kept.reason,
    "Uncommitted or ignored work remains in R1",
  );

  // (d) Reset discards the uncommitted result work once; a replay does not move it.
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: lost.seeded.projectId,
    expectedVersion: Number(domain.project(lost.seeded.projectId).version),
    paused: true,
  });
  const reset = {
    key: randomUUID(),
    taskId: lost.seeded.taskId,
    expectedVersion: Number(domain.task(lost.seeded.taskId).version),
  };
  await f.service.resetTask(reset);
  const discardedAt = recorded(f, lost.seeded.taskId, lost.resultId)[0]
    ?.discardedAt;
  assert.ok(discardedAt);
  await f.service.resetTask(reset);
  assert.equal(
    recorded(f, lost.seeded.taskId, lost.resultId)[0]?.discardedAt,
    discardedAt,
  );
  // The reset's fresh turn reports and finishes, so cleanup sees no other writer.
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: lost.seeded.projectId,
    expectedVersion: Number(domain.project(lost.seeded.projectId).version),
    paused: false,
  });
  await waitFor(() =>
    f.service.list().some((work) => work.state === "running"),
  );
  const fresh = f.service.list().find((work) => work.state === "running");
  assert.ok(fresh?.threadId && fresh.turnId);
  const reported = await f.runtime.callTool({
    threadId: fresh.threadId,
    turnId: fresh.turnId,
    callId: randomUUID(),
    tool: "cab_report_result",
    arguments: { summary: "After reset" },
  });
  assert.equal(reported.success, true, reported.text);
  f.runtime.complete(f.runtime.turns);
  await waitFor(
    () => !f.service.list().some((work) => work.state === "running"),
  );
  assert.equal(
    (await f.service.archiveTask(lost.seeded.taskId, allEvidence)).outcome,
    "cleaned",
  );
});
