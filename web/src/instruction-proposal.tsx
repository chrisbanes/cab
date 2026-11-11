import { randomUUID } from "./browser-crypto.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  draftingRunReadSchema,
  projectConfigurationSchema,
  type OperatorFeedbackItem,
  operatorFeedbackPageSchema,
  profileInstructionsSchema,
  projectInstructionsSchema,
} from "../../src/operator/contracts.js";
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
} from "./instruction-proposal-model.js";
import type { TabProps } from "./project-config.js";
import { DraftOutcome, Panel, submitDraft, useDraft } from "./settings.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import "./instruction-proposal.css";

/** What survives a reload: the run being reviewed, its start, and the selection it was asked from. */
const storedSchema = z.object({
  runId: z.string().uuid().optional(),
  /** The start's key and project version, so an unconfirmed start is resent unchanged. */
  startKey: z.string().uuid().optional(),
  expectedProjectVersion: z.number().int().positive().optional(),
  refs: z.array(
    z.object({
      kind: z.enum(["message", "follow-up", "comment"]),
      id: z.string().uuid(),
      text: z.string(),
    }),
  ),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project") }),
    z.object({ kind: z.literal("profile"), profileId: z.string().uuid() }),
  ]),
  note: z.string(),
});
type Parsed = z.infer<typeof storedSchema>;
type Stored = Pick<Parsed, "refs" | "target" | "note"> & {
  runId?: string | undefined;
  startKey?: string | undefined;
  expectedProjectVersion?: number | undefined;
};

const storageKey = (projectId: string) =>
  `cab.instruction-proposal:${projectId}`;
// Reaching sessionStorage throws when site data is blocked; the tab then keeps its state in memory.
function readStored(projectId: string): Stored {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    const parsed = raw ? storedSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success) return parsed.data;
  } catch {}
  return { refs: [], target: { kind: "project" }, note: "" };
}
function writeStored(projectId: string, stored: Stored) {
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(stored));
  } catch {}
}

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
  const [stored, setStored] = useState<Stored>(() => readStored(projectId));
  const change = useCallback(
    (patch: Partial<Stored>) =>
      setStored((current) => {
        const next = { ...current, ...patch };
        writeStored(projectId, next);
        return next;
      }),
    [projectId],
  );
  const [items, setItems] = useState<OperatorFeedbackItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<InstructionRun | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // An archived project's proposals are read-only, like the rest of its settings.
  const readOnly = Boolean(p.readOnly);

  const loadPage = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      try {
        const query = new URLSearchParams({ limit: "50" });
        if (after) query.set("cursor", after);
        const { data: page } = await client.read(
          `/api/operator/projects/${projectId}/operator-feedback?${query}`,
          operatorFeedbackPageSchema,
          signal,
        );
        setItems((current) =>
          after ? [...current, ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
        setListError(false);
      } catch {
        if (!signal?.aborted) setListError(true);
      }
    },
    [client, projectId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void loadPage(null, abort.signal);
    return () => abort.abort();
  }, [loadPage]);

  const runId = stored.runId ?? null;
  const latest = useRef(stored);
  latest.current = stored;
  const resent = useRef(new Set<string>());
  const startingId = useRef<string | null>(null);
  // The latest render's sender, so a resend uses the current session.
  const sendStartRef = useRef<typeof sendStart>(async () => {});
  const readRun = useCallback(
    async (signal?: AbortSignal) => {
      if (!runId) return;
      try {
        const { data: read } = await client.read(
          `/api/operator/drafting-runs/${runId}`,
          draftingRunReadSchema,
          signal,
        );
        if (read.kind === "instruction") setRun(read);
      } catch (error) {
        if (!(error instanceof ClientError && error.code === "not-found"))
          return;
        if (startingId.current === runId) return;
        // A start that may never have arrived is sent once more under its key and content.
        const { startKey, expectedProjectVersion } = latest.current;
        if (startKey && expectedProjectVersion && !resent.current.has(runId)) {
          resent.current.add(runId);
          await sendStartRef.current({
            ...latest.current,
            runId,
            startKey,
            expectedProjectVersion,
          });
          return;
        }
        change({
          runId: undefined,
          startKey: undefined,
          expectedProjectVersion: undefined,
        });
        setMessage("The proposal is no longer available.");
      }
    },
    [client, runId, change],
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
    let version = data.project.version;
    if (redraft) {
      // The review may outlast the loaded configuration (an accepted save changes it).
      try {
        version = (
          await client.read(
            `/api/operator/projects/${projectId}/configuration`,
            projectConfigurationSchema,
          )
        ).data.project.version;
      } catch {
        return setMessage("Couldn’t read the project. Try again.");
      }
    }
    const next = {
      ...from,
      runId: randomUUID(),
      startKey: randomUUID(),
      expectedProjectVersion: version,
    };
    const previous = redraft
      ? {
          runId: from.runId,
          startKey: from.startKey,
          expectedProjectVersion: from.expectedProjectVersion,
        }
      : undefined;
    setRun(null);
    setSaved(null);
    change(next);
    await sendStart(next, previous);
  };
  sendStartRef.current = sendStart;
  async function sendStart(
    next: Stored & {
      runId: string;
      startKey: string;
      expectedProjectVersion: number;
    },
    /** The run to go back to when a redraft is refused. */
    previous?: Pick<Stored, "runId" | "startKey" | "expectedProjectVersion">,
  ) {
    setBusy(true);
    setMessage("");
    startingId.current = next.runId;
    const result = await client
      .command(
        {
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
        startingId.current = null;
        setBusy(false);
      });
    if (result.state === "recorded") return;
    if (result.state === "unknown")
      return setMessage(
        "Couldn’t confirm the request. It is checked again when the page reads it.",
      );
    change(
      previous ?? {
        runId: undefined,
        startKey: undefined,
        expectedProjectVersion: undefined,
      },
    );
    setMessage(
      result.state === "conflict"
        ? "The project changed. Try again."
        : result.code === "forbidden"
          ? "The selection holds text that cannot be sent to the lead."
          : "Couldn’t request a proposal.",
    );
    if (result.state === "conflict") p.refreshConfiguration();
  }
  const settle = async (disposition: "accept" | "discard") => {
    if (!runId) return false;
    const result = await client.command(
      { type: "drafting.settle", key: randomUUID(), runId, disposition },
      session.csrfToken,
    );
    return result.state === "recorded";
  };
  const stop = async () => {
    if (!runId) return;
    setBusy(true);
    await client.command(
      { type: "drafting.stop", key: randomUUID(), runId },
      session.csrfToken,
    );
    setBusy(false);
    await readRun();
  };
  const reject = async () => {
    setBusy(true);
    const done = await settle("discard");
    setBusy(false);
    if (done) {
      setMessage("Rejected the proposal. The instructions are unchanged.");
      await readRun();
    } else setMessage("Couldn’t reject the proposal. Try again.");
  };
  const clear = () => {
    change({
      runId: undefined,
      startKey: undefined,
      expectedProjectVersion: undefined,
    });
    setRun(null);
  };

  return (
    <div className="settings-split instruction-proposals">
      <div className="settings-column">
        {run?.runId === runId && run ? (
          <Review
            {...p}
            run={run}
            busy={busy}
            saved={saved}
            onSaved={async (revision) => {
              setSaved(savedLine(revision));
              p.refreshConfiguration();
              // The target has changed now, so Accept is not offered again even if this fails.
              await settle("accept");
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
                if (selection.sendable && !busy && !readOnly)
                  void start(stored);
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
                          disabled={!item.available}
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
                  {targets.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      Agent {profile.name ?? "(name withheld)"}
                      {profile.id === data.project.leadProfileId
                        ? " (lead)"
                        : ""}
                    </option>
                  ))}
                </NativeSelect>
                {stored.target.kind === "profile" && (
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
                <Button
                  type="submit"
                  disabled={!selection.sendable || busy || readOnly}
                >
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
  const d = useDraft(p.drafts, `instruction-proposal:${run.runId}`, readOnly);
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
      // The outcome names the revision the save created.
      let revision: number | null = null;
      try {
        revision =
          target?.kind === "profile" && target.profileId
            ? (
                await client.read(
                  `/api/operator/profiles/${target.profileId}/instructions`,
                  profileInstructionsSchema,
                )
              ).data.currentRevision
            : (
                await client.read(
                  `/api/operator/projects/${run.projectId}/instructions`,
                  projectInstructionsSchema,
                )
              ).data.currentRevision;
      } catch {}
      await p.onSaved(revision);
    })();
  }, [d.phase, client, p, run.projectId, target]);
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
            disabled={readOnly || p.busy || run.state === "stopping"}
            onClick={p.stop}
          >
            Stop
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
            disabled={readOnly}
            onClick={p.redraft}
          >
            Redraft
          </Button>
          <Button type="button" variant="secondary" onClick={p.clear}>
            New selection
          </Button>
        </div>
      )}
      {run.state === "proposed" && run.proposalWithheld && (
        <p className="body" role="alert">
          This proposal holds text that cannot be shown, so it cannot be
          accepted.{" "}
          <Button
            type="button"
            variant="secondary"
            disabled={readOnly}
            onClick={p.redraft}
          >
            Redraft
          </Button>
        </p>
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
              block !== null,
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
          {block && d.phase === "editing" && (
            <p className="body" role="status">
              {block}
            </p>
          )}
          <DraftOutcome
            draft={d}
            client={client}
            session={session}
            label="Accept and save"
            saveDisabled={block !== null}
            refresh={p.reread}
            success={p.saved}
          />
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
