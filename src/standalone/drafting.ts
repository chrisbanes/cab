import {
  assertOwnedTaskWritable,
  assertProjectWritable,
  taskAcceptsWrites,
} from "../core/project-lifecycle.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainConflictError } from "../core/domain-errors.js";
import { issueBodyLimit, issueTitleLimit } from "../core/issue-text-limits.js";
import { type Database, transaction } from "../core/store.js";
import {
  type DraftProposal,
  draftProposalSchema,
  instructionFeedbackLimits,
  instructionTargetSchema,
  operatorFeedbackKinds,
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

/** An imported issue's improved title and body: the `issue.edit` limits with both fields required. */
export const issueEditProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(issueTitleLimit),
    // A pattern, so it reaches the tool's JSON schema.
    body: z.string().max(issueBodyLimit).regex(/\S/, "Enter an issue body"),
  })
  .strict();
export type IssueEditProposal = z.infer<typeof issueEditProposalSchema>;

/** The operator feedback an instruction run was given, as it read when the run started. */
export const instructionFeedbackSchema = z
  .object({
    kind: z.enum(operatorFeedbackKinds),
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    taskTitle: z.string(),
    recipientName: z.string(),
    createdAt: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();
export type InstructionFeedback = z.infer<typeof instructionFeedbackSchema>;

export type InstructionTarget = z.infer<typeof instructionTargetSchema>;

/** A lead's proposed replacement for one target's instructions, with how it used the evidence. */
export const instructionProposalSchema = z
  .object({
    summary: z.string().trim().min(1).max(512),
    /** The full replacement, within the configure `instructions` limit. */
    instructions: z.string().max(16_000),
    rationale: z.string().max(4000).regex(/\S/, "Explain the change"),
    /** Why the change is reusable beyond the selected feedback, or why it is not. */
    generalisation: z
      .string()
      .max(4000)
      .regex(/\S/, "Explain the generalisation"),
    conflicts: z.string().max(4000),
    insufficientEvidence: z.boolean(),
    evidence: z
      .array(
        z
          .object({
            feedbackId: z.string().uuid(),
            use: z.enum(["supports", "conflicts", "not-used"]),
            note: z.string().max(1000),
          })
          .strict(),
      )
      .max(instructionFeedbackLimits.items),
  })
  .strict();
export type InstructionProposal = z.infer<typeof instructionProposalSchema>;

/**
 * A `brief` run drafts a task from an idea; an `issue` run improves an imported issue; an
 * `instruction` run proposes a project's or agent's instructions from selected feedback.
 */
const draftingKinds = ["brief", "issue", "instruction"] as const;
export type DraftingKind = (typeof draftingKinds)[number];

const runSchema = z
  .object({
    runId: z.string().uuid(),
    projectId: z.string().uuid(),
    /** The idea of a brief run; the optional operator note of an issue run. */
    idea: z.string(),
    kind: z.enum(draftingKinds),
    taskId: z.string().uuid().nullable(),
    sourceNodeId: z.string().min(1).nullable(),
    /** The synced title and body an issue run started from. */
    observedTitle: z.string().nullable(),
    observedBody: z.string().nullable(),
    /** What an instruction run proposes for, and that target's text when it started. */
    target: instructionTargetSchema.nullable(),
    observedVersion: z.number().int().positive().nullable(),
    /** A project target's instructions revision; null for an agent, whose version is its revision. */
    observedInstructionsRevision: z.number().int().positive().nullable(),
    observedInstructions: z.string().nullable(),
    feedback: z.array(instructionFeedbackSchema).nullable(),
    harness: z.string().min(1).max(64),
    profileId: z.string().uuid(),
    profileRevision: z.number().int().positive(),
    instructionsRevision: z.number().int().positive(),
    state: z.enum(draftingStates),
    reason: z.string().nullable(),
    /** An issue run keeps its replacement body in `outcome`; see `issueEditProposalOf`. */
    proposal: z.object({ title: z.string(), outcome: z.string() }).nullable(),
    createdAt: z.number().int().nonnegative(),
    proposedAt: z.number().int().nonnegative().nullable(),
  })
  .refine((run) => run.kind !== "brief" || run.idea.length > 0, {
    message: "A brief run needs an idea",
  })
  .refine(
    (run) =>
      run.kind !== "instruction" ||
      (run.target !== null &&
        run.observedVersion !== null &&
        run.observedInstructions !== null &&
        run.feedback !== null &&
        run.feedback.length > 0),
    { message: "An instruction run records its target and evidence" },
  )
  .refine(
    (run) =>
      run.kind !== "issue" ||
      (run.taskId !== null &&
        run.sourceNodeId !== null &&
        run.observedTitle !== null &&
        run.observedBody !== null),
    { message: "An issue run records the issue it started from" },
  );

export type DraftingRun = z.infer<typeof runSchema> & {
  /** Set only while the proposal is waiting to be claimed. */
  expiresAt: number | null;
};

const draftingColumns = (table: string) => `CREATE TABLE ${table} (
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
      proposedAt INTEGER,
      kind TEXT NOT NULL DEFAULT 'brief' CHECK(kind IN (${draftingKinds.map((kind) => `'${kind}'`).join(",")})),
      taskId TEXT,
      sourceNodeId TEXT,
      observedTitle TEXT,
      observedBody TEXT,
      targetKind TEXT,
      targetId TEXT,
      observedVersion INTEGER,
      observedInstructionsRevision INTEGER,
      observedInstructions TEXT,
      feedbackJson TEXT
    )`;

/** Idempotent; also created by ExecutionState, whose harness lookups join it. */
export function createDraftingTable(db: Database): void {
  db.exec(draftingColumns("IF NOT EXISTS drafting_runs"));
  // Runs written before issue runs existed were all briefs.
  const columns = db
    .prepare("PRAGMA table_info(drafting_runs)")
    .all() as Array<{
    name: string;
  }>;
  if (!columns.some(({ name }) => name === "kind"))
    db.exec(
      "ALTER TABLE drafting_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'brief' CHECK(kind IN ('brief','issue'))",
    );
  for (const column of [
    "taskId",
    "sourceNodeId",
    "observedTitle",
    "observedBody",
  ])
    if (!columns.some(({ name }) => name === column))
      db.exec(`ALTER TABLE drafting_runs ADD COLUMN ${column} TEXT`);
  // SQLite cannot widen the `kind` CHECK, so a table from before instruction runs is rebuilt.
  const { sql } = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drafting_runs'",
    )
    .get() as { sql: string };
  if (!sql.includes("'instruction'")) {
    const kept = [
      "runId",
      "projectId",
      "idea",
      "harness",
      "profileId",
      "profileRevision",
      "instructionsRevision",
      "state",
      "reason",
      "title",
      "outcome",
      "createdAt",
      "proposedAt",
      "kind",
      "taskId",
      "sourceNodeId",
      "observedTitle",
      "observedBody",
    ].join(", ");
    // Recreated under its own name, so a migrated schema reads exactly as a fresh one.
    const rebuild = () =>
      db.exec(`ALTER TABLE drafting_runs RENAME TO drafting_runs_old;
        ${draftingColumns("IF NOT EXISTS drafting_runs")};
        INSERT INTO drafting_runs (${kept}) SELECT ${kept} FROM drafting_runs_old;
        DROP TABLE drafting_runs_old;`);
    if (db.isTransaction === true) rebuild();
    else transaction(db, rebuild);
  }
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

  /**
   * Idempotent for the same project, idea and issue; a reused run id with other content
   * conflicts. An `issue` run names the task and the synced text it starts from.
   */
  create(input: {
    runId: string;
    projectId: string;
    idea: string;
    harness: string;
    profileId: string;
    profileRevision: number;
    instructionsRevision: number;
    issue?: {
      taskId: string;
      sourceNodeId: string;
      observedTitle: string;
      observedBody: string;
    };
    instruction?: {
      target: InstructionTarget;
      observedVersion: number;
      observedInstructionsRevision: number | null;
      observedInstructions: string;
      feedback: InstructionFeedback[];
    };
  }): DraftingRun {
    const existing = this.get(input.runId);
    if (existing) {
      if (
        existing.projectId !== input.projectId ||
        existing.idea !== input.idea ||
        existing.taskId !== (input.issue?.taskId ?? null) ||
        JSON.stringify(existing.target) !==
          JSON.stringify(input.instruction?.target ?? null) ||
        JSON.stringify(existing.feedback?.map(({ kind, id }) => [kind, id])) !==
          JSON.stringify(
            input.instruction?.feedback.map(({ kind, id }) => [kind, id]),
          )
      )
        throw new DomainConflictError(
          "Drafting run identity already used with other content",
        );
      return existing;
    }
    assertProjectWritable(this.db, input.projectId);
    this.db
      .prepare(
        `INSERT INTO drafting_runs
        (runId, projectId, idea, harness, profileId, profileRevision,
          instructionsRevision, state, createdAt, kind, taskId, sourceNodeId,
          observedTitle, observedBody, targetKind, targetId, observedVersion,
          observedInstructionsRevision, observedInstructions, feedbackJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.projectId,
        input.idea,
        input.harness,
        input.profileId,
        input.profileRevision,
        input.instructionsRevision,
        this.now(),
        input.issue ? "issue" : input.instruction ? "instruction" : "brief",
        input.issue?.taskId ?? null,
        input.issue?.sourceNodeId ?? null,
        input.issue?.observedTitle ?? null,
        input.issue?.observedBody ?? null,
        input.instruction?.target.kind ?? null,
        input.instruction?.target.kind === "profile"
          ? input.instruction.target.profileId
          : null,
        input.instruction?.observedVersion ?? null,
        input.instruction?.observedInstructionsRevision ?? null,
        input.instruction?.observedInstructions ?? null,
        input.instruction
          ? JSON.stringify(
              z
                .array(instructionFeedbackSchema)
                .parse(input.instruction.feedback),
            )
          : null,
      );
    return this.require(input.runId);
  }

  /** The run, with an overdue proposal settled as `expired` first. */
  get(runId: string): DraftingRun | undefined {
    const run = this.read(runId);
    if (
      run?.state === "proposed" &&
      taskAcceptsWrites(this.db, runId) &&
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

  /**
   * Records a receipt; if another already holds the key, that one is returned, or a
   * conflict thrown when it was for other content.
   */
  recordReceipt<T>(key: string, content: unknown, receipt: T): T {
    const prior = this.receipt<T>(key, content);
    if (prior !== undefined) return prior;
    const runId = (receipt as { runId?: unknown })?.runId;
    if (typeof runId === "string") assertOwnedTaskWritable(this.db, runId);
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
    return this.receipt<T>(key, content) ?? receipt;
  }

  /** Settles every overdue proposal and drops old receipts; run at service start. */
  sweepExpired(): void {
    this.db
      .prepare(
        "DELETE FROM drafting_command_receipts WHERE createdAt < ? AND json_extract(receiptJson, '$.runId') NOT IN (SELECT d.runId FROM drafting_runs d JOIN domain_projects p ON p.id = d.projectId WHERE p.archived = 1)",
      )
      .run(this.now() - receiptRetentionMs);
    const overdue = this.db
      .prepare(
        "SELECT runId FROM drafting_runs WHERE state = 'proposed' AND proposedAt <= ? AND projectId IN (SELECT id FROM domain_projects WHERE archived = 0)",
      )
      .all(this.now() - draftingProposalTtlMs) as Array<{ runId: string }>;
    for (const { runId } of overdue) this.get(runId);
  }

  /** Last valid call wins; the state changes only when the turn ends. */
  recordProposal(
    runId: string,
    proposal: DraftProposal | IssueEditProposal | InstructionProposal,
  ): void {
    assertOwnedTaskWritable(this.db, runId);
    const kind = this.require(runId).kind;
    // An issue run stores its body in the `outcome` column; an instruction run, the rest as JSON.
    const [title, outcome] =
      kind === "issue"
        ? ((v) => [v.title, v.body])(issueEditProposalSchema.parse(proposal))
        : kind === "instruction"
          ? (({ summary, ...rest }) => [summary, JSON.stringify(rest)])(
              instructionProposalSchema.parse(proposal),
            )
          : ((v) => [v.title, v.outcome])(draftProposalSchema.parse(proposal));
    this.db
      .prepare(
        "UPDATE drafting_runs SET title = ?, outcome = ? WHERE runId = ? AND state IN ('running','stopping')",
      )
      .run(title, outcome, runId);
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

  /** Runs `change` in one transaction, joining the caller's when one is open. */
  atomically<T>(change: () => T): T {
    return this.db.isTransaction === true
      ? change()
      : transaction(this.db, change);
  }

  private move(
    runId: string,
    to: DraftingState,
    reason: string | null,
  ): DraftingRun {
    assertOwnedTaskWritable(this.db, runId);
    return this.atomically(() => {
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
        .prepare(
          `UPDATE drafting_runs SET state = ?, reason = ?,
          proposedAt = CASE WHEN ? THEN ? ELSE proposedAt END,
          title = CASE WHEN ? THEN title END, outcome = CASE WHEN ? THEN outcome END
          WHERE runId = ?`,
        )
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
    const { targetKind, targetId, feedbackJson, ...stored } = row as Record<
      string,
      unknown
    >;
    const run = runSchema.parse({
      ...stored,
      target:
        targetKind === "project"
          ? { kind: "project" }
          : targetKind === "profile"
            ? { kind: "profile", profileId: targetId }
            : null,
      feedback:
        typeof feedbackJson === "string" ? JSON.parse(feedbackJson) : null,
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

export const draftProposalToolName = "cab_propose_draft";

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

export const issueEditProposalToolName = "cab_propose_issue_edit";

export const issueEditProposalTool: RuntimeToolDefinition = {
  type: "function",
  name: issueEditProposalToolName,
  description:
    "Propose the improved issue. Call once with the full replacement title and body. This changes nothing; the operator reviews and sends it.",
  inputSchema: z.toJSONSchema(issueEditProposalSchema),
};

/** Added to the lead's own instructions for every issue drafting run. */
export const issueDraftingInstruction = [
  "You are improving an existing issue so an implementer can act on it.",
  "Inspect the repositories in your working directory to ground the issue in the code as it is, and keep the author's intent.",
  "You only propose. Do not change files you intend to keep, and do not edit the issue, create tasks, issues, branches or pull requests.",
  `When you are done, call ${issueEditProposalToolName} once with the full replacement title and body, then stop.`,
].join("\n");

/** The request part of an issue run: the text it starts from and the operator's note. */
export function issueDraftingRequest(
  run: Pick<DraftingRun, "idea" | "observedTitle" | "observedBody">,
): string {
  return [
    `Current issue title:\n${run.observedTitle ?? ""}`,
    `Current issue body:\n${run.observedBody || "(empty)"}`,
    `Operator note:\n${run.idea || "(none)"}`,
  ].join("\n\n");
}

/** The `{ title, body }` an issue run proposed, once it is `proposed`. */
export function issueEditProposalOf(
  run: Pick<DraftingRun, "kind" | "proposal">,
): IssueEditProposal | null {
  return run.kind === "issue" && run.proposal
    ? { title: run.proposal.title, body: run.proposal.outcome }
    : null;
}

export const instructionProposalToolName = "cab_propose_instruction_edit";

export const instructionProposalTool: RuntimeToolDefinition = {
  type: "function",
  name: instructionProposalToolName,
  description:
    "Propose the instruction edit. Call once with a summary, the full replacement instructions, a rationale, the generalisation, any conflicts, whether the evidence is insufficient, and one evidence entry for every selected feedback id. This changes nothing; the operator reviews it.",
  inputSchema: z.toJSONSchema(instructionProposalSchema),
};

/** Added to the lead's own instructions for every instruction drafting run. */
export const instructionDraftingInstruction = [
  "You are proposing an improvement to one set of instructions from operator feedback the operator selected.",
  "Use only the selected feedback and the current instructions in the request. Do not search history for more.",
  "Generalise only what the feedback supports as a reusable preference. A one-off task requirement, an agent's claim or conflicting feedback is not a standing preference: say so in the generalisation and conflicts instead of adding it.",
  "If the feedback does not support a change, set insufficientEvidence and keep the current instructions.",
  "You only propose. Do not change files you intend to keep, and do not create tasks, issues, branches or pull requests.",
  `When you are done, call ${instructionProposalToolName} once with the full replacement instructions and one evidence entry for every feedback id, then stop.`,
].join("\n");

/** The request part of an instruction run: the target's text, the selected feedback and the note. */
export function instructionDraftingRequest(
  run: Pick<
    DraftingRun,
    "idea" | "target" | "observedInstructions" | "feedback"
  >,
): string {
  return [
    run.target?.kind === "profile"
      ? `Target: the instructions of agent ${run.target.profileId}, which every project using that agent shares`
      : "Target: this project's instructions",
    `Current instructions:\n${run.observedInstructions || "(empty)"}`,
    ...(run.feedback ?? []).map((item) =>
      [
        `Feedback ${item.id} (${item.kind}, task "${item.taskTitle}", to ${item.recipientName}, ${new Date(item.createdAt * 1000).toISOString()}):`,
        item.text,
      ].join("\n"),
    ),
    `Operator note:\n${run.idea || "(none)"}`,
  ].join("\n\n");
}

/** The proposal an instruction run made, once it is `proposed`. */
export function instructionProposalOf(
  run: Pick<DraftingRun, "kind" | "proposal">,
): InstructionProposal | null {
  return run.kind === "instruction" && run.proposal
    ? instructionProposalSchema.parse({
        summary: run.proposal.title,
        ...(JSON.parse(run.proposal.outcome) as object),
      })
    : null;
}

/** The one tool each kind of run is offered. */
export function draftingTool(kind: DraftingKind): RuntimeToolDefinition {
  return kind === "issue"
    ? issueEditProposalTool
    : kind === "instruction"
      ? instructionProposalTool
      : draftProposalTool;
}
