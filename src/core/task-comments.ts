import { z } from "zod";

/** The only receipt scope the shared task comment command writes. */
export const taskCommentReceiptScope = "task-comment-send";

const uuid = z.string().uuid();

/** Why an assignment cannot receive a shared comment now. A bounded code, never free text. */
export const taskCommentUnavailableReasons = [
  "task-closed",
  "held",
  "cancelled",
  "no-resumable-result",
  "already-followed-up",
  "unresolved-destination",
] as const;
export type TaskCommentUnavailableReason =
  (typeof taskCommentUnavailableReasons)[number];

/** What a send would do for one assignment, as the server computes it at read time. */
export type TaskCommentRecipient = {
  assignmentId: string;
  version: number;
  role: "lead" | "delegate";
} & (
  | { mode: "input" | "resume"; reason: null }
  | { mode: "unavailable"; reason: TaskCommentUnavailableReason }
);

export const taskCommentInputSchema = z
  .object({
    actor: z.literal("operator"),
    key: uuid,
    taskId: uuid,
    body: z.string().trim().min(1).max(16000),
    recipients: z
      .array(
        z
          .object({
            assignmentId: uuid,
            expectedAssignmentVersion: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.recipients.map((r) => r.assignmentId)).size ===
      input.recipients.length,
    "Duplicate comment recipient",
  );
export type TaskCommentInput = z.input<typeof taskCommentInputSchema>;

const delivery = z
  .object({
    assignmentId: uuid,
    eventId: uuid,
    effect: z.enum(["input", "resume"]),
    assignmentVersion: z.number().int().positive().safe(),
    followUpId: uuid.nullable(),
  })
  .strict();
export type TaskCommentDelivery = z.infer<typeof delivery>;

/** The stored result of a committed send: the comment and every attributable delivery. */
export const taskCommentReceiptSchema = z
  .object({
    kind: z.literal("task-comment"),
    key: uuid,
    taskId: uuid,
    commentId: uuid,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative().safe(),
    deliveries: z.array(delivery).max(64),
  })
  .strict();
export type TaskCommentReceipt = z.infer<typeof taskCommentReceiptSchema>;

/** A sent comment with its deliveries; immutable once written. */
export type TaskComment = {
  sequence: number;
  commentId: string;
  taskId: string;
  body: string;
  createdAt: number;
  deliveries: TaskCommentDelivery[];
};

export const taskCommentSchemaSql = `
  CREATE TABLE IF NOT EXISTS coordination_task_comments (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    commentId TEXT NOT NULL UNIQUE,
    taskId TEXT NOT NULL REFERENCES domain_tasks(id),
    author TEXT NOT NULL CHECK(author = 'operator'),
    body TEXT NOT NULL CHECK(length(body) > 0),
    createdAt INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS coordination_task_comments_task
    ON coordination_task_comments(taskId, sequence);
  CREATE TABLE IF NOT EXISTS coordination_task_comment_deliveries (
    commentId TEXT NOT NULL REFERENCES coordination_task_comments(commentId),
    recipientAssignmentId TEXT NOT NULL REFERENCES domain_assignments(id),
    eventId TEXT NOT NULL UNIQUE REFERENCES coordination_inbox_events(eventId),
    expectedAssignmentVersion INTEGER NOT NULL CHECK(expectedAssignmentVersion > 0),
    effect TEXT NOT NULL CHECK(effect IN ('input','resume')),
    assignmentVersion INTEGER NOT NULL CHECK(assignmentVersion > 0),
    followUpId TEXT REFERENCES coordination_follow_ups(followUpId),
    PRIMARY KEY(commentId, recipientAssignmentId)
  );`;
