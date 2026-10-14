import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  composerOptionsSchema,
  taskSchema,
  uuid,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import { Alert } from "./ui/alert.js";
import { Input } from "./ui/input.js";
import { NativeSelect } from "./ui/native-select.js";
import { Textarea } from "./ui/textarea.js";
import { ComposerState, type ComposerInput } from "./composer-state.js";
import { useOperatorResource } from "./resource.js";
import { reasonLabels } from "./tasks.js";
import { optionalFields, optionalSummary } from "./composer-summary.js";
import "./composer.css";
export function TaskComposer({
  client,
  session,
  workspace,
  initialProject = "",
  onRecorded,
}: {
  client: OperatorClient;
  session: Session;
  workspace: Workspace | null;
  initialProject?: string;
  onRecorded: () => void;
}) {
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
    await state.submit(client, session.csrfToken, ready);
    if (!isCurrent()) return;
    const first = Object.keys(state.errors)[0];
    if (first) reveal(first);
    if (state.phase === "recorded") onRecorded();
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
            {current.state.data.data.admission.reasons.map((r) => (
              <p className="body muted" key={r}>
                {reasonLabels[r]}
              </p>
            ))}
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
  // A refused or unconfirmed creation sits beside the action that made it.
  const outcomeShown = state.failed || state.phase === "unknown";
  const optionalError = Object.keys(optionalFields).some(
    (f) => state.errors[f],
  );
  return (
    <section className="composer" aria-label="Task composer">
      {state.savedOnDevice && state.phase === "editable" && (
        <p className="metadata muted composer-saved">
          Unfinished input saved on this device
        </p>
      )}
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
        <fieldset disabled={locked} className="composer-fields">
          <label className="field body" htmlFor="composer-projectId">
            Project
            <NativeSelect
              id="composer-projectId"
              aria-label="Project"
              value={input.projectId}
              onChange={(e) => {
                edit({
                  projectId: e.target.value,
                  profileId: "",
                  blockerTaskIds: [],
                });
                state.notice =
                  "Project changed. Assignee and dependency selections were cleared.";
                setDependencyQuery("");
              }}
            >
              <option value="">Choose a project</option>
              {workspace?.data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? "Name unavailable"}
                </option>
              ))}
            </NativeSelect>
            {error("projectId")}
          </label>
          {input.projectId && (
            <aside
              className="composer-inherited"
              aria-label={`Inherited from ${o?.project.name ?? "project"}`}
            >
              <p className="metadata muted composer-inherited-title">
                Inherited from {o?.project.name ?? "project"}
              </p>
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
                  {o.project.paused && (
                    <p className="body">
                      This project is paused, so the task will wait.
                    </p>
                  )}
                  {!o.lead && (
                    <p className="body">
                      Configure a project lead before execution can begin.
                    </p>
                  )}
                  <p className="body muted">
                    Capacity: {o.capacity.projectUsage}/
                    {o.capacity.projectLimit} project · {o.capacity.globalUsage}
                    /{o.capacity.globalLimit} global. Dependencies, Stop and
                    ownership are checked again when work starts.
                  </p>
                  <a
                    className="body"
                    href={`/app/projects/${encodeURIComponent(input.projectId)}/settings`}
                  >
                    View project instructions
                  </a>
                  <h3 className="small-heading">Created ≠ running</h3>
                  <p className="body muted">
                    Execution may wait for project state, dependencies, capacity
                    or holds. You'll see the reason on the task.
                  </p>
                </div>
              )}
            </aside>
          )}
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
            <span className="metadata muted">
              Outcome, optional context and reference links share a
              16,000-character brief limit.
            </span>
            {error("outcome")}
          </label>
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
                  edit({ links: e.target.value.split("\n").filter(Boolean) });
                }}
              />
              <span className="metadata muted">
                One HTTP or HTTPS link per line. References are passive context
                and grant no repository access.
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
                Choose existing tasks in this project. These must finish before
                execution can begin.
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
                        {d.source ? ` · GitHub #${d.source.number ?? "?"}` : ""}
                      </span>
                    </label>
                  ))}
              </div>
              {o?.dependencies.length === 0 && (
                <p className="body muted">No existing tasks in this project.</p>
              )}
              {error("blockerTaskIds")}
            </fieldset>
          </details>
          {!optionalOpen && (
            <div className="composer-optional-values metadata muted">
              {optional.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
              {optional.fix && <p>{optional.fix}</p>}
            </div>
          )}
        </fieldset>
        {state.phase === "pending" ? (
          <div className="composer-actions">
            <Button type="button" disabled>
              {state.frozen?.ready ? "Creating…" : "Saving…"}
            </Button>
          </div>
        ) : (
          !locked && (
            <div className="composer-actions">
              <Button type="submit">Create and start</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void submit(false)}
              >
                Save draft
              </Button>
              <p className="metadata muted">
                {optionalError
                  ? "Check the optional settings to continue. Your input is still here."
                  : "Creates ready work; waits for dependencies and other holds. Saved drafts are not Ready."}
              </p>
            </div>
          )
        )}
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
      </form>
    </section>
  );
}
