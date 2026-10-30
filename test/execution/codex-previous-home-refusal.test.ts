import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import {
  db,
  refusedInitial,
  unpause,
  waitUntil,
} from "../fixtures/refused-turn.js";

const previousHome = "Started under the previous Codex home; restart the task";

test("a follow-up to a conversation from the previous Codex home is refused before it holds anything, and Reset task replaces it", async () => {
  const f = await refusedInitial();
  try {
    const api = new OperatorApi(f.service);
    let resumes = 0;
    Object.assign(f.runtime, {
      // The runtime's own marker check: only the first thread predates cab's home.
      startedUnderPreviousHome: (threadId: string) => threadId === "thread-1",
      resumeThread: async () => {
        resumes++;
      },
    });
    unpause(f);
    f.runtime.handleTurn = async (threadId, turnId) => {
      if (f.runtime.turns > 1) return;
      const result = await f.runtime.callTool({
        threadId,
        turnId,
        callId: "first-turn-result",
        tool: "cab_report_result",
        arguments: { summary: "First pass done" },
      });
      assert.equal(result.success, true, result.text);
    };
    await api.execute({
      type: "task.start-again",
      key: randomUUID(),
      taskId: f.taskId,
      expectedVersion: Number(f.service.domain().task(f.taskId).version),
      workId: f.workId,
    });
    await waitUntil(
      () => f.service.domain().assignment(f.assignmentId).state === "completed",
      "first turn completes",
      () => f.service.turnRequests(),
    );

    await f.service.coordinationView().postOperatorMessage({
      key: randomUUID(),
      taskId: f.taskId,
      recipientAssignmentId: f.assignmentId,
      expectedAssignmentVersion: Number(
        f.service.domain().assignment(f.assignmentId).version,
      ),
      message: "FOLLOW_UP_MESSAGE",
    });
    await waitUntil(
      () =>
        f.service
          .turnRequests()
          .some((r) => r.state === "held" && r.reason?.includes(previousHome)),
      "follow-up refused with the visible reason",
      () => f.service.turnRequests(),
    );
    assert.equal(resumes, 0);
    assert.ok(!f.runtime.prompts.some((p) => p.includes("FOLLOW_UP_MESSAGE")));
    // Nothing was admitted: no writer, capacity or recovery state pins the task.
    const refused = f.service
      .turnRequests()
      .find((r) => r.reason?.includes(previousHome));
    for (const table of [
      "task_writer_admissions",
      "execution_capacity_reservations",
      "execution_recovery_identities",
    ])
      assert.equal(
        (
          db(f.service)
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workId = ?`)
            .get(refused?.workId ?? "") as { n: number }
        ).n,
        0,
        table,
      );

    const read = (await api.readTask(f.taskId)).data;
    assert.deepEqual(read.reset, { available: true });
    const starts = f.runtime.starts;
    f.runtime.handleTurn = async () => {};
    const receipt = await api.execute({
      type: "task.reset",
      key: randomUUID(),
      taskId: f.taskId,
      expectedVersion: Number(f.service.domain().task(f.taskId).version),
    });
    assert.ok(receipt.kind === "task-reset");
    await waitUntil(
      () => f.runtime.starts === starts + 1,
      "reset starts a fresh thread",
      () => f.service.turnRequests(),
    );
    assert.equal(resumes, 0);
  } finally {
    await f.service.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
