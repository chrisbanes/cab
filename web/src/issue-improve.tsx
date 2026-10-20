import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CommandReceipt,
  draftingRunReadSchema,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import { ClientError, type OperatorClient } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import type { IssueDraftStart } from "./composer-release.js";
import {
  issueImproveCopy as copy,
  type DeliveryState,
  type DiffRow,
  emptyStored,
  type IssueDraftRun,
  type IssueEditPolicy,
  type IssueEditReview,
  type IssueImproveView,
  type IssueText,
  improveView,
  isOpenState,
  issueBodyLimit,
  issueImprovePollMs,
  issueNoteLimit,
  issueTitleLimit,
  lineDiff,
  readStored,
  reviewBlock,
  type Stored,
  staleProviderReason,
  writeStored,
} from "./issue-improve-model.js";
import { Input } from "./ui/input.js";
import { Textarea } from "./ui/textarea.js";
import "./issue-improve.css";

/** Reaching `sessionStorage` itself throws when site data is blocked; the panel then keeps its state in memory. */
const sessionStore = {
  getItem: (key: string) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {}
  },
  removeItem: (key: string) => {
    try {
      sessionStorage.removeItem(key);
    } catch {}
  },
};

export type Outcome<T = undefined> =
  | { state: "recorded"; receipt: T }
  | { state: "unknown" }
  | { state: "conflict" }
  | { state: "rejected"; code: string };

/**
 * The service calls the panel needs. The task page adapts the operator client to this, so
 * the panel does not depend on the command union directly.
 */
export interface IssueImprovePort {
  readRun(
    runId: string,
    signal: AbortSignal,
  ): Promise<
    { state: "ok"; run: IssueDraftRun } | { state: "not-found" | "error" }
  >;
  startRun(input: {
    key: string;
    runId: string;
    taskId: string;
    note: string;
    expectedTaskVersion: number;
  }): Promise<Outcome>;
  stopRun(runId: string): Promise<Outcome>;
  settleRun(runId: string, disposition: "accept" | "discard"): Promise<Outcome>;
  review(input: {
    key: string;
    runId: string;
    operationId: string;
    expectedTaskVersion: number;
    title: string;
    body: string;
  }): Promise<Outcome<IssueEditReview>>;
  confirm(input: {
    key: string;
    reviewId: string;
    expectedRevision: number;
    materialHash: string;
  }): Promise<Outcome<IssueEditReview>>;
  send(input: {
    key: string;
    reviewId: string;
    expectedTaskVersion: number;
  }): Promise<Outcome<{ state: DeliveryState; reason: string | null }>>;
}

const labels: Record<
  IssueImproveView,
  [string, "idle" | "warning" | "success" | "error" | "neutral"]
> = {
  unavailable: ["Unavailable", "idle"],
  idle: ["Ready", "idle"],
  starting: ["Starting", "idle"],
  queued: ["Waiting", "idle"],
  running: ["Drafting", "warning"],
  stopping: ["Stopping", "warning"],
  withheld: ["Draft withheld", "error"],
  interrupted: ["Draft interrupted", "warning"],
  failed: ["Draft failed", "error"],
  editing: ["Draft ready", "success"],
  reviewing: ["Reviewing", "neutral"],
  sending: ["Sending", "warning"],
  held: ["Held", "warning"],
  sent: ["Sent", "success"],
  stale: ["Issue changed", "warning"],
  "send-failed": ["Not sent", "error"],
};

const newKeys = () => ({
  reviewKey: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  confirmKey: crypto.randomUUID(),
});

/** Hands a run on to the app's durable release; see `useDraftReleases`. */
export type ReleaseRun = (runId: string, start?: IssueDraftStart) => void;

/** Whether the panel has work to show again after a reload: a draft, an edit or an unsettled send. */
export function hasImproveWork(taskId: string, policy: IssueEditPolicy) {
  const stored = readStored(sessionStore, taskId);
  return Boolean(
    stored.runId ||
      stored.edit ||
      stored.sentOperationId ||
      (policy.latest && isOpenState(policy.latest.state)),
  );
}

export function useIssueImprove({
  taskId,
  taskVersion,
  policy,
  port,
  releaseRun,
  onChanged,
}: {
  taskId: string;
  taskVersion: number;
  policy: IssueEditPolicy;
  port: IssueImprovePort;
  releaseRun: ReleaseRun;
  /** Rereads the task so `policy.latest` and the synced copy are current. */
  onChanged: () => void;
}) {
  const [stored, setStored] = useState<Stored>(() =>
    readStored(sessionStore, taskId),
  );
  const [run, setRun] = useState<IssueDraftRun | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [staleFlag, setStaleFlag] = useState(false);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const replayed = useRef(new Set<string>());
  const latest = useRef({ stored, onChanged, taskVersion });
  latest.current = { stored, onChanged, taskVersion };

  const change = useCallback(
    (patch: Partial<Stored>) => {
      setStored((current) => {
        const next = { ...current, ...patch };
        writeStored(sessionStore, taskId, next);
        return next;
      });
    },
    [taskId],
  );
  const reset = useCallback(
    (note = "") => {
      setRun(null);
      setNotFound(false);
      setStaleFlag(false);
      setSendFailure(null);
      setStored(emptyStored);
      writeStored(sessionStore, taskId, emptyStored);
      setMessage(note);
    },
    [taskId],
  );

  const runId = stored.runId ?? null;
  const settled = Boolean(
    run && !["queued", "running", "stopping"].includes(run.state),
  );

  // Poll an unsettled run; a settled one is read once.
  const readRun = useCallback(
    async (signal: AbortSignal) => {
      if (!runId) return;
      const result = await port.readRun(runId, signal);
      if (signal.aborted) return;
      if (result.state === "ok") {
        setRun(result.run);
        setNotFound(false);
      } else if (result.state === "not-found") setNotFound(true);
    },
    [port, runId],
  );
  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    const abort = new AbortController();
    void readRun(abort.signal);
    if (settled) return () => abort.abort();
    const timer = setInterval(
      () => void readRun(abort.signal),
      issueImprovePollMs,
    );
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [readRun, runId, settled]);
  useEffect(() => {
    if (run?.state !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.state]);

  const sendStart = useCallback(
    async (id: string, key: string, note: string, version: number) => {
      const result = await port.startRun({
        key,
        runId: id,
        taskId,
        note,
        expectedTaskVersion: version,
      });
      if (result.state === "recorded") return;
      if (result.state === "unknown") setMessage(copy.unconfirmed);
      else {
        reset(
          result.state === "conflict"
            ? "The task changed. Try again."
            : "Couldn’t start the draft.",
        );
      }
    },
    [port, reset, taskId],
  );

  // A run the service does not know may be a start that never arrived: send it once more
  // under its key; if it is still unknown, the durable release ends it wherever it landed.
  useEffect(() => {
    if (!notFound || !runId || !stored.startKey) return;
    const { note, expectedTaskVersion } = latest.current.stored;
    if (!replayed.current.has(runId)) {
      replayed.current.add(runId);
      void sendStart(
        runId,
        stored.startKey,
        note,
        expectedTaskVersion ?? taskVersion,
      );
      return;
    }
    releaseRun(runId, {
      key: stored.startKey,
      taskId,
      note,
      expectedTaskVersion: expectedTaskVersion ?? taskVersion,
    });
    reset(copy.gone);
  }, [
    notFound,
    runId,
    stored.startKey,
    sendStart,
    releaseRun,
    reset,
    taskId,
    taskVersion,
  ]);

  // A proposal fills the editor once; it is then claimed so it is not kept on the service.
  useEffect(() => {
    if (
      run?.state !== "proposed" ||
      run.proposalWithheld ||
      !run.proposal ||
      stored.loadedRunId === run.runId
    )
      return;
    change({
      edit: { title: run.proposal.title, body: run.proposal.body },
      loadedRunId: run.runId,
      review: undefined,
    });
    setStaleFlag(false);
    setSendFailure(null);
    // A failed claim is harmless: the unclaimed draft expires on its own.
    void port.settleRun(run.runId, "accept");
  }, [run, stored.loadedRunId, change, port]);
  // A run that is gone or used elsewhere releases the panel, keeping any text in the editor.
  useEffect(() => {
    if (!run || stored.edit) return;
    if (run.state === "expired") reset(copy.expired);
    else if (run.state === "accepted" || run.state === "discarded")
      reset(copy.gone);
  }, [run, stored.edit, reset]);

  const start = async () => {
    const id = crypto.randomUUID();
    const key = crypto.randomUUID();
    const note = stored.note;
    setMessage("");
    setRun(null);
    setNotFound(false);
    setStaleFlag(false);
    setSendFailure(null);
    // Stored with its key before it is sent, so a reload reattaches to a run that did start.
    change({
      runId: id,
      startKey: key,
      expectedTaskVersion: taskVersion,
      loadedRunId: undefined,
      review: undefined,
      sentOperationId: undefined,
    });
    setBusy(true);
    await sendStart(id, key, note, taskVersion);
    setBusy(false);
  };
  const stop = async () => {
    if (!runId) return;
    setBusy(true);
    const result = await port.stopRun(runId);
    setBusy(false);
    if (result.state !== "recorded")
      setMessage("Couldn’t stop the draft. Try again.");
  };
  /** Ends the run wherever it is and clears the editor. */
  const discard = () => {
    if (runId) releaseRun(runId);
    reset();
  };

  const edit: IssueText = stored.edit ?? { title: "", body: "" };
  const editText = (patch: Partial<IssueText>) => {
    // A changed text is a different edit: its review and keys are dropped.
    change({ edit: { ...edit, ...patch }, review: undefined });
    setStaleFlag(false);
    setSendFailure(null);
  };
  const block = reviewBlock(edit, null);

  const review = async () => {
    if (block || !runId) return;
    const title = edit.title.trim();
    const same =
      stored.review?.title === title && stored.review.body === edit.body;
    const keys = same && stored.review ? stored.review : newKeys();
    change({
      review: {
        ...keys,
        title,
        body: edit.body,
        receipt: stored.review?.receipt,
      },
    });
    setBusy(true);
    setMessage("");
    const result = await port.review({
      key: keys.reviewKey,
      runId,
      operationId: keys.operationId,
      expectedTaskVersion: taskVersion,
      title,
      body: edit.body,
    });
    setBusy(false);
    if (result.state === "recorded") {
      const r = result.receipt;
      if (
        r.reviewId !== keys.reviewKey ||
        r.operationId !== keys.operationId ||
        r.proposed.title !== title ||
        r.proposed.body !== edit.body
      ) {
        setMessage(copy.sendUnknown);
        return;
      }
      change({
        review: {
          ...keys,
          title,
          body: edit.body,
          receipt: {
            reviewId: r.reviewId,
            revision: r.revision,
            materialHash: r.materialHash,
            decision: r.decision,
            current: r.current,
            proposed: r.proposed,
          },
        },
      });
      return;
    }
    change({ review: undefined });
    if (result.state === "conflict") setStaleFlag(true);
    else if (result.state === "rejected")
      setMessage(
        result.code === "forbidden"
          ? copy.refusedDisclosure
          : `Couldn’t review the changes (${result.code}).`,
      );
    else setMessage("We couldn’t confirm the review. Try again.");
  };
  const backToEditing = () => change({ review: undefined });

  /** Approving is part of sending: one click confirms the review, then sends it. */
  const send = async () => {
    const pending = stored.review;
    const receipt = pending?.receipt;
    if (!pending || !receipt || sending) return;
    setSending(true);
    setMessage("");
    try {
      let approved = receipt;
      if (receipt.decision !== "approved") {
        const confirmed = await port.confirm({
          key: pending.confirmKey,
          reviewId: receipt.reviewId,
          expectedRevision: receipt.revision,
          materialHash: receipt.materialHash,
        });
        if (
          confirmed.state !== "recorded" ||
          confirmed.receipt.reviewId !== receipt.reviewId ||
          confirmed.receipt.materialHash !== receipt.materialHash ||
          confirmed.receipt.decision !== "approved"
        ) {
          if (confirmed.state === "conflict") {
            change({ review: undefined });
            setMessage("The task changed. Review the changes again.");
          } else setMessage(copy.sendUnknown);
          return;
        }
        approved = { ...receipt, ...confirmed.receipt };
        change({
          review: {
            ...pending,
            receipt: {
              ...receipt,
              revision: confirmed.receipt.revision,
              decision: "approved",
            },
          },
        });
      }
      const sent = await port.send({
        key: pending.operationId,
        reviewId: approved.reviewId,
        expectedTaskVersion: latest.current.taskVersion,
      });
      if (sent.state === "unknown") {
        setMessage(copy.sendUnknown);
        change({ sentOperationId: pending.operationId });
      } else if (sent.state === "recorded") {
        change({ sentOperationId: pending.operationId });
        const { state, reason } = sent.receipt;
        if (state === "confirmed-success") {
          change({
            edit: undefined,
            review: undefined,
            runId: undefined,
            startKey: undefined,
          });
        } else if (state === "confirmed-failure" || state === "denied") {
          if (reason === staleProviderReason) setStaleFlag(true);
          else setSendFailure(reason ?? "GitHub refused the edit.");
        }
      } else if (sent.state === "conflict") {
        change({ review: undefined });
        setMessage("The task changed. Review the changes again.");
      } else setMessage(`The edit wasn’t sent (${sent.code}).`);
      latest.current.onChanged();
    } finally {
      setSending(false);
    }
  };
  /** Leaves the settled outcome of a send behind and returns to a fresh panel. */
  const dismissOutcome = () => reset();
  const retry = () => {
    setSendFailure(null);
    change({ review: undefined, sentOperationId: undefined });
  };

  const view = improveView({
    policy,
    ownOperationId:
      stored.sentOperationId ?? stored.review?.operationId ?? null,
    runId,
    run,
    runLoaded: stored.loadedRunId === runId,
    hasEdit: Boolean(stored.edit),
    hasReview: Boolean(stored.review?.receipt),
    sending,
    staleFlag,
    sendFailure: sendFailure !== null,
  });
  return {
    view,
    stored,
    run,
    edit,
    block,
    busy,
    sending,
    message,
    sendFailure,
    elapsed: run ? Math.max(0, (now - run.createdAt) / 1000) : 0,
    setNote: (note: string) => change({ note }),
    editText,
    start,
    stop,
    discard,
    review,
    backToEditing,
    send,
    dismissOutcome,
    retry,
  };
}

export type IssueImprove = ReturnType<typeof useIssueImprove>;

function DiffColumn({ label, rows }: { label: string; rows: DiffRow[] }) {
  return (
    <div className="issue-improve-diff-column">
      <span className="metadata muted issue-improve-diff-label">{label}</span>
      <div className="issue-improve-diff-rows">
        {rows.map((row, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reordered.
            key={index}
            className="issue-improve-diff-row"
            data-kind={row.kind}
          >
            <span aria-hidden="true" className="issue-improve-diff-mark">
              {row.kind === "removed" ? "−" : row.kind === "added" ? "+" : ""}
            </span>
            <span className="issue-improve-diff-text">
              {row.kind === "removed" ? (
                <span className="issue-improve-sr">Removed: </span>
              ) : null}
              {row.kind === "added" ? (
                <span className="issue-improve-sr">Added: </span>
              ) : null}
              {row.text || " "}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Compare({
  name,
  current,
  proposed,
}: {
  name: string;
  current: string;
  proposed: string;
}) {
  const diff = lineDiff(current, proposed);
  return (
    <div className="issue-improve-compare">
      <span className="body issue-improve-strong">{name}</span>
      <div className="issue-improve-diff">
        <DiffColumn label="Current on GitHub" rows={diff.current} />
        <DiffColumn label="Proposed" rows={diff.proposed} />
      </div>
    </div>
  );
}

const formatClock = (seconds: number) => {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** The Improve with lead panel of an imported task. */
export function IssueImprovePanel({
  s,
  policy,
  leadName,
}: {
  s: IssueImprove;
  policy: IssueEditPolicy;
  leadName: string;
}) {
  const [label, tone] = labels[s.view];
  const { view, run } = s;
  const lead = run?.leadName ?? leadName;
  const receipt = s.stored.review?.receipt;
  const latest = policy.latest;
  return (
    <section className="issue-improve" aria-labelledby="issue-improve-heading">
      <div className="issue-improve-head">
        <h2 id="issue-improve-heading" className="small-heading">
          Improve with lead
        </h2>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </div>

      {view === "unavailable" && (
        <p className="body" role="status">
          {policy.reason ?? "Improve with lead isn’t available for this task."}
        </p>
      )}

      {(view === "idle" || view === "unavailable") && (
        <>
          <p className="body muted">{copy.intro}</p>
          <label className="field body" htmlFor="issue-improve-note">
            Note for {lead} (optional)
            <Textarea
              id="issue-improve-note"
              className="control"
              rows={2}
              autoGrow
              maxLength={issueNoteLimit}
              value={s.stored.note}
              disabled={view === "unavailable"}
              onChange={(e) => s.setNote(e.target.value)}
            />
            <span className="metadata muted">
              {s.stored.note.length.toLocaleString("en")} of{" "}
              {issueNoteLimit.toLocaleString("en")} characters.
            </span>
          </label>
          <div className="issue-improve-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={view === "unavailable" || s.busy}
              onClick={() => void s.start()}
            >
              Improve with lead
            </Button>
          </div>
          <p className="metadata muted">{copy.capacity}</p>
          <p className="metadata muted">{copy.access}</p>
        </>
      )}

      {view === "starting" && (
        <p className="body" role="status">
          Starting the draft…
        </p>
      )}

      {(view === "queued" || view === "running" || view === "stopping") && (
        <>
          <div
            className="issue-improve-actions issue-improve-between"
            role="status"
          >
            <span className="issue-improve-progress">
              <span className="body">
                {view === "queued"
                  ? "Waiting to start. A draft waits for capacity, and for a paused project to resume."
                  : view === "stopping"
                    ? "Stopping. The draft ends when the runtime is seen to stop."
                    : `${lead} is reading the repositories`}
              </span>
              {view === "running" && (
                <span className="metadata muted">
                  Requested {formatClock(s.elapsed)} ago · stops by itself after
                  10:00 of running
                </span>
              )}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={s.busy}
              onClick={() => void s.stop()}
            >
              {view === "stopping" ? "Stop again" : "Stop"}
            </Button>
          </div>
          <p className="metadata muted">
            A draft never changes the issue. Stopping ends the run and deletes
            its working copy.
          </p>
        </>
      )}

      {(view === "interrupted" || view === "failed" || view === "withheld") && (
        <>
          <div className="issue-improve-progress" role="alert">
            <span className="body issue-improve-strong">
              {view === "withheld"
                ? copy.withheld
                : (run?.reason ??
                  (view === "failed"
                    ? "The draft failed"
                    : "The draft was interrupted"))}
            </span>
            {view !== "withheld" && (
              <span className="body muted">
                {view === "failed" ? copy.failed : copy.interrupted}
              </span>
            )}
          </div>
          <div className="issue-improve-actions">
            {view !== "withheld" && (
              <Button
                type="button"
                variant="secondary"
                disabled={s.busy}
                onClick={() => void s.start()}
              >
                Retry
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={s.discard}>
              {view === "withheld" ? "Discard draft" : "Dismiss"}
            </Button>
          </div>
        </>
      )}

      {view === "editing" && (
        <>
          <p className="body" role="status">
            {lead}’s draft is ready. Edit it, then review the changes. The draft
            is kept for 24 hours.
          </p>
          <EditFields s={s} />
          {s.block && <p className="metadata muted">{s.block}</p>}
          <div className="issue-improve-actions">
            <Button
              type="button"
              disabled={Boolean(s.block) || s.busy}
              onClick={() => void s.review()}
            >
              Review changes
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={s.busy}
              onClick={() => void s.start()}
            >
              Redraft
            </Button>
            <Button type="button" variant="secondary" onClick={s.discard}>
              Discard draft
            </Button>
          </div>
        </>
      )}

      {(view === "reviewing" || view === "sending") && receipt && (
        <>
          <p className="body" role="status">
            {view === "sending"
              ? "Sending to GitHub…"
              : "Review the full replacement. Nothing has been sent."}
          </p>
          <Compare
            name="Title"
            current={receipt.current.title}
            proposed={receipt.proposed.title}
          />
          <Compare
            name="Body"
            current={receipt.current.body}
            proposed={receipt.proposed.body}
          />
          <div className="issue-improve-note" role="note">
            <span aria-hidden="true">!</span>
            <span className="body">{copy.irreversible}</span>
          </div>
          <p className="metadata muted">{copy.guard}</p>
          <div className="issue-improve-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={s.sending}
              onClick={s.backToEditing}
            >
              Back to editing
            </Button>
            <Button
              type="button"
              disabled={s.sending}
              onClick={() => void s.send()}
            >
              Send edit to GitHub
            </Button>
          </div>
        </>
      )}

      {view === "stale" && (
        <>
          <p className="body" role="alert">
            {copy.stale}
          </p>
          {s.stored.edit && <EditFields s={s} readOnly />}
          <div className="issue-improve-actions">
            <Button
              type="button"
              disabled={s.busy}
              onClick={() => void s.start()}
            >
              Redraft
            </Button>
            <Button type="button" variant="secondary" onClick={s.discard}>
              Discard draft
            </Button>
          </div>
        </>
      )}

      {view === "send-failed" && (
        <>
          <div className="issue-improve-progress" role="alert">
            <span className="body issue-improve-strong">
              The edit wasn’t sent. Nothing changed on GitHub.
            </span>
            <span className="body muted">
              {s.sendFailure ?? latest?.reason ?? "GitHub refused the edit."}
            </span>
          </div>
          <div className="issue-improve-actions">
            <Button type="button" onClick={s.retry}>
              Review again
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={s.dismissOutcome}
            >
              Dismiss
            </Button>
          </div>
        </>
      )}

      {view === "held" && (
        <>
          <p className="body" role="alert">
            {latest?.state === "uncertain" ? copy.held : copy.heldPending}
          </p>
          <p className="metadata muted">
            Another edit waits until this one is resolved. There is no resend.
          </p>
        </>
      )}

      {view === "sent" && (
        <>
          <p className="body" role="status">
            {copy.sent}
          </p>
          <div className="issue-improve-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={s.dismissOutcome}
            >
              Done
            </Button>
          </div>
        </>
      )}

      {s.message && (
        <p className="body" role="status">
          {s.message}
        </p>
      )}
    </section>
  );
}

function EditFields({
  s,
  readOnly = false,
}: {
  s: IssueImprove;
  readOnly?: boolean;
}) {
  return (
    <>
      <label className="field body" htmlFor="issue-improve-title">
        Title
        <Input
          id="issue-improve-title"
          className="control"
          value={s.edit.title}
          maxLength={issueTitleLimit * 2}
          readOnly={readOnly}
          onChange={(e) => s.editText({ title: e.target.value })}
        />
        <span className="metadata muted">
          {s.edit.title.trim().length} of {issueTitleLimit} characters
        </span>
      </label>
      <label className="field body" htmlFor="issue-improve-body">
        Body
        <Textarea
          id="issue-improve-body"
          className="control"
          rows={8}
          autoGrow
          maxLength={issueBodyLimit + 1000}
          readOnly={readOnly}
          value={s.edit.body}
          onChange={(e) => s.editText({ body: e.target.value })}
        />
        <span className="metadata muted">
          Markdown, up to {issueBodyLimit.toLocaleString("en")} characters. The
          replacement is the whole body.
        </span>
      </label>
    </>
  );
}

/** The panel for one task: its port, release and state, shown while the task page has it open. */
export function ImproveWithLead({
  client,
  csrfToken,
  taskId,
  taskVersion,
  policy,
  leadName,
  releaseDraft,
  onChanged,
}: {
  client: OperatorClient;
  csrfToken: string;
  taskId: string;
  taskVersion: number;
  policy: IssueEditPolicy;
  leadName: string;
  releaseDraft: ReleaseRun;
  onChanged: () => void;
}) {
  const port = useMemo(
    () => createIssueImprovePort(client, csrfToken, taskId),
    [client, csrfToken, taskId],
  );
  const s = useIssueImprove({
    taskId,
    taskVersion,
    policy,
    port,
    releaseRun: releaseDraft,
    onChanged,
  });
  return <IssueImprovePanel s={s} policy={policy} leadName={leadName} />;
}

/** Adapts the operator client to the panel's port. */
export function createIssueImprovePort(
  client: OperatorClient,
  csrfToken: string,
  taskId: string,
): IssueImprovePort {
  /** `pick` returns the answer wrapped, or null for a receipt that is not this command's. */
  const send = async <T,>(
    command: OperatorCommand,
    pick: (receipt: CommandReceipt) => { value: T } | null,
  ): Promise<Outcome<T>> => {
    const result = await client.command(command, csrfToken);
    if (result.state === "recorded") {
      const answer = pick(result.receipt);
      return answer
        ? { state: "recorded", receipt: answer.value }
        : { state: "unknown" };
    }
    if (result.state === "rejected")
      return { state: "rejected", code: result.code };
    return { state: result.state };
  };
  const drafting = (receipt: CommandReceipt) =>
    receipt.kind === "drafting" ? { value: undefined } : null;
  const review = (receipt: CommandReceipt) =>
    receipt.kind === "edit-review" ? { value: receipt } : null;
  return {
    async readRun(runId, signal) {
      try {
        const { data } = await client.read(
          `/api/operator/drafting-runs/${runId}`,
          draftingRunReadSchema,
          signal,
        );
        if (data.kind !== "issue") return { state: "error" };
        return {
          state: "ok",
          run: {
            runId: data.runId,
            state: data.state,
            reason: data.reason,
            proposal: data.issueProposal,
            proposalWithheld: data.proposalWithheld,
            leadName: data.leadName,
            createdAt: data.createdAt,
            expiresAt: data.expiresAt,
          },
        };
      } catch (error) {
        return {
          state:
            error instanceof ClientError && error.code === "not-found"
              ? "not-found"
              : "error",
        };
      }
    },
    startRun: (input) =>
      send({ type: "issue.draft.start", ...input }, drafting),
    stopRun: (runId) =>
      send(
        { type: "drafting.stop", key: crypto.randomUUID(), runId },
        drafting,
      ),
    settleRun: (runId, disposition) =>
      send(
        {
          type: "drafting.settle",
          key: crypto.randomUUID(),
          runId,
          disposition,
        },
        drafting,
      ),
    review: (input) =>
      send({ type: "issue.edit.review", ...input, taskId }, review),
    confirm: (input) =>
      send(
        { type: "issue.edit.confirm", ...input, taskId, decision: "approved" },
        review,
      ),
    send: (input) =>
      send({ type: "issue.edit.send", ...input, taskId }, (receipt) =>
        receipt.kind === "delivery" && receipt.operationId === input.key
          ? { value: { state: receipt.state, reason: receipt.reason } }
          : null,
      ),
  };
}
