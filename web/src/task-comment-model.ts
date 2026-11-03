/**
 * Recipient selection and effect wording for a shared task comment. The service decides what a
 * send does for each assignment; this only presents that decision and tracks the operator's
 * choice. Nothing here reads the comment's text, so an `@name` in it addresses nobody.
 */

export type CommentRecipientFact = {
  assignmentId: string;
  version: number;
  name: string | null;
  role: "lead" | "delegate";
  mode: "input" | "resume" | "unavailable";
  reason:
    | "task-closed"
    | "held"
    | "cancelled"
    | "no-resumable-result"
    | "already-followed-up"
    | "unresolved-destination"
    | null;
};

/** `null` is an untouched composer, which addresses the lead; an array is the operator's explicit set. */
export type CommentSelection = readonly string[] | null;

export const shortAssignmentId = (assignmentId: string) =>
  assignmentId.slice(0, 8);

/** The selected assignment IDs, in order. An untouched composer selects the lead, if the task has one. */
export function selectedRecipientIds(
  facts: readonly CommentRecipientFact[],
  selection: CommentSelection,
): string[] {
  if (selection) return [...selection];
  const lead = facts.find((fact) => fact.role === "lead");
  return lead ? [lead.assignmentId] : [];
}

/** Removing a recipient makes the set explicit, so a refresh never restores it. */
export function removeRecipient(
  facts: readonly CommentRecipientFact[],
  selection: CommentSelection,
  assignmentId: string,
): string[] {
  return selectedRecipientIds(facts, selection).filter(
    (id) => id !== assignmentId,
  );
}

export function addRecipient(
  facts: readonly CommentRecipientFact[],
  selection: CommentSelection,
  assignmentId: string,
): string[] {
  const current = selectedRecipientIds(facts, selection);
  return current.includes(assignmentId) ? current : [...current, assignmentId];
}

/** The assignments not yet selected, which the picker offers; unavailable ones stay listed with their reason. */
export function pickableRecipients(
  facts: readonly CommentRecipientFact[],
  selection: CommentSelection,
): CommentRecipientFact[] {
  const chosen = new Set(selectedRecipientIds(facts, selection));
  return facts.filter((fact) => !chosen.has(fact.assignmentId));
}

/**
 * The name to show: the profile's name, with the short assignment ID when another assignment in
 * the task shares it, so two same-named delegates are never confused. Names never address anyone.
 */
export function recipientLabel(
  fact: Pick<CommentRecipientFact, "assignmentId" | "name">,
  facts: readonly Pick<CommentRecipientFact, "assignmentId" | "name">[],
): string {
  const name = fact.name ?? "Assignment";
  const shared = facts.some(
    (other) =>
      other.assignmentId !== fact.assignmentId &&
      (other.name ?? "Assignment") === name,
  );
  return shared ? `${name} · ${shortAssignmentId(fact.assignmentId)}` : name;
}

/** A recipient chip's text: the lead is shown as `@lead` beside its name. */
export const chipLabel = (
  fact: CommentRecipientFact,
  facts: readonly CommentRecipientFact[],
) => `${fact.role === "lead" ? "@lead " : "@"}${recipientLabel(fact, facts)}`;

const reasonText: Record<
  NonNullable<CommentRecipientFact["reason"]>,
  string
> = {
  "task-closed": "the task is not open",
  held: "it is held",
  cancelled: "it was cancelled",
  "no-resumable-result":
    "its latest result is not the newest unambiguous work, so it can't be resumed",
  "already-followed-up": "its latest result already has a follow-up",
  "unresolved-destination":
    "its result destination is unresolved, so it can't be resumed",
};

export const unavailableText = (fact: CommentRecipientFact) =>
  `can't receive this comment: ${fact.reason ? reasonText[fact.reason] : "it is unavailable"}`;

/** What sending does for one recipient now; the service re-decides at commit. */
export function effectText(fact: CommentRecipientFact): string {
  switch (fact.mode) {
    case "input":
      return "receives this as input on its next eligible turn";
    case "resume":
      return "resumes the same assignment with this as a follow-up";
    case "unavailable":
      return unavailableText(fact);
  }
}

/** One preview line per selected recipient, in selection order; an ID with no fact is unknown. */
export function previewLines(
  facts: readonly CommentRecipientFact[],
  ids: readonly string[],
): { assignmentId: string; label: string; effect: string; blocked: boolean }[] {
  return ids.map((assignmentId) => {
    const fact = facts.find((f) => f.assignmentId === assignmentId);
    if (!fact)
      return {
        assignmentId,
        label: `Assignment ${shortAssignmentId(assignmentId)}`,
        effect: "is no longer in this task",
        blocked: true,
      };
    return {
      assignmentId,
      label: recipientLabel(fact, facts),
      effect: effectText(fact),
      blocked: fact.mode === "unavailable",
    };
  });
}

/** Sending is held while any selected recipient is unavailable; the operator removes or waits. */
export const hasBlockedRecipient = (
  facts: readonly CommentRecipientFact[],
  ids: readonly string[],
) => previewLines(facts, ids).some((line) => line.blocked);

/** The one sentence above the box for a shared comment. */
export const commentNote =
  "Shared in the task conversation. Only the assignments listed below receive it; a name in the text addresses no one, and a sent comment can't be edited.";

export const commentUnavailableNote =
  "Shared comments are unavailable, so nothing can be sent from here.";

/** Why no `@lead` chip is shown: the task has no lead assignment, and nobody is substituted. */
export const noLeadText =
  "This task has no lead assignment, so no lead is selected. Add another assignment, or send with no recipients.";

export const recordOnlyText =
  "No recipients: this comment is recorded in the conversation and wakes no assignment.";

/** The admission caveat shown with any wake: recording is not starting. */
export const admissionText =
  "Sending queues this input. Pause, Stop, capacity, readiness and permissions still decide when work runs.";

/** The text after a recorded send, by the effects the receipt reports. */
export function sentText(
  deliveries: readonly { assignmentId: string; effect: "input" | "resume" }[],
  facts: readonly CommentRecipientFact[],
): string {
  if (deliveries.length === 0)
    return "Comment recorded. No assignment was woken.";
  const names = deliveries.map((d) => {
    const fact = facts.find((f) => f.assignmentId === d.assignmentId);
    const label = fact ? recipientLabel(fact, facts) : "an assignment";
    return d.effect === "resume" ? `${label} (resumed)` : label;
  });
  return `Comment sent to ${names.join(", ")}.`;
}

type FrozenComment = {
  taskId: string;
  key: string;
  body: string;
  recipients: readonly {
    assignmentId: string;
    expectedAssignmentVersion: number;
  }[];
};

type ReceiptLike = {
  key: string;
  taskId: string;
  payloadHash: string;
  deliveries: readonly {
    assignmentId: string;
    effect: "input" | "resume";
    assignmentVersion: number;
  }[];
};

/** Matches the service's `materialDigest`: sorted-key JSON, then SHA-256. */
export async function commentPayloadHash(
  command: Pick<FrozenComment, "taskId" | "body" | "recipients">,
): Promise<string> {
  const recipients = [...command.recipients]
    .sort((a, b) => (a.assignmentId < b.assignmentId ? -1 : 1))
    .map(
      (r) =>
        `{"assignmentId":${JSON.stringify(r.assignmentId)},"expectedAssignmentVersion":${r.expectedAssignmentVersion}}`,
    );
  const material = `{"body":${JSON.stringify(command.body)},"recipients":[${recipients.join(",")}],"taskId":${JSON.stringify(command.taskId)}}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Whether a receipt settles exactly the frozen command: its key, task and hash, and one delivery
 * per frozen recipient, each with an effect that follows from the version the operator saw. A
 * receipt that fails any of these leaves the draft frozen as unknown.
 */
export async function receiptSettles(
  command: FrozenComment,
  receipt: ReceiptLike,
): Promise<boolean> {
  if (
    receipt.key !== command.key ||
    receipt.taskId !== command.taskId ||
    receipt.deliveries.length !== command.recipients.length ||
    receipt.payloadHash !== (await commentPayloadHash(command))
  )
    return false;
  return command.recipients.every((recipient) => {
    const delivery = receipt.deliveries.find(
      (d) => d.assignmentId === recipient.assignmentId,
    );
    return (
      delivery !== undefined &&
      delivery.assignmentVersion ===
        recipient.expectedAssignmentVersion +
          (delivery.effect === "resume" ? 1 : 0)
    );
  });
}
