import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OperatorApi } from "../../src/standalone/operator-api.js";
import { createOperatorFixture } from "../fixtures/operator-web.js";
import { seedReviewTask } from "../fixtures/task-review.js";

/** The retained result tables as an older build created them, trimmed to the columns this test seeds. */
const legacyResultTables = `
  CREATE TABLE retained_result_evidence (
    resultId TEXT PRIMARY KEY REFERENCES coordination_results(resultId) ON DELETE CASCADE,
    taskId TEXT NOT NULL REFERENCES domain_tasks(id),
    manifestJson TEXT NOT NULL);
  CREATE INDEX retained_result_evidence_task ON retained_result_evidence(taskId,resultId);
  CREATE TABLE retained_result_evidence_items (
    itemId TEXT PRIMARY KEY,
    resultId TEXT NOT NULL REFERENCES retained_result_evidence(resultId) ON DELETE CASCADE,
    taskId TEXT NOT NULL REFERENCES domain_tasks(id),
    content BLOB);
  CREATE INDEX retained_result_items_result ON retained_result_evidence_items(resultId,itemId);
  CREATE INDEX retained_result_items_task ON retained_result_evidence_items(taskId,resultId,itemId);`;

test("startup drops retained result evidence and its anchors, keeping other anchors", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const task = await seedReviewTask(f, "Migrated", "Older retained evidence");
  const result = task.result("An older result");
  const draftId = randomUUID(),
    submittedId = randomUUID(),
    resultAnchor = randomUUID(),
    submittedAnchor = randomUUID(),
    fileAnchor = randomUUID();
  f.seedPersistedState((db) => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(legacyResultTables);
    db.prepare("INSERT INTO retained_result_evidence VALUES (?,?,'{}')").run(
      result.resultId,
      task.taskId,
    );
    for (const itemId of [randomUUID(), randomUUID()])
      db.prepare(
        "INSERT INTO retained_result_evidence_items VALUES (?,?,?,?)",
      ).run(itemId, result.resultId, task.taskId, Buffer.from("retained"));
    const anchor = db.prepare(`INSERT INTO retained_review_anchor_contexts
      (anchorId,taskId,repositoryId,path,sourceKind,context,resultId,resultItemId,side,startLine,endLine,
       sourceSha256,excerptSha256,byteStart,byteEnd,mime,state,reason,size,capturedAt,recordJson,content)
      VALUES (?,?,NULL,'file.txt',?,?,?,?,'file',1,1,?,?,?,?,?,?,?,?,1,'{}',?)`);
    for (const id of [resultAnchor, submittedAnchor])
      anchor.run(
        id,
        task.taskId,
        "result-evidence",
        "result",
        result.resultId,
        randomUUID(),
        null,
        null,
        null,
        null,
        null,
        "gap",
        "missing",
        0,
        null,
      );
    anchor.run(
      fileAnchor,
      task.taskId,
      "workspace-file",
      "workspace",
      null,
      null,
      "a".repeat(64),
      "b".repeat(64),
      0,
      4,
      "text/plain; charset=utf-8",
      "available",
      null,
      4,
      Buffer.from("kept"),
    );
    db.prepare(
      "INSERT INTO retained_review_anchor_drafts VALUES (?,?,'open',NULL,1,1)",
    ).run(draftId, task.taskId);
    db.prepare(
      "INSERT INTO retained_review_anchor_submitted_contexts VALUES (?,?,1)",
    ).run(submittedId, task.taskId);
    const draftRef = db.prepare(
      "INSERT INTO retained_review_anchor_draft_refs VALUES (?,?,?)",
    );
    draftRef.run(draftId, resultAnchor, 0);
    draftRef.run(draftId, fileAnchor, 1);
    db.prepare(
      "INSERT INTO retained_review_anchor_submitted_refs VALUES (?,?,0)",
    ).run(submittedId, submittedAnchor);
  });

  const inspect = () => {
    const db = new DatabaseSync(
      join(f.directory, "data", "standalone.sqlite"),
      { readOnly: true },
    );
    try {
      const all = (sql: string) => db.prepare(sql).all();
      return {
        legacy: all(
          "SELECT name FROM sqlite_master WHERE name LIKE 'retained_result%'",
        ),
        anchors: all(
          "SELECT anchorId, content FROM retained_review_anchor_contexts ORDER BY anchorId",
        ),
        draftRefs: all(
          "SELECT draftId, anchorId FROM retained_review_anchor_draft_refs",
        ),
        submittedRefs: all(
          "SELECT anchorId FROM retained_review_anchor_submitted_refs",
        ),
        drafts: all("SELECT draftId FROM retained_review_anchor_drafts"),
        foreignKeys: all("PRAGMA foreign_key_check"),
      };
    } finally {
      db.close();
    }
  };
  await f.reopen();
  const migrated = inspect();
  assert.deepEqual(migrated.legacy, []);
  assert.deepEqual(
    migrated.anchors.map((row) => ({ ...row })),
    [{ anchorId: fileAnchor, content: new Uint8Array(Buffer.from("kept")) }],
  );
  assert.deepEqual(
    migrated.draftRefs.map((row) => ({ ...row })),
    [{ draftId, anchorId: fileAnchor }],
  );
  assert.deepEqual(migrated.submittedRefs, []);
  assert.deepEqual(
    migrated.drafts.map((row) => ({ ...row })),
    [{ draftId }],
  );
  assert.deepEqual(migrated.foreignKeys, []);
  // The deleted anchor reads as not found; the older result keeps no workspace state.
  await assert.rejects(
    new OperatorApi(f.service, []).readRetainedReviewAnchor(
      task.taskId,
      resultAnchor,
    ),
    { status: 404 },
  );
  assert.equal(f.service.resultWorkspaces(task.taskId).size, 0);

  // A second start is a no-op.
  await f.reopen();
  assert.deepEqual(inspect(), migrated);
});
