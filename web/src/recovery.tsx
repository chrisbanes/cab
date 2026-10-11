import { useCallback } from "react";
import {
  runtimeSettingsSchema,
  assignmentRecoverySchema,
} from "../../src/operator/contracts.js";
import { useOperatorResource } from "./resource.js";
import { ActionLink, ResourceStatus, StatusBadge } from "./components.js";
import { capacityChanges, type Values } from "./settings-changes.js";
import { holdPills, plural } from "./settings-view.js";
import { Alert } from "./ui/alert.js";
import {
  Aside,
  ChangeList,
  DraftField,
  DraftCheck,
  DraftOutcome,
  Panel,
  SavedNotice,
  reloadDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  submitDraft,
  type SettingsProps,
} from "./settings.js";
export function RuntimeSettings(p: SettingsProps) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read("/api/operator/runtime", runtimeSettingsSchema, signal),
      [p.client],
    ),
    resource = useOperatorResource(p.session.csrfToken, loader),
    data = resource.state.data?.data,
    d = useDraft(p.drafts, "capacity.configure");
  useHeaderRefresh(p.refreshNonce, resource.refresh);
  const initial: Values | null = data
    ? {
        globalLimit: String(data.globalLimit),
        ...Object.fromEntries(
          data.projects.flatMap((r) => [
            [`override-${r.project.id}`, r.override !== null],
            [`limit-${r.project.id}`, String(r.override ?? r.limit)],
          ]),
        ),
      }
    : null;
  useLoadedDraft(d, initial, resource.state.fetchedAt);
  const lines = data ? capacityChanges(data, d.values) : [];
  return (
    <div className="settings-page">
      <ResourceStatus
        label="Runtime settings"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          <p className="introduction muted">
            {data.globalUsage} of {data.globalLimit} active turns in use;
            projects default to {data.defaultProjectLimit}. Lowering a cap stops
            new starts until usage fits; active turns keep running. Capacity
            uses a keyed command with no configuration version or
            compare-and-swap guarantee.
          </p>
          <div className="settings-split">
            <div className="settings-column">
              <Panel
                title="Capacity"
                description="Waiting for workers, people or feedback releases a slot."
              >
                <form
                  onSubmit={(e) =>
                    void submitDraft(
                      e,
                      d,
                      p.client,
                      p.session,
                      {
                        type: "capacity.configure",
                        key: d.values.key,
                        globalLimit: Number(d.values.globalLimit),
                        projectOverrides: Object.fromEntries(
                          data.projects.map((r) => [
                            r.project.id,
                            d.values[`override-${r.project.id}`]
                              ? Number(d.values[`limit-${r.project.id}`])
                              : null,
                          ]),
                        ),
                      },
                      resource.refresh,
                    )
                  }
                >
                  <DraftField
                    draft={d}
                    field="globalLimit"
                    label="Global active-turn cap"
                    type="number"
                  />
                  {data.projects.map((r) => {
                    const name = r.project.name ?? "project";
                    return (
                      <div className="settings-row" key={r.project.id}>
                        <div className="settings-row-heading">
                          <h3 className="small-heading">
                            {r.project.name ?? "Project name unavailable"}
                          </h3>
                          <span className="metadata muted">
                            Usage {r.usage} / effective limit {r.limit} ·
                            Project {r.project.paused ? "paused" : "enabled"}
                          </span>
                        </div>
                        <DraftCheck
                          draft={d}
                          field={`override-${r.project.id}`}
                          label={`Set capacity override for ${name}`}
                        />
                        {d.values[`override-${r.project.id}`] && (
                          <DraftField
                            draft={d}
                            field={`limit-${r.project.id}`}
                            label={`Active-turn cap for ${name}`}
                            type="number"
                          />
                        )}
                        {r.usage > 0 && r.tasks.some((t) => t.held) && (
                          <p className="metadata muted">
                            A slot in use may belong to a held execution;
                            pausing or saving capacity does not release it.
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <ChangeList lines={lines} />
                  <DraftOutcome
                    draft={d}
                    client={p.client}
                    session={p.session}
                    label="Save capacity"
                    saveDisabled={lines.length === 0}
                    discard={() => initial && reloadDraft(d, initial)}
                    onRecorded={resource.refresh}
                  />
                </form>
              </Panel>
              <SavedNotice
                saved={p.drafts.saved("capacity.configure")}
                label="Saved capacity"
              />
            </div>
            <section
              className="settings-column"
              aria-labelledby="recovery-destinations"
            >
              <h2 id="recovery-destinations" className="settings-panel-title">
                Task recovery destinations
              </h2>
              {data.projects.flatMap((r) =>
                r.tasks.map((task) => (
                  <article className="settings-panel" key={task.taskId}>
                    <div className="settings-row-heading">
                      <h3 className="small-heading">
                        {r.project.name ?? "Project"} ·{" "}
                        {task.title ?? "Task title unavailable"}
                      </h3>
                      <StatusBadge tone={task.held ? "warning" : "neutral"}>
                        {task.held
                          ? "Execution hold recorded"
                          : task.paused
                            ? "Project paused"
                            : "Review execution evidence"}
                      </StatusBadge>
                    </div>
                    <div className="settings-actions">
                      <ActionLink
                        variant="secondary"
                        href={`/app/tasks/${task.taskId}`}
                      >
                        Task detail
                      </ActionLink>
                      <ActionLink
                        variant="secondary"
                        href={`/runtime/task/${task.taskId}`}
                      >
                        Task controls
                      </ActionLink>
                    </div>
                    <ul className="settings-links body">
                      {task.assignments.map((a) => (
                        <li key={a.assignmentId}>
                          <a
                            href={`/app/assignments/${a.assignmentId}/recovery`}
                          >
                            {a.name ?? "Profile name unavailable"}: recovery
                            evidence
                          </a>
                        </li>
                      ))}
                    </ul>
                  </article>
                )),
              )}
              {data.projects.every((r) => r.tasks.length === 0) && (
                <p className="body muted">No task recovery destinations.</p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
export function AssignmentRecovery(
  p: SettingsProps & { assignmentId: string },
) {
  const loader = useCallback(
      (signal: AbortSignal) =>
        p.client.read(
          `/api/operator/assignments/${p.assignmentId}/recovery`,
          assignmentRecoverySchema,
          signal,
        ),
      [p.client, p.assignmentId],
    ),
    resource = useOperatorResource(
      `${p.session.csrfToken}:${p.assignmentId}`,
      loader,
    ),
    data = resource.state.data?.data;
  useHeaderRefresh(p.refreshNonce, resource.refresh);
  const inspect = data
    ? `/app/tasks/${data.taskId}?assignment=${p.assignmentId}`
    : "";
  const pills = data ? holdPills(data.holds) : [];
  return (
    <div className="settings-page">
      <ResourceStatus
        label="Recovery evidence"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          <p className="settings-status body muted">
            <StatusBadge tone={data.held ? "warning" : "neutral"}>
              {data.held ? "Execution held" : "No unresolved hold reported"}
            </StatusBadge>{" "}
            {data.assignment.name ?? "Profile name unavailable"} in{" "}
            {data.project.name ?? "Project name unavailable"} · Project{" "}
            {data.project.paused ? "paused" : "enabled"}
          </p>
          {data.holds.uncertainty && (
            <Alert variant="destructive" role="alert">
              <strong>Execution may still be active.</strong> No replacement,
              successor or follow-up can start until this execution is
              reconciled. Resume does not clear it; time, acknowledgement or a
              newer receipt is not proof that it ended.
            </Alert>
          )}
          <div className="settings-phone-cards">
            <Aside
              title="Current holds"
              items={pills.map((h) => `${h.label}: ${h.value.toLowerCase()}`)}
            />
            <section className="settings-aside" aria-label="Next step">
              <h2 className="small-heading">Next step</h2>
              <p className="body">
                Inspect the execution. Detailed recovery evidence and controls
                are desktop-first.
              </p>
            </section>
          </div>
          <div className="settings-split">
            <div className="settings-column">
              <Panel
                title="Independent task-associated holds"
                description="Aggregated across all verified task records, including omitted generations."
                className="settings-desktop"
              >
                <ul className="settings-pills">
                  {pills.map((h) => (
                    <li key={h.label} className="settings-pill body">
                      {h.label}
                      <StatusBadge tone={h.tone}>{h.value}</StatusBadge>
                    </li>
                  ))}
                </ul>
                <p className="metadata muted">
                  Resume does not release writer ownership, capacity or
                  uncertainty. A newer receipt, elapsed time or interruption
                  acknowledgement provides no termination proof.
                </p>
              </Panel>
              <Panel title="Revisions and actual admitted generation">
                <p className="body">
                  {`Configured assignment version ${data.assignment.version}; captured instruction revision `}
                  {data.assignment.instructionsRevision}, profile revision{" "}
                  {data.assignment.profileRevision}. Current next-turn
                  instruction revision{" "}
                  {data.assignment.currentInstructionsRevision}, profile
                  revision {data.assignment.currentProfileRevision}.
                </p>
                {data.assignment.executionGeneration ? (
                  <p className="body">
                    Actual admitted generation: assignment version{" "}
                    {data.assignment.executionGeneration.assignmentVersion},
                    request sequence{" "}
                    {data.assignment.executionGeneration.requestSequence},
                    instruction revision{" "}
                    {data.assignment.executionGeneration.instructionsRevision},
                    profile revision{" "}
                    {data.assignment.executionGeneration.profileRevision}.
                  </p>
                ) : (
                  <p className="body">
                    Admitted generation unavailable. This does not prove
                    execution ended.
                  </p>
                )}
              </Panel>
              <Panel
                title="Recorded evidence"
                description={
                  data.omittedCount > 0
                    ? `${plural(data.omittedCount, "older recovery record")} omitted; their unresolved holds remain included above.`
                    : undefined
                }
              >
                {!data.evidenceAvailable && (
                  <p className="body">
                    Recovery evidence unavailable. Absence of records does not
                    prove release.
                  </p>
                )}
                {data.records.map((r) => (
                  <article
                    className="settings-row"
                    key={`${r.workId}-${r.generation.workRevision}-${r.generation.requestSequence}`}
                  >
                    <h3 className="small-heading">
                      {`Generation ${r.generation.workRevision ?? "unavailable"}; request ${r.generation.requestSequence}`}
                    </h3>
                    <p className="body">
                      Intent {r.intentState}; request{" "}
                      {r.requestState ?? "unavailable"}; binding{" "}
                      {r.binding
                        ? `assignment version ${r.binding.assignmentVersion}, instructions ${r.binding.instructionsRevision}, profile ${r.binding.profileRevision}`
                        : "unavailable"}
                      .
                    </p>
                    <p className="body">
                      Observations: {r.observations.join(", ") || "unavailable"}
                      . Pending effects: {r.pendingEffectCount}. Receipt{" "}
                      {`${r.receiptRecorded ? "recorded" : "not recorded"}; workspace ${r.workspace}.`}
                    </p>
                    {r.noTurnSubmission && (
                      <p className="body">
                        Historical no-turn submission witness{" "}
                        {r.noTurnSubmission.id}. Operator-adopted evidence; an
                        unobserved idle thread may exist. This records evidence,
                        not recovery or permission to dispatch.
                      </p>
                    )}
                    {r.preTurnRejection && (
                      <p className="body">
                        Before-turn archived resume witness{" "}
                        {r.preTurnRejection.id}. Source{" "}
                        {r.preTurnRejection.source}. This records rejection
                        evidence, not recovery or permission to dispatch.
                      </p>
                    )}
                    <p className="metadata muted">
                      Stop {r.holds.stop ? "active" : "inactive"}; writer{" "}
                      {r.holds.writer ? "held" : "not recorded"}; capacity{" "}
                      {r.holds.capacity ? "held" : "not recorded"}; uncertainty{" "}
                      {r.holds.uncertainty ? "active" : "not recorded"}.
                    </p>
                  </article>
                ))}
              </Panel>
            </div>
            <div className="settings-column">
              <Panel title="Next supported step">
                <p className="body">
                  Inspect the execution, then review independent evidence in the
                  advanced recovery destination. This view is read-only: it
                  releases no ownership and accepts no proof.
                </p>
                <ActionLink href={inspect} className="settings-wide">
                  Inspect execution
                </ActionLink>
              </Panel>
              <Aside
                title="Advanced destinations · desktop-first"
                items={[
                  <a key="a" href={`/runtime/assignment/${p.assignmentId}`}>
                    Advanced recovery evidence and exact Apply
                  </a>,
                  <a key="b" href={`/runtime/task/${data.taskId}`}>
                    Task Stop, Resume and dependencies
                  </a>,
                  <a
                    key="c"
                    href={`/coordination/assignment/${p.assignmentId}`}
                  >
                    Captured assignment history
                  </a>,
                  <a key="d" href={inspect}>
                    Task detail
                  </a>,
                  <a key="e" href={`/coordination/task/${data.taskId}`}>
                    Messages, results, questions and approvals
                  </a>,
                  <a key="f" href={`/assignment/${p.assignmentId}`}>
                    Exact captured instructions and result destination
                  </a>,
                ]}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
