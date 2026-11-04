import { createHash } from "node:crypto";
import {
  RedactionLimitError,
  redactionExclusionLimits,
  withinRedactionLimits,
} from "./redaction-limits.js";
import type { Database } from "./store.js";

/** Private sanitization inputs only: never project state or restorable configuration. */
export class DeletedProjectRedactionStore {
  constructor(
    private readonly db: Database,
    initialize = true,
  ) {
    if (initialize)
      db.exec(`CREATE TABLE IF NOT EXISTS deleted_project_redaction_values (
      value TEXT PRIMARY KEY NOT NULL CHECK (length(value) > 0)
    )`);
  }

  /** The only read surface is a validated union for sanitization. */
  exclusions(live: readonly string[]): string[] {
    const rows = this.db
      .prepare(
        `SELECT value FROM deleted_project_redaction_values LIMIT ${redactionExclusionLimits.values + 1}`,
      )
      .all();
    return this.validate([
      ...live,
      ...rows.map((row) => (row as { value: string }).value),
    ]);
  }

  fingerprint(live: readonly string[]): string {
    return createHash("sha256")
      .update(JSON.stringify(this.exclusions(live).sort()))
      .digest("hex");
  }

  /** Caller owns the deletion transaction and supplies complete live/retiring inputs. */
  capture(live: readonly string[], retiring: readonly string[]): void {
    if (!this.db.isTransaction)
      throw new Error("Private redaction capture requires a transaction");
    // Validate the complete union before the first insert; rollback stays with the caller.
    this.exclusions([...live, ...retiring]);
    const values = this.validate(retiring);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO deleted_project_redaction_values (value) VALUES (?)",
    );
    for (const value of values) insert.run(value);
  }

  /** Retain every instruction revision, including values no longer current. */
  captureProject(
    projectId: string,
    live: readonly string[],
    retiring: readonly string[],
  ): void {
    const revisions = this.db
      .prepare(
        "SELECT instructions FROM project_instruction_revisions WHERE projectId = ?",
      )
      .all(projectId);
    if (revisions.length === 0)
      throw new Error("Private redaction inputs unavailable");
    this.capture(live, [
      ...retiring,
      ...revisions.map((row) => (row as { instructions: string }).instructions),
    ]);
  }

  private validate(values: readonly string[]): string[] {
    const distinct = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string")
        throw new Error("Private redaction inputs unavailable");
      if (Buffer.byteLength(value) > redactionExclusionLimits.valueBytes)
        throw new RedactionLimitError();
      if (value.length > 0) distinct.add(value);
    }
    const union = [...distinct];
    if (!withinRedactionLimits(union)) throw new RedactionLimitError();
    return union;
  }
}
