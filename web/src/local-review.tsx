import { createContext, useCallback, useContext } from "react";
import { z } from "zod";
import {
  localReviewDraftReadSchema,
  localReviewListReadSchema,
  localReviewOperationReadSchema,
  retainedReviewAnchorReadSchema,
  type CommandReceipt,
  type Session,
} from "../../src/operator/contracts.js";
import type { CommandState, OperatorClient } from "./api.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import { Button, StatusBadge } from "./components.js";
import { failureCause } from "./outcome-copy.js";
import {
  leadAwaitingRecoveryNotice,
  leadResumeNotice,
  type LeadFeedbackMode,
} from "./lead-feedback.js";
import { useOperatorResource } from "./resource.js";
import type {
  LocalReviewSend,
  LocalReviewState,
  ReplyOutcome,
  ReviewAnchorCandidate,
} from "./task-workspace-state.js";
import { Textarea } from "./ui/textarea.js";

type Lead = {
  assignmentId: string;
  version: number;
  name: string;
  state: string;
  feedbackMode: LeadFeedbackMode;
  awaitingRecoveryMessage: boolean;
};
const leadAccepts = (lead: Lead | null) =>
  lead !== null && lead.feedbackMode !== "unavailable";

// Mirrors LocalReviewSend: sessionStorage is not trusted data.
const storedSendSchema = z
  .object({
    key: z.string().min(1),
    expectedDraftVersion: z.number().int().nonnegative(),
    recipientAssignmentId: z.string().min(1),
    expectedAssignmentVersion: z.number().int().nonnegative(),
    recipientName: z.string(),
    status: z.enum([
      "sending",
      "unknown",
      "recorded",
      "rejected",
      "not-recorded",
    ]),
    reason: z.string().optional(),
    resumedLead: z.literal(true).optional(),
  })
  .strict();

const anchorStatusLabel = {
  current: "Current at last comparison",
  outdated: "Outdated",
  unknown: "Unknown",
  unavailable: "Unavailable",
} as const;
const timeLabel = (value: number) => new Date(value).toLocaleString();
type DraftRead = ReturnType<typeof localReviewDraftReadSchema.parse>["data"];

const sendStorageKey = (taskId: string) =>
  `ensemble:local-review-send:${taskId}`;

/** Frozen send identity survives reload; it carries no comment text. */
function storeSend(taskId: string, send: LocalReviewSend | null) {
  try {
    if (send && (send.status === "sending" || send.status === "unknown"))
      sessionStorage.setItem(sendStorageKey(taskId), JSON.stringify(send));
    else sessionStorage.removeItem(sendStorageKey(taskId));
  } catch {
    // Storage is a convenience; the server operation remains authoritative.
  }
}

function restoredSend(taskId: string): LocalReviewSend | null {
  try {
    const raw = sessionStorage.getItem(sendStorageKey(taskId));
    if (!raw) return null;
    const value = storedSendSchema.safeParse(JSON.parse(raw));
    if (!value.success) return null;
    const { reason, resumedLead: _resumedLead, ...rest } = value.data;
    return { ...rest, status: "unknown", ...(reason ? { reason } : {}) };
  } catch {
    return null;
  }
}

/** Why a draft or send write failed, in plain words; the code itself goes to Details. */
function causeOf(code: string | undefined) {
  switch (code) {
    case "local-review-batch-too-large":
      return "it is too large to send, so shorten or remove comments";
    case "local-review-comment-anchor-required":
      return "a comment has no exact line context, so remove it";
    case "local-review-recipient-unavailable":
      return "the lead can no longer receive a review";
    case "conflict":
      return "the draft changed elsewhere";
    default:
      return failureCause(code ?? "");
  }
}

const sendDetails = (taskId: string, send: LocalReviewSend) =>
  detailRows({
    command: "review.send",
    resource: taskId,
    version: send.expectedDraftVersion,
    requestKey: send.key,
    code: send.reason,
  });

function useLocalReviewController({
  client,
  session,
  taskId,
  state,
  changed,
  lead,
}: {
  client: OperatorClient;
  session: Session;
  taskId: string;
  state: LocalReviewState;
  changed: () => void;
  lead: Lead | null;
}) {
  const draftPath = `/api/operator/tasks/${taskId}/review-draft`;
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(draftPath, localReviewDraftReadSchema, signal),
    [client, draftPath],
  );
  const resource = useOperatorResource(
    `${session.csrfToken}:${draftPath}`,
    loader,
  );
  const draft = resource.state.data?.data ?? null;
  const listPath = `/api/operator/tasks/${taskId}/local-reviews`;
  const listLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(listPath, localReviewListReadSchema, signal),
    [client, listPath],
  );
  const sentList = useOperatorResource(
    `${session.csrfToken}:${listPath}`,
    listLoader,
  );
  if (!state.send) {
    const pending = draft?.pendingOperation;
    const stored = restoredSend(taskId);
    // The server's pending operation wins; a stored identity is used only when
    // no current draft content could be locked by it (e.g. after sign-out).
    const restored =
      (stored &&
      draft &&
      !pending &&
      draft.draft.comments.length === 0 &&
      draft.draft.summary === ""
        ? stored
        : null) ??
      (pending && draft
        ? {
            key: pending.key,
            expectedDraftVersion: draft.version,
            recipientAssignmentId: pending.recipientAssignmentId,
            expectedAssignmentVersion: pending.expectedAssignmentVersion,
            recipientName: lead?.name ?? "the project lead",
            status: "unknown" as const,
          }
        : null);
    if (restored) state.send = restored;
  }

  const execute = async (input: Parameters<OperatorClient["command"]>[0]) =>
    client.command(input, session.csrfToken);
  /**
   * One alert naming the cause and saying the input is kept, or, when the response was lost,
   * one warning whose check replays the exact request. The code sits in Details.
   */
  const failure = (
    result: CommandState,
    what: string,
    confirmed: string,
    kept: string,
  ): ReplyOutcome => {
    const details =
      result.state === "recorded"
        ? []
        : detailRows({
            command: result.command.type,
            resource: taskId,
            requestKey: result.command.key,
            code: result.code,
          });
    return result.state === "unknown"
      ? {
          tone: "warning",
          message: `We couldn't confirm ${confirmed}. ${kept}`,
          details,
          check: true,
        }
      : {
          tone: "error",
          message: `${what}: ${causeOf(result.state === "recorded" ? undefined : result.code)}. ${kept}`,
          details,
        };
  };

  /**
   * Run a draft write. When its response is lost the exact request is kept and the controls
   * stay off until `check` replays it, so an unconfirmed write is never repeated under a new key.
   */
  const write = async (
    command: Parameters<OperatorClient["command"]>[0],
    settle: (result: CommandState) => Promise<void> | void,
    // The anchor stage skips the refresh: the save that follows refreshes.
    refreshWhenRecorded = true,
  ) => {
    state.pending = true;
    const result = await execute(command);
    const lost = result.state === "unknown";
    state.unconfirmed = lost ? { command, settle } : null;
    state.pending = lost;
    if (refreshWhenRecorded || result.state !== "recorded")
      await resource.refresh();
    await settle(result);
  };

  const saveCommand = (
    content: DraftRead["draft"],
    expectedDraftVersion: number,
  ) => ({
    type: "review.draft.save" as const,
    key: crypto.randomUUID(),
    taskId,
    expectedDraftVersion,
    draft: content,
  });
  const focusLater = (selector: string, fallback?: string) =>
    requestAnimationFrame(() =>
      (
        document.querySelector<HTMLElement>(selector) ??
        (fallback ? document.querySelector<HTMLElement>(fallback) : null)
      )?.focus(),
    );

  const settleSend = (send: LocalReviewSend, result: CommandState) => {
    if (result.state === "recorded") {
      const receipt = result.receipt as Extract<
        CommandReceipt,
        { kind: "local-review-operation" }
      >;
      send.status =
        receipt.state === "prepared"
          ? "unknown"
          : (receipt.state as LocalReviewSend["status"]);
      if (receipt.resumedLead) send.resumedLead = true;
      // A receipt settles what an earlier unknown outcome left behind.
      if (send.status !== "unknown") delete send.reason;
    } else if (result.code === "local-review-batch-too-large") {
      // Refused before any operation was recorded.
      send.status = "rejected";
      send.reason = result.code;
    } else if (result.code === "local-review-comment-anchor-required") {
      // Refused before any operation was recorded.
      send.status = "rejected";
      send.reason = result.code;
    } else if (result.code === "local-review-recipient-unavailable") {
      // Definitive: the lead can no longer receive the message, nothing was queued.
      send.status = "rejected";
      send.reason = result.code;
    } else {
      // Without a receipt the send may still have committed; only the same-key
      // reconciliation can confirm delivery or a no-delivery outcome.
      send.status = "unknown";
      send.reason = result.code ?? result.state;
    }
    if (send.status === "recorded") state.inspectKey = send.key;
    storeSend(taskId, send);
  };

  return {
    draft,
    resource,
    sentList,
    lead,
    open(originKey: string, label: string, anchor: ReviewAnchorCandidate) {
      state.composer = {
        originKey,
        label,
        anchor,
        body: "",
        error: null,
        saving: false,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      };
      changed();
    },
    close() {
      // An unconfirmed write keeps its composer until the check settles it.
      if (state.unconfirmed) return;
      const composer = state.composer;
      state.composer = null;
      changed();
      // Return to the selected line when it is still rendered, else the origin's
      // button; the trigger may re-render, so prefer live controls.
      requestAnimationFrame(() => {
        const origin = composer ? CSS.escape(composer.originKey) : null;
        const live = origin
          ? (document.querySelector<HTMLElement>(
              `[data-review-return="${origin}"]`,
            ) ??
            document.querySelector<HTMLElement>(
              `[data-review-origin="${origin}"]`,
            ))
          : null;
        const target = live ?? composer?.returnFocus;
        if (target?.isConnected) target.focus();
      });
    },
    async saveComposer() {
      const composer = state.composer;
      // Another write in flight or awaiting its check keeps its request: no new one starts.
      if (
        !composer ||
        !draft ||
        composer.saving ||
        state.pending ||
        !composer.body.trim()
      )
        return;
      composer.saving = true;
      composer.error = null;
      changed();
      const onSaved = (saved: CommandState) => {
        if (saved.state === "recorded") {
          this.close();
          return;
        }
        composer.error = failure(
          saved,
          "Couldn't save the comment",
          "the comment was saved",
          "Your comment is kept.",
        );
        // An unconfirmed save keeps the composer locked until it is checked.
        if (saved.state !== "unknown") composer.saving = false;
        changed();
      };
      const onStaged = async (staged: CommandState) => {
        if (
          staged.state === "recorded" &&
          staged.receipt.kind === "local-review-anchor"
        ) {
          await write(
            saveCommand(
              {
                summary: draft.draft.summary,
                comments: [
                  ...draft.draft.comments,
                  {
                    commentId: crypto.randomUUID(),
                    body: composer.body.trim(),
                    anchorGroupIds: [staged.receipt.groupId],
                  },
                ],
              },
              staged.receipt.draftVersion,
            ),
            onSaved,
          );
          return;
        }
        // Keep the typed text; an unvalidated anchor is never added.
        composer.error = failure(
          staged,
          "Couldn't capture the exact lines",
          "the exact lines were captured",
          "Your comment is kept.",
        );
        if (staged.state !== "unknown") composer.saving = false;
        changed();
      };
      await write(
        {
          type: "review.anchor.stage",
          key: crypto.randomUUID(),
          taskId,
          expectedDraftVersion: draft.version,
          anchors: [composer.anchor],
        },
        onStaged,
        false,
      );
    },
    /** Replays the exact request of an unconfirmed draft write, never a new one. */
    async check() {
      const unconfirmed = state.unconfirmed;
      if (!unconfirmed) return;
      state.unconfirmed = null;
      state.notice = null;
      if (state.composer) state.composer.error = null;
      changed();
      await write(unconfirmed.command, unconfirmed.settle);
      changed();
    },
    /** Drafts saved before the anchor rule can only be sent once these are gone. */
    async removeUnanchoredComments() {
      if (!draft) return;
      state.pending = true;
      changed();
      await write(
        saveCommand(
          {
            summary: draft.draft.summary,
            comments: draft.draft.comments.filter(
              (comment) => comment.anchorGroupIds.length > 0,
            ),
          },
          draft.version,
        ),
        (result) => {
          // Open editors of removed comments would otherwise keep Send disabled.
          if (result.state === "recorded")
            for (const comment of draft.draft.comments)
              if (comment.anchorGroupIds.length === 0)
                delete state.editing[comment.commentId];
          state.notice =
            result.state === "recorded"
              ? null
              : failure(
                  result,
                  "Couldn't remove the comments",
                  "the comments were removed",
                  "Your draft is kept.",
                );
          changed();
        },
      );
    },
    async updateComment(commentId: string, body: string | null) {
      if (!draft) return;
      const comments = draft.draft.comments;
      const index = comments.findIndex((c) => c.commentId === commentId);
      const neighbour = comments[index + 1] ?? comments[index - 1];
      state.pending = true;
      changed();
      await write(
        saveCommand(
          {
            summary: draft.draft.summary,
            comments: draft.draft.comments.flatMap((comment) =>
              comment.commentId !== commentId
                ? [comment]
                : body === null
                  ? []
                  : [{ ...comment, body: body.trim() }],
            ),
          },
          draft.version,
        ),
        (result) => {
          if (result.state === "recorded") delete state.editing[commentId];
          state.notice =
            result.state === "recorded"
              ? null
              : failure(
                  result,
                  "Couldn't save the change",
                  "the change was saved",
                  "Your text is kept.",
                );
          changed();
          if (result.state !== "recorded") return;
          if (body !== null)
            focusLater(`[data-review-edit="${CSS.escape(commentId)}"]`);
          else
            focusLater(
              neighbour
                ? `[data-comment-id="${CSS.escape(neighbour.commentId)}"]`
                : "#local-review-heading",
              "#local-review-heading",
            );
        },
      );
    },
    cancelEdit(commentId: string) {
      delete state.editing[commentId];
      changed();
      focusLater(`[data-review-edit="${CSS.escape(commentId)}"]`);
    },
    async saveSummary() {
      if (!draft || state.summary === null) return;
      state.pending = true;
      changed();
      await write(
        saveCommand(
          { summary: state.summary.trim(), comments: draft.draft.comments },
          draft.version,
        ),
        (result) => {
          if (result.state === "recorded") state.summary = null;
          state.notice =
            result.state === "recorded"
              ? null
              : failure(
                  result,
                  "Couldn't save the summary",
                  "the summary was saved",
                  "Your text is kept.",
                );
          changed();
        },
      );
    },
    async send() {
      if (!draft || !lead || !leadAccepts(lead) || state.send) return;
      const send: LocalReviewSend = {
        key: crypto.randomUUID(),
        expectedDraftVersion: draft.version,
        recipientAssignmentId: lead.assignmentId,
        expectedAssignmentVersion: lead.version,
        recipientName: lead.name,
        status: "sending",
      };
      state.send = send;
      storeSend(taskId, send);
      changed();
      const result = await execute({
        type: "review.send",
        key: send.key,
        taskId,
        expectedDraftVersion: send.expectedDraftVersion,
        recipientAssignmentId: send.recipientAssignmentId,
        expectedAssignmentVersion: send.expectedAssignmentVersion,
      });
      settleSend(send, result);
      await Promise.all([resource.refresh(), sentList.refresh()]);
      changed();
    },
    async reconcile() {
      const send = state.send;
      if (send?.status !== "unknown") return;
      send.status = "sending";
      changed();
      // Same key and material only: reconciliation never sends an edited review.
      const result = await execute({
        type: "review.send.reconcile",
        key: send.key,
        taskId,
        expectedDraftVersion: send.expectedDraftVersion,
        recipientAssignmentId: send.recipientAssignmentId,
        expectedAssignmentVersion: send.expectedAssignmentVersion,
      });
      settleSend(send, result);
      await Promise.all([resource.refresh(), sentList.refresh()]);
      changed();
    },
    async startNew() {
      if (!draft) return;
      state.pending = true;
      changed();
      await write(
        {
          type: "review.draft.discard",
          key: crypto.randomUUID(),
          taskId,
          expectedDraftVersion: draft.version,
        },
        (result) => {
          if (result.state === "recorded") {
            state.send = null;
            state.inspectKey = null;
            state.editing = {};
            state.summary = null;
            storeSend(taskId, null);
          }
          state.notice =
            result.state === "recorded"
              ? null
              : failure(
                  result,
                  "Couldn't clear the draft",
                  "the draft was cleared",
                  "Your draft is kept.",
                );
          changed();
        },
      );
    },
    /** Clears the current send state: after a rejection, or to dismiss a recorded send's banner. */
    clearSend() {
      state.send = null;
      storeSend(taskId, null);
      changed();
    },
  };
}

type Controller = ReturnType<typeof useLocalReviewController> & {
  state: LocalReviewState;
  changed: () => void;
  client: OperatorClient;
  session: Session;
  taskId: string;
};
const LocalReviewContext = createContext<Controller | null>(null);
export const useLocalReview = () => useContext(LocalReviewContext);

export function LocalReviewProvider({
  children,
  ...props
}: Parameters<typeof useLocalReviewController>[0] & {
  children: React.ReactNode;
}) {
  const controller = useLocalReviewController(props);
  return (
    <LocalReviewContext.Provider
      value={{
        ...controller,
        state: props.state,
        changed: props.changed,
        client: props.client,
        session: props.session,
        taskId: props.taskId,
      }}
    >
      {children}
    </LocalReviewContext.Provider>
  );
}

const frozen = (review: Controller) =>
  review.state.send !== null && review.state.send.status !== "rejected";

/** Opens the composer for one exact origin; disabled without a valid selection. */
/** The one action of an unconfirmed draft write: replay its exact request. */
const checkAction = (review: { check: () => Promise<void> }) => ({
  label: "Check whether it saved",
  onClick: () => review.check(),
});

export function CommentAction({
  originKey,
  label,
  anchor,
}: {
  originKey: string;
  label: string;
  anchor: ReviewAnchorCandidate | null;
}) {
  const review = useLocalReview();
  if (!review) return null;
  // Stays focusable while a composer is open so Cancel/Save can return focus here.
  const composing = review.state.composer !== null;
  return (
    <Button
      variant="secondary"
      disabled={
        !anchor ||
        !review.draft ||
        review.draft.state !== "editable" ||
        frozen(review) ||
        review.state.pending
      }
      aria-disabled={composing || undefined}
      data-review-origin={originKey}
      onClick={() =>
        anchor && !composing && review.open(originKey, label, anchor)
      }
    >
      Add review comment
    </Button>
  );
}

export function ReviewComposer({ originKey }: { originKey: string }) {
  const review = useLocalReview();
  const composer = review?.state.composer;
  if (!review || !composer || composer.originKey !== originKey) return null;
  const { anchor } = composer;
  return (
    <form
      className="review-composer"
      aria-label="Review comment"
      onSubmit={(event) => {
        event.preventDefault();
        void review.saveComposer();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          review.close();
        }
      }}
    >
      <p className="file-observation">
        Comment on {composer.label} · {anchor.repositoryId ?? "task workspace"}/
        {anchor.path} · lines {anchor.startLine}–{anchor.endLine}
        {anchor.side !== "file"
          ? ` · ${anchor.side === "left" ? "Before" : "After"}`
          : ""}
      </p>
      <details>
        <summary>Exact source</summary>
        <dl className="retained-provenance">
          <dt>Context</dt>
          <dd>{anchor.context}</dd>
          {anchor.comparisonId && (
            <>
              <dt>Comparison</dt>
              <dd>{anchor.comparisonId}</dd>
            </>
          )}
          {anchor.resultId && (
            <>
              <dt>Result</dt>
              <dd>
                {anchor.resultId} · item {anchor.resultItemId}
              </dd>
            </>
          )}
          {anchor.turnId && (
            <>
              <dt>Turn</dt>
              <dd>{anchor.turnId}</dd>
            </>
          )}
          <dt>Content</dt>
          <dd>SHA-256 {anchor.contentSha256}</dd>
        </dl>
      </details>
      <label htmlFor={`review-comment-${originKey}`}>Comment</label>
      <Textarea
        id={`review-comment-${originKey}`}
        autoFocus
        autoGrow
        maxLength={4000}
        value={composer.body}
        disabled={composer.saving}
        onChange={(event) => {
          composer.body = event.target.value;
          review.changed();
        }}
      />
      {composer.error && (
        <ActionOutcome
          tone={composer.error.tone}
          message={composer.error.message}
          details={composer.error.details}
          action={composer.error.check ? checkAction(review) : undefined}
        />
      )}
      <div className="task-actions">
        <Button
          type="submit"
          disabled={
            composer.saving || review.state.pending || !composer.body.trim()
          }
        >
          {composer.saving && !composer.error?.check
            ? "Saving comment…"
            : "Save comment"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={composer.saving || review.state.pending}
          onClick={() => review.close()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AnchorContext({ anchorId }: { anchorId: string }) {
  const review = useLocalReview();
  const path = review
    ? `/api/operator/tasks/${review.taskId}/review-anchors/${anchorId}`
    : null;
  const client = review?.client;
  const loader = useCallback(
    (signal: AbortSignal) => {
      if (!client || !path) throw new Error("No review context");
      return client.read(path, retainedReviewAnchorReadSchema, signal);
    },
    [client, path],
  );
  const resource = useOperatorResource(
    review && path ? `${review.session.csrfToken}:${path}` : null,
    loader,
  );
  const data = resource.state.data?.data;
  if (!data)
    return resource.state.error ? (
      <p role="status">Original context could not be read.</p>
    ) : (
      <p role="status">Reading original context…</p>
    );
  if (data.state === "unavailable")
    return (
      <p role="status">
        <StatusBadge>{anchorStatusLabel.unavailable}</StatusBadge> Original
        context is unavailable ({data.reason}). Current bytes are not
        substituted.
      </p>
    );
  const a = data.anchor;
  const excerpt =
    data.state === "available" && data.preview.kind === "text"
      ? data.preview.text
      : null;
  return (
    <div className="review-anchor-context">
      <p className="file-observation">
        {a.repositoryId ?? "task workspace"}/{a.path} · lines {a.startLine}–
        {a.endLine} · {a.context}
        {a.side !== "file"
          ? ` · ${a.side === "left" ? "Before" : "After"}`
          : ""}{" "}
        · <StatusBadge>{anchorStatusLabel[data.status]}</StatusBadge>
        {" · "}
        {a.observedAt
          ? `observed ${timeLabel(a.observedAt)}`
          : `captured ${timeLabel(a.capturedAt)}`}
      </p>
      {excerpt !== null ? (
        <pre className="review-anchor-excerpt">
          <code>{excerpt}</code>
        </pre>
      ) : (
        <p role="status">
          Original excerpt is not available as text
          {data.state === "gap" && a.reason ? ` (${a.reason})` : ""}.
        </p>
      )}
    </div>
  );
}

function SentReview({ operationKey }: { operationKey: string }) {
  const review = useLocalReview();
  const path = review
    ? `/api/operator/tasks/${review.taskId}/local-reviews/${operationKey}`
    : null;
  const client = review?.client;
  const loader = useCallback(
    (signal: AbortSignal) => {
      if (!client || !path) throw new Error("No review context");
      return client.read(path, localReviewOperationReadSchema, signal);
    },
    [client, path],
  );
  const resource = useOperatorResource(
    review && path ? `${review.session.csrfToken}:${path}` : null,
    loader,
  );
  const data = resource.state.data?.data;
  if (!data)
    return resource.state.error ? (
      <p role="status">
        This sent review is unavailable or not authorised. Current drafts are
        not substituted.
      </p>
    ) : (
      <p role="status">Reading sent review…</p>
    );
  const groups = new Map((data.groups ?? []).map((g) => [g.groupId, g]));
  return (
    <section className="sent-review" aria-label="Sent review">
      <p>
        Review {data.reviewId} · <StatusBadge>{data.state}</StatusBadge>
        {data.recordedAt ? ` · recorded ${timeLabel(data.recordedAt)}` : ""}
        {data.eventId ? ` · event ${data.eventId}` : ""}
      </p>
      {data.summary === null ? (
        <p>Summary withheld under current access.</p>
      ) : (
        data.summary && <p>Summary: {data.summary}</p>
      )}
      <ol className="review-comments">
        {(data.comments ?? []).map((comment) => (
          <li key={comment.commentId}>
            <p>{comment.body ?? "Comment withheld under current access."}</p>
            {comment.anchorGroupIds.flatMap((groupId) =>
              (groups.get(groupId)?.anchors ?? []).map((anchor) =>
                anchor.state === "unavailable" ? (
                  <p key={anchor.anchorId} role="status">
                    Original context unavailable ({anchor.reason}).
                  </p>
                ) : (
                  <AnchorContext
                    key={anchor.anchorId}
                    anchorId={anchor.anchorId}
                  />
                ),
              ),
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Earlier sent reviews of this task; each stays inspectable after Start a new review. */
function SentReviews() {
  const review = useLocalReview();
  if (!review) return null;
  const { sentList, state, lead } = review;
  const reviews = sentList.state.data?.data.reviews ?? [];
  if (reviews.length === 0)
    return sentList.state.error && !sentList.state.data ? (
      <p className="muted" role="status">
        Earlier sent reviews could not be listed.
      </p>
    ) : null;
  return (
    <section aria-label="Sent reviews">
      <h4>Sent reviews</h4>
      <ul className="review-comments">
        {reviews.map((item) => (
          <li key={item.operationId}>
            <p>
              {timeLabel(item.recordedAt)} · to{" "}
              {lead?.assignmentId === item.recipientAssignmentId
                ? lead.name
                : `assignment ${item.recipientAssignmentId}`}{" "}
              · review {item.reviewId}
            </p>
            <Button
              variant="secondary"
              aria-label={`Inspect review ${item.reviewId}`}
              aria-pressed={state.inspectKey === item.operationId}
              onClick={() => {
                state.inspectKey =
                  state.inspectKey === item.operationId
                    ? null
                    : item.operationId;
                review.changed();
              }}
            >
              Inspect
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The complete draft, its named destination and the one logical send. */
export function LocalReviewPanel() {
  const review = useLocalReview();
  const draft = review?.draft;
  const state = review?.state;
  if (!review || !state) return null;
  const send = state.send;
  const locked = frozen(review) || draft?.state !== "editable";
  const groupAnchors = new Map(
    (draft?.groups ?? []).map((group) => [group.groupId, group.anchorIds]),
  );
  const comments = draft?.draft.comments ?? [];
  const unanchored = comments.some(
    (comment) => comment.anchorGroupIds.length === 0,
  );
  return (
    <section id="local-review" aria-labelledby="local-review-heading">
      <h3 id="local-review-heading" className="section-heading" tabIndex={-1}>
        Local review
      </h3>
      <p>
        Select lines in Files, Changes or retained evidence, then add review
        comments. The review is sent as one local message to the named project
        lead. It does not post to GitHub, approve, merge or clear holds.
      </p>
      {draft?.unsentDraftLost && (
        <p role="status">
          An unsent draft was removed when its session ended or its access
          changed. It cannot be recovered here.
        </p>
      )}
      {review.resource.state.error && !draft && (
        <p role="alert">The review draft could not be read. Retry later.</p>
      )}
      {draft && comments.length === 0 && !send && (
        <p>No review comments yet.</p>
      )}
      {comments.length > 0 && (
        <ol className="review-comments" aria-label="Review comments">
          {comments.map((comment) => {
            const editing = state.editing[comment.commentId];
            return (
              <li
                key={comment.commentId}
                data-comment-id={comment.commentId}
                tabIndex={-1}
              >
                {comment.anchorGroupIds.flatMap((groupId) =>
                  (groupAnchors.get(groupId) ?? []).map((anchorId) => (
                    <AnchorContext key={anchorId} anchorId={anchorId} />
                  )),
                )}
                {editing === undefined ? (
                  <p>{comment.body}</p>
                ) : (
                  <>
                    <label htmlFor={`edit-${comment.commentId}`}>
                      Edit comment
                    </label>
                    <Textarea
                      id={`edit-${comment.commentId}`}
                      autoFocus
                      autoGrow
                      maxLength={4000}
                      value={editing}
                      disabled={state.pending}
                      onChange={(event) => {
                        state.editing[comment.commentId] = event.target.value;
                        review.changed();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          review.cancelEdit(comment.commentId);
                        }
                      }}
                    />
                  </>
                )}
                {!locked && (
                  <div className="task-actions">
                    {editing === undefined ? (
                      <Button
                        variant="secondary"
                        data-review-edit={comment.commentId}
                        disabled={state.pending}
                        onClick={() => {
                          state.editing[comment.commentId] = comment.body;
                          review.changed();
                        }}
                      >
                        Edit
                      </Button>
                    ) : (
                      <>
                        <Button
                          disabled={state.pending || !editing.trim()}
                          onClick={() =>
                            void review.updateComment(
                              comment.commentId,
                              editing,
                            )
                          }
                        >
                          Save edit
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={state.pending}
                          onClick={() => review.cancelEdit(comment.commentId)}
                        >
                          Cancel edit
                        </Button>
                      </>
                    )}
                    <Button
                      variant="secondary"
                      disabled={state.pending}
                      onClick={() =>
                        void review.updateComment(comment.commentId, null)
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {draft && (comments.length > 0 || draft.draft.summary) && (
        <>
          <label htmlFor="local-review-summary">Summary (optional)</label>
          <Textarea
            id="local-review-summary"
            autoGrow
            maxLength={4000}
            disabled={locked || state.pending}
            value={state.summary ?? draft.draft.summary}
            onChange={(event) => {
              state.summary = event.target.value;
              review.changed();
            }}
          />
          {!locked && state.summary !== null && (
            <Button
              variant="secondary"
              disabled={state.pending}
              onClick={() => void review.saveSummary()}
            >
              Save summary
            </Button>
          )}
        </>
      )}
      {state.notice && (
        <ActionOutcome
          // A new message starts with Details collapsed.
          key={`${state.notice.message}:${state.notice.details.map(([, v]) => v).join()}`}
          tone={state.notice.tone}
          message={state.notice.message}
          details={state.notice.details}
          action={state.notice.check ? checkAction(review) : undefined}
        />
      )}
      {draft && comments.length > 0 && !send && (
        <div className="review-send">
          <p>
            Destination:{" "}
            {review.lead
              ? `${review.lead.name} (project lead · assignment ${review.lead.assignmentId})`
              : "no project lead assignment is available"}
          </p>
          <Button
            disabled={
              !leadAccepts(review.lead) ||
              unanchored ||
              locked ||
              state.pending ||
              state.summary !== null ||
              Object.keys(state.editing).length > 0
            }
            onClick={() => void review.send()}
          >
            Send review ({comments.length} comment
            {comments.length === 1 ? "" : "s"})
          </Button>
          {review.lead?.feedbackMode === "resumes" && (
            <p role="status">{leadResumeNotice(review.lead.name)}</p>
          )}
          {review.lead?.awaitingRecoveryMessage &&
            review.lead.feedbackMode !== "resumes" && (
              <p role="status">
                {leadAwaitingRecoveryNotice(review.lead.name)}
              </p>
            )}
          {review.lead && !leadAccepts(review.lead) && (
            <p role="status">
              The project lead's assignment is {review.lead.state} and cannot
              receive a review. Your comments stay in the draft.
            </p>
          )}
          {unanchored && (
            <div role="status">
              <p>
                A comment saved before line context was required has none.
                Remove it to edit or send this review.
              </p>
              <Button
                variant="secondary"
                disabled={locked || state.pending}
                onClick={() => void review.removeUnanchoredComments()}
              >
                Remove comments without line context
              </Button>
            </div>
          )}
          {(state.summary !== null ||
            Object.keys(state.editing).length > 0) && (
            <p className="muted">Save or cancel open edits before sending.</p>
          )}
        </div>
      )}
      {draft?.state === "sending" && !send && (
        <p role="status">
          A review send for this draft is unsettled and its operation is not
          known in this browser. The draft stays frozen; it is never resent.
        </p>
      )}
      {send?.status === "sending" && (
        <p role="status">Sending review to {send.recipientName}…</p>
      )}
      {send?.status === "unknown" && (
        <ActionOutcome
          tone="warning"
          message={`We couldn't confirm the review reached ${send.recipientName}. Your draft is kept.`}
          action={{
            label: "Check whether it saved",
            onClick: () => review.reconcile(),
          }}
          details={sendDetails(review.taskId, send)}
        />
      )}
      {send &&
        (send.status === "rejected" || send.status === "not-recorded") && (
          <ActionOutcome
            tone="error"
            message={`The review wasn't sent${
              send.reason ? `: ${causeOf(send.reason)}` : ""
            }. Your comments are kept.`}
            action={{
              label: "Return to draft",
              onClick: () => review.clearSend(),
            }}
            details={sendDetails(review.taskId, send)}
          />
        )}
      {send?.status === "recorded" && (
        <ActionOutcome
          tone="success"
          message={
            send.resumedLead
              ? `Review sent to ${send.recipientName}. ${send.recipientName} was resumed with this review as a follow-up.`
              : `Review sent to ${send.recipientName}.`
          }
          details={sendDetails(review.taskId, send)}
        >
          {draft?.state !== "sent" && (
            <Button variant="secondary" onClick={() => review.clearSend()}>
              Dismiss
            </Button>
          )}
        </ActionOutcome>
      )}
      <SentReviews />
      {state.inspectKey && <SentReview operationKey={state.inspectKey} />}
      {draft?.state === "sent" && (
        <Button
          variant="secondary"
          disabled={state.pending}
          onClick={() => void review.startNew()}
        >
          Start a new review
        </Button>
      )}
    </section>
  );
}
