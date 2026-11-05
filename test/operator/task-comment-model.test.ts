import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { materialDigest } from "../../src/core/delivery.js";
import {
  addRecipient,
  chipLabel,
  commentPayloadHash,
  hasBlockedRecipient,
  pickableRecipients,
  previewLines,
  receiptSettles,
  recipientLabel,
  removeRecipient,
  selectedRecipientIds,
  sentText,
  type CommentRecipientFact,
} from "../../web/src/task-comment-model.js";

const fact = (
  over: Partial<CommentRecipientFact> & { role: "lead" | "delegate" },
): CommentRecipientFact => ({
  assignmentId: randomUUID(),
  version: 1,
  name: over.role === "lead" ? "Lead" : "Worker",
  mode: "input",
  reason: null,
  ...over,
});

test("an untouched composer selects the lead; removal makes an empty set explicit", () => {
  const lead = fact({ role: "lead" });
  const worker = fact({ role: "delegate" });
  const facts = [lead, worker];
  assert.deepEqual(selectedRecipientIds(facts, null), [lead.assignmentId]);
  const none = removeRecipient(facts, null, lead.assignmentId);
  assert.deepEqual(none, []);
  // A refresh with the same facts keeps the explicit empty set; it never restores the lead.
  assert.deepEqual(selectedRecipientIds(facts, none), []);
  const readded = addRecipient(facts, none, lead.assignmentId);
  assert.deepEqual(readded, [lead.assignmentId]);
  assert.deepEqual(addRecipient(facts, readded, lead.assignmentId), readded);
  assert.deepEqual(
    pickableRecipients(facts, readded).map((f) => f.assignmentId),
    [worker.assignmentId],
  );
});

test("a task with no lead selects nobody, and an unavailable lead stays visible", () => {
  const worker = fact({ role: "delegate" });
  assert.deepEqual(selectedRecipientIds([worker], null), []);
  const lead = fact({ role: "lead", mode: "unavailable", reason: "held" });
  const ids = selectedRecipientIds([lead, worker], null);
  assert.deepEqual(ids, [lead.assignmentId]);
  const [line] = previewLines([lead, worker], ids);
  assert.equal(line?.blocked, true);
  assert.match(line?.effect ?? "", /it is held/);
  assert.equal(hasBlockedRecipient([lead, worker], ids), true);
  assert.equal(hasBlockedRecipient([lead, worker], []), false);
});

test("same-named assignments are told apart by their short identity, never by name", () => {
  const a = fact({ role: "delegate", name: "Worker" });
  const b = fact({ role: "delegate", name: "Worker" });
  const lead = fact({ role: "lead", name: "Lead" });
  const facts = [lead, a, b];
  assert.notEqual(recipientLabel(a, facts), recipientLabel(b, facts));
  assert.match(recipientLabel(a, facts), /^Worker · [0-9a-f]{8}$/);
  assert.equal(recipientLabel(lead, facts), "Lead");
  assert.equal(chipLabel(lead, facts), "@lead Lead");
  assert.match(chipLabel(a, facts), /^@Worker · /);
});

test("a selection that left the task is shown and blocks the send", () => {
  const lead = fact({ role: "lead" });
  const gone = randomUUID();
  const lines = previewLines([lead], [lead.assignmentId, gone]);
  assert.equal(lines[1]?.blocked, true);
  assert.match(lines[1]?.effect ?? "", /no longer in this task/);
});

test("input and resume are worded differently, and a record-only send reports no wake", () => {
  const input = fact({ role: "lead", mode: "input" });
  const resume = fact({ role: "delegate", mode: "resume" });
  const lines = previewLines(
    [input, resume],
    [input.assignmentId, resume.assignmentId],
  );
  assert.match(lines[0]?.effect ?? "", /input on its next eligible turn/);
  assert.match(lines[1]?.effect ?? "", /resumes the same assignment/);
  assert.equal(
    sentText([], [input]),
    "Comment recorded. No assignment was woken.",
  );
  assert.match(
    sentText(
      [{ assignmentId: resume.assignmentId, effect: "resume" }],
      [input, resume],
    ),
    /\(resumed\)/,
  );
});

test("the receipt settles only the exact frozen command", async () => {
  const taskId = randomUUID();
  const key = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const command = {
    taskId,
    key,
    body: 'Check the "api" é',
    recipients: [
      { assignmentId: b, expectedAssignmentVersion: 3 },
      { assignmentId: a, expectedAssignmentVersion: 1 },
    ],
  };
  const payloadHash = materialDigest({
    taskId,
    body: command.body,
    recipients: [...command.recipients].sort((x, y) =>
      x.assignmentId < y.assignmentId ? -1 : 1,
    ),
  });
  assert.equal(await commentPayloadHash(command), payloadHash);
  const receipt = {
    key,
    taskId,
    payloadHash,
    deliveries: [
      { assignmentId: a, effect: "input" as const, assignmentVersion: 1 },
      { assignmentId: b, effect: "resume" as const, assignmentVersion: 4 },
    ],
  };
  assert.equal(await receiptSettles(command, receipt), true);
  for (const wrong of [
    { ...receipt, key: randomUUID() },
    { ...receipt, taskId: randomUUID() },
    { ...receipt, payloadHash: "0".repeat(64) },
    { ...receipt, deliveries: receipt.deliveries.slice(1) },
    {
      ...receipt,
      deliveries: [
        { assignmentId: a, effect: "input" as const, assignmentVersion: 2 },
        receipt.deliveries[1] as (typeof receipt.deliveries)[number],
      ],
    },
  ])
    assert.equal(await receiptSettles(command, wrong), false);
});

test("comment receipts settle when browser subtle crypto is unavailable", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const native = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: native.getRandomValues.bind(native) },
  });
  try {
    const command = {
      taskId: "task-a",
      key: "key-a",
      body: 'Check "é"',
      recipients: [],
    };
    const hash = materialDigest({
      taskId: command.taskId,
      body: command.body,
      recipients: [],
    });
    assert.equal(await commentPayloadHash(command), hash);
    assert.equal(
      await receiptSettles(command, {
        key: command.key,
        taskId: command.taskId,
        payloadHash: hash,
        deliveries: [],
      }),
      true,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});
