import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  readRecoveryDocument,
  writeRecoveryDocument,
} from "../src/cli/recovery-document.js";
import { tmpdir } from "./temp.js";

test("recovery documents round-trip with their digest and refuse anything else", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-recovery-document-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assignmentId = randomUUID();
  const { path, document } = await writeRecoveryDocument(join(dir, "r.json"), {
    schema: "ensemble.cli.recovery/v1",
    path: "conversation-replace",
    preparedAt: 1,
    service: { installationId: randomUUID(), origin: "https://e.test" },
    target: {
      scope: `assignment:${assignmentId}`,
      assignmentId,
      taskId: randomUUID(),
      projectId: randomUUID(),
      workId: null,
    },
    bound: {
      assignmentVersion: 1,
      conversationRevision: 1,
      workRevision: null,
      requestSequence: null,
      observedAt: 1,
    },
    command: { type: "recovery.conversation.replace", assignmentId },
    preview: { lines: [] },
  });
  assert.deepEqual(await readRecoveryDocument(path), document);
  await assert.rejects(
    writeRecoveryDocument(path, document),
    /already exists/,
    "never overwrites",
  );
  for (const [name, body] of [
    ["not-json", "{"],
    [
      "change",
      JSON.stringify({ ...document, schema: "ensemble.cli.change/v1" }),
    ],
    ["digest", JSON.stringify({ ...document, preparedAt: 2 })],
  ]) {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, body ?? "", { mode: 0o600 });
    await assert.rejects(
      readRecoveryDocument(file),
      /Recovery document rejected/,
    );
  }
});
