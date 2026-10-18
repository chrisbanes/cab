import { useCallback, useEffect, useRef, useState } from "react";
import { CirclePlay, Clock } from "lucide-react";
import { flushSync } from "react-dom";
import {
  composerOptionsSchema,
  taskSchema,
  uuid,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import { workspaceLabels } from "../../src/operator/project-labels.js";
import type { OperatorClient } from "./api.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import { Alert } from "./ui/alert.js";
import { Badge } from "./ui/badge.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import {
  briefNearLimit,
  ComposerState,
  type ComposerInput,
} from "./composer-state.js";
import { useOperatorResource } from "./resource.js";
import {
  orderWaits,
  runtimeWaitCodes,
  type Wait,
} from "../../src/operator/wait-reasons.js";
import type { ConfigurationDrafts } from "./settings-state.js";
import { WaitReasons } from "./wait-reasons.js";
import { optionalFields, optionalSummary } from "./composer-summary.js";
import {
  DraftChoice,
  DraftWithLead,
  releaseDraft,
  useDrafting,
} from "./composer-drafting.js";
import "./composer.css";
export function TaskComposer({
  client,
  session,
  workspace,
  initialProject = "",
  onRecorded,
  drafts,
  refresh,
}: {
  client: OperatorClient;
  session: Session;
  workspace: Workspace | null;
  initialProject?: string;
  onRecorded: () => void;
  drafts: ConfigurationDrafts;
  /** Re-reads the workspace after a Fix changes a project. */
  refresh: () => void;
}) {
  const labels = workspaceLabels(workspace);
  const [, render] = useState(0);
  const [state] = useState(() => {
    const s = new ComposerState(
      {
        getItem: (k) => sessionStorage.getItem(k),
        setItem: (k, v) => sessionStorage.setItem(k, v),
        removeItem: (k) => sessionStorage.removeItem(k),
      },
      () => render((n) => n + 1),
    );
    if (!s.recovered && uuid.safeParse(initialProject).success)
      s.input = { ...s.input, projectId: initialProject };
    return s;
  });
  useEffect(() => {
    state.activate(() => render((n) => n + 1));
    return () => state.dispose();
  }, [state]);
  const [resumed, setResumed] = useState(
      !state.recovered || state.phase === "unknown",
    ),
    [linkText, setLinkText] = useState(state.input.links.join("\n")),
    [dependencyQuery, setDependencyQuery] = useState(""),
    [optionalOpen, setOptionalOpen] = useState(false);
  const input = state.input,
    locked = state.phase !== "editable";
  // The message that follows a send replaces the button the operator used, so it takes focus.
  const sent = useRef(false);
  if (state.phase === "pending") sent.current = true;
  const optionsLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(
        `/api/operator/projects/${input.projectId}/composer-options`,
        composerOptionsSchema,
        signal,
      ),
    [client, input.projectId],
  );
  const options = useOperatorResource(
    input.projectId ? `${session.csrfToken}:${input.projectId}` : null,
    optionsLoader,
  );
  const recordedId = state.phase === "recorded" ? state.frozen?.taskId : null;
  const taskLoader = useCallback(
    (signal: AbortSignal) =>
      client.read(`/api/operator/tasks/${recordedId}`, taskSchema, signal),
    [client, recordedId],
  );
  const current = useOperatorResource(
    recordedId ? `${session.csrfToken}:${recordedId}` : null,
    taskLoader,
  );
  const edit = (patch: Partial<ComposerInput>) => state.edit(patch);
  const projectOptions = options.state.data?.data;
  const drafting = useDrafting({
    state,
    client,
    csrfToken: session.csrfToken,
    // Undefined while the project's options load; null when it has no lead.
    lead:
      input.projectId && projectOptions
        ? projectOptions.lead
          ? { name: projectOptions.lead.name }
          : null
        : undefined,
    locked,
  });
  // Fresh options can show a stored selection is no longer permitted before submit.
  const fresh =
    state.phase === "editable" && options.state.status === "fresh"
      ? options.state.data?.data
      : undefined;
  const unavailable: Record<string, string> = {};
  if (
    fresh &&
    input.profileId &&
    !fresh.profiles.some((p) => p.id === input.profileId)
  )
    unavailable.profileId = "Choose a currently permitted assignee.";
  if (
    fresh &&
    input.blockerTaskIds.some(
      (id) => !fresh.dependencies.some((d) => d.id === id),
    )
  )
    unavailable.blockerTaskIds =
      "Choose existing dependencies in this project.";
  const unavailableFields = Object.keys(unavailable).join();
  useEffect(() => {
    if (unavailableFields) setOptionalOpen(true);
  }, [unavailableFields]);
  // The collapsed section stays mounted, so an error target only needs it opened.
  const reveal = (field: string) => {
    if (field in optionalFields) flushSync(() => setOptionalOpen(true));
    document.getElementById(`composer-${field}`)?.focus();
  };
  async function submit(ready: boolean) {
    if (
      state.phase === "editable" &&
      input.projectId &&
      (!options.state.data || options.state.status !== "fresh")
    ) {
      state.refuse(ready, "the project's options haven't loaded");
      return;
    }
    const blocked = Object.keys(unavailable)[0];
    if (blocked) {
      state.errors[blocked] = unavailable[blocked] as string;
      render((n) => n + 1);
      reveal(blocked);
      return;
    }
    const isCurrent = state.captureScope();
    const draftRunId = input.draftingRunId;
    await state.submit(client, session.csrfToken, ready);
    if (!isCurrent()) return;
    const first = Object.keys(state.errors)[0];
    if (first) reveal(first);
    if (state.phase === "recorded") {
      // A draft left over from this composer ends with it.
      if (draftRunId) void releaseDraft(client, session.csrfToken, draftRunId);
      onRecorded();
    }
  }
  if (state.recovered && !resumed && state.phase === "editable")
    return (
      <section
        className="composer recovery-prompt"
        aria-label="Unfinished input"
      >
        <h2 className="section-heading">Unfinished input on this device</h2>
        <p className="body">
          This input was kept in this tab. It is not a saved Ensemble task.
        </p>
        <p className="body">{input.title || "Untitled input"}</p>
        <div className="task-actions">
          <Button onClick={() => setResumed(true)}>
            Resume unfinished input
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              // The run would otherwise outlive the input that could reach it.
              if (input.draftingRunId)
                void releaseDraft(
                  client,
                  session.csrfToken,
                  input.draftingRunId,
                );
              state.discard();
              setLinkText("");
              setResumed(true);
            }}
          >
            Discard unfinished input
          </Button>
        </div>
      </section>
    );
  if (state.phase === "recorded")
    return (
      <section
        className="composer"
        aria-label={state.frozen?.ready ? "Task created" : "Draft saved"}
      >
        <ActionOutcome
          tone="success"
          message={state.notice}
          details={detailRows(state.details)}
        >
          <ActionLink
            variant="primary"
            href={`/app/tasks/${state.frozen?.taskId}`}
          >
            Open task
          </ActionLink>
        </ActionOutcome>
        <h3 className="small-heading">Current execution</h3>
        <Button
          variant="secondary"
          onClick={current.refresh}
          disabled={current.state.pending}
        >
          Refresh execution
        </Button>
        <ResourceStatus
          state={current.state}
          retry={current.refresh}
          label="Execution updates"
        />
        {current.state.data && (
          <>
            <p className="body">
              <StatusBadge>
                {current.state.data.data.execution.state}
              </StatusBadge>
            </p>
            <WaitReasons
              waits={current.state.data.data.waits}
              taskId={current.state.data.data.task.id}
              projectId={current.state.data.data.task.projectId}
              prefix={state.frozen?.ready ? "It will wait: " : "Waiting · "}
              client={client}
              session={session}
              drafts={drafts}
              workspace={workspace}
              onChanged={() => {
                current.refresh();
                refresh();
              }}
            />
          </>
        )}
        <a className="control" href="/app/tasks">
          Back to tasks
        </a>
      </section>
    );
  const error = (field: string) => {
    const message = state.errors[field] ?? unavailable[field];
    return (
      message && (
        <span role="alert" className="body error-text">
          {message}
        </span>
      )
    );
  };
  const o = options.state.data?.data;
  const lead = o?.lead
    ? workspace?.data.profiles.find((p) => p.id === o.lead?.profileId)
    : undefined;
  const optional = optionalSummary(input, o, unavailable, state.errors);
  // The same waits the task would show, from the project's and the selected dependencies.
  const blocking = (o?.dependencies ?? []).filter(
    (d) => input.blockerTaskIds.includes(d.id) && d.blocking,
  );
  const assigneeWaits = input.profileId
    ? o?.assigneeWaits[input.profileId]
    : undefined;
  const prediction: Wait[] | null =
    o && options.state.status === "fresh"
      ? orderWaits([
          // An explicit assignee runs the turn, so its runtime waits replace the lead's.
          ...(assigneeWaits
            ? [
                ...o.waits.filter((w) => !runtimeWaitCodes.includes(w.code)),
                ...assigneeWaits,
              ]
            : o.waits),
          ...(blocking.length
            ? [
                {
                  code: "local-dependency" as const,
                  fix: null,
                  links: blocking.map((d) => ({
                    kind: "task" as const,
                    id: d.id,
                    label: d.title ?? "Unavailable task",
                  })),
                },
              ]
            : []),
        ])
      : null;
  // A refused or unconfirmed creation sits just above the bar that made it.
  const outcomeShown = state.failed || state.phase === "unknown";
  const optionalError = Object.keys(optionalFields).some(
    (f) => state.errors[f],
  );
  return (
    <section className="composer" aria-label="Task composer">
      {state.notice && !outcomeShown && (
        <Alert className="resource-status" role="status">
          {state.notice}
        </Alert>
      )}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <div className="composer-body">
          <fieldset disabled={locked} className="composer-fields">
            <DraftWithLead d={drafting} state={state} />
            <div className="composer-lead-row">
              <label className="field body" htmlFor="composer-projectId">
                Project
                <NativeSelect
                  id="composer-projectId"
                  aria-label="Project"
                  // A start still in flight cannot yet be released for another project.
                  disabled={drafting.starting}
                  value={input.projectId}
                  onChange={(e) => {
                    // A draft read the old project's repositories, so it ends with the change.
                    const staleDraft = input.draftingRunId;
                    if (staleDraft)
                      void releaseDraft(client, session.csrfToken, staleDraft);
                    edit({
                      projectId: e.target.value,
                      profileId: "",
                      blockerTaskIds: [],
                      draftingRunId: undefined,
                      draftingKey: undefined,
                    });
                    state.notice = staleDraft
                      ? "Project changed. Assignee and dependency selections were cleared, and the draft for the previous project was ended."
                      : "Project changed. Assignee and dependency selections were cleared.";
                    setDependencyQuery("");
                  }}
                >
                  <option value="">Choose a project</option>
                  {workspace?.data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {labels.get(p.id)?.text}
                    </option>
                  ))}
                </NativeSelect>
                {error("projectId")}
              </label>
              <div className="composer-title-cell">
                <label className="field body" htmlFor="composer-title">
                  Task title
                  <Input
                    id="composer-title"
                    aria-label="Task title"
                    className="control"
                    value={input.title}
                    onChange={(e) => edit({ title: e.target.value })}
                    aria-invalid={Boolean(state.errors.title)}
                  />
                  {error("title")}
                </label>
                <DraftChoice d={drafting} field="title" />
              </div>
            </div>
            <label className="field body" htmlFor="composer-outcome">
              Desired outcome
              <Textarea
                id="composer-outcome"
                aria-label="Desired outcome"
                className="control outcome-input"
                rows={9}
                autoGrow
                maxAutoGrowHeight={480}
                value={input.outcome}
                onChange={(e) => edit({ outcome: e.target.value })}
                aria-invalid={Boolean(state.errors.outcome)}
              />
              {briefNearLimit(input) && (
                <span className="metadata muted">
                  Outcome, optional context and reference links share a
                  16,000-character brief limit.
                </span>
              )}
              {error("outcome")}
            </label>
            <DraftChoice d={drafting} field="outcome" />
            <div
              className="composer-optional"
              data-invalid={optional.fix ? "true" : undefined}
            >
              <details
                className="composer-disclosure"
                open={optionalOpen}
                onToggle={(e) => setOptionalOpen(e.currentTarget.open)}
              >
                <summary className="small-heading">{optional.summary}</summary>
                <label className="field body" htmlFor="composer-context">
                  Optional context
                  <Textarea
                    id="composer-context"
                    aria-label="Optional context"
                    className="control"
                    rows={5}
                    autoGrow
                    value={input.context}
                    onChange={(e) => edit({ context: e.target.value })}
                  />
                  {error("context")}
                </label>
                <label className="field body" htmlFor="composer-links">
                  Reference links
                  <Textarea
                    id="composer-links"
                    aria-label="Reference links"
                    className="control"
                    rows={3}
                    value={linkText}
                    onChange={(e) => {
                      setLinkText(e.target.value);
                      edit({
                        links: e.target.value.split("\n").filter(Boolean),
                      });
                    }}
                  />
                  <span className="metadata muted">
                    One HTTP or HTTPS link per line. References are passive
                    context and grant no repository access.
                  </span>
                  {error("links")}
                </label>
                <label className="field body" htmlFor="composer-profileId">
                  Assignee
                  <NativeSelect
                    id="composer-profileId"
                    aria-label="Assignee"
                    value={input.profileId}
                    onChange={(e) => edit({ profileId: e.target.value })}
                    disabled={!o || options.state.status !== "fresh"}
                  >
                    <option value="">
                      {o?.routingEnabled
                        ? "Automatic allocation via project routing"
                        : "Default project lead allocation"}
                    </option>
                    {o?.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name ?? "Name unavailable"}
                      </option>
                    ))}
                  </NativeSelect>
                  <span className="metadata muted">
                    An explicit assignee skips routing, but every hold still
                    applies. The project lead remains accountable.
                  </span>
                  {error("profileId")}
                </label>
                <fieldset
                  className="dependency-options"
                  disabled={!o || options.state.status !== "fresh"}
                >
                  <legend className="small-heading">Dependencies</legend>
                  <p className="body muted">
                    Choose existing tasks in this project. These must finish
                    before execution can begin.
                  </p>
                  <label className="field body" htmlFor="dependency-search">
                    Find dependencies
                    <Input
                      id="dependency-search"
                      className="control"
                      value={dependencyQuery}
                      onChange={(e) => setDependencyQuery(e.target.value)}
                    />
                  </label>
                  <div
                    id="composer-blockerTaskIds"
                    className="dependency-list"
                    tabIndex={-1}
                  >
                    {o?.dependencies
                      .filter(
                        (d) =>
                          !dependencyQuery ||
                          d.title
                            ?.toLocaleLowerCase()
                            .includes(dependencyQuery.toLocaleLowerCase()),
                      )
                      .map((d) => (
                        <label className="dependency-choice body" key={d.id}>
                          <input
                            type="checkbox"
                            aria-label={d.title ?? "Title unavailable"}
                            checked={input.blockerTaskIds.includes(d.id)}
                            onChange={(e) =>
                              edit({
                                blockerTaskIds: e.target.checked
                                  ? [...input.blockerTaskIds, d.id]
                                  : input.blockerTaskIds.filter(
                                      (id) => id !== d.id,
                                    ),
                              })
                            }
                          />
                          <span>{d.title ?? "Title unavailable"}</span>
                          <span className="metadata muted">
                            {d.state}
                            {d.source
                              ? ` · GitHub #${d.source.number ?? "?"}`
                              : ""}
                          </span>
                        </label>
                      ))}
                  </div>
                  {o?.dependencies.length === 0 && (
                    <p className="body muted">
                      No existing tasks in this project.
                    </p>
                  )}
                  {error("blockerTaskIds")}
                </fieldset>
              </details>
              {!optionalOpen && optional.chips.length > 0 && (
                <ul
                  className="composer-optional-chips"
                  aria-label="Supplied optional values"
                >
                  {optional.chips.map((chip) => (
                    <li
                      key={chip.field}
                      data-invalid={chip.invalid ? "true" : undefined}
                    >
                      {chip.invalid && (
                        <>
                          <span aria-hidden="true">!</span>
                          <span className="sr-only">Error: </span>
                        </>
                      )}
                      {chip.text}
                    </li>
                  ))}
                </ul>
              )}
              {!optionalOpen && optional.fix && (
                <p className="metadata composer-optional-fix">{optional.fix}</p>
              )}
            </div>
          </fieldset>
          {input.projectId && (
            <aside className="composer-aside" aria-label="Before you create">
              {prediction && !locked && (
                <section
                  className="composer-prediction"
                  aria-labelledby="composer-prediction-title"
                  aria-live="polite"
                >
                  <div className="composer-prediction-head">
                    <h2
                      id="composer-prediction-title"
                      className="small-heading"
                    >
                      If you create it now
                    </h2>
                    {prediction.length ? (
                      <Badge variant="secondary" className="metadata">
                        <Clock aria-hidden="true" />
                        Will wait
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="metadata border-(--accent-edge) text-(--accent-text)"
                      >
                        <CirclePlay aria-hidden="true" />
                        Starts now
                      </Badge>
                    )}
                  </div>
                  {/* Kept when no wait remains, so a Resume outcome stays visible. */}
                  <WaitReasons
                    waits={prediction}
                    projectId={input.projectId}
                    variant="numbered"
                    client={client}
                    session={session}
                    drafts={drafts}
                    workspace={workspace}
                    onChanged={() => {
                      void options.refresh();
                      refresh();
                    }}
                  />
                  {prediction.length > 0 && (
                    <p className="metadata muted">
                      Created ≠ running. Execution may wait for project state,
                      dependencies, capacity or holds. You'll see the reason on
                      the task.
                    </p>
                  )}
                </section>
              )}
              <section
                className="composer-inherited"
                aria-labelledby="composer-inherited-title"
              >
                <h2
                  id="composer-inherited-title"
                  className="metadata muted composer-inherited-title"
                >
                  Inherited from {o?.project.name ?? "project"}
                </h2>
                <ResourceStatus
                  state={options.state}
                  retry={options.refresh}
                  label="Project options"
                />
                {o && (
                  <div className="composer-policy">
                    <p className="metadata muted">Accountable lead</p>
                    <p className="body">
                      {o.lead?.name ??
                        (o.lead ? "Name unavailable" : "Unconfigured")}
                    </p>
                    {lead?.summary && (
                      <p className="body muted">{lead.summary}</p>
                    )}
                    <p className="body muted">
                      {o.routingEnabled
                        ? "Routing chooses an assignee unless you pick one."
                        : "The project lead is assigned unless you pick one."}
                    </p>
                    <p className="body muted">
                      Capacity: {o.capacity.projectUsage}/
                      {o.capacity.projectLimit} project ·{" "}
                      {o.capacity.globalUsage}/{o.capacity.globalLimit} global.
                      Dependencies, Stop and ownership are checked again when
                      work starts.
                    </p>
                    <a
                      className="body"
                      href={`/app/projects/${encodeURIComponent(input.projectId)}/settings`}
                    >
                      View project instructions
                    </a>
                  </div>
                )}
              </section>
            </aside>
          )}
        </div>
        {state.failed && (
          <ActionOutcome
            key={state.details.requestKey}
            tone="error"
            message={state.notice}
            details={detailRows(state.details)}
          />
        )}
        {state.phase === "unknown" && (
          <ActionOutcome
            tone="warning"
            message={state.notice}
            action={{
              label: "Check whether it saved",
              onClick: () => submit(state.frozen?.ready ?? false),
            }}
            focus={sent.current}
            details={detailRows(state.details)}
          />
        )}
        {state.phase === "pending" ? (
          <div className="composer-actions">
            <Button type="button" disabled>
              {state.frozen?.ready ? "Creating…" : "Saving…"}
            </Button>
          </div>
        ) : (
          !locked && (
            <div className="composer-actions">
              {state.savedOnDevice && (
                <p className="metadata muted">
                  Unfinished input saved on this device · not yet an Ensemble
                  draft
                </p>
              )}
              <div className="composer-actions-end">
                <p className="metadata muted">
                  {optionalError
                    ? "Check the optional settings to continue. Your input is still here."
                    : "Save draft keeps it without starting."}
                </p>
                <Button type="submit">Create and start</Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void submit(false)}
                >
                  Save draft
                </Button>
              </div>
            </div>
          )
        )}
      </form>
    </section>
  );
}
