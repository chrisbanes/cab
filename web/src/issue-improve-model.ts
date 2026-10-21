// Pure state for the Improve with lead panel.
import { z } from "zod";
import {
  issueBodyLimit,
  issueTitleLimit,
} from "../../src/core/issue-text-limits.js";
import type {
  CommandReceipt,
  DraftingRunRead,
  TaskRead,
} from "../../src/operator/contracts.js";
import { issueChangedReason } from "../../src/operator/github-reasons.js";

export const issueNoteLimit = 16_000;
export { issueBodyLimit, issueTitleLimit };
export const issueImprovePollMs = 2000;

export interface IssueText {
  title: string;
  body: string;
}

/** The task read's `issueEdit` field. */
export type IssueEditPolicy = NonNullable<TaskRead["data"]["issueEdit"]>;
export type DeliveryState = NonNullable<IssueEditPolicy["latest"]>["state"];
export type IssueRunState = DraftingRunRead["data"]["state"];

export interface IssueDraftRun {
  runId: string;
  state: IssueRunState;
  reason: string | null;
  proposal: IssueText | null;
  /** The run has a proposal that cannot be shown. */
  proposalWithheld: boolean;
  leadName: string | null;
  createdAt: number;
  expiresAt: number | null;
}

/** The review the service recorded: the current text, the proposal and what approves it. */
export type IssueEditReview = Extract<CommandReceipt, { kind: "edit-review" }>;

/** The provider reason the preflight records when the issue moved since the draft. */
export const staleProviderReason = issueChangedReason;

/** A delivery state the service has not settled: the edit may or may not be on GitHub. */
export const openStates: readonly DeliveryState[] = [
  "prepared",
  "attempting",
  "uncertain",
];

export const isOpenState = (state: DeliveryState) => openStates.includes(state);

export type DiffRow = { kind: "same" | "removed" | "added"; text: string };

/** The most table cells the diff builds; a larger changed middle is shown as removed then added. */
const diffCellLimit = 4_000_000;

/**
 * Line diff: lines both sides share at the start and end are kept, and the changed middle is
 * matched by longest common subsequence. A middle too large for that is shown whole, as all
 * removed and all added, so a very long body cannot stall the page.
 */
export function lineDiff(
  current: string,
  proposed: string,
): { current: DiffRow[]; proposed: DiffRow[] } {
  const a = current.split("\n");
  const b = proposed.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const same = (lines: string[]): DiffRow[] =>
    lines.map((text) => ({ kind: "same", text }));
  const left = same(a.slice(0, head));
  const right = same(b.slice(0, head));
  if ((midA.length + 1) * (midB.length + 1) > diffCellLimit) {
    for (const text of midA) left.push({ kind: "removed", text });
    for (const text of midB) right.push({ kind: "added", text });
  } else {
    const width = midB.length + 1;
    // table[i * width + j]: the common length of midA[i..] and midB[j..].
    const table = new Uint32Array((midA.length + 1) * width);
    const common = (i: number, j: number) => table[i * width + j] ?? 0;
    for (let i = midA.length - 1; i >= 0; i--)
      for (let j = midB.length - 1; j >= 0; j--)
        table[i * width + j] =
          midA[i] === midB[j]
            ? common(i + 1, j + 1) + 1
            : Math.max(common(i + 1, j), common(i, j + 1));
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      const lineA = midA[i];
      const lineB = midB[j];
      if (lineA !== undefined && lineB !== undefined && lineA === lineB) {
        left.push({ kind: "same", text: lineA });
        right.push({ kind: "same", text: lineB });
        i++;
        j++;
      } else if (
        lineA !== undefined &&
        (lineB === undefined || common(i + 1, j) >= common(i, j + 1))
      ) {
        left.push({ kind: "removed", text: lineA });
        i++;
      } else if (lineB !== undefined) {
        right.push({ kind: "added", text: lineB });
        j++;
      }
    }
  }
  left.push(...same(a.slice(a.length - tail)));
  right.push(...same(b.slice(b.length - tail)));
  return { current: left, proposed: right };
}

/** Why Review changes is not offered yet; null when the text can be reviewed. */
export function reviewBlock(
  edit: IssueText,
  observed: IssueText | null,
): string | null {
  if (edit.title.trim() === "") return "Enter a title.";
  if (edit.title.trim().length > issueTitleLimit)
    return `The title is over ${issueTitleLimit} characters.`;
  if (edit.body.trim() === "") return "Enter a body.";
  if (edit.body.length > issueBodyLimit)
    return `The body is over ${issueBodyLimit.toLocaleString("en")} characters.`;
  if (
    observed &&
    edit.title.trim() === observed.title &&
    edit.body === observed.body
  )
    return "This matches the issue as it is now.";
  return null;
}

export type IssueImproveView =
  | "unavailable"
  | "idle"
  | "starting"
  | "queued"
  | "running"
  | "stopping"
  | "withheld"
  | "interrupted"
  | "failed"
  | "editing"
  | "reviewing"
  | "sending"
  | "held"
  | "sent"
  | "stale"
  | "send-failed";

export interface ViewInput {
  policy: IssueEditPolicy;
  /** The panel's own edit once sent or refused, by operation id. */
  ownOperationId: string | null;
  runId: string | null;
  run: IssueDraftRun | null;
  /** The run's proposal already filled the editor, so the editor outranks the run. */
  runLoaded: boolean;
  hasEdit: boolean;
  hasReview: boolean;
  sending: boolean;
  /** The service confirmed this panel's send in its own answer, ahead of the next task read. */
  sentConfirmed: boolean;
  staleFlag: boolean;
  sendFailure: boolean;
}

/**
 * What the panel shows. The service's newest unsettled edit always wins, so a held outcome
 * survives a reload and cannot be hidden by a fresh draft.
 */
export function improveView(input: ViewInput): IssueImproveView {
  const latest = input.policy.latest;
  if (latest && isOpenState(latest.state)) return "held";
  if (input.sentConfirmed) return "sent";
  if (latest?.operationId === input.ownOperationId) {
    if (latest.state === "confirmed-success") return "sent";
    if (latest.reason === staleProviderReason) return "stale";
    if (latest.state === "confirmed-failure" || latest.state === "denied")
      return "send-failed";
  }
  if (input.staleFlag) return "stale";
  if (input.sending) return "sending";
  if (input.sendFailure) return "send-failed";
  if (input.hasReview) return "reviewing";
  // A newer draft outranks the text of an older one until its proposal arrives.
  if (input.hasEdit && (!input.runId || input.runLoaded)) return "editing";
  if (input.runId) {
    if (!input.run) return "starting";
    if (input.run.state === "proposed")
      return input.run.proposalWithheld ? "withheld" : "editing";
    if (input.run.state === "failed") return "failed";
    if (input.run.state === "interrupted") return "interrupted";
    if (input.run.state === "queued") return "queued";
    if (input.run.state === "stopping") return "stopping";
    if (input.run.state === "running") return "running";
    return "idle";
  }
  return input.policy.available ? "idle" : "unavailable";
}

/** The part of the panel that survives a reload, apart from the service's own records. */
export const storedSchema = z
  .object({
    note: z.string().max(issueNoteLimit),
    runId: z.string().uuid().optional(),
    startKey: z.string().uuid().optional(),
    expectedTaskVersion: z.number().int().nonnegative().optional(),
    /** The run whose proposal already filled the editor, so a reload does not refill it. */
    loadedRunId: z.string().uuid().optional(),
    /** The run the text being edited came from, which a review names; a newer draft may not have arrived. */
    editRunId: z.string().uuid().optional(),
    edit: z
      .object({
        title: z.string().max(issueTitleLimit * 4),
        body: z.string().max(issueBodyLimit * 2),
      })
      .optional(),
    /** Keys and receipt of the review in progress, so a retry reuses them. */
    review: z
      .object({
        reviewKey: z.string().uuid(),
        operationId: z.string().uuid(),
        confirmKey: z.string().uuid(),
        title: z.string(),
        body: z.string(),
        receipt: z
          .object({
            reviewId: z.string().uuid(),
            revision: z.number().int().nonnegative(),
            materialHash: z.string(),
            decision: z.enum(["pending", "approved", "denied"]),
            current: z.object({ title: z.string(), body: z.string() }),
            proposed: z.object({ title: z.string(), body: z.string() }),
          })
          .optional(),
      })
      .optional(),
    /** The edit this panel sent, kept until the operator dismisses its outcome. */
    sentOperationId: z.string().uuid().optional(),
  })
  .strict();
export type Stored = z.infer<typeof storedSchema>;

export const emptyStored: Stored = { note: "" };

export const storageKey = (taskId: string) =>
  `ensemble.issue-improve.v1.${taskId}`;

export function readStored(
  storage: Pick<Storage, "getItem">,
  taskId: string,
): Stored {
  try {
    const bytes = storage.getItem(storageKey(taskId));
    return bytes ? storedSchema.parse(JSON.parse(bytes)) : emptyStored;
  } catch {
    return emptyStored;
  }
}

export function writeStored(
  storage: Pick<Storage, "setItem" | "removeItem">,
  taskId: string,
  value: Stored,
) {
  try {
    if (JSON.stringify(value) === JSON.stringify(emptyStored))
      storage.removeItem(storageKey(taskId));
    else storage.setItem(storageKey(taskId), JSON.stringify(value));
  } catch {
    // Held in memory for this page; storage only adds survival across a reload.
  }
}

export const issueImproveCopy = {
  intro:
    "Ask the project lead to rewrite this issue’s title and body so an implementer can act on it. It keeps your intent and proposes a replacement for you to edit.",
  access:
    "The lead reads this project’s linked repositories in a throwaway copy with network off. This is not a read-only sandbox: reads keep the runtime’s normal host access. Nothing is sent to GitHub until you review and send it.",
  capacity:
    "Counts toward capacity and stops by itself after 10:00 of running. It also works while the task has work running.",
  irreversible:
    "Sending replaces the title and body on GitHub, and Ensemble cannot undo it. The current text stays in this review, but there is no restore action.",
  guard:
    "Sends one edit under this repository’s issue edit grant. It is refused, with nothing sent, if the issue changed on GitHub after the draft started.",
  stale:
    "The issue changed on GitHub after this draft started. Nothing was sent. Redraft to start again from the current text; your edits stay on screen until the new draft arrives.",
  held: "Held: we couldn’t confirm whether GitHub applied the edit. Check the issue on GitHub. Ensemble won’t send it again, and the edit stays held across reloads and restarts.",
  heldPending:
    "Sending. The edit is in progress and can’t be sent again from here.",
  sent: "Sent. GitHub shows the new title and body. The title and outcome here update after the next sync.",
  withheld:
    "The draft holds text that cannot be shown, such as a private path or credential. Discard it and redraft.",
  gone: "That draft is no longer available. Your text is unchanged.",
  expired: "The draft expired before it was used. Your text is unchanged.",
  unconfirmed:
    "We couldn’t confirm the draft started. If it did, it will appear here.",
  interrupted: "The run ended and its working copy was deleted.",
  failed: "The lead returned no draft. Nothing was changed.",
  refusedDisclosure:
    "The current text includes something that can’t be shown here, so a full replacement can’t be reviewed. Edit the issue on GitHub instead.",
  refusedAtSend:
    "The text can no longer be shown in full, so nothing was approved or sent. Edit it and review again.",
  sendUnknown:
    "We couldn’t confirm the send. Check the issue on GitHub; the edit is held until its outcome is known.",
} as const;
