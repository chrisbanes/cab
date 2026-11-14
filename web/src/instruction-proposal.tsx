import { randomUUID } from "./browser-crypto.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  draftingRunReadSchema,
  operatorCommandSchema,
  projectConfigurationSchema,
  type OperatorFeedbackItem,
  operatorFeedbackPageSchema,
  profileInstructionsSchema,
} from "../../src/operator/contracts.js";
import { isDefiniteRefusal } from "./command-lifecycle.js";
import { ClientError } from "./api.js";
import { Button, StatusBadge } from "./components.js";
import { lineDiff } from "./issue-improve-model.js";
import {
  acceptBlock,
  evidenceUseLabel,
  impactLines,
  type InstructionRun,
  instructionNoteLimit,
  instructionProposalPollMs,
  restoreLine,
  runStateLabel,
  savedLine,
  selectionSummary,
  proposalJournal,
  type StoredProposal as Stored,
} from "./instruction-proposal-model.js";
import type { TabProps } from "./project-config.js";
import { DraftOutcome, Panel, submitDraft, useDraft } from "./settings.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import "./instruction-proposal.css";

const unsettled = (state: InstructionRun["state"]) =>
  state === "queued" || state === "running" || state === "stopping";
const kindLabel = {
  message: "Message",
  "follow-up": "Follow-up",
  comment: "Comment",
};
const when = (at: number) => new Date(at).toLocaleString("en-GB");

export function InstructionProposalsTab(p: TabProps) {
  const { projectId, data, client, session } = p;
  const journal = useMemo(() => proposalJournal(projectId), [projectId]);
  const stored = useSyncExternalStore(journal.subscribe, journal.snapshot);
  const change = useCallback(
    (patch: Partial<Stored>) => journal.change(patch),
    [journal],
  );
  const [items, setItems] = useState<OperatorFeedbackItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<InstructionRun | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Reads of the run are failing for a reason other than not-found.
  const [readFailed, setReadFailed] = useState(false);
  // An archived project's proposals are read-only, like the rest of its settings.
  const readOnly = Boolean(p.readOnly);
  const latest = useRef(stored);
  latest.current = stored;

  const loadPage = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      const currentAuthentication = client.captureAuthenticationScope();
      const selectionAtStart = journal.snapshot();
      try {
        const query = new URLSearchParams({ limit: "50" });
        if (after) query.set("cursor", after);
        const { data: page } = await client.read(
          `/api/operator/projects/${projectId}/operator-feedback?${query}`,
          operatorFeedbackPageSchema,
          signal,
        );
        if (signal?.aborted || !currentAuthentication()) return;
        setItems((current) =>
          after ? [...current, ...page.items] : page.items,
        );
        // A selected item that is withheld now can no longer be sent, so it leaves the selection.
        const withheld = new Set(
          page.items.filter((item) => !item.available).map((item) => item.id),
        );
        if (
          journal.snapshot() === selectionAtStart &&
          latest.current.refs.some((r) => withheld.has(r.id))
        ) {
          change({
            refs: journal.snapshot().refs.filter((r) => !withheld.has(r.id)),
          });
          setMessage(
            "Selected feedback that is now withheld was removed from the selection.",
          );
        }
        setCursor(page.nextCursor);
        setListError(false);
      } catch {
        if (!signal?.aborted) setListError(true);
      }
    },
    [client, projectId, journal, change],
  );
  useEffect(() => {
    const abort = new AbortController();
    void loadPage(null, abort.signal);
    return () => abort.abort();
  }, [loadPage]);

  const runId = stored.runId ?? null;
  const resent = useRef(new Set<string>());
  const startingId = useRef<string | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // The latest render's sender, so a resend uses the current session.
  const sendStartRef = useRef<typeof sendStart>(async () => {});
  const readRun = useCallback(
    async (signal?: AbortSignal) => {
      if (!runId) return;
      const currentAuthentication = client.captureAuthenticationScope();
      try {
        const { data: read } = await client.read(
          `/api/operator/drafting-runs/${runId}`,
          draftingRunReadSchema,
          signal,
        );
        if (
          signal?.aborted ||
          !currentAuthentication() ||
          !journal.matches(runId)
        )
          return;
        if (
          read.kind !== "instruction" ||
          read.projectId !== projectId ||
          read.runId !== runId
        ) {
          setReadFailed(true);
          return;
        }
        journal.started(runId);
        setRun(read);
        setReadFailed(false);
      } catch (error) {
        if (
          signal?.aborted ||
          !currentAuthentication() ||
          !journal.matches(runId)
        )
          return;
        if (!(error instanceof ClientError && error.code === "not-found")) {
          if (!signal?.aborted) setReadFailed(true);
          return;
        }
        if (startingId.current === runId) return;
        // A start that may never have arrived is sent once more under its key and content,
        // except from a read-only view, which only clears it.
        const { startKey, expectedProjectVersion } = latest.current;
        if (
          !readOnlyRef.current &&
          startKey &&
          expectedProjectVersion &&
          !resent.current.has(runId)
        ) {
          resent.current.add(runId);
          await sendStartRef.current(
            {
              ...latest.current,
              runId,
              startKey,
              expectedProjectVersion,
            },
            true,
          );
          return;
        }
        if (
          (latest.current.pendingStart && !readOnlyRef.current) ||
          latest.current.previous
        ) {
          setMessage("Couldn’t confirm the request. Try checking it again.");
          return;
        }
        journal.clear();
        setMessage("The proposal is no longer available.");
      }
    },
    [client, projectId, runId, journal],
  );
  const reviewing = run?.state === "proposed";
  // A proposal is read again too, so a target changed elsewhere shows as changed.
  const polling =
    !run ||
    run.runId !== runId ||
    unsettled(run.state) ||
    run.state === "proposed";
  useEffect(() => {
    if (!runId) return setRun(null);
    const abort = new AbortController();
    void readRun(abort.signal);
    if (!polling) return () => abort.abort();
    // A proposal waiting for review is only re-read to notice a changed target.
    const timer = setInterval(
      () => void readRun(abort.signal),
      reviewing ? instructionProposalPollMs * 5 : instructionProposalPollMs,
    );
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [readRun, runId, polling, reviewing]);

  const selection = selectionSummary(stored.refs.map((r) => r.text));
  const permitted = data.routing?.candidateProfileIds ?? [];
  const targets = data.profiles.filter(
    (profile) =>
      !profile.revoked &&
      (profile.id === data.project.leadProfileId ||
        permitted.includes(profile.id)),
  );
  // A stored agent that is no longer the lead or permitted is shown as such, never silently swapped.
  const targetValid =
    stored.target.kind === "project" ||
    targets.some(
      (profile) =>
        stored.target.kind === "profile" &&
        profile.id === stored.target.profileId,
    );
  const sendable = selection.sendable && targetValid;
  const toggle = (item: OperatorFeedbackItem) => {
    const selected = stored.refs.some((r) => r.id === item.id);
    change({
      refs: selected
        ? stored.refs.filter((r) => r.id !== item.id)
        : [
            ...stored.refs,
            { kind: item.kind, id: item.id, text: item.text ?? "" },
          ],
    });
  };

  /** A request from the selection; a redraft keeps the reviewed run if it cannot start. */
  const start = async (from: Stored, redraft = false) => {
    if (readOnly) return;
    const currentAuthentication = client.captureAuthenticationScope();
    const original = journal.snapshot();
    let version = data.project.version;
    if (busy) return;
    if (redraft) {
      // Busy at once, so a second click cannot start a second run while the project is read.
      setBusy(true);
      // The review may outlast the loaded configuration (an accepted save changes it).
      try {
        version = (
          await client.read(
            `/api/operator/projects/${projectId}/configuration`,
            projectConfigurationSchema,
          )
        ).data.project.version;
      } catch {
        setBusy(false);
        return setMessage("Couldn’t read the project. Try again.");
      }
    }
    if (!currentAuthentication() || journal.snapshot() !== original) {
      setBusy(false);
      return;
    }
    const next = {
      ...from,
      runId: randomUUID(),
      startKey: randomUUID(),
      expectedProjectVersion: version,
    };
    const {
      drafts: _drafts,
      pendingStart: _pending,
      previous: _previous,
      close: _close,
      ...selection
    } = from;
    const command = {
      type: "instruction.draft.start" as const,
      key: next.startKey,
      runId: next.runId,
      projectId,
      expectedProjectVersion: version,
      target: next.target,
      feedback: next.refs.map(({ kind, id }) => ({ kind, id })),
      note: next.note,
    };
    if (
      !operatorCommandSchema.safeParse(command).success ||
      new TextEncoder().encode(JSON.stringify(command)).length > 65536
    ) {
      setBusy(false);
      setMessage(
        "Couldn’t request a proposal: the request is too large or invalid. Your reviewed proposal is still here.",
      );
      return;
    }
    next.pendingStart = command;
    next.previous = redraft ? selection : undefined;
    next.close = undefined;
    setRun(null);
    setSaved(null);
    change(next);
    await sendStart(next);
  };
  sendStartRef.current = sendStart;
  async function sendStart(
    next: Stored & {
      runId: string;
      startKey: string;
      expectedProjectVersion: number;
    },
    reconciling = false,
  ) {
    const currentAuthentication = client.captureAuthenticationScope();
    const current = () =>
      currentAuthentication() &&
      journal.matches(next.runId) &&
      journal.snapshot().startKey === next.startKey;
    setBusy(true);
    setMessage("");
    setReadFailed(false);
    startingId.current = next.runId;
    const result = await client
      .command(
        next.pendingStart ?? {
          type: "instruction.draft.start",
          key: next.startKey,
          runId: next.runId,
          projectId,
          expectedProjectVersion: next.expectedProjectVersion,
          target: next.target,
          feedback: next.refs.map(({ kind, id }) => ({ kind, id })),
          note: next.note,
        },
        session.csrfToken,
      )
      .finally(() => {
        if (currentAuthentication() && journal.matches(next.runId)) {
          startingId.current = null;
          setBusy(false);
        }
      });
    if (!current()) return;
    if (
      result.state === "recorded" &&
      result.receipt.kind === "drafting" &&
      result.receipt.key === next.startKey &&
      result.receipt.runId === next.runId &&
      result.receipt.operation === "start"
    ) {
      journal.started(next.runId);
      return;
    }
    if (
      result.state === "unknown" ||
      result.state === "recorded" ||
      (reconciling && !isDefiniteRefusal(result))
    )
      return setMessage(
        "Couldn’t confirm the request. It is checked again when the page reads it.",
      );
    journal.refused(next.runId);
    const fields = result.state === "rejected" ? (result.fieldPaths ?? []) : [];
    setMessage(
      result.state === "conflict"
        ? "The project changed. Try again."
        : result.state === "rejected" && result.code === "forbidden"
          ? "The selection or note holds text that cannot be sent to the lead. The feedback list was read again."
          : fields.includes("target")
            ? "The target is no longer available. Choose another target."
            : fields.includes("feedback")
              ? "Some selected feedback can no longer be used. The feedback list was read again."
              : "Couldn’t request a proposal.",
    );
    if (result.state === "conflict") p.refreshConfiguration();
    // A refusal may mean the feedback changed, so the list shows what is available now.
    if (
      result.state === "rejected" &&
      (result.code === "forbidden" || fields.includes("feedback"))
    )
      void loadPage(null);
  }
  const settle = async (disposition: "accept" | "discard") => {
    if (!runId) return false;
    const currentAuthentication = client.captureAuthenticationScope();
    const close = journal.snapshot().close ?? {
      runId,
      key: randomUUID(),
      disposition,
    };
    if (
      !journal.matches(runId) ||
      close.runId !== runId ||
      close.disposition !== disposition
    )
      return false;
    journal.change({ close });
    const result = await client.command(
      { type: "drafting.settle", ...close },
      session.csrfToken,
    );
    return (
      currentAuthentication() &&
      journal.matches(runId) &&
      result.state === "recorded" &&
      result.receipt.kind === "drafting" &&
      result.receipt.key === close.key &&
      result.receipt.runId === runId &&
      result.receipt.operation === disposition &&
      result.receipt.state ===
        (disposition === "accept" ? "accepted" : "discarded")
    );
  };
  const stop = async () => {
    if (!runId) return;
    const currentAuthentication = client.captureAuthenticationScope();
    setBusy(true);
    setMessage("");
    const result = await client.command(
      { type: "drafting.stop", key: randomUUID(), runId },
      session.csrfToken,
    );
    if (!currentAuthentication() || !journal.matches(runId)) return;
    setBusy(false);
    if (result.state !== "recorded")
      setMessage("Couldn’t stop the proposal. Try again.");
    await readRun();
  };
  const reject = async () => {
    if (!runId) return;
    const currentAuthentication = client.captureAuthenticationScope();
    setBusy(true);
    setMessage("");
    const done = await settle("discard");
    if (!currentAuthentication() || !journal.matches(runId)) return;
    setBusy(false);
    if (done) {
      setMessage("Rejected the proposal. The instructions are unchanged.");
      await readRun();
    } else setMessage("Couldn’t reject the proposal. Try again.");
  };
  const clear = () => {
    setMessage("");
    setReadFailed(false);
    setBusy(false);
    journal.clear();
    setRun(null);
    setSaved(null);
  };

  return (
    <div className="settings-split instruction-proposals">
      <div className="settings-column">
        {runId && run?.runId !== runId ? (
          <Panel
            title="Instruction proposal"
            description="Checking the request…"
          >
            {/* Only a start that could not be confirmed, or a run that cannot be read, is left. */}
            {(message || readFailed) && (
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void readRun()}
                >
                  Try again
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={clear}
                >
                  New selection
                </Button>
              </div>
            )}
          </Panel>
        ) : run?.runId === runId && run ? (
          <Review
            {...p}
            key={run.runId}
            journal={journal}
            run={run}
            busy={busy}
            saved={saved}
            onSaved={async (revision) => {
              const currentAuthentication = client.captureAuthenticationScope();
              if (!journal.matches(run.runId)) return;
              setSaved(savedLine(revision));
              p.refreshConfiguration();
              // The target has changed now, so Accept is not offered again even if this fails.
              if (
                !readOnly &&
                !(await settle("accept")) &&
                currentAuthentication() &&
                journal.matches(run.runId)
              )
                setMessage(
                  "Saved. The proposal could not be closed; it expires on its own. Choose New selection to continue.",
                );
              if (currentAuthentication() && journal.matches(run.runId))
                await readRun();
            }}
            reread={() => void readRun()}
            stop={stop}
            reject={reject}
            redraft={() => void start(stored, true)}
            clear={clear}
          />
        ) : (
          <Panel
            title="Request an instruction proposal"
            description="Select recorded operator feedback. The lead sees only what you select and proposes one edit; nothing changes until you accept it."
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (sendable && !busy && !readOnly) void start(stored);
              }}
            >
              <fieldset className="settings-fields">
                <legend className="small-heading">Feedback</legend>
                <p className="metadata muted" aria-live="polite">
                  {selection.line}
                </p>
                {listError && (
                  <p className="body" role="alert">
                    Couldn’t load feedback.{" "}
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void loadPage(null)}
                    >
                      Try again
                    </Button>
                  </p>
                )}
                {!listError && items.length === 0 && (
                  <p className="metadata muted">
                    No operator feedback has been recorded for this project.
                  </p>
                )}
                <ul className="instruction-feedback-list">
                  {items.map((item) => (
                    <li key={item.id}>
                      <label className="instruction-feedback-item">
                        <input
                          type="checkbox"
                          // A selected item stays clearable even once it is withheld.
                          disabled={
                            !item.available &&
                            !stored.refs.some((r) => r.id === item.id)
                          }
                          checked={stored.refs.some((r) => r.id === item.id)}
                          onChange={() => toggle(item)}
                        />
                        <span>
                          <span className="metadata muted">
                            {kindLabel[item.kind]} · {item.taskTitle ?? "Task"}{" "}
                            · to {item.recipientName ?? "an agent"} ·{" "}
                            {when(item.createdAt)}
                          </span>
                          <span className="body instruction-text">
                            {item.available
                              ? item.text
                              : "Text withheld: it holds something cab does not show."}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {cursor && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void loadPage(cursor)}
                  >
                    Load more
                  </Button>
                )}
              </fieldset>
              <div className="settings-fields">
                <label className="body" htmlFor="instruction-target">
                  Target
                </label>
                <NativeSelect
                  id="instruction-target"
                  value={
                    stored.target.kind === "project"
                      ? ""
                      : stored.target.profileId
                  }
                  onChange={(e) =>
                    change({
                      target: e.target.value
                        ? { kind: "profile", profileId: e.target.value }
                        : { kind: "project" },
                    })
                  }
                >
                  <option value="">Project instructions</option>
                  {!targetValid && stored.target.kind === "profile" && (
                    <option value={stored.target.profileId} disabled>
                      Agent no longer available
                    </option>
                  )}
                  {targets.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      Agent {profile.name ?? "(name withheld)"}
                      {profile.id === data.project.leadProfileId
                        ? " (lead)"
                        : ""}
                    </option>
                  ))}
                </NativeSelect>
                {!targetValid && (
                  <p className="body" role="status">
                    The chosen agent is no longer this project&rsquo;s lead or a
                    permitted agent. Choose another target.
                  </p>
                )}
                {stored.target.kind === "profile" && targetValid && (
                  <p className="metadata muted">
                    An agent’s instructions are shared by every project that
                    uses it. The proposal lists those projects before you
                    accept.
                  </p>
                )}
                <label className="body" htmlFor="instruction-note">
                  Note for the lead (optional)
                </label>
                <Textarea
                  id="instruction-note"
                  value={stored.note}
                  maxLength={instructionNoteLimit}
                  onChange={(e) => change({ note: e.target.value })}
                />
              </div>
              <div className="settings-actions">
                <Button type="submit" disabled={!sendable || busy || readOnly}>
                  {busy ? "Requesting…" : "Request proposal"}
                </Button>
              </div>
              {selection.over && (
                <p className="metadata muted" role="status">
                  Select at most 20 items and 64,000 characters.
                </p>
              )}
            </form>
          </Panel>
        )}
        {!journal.available && (
          <p className="body" role="status">
            Reload recovery is unavailable because this tab cannot save browser
            data. Your changes remain available on this page.
          </p>
        )}
        {message && (
          <p className="body" role="status">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

function Review(
  p: TabProps & {
    run: InstructionRun;
    journal: ReturnType<typeof proposalJournal>;
    busy: boolean;
    saved: string | null;
    onSaved: (revision: number | null) => Promise<void>;
    /** Reads the run again, so a conflicting save shows the target's current state. */
    reread: () => void;
    stop: () => void;
    reject: () => void;
    redraft: () => void;
    clear: () => void;
  },
) {
  const { run, client, session } = p;
  const proposal = run.instructionProposal;
  const target = run.instructionTarget;
  const current = target?.observedInstructions ?? "";
  // The edited text lives in the run's draft, so it survives leaving the tab.
  const readOnly = Boolean(p.readOnly);
  const d = useDraft(
    p.drafts,
    `instruction-proposal:${run.runId}`,
    readOnly,
    p.journal.recovery(run),
  );
  useEffect(() => {
    void d.verifyRecovery(client);
  }, [d, client]);
  const finalText =
    typeof d.values.instructions === "string"
      ? d.values.instructions
      : (proposal?.instructions ?? "");
  // A sent save has frozen its body; further edits would be silently dropped.
  const locked =
    readOnly ||
    d.phase === "pending" ||
    d.phase === "unknown" ||
    d.phase === "recorded";
  const block = acceptBlock(run, finalText);
  const diff = useMemo(() => {
    const { current: removed, proposed: added } = lineDiff(current, finalText);
    return [...removed, ...added].filter((row) => row.kind !== "same");
  }, [current, finalText]);
  const proposed = proposal?.instructions;
  useEffect(() => {
    if (!d.values.key && proposed !== undefined)
      d.startOperation({ key: randomUUID(), instructions: proposed });
  }, [d, proposed]);
  const reported = useRef(false);
  useEffect(() => {
    if (d.phase !== "recorded" || reported.current) return;
    reported.current = true;
    void (async () => {
      const currentAuthentication = client.captureAuthenticationScope();
      const receipt = d.receipt;
      let revision: number | null =
        receipt?.kind === "configuration" &&
        receipt.result.commandType === "project.configure"
          ? receipt.result.instructionsRevision
          : null;
      if (
        receipt?.kind === "configuration" &&
        receipt.result.commandType === "profile.configure"
      ) {
        try {
          const read = await client.read(
            `/api/operator/profiles/${receipt.result.resourceId}/instructions`,
            profileInstructionsSchema,
          );
          if (
            read.data.summary.id === receipt.result.resourceId &&
            read.data.summary.version === receipt.result.version
          )
            revision = read.data.currentRevision;
        } catch {
          /* The saved configuration is known; its exact instructions revision may be unavailable. */
        }
      }
      if (!currentAuthentication() || !p.journal.matches(run.runId)) return;
      await p.onSaved(revision);
    })();
  }, [d.phase, d.receipt, client, p, run.runId]);
  const command = () =>
    target?.kind === "profile"
      ? {
          type: "profile.configure",
          key: d.values.key,
          profileId: target.profileId,
          expectedVersion: run.targetCurrent?.version,
          instructions: finalText,
        }
      : {
          type: "project.configure",
          key: d.values.key,
          projectId: run.projectId,
          expectedVersion: run.targetCurrent?.version,
          instructions: finalText,
        };
  const feedbackOf = (id: string) =>
    run.feedback?.find((item) => item.id === id);
  return (
    <Panel
      title={proposal?.summary ?? "Instruction proposal"}
      description={`For ${target?.kind === "profile" ? `agent ${target.name ?? "(name withheld)"}` : "this project's instructions"} · drafted by ${run.leadName ?? "the lead"}`}
      action={
        <StatusBadge tone="neutral">{runStateLabel(run.state)}</StatusBadge>
      }
    >
      {readOnly && (
        <p className="body" role="status">
          This project is archived, so its proposals are read-only.
        </p>
      )}
      {(run.state === "queued" ||
        run.state === "running" ||
        run.state === "stopping") && (
        <div className="settings-actions">
          <p className="body" role="status">
            The lead is drafting from the selected feedback.
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={readOnly || p.busy}
            onClick={p.stop}
          >
            {run.state === "stopping" ? "Stop again" : "Stop"}
          </Button>
        </div>
      )}
      {(run.state === "interrupted" ||
        run.state === "failed" ||
        run.state === "expired" ||
        run.state === "discarded" ||
        run.state === "accepted") && (
        <div className="settings-actions">
          <p className="body">
            {p.saved ?? run.reason ?? runStateLabel(run.state)}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={readOnly || p.busy}
            onClick={p.redraft}
          >
            Redraft
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={p.busy}
            onClick={p.clear}
          >
            New selection
          </Button>
        </div>
      )}
      {run.state === "proposed" && run.proposalWithheld && (
        <>
          <p className="body" role="alert">
            This proposal holds text that cannot be shown, so it cannot be
            accepted.
          </p>
          <div className="settings-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={readOnly || p.busy}
              onClick={p.reject}
            >
              Reject
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={readOnly || p.busy}
              onClick={p.redraft}
            >
              Redraft
            </Button>
          </div>
        </>
      )}
      {run.state === "proposed" && proposal && (
        <form
          onSubmit={(e) =>
            void submitDraft(
              e,
              d,
              client,
              session,
              command(),
              p.reread,
              {},
              block !== null || p.busy,
            )
          }
        >
          {proposal.insufficientEvidence && (
            <p className="body" role="status">
              The lead found the evidence insufficient for a general change.
            </p>
          )}
          <section aria-label="Evidence" className="settings-fields">
            <h3 className="small-heading">Evidence</h3>
            <ul className="instruction-feedback-list">
              {proposal.evidence.map((entry) => {
                const item = feedbackOf(entry.feedbackId);
                return (
                  <li key={entry.feedbackId}>
                    <p className="metadata muted">
                      {evidenceUseLabel[entry.use]} ·{" "}
                      {item
                        ? `${kindLabel[item.kind]} · ${item.taskTitle ?? "Task"} · to ${item.recipientName ?? "an agent"} · ${when(item.createdAt)}`
                        : "Unknown item"}
                    </p>
                    <p className="body instruction-text">
                      {item?.text ??
                        "Text withheld: it holds something cab does not show."}
                    </p>
                    {entry.note && <p className="metadata">{entry.note}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-label="Reasoning" className="settings-fields">
            <h3 className="small-heading">Rationale</h3>
            <p className="body instruction-text">{proposal.rationale}</p>
            <h3 className="small-heading">Generalisation</h3>
            <p className="body instruction-text">{proposal.generalisation}</p>
            <h3 className="small-heading">Conflicts</h3>
            <p className="body instruction-text">
              {proposal.conflicts || "None stated."}
            </p>
          </section>
          <section aria-label="Instructions" className="settings-fields">
            <h3 className="small-heading">Current instructions</h3>
            <pre className="body instruction-text">{current || "(empty)"}</pre>
            <label className="small-heading" htmlFor="instruction-final">
              Proposed instructions
            </label>
            <Textarea
              id="instruction-final"
              value={finalText}
              rows={10}
              disabled={locked}
              onChange={(e) => d.set("instructions", e.target.value)}
            />
            <ul className="body instruction-diff" aria-label="Changed lines">
              {diff.length === 0 ? (
                <li className="metadata muted">No changed lines.</li>
              ) : (
                diff.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat; the list is rebuilt from the text.
                  <li key={i} data-kind={row.kind}>
                    {row.kind === "added" ? "Added: " : "Removed: "}
                    {row.text}
                  </li>
                ))
              )}
            </ul>
          </section>
          <section aria-label="Impact" className="settings-fields">
            <h3 className="small-heading">Who this affects</h3>
            {impactLines(run).map((line) => (
              <p key={line} className="body">
                {line}
              </p>
            ))}
            <p className="metadata muted">
              {restoreLine(target?.kind === "profile" ? "profile" : "project")}
            </p>
          </section>
          {block &&
            (d.phase === "editing" ||
              d.phase === "conflict" ||
              d.phase === "rejected") && (
              <p className="body" role="status">
                {block}
              </p>
            )}
          {d.phase === "recorded" &&
            d.receipt?.kind === "configuration" &&
            "version" in d.receipt.result &&
            run.targetCurrent &&
            run.targetCurrent.version !== d.receipt.result.version && (
              <p className="body" role="status">
                Instructions changed again after this save. This confirmation
                describes your earlier save.
              </p>
            )}
          <DraftOutcome
            draft={d}
            client={client}
            session={session}
            label="Accept and save"
            saveDisabled={block !== null || p.busy}
            refresh={p.reread}
            success={p.saved}
          />
          {d.phase === "recorded" && (
            <div className="settings-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={p.busy}
                onClick={p.clear}
              >
                New selection
              </Button>
            </div>
          )}
          {d.phase !== "recorded" &&
            d.phase !== "pending" &&
            d.phase !== "unknown" && (
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={readOnly || p.busy}
                  onClick={p.reject}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={readOnly || p.busy}
                  onClick={p.redraft}
                >
                  Redraft
                </Button>
              </div>
            )}
        </form>
      )}
    </Panel>
  );
}
