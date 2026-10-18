import { useCallback, useEffect, useRef, useState } from "react";
import {
  draftingRunReadSchema,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { Button } from "./components.js";
import type { ComposerState } from "./composer-state.js";
import {
  type DraftChoice as Choice,
  type DraftField,
  draftingCopy,
  draftingLimitSeconds,
  draftingPollMs,
  formatElapsed,
  planFill,
} from "./composer-drafting-model.js";
import { useOperatorResource } from "./resource.js";
import { Badge } from "./ui/badge.js";
import { Textarea } from "./ui/textarea.js";

type Command = Extract<
  OperatorCommand,
  { type: "drafting.start" | "drafting.stop" | "drafting.settle" }
>;

/**
 * Best effort when a task is created: ends the project's draft so nothing
 * lingers. A running draft is stopped; any other is discarded.
 */
export async function releaseDraft(
  client: OperatorClient,
  csrfToken: string,
  runId: string,
) {
  const key = () => crypto.randomUUID();
  await client.command({ type: "drafting.stop", key: key(), runId }, csrfToken);
  await client.command(
    { type: "drafting.settle", key: key(), runId, disposition: "discard" },
    csrfToken,
  );
}

const stateLabels = {
  idle: ["Ready to draft", "secondary"],
  starting: ["Starting", "secondary"],
  unavailable: ["Unavailable", "secondary"],
  queued: ["Waiting", "secondary"],
  running: ["Drafting", "attention"],
  stopping: ["Stopping", "attention"],
  proposed: ["Draft ready", "success"],
  interrupted: ["Draft interrupted", "attention"],
  failed: ["Draft failed", "destructive"],
} as const;

/** Hands a rough idea to the project lead and fills the composer; the panel and choices render from it. */
export function useDrafting({
  state,
  client,
  csrfToken,
  lead,
  locked,
}: {
  state: ComposerState;
  client: OperatorClient;
  csrfToken: string;
  /** Undefined while the project's options load; null when the project has no lead. */
  lead: { name: string | null } | null | undefined;
  locked: boolean;
}) {
  const input = state.input;
  const runId = input.draftingRunId ?? "";
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/drafting-runs/${runId}`,
        draftingRunReadSchema,
        signal,
      ),
    [client, runId],
  );
  const resource = useOperatorResource(
    runId ? `${csrfToken}:${runId}` : null,
    loader,
  );
  const run = resource.state.data?.data;
  const [busy, setBusy] = useState(false);
  // The run id is stored before the start is sent, so its first read may not find it yet.
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const applied = useRef<string | null>(null);
  // Handlers outlive the render that made them, so they reread through the latest loader.
  const poll = useRef(resource.poll);
  poll.current = resource.poll;
  const refresh = useRef(resource.refresh);
  refresh.current = resource.refresh;
  // A run released elsewhere (a project change, discarded input) leaves no stale proposal.
  useEffect(() => {
    if (runId) return;
    setChoices([]);
    applied.current = null;
  }, [runId]);
  const settled = Boolean(
    run && !["queued", "running", "stopping"].includes(run.state),
  );

  useEffect(() => {
    if (!runId || settled) return;
    const timer = setInterval(() => poll.current(), draftingPollMs);
    return () => clearInterval(timer);
  }, [runId, settled]);
  useEffect(() => {
    if (run?.state !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.state]);

  const send = async (command: Command) => {
    setBusy(true);
    const result = await client.command(command, csrfToken);
    setBusy(false);
    return result;
  };
  const clearRun = (note = "") => {
    state.edit({ draftingRunId: undefined });
    setChoices([]);
    applied.current = null;
    setMessage(note);
  };
  const settle = async (disposition: "accept" | "discard") => {
    const result = await send({
      type: "drafting.settle",
      key: crypto.randomUUID(),
      runId,
      disposition,
    });
    if (result.state === "recorded") clearRun();
    else setMessage("Couldn't finish with the draft. Try again.");
  };
  const start = async () => {
    const idea = input.idea ?? "";
    if (!input.projectId || idea.trim() === "") return;
    const next = crypto.randomUUID();
    // Stored before it is sent, so a reload reattaches to a run that did start.
    state.edit({ draftingRunId: next });
    setChoices([]);
    applied.current = null;
    setMessage("");
    setStarting(true);
    // The button that started it is replaced, so focus stays with the idea.
    document.getElementById("composer-idea")?.focus();
    const result = await send({
      type: "drafting.start",
      key: crypto.randomUUID(),
      runId: next,
      projectId: input.projectId,
      idea,
    });
    // The reread clears the earlier not-found before the guard is lifted.
    if (result.state === "recorded") void refresh.current();
    setStarting(false);
    if (result.state === "recorded") return;
    if (result.state === "unknown") {
      // Read again so a start that did land is found rather than dropped.
      void refresh.current();
      setMessage(draftingCopy.unconfirmed);
    } else {
      clearRun(
        result.code === "conflict" || result.state === "conflict"
          ? "Couldn't start the draft: the project lead is unavailable."
          : "Couldn't start the draft.",
      );
    }
  };
  const stop = async () => {
    const result = await send({
      type: "drafting.stop",
      key: crypto.randomUUID(),
      runId,
    });
    if (result.state === "recorded") void refresh.current();
    else setMessage("Couldn't stop the draft. Try again.");
  };

  // A draft that is gone, expired or used elsewhere releases the composer.
  const lost =
    (resource.state.error === "not-found" && !starting) ||
    run?.state === "expired" ||
    run?.state === "accepted" ||
    run?.state === "discarded";
  // biome-ignore lint/correctness/useExhaustiveDependencies: releases once when the run is lost; the handlers are rebuilt every render.
  useEffect(() => {
    if (!lost || !runId) return;
    clearRun(
      run?.state === "expired" ? draftingCopy.expired : draftingCopy.gone,
    );
  }, [lost, runId]);

  // A ready proposal fills empty fields at once; typed text waits for a choice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applies each ready proposal once, from the input as it stands then.
  useEffect(() => {
    if (run?.state !== "proposed" || !run.proposal) return;
    if (applied.current === run.runId) return;
    applied.current = run.runId;
    const plan = planFill(state.input, run.proposal);
    if (Object.keys(plan.fill).length > 0) state.edit(plan.fill);
    setChoices(plan.choices);
    if (plan.choices.length === 0) void settle("accept");
  }, [run]);
  const choose = (choice: Choice, replace: boolean) => {
    if (replace) state.edit({ [choice.field]: choice.proposed });
    const rest = choices.filter((item) => item.field !== choice.field);
    setChoices(rest);
    if (rest.length === 0) void settle("accept");
  };

  const idle = !runId;
  const view: keyof typeof stateLabels =
    !input.projectId || (lead === null && idle)
      ? "unavailable"
      : idle || lost
        ? "idle"
        : !run
          ? "starting"
          : run.state === "queued"
            ? "queued"
            : run.state === "running"
              ? "running"
              : run.state === "stopping"
                ? "stopping"
                : run.state === "proposed"
                  ? "proposed"
                  : run.state === "failed"
                    ? "failed"
                    : "interrupted";
  const [label, tone] = stateLabels[view];
  const editableIdea =
    view === "idle" || view === "interrupted" || view === "failed";
  const canStart =
    !locked &&
    !busy &&
    lead !== undefined &&
    lead !== null &&
    Boolean(input.projectId) &&
    (input.idea ?? "").trim() !== "";
  const waitingForRun = Boolean(runId) && !run && !lost;
  const leadName = lead?.name ?? "The lead";
  const elapsed = run ? (now - run.createdAt) / 1000 : 0;
  return {
    input,
    run,
    view,
    label,
    tone,
    busy,
    starting,
    message,
    choices,
    choose,
    start,
    stop,
    settle,
    canStart,
    editableIdea,
    waitingForRun,
    leadName,
    elapsed,
    locked,
    lead,
  };
}

export type Drafting = ReturnType<typeof useDrafting>;

/** The Draft with lead panel. */
export function DraftWithLead({
  d,
  state,
}: {
  d: Drafting;
  state: ComposerState;
}) {
  const {
    input,
    run,
    view,
    label,
    tone,
    busy,
    message,
    start,
    stop,
    settle,
    canStart,
    editableIdea,
    waitingForRun,
    leadName,
    elapsed,
    locked,
    lead,
  } = d;
  // Closed while idle, so the fields stay in the first view; open whenever a run exists.
  const [open, setOpen] = useState(Boolean(input.draftingRunId));
  const hasRun = Boolean(input.draftingRunId);
  useEffect(() => {
    if (hasRun) setOpen(true);
  }, [hasRun]);
  return (
    <section className="composer-draft" data-open={open ? "true" : "false"}>
      <h2 className="composer-draft-heading">
        <button
          type="button"
          className="composer-draft-head small-heading"
          aria-expanded={open}
          aria-controls="composer-draft-body"
          onClick={() => setOpen(!open)}
        >
          <span>Draft with lead</span>
          <Badge variant={tone} className="metadata">
            {label}
          </Badge>
        </button>
      </h2>
      <div
        id="composer-draft-body"
        className="composer-draft-body"
        hidden={!open}
      >
        <label className="field body" htmlFor="composer-idea">
          Rough idea
          <Textarea
            id="composer-idea"
            aria-label="Rough idea"
            className="control"
            rows={3}
            autoGrow
            maxLength={16000}
            value={input.idea ?? ""}
            readOnly={!editableIdea}
            disabled={locked || view === "unavailable"}
            placeholder={
              view === "unavailable" && lead === null
                ? "Drafting needs a project lead"
                : undefined
            }
            onChange={(e) => state.edit({ idea: e.target.value })}
          />
          <span className="metadata muted">1 to 16,000 characters</span>
        </label>
        {view === "idle" && (
          <div className="composer-draft-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={!canStart || waitingForRun}
              onClick={() => void start()}
            >
              Draft with lead
            </Button>
            <span className="metadata muted">
              Fills the title and outcome for you to edit.
            </span>
          </div>
        )}
        {view === "unavailable" && (
          <>
            <div className="composer-draft-actions">
              <Button type="button" variant="secondary" disabled>
                Draft with lead
              </Button>
            </div>
            <p className="body" role="status">
              {!input.projectId ? (
                draftingCopy.chooseProject
              ) : (
                <>
                  {draftingCopy.noLead}{" "}
                  <a
                    href={`/app/projects/${encodeURIComponent(input.projectId)}/settings`}
                  >
                    Open project configuration
                  </a>
                </>
              )}
            </p>
          </>
        )}
        {(view === "queued" || view === "running") && (
          <div className="composer-draft-actions" role="status">
            <span className="composer-draft-progress">
              <span className="body">
                {view === "queued"
                  ? draftingCopy.waiting
                  : `${leadName} is reading the repositories`}
              </span>
              {view === "running" && (
                <span className="metadata muted">
                  Requested {formatElapsed(elapsed)} ago · stops by itself after{" "}
                  {formatElapsed(draftingLimitSeconds)} of running
                </span>
              )}
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void stop()}
            >
              Stop
            </Button>
          </div>
        )}
        {view === "queued" || view === "running" ? (
          <p className="metadata muted">
            You can keep editing the fields below. A draft never overwrites text
            you typed. Stopping ends the run and deletes its working copy.
          </p>
        ) : null}
        {view === "starting" && (
          <p className="body" role="status">
            Starting the draft…
          </p>
        )}
        {view === "stopping" && (
          <p className="body" role="status">
            {draftingCopy.stopping}
          </p>
        )}
        {view === "proposed" && (
          <>
            <p className="body" role="status">
              {draftingCopy.proposed}
            </p>
            <div className="composer-draft-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void settle("discard")}
              >
                Discard draft
              </Button>
            </div>
          </>
        )}
        {(view === "interrupted" || view === "failed") && (
          <>
            <div className="composer-draft-outcome" role="alert">
              <span className="body composer-draft-strong">
                {run?.reason ??
                  (view === "failed"
                    ? "The draft failed"
                    : "The draft was interrupted")}
              </span>
              <span className="body muted">
                {view === "failed"
                  ? draftingCopy.failed
                  : draftingCopy.interrupted}
              </span>
            </div>
            <div className="composer-draft-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={!canStart}
                onClick={() => void start()}
              >
                Retry
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void settle("discard")}
              >
                Dismiss
              </Button>
            </div>
          </>
        )}
        {message && (
          <p className="body" role="status">
            {message}
          </p>
        )}
        <p className="metadata muted">{draftingCopy.access}</p>
      </div>
    </section>
  );
}

/** The proposal beside text the operator already wrote, one choice per field. */
export function DraftChoice({ d, field }: { d: Drafting; field: DraftField }) {
  const choice = d.choices.find((item) => item.field === field);
  if (!choice) return null;
  return (
    <fieldset className="composer-draft-choice">
      <legend className="metadata composer-draft-choice-label">
        Proposed {field}
      </legend>
      <span className="body composer-draft-choice-text">{choice.proposed}</span>
      <span className="composer-draft-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={d.busy}
          onClick={() => d.choose(choice, true)}
        >
          Replace {field}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={d.busy}
          onClick={() => d.choose(choice, false)}
        >
          Keep mine
        </Button>
      </span>
    </fieldset>
  );
}
