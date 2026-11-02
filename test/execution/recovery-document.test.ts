import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CliError } from "../../src/cli/connections.js";
import {
  readEvidenceFile,
  readRecoveryDocument,
  writeRecoveryDocument,
} from "../../src/cli/recovery-document.js";
import { tmpdir } from "../fixtures/temp.js";

test("recovery documents round-trip with their digest and refuse anything else", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cab-recovery-document-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const assignmentId = randomUUID();
  const { path, document } = await writeRecoveryDocument(join(dir, "r.json"), {
    schema: "cab.cli.recovery/v1",
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
    ["change", JSON.stringify({ ...document, schema: "cab.cli.change/v1" })],
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

test("a missing or open recovery document names the prepare command or the chmod", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cab-recovery-document-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const refusal = (path: string) =>
    readRecoveryDocument(path).then(
      () => assert.fail("expected a refusal"),
      (error: CliError) => error,
    );
  const missing = await refusal(join(dir, "nofile"));
  assert.equal(missing.code, "change-document-invalid");
  assert.match(
    missing.message,
    /Recovery document rejected: it does not exist\./,
  );
  assert.match(missing.extra.fix ?? "", /cab recovery prepare/);
  const open = join(dir, "open.json");
  writeFileSync(open, "{}", { mode: 0o600 });
  chmodSync(open, 0o640);
  const mode = await refusal(open);
  assert.match(mode.message, /its mode is 0640; it must be 0600/);
  assert.equal(mode.extra.fix, `chmod 600 ${open}`);
});

test("bound recovery evidence requires every termination, effects and workspace assertion", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cab-bound-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = {
    termination: { kind: "process-exit" },
    effects: "settled",
    workspace: "preserved",
  };
  const file = join(root, "evidence.json");
  const write = (value: unknown) =>
    writeFileSync(
      file,
      JSON.stringify({
        schema: "cab.cli.recovery-evidence/v1",
        receipt: value,
      }),
      { mode: 0o600 },
    );
  write(receipt);
  assert.deepEqual(await readEvidenceFile(file, "bound-turn-recover"), {
    receipt,
  });
  for (const key of ["termination", "effects", "workspace"] as const) {
    const { [key]: _omitted, ...incomplete } = receipt;
    write(incomplete);
    await assert.rejects(
      readEvidenceFile(file, "bound-turn-recover"),
      /Nothing is inferred/,
    );
  }
  for (const extra of [
    { effects: "unsettled" },
    { termination: { kind: "acknowledged" } },
    { force: true },
  ]) {
    write({ ...receipt, ...extra });
    await assert.rejects(readEvidenceFile(file, "bound-turn-recover"));
  }
});
