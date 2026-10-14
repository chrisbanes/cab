import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
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
import { Button, StatusBadge, isPlainClick } from "./components.js";
import { failureCause } from "./outcome-copy.js";
import {
  leadAwaitingRecoveryNotice,
  leadResumeNotice,
  type LeadFeedbackMode,
} from "./lead-feedback.js";
import { useOperatorResource } from "./resource.js";
import type {
  DraftWrite,
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

type Command = Parameters<OperatorClient["command"]>[0];
type Unconfirmed = NonNullable<LocalReviewState["unconfirmed"]>;

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

/** How each draft write reads when it fails or cannot be confirmed. */
const writeCopy: Record<
  DraftWrite["kind"],
  { what: string; confirmed: string; kept: string }
> = {
  stage: {
    what: "Couldn't capture the exact lines",
    confirmed: "the exact lines were captured",
    kept: "Your comment is kept.",
  },
  add: {
    what: "Couldn't save the comment",
    confirmed: "the comment was saved",
    kept: "Your comment is kept.",
  },
  edit: {
    what: "Couldn't save the change",
    confirmed: "the change was saved",
    kept: "Your text is kept.",
  },
  summary: {
    what: "Couldn't save the summary",
    confirmed: "the summary was saved",
    kept: "Your text is kept.",
  },
  unanchored: {
    what: "Couldn't remove the comments",
    confirmed: "the comments were removed",
    kept: "Your draft is kept.",
  },
  discard: {
    what: "Couldn't clear the draft",
    confirmed: "the draft was cleared",
    kept: "Your draft is kept.",
  },
};

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
  const failure = (result: CommandState, intent: DraftWrite): ReplyOutcome => {
    const { what, confirmed, kept } = writeCopy[intent.kind];
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
        }
      : {
          tone: "error",
          message: `${what}: ${causeOf(result.state === "recorded" ? undefined : result.code)}. ${kept}`,
          details,
        };
  };

  /** A write as the one exact request that a check replays, and the warning that offers it. */
  const unconfirmedWrite = (
    command: Command,
    intent: DraftWrite,
    result?: CommandState,
  ): Unconfirmed => ({
    command,
    intent,
    outcome: failure(
      result?.state === "unknown"
        ? result
        : { state: "unknown", command, code: "command-outcome-unknown" },
      intent,
    ),
  });

  /** Keep a write as the one exact request that the current page's check will replay. */
  const holdUnconfirmed = (
    command: Command,
    intent: DraftWrite,
    result?: CommandState,
  ) => {
    state.unconfirmed = unconfirmedWrite(command, intent, result);
    state.notice = null;
  };

  // A send answered after its page is gone is left for the page that opens next. Every
  // mounted page re-renders from the shared state, so a write settled elsewhere still shows here.
  const alive = useRef(true);
  // The draft write this page is awaiting an answer for, ready to be kept. If the page goes
  // away first, its cleanup keeps that exact request, so the answer that arrives later is ignored.
  const inFlight = useRef<Unconfirmed | null>(null);
  // The next warning to appear takes focus: this page just held a write while no composer form
  // was on screen, so the control the operator used is gone. A warning restored on a later
  // visit never takes it.
  const focusWarning = useRef(false);
  const rerender = useRef(changed);
  rerender.current = changed;
  useEffect(() => {
    alive.current = true;
    const unsubscribe = state.subscribe(() => rerender.current());
    return () => {
      alive.current = false;
      unsubscribe();
      // `pending` stays on: the page that opens next checks this request, which ends it.
      if (inFlight.current) {
        state.unconfirmed = inFlight.current;
        state.notice = null;
        inFlight.current = null;
        state.notify();
      }
      // A send in flight is left unknown for the page that opens next to check.
      if (state.send?.status === "sending") {
        state.send.status = "unknown";
        storeSend(taskId, state.send);
      }
    };
  }, [state, taskId]);

  /**
   * Run a draft write. When its response is lost, or the page that sent it goes away first,
   * the exact request and what it is for are kept as plain data and the controls stay off until
   * the current page's `check` replays it, so a write is never repeated under a new key.
   * Returns false when the answer, or that of a write chained from it, came after this page's
   * cleanup had kept the request: that late answer is ignored, and the state is left to the
   * page that checks it.
   */
  const write = async (
    command: Command,
    intent: DraftWrite,
    // The anchor stage skips the refresh: the save that follows refreshes.
    refreshWhenRecorded = true,
  ): Promise<boolean> => {
    state.pending = true;
    inFlight.current = unconfirmedWrite(command, intent);
    state.notify();
    const result = await execute(command);
    if (inFlight.current?.command !== command) return false;
    inFlight.current = null;
    if (result.state === "unknown") {
      holdUnconfirmed(command, intent, result);
      focusWarning.current = !state.composerShown;
      await resource.refresh();
      state.notify();
      return true;
    }
    state.unconfirmed = null;
    if (refreshWhenRecorded || result.state !== "recorded")
      await resource.refresh();
    // A chained write (the save after a stage) that was ignored settles nothing here.
    if ((await settle(command, intent, result)) === false) return false;
    // The panel stays frozen through the refresh and the settle; only an unconfirmed
    // write (one a settle started) keeps it frozen after that.
    state.pending = state.unconfirmed !== null;
    state.notify();
    return true;
  };

  /** The one success line of a draft write, with the receipt behind it in Details. */
  const succeeded = (
    command: Command,
    result: CommandState,
    message: string,
  ): ReplyOutcome | null =>
    result.state === "recorded"
      ? {
          tone: "success",
          message,
          details: detailRows({
            command: command.type,
            resource: taskId,
            requestKey: command.key,
            kind: result.receipt.kind,
            ...(result.receipt.kind === "local-review-draft"
              ? { version: result.receipt.version }
              : {}),
          }),
        }
      : null;

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
  // Focus waits for the commit that shows the write's outcome: a frame callback can run
  // first, while the target is still disabled or not yet rendered.
  // The gate waits for the latest announced change. `write()` re-notifies in a microtask after
  // `settle`, ahead of React's commit; a `settle` branch that awaits real work would break that.
  const focusLater = (selector: string, fallback?: string) =>
    state.afterRender(() =>
      (
        document.querySelector<HTMLElement>(selector) ??
        (fallback ? document.querySelector<HTMLElement>(fallback) : null)
      )?.focus(),
    );

  const closeComposer = () => {
    // An unconfirmed write keeps its composer until the check settles it.
    if (state.unconfirmed) return;
    const composer = state.composer;
    state.composer = null;
    state.notify();
    // Return to the selected line when it is still rendered, else the origin's
    // button; the trigger may re-render, so prefer live controls.
    state.afterRender(() => {
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
  };

  /** A refused comment write: unlock the composer and say so where the operator can see it. */
  const refuse = (result: CommandState, intent: DraftWrite) => {
    const composer = state.composer;
    const outcome = failure(result, intent);
    if (composer) {
      composer.error = outcome;
      composer.saving = false;
    }
    // Without the composer's form on screen the panel carries the message.
    if (!state.composerShown) state.notice = outcome;
    state.notify();
  };

  /**
   * Settle a draft write by what it was for, using this page's draft and resource. Returns
   * false when it chained a write whose answer was ignored.
   */
  const settle = async (
    command: Command,
    intent: DraftWrite,
    result: CommandState,
  ): Promise<boolean | undefined> => {
    switch (intent.kind) {
      case "stage": {
        if (
          result.state === "recorded" &&
          result.receipt.kind === "local-review-anchor"
        ) {
          // Without this page's draft the stage stays unconfirmed: replaying it is safe.
          if (!draft) {
            holdUnconfirmed(command, intent);
            focusWarning.current = !state.composerShown;
            return;
          }
          return write(
            saveCommand(
              {
                summary: draft.draft.summary,
                comments: [
                  ...draft.draft.comments,
                  {
                    commentId: crypto.randomUUID(),
                    body: intent.body,
                    anchorGroupIds: [result.receipt.groupId],
                  },
                ],
              },
              result.receipt.draftVersion,
            ),
            { kind: "add" },
          );
        }
        // Keep the typed text; an unvalidated anchor is never added.
        refuse(result, intent);
        return;
      }
      case "add": {
        if (result.state === "recorded") {
          state.notice = succeeded(command, result, "Comment added.");
          closeComposer();
          return;
        }
        refuse(result, intent);
        return;
      }
      case "edit": {
        if (result.state === "recorded") delete state.editing[intent.commentId];
        state.notice =
          succeeded(
            command,
            result,
            intent.remove ? "Comment removed." : "Comment updated.",
          ) ?? failure(result, intent);
        state.notify();
        if (result.state !== "recorded") return;
        if (!intent.remove)
          focusLater(`[data-review-edit="${CSS.escape(intent.commentId)}"]`);
        else
          focusLater(
            intent.neighbourId
              ? `[data-comment-id="${CSS.escape(intent.neighbourId)}"]`
              : "#local-review-heading",
            "#local-review-heading",
          );
        return;
      }
      case "summary": {
        if (result.state === "recorded") state.summary = null;
        state.notice =
          succeeded(command, result, "Summary saved.") ??
          failure(result, intent);
        state.notify();
        return;
      }
      case "unanchored": {
        // Open editors of removed comments would otherwise keep Send disabled.
        if (result.state === "recorded")
          for (const id of intent.commentIds) delete state.editing[id];
        state.notice =
          succeeded(
            command,
            result,
            "Comments without line context removed.",
          ) ?? failure(result, intent);
        state.notify();
        return;
      }
      case "discard": {
        if (result.state === "recorded") {
          state.send = null;
          state.inspectKey = null;
          state.editing = {};
          state.summary = null;
          storeSend(taskId, null);
        }
        state.notice =
          succeeded(command, result, "Started a new review.") ??
          failure(result, intent);
        state.notify();
        return;
      }
    }
  };

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
    focusWarning,
    /** Move focus to the check of the unconfirmed write, the first warning in the panel. */
    showWarning() {
      document
        .querySelector<HTMLElement>(
          '#local-review [data-slot="action-outcome"][data-tone="warning"] button',
        )
        ?.focus();
    },
    open(originKey: string, label: string, anchor: ReviewAnchorCandidate) {
      // The composer this replaces takes its refusal with it.
      if (
        state.notice?.tone === "success" ||
        (state.notice && state.notice === state.composer?.error)
      )
        state.notice = null;
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
      state.notify();
    },
    close() {
      closeComposer();
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
      state.notify();
      await write(
        {
          type: "review.anchor.stage",
          key: crypto.randomUUID(),
          taskId,
          expectedDraftVersion: draft.version,
          anchors: [composer.anchor],
        },
        { kind: "stage", body: composer.body.trim() },
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
      await write(unconfirmed.command, unconfirmed.intent);
    },
    /** Drafts saved before the anchor rule can only be sent once these are gone. */
    async removeUnanchoredComments() {
      if (!draft || state.pending) return;
      const unanchored = draft.draft.comments.filter(
        (comment) => comment.anchorGroupIds.length === 0,
      );
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
        { kind: "unanchored", commentIds: unanchored.map((c) => c.commentId) },
      );
    },
    async updateComment(commentId: string, body: string | null) {
      if (!draft || state.pending) return;
      const comments = draft.draft.comments;
      const index = comments.findIndex((c) => c.commentId === commentId);
      const neighbour = comments[index + 1] ?? comments[index - 1];
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
        {
          kind: "edit",
          commentId,
          remove: body === null,
          neighbourId: neighbour?.commentId ?? null,
        },
      );
    },
    cancelEdit(commentId: string) {
      delete state.editing[commentId];
      state.notify();
      focusLater(`[data-review-edit="${CSS.escape(commentId)}"]`);
    },
    async saveSummary() {
      if (!draft || state.summary === null || state.pending) return;
      await write(
        saveCommand(
          { summary: state.summary.trim(), comments: draft.draft.comments },
          draft.version,
        ),
        { kind: "summary" },
      );
    },
    async send() {
      if (!draft || !lead || !leadAccepts(lead) || state.send || state.pending)
        return;
      state.notice = null;
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
      state.notify();
      const result = await execute({
        type: "review.send",
        key: send.key,
        taskId,
        expectedDraftVersion: send.expectedDraftVersion,
        recipientAssignmentId: send.recipientAssignmentId,
        expectedAssignmentVersion: send.expectedAssignmentVersion,
      });
      // Left unknown when the page went away: the page that opens next checks it.
      if (!alive.current) return;
      settleSend(send, result);
      await Promise.all([resource.refresh(), sentList.refresh()]);
      state.notify();
    },
    async reconcile() {
      const send = state.send;
      if (send?.status !== "unknown") return;
      send.status = "sending";
      state.notify();
      // Same key and material only: reconciliation never sends an edited review.
      const result = await execute({
        type: "review.send.reconcile",
        key: send.key,
        taskId,
        expectedDraftVersion: send.expectedDraftVersion,
        recipientAssignmentId: send.recipientAssignmentId,
        expectedAssignmentVersion: send.expectedAssignmentVersion,
      });
      if (!alive.current) return;
      settleSend(send, result);
      await Promise.all([resource.refresh(), sentList.refresh()]);
      state.notify();
    },
    async startNew() {
      if (!draft || state.pending) return;
      await write(
        {
          type: "review.draft.discard",
          key: crypto.randomUUID(),
          taskId,
          expectedDraftVersion: draft.version,
        },
        { kind: "discard" },
      );
    },
    /** Clears the current send state: after a rejection, or to dismiss a recorded send's banner. */
    clearSend() {
      state.send = null;
      storeSend(taskId, null);
      state.notify();
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
  // Every notify re-renders this provider; tell the gate which change that commit shows.
  const revision = props.state.gate.revision;
  useEffect(() => props.state.gate.committed(revision));
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

/** The one action of an unconfirmed draft write: replay its exact request. */
const checkAction = (review: { check: () => Promise<void> }) => ({
  label: "Check whether it saved",
  onClick: () => review.check(),
});

/** Opens the composer for one exact origin; disabled without a valid selection. */
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
  // Stays focusable while a composer is open so Cancel/Save can return focus here. A composer
  // whose form is not on this page does not hold the button: opening one replaces it.
  const composing =
    review.state.composer !== null && review.state.composerShown;
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
  const shown = Boolean(review && composer?.originKey === originKey);
  const state = review?.state;
  // Tell the state this form is on screen, so a message for it is placed here and a
  // composer that is not on this page does not block new comments. A refusal shows in one
  // place: here while the form is on screen, otherwise in the panel. The hand-over runs before
  // paint, so no frame shows the refusal twice or not at all.
  useLayoutEffect(() => {
    if (!shown || !state) return;
    state.composerShown = true;
    if (state.composer?.error && state.notice === state.composer.error)
      state.notice = null;
    state.notify();
    return () => {
      state.composerShown = false;
      if (state.composer?.error && state.notice === null)
        state.notice = state.composer.error;
      state.notify();
    };
  }, [shown, state]);
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
        />
      )}
      {review.state.unconfirmed && (
        <p className="metadata muted" role="status">
          {/* biome-ignore lint/a11y/useValidAnchor: a link to the panel on this page; modified clicks keep the browser's own behaviour. */}
          <a
            href="#local-review"
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              // Stay on this history entry: the check is on this page.
              event.preventDefault();
              review.showWarning();
            }}
          >
            Check whether it saved in Local review.
          </a>
        </p>
      )}
      <div className="task-actions">
        <Button
          type="submit"
          disabled={
            composer.saving || review.state.pending || !composer.body.trim()
          }
        >
          {composer.saving && !review.state.unconfirmed
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
  // A warning that appeared has had its turn at the focus.
  useEffect(() => {
    if (review) review.focusWarning.current = false;
  });
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
                        if (state.notice?.tone === "success")
                          state.notice = null;
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
              if (state.notice?.tone === "success") state.notice = null;
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
      {state.unconfirmed && (
        <ActionOutcome
          // The check lives here, where it stays reachable while the task is open.
          key={state.unconfirmed.command.key}
          tone="warning"
          message={state.unconfirmed.outcome.message}
          details={state.unconfirmed.outcome.details}
          focus={review.focusWarning.current}
          action={checkAction(review)}
        />
      )}
      {!state.unconfirmed && state.notice && (
        <ActionOutcome
          // A new message starts with Details collapsed.
          key={`${state.notice.message}:${state.notice.details.map(([, v]) => v).join()}`}
          tone={state.notice.tone}
          message={state.notice.message}
          details={state.notice.details}
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
