import { z } from "zod";
import { type Database, transaction } from "./store.js";

/** The task text a lead turn carried, and the source revision it was read at. */
export interface LeadText {
  title: string;
  outcome: string;
  /** The task's issue brief (untrusted source text); null when it has none. */
  issueBrief: string | null;
  /** The task's latest source capture revision; null when it has none. */
  sourceRevision: number | null;
}

const textRow = z.object({
  title: z.string(),
  outcome: z.string(),
  issueBrief: z.string().nullable(),
  sourceRevision: z.number().int().positive().nullable(),
});

/**
 * The task text submitted to lead turns, and the anchors that say what text a handback
 * delivered (ADR-1001). A turn's text counts as seen only once its submission is confirmed:
 * `startTurn` returned and the exact execution identity bound its turn. A submission left
 * uncertain by a crash never advances the confirmed text, so the next turn repeats the diff.
 */
export class LeadTextStore {
  constructor(private readonly db: Database) {}

  migrate(): void {
    const anchorsExisted = this.tableExists("task_handback_text");
    this.db.exec(`CREATE TABLE IF NOT EXISTS lead_text_submissions (
        workId TEXT PRIMARY KEY, taskId TEXT NOT NULL, assignmentId TEXT NOT NULL,
        requestSequence INTEGER NOT NULL, threadId TEXT NOT NULL,
        sourceRevision INTEGER, title TEXT NOT NULL, outcome TEXT NOT NULL,
        turnId TEXT
      );
      CREATE TABLE IF NOT EXISTS lead_text_confirmed (
        assignmentId TEXT PRIMARY KEY,
        workId TEXT NOT NULL REFERENCES lead_text_submissions(workId)
      );
      CREATE TABLE IF NOT EXISTS task_handback_text (
        taskId TEXT PRIMARY KEY REFERENCES domain_tasks(id),
        sourceRevision INTEGER NOT NULL,
        basis TEXT NOT NULL CHECK(basis IN ('handback','done','upgrade'))
      );`);
    // Fresh and upgraded stores add the column the same way, so their schemas match.
    if (!this.columnExists("lead_text_submissions", "issueBrief"))
      this.db.exec(
        "ALTER TABLE lead_text_submissions ADD COLUMN issueBrief TEXT",
      );
    if (anchorsExisted) return;
    // Work handed back before anchors existed: what it saw is unknown, so the text observed
    // now is the baseline. Later revisions flag; earlier edits are not claimed.
    const pending = this.tableExists("coordination_completion_requests")
      ? `OR EXISTS (SELECT 1 FROM coordination_completion_requests r
          WHERE r.taskId = t.id AND r.status = 'pending')`
      : "";
    this.db.exec(`INSERT INTO task_handback_text (taskId, sourceRevision, basis)
      SELECT t.id, (SELECT MAX(revision) FROM task_review_sources s WHERE s.taskId = t.id), 'upgrade'
      FROM domain_tasks t JOIN imported_tasks i ON i.taskId = t.id
      WHERE EXISTS (SELECT 1 FROM task_review_sources s WHERE s.taskId = t.id)
        AND (t.state = 'done'
          OR EXISTS (SELECT 1 FROM task_lead_bindings b JOIN domain_assignments a ON a.id = b.assignmentId
            WHERE b.taskId = t.id AND a.state = 'completed')
          ${pending})`);
  }

  /** The task's current text and source revision, as a lead turn would carry it now. */
  current(taskId: string): LeadText {
    return textRow.parse(
      this.db
        .prepare(
          `SELECT b.title, t.outcome,
            (SELECT ib.brief FROM source_issue_briefs ib JOIN external_items e
              ON e.provider = ib.provider AND e.instance = ib.instance AND e.externalId = ib.externalId
              WHERE e.taskId = t.id) AS issueBrief,
            (SELECT MAX(revision) FROM task_review_sources s WHERE s.taskId = t.id) AS sourceRevision
          FROM domain_tasks t JOIN tasks b ON b.id = t.id WHERE t.id = ?`,
        )
        .get(taskId),
    );
  }

  /**
   * Records the text a lead turn is about to submit, before the runtime call. A retried
   * preparation of the same unconfirmed work replaces its candidate.
   */
  prepare(input: {
    workId: string;
    taskId: string;
    assignmentId: string;
    requestSequence: number;
    threadId: string;
    text: LeadText;
  }): void {
    this.db
      .prepare(
        `INSERT INTO lead_text_submissions (workId, taskId, assignmentId, requestSequence, threadId, sourceRevision, title, outcome, issueBrief)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workId) DO UPDATE SET threadId = excluded.threadId, sourceRevision = excluded.sourceRevision,
          title = excluded.title, outcome = excluded.outcome, issueBrief = excluded.issueBrief
        WHERE lead_text_submissions.turnId IS NULL AND lead_text_submissions.assignmentId = excluded.assignmentId`,
      )
      .run(
        input.workId,
        input.taskId,
        input.assignmentId,
        input.requestSequence,
        input.threadId,
        input.text.sourceRevision,
        input.text.title,
        input.text.outcome,
        input.text.issueBrief,
      );
  }

  /**
   * Confirms the submission once its exact thread bound `turnId`. The assignment's confirmed
   * text moves only forward in request order, so a stale or replayed confirmation cannot
   * regress it or confirm another work's text.
   */
  confirm(workId: string, threadId: string, turnId: string): boolean {
    return transaction(this.db, () => {
      const candidate = this.db
        .prepare(
          "SELECT assignmentId, requestSequence, turnId FROM lead_text_submissions WHERE workId = ? AND threadId = ?",
        )
        .get(workId, threadId) as
        | {
            assignmentId: string;
            requestSequence: number;
            turnId: string | null;
          }
        | undefined;
      if (
        !candidate ||
        (candidate.turnId !== null && candidate.turnId !== turnId)
      )
        return false;
      this.db
        .prepare("UPDATE lead_text_submissions SET turnId = ? WHERE workId = ?")
        .run(turnId, workId);
      const confirmed = this.db
        .prepare(
          `SELECT s.requestSequence FROM lead_text_confirmed c
          JOIN lead_text_submissions s ON s.workId = c.workId WHERE c.assignmentId = ?`,
        )
        .get(candidate.assignmentId) as { requestSequence: number } | undefined;
      if (confirmed && confirmed.requestSequence > candidate.requestSequence)
        return false;
      this.db
        .prepare(
          "INSERT INTO lead_text_confirmed (assignmentId, workId) VALUES (?, ?) ON CONFLICT(assignmentId) DO UPDATE SET workId = excluded.workId",
        )
        .run(candidate.assignmentId, workId);
      // Earlier confirmed text is superseded; candidates stay until their own outcome.
      this.db
        .prepare(
          `DELETE FROM lead_text_submissions WHERE assignmentId = ? AND turnId IS NOT NULL
            AND requestSequence < ? AND workId <> ?`,
        )
        .run(candidate.assignmentId, candidate.requestSequence, workId);
      return true;
    });
  }

  /**
   * The text the assignment's last confirmed turn carried in this conversation; undefined
   * before any, or when that turn was in a conversation `threadId` has not seen (a replaced
   * or new one).
   */
  confirmed(assignmentId: string, threadId: string): LeadText | undefined {
    const row = this.db
      .prepare(
        `SELECT s.title, s.outcome, s.issueBrief, s.sourceRevision FROM lead_text_confirmed c
        JOIN lead_text_submissions s ON s.workId = c.workId
        WHERE c.assignmentId = ? AND s.threadId = ?`,
      )
      .get(assignmentId, threadId);
    return row ? textRow.parse(row) : undefined;
  }

  /**
   * Anchors a handback: the work's submitted source revision when it carried text, otherwise
   * the revision observed now. A later handback replaces it; a task without a source
   * capture has nothing to anchor.
   */
  recordHandback(
    taskId: string,
    basis: "handback" | "done",
    workId?: string,
  ): void {
    const submitted = workId
      ? (this.db
          .prepare(
            "SELECT sourceRevision FROM lead_text_submissions WHERE workId = ? AND taskId = ?",
          )
          .get(workId, taskId) as { sourceRevision: number | null } | undefined)
      : undefined;
    const revision =
      submitted?.sourceRevision ?? this.current(taskId).sourceRevision;
    if (revision === null) return;
    this.db
      // A Done transition anchors only a task no lead handed back: it never moves an earlier
      // handback (or upgrade baseline), so an edit after that handback stays flagged.
      .prepare(
        `INSERT INTO task_handback_text (taskId, sourceRevision, basis) VALUES (?, ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET sourceRevision = excluded.sourceRevision, basis = excluded.basis
        WHERE excluded.basis = 'handback' OR task_handback_text.basis = 'done'`,
      )
      .run(taskId, revision, basis);
  }

  /**
   * Whether an imported task's issue text changed after its last handback, including an edit
   * that was later reverted. Informational only: it gates nothing.
   */
  changedSinceHandback(taskId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM task_handback_text h JOIN imported_tasks i ON i.taskId = h.taskId
          WHERE h.taskId = ? AND (SELECT MAX(revision) FROM task_review_sources s WHERE s.taskId = h.taskId) > h.sourceRevision`,
        )
        .get(taskId) !== undefined
    );
  }

  private columnExists(table: string, column: string): boolean {
    return (
      this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((row) => row.name === column);
  }

  private tableExists(name: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name) !== undefined
    );
  }
}
