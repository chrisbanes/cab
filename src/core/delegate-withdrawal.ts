/** Why an unfinished delegate cannot be withdrawn yet; each has one fixed way out. */
export const delegateBlockerCodes = [
  "live-execution",
  "uncertain-execution",
  "held-execution",
  "ownership-hold",
  "open-request",
  "unfinished-delegates",
] as const;
export type DelegateBlocker = (typeof delegateBlockerCodes)[number];

export const delegateWithdrawalRefusalCodes = [
  ...delegateBlockerCodes,
  "not-delegate",
  "lead-assignment",
  "not-requester",
  "already-final",
  "version-changed",
] as const;
export type DelegateWithdrawalRefusal =
  (typeof delegateWithdrawalRefusalCodes)[number];

export const withdrawalReasonLimit = 2000;

export interface DelegateStatus {
  assignmentId: string;
  state: string;
  blockers: DelegateBlocker[];
}

export interface AssignmentWithdrawal {
  assignmentId: string;
  taskId: string;
  actor: "operator" | "lead";
  leadAssignmentId: string;
  priorState: "pending" | "running";
  reason: string;
  /** Milliseconds since the epoch. */
  withdrawnAt: number;
}

/** The condition and its existing way out, for a withdrawal refusal. */
export function withdrawalRefusalText(
  code: DelegateWithdrawalRefusal,
  assignmentId: string,
): string {
  const recovery = `the operator can inspect it with cab recovery get ${assignmentId} and release it with cab recovery release ${assignmentId}`;
  const taskRecovery =
    "the operator can find the held assignment with cab recovery get ASSIGNMENT_ID and release it with cab recovery release";
  switch (code) {
    case "live-execution":
      return "The delegate is still running: it has a live or queued execution. Wait for its result.";
    case "held-execution":
      return `The delegate has a held execution; ${recovery}.`;
    case "uncertain-execution":
      return `The delegate's execution outcome is uncertain; ${recovery}.`;
    case "ownership-hold":
      return `The task has an ownership or recovery hold; ${taskRecovery}.`;
    case "open-request":
      return "The delegate is waiting on its own open question or approval. Answer or decline it in the Inbox.";
    case "unfinished-delegates":
      return "The delegate has unfinished delegates of its own. Withdraw or finish those first.";
    case "not-delegate":
      return "Only a delegated assignment can be withdrawn; this one was not requested by another assignment.";
    case "lead-assignment":
      return "The task lead's assignment cannot be withdrawn.";
    case "not-requester":
      return "Only the lead that requested this delegate can withdraw it.";
    case "already-final":
      return "The delegate already completed or was withdrawn.";
    case "version-changed":
      return "The assignment changed since it was read. Read it again and retry.";
  }
}

export class DelegateWithdrawalRefusedError extends Error {
  constructor(
    readonly code: DelegateWithdrawalRefusal,
    readonly assignmentId: string,
  ) {
    super(withdrawalRefusalText(code, assignmentId));
  }
}

/** One delegate's line in the report refusal: `<id> <state>; <condition>; <way out>`. */
function blockingDelegateLine(delegate: DelegateStatus): string {
  const id = delegate.assignmentId.slice(0, 8);
  const [first] = delegate.blockers;
  if (!first)
    return `${id} ${delegate.state}; no live execution; withdraw it with cab_withdraw_delegate or ask the operator`;
  if (first === "live-execution")
    return `${id} ${delegate.state}; still running; wait for its result`;
  if (first === "open-request")
    return `${id} ${delegate.state}; waiting on its open question or approval; it is answered or declined in the Inbox`;
  if (first === "unfinished-delegates")
    return `${id} ${delegate.state}; has unfinished delegates of its own; withdraw or finish those first`;
  if (first === "ownership-hold")
    return `${id} ${delegate.state}; task ownership or recovery hold; ask the operator to release it (cab recovery release)`;
  return `${id} ${delegate.state}; ${first === "uncertain-execution" ? "uncertain execution" : "held execution"}; ask the operator to recover it (cab recovery get ${delegate.assignmentId})`;
}

/** The lead's report refusal while delegates remain unfinished; capped for the tool reply. */
export class DelegatesUnfinishedError extends Error {
  readonly delegates: Array<DelegateStatus & { withdrawable: boolean }>;

  constructor(delegates: DelegateStatus[]) {
    const shown = delegates.slice(0, 5).map(blockingDelegateLine);
    const more =
      delegates.length > 5 ? [`and ${delegates.length - 5} more`] : [];
    super(
      [
        "Assignment cannot report while delegated assignments are not completed:",
        ...[...shown, ...more].map((line) => `- ${line}`),
      ].join("\n"),
    );
    this.delegates = delegates.map((delegate) => ({
      ...delegate,
      withdrawable: delegate.blockers.length === 0,
    }));
  }
}
