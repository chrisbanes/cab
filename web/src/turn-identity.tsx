import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";

type ComparisonData = WorkspaceComparisonRead["data"];
type Snapshot = Extract<ComparisonData, { state: "available" }>["comparison"];
type TurnSnapshot = Extract<Snapshot, { target: "turn" }>;
type Assignments = Array<{ assignmentId: string; name: string | null }>;

export function dateLabel(value: number | undefined) {
  return value === undefined
    ? "not retained"
    : new Date(value).toLocaleString();
}

// Never substitute the lead's name for an unlisted or unnamed assignment.
const agentName = (assignments: Assignments, assignmentId: string) =>
  assignments.find((item) => item.assignmentId === assignmentId)?.name ??
  "Agent name unavailable";

/** Actual identity of the latest finished turn capture, including what it could not observe. */
export function FinishedTurn({
  snapshot,
  assignments,
}: {
  snapshot: TurnSnapshot;
  assignments: Assignments;
}) {
  return (
    <section
      className="changes-pending-turn changes-finished-turn"
      aria-label="Last turn identity"
    >
      <h5>Last turn</h5>
      <p>
        Agent {agentName(assignments, snapshot.assignmentId)} ·{" "}
        <span className="identifier">
          profile {snapshot.profileId} · work {snapshot.workId} · assignment{" "}
          {snapshot.assignmentId}
        </span>
      </p>
      <p className="identifier">
        Thread {snapshot.threadId ?? "not retained"} · turn{" "}
        {snapshot.turnId ?? "not retained"} · outcome {snapshot.outcome} ·
        capture {snapshot.state}
      </p>
      <p>
        Capture started {dateLabel(snapshot.startedAt)} · before the turn{" "}
        {dateLabel(snapshot.beforeObservedAt)} · after the turn{" "}
        {dateLabel(snapshot.observedAt)}
      </p>
      {(snapshot.state !== "available" || snapshot.reason) && (
        <p role="status">
          Capture incomplete
          {snapshot.reason && (
            <>
              {" ("}
              <span className="identifier">{snapshot.reason}</span>
              {")"}
            </>
          )}
          . Some entries are marked as gaps; this capture does not show that the
          agent stopped writing.
        </p>
      )}
      {snapshot.truncated && (
        <p role="status">This capture is bounded and truncated.</p>
      )}
    </section>
  );
}

export function PendingTurn({
  data,
  assignments,
}: {
  data: Extract<ComparisonData, { state: "unsettled" }>;
  assignments: Assignments;
}) {
  const pending = data.pending;
  const agent = agentName(assignments, pending.identity.assignmentId);
  const finishedAgent = data.latestFinished
    ? agentName(assignments, data.latestFinished.assignmentId)
    : "";
  return (
    <section className="changes-pending-turn" aria-label="Current actual turn">
      <h5>Current actual turn</h5>
      <p>
        Agent {agent} ·{" "}
        <span className="identifier">
          profile {pending.identity.profileId} · work {pending.identity.workId}{" "}
          · assignment {pending.identity.assignmentId}
        </span>
      </p>
      <p className="identifier">
        Turn {pending.turnId ?? "not yet bound"} · thread{" "}
        {pending.threadId ?? "not yet bound"} · outcome {pending.outcome} ·{" "}
        capture {pending.captureState}
      </p>
      <p>
        Capture started {dateLabel(pending.startedAt)} · before the turn{" "}
        {pending.beforeObservedAt === undefined
          ? (pending.beforeState ?? "not retained")
          : dateLabel(pending.beforeObservedAt)}
        {" · "}after the turn{" "}
        {pending.afterObservedAt === undefined
          ? (pending.afterState ?? "not read")
          : dateLabel(pending.afterObservedAt)}
      </p>
      {pending.reason && (
        <p>
          Capture limitation:{" "}
          <span className="identifier">{pending.reason}</span>
        </p>
      )}
      {data.latestFinished && (
        <p>
          Latest finished capture remains separate: agent {finishedAgent} · work{" "}
          {data.latestFinished.workId} · turn{" "}
          {data.latestFinished.turnId ?? "not retained"} · outcome{" "}
          {data.latestFinished.outcome} · capture started{" "}
          {dateLabel(data.latestFinished.startedAt)} · before the turn{" "}
          {data.latestFinished.beforeObservedAt === undefined
            ? "not retained"
            : dateLabel(data.latestFinished.beforeObservedAt)}{" "}
          · after the turn {dateLabel(data.latestFinished.observedAt)}.
        </p>
      )}
      <p>
        A partial or unsettled capture does not show that the agent stopped
        writing, and it changes no hold.
      </p>
    </section>
  );
}
