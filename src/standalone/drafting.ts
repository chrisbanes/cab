import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainConflictError } from "../core/domain-errors.js";
import { type Database, transaction } from "../core/store.js";
import {
  type DraftProposal,
  draftProposalSchema,
} from "../operator/contracts.js";
import type { RuntimeToolDefinition } from "./codex.js";

/** A drafting run is cut off this long after admission. */
export const draftingTimeLimitMs = 600_000;
/** An unclaimed proposal is discarded this long after it arrived. */
export const draftingProposalTtlMs = 24 * 60 * 60 * 1000;

export const draftingStates = [
  "queued",
  "running",
  "stopping",
  "proposed",
  "interrupted",
  "failed",
  "accepted",
  "discarded",
  "expired",
] as const;
export type DraftingState = (typeof draftingStates)[number];

/** Legal moves; every other pair, including any move out of a terminal state, is refused. */
const transitions: Record<DraftingState, readonly DraftingState[]> = {
  queued: ["running", "stopping", "interrupted", "failed"],
  running: ["stopping", "proposed", "interrupted", "failed"],
  stopping: ["interrupted", "failed"],
  proposed: ["accepted", "discarded", "expired"],
  interrupted: ["discarded"],
  failed: ["discarded"],
  accepted: [],
  discarded: [],
  expired: [],
};

const runSchema = z.object({
  runId: z.string().uuid(),
  projectId: z.string().uuid(),
  idea: z.string().min(1),
  harness: z.string().min(1).max(64),
  profileId: z.string().uuid(),
  profileRevision: z.number().int().positive(),
  instructionsRevision: z.number().int().positive(),
  state: z.enum(draftingStates),
  reason: z.string().nullable(),
  proposal: draftProposalSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  proposedAt: z.number().int().nonnegative().nullable(),
});

export type DraftingRun = z.infer<typeof runSchema> & {
  /** Set only while the proposal is waiting to be claimed. */
  expiresAt: number | null;
};

/** Idempotent; also created by ExecutionState, whose harness lookups join it. */
export function createDraftingTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS drafting_runs (
      runId TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      idea TEXT NOT NULL,
      harness TEXT NOT NULL,
      profileId TEXT NOT NULL,
      profileRevision INTEGER NOT NULL,
      instructionsRevision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN (${draftingStates.map((state) => `'${state}'`).join(",")})),
      reason TEXT,
      title TEXT,
      outcome TEXT,
      createdAt INTEGER NOT NULL,
      proposedAt INTEGER
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS drafting_command_receipts (
      key TEXT PRIMARY KEY,
      payloadHash TEXT NOT NULL,
      receiptJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`);
}

/** How long a command receipt answers a replay of its key. */
const receiptRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** Durable drafting-run lifecycle; owns no workspace, capacity or runtime state. */
export class DraftingRunStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    createDraftingTable(db);
  }

  /** Idempotent for the same project and idea; a reused run id with other content conflicts. */
  create(input: {
    runId: string;
    projectId: string;
    idea: string;
    harness: string;
    profileId: string;
    profileRevision: number;
    instructionsRevision: number;
  }): DraftingRun {
    const existing = this.get(input.runId);
    if (existing) {
      if (
        existing.projectId !== input.projectId ||
        existing.idea !== input.idea
      )
        throw new DomainConflictError(
          "Drafting run identity already used with other content",
        );
      return existing;
    }
    this.db
      .prepare(`INSERT INTO drafting_runs
        (runId, projectId, idea, harness, profileId, profileRevision,
          instructionsRevision, state, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
      .run(
        input.runId,
        input.projectId,
        input.idea,
        input.harness,
        input.profileId,
        input.profileRevision,
        input.instructionsRevision,
        this.now(),
      );
    return this.require(input.runId);
  }

  /** The run, with an overdue proposal settled as `expired` first. */
  get(runId: string): DraftingRun | undefined {
    const run = this.read(runId);
    if (
      run?.state === "proposed" &&
      run.expiresAt &&
      run.expiresAt <= this.now()
    )
      return this.move(
        runId,
        "expired",
        "The draft was not used within 24 hours",
      );
    return run;
  }

  require(runId: string): DraftingRun {
    const run = this.get(runId);
    if (!run) throw new Error("Drafting run disappeared");
    return run;
  }

  /** Runs that have not reached a state the operator can act on or leave. */
  unfinished(): DraftingRun[] {
    return this.db
      .prepare(
        "SELECT * FROM drafting_runs WHERE state IN ('queued','running','stopping') ORDER BY createdAt",
      )
      .all()
      .map((row) => this.parse(row));
  }

  /** Whether a valid proposal was recorded, though the run has not yet ended. */
  hasCandidate(runId: string): boolean {
    const row = this.db
      .prepare("SELECT title FROM drafting_runs WHERE runId = ?")
      .get(runId) as { title: string | null } | undefined;
    return row?.title != null;
  }

  /** The recorded receipt for a key; the same key with other content conflicts. */
  receipt<T>(key: string, content: unknown): T | undefined {
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex");
    const stored = this.db
      .prepare(
        "SELECT payloadHash, receiptJson FROM drafting_command_receipts WHERE key = ?",
      )
      .get(key) as { payloadHash: string; receiptJson: string } | undefined;
    if (!stored) return undefined;
    if (stored.payloadHash !== payloadHash)
      throw new DomainConflictError("Request key reused for other content");
    return JSON.parse(stored.receiptJson) as T;
  }

  recordReceipt(key: string, content: unknown, receipt: unknown): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO drafting_command_receipts (key, payloadHash, receiptJson, createdAt) VALUES (?, ?, ?, ?)",
      )
      .run(
        key,
        createHash("sha256").update(JSON.stringify(content)).digest("hex"),
        JSON.stringify(receipt),
        this.now(),
      );
  }

  /** Settles every overdue proposal and drops old receipts; run at service start. */
  sweepExpired(): void {
    this.db
      .prepare("DELETE FROM drafting_command_receipts WHERE createdAt < ?")
      .run(this.now() - receiptRetentionMs);
    const overdue = this.db
      .prepare(
        "SELECT runId FROM drafting_runs WHERE state = 'proposed' AND proposedAt <= ?",
      )
      .all(this.now() - draftingProposalTtlMs) as Array<{ runId: string }>;
    for (const { runId } of overdue) this.get(runId);
  }

  /** Last valid call wins; the state changes only when the turn ends. */
  recordProposal(runId: string, proposal: DraftProposal): void {
    const value = draftProposalSchema.parse(proposal);
    this.db
      .prepare(
        "UPDATE drafting_runs SET title = ?, outcome = ? WHERE runId = ? AND state IN ('running','stopping')",
      )
      .run(value.title, value.outcome, runId);
  }

  /** Moves to `to`, refusing an illegal move. `proposed` needs a recorded proposal. */
  transition(
    runId: string,
    to: DraftingState,
    reason: string | null = null,
  ): DraftingRun {
    this.get(runId); // settle an overdue proposal before judging the move
    return this.move(runId, to, reason);
  }

  private move(
    runId: string,
    to: DraftingState,
    reason: string | null,
  ): DraftingRun {
    return transaction(this.db, () => {
      const row = this.db
        .prepare("SELECT state, title FROM drafting_runs WHERE runId = ?")
        .get(runId) as
        | { state: DraftingState; title: string | null }
        | undefined;
      if (!row) throw new Error("Drafting run disappeared");
      if (!transitions[row.state].includes(to))
        throw new Error(`Drafting run cannot move from ${row.state} to ${to}`);
      if (to === "proposed" && row.title === null)
        throw new Error("Drafting run has no proposal");
      // A claimed, discarded or expired proposal is not kept.
      const keep = to === "proposed";
      this.db
        .prepare(`UPDATE drafting_runs SET state = ?, reason = ?,
          proposedAt = CASE WHEN ? THEN ? ELSE proposedAt END,
          title = CASE WHEN ? THEN title END, outcome = CASE WHEN ? THEN outcome END
          WHERE runId = ?`)
        .run(
          to,
          reason,
          Number(keep),
          this.now(),
          Number(keep),
          Number(keep),
          runId,
        );
      return this.read(runId) as DraftingRun;
    });
  }

  private read(runId: string): DraftingRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM drafting_runs WHERE runId = ?")
      .get(runId);
    return row ? this.parse(row) : undefined;
  }

  private parse(row: unknown): DraftingRun {
    const stored = row as Record<string, unknown>;
    const run = runSchema.parse({
      ...stored,
      // The candidate is offered only once the run is `proposed`.
      proposal:
        stored.state === "proposed" && typeof stored.title === "string"
          ? { title: stored.title, outcome: stored.outcome }
          : null,
    });
    return {
      ...run,
      expiresAt:
        run.state === "proposed" && run.proposedAt !== null
          ? run.proposedAt + draftingProposalTtlMs
          : null,
    };
  }
}

export const draftProposalToolName = "ensemble_propose_draft";

export const draftProposalTool: RuntimeToolDefinition = {
  type: "function",
  name: draftProposalToolName,
  description:
    "Propose the task brief. Call once with a concise title and the desired outcome, including context and acceptance criteria. This creates nothing; the operator reviews it.",
  inputSchema: z.toJSONSchema(draftProposalSchema),
};

/** Added to the lead's own instructions for every drafting run. */
export const draftingInstruction = [
  "You are drafting a task brief for the operator from a rough idea.",
  "Inspect the repositories in your working directory to ground the brief in the code as it is.",
  "You only propose. Do not change files you intend to keep, and do not create tasks, issues, branches or pull requests.",
  `When you are done, call ${draftProposalToolName} once with a concise title and a desired outcome that states the context, the result wanted and acceptance criteria, then stop.`,
].join("\n");
