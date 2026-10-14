import { useCallback, useId, useRef, useState } from "react";
import {
  executionHarnessLabels,
  runtimeSettingsSchema,
  assignmentRecoverySchema,
  type HarnessStatus,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import { ActionOutcome, detailRows } from "./action-feedback.js";
import { failureCause } from "./outcome-copy.js";
import { Input } from "./ui/input.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.js";
import { AddClaudePanel } from "./add-claude.js";
import {
  disableConfirmation,
  executableMissingMessage,
  executionSummary,
  harnessReason,
  harnessStateLabel,
} from "./execution-runtime.js";
import { ExecutionNotices, PolicyDisclosure } from "./execution-notice.js";
import { useOperatorResource } from "./resource.js";
import {
  ActionLink,
  Button,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
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
  reloadDraft,
  useDraft,
  useHeaderRefresh,
  useLoadedDraft,
  submitDraft,
  type SettingsProps,
} from "./settings.js";
type Outcome = {
  tone: "success" | "error" | "warning";
  message: string;
  details: ReturnType<typeof detailRows>;
  /** Resend the exact original command. */
  retry?: () => void;
};

/**
 * The on/off control of one execution runtime and its one outcome. Turning off a runtime
 * that tasks use confirms first, with the count read fresh; an unknown outcome resends the
 * exact same command (a replayed key returns the stored receipt).
 */
function RuntimeToggle(
  p: SettingsProps & { status: HarnessStatus; reload: () => void },
) {
  const { harness } = p.status,
    label = executionHarnessLabels[harness],
    [pending, setPending] = useState(false),
    [outcome, setOutcome] = useState<Outcome | null>(null),
    [confirm, setConfirm] = useState<number | null>(null),
    control = useRef<HTMLInputElement>(null),
    id = useId();
  const boundTasks = async () =>
    (
      await p.client
        .read("/api/operator/runtime", runtimeSettingsSchema)
        .catch(() => null)
    )?.data.runtimes.find((r) => r.harness === harness)?.boundTasks ?? 0;
  const send = async (
    command: Extract<OperatorCommand, { type: "runtime.configure" }>,
  ) => {
    setPending(true);
    setConfirm(null);
    setOutcome(null);
    const result = await p.client.command(command, p.session.csrfToken);
    const details = (code?: string) =>
      detailRows({
        command: command.type,
        resource: `system:runtime:${harness}`,
        requestKey: command.key,
        ...(code ? { code } : {}),
      });
    if (result.state === "recorded") {
      setOutcome({
        tone: "success",
        message: `${label} turned ${command.enabled ? "on" : "off"}.`,
        details: details(),
      });
      p.refresh();
      p.reload();
    } else if (result.state === "unknown")
      setOutcome({
        tone: "warning",
        message: "We couldn't confirm the change.",
        details: details(result.code),
        retry: () => void send(command),
      });
    else if (result.code === "runtime-confirmation-required") {
      const tasks = await boundTasks();
      if (tasks > 0) setConfirm(tasks);
      else
        setOutcome({
          tone: "error",
          message: `Couldn't turn off ${label}: it changed elsewhere.`,
          details: details(result.code),
        });
    } else
      setOutcome({
        tone: "error",
        message:
          result.code === "runtime-executable-missing"
            ? executableMissingMessage(harness)
            : `Couldn't turn ${command.enabled ? "on" : "off"} ${label}: ${failureCause(result.code)}.`,
        details: details(result.code),
      });
    setPending(false);
    requestAnimationFrame(() => control.current?.focus());
  };
  const command = (enabled: boolean, confirmedBoundTasks?: number) =>
    ({
      type: "runtime.configure",
      key: crypto.randomUUID(),
      harness,
      enabled,
      ...(confirmedBoundTasks === undefined ? {} : { confirmedBoundTasks }),
    }) as const;
  const toggle = async (enabled: boolean) => {
    if (enabled) return send(command(true));
    setPending(true);
    const tasks = await boundTasks();
    setPending(false);
    if (tasks > 0) setConfirm(tasks);
    else void send(command(false));
  };
  const reason = harnessReason(p.status);
  return (
    <>
      <label className="body check-field" htmlFor={id}>
        <Input
          id={id}
          ref={control}
          type="checkbox"
          role="switch"
          className="native-check settings-switch size-5 shrink-0 p-0 accent-foreground"
          checked={p.status.enabled}
          disabled={pending || confirm !== null || Boolean(outcome?.retry)}
          aria-busy={pending}
          onChange={(e) => void toggle(e.target.checked)}
        />
        {label} enabled
      </label>
      {reason && <p className="metadata muted">{reason}</p>}
      {outcome && (
        <ActionOutcome
          tone={outcome.tone}
          message={outcome.message}
          details={outcome.details}
          action={
            outcome.retry && {
              label: "Check whether it saved",
              onClick: outcome.retry,
            }
          }
        />
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <DialogContent
          role="alertdialog"
          className="stop-dialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement)
              .querySelector<HTMLElement>("[data-keep]")
              ?.focus();
          }}
        >
          <DialogTitle>Turn off {label}?</DialogTitle>
          <DialogDescription className="body">
            {confirm !== null && disableConfirmation(harness, confirm)}
          </DialogDescription>
          <div className="stop-dialog-actions">
            <Button
              type="button"
              variant="destructive"
              onClick={() => void send(command(false, confirm ?? 0))}
            >
              Turn off {label}
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="secondary" data-keep>
                Cancel
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

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
            new starts until usage fits; active turns keep running. Two saves at
            the same time can overwrite each other.
          </p>
          <div className="settings-split">
            <div className="settings-column">
              <AddClaudePanel {...p} />
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
                    refresh={resource.refresh}
                  />
                </form>
              </Panel>
              <Panel
                title="Execution runtimes"
                description="Work for a runtime that is not enabled or unavailable waits; it never falls back to another runtime."
              >
                {p.workspace?.data.harnesses.map((h) => (
                  <div className="settings-row" key={h.harness}>
                    <div className="settings-row-heading">
                      <h3 className="small-heading">
                        {executionHarnessLabels[h.harness]}
                      </h3>
                      <StatusBadge
                        tone={
                          h.state === "unavailable"
                            ? "error"
                            : h.state === "available"
                              ? "success"
                              : "neutral"
                        }
                      >
                        {harnessStateLabel[h.state]}
                      </StatusBadge>
                    </div>
                    <RuntimeToggle
                      {...p}
                      status={h}
                      reload={resource.refresh}
                    />
                    <h4 className="small-heading">
                      Effective execution policy
                    </h4>
                    <PolicyDisclosure
                      harness={h.harness}
                      workspace={p.workspace}
                    />
                  </div>
                ))}
              </Panel>
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
              successor or follow-up can start until this execution is confirmed
              ended. Resume does not clear this, and neither does time passing
              or an acknowledgement.
            </Alert>
          )}
          <div className="settings-phone-cards">
            <Aside
              title="Task-wide holds"
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
                title="Task-wide holds"
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
                  uncertainty. Elapsed time or an interruption acknowledgement
                  does not prove the execution ended.
                </p>
              </Panel>
              <Panel title="Versions and generation in use">
                <p className="body">
                  {`Configured assignment version ${data.assignment.version}; captured instructions version `}
                  {data.assignment.instructionsRevision}, profile version{" "}
                  {data.assignment.profileRevision}. Next-turn instructions
                  version {data.assignment.currentInstructionsRevision}, profile
                  version {data.assignment.currentProfileRevision}.
                </p>
                {data.assignment.executionGeneration ? (
                  <p className="body">
                    Generation in use: assignment version{" "}
                    {data.assignment.executionGeneration.assignmentVersion},
                    request sequence{" "}
                    {data.assignment.executionGeneration.requestSequence},
                    instructions version{" "}
                    {data.assignment.executionGeneration.instructionsRevision},
                    profile version{" "}
                    {data.assignment.executionGeneration.profileRevision}.
                  </p>
                ) : (
                  <p className="body">
                    The generation in use is unavailable. This does not prove
                    execution ended.
                  </p>
                )}
                <p className="body">
                  Execution runtime: {executionSummary(data.assignment).line}.
                </p>
                <ExecutionNotices assignment={data.assignment} />
              </Panel>
              <Panel
                title="Selected assignment evidence"
                description={
                  data.omittedCount > 0
                    ? `${plural(data.omittedCount, "older recovery record")} for this assignment omitted; task-wide holds above include verified sibling and omitted generations.`
                    : undefined
                }
              >
                {!data.evidenceAvailable && (
                  <p className="body">
                    Recovery evidence unavailable for this assignment. Absence
                    of records does not prove release.
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
