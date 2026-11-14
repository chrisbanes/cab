import type { Database } from "./store.js";

/** Shared with the operator transaction; no runtime or provider data belongs here. */
export function initializeReasoningSummaryStorage(db: Database): void {
  for (const [table, columns] of [
    [
      "project_reasoning_summaries",
      ["generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)"],
    ],
    [
      "execution_intent_reasoning_summaries",
      [
        "captureMode TEXT CHECK(captureMode IN ('enhanced','baseline'))",
        "generation INTEGER CHECK(generation >= 0)",
      ],
    ],
  ] as const) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (!existing.length) continue;
    for (const column of columns)
      if (!existing.some(({ name }) => name === column.split(" ")[0]))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_reasoning_summaries (
    workId TEXT NOT NULL,
    taskId TEXT NOT NULL,
    assignmentId TEXT NOT NULL,
    assignmentVersion INTEGER NOT NULL,
    instructionsRevision INTEGER NOT NULL,
    profileRevision INTEGER NOT NULL,
    conversationRevision INTEGER NOT NULL,
    workRevision INTEGER NOT NULL,
    threadId TEXT NOT NULL,
    turnId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    intentId TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    captureMode TEXT CHECK(captureMode IN ('enhanced','baseline')),
    generation INTEGER CHECK(generation >= 0),
    text TEXT,
    stored INTEGER NOT NULL CHECK(stored IN (0,1)),
    truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    CHECK((stored = 1 AND text IS NOT NULL) OR (stored = 0 AND text IS NULL)),
    PRIMARY KEY(workId, threadId, turnId)
  );
  CREATE INDEX IF NOT EXISTS conversation_reasoning_summaries_project
    ON conversation_reasoning_summaries(projectId)`);
}

/** Called only inside the receipted domain command's transaction. */
export function eraseReasoningSummaries(db: Database, projectId: string): void {
  db.prepare(`INSERT INTO project_reasoning_summaries (projectId, enabled, generation)
    VALUES (?, 0, 1) ON CONFLICT(projectId) DO UPDATE SET generation = generation + 1`).run(
    projectId,
  );
  db.prepare(`UPDATE conversation_reasoning_summaries
    SET text = NULL, stored = 0 WHERE projectId = ?`).run(projectId);
}
