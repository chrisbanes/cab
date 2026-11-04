import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Circle, CirclePause, CircleSlash } from "lucide-react";
import {
  executionHarnessLabels,
  runtimeSettingsSchema,
  assignmentRecoverySchema,
  recoveryOptionsSchema,
  operatorCommandSchema,
  type CommandReceipt,
  type HarnessStatus,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
import { CommandLifecycle } from "./command-lifecycle.js";
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
import { ExecutionNotices, RuntimePolicy } from "./execution-notice.js";
import { useOperatorResource } from "./resource.js";
import {
  ActionLink,
  Button,
  ProjectName,
  ResourceStatus,
  StatusBadge,
} from "./components.js";
import {
  projectLabel,
  workspaceLabels,
} from "../../src/operator/project-labels.js";
import { capacityChanges, type Values } from "./settings-changes.js";
import { useFragmentLanding } from "./settings-sections.js";
import { holdPills, plural, recoveryRecordRuns } from "./settings-view.js";
import {
  evidenceWarning,
  executionStatus,
  recoveryAssignmentFacts,
  recoveryTaskFacts,
  resumeWarning,
} from "./task-execution-model.js";
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
  /** The switch is off while the check is pending, so the check takes the focus. */
  focus?: boolean;
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
    // The switch regains focus once the commit that re-enables it; a frame callback can run first.
    restore = useRef(false),
    id = useId();
  useEffect(() => {
    if (!restore.current || pending || confirm !== null || outcome?.retry)
      return;
    restore.current = false;
    control.current?.focus();
  });
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
    restore.current = false;
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
        focus: true,
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
    restore.current = true;
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
          focus={outcome.focus}
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
  const writableProjects =
    resource.state.status === "fresh" &&
    !resource.state.pending &&
    !resource.state.error
      ? (data?.projects.filter((row) => row.project.archived === false) ?? [])
      : [];
  const writableProjectIds = new Set(
    writableProjects.map((row) => row.project.id),
  );
  const frozenCapacity = d.frozen;
  d.readOnly =
    frozenCapacity?.type === "capacity.configure" &&
    Object.keys(frozenCapacity.projectOverrides).some(
      (id) => !writableProjectIds.has(id),
    );
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
  // `/app/settings/runtime#add-claude` lands once the panel exists.
  useFragmentLanding(Boolean(data));
  const labels = workspaceLabels(p.workspace);
  type ProjectRow = NonNullable<typeof data>["projects"][number];
  const labelOf = (r: ProjectRow) =>
    projectLabel(labels, r.project.id, r.project.name);
  const lines = data
    ? capacityChanges(
        { ...data, projects: writableProjects },
        d.values,
        (r) => labelOf(r).text,
      )
    : [];
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
                              : "idle"
                        }
                        icon={
                          h.state === "not-configured" ? CircleSlash : undefined
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
                    <RuntimePolicy
                      harness={h.harness}
                      workspace={p.workspace}
                    />
                  </div>
                ))}
              </Panel>
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
                          writableProjects.map((r) => [
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
                    const name = labelOf(r).text;
                    return (
                      <div className="settings-row" key={r.project.id}>
                        <div className="settings-row-heading">
                          <h3 className="small-heading">
                            <ProjectName label={labelOf(r)} id={r.project.id} />
                          </h3>
                          <span className="metadata muted">
                            Usage {r.usage} / effective limit {r.limit} ·
                            Project {r.project.paused ? "paused" : "enabled"}
                          </span>
                        </div>
                        {r.project.archived && (
                          <p className="metadata muted">
                            Archived · capacity is read-only.
                          </p>
                        )}
                        <fieldset disabled={r.project.archived}>
                          <DraftCheck
                            draft={d}
                            field={`override-${r.project.id}`}
                            label={`Set capacity override for ${name}`}
                          />
                          {d.values[`override-${r.project.id}`] && (
                            <DraftField
                              draft={d}
                              field={`limit-${r.project.id}`}
                              errorField={`projectOverrides.${r.project.id}`}
                              label={`Active-turn cap for ${name}`}
                              type="number"
                            />
                          )}
                        </fieldset>
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
                        <ProjectName label={labelOf(r)} id={r.project.id} /> ·{" "}
                        {task.title ?? "Task title unavailable"}
                      </h3>
                      <StatusBadge
                        tone={task.held ? "warning" : "idle"}
                        icon={
                          task.held
                            ? undefined
                            : task.paused
                              ? CirclePause
                              : Circle
                        }
                      >
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
                        href={`/app/tasks/${task.taskId}?section=execution`}
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
/** A recovery witness inside its generation's record: evidence only. */
function Witness({
  title,
  id,
  source,
  children,
}: {
  title: string;
  id: string;
  source: "runtime" | "operator-adopted";
  children: ReactNode;
}) {
  return (
    <section className="settings-row" aria-label={title}>
      <h4 className="small-heading">{title}</h4>
      <p className="metadata muted">
        Witness <span className="identifier">{id}</span> ·{" "}
        {source === "runtime" ? "from the runtime" : "added by an operator"}
      </p>
      <p className="body">{children}</p>
      <p className="body">
        Evidence only. It doesn't recover the assignment or allow new work.
      </p>
    </section>
  );
}

type RecoveryRecordData = ReturnType<
  typeof assignmentRecoverySchema.parse
>["data"]["records"][number];

const recordKey = (r: RecoveryRecordData) =>
  `${r.workId}-${r.generation.workRevision}-${r.generation.requestSequence}`;

function RecoveryRecord({ r }: { r: RecoveryRecordData }) {
  return (
    <article className="settings-row">
      <h3 className="small-heading">
        {`Generation ${r.generation.workRevision ?? "unavailable"}; request ${r.generation.requestSequence}`}
      </h3>
      <p className="body">
        {`Intent ${r.intentState}; request ${r.requestState ?? "unavailable"}; binding ${
          r.binding
            ? `assignment version ${r.binding.assignmentVersion}, instructions ${r.binding.instructionsRevision}, profile ${r.binding.profileRevision}`
            : "unavailable"
        }.`}
      </p>
      <p className="body">
        Observations: {r.observations.join(", ") || "unavailable"}. Pending
        effects: {r.pendingEffectCount}. Receipt{" "}
        {`${r.receiptRecorded ? "recorded" : "not recorded"}; workspace ${r.workspace}.`}
      </p>
      {r.preTurnRejection && (
        <Witness
          title="Before-turn refusal"
          id={r.preTurnRejection.id}
          source={r.preTurnRejection.source}
        >
          The runtime refused to resume the archived conversation before any
          turn was sent. This attempt never reached a turn.
        </Witness>
      )}
      {r.noTurnSubmission && (
        <Witness
          title="No turn sent"
          id={r.noTurnSubmission.id}
          source={r.noTurnSubmission.source}
        >
          An operator confirmed that no turn was sent for this attempt. An idle
          conversation may still exist that cab hasn't seen.
        </Witness>
      )}
      <p className="metadata muted">
        Stop {r.holds.stop ? "active" : "inactive"}; writer{" "}
        {r.holds.writer ? "held" : "not recorded"}; capacity{" "}
        {r.holds.capacity ? "held" : "not recorded"}; uncertainty{" "}
        {r.holds.uncertainty ? "active" : "not recorded"}.
      </p>
    </article>
  );
}

type BoundCommand = Extract<
  OperatorCommand,
  { type: "recovery.bound-turn.recover" }
>;
type RecoveryOptions = ReturnType<typeof recoveryOptionsSchema.parse>["data"];

/** One original command stays frozen until its receipt has been checked. */
function BoundTurnRecovery(
  p: SettingsProps & {
    assignmentId: string;
    projectId: string;
    taskId: string;
  },
) {
  const loader = useCallback(
    (signal: AbortSignal) =>
      p.client.read(
        `/api/operator/assignments/${p.assignmentId}/recovery-options`,
        recoveryOptionsSchema,
        signal,
      ),
    [p.client, p.assignmentId],
  );
  const resource = useOperatorResource(
    `${p.session.csrfToken}:${p.assignmentId}`,
    loader,
  );
  useHeaderRefresh(p.refreshNonce, resource.refresh);
  // Keep the original bounded identities, including an unknown command whose record later disappears.
  const shown = useRef<RecoveryOptions["records"] | null>(null);
  if (shown.current === null && resource.state.data)
    shown.current = resource.state.data.data.records;
  return (
    <Panel
      title="Reconcile a bound turn"
      description="Reconciliation is durable and cannot be undone. It releases only this execution's ownership; it never resumes work."
    >
      <ResourceStatus
        label="Recovery eligibility"
        state={resource.state}
        retry={resource.refresh}
      />
      {resource.state.data &&
        shown.current?.map((record) => (
          <BoundTurnForm
            key={`${record.workId}:${record.generation.requestSequence}`}
            {...p}
            options={resource.state.data!.data}
            record={record}
            fresh={resource.state.status === "fresh"}
            reload={resource.refresh}
          />
        ))}
      {shown.current?.length === 0 && (
        <p className="body">No bound recovery identity is available.</p>
      )}
    </Panel>
  );
}

const boundIdentity = (
  r: RecoveryOptions["records"][number],
  options: RecoveryOptions,
) =>
  JSON.stringify([
    options.assignmentId,
    options.projectId,
    options.taskId,
    options.assignmentVersion,
    options.conversationRevision,
    r.workId,
    r.generation,
    r.process,
    r.threadId,
    r.turnId,
  ]);

function BoundTurnForm(
  p: SettingsProps & {
    assignmentId: string;
    projectId: string;
    taskId: string;
    options: RecoveryOptions;
    record: RecoveryOptions["records"][number];
    fresh: boolean;
    reload: () => void;
  },
) {
  const fieldId = useId();
  const [termination, setTermination] = useState(false),
    [effects, setEffects] = useState(false),
    [workspace, setWorkspace] = useState(""),
    [review, setReview] = useState<BoundCommand | null>(null),
    [lifecycle] = useState(() => new CommandLifecycle<BoundCommand>()),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState(""),
    [receipt, setReceipt] = useState<CommandReceipt | null>(null),
    [retry, setRetry] = useState(false),
    trigger = useRef<HTMLButtonElement>(null),
    initial = useRef(boundIdentity(p.record, p.options)),
    current = useRef(true);
  useEffect(
    () => () => {
      current.current = false;
    },
    [],
  );
  const frozen = lifecycle.frozen;
  const latest = p.options.records.find(
    (r) =>
      r.workId === p.record.workId &&
      r.generation.requestSequence === p.record.generation.requestSequence,
  );
  const path = latest?.paths.find((r) => r.path === "bound-turn-recover");
  const identityChanged =
    !latest || boundIdentity(latest, p.options) !== initial.current;
  const completeIdentity = Boolean(
    p.record.workId &&
      p.record.generation.workRevision &&
      p.record.threadId &&
      p.record.turnId &&
      p.record.process,
  );
  const allowed =
    !p.readOnly &&
    p.fresh &&
    !identityChanged &&
    completeIdentity &&
    p.options.assignmentId === p.assignmentId &&
    p.options.projectId === p.projectId &&
    p.options.taskId === p.taskId &&
    p.options.gaps.length === 0 &&
    path?.eligible;
  const matches = (r: CommandReceipt, c: BoundCommand) =>
    r.kind === "recovery-resolution" &&
    r.path === "bound-turn-recover" &&
    r.assignmentId === c.assignmentId &&
    r.key === c.key &&
    r.workId === c.receipt.workId;
  const send = async (c: BoundCommand) => {
    if (p.readOnly) return;
    if (!lifecycle.frozen) lifecycle.restoreUnknown(c);
    const original = lifecycle.begin();
    if (!original) return;
    setReview(null);
    setPending(true);
    setRetry(false);
    const authenticated = p.client.captureAuthenticationScope();
    const result = await p.client.command(original, p.session.csrfToken);
    if (!current.current || !authenticated()) return;
    const disposition = lifecycle.settle(result, (command, receipt) =>
      matches(receipt, command),
    );
    if (disposition === "recorded" && result.state === "recorded") {
      setReceipt(result.receipt);
      setMessage(
        "Execution reconciled. No work was started. Review the task's remaining holds before an explicit continuation.",
      );
      p.reload();
      p.refresh();
    } else
      setMessage(
        result.state === "unknown" || result.state === "recorded"
          ? "Outcome unknown. Check the original receipt before retrying. Your original evidence and request key are frozen."
          : `Recovery refused (${result.code}). Your original evidence and request key are retained. Check the receipt before retrying.`,
      );
    setPending(false);
  };
  const check = async () => {
    if (!frozen) return;
    setPending(true);
    setRetry(false);
    const authenticated = p.client.captureAuthenticationScope();
    try {
      const result = await p.client.operation({
        scope: `assignment:${frozen.assignmentId}`,
        type: frozen.type,
        key: frozen.key,
      });
      if (!current.current || !authenticated()) return;
      if (
        result.data.state === "recorded" &&
        matches(result.data.receipt, frozen)
      ) {
        lifecycle.settle(
          { state: "recorded", receipt: result.data.receipt },
          (command, receipt) => matches(receipt, command),
        );
        setReceipt(result.data.receipt);
        setMessage(
          "Execution reconciled. No work was started. Review the task's remaining holds before an explicit continuation.",
        );
        p.reload();
        p.refresh();
      } else if (result.data.state === "not-recorded") {
        setMessage(
          p.readOnly
            ? "No receipt is recorded. This project is archived; retry is disabled and the original request is kept."
            : "No receipt is recorded. You may retry only the exact original command; the service will recheck its proof.",
        );
        setRetry(true);
      } else
        setMessage(
          "The receipt does not match this recovery. Keep the original evidence and inspect the operation.",
        );
    } catch {
      if (current.current && authenticated())
        setMessage(
          "Receipt readback unavailable. Keep the original evidence; retry remains blocked.",
        );
    }
    if (current.current && authenticated()) setPending(false);
  };
  const prepare = () => {
    const r = p.record;
    if (!allowed || !termination || !effects || !workspace || !r.process)
      return;
    const parsed = operatorCommandSchema.safeParse({
      type: "recovery.bound-turn.recover",
      key: crypto.randomUUID(),
      assignmentId: p.assignmentId,
      receipt: {
        kind: "bound-turn",
        workId: r.workId,
        workRevision: r.generation.workRevision,
        requestSequence: r.generation.requestSequence,
        threadId: r.threadId,
        turnId: r.turnId,
        processIdentity: r.process,
        termination: { kind: "process-exit" },
        effects: "settled",
        workspace,
      },
    });
    if (parsed.success && parsed.data.type === "recovery.bound-turn.recover")
      setReview(parsed.data);
  };
  return (
    <section
      className="settings-row"
      aria-label={`Bound turn ${p.record.generation.requestSequence}`}
    >
      <p className="body">
        Work{" "}
        <span className="identifier">{p.record.workId ?? "Unavailable"}</span> ·
        revision {p.record.generation.workRevision ?? "Unavailable"} · request{" "}
        {p.record.generation.requestSequence}
      </p>
      <p className="body identifier">
        Thread {p.record.threadId ?? "Unavailable"} · turn{" "}
        {p.record.turnId ?? "Unavailable"}
      </p>
      <p className="body identifier">
        Process {p.record.process?.processId ?? "Unavailable"} · birth{" "}
        {p.record.process?.processStartedAt ?? "Unavailable"} · boot{" "}
        {p.record.process?.bootId ?? "Unavailable"}
      </p>
      <p className="body">
        {allowed
          ? "Eligible for review. This check is advisory; submission verifies the exact identity again."
          : `Recovery blocked: ${identityChanged ? "identity changed; reload the page before preparing new proof" : [...(path?.blockedBy ?? ["bound-identity-missing"]), ...p.options.gaps].join(", ") || "eligibility unavailable"}.`}
      </p>
      <fieldset
        disabled={Boolean(frozen) || !allowed || pending}
        className="settings-column"
      >
        <legend className="small-heading">Independent evidence</legend>
        <label className="body check-field" htmlFor={`${fieldId}-termination`}>
          <Input
            id={`${fieldId}-termination`}
            className="native-check size-5 shrink-0 p-0 accent-foreground"
            type="checkbox"
            checked={termination}
            onChange={(e) => setTermination(e.target.checked)}
          />
          I independently confirmed this exact process exited
        </label>
        <label className="body check-field" htmlFor={`${fieldId}-effects`}>
          <Input
            id={`${fieldId}-effects`}
            className="native-check size-5 shrink-0 p-0 accent-foreground"
            type="checkbox"
            checked={effects}
            onChange={(e) => setEffects(e.target.checked)}
          />
          All effects and callbacks are settled
        </label>
        <label className="body">
          Workspace disposition
          <select
            className="body"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            <option value="">Choose after inspection</option>
            <option value="preserved">Preserved</option>
            <option value="reconciled">Reconciled</option>
          </select>
        </label>
        <Button
          ref={trigger}
          type="button"
          disabled={!termination || !effects || !workspace}
          onClick={prepare}
        >
          Review reconciliation
        </Button>
      </fieldset>
      {frozen && (
        <details>
          <summary className="body">
            Original recovery evidence and request key
          </summary>
          <pre className="body whitespace-pre-wrap break-all">
            {JSON.stringify(frozen, null, 2)}
          </pre>
        </details>
      )}
      {message && (
        <p role="status" className="body">
          {message}
        </p>
      )}
      {receipt?.kind === "recovery-resolution" && (
        <p className="body identifier">Receipt {receipt.receiptId}</p>
      )}
      {frozen && !receipt && (
        <div className="settings-actions">
          <Button type="button" disabled={pending} onClick={() => void check()}>
            Check original receipt
          </Button>
          {retry && (
            <Button
              type="button"
              disabled={pending || p.readOnly}
              onClick={() => void send(frozen)}
            >
              Retry exact recovery
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={review !== null}
        onOpenChange={(open) => !open && setReview(null)}
      >
        <DialogContent
          role="alertdialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement)
              .querySelector<HTMLElement>("[data-cancel]")
              ?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle>Reconcile this execution permanently?</DialogTitle>
          <DialogDescription>
            Reconciliation cannot be undone. Stop, project pause, approvals and
            delivery holds remain. This does not resume or start a turn.
          </DialogDescription>
          <pre className="metadata whitespace-pre-wrap break-all">
            {JSON.stringify(review?.receipt, null, 2)}
          </pre>
          <div className="stop-dialog-actions">
            <DialogClose asChild>
              <Button type="button" variant="secondary" data-cancel>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={!allowed}
              onClick={() => review && void send(review)}
            >
              Confirm reconciliation
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
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
  const status = data ? executionStatus(data.execution, data) : null;
  const facts = data ? recoveryAssignmentFacts(data.assignment) : null;
  const taskFacts = data ? recoveryTaskFacts(data.lead, data.taskHold) : null;
  const assignmentInspector = data
    ? `/app/tasks/${data.taskId}?section=assignments&inspectAssignment=${encodeURIComponent(p.assignmentId)}`
    : "";
  return (
    <div className="settings-page">
      <ResourceStatus
        label="Recovery evidence"
        state={resource.state}
        retry={resource.refresh}
      />
      {data && (
        <>
          {data.project.archived && (
            <p role="status">
              This project is archived. Recovery evidence and original receipt
              checks remain available; new recovery and retry sends are
              disabled.
            </p>
          )}
          <p className="settings-status body muted">
            <StatusBadge tone={status?.held ? "warning" : "idle"}>
              {status?.held ? "Execution held" : status?.label}
            </StatusBadge>{" "}
            {status?.held && <>{status.label} · </>}
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
                Inspect the execution, then review the exact bound turn and
                independent evidence below. Reconciliation never resumes work.
              </p>
            </section>
          </div>
          <div className="settings-split">
            <div className="settings-column">
              <Panel title="Execution and assignment">
                {status?.note && <p className="body">{status.note}</p>}
                <p className="body">
                  Accountable project lead: {taskFacts?.lead}.
                </p>
                {taskFacts && taskFacts.taskHold !== null && (
                  <p className="body">Task hold: {taskFacts.taskHold}.</p>
                )}
                <p className="body">{facts?.lifecycle}</p>
                <p className="body">
                  Result destination: {facts?.destination}.
                </p>
                <p className="body">{facts?.revisions}</p>
                {facts?.canInspectApply && (
                  <ActionLink href={assignmentInspector}>
                    Inspect assignment to apply current instructions
                  </ActionLink>
                )}
                <p className="body">{resumeWarning}</p>
                <p className="body">{evidenceWarning}</p>
                <ActionLink
                  href={`/app/tasks/${data.taskId}?section=execution`}
                >
                  View task-wide execution evidence
                </ActionLink>
                <p className="metadata muted">
                  Other advanced identities and runtime reasons are available
                  through the CLI recovery-options read.
                </p>
              </Panel>
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
                    Generation in use: Unavailable. No turn request for this
                    assignment was accepted with its versions, so the generation
                    in use can't be named. This doesn't mean the execution
                    ended.
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
                    <strong className="action-outcome-title">
                      We can't show recovery details for this assignment.
                    </strong>
                    No recovery record was found. That alone doesn't mean the
                    execution ended or that its holds were released.
                  </p>
                )}
                {recoveryRecordRuns(data.records).map(({ shown, older }) => (
                  <Fragment key={recordKey(shown)}>
                    <RecoveryRecord r={shown} />
                    {older.length > 0 && (
                      <details className="recovery-older">
                        <summary className="metadata">
                          {plural(older.length, "older record")}, same state
                        </summary>
                        {older.map((r) => (
                          <RecoveryRecord key={recordKey(r)} r={r} />
                        ))}
                      </details>
                    )}
                  </Fragment>
                ))}
              </Panel>
            </div>
            <div className="settings-column">
              <BoundTurnRecovery
                key={`${p.session.csrfToken}:${p.assignmentId}:${data.project.id}`}
                {...p}
                readOnly={
                  data.project.archived || data.assignment.readOnly === true
                }
                projectId={data.project.id}
                taskId={data.taskId}
              />
              <Panel title="Next supported step">
                <p className="body">
                  Inspect the exact execution and review independent evidence
                  before reconciliation. Remaining task and project holds
                  require a separate explicit action.
                </p>
                <ActionLink href={inspect} className="settings-wide">
                  Inspect execution
                </ActionLink>
              </Panel>
              <Aside
                title="Advanced destinations · desktop-first"
                items={[
                  <a
                    key="b"
                    href={`/app/tasks/${data.taskId}?section=execution`}
                  >
                    Task Stop, Resume and dependencies
                  </a>,
                  <a
                    key="c"
                    href={`/app/tasks/${data.taskId}?assignment=${p.assignmentId}`}
                  >
                    Assignment conversation
                  </a>,
                  <a key="d" href={inspect}>
                    Task detail
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
