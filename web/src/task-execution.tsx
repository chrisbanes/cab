import { useRef, useState } from "react";
import {
  type CommandReceipt,
  type OperatorCommand,
  operatorCommandSchema,
  type Session,
  type TaskRead,
  type Workspace,
} from "../../src/operator/contracts.js";
import type { OperatorClient } from "./api.js";
import { useCommandSend } from "./command-send.js";
import { SendFeedback } from "./coordination-actions.js";
import { ActionLink, Button, ShortId, StatusBadge } from "./components.js";
import {
  admissionLine,
  evidenceNotice,
  evidenceWarning,
  executionHoldLines,
  executionStatus,
  holdsUnreadable,
  recordLine,
  resumeWarning,
  staleRevisions,
} from "./task-execution-model.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog.js";
import { NativeSelect } from "./ui/native-select.js";

type Data = TaskRead["data"];

/** A command behind a confirmation; Cancel sends nothing and returns focus to the trigger. */
export function ConfirmCommand({
  trigger,
  title,
  description,
  confirm,
  disabled,
  onConfirm,
  destructive = false,
}: {
  trigger: string;
  title: string;
  description: string;
  confirm: string;
  disabled?: boolean;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" disabled={disabled}>
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent
        role="alertdialog"
        className="stop-dialog"
        onOpenAutoFocus={(event) => {
          // Opens on the choice that sends nothing.
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="body">{description}</DialogDescription>
        <div className="stop-dialog-actions">
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirm}
          </Button>
          <DialogClose asChild>
            <Button ref={cancel} type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A domain receipt for exactly this task command, at a version after the one it was sent with. */
const dependencyMatches = (c: OperatorCommand, r: CommandReceipt) =>
  (c.type === "dependency.add" || c.type === "dependency.remove") &&
  r.kind === "domain" &&
  r.key === c.key &&
  "state" in r.result &&
  r.result.id === c.taskId &&
  r.result.projectId === c.projectId &&
  r.result.version > c.expectedVersion;

function Dependencies({
  data,
  client,
  session,
  onChanged,
}: {
  data: Data;
  client: OperatorClient;
  session: Session;
  onChanged: () => void;
}) {
  const taskId = data.task.id,
    candidates = data.dependencyCandidates;
  const [choice, setChoice] = useState("");
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:dependency`,
    dependencyMatches,
    (kind) => {
      if (kind === "recorded") setChoice("");
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  // A send waiting for a check holds every other dependency change until it is resolved.
  const busy = Boolean(sending) || uncertain;
  const change = (type: "dependency.add" | "dependency.remove", id: string) =>
    void send(
      operatorCommandSchema.parse({
        type,
        key: crypto.randomUUID(),
        projectId: data.task.projectId,
        taskId,
        blockerTaskId: id,
        expectedVersion: data.task.version,
      }),
    );
  const chosen = candidates?.find((c) => c.id === choice);
  return (
    <section aria-labelledby="execution-dependencies">
      <h4 id="execution-dependencies">Local dependencies</h4>
      <p className="muted">
        Local dependencies gate new execution independently of readiness.
      </p>
      {data.localDependencies.length ? (
        <ul className="execution-list">
          {data.localDependencies.map((b) => (
            <li key={b.id}>
              <a href={`/app/tasks/${b.id}`}>
                {b.title ?? "Title unavailable"}
              </a>{" "}
              <span className="metadata muted">{b.state}</span>
              <ConfirmCommand
                trigger="Remove"
                title={`Remove ${b.title ?? "this task"} as a blocker?`}
                description="This task no longer waits for it. You can add it again."
                confirm="Remove dependency"
                disabled={busy}
                onConfirm={() => change("dependency.remove", b.id)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p>No local task blockers.</p>
      )}
      {candidates === undefined ? (
        <p className="muted">Dependency choices are unavailable.</p>
      ) : data.source ? (
        <p className="muted">
          An imported task follows its source's dependencies; local blockers
          cannot be added.
        </p>
      ) : candidates.length ? (
        <div className="execution-add">
          <label htmlFor="execution-blocker">Local blocker</label>
          <NativeSelect
            id="execution-blocker"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">Choose a task</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title ?? "Title unavailable"} · {c.state}
              </option>
            ))}
          </NativeSelect>
          <ConfirmCommand
            trigger="Add dependency…"
            title={`Wait for ${chosen?.title ?? "this task"}?`}
            description="New execution of this task waits until the blocker is done. You can remove it again."
            confirm="Add dependency"
            disabled={busy || !chosen}
            onConfirm={() => chosen && change("dependency.add", chosen.id)}
          />
        </div>
      ) : (
        <p className="muted">No other task in this project can be added.</p>
      )}
      <SendFeedback
        entry={entry}
        outcome={outcome}
        recorded={(c) =>
          c.type === "dependency.add"
            ? "Dependency added."
            : "Dependency removed."
        }
        conflict="Not changed: the task changed since it was read."
        check={() => void send()}
        review={{ label: "Review current dependencies", onClick: clear }}
      />
    </section>
  );
}

/** The Execution tab: status, gates, lead, holds, recovery evidence and local dependencies. */
export function TaskExecution({
  data,
  project,
  client,
  session,
  onChanged,
}: {
  data: Data;
  project: Workspace["data"]["projects"][number] | undefined;
  client: OperatorClient;
  session: Session;
  onChanged: () => void;
}) {
  const taskId = data.task.id,
    recovery = data.executionRecovery,
    status = executionStatus(data.execution, recovery),
    holds = executionHoldLines(data.execution, data.taskHold, recovery),
    notice = evidenceNotice(recovery);
  const name = (assignmentId: string) =>
    data.assignments.find((a) => a.assignmentId === assignmentId)?.name ??
    "Assignment";
  return (
    <section id="execution" className="task-execution">
      <h3 className="section-heading">Execution</h3>
      <p data-execution-status>
        <StatusBadge tone={status.held ? "warning" : "neutral"}>
          {status.label}
        </StatusBadge>
      </p>
      {status.note && <p role="note">{status.note}</p>}
      <dl className="execution-facts">
        <dt>Project</dt>
        <dd>
          {project
            ? `${project.name ?? "Name unavailable"} · ${project.paused ? "Paused" : "Active"}`
            : "Project state unavailable"}
        </dd>
        <dt>Task</dt>
        <dd>
          {data.task.state} · {data.task.ready ? "Ready" : "Not ready"}
        </dd>
        <dt>Admission</dt>
        <dd>{admissionLine(data.admission)}</dd>
        <dt>Accountable lead</dt>
        <dd>
          {data.lead ? (
            <>
              {data.lead.name ?? "Name unavailable"}
              {data.leadAssignmentId && (
                <>
                  {" · "}
                  <a
                    href={`/app/tasks/${taskId}?assignment=${data.leadAssignmentId}`}
                  >
                    Task-scoped lead execution
                  </a>
                </>
              )}
            </>
          ) : (
            "No project lead is configured"
          )}
        </dd>
      </dl>
      <section aria-labelledby="execution-holds">
        <h4 id="execution-holds">Execution ownership and recovery</h4>
        {holds.length ? (
          <ul className="execution-list">
            {holds.map((h) => (
              <li key={h.kind}>
                <strong>{h.label}</strong> · {h.clears}
              </li>
            ))}
          </ul>
        ) : recovery ? (
          <p>No unresolved execution hold is reported.</p>
        ) : (
          <p>{holdsUnreadable}</p>
        )}
        <p className="muted">{resumeWarning}</p>
      </section>
      <section aria-labelledby="execution-evidence">
        <h4 id="execution-evidence">Recorded recovery evidence</h4>
        {notice && <p>{notice}</p>}
        {recovery && recovery.records.length > 0 && (
          <ol className="execution-list">
            {recovery.records.map((r) => (
              <li key={r.workId ?? r.generation.requestSequence}>
                <ShortId value={r.workId ?? "withheld"} />{" "}
                {r.binding ? (
                  <a
                    href={`/app/assignments/${r.binding.assignmentId}/recovery`}
                  >
                    {name(r.binding.assignmentId)}
                  </a>
                ) : (
                  "Assignment identity not recorded"
                )}{" "}
                <span className="metadata muted">
                  request {r.generation.requestSequence} · {recordLine(r)}
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="muted">{evidenceWarning}</p>
        {data.assignments.length > 0 && (
          <ul className="settings-links body">
            {data.assignments.map((a) => (
              <li key={a.assignmentId}>
                <ActionLink
                  variant="secondary"
                  href={`/app/assignments/${a.assignmentId}/recovery`}
                >
                  {a.name ?? "Assignment"}: recovery
                </ActionLink>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Dependencies
        data={data}
        client={client}
        session={session}
        onChanged={onChanged}
      />
    </section>
  );
}

/**
 * Apply current instructions for the next turn, in a stale assignment row's facts. It changes only
 * the revisions the next turn captures; an unconfirmed send stays checkable once the row is current.
 */
export function ApplyInstructions({
  assignment,
  projectId,
  taskId,
  client,
  session,
  onChanged,
}: {
  assignment: Data["assignments"][number];
  projectId: string;
  taskId: string;
  client: OperatorClient;
  session: Session;
  onChanged: () => void;
}) {
  const assignmentId = assignment.assignmentId,
    stale = staleRevisions(assignment);
  const { entry, send, sending, outcome, uncertain, clear } = useCommandSend(
    client,
    session,
    `${taskId}:apply:${assignmentId}`,
    (c, r) =>
      c.type === "assignment.apply" &&
      r.kind === "domain" &&
      r.key === c.key &&
      "taskId" in r.result &&
      r.result.id === c.assignmentId &&
      r.result.projectId === c.projectId &&
      r.result.version > c.expectedVersion,
    (kind) => {
      if (kind === "recorded" || kind === "conflict") onChanged();
    },
  );
  if (!stale.length && !uncertain && !outcome) return null;
  return (
    <div data-apply-instructions>
      {stale.length > 0 && (
        <p>
          Captured revisions are behind the current ones: {stale.join(", ")}.
          Changing configuration does not change this assignment until applied
          for its next turn.
        </p>
      )}
      {stale.length > 0 && !uncertain && (
        <ConfirmCommand
          trigger="Apply current instructions for the next turn…"
          title="Apply current instructions for the next turn?"
          description="The next turn captures the current project instructions and profile revision. A turn already running keeps the revisions it started with."
          confirm="Apply"
          disabled={Boolean(sending)}
          onConfirm={() =>
            void send(
              operatorCommandSchema.parse({
                type: "assignment.apply",
                key: crypto.randomUUID(),
                projectId,
                assignmentId,
                expectedVersion: assignment.version,
              }),
            )
          }
        />
      )}
      <SendFeedback
        entry={entry}
        outcome={outcome}
        recorded="Applied. The next turn uses the current instructions and profile."
        conflict="Not applied: the assignment changed since it was read."
        check={() => void send()}
        review={{ label: "Review current revisions", onClick: clear }}
      />
    </div>
  );
}
