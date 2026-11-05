import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  unstackConfirmation,
  unstackRecovery,
  unstackStatus,
  cancelStackedConfirmation,
} from "../../src/operator/unstack-copy.js";
import { unstackReceiptSchema } from "../../src/operator/unstack-contracts.js";
import { unstackPhases } from "../../src/core/unstack.js";

test("shared Unstack copy states full captured provider effect, conditional restack and conservative partial recovery", () => {
  assert.match(unstackConfirmation, /all removable unmerged members/);
  assert.match(unstackConfirmation, /not just this pull request/);
  assert.match(
    unstackConfirmation,
    /only after complete removal and exact retarget/,
  );
  assert.match(unstackConfirmation, /cannot undo merges or automatic adoption/);
  assert.match(
    unstackRecovery,
    /original operation stays unfinished and readback-only/,
  );
  assert.match(
    unstackRecovery,
    /No new key, repeated Unstack, queue cancellation, retarget or restack/,
  );
  assert.match(cancelStackedConfirmation, /separate from Stop/);
  assert.match(
    cancelStackedConfirmation,
    /closes no external issue or pull request/,
  );
});

test("typed status distinguishes a recorded intent from provider success for every durable phase", () => {
  for (const phase of unstackPhases) {
    const r = unstackReceiptSchema.parse({
      kind: "task-unstack",
      key: randomUUID(),
      taskId: randomUUID(),
      recorded: true,
      expectedVersion: 1,
      materialHash: "a".repeat(64),
      phase,
      revision: 1,
      reason: "pending",
    });
    assert.match(
      unstackStatus(r),
      phase === "confirmed"
        ? /one restack was queued/
        : phase === "failed"
          ? /no-effect/
          : /unfinished/,
    );
  }
});
