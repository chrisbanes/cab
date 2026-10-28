import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Runtime } from "../../src/standalone/codex.js";
import {
  type ConversationHistoryBinding,
  ConversationHistoryStore,
} from "../../src/standalone/conversation-history.js";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { StandaloneService } from "../../src/standalone/service.js";
import { tmpdir } from "../fixtures/temp.js";

const runtime: Runtime = {
  async start() {},
  async stop() {},
  async startThread() {
    throw new Error("Paused UI fixture must not execute");
  },
  async resumeThread() {},
  async startTurn() {
    throw new Error("Paused UI fixture must not execute");
  },
  async interruptTurn() {},
  async waitForTurn() {
    return "completed";
  },
  onUnexpectedRequest() {},
};

function command(service: StandaloneService, body: Record<string, unknown>) {
  return service
    .domain()
    .execute({ actor: "operator", key: randomUUID(), ...body } as never);
}

test("assignment history reads stay bounded, sanitized and scoped, with omissions and immutable generations after restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-s05-history-read-"));
  const dataDir = join(root, "data");
  let currentSecret = "";
  const createService = () =>
    new StandaloneService(dataDir, () => runtime, undefined, {
      power: { enabled: false },
      routingClient: null,
      conversationHistoryExclusions: () =>
        currentSecret ? [currentSecret] : [],
    });
  let service = createService();
  t.after(async () => {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const profileId = randomUUID();
  const projectId = randomUUID();
  command(service, {
    type: "profile.create",
    profileId,
    name: "Shared history profile",
    instructions: "PRIVATE_HISTORY_PROFILE_CANARY",
    capabilities: "coordinate",
  });
  command(service, {
    type: "project.create",
    projectId,
    name: "History UI project",
    leadProfileId: profileId,
  });
  const assignments = Array.from({ length: 2 }, (_, index) => {
    const taskId = randomUUID();
    const assignmentId = randomUUID();
    command(service, {
      type: "task.create",
      projectId,
      taskId,
      title: `History task ${index}`,
      outcome: "Inspect retained history.",
      ready: false,
    });
    command(service, {
      type: "assignment.create",
      projectId,
      taskId,
      assignmentId,
      profileId,
      brief: "Inspect history.",
      resultDestination: "lead",
      requesterAssignmentId: null,
    });
    return { taskId, assignmentId };
  });
  const [first, second] = assignments;
  assert.ok(first && second);
  const binding = (
    taskId: string,
    assignmentId: string,
    generation: number,
  ): ConversationHistoryBinding => ({
    workId: `history-work-${assignmentId}-${generation}`,
    taskId,
    assignmentId,
    assignmentVersion: generation,
    // The API redacts only with every captured revision known, so these are the real first ones.
    instructionsRevision: 1,
    profileRevision: 1,
    conversationRevision: generation,
    workRevision: generation,
    threadId: `history-thread-${assignmentId}-${generation}`,
    turnId: `history-turn-${assignmentId}-${generation}`,
  });
  const escapedCredentialCanaries = [
    "UI_ESCAPED_VALUE_PREFIX_CANARY",
    "UI_ESCAPED_VALUE_SUFFIX_CANARY",
    "UI_SINGLE_ESCAPED_PREFIX_CANARY",
    "UI_SINGLE_ESCAPED_SUFFIX_CANARY",
  ];
  const db = new DatabaseSync(join(dataDir, "standalone.sqlite"));
  try {
    const history = new ConversationHistoryStore(db);
    const original = binding(first.taskId, first.assignmentId, 1);
    for (let index = 0; index < 202; index += 1) {
      history.record(
        original,
        {
          threadId: original.threadId,
          turnId: original.turnId,
          itemId: `message-${index}`,
          kind: "completed",
          text: `Visible history ${index}`,
        },
        [],
      );
    }
    const newer = binding(first.taskId, first.assignmentId, 2);
    const escapedCredential = [
      JSON.stringify({
        token: 'UI_ESCAPED_VALUE_PREFIX_CANARY"UI_ESCAPED_VALUE_SUFFIX_CANARY',
      }),
      "password='UI_SINGLE_ESCAPED_PREFIX_CANARY\\'UI_SINGLE_ESCAPED_SUFFIX_CANARY'",
    ].join(" ");
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "html-message",
        kind: "completed",
        text: `Safe assistant <script>globalThis.HISTORY_INJECTED = true</script> PRIVATE_HISTORY_PROFILE_CANARY ${dataDir} LATER_PRIVATE_VALUE ${escapedCredential}`,
      },
      ["PRIVATE_HISTORY_PROFILE_CANARY", dataDir],
    );
    const persistedEscapedCredential = db
      .prepare(
        "SELECT text FROM conversation_history_items WHERE workId = ? AND itemId = ?",
      )
      .get(newer.workId, "html-message") as { text: string | null } | undefined;
    assert.ok(persistedEscapedCredential?.text);
    for (const canary of escapedCredentialCanaries)
      assert.ok(!persistedEscapedCredential.text.includes(canary));
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "partial-message",
        kind: "started",
      },
      [],
    );
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "partial-message",
        kind: "delta",
        bytes: 12,
      },
      [],
    );
    history.record(
      newer,
      {
        threadId: newer.threadId,
        turnId: newer.turnId,
        itemId: "omitted-message",
        kind: "omitted",
        reason: "size-limit",
      },
      [],
    );
    history.recordEarlyBufferLimit(newer);
    const other = binding(second.taskId, second.assignmentId, 1);
    history.record(
      other,
      {
        threadId: other.threadId,
        turnId: other.turnId,
        itemId: "other-message",
        kind: "completed",
        text: "OTHER_TASK_HISTORY_CANARY",
      },
      [],
    );
  } finally {
    db.close();
  }
  currentSecret = "LATER_PRIVATE_VALUE";

  const page = async (assignmentId: string) =>
    new OperatorApi(service, [dataDir]).readAssignmentHistory(assignmentId);
  const verify = async () => {
    const read = service
      .coordinationView()
      .readAssignmentHistory(first.assignmentId);
    assert.equal(read.items.length, 200);
    assert.equal(read.omittedItemCount, 5);
    const escapedItem = read.items.find(
      (item) => item.itemId === "html-message",
    );
    assert.equal(escapedItem?.lifecycle, "completed");
    assert.ok(escapedItem?.text);
    for (const canary of escapedCredentialCanaries)
      assert.ok(!escapedItem.text.includes(canary));
    const served = (await page(first.assignmentId)).data;
    assert.equal(served.items.length, 200);
    assert.equal(served.omittedItemCount, 5);
    const body = JSON.stringify(served);
    // The markup stays literal text: the operator app renders it escaped.
    assert.match(
      served.items.find((item) => item.itemId === "html-message")?.text ?? "",
      /Safe assistant <script>/,
    );
    assert.doesNotMatch(
      body,
      /PRIVATE_HISTORY_PROFILE_CANARY|LATER_PRIVATE_VALUE|OTHER_TASK_HISTORY_CANARY/,
    );
    for (const canary of escapedCredentialCanaries)
      assert.ok(!body.includes(canary));
    assert.ok(!body.includes(dataDir));
    assert.deepEqual(
      [
        ...new Set(served.items.map((item) => item.conversationRevision)),
      ].sort(),
      [1, 2],
    );
    assert.deepEqual(
      served.turnOmissions.map((omission) => omission.reason),
      ["early-buffer-limit"],
    );
    const partial = served.items.find(
      (item) => item.itemId === "partial-message",
    );
    assert.equal(partial?.deltaBytes, 12);
    assert.equal(partial?.text, null);
    assert.equal(
      served.items.find((item) => item.itemId === "omitted-message")
        ?.omissionReason,
      "size-limit",
    );
    assert.ok(!served.items.some((item) => item.text === "Visible history 0"));
    const other = (await page(second.assignmentId)).data;
    assert.match(JSON.stringify(other), /OTHER_TASK_HISTORY_CANARY/);
    assert.doesNotMatch(
      JSON.stringify(other),
      /Safe assistant|Visible history/,
    );
  };
  await verify();
  await service.stop();
  service = createService();
  await service.start();
  await verify();
});
